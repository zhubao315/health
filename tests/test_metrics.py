"""Tests for coros_health.metrics — the single source of analytic definitions.

Every definition documented in README 数据字典 has to keep its exact
behaviour here — in particular: missing stays None (never cast to 0), and
rolling stats degrade to None below min_obs instead of reporting a
misleading average.
"""

import unittest

from coros_health import metrics as M


class TestRollingMean(unittest.TestCase):
    def test_min_obs_below_five_is_none(self):
        # 6 valid values, window 7, min_obs 5: first 4 windows are short.
        vals = [100.0] * 6
        out = M.rolling_mean(vals, window=7, min_obs=5)
        self.assertEqual(out[:4], [None] * 4)
        self.assertEqual(out[4], 100.0)

    def test_short_window_with_missing_values_drops_below_min_obs(self):
        # 4 valid + 1 missing only reaches min_obs at index 6.
        vals = [100.0] * 4 + [None] + [100.0] * 2
        out = M.rolling_mean(vals, window=7, min_obs=5)
        self.assertEqual(out[:5], [None] * 5)
        self.assertEqual(out[5], 100.0)

    def test_missing_never_cast_to_zero(self):
        # A window of [70, None, 70] must average 70, not 46.67.
        vals = [70.0, None, 70.0, 70.0, 70.0]
        out = M.rolling_mean(vals, window=7, min_obs=3)
        self.assertEqual(out[-1], 70.0)

    def test_rolling_median_matches_manual(self):
        vals = [1, 2, 3, 8, 9, 10, 11]
        out = M.rolling_median(vals, window=7, min_obs=5)
        self.assertEqual(out[-1], 8.0)  # median of the full window
        self.assertIsNone(out[0])

    def test_genuine_zero_is_kept_zero(self):
        vals = [0, 0, 0, 0, 0, 0]
        out = M.rolling_mean(vals)
        self.assertEqual(out[-1], 0.0)


class TestBaseline(unittest.TestCase):
    def test_trailing_baseline_is_28day_rolling_mean(self):
        vals = [10.0] * 19 + [20.0] * 2  # only 21 valid total
        out = M.trailing_baseline(vals)
        # Needs >= 20 obs in a window, so valid only from index 19.
        self.assertIsNone(out[18])
        self.assertEqual(out[19], 10.5)  # (19*10 + 20) / 20


class TestSleepRegularity(unittest.TestCase):
    def test_identical_bedtimes_means_regular(self):
        bedtimes = [-55.0] * 7  # 23:05 every night
        out = M.sleep_regularity_series(bedtimes)
        self.assertEqual(out[-1], 1.0)

    def test_off_nights_do_not_score_higher_than_uniform(self):
        # MAD-of-median is insensitive to polarization in a 7-value window;
        # the guaranteed invariant is monotonicity vs. a uniform week.
        uniform = M.sleep_regularity_series([-55.0] * 8)
        scattered = M.sleep_regularity_series(
            [-55.0, -55.0, -55.0, -55.0, -240.0, -240.0, -240.0, -240.0]
        )
        self.assertIsNotNone(uniform[-1])
        self.assertIsNotNone(scattered[-1])
        self.assertLessEqual(scattered[-1], uniform[-1])

    def test_below_min_obs_is_none(self):
        out = M.sleep_regularity_series([-55.0] * 4)
        self.assertEqual(out, [None, None, None, None])

    def test_none_bedtimes_excluded_not_zero(self):
        vals = [-55.0, None, -55.0, -55.0, -55.0, -55.0, -55.0]
        out = M.sleep_regularity_series(vals)
        self.assertEqual(out[-1], 1.0)


class TestWrapBedtime(unittest.TestCase):
    def test_before_midnight(self):
        self.assertEqual(M.wrap_bedtime("23:05"), 1385 - 1440)

    def test_after_midnight(self):
        self.assertEqual(M.wrap_bedtime("00:31"), 31)

    def test_around_half_past_noon_wraps_negative(self):
        # Tied to ±12 h wrapping: 12:31 → -689.
        self.assertEqual(M.wrap_bedtime("12:31"), 751 - 1440)

    def test_invalid_or_empty(self):
        self.assertIsNone(M.wrap_bedtime(None))
        self.assertIsNone(M.wrap_bedtime("n/a"))


class TestSleepTargetGap(unittest.TestCase):
    def test_none_stays_none(self):
        self.assertIsNone(M.sleep_target_gap(None))

    def test_zero_is_a_value_not_missing(self):
        self.assertEqual(M.sleep_target_gap(0), -480)


class TestHrvDeviation(unittest.TestCase):
    def test_signed_deviation_in_ms(self):
        self.assertEqual(M.hrv_deviation_series([50, 60], [40, 70]), [10.0, -10.0])

    def test_without_baseline_is_none(self):
        self.assertEqual(M.hrv_deviation_series([50], [None]), [None])


class TestRhrTrend(unittest.TestCase):
    def test_steady_rise_is_positive(self):
        rhr = [50 + 0.5 * i for i in range(28)]
        out = M.rhr_trend_series(rhr)
        self.assertIsNotNone(out[-1])
        self.assertGreater(out[-1], 0)

    def test_flat_rhr_is_near_zero(self):
        rhr = [52.0] * 28
        out = M.rhr_trend_series(rhr)
        self.assertIsNotNone(out[-1])
        self.assertLessEqual(abs(out[-1]), 0.5)


class TestPearson(unittest.TestCase):
    def test_perfect_positive(self):
        xs = list(range(1, 9))
        ys = [2 * x for x in xs]
        r, n, lo, hi = M.pearson(xs, ys)
        self.assertEqual(n, 8)
        self.assertAlmostEqual(r, 1.0)
        self.assertAlmostEqual(lo, 1.0)
        self.assertAlmostEqual(hi, 1.0)

    def test_perfect_negative(self):
        xs = list(range(1, 9))
        ys = [17 - x for x in xs]
        r, n, lo, hi = M.pearson(xs, ys)
        self.assertAlmostEqual(r, -1.0)
        self.assertAlmostEqual(lo, -1.0)
        self.assertAlmostEqual(hi, -1.0)

    def test_too_few_pairs(self):
        r, n, lo, hi = M.pearson([1, 2, 3], [1, 2, 3])
        self.assertIsNone(r)
        self.assertEqual(n, 3)
        self.assertIsNone(lo)

    def test_constant_inputs_undefined(self):
        r, n, lo, hi = M.pearson([5] * 8, [1, 2, 3, 4, 5, 6, 7, 8])
        self.assertIsNone(r)
        self.assertEqual(n, 8)

    def test_pairs_with_missing_side_are_dropped(self):
        xs = list(range(1, 11))
        ys = list(range(1, 11))
        ys[0] = None
        r, n, _, _ = M.pearson(xs, ys)
        self.assertEqual(n, 9)
        self.assertGreater(r, 0)


class TestAlignLag(unittest.TestCase):
    DATES = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]

    def test_lag_one_pairs_next_day(self):
        xs, ys = M.align_lag(self.DATES, [1, 2, 3, 4, 5], [10, 20, 30, 40, 50], lag=1)
        self.assertEqual(xs, [1, 2, 3, 4])
        self.assertEqual(ys, [20, 30, 40, 50])

    def test_lag_zero_pairs_same_day(self):
        xs, ys = M.align_lag(self.DATES, [1, 2, 3, 4, 5], [10, 20, 30, 40, 50], lag=0)
        self.assertEqual(xs, [1, 2, 3, 4, 5])
        self.assertEqual(ys, [10, 20, 30, 40, 50])

    def test_store_breaks_pair(self):
        dates = ["2026-01-01", "2026-01-03", "2026-01-04"]  # Jan 2 gap
        xs, ys = M.align_lag(dates, [1, 2, 3], [None, 20, 30], lag=1)
        # Jan 1 + 1 = Jan 2 missing → dropped; Jan 3 pairs Jan 4.
        self.assertEqual(xs, [2])
        self.assertEqual(ys, [30])


class TestAnomalyFlags(unittest.TestCase):
    def test_spike_is_flagged(self):
        dates = [f"2026-03-{d:02d}" for d in range(1, 32)]
        values = [70] * 30 + [110]
        flags = M.anomaly_flags(values, dates, window=60, threshold=3.5, min_pairs=20)
        self.assertEqual([f[0] for f in flags], ["2026-03-31"])

    def test_quiet_series_not_flagged(self):
        dates = [f"2026-03-{d:02d}" for d in range(1, 31)]
        flags = M.anomaly_flags([70] * 30, dates)
        self.assertEqual(flags, [])

    def test_too_short_history_not_flagged(self):
        dates = ["2026-03-01", "2026-03-02"]
        flags = M.anomaly_flags([70, 130], dates, min_pairs=20)
        self.assertEqual(flags, [])


class TestCompleteness(unittest.TestCase):
    def test_fraction_of_valid(self):
        dates = [f"2026-01-{d:02d}" for d in range(1, 11)]
        values = [1, 2, 3, None, None, None, 4, 5, 6, 7]
        completeness, ok = M.completeness(dates, values)
        self.assertEqual(completeness, 0.7)
        self.assertEqual(ok, 7)

    def test_empty_dates(self):
        self.assertEqual(M.completeness([], []), (None, 0))


if __name__ == "__main__":
    unittest.main()
