"""Data-quality audit → dashboard/data_quality.json.

Checks (all read-only, no data mutation):
- 最新数据日期 & 同步新鲜度（meta.last_run / last_sync vs 今天）
- 每个指标的缺失率（总量 + 最近 30/90 天）
- 日期断档（>1 天的空洞）与主键重复
- 伪零值（生理上不可能为 0 的指标出现 0）
- 异常值（滚动 MAD 的稳健 z 分数）
- 各表覆盖范围

输出字段命名与 README 数据字典一致，前端据此显示数据状态。
"""

import datetime
import json
import statistics
import sqlite3
from pathlib import Path

ValueType = int | float | None

# Physically impossible zeros (only steps/calories/exercise may be真 0).
NEVER_ZERO = {
    "sleep_total_min",
    "hrv_avg",
    "rhr",
    "avg_hr",
    "stress_avg",
    "sleep_score",
    "load_short",
    "load_long",
}

METRIC_ROWS = [
    # key, label, unit, 醒来日(True)/自然日(False), 稳健异常窗口
    ("sleep_total_min", "睡眠时长", "min", True, 60),
    ("sleep_score", "睡眠分", "分", True, 90),
    ("sleep_hr_avg", "睡眠均心率", "bpm", True, None),
    ("hrv_avg", "夜间HRV", "ms", True, 60),
    ("rhr", "静息心率", "bpm", False, 60),
    ("avg_hr", "日均心率", "bpm", False, None),
    ("stress_avg", "平均压力", "分", False, 60),
    ("steps", "步数", "步", False, None),
    ("load_short", "短期负荷", "负荷", False, 90),
    ("load_long", "长期负荷", "负荷", False, None),
    ("load_ratio", "负荷比", "比值", False, 90),
]


def _date_list(conn, table, column="date"):
    return [r[0] for r in conn.execute(f"SELECT {column} FROM {table} ORDER BY {column}")]


def find_gaps(dates):
    """Return [(before_date, after_date, missing_days), ...]."""
    parsed = sorted(datetime.date.fromisoformat(d) for d in dates)
    return [
        (a.isoformat(), b.isoformat(), (b - a).days - 1)
        for a, b in zip(parsed, parsed[1:])
        if (b - a).days > 1
    ]


def rolling_mad_anomalies(values, window, threshold=3.5, min_pairs=20):
    """Indices where |value − rolling median| > threshold·MAD (稳健 z)."""
    flags = []
    for i in range(len(values)):
        window_vals = [v for v in values[max(0, i - window) : i] if v is not None]
        value = values[i]
        if value is None or len(window_vals) < min_pairs:
            continue
        med = statistics.median(window_vals)
        mad = statistics.median(abs(v - med) for v in window_vals)
        if mad == 0 and value == med:
            continue
        z = 0.6745 * (value - med) / mad if mad else float("inf")
        if abs(z) > threshold:
            flags.append((i, round(z, 2)))
    return flags


def missing_rate(rows, key, window_days=None):
    recent = rows
    if window_days:
        recent = rows[-window_days:]
    if not recent:
        return None, None
    miss = sum(1 for r in recent if r.get(key) is None)
    return round(miss / len(recent), 4), miss


def zero_stats(rows, key):
    total = sum(1 for r in rows if r.get(key) == 0)
    if total and key in NEVER_ZERO:
        samples = [r["date"] for r in rows if r.get(key) == 0][-3:]
        return {"zeros": total, "last_dates": samples, "suspicious": True}
    return {"zeros": total, "suspicious": False}


def beijing_today():
    tz = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz).date()


def audit(conn, today=None):
    """Produce the data_quality dict."""
    today = today or beijing_today()
    rows = [dict(r) for r in conn.execute("SELECT * FROM daily ORDER BY date")]
    latest_date = rows[-1]["date"] if rows else None
    days_since = (
        (today - datetime.date.fromisoformat(latest_date)).days if latest_date else None
    )
    sync_status = "empty" if latest_date is None else ("stale" if days_since > 2 else "ok")

    meta = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM meta")}
    last_run = meta.get("last_run")
    # table → error message, recorded by cli when a fetch step failed but the
    # dashboard was still built from existing rows
    try:
        fetch_errors = json.loads(meta.get("last_fetch_errors") or "{}")
    except ValueError:
        fetch_errors = {}
    if fetch_errors and sync_status == "ok":
        sync_status = "warn"

    metrics = {}
    for key, label, unit, wake_day, an_window in METRIC_ROWS:
        miss_total, miss_n = missing_rate(rows, key)
        miss_30, _ = missing_rate(rows, key, 30)
        miss_90, _ = missing_rate(rows, key, 90)
        zero = zero_stats(rows, key)
        values = [r.get(key) for r in rows]
        flagged = rolling_mad_anomalies(values, an_window) if an_window else []
        anomalies = [
            {"date": rows[i]["date"], "value": values[i], "robust_z": z}
            for i, z in flagged[-5:]
        ]
        non_null = [v for v in values if v is not None]
        metrics[key] = {
            "label": label,
            "unit": unit,
            "wake_day_indexed": wake_day,
            "missing_total": miss_total,
            "missing_30d": miss_30,
            "missing_90d": miss_90,
            "zeros": zero,
            "anomaly_count": len(flagged),
            "anomalies_recent": anomalies,
            "p50": round(statistics.median(non_null), 1) if non_null else None,
            "obs_days": len(non_null),
        }

    gaps = {}
    for table in ["daily_health", "sleep", "hrv", "avg_hr", "rhr", "stress_daily", "load"]:
        dates = _date_list(conn, table)
        found = find_gaps(dates)
        if found:
            gaps[table] = found[-3:]

    tables = {}
    pk_column = {**{t: "date" for t in [
        "daily_health", "sleep", "hrv", "avg_hr", "rhr", "stress_daily", "load"
    ]}, "activities": "label_id"}
    for table in ["daily_health", "sleep", "hrv", "avg_hr", "rhr", "stress_daily", "load", "activities"]:
        key = pk_column[table]
        r = conn.execute(
            f"SELECT COUNT(*) n, COUNT(DISTINCT {key}) d, MIN(date) a, MAX(date) b FROM {table}"
        ).fetchone()
        tables[table] = {
            "rows": r["n"],
            "unique_keys": r["d"],
            "duplicate_keys": r["n"] - r["d"],
            "primary_key": key,
            "start": r["a"],
            "end": r["b"],
        }

    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "today_utc8": today.isoformat(),
        "latest_data_date": latest_date,
        "days_since_latest": days_since,
        "sync_status": sync_status,
        "last_sync": meta.get("last_sync"),
        "last_run": last_run,
        "partial_fetch_errors": fetch_errors or None,
        "metrics": metrics,
        "date_gaps": gaps,
        "tables": tables,
    }
    return payload


def write_quality(conn, path="dashboard/data_quality.json", today=None):
    payload = audit(conn, today=today)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )
    return payload
