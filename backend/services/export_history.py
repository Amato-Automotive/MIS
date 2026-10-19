"""
AutoForm MIS — Export: what changed, and what happened in a period.

The Leads tab is overwritten as leads move, so on its own it can only ever say
where things stand now. Two things turn it into a history:

  • diff_leads — each sync compares the rows it is about to write with the
    rows already stored and records the difference as events. Pure, so the
    rules that decide what counts as an arrival are tested directly.
  • the Activity tab — the team's own log of contacts, dated to the day.

build_period then answers "what happened between these two dates" from both.

Two limits every reader of this must know, and the UI states:

  • An event is dated to the SYNC that saw it, not to the moment it happened.
    Leads that change twice between syncs show only the net change.
  • History starts at the first sync after this shipped. Before that there is
    only a `baseline` snapshot, which is a starting point and never an arrival.
"""
from datetime import date
from typing import Optional

from services.export_leads_sync import CLOSED, STAGES, company_key


def diff_leads(prev: list, new: list) -> list:
    """Events turning `prev` (stored rows) into `new` (rows about to be written).

    Both are dicts with company / stage_no / status. When nothing is stored
    yet — the first sync, or the first after the sheet was re-registered —
    every lead is a `baseline`, not an arrival: otherwise switching the team to
    a new workbook would report the whole list as new that day.
    """
    events: list = []
    before = {company_key(r["company"]): r for r in prev}
    after = {company_key(r["company"]): r for r in new}
    first = not before

    for key, r in after.items():
        old = before.get(key)
        if old is None:
            events.append({"company": r["company"], "company_key": key,
                           "kind": "baseline" if first else "added",
                           "from_stage": None, "to_stage": r.get("stage_no"),
                           "from_status": None, "to_status": r.get("status")})
            continue
        if old.get("stage_no") != r.get("stage_no"):
            events.append({"company": r["company"], "company_key": key, "kind": "stage",
                           "from_stage": old.get("stage_no"), "to_stage": r.get("stage_no"),
                           "from_status": None, "to_status": None})
        if old.get("status") != r.get("status"):
            events.append({"company": r["company"], "company_key": key, "kind": "status",
                           "from_stage": None, "to_stage": None,
                           "from_status": old.get("status"), "to_status": r.get("status")})

    for key, old in before.items():
        if key not in after:
            events.append({"company": old["company"], "company_key": key, "kind": "removed",
                           "from_stage": old.get("stage_no"), "to_stage": None,
                           "from_status": old.get("status"), "to_status": None})
    return events


def stage_entries(events: list) -> dict:
    """{company_key: (kind, date)} — when each company arrived at the stage it
    is at now, as far as the history can tell.

    `events` are baseline / added / stage rows in the order they were observed.
    A baseline that shows the stage we already knew the company was at is not
    a new arrival: re-registering the sheet (the team moving from a copy to
    their real workbook) writes a fresh baseline for every lead, and taking it
    at face value would restart every time-in-stage from that day.
    """
    out: dict = {}
    stage_of: dict = {}
    for e in events:
        key, to = e["company_key"], e["to_stage"]
        if e["kind"] == "baseline" and key in stage_of and stage_of[key] == to:
            continue
        stage_of[key] = to
        out[key] = (e["kind"], e["observed_on"])
    return out


def closed_on(lead: dict, status_events: list) -> Optional[date]:
    """The day a Won/Lost lead closed: the day the sync saw its status change
    to what it is now. None for open leads, and for leads that were already
    closed when tracking began — the sheet has no closed-date column (management
    settled the layout on a Target Closure Date instead), so those are undatable."""
    if lead.get("status") not in CLOSED:
        return None
    seen = [e["observed_on"] for e in status_events
            if e["company_key"] == company_key(lead["company"]) and e["to_status"] == lead["status"]]
    return max(seen) if seen else None


def _bar(rows: list, key: str, order: tuple = ()) -> list:
    counts: dict = {}
    for r in rows:
        counts[r.get(key)] = counts.get(r.get(key), 0) + 1
    known = [k for k in order if k in counts] + sorted(
        (k for k in counts if k and k not in order), key=str.upper)
    out = [{"key": k, "count": counts[k]} for k in known]
    if None in counts:
        out.append({"key": None, "count": counts[None]})
    return out


def build_period(events: list, activities: list, leads: list, d1: Optional[date], d2: Optional[date],
                 activity_types: tuple, feed_limit: int = 200) -> dict:
    """What happened between d1 and d2 inclusive (None, None = all time).

    `events` carry `observed_on` (a date); `activities` carry `activity_date`;
    `leads` are the current rows, already cut by the lead filters — events and
    activities should arrive cut the same way, so every figure here is about
    the same set of companies.
    """
    def inside(d: Optional[date]) -> bool:
        return d is not None and (d1 is None or d >= d1) and (d2 is None or d <= d2)

    ev = [e for e in events if e["kind"] != "baseline" and inside(e["observed_on"])]
    acts = [a for a in activities if inside(a["activity_date"])]

    stage_ev = [e for e in ev if e["kind"] == "stage"]
    moved = [e for e in stage_ev if e["from_stage"] is not None and e["to_stage"] is not None]
    advanced = [e for e in moved if e["to_stage"] > e["from_stage"]]
    went_back = [e for e in moved if e["to_stage"] < e["from_stage"]]

    status_all = [e for e in events if e["kind"] == "status"]
    closes = []
    for lead in leads:
        on = closed_on(lead, status_all)
        if inside(on):
            closes.append({"company": lead["company"], "status": lead["status"], "closed_on": on,
                           "owner": lead.get("owner"), "region": lead.get("region"),
                           "potential_cr": lead.get("potential_cr"),
                           "lost_reason": lead.get("lost_reason"), "stage_no": lead.get("stage_no")})
    closes.sort(key=lambda c: c["closed_on"], reverse=True)

    # Per-stage flow: how many leads arrived at each stage in the window, and
    # how many left it — onward or backward.
    flow = []
    for n, name in STAGES.items():
        flow.append({
            "stage": n, "name": name,
            "entered": sum(1 for e in stage_ev if e["to_stage"] == n)
                       + sum(1 for e in ev if e["kind"] == "added" and e["to_stage"] == n),
            "moved_on": sum(1 for e in advanced if e["from_stage"] == n),
            "went_back": sum(1 for e in went_back if e["from_stage"] == n),
        })

    open_keys = {company_key(l["company"]) for l in leads if l.get("status") not in CLOSED}
    touched = {a["company_key"] for a in acts if a["matched"]}

    feed = [{"date": a["activity_date"], "type": "activity", "company": a["company"],
             "activity_type": a["activity_type"], "by_person": a["by_person"], "notes": a["notes"],
             "matched": a["matched"]} for a in acts]
    feed += [{"date": e["observed_on"], "type": e["kind"], "company": e["company"],
              "from_stage": e["from_stage"], "to_stage": e["to_stage"],
              "from_status": e["from_status"], "to_status": e["to_status"]} for e in ev]
    # Activities before events on the same day: a contact usually causes the
    # move, and the sync sees the move later.
    feed.sort(key=lambda f: (f["date"], f["type"] != "activity"), reverse=True)

    return {
        "movement": {
            "added": sum(1 for e in ev if e["kind"] == "added"),
            "removed": sum(1 for e in ev if e["kind"] == "removed"),
            "advanced": len(advanced),
            "went_back": len(went_back),
            "staged": sum(1 for e in stage_ev if e["from_stage"] is None and e["to_stage"] is not None),
            "on_hold": sum(1 for e in ev if e["kind"] == "status" and e["to_status"] == "On Hold"),
            "won": sum(1 for c in closes if c["status"] == "Won"),
            "lost": sum(1 for c in closes if c["status"] == "Lost"),
        },
        "closes": closes,
        "stage_flow": flow,
        "activity": {
            "touches": len(acts),
            "companies": len({a["company_key"] for a in acts}),
            "open_leads": len(open_keys),
            "open_touched": len(open_keys & touched),
            "unmatched": sum(1 for a in acts if not a["matched"]),
            "by_type": _bar(acts, "activity_type", activity_types),
            "by_person": _bar(acts, "by_person"),
        },
        "feed": feed[:feed_limit],
        "feed_total": len(feed),
    }
