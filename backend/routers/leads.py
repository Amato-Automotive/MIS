"""
AutoForm MIS — Leads Router (Phase 3)
Upload, unified analytics (filter-aware), filter options, paginated list, upload history.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, case, text, extract, and_, or_
from typing import Optional
from datetime import date, timedelta
from database import get_db
from models import Lead, UploadLog, User
from routers.auth import get_current_user
from services.lead_parser import parse_leads_file, _parse_mobile
from services.permissions import require_module
import uuid

router = APIRouter(prefix="/leads", tags=["Leads"])

MODULE_KEY = "leads"


# ── User scoping: intentionally none ──────────────────────────────────────────
# Leads used to be row-scoped by `uploaded_by` for any role outside
# {superadmin, management} — a Phase 3 rule that predates the Phase 7
# permissions system. It survived that migration because it scopes *rows*
# rather than gating the endpoint, so the role-based sweep missed it.
#
# It could never work for this data: leads arrive as centrally-uploaded
# IVR/WhatsApp sheets run by an admin, so `uploaded_by` is always an admin
# and every staff / sales_head user saw zero rows regardless of their grant.
#
# Access is now decided solely by require_module(..., "leads") — consistent
# with Sales, Finance and OE Network. If leads ever need to be restricted to
# a subset of users, scope on something meaningful to the business (e.g.
# `assigned_asm`, mapped via a users→ASM table) rather than reinstating this.


# ── Month-list helper ──────────────────────────────────────────────────────────
def parse_months_param(months: Optional[str]) -> list[tuple[int, int]]:
    """Parse a comma-separated 'YYYY-MM,YYYY-MM' string into (year, month) tuples."""
    if not months:
        return []
    pairs = []
    for token in months.split(","):
        token = token.strip()
        if not token:
            continue
        year_s, month_s = token.split("-")
        pairs.append((int(year_s), int(month_s)))
    return pairs


# ── Shared filter helper ──────────────────────────────────────────────────────
def apply_filters(q, filters: dict):
    """Apply common filters to any Lead query."""
    if filters.get("date_from"):
        q = q.filter(Lead.lead_date >= filters["date_from"])
    if filters.get("date_to"):
        q = q.filter(Lead.lead_date <= filters["date_to"])
    if filters.get("months"):
        q = q.filter(or_(*[
            and_(extract("year", Lead.lead_date) == y, extract("month", Lead.lead_date) == m)
            for y, m in filters["months"]
        ]))
    if filters.get("source"):
        q = q.filter(Lead.source == filters["source"])
    if filters.get("asm"):
        q = q.filter(Lead.assigned_asm == filters["asm"])
    if filters.get("call_status"):
        q = q.filter(Lead.call_status == filters["call_status"])
    if filters.get("review_status"):
        q = q.filter(Lead.review_status == filters["review_status"])
    if filters.get("reason_category"):
        q = q.filter(Lead.reason_category == filters["reason_category"])
    if filters.get("state"):
        q = q.filter(Lead.state == filters["state"])
    return q


def apply_filters_text(where_clauses: list, params: dict, filters: dict):
    """Build WHERE clauses + params dict for raw SQL queries."""
    if filters.get("date_from"):
        where_clauses.append("lead_date >= :date_from")
        params["date_from"] = filters["date_from"]
    if filters.get("date_to"):
        where_clauses.append("lead_date <= :date_to")
        params["date_to"] = filters["date_to"]
    if filters.get("months"):
        month_clauses = []
        for i, (y, m) in enumerate(filters["months"]):
            month_clauses.append(f"(EXTRACT(year FROM lead_date) = :_my{i} AND EXTRACT(month FROM lead_date) = :_mm{i})")
            params[f"_my{i}"] = y
            params[f"_mm{i}"] = m
        where_clauses.append("(" + " OR ".join(month_clauses) + ")")
    if filters.get("source"):
        where_clauses.append("source = :source")
        params["source"] = filters["source"]
    if filters.get("asm"):
        where_clauses.append("assigned_asm = :asm")
        params["asm"] = filters["asm"]
    if filters.get("call_status"):
        where_clauses.append("call_status = :call_status")
        params["call_status"] = filters["call_status"]
    if filters.get("review_status"):
        where_clauses.append("review_status = :review_status")
        params["review_status"] = filters["review_status"]
    if filters.get("reason_category"):
        where_clauses.append("reason_category = :reason_category")
        params["reason_category"] = filters["reason_category"]
    if filters.get("state"):
        where_clauses.append("state = :state")
        params["state"] = filters["state"]


def lead_key(lead_date, source, mobile, name) -> tuple:
    """Identity of one lead across uploads (see upload_leads)."""
    who = (mobile or "").strip() or "name:" + (name or "").strip().lower()
    return (str(lead_date), (source or "").strip().lower(), who)


# ── Upload ───────────────────────────────────────────────────────────────────
@router.post("/upload")
async def upload_leads(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    filename: str = file.filename or "upload"
    if not filename.lower().endswith((".xlsx", ".xls", ".csv")):
        raise HTTPException(status_code=400, detail="Only .xlsx, .xls, or .csv files are accepted")

    file_bytes = await file.read()

    log = UploadLog(
        id=uuid.uuid4(),
        module="leads",
        filename=filename,
        status="Processing",
        uploaded_by=current_user.id,
    )
    db.add(log)
    db.commit()
    db.refresh(log)

    records, errors = parse_leads_file(file_bytes, filename)

    # ── Upsert, not append ────────────────────────────────────────────────────
    # The same monthly sheet gets uploaded again as it fills up (and as review
    # statuses move Follow Up → Closed Won). Appending doubled every lead each
    # time; instead a lead already on file is updated in place and only new
    # ones are inserted. Identity = date + channel + mobile (name when there is
    # no mobile). Repeats of a key inside one file collapse to the last row.
    # Copies of a key already stored more than once (left by uploads made
    # before this rule) are removed, so re-uploading a month's sheet repairs
    # that month's doubled counts.
    by_key: dict[tuple, dict] = {}
    for rec in records:
        by_key[lead_key(rec["lead_date"], rec["source"], rec["mobile_number"], rec["customer_name"])] = rec
    within_file_dupes = len(records) - len(by_key)

    inserted = updated = duplicates_removed = 0
    if by_key:
        dates = [date.fromisoformat(k[0]) for k in by_key]
        existing: dict[tuple, list[Lead]] = {}
        for lead in db.query(Lead).filter(Lead.lead_date >= min(dates), Lead.lead_date <= max(dates)):
            existing.setdefault(
                lead_key(str(lead.lead_date), lead.source, _parse_mobile(lead.mobile_number), lead.customer_name), []
            ).append(lead)
        for key, rec in by_key.items():
            matches = existing.get(key)
            if not matches:
                db.add(Lead(id=uuid.uuid4(), upload_log_id=log.id, uploaded_by=current_user.id, **rec))
                inserted += 1
                continue
            lead, extras = matches[0], matches[1:]
            for field, value in rec.items():
                setattr(lead, field, value)
            lead.upload_log_id = log.id  # type: ignore[assignment]
            updated += 1
            for extra in extras:
                db.delete(extra)
                duplicates_removed += 1

    info_msgs   = [e for e in errors if e.startswith("INFO:")]
    real_errors = [e for e in errors if not e.startswith("INFO:")]
    skipped = sum(int(m.split()[1]) for m in info_msgs if "summary" in m) if info_msgs else 0
    fatal = not records and bool(real_errors)

    log.rows_total   = len(records) + len(real_errors) + skipped  # type: ignore[assignment]
    log.rows_success = inserted + updated                         # type: ignore[assignment]
    log.rows_failed  = len(real_errors)                           # type: ignore[assignment]
    log.status       = "Failed" if fatal else "Done"              # type: ignore[assignment]
    log.error_details = "\n".join(real_errors) if real_errors else None  # type: ignore[assignment]
    db.commit()

    return {
        "upload_id": str(log.id),
        "filename": file.filename,
        "rows_inserted": inserted,
        "rows_updated": updated,
        "rows_duplicate_in_file": within_file_dupes,
        "rows_duplicates_removed": duplicates_removed,
        "rows_skipped_summary": skipped,
        "rows_failed": len(real_errors),
        "errors": real_errors[:20],
        "info": [m[len("INFO:"):].strip() for m in info_msgs],
        "status": log.status,
    }


@router.delete("/uploads/{upload_id}")
def delete_upload(
    upload_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Undo an upload: remove the leads it CREATED, and its history entry.

    An upload also updates leads that were already stored (and re-tags them
    with its id); those are older leads and must survive — only rows inserted
    by this upload (created after it started) are deleted. Leads a later
    upload re-touched carry that later upload's id and are not affected.
    """
    require_module(db, current_user, MODULE_KEY)
    if current_user.role not in ("superadmin", "leads_head"):
        raise HTTPException(status_code=403, detail="Only a superadmin or leads head can delete an upload")
    log = db.query(UploadLog).filter(UploadLog.id == upload_id, UploadLog.module == "leads").first()
    if not log:
        raise HTTPException(status_code=404, detail="Upload not found")
    removed = db.query(Lead).filter(
        Lead.upload_log_id == upload_id,
        Lead.created_at >= log.uploaded_at,
    ).delete(synchronize_session=False)
    db.delete(log)
    db.commit()
    return {"deleted_leads": removed}


# ── Filter options (populate dropdowns) ───────────────────────────────────────
@router.get("/filter-options")
def filter_options(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return distinct values for all filterable fields."""
    require_module(db, current_user, MODULE_KEY)

    months = db.execute(text("""
        SELECT DISTINCT
            EXTRACT(year FROM lead_date)::int  AS year,
            EXTRACT(month FROM lead_date)::int AS month,
            TO_CHAR(lead_date, 'Mon YYYY')     AS label,
            MIN(lead_date)::text               AS date_from,
            MAX(lead_date)::text               AS date_to
        FROM leads
        GROUP BY year, month, label
        ORDER BY year, month
    """)).fetchall()

    base_q = db.query(Lead)
    sources       = [r[0] for r in base_q.with_entities(Lead.source).distinct().order_by(Lead.source).all() if r[0]]
    asms          = [r[0] for r in base_q.with_entities(Lead.assigned_asm).filter(Lead.assigned_asm.isnot(None)).distinct().order_by(Lead.assigned_asm).all()]
    call_statuses = [r[0] for r in base_q.with_entities(Lead.call_status).filter(Lead.call_status.isnot(None)).distinct().order_by(Lead.call_status).all()]
    rev_statuses  = [r[0] for r in base_q.with_entities(Lead.review_status).filter(Lead.review_status.isnot(None)).distinct().order_by(Lead.review_status).all()]
    reason_cats   = [r[0] for r in base_q.with_entities(Lead.reason_category).filter(Lead.reason_category.isnot(None)).distinct().order_by(Lead.reason_category).all()]
    states        = [r[0] for r in base_q.with_entities(Lead.state).filter(Lead.state.isnot(None)).distinct().order_by(Lead.state).all()]

    return {
        "months":        [{"year": r.year, "month": r.month, "label": r.label, "date_from": r.date_from, "date_to": r.date_to} for r in months],
        "sources":       sources,
        "asms":          asms,
        "call_statuses": call_statuses,
        "rev_statuses":  rev_statuses,
        "reason_cats":   reason_cats,
        "states":        states,
    }


# ── Unified analytics (all charts, filter-aware) ──────────────────────────────
@router.get("/analytics")
def leads_analytics(
    date_from:       Optional[date] = None,
    date_to:         Optional[date] = None,
    months:          Optional[str]  = None,
    source:          Optional[str]  = None,
    asm:             Optional[str]  = None,
    call_status:     Optional[str]  = None,
    review_status:   Optional[str]  = None,
    reason_category: Optional[str]  = None,
    state:           Optional[str]  = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    filters = {
        "date_from": date_from, "date_to": date_to, "months": parse_months_param(months),
        "source": source, "asm": asm,
        "call_status": call_status, "review_status": review_status,
        "reason_category": reason_category, "state": state,
    }

    base = apply_filters(db.query(Lead), filters)

    # ── KPIs ──────────────────────────────────────────────────────────────────
    total     = base.count()
    base2 = apply_filters(db.query(Lead), filters)
    closed_won = base2.filter(Lead.review_status == "Closed Won").count()
    conv_rate  = round((closed_won / total * 100), 1) if total > 0 else 0.0

    base3 = apply_filters(db.query(Lead), filters)
    follow_up = base3.filter(Lead.review_status == "Follow Up").count()

    base4 = apply_filters(db.query(Lead), filters)
    closed_lost = base4.filter(Lead.review_status == "Closed Lost").count()

    # ── Trends ────────────────────────────────────────────────────────────────
    where_clauses = ["1=1"]
    params: dict = {}
    apply_filters_text(where_clauses, params, filters)
    where_sql = " AND ".join(where_clauses)

    trend_rows = db.execute(text(f"""
        SELECT date_trunc('month', lead_date)::date AS period,
               COUNT(*) AS count,
               COUNT(*) FILTER (WHERE review_status = 'Closed Won') AS closed_won,
               COUNT(*) FILTER (WHERE review_status = 'Follow Up')  AS follow_up
        FROM leads
        WHERE {where_sql}
        GROUP BY period ORDER BY period ASC
    """), params).fetchall()

    # ── Source breakdown ───────────────────────────────────────────────────────
    src_q = apply_filters(db.query(Lead.source, func.count(Lead.id).label("count")), filters)
    src_rows = src_q.group_by(Lead.source).order_by(func.count(Lead.id).desc()).all()

    # ── Call status ────────────────────────────────────────────────────────────
    cs_q = apply_filters(db.query(Lead.call_status, func.count(Lead.id).label("count")), filters)
    cs_rows = cs_q.filter(Lead.call_status.isnot(None)).group_by(Lead.call_status).order_by(func.count(Lead.id).desc()).all()

    # ── Review status ──────────────────────────────────────────────────────────
    rs_q = apply_filters(db.query(Lead.review_status, func.count(Lead.id).label("count")), filters)
    rs_rows = rs_q.filter(Lead.review_status.isnot(None)).group_by(Lead.review_status).order_by(func.count(Lead.id).desc()).all()

    # ── Reason categories ──────────────────────────────────────────────────────
    rc_q = apply_filters(db.query(Lead.reason_category, func.count(Lead.id).label("count")), filters)
    rc_rows = rc_q.filter(Lead.reason_category.isnot(None)).group_by(Lead.reason_category).order_by(func.count(Lead.id).desc()).all()

    # ── ASM performance ────────────────────────────────────────────────────────
    asm_q = apply_filters(
        db.query(
            Lead.assigned_asm,
            func.count(Lead.id).label("total"),
            func.sum(case((Lead.review_status == "Closed Won", 1), else_=0)).label("closed_won"),
        ),
        filters,
    )
    asm_rows = asm_q.filter(Lead.assigned_asm.isnot(None))\
        .group_by(Lead.assigned_asm)\
        .order_by(func.count(Lead.id).desc()).all()

    # ── Top states ─────────────────────────────────────────────────────────────
    state_q = apply_filters(db.query(Lead.state, func.count(Lead.id).label("count")), filters)
    state_rows = state_q.filter(Lead.state.isnot(None)).group_by(Lead.state).order_by(func.count(Lead.id).desc()).limit(10).all()

    return {
        "kpis": {
            "total": total,
            "closed_won": closed_won,
            "follow_up": follow_up,
            "closed_lost": closed_lost,
            "conversion_rate": conv_rate,
            "top_source": src_rows[0].source if src_rows else None,
            "top_source_count": src_rows[0].count if src_rows else 0,
        },
        "trends": [
            {"period": str(r.period), "count": r.count, "closed_won": r.closed_won, "follow_up": r.follow_up}
            for r in trend_rows
        ],
        "sources":         [{"source": r.source, "count": r.count} for r in src_rows],
        "call_status":     [{"status": r.call_status, "count": r.count} for r in cs_rows],
        "review_status":   [{"status": r.review_status, "count": r.count} for r in rs_rows],
        "reason_categories":[{"category": r.reason_category, "count": r.count} for r in rc_rows],
        "asm_performance": [{"asm": r.assigned_asm, "total": r.total, "closed_won": r.closed_won or 0} for r in asm_rows],
        "top_states":      [{"state": r.state, "count": r.count} for r in state_rows],
    }


# ── Paginated list (filter-aware) ─────────────────────────────────────────────
@router.get("/list")
def leads_list(
    page:            int           = Query(1, ge=1),
    per_page:        int           = Query(50, ge=1, le=200),
    date_from:       Optional[date] = None,
    date_to:         Optional[date] = None,
    months:          Optional[str]  = None,
    source:          Optional[str]  = None,
    asm:             Optional[str]  = None,
    call_status:     Optional[str]  = None,
    review_status:   Optional[str]  = None,
    reason_category: Optional[str]  = None,
    state:           Optional[str]  = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    filters = {
        "date_from": date_from, "date_to": date_to, "months": parse_months_param(months),
        "source": source, "asm": asm,
        "call_status": call_status, "review_status": review_status,
        "reason_category": reason_category, "state": state,
    }
    q = apply_filters(db.query(Lead), filters)
    total = q.count()
    leads = q.order_by(Lead.lead_date.desc()).offset((page - 1) * per_page).limit(per_page).all()

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "data": [
            {
                "id": str(l.id),
                "lead_date": str(l.lead_date),
                "source": l.source,
                "customer_name": l.customer_name,
                "mobile_number": l.mobile_number,
                "car_type": l.car_type,
                "product_type": l.product_type,
                "location": l.location,
                "state": l.state,
                "call_status": l.call_status,
                "reason_category": l.reason_category,
                "assigned_asm": l.assigned_asm,
                "review_status": l.review_status,
                "review_reason": l.review_reason,
            }
            for l in leads
        ],
    }


# ── Upload history ────────────────────────────────────────────────────────────
@router.get("/upload-history")
def upload_history(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    # Same rule as the row scoping above — dropped for the same reason. A staff
    # user who can see every lead but an empty Upload History tab is a confusing
    # half-state; module access now decides both.
    q = db.query(UploadLog).filter(UploadLog.module == "leads")

    logs = q.order_by(UploadLog.uploaded_at.desc()).limit(50).all()
    return [
        {
            "id": str(l.id),
            "filename": l.filename,
            "rows_total": l.rows_total,
            "rows_success": l.rows_success,
            "rows_failed": l.rows_failed,
            "status": l.status,
            "uploaded_at": l.uploaded_at.isoformat() if l.uploaded_at else None,
        }
        for l in logs
    ]
