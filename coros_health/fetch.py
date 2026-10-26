"""Fetch all COROS health data through MCP, with date-range chunking."""

import datetime
import json
import time

from . import parse
from .mcp import RangeError, TransientError, call_tool

# A window whose server keeps answering "unavailable" is skipped rather than
# allowed to abort the whole rebuild — but a run of consecutive skips means
# the gateway is really down, so stop after this many.
MAX_SAFE_SKIPS = 5


def _d(value):
    return datetime.date.fromisoformat(value)


def date_chunks(start, end, days):
    current = start
    while current <= end:
        stop = min(current + datetime.timedelta(days=days - 1), end)
        yield current, stop
        current = stop + datetime.timedelta(days=1)


_DAYS_LADDER = (3650, 1000, 365, 180, 90, 30, 7, 1)


def _last_n_days(token, tool, total, parser, label, extra=()):
    """Fetch tools whose only argument is a plain "recent N days" window.

    These APIs have a server-side cap on `days`: a full-history rebuild asks
    for ~1000+ days and gets rejected ("date is out of range"), which used to
    abort the whole sync. Probe a descending ladder instead so every window
    size the API accepts is tried, keep as much as it allows, and let the
    untouched older rows in the database carry the rest of the history.
    """
    candidates = [total] + [d for d in (*extra, *_DAYS_LADDER) if d < total]
    ordered = []
    for c in candidates:
        if c >= 1 and c not in ordered:
            ordered.append(c)
    for days in ordered:
        try:
            text = call_tool(token, tool, {"days": days})
        except RangeError:
            continue
        rows = parser(text)
        print(f"[fetch] {label} last {days}d: {len(rows)} rows", flush=True)
        time.sleep(1.2)
        return rows
    print(
        f"[fetch] {label}: every window size rejected; keeping existing database rows",
        flush=True,
    )
    time.sleep(1.2)
    return []


def _range_call(token, tool, start, end, chunk_days, parser, label):
    rows = []
    current = start
    skips = 0
    while current <= end:
        stop = min(current + datetime.timedelta(days=chunk_days - 1), end)
        args = {"startDate": current.strftime("%Y%m%d"), "endDate": stop.strftime("%Y%m%d")}
        skipped, text = False, None
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
            except TransientError as exc:
                skips += 1
                print(
                    f"[fetch] {label} {current}..{stop}: skipped ({exc})"
                    + (f" — {skips} consecutive skips" if skips >= 2 else ""),
                    flush=True,
                )
                if skips >= MAX_SAFE_SKIPS:
                    raise
                skipped = True
                break
        if not skipped:
            skips = 0
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
    total = (end - start).days + 3
    return _last_n_days(token, "queryDailyHealthData", total, parse.parse_daily_health, "daily health", extra=(500,))


def fetch_sleep(token, start, end):
    return _range_call(
        token, "querySleepOverview", start, end, 90, parse.parse_sleep_overview, "sleep"
    )


def fetch_hrv(token, start, end):
    assessments, series = [], []
    current = start
    skips = 0
    while current <= end:
        stop = min(current + datetime.timedelta(days=6), end)
        try:
            text = call_tool(
                token,
                "querySleepHrv",
                {
                    "startDate": current.strftime("%Y%m%d"),
                    "endDate": stop.strftime("%Y%m%d"),
                },
            )
        except TransientError as exc:
            skips += 1
            print(
                f"[fetch] hrv {current}..{stop}: skipped ({exc})"
                + (f" — {skips} consecutive skips" if skips >= 2 else ""),
                flush=True,
            )
            if skips >= MAX_SAFE_SKIPS:
                raise
            current = stop + datetime.timedelta(days=1)
            time.sleep(1.2)
            continue
        except RangeError:
            # single-week window rejected is as good as empty for this range
            current = stop + datetime.timedelta(days=1)
            time.sleep(1.2)
            continue
        skips = 0
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
    """queryRestingHeartRate is anchored at *now* (最近 N 天语义).

    So the honest request is a single call covering (start..end] measured
    backwards from `end`, never a bogus loop of per-chunk "last 365 days".
    The server caps that window: probe a descending ladder on rejection.
    """
    total = max(1, (end - start).days + 1)
    return _last_n_days(token, "queryRestingHeartRate", total, parse.parse_rhr, "rhr")


def fetch_stress_daily(token, start, end):
    total = max(1, (end - start).days + 1)
    return _last_n_days(token, "queryStressLevel", total, parse.parse_stress_daily, "stress daily")


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
    total = max(1, (end - start).days + 1)
    return _last_n_days(token, "queryTrainingLoadAssessment", total, parse.parse_load, "load")


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
