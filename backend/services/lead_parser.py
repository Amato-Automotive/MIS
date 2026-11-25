"""
AutoForm MIS — Lead Data Parser
Handles Excel/CSV ingestion with normalization, ASM extraction, and reason classification.
"""
import re
import io
from datetime import date, datetime
import pandas as pd
from typing import Tuple

# ── State Normalization Map ─────────────────────────────────────────────────
# Maps any variant (lowercase, stripped) → canonical Indian state name
STATE_MAP = {
    # Andhra Pradesh
    "ap": "Andhra Pradesh", "andhra": "Andhra Pradesh",
    "andhra pradesh": "Andhra Pradesh", "andhrapradesh": "Andhra Pradesh",
    "andhra pradesh ": "Andhra Pradesh", "tirupati": "Andhra Pradesh",
    # Assam
    "assam": "Assam", "guwahati": "Assam",
    # Bihar
    "bihar": "Bihar",
    # Chandigarh
    "chandigarh": "Chandigarh",
    # Chhattisgarh
    "cg": "Chhattisgarh", "chhattisgarh": "Chhattisgarh",
    # Delhi
    "delhi": "Delhi",
    # Gujarat
    "gujarat": "Gujarat", "ahmedabad": "Gujarat",
    # Haryana
    "haryana": "Haryana", "harwana": "Haryana",
    "ghaziabad": "Uttar Pradesh",  # ghaziabad is UP, not haryana
    # Himachal Pradesh
    "hp": "Himachal Pradesh", "himachal": "Himachal Pradesh",
    "himachal pradesh": "Himachal Pradesh",
    # Jammu & Kashmir
    "j&k": "Jammu & Kashmir", "jk": "Jammu & Kashmir",
    "jammu": "Jammu & Kashmir", "kashmir": "Jammu & Kashmir",
    # Jharkhand
    "jharkhand": "Jharkhand", "jamshedpur": "Jharkhand",
    "dhanbad": "Jharkhand",
    # Karnataka
    "karnataka": "Karnataka",
    # Kerala
    "kerala": "Kerala",
    # Madhya Pradesh
    "mp": "Madhya Pradesh", "madhya pradesh": "Madhya Pradesh",
    # Maharashtra
    "maharashtra": "Maharashtra", "maharshtra": "Maharashtra",
    "mumbai": "Maharashtra", "pune": "Maharashtra", "thane": "Maharashtra",
    "nagpur": "Maharashtra",
    # Nagaland
    "nagaland": "Nagaland",
    # Odisha
    "odisha": "Odisha", "bhubaneswar": "Odisha",
    # Punjab
    "punjab": "Punjab", "punajab": "Punjab", "punajb": "Punjab",
    # Rajasthan
    "rajasthan": "Rajasthan", "jaipur": "Rajasthan",
    # Sikkim
    "sikkim": "Sikkim", "sikkam": "Sikkim",
    # Tamil Nadu
    "tamil nadu": "Tamil Nadu", "tamilnadu": "Tamil Nadu",
    "taminnadu": "Tamil Nadu", "chennai": "Tamil Nadu",
    # Telangana
    "telangana": "Telangana", "telagana": "Telangana",
    "telegana": "Telangana", "telalgana": "Telangana",
    "hyderabad": "Telangana",
    # Tripura
    "tripura": "Tripura",
    # Uttar Pradesh
    "uttar pradesh": "Uttar Pradesh", "up": "Uttar Pradesh",
    "uttar pardesh": "Uttar Pradesh",
    # Uttarakhand
    "uttarakhand": "Uttarakhand", "uttrakhand": "Uttarakhand",
    "uttarakhnad": "Uttarakhand",
    # West Bengal
    "west bengal": "West Bengal",
}

# ── Source Normalization ────────────────────────────────────────────────────
SOURCE_MAP = {
    "ivr": "IVR",
    "whatsapp": "WhatsApp",
    "instagram": "Instagram",
}

# ── Status Normalization ────────────────────────────────────────────────────
CALL_STATUS_MAP = {
    "follow up": "Follow Up",
    "closed won": "Closed Won",
    "no response": "No Response",
    "complaint": "Complaint",
    "take recording": "Take Recording",
    "asking about the autocruze brand": "Inquiry",
    "asking about the product warranty": "Inquiry",
}

REVIEW_STATUS_MAP = {
    "closed won": "Closed Won",
    "closed lost": "Closed Lost",
    "follow up": "Follow Up",
    "no response": "No Response",
    "call disconnected": "Call Disconnected",
    "switch off": "Switch Off",
    "switch off ": "Switch Off",
    "complaint": "Complaint",
}

# Summary rows to skip (appear at bottom of some sheets)
SUMMARY_ROW_KEYWORDS = {
    "total calls received", "total percentage", "total",
    "grand total", "summary",
}

# ── Canonical ASM names (fuzzy dedup) ──────────────────────────────────────
# Maps variant spellings → canonical name
ASM_NAME_MAP = {
    "prosejit": "Prosenjit",
    "prosenit": "Prosenjit",
    "prosenjit": "Prosenjit",
    "atul asm number": "Atul",
    "rg store": "RG Store",
}

# ── ASM extraction pattern ──────────────────────────────────────────────────
_ASM_RE = re.compile(
    r'shared\s+with\s+(.+?)\s+(?:asm|sir)\s*$',
    re.IGNORECASE
)

# ── Reason category patterns ────────────────────────────────────────────────
_REASON_PATTERNS = [
    (re.compile(r'shared\s+with\s+.+?\s+(?:asm|sir)', re.IGNORECASE), "Assigned to ASM"),
    (re.compile(r'shared\s+(images?|image)', re.IGNORECASE),           "Images Shared"),
    (re.compile(r'shared\s+.*(store|address)', re.IGNORECASE),         "Store Shared"),
    (re.compile(r'(bought|buy|purchase|said.*bought)', re.IGNORECASE), "Already Bought"),
    (re.compile(r'asking|enquir|inquir', re.IGNORECASE),               "Inquiry"),
]


# ── Helper functions ────────────────────────────────────────────────────────

def _clean_str(raw) -> str | None:
    """Convert to string, stripping whitespace. Returns None for NaN / 'nan' / empty."""
    if raw is None:
        return None
    try:
        if pd.isna(raw):
            return None
    except (TypeError, ValueError):
        pass
    s = str(raw).strip()
    return None if (s == "" or s.lower() == "nan") else s


def _normalize_state(raw) -> str | None:
    s = _clean_str(raw)
    if not s:
        return None
    return STATE_MAP.get(s.lower(), s)


def _normalize_source(raw) -> str:
    s = _clean_str(raw)
    if not s:
        return "Other"
    return SOURCE_MAP.get(s.lower(), s)


def _normalize_call_status(raw) -> str | None:
    s = _clean_str(raw)
    if not s:
        return None
    return CALL_STATUS_MAP.get(s.lower(), s.title())


def _normalize_review_status(raw) -> str | None:
    s = _clean_str(raw)
    if not s:
        return None
    return REVIEW_STATUS_MAP.get(s.lower(), s.title())


def _extract_asm(reason: str | None) -> str | None:
    """Extract ASM name from reason text. Returns canonical name or None."""
    if not reason:
        return None
    m = _ASM_RE.search(reason)
    if not m:
        return None
    raw_name = m.group(1).strip()
    return ASM_NAME_MAP.get(raw_name.lower(), raw_name)


def _classify_reason(reason: str | None) -> str:
    """Classify reason text into a category."""
    if not reason:
        return "Other"
    for pattern, category in _REASON_PATTERNS:
        if pattern.search(reason):
            return category
    return "Other"


def _is_summary_row(row: pd.Series) -> bool:
    """Detect and skip summary/total rows injected at sheet bottom."""
    for col in ["Review Status", "Status", "Chanel"]:
        val = _clean_str(row.get(col))
        if val and val.lower() in SUMMARY_ROW_KEYWORDS:
            return True
    return False


def _parse_mobile(raw) -> str | None:
    """Normalise a mobile number so the same customer always gets the same key.

    Excel hands back floats (9876543210.0); people type "+91 98765 43210" or
    "098765-43210". Indian mobiles are reduced to their 10 digits; anything that
    doesn't look like one keeps its digits (or raw text if it has none).
    """
    if raw is None:
        return None
    try:
        if pd.isna(raw):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(raw, float) and raw.is_integer():
        raw = int(raw)
    s = str(raw).strip()
    if s == "" or s.lower() == "nan":
        return None
    digits = re.sub(r"\D", "", s)
    if not digits:
        return s[:20]
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits[:20]


# Text dates: "2026-01-07", "01/07/2026", "2026-01-07 00:00:00" ...
_YEAR_FIRST_RE = re.compile(r"^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)")
_YEAR_LAST_RE  = re.compile(r"^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)")


def infer_date_order(values) -> dict:
    """Decide, for the whole Date column, which of the two middle numbers is the day.

    A single "2026-01-07" can't say whether it is 7 Jan or 1 Jul, but the
    column can: the AFAC sheets write year-DAY-month ("2026-13-07" = 13 Jul
    appears alongside it), so any value whose month slot is >12 settles it.
    With no deciding value, fall back to day-first — the Indian convention
    and what these sheets have always used.
    """
    yf = {"day_first": False, "month_first": False}
    yl = {"day_first": False, "month_first": False}
    for v in values:
        if v is None or isinstance(v, (pd.Timestamp, datetime, date, int, float)):
            continue
        s = str(v)
        m = _YEAR_FIRST_RE.match(s)
        if m:
            a, b = int(m.group(2)), int(m.group(3))
            if a > 12: yf["day_first"] = True
            if b > 12: yf["month_first"] = True
            continue
        m = _YEAR_LAST_RE.match(s)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a > 12: yl["day_first"] = True
            if b > 12: yl["month_first"] = True
    return {
        "year_first_day_first": not (yf["month_first"] and not yf["day_first"]),
        "year_last_day_first":  not (yl["month_first"] and not yl["day_first"]),
    }


def _parse_date(raw, order: dict | None = None) -> str | None:
    """Return an ISO date string from an Excel date cell, serial number or text.

    `order` comes from infer_date_order over the whole column; without it text
    dates are read day-first.
    """
    order = order or {"year_first_day_first": True, "year_last_day_first": True}
    if raw is None:
        return None
    try:
        if pd.isna(raw):
            return None
    except (TypeError, ValueError):
        pass
    try:
        if isinstance(raw, (pd.Timestamp, datetime, date)):
            return pd.Timestamp(raw).date().isoformat()
        if isinstance(raw, (int, float)):
            # Excel serial day number (CSV exports / unformatted cells).
            if 20000 <= float(raw) <= 80000:
                return (pd.Timestamp("1899-12-30") + pd.Timedelta(days=float(raw))).date().isoformat()
            return None
        s = str(raw).strip()
        m = _YEAR_FIRST_RE.match(s)
        if m:
            y, a, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
            d, mo = (a, b) if order["year_first_day_first"] else (b, a)
            if mo > 12:  # this value contradicts the column; trust the value
                d, mo = mo, d
            return date(y, mo, d).isoformat()
        m = _YEAR_LAST_RE.match(s)
        if m:
            a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            d, mo = (a, b) if order["year_last_day_first"] else (b, a)
            if mo > 12:
                d, mo = mo, d
            return date(y, mo, d).isoformat()
        return pd.to_datetime(s, dayfirst=True).date().isoformat()
    except Exception:
        return None


# ── Header detection ────────────────────────────────────────────────────────
# Canonical column name → accepted spellings (compared lowercased, with
# punctuation and repeated spaces removed). Sheets are typed by hand, so
# "Channel" vs "Chanel", "Mobile No." and trailing spaces all turn up.
_HEADER_ALIASES = {
    "Date":          ["date", "lead date", "call date"],
    "Chanel":        ["chanel", "channel", "source", "lead source"],
    "Customer Name": ["customer name", "name", "customer"],
    "Mobile Number": ["mobile number", "mobile no", "mobile", "phone", "phone number",
                      "contact number", "contact no", "mob no", "number"],
    "Car Type":      ["car type", "car", "car model", "vehicle"],
    "Product Type":  ["product type", "product"],
    "Location":      ["location", "city"],
    "State":         ["state"],
    "Status":        ["status", "call status"],
    "Reason":        ["reason", "remarks", "remark"],
    "Review Status": ["review status"],
    "Review Reason": ["review reason", "review remarks", "review remark"],
}
_ALIAS_LOOKUP = {alias: canon for canon, aliases in _HEADER_ALIASES.items() for alias in aliases}
REQUIRED_COLS = {"Date", "Chanel", "Mobile Number"}


def _norm_header(h) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", str(h).lower())).strip()


def _canonicalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    rename = {}
    seen = set()
    for col in df.columns:
        canon = _ALIAS_LOOKUP.get(_norm_header(col))
        if canon and canon not in seen:
            rename[col] = canon
            seen.add(canon)
    return df.rename(columns=rename)


def _read_frame(file_bytes: bytes, is_csv: bool, sheet=None) -> pd.DataFrame:
    """Read one table, finding the header row even if title rows sit above it."""
    def read(header):
        if is_csv:
            return pd.read_csv(io.BytesIO(file_bytes), header=header)
        return pd.read_excel(io.BytesIO(file_bytes), sheet_name=sheet, header=header)

    df = _canonicalise_columns(read(0))
    if REQUIRED_COLS <= set(df.columns):
        return df
    raw = read(None)
    for i in range(min(15, len(raw))):
        names = {_ALIAS_LOOKUP.get(_norm_header(v)) for v in raw.iloc[i].tolist() if pd.notna(v)}
        if REQUIRED_COLS <= names:
            return _canonicalise_columns(read(i))
    return df


def _unflip_excel_dates(records: list[dict], from_date_cell: list[bool]) -> int:
    """Undo Excel's month/day swap on date cells, judged against the file's typed dates.

    When "01-07-2026" (1 Jul) is typed into Excel set to a month-first locale,
    Excel converts it into a real date, 7 Jan; "31-07-2026" can't convert and
    stays text. So a sheet ends up with text dates all in July plus date cells
    scattered over Jan-Dec on the 7th. A date cell is swapped back only when
    its own month is one no typed date uses AND the swapped date's month is
    one they do. Files with no typed dates, or whose date cells already sit in
    the typed months, are left exactly as they are.
    """
    text_months = {r["lead_date"][:7] for r, cell in zip(records, from_date_cell) if not cell}
    if not text_months:
        return 0
    fixed = 0
    for r, cell in zip(records, from_date_cell):
        if not cell:
            continue
        d = date.fromisoformat(r["lead_date"])
        if d.day > 12 or d.strftime("%Y-%m") in text_months:
            continue
        swapped = date(d.year, d.day, d.month)
        if swapped.strftime("%Y-%m") in text_months:
            r["lead_date"] = swapped.isoformat()
            fixed += 1
    return fixed


# ── Main parser ─────────────────────────────────────────────────────────────

def parse_leads_file(file_bytes: bytes, filename: str) -> Tuple[list[dict], list[str]]:
    """
    Parse a leads Excel/CSV file.

    Returns:
        (records, errors)
        records — list of clean dicts ready for DB insert
        errors  — list of human-readable row-level error messages
    """
    errors = []
    records = []

    is_csv = filename.lower().endswith(".csv")
    try:
        if is_csv:
            df_raw = _read_frame(file_bytes, True)
        else:
            xl = pd.ExcelFile(io.BytesIO(file_bytes))
            # If a primary "Sheet1" tab exists, use only that — secondary tabs
            # (e.g. "Store", "Store Leads") are often informal scratch sheets
            # with unreliable Date columns and shouldn't be combined in.
            primary = next((s for s in xl.sheet_names if s.strip().lower() == "sheet1"), None)
            sheets_to_read = [primary] if primary else xl.sheet_names

            frames = []
            for sheet in sheets_to_read:
                try:
                    frame = _read_frame(file_bytes, False, sheet)
                except Exception as e:
                    errors.append(f"Sheet '{sheet}' could not be read: {e}")
                    continue
                if REQUIRED_COLS <= set(frame.columns):
                    frames.append(frame)
                elif len(sheets_to_read) > 1:
                    errors.append(f"INFO: tab '{sheet}' skipped — no Date / Chanel / Mobile Number header found")
            if not frames:
                df_raw = _read_frame(file_bytes, False, sheets_to_read[0]) if sheets_to_read else pd.DataFrame()
            else:
                df_raw = pd.concat(frames, ignore_index=True)
    except Exception as e:
        return [], [f"Could not open file: {e}"]

    # Validate required columns exist
    missing = REQUIRED_COLS - set(df_raw.columns)
    if missing:
        return [], [f"Missing required columns: {', '.join(sorted(missing))}. Expected: Date, Chanel (or Channel), Customer Name, Mobile Number, Car Type, Product Type, Location, State, Status, Reason, Review Status, Review Reason"]

    date_order = infer_date_order(df_raw["Date"].tolist())
    from_date_cell: list[bool] = []  # parallel to records: date came from a real Excel date cell
    skipped_summary = 0
    for idx, row in df_raw.iterrows():
        row_num = idx + 2  # 1-based + header row

        # Skip summary rows
        if _is_summary_row(row):
            skipped_summary += 1
            continue

        # Skip completely blank rows
        if row.get("Mobile Number") is None or pd.isna(row.get("Mobile Number", None)):
            if row.get("Date") is None or pd.isna(row.get("Date", None)):
                continue  # blank row

        lead_date = _parse_date(row.get("Date"), date_order)
        if not lead_date:
            errors.append(f"Row {row_num}: Invalid or missing Date")
            continue

        source = _normalize_source(row.get("Chanel"))
        reason_raw = _clean_str(row.get("Reason"))

        record = {
            "lead_date":       lead_date,
            "source":          source,
            "customer_name":   _clean_str(row.get("Customer Name")),
            "mobile_number":   _parse_mobile(row.get("Mobile Number")),
            "car_type":        _clean_str(row.get("Car Type")),
            "product_type":    _clean_str(row.get("Product Type")),
            "location":        _clean_str(row.get("Location")),
            "state":           _normalize_state(row.get("State")),
            "call_status":     _normalize_call_status(row.get("Status")),
            "reason":          reason_raw,
            "reason_category": _classify_reason(reason_raw),
            "assigned_asm":    _extract_asm(reason_raw),
            "review_status":   _normalize_review_status(row.get("Review Status")),
            "review_reason":   _clean_str(row.get("Review Reason")),
        }
        records.append(record)
        from_date_cell.append(isinstance(row.get("Date"), (pd.Timestamp, datetime, date)))

    flipped = _unflip_excel_dates(records, from_date_cell)
    if flipped:
        errors.append(f"INFO: {flipped} dates that Excel had stored month/day-swapped were corrected")

    if skipped_summary:
        errors.append(f"INFO: {skipped_summary} summary/total rows were automatically skipped")

    return records, errors
