#!/usr/bin/env python3
"""Backfill raw HRV / stress series for a recent window.

Full-history raw series would need one MCP call per 7 days; this script is
meant for the last year (or any window you pass), while daily aggregates are
already complete from 2024-01.
"""

import argparse
import datetime
import gzip
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coros_health import db, fetch
from coros_health.mcp import DEFAULT_ISSUER, get_token


def merge(path, rows, columns):
    existing = {}
    if path.exists():
        import csv

        with gzip.open(path, "rt") as f:
            for row in csv.DictReader(f):
                existing[row["ts"]] = row
    for row in rows:
        existing[str(row["ts"])] = {c: row.get(c) for c in columns}
    db.export_series(path, sorted(existing.values(), key=lambda r: int(r["ts"])), columns)
    return len(existing)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2025-10-01")
    parser.add_argument("--end", default=datetime.date.today().isoformat())
    args = parser.parse_args()
    start = datetime.date.fromisoformat(args.start)
    end = datetime.date.fromisoformat(args.end)
    token = get_token(
        DEFAULT_ISSUER, os.environ["COROS_ACCOUNT"], os.environ["COROS_PASSWORD"]
    )
    conn = db.connect("data/health.db")

    hrv_rows, hrv_series = fetch.fetch_hrv(token, start, end)
    db.upsert(conn, "hrv", hrv_rows)
    n1 = merge(
        Path("data/hrv_series.csv.gz"),
        hrv_series,
        ["date", "ts", "timezone", "hrv", "status", "confidence"],
    )
    stress = fetch.fetch_stress_series(token, start, end)
    n2 = merge(
        Path("data/stress_series.csv.gz"),
        stress,
        ["date", "ts", "timezone", "stress", "score", "stress_hrv", "stress_hr"],
    )
    print(f"hrv_series={n1} stress_series={n2}")


if __name__ == "__main__":
    main()
