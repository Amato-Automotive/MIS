"""
Export lead health — the traffic light management reads first.

The quiet ways this goes wrong:

  MISSING = GREEN   A lead with nothing logged painted green looks like the
                    best-run lead on the list. No readable clock is `unknown`.
  FLOORS            "≥ 20 days in stage" (already there when tracking began)
                    is not known to be fine. Only a floor past a step counts.
  ON HOLD           A paused lead is meant to sit still; red would bury the
                    leads that are actually stuck.
  WORST WINS        One red clock makes the lead red, whatever the others say,
                    and every reason is kept so the screen can say why.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.export_health import (  # noqa: E402
    build_health, health, priority_key, stage_age_buckets, target_timeline,
)
from services.export_leads_sync import REGION_LABELS, REGIONS, STAGES, enrich  # noqa: E402

TODAY = date(2026, 10, 19)


def L(company="x", status="Active", stage=2, *, in_stage=None, basis="observed", contact=None,
      next_action=None, target=None, potential=None, owner=None, region="UK"):
    """An enriched lead. `in_stage` / `contact` are day counts back from TODAY;
    `next_action` / `target` are day offsets from TODAY (negative = past)."""
    def ago(n):
        return None if n is None else date.fromordinal(TODAY.toordinal() - n)

    def ahead(n):
        return None if n is None else date.fromordinal(TODAY.toordinal() + n)

    row = {"company": company, "status": status, "stage_no": stage, "potential_cr": potential,
           "last_contact": ago(contact), "next_action": None,
           "next_action_date": ahead(next_action), "target_close_date": ahead(target),
           "owner": owner, "region": region, "country": None, "customer_type": None, "source": None}
    if in_stage is not None:
        row["stage_entered_kind"] = "stage" if basis == "observed" else "baseline"
        row["stage_entered_on"] = ago(in_stage)
    return enrich(row, TODAY, 30)


def level(**kw):
    return L(**kw)["health"]["level"]


def test_stage_clock_steps_at_30_60_90_days():
    assert [level(in_stage=d, contact=1) for d in (0, 29, 30, 59, 60, 89, 90, 400)] == \
        ["on_track", "on_track", "watch", "watch", "at_risk", "at_risk", "critical", "critical"]


def test_green_needs_a_logged_contact():
    # Just added, nothing overdue, but nobody has spoken to it: not "on track".
    assert level(in_stage=0) == "unknown"
    assert level(in_stage=0, target=90) == "unknown"
    assert level(in_stage=0, contact=3) == "on_track"
    # Anything worse than green still shows without a contact.
    assert level(in_stage=95) == "critical"
    assert level(next_action=3) == "watch"


def test_contact_clock_steps_at_14_30_60_days():
    assert [level(contact=d) for d in (3, 13, 14, 30, 59, 60)] == \
        ["on_track", "on_track", "watch", "at_risk", "at_risk", "critical"]


def test_next_action_watch_when_due_soon_and_red_two_weeks_late():
    assert [level(next_action=d, contact=1) for d in (30, 7, 0, -1, -14, -15)] == \
        ["on_track", "watch", "watch", "at_risk", "at_risk", "critical"]


def test_target_closure_watch_within_a_month_and_red_a_month_past():
    assert [level(target=d, contact=1) for d in (60, 30, -1, -30, -31)] == \
        ["on_track", "watch", "at_risk", "at_risk", "critical"]


def test_nothing_readable_is_unknown_never_green():
    assert level() == "unknown"
    assert L()["health"]["reasons"] == []


def test_a_short_floor_says_nothing_but_a_long_one_is_red():
    assert level(in_stage=20, basis="floor") == "unknown"
    assert level(in_stage=95, basis="floor") == "critical"
    assert L(in_stage=95, basis="floor")["health"]["reasons"][0]["text"] == "At stage 2 for ≥ 95 days"


def test_on_hold_is_parked_and_closed_has_no_health():
    assert level(status="On Hold", in_stage=200) == "parked"
    assert L(status="Won")["health"] is None
    assert L(status="Lost", in_stage=200)["health"] is None


def test_worst_clock_wins_and_every_reason_is_kept_worst_first():
    h = L(in_stage=5, contact=70, next_action=-3)["health"]
    assert h["level"] == "critical"
    assert [r["clock"] for r in h["reasons"]] == ["contact", "next_action", "stage"]
    assert [r["level"] for r in h["reasons"]] == ["critical", "at_risk", "on_track"]


def test_priority_is_level_then_money_then_how_stuck():
    rows = [L("small-red", contact=70, potential=1), L("big-red", contact=61, potential=9),
            L("amber", contact=40, potential=50), L("red-no-estimate", contact=200)]
    assert [r["company"] for r in sorted(rows, key=priority_key)] == \
        ["big-red", "small-red", "red-no-estimate", "amber"]


def test_stage_age_buckets_keep_short_floors_out_of_the_buckets():
    rows = [L(in_stage=10), L(in_stage=45), L(in_stage=95, basis="floor"),
            L(in_stage=20, basis="floor"), L()]
    got = {b["key"]: b["leads"] for b in stage_age_buckets(rows)}
    assert got == {"0–29 days": 1, "30–59 days": 1, "60–89 days": 0, "90+ days": 1, None: 2}


def test_target_timeline_is_by_month_and_marks_the_past():
    rows = [L("a", target=-40, potential=2), L("b", target=-35), L("c", target=5, potential=1),
            L("d", target=60), L("e")]
    tl = target_timeline(rows, TODAY)
    assert [(m["month"], m["leads"], m["when"]) for m in tl] == \
        [(9, 2, "past"), (10, 1, "current"), (12, 1, "future")]
    assert (tl[0]["potential_cr"], tl[0]["potential_count"]) == (2.0, 1)


def test_build_health_counts_lists_and_gaps():
    rows = [L("red", contact=90, owner="Jai", potential=5), L("amber", contact=40),
            L("hold", status="On Hold"), L("blank"), L("won", status="Won")]
    h = build_health(rows, TODAY, REGION_LABELS, REGIONS, STAGES)
    assert h["open"] == 4                                   # the won lead is not open
    assert (h["counts"]["critical"], h["counts"]["at_risk"], h["counts"]["parked"],
            h["counts"]["unknown"]) == (1, 1, 1, 1)
    assert [i["company"] for i in h["lists"]["critical"]["items"]] == ["red"]
    # Gaps count leads someone is meant to be working — not the parked one.
    assert (h["gaps"]["working"], h["gaps"]["no_owner"], h["gaps"]["no_activity"]) == (3, 2, 1)
    assert [g["key"] for g in h["by_owner"]] == ["Jai", None]
