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
