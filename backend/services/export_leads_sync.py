"""
AutoForm MIS — Export lead pipeline: sheet parser and the pipeline maths.

Source is the `Leads` tab of the export team's workbook — a format we designed
for them, one row per company, with dropdowns fed from a `Lists` tab. The
older tabs in that workbook meant things by cell colour with no consistent key;
the whole point of the new tab is that nothing is read from formatting, so
this parser reads values only.

Columns are mapped by header text, never position, with punctuation ignored
("Est. Potential (₹ Cr)" and "Est Potential Cr" are one column). A column the
parser expects but cannot find is reported rather than silently read as blank:
a renamed header would otherwise look exactly like a team that stopped
filling that column in.

The sheet's own validation already rejects most bad input, but values pasted
or written through the API bypass it — so every value is re-checked here, and
anything that fails is stored as NULL with a warning naming the row. Nothing
is guessed.

The summary half of this file is pure (rows in, dict out) so the rules that
produce plausible-looking wrong numbers — absent vs zero potential, what counts
as open, what "stale" is measured from — are unit-tested without a database.
"""
import re
from datetime import date
from statistics import median
from typing import Optional

from services.oe_network_sync import _clean, _cut, _fetch_all_grids, _to_number, parse_date_cell

TAB_NAME = "LEADS"

# Stage NUMBER is the identity; these labels are only for display. Kept here
# rather than read from the Lists tab so rewording a dropdown value cannot
# split one stage into two.
STAGES = {
    1: "Lead Generation", 2: "Lead Qualification", 3: "Customer Engagement",
    4: "Material Development", 5: "Sample Development", 6: "Sample Submission",
    7: "Commercials", 8: "Product Approval", 9: "PO & Onboarding",
    10: "Production", 11: "Dispatch",
}
STATUSES = ("Active", "On Hold", "Won", "Lost")
# Won and Lost are finished. Anything else — including a blank status — is
# still in the pipeline: a lead nobody has closed has not been closed.
CLOSED = {"Won", "Lost"}

REGIONS = ("UK", "EU", "AU")
REGION_LABELS = {"UK": "United Kingdom", "EU": "Europe", "AU": "Australia"}

# The workbook is "Exports UK, EU, AU", and the team plans by those three
# markets rather than by country. EU here means the European market, not EU
# membership: Switzerland and Norway sell through the same channel. Ireland
# is EU — it is its own market from the UK even though the team often works
# the two together.
_UK = {"UK", "UNITED KINGDOM", "GREAT BRITAIN", "ENGLAND", "SCOTLAND", "WALES", "NORTHERN IRELAND"}
_AU = {"AUSTRALIA"}
_EU = {
    "IRELAND", "GERMANY", "FRANCE", "ITALY", "SPAIN", "PORTUGAL", "NETHERLANDS", "BELGIUM",
    "LUXEMBOURG", "AUSTRIA", "SWITZERLAND", "POLAND", "CZECH REPUBLIC", "CZECHIA", "SLOVAKIA",
    "HUNGARY", "SLOVENIA", "CROATIA", "ROMANIA", "BULGARIA", "GREECE", "CYPRUS", "MALTA",
    "DENMARK", "SWEDEN", "NORWAY", "FINLAND", "ICELAND", "ESTONIA", "LATVIA", "LITHUANIA",
    "SERBIA",
}

# normalised header -> record field. Headers are compared with everything but
# letters and digits stripped, so spacing, case and "(₹ Cr)" punctuation drift
# cannot drop a column.
COLUMNS = {
    "COMPANY": "company",
    "OWNER": "owner",
    "CUSTOMERTYPE": "customer_type",
    "COUNTRY": "country",
    "CITY": "city",
    "CONTACTPERSON": "contact_person",
    "CONTACTEMAIL": "contact_email",
    "CONTACTPHONE": "contact_phone",
    "STAGE": "stage",
    "STAGESINCE": "stage_since",
    "STATUS": "status",
    "ESTPOTENTIALCR": "potential_cr",
    "LASTCONTACT": "last_contact",
    "NEXTACTION": "next_action",
    "NEXTACTIONDATE": "next_action_date",
    "SOURCE": "source",
    "REMARKS": "remarks",
}
REQUIRED = {"COMPANY", "STAGE", "STATUS"}

_STAGE_RE = re.compile(r"^\s*(?:STAGE\s*)?(\d{1,2})\b", re.IGNORECASE)
_TEXT_LIMITS = {"company": 200, "owner": 100, "customer_type": 60, "country": 60, "city": 100,
                "contact_person": 200, "contact_email": 300, "contact_phone": 100, "source": 80}


def _hkey(v) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(v).upper()) if v is not None else ""


def region_for(country: Optional[str]) -> Optional[str]:
    """'UK' | 'EU' | 'AU' for a country as the dropdown spells it, else None.

    "Europe (pan-EU)" — a lead with no single country, such as an OEM's
    European office — is EU by definition.
    """
    if not country:
        return None
    key = " ".join(country.upper().split())
    if key in _UK:
        return "UK"
    if key in _AU:
        return "AU"
    if key in _EU or key.startswith("EUROPE"):
        return "EU"
    return None


def parse_stage(v) -> Optional[int]:
    """1–11 from "3 - Customer Engagement", "STAGE 3" or a bare 3."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        n = int(v) if float(v).is_integer() else None
    else:
        m = _STAGE_RE.match(str(v))
        n = int(m.group(1)) if m else None
    return n if n in STAGES else None


def parse_status(v) -> Optional[str]:
    key = _hkey(v)
    return next((s for s in STATUSES if _hkey(s) == key), None) if key else None


def _find_header(grid: list):
    """(row_idx, {normalised header: col_idx}) for the first of the top rows
    that carries every required header, else None."""
    for r_idx, line in enumerate(grid[:5]):
        found: dict = {}
        for c_idx, v in enumerate(line or []):
            k = _hkey(v)
            if k:
                found.setdefault(k, c_idx)
        if REQUIRED <= found.keys():
            return r_idx, found
    return None


def _pick_tab(grids: dict):
    """(title, grid, header) for the leads tab, or (None, None, error).

    A tab titled "Leads" wins. Otherwise exactly one tab may carry the leads
    headers — two would mean somebody duplicated the tab, and picking either
    silently could publish last week's copy.
    """
    candidates = []
    for title, grid in grids.items():
        hdr = _find_header(grid or [])
        if hdr:
            candidates.append((title, grid, hdr))
    named = [c for c in candidates if " ".join(c[0].split()).upper() == TAB_NAME]
    if named:
        return named[0]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        return None, None, ("No tab with the leads columns (Company, Stage, Status) was found. "
                            "The pipeline is read from a tab named 'Leads'.")
    return None, None, (f"{len(candidates)} tabs carry the leads columns "
                        f"({', '.join(repr(c[0]) for c in candidates)}) and none is named 'Leads' — "
                        f"rename the live one to 'Leads'.")


def parse_leads(sheet_id: str):
    """Fetch the workbook and parse it. See parse_leads_grids."""
    return parse_leads_grids(_fetch_all_grids(sheet_id))


def parse_leads_grids(grids: dict):
    """(records, errors). One record per company.

    Split from the fetch so the value rules can be tested on a plain grid.
    """
    errors: list = []
    title, grid, header = _pick_tab(grids)
    if title is None:
        return [], [header]
    header_idx, cols = header

    missing = [h for h in COLUMNS if h not in cols and h not in REQUIRED]
    if missing:
        errors.append(
            f"'{title}' has no column for: {', '.join(missing)} (headers compared without "
            f"spaces or punctuation). Those fields are empty for every lead — check the header row.")

    records: list = []
    seen: set = set()

    def cell(line, key):
        idx = cols.get(key)
        return line[idx] if idx is not None and idx < len(line) else None

    for r_idx, line in enumerate(grid[header_idx + 1:], start=header_idx + 2):
        if not line or not any(_clean(v) for v in line):
            continue
        company = _cut(_clean(cell(line, "COMPANY")), 200)
        if not company:
            errors.append(f"Row {r_idx}: has data but no company — skipped.")
            continue
        if company.upper() in seen:
            errors.append(f"Row {r_idx}: {company!r} is already listed above — only the first row was read.")
            continue
        seen.add(company.upper())

        rec: dict = {"sheet_row": r_idx, "company": company}
        for key, field in COLUMNS.items():
            if field in ("company", "stage", "status", "potential_cr",
                         "stage_since", "last_contact", "next_action_date"):
                continue
            val = _clean(cell(line, key))
            rec[field] = _cut(val, _TEXT_LIMITS[field]) if field in _TEXT_LIMITS else val

        raw_stage = cell(line, "STAGE")
        rec["stage_no"] = parse_stage(raw_stage)
        if rec["stage_no"] is None and _clean(raw_stage):
            errors.append(f"Row {r_idx} ({company}): stage {_clean(raw_stage)!r} is not one of 1–11 — left blank.")

        raw_status = cell(line, "STATUS")
        rec["status"] = parse_status(raw_status)
        if rec["status"] is None and _clean(raw_status):
            errors.append(f"Row {r_idx} ({company}): status {_clean(raw_status)!r} is not "
                          f"{' / '.join(STATUSES)} — left blank.")

        raw_pot = cell(line, "ESTPOTENTIALCR")
        pot = _to_number(raw_pot)
        if pot is None and _clean(raw_pot):
            errors.append(f"Row {r_idx} ({company}): potential {_clean(raw_pot)!r} is not a number — left blank.")
        elif pot is not None and pot < 0:
            errors.append(f"Row {r_idx} ({company}): potential {pot} is negative — left blank.")
            pot = None
        rec["potential_cr"] = pot

        for key, field in (("STAGESINCE", "stage_since"), ("LASTCONTACT", "last_contact"),
                           ("NEXTACTIONDATE", "next_action_date")):
            raw = cell(line, key)
            d = parse_date_cell(raw)
            if d is None and _clean(raw):
                errors.append(f"Row {r_idx} ({company}): {field.replace('_', ' ')} {_clean(raw)!r} "
                              f"is not a date — left blank.")
            rec[field] = d

        rec["region"] = region_for(rec["country"])
        if rec["country"] and rec["region"] is None:
            errors.append(f"Row {r_idx} ({company}): country {rec['country']!r} is not mapped to "
                          f"UK / EU / AU, so it is left out of the region split — add it to "
                          f"services/export_leads_sync.py.")
        records.append(rec)

    if not records:
        errors.append(f"'{title}' has no lead rows.")
    return records, errors


# ── Pipeline maths (pure) ──────────────────────────────────────────────────────

def is_open(status: Optional[str]) -> bool:
    return status not in CLOSED


def _days(since: Optional[date], today: date) -> Optional[int]:
    return None if since is None else (today - since).days


def enrich(row: dict, today: date, stale_days: int) -> dict:
    """A lead plus the figures derived from its dates.

    Each derived flag is None, not False, when the date it needs is missing: a
    lead with no Last Contact recorded is not "recently contacted", and a lead
    with no Stage Since has not been in its stage for zero days.
    """
    open_ = is_open(row.get("status"))
    since_contact = _days(row.get("last_contact"), today)
    nad = row.get("next_action_date")
    return {
        **row,
        "stage_name": STAGES.get(row.get("stage_no")),
        "is_open": open_,
        "days_in_stage": _days(row.get("stage_since"), today),
        "days_since_contact": since_contact,
        "stale": (None if since_contact is None or not open_ else since_contact > stale_days),
        "next_action_overdue": (None if nad is None or not open_ else nad < today),
    }


def _pot_sum(rows: list) -> dict:
    """Total potential plus how many leads it covers.

    The two travel together because most leads carry no estimate: ₹31 Cr
    across 4 of 42 leads and ₹31 Cr across 42 of 42 are different statements,
    and the UI must say which one it is making.
    """
    vals = [float(r["potential_cr"]) for r in rows if r.get("potential_cr") is not None]
    return {"potential_cr": round(sum(vals), 2) if vals else None,
            "potential_count": len(vals), "leads": len(rows)}


def _group(rows: list, field: str, order: Optional[tuple] = None) -> list:
    keys = {r.get(field) for r in rows}
    if order:
        ordered = [k for k in order if k in keys] + sorted(k for k in keys if k not in order and k)
    else:
        ordered = sorted((k for k in keys if k), key=str.upper)
    if None in keys:
        ordered.append(None)                 # "Not set" last, never hidden
    out = []
    for k in ordered:
        grp = [r for r in rows if r.get(field) == k]
        opn = [r for r in grp if r["is_open"]]
        out.append({
            "key": k,
            "leads": len(grp),
            "open": len(opn),
            "won": sum(r.get("status") == "Won" for r in grp),
            "lost": sum(r.get("status") == "Lost" for r in grp),
            "pipeline": _pot_sum(opn),
        })
    return out


def build_summary(rows: list, today: date, stale_days: int, attention_limit: int = 10) -> dict:
    """Everything the Export overview draws, from already-enriched rows."""
    opn = [r for r in rows if r["is_open"]]
    won = [r for r in rows if r.get("status") == "Won"]

    funnel = []
    for n, name in STAGES.items():
        here = [r for r in opn if r.get("stage_no") == n]
        dwell = [r["days_in_stage"] for r in here if r["days_in_stage"] is not None]
        funnel.append({
            "stage": n, "name": name,
            # Open leads sitting at this stage right now.
            "open_here": len(here),
            # Every lead whose current stage is this one or later, closed ones
            # included — stages run in order, so a lead at 6 has passed 1–5.
            # A Lost lead counts up to where it was lost, which is the point.
            "reached": sum(1 for r in rows if (r.get("stage_no") or 0) >= n),
            "pipeline": _pot_sum(here),
            "median_days_in_stage": median(dwell) if dwell else None,
            "days_known": len(dwell),
        })

    def top(pred, key):
        picked = [r for r in opn if pred(r)]
        picked.sort(key=key, reverse=True)
        return [{f: r.get(f) for f in ("company", "owner", "region", "stage_no", "stage_name",
                                        "days_in_stage", "days_since_contact", "next_action",
                                        "next_action_date")}
                for r in picked[:attention_limit]], len(picked)

    overdue, n_overdue = top(lambda r: r["next_action_overdue"],
                             lambda r: (today - r["next_action_date"]).days)
    stale, n_stale = top(lambda r: r["stale"], lambda r: r["days_since_contact"])
    longest, _ = top(lambda r: r["days_in_stage"] is not None, lambda r: r["days_in_stage"])

    return {
        "as_of": today.isoformat(),
        "stale_days": stale_days,
        "kpis": {
            "leads": len(rows),
            "open": len(opn),
            "active": sum(r.get("status") == "Active" for r in rows),
            "on_hold": sum(r.get("status") == "On Hold" for r in rows),
            "won": len(won),
            "lost": sum(r.get("status") == "Lost" for r in rows),
            "no_status": sum(r.get("status") is None for r in rows),
            "pipeline": _pot_sum(opn),
            "won_potential": _pot_sum(won),
            "stale": n_stale,
            "overdue_actions": n_overdue,
        },
        "funnel": funnel,
        "no_stage_open": sum(1 for r in opn if r.get("stage_no") is None),
        "by_region": _group(rows, "region", REGIONS),
        "by_owner": _group(rows, "owner"),
        "by_customer_type": _group(rows, "customer_type"),
        "by_source": _group(rows, "source"),
        "attention": {
            "overdue_actions": overdue,
            "stale": stale,
            "longest_in_stage": longest,
        },
        # What the team has not filled in, so every figure above can say how
        # much of the list it actually covers.
        "data_quality": {
            "leads": len(rows),
            "missing_owner": sum(not r.get("owner") for r in rows),
            "missing_stage": sum(r.get("stage_no") is None for r in rows),
            "missing_stage_since": sum(r.get("stage_since") is None for r in opn),
            "missing_last_contact": sum(r.get("last_contact") is None for r in opn),
            "missing_potential": sum(r.get("potential_cr") is None for r in opn),
            "missing_region": sum(r.get("region") is None for r in rows),
            "open": len(opn),
        },
    }
