"""
The Sync cooldown.

Reps can press Sync, and the row lock only stops runs that literally overlap.
Six people pressing twenty seconds apart do not overlap, so each one used to
pull all four sheets in full — the API cost of a rush without any of the
concurrency. The cooldown closes that gap.

What it must NOT do is lock somebody out of their own data. A rep who has just
filed a visit and presses Sync needs either the pull or an honest answer about
when the last one happened, never a flat "up to date". So the window is short,
only a SUCCESSFUL pull suppresses the next one, and the admin's per-source sync
ignores the cooldown entirely.
"""
import ast
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import routers.oe_network as oe  # noqa: E402

ROUTER = os.path.join(os.path.dirname(__file__), "..", "routers", "oe_network.py")
with open(ROUTER, encoding="utf-8") as f:
    SRC = f.read()
FUNCS = {n.name: n for n in ast.walk(ast.parse(SRC)) if isinstance(n, ast.FunctionDef)}


def body(name):
    return ast.get_source_segment(SRC, FUNCS[name]) or ""


class ExplodingDB:
    """Any query at all is a failure for the cases that must short-circuit."""

    def execute(self, *_a, **_k):
        raise AssertionError("the cooldown queried the database when it should not have")


# ── Disabling it ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("window", [0, -1])
def test_zero_or_negative_window_disables_the_cooldown(window, monkeypatch):
    """An escape hatch that costs nothing: setting the env var to 0 turns the
    feature off without a deploy, and does so before any query runs."""
    monkeypatch.setattr(oe, "SYNC_COOLDOWN_SECONDS", window)
    assert oe._synced_within_cooldown(ExplodingDB(), object()) is None


def test_default_window_is_short():
    """Long enough to collapse a rush, short enough that a rep who just filed a
    visit is not shut out of it for long."""
    assert 0 < oe.SYNC_COOLDOWN_SECONDS <= 300


def test_window_is_configurable_without_a_deploy():
    assert "OE_SYNC_COOLDOWN_SECONDS" in SRC


# ── What may suppress a retry ─────────────────────────────────────────────────

def test_only_a_successful_sync_suppresses_the_next_one():
    """A failed or still-Processing run leaves the sheet exactly as stale as it
    was. Letting it start the cooldown would turn one bad pull into a minute of
    silently refusing to try again."""
    sql = body("_synced_within_cooldown")
    assert "status = 'Done'" in sql


def test_cooldown_is_per_source():
    """The four sheets are pulled on their own schedules, so one being fresh
    says nothing about the others."""
    assert "source_label IS NOT DISTINCT FROM :label" in body("_synced_within_cooldown")
    assert "module = :module" in body("_synced_within_cooldown")


def test_cooldown_uses_cast_not_the_colon_colon_form():
    """text() does not recognise a bind parameter followed by ::, and leaves it
    in the statement as literal SQL — a runtime failure, not an import one."""
    sql = body("_synced_within_cooldown")
    assert "CAST(:window AS int)" in sql
    assert "::" not in sql


# ── Where it applies ──────────────────────────────────────────────────────────

def test_the_shared_sync_button_honours_the_cooldown():
    assert "_synced_within_cooldown(db, source)" in body("sync_latest")


def test_the_per_source_admin_sync_ignores_the_cooldown():
    """An admin who has just corrected a sheet must be able to re-pull it at
    once; making them wait out a window meant for a crowd would be absurd."""
    assert "_synced_within_cooldown" not in body("sync_sheet_source")


def test_a_skipped_sheet_is_not_reported_as_a_failure():
    """Telling a rep their sync failed is what makes them press again."""
    b = body("sync_latest")
    assert '"Up to date"' in b
    assert '"Already syncing"' in b
    # and it hands back when, so the UI need not guess
    assert "last_synced_at" in b


def test_the_claim_is_taken_before_the_google_fetch():
    """Locking after the parse meant six reps each downloaded every sheet in
    full before five of them found they could not have the lock."""
    src = body("_do_sync")
    lock = src.index("FOR UPDATE NOWAIT")
    fetches = [src.index(p) for p in
               ("parse_visit_plan(", "parse_targets(", "parse_dealer_data(", "parse_log_book(")]
    assert lock < min(fetches), (
        "the source is claimed after the sheet is fetched, so a losing caller "
        "still pays the full Google API cost before being turned away")


# ── Per-tab sync ──────────────────────────────────────────────────────────────

def test_no_sheets_param_still_syncs_everything():
    assert oe.parse_sync_sheets(None) == set(oe.SYNC_SHEET_KEYS)
    assert oe.parse_sync_sheets("  ") == set(oe.SYNC_SHEET_KEYS)


def test_a_tab_gets_only_the_sheets_it_names():
    assert oe.parse_sync_sheets("log, plan") == {"log", "plan"}


def test_an_unknown_sheet_key_is_refused_not_dropped():
    """Dropping it would sync less than asked and report success."""
    with pytest.raises(oe.HTTPException) as e:
        oe.parse_sync_sheets("log,dealer")
    assert e.value.status_code == 400
    assert "dealer" in e.value.detail
