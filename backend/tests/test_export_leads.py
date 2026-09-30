"""
The Export lead pipeline — the parser for the `Leads` tab and the pipeline
maths behind the overview.

The hazards here are all quiet ones:

  RENAMED HEADER     A column matched by position, or by exact header text,
                     goes silently blank when someone retypes the header. Every
                     lead then looks like nobody filled that field in.
  ABSENT vs ZERO     Most leads carry no potential estimate. Summing NULL as 0
                     reports "₹31 Cr pipeline" as if it covered the whole list.
  OPEN               A blank status is still an open lead; only Won and Lost
                     close one. Treating blank as closed shrinks the pipeline.
  STALE              "No contact for 30 days" needs a contact date. A lead with
                     none recorded is unknown, not fresh and not stale.
  WHICH TAB          The workbook has many tabs. A duplicated Leads tab picked
                     silently could publish last week's copy.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.export_leads_sync import (  # noqa: E402
    build_summary, enrich, parse_leads_grids, parse_stage, parse_status, region_for,
)

HEADERS = ["Company", "Owner", "Customer Type", "Country", "City", "Contact Person",
           "Contact Email", "Contact Phone", "Stage", "Stage Since", "Status",
           "Est. Potential (₹ Cr)", "Last Contact", "Next Action", "Next Action Date",
           "Source", "Remarks"]
H = {h: i for i, h in enumerate(HEADERS)}


def row(company, **kw):
    """A sheet row with the named columns filled (keys are headers, spaces → _)."""
    out = [""] * len(HEADERS)
    out[H["Company"]] = company
    for k, v in kw.items():
        out[H[k.replace("_", " ").replace("Est Potential", "Est. Potential (₹ Cr)")]] = v
    return out


def parse(*rows, headers=HEADERS, tab="Leads", extra=None):
    grids = {tab: [headers, *rows]}
    grids.update(extra or {})
    return parse_leads_grids(grids)


# ── Parser ────────────────────────────────────────────────────────────────────

def test_reads_a_full_row_and_derives_region():
    recs, errs = parse(row("Halfords", Owner="Reenu + Jai", Country="UK",
                           Stage="6 - Sample Submission", Status="Active",
                           Est_Potential=5, Last_Contact=46252))   # 2026-08-18 as a serial
    assert errs == []
    r = recs[0]
    assert (r["company"], r["owner"], r["stage_no"], r["status"]) == ("Halfords", "Reenu + Jai", 6, "Active")
    assert r["potential_cr"] == 5.0
    assert r["last_contact"] == date(2026, 8, 18)
    assert r["region"] == "UK"
    assert r["sheet_row"] == 2


def test_headers_match_despite_spacing_case_and_punctuation():
    drifted = [h.upper().replace(".", "").replace("(₹ Cr)", "Cr") for h in HEADERS]
    drifted[H["Stage Since"]] = "stage  since"
    recs, errs = parse(row("Amio", Stage="2", Status="Active", Est_Potential="1.5",
                           Stage_Since="01-09-2026"), headers=drifted)
    assert errs == []
    assert recs[0]["potential_cr"] == 1.5
    assert recs[0]["stage_since"] == date(2026, 9, 1)


def test_a_missing_optional_column_is_reported_not_silently_blank():
    headers = [h for h in HEADERS if h != "Owner"]
    r = [c for i, c in enumerate(row("Amio", Stage="2", Status="Active")) if i != H["Owner"]]
    recs, errs = parse(r, headers=headers)
    assert recs[0]["owner"] is None
    assert any("OWNER" in e for e in errs)


def test_bad_values_are_left_blank_and_named():
    recs, errs = parse(row("Piton", Stage="Stage twelve", Status="Maybe",
                           Est_Potential="big", Last_Contact="soon"))
    r = recs[0]
    assert (r["stage_no"], r["status"], r["potential_cr"], r["last_contact"]) == (None, None, None, None)
    assert len(errs) == 4 and all("Piton" in e for e in errs)


def test_blank_potential_is_absent_without_a_warning_and_zero_is_kept():
    recs, errs = parse(row("A", Stage="2", Status="Active"),
                       row("B", Stage="2", Status="Active", Est_Potential=0))
    assert errs == []
    assert recs[0]["potential_cr"] is None
    assert recs[1]["potential_cr"] == 0.0


def test_negative_potential_is_rejected():
    recs, errs = parse(row("A", Stage="2", Status="Active", Est_Potential=-3))
    assert recs[0]["potential_cr"] is None and errs


def test_duplicate_company_keeps_the_first_row():
    recs, errs = parse(row("Amio", Stage="2", Status="Active"),
                       row("AMIO", Stage="5", Status="Active"))
    assert [r["stage_no"] for r in recs] == [2]
    assert any("already listed" in e for e in errs)


def test_blank_rows_are_skipped_and_orphan_data_is_reported():
    orphan = row("", Stage="3", Status="Active")
    recs, errs = parse(row("A", Stage="2", Status="Active"), [""] * 5, orphan)
    assert len(recs) == 1
    assert errs == ["Row 4: has data but no company — skipped."]


def test_unmapped_country_is_reported_and_region_left_empty():
    recs, errs = parse(row("AutoStar", Country="Bermuda", Stage="2", Status="Active"))
    assert recs[0]["region"] is None
    assert any("Bermuda" in e for e in errs)


def test_tab_named_leads_wins_over_a_copy():
    old = {"Leads (old)": [HEADERS, row("Old Co", Stage="1", Status="Active")]}
    recs, _ = parse(row("New Co", Stage="2", Status="Active"), extra=old)
    assert [r["company"] for r in recs] == ["New Co"]


def test_two_unnamed_candidate_tabs_refuse_to_guess():
    grids = {"Copy A": [HEADERS, row("A", Stage="1", Status="Active")],
             "Copy B": [HEADERS, row("B", Stage="1", Status="Active")]}
    recs, errs = parse_leads_grids(grids)
    assert recs == [] and "none is named 'Leads'" in errs[0]


def test_workbook_without_a_leads_tab():
    recs, errs = parse_leads_grids({"UK": [["Sr. No.", "Company Name"]]})
    assert recs == [] and "No tab" in errs[0]


def test_stage_status_region_vocabularies():
    assert [parse_stage(v) for v in ("3 - Customer Engagement", "STAGE 5 ", " STAGE 5", 11, 7.0, 12, "x")] \
        == [3, 5, 5, 11, 7, None, None]
    assert [parse_status(v) for v in ("on hold", "ONHOLD", "Won", " lost ", "")] \
        == ["On Hold", "On Hold", "Won", "Lost", None]
    assert [region_for(c) for c in ("UK", "Ireland", "Europe (pan-EU)", "Australia", "Bermuda", None)] \
        == ["UK", "EU", "EU", "AU", None, None]


# ── Pipeline maths ────────────────────────────────────────────────────────────

TODAY = date(2026, 9, 28)


def lead(company, status="Active", stage=2, potential=None, last_contact=None,
         stage_since=None, next_action_date=None, owner=None, region="UK"):
    return enrich({"company": company, "status": status, "stage_no": stage,
                   "potential_cr": potential, "last_contact": last_contact,
                   "stage_since": stage_since, "next_action_date": next_action_date,
                   "owner": owner, "region": region, "customer_type": None, "source": None},
                  TODAY, 30)


def test_blank_status_is_open_and_only_won_lost_close():
    assert [lead("x", status=s)["is_open"] for s in ("Active", "On Hold", None, "Won", "Lost")] \
        == [True, True, True, False, False]


def test_pipeline_potential_is_absent_not_zero_and_says_what_it_covers():
    s = build_summary([lead("a"), lead("b")], TODAY, 30)
    assert s["kpis"]["pipeline"] == {"potential_cr": None, "potential_count": 0, "leads": 2}

    s = build_summary([lead("a", potential=5), lead("b"), lead("won", status="Won", potential=20)],
                      TODAY, 30)
    # Won business is not pipeline.
    assert s["kpis"]["pipeline"] == {"potential_cr": 5.0, "potential_count": 1, "leads": 2}
    assert s["kpis"]["won_potential"]["potential_cr"] == 20.0


def test_stale_needs_a_contact_date():
    fresh = lead("fresh", last_contact=date(2026, 9, 20))
    old = lead("old", last_contact=date(2026, 7, 1))
    unknown = lead("unknown")
    closed = lead("closed", status="Lost", last_contact=date(2026, 1, 1))
    assert [x["stale"] for x in (fresh, old, unknown, closed)] == [False, True, None, None]
    s = build_summary([fresh, old, unknown, closed], TODAY, 30)
    assert s["kpis"]["stale"] == 1
    assert [a["company"] for a in s["attention"]["stale"]] == ["old"]


def test_overdue_actions_only_for_open_leads_with_a_date():
    rows = [lead("late", next_action_date=date(2026, 9, 1)),
            lead("later", next_action_date=date(2026, 10, 5)),
            lead("done", status="Won", next_action_date=date(2026, 1, 1)),
            lead("none")]
    s = build_summary(rows, TODAY, 30)
    assert s["kpis"]["overdue_actions"] == 1
    assert s["attention"]["overdue_actions"][0]["company"] == "late"


def test_funnel_open_here_versus_reached():
    rows = [lead("a", stage=2), lead("b", stage=5), lead("c", stage=5, status="Lost"),
            lead("d", stage=None)]
    f = {x["stage"]: x for x in build_summary(rows, TODAY, 30)["funnel"]}
    assert (f[2]["open_here"], f[5]["open_here"]) == (1, 1)
    # Reached counts every lead at that stage or later, the lost one included.
    assert (f[1]["reached"], f[2]["reached"], f[5]["reached"], f[6]["reached"]) == (3, 3, 2, 0)
    assert build_summary(rows, TODAY, 30)["no_stage_open"] == 1


def test_days_in_stage_median_ignores_unknown_dates():
    rows = [lead("a", stage=3, stage_since=date(2026, 9, 18)),
            lead("b", stage=3, stage_since=date(2026, 9, 8)),
            lead("c", stage=3)]
    f3 = build_summary(rows, TODAY, 30)["funnel"][2]
    assert (f3["median_days_in_stage"], f3["days_known"], f3["open_here"]) == (15, 2, 3)


def test_groups_keep_not_set_last_and_regions_in_market_order():
    rows = [lead("a", region="AU"), lead("b", region="UK"), lead("c", region=None),
            lead("d", owner="Jai"), lead("e", owner="Reenu")]
    s = build_summary(rows, TODAY, 30)
    assert [g["key"] for g in s["by_region"]] == ["UK", "AU", None]
    assert [g["key"] for g in s["by_owner"]] == ["Jai", "Reenu", None]
