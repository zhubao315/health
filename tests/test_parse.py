"""Tests for coros_health.parse — redaction + recent sleep-window fixes."""

import unittest

from coros_health.parse import parse_devices, parse_sleep_overview

_DEVICE_TEXT = """
2 devices

1. PACE 3
Model Name: PACE 3
Serial Number: COR-SERIAL-123
Bluetooth ID: AA:BB:CC:DD:EE:FF
Warranty Expiration Date: 2029-01-01
Firmware Version: 3.0903.2100

2. Apex Pro
Model Name: Apex Pro
Serial Number: COR-SERIAL-456
Bluetooth ID: 11:22:33:44:55:66
"""

_SLEEP_TEXT_CROSSING = """
2026-10-25
Sleep Score: 85
Main Sleep: 7小时42分钟
Main Sleep Window: 2026-10-25 22:31 - 2026-10-26 06:13
Deep Sleep Ratio: 22%
Light Sleep Ratio: 51%
REM Ratio: 21%
Awake Ratio: 6%
Awake Time: 32分钟
Awake Count: 3
Naps Total: 0分钟
"""


class TestParseDevices(unittest.TestCase):
    def test_only_name_and_model_survive(self):
        devices = parse_devices(_DEVICE_TEXT)
        self.assertEqual(len(devices), 2)
        blob = str(devices)
        for needle in ("SERIAL", "AA:BB", "Warranty", "Firmware"):
            self.assertNotIn(needle, blob)

    def test_names_and_models_kept(self):
        devices = parse_devices(_DEVICE_TEXT)
        self.assertEqual(devices[0]["name"], "PACE 3")
        self.assertEqual(devices[0]["model"], "PACE 3")
        self.assertEqual(devices[1]["name"], "Apex Pro")


class TestParseSleepWindow(unittest.TestCase):
    def test_window_embellished_with_dates_rsplit_on_last_hyphen(self):
        rows = parse_sleep_overview(_SLEEP_TEXT_CROSSING)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["date"], "2026-10-25")
        # "22:31 - 06:13" — the ISO-date hyphens must not swallow the split
        self.assertEqual(row["window_start"], "22:31")
        self.assertEqual(row["window_end"], "06:13")

    def test_minutes_and_ratio_fields(self):
        rows = parse_sleep_overview(_SLEEP_TEXT_CROSSING)
        row = rows[0]
        self.assertEqual(row["sleep_score"], 85)
        self.assertEqual(row["deep_pct"], 22)
        self.assertEqual(row["awake_count"], 3)

    def test_missing_window_leaves_none(self):
        rows = parse_sleep_overview(
            """
2026-10-26
Sleep Score: 70
Main Sleep: 6小时30分钟
"""
        )
        r = rows[0]
        self.assertIsNone(r["window_start"])
        self.assertIsNone(r["window_end"])


if __name__ == "__main__":
    unittest.main()
