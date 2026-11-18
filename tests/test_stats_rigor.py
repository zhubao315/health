"""Correlation-rigor tests: rank statistics, p values and FDR correction."""

import math
import unittest

from coros_health import stats_rigor


class StatsRigorTests(unittest.TestCase):
    def test_spearman_recovers_perfect_monotone_relationship(self):
        xs = [1, 2, 3, 4, 5]
        ys = [10, 20, 30, 40, 50]
        self.assertAlmostEqual(stats_rigor.spearman(xs, ys), 1.0, places=6)

    def test_spearman_handles_ties(self):
        xs = [1, 2, 2, 3, 4]
        ys = [1, 2, 3, 4, 5]
        rho = stats_rigor.spearman(xs, ys)
        self.assertIsNotNone(rho)
        self.assertGreater(rho, 0.9)

    def test_spearman_beats_pearson_on_monotone_nonlinear_data(self):
        xs = [1, 2, 3, 4, 5, 6, 7, 8]
        ys = [math.exp(x / 3) for x in xs]
        self.assertAlmostEqual(stats_rigor.spearman(xs, ys), 1.0, places=6)
        self.assertLess(stats_rigor.pearson(xs, ys), 1.0)

    def test_constant_input_is_undefined(self):
        self.assertIsNone(stats_rigor.spearman([1, 1, 1], [1, 2, 3]))

    def test_two_sided_p_shrinks_with_sample_size(self):
        small = stats_rigor.two_sided_p(0.5, 10)
        large = stats_rigor.two_sided_p(0.5, 1000)
        self.assertIsNotNone(small)
        self.assertLess(large, small)
        self.assertEqual(stats_rigor.two_sided_p(0.5, 3), None)

    def test_benjamini_hochberg_controls_fdr(self):
        q = stats_rigor.benjamini_hochberg([0.01, 0.02, 0.03, 0.9])
        # BH scales the smallest p by m/rank = 4/1 here.
        self.assertAlmostEqual(q[0], 0.04)
        self.assertGreaterEqual(q[0], 0.01)
        self.assertLessEqual(q[3], 1.0)
        self.assertGreaterEqual(q[3], q[2])

    def test_benjamini_hochberg_preserves_none(self):
        q = stats_rigor.benjamini_hochberg([None, 0.04, None])
        self.assertIsNone(q[0])
        self.assertIsNotNone(q[1])
        self.assertIsNone(q[2])

    def test_enrich_flags_small_samples_and_adds_family_fields(self):
        results = [
            {"n": 12, "p_value": 0.04, "r": 0.5},
            {"n": 900, "p_value": 0.001, "r": 0.2},
            {"n": 50, "p_value": None, "r": None},
        ]
        out = stats_rigor.enrich(results)
        self.assertFalse(out[0]["samples_ok"])
        self.assertTrue(out[1]["samples_ok"])
        self.assertIsNotNone(out[0]["q_value_bh"])
        self.assertIsNone(out[2]["q_value_bh"])
        self.assertIn("spearman", out[0]["method"])


if __name__ == "__main__":
    unittest.main()
