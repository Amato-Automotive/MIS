"""
AutoForm MIS — Export lead pipeline: sheet parser and the pipeline maths.

Source is the export team's workbook — a format we designed for them, with
dropdowns fed from a `Lists` tab. Two tabs are read:

  • Leads     one row per company: where it stands, who owns it, when it should close
  • Activity  one row per contact with a customer (date, company, type, by whom)

The older tabs in that workbook meant things by cell colour with no consistent
key; the whole point of the new ones is that nothing is read from formatting,
so this parser reads values only.

A lead's Last Contact is NOT typed on the Leads tab any more. It is the newest
Activity row for that company, filled in at sync — one fact, one place, and the
team logs a contact once instead of logging it and then remembering to update a
date column as well.

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

from services.export_health import health
from services.oe_network_sync import _clean, _cut, _fetch_all_grids, _to_number, parse_date_cell

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

LOST_REASONS = ("Price", "Quality", "Lead Time / Capacity", "MOQ", "No Response",
                "Chose Competitor", "Not a Fit", "Other")
ACTIVITY_TYPES = ("Email", "Call", "Video Call", "Meeting", "Visit", "Sample Sent",
                  "Quote Sent", "Trade Fair", "Other")

REGIONS = ("UK", "EU", "AU", "OTH")
REGION_LABELS = {"UK": "United Kingdom", "EU": "Europe", "AU": "Australia", "OTH": "Other"}

# The workbook is "Exports UK, EU, AU", and the team plans by those three
# markets rather than by country. EU here means the European market, not EU
# membership: Switzerland and Norway sell through the same channel. Ireland
# is EU — it is its own market from the UK even though the team often works
# the two together. Anything else (a Frankfurt contact from Algeria or China)
# is OTH: a real lead, just outside the three markets the team plans by.
_UK = {"UK", "UNITED KINGDOM", "GREAT BRITAIN", "ENGLAND", "SCOTLAND", "WALES", "NORTHERN IRELAND"}
_AU = {"AUSTRALIA"}
_EU = {
    "IRELAND", "GERMANY", "FRANCE", "ITALY", "SPAIN", "PORTUGAL", "NETHERLANDS", "BELGIUM",
    "LUXEMBOURG", "AUSTRIA", "SWITZERLAND", "POLAND", "CZECH REPUBLIC", "CZECHIA", "SLOVAKIA",
    "HUNGARY", "SLOVENIA", "CROATIA", "ROMANIA", "BULGARIA", "GREECE", "CYPRUS", "MALTA",
    "DENMARK", "SWEDEN", "NORWAY", "FINLAND", "ICELAND", "ESTONIA", "LATVIA", "LITHUANIA",
    "SERBIA", "ALBANIA",
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
    "STATUS": "status",
    "TARGETCLOSUREDATE": "target_close_date",
    "LOSTREASON": "lost_reason",
    "ESTPOTENTIALCR": "potential_cr",
    "NEXTACTION": "next_action",
    "NEXTACTIONDATE": "next_action_date",
    "SOURCE": "source",
    "REMARKS": "remarks",
}
REQUIRED = {"COMPANY", "STAGE", "STATUS"}

ACTIVITY_COLUMNS = {
    "DATE": "activity_date",
    "COMPANY": "company",
    "TYPE": "activity_type",
    "BY": "by_person",
    "NOTES": "notes",
}
ACTIVITY_REQUIRED = {"DATE", "COMPANY", "TYPE"}

# Fields the generic text loop must leave alone — each is parsed on its own.
_TYPED_FIELDS = {"company", "stage", "status", "potential_cr", "target_close_date",
                 "lost_reason", "next_action_date"}

_STAGE_RE = re.compile(r"^\s*(?:STAGE\s*)?(\d{1,2})\b", re.IGNORECASE)
_TEXT_LIMITS = {"company": 200, "owner": 100, "customer_type": 60, "country": 60, "city": 100,
                "contact_person": 200, "contact_email": 300, "contact_phone": 100, "source": 80}


def _hkey(v) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(v).upper()) if v is not None else ""


def company_key(name: str) -> str:
    """How two spellings of one company are recognised: case and spacing only.
    Anything looser would merge different companies that share a word."""
    return " ".join(name.upper().split())


def region_for(country: Optional[str]) -> Optional[str]:
    """'UK' | 'EU' | 'AU' | 'OTH' for a country as the dropdown spells it;
    None only when no country is given.

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
    return "OTH"


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


def _pick(v, vocabulary) -> Optional[str]:
    """The vocabulary entry `v` spells, ignoring case, spacing and punctuation."""
    key = _hkey(v)
    return next((s for s in vocabulary if _hkey(s) == key), None) if key else None


def parse_status(v) -> Optional[str]:
    return _pick(v, STATUSES)


def _find_header(grid: list, required: set):
    """(row_idx, {normalised header: col_idx}) for the first of the top rows
    that carries every required header, else None."""
    for r_idx, line in enumerate(grid[:5]):
        found: dict = {}
        for c_idx, v in enumerate(line or []):
            k = _hkey(v)
            if k:
                found.setdefault(k, c_idx)
        if required <= found.keys():
            return r_idx, found
    return None


def _pick_tab(grids: dict, required: set, names: set, what: str):
    """(title, grid, header) for the tab carrying `required`, or (None, None, error).

    A tab with one of the expected names wins. Otherwise exactly one tab may
    carry the headers — two would mean somebody duplicated the tab, and
    picking either silently could publish last week's copy.
    """
    candidates = []
    for title, grid in grids.items():
        hdr = _find_header(grid or [], required)
        if hdr:
            candidates.append((title, grid, hdr))
    named = [c for c in candidates if " ".join(c[0].split()).upper() in names]
    if named:
        return named[0]
    if len(candidates) == 1:
        return candidates[0]
    want = " / ".join(repr(n.title()) for n in sorted(names))
    if not candidates:
        return None, None, None
    return None, None, (f"{len(candidates)} tabs carry the {what} columns "
                        f"({', '.join(repr(c[0]) for c in candidates)}) and none is named {want} — "
                        f"rename the live one.")


def _missing_columns(title: str, cols: dict, expected: dict, required: set) -> Optional[str]:
    missing = [h for h in expected if h not in cols and h not in required]
    if not missing:
        return None
    return (f"'{title}' has no column for: {', '.join(missing)} (headers compared without "
            f"spaces or punctuation). Those fields are empty on every row — check the header row.")


def _date_field(raw, where: str, label: str, errors: list, not_after: Optional[date] = None):
    d = parse_date_cell(raw)
    if d is None and _clean(raw):
        errors.append(f"{where}: {label} {_clean(raw)!r} is not a date — left blank.")
    elif d is not None and not_after is not None and d > not_after:
        errors.append(f"{where}: {label} {d.isoformat()} is in the future — left blank.")
        d = None
    return d


def parse_leads(sheet_id: str, today: Optional[date] = None):
    """Fetch the workbook and parse both tabs. See parse_workbook_grids."""
    return parse_workbook_grids(_fetch_all_grids(sheet_id), today)


def parse_workbook_grids(grids: dict, today: Optional[date] = None):
    """(leads, activities, errors), with each lead's last_contact filled from
    its newest matched activity."""
    today = today or date.today()
    leads, errors = parse_leads_grids(grids, today)
    activities, act_errors = parse_activity_grids(grids, {company_key(r["company"]) for r in leads}, today)
    apply_last_contact(leads, activities)
    return leads, activities, errors + act_errors


def parse_leads_grids(grids: dict, today: Optional[date] = None):
    """(records, errors). One record per company.

    Split from the fetch so the value rules can be tested on a plain grid.
    """
    today = today or date.today()
    errors: list = []
    title, grid, header = _pick_tab(grids, REQUIRED, {"LEADS"}, "leads")
    if title is None:
        return [], [header or ("No tab with the leads columns (Company, Stage, Status) was found. "
                               "The pipeline is read from a tab named 'Leads'.")]
    header_idx, cols = header
    miss = _missing_columns(title, cols, COLUMNS, REQUIRED)
    if miss:
        errors.append(miss)

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
        if company_key(company) in seen:
            errors.append(f"Row {r_idx}: {company!r} is already listed above — only the first row was read.")
            continue
        seen.add(company_key(company))
        where = f"Row {r_idx} ({company})"

        rec: dict = {"sheet_row": r_idx, "company": company}
        for key, field in COLUMNS.items():
            if field in _TYPED_FIELDS:
                continue
            val = _clean(cell(line, key))
            rec[field] = _cut(val, _TEXT_LIMITS[field]) if field in _TEXT_LIMITS else val

        raw_stage = cell(line, "STAGE")
        rec["stage_no"] = parse_stage(raw_stage)
        if rec["stage_no"] is None and _clean(raw_stage):
            errors.append(f"{where}: stage {_clean(raw_stage)!r} is not one of 1–11 — left blank.")

        raw_status = cell(line, "STATUS")
        rec["status"] = parse_status(raw_status)
        if rec["status"] is None and _clean(raw_status):
            errors.append(f"{where}: status {_clean(raw_status)!r} is not "
                          f"{' / '.join(STATUSES)} — left blank.")

        raw_pot = cell(line, "ESTPOTENTIALCR")
        pot = _to_number(raw_pot)
        if pot is None and _clean(raw_pot):
            errors.append(f"{where}: potential {_clean(raw_pot)!r} is not a number — left blank.")
        elif pot is not None and pot < 0:
            errors.append(f"{where}: potential {pot} is negative — left blank.")
            pot = None
        rec["potential_cr"] = pot

        rec["next_action_date"] = _date_field(cell(line, "NEXTACTIONDATE"), where, "next action date", errors)
        # A plan, not a record: it may lie in the past (that is what "past
        # target" means) and is kept on a closed lead as the date it was aimed at.
        rec["target_close_date"] = _date_field(cell(line, "TARGETCLOSUREDATE"), where,
                                               "target closure date", errors)

        raw_reason = cell(line, "LOSTREASON")
        rec["lost_reason"] = _pick(raw_reason, LOST_REASONS)
        if rec["lost_reason"] is None and _clean(raw_reason):
            errors.append(f"{where}: lost reason {_clean(raw_reason)!r} is not on the list — left blank.")
        elif rec["lost_reason"] and rec["status"] != "Lost":
            errors.append(f"{where}: has a Lost Reason but its status is "
                          f"{rec['status'] or 'blank'}, not Lost — check which is right.")

        # Filled from the Activity tab by apply_last_contact, never typed.
        rec["last_contact"] = None

        rec["region"] = region_for(rec["country"])
        records.append(rec)

    if not records:
        errors.append(f"'{title}' has no lead rows.")
    return records, errors


def parse_activity_grids(grids: dict, lead_keys: set, today: Optional[date] = None):
    """(records, errors) for the Activity tab.

    A missing Activity tab is a warning, not a failure — the pipeline still
    syncs, it just has no contact dates. A row naming a company that is not on
    the Leads tab is kept with matched=False and reported: it cannot feed a
    lead's Last Contact, but dropping it would lose the team's own record.
    """
    today = today or date.today()
    title, grid, header = _pick_tab(grids, ACTIVITY_REQUIRED, {"ACTIVITY", "ACTIVITY LOG"}, "activity")
    if title is None:
        return [], [header or ("No 'Activity' tab (Date, Company, Type) was found, so no lead "
                               "has a Last Contact date.")]
    errors: list = []
    header_idx, cols = header
    miss = _missing_columns(title, cols, ACTIVITY_COLUMNS, ACTIVITY_REQUIRED)
    if miss:
        errors.append(miss)

    def cell(line, key):
        idx = cols.get(key)
        return line[idx] if idx is not None and idx < len(line) else None

    records: list = []
    unmatched: dict = {}
    for r_idx, line in enumerate(grid[header_idx + 1:], start=header_idx + 2):
        if not line or not any(_clean(v) for v in line):
            continue
        where = f"Activity row {r_idx}"
        company = _cut(_clean(cell(line, "COMPANY")), 200)
        if not company:
            errors.append(f"{where}: has no company — skipped.")
            continue
        raw_date = cell(line, "DATE")
        d = _date_field(raw_date, f"{where} ({company})", "date", errors, today)
        if d is None:
            if not _clean(raw_date):
                errors.append(f"{where} ({company}): has no date — skipped.")
            continue
        raw_type = cell(line, "TYPE")
        kind = _pick(raw_type, ACTIVITY_TYPES)
        if kind is None and _clean(raw_type):
            errors.append(f"{where} ({company}): type {_clean(raw_type)!r} is not on the list — left blank.")
        key = company_key(company)
        matched = key in lead_keys
        if not matched:
            unmatched.setdefault(company, []).append(r_idx)
        records.append({
            "sheet_row": r_idx, "activity_date": d, "company": company, "company_key": key,
            "matched": matched, "activity_type": kind,
            "by_person": _cut(_clean(cell(line, "BY")), 100),
            "notes": _clean(cell(line, "NOTES")),
        })
    for company, rows in unmatched.items():
        errors.append(f"Activity: {company!r} (row{'s' if len(rows) > 1 else ''} "
                      f"{', '.join(map(str, rows))}) is not on the Leads tab — kept, but it "
                      f"cannot count as that lead's Last Contact. Pick the company from the dropdown.")
    return records, errors


def apply_last_contact(leads: list, activities: list) -> None:
    """Set each lead's last_contact to its newest matched activity date."""
    newest: dict = {}
    for a in activities:
        if a["matched"] and (a["company_key"] not in newest or a["activity_date"] > newest[a["company_key"]]):
            newest[a["company_key"]] = a["activity_date"]
    for r in leads:
        r["last_contact"] = newest.get(company_key(r["company"]))


# ── Pipeline maths (pure) ──────────────────────────────────────────────────────

def is_open(status: Optional[str]) -> bool:
    return status not in CLOSED


def _days(since: Optional[date], today: date) -> Optional[int]:
    return None if since is None else (today - since).days


def stage_entry(row: dict):
    """(date, basis) the lead entered its current stage, best evidence first.

      observed  the sync saw it arrive at this stage — dated to that sync
      floor     it has been at this stage at least since tracking began; the
                real figure is longer, and the UI prints it as "≥"

    `row` carries `stage_entered_on` / `stage_entered_kind` from the history
    table (the newest arrival or baseline event for its company), if any.
    """
    kind, on = row.get("stage_entered_kind"), row.get("stage_entered_on")
    if on is not None and kind in ("stage", "added"):
        return on, "observed"
    if on is not None and kind == "baseline":
        return on, "floor"
    return None, None


def enrich(row: dict, today: date, stale_days: int) -> dict:
    """A lead plus the figures derived from its dates.

    Each derived flag is None, not False, when the date it needs is missing: a
    lead with no Last Contact recorded is not "recently contacted", and a lead
    with no stage date has not been in its stage for zero days.
    """
    open_ = is_open(row.get("status"))
    since_contact = _days(row.get("last_contact"), today)
    nad = row.get("next_action_date")
    target = row.get("target_close_date")
    entered, basis = stage_entry(row)
    out = {
        **row,
        "stage_name": STAGES.get(row.get("stage_no")),
        "is_open": open_,
        "days_in_stage": _days(entered, today),
        "days_in_stage_basis": basis,
        "days_since_contact": since_contact,
        "stale": (None if since_contact is None or not open_ else since_contact > stale_days),
        "next_action_overdue": (None if nad is None or not open_ else nad < today),
        "past_target": (None if target is None or not open_ else target < today),
    }
    out["health"] = health(out, today)
    return out


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
    lost = [r for r in rows if r.get("status") == "Lost"]
    closed = won + lost

    funnel = []
    for n, name in STAGES.items():
        here = [r for r in opn if r.get("stage_no") == n]
        # A floor is a lower bound, not a duration — putting it in a median
        # would drag the figure down and pass that off as a measurement.
        dwell = [r["days_in_stage"] for r in here
                 if r["days_in_stage"] is not None and r["days_in_stage_basis"] != "floor"]
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
                                        "days_in_stage", "days_in_stage_basis",
                                        "days_since_contact", "next_action", "next_action_date",
                                        "target_close_date")}
                for r in picked[:attention_limit]], len(picked)

    overdue, n_overdue = top(lambda r: r["next_action_overdue"],
                             lambda r: (today - r["next_action_date"]).days)
    stale, n_stale = top(lambda r: r["stale"], lambda r: r["days_since_contact"])
    past_target, n_past_target = top(lambda r: r["past_target"],
                                     lambda r: (today - r["target_close_date"]).days)
    longest, _ = top(lambda r: r["days_in_stage"] is not None, lambda r: r["days_in_stage"])

    reasons = [{"key": k, "leads": sum(1 for r in lost if r.get("lost_reason") == k)}
               for k in LOST_REASONS]
    reasons = [x for x in reasons if x["leads"]]
    no_reason = sum(1 for r in lost if not r.get("lost_reason"))
    if no_reason:
        reasons.append({"key": None, "leads": no_reason})

    return {
        "as_of": today.isoformat(),
        "stale_days": stale_days,
        "kpis": {
            "leads": len(rows),
            "open": len(opn),
            "active": sum(r.get("status") == "Active" for r in rows),
            "on_hold": sum(r.get("status") == "On Hold" for r in rows),
            "won": len(won),
            "lost": len(lost),
            "no_status": sum(r.get("status") is None for r in rows),
            "pipeline": _pot_sum(opn),
            "won_potential": _pot_sum(won),
            "stale": n_stale,
            "overdue_actions": n_overdue,
            "past_target": n_past_target,
        },
        "funnel": funnel,
        "no_stage_open": sum(1 for r in opn if r.get("stage_no") is None),
        "by_region": _group(rows, "region", REGIONS),
        "by_owner": _group(rows, "owner"),
        "by_customer_type": _group(rows, "customer_type"),
        "by_source": _group(rows, "source"),
        "lost_reasons": reasons,
        "attention": {
            "overdue_actions": overdue,
            "stale": stale,
            "past_target": past_target,
            "longest_in_stage": longest,
        },
        # What the team has not filled in, so every figure above can say how
        # much of the list it actually covers.
        "data_quality": {
            "leads": len(rows),
            "missing_owner": sum(not r.get("owner") for r in rows),
            "missing_stage": sum(r.get("stage_no") is None for r in rows),
            "missing_target_close": sum(r.get("target_close_date") is None for r in opn),
            "missing_last_contact": sum(r.get("last_contact") is None for r in opn),
            "missing_potential": sum(r.get("potential_cr") is None for r in opn),
            "missing_region": sum(r.get("region") is None for r in rows),
            "missing_lost_reason": no_reason,
            "open": len(opn),
            "closed": len(closed),
            "lost": len(lost),
        },
    }
