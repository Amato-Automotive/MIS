"""
A month finance has added to the sheet but not filled in yet must not reach the
dashboards. The sync keeps it (a zero is a legitimate figure), so the cut is made
on read: monthly rows AFTER a company's latest published month are left out.

Observed Nov 2026, Amato SRN Unit: Sales total 178M / 183M / 0 and Balance Sheet
total 409M / 136M / 0 for Sep / Oct / Nov, while Budget and Unit Economics rows
carried the same constants into November. Every chart dropped to zero and the
period picker offered a month with nothing in it.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from routers.finance import _not_yet_published, _PUBLISHED_ANCHORS  # noqa: E402

LATEST = date(2026, 10, 31)


def test_a_month_after_the_latest_published_one_is_hidden():
    assert _not_yet_published("monthly", date(2026, 11, 30), LATEST)


def test_the_latest_published_month_and_earlier_ones_stay():
    assert not _not_yet_published("monthly", date(2026, 10, 31), LATEST)
    assert not _not_yet_published("monthly", date(2026, 4, 30), LATEST)


def test_a_company_with_no_published_month_is_never_cut():
    """A tab without the anchor lines must not vanish from every view."""
    assert not _not_yet_published("monthly", date(2026, 11, 30), None)


def test_yearly_columns_are_never_cut():
    """The yearly file carries a full-year column (31 Mar 2027) long before the
    year has run; it is a different kind of figure and has its own rules."""
    assert not _not_yet_published("annual", date(2027, 3, 31), LATEST)


def test_the_anchors_are_the_two_statements_every_company_reports():
    assert "sales_accounts/total" in _PUBLISHED_ANCHORS
    assert "balance_sheet/sources_of_funds/total" in _PUBLISHED_ANCHORS
