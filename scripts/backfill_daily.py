#!/usr/bin/env python3
"""Backfill daily HRV / RHR / load from the legacy COROS web API.

The MCP tool needs one call per 7 days for HRV; the legacy
`/analyse/dayDetail/query` returns ~24 weeks per call. Use this once to seed
history, then the daily MCP sync keeps it current.
"""

import datetime
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coros_health import db

LOGIN_URL = "https://teamcnapi.coros.com/account/login"
DETAIL_URL = "https://teamcnapi.coros.com/analyse/dayDetail/query"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36"


def login(account, password):
    req = urllib.request.Request(
        LOGIN_URL,
        data=json.dumps(
            {
                "account": account,
                "accountType": 2,
                "pwd": hashlib.md5(password.encode()).hexdigest(),
            }
        ).encode(),
        headers={
            "content-type": "application/json;charset=UTF-8",
            "accept": "application/json",
            "origin": "https://t.coros.com",
            "referer": "https://t.coros.com/",
            "user-agent": UA,
        },
    )
    body = json.load(urllib.request.urlopen(req, timeout=30))
    token = body.get("data", {}).get("accessToken")
    if not token:
        raise SystemExit(f"login failed: {body.get('message')}")
    return {
        "accesstoken": token,
        "cookie": f"CPL-coros-region=2; CPL-coros-token={token}",
        "user-agent": UA,
    }


def chunks(start, end, days=168):
    current = start
    while current <= end:
        stop = min(current + datetime.timedelta(days=days - 1), end)
        yield current, stop
        current = stop + datetime.timedelta(days=1)


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2024-01-01")
    parser.add_argument("--end", default=datetime.date.today().isoformat())
    parser.add_argument("--only-rhr", action="store_true")
    args = parser.parse_args()
    start = datetime.date.fromisoformat(args.start)
    end = datetime.date.fromisoformat(args.end)
    headers = login(os.environ["COROS_ACCOUNT"], os.environ["COROS_PASSWORD"])
    conn = db.connect("data/health.db")

    hrv_rows, rhr_rows, load_rows = [], [], []
    for first, last in chunks(start, end):
        url = DETAIL_URL + "?" + urllib.parse.urlencode(
            {"startDay": first.strftime("%Y%m%d"), "endDay": last.strftime("%Y%m%d")}
        )
        body = json.load(
            urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60)
        )
        if body.get("result") != "0000":
            raise SystemExit(f"analyse error: {body.get('message')}")
        days = body.get("data", {}).get("dayList", [])
        for item in days:
            day = str(item.get("happenDay"))
            if not day or len(day) != 8:
                continue
            date = f"{day[:4]}-{day[4:6]}-{day[6:]}"
            if not args.only_rhr and (
                item.get("avgSleepHrv") is not None
                or item.get("sleepHrvBase") is not None
            ):
                hrv_rows.append(
                    {
                        "date": date,
                        "hrv_avg": item.get("avgSleepHrv"),
                        "hrv_baseline": item.get("sleepHrvBase"),
                    }
                )
            if item.get("rhr") is not None:
                rhr_rows.append({"date": date, "rhr": item.get("rhr")})
            if not args.only_rhr and (
                item.get("ati") is not None or item.get("cti") is not None
            ):
                load_rows.append(
                    {
                        "date": date,
                        "load_short": item.get("ati"),
                        "load_long": item.get("cti"),
                        "load_ratio": item.get("trainingLoadRatio"),
                    }
                )
        print(f"[legacy] {first}..{last}: {len(days)} days", flush=True)
        time.sleep(2)

    print(
        f"[legacy] hrv={db.upsert(conn, 'hrv', hrv_rows)} "
        f"rhr={db.upsert(conn, 'rhr', rhr_rows)} load={db.upsert(conn, 'load', load_rows)}"
    )
    # Keep CSV exports and the dashboard consistent with the corrected RHR.
    db.export_csv(conn, "rhr", "data/rhr.csv")
    db.export_csv(conn, "daily", "data/daily.csv")
    payload = db.dashboard_payload(conn)
    Path("dashboard/data.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


if __name__ == "__main__":
    main()
