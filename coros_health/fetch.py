"""Fetch all COROS health data through MCP, with date-range chunking."""

import datetime
import json
import time

from . import parse
from .mcp import RangeError, call_tool


def _d(value):
    return datetime.date.fromisoformat(value)


def date_chunks(start, end, days):
    current = start
    while current <= end:
        stop = min(current + datetime.timedelta(days=days - 1), end)
        yield current, stop
        current = stop + datetime.timedelta(days=1)


def _range_call(token, tool, start, end, chunk_days, parser, label):
    rows = []
    current = start
    while current <= end:
        stop = min(current + datetime.timedelta(days=chunk_days - 1), end)
        args = {"startDate": current.strftime("%Y%m%d"), "endDate": stop.strftime("%Y%m%d")}
        while True:
            try:
                text = call_tool(token, tool, args)
                break
            except RangeError:
                if chunk_days <= 7:
                    raise
                chunk_days = max(7, chunk_days // 3)
                stop = min(current + datetime.timedelta(days=chunk_days - 1), end)
                args["endDate"] = stop.strftime("%Y%m%d")
                print(f"[fetch] {label}: shrinking window to {chunk_days} days", flush=True)
        parsed = parser(text)
        if isinstance(parsed, tuple):
            rows.extend(parsed[0])
        else:
            rows.extend(parsed)
        print(
            f"[fetch] {label} {current}..{stop}: {len(parsed[0]) if isinstance(parsed, tuple) else len(parsed)} rows",
            flush=True,
        )
        current = stop + datetime.timedelta(days=1)
        time.sleep(1.2)
    return rows


def fetch_daily_health(token, start, end):
    days = (end - start).days + 3
    for candidate in [days, 1000, 500, 180, 90]:
        if candidate <= 0:
            continue
        try:
            text = call_tool(token, "queryDailyHealthData", {"days": min(candidate, days)})
            rows = parse.parse_daily_health(text)
            print(f"[fetch] daily health: {len(rows)} rows", flush=True)
            return rows
        except RangeError:
            continue
        finally:
            time.sleep(1.2)
    return []


def fetch_sleep(token, start, end):
    return _range_call(
        token, "querySleepOverview", start, end, 90, parse.parse_sleep_overview, "sleep"
    )


def fetch_hrv(token, start, end):
    assessments, series = [], []
    current = start
    while current <= end:
        stop = min(current + datetime.timedelta(days=6), end)
        text = call_tool(
            token,
            "querySleepHrv",
            {
                "startDate": current.strftime("%Y%m%d"),
                "endDate": stop.strftime("%Y%m%d"),
            },
        )
        a, s = parse.parse_hrv(text)
        assessments.extend(a)
        series.extend(s)
        print(f"[fetch] hrv {current}..{stop}: {len(a)} days, {len(s)} points", flush=True)
        current = stop + datetime.timedelta(days=1)
        time.sleep(1.2)
    return assessments, series


def fetch_avg_hr(token, start, end):
    return _range_call(
        token, "queryAvgHeartRate", start, end, 90, parse.parse_avg_hr, "avg_hr"
    )


def fetch_rhr(token, start, end):
    rows = []
    current = start
    while current <= end:
        days = min(365, (end - current).days + 1)
        text = call_tool(token, "queryRestingHeartRate", {"days": days})
        rows.extend(parse.parse_rhr(text))
        print(f"[fetch] rhr {current}: {len(rows)} rows", flush=True)
        current += datetime.timedelta(days=days)
        time.sleep(1.2)
    return rows


def fetch_stress_daily(token, start, end):
    rows = []
    current = start
    while current <= end:
        days = min(365, (end - current).days + 1)
        text = call_tool(token, "queryStressLevel", {"days": days})
        rows.extend(parse.parse_stress_daily(text))
        print(f"[fetch] stress daily {current}: {len(rows)} rows", flush=True)
        current += datetime.timedelta(days=days)
        time.sleep(1.2)
    return rows


def fetch_stress_series(token, start, end):
    return _range_call(
        token,
        "queryStressTimeSeries",
        start,
        end,
        7,
        parse.parse_stress_series,
        "stress_series",
    )


def fetch_load(token, start, end):
    rows = []
    current = start
    while current <= end:
        days = min(365, (end - current).days + 1)
        text = call_tool(token, "queryTrainingLoadAssessment", {"days": days})
        rows.extend(parse.parse_load(text))
        print(f"[fetch] load {current}: {len(rows)} rows", flush=True)
        current += datetime.timedelta(days=days)
        time.sleep(1.2)
    return rows


def fetch_sports(token, start, end):
    rows = []
    for first, last in date_chunks(start, end, 31):
        text = call_tool(
            token,
            "querySportRecords",
            {
                "startDate": first.strftime("%Y%m%d"),
                "endDate": last.strftime("%Y%m%d"),
                "limit": 500,
            },
        )
        rows.extend(parse.parse_sports(text))
        print(f"[fetch] sports {first}..{last}: {len(rows)} rows", flush=True)
        time.sleep(1.2)
    return rows


def fetch_snapshots(token):
    fitness_text = call_tool(token, "queryFitnessAssessmentOverview", {})
    time.sleep(1.2)
    recovery_text = call_tool(token, "queryRecoveryStatus", {})
    time.sleep(1.2)
    devices_text = call_tool(token, "queryDevices", {})
    return {
        "fitness": parse.parse_fitness(fitness_text),
        "recovery": parse.parse_recovery(recovery_text),
        "devices": parse.parse_devices(devices_text),
    }
