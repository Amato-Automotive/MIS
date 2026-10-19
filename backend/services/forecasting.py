"""
AutoForm MIS — the chatbot's forecasting arithmetic.

The model never projects a number itself: it fetches actuals with SQL and calls
these, so a forecast quoted in a meeting is arithmetic, not a guess.

The one rule that matters here: a missing month is None, never 0. OEM brand
targets publish achievement a month at a time with NULL for the months still
to come; read as 0, a NULL would look like a collapse and drag the projection
down. So None is dropped — and counted, so the answer can say how many months
the projection actually stands on.
"""
from typing import Optional


def _clean(points) -> tuple[list[float], int]:
    if not isinstance(points, (list, tuple)):
        raise ValueError("points must be a list of numbers (null for a missing period)")
    vals, missing = [], 0
    for p in points:
        if p is None:
            missing += 1
            continue
        if isinstance(p, bool) or not isinstance(p, (int, float)):
            raise ValueError(f"points must be numbers or null, got {p!r}")
        vals.append(float(p))
    return vals, missing


def _confidence(n: int) -> str:
    # One month is a single observation, not a pace; three is the least that
    # says anything about a trend.
    return "low" if n < 2 else ("medium" if n < 4 else "high")


def linear_extrapolate(points: list, periods_remaining: int, target: Optional[float] = None) -> dict:
    """Project the period total from the actuals so far.

    run_rate     the average of the actuals — what the narration calls "the pace"
    projected    actual so far + run_rate × periods_remaining
    trend_*      the same, but continuing the least-squares line through the
                 actuals (only with 3+ points: two points fit any line)
    With a target: the gap and the run rate the remaining periods need.
    """
    vals, missing = _clean(points)
    if not vals:
        raise ValueError("no actuals to project from — every point was null")
    if not isinstance(periods_remaining, int) or isinstance(periods_remaining, bool) or periods_remaining < 0:
        raise ValueError("periods_remaining must be a whole number ≥ 0")

    n = len(vals)
    actual = sum(vals)
    run_rate = actual / n
    projected = actual + run_rate * periods_remaining
    out = {
        "periods_used": n,
        "periods_missing_excluded": missing,
        "actual_to_date": round(actual, 2),
        "run_rate": round(run_rate, 2),
        "periods_remaining": periods_remaining,
        "projected_total": round(projected, 2),
        "confidence": _confidence(n),
    }
    if n >= 3:
        xs = list(range(n))
        mx, my = sum(xs) / n, run_rate
        slope = sum((x - mx) * (y - my) for x, y in zip(xs, vals)) / sum((x - mx) ** 2 for x in xs)
        intercept = my - slope * mx
        future = sum(intercept + slope * (n + i) for i in range(periods_remaining))
        out["trend_slope_per_period"] = round(slope, 2)
        out["trend_projected_total"] = round(actual + future, 2)
    if target is not None:
        if isinstance(target, bool) or not isinstance(target, (int, float)):
            raise ValueError("target must be a number")
        gap = float(target) - projected
        out["target"] = round(float(target), 2)
        out["projected_gap_to_target"] = round(gap, 2)   # > 0: short of target
        out["projected_pct_of_target"] = round(projected / target * 100, 1) if target else None
        if periods_remaining:
            out["required_run_rate"] = round((float(target) - actual) / periods_remaining, 2)
    return out


def growth_rate(points: list) -> dict:
    """Period-on-period growth across the actuals.

    average_pct      mean of each step's % change, over steps where both ends
                     exist and the earlier one is not 0 (a % of 0 is undefined)
    compound_pct     the constant per-period rate that turns the first value
                     into the last — steadier than the mean when steps swing
    recent_pct       the last step alone, to show acceleration or deceleration
    """
    if not isinstance(points, (list, tuple)):
        raise ValueError("points must be a list of numbers (null for a missing period)")
    _clean(points)   # validates types
    steps = []
    for a, b in zip(points, points[1:]):
        if a is None or b is None or a == 0:
            continue
        steps.append((b - a) / abs(a) * 100)
    vals = [float(p) for p in points if p is not None]
    if len(vals) < 2:
        raise ValueError("need at least two non-null points to measure growth")
    out = {
        "points_used": len(vals),
        "steps_measured": len(steps),
        "average_pct": round(sum(steps) / len(steps), 2) if steps else None,
        "recent_pct": round(steps[-1], 2) if steps else None,
        "confidence": _confidence(len(vals)),
    }
    first, last, k = vals[0], vals[-1], len(vals) - 1
    out["compound_pct"] = round(((last / first) ** (1 / k) - 1) * 100, 2) if first > 0 and last > 0 else None
    return out
