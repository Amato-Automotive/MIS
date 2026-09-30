"""
AutoForm MIS — OE Network Sales Sync
Two parsers over the shared Google Sheets service account:

  • parse_visit_plan  — one spreadsheet per calendar month, one tab per
    salesperson. Tabs are recognized by their header signature (S NO. / Date /
    MONTH / ASM NAME / OEM / DEALER VISIT PLAN / CITY / STATE), never by tab
    title, so leftover scratch tabs are skipped and new salespeople need no
    code change. Month/year come from the sheet registration — tab titles and
    row data carry no reliable year.

  • parse_log_book    — one continuous Form-responses spreadsheet. Columns are
    mapped by header text (not position) so form edits that reorder columns
    don't break the sync. The submission Timestamp and "Column 1" (a month
    abbreviation) are the only columns not ingested — both duplicate visit_date.

Nothing business-specific is hardcoded: salespeople, OEMs, dealers, cities and
states are all read from the sheet. The only fixed mapping is the Indian-state
alias table used to fold hand-typed variants (UP / U.P. / Uttar Pradesh) into
one filter value; unknown values pass through title-cased.
"""
import re
from datetime import date, timedelta
from typing import Optional

from services.dealer_resolve import canon_city
from services.google_sheets import get_sheets_service, SHEETS_RETRIES

# Google Sheets serial-number epoch (UNFORMATTED_VALUE renders dates as serials).
_SHEETS_EPOCH = date(1899, 12, 30)

_DATE_STR_RE = re.compile(r"^\s*(\d{1,4})[./\-](\d{1,2})[./\-](\d{2,4})\s*$")

PLAN_REQUIRED_HEADERS = {"DATE", "ASM NAME", "OEM", "DEALER VISIT PLAN", "CITY", "STATE"}

LOG_REQUIRED_HEADERS = {"VISIT DATE / CALLING DATE", "DEALERSHIP NAME", "SALES PERSON'S NAME"}
# header text → record field (required + optional columns)
#
# REMARKS is the original Google Form's single free-text column. The visit-log
# form (which replaced that Google Form) instead writes one category per column
# — PRODUCT FEEDBACK / REPLACEMENT / SALES / OTHERS — and leaves REMARKS blank.
# Both layouts can appear in the same sheet (old rows vs. new-form rows); all 5
# are kept as separate fields (never merged into one string) so old-format text
# and the new categories are each shown in their own column downstream.
LOG_COLUMNS = {
    "VISIT DATE / CALLING DATE": "visit_date",
    "DEALERSHIP NAME": "dealership",
    "DEALERSHIP ADDRESS": "address",
    "CONTACT PERSON": "contact_person",
    "CONTACT NO.": "contact_number",
    "DESIGNATION": "designation",
    "TOTAL CAR SALES": "car_sales",
    "TOTAL SEAT COVERS SALES": "seat_cover_sales",
    "MATS SALES": "mats_sales",
    "REMARKS": "remarks",
    "PRODUCT FEEDBACK": "remark_product_feedback",
    "REPLACEMENT": "remark_replacement",
    "SALES": "remark_sales",
    "OTHERS": "remark_others",
    "UPLOAD PHOTO (IF YOU VISIT THE MARKET)": "photo_link",
    "EMAIL ADDRESS": "email",
    "OEM": "oem",
    "CHANNEL": "channel",
    "SALES PERSON'S NAME": "salesperson",
    "VISIT / CALLING": "contact_mode",
    "CITY": "city",
    "STATE": "state",
}

# Standard Indian state aliases — key is the value with everything but letters
# removed, uppercased. Only well-known abbreviations/misspellings; anything not
# found here passes through as typed (title-cased).
STATE_ALIASES = {
    "UP": "Uttar Pradesh", "UTTARPRADESH": "Uttar Pradesh",
    "MP": "Madhya Pradesh", "MADHYAPRADESH": "Madhya Pradesh",
    "HP": "Himachal Pradesh", "HIMACHALPRADESH": "Himachal Pradesh",
    "AP": "Andhra Pradesh", "ANDHRAPRADESH": "Andhra Pradesh",
    "WB": "West Bengal", "WESTBENGAL": "West Bengal",
    "TN": "Tamil Nadu", "TAMILNADU": "Tamil Nadu",
    "RAJ": "Rajasthan", "RAJASTHAN": "Rajasthan",
    "UK": "Uttarakhand", "UTTARAKHAND": "Uttarakhand", "UTTARANCHAL": "Uttarakhand",
    "JH": "Jharkhand", "JHARKHAND": "Jharkhand",
    "CH": "Chandigarh", "CHD": "Chandigarh", "CHANDIGARH": "Chandigarh",
    "CG": "Chhattisgarh", "CHHATTISGARH": "Chhattisgarh", "CHATTISGARH": "Chhattisgarh",
    "MH": "Maharashtra", "MAHARASHTRA": "Maharashtra", "MAHARASHTR": "Maharashtra",
    "TG": "Telangana", "TS": "Telangana", "TELANGANA": "Telangana",
    "KA": "Karnataka", "KARNATAKA": "Karnataka",
    "GJ": "Gujarat", "GUJARAT": "Gujarat",
    "HR": "Haryana", "HARYANA": "Haryana",
    "PB": "Punjab", "PUNJAB": "Punjab",
    "BR": "Bihar", "BIHAR": "Bihar",
    "OD": "Odisha", "ODISHA": "Odisha", "ORISSA": "Odisha",
    "KL": "Kerala", "KERALA": "Kerala",
    "GA": "Goa", "GOA": "Goa",
    "AS": "Assam", "ASSAM": "Assam",
    "DL": "Delhi", "DELHI": "Delhi", "NEWDELHI": "Delhi", "DELHINCR": "Delhi", "NCR": "Delhi",
    "JK": "Jammu & Kashmir", "JAMMUKASHMIR": "Jammu & Kashmir", "JAMMUANDKASHMIR": "Jammu & Kashmir",
    "LADAKH": "Ladakh",
    "SIKKIM": "Sikkim", "SIKIM": "Sikkim",
    "MEGHALAYA": "Meghalaya",
    "NAGALAND": "Nagaland",
    "MANIPUR": "Manipur",
    "MIZORAM": "Mizoram",
    "TRIPURA": "Tripura",
    "ARUNACHALPRADESH": "Arunachal Pradesh",
    "PONDICHERRY": "Puducherry", "PUDUCHERRY": "Puducherry",
}


# ── Cell helpers ──────────────────────────────────────────────────────────────

def _clean(v) -> Optional[str]:
    if v is None:
        return None
    s = " ".join(str(v).split())
    return s or None


def _upper(v) -> Optional[str]:
    s = _clean(v)
    return s.upper() if s else None


def _norm_header(v) -> str:
    return " ".join(str(v).split()).upper() if v is not None else ""


def _to_number(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def normalize_state(v) -> Optional[str]:
    s = _clean(v)
    if not s:
        return None
    key = re.sub(r"[^A-Z]", "", s.upper())
    if key in STATE_ALIASES:
        return STATE_ALIASES[key]
    return s.title()


def parse_date_cell(v) -> Optional[date]:
    """Handles Sheets serial numbers (UNFORMATTED_VALUE) and the hand-typed
    string variants seen in the real sheets (10.07.2026, 10/07/2026, ISO)."""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        try:
            d = _SHEETS_EPOCH + timedelta(days=int(v))
        except OverflowError:
            return None
        return d if date(2000, 1, 1) <= d <= date(2100, 12, 31) else None
    m = _DATE_STR_RE.match(str(v))
    if not m:
        return None
    a, b, c = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if a > 999:                       # YYYY-MM-DD
        y, mo, d = a, b, c
    else:                             # DD-MM-YYYY (Indian convention)
        d, mo, y = a, b, c
        if mo > 12 and d <= 12:       # tolerate a swapped MM-DD entry
            d, mo = mo, d
    if y < 100:
        y += 2000
    try:
        out = date(y, mo, d)
    except ValueError:
        return None
    return out if date(2000, 1, 1) <= out <= date(2100, 12, 31) else None


def _cut(s: Optional[str], limit: int) -> Optional[str]:
    return s[:limit] if s else s


def _fetch_all_grids(sheet_id: str) -> dict:
    """{tab_title: ragged grid}. UNFORMATTED_VALUE so numbers stay numbers and
    date cells arrive as serials rather than locale-formatted strings.

    Two API calls whatever the workbook's size: one for the tab titles, one
    batchGet for every tab's values. Both retry on 429/5xx — a sync that dies on
    a transient blip is a sync someone has to sit and redo.
    """
    service = get_sheets_service()
    # fields= keeps this to the titles. The default response carries every
    # sheet's full properties — grid size, tab colour, merges, conditional
    # formats — none of which is read here, and it is the larger payload on a
    # workbook with many tabs.
    meta = service.spreadsheets().get(
        spreadsheetId=sheet_id, fields="sheets.properties.title",
    ).execute(num_retries=SHEETS_RETRIES)
    titles = [s["properties"]["title"] for s in meta.get("sheets", [])]
    if not titles:
        return {}
    resp = service.spreadsheets().values().batchGet(
        spreadsheetId=sheet_id, ranges=[f"'{t}'" for t in titles],
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute(num_retries=SHEETS_RETRIES)
    return {t: vr.get("values", []) for t, vr in zip(titles, resp.get("valueRanges", []))}


def _find_header_row(grid, required: set, search_rows: int = 10):
    """First row whose cells include every required header; (row_idx, {header: col_idx}), 0-indexed."""
    for r_idx, line in enumerate(grid[:search_rows]):
        found = {}
        for c_idx, v in enumerate(line):
            h = _norm_header(v)
            if h:
                found.setdefault(h, c_idx)
        if required.issubset(found.keys()):
            return r_idx, found
    return None


# ── Visit plan (monthly, multi-tab) ───────────────────────────────────────────

def parse_visit_plan(sheet_id: str, plan_year: int, plan_month: int):
    """Returns (records, skipped_tabs, errors)."""
    grids = _fetch_all_grids(sheet_id)
    records, skipped_tabs, errors = [], [], []

    for title, grid in grids.items():
        header = _find_header_row(grid, PLAN_REQUIRED_HEADERS)
        if header is None:
            skipped_tabs.append(title)
            continue
        header_row, cols = header
        c_date, c_asm, c_oem = cols["DATE"], cols["ASM NAME"], cols["OEM"]
        c_dealer, c_city, c_state = cols["DEALER VISIT PLAN"], cols["CITY"], cols["STATE"]

        def cell(line, c):
            return line[c] if c < len(line) else None

        for r, line in enumerate(grid[header_row + 1:], start=header_row + 2):
            dealer = _clean(cell(line, c_dealer))
            if not dealer:
                continue  # filler/blank rows below the data
            raw_date = cell(line, c_date)
            visit_date = parse_date_cell(raw_date)
            if raw_date not in (None, "") and visit_date is None:
                errors.append(f"[{title}] row {r}: unreadable date {raw_date!r} — kept without a date")
            records.append({
                "salesperson": _cut(_upper(cell(line, c_asm)) or _upper(title), 100),
                "visit_date": visit_date,
                "oem": _cut(_upper(cell(line, c_oem)), 50),
                "dealer_name": _cut(dealer, 200),
                "city": _cut(canon_city(_clean(cell(line, c_city))) or None, 100),
                "state": _cut(normalize_state(cell(line, c_state)), 100),
                "plan_year": plan_year,
                "plan_month": plan_month,
            })

    if not records and not errors:
        errors.append("No salesperson tabs found — no tab has the expected header row "
                      "(Date / ASM NAME / OEM / DEALER VISIT PLAN / CITY / STATE)")
    return records, skipped_tabs, errors


# ── Log book (single continuous form-responses tab) ───────────────────────────

def parse_log_book(sheet_id: str):
    """Returns (records, skipped_tabs, errors)."""
    grids = _fetch_all_grids(sheet_id)
    records, skipped_tabs, errors = [], [], []

    target = None
    for title, grid in grids.items():
        header = _find_header_row(grid, LOG_REQUIRED_HEADERS, search_rows=3)
        if header is not None:
            target = (title, grid, header)
            break
        skipped_tabs.append(title)
    if target is None:
        errors.append("No form-responses tab found — expected headers "
                      "'Visit Date / Calling Date', 'Dealership Name', \"Sales Person's Name\"")
        return records, skipped_tabs, errors

    title, grid, (header_row, found) = target
    cols = {field: found[h] for h, field in LOG_COLUMNS.items() if h in found}

    def cell(line, field):
        c = cols.get(field)
        return line[c] if c is not None and c < len(line) else None

    for r, line in enumerate(grid[header_row + 1:], start=header_row + 2):
        if not any(v not in (None, "") for v in line):
            continue
        dealership = _clean(cell(line, "dealership"))
        if not dealership:
            errors.append(f"row {r}: no dealership name — skipped")
            continue
        visit_date = parse_date_cell(cell(line, "visit_date"))
        if visit_date is None:
            errors.append(f"row {r} ({dealership}): missing/unreadable visit date — skipped")
            continue
        contact_mode = _clean(cell(line, "contact_mode"))
        records.append({
            "visit_date": visit_date,
            "log_year": visit_date.year,
            "log_month": visit_date.month,
            "salesperson": _cut(_upper(cell(line, "salesperson")), 100),
            "contact_mode": _cut(contact_mode.title() if contact_mode else None, 30),
            "oem": _cut(_upper(cell(line, "oem")), 50),
            "dealership": _cut(dealership, 200),
            "address": _cut(_clean(cell(line, "address")), 255),
            "contact_person": _cut(_clean(cell(line, "contact_person")), 150),
            "contact_number": _cut(_clean(cell(line, "contact_number")), 30),
            "designation": _cut(_clean(cell(line, "designation")), 100),
            "car_sales": _to_number(cell(line, "car_sales")),
            "seat_cover_sales": _to_number(cell(line, "seat_cover_sales")),
            "mats_sales": _to_number(cell(line, "mats_sales")),
            "remarks": _clean(cell(line, "remarks")),
            "remark_product_feedback": _clean(cell(line, "remark_product_feedback")),
            "remark_replacement": _clean(cell(line, "remark_replacement")),
            "remark_sales": _clean(cell(line, "remark_sales")),
            "remark_others": _clean(cell(line, "remark_others")),
            "channel": _cut(_clean(cell(line, "channel")), 20),
            "email": _cut(_clean(cell(line, "email")), 150),
            "photo_link": _clean(cell(line, "photo_link")),
            # Canonical on the way in, so the sheet's mix of Bhopāl / Bhopal /
            # BHOPAL lands as one city without anyone editing the sheet.
            "city": _cut(canon_city(_clean(cell(line, "city"))) or None, 100),
            "state": _cut(normalize_state(cell(line, "state")), 100),
            "sheet_row": r,
        })

    return records, skipped_tabs, errors
