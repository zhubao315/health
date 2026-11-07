#!/usr/bin/env python3
"""Build the cross-sport Activity Data Layer summary for the health dashboard.

Read-only over the three sport repositories: it never edits their
activities.json, never zero-fills a missing field, and keeps every record's
source + source_activity_id. The output is an aggregate index, not a copy of
raw activities.

Layer schema (per activity, documented for consumers):
    activity_id, sport_type, start_time, distance_m, duration_s,
    elevation_gain_m, elevation_loss_m, avg_heart_rate, max_heart_rate,
    training_load, source, source_activity_id

Fields a device never recorded stay null end-to-end. Distance is never added
across sports; duration and elevation are additive but only over the records
that actually carry the field (coverage is reported next to every total).
"""
import argparse
import csv
import datetime
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "dashboard", "cross_sport.json")

SPORTS = {
    "running": {
        "repo": "zhubao315/running",
        "branch": "master",
        "sport_type": "run",
        "local": os.path.join(os.path.dirname(HERE), "running", "src", "static", "activities.json"),
    },
    "cycling": {
        "repo": "zhubao315/cycling",
        "branch": "main",
        "sport_type": "ride",
        "local": os.path.join(os.path.dirname(HERE), "cycling", "src", "static", "activities.json"),
    },
    "hiking": {
        "repo": "zhubao315/hiking",
        "branch": "main",
        "sport_type": "hike",
        "local": os.path.join(os.path.dirname(HERE), "hiking", "src", "static", "activities.json"),
    },
}


def duration_seconds(value):
    if not value:
        return None
    parts = [int(p) for p in str(value).split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def load_json(sport, cfg, remote):
    if remote:
        url = (
            f"https://raw.githubusercontent.com/{cfg['repo']}/{cfg['branch']}"
            "/src/static/activities.json"
        )
        with urllib.request.urlopen(url, timeout=60) as response:
            return json.load(response)
    path = cfg["local"]
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    return json.load(open(path, encoding="utf-8"))


def empty_bucket():
    return {
        "count": 0,
        "distance_km": 0.0,
        "duration_h": 0.0,
        "elevation_gain_m": 0.0,
        "elevation_records": 0,
        "hr_records": 0,
    }


def add(bucket, distance_km, duration_s, gain, hr):
    bucket["count"] += 1
    bucket["distance_km"] += distance_km or 0.0
    bucket["duration_h"] += (duration_s or 0) / 3600.0
    if gain:
        bucket["elevation_gain_m"] += gain
        bucket["elevation_records"] += 1
    if hr:
        bucket["hr_records"] += 1


def round_bucket(b):
    return {
        "count": b["count"],
        "distance_km": round(b["distance_km"], 2),
        "duration_h": round(b["duration_h"], 2),
        "elevation_gain_m": round(b["elevation_gain_m"]) if b["elevation_records"] else None,
        "elevation_records": b["elevation_records"],
        "hr_records": b["hr_records"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote", action="store_true", help="fetch from GitHub instead of sibling clones")
    args = parser.parse_args()

    years = {}
    months = {}
    sources = []
    career = {name: empty_bucket() for name in SPORTS}
    seen = set()

    for name, cfg in SPORTS.items():
        try:
            raw = load_json(name, cfg, args.remote)
        except Exception as exc:  # network/disk failure: keep the previous file
            print(f"WARN: {name}: {exc}", file=sys.stderr)
            return 0
        kept = 0
        for activity in raw:
            rid = activity.get("run_id")
            key = (name, rid)
            if rid is None or key in seen:
                continue
            seen.add(key)
            date = str(activity.get("start_date_local") or "")[:10]
            distance_m = activity.get("distance")
            seconds = duration_seconds(activity.get("moving_time"))
            if not date or distance_m in (None, 0) or seconds in (None, 0):
                continue
            year = int(date[:4])
            month_key = date[:7]
            gain = activity.get("elevation_gain")
            hr = activity.get("average_heartrate")
            distance_km = float(distance_m) / 1000.0
            kept += 1

            years.setdefault(year, {n: empty_bucket() for n in SPORTS})
            add(years[year][name], distance_km, seconds, gain, hr)
            months.setdefault(month_key, {n: 0 for n in SPORTS})
            months[month_key][name] += 1
            add(career[name], distance_km, seconds, gain, hr)

        data_years = sorted(
            int(str(a.get("start_date_local"))[:4])
            for a in raw
            if a.get("start_date_local")
        )
        sources.append(
            {
                "sport": name,
                "repo": cfg["repo"],
                "branch": cfg["branch"],
                "sport_type": cfg["sport_type"],
                "records_raw": len(raw),
                "records_used": kept,
                "date_first": str(min(data_years)) if data_years else None,
                "date_last": str(max(data_years)) if data_years else None,
            }
        )

    year_rows = []
    for year in sorted(years):
        sports = {n: round_bucket(years[year][n]) for n in SPORTS}
        duration = sum(sports[n]["duration_h"] for n in SPORTS)
        elevation = sum(sports[n]["elevation_gain_m"] or 0 for n in SPORTS)
        year_rows.append(
            {
                "year": year,
                "sports": sports,
                "totals": {
                    "count": sum(sports[n]["count"] for n in SPORTS),
                    "duration_h": round(duration, 2),
                    "elevation_gain_m": round(elevation) if elevation else None,
                },
            }
        )

    recent_months = [
        {"month": key, **months[key]} for key in sorted(months)[-24:]
    ]

    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "layer_version": 1,
        "schema": [
            "activity_id",
            "sport_type",
            "start_time",
            "distance_m",
            "duration_s",
            "elevation_gain_m",
            "elevation_loss_m",
            "avg_heart_rate",
            "max_heart_rate",
            "training_load",
            "source",
            "source_activity_id",
        ],
        "notes": [
            "distance is reported per sport and never summed across sports",
            "elevation_loss is not recorded by any device export and stays null",
            "training_load comes from the COROS health archive, not from these sport exports",
            "records are de-duplicated by (source, source_activity_id)",
        ],
        "sources": sources,
        "career": {n: round_bucket(b) for n, b in career.items()},
        "years": year_rows,
        "recent_months": recent_months,
    }
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"wrote {OUT}: {len(year_rows)} years, {len(recent_months)} months")
    return 0


if __name__ == "__main__":
    sys.exit(main())
