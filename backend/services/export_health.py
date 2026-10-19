"""
AutoForm MIS — Export: how urgent each open lead is.

One traffic light per open lead, worked out from four clocks. Each clock has
the same three steps, so "red" means the same kind of thing whichever clock
set it:

  clock                      watch (yellow)     at risk (amber)    critical (red)
  ─────────────────────────  ─────────────────  ─────────────────  ──────────────
  stage not moved            30+ days           60+ days           90+ days
  no contact logged          14+ days           30+ days           60+ days
  next action date           due in ≤ 7 days    1–14 days overdue  15+ days overdue
  target closure date        due in ≤ 30 days   1–30 days past     31+ days past

The lead takes the WORST of its clocks, and keeps every reason, so the screen
can say "red because: stage 3 for 94 days, no contact for 71 days".

Three rules keep this from producing confident nonsense:

  • A clock with no date is not green. "No contact logged" with nothing on the
    Activity tab is unknown, not fresh. Green needs a logged contact: a lead
    whose readable clocks are all fine but which nobody has contacted is
    `unknown` — management sees how many of those there are, rather than a
    reassuring wall of green.
  • A time-in-stage that is only a floor (the lead was already at that stage
    when tracking began: "≥ 20 days") counts only once the floor itself crosses
    a step. ≥ 95 days is genuinely red; ≥ 20 days is not known to be green.
  • On Hold is `parked`. A lead the team deliberately paused is expected not to
    move, and painting it red would bury the leads that are actually stuck.

Pure — rows in, dicts out — so the thresholds are unit-tested.
"""
from datetime import date
from typing import Optional

# Worst first. The order is the priority order everywhere it is shown.
LEVELS = ("critical", "at_risk", "watch", "on_track", "parked", "unknown")
LEVEL_LABELS = {
    "critical": "Act now", "at_risk": "At risk", "watch": "Watch",
    "on_track": "On track", "parked": "On hold", "unknown": "Can't tell yet",
}
_RANK = {"critical": 0, "at_risk": 1, "watch": 2, "on_track": 3}

# (watch, at_risk, critical) — days. The table in the docstring is the spec;
# the Highlights tab prints these same numbers, so change them here only.
STAGE_DAYS = (30, 60, 90)
CONTACT_DAYS = (14, 30, 60)
NEXT_ACTION_DUE_SOON = 7          # days ahead that count as "watch"
NEXT_ACTION_OVERDUE = (1, 15)     # days overdue: at_risk from, critical from
TARGET_DUE_SOON = 30
TARGET_PAST = (1, 31)

THRESHOLDS = {
    "stage_days": STAGE_DAYS, "contact_days": CONTACT_DAYS,
    "next_action_due_soon": NEXT_ACTION_DUE_SOON, "next_action_overdue": NEXT_ACTION_OVERDUE,
    "target_due_soon": TARGET_DUE_SOON, "target_past": TARGET_PAST,
}


def _step(days: int, steps: tuple) -> str:
    watch, risk, crit = steps
    if days >= crit:
        return "critical"
    if days >= risk:
        return "at_risk"
    if days >= watch:
        return "watch"
    return "on_track"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _stage_clock(row: dict) -> Optional[dict]:
    days, basis = row.get("days_in_stage"), row.get("days_in_stage_basis")
    if days is None:
        return None
    level = _step(days, STAGE_DAYS)
    # A floor below the first step says nothing either way.
    if basis == "floor" and level == "on_track":
        return None
    at = f"stage {row['stage_no']}" if row.get("stage_no") else "its stage"
    return {"clock": "stage", "level": level, "days": days,
            "text": f"At {at} for {'≥ ' if basis == 'floor' else ''}{_plural(days, 'day')}"}


def _contact_clock(row: dict) -> Optional[dict]:
    days = row.get("days_since_contact")
    if days is None:
        return None
    return {"clock": "contact", "level": _step(days, CONTACT_DAYS), "days": days,
            "text": f"No contact for {_plural(days, 'day')}" if days else "Contacted today"}


def _next_action_clock(row: dict, today: date) -> Optional[dict]:
    nad = row.get("next_action_date")
    if nad is None:
        return None
    late = (today - nad).days
    if late >= NEXT_ACTION_OVERDUE[1]:
        level = "critical"
    elif late >= NEXT_ACTION_OVERDUE[0]:
        level = "at_risk"
    elif -late <= NEXT_ACTION_DUE_SOON:
        level = "watch"
    else:
        level = "on_track"
    if late > 0:
        text = f"Next action {_plural(late, 'day')} overdue"
    elif late == 0:
        text = "Next action due today"
    else:
        text = f"Next action due in {_plural(-late, 'day')}"
    return {"clock": "next_action", "level": level, "days": late, "text": text}


def _target_clock(row: dict, today: date) -> Optional[dict]:
    tcd = row.get("target_close_date")
    if tcd is None:
        return None
    past = (today - tcd).days
    if past >= TARGET_PAST[1]:
        level = "critical"
    elif past >= TARGET_PAST[0]:
        level = "at_risk"
    elif -past <= TARGET_DUE_SOON:
        level = "watch"
    else:
        level = "on_track"
    if past > 0:
        text = f"Target closure passed {_plural(past, 'day')} ago"
    elif past == 0:
        text = "Target closure is today"
    else:
        text = f"Target closure in {_plural(-past, 'day')}"
    return {"clock": "target", "level": level, "days": past, "text": text}


def health(row: dict, today: date) -> Optional[dict]:
    """{level, reasons} for an enriched lead; None for a closed one.

    `reasons` are the clocks that could be read, worst first. A clock that is
    on track is kept too — "contacted 3 days ago" is why a lead is green.
    """
    if not row.get("is_open"):
        return None
    if row.get("status") == "On Hold":
        return {"level": "parked", "reasons": []}
    clocks = [c for c in (_stage_clock(row), _contact_clock(row),
                          _next_action_clock(row, today), _target_clock(row, today)) if c]
    if not clocks:
        return {"level": "unknown", "reasons": []}
    clocks.sort(key=lambda c: _RANK[c["level"]])
    level = clocks[0]["level"]
    # Green has to be earned by a logged contact. Without one, a lead that was
    # only just added (stage clock at 0 days) would be "on track" while nobody
    # has ever spoken to it — the 120-row prospect list would turn the page
    # green the day it was pasted in. A non-green clock still counts: 90 days
    # stuck is red whether or not anyone logged a call.
    if level == "on_track" and not any(c["clock"] == "contact" for c in clocks):
        level = "unknown"
    return {"level": level, "reasons": clocks}


def priority_key(row: dict):
    """Worst level first; within a level, the most money first, then the
    longest-stuck — the order someone with ten minutes should read them in."""
    h = row.get("health") or {}
    worst_days = max((c["days"] for c in h.get("reasons", [])), default=0)
    return (LEVELS.index(h.get("level", "unknown")),
            -(row.get("potential_cr") or 0), -worst_days)


def _counts(rows: list) -> dict:
    out = {lv: 0 for lv in LEVELS}
    for r in rows:
        out[r["health"]["level"]] += 1
    return out


def health_split(rows: list, field: str, labels: Optional[dict] = None,
                 order: Optional[tuple] = None) -> list:
    """Open leads per value of `field`, counted by level. Values in `order`
    first, then the rest A–Z, then "not set" last."""
    keys = {r.get(field) for r in rows}
    ordered = ([k for k in (order or ()) if k in keys]
               + sorted((k for k in keys if k and k not in (order or ())), key=lambda k: str(k).upper()))
    if None in keys:
        ordered.append(None)
    return [{"key": k, "label": (labels or {}).get(k, k), "counts": _counts([r for r in rows if r.get(field) == k]),
             "leads": sum(1 for r in rows if r.get(field) == k)} for k in ordered]


AGE_BUCKETS = (("0–29 days", 0, 29), ("30–59 days", 30, 59), ("60–89 days", 60, 89), ("90+ days", 90, None))


def stage_age_buckets(rows: list) -> list:
    """Open leads by how long they have sat at their stage. A floor below the
    90-day line cannot be placed in a bucket (≥ 20 could be anything), so it
    goes to "not known yet" with the leads that have no date at all."""
    out = []
    for label, lo, hi in AGE_BUCKETS:
        n = 0
        for r in rows:
            d = r.get("days_in_stage")
            if d is None or d < lo or (hi is not None and d > hi):
                continue
            if r.get("days_in_stage_basis") == "floor" and hi is not None:
                continue
            n += 1
        out.append({"key": label, "leads": n})
    known = sum(b["leads"] for b in out)
    out.append({"key": None, "leads": len(rows) - known})
    return out


def target_timeline(rows: list, today: date) -> list:
    """Open leads by the month of their Target Closure Date, oldest first, each
    month marked past / current / future. Leads with no target are counted in
    a final row so the chart never looks complete when it is not."""
    months: dict = {}
    for r in rows:
        t = r.get("target_close_date")
        if t is None:
            continue
        m = months.setdefault((t.year, t.month), {"leads": 0, "pot": []})
        m["leads"] += 1
        if r.get("potential_cr") is not None:
            m["pot"].append(float(r["potential_cr"]))
    cur = (today.year, today.month)
    out = [{"year": y, "month": mo, "leads": v["leads"],
            "potential_cr": round(sum(v["pot"]), 2) if v["pot"] else None,
            "potential_count": len(v["pot"]),
            "when": "past" if (y, mo) < cur else "current" if (y, mo) == cur else "future"}
           for (y, mo), v in sorted(months.items())]
    return out


def build_health(rows: list, today: date, region_labels: dict, regions: tuple,
                 stages: dict, list_limit: int = 12) -> dict:
    """Everything the Highlights tab and the health panels draw, from enriched
    rows that already carry `health`."""
    opn = [r for r in rows if r.get("health")]
    ranked = sorted(opn, key=priority_key)

    def pick(level):
        chosen = [r for r in ranked if r["health"]["level"] == level]
        return [{f: r.get(f) for f in ("company", "owner", "region", "country", "stage_no", "stage_name",
                                        "potential_cr", "next_action", "next_action_date",
                                        "target_close_date", "health")}
                for r in chosen[:list_limit]], chosen

    lists = {}
    for lv in ("critical", "at_risk", "watch"):
        items, chosen = pick(lv)
        # Summed over every lead at this level, not just the ones listed.
        pots = [float(r["potential_cr"]) for r in chosen if r.get("potential_cr") is not None]
        lists[lv] = {"items": items, "total": len(chosen),
                     "potential_cr": round(sum(pots), 2) if pots else None, "potential_count": len(pots)}

    by_stage = []
    for n, name in stages.items():
        here = [r for r in opn if r.get("stage_no") == n]
        by_stage.append({"key": n, "label": f"{n} · {name}", "leads": len(here), "counts": _counts(here)})
    no_stage = [r for r in opn if r.get("stage_no") is None]
    if no_stage:
        by_stage.append({"key": None, "label": "No stage", "leads": len(no_stage), "counts": _counts(no_stage)})

    # Housekeeping: the gaps that stop a lead from being judged at all, each a
    # concrete thing someone can go and fill in.
    working = [r for r in opn if r["health"]["level"] != "parked"]
    gaps = {
        "no_owner": sum(1 for r in working if not r.get("owner")),
        "no_activity": sum(1 for r in working if r.get("last_contact") is None),
        "no_next_action": sum(1 for r in working if not r.get("next_action") and r.get("next_action_date") is None),
        "no_target": sum(1 for r in working if r.get("target_close_date") is None),
        "no_potential": sum(1 for r in working if r.get("potential_cr") is None),
        "working": len(working),
    }

    return {
        "levels": list(LEVELS),
        "level_labels": LEVEL_LABELS,
        "thresholds": THRESHOLDS,
        "counts": _counts(opn),
        "open": len(opn),
        "lists": lists,
        "by_stage": by_stage,
        "by_owner": health_split(opn, "owner"),
        "by_region": health_split(opn, "region", region_labels, regions),
        "stage_age": stage_age_buckets(opn),
        "target_timeline": target_timeline(opn, today),
        "no_target": sum(1 for r in opn if r.get("target_close_date") is None),
        "gaps": gaps,
    }
