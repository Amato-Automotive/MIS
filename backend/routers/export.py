"""
AutoForm MIS — Export (UK / EU / AU lead pipeline) Router

One registered workbook, two tabs read (`Leads`, `Activity`). Registry and sync
follow the standard sheet_sources pattern. The read side:

  /summary, /leads   the pipeline as it stands TODAY. Not time-scoped: the
                     Leads tab is a snapshot, and a month picker over it would
                     only filter by whichever date column it chose.
  /periods, /activity  what HAPPENED in a period — stage moves recorded by the
                     sync, closes, and the team's activity log. Time-scoped,
                     with the standard period controls.

All four take the same lead filters, so a figure on one always matches the rows
on another.

The data is a few dozen rows, so the endpoints load the filtered rows and
compute in Python (services/export_leads_sync, services/export_history) rather
than in SQL. That keeps the rules — what counts as open, absent vs zero, what an
arrival is — in pure functions with tests, instead of spread across aggregates.

Who can do what:
  • read and press Sync — anyone holding the 'export' module. Sync pulls the
    one sheet the module owns; there is nothing to choose.
  • register or remove the sheet — superadmin / management only, because
    removing it wipes the pipeline (but not its stage history — see
    export_lead_events in migrate_phase27).
There is no row-level scope yet: the lead owners are not MIS users today.
"""
import calendar
import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from database import get_db
from models import SheetSource, SyncLog, User
from routers.auth import get_current_user
from routers.oe_network import _bulk_insert, _db_message
from services.export_history import build_period, diff_leads, stage_entries
from services.export_leads_sync import (
    ACTIVITY_TYPES, LOST_REASONS, REGION_LABELS, REGIONS, STAGES, STATUSES,
    build_summary, company_key, enrich, parse_leads,
)
from services.google_sheets import extract_sheet_id
from services.period_filters import date_bounds, parse_ym
from services.permissions import require_module
from services.sync_logs import SYNC_LOG_RETENTION, prune_sync_logs

router = APIRouter(prefix="/export", tags=["Export"])

MODULE_KEY = "export"
MODULE = "export_leads"
LABEL = "Export Leads"

# An open lead with no contact for longer than this is flagged as stale. The
# team has not set a figure; a month is the default and the caller may pass
# its own, which the response echoes so the UI can say what it used.
DEFAULT_STALE_DAYS = 30

# Events are stamped in UTC; the team works in IST, and a sync at 01:00 IST
# belongs to that IST day, not the previous UTC one.
_LOCAL_DAY = "CAST((observed_at AT TIME ZONE 'Asia/Kolkata') AS date)"

_LEAD_COLS = ("id", "sheet_source_id", "sheet_row", "company", "owner", "customer_type",
              "country", "region", "city", "contact_person", "contact_email", "contact_phone",
              "stage_no", "stage_since", "status", "closed_date", "lost_reason", "potential_cr",
              "last_contact", "next_action", "next_action_date", "source", "remarks", "sync_log_id")
# Everything a reader sees; ids and provenance stay server-side.
_READ_COLS = [c for c in _LEAD_COLS if c not in ("id", "sheet_source_id", "sync_log_id")]
_ACTIVITY_COLS = ("id", "sheet_source_id", "sheet_row", "activity_date", "company", "company_key",
                  "matched", "activity_type", "by_person", "notes", "sync_log_id")
_EVENT_COLS = ("id", "company", "company_key", "kind", "from_stage", "to_stage",
               "from_status", "to_status", "sync_log_id")
_DATE_FIELDS = ("stage_since", "last_contact", "next_action_date", "closed_date")


def _require_access(db: Session, current_user: User) -> None:
    require_module(db, current_user, MODULE_KEY)


def _require_admin(db: Session, current_user: User) -> None:
    require_module(db, current_user, MODULE_KEY)
    if current_user.role not in {"superadmin", "management"}:
        raise HTTPException(status_code=403,
                            detail="Only a superadmin or management user can manage the export sheet")


def _source(db: Session) -> Optional[SheetSource]:
    return db.query(SheetSource).filter(SheetSource.module == MODULE).first()


def _last_log(db: Session, s: SheetSource) -> Optional[SyncLog]:
    return (db.query(SyncLog)
            .filter(SyncLog.module == MODULE, SyncLog.source_label == s.sheet_id)
            .order_by(SyncLog.synced_at.desc()).first())


def _source_out(db: Session, s: SheetSource) -> dict:
    log = _last_log(db, s)
    return {
        "id": str(s.id), "sheet_id": s.sheet_id, "label": s.label,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "last_synced_at": log.synced_at.isoformat() if log and log.synced_at else None,
        "last_sync_status": log.status if log else None,
    }


# ── Registry ──────────────────────────────────────────────────────────────────

class SheetSourceIn(BaseModel):
    sheet_url_or_id: str


@router.post("/sheet-sources")
def add_sheet_source(body: SheetSourceIn, db: Session = Depends(get_db),
                     current_user: User = Depends(get_current_user)):
    _require_admin(db, current_user)
    source = SheetSource(id=uuid.uuid4(), module=MODULE,
                         sheet_id=extract_sheet_id(body.sheet_url_or_id),
                         label=LABEL, created_by=current_user.id)
    db.add(source)
    try:
        db.commit()
    except IntegrityError:
        # One workbook per module, enforced by a partial unique index.
        db.rollback()
        raise HTTPException(status_code=400,
                            detail="An export sheet is already registered — remove it first to replace it")
    db.refresh(source)
    return _source_out(db, source)


@router.get("/sheet-sources")
def list_sheet_sources(db: Session = Depends(get_db),
                       current_user: User = Depends(get_current_user)):
    _require_access(db, current_user)
    s = _source(db)
    return [_source_out(db, s)] if s else []


@router.delete("/sheet-sources/{source_id}")
def delete_sheet_source(source_id: str, db: Session = Depends(get_db),
                        current_user: User = Depends(get_current_user)):
    _require_admin(db, current_user)
    source = db.query(SheetSource).filter(SheetSource.id == source_id,
                                          SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    rows = db.execute(text("SELECT COUNT(*) FROM export_leads WHERE sheet_source_id = :sid"),
                      {"sid": str(source.id)}).scalar()
    # ON DELETE CASCADE wipes the leads and activities. Stage history is not
    # tied to the source and survives, so re-registering (e.g. the team's real
    # workbook in place of a copy) carries it on.
    db.delete(source)
    db.commit()
    return {"deleted": True, "rows_deleted": rows}


# ── Sync ──────────────────────────────────────────────────────────────────────

def run_sync(db: Session, source: SheetSource, user_id) -> dict:
    """Pull the workbook and replace the stored copy, recording what changed.

    Everything — the diff against the stored leads, the history rows, the
    delete-then-insert of leads and activities — commits as one transaction
    under a NOWAIT lock on the source row taken before the fetch. So two
    presses of Sync cannot both insert, and a failure leaves both the data and
    the history exactly as they were.

    Shared by the Sync button and scripts/sync_export.py (the nightly run);
    `user_id` is None for the latter. Raises HTTPException on failure.
    """
    log = SyncLog(id=uuid.uuid4(), module=MODULE, source_label=source.sheet_id,
                  status="Processing", synced_by=user_id)
    db.add(log)
    db.commit()
    db.refresh(log)
    prune_sync_logs(db, MODULE, source.sheet_id)

    try:
        db.execute(text("SELECT 1 FROM sheet_sources WHERE id = :id FOR UPDATE NOWAIT"),
                   {"id": str(source.id)})
    except OperationalError:
        db.rollback()
        log.status = "Failed"
        log.error_details = "A sync for this sheet was already running."
        db.commit()
        raise HTTPException(status_code=409,
                            detail="The export sheet is already syncing — wait for that run to finish.")

    def fail(status: int, detail: str, stored: str):
        db.rollback()
        log.status = "Failed"
        log.error_details = stored
        db.commit()
        raise HTTPException(status_code=status, detail=detail)

    try:
        records, activities, errors = parse_leads(source.sheet_id)
    except Exception as e:
        fail(502, f"Could not sync from Google Sheets: {_db_message(e)}", _db_message(e, 4000))

    # A tab that could not be found or read yields no rows. Replacing the
    # pipeline with nothing would look like the team closed every lead — and
    # would write a "removed" event for every one of them — so an empty parse
    # fails the sync and leaves the last good data in place.
    if not records:
        msg = "\n".join(errors) or "No lead rows found."
        fail(422, msg, msg)

    try:
        sid = str(source.id)
        prev = db.execute(text("SELECT company, stage_no, status FROM export_leads WHERE sheet_source_id = :sid"),
                          {"sid": sid}).mappings().all()
        events = diff_leads([dict(r) for r in prev], records)

        deleted = db.execute(text("DELETE FROM export_leads WHERE sheet_source_id = :sid"),
                             {"sid": sid}).rowcount
        db.execute(text("DELETE FROM export_activities WHERE sheet_source_id = :sid"), {"sid": sid})
        stamp = {"sheet_source_id": sid, "sync_log_id": str(log.id)}
        written = _bulk_insert(db, "export_leads", _LEAD_COLS,
                               [{**r, **stamp, "id": str(uuid.uuid4())} for r in records])
        _bulk_insert(db, "export_activities", _ACTIVITY_COLS,
                     [{**a, **stamp, "id": str(uuid.uuid4())} for a in activities])
        _bulk_insert(db, "export_lead_events", _EVENT_COLS,
                     [{**e, "sync_log_id": str(log.id), "id": str(uuid.uuid4())} for e in events])
        db.commit()
    except Exception as e:
        fail(500, f"Could not store synced rows: {_db_message(e)}", _db_message(e, 4000))

    log.rows_total = log.rows_inserted = written
    log.rows_updated = log.rows_failed = 0
    log.rows_deleted = deleted
    log.status = "Done"
    log.error_details = "\n".join(errors) if errors else None
    db.commit()
    changes = [e for e in events if e["kind"] != "baseline"]
    return {
        "sync_id": str(log.id), "rows_total": written, "rows_inserted": written,
        "rows_updated": 0, "rows_failed": 0, "rows_deleted": deleted,
        "activities": len(activities),
        # A first sync records a starting point, not changes — say which.
        "baseline": len(events) - len(changes),
        "changes": len(changes),
        # These are the sheet's data problems, worded for the export team.
        "warnings": errors[:50], "status": "Done",
    }


@router.post("/sync")
def sync(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _require_access(db, current_user)
    source = _source(db)
    if not source:
        raise HTTPException(status_code=400, detail="No export sheet registered yet")
    return run_sync(db, source, current_user.id)


@router.get("/sync-history")
def sync_history(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The last few runs, with their warnings — the warnings are the list of
    things to fix in the sheet, so they are worth showing, not just logging."""
    _require_access(db, current_user)
    logs = (db.query(SyncLog).filter(SyncLog.module == MODULE)
            .order_by(SyncLog.synced_at.desc()).limit(SYNC_LOG_RETENTION).all())
    return [{
        "id": str(l.id), "status": l.status,
        "synced_at": l.synced_at.isoformat() if l.synced_at else None,
        "rows_inserted": l.rows_inserted, "rows_deleted": l.rows_deleted,
        "warnings": l.error_details.split("\n") if l.error_details else [],
    } for l in logs]


# ── Read side ─────────────────────────────────────────────────────────────────

def _filters(
    owner: Optional[str] = None,
    customer_type: Optional[str] = None,
    region: Optional[str] = Query(None, description="UK | EU | AU"),
    country: Optional[str] = None,
    stage: Optional[int] = Query(None, ge=1, le=11),
    status: Optional[str] = Query(None, description="Active | On Hold | Won | Lost"),
    source: Optional[str] = None,
    q: Optional[str] = Query(None, description="Free text over company, contact, city, next action, remarks"),
    stale_days: int = Query(DEFAULT_STALE_DAYS, ge=1, le=365),
) -> dict:
    return dict(owner=owner, customer_type=customer_type, region=region, country=country,
                stage=stage, status=status, source=source, q=q, stale_days=stale_days)


def _lead_filtered(f: dict) -> bool:
    return any(f[k] not in (None, "") for k in f if k != "stale_days")


def _stage_entries(db: Session) -> dict:
    """{company_key: (kind, date)} each company arrived at its current stage —
    see services/export_history.stage_entries for the rules."""
    rows = db.execute(text(f"""
        SELECT company_key, kind, to_stage, {_LOCAL_DAY} AS observed_on
        FROM export_lead_events
        WHERE kind IN ('baseline', 'added', 'stage')
        ORDER BY observed_at, id
    """)).mappings().all()
    return stage_entries([dict(r) for r in rows])


def _load(db: Session, owner, customer_type, region, country, stage, status, source, q,
          stale_days: int) -> list:
    """Filtered, enriched leads. Shared by every read endpoint so they cannot
    disagree about which rows a filter selects."""
    where, params = ["1=1"], {}
    for col, val in (("owner", owner), ("customer_type", customer_type), ("region", region),
                     ("country", country), ("status", status), ("source", source)):
        if val:
            where.append(f"{col} = :{col}")
            params[col] = val
    if stage is not None:
        where.append("stage_no = :stage")
        params["stage"] = stage
    if q and q.strip():
        where.append("(company ILIKE :q OR contact_person ILIKE :q OR city ILIKE :q"
                     " OR next_action ILIKE :q OR remarks ILIKE :q)")
        params["q"] = f"%{q.strip()}%"
    rows = db.execute(text(
        f"SELECT {', '.join(_READ_COLS)} FROM export_leads WHERE {' AND '.join(where)}"
        f" ORDER BY sheet_row"), params).mappings().all()
    entries = _stage_entries(db)
    today = date.today()
    out = []
    for r in rows:
        d = dict(r)
        if d["potential_cr"] is not None:
            d["potential_cr"] = float(d["potential_cr"])
        kind, on = entries.get(company_key(d["company"]), (None, None))
        d["stage_entered_kind"], d["stage_entered_on"] = kind, on
        out.append(enrich(d, today, stale_days))
    return out


def _sync_meta(db: Session) -> dict:
    s = _source(db)
    log = _last_log(db, s) if s else None
    return {
        "registered": s is not None,
        "last_synced_at": log.synced_at.isoformat() if log and log.synced_at else None,
        "last_sync_status": log.status if log else None,
    }


def _tracking_since(db: Session) -> Optional[date]:
    return db.execute(text(f"SELECT MIN({_LOCAL_DAY}) FROM export_lead_events")).scalar()


@router.get("/filter-options")
def filter_options(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Every value in the table, never only those the current filter left."""
    _require_access(db, current_user)

    def distinct(col: str) -> list:
        return [r[0] for r in db.execute(text(
            f"SELECT DISTINCT {col} FROM export_leads WHERE {col} IS NOT NULL ORDER BY {col}"))]

    present_regions = set(distinct("region"))
    return {
        "owners": distinct("owner"),
        "customer_types": distinct("customer_type"),
        "regions": [{"value": r, "label": REGION_LABELS[r]} for r in REGIONS if r in present_regions],
        "countries": distinct("country"),
        # Stages and statuses are fixed vocabularies — offered whole, so a
        # stage nobody is at yet can still be picked and shows an empty list
        # rather than being missing from the dropdown.
        "stages": [{"value": n, "label": f"{n} - {name}"} for n, name in STAGES.items()],
        "statuses": list(STATUSES),
        "sources": distinct("source"),
    }


@router.get("/summary")
def summary(f: dict = Depends(_filters), db: Session = Depends(get_db),
            current_user: User = Depends(get_current_user)):
    """Everything the Pipeline tab draws, in one round trip."""
    _require_access(db, current_user)
    rows = _load(db, **f)
    since = _tracking_since(db)
    return {
        **build_summary(rows, date.today(), f["stale_days"]),
        "lost_reason_options": list(LOST_REASONS),
        "tracking_since": since.isoformat() if since else None,
        "region_labels": REGION_LABELS,
        "sync": _sync_meta(db),
    }


@router.get("/leads")
def leads(f: dict = Depends(_filters), db: Session = Depends(get_db),
          current_user: User = Depends(get_current_user)):
    """The filtered lead list with its derived ageing fields and its latest
    few activities, in sheet order. A few dozen rows, so no pagination —
    sorting is the client's."""
    _require_access(db, current_user)
    rows = _load(db, **f)
    recent: dict = {}
    for a in db.execute(text("""
        SELECT company_key, activity_date, activity_type, by_person, notes FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY company_key
                                         ORDER BY activity_date DESC, sheet_row DESC) AS rn
            FROM export_activities WHERE matched) t
        WHERE rn <= 5 ORDER BY company_key, activity_date DESC
    """)).mappings():
        recent.setdefault(a["company_key"], []).append({
            "date": a["activity_date"].isoformat(), "activity_type": a["activity_type"],
            "by_person": a["by_person"], "notes": a["notes"]})
    for r in rows:
        for k in _DATE_FIELDS:
            if r[k] is not None:
                r[k] = r[k].isoformat()
        r.pop("stage_entered_on", None)
        r.pop("stage_entered_kind", None)
        r["recent_activity"] = recent.get(company_key(r["company"]), [])
    return {"leads": rows, "stale_days": f["stale_days"], "sync": _sync_meta(db)}


def _window(from_ym, to_ym, from_date, to_date):
    """The period controls' selection as inclusive dates; (None, None) is all
    time. Events and activities carry real days, so a custom day range is
    honoured to the day — nothing here needs snapping to months."""
    d1, d2 = date_bounds(from_date, to_date)
    if d1:
        return d1, d2
    m1, m2 = parse_ym(from_ym, "from_ym"), parse_ym(to_ym, "to_ym")
    if m1 and m2:
        if m1 > m2:
            raise HTTPException(status_code=400, detail="from_ym is after to_ym")
        y2, mo2 = divmod(m2, 100)
        return date(*divmod(m1, 100), 1), date(y2, mo2, calendar.monthrange(y2, mo2)[1])
    return None, None


@router.get("/periods")
def periods(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Months that have anything to show on the Activity tab, newest first —
    fetched before the first data request, so the tab can open on the newest
    month with data rather than on an empty current month."""
    _require_access(db, current_user)
    rows = db.execute(text(f"""
        SELECT DISTINCT y, m FROM (
            SELECT EXTRACT(YEAR FROM {_LOCAL_DAY}) AS y, EXTRACT(MONTH FROM {_LOCAL_DAY}) AS m
            FROM export_lead_events WHERE kind <> 'baseline'
            UNION ALL
            SELECT EXTRACT(YEAR FROM activity_date), EXTRACT(MONTH FROM activity_date) FROM export_activities
            UNION ALL
            SELECT EXTRACT(YEAR FROM closed_date), EXTRACT(MONTH FROM closed_date)
            FROM export_leads WHERE closed_date IS NOT NULL
        ) t ORDER BY y DESC, m DESC
    """)).fetchall()
    since = _tracking_since(db)
    return {
        "months": [{"year": int(r.y), "month": int(r.m)} for r in rows],
        "tracking_since": since.isoformat() if since else None,
    }


@router.get("/activity")
def activity(
    f: dict = Depends(_filters),
    from_ym: Optional[str] = Query(None, description="YYYY-MM; the shared period controls"),
    to_ym: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD; the custom day range"),
    to_date: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """What happened in the selected period, for the leads the filters select.

    A lead filter can only be applied to companies that are still on the
    Leads tab, so with one active, removed leads and activity logged against
    an unknown company drop out — the response says so (`lead_filtered`).
    """
    _require_access(db, current_user)
    d1, d2 = _window(from_ym, to_ym, from_date, to_date)
    leads_ = _load(db, **f)
    filtered = _lead_filtered(f)
    keys = {company_key(l["company"]) for l in leads_}

    events = [dict(r) for r in db.execute(text(f"""
        SELECT company, company_key, kind, from_stage, to_stage, from_status, to_status,
               {_LOCAL_DAY} AS observed_on
        FROM export_lead_events ORDER BY observed_at
    """)).mappings()]
    acts = [dict(r) for r in db.execute(text("""
        SELECT activity_date, company, company_key, matched, activity_type, by_person, notes
        FROM export_activities ORDER BY activity_date, sheet_row
    """)).mappings()]
    if filtered:
        events = [e for e in events if e["company_key"] in keys]
        acts = [a for a in acts if a["company_key"] in keys]

    out = build_period(events, acts, leads_, d1, d2, ACTIVITY_TYPES)
    since = _tracking_since(db)
    return {
        **out,
        "window": {"from": d1.isoformat() if d1 else None, "to": d2.isoformat() if d2 else None},
        "lead_filtered": filtered,
        "tracking_since": since.isoformat() if since else None,
        "activity_types": list(ACTIVITY_TYPES),
        "sync": _sync_meta(db),
    }
