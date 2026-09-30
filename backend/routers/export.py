"""
AutoForm MIS — Export (UK / EU / AU lead pipeline) Router

One registered workbook, one tab read (`Leads`), one table. Registry and sync
follow the standard sheet_sources pattern; the read side is two endpoints —
/summary for the overview and /leads for the list — which take the same
filters, so a figure on one always matches the rows on the other.

NOT TIME-SCOPED, deliberately, so there is no period control. The table is the
pipeline as it stands today: each sync replaces it and nothing records what a
lead looked like last month. A month picker over it would only filter by
whichever date column it chose and imply a history the data does not have.
Ageing is measured instead from the team's own dates (Stage Since, Last
Contact), relative to today.

The data is a few dozen rows, so /summary loads the filtered rows and computes
in Python (services/export_leads_sync.build_summary) rather than in SQL. That
keeps the rules — what counts as open, absent vs zero potential — in one pure
function with tests, instead of spread across a dozen aggregate queries.

Who can do what:
  • read and press Sync — anyone holding the 'export' module. Sync pulls the
    one sheet the module owns; there is nothing to choose.
  • register or remove the sheet — superadmin / management only, because
    removing it wipes the pipeline.
There is no row-level scope yet: the lead owners are not MIS users today.
"""
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
from services.export_leads_sync import (
    REGION_LABELS, REGIONS, STAGES, STATUSES, build_summary, enrich, parse_leads,
)
from services.google_sheets import extract_sheet_id
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

_LEAD_COLS = ("id", "sheet_source_id", "sheet_row", "company", "owner", "customer_type",
              "country", "region", "city", "contact_person", "contact_email", "contact_phone",
              "stage_no", "stage_since", "status", "potential_cr", "last_contact",
              "next_action", "next_action_date", "source", "remarks", "sync_log_id")
# Everything a reader sees; ids and provenance stay server-side.
_READ_COLS = [c for c in _LEAD_COLS if c not in ("id", "sheet_source_id", "sync_log_id")]


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
    db.delete(source)                         # ON DELETE CASCADE wipes the leads
    db.commit()
    return {"deleted": True, "rows_deleted": rows}


# ── Sync ──────────────────────────────────────────────────────────────────────

@router.post("/sync")
def sync(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Pull the Leads tab and replace the table with it.

    Delete-then-insert in one transaction, under a NOWAIT lock on the source
    row taken before the fetch, so two presses of Sync cannot both insert and
    double the pipeline.
    """
    _require_access(db, current_user)
    source = _source(db)
    if not source:
        raise HTTPException(status_code=400, detail="No export sheet registered yet")

    log = SyncLog(id=uuid.uuid4(), module=MODULE, source_label=source.sheet_id,
                  status="Processing", synced_by=current_user.id)
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

    try:
        records, errors = parse_leads(source.sheet_id)
    except Exception as e:
        db.rollback()
        log.status = "Failed"
        log.error_details = _db_message(e, 4000)
        db.commit()
        raise HTTPException(status_code=502,
                            detail=f"Could not sync from Google Sheets: {_db_message(e)}")

    # A tab that could not be found or read yields no rows. Replacing the
    # pipeline with nothing would look like the team closed every lead, so an
    # empty parse fails the sync and leaves the last good data in place.
    if not records:
        db.rollback()
        log.status = "Failed"
        log.error_details = "\n".join(errors) or "No lead rows found."
        db.commit()
        raise HTTPException(status_code=422, detail=log.error_details)

    try:
        deleted = db.execute(text("DELETE FROM export_leads WHERE sheet_source_id = :sid"),
                             {"sid": str(source.id)}).rowcount
        stamp = {"sheet_source_id": str(source.id), "sync_log_id": str(log.id)}
        written = _bulk_insert(db, "export_leads", _LEAD_COLS,
                               [{**r, **stamp, "id": str(uuid.uuid4())} for r in records])
        db.commit()
    except Exception as e:
        db.rollback()
        log.status = "Failed"
        log.error_details = _db_message(e, 4000)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Could not store synced rows: {_db_message(e)}")

    log.rows_total = log.rows_inserted = written
    log.rows_updated = log.rows_failed = 0
    log.rows_deleted = deleted
    log.status = "Done"
    log.error_details = "\n".join(errors) if errors else None
    db.commit()
    return {
        "sync_id": str(log.id), "rows_total": written, "rows_inserted": written,
        "rows_updated": 0, "rows_failed": 0, "rows_deleted": deleted,
        # These are the sheet's data problems, worded for the export team.
        "warnings": errors[:50], "status": "Done",
    }


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

def _load(db: Session, owner, customer_type, region, country, stage, status, source, q,
          stale_days: int) -> list:
    """Filtered, enriched leads. Shared by /summary and /leads so the two
    cannot disagree about which rows a filter selects."""
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
    today = date.today()
    out = []
    for r in rows:
        d = dict(r)
        if d["potential_cr"] is not None:
            d["potential_cr"] = float(d["potential_cr"])
        out.append(enrich(d, today, stale_days))
    return out


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


def _sync_meta(db: Session) -> dict:
    s = _source(db)
    log = _last_log(db, s) if s else None
    return {
        "registered": s is not None,
        "last_synced_at": log.synced_at.isoformat() if log and log.synced_at else None,
        "last_sync_status": log.status if log else None,
    }


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
    """Everything the Export overview draws, in one round trip."""
    _require_access(db, current_user)
    rows = _load(db, **f)
    return {
        **build_summary(rows, date.today(), f["stale_days"]),
        "region_labels": REGION_LABELS,
        "sync": _sync_meta(db),
    }


@router.get("/leads")
def leads(f: dict = Depends(_filters), db: Session = Depends(get_db),
          current_user: User = Depends(get_current_user)):
    """The filtered lead list with its derived ageing fields, in sheet order.
    A few dozen rows, so no pagination — sorting is the client's."""
    _require_access(db, current_user)
    rows = _load(db, **f)
    for r in rows:
        for k in ("stage_since", "last_contact", "next_action_date"):
            if r[k] is not None:
                r[k] = r[k].isoformat()
    return {"leads": rows, "stale_days": f["stale_days"], "sync": _sync_meta(db)}
