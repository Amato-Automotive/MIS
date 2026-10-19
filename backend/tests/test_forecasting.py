import pytest

from services.forecasting import growth_rate, linear_extrapolate


def test_unpublished_months_are_dropped_not_zeroed():
    # OEM targets publish achievement a month at a time; NULL is "not yet",
    # and reading it as 0 would project a collapse.
    with_nulls = linear_extrapolate([10, 12, 11, None, None], periods_remaining=7, target=150)
    assert with_nulls["periods_used"] == 3 and with_nulls["periods_missing_excluded"] == 2
    assert with_nulls["run_rate"] == 11.0
    assert with_nulls["projected_total"] == 33 + 11 * 7
    assert with_nulls["required_run_rate"] == round((150 - 33) / 7, 2)
    assert with_nulls["projected_gap_to_target"] == 150 - 110


def test_one_month_is_low_confidence_and_has_no_trend():
    out = linear_extrapolate([40], periods_remaining=2)
    assert out["confidence"] == "low" and "trend_projected_total" not in out


def test_trend_continues_the_line():
    out = linear_extrapolate([10, 20, 30], periods_remaining=2)
    assert out["trend_slope_per_period"] == 10.0
    assert out["trend_projected_total"] == 60 + 40 + 50


@pytest.mark.parametrize("args", [
    {"points": [None, None], "periods_remaining": 3},
    {"points": [1, "x"], "periods_remaining": 3},
    {"points": [1], "periods_remaining": -1},
    {"points": [1], "periods_remaining": True},
    {"points": "1,2", "periods_remaining": 3},
])
def test_bad_input_is_refused(args):
    with pytest.raises(ValueError):
        linear_extrapolate(**args)


def test_growth_skips_gaps_and_zero_bases():
    out = growth_rate([100, 110, None, 121, 0, 50])
    # 100→110 = +10%; 110→None and None→121 skipped; 121→0 = −100%; 0→50 undefined
    assert out["steps_measured"] == 2 and out["average_pct"] == -45.0 and out["recent_pct"] == -100.0
    assert growth_rate([100, 121])["compound_pct"] == 21.0
    assert growth_rate([100, 110, 121])["compound_pct"] == 10.0


def test_growth_needs_two_points():
    with pytest.raises(ValueError):
        growth_rate([5, None])
