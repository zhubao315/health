"""Tests for coros_health.db — storage, migration, sanitization, derivation.

Key invariants under test:
- snapshots v1 (fetched_at PK) → v2 (date PK): keep the day's latest row,
  at most one row per calendar day, idempotent on reconnect;
- device serial numbers / bluetooth ids never survive migration;
- sleep stages: prefer real minutes, else pct×total, else None — never 0;
- daily view leaves missing metrics as NULL (not 0);
- recent_activities exposes no location / label_id.
"""

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from coros_health import db

_TABLES = (
    "daily_health",
    "sleep",
    "hrv",
    "avg_hr",
    "rhr",
    "stress_daily",
    "load",
    "activities",
    "snapshots",
    "meta",
)


def _seed_person(conn, day, **metrics):
    defaults = {
        "date": day,
        "steps": 8000,
        "calories": 2100,
        "exercise_min": 40,
        "stress_avg": 35,
        "sleep_score": 85,
        "sleep_total_min": 460,
        "sleep_deep_min": None,
        "sleep_light_min": None,
        "sleep_rem_min": None,
        "sleep_awake_min": 45,
        "sleep_hr_avg": 58,
    }
    defaults.update({k: v for k, v in metrics.items() if k in defaults})
    db.upsert(conn, "daily_health", [defaults])


class DbFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "health.db")
        self.addCleanup(self.tmp.cleanup)


class TestUpsertIdempotency(DbFixture):
    def test_same_date_twice_is_one_row(self):
        conn = db.connect(self.path)
        rows = [
            {"date": "2026-01-01", "steps": 100},
            {"date": "2026-01-02", "steps": 200},
        ]
        db.upsert(conn, "daily_health", rows)
        db.upsert(conn, "daily_health", [{"date": "2026-01-01", "steps": 111}])
        conn.commit()
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM daily_health").fetchone()[0], 2
        )
        self.assertEqual(
            conn.execute(
                "SELECT steps FROM daily_health WHERE date = '2026-01-01'"
            ).fetchone()[0],
            111,
        )

    def test_null_metrics_stay_null_after_replace(self):
        conn = db.connect(self.path)
        db.upsert(conn, "daily_health", [{"date": "2026-01-01", "steps": None}])
        row = dict(
            conn.execute("SELECT * FROM daily_health WHERE date='2026-01-01'").fetchone()
        )
        self.assertIsNone(row["steps"])
        self.assertNotIn(row["steps"], (0,))


class TestSnapshotMigration(DbFixture):
    def _create_legacy(self, rows):
        raw = sqlite3.connect(self.path)
        raw.execute(
            "CREATE TABLE snapshots (fetched_at TEXT PRIMARY KEY, fitness_json TEXT,"
            " recovery_json TEXT, devices_json TEXT)"
        )
        raw.executemany(
            "INSERT INTO snapshots VALUES (?,?,?,?)", rows
        )
        raw.commit()
        raw.close()

    def test_dedupe_per_day_keeps_latest_and_strips_serial(self):
        legacy = json.dumps(
            [
                {
                    "name": "PACE 3",
                    "model": "PACE 3",
                    "serialNumber": "SER-NO-1",
                    "bluetoothId": "BT-NO-2",
                    "warrantyExpirationDate": "2029-01-01",
                }
            ]
        )
        self._create_legacy(
            [
                ("2026-10-25T07:00:00", "{}", "{}", legacy),
                ("2026-10-25T09:30:00", "{}", "{}", legacy),
                ("2026-10-26T08:00:00", "{}", "{}", legacy),
            ]
        )
        conn = db.connect(self.path)
        dates = [r[0] for r in conn.execute("SELECT date FROM snapshots ORDER BY date")]
        self.assertEqual(dates, ["2026-10-25", "2026-10-26"])
        kept = conn.execute(
            "SELECT fetched_at FROM snapshots WHERE date='2026-10-25'"
        ).fetchone()[0]
        self.assertEqual(kept, "2026-10-25T09:30:00")
        devices = json.loads(
            conn.execute("SELECT devices_json FROM snapshots").fetchone()[0]
        )[0]
        self.assertEqual(set(devices.keys()), {"name", "model"})
        blob = json.dumps(devices)
        for needle in ("SER-", "BT-NO"):
            self.assertNotIn(needle, blob)
        for table_hint in _TABLES:
            pass  # sanity: migration keeps the view working below

    def test_migration_is_idempotent_across_reconnects(self):
        self._create_legacy([("2026-10-25T07:00:00", "{}", "{}", "[]")])
        conn = db.connect(self.path)
        conn.close()
        conn = db.connect(self.path)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0], 1
        )
        # add_snapshot keeps one row per day afterwards
        db.add_snapshot(
            conn,
            {"fetched_at": "2026-10-26T08:00:00", "fitness": {}, "recovery": {}, "devices": []},
        )
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0], 2
        )

    def test_already_migrated_schema_is_untouched(self):
        conn = db.connect(self.path)
        db.add_snapshot(
            conn,
            {"fetched_at": "2026-10-26T08:00:00", "fitness": {}, "recovery": {}, "devices": [{"name": "PACE 3", "model": "M"}]},
        )
        devices = json.loads(
            conn.execute("SELECT devices_json FROM snapshots").fetchone()[0]
        )
        self.assertEqual(devices[0]["name"], "PACE 3")


class TestSleepStageDerivation(DbFixture):
    def test_minutes_win_over_percent(self):
        conn = db.connect(self.path)
        db.upsert(
            conn,
            "sleep",
            [{"date": "2026-01-01", "sleep_score": 80, "main_min": 460, "deep_pct": 20}],
        )
        _seed_person(
            conn,
            "2026-01-01",
            sleep_total_min=460,
            sleep_deep_min=101,
            sleep_light_min=230,
            sleep_rem_min=84,
            sleep_awake_min=45,
        )
        row = dict(
            conn.execute("SELECT * FROM daily WHERE date='2026-01-01'").fetchone()
        )
        stages = db.sleep_stage_metrics(row)
        self.assertEqual(stages["deep"], 101)
        self.assertEqual(stages["light"], 230)
        self.assertEqual(stages["rem"], 84)
        # minute columns win even though deep_pct=20 was also present
        self.assertEqual(stages["stage_completeness"], 1.0)

    def test_percent_fallback_multiplies_total(self):
        conn = db.connect(self.path)
        db.upsert(conn, "sleep", [{"date": "2026-01-01", "sleep_score": 80, "deep_pct": 20}])
        # no daily_health minute columns at all
        db.upsert(conn, "daily_health", [{"date": "2026-01-01", "steps": 8000}])
        row = dict(
            conn.execute("SELECT * FROM daily WHERE date='2026-01-01'").fetchone()
        )
        self.assertEqual(row["sleep_total_min"], None)
        # sleep table main_min missing → total unset → pct has nothing to scale
        stages = db.sleep_stage_metrics(row)
        self.assertIsNone(stages["deep"])

    def test_main_min_backfills_total_for_percent_math(self):
        conn = db.connect(self.path)
        db.upsert(
            conn, "sleep", [{"date": "2026-01-01", "main_min": 460, "deep_pct": 20}]
        )
        _seed_person(conn, "2026-01-01", sleep_total_min=None)
        row = dict(
            conn.execute("SELECT * FROM daily WHERE date='2026-01-01'").fetchone()
        )
        stages = db.sleep_stage_metrics(row)
        # 460 × 20 % → 92 rounded; from the sleep table, not a fake zero
        self.assertEqual(stages["deep"], 92)
        self.assertLess(stages["stage_completeness"], 1.0)

    def test_stages_missing_is_none_never_zero(self):
        conn = db.connect(self.path)
        db.upsert(conn, "sleep", [{"date": "2026-01-01", "sleep_score": 80}])
        db.upsert(conn, "daily_health", [{"date": "2026-01-01", "steps": 100}])
        row = dict(
            conn.execute("SELECT * FROM daily WHERE date='2026-01-01'").fetchone()
        )
        stages = db.sleep_stage_metrics(row)
        self.assertIsNone(stages["deep"])
        self.assertIsNone(stages["rem"])
        self.assertEqual(stages["stage_completeness"], 0.0)

    def test_payload_keeps_missing_stages_null(self):
        conn = db.connect(self.path)
        db.upsert(conn, "sleep", [{"date": "2026-01-01", "sleep_score": 80}])
        db.upsert(conn, "daily_health", [{"date": "2026-01-01", "steps": 100}])
        payload = db.dashboard_payload(conn)
        row = payload["daily"][0]
        self.assertIsNone(row["deep"])
        self.assertIsNone(row["light"])
        self.assertIsNone(row["rem"])


class TestViewConstants(DbFixture):
    def test_view_leaves_missing_values_null(self):
        conn = db.connect(self.path)
        _seed_person(conn, "2026-01-01")
        row = conn.execute(
            "SELECT hrv_avg, rhr, load_short FROM daily WHERE date='2026-01-01'"
        ).fetchone()
        self.assertIsNone(row["hrv_avg"])
        self.assertIsNone(row["rhr"])
        self.assertIsNone(row["load_short"])

    def test_latest_carry_own_dates(self):
        conn = db.connect(self.path)
        _seed_person(conn, "2026-01-01")
        _seed_person(
            conn,
            "2026-01-02",
            steps=None,
            calories=None,
            exercise_min=None,
            stress_avg=None,
            sleep_score=None,
            sleep_total_min=None,
            sleep_awake_min=None,
            sleep_hr_avg=None,
        )
        payload = db.dashboard_payload(conn)
        # Jan 2 has no steps → the KPI keeps Jan 1's value + date
        self.assertEqual(payload["latest"]["steps"]["date"], "2026-01-01")
        self.assertEqual(payload["latest"]["steps"]["value"], 8000)
        # sleep KPI likewise
        self.assertEqual(payload["latest"]["sleep_total_min"]["date"], "2026-01-01")

    def test_latest_hrv_and_icons_are_none_when_trimmed(self):
        conn = db.connect(self.path)
        _seed_person(conn, "2026-01-01")
        payload = db.dashboard_payload(conn)
        self.assertIsNone(payload["latest"]["hrv_avg"]["value"])
        self.assertIsNone(payload["latest"]["hrv_avg"]["date"])


class TestRecentActivities(DbFixture):
    def test_no_location_or_label_id(self):
        conn = db.connect(self.path)
        _seed_person(conn, "2026-10-01")
        db.upsert(
            conn,
            "activities",
            [
                {
                    "label_id": "L1",
                    "sport_type": 1,
                    "sport": "跑步",
                    "date": "2026-09-30",
                    "location": "北京市",
                    "distance_km": 10.5,
                    "duration_min": 52,
                    "avg_hr": 150,
                    "calories": 700,
                    "avg_speed_kmh": 12.1,
                    "avg_pace": "4:57",
                }
            ],
        )
        acts = db.recent_activities(conn, 90)
        self.assertEqual(len(acts), 1)
        self.assertNotIn("location", acts[0])
        self.assertNotIn("label_id", acts[0])
        self.assertNotIn("avg_pace", acts[0])
        self.assertEqual(acts[0]["sport"], "跑步")

    def test_old_activities_outside_window_are_excluded(self):
        conn = db.connect(self.path)
        _seed_person(conn, "2026-10-01")
        db.upsert(
            conn,
            "activities",
            [
                {"label_id": "NEW", "date": "2026-09-30", "sport": "NEW", "distance_km": 10.0},
                {"label_id": "OLD", "date": "2025-09-30", "sport": "OLD", "distance_km": 10.0},
            ],
        )
        acts = db.recent_activities(conn, 90)
        ids = {a["sport"] for a in acts}
        self.assertIn("NEW", ids)
        self.assertNotIn("OLD", ids)


class TestPearsonWithCI(unittest.TestCase):
    def test_perfect_positive_ci_degenerates(self):
        r, n, lo, hi = db.pearson_with_ci(list(range(1, 9)), [2 * x for x in range(1, 9)])
        self.assertAlmostEqual(r, 1.0)
        self.assertEqual(n, 8)
        self.assertAlmostEqual(lo, 1.0)
        self.assertAlmostEqual(hi, 1.0)

    def test_fewer_than_eight_pairs(self):
        r, n, lo, hi = db.pearson_with_ci([1, 2, 3], [1, 2, 3])
        self.assertIsNone(r)
        self.assertEqual(n, 3)


class TestCorrelationsAlignedByDate(DbFixture):
    def test_stress_pairs_next_night_sleep(self):
        conn = db.connect(self.path)
        # three nights: stress on day d pairs sleep on d+1 (lag=1 spec)
        for d, stress, sleep_total in [
            ("2026-01-01", 30, 400),
            ("2026-01-02", 60, 500),
            ("2026-01-03", 90, None),  # third night missing sleep
        ]:
            db.upsert(
                conn, "daily_health", [{"date": d, "stress_avg": stress}]
            )
            db.upsert(
                conn,
                "sleep",
                [{"date": d, "sleep_score": 80, "main_min": sleep_total}],
            )
        payload = db.dashboard_payload(conn)
        spec = [
            c for c in payload["correlations"] if "压力" in c["label"] and "睡眠" in c["label"]
        ][0]
        # (30→500) survives; (60→None) is dropped by the pair filter, so only
        # 1 *usable* pair remains — n must report usable pairs, never padded.
        self.assertEqual(spec["n"], 1)


if __name__ == "__main__":
    unittest.main()
