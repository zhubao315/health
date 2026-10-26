"""CLI: fetch COROS health data, store it and build the dashboard payload."""

import argparse
import datetime
import gzip
import json
import os
from pathlib import Path

from . import db, fetch, quality
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
    fetch_errors = {}

    def _fetch(table, fn):
        """Fetch one metric; a transient/limited API failure must never abort
        the run — the dashboard builds from whatever the DB already has and
        data_quality reports the gap."""
        try:
            db.upsert(conn, table, fn())
        except Exception as exc:
            fetch_errors[table] = str(exc)[:200]
            print(f"[sync] warn: {table} fetch failed; keeping existing rows", flush=True)

    if not args.skip_daily_health:
        _fetch("daily_health", lambda: fetch.fetch_daily_health(token, start, end))

    if not args.skip_sleep:
        _fetch("sleep", lambda: fetch.fetch_sleep(token, start, end))

    if not args.skip_hrv:
        try:
            hrv_rows, hrv_series = fetch.fetch_hrv(token, start, end)
            db.upsert(conn, "hrv", hrv_rows)
        except Exception as exc:
            fetch_errors["hrv"] = str(exc)[:200]
            print("[sync] warn: hrv fetch failed; keeping existing rows", flush=True)

    _fetch("avg_hr", lambda: fetch.fetch_avg_hr(token, start, end))

    if not args.skip_rhr:
        _fetch("rhr", lambda: fetch.fetch_rhr(token, start, end))

    _fetch("stress_daily", lambda: fetch.fetch_stress_daily(token, start, end))

    if not args.skip_load:
        _fetch("load", lambda: fetch.fetch_load(token, start, end))

    stress_series = []
    if not args.skip_series:
        try:
            stress_series = fetch.fetch_stress_series(token, start, end)
        except Exception as exc:
            fetch_errors["stress_series"] = str(exc)[:200]
            print("[sync] warn: stress series failed; keeping existing csv", flush=True)

    sports = []
    if not args.skip_sports:
        _fetch("activities", lambda: fetch.fetch_sports(token, start, end))

    try:
        snapshots = fetch.fetch_snapshots(token)
    except Exception as exc:
        fetch_errors["snapshots"] = str(exc)[:200]
        print(f"[sync] warn: snapshots fetch failed; keeping existing rows", flush=True)
        snapshots = {}
    if snapshots:
        snapshots["fetched_at"] = db.utcnow_iso()
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
    quality.write_quality(conn, str(DASHBOARD / "data_quality.json"))
    db.set_meta(conn, "last_sync", end.isoformat())
    db.set_meta(conn, "last_run", db.utcnow_iso())
    db.set_meta(conn, "last_fetch_errors", json.dumps(fetch_errors, ensure_ascii=False))

    print("[sync] coverage:")
    for table, info in payload["coverage"].items():
        print(f"  {table}: {info['rows']} rows {info['start']} .. {info['end']}")
    print("[sync] done", flush=True)


if __name__ == "__main__":
    main()
