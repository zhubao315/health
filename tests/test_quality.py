"""Tests for coros_health.quality — gaps, missing rates, pseudo-zero audit."""

import tempfile
import unittest
from pathlib import Path

from coros_health import db, quality


def _conn_with_days(path, days):
    conn = db.connect(path)
    rows = [{"date": d, "steps": 8000} for d in days]
    db.upsert(conn, "daily_health", rows)
    return conn


class QualityFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "health.db")


class TestFindGaps(QualityFixture):
    def test_continuous_dates_have_no_gaps(self):
        conn = _conn_with_days(
            self.path,
            ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"],
        )
        gaps = quality.find_gaps(quality._date_list(conn, "daily_health"))
        self.assertEqual(gaps, [])

    def test_gap_reports_interval_length(self):
        conn = _conn_with_days(
            self.path,
            ["2026-01-01", "2026-01-02", "2026-01-12", "2026-01-13"],
        )
        gaps = quality.find_gaps(quality._date_list(conn, "daily_health"))
        self.assertEqual(gaps, [("2026-01-02", "2026-01-12", 9)])

    def test_single_row_no_gaps(self):
        conn = _conn_with_days(self.path, ["2026-01-01"])
        self.assertEqual(quality.find_gaps(quality._date_list(conn, "daily_health")), [])

    def test_unsorted_input_still_sorted(self):
        gaps = quality.find_gaps(
            ["2026-01-12", "2026-01-01", "2026-01-02"]
        )
        self.assertEqual(gaps, [("2026-01-02", "2026-01-12", 9)])


class TestMissingRate(QualityFixture):
    def test_counts_none_entries(self):
        rows = [
            {"date": "2026-01-01", "hrv_avg": 55},
            {"date": "2026-01-02", "hrv_avg": None},
            {"date": "2026-01-03", "hrv_avg": 58},
        ]
        rate, missed = quality.missing_rate(rows, "hrv_avg")
        self.assertEqual(rate, 0.3333)
        self.assertEqual(missed, 1)

    def test_window_limits_rows(self):
        rows = [
            {"date": "2026-01-01", "hrv_avg": None},
            {"date": "2026-01-02", "hrv_avg": 55},
            {"date": "2026-01-03", "hrv_avg": 58},
        ]
        rate, missed = quality.missing_rate(rows, "hrv_avg", window_days=2)
        self.assertEqual(rate, 0.0)
        self.assertEqual(missed, 0)

    def test_empty_rows(self):
        self.assertEqual(quality.missing_rate([], "hrv_avg"), (None, None))


class TestZeroStats(QualityFixture):
    def test_never_zero_metric_with_zero_is_suspicious(self):
        rows = [
            {"date": "2026-01-01", "sleep_total_min": 0},
            {"date": "2026-01-02", "sleep_total_min": 400},
        ]
        info = quality.zero_stats(rows, "sleep_total_min")
        self.assertTrue(info["suspicious"])
        self.assertEqual(info["zeros"], 1)
        self.assertEqual(info["last_dates"], ["2026-01-01"])

    def test_plain_metric_zero_is_fine(self):
        rows = [{"date": "2026-01-01", "steps": 0}]
        info = quality.zero_stats(rows, "steps")
        self.assertFalse(info["suspicious"])
        self.assertEqual(info["zeros"], 1)


class TestAuditShape(QualityFixture):
    def _five_day_conn(self):
        days = [f"2026-01-{d:02d}" for d in range(1, 6)]
        conn = _conn_with_days(self.path, days)
        for d in days:
            db.upsert(
                conn,
                "sleep",
                [{"date": d, "sleep_score": 80, "main_min": 400 + int(d[-1])}],
            )
        return conn

    def test_audit_still_runs_on_tiny_fixture(self):
        conn = self._five_day_conn()
        report = quality.audit(conn, today=__import__("datetime").date(2026, 1, 5))
        self.assertIn("generated_at", report)
        self.assertIn("metrics", report)
        self.assertIn("sync_status", report)
        self.assertIsNone(report["partial_fetch_errors"])

    def test_partial_fetch_errors_flip_status_to_warn(self):
        conn = self._five_day_conn()
        db.set_meta(conn, "last_fetch_errors", '{"hrv": "transient"}')
        report = quality.audit(conn, today=__import__("datetime").date(2026, 1, 5))
        self.assertEqual(report["sync_status"], "warn")
        self.assertEqual(report["partial_fetch_errors"], {"hrv": "transient"})

    def test_invalid_fetch_error_json_is_ignored(self):
        conn = self._five_day_conn()
        db.set_meta(conn, "last_fetch_errors", "{not json")
        report = quality.audit(conn, today=__import__("datetime").date(2026, 1, 5))
        self.assertEqual(report["sync_status"], "ok")

    def test_write_quality_creates_json_without_stale_before_audit(self):
        conn = self._five_day_conn()
        out = Path(self.tmp.name) / "data_quality.json"
        quality.write_quality(conn, str(out))
        import json

        blob = json.loads(out.read_text())
        self.assertNotIn("serial", json.dumps(blob).lower())


if __name__ == "__main__":
    unittest.main()
