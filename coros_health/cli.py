"""CLI: fetch COROS health data, store it and build the dashboard payload."""

import argparse
import datetime
import gzip
import json
import os
from pathlib import Path

from . import db, fetch
from .mcp import DEFAULT_ISSUER, get_token

DATA = Path("data")
DASHBOARD = Path("dashboard")


def _merge_series(path, new_rows, columns, key="ts"):
    existing = {}
    if path.exists():
        with gzip.open(path, "rt") as f:
            import csv

            for row in csv.DictReader(f):
                existing[row[key]] = row
    for row in new_rows:
        existing[str(row[key])] = {c: row.get(c) for c in columns}
    rows = sorted(existing.values(), key=lambda r: int(r[key]))
    db.export_series(path, rows, columns)
    return len(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2024-01-01")
    parser.add_argument("--end", default=datetime.date.today().isoformat())
    parser.add_argument("--incremental", action="store_true")
    parser.add_argument("--skip-series", action="store_true")
    parser.add_argument("--skip-sports", action="store_true")
    parser.add_argument("--skip-daily-health", action="store_true")
    parser.add_argument("--skip-sleep", action="store_true")
    parser.add_argument("--skip-hrv", action="store_true")
    parser.add_argument("--skip-rhr", action="store_true")
    parser.add_argument("--skip-load", action="store_true")
    args = parser.parse_args()

    end = datetime.date.fromisoformat(args.end)
    start = datetime.date.fromisoformat(args.start)
    conn = db.connect(str(DATA / "health.db"))

    if args.incremental:
        last = db.get_meta(conn, "last_sync")
        if last:
            start = max(start, datetime.date.fromisoformat(last) - datetime.timedelta(days=7))

    print(f"[sync] {start} -> {end}", flush=True)
    token = get_token(
        DEFAULT_ISSUER,
        os.environ.get("COROS_ACCOUNT") or os.environ.get("COROS_EMAIL"),
        os.environ.get("COROS_PASSWORD"),
    )

    hrv_series = []

    if not args.skip_daily_health:
        daily = fetch.fetch_daily_health(token, start, end)
        db.upsert(conn, "daily_health", daily)

    if not args.skip_sleep:
        sleep = fetch.fetch_sleep(token, start, end)
        db.upsert(conn, "sleep", sleep)

    if not args.skip_hrv:
        hrv_rows, hrv_series = fetch.fetch_hrv(token, start, end)
        db.upsert(conn, "hrv", hrv_rows)

    avg_hr = fetch.fetch_avg_hr(token, start, end)
    db.upsert(conn, "avg_hr", avg_hr)

    if not args.skip_rhr:
        rhr = fetch.fetch_rhr(token, start, end)
        db.upsert(conn, "rhr", rhr)

    stress = fetch.fetch_stress_daily(token, start, end)
    db.upsert(conn, "stress_daily", stress)

    if not args.skip_load:
        load = fetch.fetch_load(token, start, end)
        db.upsert(conn, "load", load)

    stress_series = []
    if not args.skip_series:
        stress_series = fetch.fetch_stress_series(token, start, end)

    sports = []
    if not args.skip_sports:
        sports = fetch.fetch_sports(token, start, end)
        db.upsert(conn, "activities", sports)

    snapshots = fetch.fetch_snapshots(token)
    snapshots["fetched_at"] = datetime.datetime.now().isoformat(timespec="seconds")
    db.add_snapshot(conn, snapshots)

    if not args.skip_series:
        n1 = _merge_series(
            DATA / "hrv_series.csv.gz",
            hrv_series,
            ["date", "ts", "timezone", "hrv", "status", "confidence"],
        )
        n2 = _merge_series(
            DATA / "stress_series.csv.gz",
            stress_series,
            ["date", "ts", "timezone", "stress", "score", "stress_hrv", "stress_hr"],
        )
        print(f"[sync] hrv_series={n1} stress_series={n2}", flush=True)

    for table in [
        "daily_health",
        "sleep",
        "hrv",
        "avg_hr",
        "rhr",
        "stress_daily",
        "load",
        "activities",
    ]:
        db.export_csv(conn, table, str(DATA / f"{table}.csv"))
    db.export_csv(conn, "daily", str(DATA / "daily.csv"))

    payload = db.dashboard_payload(conn)
    DASHBOARD.mkdir(exist_ok=True)
    (DASHBOARD / "data.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )
    db.set_meta(conn, "last_sync", end.isoformat())
    db.set_meta(conn, "last_run", datetime.datetime.now().isoformat(timespec="seconds"))

    print("[sync] coverage:")
    for table, info in payload["coverage"].items():
        print(f"  {table}: {info['rows']} rows {info['start']} .. {info['end']}")
    print("[sync] done", flush=True)


if __name__ == "__main__":
    main()
