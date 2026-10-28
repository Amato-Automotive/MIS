"""
AutoForm MIS — Finance v2 Sync (whole-sheet, 14-section template)

The finance team replaced the old Tally-style export with a new hand-built
template. Layout of every tab:

    row 1:  [ ] | COMPANY'S NAME | <name>
    row 2:  S.No. | Particulars | <period1> | % | <period2> | % | ...      (header)
    row 3:  1 | Sales Accounts                                             (section)
    row 4:    | Branch Sales | 510198.30 | 0.10 | 561218.13 | 0.10 | ...   (line item)
    ...
    row 8:    | Total | 5101983 | 1 | ...                                  (section total)

Key differences from the old export (see git history / phase-8 finance_sync):
  * Column A holds the SECTION number only — line items have a blank col A.
  * Values start at col C (index 3): Amount/% column PAIRS, one pair per period.
  * Periods are plain dates (monthly sheet) or FY strings like "2023-24"
    (yearly sheet) — no "AS AT" / "... TO ..." header text to regex.
  * 14 numbered sections in one flat sheet, not a BS block + P&L block.

Cadence (monthly vs yearly) is auto-detected per period column from the header
cell's own type, so it doesn't matter whether the team keeps monthly & yearly
as two tabs in one file or two separate files — every tab is parsed the same
way and merged by period. Periods are period-count-agnostic (the monthly sheet
grows a column each month; nothing here assumes a fixed count).

Mirrors the sheet, never audits it: the sheet's own "Total" rows are captured
as their own entities and used as-is, never recomputed by summing children —
same principle locked in for every other sheet-backed module.

REGISTERED_SECTIONS gates which sections are captured. Phase A: the seven
statement-style sections feeding Balance Sheet + P&L. Phase B adds `ratios`
(single value per period, no %) and `units` (quantity per period, no %) — both
still fit the generic value/percent walk. The remaining sections (aging, cost
stages, average unit cost, alteration, stock audit) are empty shells in the
current template and/or need extra columns before they can be captured; they
stay unregistered until finance populates them.
"""
import re
import calendar
from datetime import date, datetime, timedelta
from typing import Optional, Tuple

from services.google_sheets import get_sheets_service, SHEETS_RETRIES

ITEM_COL = 1   # col A — section number (blank on line-item rows)
LABEL_COL = 2  # col B — Particulars / label

# Excel/Sheets serial dates count days from this epoch.
_EXCEL_EPOCH = date(1899, 12, 30)
_FY_RE = re.compile(r"^(\d{4})-(\d{2,4})$")

# Sections captured (slug of the col-B section title). Everything else in the
# sheet is skipped until it is registered here.
REGISTERED_SECTIONS = {
    # Phase A — Balance Sheet + P&L statements
    "sales_accounts",
    "profit_loss_a_c",
    "balance_sheet",
    "inventories",
    "working_capital",
    "production_cost",
    "employee_s_cost",
    # Phase B — ratios (Key Financial Ratios) + units (Sales/Production volumes)
    "ratios",
    "units",
    # Phase C — Working Capital Aging (§8) + Average Unit Cost (§12)
    "working_capital_aging",
    "average_unit_cost",
    # Phase D — Cash Flow Statement (§15). NOTE: this section does NOT use the
    # generic row walk below — it is parsed by _parse_cash_flow_rows (see there
    # for why the generic sub-header/total heuristics don't fit a cash flow
    # statement). Registering it here only gates it in; the dispatch is explicit.
    "cash_flow_statement",
}


# ── Cash Flow Statement (§15) — structural classifier ────────────────────────
# A cash flow statement is a standardized statement, not a free-form section, so
# it is classified by LABEL STRUCTURE rather than by the generic "row with no
# value in any period = sub-header" heuristic. Two reasons the generic walk fails
# here:
#   1. Sparse data: when only one month is populated, genuine line items that are
#      blank that month (e.g. "Less: Direct Taxes Paid") would be misread as
#      sub-headers and hijack the grouping of the rows beneath them.
#   2. Its subtotals aren't literally "Total": they read "(A) NET CASH FROM ...",
#      "Sub-total: ...", "CLOSING CASH & CASH EQUIVALENTS".
#
# Model: sub_section = the activity (operating / investing / financing), plus a
# reconciliation tail (Net increase → Opening → Closing). The (A)/(B)/(C) activity
# nets and Closing Cash are the one `total` per activity; intermediate
# "Sub-total: …" rows stay as inline line items. Mirrors the sheet, never audits:
# every figure (including the nets) is taken as-is, never recomputed.

# Structural group headers inside an activity — context only, never stored.
# Matched on the normalized label (see _cf_norm).
_CF_GROUP_HEADERS = {
    "net profit before tax", "add non cash adjustments", "changes in working capital",
    "direct taxes", "capital expenditure", "investments long term", "equity", "borrowings",
}
# The (A)/(B)/(C) activity-net rows — the per-activity totals.
_CF_NET_RE = re.compile(r"^\s*\(\s*([ABCabc])\s*\)")


def _cf_norm(label: str) -> str:
    """Normalize a label for structural matching: lowercase, punctuation → single
    spaces, trimmed. "Investments & Long-Term" → "investments long term"."""
    return re.sub(r"[^a-z0-9]+", " ", label.lower()).strip()


# The only labels allowed to open a sub-section, per section (normalized). A
# value-less row used to count as a sub-header by itself, and a real line item
# that is merely blank — or #DIV/0! — in every loaded period then re-filed every
# row below it under its own name. It bit the Balance Sheet (blank Share
# Capital), the P&L (blank Provision for Expenses), Ratios (AV ENT's all-#DIV/0!
# Debts Covering Ratio hid ROCE), Production Cost (blank "Add: Change in FG
# Stock" in YSA, AV ENT and every yearly tab) and WC Aging (blank "> 90 Days").
# So headings are listed, not guessed: these are every heading in both masters
# as of Oct 2026. A section not listed here is flat. A NEW heading finance adds
# must be added here, or its rows simply stay in the current group.
_SUBHEADERS = {
    "balance_sheet": {"sources of funds", "application of funds"},
    "working_capital": {"current assets", "current liabilities"},
    "ratios": {"liquidity ratio", "eficiency ratio", "efficiency ratio", "solvency ratio",
               "profitability ratio", "growth ratio"},
    "working_capital_aging": {"inventory", "debtors", "creditors"},
}

# ── §7 UNITS — structural grouping ───────────────────────────────────────────
# The sheet lays this section out as four blocks (Sales 4w / Sales 2w /
# Productions 4w / Productions 2w), and inside the 2w blocks it nests a further
# "Others" group holding Lifestyle and Bags. Two things break the generic walk:
#
#   1. NESTING. sub_section is a single slug, so a nested "Others" header used to
#      REPLACE its parent segment. Sales-2w-Others and Productions-2w-Others then
#      produced identical line_keys (units/others/lifestyle), and since the sync
#      upserts on (sheet_source_id, line_key, period...), the production figure
#      silently overwrote the sales one. Verified on live data: AMATO TOTAL and
#      AMATO SRN each lost 6 values this way. The segment is therefore carried in
#      the sub_section path — "sales_2w/others" vs "productions_2w/others".
#
#   2. BLANK LINE ITEMS. A company with no Mats this quarter has a value-less
#      "Mats" row, which the generic "value-less = sub-header" rule promoted to a
#      sub-header, hijacking the grouping for every row beneath it (observed on
#      AMATO RPS / PUNE / NOIDA: real figures filed under units/mats/other and
#      units/seat_cover/...). Same class of bug as the balance-sheet sub-header
#      hijack. Fix is the same shape: only STRUCTURAL labels may change grouping.
# One template row, two spellings. The monthly and yearly masters (and AMATO
# TOTAL against the other tabs) name a few rows differently — same template
# position, different label — and a line's key is its label's slug, so the
# yearly history and the monthly figures landed on two separate lines that
# never joined up. Each spelling maps to the monthly master's key and label.
# Checked by row position, Oct 2026: P&L row 12 is "Direct Income" monthly and
# "Job work Recipets"/"Job work Reciepts" yearly; row 14 "Direct Expenses" vs
# "Direct Cost"; Production Cost "Less: FG Trading Cost" (AMATO TOTAL) is every
# other tab's "Less: FG Purchase".
_KEY_ALIASES = {
    ("profit_loss_a_c", "job_work_recipets"): ("direct_income", "Direct Income"),
    ("profit_loss_a_c", "job_work_reciepts"): ("direct_income", "Direct Income"),
    ("profit_loss_a_c", "direct_cost"): ("direct_expenses", "Direct Expenses"),
    ("production_cost", "less_fg_trading_cost"): ("less_fg_purchase", "Less: FG Purchase"),
}

_UNITS_SEGMENT_RE = re.compile(r"^(sales|production|productions)(\s+(4w|2w))?$")
_UNITS_GROUPS = {"others"}


# ── Grid helpers (same idioms as every other sync service) ───────────────────

def _cell(grid, row: int, col: int):
    r, c = row - 1, col - 1
    if r < 0 or r >= len(grid):
        return None
    line = grid[r]
    if c < 0 or c >= len(line):
        return None
    v = line[c]
    return v if v not in ("", None) else None


def _to_number(v) -> Optional[float]:
    if v is None or isinstance(v, bool):
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


def _to_item_no(v) -> Optional[int]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        if s.replace(".", "", 1).isdigit():
            return int(float(s))
    return None


def _slugify(label: str) -> str:
    # Preserve comparison operators as words so aging buckets don't collide:
    # "< 90 Days" and "> 90 Days" would both strip to "90_days" otherwise, and
    # the two rows would clash on line_key in the upsert.
    s = label.strip().lower().replace("<", " lt ").replace(">", " gt ")
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s)
    return s.strip("_")


def _last_day(y: int, m: int) -> int:
    return calendar.monthrange(y, m)[1]


def _month_span(d: date) -> Tuple[date, date]:
    return date(d.year, d.month, 1), date(d.year, d.month, _last_day(d.year, d.month))


# ── Period detection (cadence auto-detected per column) ──────────────────────

def _parse_period(v) -> Optional[Tuple[str, date, date, str]]:
    """Interpret a header cell → (cadence, period_start, period_end, period_type),
    or None if the cell isn't a period. Handles FY strings ("2023-24"), real
    date objects (openpyxl path), Excel serial numbers (Sheets API UNFORMATTED
    path — gap-analysis flagged the date cells show as serials), and date
    strings, defensively."""
    if v is None or isinstance(v, bool):
        return None

    # Financial-year string, e.g. "2023-24" → Apr 2023 … Mar 2024
    if isinstance(v, str):
        m = _FY_RE.match(v.strip())
        if m:
            start_year = int(m.group(1))
            return ("yearly", date(start_year, 4, 1), date(start_year + 1, 3, 31), "annual")

    # Real date/datetime object (openpyxl) → its month
    if isinstance(v, (datetime, date)):
        d = v.date() if isinstance(v, datetime) else v
        s, e = _month_span(d)
        return ("monthly", s, e, "monthly")

    # Excel/Sheets serial number → date → its month
    n = _to_number(v)
    if n is not None and 20000 <= n <= 80000:
        d = _EXCEL_EPOCH + timedelta(days=int(n))
        s, e = _month_span(d)
        return ("monthly", s, e, "monthly")

    # Date string fallbacks
    if isinstance(v, str):
        for fmt in ("%Y-%m-%d", "%d-%b-%y", "%d-%b-%Y", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                d = datetime.strptime(v.strip(), fmt).date()
                s, e = _month_span(d)
                return ("monthly", s, e, "monthly")
            except ValueError:
                continue
    return None


def _find_header_row(grid) -> Optional[int]:
    for r in range(1, len(grid) + 1):
        v = _cell(grid, r, LABEL_COL)
        if isinstance(v, str) and v.strip().upper() == "PARTICULARS":
            return r
    return None


def _detect_periods(grid, header_row: int) -> list:
    """Scan the header row → list of (amount_col, percent_col, cadence,
    period_start, period_end, period_type). The period label sits in the
    value column; the next column holds "%" (percent_col = amount_col + 1),
    unless that next column is itself another period value column."""
    line = grid[header_row - 1] if 0 <= header_row - 1 < len(grid) else []
    value_cols = {}
    for c_idx, v in enumerate(line, start=1):
        parsed = _parse_period(v)
        if parsed:
            value_cols[c_idx] = parsed
    cols = []
    for c_idx, (cadence, p_start, p_end, p_type) in value_cols.items():
        percent_col = c_idx + 1
        if percent_col in value_cols:
            percent_col = None
        cols.append((c_idx, percent_col, cadence, p_start, p_end, p_type))
    return cols


# ── Section walk (generic across all statement-style sections) ───────────────

def parse_finance_tab(grid, tab_title: str) -> Tuple[list, list]:
    errors: list = []
    header_row = _find_header_row(grid)
    if header_row is None:
        return [], [f"{tab_title}: 'Particulars' header row not found"]

    period_cols = _detect_periods(grid, header_row)
    if not period_cols:
        return [], [f"{tab_title}: no period columns detected in header row"]

    records: list = []
    section_key: Optional[str] = None
    section_label: Optional[str] = None
    registered = False
    sub_section: Optional[str] = None
    units_segment: Optional[str] = None  # §7 only — the enclosing Sales/Productions block
    ordinal = 0

    def emit(label: str, entity_type: str):
        nonlocal ordinal
        ordinal += 1
        base = section_key
        if sub_section:
            base = f"{base}/{sub_section}"
        slug = _slugify(label)
        if (section_key, slug) in _KEY_ALIASES:
            slug, label = _KEY_ALIASES[(section_key, slug)]
        line_key = f"{base}/{slug}"
        for amount_col, percent_col, cadence, p_start, p_end, p_type in period_cols:
            amount = _to_number(_cell(grid, r, amount_col))
            if amount is None:
                continue
            percent = _to_number(_cell(grid, r, percent_col)) if percent_col else None
            records.append({
                "tab_title": tab_title, "cadence": cadence,
                "section_key": section_key, "section_label": section_label,
                "sub_section": sub_section, "entity_type": entity_type,
                "item_no": ordinal, "line_key": line_key, "line_label": label,
                "parent_key": None,
                "period_start_date": p_start, "period_end_date": p_end, "period_type": p_type,
                "amount": amount, "percent": percent, "metrics": None,
            })

    for r in range(header_row + 1, len(grid) + 1):
        a = _to_item_no(_cell(grid, r, ITEM_COL))
        b = _cell(grid, r, LABEL_COL)

        # A numbered row with a title starts a new section.
        if a is not None and isinstance(b, str) and b.strip():
            section_label = b.strip()
            section_key = _slugify(section_label)
            registered = section_key in REGISTERED_SECTIONS
            # Cash Flow opens on the first (implicit) activity — Operating; every
            # other section starts with no sub-section until a sub-header sets one.
            sub_section = "operating_activities" if section_key == "cash_flow_statement" else None
            units_segment = None
            ordinal = 0
            continue

        if not registered or section_key is None:
            continue

        label = str(b).strip() if isinstance(b, str) and b.strip() else None
        if label is None:
            continue  # blank separator / spacer row

        # §15 Cash Flow Statement — classified by label structure, not by value
        # presence (see the _CF_* block above). sub_section carries the current
        # activity; it is switched by the activity headers and by the (C) net.
        if section_key == "cash_flow_statement":
            n = _cf_norm(label)
            if "cash flow from investing activities" in n:
                sub_section = "investing_activities"   # activity header — context only
                continue
            if "cash flow from financing activities" in n:
                sub_section = "financing_activities"   # activity header — context only
                continue
            net = _CF_NET_RE.match(label)
            if net:                                    # (A)/(B)/(C) = that activity's one total
                emit(label, "total")
                if net.group(1).lower() == "c":
                    sub_section = "reconciliation"     # Net increase → Opening → Closing follow (C)
                continue
            if "closing cash cash equivalents" in n:
                emit(label, "total")                   # the reconciliation total
                continue
            if n in _CF_GROUP_HEADERS:
                continue                               # structural group header — not stored
            emit(label, "line_item")                   # incl. "Sub-total: …"; blank periods emit nothing
            continue

        # A sub-header (e.g. "Current Assets", "Sources of Funds:") carries a
        # label but nothing in any amount OR percent cell. A real line item with
        # a blank amount still has a percent cell ("Advance from Debtors | | 0"),
        # so keying off amount alone would wrongly demote it to a sub-header.
        amount_present = any(_to_number(_cell(grid, r, ac)) is not None for ac, *_ in period_cols)
        any_cell = amount_present or any(
            pc and _cell(grid, r, pc) is not None for _, pc, *_ in period_cols
        )
        label_norm = label.upper().rstrip(":").strip()

        if label_norm == "TOTAL":
            emit(label, "total")
            sub_section = None  # a total closes its sub-section
        elif not any_cell and section_key == "units":
            # §7 keeps the enclosing segment in the path so the two "Others"
            # groups stay distinct, and only structural labels may regroup —
            # see the _UNITS_* block above for the two bugs this prevents.
            n = _cf_norm(label)
            if _UNITS_SEGMENT_RE.match(n):
                # AMATO TOTAL heads its 4-wheeler block plain "Sales" where every
                # other tab says "Sales 4w", and "Production" vs "Productions"
                # varies too — one key per block, whatever the spelling.
                kind, _, wheels = n.partition(" ")
                units_segment = f"{'sales' if kind == 'sales' else 'productions'}_{wheels or '4w'}"
                sub_section = units_segment
            elif n in _UNITS_GROUPS and units_segment:
                sub_section = f"{units_segment}/{_slugify(label)}"
            # else: a real line item blank in every loaded period — keep the
            # current grouping rather than hijacking it.
            continue
        elif not any_cell:
            # Only a listed heading regroups (see _SUBHEADERS); any other
            # value-less row is a blank line item and keeps the current grouping.
            if _cf_norm(label) in _SUBHEADERS.get(section_key, ()):
                sub_section = _slugify(label)  # sub-header — context only, not stored
        else:
            emit(label, "line_item")

    return records, errors


# ── Multi-tab orchestration ──────────────────────────────────────────────────

def fetch_finance_grids(sheet_id: str) -> dict:
    """Fetches every tab in the sheet (monthly and/or yearly). UNFORMATTED_VALUE
    so numbers come through as numbers and date cells as serials (handled by
    _parse_period), rather than locale-formatted strings."""
    service = get_sheets_service()
    meta = service.spreadsheets().get(spreadsheetId=sheet_id, fields="sheets.properties.title").execute(num_retries=SHEETS_RETRIES)
    titles = [s["properties"]["title"] for s in meta.get("sheets", [])]
    if not titles:
        return {}
    ranges = [f"'{t}'!A1:AZ500" for t in titles]
    resp = service.spreadsheets().values().batchGet(
        spreadsheetId=sheet_id, ranges=ranges,
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute(num_retries=SHEETS_RETRIES)
    grids = {}
    for title, value_range in zip(titles, resp.get("valueRanges", [])):
        grids[title] = value_range.get("values", [])
    return grids


def parse_finance_workbook_grids(grids: dict) -> Tuple[list, list, set]:
    """Pure — no network. Unions every tab's records; returns the set of covered
    (line_key, period_start, period_end) triples for sync reconciliation."""
    all_records: list = []
    all_errors: list = []
    covered: set = set()

    for title, grid in grids.items():
        parsed, errors = parse_finance_tab(grid, title)
        all_errors += errors
        for rec in parsed:
            all_records.append(rec)
            covered.add((rec["line_key"], rec["period_start_date"], rec["period_end_date"]))

    return all_records, all_errors, covered


def parse_finance_workbook_by_company(grids: dict) -> Tuple[dict, list]:
    """Finance v3 — a master workbook holds ONE tab per company. Group each tab's
    parsed records by tab title (= company), returning
    {tab_title: {"records": [...], "covered": {(line_key, ps, pe), ...},
                 "cadences": {"monthly"|"yearly", ...}}}
    plus the flat error list. Tabs that fail to parse (no "Particulars" header —
    e.g. an index/README tab) yield no records and are simply omitted, so no
    company is created for them."""
    by_company: dict = {}
    all_errors: list = []
    for title, grid in grids.items():
        records, errors = parse_finance_tab(grid, title)
        all_errors += errors
        if not records:
            continue
        entry = by_company.setdefault(title, {"records": [], "covered": set(), "cadences": set()})
        for rec in records:
            entry["records"].append(rec)
            entry["covered"].add((rec["line_key"], rec["period_start_date"], rec["period_end_date"]))
            entry["cadences"].add(rec["cadence"])
    return by_company, all_errors


def fetch_and_parse_finance_by_company(sheet_id: str) -> Tuple[dict, list]:
    return parse_finance_workbook_by_company(fetch_finance_grids(sheet_id))


def fetch_and_parse_finance_workbook(sheet_id: str) -> Tuple[list, list, set]:
    grids = fetch_finance_grids(sheet_id)
    return parse_finance_workbook_grids(grids)
