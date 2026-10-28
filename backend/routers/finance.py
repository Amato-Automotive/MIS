"""
AutoForm MIS — Finance v2 Router (whole-sheet, 14-section template)

Per-company sheet registry (one Google Sheet per company; monthly and/or yearly
tabs), manual "Sync Now" per registered sheet, tab-scoped analytics
(balance_sheet / profit_loss for Phase A) with stock-vs-flow-aware KPI math over
a merged monthly + yearly timeline, sync history.

Backed by the single generic finance_lines table (see migrate_phase9_finance_v2.sql).
Gated by the per-user module/company permission system (services/permissions.py).
"""
import uuid
from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text, bindparam
from database import get_db
from models import SheetSource, SyncLog, User
from routers.auth import get_current_user
from services.google_sheets import extract_sheet_id
from services.finance_sync import fetch_and_parse_finance_by_company, _slugify
from services.permissions import require_module, require_sheet_source_access, get_user_sheet_source_ids
from services.sync_logs import SYNC_LOG_RETENTION, prune_sync_logs

router = APIRouter(prefix="/finance", tags=["Finance"])

MODULE = "finance"
MODULE_KEY = "finance"
_MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Which sheet sections feed which dashboard tab. Order here is the render order
# of the section groups within a tab.
BALANCE_SHEET_SECTIONS = ["balance_sheet", "inventories", "working_capital", "working_capital_aging"]
PROFIT_LOSS_SECTIONS = ["sales_accounts", "profit_loss_a_c", "production_cost", "employee_s_cost"]
PLANT_OPS_SECTIONS = ["units", "average_unit_cost"]
CASH_FLOW_SECTIONS = ["cash_flow_statement"]
BUDGET_SECTIONS = ["budget"]
UNIT_ECONOMICS_SECTIONS = ["unit_economics"]

# Key Financial Ratios (section "ratios") split across the two statement tabs by
# their category sub-section. Balance-sheet-driven ratios on the BS tab;
# earnings ratios on the P&L tab. ("eficiency" is the sheet's own spelling.)
BS_RATIO_SUBS = ["liquidity_ratio", "eficiency_ratio", "efficiency_ratio", "solvency_ratio"]
PL_RATIO_SUBS = ["profitability_ratio", "growth_ratio"]
_RATIO_SUB_LABELS = {
    "liquidity_ratio": "Liquidity", "eficiency_ratio": "Efficiency", "efficiency_ratio": "Efficiency",
    "solvency_ratio": "Solvency", "profitability_ratio": "Profitability", "growth_ratio": "Growth",
}

# Human labels for the sub-section slugs the parser emits.
_SUB_LABELS = {
    # Budget's three blocks
    "pnl": "Profit & Loss Budget", "cash_flow": "Cash Flow Budget", "units": "Sale Units Budget",
    "sources_of_funds": "Sources of Funds",
    "application_of_funds": "Application of Funds",
    "current_assets": "Current Assets",
    "current_liabilities": "Current Liabilities",
    # §7 Units — the sheet splits every company into 4-wheeler and 2-wheeler
    # blocks, with a nested "Others" group inside each 2w block. The bare
    # sales/productions keys are the older single-block layout, still used by
    # the test masters.
    "sales": "Sales", "productions": "Production",
    "sales_4w": "Sales — 4 Wheeler", "sales_2w": "Sales — 2 Wheeler",
    "productions_4w": "Production — 4 Wheeler", "productions_2w": "Production — 2 Wheeler",
    "sales_4w/others": "Sales — 4 Wheeler · Others",
    "sales_2w/others": "Sales — 2 Wheeler · Others",
    "productions_4w/others": "Production — 4 Wheeler · Others",
    "productions_2w/others": "Production — 2 Wheeler · Others",
    # Working Capital Aging (§8) sub-headers
    "inventory": "Inventory", "debtors": "Debtors", "creditors": "Creditors",
    # Cash Flow Statement (§15) activities
    "operating_activities": "Operating Activities",
    "investing_activities": "Investing Activities",
    "financing_activities": "Financing Activities",
    "reconciliation": "Net Change & Cash Position",
}


def _fyq(y: int, m: int):
    return (y, (m - 4) // 3 + 1) if m >= 4 else (y - 1, 4)


def _signed_delta_pct(curr: float, prev):
    """% change is only meaningful when the base is strictly positive — a
    negative divided by a negative silently flips the sign. Mirrors
    aggregate.ts::computeDelta on the frontend."""
    if prev is None or curr is None or prev <= 0:
        return None
    return round((curr - prev) / prev * 100, 1)


def _growth_kpis(monthly: list) -> dict:
    """MoM/QoQ/YoY/YoY-FY growth off a flat [{year, month, amount}] flow series —
    same Indian-FY-quarter math as sales.py, generalized. Flow rule: buckets sum."""
    monthly = sorted(monthly, key=lambda x: (x["year"], x["month"]))
    out = {
        "mom_growth": None, "mom_period": None,
        "qoq_growth": None, "qoq_period": None,
        "yoy_growth": None, "yoy_period": None,
        "yoy_fy_growth": None, "yoy_fy_period": None,
    }
    if len(monthly) >= 2:
        pr, cr = monthly[-2], monthly[-1]
        if pr["amount"]:
            out["mom_growth"] = round((cr["amount"] - pr["amount"]) / pr["amount"] * 100, 1)
        out["mom_period"] = f"{_MN[pr['month'] - 1]} → {_MN[cr['month'] - 1]}"
    if monthly:
        latest = monthly[-1]
        ly = next((m["amount"] for m in monthly if m["year"] == latest["year"] - 1 and m["month"] == latest["month"]), None)
        if ly:
            out["yoy_growth"] = round((latest["amount"] - ly) / ly * 100, 1)
        out["yoy_period"] = f"{_MN[latest['month'] - 1]} {latest['year'] - 1} → {_MN[latest['month'] - 1]} {latest['year']}"
    q_totals: dict = {}
    for r in monthly:
        qk = _fyq(r["year"], r["month"])
        q_totals[qk] = q_totals.get(qk, 0.0) + r["amount"]
    sqs = sorted(q_totals)
    qn = {1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"}
    if len(sqs) >= 2:
        p_qk, c_qk = sqs[-2], sqs[-1]
        p_amt, c_amt = q_totals[p_qk], q_totals[c_qk]
        if p_amt:
            out["qoq_growth"] = round((c_amt - p_amt) / p_amt * 100, 1)
        out["qoq_period"] = f"{qn[p_qk[1]]} FY{str(p_qk[0] + 1)[-2:]} → {qn[c_qk[1]]} FY{str(c_qk[0] + 1)[-2:]}"
    fy_totals: dict = {}
    for r in monthly:
        fy_s = r["year"] if r["month"] >= 4 else r["year"] - 1
        fy_totals[fy_s] = fy_totals.get(fy_s, 0.0) + r["amount"]
    sorted_fys = sorted(fy_totals)
    if len(sorted_fys) >= 2:
        p_fy, c_fy = sorted_fys[-2], sorted_fys[-1]
        if fy_totals[p_fy]:
            out["yoy_fy_growth"] = round((fy_totals[c_fy] - fy_totals[p_fy]) / fy_totals[p_fy] * 100, 1)
        out["yoy_fy_period"] = f"FY{str(p_fy + 1)[-2:]} → FY{str(c_fy + 1)[-2:]}"
    return out


def _stock_growth(series: list) -> dict:
    """MoM/QoQ/YoY deltas for a point-in-time (stock) total series — last value
    within each bucket, never summed. `series` is [{period_end_date, amount}]
    already ordered by date, dates as ISO strings."""
    out = {"mom_delta_pct": None, "mom_period": None, "qoq_delta_pct": None,
           "qoq_period": None, "yoy_delta_pct": None, "yoy_period": None}
    if len(series) >= 2:
        prev, curr = series[-2], series[-1]
        out["mom_delta_pct"] = _signed_delta_pct(curr["amount"], prev["amount"])
        out["mom_period"] = f"{prev['period_end_date']} → {curr['period_end_date']}"
    if not series:
        return out
    q_latest: dict = {}
    for p in series:
        d = date.fromisoformat(p["period_end_date"])
        qk = _fyq(d.year, d.month)
        if qk not in q_latest or d > date.fromisoformat(q_latest[qk]["period_end_date"]):
            q_latest[qk] = p
    sqs = sorted(q_latest)
    qn = {1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"}
    if len(sqs) >= 2:
        p_qk, c_qk = sqs[-2], sqs[-1]
        out["qoq_delta_pct"] = _signed_delta_pct(q_latest[c_qk]["amount"], q_latest[p_qk]["amount"])
        out["qoq_period"] = f"{qn[p_qk[1]]} FY{str(p_qk[0] + 1)[-2:]} → {qn[c_qk[1]]} FY{str(c_qk[0] + 1)[-2:]}"
    latest = series[-1]
    latest_d = date.fromisoformat(latest["period_end_date"])
    prior = next((p for p in series
                  if date.fromisoformat(p["period_end_date"]).year == latest_d.year - 1
                  and date.fromisoformat(p["period_end_date"]).month == latest_d.month), None)
    if prior:
        out["yoy_delta_pct"] = _signed_delta_pct(latest["amount"], prior["amount"])
        out["yoy_period"] = f"{prior['period_end_date']} → {latest['period_end_date']}"
    return out


# ── Master files (admin) ─────────────────────────────────────────────────────
# Finance v3: the finance team delivers TWO shared master spreadsheets (one
# monthly, one yearly), each holding every company as a tab. Superadmins register
# the masters; syncing a master fans its tabs out to per-company sheet_sources.
class SheetSourceIn(BaseModel):
    sheet_url_or_id: str
    label: str


def _require_admin(user: User):
    if user.role not in {"superadmin", "management"}:
        raise HTTPException(status_code=403, detail="Only a superadmin or management user can manage finance data sources")


@router.post("/masters")
def add_master(body: SheetSourceIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    _require_admin(current_user)
    sheet_id = extract_sheet_id(body.sheet_url_or_id)
    existing = db.query(SheetSource).filter(SheetSource.module == MODULE, SheetSource.kind == "master", SheetSource.sheet_id == sheet_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="This master file is already registered")
    source = SheetSource(id=uuid.uuid4(), module=MODULE, kind="master", sheet_id=sheet_id, label=body.label.strip(), created_by=current_user.id)
    db.add(source)
    db.commit()
    db.refresh(source)
    return {"id": str(source.id), "sheet_id": source.sheet_id, "label": source.label, "created_at": source.created_at.isoformat()}


@router.get("/masters")
def list_masters(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    _require_admin(current_user)
    masters = db.query(SheetSource).filter(SheetSource.module == MODULE, SheetSource.kind == "master").order_by(SheetSource.created_at.asc()).all()
    out = []
    for m in masters:
        last = db.query(SyncLog).filter(SyncLog.module == MODULE, SyncLog.source_label == m.sheet_id).order_by(SyncLog.synced_at.desc()).first()
        out.append({
            "id": str(m.id), "sheet_id": m.sheet_id, "label": m.label,
            "last_synced_at": last.synced_at.isoformat() if last and last.synced_at else None,
            "last_sync_status": last.status if last else None,
        })
    return out


@router.delete("/masters/{master_id}")
def delete_master(master_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    _require_admin(current_user)
    m = db.query(SheetSource).filter(SheetSource.id == master_id, SheetSource.module == MODULE, SheetSource.kind == "master").first()
    if not m:
        raise HTTPException(status_code=404, detail="Master file not found")
    db.delete(m)  # removes the registration only; company data stays until re-synced
    db.commit()
    return {"deleted": True}


_UPSERT_SQL = text("""
    INSERT INTO finance_lines
        (id, sheet_source_id, tab_title, cadence, section_key, section_label, sub_section,
         entity_type, item_no, line_key, line_label, parent_key,
         period_start_date, period_end_date, period_type, amount, percent, sync_log_id)
    VALUES
        (:id, :sid, :tab_title, :cadence, :section_key, :section_label, :sub_section,
         :entity_type, :item_no, :line_key, :line_label, :parent_key,
         :period_start_date, :period_end_date, :period_type, :amount, :percent, :sync_log_id)
    ON CONFLICT (sheet_source_id, line_key, period_start_date, period_end_date)
    DO UPDATE SET
        tab_title = EXCLUDED.tab_title, cadence = EXCLUDED.cadence,
        section_key = EXCLUDED.section_key, section_label = EXCLUDED.section_label,
        sub_section = EXCLUDED.sub_section, entity_type = EXCLUDED.entity_type,
        item_no = EXCLUDED.item_no, line_label = EXCLUDED.line_label, parent_key = EXCLUDED.parent_key,
        period_type = EXCLUDED.period_type, amount = EXCLUDED.amount, percent = EXCLUDED.percent,
        sync_log_id = EXCLUDED.sync_log_id, updated_at = NOW()
""")


def _sync_company_records(db: Session, company_sid: str, entry: dict, log_id: str):
    """Reconcile + upsert one company tab's rows. Reconcile is scoped to the
    cadence(s) present in THIS master's parse, so syncing the monthly master
    never touches the company's yearly rows and vice-versa."""
    records = entry["records"]
    cadences = list(entry["cadences"])
    rec_by_key = {(r["line_key"], r["period_start_date"], r["period_end_date"]): r for r in records}

    existing = db.execute(text(
        "SELECT id, line_key, period_start_date, period_end_date FROM finance_lines "
        "WHERE sheet_source_id = :sid AND cadence = ANY(:cads)"
    ), {"sid": company_sid, "cads": cadences}).fetchall()
    existing_map = {(r.line_key, r.period_start_date, r.period_end_date): r.id for r in existing}
    stale_ids = [str(rid) for key, rid in existing_map.items() if key not in rec_by_key]
    deleted = 0
    if stale_ids:
        deleted = db.execute(
            text("DELETE FROM finance_lines WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)),
            {"ids": stale_ids},
        ).rowcount

    inserted = sum(1 for k in rec_by_key if k not in existing_map)
    updated = len(rec_by_key) - inserted
    if rec_by_key:
        params = [{
            "id": str(uuid.uuid4()), "sid": company_sid, "tab_title": rec["tab_title"], "cadence": rec["cadence"],
            "section_key": rec["section_key"], "section_label": rec["section_label"], "sub_section": rec["sub_section"],
            "entity_type": rec["entity_type"], "item_no": rec["item_no"], "line_key": rec["line_key"],
            "line_label": rec["line_label"], "parent_key": rec["parent_key"],
            "period_start_date": rec["period_start_date"], "period_end_date": rec["period_end_date"],
            "period_type": rec["period_type"], "amount": rec["amount"], "percent": rec["percent"],
            "sync_log_id": log_id,
        } for rec in rec_by_key.values()]
        db.execute(_UPSERT_SQL, params)
    return inserted, updated, deleted


@router.post("/masters/{master_id}/sync")
def sync_master(master_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    _require_admin(current_user)
    master = db.query(SheetSource).filter(SheetSource.id == master_id, SheetSource.module == MODULE, SheetSource.kind == "master").first()
    if not master:
        raise HTTPException(status_code=404, detail="Master file not found")

    log = SyncLog(id=uuid.uuid4(), module=MODULE, source_label=master.sheet_id, status="Processing", synced_by=current_user.id)
    db.add(log)
    db.commit()
    db.refresh(log)
    prune_sync_logs(db, MODULE, master.sheet_id)

    try:
        by_company, errors = fetch_and_parse_finance_by_company(master.sheet_id)
    except Exception as e:
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=502, detail=f"Could not read the master sheet: {e}")

    row_errors = list(errors)
    inserted = updated = deleted = 0
    companies_touched = 0
    try:
        for tab_title, entry in by_company.items():
            company_key = _slugify(tab_title)
            company = db.query(SheetSource).filter(
                SheetSource.module == MODULE, SheetSource.kind == "company", SheetSource.sheet_id == company_key
            ).first()
            if not company:
                company = SheetSource(id=uuid.uuid4(), module=MODULE, kind="company",
                                      sheet_id=company_key, label=tab_title.strip(), created_by=current_user.id)
                db.add(company)
                db.flush()  # get id without ending the transaction
            i, u, d = _sync_company_records(db, str(company.id), entry, str(log.id))
            inserted += i; updated += u; deleted += d
            companies_touched += 1

        log.rows_total = inserted + updated
        log.rows_inserted = inserted
        log.rows_updated = updated
        log.rows_failed = 0
        log.rows_deleted = deleted
        log.status = "Done"
        log.error_details = "\n".join(row_errors) if row_errors else None
        db.commit()
    except Exception as e:
        db.rollback()
        log.status = "Failed"
        log.error_details = f"{e}"
        db.commit()
        raise HTTPException(status_code=500, detail=f"Sync failed while writing rows: {e}")

    return {
        "sync_id": str(log.id), "companies": companies_touched,
        "rows_total": log.rows_total, "rows_inserted": inserted, "rows_updated": updated,
        "rows_failed": 0, "rows_deleted": deleted, "errors": row_errors[:20], "status": "Done",
    }


# ── Companies (the per-company view + access surface) ────────────────────────
@router.get("/sheet-sources")
def list_sheet_sources(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    allowed_ids = set(get_user_sheet_source_ids(db, current_user, module=MODULE))
    sources = (
        db.query(SheetSource)
        .filter(SheetSource.module == MODULE, SheetSource.kind == "company")
        .order_by(SheetSource.label.asc())
        .all()
    )
    return [
        {"id": str(s.id), "sheet_id": s.sheet_id, "label": s.label,
         "created_at": s.created_at.isoformat() if s.created_at else None,
         "last_synced_at": None, "last_sync_status": None}
        for s in sources if str(s.id) in allowed_ids
    ]


class CompanyRenameIn(BaseModel):
    label: str


# Changes the display name only. The company's identity is sheet_id (the slug of
# its master-sheet tab), which access grants and finance_lines hang off — so the
# tab keeps its old name and sync, which sets label only on create, leaves this be.
@router.patch("/sheet-sources/{source_id}")
def rename_sheet_source(source_id: str, body: CompanyRenameIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    _require_admin(current_user)
    label = body.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Company name cannot be empty")
    source = db.query(SheetSource).filter(SheetSource.id == source_id, SheetSource.module == MODULE, SheetSource.kind == "company").first()
    if not source:
        raise HTTPException(status_code=404, detail="Company not found")
    source.label = label
    db.commit()
    return {"id": str(source.id), "sheet_id": source.sheet_id, "label": source.label}


@router.delete("/sheet-sources/{source_id}")
def delete_sheet_source(source_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    _require_admin(current_user)
    source = db.query(SheetSource).filter(SheetSource.id == source_id, SheetSource.module == MODULE, SheetSource.kind == "company").first()
    if not source:
        raise HTTPException(status_code=404, detail="Company not found")
    count = db.execute(text("SELECT COUNT(*) FROM finance_lines WHERE sheet_source_id = :sid"), {"sid": str(source.id)}).scalar()
    db.delete(source)  # ON DELETE CASCADE removes finance_lines + access rows
    db.commit()
    return {"deleted": True, "rows_deleted": count or 0}


# ── Analytics ──────────────────────────────────────────────────────────────────
def _collect_groups(db: Session, sid: str, section_keys: list):
    """Pull finance_lines for the given sections and shape them into ordered
    render groups: [{section_key, section_label, sub_sections:[{key,label,
    line_items:[{..., series:[point]}], total}]}]. Also returns the ordered
    distinct period list across all fetched rows."""
    rows = db.execute(text("""
        SELECT section_key, section_label, sub_section, entity_type, item_no, line_key, line_label,
               parent_key, period_start_date, period_end_date, period_type, amount, percent
        FROM finance_lines
        WHERE sheet_source_id = :sid AND section_key = ANY(:keys)
        ORDER BY period_end_date
    """), {"sid": sid, "keys": section_keys}).fetchall()

    # section_key -> sub_section(None-safe) -> line_key -> entry
    tree: dict = {}
    periods: dict = {}
    for r in rows:
        pe = r.period_end_date.isoformat()
        periods[(r.period_start_date, r.period_end_date)] = {
            "period_start_date": r.period_start_date.isoformat(),
            "period_end_date": pe, "period_type": r.period_type,
        }
        sec = tree.setdefault(r.section_key, {"section_label": r.section_label, "subs": {}})
        sub = sec["subs"].setdefault(r.sub_section, {})
        entry = sub.setdefault(r.line_key, {
            "line_key": r.line_key, "line_label": r.line_label, "item_no": r.item_no,
            "entity_type": r.entity_type, "parent_key": r.parent_key, "series": [],
        })
        entry["series"].append({
            "period_start_date": r.period_start_date.isoformat(), "period_end_date": pe,
            "period_type": r.period_type,
            "amount": float(r.amount) if r.amount is not None else None,
            "percent": r.percent,
        })

    groups = []
    for skey in section_keys:
        sec = tree.get(skey)
        if not sec:
            continue
        sub_list = []
        for sub_slug, items in sec["subs"].items():
            entries = sorted(items.values(), key=lambda x: (x["item_no"] is None, x["item_no"] or 0))
            total = next((e for e in entries if e["entity_type"] == "total"), None)
            line_items = [e for e in entries if e["entity_type"] != "total"]
            sub_list.append({
                "key": sub_slug,
                "label": _SUB_LABELS.get(sub_slug) if sub_slug else None,
                "min_ordinal": min((e["item_no"] or 0) for e in entries) if entries else 0,
                "line_items": line_items,
                "total": total,
            })
        sub_list.sort(key=lambda s: s["min_ordinal"])
        for s in sub_list:
            s.pop("min_ordinal", None)
        groups.append({"section_key": skey, "section_label": sec["section_label"], "sub_sections": sub_list})

    ordered_periods = [periods[k] for k in sorted(periods, key=lambda k: k[1])]
    return groups, ordered_periods


def _find_series(groups: list, line_key: str) -> list:
    for g in groups:
        for sub in g["sub_sections"]:
            for it in sub["line_items"]:
                if it["line_key"] == line_key:
                    return it["series"]
            if sub["total"] and sub["total"]["line_key"] == line_key:
                return sub["total"]["series"]
    return []


def _monthly_flow(series: list) -> list:
    return [{"year": date.fromisoformat(p["period_end_date"]).year,
             "month": date.fromisoformat(p["period_end_date"]).month,
             "amount": p["amount"]}
            for p in series if p["period_type"] == "monthly" and p["amount"] is not None]


# ── Ratio derivations for quarter / year buckets ─────────────────────────────
# The sheet publishes ratios per MONTH only, and the yearly file reuses those
# monthly formulas unchanged (PBITDA ×12, debtors ×30) on full-year figures, so
# its annual ratios are overstated — FY 25-26 ROI reads 411% for AMATO SRN
# against a true 34%. A quarter or a year therefore has no ratio of its own to
# mirror, and taking the last month's value labelled September's MoM Sales
# Growth as "Q2". Instead each flow-based ratio ships the figures it is made of,
# and the frontend recomputes a bucket from the bucket's own figures with the
# sheet's OWN formulas — identical on all 18 company tabs, checked 2026-10-26 —
# so a one-month bucket reproduces the sheet exactly. Balance-only ratios
# (current, quick, debt/equity) need none of this: a quarter-end balance ratio IS
# the last month's, so they keep the stock rule.
_PBITDA = ("profit_loss_a_c/pbitda", "PBITDA")
_FIN_COST = ("profit_loss_a_c/finance_s_cost", "Finance's Cost")
_SALES = ("sales_accounts/total", "Sales")
_MATERIAL = ("profit_loss_a_c/cost_of_material", "Cost of Material")
_APP_TOTAL = ("balance_sheet/application_of_funds/total", "Application of Funds")
_CUR_LIAB = ("balance_sheet/sources_of_funds/current_liabilities", "Current Liabilities")
_RESERVES = ("balance_sheet/sources_of_funds/reserve_surplus", "Reserve & Surplus")
_NWC = ("working_capital/net_working_capital", "Net Working Capital")
_DEBTORS = ("working_capital/current_assets/sundry_debtors", "Sundry Debtors")
_CREDITORS = ("working_capital/current_liabilities/sundry_creditors", "Sundry Creditors")
_INVENTORY = ("inventories/total", "Inventories")

_RATIO_DERIVATIONS = {
    "return_on_investment": {"kind": "return", "num": _PBITDA, "den": [(1, _APP_TOTAL)]},
    "return_on_equity_ratio": {"kind": "return", "num": _PBITDA, "den": [(1, _RESERVES)]},
    "return_on_wkg_capital": {"kind": "return", "num": _PBITDA, "den": [(1, _NWC)]},
    "return_on_capital_employed": {"kind": "return", "num": _PBITDA, "den": [(1, _APP_TOTAL), (-1, _CUR_LIAB)]},
    "debts_covering_ratio": {"kind": "flow_ratio", "num": _PBITDA, "den": _FIN_COST},
    "recv_turnover_in_days": {"kind": "days", "terms": [(1, _DEBTORS, _SALES)]},
    "inventory_turnover_in_days": {"kind": "days", "terms": [(1, _INVENTORY, _MATERIAL)]},
    "vendor_turnover_in_days": {"kind": "days", "terms": [(1, _CREDITORS, _MATERIAL)]},
    "sales_growth": {"kind": "growth", "base": _SALES},
    "profit_growth": {"kind": "growth", "base": _PBITDA},
}
# Efficiency's "Net" row (Recv + Inventory − Vendor days) is matched on its
# sub-section as well — "net" on its own is too generic a slug to trust.
_NET_DAYS = {"kind": "days", "terms": [(1, _DEBTORS, _SALES), (1, _INVENTORY, _MATERIAL), (-1, _CREDITORS, _MATERIAL)]}
_EFFICIENCY_SUBS = {"eficiency_ratio", "efficiency_ratio"}


def _ratio_spec(sub_section: str, line_key: str):
    slug = line_key.rsplit("/", 1)[-1]
    if slug == "net":
        return _NET_DAYS if sub_section in _EFFICIENCY_SUBS else None
    return _RATIO_DERIVATIONS.get(slug)


def _spec_keys(spec: dict) -> set:
    if spec["kind"] == "return":
        return {spec["num"][0]} | {inp[0] for _, inp in spec["den"]}
    if spec["kind"] == "flow_ratio":
        return {spec["num"][0], spec["den"][0]}
    if spec["kind"] == "days":
        return {k for _, stock, flow in spec["terms"] for k in (stock[0], flow[0])}
    return {spec["base"][0]}


def _materialize_spec(spec: dict, inputs: dict) -> dict:
    """Spec → JSON for the frontend: every input as {label, series}."""
    def inp(ref):
        key, label = ref
        return {"label": label, "series": inputs.get(key, [])}
    kind = spec["kind"]
    if kind == "return":
        return {"kind": kind, "num": inp(spec["num"]),
                "den": [{"sign": sign, **inp(ref)} for sign, ref in spec["den"]]}
    if kind == "flow_ratio":
        return {"kind": kind, "num": inp(spec["num"]), "den": inp(spec["den"])}
    if kind == "days":
        return {"kind": kind, "terms": [{"sign": sign, "stock": inp(stock), "flow": inp(flow)}
                                        for sign, stock, flow in spec["terms"]]}
    return {"kind": kind, "base": inp(spec["base"])}


def _collect_ratios(db: Session, sid: str, sub_slugs: list) -> list:
    """Key Financial Ratios for the given category sub-sections → a list of
    {key, label, items:[{line_key, line_label, series:[{period_end_date,
    period_type, amount}], derive}]}. Ratios are a single value per period (no
    percent, no total), so they get their own card panel, not the additive
    GroupBlock. `derive` is the recipe for quarter/year buckets — see
    _RATIO_DERIVATIONS — or None for balance-only ratios."""
    rows = db.execute(text("""
        SELECT sub_section, item_no, line_key, line_label, period_end_date, period_type, amount
        FROM finance_lines
        WHERE sheet_source_id = :sid AND section_key = 'ratios' AND sub_section = ANY(:subs)
        ORDER BY period_end_date
    """), {"sid": sid, "subs": sub_slugs}).fetchall()
    cats: dict = {}
    for r in rows:
        cat = cats.setdefault(r.sub_section, {})
        it = cat.setdefault(r.line_key, {
            "line_key": r.line_key, "line_label": r.line_label, "item_no": r.item_no, "series": [],
        })
        it["series"].append({
            "period_end_date": r.period_end_date.isoformat(), "period_type": r.period_type,
            "amount": float(r.amount) if r.amount is not None else None,
        })
    specs = {key: _ratio_spec(sub, key) for sub, cat in cats.items() for key in cat}
    needed = set().union(*(_spec_keys(s) for s in specs.values() if s))
    inputs: dict = {}
    if needed:
        for r in db.execute(text("""
            SELECT line_key, period_end_date, period_type, amount
            FROM finance_lines
            WHERE sheet_source_id = :sid AND line_key = ANY(:keys) AND amount IS NOT NULL
            ORDER BY period_end_date
        """), {"sid": sid, "keys": sorted(needed)}).fetchall():
            inputs.setdefault(r.line_key, []).append({
                "period_end_date": r.period_end_date.isoformat(), "period_type": r.period_type,
                "amount": float(r.amount),
            })

    out = []
    for sub in sub_slugs:
        if sub in cats:
            items = sorted(cats[sub].values(), key=lambda x: (x["item_no"] is None, x["item_no"] or 0))
            for it in items:
                spec = specs.get(it["line_key"])
                it["derive"] = _materialize_spec(spec, inputs) if spec else None
            out.append({"key": sub, "label": _RATIO_SUB_LABELS.get(sub, sub), "items": items})
    return out


def _latest_value(db: Session, sid: str, line_key: str):
    r = db.execute(text("""
        SELECT amount, period_end_date FROM finance_lines
        WHERE sheet_source_id = :sid AND line_key = :lk AND amount IS NOT NULL
        ORDER BY period_end_date DESC LIMIT 1
    """), {"sid": sid, "lk": line_key}).first()
    return (float(r.amount), r.period_end_date.isoformat()) if r else (None, None)


# Cross-statement ties an auditor would run first — each pair should be equal if
# the sheet is internally consistent. Compared at each line's latest period.
_RECON_TIES = [
    ("Balance Sheet balances", "Sources of Funds", "balance_sheet/sources_of_funds/total",
     "Application of Funds", "balance_sheet/application_of_funds/total"),
    ("Current Assets tie", "Balance Sheet", "balance_sheet/application_of_funds/current_assets",
     "Working Capital", "working_capital/current_assets/total"),
    ("Current Liabilities tie", "Balance Sheet", "balance_sheet/sources_of_funds/current_liabilities",
     "Working Capital", "working_capital/current_liabilities/total"),
    ("Inventory tie", "Inventories total", "inventories/total",
     "Working Capital", "working_capital/current_assets/inventory"),
    ("Profit tie (PAT → BS)", "P&L PAT", "profit_loss_a_c/pat",
     "BS Profit & Loss A/c", "balance_sheet/sources_of_funds/profit_loss_a_c"),
]


def _reconciliation(db: Session, sid: str) -> list:
    out = []
    for label, ln, lk, rn, rk in _RECON_TIES:
        lv, lp = _latest_value(db, sid, lk)
        rv, rp = _latest_value(db, sid, rk)
        if lv is None or rv is None:
            continue
        tol = max(1.0, 0.005 * abs(lv))  # ₹1 or 0.5% of the value
        out.append({
            "label": label,
            "left": {"name": ln, "value": lv}, "right": {"name": rn, "value": rv},
            "delta": round(lv - rv, 2), "matches": abs(lv - rv) <= tol, "period": lp,
        })
    return out


def _balance_sheet_analytics(db: Session, sid: str) -> dict:
    groups, periods = _collect_groups(db, sid, BALANCE_SHEET_SECTIONS)
    src = _find_series(groups, "balance_sheet/sources_of_funds/total")
    app = _find_series(groups, "balance_sheet/application_of_funds/total")
    kpis = {
        "sources_total_latest": src[-1]["amount"] if src else None,
        "application_total_latest": app[-1]["amount"] if app else None,
        **_stock_growth(src),
    }
    return {"statement": "balance_sheet", "kind": "stock", "kpis": kpis, "groups": groups,
            "periods": periods, "ratios": _collect_ratios(db, sid, BS_RATIO_SUBS),
            "reconciliation": _reconciliation(db, sid)}


def _profit_loss_analytics(db: Session, sid: str) -> dict:
    groups, periods = _collect_groups(db, sid, PROFIT_LOSS_SECTIONS)
    sales = _find_series(groups, "profit_loss_a_c/sales_accounts")
    gross = _find_series(groups, "profit_loss_a_c/gross_margin")
    pat = _find_series(groups, "profit_loss_a_c/pat")
    monthly_sales = _monthly_flow(sales)
    kpis = {
        "sales_total": round(sum(m["amount"] for m in monthly_sales), 2) if monthly_sales else 0.0,
        "gross_margin_total": round(sum(m["amount"] for m in _monthly_flow(gross)), 2) if gross else 0.0,
        "pat_total": round(sum(m["amount"] for m in _monthly_flow(pat)), 2) if pat else 0.0,
        **_growth_kpis(monthly_sales),
    }
    return {"statement": "profit_loss", "kind": "flow", "kpis": kpis, "groups": groups,
            "periods": periods, "ratios": _collect_ratios(db, sid, PL_RATIO_SUBS)}


def _plant_ops_analytics(db: Session, sid: str) -> dict:
    groups, periods = _collect_groups(db, sid, PLANT_OPS_SECTIONS)
    return {"statement": "plant_ops", "kind": "flow", "kpis": {}, "groups": groups, "periods": periods}


def _cash_flow_analytics(db: Session, sid: str) -> dict:
    # A flow statement, like P&L. The activity nets (A)/(B)/(C) and Closing Cash
    # arrive as each sub-section's `total`, so the frontend derives the headline
    # KPIs from the groups directly (period-switchable) — no server-side KPI math.
    groups, periods = _collect_groups(db, sid, CASH_FLOW_SECTIONS)
    return {"statement": "cash_flow", "kind": "flow", "kpis": {}, "groups": groups, "periods": periods}


# ── Budget: the actual that each budget line is measured against ─────────────
# Finance's Budget block carries budget figures only, so the actual side comes
# from what the sheet already reports (agreed with the user, Oct 2026). Each
# budget line (matched by its label's slug) maps to the P&L / Cash Flow / Units
# rows that make up its actual. Sums are of the sheet's own rows — a line the
# sheet doesn't report for a month simply doesn't add — and `need_all` lines
# (a difference, like PBIT) show nothing unless every part is there.
_BUDGET_ACTUALS = {
    "revanue_income": ("Sales Accounts", [(1, "profit_loss_a_c/sales_accounts")], False),
    "revenue_income": ("Sales Accounts", [(1, "profit_loss_a_c/sales_accounts")], False),
    "cost_of_goods_sold": ("Cost of Material + Direct Expenses",
                           [(1, "profit_loss_a_c/cost_of_material"), (1, "profit_loss_a_c/direct_expenses")], False),
    "gross_profit": ("Gross Margin", [(1, "profit_loss_a_c/gross_margin")], False),
    "operating_cost": ("Indirect Expenses + Employee's Cost + Provision for Expenses",
                       [(1, "profit_loss_a_c/indirect_expenses"), (1, "profit_loss_a_c/employee_s_cost"),
                        (1, "profit_loss_a_c/provision_for_expenses")], False),
    "pbitda": ("PBITDA", [(1, "profit_loss_a_c/pbitda")], False),
    "pbit": ("PBITDA − Depreciation", [(1, "profit_loss_a_c/pbitda"), (-1, "profit_loss_a_c/depericiation")], True),
    "pat": ("PAT", [(1, "profit_loss_a_c/pat")], False),
    "opening_cash_bank": ("Opening cash (Cash Flow)",
                          [(1, "cash_flow_statement/reconciliation/add_opening_cash_cash_equivalents")], False),
    "closing_cash_bank": ("Closing cash (Cash Flow)",
                          [(1, "cash_flow_statement/reconciliation/closing_cash_cash_equivalents")], False),
}
# Budgeted units → §7 actual sales units.
_UNIT_ACTUALS = {
    "4w_seat_cover": ["units/sales_4w/seat_cover"],
    "4w_accessories": ["units/sales_4w/accessories"],
    "4w_mats": ["units/sales_4w/mats"],
    "4w_other": ["units/sales_4w/other"],
    "2w_seat_cover": ["units/sales_2w/seat_cover"],
    "2w_accessories": ["units/sales_2w/accessories"],
    "lifestyle": ["units/sales_2w/others/lifestyle"],
    "bags": ["units/sales_2w/others/bags"],
}
for _slug, _keys in _UNIT_ACTUALS.items():
    _BUDGET_ACTUALS[_slug] = ("Sales units (§7 Units)", [(1, k) for k in _keys], False)


def _budget_actuals(db: Session, sid: str, groups: list) -> dict:
    """{budget line_key: {"basis": str, "series": [point]}} for every budget line
    that has a known actual."""
    wanted = {}
    for g in groups:
        for sub in g["sub_sections"]:
            for it in sub["line_items"]:
                spec = _BUDGET_ACTUALS.get(it["line_key"].rsplit("/", 1)[-1])
                if spec:
                    wanted[it["line_key"]] = spec
    keys = sorted({k for _, terms, _ in wanted.values() for _, k in terms})
    if not keys:
        return {}
    by_key: dict = {}
    for r in db.execute(text("""
        SELECT line_key, period_start_date, period_end_date, period_type, amount
        FROM finance_lines
        WHERE sheet_source_id = :sid AND line_key = ANY(:keys) AND amount IS NOT NULL
    """), {"sid": sid, "keys": keys}).fetchall():
        by_key.setdefault(r.line_key, {})[(r.period_start_date, r.period_end_date, r.period_type)] = float(r.amount)

    out = {}
    for budget_key, (basis, terms, need_all) in wanted.items():
        periods = set().union(*(by_key.get(k, {}).keys() for _, k in terms))
        series = []
        for ps, pe, pt in sorted(periods, key=lambda p: p[1]):
            parts = [(sign, by_key.get(k, {}).get((ps, pe, pt))) for sign, k in terms]
            present = [(sign, v) for sign, v in parts if v is not None]
            if not present or (need_all and len(present) < len(parts)):
                continue
            series.append({"period_start_date": ps.isoformat(), "period_end_date": pe.isoformat(),
                           "period_type": pt, "amount": sum(sign * v for sign, v in present), "percent": None})
        out[budget_key] = {"basis": basis, "series": series}
    return out


def _budget_analytics(db: Session, sid: str) -> dict:
    groups, periods = _collect_groups(db, sid, BUDGET_SECTIONS)
    return {"statement": "budget", "kind": "flow", "kpis": {}, "groups": groups, "periods": periods,
            "actuals": _budget_actuals(db, sid, groups)}


def _unit_economics_analytics(db: Session, sid: str) -> dict:
    # Per-unit rates (price, cost, profit) are not summable; the frontend works a
    # quarter or year out from the summed volumes and money (revenue ÷ units).
    groups, periods = _collect_groups(db, sid, UNIT_ECONOMICS_SECTIONS)
    return {"statement": "unit_economics", "kind": "flow", "kpis": {}, "groups": groups, "periods": periods}


@router.get("/analytics")
def finance_analytics(
    sheet_source_id: str = Query(...),
    statement: str = Query(..., pattern="^(balance_sheet|profit_loss|plant_ops|cash_flow|budget|unit_economics)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    source = db.query(SheetSource).filter(SheetSource.id == sheet_source_id, SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    require_sheet_source_access(db, current_user, source.id)

    if statement == "balance_sheet":
        return _balance_sheet_analytics(db, sheet_source_id)
    if statement == "plant_ops":
        return _plant_ops_analytics(db, sheet_source_id)
    if statement == "cash_flow":
        return _cash_flow_analytics(db, sheet_source_id)
    if statement == "budget":
        return _budget_analytics(db, sheet_source_id)
    if statement == "unit_economics":
        return _unit_economics_analytics(db, sheet_source_id)
    return _profit_loss_analytics(db, sheet_source_id)


# ── Consolidated (every company side by side) ────────────────────────────────
# "Consolidated" here means SIDE BY SIDE, not summed. Each company's own figures
# are returned as-is and shown together in one place; nothing is added across
# companies. That is deliberate, not a simplification: the master sheet already
# carries finance's own roll-up tabs (e.g. AMATO TOTAL), which land in
# sheet_sources as ordinary companies, so summing every tab would double-count
# whichever entities those roll-ups already cover.
#
# P&L lines come back as full series so the frontend's period picker can bucket
# them at monthly/quarterly/yearly like every other view. Balance Sheet is a
# stock, so only its latest point travels — "last figures", as at its own date.
_CONSOLIDATED_PL_KEYS = {
    "sales": "profit_loss_a_c/sales_accounts",
    "gross": "profit_loss_a_c/gross_margin",
    "pbitda": "profit_loss_a_c/pbitda",
    "pat": "profit_loss_a_c/pat",
}
_CONSOLIDATED_BS_KEYS = {
    "sources": "balance_sheet/sources_of_funds/total",
    "application": "balance_sheet/application_of_funds/total",
}


@router.get("/consolidated")
def finance_consolidated(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_module(db, current_user, MODULE_KEY)
    allowed_ids = set(get_user_sheet_source_ids(db, current_user, module=MODULE))
    companies = (
        db.query(SheetSource)
        .filter(SheetSource.module == MODULE, SheetSource.kind == "company")
        .order_by(SheetSource.label.asc())
        .all()
    )
    companies = [c for c in companies if str(c.id) in allowed_ids]
    if not companies:
        return {"companies": []}

    sids = [str(c.id) for c in companies]
    keys = list(_CONSOLIDATED_PL_KEYS.values()) + list(_CONSOLIDATED_BS_KEYS.values())
    # One pass for every company rather than a query per company. sheet_source_id
    # is a uuid column and these are strings, so this uses the same expanding
    # bindparam / IN form already proven against it in _sync_company_records
    # rather than an ANY(...) array cast.
    rows = db.execute(
        text("""
            SELECT sheet_source_id, line_key, period_start_date, period_end_date,
                   period_type, amount, percent
            FROM finance_lines
            WHERE sheet_source_id IN :sids
              AND line_key = ANY(:keys)
              AND amount IS NOT NULL
            ORDER BY period_end_date
        """).bindparams(bindparam("sids", expanding=True)),
        {"sids": sids, "keys": keys},
    ).fetchall()

    pl_by_key = {v: k for k, v in _CONSOLIDATED_PL_KEYS.items()}
    bs_by_key = {v: k for k, v in _CONSOLIDATED_BS_KEYS.items()}
    acc: dict = {
        sid: {"pl": {k: [] for k in _CONSOLIDATED_PL_KEYS}, "bs": {k: None for k in _CONSOLIDATED_BS_KEYS}}
        for sid in sids
    }
    for r in rows:
        sid = str(r.sheet_source_id)
        slot = acc.get(sid)
        if slot is None:
            continue
        if r.line_key in pl_by_key:
            slot["pl"][pl_by_key[r.line_key]].append({
                "period_start_date": r.period_start_date.isoformat(),
                "period_end_date": r.period_end_date.isoformat(),
                "period_type": r.period_type,
                "amount": float(r.amount),
                "percent": r.percent,
            })
        elif r.line_key in bs_by_key:
            # Rows arrive oldest-first, so the last one seen is the latest point.
            slot["bs"][bs_by_key[r.line_key]] = {
                "amount": float(r.amount),
                "period_end_date": r.period_end_date.isoformat(),
            }

    out = []
    for c in companies:
        sid = str(c.id)
        bs = acc[sid]["bs"]
        as_at = max(
            (v["period_end_date"] for v in bs.values() if v is not None),
            default=None,
        )
        out.append({"id": sid, "label": c.label, "pl": acc[sid]["pl"], "bs": bs, "as_at": as_at})
    return {"companies": out}


# ── Sync history ──────────────────────────────────────────────────────────────
@router.get("/sync-history")
def sync_history(
    sheet_source_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    query = db.query(SyncLog).filter(SyncLog.module == MODULE)
    if sheet_source_id:
        source = db.query(SheetSource).filter(SheetSource.id == sheet_source_id, SheetSource.module == MODULE).first()
        if source:
            require_sheet_source_access(db, current_user, source.id)
            query = query.filter(SyncLog.source_label == source.sheet_id)
    logs = query.order_by(SyncLog.synced_at.desc()).limit(SYNC_LOG_RETENTION).all()
    return [
        {
            "id": str(l.id),
            "rows_total": l.rows_total, "rows_inserted": l.rows_inserted,
            "rows_updated": l.rows_updated, "rows_failed": l.rows_failed,
            "rows_deleted": l.rows_deleted, "status": l.status,
            "synced_at": l.synced_at.isoformat() if l.synced_at else None,
        }
        for l in logs
    ]
