"""
AutoForm MIS — OE Network Sales Router
Five sheet types under one module ("oe_network" permission key):
  • oe_visit_plan    — one spreadsheet per calendar month, one tab per salesperson
  • oe_log_book      — one continuous Form-responses spreadsheet
  • oe_targets       — one spreadsheet per quarter, stacked OEM blocks per tab
  • oe_dealer_data   — the OE team's dealer file, one tab per OEM
  • oe_oem_targets   — one spreadsheet per FY, one tab per OEM, the brand-level
                       target summary
Registry + manual sync follow the standard sheet_sources pattern; data endpoints
are filter-first (plans list, logs list, log analytics, plan-vs-actual coverage,
dealer directory, dealer-level plan adherence). Target analytics live in
routers/oe_targets.py (per salesperson) and routers/oe_oem_targets.py (per
brand); this file owns the registry and sync for all of them.

oe_targets and oe_oem_targets are two different commitments from two different
files — the same money cut by person and cut by brand — and are never added
together or shown as one number.
"""
import calendar
import csv
import io as _io
import os
import re
import uuid
from datetime import date
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError
from database import get_db
from models import SheetSource, SyncLog, User
from routers.auth import get_current_user
from services.dealer_resolve import DealerIndex
from services.google_sheets import extract_sheet_id
from services.oe_dealer_data_sync import parse_dealer_data, SERIES as DEALER_SERIES
from services.oe_network_sync import parse_visit_plan, parse_log_book
from services.oe_oem_targets_sync import parse_oem_targets
from services.oe_targets_sync import parse_targets, QUARTER_TAGS
from services.period_filters import parse_date as _parse_date, snap_to_months
from services.oe_dealer_data_sync import FULL_PART_COVERAGE_OEMS
from services.oe_scope import OEScope, names_match as _names_match, name_tokens as _name_tokens
from services.permissions import require_module
from services.sync_logs import SYNC_LOG_RETENTION, prune_sync_logs
from services.remark_themes import classify as classify_remark, THEMES, is_theme

router = APIRouter(prefix="/oe-network", tags=["OE Network"])

MODULE_KEY = "oe_network"
MODULE_PLAN = "oe_visit_plan"
MODULE_LOG = "oe_log_book"
MODULE_TGT = "oe_targets"
# The OE team's dealer file: one tab per OEM, one row per dealer outlet, with
# their vehicle sales and ours month by month plus the quarter targets. Unlike
# the other three this one feeds TWO tables (oe_dealer_monthly and
# oe_dealer_targets) and can create dealers, so it has its own sync path.
MODULE_DD = "oe_dealer_data"
# The brand-level target summary: one workbook per financial year, one tab per
# OEM, one row per product, twelve months of target and achievement. Distinct
# from MODULE_TGT, which is the same money split across salespeople and
# published a quarter at a time. Feeds two tables (the monthly rows and last
# year's actual, which has no month), so like MODULE_DD it has its own write.
MODULE_OEMTGT = "oe_oem_targets"
OE_MODULES = (MODULE_PLAN, MODULE_LOG, MODULE_TGT, MODULE_DD, MODULE_OEMTGT)

# sheet_sources.quarter is VARCHAR(2) holding 'Q1'..'Q4' (Depot-to-Distributor
# set that convention); OE targets reuse it rather than add a second column.
QUARTERS = ("Q1", "Q2", "Q3", "Q4")

_MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"]

_SHEET_TYPES = {MODULE_PLAN: "visit_plan", MODULE_LOG: "log_book",
                MODULE_TGT: "targets", MODULE_DD: "dealer_data",
                MODULE_OEMTGT: "oem_target"}


def _scope(db: Session, current_user: User,
           salesperson: Optional[str] = None) -> tuple[OEScope, Optional[str]]:
    """Gate the module and resolve the caller's row-level scope.

    Every data endpoint in this module and in oe_targets.py starts here — there
    is deliberately no bare "just check the module" helper left, so an endpoint
    added later cannot forget to scope and quietly leak every rep's numbers. The
    test suite pins that: no router may call require_module for this module
    directly.

    Returns the scope plus the salesperson value the caller should pass to
    _add_filters. For an unscoped user that is the query parameter unchanged.
    For a scoped user it is None — deliberately, and this is the subtle part:
    their constraint is applied by scope.apply(), which token-matches their
    canonical name against the spellings that table actually uses. Passing the
    canonical name to _add_filters as well would add a literal
    `salesperson = 'PANKAJ'`, which excludes the "PANKAJ VIG" rows it is meant
    to include — the scope would silently show a rep almost nothing.

    Either way a client-supplied ?salesperson= is dropped for a scoped user, so
    a rep cannot widen their view by editing the query string.
    """
    require_module(db, current_user, MODULE_KEY)
    # Superadmin is never scoped, matching services/permissions.py where it
    # bypasses every other check. Without this an admin who was once given a
    # scope, or who is pointed at a salesperson row by mistake, would lock
    # themselves out of the module they administer.
    name = None if current_user.role == "superadmin" else current_user.oe_salesperson
    scope = OEScope(db, name)
    return scope, (None if scope.limited else salesperson)


def _require_admin(db: Session, current_user: User) -> None:
    """Keeps the sheet registry — adding, deleting and re-syncing one named
    sheet — away from field reps, who only read what it produces.

    It refuses a SCOPED account, not a non-admin one, and that is deliberate:
    managing sheets is an ordinary part of running the module, so anyone holding
    oe_network without a linked salesperson — management, sales heads — keeps
    doing it exactly as they did before row-level scoping existed. Reps are the
    only ones this takes it away from. Read as "not a field rep", not as
    "superadmin"; the name is looser than the rule.

    Not the same as the Overview's Sync button (/sync-latest), which every OE
    user may press: pulling the latest rows is routine, while registering or
    dropping a source rewrites what the module is made of.
    """
    scope, _ = _scope(db, current_user)
    if scope.limited:
        raise HTTPException(
            status_code=403,
            detail="Managing OE sheet sources is not available on a salesperson account.")


def _sheet_type(module: str) -> str:
    return _SHEET_TYPES.get(module, module)


# ── Dealer-name matching (plan says "Pratham", the form says "Pratham Motors") ──
# Generic trade words appear in almost every dealership name, so they can't be
# evidence that two names refer to the same dealer. Only if a name is NOTHING
# BUT generic words do we fall back to using them.
_DEALER_STOPWORDS = {
    "MOTORS", "MOTOR", "AUTO", "AUTOS", "AUTOMOBILES", "AUTOMOBILE", "AUTOMOTIVE",
    "CARS", "CAR", "WHEELS", "VEHICLES", "VEHICLE", "AGENCY", "AGENCIES",
    "ENTERPRISES", "ENTERPRISE", "TRADERS", "TRADING", "SALES", "SERVICE",
    "SERVICES", "PVT", "LTD", "PRIVATE", "LIMITED", "THE", "AND", "INDIA", "NEW",
}


def _dealer_tokens(name: Optional[str]) -> set:
    if not name:
        return set()
    toks = {t for t in re.split(r"[^A-Za-z0-9]+", name.upper()) if len(t) >= 3}
    return (toks - _DEALER_STOPWORDS) or toks


def _dealer_match_score(a_tokens: set, b_tokens: set) -> int:
    return len(a_tokens & b_tokens)


# ── Sheet registry ─────────────────────────────────────────────────────────────

class SheetSourceIn(BaseModel):
    sheet_url_or_id: str
    sheet_type: str                      # 'visit_plan' | 'log_book' | 'targets'
    year: Optional[int] = None           # visit_plan: calendar year; targets: FY start year
    month: Optional[int] = None          # visit_plan only
    quarter: Optional[str] = None        # targets only — 'Q1'..'Q4'


@router.post("/sheet-sources")
def add_sheet_source(
    body: SheetSourceIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(db, current_user)

    quarter = None
    if body.sheet_type == "visit_plan":
        if body.year is None or body.month is None:
            raise HTTPException(status_code=400, detail="Visit plan sheets need a month and a year")
        if not (1 <= body.month <= 12):
            raise HTTPException(status_code=400, detail="month must be 1–12")
        if not (2020 <= body.year <= 2100):
            raise HTTPException(status_code=400, detail="year must be between 2020 and 2100")
        module = MODULE_PLAN
        # Label is derived, never typed, so the month identity can't drift.
        label = f"Visit Plan — {_MONTH_NAMES[body.month - 1]} {body.year}"
        calendar_year, month = body.year, body.month
    elif body.sheet_type == "log_book":
        module = MODULE_LOG
        label = "OE Log Book"
        calendar_year, month = None, None
    elif body.sheet_type == "targets":
        if body.year is None or body.quarter is None:
            raise HTTPException(status_code=400, detail="Target sheets need a quarter and a financial year")
        if body.quarter not in QUARTERS:
            raise HTTPException(status_code=400, detail="quarter must be one of Q1, Q2, Q3, Q4")
        if not (2020 <= body.year <= 2100):
            raise HTTPException(status_code=400, detail="year must be between 2020 and 2100")
        module = MODULE_TGT
        q_no = int(body.quarter[1])
        # year is the FY START year: FY26-27 => 2026. Label carries the quarter
        # tag the team actually says out loud ("AMJ"), not just "Q1".
        label = f"Targets — {QUARTER_TAGS[q_no]} FY{body.year % 100:02d}-{(body.year + 1) % 100:02d}"
        calendar_year, month, quarter = body.year, None, body.quarter
    elif body.sheet_type == "dealer_data":
        # No period: the file is continuous and grows a column each month, so
        # re-syncing it always brings the latest picture — same as the log book.
        module = MODULE_DD
        label = "OE Dealer Data"
        calendar_year, month = None, None
    elif body.sheet_type == "oem_target":
        # One workbook per FINANCIAL year, and the whole year's targets are in
        # it from day one — only the achievement columns fill in month by
        # month. So the year is the identity and re-syncing the same sheet is
        # the normal way to pick up a new month, not an exception.
        if body.year is None:
            raise HTTPException(status_code=400,
                                detail="OEM target sheets need a financial year")
        if not (2020 <= body.year <= 2100):
            raise HTTPException(status_code=400, detail="year must be between 2020 and 2100")
        module = MODULE_OEMTGT
        # FY START year, the same convention the quarterly target sheets use:
        # 2026 => FY26-27.
        label = f"OEM Targets — FY{body.year % 100:02d}-{(body.year + 1) % 100:02d}"
        calendar_year, month = body.year, None
    else:
        raise HTTPException(
            status_code=400,
            detail="sheet_type must be visit_plan, log_book, targets, dealer_data "
                   "or oem_target")

    source = SheetSource(
        id=uuid.uuid4(),
        module=module,
        sheet_id=extract_sheet_id(body.sheet_url_or_id),
        label=label,
        calendar_year=calendar_year,
        month=month,
        quarter=quarter,
        created_by=current_user.id,
    )
    db.add(source)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"{label} is already registered")
    db.refresh(source)
    return _source_out(db, source)


def _source_out(db: Session, s: SheetSource) -> dict:
    last_log = (
        db.query(SyncLog)
        .filter(SyncLog.module == s.module, SyncLog.source_label == s.sheet_id)
        .order_by(SyncLog.synced_at.desc())
        .first()
    )
    return {
        "id": str(s.id), "sheet_id": s.sheet_id, "label": s.label,
        "sheet_type": _sheet_type(s.module),
        "calendar_year": s.calendar_year, "month": s.month, "quarter": s.quarter,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "last_synced_at": last_log.synced_at.isoformat() if last_log and last_log.synced_at else None,
        "last_sync_status": last_log.status if last_log else None,
    }


@router.get("/sheet-sources")
def list_sheet_sources(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _scope(db, current_user)
    sources = (
        db.query(SheetSource)
        .filter(SheetSource.module.in_(OE_MODULES))
        .order_by(SheetSource.module, SheetSource.calendar_year.desc(),
                  SheetSource.month.desc(), SheetSource.quarter.desc())
        .all()
    )
    return [_source_out(db, s) for s in sources]


@router.delete("/sheet-sources/{source_id}")
def delete_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(db, current_user)
    source = db.query(SheetSource).filter(
        SheetSource.id == source_id, SheetSource.module.in_(OE_MODULES)
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    rows_deleted = sum(
        db.execute(text(f"SELECT COUNT(*) FROM {t} WHERE sheet_source_id = :sid"),
                   {"sid": str(source.id)}).scalar()
        for t in _DATA_TABLES[source.module]
    )
    # ON DELETE CASCADE wipes the data rows.
    db.delete(source)
    db.commit()
    return {"deleted": True, "rows_deleted": rows_deleted}


# ── Sync ───────────────────────────────────────────────────────────────────────

# Column lists, not whole statements: every module's rows go through
# _bulk_insert, which builds one multi-row INSERT per chunk. Written one
# statement per row, the log book's ~2,300 rows meant ~2,300 round trips to a
# database reached over an SSH tunnel — minutes of wall clock with a write
# transaction held open the whole time, which is what made it look hung.
_PLAN_COLS = ("id", "sheet_source_id", "salesperson", "visit_date", "plan_year",
              "plan_month", "oem", "dealer_name", "city", "state", "sync_log_id")

_LOG_COLS = ("id", "sheet_source_id", "visit_date", "log_year", "log_month", "salesperson",
             "contact_mode", "oem", "dealership", "address", "contact_person",
             "contact_number", "designation", "car_sales", "seat_cover_sales",
             "mats_sales", "remarks", "remark_product_feedback", "remark_replacement",
             "remark_sales", "remark_others", "channel", "email", "photo_link",
             "city", "state", "sheet_row", "sync_log_id", "dealer_id")

_TGT_COLS = ("id", "sheet_source_id", "fy_year", "quarter", "period_year", "period_month",
             "oem", "category", "salesperson", "region",
             "tgt_nos", "tgt_value", "ach_nos", "ach_value", "value_scale", "sync_log_id")

_OEM_TGT_COLS = ("id", "sheet_source_id", "fy_year", "period_year", "period_month",
                 "quarter", "oem", "product", "product_key",
                 "tgt_nos", "tgt_value", "ach_nos", "ach_value",
                 "tgt_value_scale", "ach_value_scale", "sync_log_id")

_OEM_TGT_ANNUAL_COLS = ("id", "sheet_source_id", "fy_year", "oem", "product",
                        "product_key", "py_nos", "py_value", "py_value_scale",
                        "sync_log_id")

# A module can own more than one table: the dealer file writes the monthly
# sales and the quarterly targets, and both are replaced together on sync.
_DATA_TABLES = {
    MODULE_PLAN: ("oe_visit_plans",),
    MODULE_LOG: ("oe_visit_logs",),
    MODULE_TGT: ("oe_targets",),
    MODULE_DD: ("oe_dealer_monthly", "oe_dealer_targets"),
    MODULE_OEMTGT: ("oe_oem_targets", "oe_oem_target_annual"),
}
_INSERT_COLS = {MODULE_PLAN: _PLAN_COLS, MODULE_LOG: _LOG_COLS, MODULE_TGT: _TGT_COLS}

# How many DEALERSHIPS a set of log rows touched.
#
# Two rows are the same dealership when they resolved to the same outlet, and
# otherwise when the typed name matches ignoring case and spacing. Both halves
# matter and neither is enough alone:
#
#   COUNT(DISTINCT dealership)              971 for July 2026 — counts
#                                           "Popular Vehicles" and "POPULAR
#                                           VEHICLES" as two dealerships
#   COUNT(DISTINCT UPPER(TRIM(dealership))) 905 — still counts every spelling
#                                           variant the old free-text form left
#                                           behind as its own dealership
#   this                                    891 — 417 identified outlets plus
#                                           474 names we could not place
#
# It is still a ceiling, because two unmatched spellings of one dealership stay
# two. It cannot be anything else: if we could tell they were the same, they
# would have matched. Never compare it to the Dealers tab's figure as though
# they answer the same question — see the note on `dealerships_matched` below.
_CONTACTED_DEALERSHIPS = (
    "COUNT(DISTINCT COALESCE(CAST(dealer_id AS text), UPPER(TRIM(dealership))))"
)

_DEALER_MONTHLY_COLS = ("id", "dealer_id", "sheet_source_id", "month", "product",
                        "oem_total", "ysasc", "ys_sale")
_DEALER_TARGET_COLS = ("id", "dealer_id", "sheet_source_id", "quarter", "fy_year",
                       "period_start", "period_end", "product", "target", "achievement")

# How many rows go in one INSERT. These files run to thousands of rows and the
# database is reached over an SSH tunnel, so the cost is dominated by round
# trips, not by the inserts themselves: one statement per row took minutes and
# held a write transaction open the whole time, which is what let a double-click
# on Sync overlap two runs.
#
# 500 keeps every statement inside Postgres's 65535 bind-parameter ceiling with
# room to spare — the widest table here is oe_visit_logs at 29 columns, so
# 500 x 29 = 14,500.
_INSERT_CHUNK = 500


def _db_message(e: Exception, limit: int = 600) -> str:
    """A database failure as something a person can act on.

    `str()` of a SQLAlchemy DBAPIError appends the entire bound parameter list —
    for a batched insert that is thousands of values, and it went straight to
    the browser as the sync's error text. The driver's own message (plus its
    DETAIL line, which names the conflicting key) is the part that says what
    actually went wrong, so that is what we keep.
    """
    msg = str(getattr(e, "orig", None) or e).strip()
    msg = " ".join(msg.split())
    return msg if len(msg) <= limit else msg[:limit] + " …"


def _bulk_insert(db: Session, table: str, cols: tuple, rows: list) -> int:
    """Insert rows in multi-row statements. Returns the number written.

    Rows must carry every column in `cols`. Indexed, not `.get()`: a parser that
    stops emitting a field should fail here rather than quietly write NULLs into
    a column nobody notices for a month. This matches what the per-row named
    statements did before — SQLAlchemy raised on a missing bind parameter.
    """
    if not rows:
        return 0
    collist = ", ".join(cols)
    for i in range(0, len(rows), _INSERT_CHUNK):
        chunk = rows[i:i + _INSERT_CHUNK]
        # Parameters stay bound — the only thing interpolated is the column
        # list and the placeholder names, both of which come from the _*_COLS
        # tuples above and never from the sheet.
        values = ", ".join(
            "(" + ", ".join(f":{c}_{n}" for c in cols) + ")"
            for n in range(len(chunk))
        )
        params = {f"{c}_{n}": row[c] for n, row in enumerate(chunk) for c in cols}
        db.execute(text(f"INSERT INTO {table} ({collist}) VALUES {values}"), params)
    return len(rows)


def sync_dealer_data(db: Session, source_id: Optional[str],
                     records: list, errors: list) -> int:
    """Write the dealer file's rows, creating dealers we have never seen.

    Returns the number of rows written across both tables.

    The file is the authority on which dealers exist, so a name we don't hold
    is added rather than dropped — but only as a last resort, and its state
    comes from the file, which is the one field the file gets wrong (its STATES
    column is a sales region). Those are surfaced as errors so someone checks
    them, because a dealer in the wrong state disappears from the visit form's
    dropdown.
    """
    index = DealerIndex(db)
    created = []
    # Which file rows landed on each outlet. Two rows resolving to ONE dealer is
    # the failure mode of syncing a per-code tab before its outlets exist: the
    # master row carries no dealer_code yet, so every code of a dealership
    # matches it, and the insert then dies on (dealer_id, month, product) with a
    # multi-thousand-parameter IntegrityError that says nothing about the cause.
    # Caught here instead, named, and turned into the instruction that fixes it.
    landed: dict = {}
    # Accumulated and flushed in batches at the end rather than written one row
    # at a time — see _bulk_insert.
    monthly_rows: list = []
    target_rows: list = []
    refresh: list = []

    for rec in records:
        # The code is passed through: on a per-code tab it identifies the outlet
        # exactly, and passing it means a two-code dealership resolves to the
        # right sibling instead of falling back to the group's anchor.
        dealer_id = index.resolve(rec["oem"], rec["name"], rec["city"], rec.get("dealer_code"))
        if dealer_id is None:
            dealer_id = db.execute(text("""
                INSERT INTO oe_dealerships
                    (oem, state, city, name, salesperson, dealer_code, dealer_codes, source)
                VALUES (:oem, :state, NULLIF(:city, ''), :name,
                        NULLIF(:sp, ''), NULLIF(:code, ''), NULLIF(:codes, ''), 'oe_file')
                ON CONFLICT (oem, state, UPPER(name), UPPER(COALESCE(city, '')),
                             UPPER(COALESCE(dealer_code, '')))
                DO UPDATE SET updated_at = NOW()
                RETURNING id
            """), {"oem": rec["oem"], "state": rec["state"] or "Unknown",
                   "city": rec["city"], "name": rec["name"],
                   "sp": rec["salesperson"] or "", "code": rec.get("dealer_code") or "",
                   "codes": rec["dealer_codes"] or ""}).scalar()
            created.append(f"{rec['name']} / {rec['city']}")
        else:
            # Refresh the fields the file owns. City, name and state are left
            # alone: the master already holds a matched outlet, and the file's
            # state cannot be trusted over it. Collected and applied in one
            # statement below rather than one UPDATE per dealer.
            refresh.append({"id": dealer_id, "sp": rec["salesperson"] or "",
                            "codes": rec["dealer_codes"] or ""})

        landed.setdefault(dealer_id, []).append(
            f"{rec['name']} / {rec['city'] or '?'}"
            + (f" (code {rec['dealer_code']})" if rec.get("dealer_code") else ""))

        for m in rec["monthly"]:
            if all(m.get(k) is None for k in DEALER_SERIES):
                continue
            monthly_rows.append({
                "id": str(uuid.uuid4()), "dealer_id": dealer_id,
                "sheet_source_id": source_id, "month": m["month"],
                "product": m["product"],
                **{k: m.get(k) for k in DEALER_SERIES},
            })
        for t in rec["targets"]:
            if t.get("target") is None and t.get("achievement") is None:
                continue
            target_rows.append({
                "id": str(uuid.uuid4()), "dealer_id": dealer_id,
                "sheet_source_id": source_id, **t,
            })

    collisions = {d: rows for d, rows in landed.items() if len(rows) > 1}
    if collisions:
        shown = "; ".join(" + ".join(rows) for rows in list(collisions.values())[:4])
        raise ValueError(
            f"{len(collisions)} outlet(s) in the master list matched more than one row of "
            f"the file, so the same dealer would be written twice for a month. Nothing was "
            f"changed. This is what the outlet backfill exists to fix — run it for this OEM "
            f"first, then sync again:  python -m scripts.backfill_oe_dealer_outlets "
            f"--oem <OEM>   (add --apply once the dry run looks right). It reads the same "
            f"registered sheet this sync just read. Colliding rows: {shown}"
            + (f" … and {len(collisions) - 4} more" if len(collisions) > 4 else ""))

    # One UPDATE ... FROM (VALUES ...) for every matched dealer, in place of one
    # statement each. COALESCE/NULLIF semantics are unchanged.
    for i in range(0, len(refresh), _INSERT_CHUNK):
        chunk = refresh[i:i + _INSERT_CHUNK]
        # CAST(...), not a ::uuid suffix — text() does not recognise a bind
        # parameter that is immediately followed by another colon, so
        # ":id_0::uuid" reaches Postgres as literal text and the whole
        # statement fails on a syntax error.
        values = ", ".join(f"(CAST(:id_{n} AS uuid), :sp_{n}, :codes_{n})"
                           for n in range(len(chunk)))
        params = {f"{k}_{n}": r[k] for n, r in enumerate(chunk) for k in ("id", "sp", "codes")}
        db.execute(text(f"""
            UPDATE oe_dealerships d
               SET salesperson  = COALESCE(NULLIF(v.sp, ''), d.salesperson),
                   dealer_codes = COALESCE(NULLIF(v.codes, ''), d.dealer_codes),
                   updated_at   = NOW()
              FROM (VALUES {values}) AS v(id, sp, codes)
             WHERE d.id = v.id
        """), params)

    written = (_bulk_insert(db, "oe_dealer_monthly", _DEALER_MONTHLY_COLS, monthly_rows)
               + _bulk_insert(db, "oe_dealer_targets", _DEALER_TARGET_COLS, target_rows))

    if created:
        errors.append(
            f"{len(created)} dealer(s) in the file were not in the master list and were "
            f"added with the file's own state, which is a sales region and may be wrong — "
            f"check them: {', '.join(created[:8])}"
            + (f" and {len(created) - 8} more" if len(created) > 8 else "")
        )
    return written


def sync_oem_targets(db: Session, source_id: str, log_id: str,
                     records: list, annual_records: list) -> int:
    """Write the brand-level target summary's two tables. Returns rows written.

    Its own path rather than the shared one for the same reason the dealer file
    has one: two tables from a single parse. Nothing is resolved or created
    here — the OEM is just the tab name — so it is only the two inserts.
    """
    stamp = {"sheet_source_id": source_id, "sync_log_id": log_id}
    months = [{**rec, **stamp, "id": str(uuid.uuid4())} for rec in records]
    annual = [{**rec, **stamp, "id": str(uuid.uuid4())} for rec in annual_records]
    return (_bulk_insert(db, "oe_oem_targets", _OEM_TGT_COLS, months)
            + _bulk_insert(db, "oe_oem_target_annual", _OEM_TGT_ANNUAL_COLS, annual))


def _sync_result(log: SyncLog, db: Session, written: int, deleted: int,
                 skipped_tabs: list, errors: list) -> dict:
    """Close out a sync log and shape the response. Shared so the dealer file,
    which returns early because it writes two tables, reports identically."""
    log.rows_total = written
    log.rows_inserted = written
    log.rows_updated = 0
    log.rows_failed = 0
    log.rows_deleted = deleted
    log.status = "Done"
    log.error_details = "\n".join(errors) if errors else None
    db.commit()

    return {
        "sync_id": str(log.id),
        "rows_total": written,
        "rows_inserted": written,
        "rows_updated": 0,
        "rows_failed": 0,
        "rows_deleted": deleted,
        "skipped_tabs": skipped_tabs,
        "errors": errors[:20],
        "status": "Done",
    }


# How long after a successful pull the shared Sync button stops re-pulling the
# same sheet. Short on purpose: it exists to collapse a rush — six reps tapping
# Sync within a minute of each other used to mean six full downloads of every
# sheet, which the row lock does not prevent because none of them overlap — not
# to stop anyone refreshing. A rep who has just filed a visit waits out the rest
# of the minute rather than being locked out of their own data, and the response
# says exactly when the last pull happened so they can judge that for themselves
# instead of being told a flat "up to date" that might not be true for them.
SYNC_COOLDOWN_SECONDS = int(os.getenv("OE_SYNC_COOLDOWN_SECONDS") or 60)


def _synced_within_cooldown(db: Session, source: SheetSource):
    """The timestamp of a successful sync inside the cooldown window, else None.

    Only 'Done' counts. A run that failed, or one still Processing, leaves the
    sheet exactly as stale as it was, so it must not suppress the next attempt —
    that would turn one bad pull into a minute of silently refusing to retry.
    """
    if SYNC_COOLDOWN_SECONDS <= 0:
        return None
    return db.execute(text("""
        SELECT synced_at FROM sync_logs
        WHERE module = :module
          AND source_label IS NOT DISTINCT FROM :label
          AND status = 'Done'
          AND synced_at > NOW() - (CAST(:window AS int) * INTERVAL '1 second')
        ORDER BY synced_at DESC
        LIMIT 1
    """), {"module": source.module, "label": source.sheet_id,
           "window": SYNC_COOLDOWN_SECONDS}).scalar()


def _do_sync(db: Session, source: SheetSource, current_user: User) -> dict:
    log = SyncLog(
        id=uuid.uuid4(),
        module=source.module,
        source_label=source.sheet_id,
        status="Processing",
        synced_by=current_user.id,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    prune_sync_logs(db, source.module, source.sheet_id)

    # Claim this source BEFORE reading a single cell from Google. The lock has
    # to be here, not after the parse: reps can press Sync now, and six people
    # tapping it at once used to mean six full downloads of every sheet — the
    # log book is thousands of rows — after which five of them discovered they
    # could not have the lock and threw all of it away. Claiming first turns
    # that into one download and five instant 409s.
    #
    # Taken after the log bookkeeping has committed, because that commit would
    # otherwise release it. Held across the fetch and the write, to the final
    # commit. Holding it over a slow network call costs nothing here: NOWAIT
    # means the others fail immediately rather than queue behind it.
    try:
        db.execute(
            text("SELECT 1 FROM sheet_sources WHERE id = :id FOR UPDATE NOWAIT"),
            {"id": str(source.id)},
        )
    except OperationalError:
        db.rollback()
        log.status = "Failed"
        log.error_details = "A sync for this sheet was already running."
        db.commit()
        raise HTTPException(
            status_code=409,
            detail="This sheet is already syncing — wait for that run to finish.",
        )

    # Only the OEM target sheet produces a second set of rows (last year's
    # actual, which has no month); every other parser leaves this empty.
    annual_records: list = []
    try:
        if source.module == MODULE_PLAN:
            records, skipped_tabs, errors = parse_visit_plan(
                source.sheet_id, source.calendar_year, source.month
            )
        elif source.module == MODULE_TGT:
            records, skipped_tabs, errors = parse_targets(
                source.sheet_id, source.calendar_year, int(source.quarter[1])
            )
        elif source.module == MODULE_DD:
            records, skipped_tabs, errors = parse_dealer_data(source.sheet_id)
        elif source.module == MODULE_OEMTGT:
            records, annual_records, skipped_tabs, errors = parse_oem_targets(
                source.sheet_id, source.calendar_year
            )
        else:
            records, skipped_tabs, errors = parse_log_book(source.sheet_id)
    except Exception as e:
        log.status = "Failed"
        log.error_details = _db_message(e, 4000)
        db.commit()
        raise HTTPException(status_code=502,
                            detail=f"Could not sync from Google Sheets: {_db_message(e)}")

    tables = _DATA_TABLES[source.module]

    # The source row is already locked (claimed above, before the fetch) and
    # stays locked to the commit below. That is what stops two overlapping runs
    # doubling the data: every sync is delete-then-insert, so without it the
    # second run's DELETE lands while the first run's INSERTs are still
    # uncommitted, deletes nothing, and both sets of rows survive — every figure
    # on the tab doubles.

    # Full-replace in ONE transaction: rows removed from the sheet disappear
    # here too, and a mid-sync failure can never leave the table half-wiped.
    try:
        deleted = sum(
            db.execute(text(f"DELETE FROM {t} WHERE sheet_source_id = :sid"),
                       {"sid": str(source.id)}).rowcount
            for t in tables
        )

        if source.module == MODULE_DD:
            written = sync_dealer_data(db, str(source.id), records, errors)
            db.commit()
            return _sync_result(log, db, written, deleted, skipped_tabs, errors)

        if source.module == MODULE_OEMTGT:
            written = sync_oem_targets(db, str(source.id), str(log.id),
                                       records, annual_records)
            db.commit()
            return _sync_result(log, db, written, deleted, skipped_tabs, errors)

        cols = _INSERT_COLS[source.module]

        # Log rows carry the outlet they belong to, so visits, remarks, dealer
        # sales and targets all hang off one key. Resolved here rather than at
        # read time because it is the same answer every time and the dealer
        # views would otherwise redo it on every request. Unresolved stays NULL
        # and is reported below — never guessed at.
        index = DealerIndex(db) if source.module == MODULE_LOG else None
        unresolved = 0
        rows: list = []
        for rec in records:
            extra = {}
            if index is not None:
                did = index.resolve(rec.get("oem"), rec.get("dealership"), rec.get("city"))
                extra["dealer_id"] = did
                unresolved += did is None
            rows.append({
                **rec,
                **extra,
                "id": str(uuid.uuid4()),
                "sheet_source_id": str(source.id),
                "sync_log_id": str(log.id),
            })
        # Batched, not one statement per row — see _bulk_insert. Each of these
        # modules writes exactly one table.
        _bulk_insert(db, _DATA_TABLES[source.module][0], cols, rows)
        db.commit()
        if unresolved:
            errors.append(
                f"{unresolved} of {len(records)} log rows could not be matched to a "
                f"dealership in the master list and will not appear in dealer views."
            )
    except Exception as e:
        db.rollback()
        log.status = "Failed"
        # The log keeps a longer copy than the toast does; still not the params.
        log.error_details = _db_message(e, 4000)
        db.commit()
        raise HTTPException(status_code=500,
                            detail=f"Could not store synced rows: {_db_message(e)}")

    return _sync_result(log, db, len(records), deleted, skipped_tabs, errors)


@router.post("/sheet-sources/{source_id}/sync")
def sync_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(db, current_user)
    source = db.query(SheetSource).filter(
        SheetSource.id == source_id, SheetSource.module.in_(OE_MODULES)
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    return _do_sync(db, source, current_user)


# What a tab's Sync button may ask for. Each tab pulls only the sheets it draws
# from: one shared button that pulled everything made Visit/Calling re-download
# the dealer file and both target sheets, and how many it pulled varied with the
# cooldown, so the same press looked different from one minute to the next.
SYNC_SHEET_KEYS = ("log", "plan", "dealers", "targets", "oem_targets")


def parse_sync_sheets(raw: str | None) -> set[str]:
    """`?sheets=log,plan` → {"log", "plan"}; absent means every key. An unknown
    key is refused rather than dropped — silently syncing less than was asked
    for would look exactly like a sync that found nothing new."""
    if raw is None or not raw.strip():
        return set(SYNC_SHEET_KEYS)
    keys = {k.strip() for k in raw.split(",") if k.strip()}
    unknown = keys - set(SYNC_SHEET_KEYS)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown sheet key(s): {', '.join(sorted(unknown))}. "
                   f"Use any of: {', '.join(SYNC_SHEET_KEYS)}")
    return keys


@router.post("/sync-latest")
def sync_latest(
    sheets: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One-click refresh for a tab: the log book and the dealer file both keep
    growing, and only the newest visit-plan month, target quarter and OEM target
    year still change, so those are the sheets worth re-pulling — earlier
    periods are frozen history. `sheets` narrows it to the tab's own sources."""
    _scope(db, current_user)
    wanted = parse_sync_sheets(sheets)
    growing = [m for k, m in (("log", MODULE_LOG), ("dealers", MODULE_DD)) if k in wanted]
    sources = (db.query(SheetSource).filter(SheetSource.module.in_(growing)).all()
               if growing else [])
    if "plan" in wanted:
        newest_plan = (
            db.query(SheetSource)
            .filter(SheetSource.module == MODULE_PLAN)
            .order_by(SheetSource.calendar_year.desc(), SheetSource.month.desc())
            .first()
        )
        if newest_plan:
            sources.append(newest_plan)
    if "targets" in wanted:
        newest_targets = (
            db.query(SheetSource)
            .filter(SheetSource.module == MODULE_TGT)
            .order_by(SheetSource.calendar_year.desc(), SheetSource.quarter.desc())
            .first()
        )
        if newest_targets:
            sources.append(newest_targets)
    # The current FY's OEM summary is a live sheet all year: the targets are
    # set once but a month of achievement lands in it every month, so the
    # newest year is always worth re-pulling.
    if "oem_targets" in wanted:
        newest_oem_targets = (
            db.query(SheetSource)
            .filter(SheetSource.module == MODULE_OEMTGT)
            .order_by(SheetSource.calendar_year.desc())
            .first()
        )
        if newest_oem_targets:
            sources.append(newest_oem_targets)
    if not sources:
        raise HTTPException(
            status_code=400,
            detail="No sheet for this tab has been added yet — add it from the Data Source Sheets tab")

    results = []
    for source in sources:
        # Checked per source, not once for the whole run: the four sheets are
        # synced on their own schedules by the per-source button too, so one of
        # them being fresh says nothing about the others.
        fresh = _synced_within_cooldown(db, source)
        if fresh is not None:
            results.append({
                "label": source.label, "status": "Up to date",
                "rows_inserted": 0, "error": None,
                "last_synced_at": fresh.isoformat(),
            })
            continue
        try:
            out = _do_sync(db, source, current_user)
            results.append({"label": source.label, "status": out["status"],
                            "rows_inserted": out["rows_inserted"]})
        except HTTPException as e:
            # 409 is somebody else's sync already running, which is not this
            # caller's problem and not an error: the run in flight is pulling
            # the same sheet and their screen will have it. Reporting it as
            # "Failed" invited exactly the retry that makes a rush worse, which
            # matters now that every rep can press Sync.
            already = e.status_code == 409
            results.append({
                "label": source.label,
                "status": "Already syncing" if already else "Failed",
                "rows_inserted": 0,
                "error": None if already else str(e.detail),
            })
    return {"results": results}


# ── Shared filter plumbing ────────────────────────────────────────────────────

# oe_visit_logs keeps `remarks` (the old single-blob column, from before the
# visit-log form existed) and the 4 new-form categories
# (remark_product_feedback / remark_replacement / remark_sales /
# remark_others) as fully separate fields everywhere — never merged. A row
# submitted through the new form leaves `remarks` NULL; its text lives only
# in whichever category columns the rep filled in.


def _add_filters(where: list, params: dict, mapping: dict):
    """mapping: {sql_column: value} — adds an equality clause per non-empty value."""
    for col, val in mapping.items():
        if val:
            key = col.replace(".", "_")
            where.append(f"{col} = :{key}")
            params[key] = val


_YM_RE = re.compile(r"^(\d{4})-(\d{1,2})$")


_snap_to_months = snap_to_months


def _ym_value(token: str) -> int:
    m = _YM_RE.match(token or "")
    if not m or not (1 <= int(m.group(2)) <= 12):
        raise HTTPException(status_code=400, detail=f"Invalid period token: {token!r} (expected YYYY-MM)")
    return int(m.group(1)) * 100 + int(m.group(2))


def _add_period(where: list, params: dict, year_col: str, month_col: str,
                year: Optional[int], month: Optional[int],
                from_ym: Optional[str], to_ym: Optional[str],
                date_col: Optional[str] = None,
                from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Scopes to a single month (year+month), an inclusive month range
    (from_ym..to_ym, 'YYYY-MM'), or an exact day range (from_date..to_date).

    A day range is applied to `date_col` when the table has one. Tables that
    only carry a year and a month — the visit plans — cannot be cut finer than
    a month, so there the range widens to every month it touches. Callers that
    compare the two kinds of table against each other must snap BOTH sides to
    months themselves; a like-for-like comparison is the whole point of those
    endpoints, and silently cutting one side finer than the other would make
    the ratio wrong rather than merely imprecise.
    """
    d1, d2 = _parse_date(from_date, "from_date"), _parse_date(to_date, "to_date")
    if d1 and d2:
        if d1 > d2:
            raise HTTPException(status_code=400, detail="from_date is after to_date")
        if date_col:
            where.append(f"{date_col} BETWEEN :p_dfrom AND :p_dto")
            params["p_dfrom"], params["p_dto"] = d1, d2
        else:
            where.append(f"({year_col} * 100 + {month_col}) BETWEEN :p_from AND :p_to")
            params["p_from"] = d1.year * 100 + d1.month
            params["p_to"] = d2.year * 100 + d2.month
        return
    if from_ym and to_ym:
        where.append(f"({year_col} * 100 + {month_col}) BETWEEN :p_from AND :p_to")
        params["p_from"] = _ym_value(from_ym)
        params["p_to"] = _ym_value(to_ym)
        return
    if year is not None:
        where.append(f"{year_col} = :p_year")
        params["p_year"] = year
    if month is not None:
        where.append(f"{month_col} = :p_month")
        params["p_month"] = month


# ── Visit plans list ──────────────────────────────────────────────────────────

@router.get("/plans")
def list_plans(
    year: Optional[int] = None,
    month: Optional[int] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealer name search"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, salesperson = _scope(db, current_user, salesperson)

    where = ["1=1"]
    params: dict = {}
    scope.apply(where, params, "salesperson", "oe_visit_plans")
    if year is not None:
        where.append("plan_year = :year")
        params["year"] = year
    if month is not None:
        where.append("plan_month = :month")
        params["month"] = month
    _add_filters(where, params, {"salesperson": salesperson, "oem": oem, "state": state, "city": city})
    if q:
        where.append("dealer_name ILIKE :q")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    total = db.execute(text(f"SELECT COUNT(*) FROM oe_visit_plans WHERE {where_sql}"), params).scalar()
    summary = db.execute(text(f"""
        SELECT COUNT(*) AS planned,
               COUNT(DISTINCT salesperson) AS salespersons,
               COUNT(DISTINCT dealer_name) AS dealers,
               COUNT(DISTINCT city) AS cities
        FROM oe_visit_plans WHERE {where_sql}
    """), params).fetchone()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT id, salesperson, visit_date, plan_year, plan_month, oem, dealer_name, city, state
        FROM oe_visit_plans WHERE {where_sql}
        ORDER BY salesperson, visit_date NULLS LAST, dealer_name
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "total": total, "page": page, "per_page": per_page,
        "summary": {
            "planned_visits": summary.planned, "salespersons": summary.salespersons,
            "dealers": summary.dealers, "cities": summary.cities,
        },
        "data": [
            {
                "id": str(r.id), "salesperson": r.salesperson,
                "visit_date": r.visit_date.isoformat() if r.visit_date else None,
                "plan_year": r.plan_year, "plan_month": r.plan_month,
                "oem": r.oem, "dealer_name": r.dealer_name, "city": r.city, "state": r.state,
            }
            for r in rows
        ],
    }


# ── Log book list ─────────────────────────────────────────────────────────────

@router.get("/logs")
def list_logs(
    year: Optional[int] = None,
    month: Optional[int] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    contact_mode: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership name search"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, salesperson = _scope(db, current_user, salesperson)

    where = ["1=1"]
    params: dict = {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    if year is not None:
        where.append("log_year = :year")
        params["year"] = year
    if month is not None:
        where.append("log_month = :month")
        params["month"] = month
    _add_filters(where, params, {
        "salesperson": salesperson, "oem": oem, "state": state,
        "city": city, "contact_mode": contact_mode,
    })
    if q:
        where.append("dealership ILIKE :q")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    total = db.execute(text(f"SELECT COUNT(*) FROM oe_visit_logs WHERE {where_sql}"), params).scalar()
    summary = db.execute(text(f"""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
               {_CONTACTED_DEALERSHIPS} AS dealerships
        FROM oe_visit_logs WHERE {where_sql}
    """), params).fetchone()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT id, visit_date, salesperson, contact_mode, oem, dealership, address, designation,
               car_sales, seat_cover_sales, mats_sales, remarks, city, state
        FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "total": total, "page": page, "per_page": per_page,
        "summary": {
            "total_logs": summary.total, "visits": summary.visits,
            "calls": summary.calls, "dealerships": summary.dealerships,
        },
        "data": [
            {
                "id": str(r.id), "visit_date": r.visit_date.isoformat(),
                "salesperson": r.salesperson, "contact_mode": r.contact_mode, "oem": r.oem,
                "dealership": r.dealership, "address": r.address, "designation": r.designation,
                "car_sales": float(r.car_sales) if r.car_sales is not None else None,
                "seat_cover_sales": float(r.seat_cover_sales) if r.seat_cover_sales is not None else None,
                "mats_sales": float(r.mats_sales) if r.mats_sales is not None else None,
                "remarks": r.remarks, "city": r.city, "state": r.state,
            }
            for r in rows
        ],
    }


# ── Remarks / field activity ──────────────────────────────────────────────────
# "What is everyone up to?" — the log book's free-text REMARKS are the field
# team's own account of every visit and call. We tag each remark with themes
# (order booked, order pushed, follow-up, catalogue shared…) so leadership can
# read the gist across hundreds of notes, roll it up per salesperson, and still
# drop into the raw feed. Theme tagging is done in Python (services/remark_themes),
# so the whole filtered slice is pulled once and summarised in memory — the log
# book is a few hundred rows a month, so this stays cheap.

def _theme_list(counter: dict) -> list:
    """Counter keyed by theme -> ordered [{key,label,count}] in THEMES order,
    dropping themes with no hits."""
    return [
        {"key": key, "label": label, "count": counter[key]}
        for key, label in THEMES if counter.get(key)
    ]


# The rep now classifies their own note at source: the visit-log form makes them
# tick one or more of four categories and write a separate remark in each, and
# each lands in its own column. That hand-classification beats anything the
# keyword classifier can infer, so it is the PRIMARY axis here and the themes
# nest inside it — "of the 176 Sales notes, 112 are pushing for an order".
#
# `general` is the pre-form world: one blob in `remarks`, no category. Rows
# written before 29 Jul 2026 have only that; rows since have only the four. The
# two are never merged (see the note above _add_filters), so a row contributes
# one entry per non-empty remark field and a single row can appear under several
# categories at once.
REMARK_CATEGORIES = [
    ("sales", "Sales", "remark_sales"),
    ("product_feedback", "Product Feedback", "remark_product_feedback"),
    ("replacement", "Replacement", "remark_replacement"),
    ("others", "Others", "remark_others"),
    ("general", "General (pre-form)", "remarks"),
]
_CATEGORY_KEYS = {key for key, _, _ in REMARK_CATEGORIES}
_CATEGORY_COLUMNS = [col for _, _, col in REMARK_CATEGORIES]


def _notes(found: list) -> list:
    """The per-category notes of one row, shaped for the client."""
    return [
        {"category": key, "label": label, "text": body, "themes": ts}
        for key, label, body, ts in found
    ]


@router.get("/remarks")
def remarks_activity(
    year: Optional[int] = None,
    month: Optional[int] = None,
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    contact_mode: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership or remark text search"),
    category: Optional[str] = Query(None, description="Restrict the feed to one remark category"),
    theme: Optional[str] = Query(None, description="Restrict the feed to one theme key"),
    page: int = Query(1, ge=1),
    per_page: int = Query(30, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Categories + nested themes + per-salesperson rollup + remark feed, in one call.

    The KPIs, category/theme tallies and per-salesperson rollup are computed over
    the whole filtered slice; only the feed narrows to `category`/`theme` and
    paginates. That keeps the chips stable when one is clicked to filter the feed
    beneath them.
    """
    scope, salesperson = _scope(db, current_user, salesperson)
    if theme and not is_theme(theme):
        raise HTTPException(status_code=400, detail=f"Unknown theme: {theme!r}")
    if category and category not in _CATEGORY_KEYS:
        raise HTTPException(status_code=400, detail=f"Unknown remark category: {category!r}")

    # "Has a remark" now means any of the five fields, not just the legacy blob —
    # every row written since 29 Jul 2026 leaves `remarks` NULL.
    any_remark = " OR ".join(f"COALESCE({c}, '') <> ''" for c in _CATEGORY_COLUMNS)
    where = [f"({any_remark})"]
    params: dict = {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym,
                date_col="visit_date", from_date=from_date, to_date=to_date)
    _add_filters(where, params, {
        "salesperson": salesperson, "oem": oem, "state": state,
        "city": city, "contact_mode": contact_mode,
    })
    if q:
        text_cols = " OR ".join(f"{c} ILIKE :q" for c in _CATEGORY_COLUMNS)
        where.append(f"(dealership ILIKE :q OR {text_cols})")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    rows = db.execute(text(f"""
        SELECT id, visit_date, salesperson, contact_mode, oem, dealership,
               city, state, {", ".join(_CATEGORY_COLUMNS)}
        FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
    """), params).fetchall()

    # One row fans out into one entry per non-empty remark field. Classify each
    # separately: a Sales note and a Product Feedback note on the same visit are
    # different statements and must not share tags.
    #   entries[row_id] -> [(category_key, label, text, [theme keys]), …]
    entries: dict = {}
    for r in rows:
        found = []
        for key, label, col in REMARK_CATEGORIES:
            body = (getattr(r, col) or "").strip()
            if body:
                found.append((key, label, body, classify_remark(body)))
        entries[r.id] = found

    # Row-level tags = the union across its categories, for the salesperson rollup.
    tags = {rid: sorted({t for _, _, _, ts in e for t in ts}) for rid, e in entries.items()}

    # Category tallies, each with its own nested theme breakdown.
    cat_counts: dict = {}
    cat_themes: dict = {}
    for e in entries.values():
        for key, _, _, ts in e:
            cat_counts[key] = cat_counts.get(key, 0) + 1
            bucket = cat_themes.setdefault(key, {})
            for t in ts:
                bucket[t] = bucket.get(t, 0) + 1

    categories = [
        {
            "key": key,
            "label": label,
            "count": cat_counts[key],
            "themes": _theme_list(cat_themes.get(key, {})),
        }
        for key, label, _ in REMARK_CATEGORIES if cat_counts.get(key)
    ]

    theme_counter: dict = {}
    for r in rows:
        for t in tags[r.id]:
            theme_counter[t] = theme_counter.get(t, 0) + 1

    # Per-salesperson rollup — the spine of "what everyone is up to".
    people: dict = {}
    for r in rows:
        sp = r.salesperson or "—"
        p = people.get(sp)
        if p is None:
            p = people[sp] = {
                "salesperson": sp, "remarks": 0, "visits": 0, "calls": 0,
                "dealers": set(), "themes": {}, "categories": {}, "latest": None,
            }
        p["remarks"] += 1
        if r.contact_mode == "Visit":
            p["visits"] += 1
        elif r.contact_mode == "Calling":
            p["calls"] += 1
        if r.dealership:
            p["dealers"].add(r.dealership.strip().lower())
        for t in tags[r.id]:
            p["themes"][t] = p["themes"].get(t, 0) + 1
        for key, _, _, _ in entries[r.id]:
            p["categories"][key] = p["categories"].get(key, 0) + 1
        # rows are date-desc, so the first one seen per person is the latest.
        if p["latest"] is None:
            p["latest"] = {
                "visit_date": r.visit_date.isoformat(),
                "dealership": r.dealership, "oem": r.oem,
                "contact_mode": r.contact_mode,
                "notes": _notes(entries[r.id]),
                "themes": tags[r.id],
            }

    by_salesperson = sorted(
        (
            {
                "salesperson": p["salesperson"],
                "remarks": p["remarks"], "visits": p["visits"], "calls": p["calls"],
                "dealers": len(p["dealers"]),
                "top_themes": _theme_list(p["themes"])[:3],
                "categories": [
                    {"key": key, "label": label, "count": p["categories"][key]}
                    for key, label, _ in REMARK_CATEGORIES if p["categories"].get(key)
                ],
                "latest": p["latest"],
            }
            for p in people.values()
        ),
        key=lambda x: x["remarks"], reverse=True,
    )

    # Feed — narrow to the chosen category/theme, then paginate in memory. When
    # both are set the SAME note must satisfy both, so "Sales + complaint" means
    # a complaint written under Sales, not a row that happens to have each
    # somewhere.
    def keeps(r) -> bool:
        return any(
            (not category or key == category) and (not theme or theme in ts)
            for key, _, _, ts in entries[r.id]
        )

    feed_rows = [r for r in rows if keeps(r)] if (category or theme) else list(rows)
    total = len(feed_rows)
    start = (page - 1) * per_page
    page_rows = feed_rows[start:start + per_page]

    return {
        "kpis": {
            # `remarks` counts ROWS with at least one note; `notes` counts the
            # notes themselves, which is higher whenever a rep ticks 2+ categories.
            "remarks": len(rows),
            "notes": sum(cat_counts.values()),
            "dealers": len({r.dealership.strip().lower() for r in rows if r.dealership}),
            "salespersons": len(people),
            "visits": sum(1 for r in rows if r.contact_mode == "Visit"),
            "calls": sum(1 for r in rows if r.contact_mode == "Calling"),
        },
        "categories": categories,
        "themes": _theme_list(theme_counter),
        "by_salesperson": by_salesperson,
        "feed": {
            "total": total, "page": page, "per_page": per_page,
            "data": [
                {
                    "id": str(r.id), "visit_date": r.visit_date.isoformat(),
                    "salesperson": r.salesperson, "contact_mode": r.contact_mode,
                    "oem": r.oem, "dealership": r.dealership,
                    "city": r.city, "state": r.state,
                    "notes": _notes(entries[r.id]),
                    "themes": tags[r.id],
                }
                for r in page_rows
            ],
        },
    }


# ── Filter options ────────────────────────────────────────────────────────────

@router.get("/filter-options")
def filter_options(
    scope: str = Query(..., description="plans | logs | dealer_sales"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    user_scope, _ = _scope(db, current_user)
    if scope == "plans":
        table = "oe_visit_plans"
        scope_table = "oe_visit_plans"
        extra = {}
    elif scope == "logs":
        table = "oe_visit_logs"
        scope_table = "oe_visit_logs"
        extra = {"contact_modes": "contact_mode"}
    elif scope == "dealer_sales":
        # Only the OEMs we actually hold dealer sales for. The Dealers tab is
        # built on oe_dealer_monthly, so offering an OEM that has visit logs but
        # no sales file (every OEM except MSIL today) is a filter that can only
        # ever return an empty tab. Derived, not listed: the day a TATA dealer
        # file is synced, TATA appears here on its own.
        table = ("oe_dealerships d JOIN oe_dealer_monthly m ON m.dealer_id = d.id")
        scope_table = "oe_dealerships"
        extra = {}
    else:
        raise HTTPException(
            status_code=400, detail="scope must be plans, logs or dealer_sales")

    # dealer_sales reads from a join, so its columns need qualifying.
    p = "d." if scope == "dealer_sales" else ""

    scope_where, scope_params = [], {}
    user_scope.apply(scope_where, scope_params, f"{p}salesperson", scope_table)
    scope_sql = ("".join(f" AND {c}" for c in scope_where))

    def distinct(col: str):
        rows = db.execute(text(
            f"SELECT DISTINCT {p}{col} FROM {table} "
            f"WHERE {p}{col} IS NOT NULL{scope_sql} ORDER BY {p}{col}"
        ), scope_params).fetchall()
        return [r[0] for r in rows]

    out = {
        "salespersons": distinct("salesperson"),
        "oems": distinct("oem"),
        "states": distinct("state"),
        "cities": distinct("city"),
    }
    if scope == "dealer_sales":
        # From the sales rows, not from the current response: an OEM that sells
        # only seat covers must not shrink the dropdown for the one that also
        # reports mats.
        out["products"] = [r[0] for r in db.execute(text(
            f"""SELECT DISTINCT m.product
                  FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
                 WHERE 1=1{scope_sql} ORDER BY 1"""), scope_params).fetchall()]
    for key, col in extra.items():
        out[key] = distinct(col)
    # Whose data these options (and every row alongside them) describe. None for
    # an unscoped user. The tabs read this to drop the salesperson picker and to
    # print whose numbers are on screen, rather than inferring either from the
    # locally cached user record.
    out["scope"] = user_scope.as_dict()
    return out


# ── Available periods ─────────────────────────────────────────────────────────

@router.get("/periods")
def available_periods(
    oem: Optional[str] = Query(None, description="Scopes dealer_months to one OEM"),
    product: Optional[str] = Query(None, description="Scopes dealer_months to one product"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, _ = _scope(db, current_user)

    plan_where, plan_params = ["1=1"], {}
    scope.apply(plan_where, plan_params, "salesperson", "oe_visit_plans")
    plan_months = db.execute(text(f"""
        SELECT DISTINCT plan_year AS year, plan_month AS month FROM oe_visit_plans
        WHERE {" AND ".join(plan_where)} ORDER BY 1, 2
    """), plan_params).fetchall()

    log_where, log_params = ["1=1"], {}
    scope.apply(log_where, log_params, "salesperson", "oe_visit_logs")
    log_months = db.execute(text(f"""
        SELECT DISTINCT log_year AS year, log_month AS month FROM oe_visit_logs
        WHERE {" AND ".join(log_where)} ORDER BY 1, 2
    """), log_params).fetchall()
    # The months the dealer sales file covers. The Dealers tab needs these
    # BEFORE its first request: its period picker defaults to a month, and it
    # cannot pick one out of a response it has not fetched yet.
    #
    # Scoped to the OEM, because the OEMs do not cover the same months and the
    # union is wrong for every one of them: MSIL's file runs Jan-Jul 2026 while
    # TATA's starts in July, so an unscoped list offered six empty months on the
    # TATA view. A month in the picker is a promise that there is something
    # behind it.
    dm_where, dm_params = [], {}
    scope.apply(dm_where, dm_params, "d.salesperson", "oe_dealerships")
    if oem:
        dm_where.append("UPPER(d.oem) = UPPER(:dm_oem)")
        dm_params["dm_oem"] = oem
    if product:
        dm_where.append("m.product = :dm_product")
        dm_params["dm_product"] = product
    dm_sql = (" WHERE " + " AND ".join(dm_where)) if dm_where else ""
    dealer_months = db.execute(text(f"""
        SELECT DISTINCT EXTRACT(YEAR FROM m.month)::int  AS year,
                        EXTRACT(MONTH FROM m.month)::int AS month
        FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
        {dm_sql}
        ORDER BY 1, 2
    """), dm_params).fetchall()
    return {
        "plan_months": [{"year": r.year, "month": r.month} for r in plan_months],
        "log_months": [{"year": r.year, "month": r.month} for r in log_months],
        "dealer_months": [{"year": r.year, "month": r.month} for r in dealer_months],
    }


# ── Log analytics ─────────────────────────────────────────────────────────────

@router.get("/log-analytics")
def log_analytics(
    year: Optional[int] = None,
    month: Optional[int] = None,
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    contact_mode: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership name search"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, salesperson = _scope(db, current_user, salesperson)

    where = ["1=1"]
    params: dict = {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym,
                date_col="visit_date", from_date=from_date, to_date=to_date)
    _add_filters(where, params, {
        "salesperson": salesperson, "oem": oem, "state": state,
        "city": city, "contact_mode": contact_mode,
    })
    if q:
        where.append("dealership ILIKE :q")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    kpis = db.execute(text(f"""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
               {_CONTACTED_DEALERSHIPS} AS dealerships,
               COUNT(DISTINCT salesperson) AS salespersons,
               AVG(car_sales) AS avg_car_sales,
               AVG(seat_cover_sales) AS avg_seat_cover_sales,
               AVG(mats_sales) AS avg_mats_sales
        FROM oe_visit_logs WHERE {where_sql}
    """), params).fetchone()

    def grouped(col: str):
        rows = db.execute(text(f"""
            SELECT {col} AS key,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
                   COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
                   {_CONTACTED_DEALERSHIPS} AS dealerships
            FROM oe_visit_logs WHERE {where_sql} AND {col} IS NOT NULL
            GROUP BY {col} ORDER BY total DESC
        """), params).fetchall()
        return [
            {"key": r.key, "total": r.total, "visits": r.visits, "calls": r.calls, "dealerships": r.dealerships}
            for r in rows
        ]

    trend = db.execute(text(f"""
        SELECT log_year AS year, log_month AS month,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls
        FROM oe_visit_logs WHERE {where_sql}
        GROUP BY log_year, log_month ORDER BY 1, 2
    """), params).fetchall()

    return {
        "kpis": {
            "total_logs": kpis.total, "visits": kpis.visits, "calls": kpis.calls,
            "dealerships": kpis.dealerships, "salespersons": kpis.salespersons,
            # Dealer-reported monthly figures — averages by design (summing
            # would double-count the same dealership across repeat contacts).
            "avg_car_sales": round(float(kpis.avg_car_sales), 1) if kpis.avg_car_sales is not None else None,
            "avg_seat_cover_sales": round(float(kpis.avg_seat_cover_sales), 1) if kpis.avg_seat_cover_sales is not None else None,
            "avg_mats_sales": round(float(kpis.avg_mats_sales), 1) if kpis.avg_mats_sales is not None else None,
        },
        "by_salesperson": grouped("salesperson"),
        "by_oem": grouped("oem"),
        "by_state": grouped("state"),
        "monthly_trend": [
            {"year": r.year, "month": r.month, "total": r.total, "visits": r.visits, "calls": r.calls}
            for r in trend
        ],
    }


# ── Plan vs actual ────────────────────────────────────────────────────────────

@router.get("/plan-vs-actual")
def plan_vs_actual(
    year: Optional[int] = None,
    month: Optional[int] = Query(None, ge=1, le=12),
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealer name search"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, salesperson = _scope(db, current_user, salesperson)
    # This endpoint pairs names in Python, so a scoped user's own name is what
    # the pairing filter below needs — the SQL-safe None that _scope returns
    # would drop the filter entirely.
    if scope.limited:
        salesperson = scope.canonical
    # Plans carry no day, so a day range widens to whole months on BOTH sides
    # rather than cutting the logs finer than the plan they are measured against.
    if from_date and to_date:
        from_ym, to_ym = _snap_to_months(from_date, to_date)
    if not ((from_ym and to_ym) or (year is not None and month is not None)):
        raise HTTPException(status_code=400, detail="Provide year+month or from_ym+to_ym")

    # oem/state/city/dealer-search exist on both tables and filter both sides in
    # SQL. A salesperson FILTER can't — the two sheets spell names differently —
    # so it is applied after grouping, via the same token matching used to pair
    # rows. A salesperson SCOPE is different and does go into the SQL: the
    # totals below are recomputed straight from the database rather than summed
    # from the paired rows, so a Python-only scope would leave them counting the
    # whole team under a rep's own row breakdown.
    def side_where(year_col: str, month_col: str, dealer_col: str, table: str) -> tuple:
        where = ["1=1"]
        params: dict = {}
        scope.apply(where, params, "salesperson", table)
        _add_period(where, params, year_col, month_col, year, month, from_ym, to_ym)
        _add_filters(where, params, {"oem": oem, "state": state, "city": city})
        if q:
            where.append(f"{dealer_col} ILIKE :q")
            params["q"] = f"%{q}%"
        return " AND ".join(where), params

    plan_where, plan_params = side_where("plan_year", "plan_month", "dealer_name", "oe_visit_plans")
    planned = db.execute(text(f"""
        SELECT salesperson, COUNT(*) AS planned, COUNT(DISTINCT dealer_name) AS dealers_planned
        FROM oe_visit_plans WHERE {plan_where}
        GROUP BY salesperson ORDER BY salesperson
    """), plan_params).fetchall()

    log_where, log_params = side_where("log_year", "log_month", "dealership", "oe_visit_logs")
    logged = db.execute(text(f"""
        SELECT salesperson,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
               {_CONTACTED_DEALERSHIPS} AS dealerships
        FROM oe_visit_logs WHERE {log_where}
        GROUP BY salesperson
    """), log_params).fetchall()

    if salesperson:
        planned = [p for p in planned if _names_match(p.salesperson, salesperson)]
        logged = [r for r in logged if _names_match(r.salesperson, salesperson)]

    unmatched_logs = {r.salesperson: r for r in logged if r.salesperson}
    rows = []
    for p in planned:
        matches = [name for name in unmatched_logs if _names_match(p.salesperson, name)]
        visits = calls = total = dealerships = 0
        for name in matches:
            r = unmatched_logs.pop(name)
            visits += r.visits
            calls += r.calls
            total += r.total
            dealerships += r.dealerships
        rows.append({
            "salesperson": p.salesperson,
            "log_name": ", ".join(matches) if matches else None,
            "planned": p.planned,
            "dealers_planned": p.dealers_planned,
            "visits": visits,
            "calls": calls,
            "total_logged": total,
            "dealerships_contacted": dealerships,
            # plan_pct, not "coverage". It is visits DONE over visits PLANNED,
            # which is a completion figure and routinely exceeds 100%. It says
            # nothing about how much of the network was reached: a rep can visit
            # the same 30 dealerships repeatedly and still clear their plan.
            # "Coverage" means one thing in this app -- dealerships contacted
            # out of dealerships assigned, on the Dealers tab -- and this is not
            # that. coverage_pct is kept as a deprecated alias so a backend
            # deploy cannot break a frontend that has not shipped yet; remove it
            # once both sides are live.
            "plan_pct": round(visits / p.planned * 100, 1) if p.planned else None,
            "coverage_pct": round(visits / p.planned * 100, 1) if p.planned else None,
        })

    # Salespeople who logged activity but had no plan tab this month.
    for name, r in unmatched_logs.items():
        rows.append({
            "salesperson": name, "log_name": name,
            "planned": 0, "dealers_planned": 0,
            "visits": r.visits, "calls": r.calls, "total_logged": r.total,
            "dealerships_contacted": r.dealerships,
            "plan_pct": None, "coverage_pct": None,
        })

    total_planned = sum(r["planned"] for r in rows)
    total_visits = sum(r["visits"] for r in rows)
    total_calls = sum(r["calls"] for r in rows)
    # Counted once across the whole scope, NOT summed from the per-rep figures:
    # a dealership two reps both contacted is one dealership, and adding the
    # rows would report it twice.
    total_dealerships = db.execute(text(f"""
        SELECT {_CONTACTED_DEALERSHIPS} FROM oe_visit_logs
        WHERE {log_where}
    """), log_params).scalar() or 0
    # ...and how many of those we could actually place in the OE dealer list.
    #
    # Returned so the Overview can print it BESIDE the total instead of leaving
    # the reader to discover, on another tab, that "dealerships" is 891 here and
    # 417 there. Both are right and they answer different questions: this tab
    # counts every dealership the team named, the Dealers tab counts only those
    # the OE dealer file knows about, because everything it goes on to divide by
    # -- coverage, penetration, target -- comes out of that file. Printing the
    # smaller number under the larger one turns a contradiction into a subtotal.
    matched_dealerships = db.execute(text(f"""
        SELECT COUNT(DISTINCT dealer_id) FROM oe_visit_logs
        WHERE {log_where} AND dealer_id IS NOT NULL
    """), log_params).scalar() or 0
    return {
        "year": year, "month": month, "from_ym": from_ym, "to_ym": to_ym,
        "rows": rows,
        "totals": {
            "planned": total_planned, "visits": total_visits, "calls": total_calls,
            # Distinct dealerships actually named this period, so repetition is
            # visible beside the completion figure instead of hiding inside it.
            "dealerships": total_dealerships,
            "dealerships_matched": matched_dealerships,
            "plan_pct": round(total_visits / total_planned * 100, 1) if total_planned else None,
            "coverage_pct": round(total_visits / total_planned * 100, 1) if total_planned else None,
        },
    }


# ── Dealer directory ──────────────────────────────────────────────────────────
# The network itself, not the activity: one row per dealership (case-folded),
# with recency, contact mix and the dealer's own reported figures.

_DEALER_SORTS = {
    "recent": "last_contact DESC",
    "stale": "last_contact ASC",
    "most": "total DESC",
    "name": "dealer_name ASC",
}


@router.get("/dealers")
def dealer_directory(
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership name search"),
    sort: str = Query("recent", description="recent | stale | most | name"),
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, salesperson = _scope(db, current_user, salesperson)
    order = _DEALER_SORTS.get(sort, _DEALER_SORTS["recent"])

    where = ["1=1"]
    params: dict = {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    _add_filters(where, params, {"salesperson": salesperson, "oem": oem, "state": state})
    if q:
        where.append("dealership ILIKE :q")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    summary = db.execute(text(f"""
        SELECT COUNT(*) AS dealers,
               COUNT(*) FILTER (WHERE last_contact >= CURRENT_DATE - 30) AS active_30,
               COUNT(*) FILTER (WHERE last_contact < CURRENT_DATE - 45) AS stale_45
        FROM (
            SELECT MAX(visit_date) AS last_contact
            FROM oe_visit_logs WHERE {where_sql}
            GROUP BY LOWER(dealership)
        ) t
    """), params).fetchone()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT
            (ARRAY_AGG(dealership ORDER BY visit_date DESC, sheet_row DESC NULLS LAST))[1] AS dealer_name,
            (ARRAY_AGG(oem ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE oem IS NOT NULL))[1] AS oem,
            (ARRAY_AGG(city ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE city IS NOT NULL))[1] AS city,
            (ARRAY_AGG(state ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE state IS NOT NULL))[1] AS state,
            (ARRAY_AGG(salesperson ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE salesperson IS NOT NULL))[1] AS last_salesperson,
            (ARRAY_AGG(contact_mode ORDER BY visit_date DESC, sheet_row DESC NULLS LAST))[1] AS last_mode,
            (ARRAY_AGG(remarks ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE remarks IS NOT NULL AND remarks <> ''))[1] AS last_remark,
            MAX(visit_date) AS last_contact,
            (CURRENT_DATE - MAX(visit_date)) AS days_since,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
            COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
            AVG(car_sales) AS avg_car_sales,
            AVG(seat_cover_sales) AS avg_seat_cover_sales,
            AVG(seat_cover_sales / NULLIF(car_sales, 0))
                FILTER (WHERE car_sales > 0 AND seat_cover_sales IS NOT NULL) AS attach
        FROM oe_visit_logs
        WHERE {where_sql}
        GROUP BY LOWER(dealership)
        ORDER BY {order}
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "summary": {
            "dealers": summary.dealers,
            "active_30": summary.active_30,
            "stale_45": summary.stale_45,
        },
        "total": summary.dealers, "page": page, "per_page": per_page,
        "data": [
            {
                "dealer_name": r.dealer_name, "oem": r.oem, "city": r.city, "state": r.state,
                "last_salesperson": r.last_salesperson, "last_mode": r.last_mode,
                "last_remark": r.last_remark,
                "last_contact": r.last_contact.isoformat() if r.last_contact else None,
                "days_since": r.days_since,
                "total": r.total, "visits": r.visits, "calls": r.calls,
                "avg_car_sales": round(float(r.avg_car_sales), 1) if r.avg_car_sales is not None else None,
                "avg_seat_cover_sales": round(float(r.avg_seat_cover_sales), 1) if r.avg_seat_cover_sales is not None else None,
                "attach_pct": round(float(r.attach) * 100, 1) if r.attach is not None else None,
            }
            for r in rows
        ],
    }


@router.get("/dealers/history")
def dealer_history(
    name: str = Query(..., description="Dealership name as shown in the directory"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, _ = _scope(db, current_user)
    where = ["LOWER(dealership) = LOWER(:name)"]
    params: dict = {"name": name}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    rows = db.execute(text(f"""
        SELECT visit_date, salesperson, contact_mode, oem, designation,
               car_sales, seat_cover_sales, mats_sales, remarks, city, state
        FROM oe_visit_logs
        WHERE {" AND ".join(where)}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
        LIMIT 100
    """), params).fetchall()
    return {
        "dealer_name": name,
        "contacts": [
            {
                "visit_date": r.visit_date.isoformat(),
                "salesperson": r.salesperson, "contact_mode": r.contact_mode,
                "oem": r.oem, "designation": r.designation,
                "car_sales": float(r.car_sales) if r.car_sales is not None else None,
                "seat_cover_sales": float(r.seat_cover_sales) if r.seat_cover_sales is not None else None,
                "mats_sales": float(r.mats_sales) if r.mats_sales is not None else None,
                "remarks": r.remarks, "city": r.city, "state": r.state,
            }
            for r in rows
        ],
    }


# ── Plan adherence (dealer-level) ─────────────────────────────────────────────
# Plan-vs-actual above compares COUNTS; this compares NAMES: was each planned
# dealership actually contacted by that salesperson, and which contacted
# dealers were never on the plan at all.

@router.get("/plan-adherence")
def plan_adherence(
    year: Optional[int] = None,
    month: Optional[int] = Query(None, ge=1, le=12),
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, salesperson = _scope(db, current_user, salesperson)
    # Pairs names in Python, like plan-vs-actual — see the note there.
    if scope.limited:
        salesperson = scope.canonical
    # Plans carry no day, so a day range widens to whole months on BOTH sides
    # rather than cutting the logs finer than the plan they are measured against.
    if from_date and to_date:
        from_ym, to_ym = _snap_to_months(from_date, to_date)
    if not ((from_ym and to_ym) or (year is not None and month is not None)):
        raise HTTPException(status_code=400, detail="Provide year+month or from_ym+to_ym")

    def side_where(year_col: str, month_col: str, table: str) -> tuple:
        where = ["1=1"]
        params: dict = {}
        scope.apply(where, params, "salesperson", table)
        _add_period(where, params, year_col, month_col, year, month, from_ym, to_ym)
        _add_filters(where, params, {"oem": oem, "state": state})
        return " AND ".join(where), params

    plan_where, plan_params = side_where("plan_year", "plan_month", "oe_visit_plans")
    plans = db.execute(text(f"""
        SELECT salesperson, dealer_name,
               MIN(oem) AS oem, MIN(city) AS city, COUNT(*) AS planned_visits
        FROM oe_visit_plans WHERE {plan_where}
        GROUP BY salesperson, dealer_name
        ORDER BY salesperson, dealer_name
    """), plan_params).fetchall()

    log_where, log_params = side_where("log_year", "log_month", "oe_visit_logs")
    logs = db.execute(text(f"""
        SELECT salesperson, dealership, MIN(oem) AS oem,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls
        FROM oe_visit_logs WHERE {log_where}
        GROUP BY salesperson, dealership
    """), log_params).fetchall()

    plan_by_sp: dict = {}
    for p in plans:
        plan_by_sp.setdefault(p.salesperson, []).append(p)
    log_by_sp: dict = {}
    for l in logs:
        log_by_sp.setdefault(l.salesperson, []).append(l)

    if salesperson:
        plan_by_sp = {sp: v for sp, v in plan_by_sp.items() if _names_match(sp, salesperson)}
        log_by_sp = {sp: v for sp, v in log_by_sp.items() if _names_match(sp, salesperson)}

    unmatched_log_sps = dict(log_by_sp)
    out_rows = []
    for sp, planned_dealers in plan_by_sp.items():
        # Same consumption logic as plan-vs-actual: each log name pairs with
        # at most one plan name.
        matched_names = [n for n in unmatched_log_sps if _names_match(sp, n)]
        logged: list = []
        for n in matched_names:
            logged.extend(unmatched_log_sps.pop(n))
        logged_tokens = [(l, _dealer_tokens(l.dealership)) for l in logged]
        consumed = set()

        dealers = []
        visited = called = missed = 0
        for p in planned_dealers:
            p_tokens = _dealer_tokens(p.dealer_name)
            best, best_score = None, 0
            p_visits = p_calls = 0
            for l, l_tokens in logged_tokens:
                score = _dealer_match_score(p_tokens, l_tokens)
                if score > 0:
                    consumed.add(l.dealership)
                    p_visits += l.visits
                    p_calls += l.calls
                    if score > best_score:
                        best, best_score = l, score
            if p_visits > 0:
                status = "visited"
                visited += 1
            elif p_calls > 0:
                status = "called"
                called += 1
            else:
                status = "missed"
                missed += 1
            dealers.append({
                "dealer_name": p.dealer_name, "oem": p.oem, "city": p.city,
                "planned_visits": p.planned_visits, "status": status,
                "log_dealership": best.dealership if best else None,
                "visits": p_visits, "calls": p_calls,
            })

        unplanned = [
            {"dealership": l.dealership, "oem": l.oem, "visits": l.visits, "calls": l.calls}
            for l, _t in logged_tokens if l.dealership not in consumed
        ]
        unplanned.sort(key=lambda u: -(u["visits"] + u["calls"]))
        planned_n = len(planned_dealers)
        out_rows.append({
            "salesperson": sp,
            "log_name": ", ".join(matched_names) if matched_names else None,
            "planned": planned_n, "visited": visited, "called_only": called, "missed": missed,
            "adherence_pct": round(visited / planned_n * 100, 1) if planned_n else None,
            "touch_pct": round((visited + called) / planned_n * 100, 1) if planned_n else None,
            "unplanned_count": len(unplanned),
            "dealers": dealers,
            "unplanned": unplanned[:50],
        })

    # Salespeople with logs but no plan this period.
    for sp, logged in unmatched_log_sps.items():
        if sp is None:
            continue
        unplanned = [
            {"dealership": l.dealership, "oem": l.oem, "visits": l.visits, "calls": l.calls}
            for l in logged
        ]
        unplanned.sort(key=lambda u: -(u["visits"] + u["calls"]))
        out_rows.append({
            "salesperson": sp, "log_name": sp,
            "planned": 0, "visited": 0, "called_only": 0, "missed": 0,
            "adherence_pct": None, "touch_pct": None,
            "unplanned_count": len(unplanned),
            "dealers": [], "unplanned": unplanned[:50],
        })

    out_rows.sort(key=lambda r: (r["planned"] == 0, r["salesperson"] or ""))
    tp = sum(r["planned"] for r in out_rows)
    tv = sum(r["visited"] for r in out_rows)
    tc = sum(r["called_only"] for r in out_rows)
    tm = sum(r["missed"] for r in out_rows)
    return {
        "rows": out_rows,
        "totals": {
            "planned": tp, "visited": tv, "called_only": tc, "missed": tm,
            "unplanned": sum(r["unplanned_count"] for r in out_rows),
            "adherence_pct": round(tv / tp * 100, 1) if tp else None,
            "touch_pct": round((tv + tc) / tp * 100, 1) if tp else None,
        },
    }


# ── Attach rates ──────────────────────────────────────────────────────────────
# The dealer-reported figures turned into a real metric: seat-cover sales as a
# share of the dealer's car sales. Averaged per dealer FIRST, then across
# dealers — repeat contacts with the same dealer must not weight the average.

@router.get("/attach-rates")
def attach_rates(
    year: Optional[int] = None,
    month: Optional[int] = Query(None, ge=1, le=12),
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    state: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope, salesperson = _scope(db, current_user, salesperson)
    where = ["car_sales > 0", "seat_cover_sales IS NOT NULL"]
    params: dict = {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym,
                date_col="visit_date", from_date=from_date, to_date=to_date)
    _add_filters(where, params, {"salesperson": salesperson, "state": state})
    where_sql = " AND ".join(where)

    inner = f"""
        SELECT LOWER(dealership) AS dkey, oem,
               AVG(seat_cover_sales / NULLIF(car_sales, 0)) AS attach,
               AVG(mats_sales / NULLIF(car_sales, 0)) AS mats_attach,
               AVG(car_sales) AS cars
        FROM oe_visit_logs
        WHERE {where_sql}
        GROUP BY LOWER(dealership), oem
    """
    by_oem = db.execute(text(f"""
        SELECT oem, COUNT(*) AS dealers,
               AVG(attach) * 100 AS attach_pct,
               AVG(mats_attach) * 100 AS mats_attach_pct,
               AVG(cars) AS avg_car_sales
        FROM ({inner}) t WHERE oem IS NOT NULL
        GROUP BY oem ORDER BY attach_pct DESC
    """), params).fetchall()
    overall = db.execute(text(f"""
        SELECT COUNT(*) AS dealers, AVG(attach) * 100 AS attach_pct
        FROM ({inner}) t
    """), params).fetchone()

    return {
        "overall": {
            "dealers": overall.dealers,
            "attach_pct": round(float(overall.attach_pct), 1) if overall.attach_pct is not None else None,
        },
        "by_oem": [
            {
                "oem": r.oem, "dealers": r.dealers,
                "attach_pct": round(float(r.attach_pct), 1) if r.attach_pct is not None else None,
                "mats_attach_pct": round(float(r.mats_attach_pct), 1) if r.mats_attach_pct is not None else None,
                "avg_car_sales": round(float(r.avg_car_sales), 1) if r.avg_car_sales is not None else None,
            }
            for r in by_oem
        ],
    }


# -- My Visits ----------------------------------------------------------------
# A rep's own submissions, in full, exportable. This is what the OTP-only ASM
# portal existed to provide; it lives here now that reps have real accounts, so
# there is one login and one place to look.
#
# Deliberately NOT built on /logs: that endpoint serves the analytics tabs and
# returns only the subset they draw. This returns every field the rep actually
# typed -- contact number, channel, photo link, each remark category separately
# -- so the table and the export read like the log book itself rather than a
# summary of it.


def _my_visits_where(scope: OEScope, oem, contact_mode, from_date, to_date, q):
    where = ["1=1"]
    params: dict = {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    if oem:
        where.append("UPPER(oem) = UPPER(:mv_oem)")
        params["mv_oem"] = oem.strip()
    if contact_mode:
        where.append("contact_mode = :mv_mode")
        params["mv_mode"] = contact_mode.strip().title()
    if from_date:
        where.append("visit_date >= CAST(:mv_from AS date)")
        params["mv_from"] = _parse_date(from_date, "from_date")
    if to_date:
        where.append("visit_date <= CAST(:mv_to AS date)")
        params["mv_to"] = _parse_date(to_date, "to_date")
    if q:
        where.append("(dealership ILIKE :mv_q OR city ILIKE :mv_q OR state ILIKE :mv_q)")
        params["mv_q"] = f"%{q.strip()}%"
    return " AND ".join(where), params


def _my_visits_scope(db: Session, current_user: User) -> OEScope:
    """This view is only meaningful for somebody it can say "my" about."""
    scope, _ = _scope(db, current_user)
    if not scope.limited:
        raise HTTPException(
            status_code=403,
            detail="My Visits shows the rows filed under your own name, and this "
                   "account is not linked to a salesperson. Use the Field Activity "
                   "tab to see the whole team.")
    return scope


_MV_FIELDS = """
    visit_date, dealership, contact_mode, oem, channel, contact_person,
    contact_number, designation, city, state, address,
    car_sales, seat_cover_sales, mats_sales,
    remarks, remark_product_feedback, remark_replacement, remark_sales,
    remark_others, photo_link, email
"""


@router.get("/my-visits")
def my_visits(
    oem: Optional[str] = None,
    contact_mode: Optional[str] = Query(None, description="Visit or Calling"),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    q: Optional[str] = Query(None, description="Dealership / city / state search"),
    page: int = Query(1, ge=1),
    per_page: int = Query(30, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope = _my_visits_scope(db, current_user)
    where_sql, params = _my_visits_where(scope, oem, contact_mode, from_date, to_date, q)

    # The tiles ignore the Visit/Calling filter on purpose: narrowing the table
    # to Visits would zero the Calls tile, which tells the reader nothing. Every
    # other active filter still applies, so the tiles stay honest about the
    # window being looked at.
    kpi_sql, kpi_params = _my_visits_where(scope, oem, None, from_date, to_date, q)
    summary = db.execute(text(f"""
        SELECT COUNT(*) FILTER (WHERE contact_mode = 'Visit')   AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
               COUNT(DISTINCT dealership) AS dealerships
        FROM oe_visit_logs WHERE {kpi_sql}
    """), kpi_params).fetchone()

    total = db.execute(text(
        f"SELECT COUNT(*) FROM oe_visit_logs WHERE {where_sql}"), params).scalar()

    params["mv_limit"] = per_page
    params["mv_offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT {_MV_FIELDS} FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
        LIMIT :mv_limit OFFSET :mv_offset
    """), params).mappings().all()

    def num(v):
        return float(v) if v is not None else None

    numeric = ("car_sales", "seat_cover_sales", "mats_sales")
    return {
        "salesperson": scope.canonical,
        "total": total, "page": page, "per_page": per_page,
        "summary": {"visits": summary.visits, "calls": summary.calls,
                    "dealerships": summary.dealerships},
        "data": [
            {
                **{k: r[k] for k in r.keys() if k not in numeric and k != "visit_date"},
                "visit_date": r["visit_date"].isoformat() if r["visit_date"] else None,
                **{k: num(r[k]) for k in numeric},
            }
            for r in rows
        ],
    }


# Matches the live log-book sheet's own header wording AND column order, so the
# export reads like the source of truth rather than a paraphrase of it.
# Timestamp and the month-abbreviation column are omitted: both restate the
# visit date.
_MV_HEADERS = [
    "Visit Date / Calling Date", "Dealership Name", "Visit / Calling", "OEM", "Channel",
    "Contact Person", "Contact No.", "Designation", "City", "State", "Dealership Address",
    "Total Car Sales", "Total Seat Covers Sales", "Mats Sales",
    "Remarks", "Product Feedback", "Replacement", "Sales", "Others",
    "Upload Photo", "Email address",
]

# Same order as _MV_HEADERS. Kept as one list so a column cannot be added to the
# header row without also being added to the data row.
_MV_EXPORT_KEYS = [
    "visit_date", "dealership", "contact_mode", "oem", "channel",
    "contact_person", "contact_number", "designation", "city", "state", "address",
    "car_sales", "seat_cover_sales", "mats_sales",
    "remarks", "remark_product_feedback", "remark_replacement", "remark_sales",
    "remark_others", "photo_link", "email",
]


def _mv_export_rows(db: Session, where_sql: str, params: dict) -> list:
    assert len(_MV_HEADERS) == len(_MV_EXPORT_KEYS)
    rows = db.execute(text(f"""
        SELECT {_MV_FIELDS} FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
    """), params).mappings().all()
    out = []
    for r in rows:
        line = []
        for k in _MV_EXPORT_KEYS:
            v = r[k]
            if k == "visit_date":
                line.append(v.strftime("%d/%m/%Y") if v else "")
            elif v is None:
                line.append("")
            else:
                line.append(v)
        out.append(line)
    return out


def _mv_disposition(scope: OEScope, ext: str) -> dict:
    name = f"visit-log_{(scope.canonical or 'me').replace(' ', '_')}.{ext}"
    return {"Content-Disposition": f'attachment; filename="{name}"'}


@router.get("/my-visits/export.csv")
def my_visits_csv(
    oem: Optional[str] = None,
    contact_mode: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope = _my_visits_scope(db, current_user)
    where_sql, params = _my_visits_where(scope, oem, contact_mode, from_date, to_date, q)
    buf = _io.StringIO()
    w = csv.writer(buf)
    w.writerow(_MV_HEADERS)
    w.writerows(_mv_export_rows(db, where_sql, params))
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers=_mv_disposition(scope, "csv"))


@router.get("/my-visits/export.xlsx")
def my_visits_xlsx(
    oem: Optional[str] = None,
    contact_mode: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    scope = _my_visits_scope(db, current_user)
    where_sql, params = _my_visits_where(scope, oem, contact_mode, from_date, to_date, q)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Visit Log"
    ws.append(_MV_HEADERS)
    for row in _mv_export_rows(db, where_sql, params):
        ws.append(row)
    for i, h in enumerate(_MV_HEADERS, start=1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = max(12, len(h) + 2)
    buf = _io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=_mv_disposition(scope, "xlsx"))


# -- Sync history --------------------------------------------------------------─

@router.get("/sync-history")
def sync_history(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(db, current_user)
    # Map sheet_id → label so history rows say "Visit Plan — July 2026", not an opaque ID.
    sources = db.query(SheetSource).filter(SheetSource.module.in_(OE_MODULES)).all()
    labels = {s.sheet_id: s.label for s in sources}
    logs = (
        db.query(SyncLog)
        .filter(SyncLog.module.in_(OE_MODULES))
        .order_by(SyncLog.synced_at.desc())
        .limit(SYNC_LOG_RETENTION)
        .all()
    )
    return [
        {
            "id": str(l.id),
            "sheet_type": _sheet_type(l.module),
            "source_label": labels.get(l.source_label, l.source_label),
            "rows_total": l.rows_total, "rows_inserted": l.rows_inserted,
            "rows_failed": l.rows_failed, "rows_deleted": l.rows_deleted,
            "status": l.status,
            "synced_at": l.synced_at.isoformat() if l.synced_at else None,
        }
        for l in logs
    ]


# ── Dealer performance ────────────────────────────────────────────────────────
# The dealer-centric half of the module. Everything above answers "what is each
# rep doing"; this answers "how is each dealership doing" — which is what the OE
# team's own dealer file is keyed on, and what leadership asks about.
#
# TWO PERIOD GRAINS, deliberately. Dealer sales arrive as one figure per month,
# so a range like 12 Jul – 5 Aug cannot be cut finer than whole months for
# sales, while visits and calls are dated to the day and are cut exactly. Both
# are returned so the UI can say so, rather than quietly implying the sales
# figures were filtered to the day.

def _last_day(m: date) -> date:
    return date(m.year, m.month, calendar.monthrange(m.year, m.month)[1])


def _ym_to_date(token: str) -> date:
    v = _ym_value(token)
    return date(v // 100, v % 100, 1)


def _period_bounds(year: Optional[int], month: Optional[int],
                   from_ym: Optional[str], to_ym: Optional[str],
                   from_date: Optional[str], to_date: Optional[str]):
    """(month_from, month_to, date_from, date_to). Any may be None for all time.

    A custom day range wins when given; otherwise this reads exactly the period
    params every other endpoint here takes, so the shared filter bar keeps
    working unchanged.
    """
    d1, d2 = _parse_date(from_date, "from_date"), _parse_date(to_date, "to_date")
    if d1 and d2:
        if d1 > d2:
            raise HTTPException(status_code=400, detail="from_date is after to_date")
        return d1.replace(day=1), d2.replace(day=1), d1, d2
    if from_ym and to_ym:
        m1, m2 = _ym_to_date(from_ym), _ym_to_date(to_ym)
        if m1 > m2:
            raise HTTPException(status_code=400, detail="from_ym is after to_ym")
        return m1, m2, m1, _last_day(m2)
    if year is not None and month is not None:
        m = date(year, month, 1)
        return m, m, m, _last_day(m)
    if year is not None:
        return date(year, 1, 1), date(year, 12, 1), date(year, 1, 1), date(year, 12, 31)
    return None, None, None, None


def _dealer_scope(where: list, params: dict, oem: Optional[str],
                  salesperson: Optional[str], state: Optional[str]):
    """Entity filters applied to the DEALER, not to the visit.

    salesperson here is the rep the dealer is assigned to in the OE file, not
    whoever happened to log a contact. The question this tab answers is "how is
    this rep's patch doing", and that has to include the dealers they never
    touched — otherwise filtering by rep would hide exactly the gap worth
    seeing.
    """
    if oem:
        where.append("d.oem = :f_oem")
        params["f_oem"] = oem
    if salesperson:
        where.append("UPPER(d.salesperson) = UPPER(:f_sp)")
        params["f_sp"] = salesperson
    if state:
        where.append("d.state = :f_state")
        params["f_state"] = state


# Reused by every query below: the activity slice, the sales slice, and the
# dealer filter are the same three ideas each time.
# CAST(:p AS date), never :p::date — SQLAlchemy's text() does not recognise a
# bind parameter followed by the :: cast operator and leaves it as literal SQL.
_ACT_WINDOW = """
    dealer_id IS NOT NULL
    AND (CAST(:d_from AS date) IS NULL OR visit_date >= CAST(:d_from AS date))
    AND (CAST(:d_to   AS date) IS NULL OR visit_date <= CAST(:d_to   AS date))
"""
_SALES_WINDOW = """
    (CAST(:m_from AS date) IS NULL OR month >= CAST(:m_from AS date))
    AND (CAST(:m_to AS date) IS NULL OR month <= CAST(:m_to AS date))
"""
# Sales and targets are now per PRODUCT (TATA sets separate seat-cover and mat
# targets and reports each separately). Unfiltered, every product is summed,
# which is right for the OEMs that publish only one.
_PROD_WINDOW = """
    (CAST(:f_prod AS varchar) IS NULL OR {a}.product = CAST(:f_prod AS varchar))
"""


def _prod(alias: str) -> str:
    return _PROD_WINDOW.format(a=alias)


_DEALER_AGG_SQL = """
WITH sales AS (
    -- SUM(ysasc) is NULL only when no month in range supplied one, which is
    -- what makes penetration honestly unavailable rather than wrong. Same for
    -- oem_total, which an OEM like TATA never publishes at all: it has to reach
    -- the screen as an em dash, not as a zero that reads like "sold nothing".
    -- ys_sale is different and IS coalesced to 0 below -- it counts OUR sales,
    -- and no row genuinely means none.
    SELECT m.dealer_id, SUM(m.oem_total) AS oem_total,
           SUM(m.ysasc) AS ysasc, SUM(m.ys_sale) AS ys_sale
    FROM oe_dealer_monthly m
    WHERE {sales_window} AND {prod_window} GROUP BY 1
),
acts AS (
    SELECT dealer_id,
           COUNT(*) AS contacts,
           COUNT(*) FILTER (WHERE contact_mode = 'Visit')   AS visits,
           COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
           MAX(visit_date) AS last_contact
    FROM oe_visit_logs WHERE {act_window} GROUP BY 1
),
grp AS (
    -- Contacts, rolled up to the DEALERSHIP. A visit log names a dealership and
    -- a city and never a dealer code, so where an OEM's file splits one
    -- dealership across codes every sibling shows the visits that were really
    -- made to it, instead of one sibling holding them all and the others
    -- reading as never contacted. The caller counts each group once.
    SELECT d.oem AS g_oem, UPPER(d.name) AS g_name,
           UPPER(COALESCE(d.city, '')) AS g_city,
           SUM(a.contacts) AS contacts, SUM(a.visits) AS visits,
           SUM(a.calls) AS calls, MAX(a.last_contact) AS last_contact
    FROM oe_dealerships d JOIN acts a ON a.dealer_id = d.id
    GROUP BY 1, 2, 3
),
tgts AS (
    -- A quarter counts if it OVERLAPS the period at all, and its target is NOT
    -- pro-rated: the target was agreed for the whole quarter, and slicing it
    -- would invent a number the OE team never signed up to.
    --
    -- `sold` is what we actually sold inside those quarters' own months, per
    -- product. It exists because the two file shapes differ on achievement:
    -- MSIL publishes a quarter ACH column, TATA publishes a quarter target and
    -- only MONTHLY results. Summed at READ time and returned BESIDE the stored
    -- figure rather than written into it -- a stored copy of a derivable number
    -- can only drift from its inputs.
    SELECT t.dealer_id,
           CAST(SUM(t.target)      AS double precision) AS target,
           CAST(SUM(t.achievement) AS double precision) AS achievement
    FROM oe_dealer_targets t
    WHERE (CAST(:m_from AS date) IS NULL OR t.period_end   >= CAST(:m_from AS date))
      AND (CAST(:m_to   AS date) IS NULL OR t.period_start <= CAST(:m_to   AS date))
      AND {tgt_prod_window}
    GROUP BY 1
),
sold AS (
    -- Our units inside the quarters the period touches, per dealer.
    --
    -- Deliberately NOT computed inside `tgts`: doing it there only counted
    -- dealers that HAVE a target, so the 46 dealers with mat sales and no mat
    -- target vanished from the figure and the "Achieved" tile read 3,457 while
    -- the Quarter panel, which sums independently, read 3,791. Two numbers
    -- disagreeing on one screen is a support call.
    --
    -- The month window is "inside ANY quarter that overlaps the period", so it
    -- matches the quarters shown, whether or not this particular dealer was
    -- given one.
    SELECT m.dealer_id, SUM(m.ys_sale) AS sold
    FROM oe_dealer_monthly m
    WHERE {prod_window}
      AND EXISTS (
        SELECT 1 FROM oe_dealer_targets t
         WHERE (CAST(:m_from AS date) IS NULL OR t.period_end   >= CAST(:m_from AS date))
           AND (CAST(:m_to   AS date) IS NULL OR t.period_start <= CAST(:m_to   AS date))
           AND {tgt_prod_window}
           AND m.month >= t.period_start AND m.month <= t.period_end)
    GROUP BY 1
)
SELECT d.id, d.oem, d.name, d.city, d.state, d.salesperson, d.dealer_codes,
       UPPER(d.name) || '~' || UPPER(COALESCE(d.city, '')) AS group_key,
       s.oem_total              AS oem_total,
       s.ysasc                  AS ysasc,
       COALESCE(s.ys_sale, 0)   AS ys_sale,
       COALESCE(g.contacts, 0)  AS contacts,
       COALESCE(g.visits, 0)    AS visits,
       COALESCE(g.calls, 0)     AS calls,
       g.last_contact,
       CAST(t.target      AS double precision) AS target,
       CAST(t.achievement AS double precision) AS achievement,
       so.sold,
       (s.dealer_id IS NOT NULL) AS has_sales
FROM oe_dealerships d
LEFT JOIN sales s ON s.dealer_id = d.id
LEFT JOIN tgts  t ON t.dealer_id = d.id
LEFT JOIN sold  so ON so.dealer_id = d.id
LEFT JOIN grp   g ON g.g_oem = d.oem AND g.g_name = UPPER(d.name)
                 AND g.g_city = UPPER(COALESCE(d.city, ''))
WHERE d.is_active
  AND (s.dealer_id IS NOT NULL OR g.g_oem IS NOT NULL OR t.dealer_id IS NOT NULL
       OR so.dealer_id IS NOT NULL)
  {extra}
ORDER BY COALESCE(s.ys_sale, 0) DESC, d.name
"""


def _ratio(num, den) -> Optional[float]:
    """A percentage as a RATIO OF SUMS, never the mean of monthly percentages.
    Averaging the monthly figures would weight a 12-unit month like a 1,200-unit
    one and quietly disagree with the OE team's own sheet."""
    return round(100.0 * num / den, 2) if den else None


def _ours(d: dict) -> float:
    """Our units for a target-only OEM, per dealer.

    Mirrors `oursOf` in the Dealers tab's model.ts and has to keep mirroring it:
    the "Amato SC Sale" tile is the sum of the column printed underneath it, so
    the moment the two disagree about an absent `sold` the page gives two
    answers to one question.

    `sold` is NULL for a dealer whose months touch no quarter at all — TATA's
    JAS'26 targets land before the OND ones do, so an October screen has
    achievement with no quarter to sum it into. Reading that as 0 is what made
    the tile show 0 while every row beneath it showed real units. ys_sale is
    already COALESCEd to 0 in the query, so the fallback is always a number.
    """
    return d["sold"] if d["sold"] is not None else d["ys_sale"]


def _funnel(oem_total, ysasc, ys_sale) -> dict:
    """The dealer file's three figures and the three ratios read off them.

    The funnel narrows: oem_total (every seat cover the dealer sold) ⊇ ysasc
    (those on a vehicle we hold a part number for) ⊇ ys_sale (ours).

      penetration     ys_sale ÷ ysasc — the headline. What we converted of what
                      we could have won.
      share           ys_sale ÷ oem_total — our slice of the dealer's whole
                      seat-cover business. This is what "penetration" used to
                      mean here, kept because it is the number that says how
                      big the dealer is to us overall.
      addressable_pct ysasc ÷ oem_total — how much of that dealer's business we
                      even make a part for. A low value is a product gap, NOT a
                      selling failure, and must never be read as one.

    penetration is NULL when ysasc is absent rather than falling back to
    oem_total: a silent fallback would report the old, much lower number
    (11.8% network-wide vs 20.1%) under the new name.

    oem_total passes through as NULL for the same reason. TATA publishes no
    total-sold figure at all, and a 0 there would render on every screen in the
    tab as "this dealer sold nothing". ys_sale is the one figure that IS zeroed:
    it counts our own sales, so no row genuinely means none.
    """
    total, avail, ours = oem_total, ysasc, ys_sale or 0
    return {
        "oem_total": total,
        "ysasc": avail,
        "ys_sale": ours,
        "penetration": _ratio(ours, avail) if avail is not None else None,
        "share": _ratio(ours, total),
        "addressable_pct": _ratio(avail, total) if avail is not None else None,
    }


def _dealer_months(db: Session, extra: str, params: dict) -> list:
    """Network trend: total sold, YSASC, YS Sale and our activity, by month.

    Contacts are bucketed into the month they happened in so the line can be
    read against the sales bars on one axis.
    """
    sales = db.execute(text(f"""
        SELECT m.month, SUM(m.oem_total) AS oem_total,
               SUM(m.ysasc) AS ysasc, SUM(m.ys_sale) AS ys_sale
        FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
        WHERE {_SALES_WINDOW.replace('month', 'm.month')} AND {_prod('m')} {extra}
        GROUP BY 1 ORDER BY 1
    """), params).mappings().all()
    acts = db.execute(text(f"""
        SELECT date_trunc('month', l.visit_date)::date AS month,
               COUNT(*) FILTER (WHERE l.contact_mode = 'Visit')   AS visits,
               COUNT(*) FILTER (WHERE l.contact_mode = 'Calling') AS calls
        FROM oe_visit_logs l JOIN oe_dealerships d ON d.id = l.dealer_id
        WHERE {_ACT_WINDOW.replace('dealer_id', 'l.dealer_id').replace('visit_date', 'l.visit_date')} {extra}
        GROUP BY 1 ORDER BY 1
    """), params).mappings().all()

    empty = {"oem_total": None, "ysasc": None, "ys_sale": None,
             "penetration": None, "share": None, "addressable_pct": None}

    by_month: dict = {}
    for r in sales:
        by_month[r["month"]] = {
            "month": r["month"].isoformat(), "visits": 0, "calls": 0,
            **_funnel(r["oem_total"], r["ysasc"], r["ys_sale"]),
        }
    for r in acts:
        b = by_month.setdefault(r["month"], {"month": r["month"].isoformat(),
                                             "visits": 0, "calls": 0, **empty})
        b["visits"], b["calls"] = r["visits"], r["calls"]
    return [by_month[k] for k in sorted(by_month)]


def _dealer_quarters(db: Session, extra: str, params: dict) -> list:
    """Quarter vs quarter: target, achievement, and the sales that fell inside
    each quarter's own months. Quarters are returned whole even if the period
    only clips them, for the same reason targets are not pro-rated.

    `by_product` carries the split for the OEMs that set a target per product.
    It is always present, with one entry for an OEM that sets only one, so the
    panel never needs to know which kind it is looking at.

    `sold` is the quarter's own YS Sale for the products in scope. It is what
    the UI falls back to when `achievement` is NULL, which is how a quarter
    target reports progress for an OEM that publishes no achievement column.
    """
    rows = db.execute(text(f"""
        SELECT t.quarter, t.fy_year, t.product, MIN(t.period_start) AS period_start,
               MAX(t.period_end) AS period_end,
               CAST(SUM(t.target)      AS double precision) AS target,
               CAST(SUM(t.achievement) AS double precision) AS achievement
        FROM oe_dealer_targets t JOIN oe_dealerships d ON d.id = t.dealer_id
        WHERE (CAST(:m_from AS date) IS NULL OR t.period_end   >= CAST(:m_from AS date))
          AND (CAST(:m_to   AS date) IS NULL OR t.period_start <= CAST(:m_to   AS date))
          AND {_prod('t')}
          {extra}
        GROUP BY 1, 2, 3 ORDER BY 2, 1, 3
    """), params).mappings().all()

    out: dict = {}
    for r in rows:
        tag = {1: "AMJ", 2: "JAS", 3: "OND", 4: "JFM"}[int(r["quarter"][1])]
        key = (r["fy_year"], r["quarter"])
        q = out.get(key)
        if q is None:
            sales = db.execute(text(f"""
                SELECT SUM(m.oem_total) AS oem_total,
                       SUM(m.ysasc) AS ysasc, SUM(m.ys_sale) AS ys_sale
                FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
                WHERE m.month >= :q_start AND m.month <= :q_end
                  AND {_prod('m')} {extra}
            """), {**params, "q_start": r["period_start"],
                   "q_end": r["period_end"]}).mappings().first()
            q = out[key] = {
                "quarter": r["quarter"],
                "fy_year": r["fy_year"],
                "label": f"{tag} '{str(r['period_start'].year)[2:]}",
                "period_start": r["period_start"].isoformat(),
                "period_end": r["period_end"].isoformat(),
                "target": 0,
                "achievement": None,
                "by_product": [],
                **_funnel(sales["oem_total"], sales["ysasc"], sales["ys_sale"]),
            }
        sold = db.execute(text(f"""
            SELECT SUM(m.ys_sale) AS ys_sale
            FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
            WHERE m.month >= :q_start AND m.month <= :q_end
              AND m.product = :q_prod {extra}
        """), {**params, "q_start": r["period_start"], "q_end": r["period_end"],
               "q_prod": r["product"]}).scalar()
        q["by_product"].append({
            "product": r["product"], "target": r["target"],
            "achievement": r["achievement"], "sold": sold,
        })
        q["target"] += r["target"] or 0
        if r["achievement"] is not None:
            q["achievement"] = (q["achievement"] or 0) + r["achievement"]
    for q in out.values():
        q["sold"] = sum(b["sold"] or 0 for b in q["by_product"])
    return [out[k] for k in sorted(out)]


def _contact_effect(db: Session, extra: str, params: dict) -> dict:
    """Does contacting a dealer more actually shift what we sell there?

    Compared WITHIN A MONTH — contacts made in a month against that same
    month's penetration. Totalling contacts over one window and sales over
    another would let contacts made in August "explain" sales from January,
    which is backwards.

    This is an association, not proof: reps go where they already do well.
    `months` is returned so the caller can say how thin the evidence is —
    dealer sales and visit logs currently overlap in very few months.
    """
    rows = db.execute(text(f"""
        WITH dm AS (
            SELECT m.dealer_id, m.month, m.oem_total, m.ysasc, m.ys_sale,
                   COALESCE(c.n, 0) AS contacts
            FROM oe_dealer_monthly m
            JOIN oe_dealerships d ON d.id = m.dealer_id
            LEFT JOIN (
                SELECT dealer_id, date_trunc('month', visit_date)::date AS mth, COUNT(*) AS n
                FROM oe_visit_logs WHERE dealer_id IS NOT NULL GROUP BY 1, 2
            ) c ON c.dealer_id = m.dealer_id AND c.mth = m.month
            WHERE {_SALES_WINDOW.replace('month', 'm.month')} AND {_prod('m')}
              AND m.month IN (SELECT DISTINCT date_trunc('month', visit_date)::date
                              FROM oe_visit_logs WHERE dealer_id IS NOT NULL)
              {extra}
        )
        SELECT CASE WHEN contacts = 0 THEN '0'
                    WHEN contacts = 1 THEN '1'
                    WHEN contacts = 2 THEN '2'
                    WHEN contacts <= 4 THEN '3-4'
                    ELSE '5+' END AS bucket,
               COUNT(*) AS dealer_months,
               SUM(oem_total) AS oem_total, SUM(ysasc) AS ysasc,
               SUM(ys_sale) AS ys_sale
        FROM dm GROUP BY 1
    """), params).mappings().all()

    order = ["0", "1", "2", "3-4", "5+"]
    buckets = {r["bucket"]: r for r in rows}
    months = db.execute(text(f"""
        SELECT COUNT(DISTINCT m.month) FROM oe_dealer_monthly m
        JOIN oe_dealerships d ON d.id = m.dealer_id
        WHERE {_SALES_WINDOW.replace('month', 'm.month')} AND {_prod('m')}
          AND m.month IN (SELECT DISTINCT date_trunc('month', visit_date)::date
                          FROM oe_visit_logs WHERE dealer_id IS NOT NULL)
          {extra}
    """), params).scalar()

    return {
        "months": months or 0,
        "buckets": [{
            "bucket": b,
            "dealer_months": buckets[b]["dealer_months"],
            **_funnel(buckets[b]["oem_total"], buckets[b]["ysasc"], buckets[b]["ys_sale"]),
        } for b in order if b in buckets],
    }


@router.get("/dealer-performance/{dealer_id}")
def dealer_detail(
    dealer_id: str,
    product: Optional[str] = Query(None, description="SC | MAT | ACC; all products if absent"),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    from_ym: Optional[str] = Query(None),
    to_ym: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One dealership, whole: who they are, their month-by-month trend with our
    contacts on the same timeline, their quarter targets, and every contact we
    have logged with the remarks the rep wrote.

    Returns BOTH scopes, because the drawer needs both and conflating them is a
    trap either way:

      • `totals`   — the same period the tab is filtered to, so the headline
                     figures reconcile with the table row that was clicked.
                     Opening a dealer from an August table and reading lifetime
                     totals made the drawer look like it disagreed with the row.
      • `lifetime` — every month on record, shown as context underneath.

    `by_month`, `targets` and `history` stay unfiltered on purpose: a trend
    chart clipped to one month is not a trend, and the contact log is a dated
    list where the reader can see the dates for themselves.
    """
    scope, _ = _scope(db, current_user)
    m_from, m_to, d_from, d_to = _period_bounds(year, month, from_ym, to_ym,
                                                from_date, to_date)
    d_where = ["id = :id"]
    d_params: dict = {"id": dealer_id}
    scope.apply(d_where, d_params, "salesperson", "oe_dealerships")
    d = db.execute(text(f"""
        SELECT id, oem, name, city, state, salesperson, dealer_code, dealer_codes, source
        FROM oe_dealerships WHERE {" AND ".join(d_where)}
    """), d_params).mappings().first()
    if not d:
        raise HTTPException(status_code=404, detail="Dealer not found")

    prod = {"id": dealer_id, "f_prod": product or None}
    # Summed across the products in scope. A month with figures for seat covers
    # and mats is one month on the chart, not two.
    sales = db.execute(text(f"""
        SELECT month, SUM(oem_total) AS oem_total, SUM(ysasc) AS ysasc,
               SUM(ys_sale) AS ys_sale
        FROM oe_dealer_monthly m
        WHERE dealer_id = :id AND {_prod('m')}
        GROUP BY 1 ORDER BY 1
    """), prod).mappings().all()
    # The split itself, for the drawer's per-product lines.
    by_product = [{
        "product": r["product"], "ys_sale": r["ys_sale"],
        "oem_total": r["oem_total"], "ysasc": r["ysasc"],
    } for r in db.execute(text("""
        SELECT product, SUM(ys_sale) AS ys_sale, SUM(oem_total) AS oem_total,
               SUM(ysasc) AS ysasc
        FROM oe_dealer_monthly WHERE dealer_id = :id
        GROUP BY 1 ORDER BY 1
    """), {"id": dealer_id}).mappings().all()]
    act_where = ["dealer_id = :id"]
    act_params: dict = {"id": dealer_id}
    scope.apply(act_where, act_params, "salesperson", "oe_visit_logs")
    acts = db.execute(text(f"""
        SELECT date_trunc('month', visit_date)::date AS month,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit')   AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls
        FROM oe_visit_logs WHERE {" AND ".join(act_where)} GROUP BY 1 ORDER BY 1
    """), act_params).mappings().all()

    empty = {"oem_total": None, "ysasc": None, "ys_sale": None,
             "penetration": None, "share": None, "addressable_pct": None}

    months: dict = {}
    for r in sales:
        months[r["month"]] = {
            "month": r["month"].isoformat(), "visits": 0, "calls": 0,
            **_funnel(r["oem_total"], r["ysasc"], r["ys_sale"]),
        }
    for r in acts:
        b = months.setdefault(r["month"], {"month": r["month"].isoformat(),
                                           "visits": 0, "calls": 0, **empty})
        b["visits"], b["calls"] = r["visits"], r["calls"]

    # period_start/period_end travel with each quarter so the drawer can scope
    # these to the selected period the same way the tab's Quarter panel does —
    # a quarter counts if it OVERLAPS the period, and is never pro-rated.
    # One row per quarter per product, with `sold` — what we actually sold in
    # that quarter's own months — beside the stored achievement. The OEMs that
    # publish no quarter ACH column report their progress through `sold`, and
    # it is derived at read time so the two can never disagree.
    targets = [{
        "quarter": t["quarter"], "fy_year": t["fy_year"],
        "label": f"{ {1: 'AMJ', 2: 'JAS', 3: 'OND', 4: 'JFM'}[int(t['quarter'][1])] } "
                 f"'{str(t['period_start'].year)[2:]}",
        "period_start": t["period_start"].isoformat(),
        "period_end": t["period_end"].isoformat(),
        "product": t["product"],
        "target": t["target"], "achievement": t["achievement"], "sold": t["sold"],
    } for t in db.execute(text(f"""
        SELECT t.quarter, t.fy_year, t.period_start, t.period_end, t.product,
               CAST(t.target      AS double precision) AS target,
               CAST(t.achievement AS double precision) AS achievement,
               (SELECT SUM(m.ys_sale) FROM oe_dealer_monthly m
                 WHERE m.dealer_id = t.dealer_id AND m.product = t.product
                   AND m.month >= t.period_start AND m.month <= t.period_end) AS sold
        FROM oe_dealer_targets t
        WHERE t.dealer_id = :id AND {_prod('t')}
        ORDER BY t.period_start, t.product
    """), prod).mappings().all()]

    # Contact history, newest first, with each remark category kept separate —
    # same rule as the Field Activity tab: the legacy blob and the four
    # form categories are never merged.
    log_rows = db.execute(text(f"""
        SELECT id, visit_date, salesperson, contact_mode, channel, contact_person,
               designation, car_sales, seat_cover_sales, mats_sales,
               {", ".join(_CATEGORY_COLUMNS)}
        FROM oe_visit_logs WHERE {" AND ".join(act_where)}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
    """), act_params).mappings().all()

    history = []
    for r in log_rows:
        notes = []
        for key, label, col in REMARK_CATEGORIES:
            body = (r[col] or "").strip()
            if body:
                notes.append({"category": key, "label": label, "text": body,
                              "themes": classify_remark(body)})
        history.append({
            "id": str(r["id"]),
            "visit_date": r["visit_date"].isoformat() if r["visit_date"] else None,
            "salesperson": r["salesperson"], "contact_mode": r["contact_mode"],
            "channel": r["channel"], "contact_person": r["contact_person"],
            "designation": r["designation"],
            "car_sales": r["car_sales"], "seat_cover_sales": r["seat_cover_sales"],
            "mats_sales": r["mats_sales"], "notes": notes,
        })

    last_visit = next((h for h in history if h["contact_mode"] == "Visit" and h["notes"]), None)

    def totals_for(keys, contacts) -> dict:
        """Summed from the months already loaded rather than re-queried, and
        ysasc stays None unless at least one month in scope supplied it — so a
        dealer whose history predates the three-series file reports no
        penetration instead of a made-up one."""
        rows = [months[k] for k in keys]
        avail = [m["ysasc"] for m in rows if m["ysasc"] is not None]
        totals = [m["oem_total"] for m in rows if m["oem_total"] is not None]
        return {
            **_funnel(sum(totals) if totals else None,
                      sum(avail) if avail else None,
                      sum(m["ys_sale"] or 0 for m in rows)),
            "visits": sum(h["contact_mode"] == "Visit" for h in contacts),
            "calls": sum(h["contact_mode"] == "Calling" for h in contacts),
            "months": len(rows),
        }

    in_months = [k for k in months
                 if (m_from is None or k >= m_from) and (m_to is None or k <= m_to)]
    in_contacts = [h for h in history
                   if h["visit_date"] and (d_from is None or h["visit_date"] >= d_from.isoformat())
                   and (d_to is None or h["visit_date"] <= d_to.isoformat())]

    # What this dealer's OEM publishes, judged over ALL its months rather than
    # the selected window: an empty period says nothing about the source, and a
    # dealer whose one month happens to be missing must not lose the tiles its
    # OEM does fill. Same rule as the tab's `capabilities` -- see the Dealers
    # tab, which has no other way to know TATA cannot answer a penetration
    # question. Without this the drawer drew Total sold / YSASC / Penetration
    # for every TATA dealer, three permanently empty tiles reading as a load
    # failure rather than as "this OEM does not publish it".
    has_funnel = db.execute(text("""
        SELECT EXISTS (
            SELECT 1 FROM oe_dealer_monthly m JOIN oe_dealerships d2 ON d2.id = m.dealer_id
            WHERE UPPER(d2.oem) = UPPER(:oem) AND m.oem_total IS NOT NULL
        )
    """), {"oem": d["oem"]}).scalar()

    return {
        "capabilities": {"funnel": bool(has_funnel)},
        "dealer": {
            "id": str(d["id"]), "oem": d["oem"], "name": d["name"],
            "city": d["city"] or "", "state": d["state"],
            "salesperson": d["salesperson"], "codes": d["dealer_codes"],
            "dealer_code": d["dealer_code"], "source": d["source"],
        },
        # Every product on record, unfiltered — the drawer says what this dealer
        # buys from us, and a product filter on the tab must not hide the rest.
        "by_product": by_product,
        # The tab's period — reconciles with the row that was clicked.
        "totals": totals_for(sorted(in_months), in_contacts),
        # Every month on record, shown alongside as context.
        "lifetime": totals_for(sorted(months), history),
        "period": {
            "month_from": m_from.isoformat() if m_from else None,
            "month_to": m_to.isoformat() if m_to else None,
            "date_from": d_from.isoformat() if d_from else None,
            "date_to": d_to.isoformat() if d_to else None,
            # True when the tab is on "all time", in which case the two scopes
            # are the same figures and the UI shows only one.
            "all_time": m_from is None and m_to is None,
        },
        "by_month": [months[k] for k in sorted(months)],
        "targets": targets,
        "last_field_note": last_visit,
        "history": history,
    }


@router.get("/dealer-performance")
def dealer_performance(
    oem: Optional[str] = Query(None),
    salesperson: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    product: Optional[str] = Query(None, description="SC | MAT | ACC; all products if absent"),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    from_ym: Optional[str] = Query(None),
    to_ym: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Everything the Dealers tab needs, in one call.

    The per-dealer rows come back whole — a few hundred at most — so the client
    can rank, filter and plot them without a round trip per view. Top 20,
    bottom 20 and the volume-vs-penetration map are the same list read three
    ways, and they must agree with each other.
    """
    scope, salesperson = _scope(db, current_user, salesperson)
    m_from, m_to, d_from, d_to = _period_bounds(year, month, from_ym, to_ym,
                                                from_date, to_date)
    params = {"m_from": m_from, "m_to": m_to, "d_from": d_from, "d_to": d_to,
              "f_prod": product or None,
              "full_cov": list(FULL_PART_COVERAGE_OEMS)}
    where: list = []
    # Scoped on the dealer's assigned rep, straight from the OE dealer file's
    # SALES PERSON column — so a rep's patch includes the dealers they have
    # never contacted, which is exactly the gap this tab exists to show.
    scope.apply(where, params, "d.salesperson", "oe_dealerships")
    _dealer_scope(where, params, oem, salesperson, state)
    extra = (" AND " + " AND ".join(where)) if where else ""

    rows = db.execute(text(_DEALER_AGG_SQL.format(
        sales_window=_SALES_WINDOW, prod_window=_prod("m"),
        tgt_prod_window=_prod("t"), act_window=_ACT_WINDOW, extra=extra)),
        params).mappings().all()

    dealers = [{
        "id": str(r["id"]), "oem": r["oem"], "name": r["name"],
        "city": r["city"] or "", "state": r["state"],
        "salesperson": r["salesperson"], "codes": r["dealer_codes"],
        # Which dealership this outlet belongs to. Several outlets share one on
        # the OEMs whose file is keyed per dealer code, and contacts belong to
        # the dealership, so anything counting activity counts groups, not rows.
        "group_key": f"{r['oem']}|{r['group_key']}",
        **_funnel(r["oem_total"], r["ysasc"], r["ys_sale"]),
        "contacts": r["contacts"], "visits": r["visits"], "calls": r["calls"],
        "last_contact": r["last_contact"].isoformat() if r["last_contact"] else None,
        "target": r["target"], "achievement": r["achievement"], "sold": r["sold"],
        "has_sales": r["has_sales"],
    } for r in rows]

    # Sums that must not double-count a dealership listed under several codes.
    groups: dict = {}
    for d in dealers:
        g = groups.setdefault(d["group_key"],
                              {"visits": 0, "calls": 0, "contacts": 0, "sp": d["salesperson"]})
        g["visits"], g["calls"] = d["visits"], d["calls"]     # identical on every sibling
        g["contacts"] = d["contacts"]

    totals = [d["oem_total"] for d in dealers if d["oem_total"] is not None]
    tot_total = sum(totals) if totals else None
    tot_ours = sum(d["ys_sale"] for d in dealers)
    avail = [d["ysasc"] for d in dealers if d["ysasc"] is not None]
    tot_avail = sum(avail) if avail else None
    contacted = sum(1 for g in groups.values() if g["contacts"])

    # What the OEMs in scope actually publish, counted per (OEM, PRODUCT) rather
    # than per OEM. TATA publishes a total for seat covers and none for mats, so
    # "does TATA have a funnel" has no single answer — with both products in view
    # oem_total covers SC while ys_sale covers SC and MAT, and every ratio read
    # off them divides one pool by another. Per product, SC gets its funnel and
    # MAT correctly does not.
    caps = db.execute(text(f"""
        SELECT COUNT(DISTINCT d.oem) AS oems,
               COUNT(DISTINCT (d.oem, m.product)) AS series,
               COUNT(DISTINCT (d.oem, m.product))
                   FILTER (WHERE m.oem_total IS NOT NULL) AS funnel_series,
               COUNT(DISTINCT d.oem)
                   FILTER (WHERE NOT (d.oem = ANY(:full_cov))) AS partial_oems,
               ARRAY_AGG(DISTINCT m.product) AS products,
               ARRAY_AGG(DISTINCT m.product)
                   FILTER (WHERE m.oem_total IS NOT NULL) AS funnel_products
        FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
        WHERE {_SALES_WINDOW.replace('month', 'm.month')}
          AND {_prod('m')} {extra}
    """), params).mappings().first()

    # The yardstick "opportunity" is measured against, and it must NOT move when
    # the view is sliced. Scoped to the OEM (penetration is not comparable
    # across OEMs) and to the period, but deliberately ignoring salesperson and
    # state: benchmarking a rep's dealers against that same rep's own average
    # makes a weak territory look like it has the least to gain, which is
    # exactly backwards.
    bench_where: list = []
    _dealer_scope(bench_where, params, oem, None, None)
    bench_extra = (" AND " + " AND ".join(bench_where)) if bench_where else ""
    bench = db.execute(text(f"""
        SELECT SUM(m.oem_total) AS oem_total, SUM(m.ysasc) AS ysasc,
               SUM(m.ys_sale) AS ys_sale
        FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
        WHERE {_SALES_WINDOW.replace('month', 'm.month')} AND {_prod('m')} {bench_extra}
    """), params).mappings().first()
    bench_f = _funnel(bench["oem_total"], bench["ysasc"], bench["ys_sale"])

    # 0 == 0 on an empty period, deliberately: no rows tells us nothing about
    # what the OEM publishes, so the tab must not flip into its other shape.
    funnel_ok = caps["series"] == caps["funnel_series"]
    # Whether every OEM in view holds a part number for the whole range, which
    # is what makes their Available Part Number % a truthful 100 rather than a
    # suspicious one. Requires rows: an empty screen claims nothing.
    #
    # Deliberately NOT gated on funnel_ok. This is a fact about the OEMs, not
    # about whether this particular selection can draw a funnel — and the
    # funnel_scope panel below is drawn exactly when funnel_ok is false, so
    # tying the two would leave that panel explaining the wrong OEM's rules.
    full_coverage = bool(caps["oems"] and not caps["partial_oems"])

    # TATA publishes a seat-cover total and no mat total, so across both products
    # there is no single honest funnel — oem_total would cover SC while ys_sale
    # covered SC and MAT. But there IS a funnel for seat covers, and leaving it
    # off the page hides the tab's most useful number behind a filter nobody
    # knows to set: the tab looked completely unchanged after the totals arrived.
    #
    # So it is returned as its OWN block, aggregated over only the products that
    # publish a total and carrying their names, and the tab labels it with them.
    # It can never be read as covering the whole selection, and it is not mixed
    # into `kpis`, which stays the figure for everything in view.
    funnel_products = sorted(caps["funnel_products"] or [])
    funnel_scope = None
    if not funnel_ok and funnel_products:
        fs = db.execute(text(f"""
            SELECT SUM(m.oem_total) AS oem_total, SUM(m.ysasc) AS ysasc,
                   SUM(m.ys_sale) AS ys_sale
            FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
            WHERE {_SALES_WINDOW.replace('month', 'm.month')}
              AND m.product = ANY(:funnel_prods) {extra}
        """), params | {"funnel_prods": funnel_products}).mappings().first()
        funnel_scope = {
            "products": funnel_products,
            **_funnel(fs["oem_total"], fs["ysasc"], fs["ys_sale"]),
        }

    kpis = {
        # Dealerships, not rows: coverage is "did we contact this dealership",
        # and a dealership listed under two codes was contacted once.
        "dealers": len(groups),
        "outlets": len(dealers),
        "contacted": contacted,
        "coverage": round(100.0 * contacted / len(groups), 1) if groups else None,
        **_funnel(tot_total, tot_avail, tot_ours),
        # Whole-OEM figures for this period, unaffected by the other filters.
        # Opportunity is measured against `benchmark`, so it has to be the same
        # KIND of ratio as each dealer's own penetration — ys_sale ÷ ysasc.
        "benchmark": bench_f["penetration"] if funnel_ok else None,
        "benchmark_share": bench_f["share"] if funnel_ok else None,
        "visits": sum(g["visits"] for g in groups.values()),
        "calls": sum(g["calls"] for g in groups.values()),
        # Targets are per outlet, so these sum over rows — two codes of one
        # dealership carry two targets the team set separately.
        #
        # Summed UNROUNDED and rounded once at display. The sheet's target is an
        # OEM total split across dealers by share, so each dealer's share is
        # fractional; rounding per dealer first put this total 27 units under the
        # sheet's own figure for MSIL JAS'26 and 17 over it for AMJ'26.
        "target": sum(d["target"] or 0 for d in dealers),
        "achievement": (sum(d["achievement"] for d in dealers if d["achievement"] is not None)
                        if any(d["achievement"] is not None for d in dealers) else None),
        # Not `d["sold"] or 0` — see _ours. Absent quarter, not zero sales.
        "sold": sum(_ours(d) for d in dealers),
    }

    # With a funnel OEM and a non-funnel one both in scope, ys_sale counts every
    # dealer but ysasc and oem_total count only the OEMs that publish them, so
    # every ratio read off them divides one pool by another. MSIL + TATA in July
    # returned 49.96% "penetration" that way -- TATA's sales over MSIL's YSASC.
    # The tab hides those tiles when funnel is false, but a wrong number must
    # not sit in the payload waiting for the next reader to trust it.
    if not funnel_ok:
        for key in ("penetration", "share", "addressable_pct"):
            kpis[key] = None
        # The absolutes go too. They are not individually wrong — oem_total is a
        # real figure for the products that publish one — but sitting in a block
        # labelled as the whole selection they describe no single population,
        # which is exactly what the ratios were removed for. The honest,
        # product-labelled version is `funnel_scope` below.
        for key in ("oem_total", "ysasc"):
            kpis[key] = None

    # The window `sold` actually covers, which is NOT the selected period: the
    # `sold` CTE rolls up to whole quarters so the figure sits beside a target
    # agreed for the same quarter. Picking July or August inside JAS'26 gives
    # the identical number, and with nothing on screen saying so the tile reads
    # as a filter that has stopped working.
    #
    # NULL when no target quarter overlaps the period at all — `_ours` then
    # falls back to the period's own ys_sale, so the figure really is the
    # selected months and there is nothing to disclose.
    sq = db.execute(text(f"""
        SELECT MIN(t.period_start) AS m_from, MAX(t.period_end) AS m_to
        FROM oe_dealer_targets t JOIN oe_dealerships d ON d.id = t.dealer_id
        WHERE (CAST(:m_from AS date) IS NULL OR t.period_end   >= CAST(:m_from AS date))
          AND (CAST(:m_to   AS date) IS NULL OR t.period_start <= CAST(:m_to   AS date))
          AND {_prod('t')} {extra}
    """), params).mappings().first()
    sold_scope = ({"month_from": sq["m_from"].isoformat(),
                   "month_to": sq["m_to"].isoformat()}
                  if sq and sq["m_from"] else None)

    by_sp: dict = {}
    seen_groups: set = set()
    for d in dealers:
        sp = d["salesperson"] or "Unassigned"
        b = by_sp.setdefault(sp, {"salesperson": sp, "assigned": 0, "contacted": 0,
                                  "oem_total": None, "ysasc": None, "ys_sale": 0,
                                  "visits": 0, "calls": 0, "target": 0,
                                  "achievement": 0, "sold": 0})
        # Assigned dealerships and their activity are counted once per group;
        # volumes and targets are per outlet, because each code has its own.
        first_of_group = d["group_key"] not in seen_groups
        seen_groups.add(d["group_key"])
        if first_of_group:
            b["assigned"] += 1
            b["contacted"] += 1 if d["contacts"] else 0
            b["visits"] += d["visits"]
            b["calls"] += d["calls"]
        b["ys_sale"] += d["ys_sale"]
        # Both stay None until some dealer of theirs actually has one — an OEM
        # that publishes no total must not report a rep as having sold into 0.
        for k in ("oem_total", "ysasc"):
            if d[k] is not None:
                b[k] = (b[k] or 0) + d[k]
        b["target"] += d["target"] or 0
        b["achievement"] += d["achievement"] or 0
        b["sold"] += _ours(d)
    for b in by_sp.values():
        b["coverage"] = round(100.0 * b["contacted"] / b["assigned"], 1) if b["assigned"] else None
        b.update(_funnel(b["oem_total"], b["ysasc"], b["ys_sale"]))

    return {
        "period": {
            "month_from": m_from.isoformat() if m_from else None,
            "month_to": m_to.isoformat() if m_to else None,
            "date_from": d_from.isoformat() if d_from else None,
            "date_to": d_to.isoformat() if d_to else None,
        },
        # What this scope's OEMs publish. The tab renders the panels these
        # allow; see the Dealers tab, which has no other way to know that TATA
        # cannot answer a penetration question.
        "capabilities": {
            # An empty period tells us nothing about what the OEM publishes, so
            # it must not flip the tab into its other shape — with no rows the
            # answer is "as before", not "no funnel".
            "funnel": funnel_ok,
            "full_coverage": full_coverage,
            "products": sorted(caps["products"] or []),
            "oems": caps["oems"] or 0,
        },
        "kpis": kpis,
        # The whole-quarter window `kpis.sold` (and every row's `sold`) is
        # summed over, when that is wider than the period asked for.
        "sold_scope": sold_scope,
        # The funnel for the products that publish one, when not all do.
        # None when `kpis` already carries it, or when nothing publishes one.
        "funnel_scope": funnel_scope,
        "dealers": dealers,
        "by_salesperson": sorted(by_sp.values(), key=lambda b: -b["ys_sale"]),
        "by_month": _dealer_months(db, extra, params),
        "by_quarter": _dealer_quarters(db, extra, params),
        "contact_effect": _contact_effect(db, extra, params),
    }
