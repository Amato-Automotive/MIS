"""
Finance sheet parser — which rows may regroup the rows beneath them.

A value-less labelled row is read as a sub-header, and a sub-header becomes part
of every following line_key. When a real line item is merely blank in the
loaded periods, that rule re-files the rest of the section under a new key: the
detail table grows a second, empty copy of those rows and the KPIs that look up
the canonical key lose the figures. Nothing raises, so it is pinned here.

Run: backend/venv/Scripts/python.exe -m pytest backend/tests -q
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.finance_sync import parse_finance_tab  # noqa: E402


def _pl_grid(provision_amount):
    return [
        [None, "COMPANY'S NAME", "AMATO DL"],
        ["S.No.", "Particulars", "2025-26", "%"],
        [2, "Profit & Loss A/c"],
        [None, "Sales Accounts", 1000, 1],
        [None, "Provision for Expenses", provision_amount],
        [None, "PBITDA", 300, 0.3],
        [None, "PBT", 200, 0.2],
        [None, "PAT", 150, 0.15],
    ]


def _keys(records):
    return {r["line_key"] for r in records}


def test_blank_pl_row_does_not_regroup_the_rows_below():
    records, errors = parse_finance_tab(_pl_grid(None), "AMATO DL")
    assert not errors
    keys = _keys(records)
    assert {"profit_loss_a_c/pbitda", "profit_loss_a_c/pbt", "profit_loss_a_c/pat"} <= keys
    assert not any("provision_for_expenses/" in k for k in keys)
    assert all(r["sub_section"] is None for r in records)


def test_pl_keys_match_whether_or_not_the_row_is_blank():
    blank, _ = parse_finance_tab(_pl_grid(None), "AMATO DL")
    filled, _ = parse_finance_tab(_pl_grid(0), "AMATO DL")
    assert _keys(blank) | {"profit_loss_a_c/provision_for_expenses"} == _keys(filled)


def test_balance_sheet_subheaders_still_group():
    grid = [
        [None, "COMPANY'S NAME", "X"],
        ["S.No.", "Particulars", "2025-26", "%"],
        [3, "Balance Sheet"],
        [None, "Sources of Funds:"],
        [None, "Share Capital"],
        [None, "Reserves", 500, 1],
        [None, "Total", 500, 1],
    ]
    records, _ = parse_finance_tab(grid, "X")
    assert _keys(records) == {"balance_sheet/sources_of_funds/reserves", "balance_sheet/sources_of_funds/total"}


def _cash_flow_then_blocks():
    """§11 Cash Flow, then finance's unnumbered Budget / Unit Economics blocks
    (AMATO RPS / SRN, Oct 2026). Two products repeat the same metric labels."""
    return [
        [None, "COMPANY'S NAME", "AMATO SRN"],
        ["S.No.", "Particulars", "2025-26", "%"],
        [11, "Cash Flow Statement"],
        [None, "(C) NET CASH FROM / (USED IN) FINANCING ACTIVITIES", -5],
        [None, "CLOSING CASH & CASH EQUIVALENTS", 90],
        [None, "BUDGET /ACTUAL/VARIANCE"],
        [None, "Revanue/Income", 1000, 1],
        [None, "PAT", 60, 0.06],
        [None, "BUDGET SALE UNITS"],
        [None, "4w Seat Cover", 10000],
        [None, "2w Seat Cover"],
        [None, "UNIT ECONOMICS"],
        [None, "Metrics of Seat Covers"],
        [None, "Unit Sold", 5000],
        [None, "Average Product Cost", "#DIV/0! (Function DIVIDE parameter 2 cannot be zero.)"],
        [None, "Metrics of Mat"],
        [None, "Unit Sold", 2000],
    ]


def test_unnumbered_budget_and_unit_economics_blocks_get_their_own_sections():
    records, errors = parse_finance_tab(_cash_flow_then_blocks(), "AMATO SRN")
    assert not errors
    by_key = {r["line_key"]: r["amount"] for r in records}
    # Nothing from the blocks lands in Cash Flow's reconciliation any more.
    assert not any(k.startswith("cash_flow_statement/reconciliation/") and "closing_cash" not in k for k in by_key)
    assert by_key["budget/pnl/revanue_income"] == 1000
    assert by_key["budget/units/4w_seat_cover"] == 10000
    assert "budget/units/2w_seat_cover" not in by_key        # blank row: absent, not zero
    # Same label under two products stays two lines rather than overwriting.
    assert by_key["unit_economics/seat_covers/unit_sold"] == 5000
    assert by_key["unit_economics/mat/unit_sold"] == 2000
    assert "unit_economics/seat_covers/average_product_cost" not in by_key  # #DIV/0! is absent


def _grid(rows, period="2025-26"):
    return [[None, "COMPANY'S NAME", "X"], ["S.No.", "Particulars", period, "%"], *rows]


def test_all_div0_ratio_does_not_regroup_the_ratios_below():
    # AV ENT, Oct 2026: Debts Covering Ratio was #DIV/0! every month and hid ROCE.
    div0 = "#DIV/0! (Function DIVIDE parameter 2 cannot be zero.)"
    records, _ = parse_finance_tab(_grid([
        [6, "RATIOS"],
        [None, "SOLVENCY RATIO"],
        [None, "Debt/Equity Ratio", 1.2],
        [None, "Debts Covering Ratio", div0],
        [None, "Return on Capital Employed", 0.2],
        [None, "PROFITABILITY RATIO"],
        [None, "Return on Investment", 0.1],
    ]), "AV ENT")
    keys = _keys(records)
    assert "ratios/solvency_ratio/return_on_capital_employed" in keys
    assert "ratios/profitability_ratio/return_on_investment" in keys


def test_blank_production_cost_row_keeps_the_section_flat():
    records, _ = parse_finance_tab(_grid([
        [9, "PRODUCTION COST"],
        [None, "Cost of Material", 100, 0.5],
        [None, "Add: Change in FG Stock"],
        [None, "Net Production Cost", 90, 0.45],
    ]), "YSA")
    assert "production_cost/net_production_cost" in _keys(records)
    assert all(r["sub_section"] is None for r in records)


def test_yearly_spellings_join_the_monthly_lines():
    records, _ = parse_finance_tab(_grid([
        [2, "Profit & Loss A/c"],
        [None, "Job work Recipets", 10, 0.01],
        [None, "Direct Cost", 20, 0.02],
    ]), "AMATO TOTAL")
    by_key = {r["line_key"]: r["line_label"] for r in records}
    assert by_key == {"profit_loss_a_c/direct_income": "Direct Income",
                      "profit_loss_a_c/direct_expenses": "Direct Expenses"}


def test_plain_sales_block_is_the_four_wheeler_block():
    records, _ = parse_finance_tab(_grid([
        [7, "UNITS"],
        [None, "Sales"],
        [None, "Seat Cover", 100],
        [None, "Sales 2w"],
        [None, "Seat Cover", 5],
    ]), "AMATO TOTAL")
    assert _keys(records) == {"units/sales_4w/seat_cover", "units/sales_2w/seat_cover"}
