"""
Export stage history — what the sync records, and what a period reports.

The quiet ways this goes wrong:

  FIRST SYNC       Recording every lead as "added" the first time — or the
                   first time after the sheet is re-registered — reports the
                   whole list as new that month.
  RE-REGISTERING   Moving the team from a copy to their real workbook writes a
                   fresh baseline for every lead. Taken at face value it would
                   restart every time-in-stage from that day.
  NET CHANGE       A lead that goes 3→4 and 4→3 between syncs changed nothing;
                   a lead that goes 2→5 is ONE advance, not three.
  CLOSES           A lead closed before tracking has no event; its Closed Date
                   is the only record and must be what counts.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.export_history import build_period, closed_on, diff_leads, stage_entries  # noqa: E402
from services.export_leads_sync import ACTIVITY_TYPES  # noqa: E402


def L(company, stage=2, status="Active", **kw):
    return {"company": company, "stage_no": stage, "status": status, **kw}


def kinds(events):
    return sorted((e["company"], e["kind"]) for e in events)


# ── diff_leads ────────────────────────────────────────────────────────────────

def test_first_sync_is_a_baseline_not_a_wave_of_arrivals():
    ev = diff_leads([], [L("A"), L("B")])
    assert kinds(ev) == [("A", "baseline"), ("B", "baseline")]


def test_later_syncs_record_arrivals_departures_and_changes():
    prev = [L("A", 2), L("B", 3), L("C", 5)]
    new = [L("A", 4), L("B", 3, "On Hold"), L("D", 1)]
    ev = diff_leads(prev, new)
    assert kinds(ev) == [("A", "stage"), ("B", "status"), ("C", "removed"), ("D", "added")]
    a = next(e for e in ev if e["company"] == "A")
    assert (a["from_stage"], a["to_stage"]) == (2, 4)


def test_nothing_changed_writes_nothing_and_case_drift_is_not_a_change():
    assert diff_leads([L("Amio", 2)], [L("AMIO ", 2)]) == []


def test_stage_and_status_changing_together_are_two_events():
    ev = diff_leads([L("A", 8)], [L("A", 9, "Won")])
    assert kinds(ev) == [("A", "stage"), ("A", "status")]


# ── stage_entries ─────────────────────────────────────────────────────────────

def E(company, kind, to_stage, on):
    return {"company_key": company.upper(), "kind": kind, "to_stage": to_stage, "observed_on": on}


def test_arrival_date_survives_a_re_registration_baseline():
    got = stage_entries([
        E("A", "baseline", 2, date(2026, 9, 1)),
        E("A", "stage", 3, date(2026, 9, 10)),
        E("A", "baseline", 3, date(2026, 9, 20)),   # sheet swapped, same stage
    ])
    assert got["A"] == ("stage", date(2026, 9, 10))


def test_a_baseline_at_a_different_stage_resets_to_a_floor():
    got = stage_entries([
        E("A", "stage", 3, date(2026, 9, 10)),
        E("A", "baseline", 5, date(2026, 9, 20)),   # moved while unregistered: arrival unknown
    ])
    assert got["A"] == ("baseline", date(2026, 9, 20))


# ── closed_on ─────────────────────────────────────────────────────────────────

def test_closed_date_beats_the_observed_status_change():
    ev = [{"company_key": "A", "to_status": "Won", "observed_on": date(2026, 9, 25)}]
    assert closed_on(L("A", 9, "Won", closed_date=date(2026, 9, 3)), ev) == date(2026, 9, 3)
    assert closed_on(L("A", 9, "Won", closed_date=None), ev) == date(2026, 9, 25)
    assert closed_on(L("A", 9, "Active", closed_date=date(2026, 9, 3)), ev) is None
    # Closed before tracking, no date typed: unknown, not "today".
    assert closed_on(L("B", 9, "Won", closed_date=None), ev) is None


# ── build_period ──────────────────────────────────────────────────────────────

def ev(company, kind, on, fs=None, ts=None, fst=None, tst=None):
    return {"company": company, "company_key": company.upper(), "kind": kind, "observed_on": on,
            "from_stage": fs, "to_stage": ts, "from_status": fst, "to_status": tst}


def act(company, on, matched=True, kind="Email", by="Jai"):
    return {"company": company, "company_key": company.upper(), "activity_date": on,
            "matched": matched, "activity_type": kind, "by_person": by, "notes": None}


SEPT = (date(2026, 9, 1), date(2026, 9, 30))


def period(events, acts, leads, window=SEPT):
    return build_period(events, acts, leads, *window, ACTIVITY_TYPES)


def test_baselines_never_count_as_movement():
    p = period([ev("A", "baseline", date(2026, 9, 5), ts=2)], [], [L("A")])
    assert all(v == 0 for v in p["movement"].values())
    assert p["feed"] == []


def test_a_multi_stage_jump_is_one_advance():
    p = period([ev("A", "stage", date(2026, 9, 5), fs=2, ts=5),
                ev("B", "stage", date(2026, 9, 6), fs=6, ts=4)], [], [L("A", 5), L("B", 4)])
    m = p["movement"]
    assert (m["advanced"], m["went_back"]) == (1, 1)
    flow = {f["stage"]: f for f in p["stage_flow"]}
    assert (flow[2]["moved_on"], flow[5]["entered"], flow[6]["went_back"], flow[4]["entered"]) == (1, 1, 1, 1)


def test_window_edges_are_inclusive_and_outside_is_ignored():
    p = period([ev("A", "stage", date(2026, 9, 1), fs=2, ts=3),
                ev("B", "stage", date(2026, 9, 30), fs=2, ts=3),
                ev("C", "stage", date(2026, 10, 1), fs=2, ts=3)], [], [])
    assert p["movement"]["advanced"] == 2


def test_closes_come_from_closed_date_even_without_an_event():
    leads = [L("UKCC", 9, "Won", closed_date=date(2026, 9, 12), potential_cr=20.0),
             L("Old", 9, "Won", closed_date=date(2026, 6, 1)),
             L("Gone", 4, "Lost", closed_date=None, lost_reason="Price")]
    events = [ev("Gone", "status", date(2026, 9, 20), fst="Active", tst="Lost")]
    p = period(events, [], leads)
    assert (p["movement"]["won"], p["movement"]["lost"]) == (1, 1)
    assert [c["company"] for c in p["closes"]] == ["Gone", "UKCC"]   # newest first


def test_activity_counts_and_coverage_of_open_leads():
    leads = [L("A"), L("B"), L("C", 9, "Won")]
    acts = [act("A", date(2026, 9, 3)), act("A", date(2026, 9, 9), kind="Call"),
            act("C", date(2026, 9, 4)), act("Ghost", date(2026, 9, 5), matched=False),
            act("B", date(2026, 8, 30))]                                   # outside
    a = period([], acts, leads)["activity"]
    assert (a["touches"], a["companies"], a["unmatched"]) == (4, 3, 1)
    # Open leads touched: A only — C is won, Ghost is not a lead, B was August.
    assert (a["open_touched"], a["open_leads"]) == (1, 2)
    assert [b["key"] for b in a["by_type"]] == ["Email", "Call"]


def test_all_time_window_takes_everything():
    p = period([ev("A", "stage", date(2025, 1, 1), fs=1, ts=2)], [], [], window=(None, None))
    assert p["movement"]["advanced"] == 1
