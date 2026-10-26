"""SQLite storage, CSV export and dashboard payload.

Design rules:
- Every metric stored keeps missing values as NULL.真实零值与缺失值严格区分；
  sleep stages are derived once here (from minutes, else percent × total)
  and marked with a completeness flag so the frontend never fakes a 0.
- All timestamps use UTC ISO-8601 with explicit "+00:00".
- Device snapshots never persist serial numbers / Bluetooth IDs
  (see parseDevices); legacy rows are stripped during migration.
"""

import csv
import datetime
import gzip
import json
import math
import sqlite3
from pathlib import Path

TABLES = {
    "daily_health": [
        "date",
        "steps",
        "calories",
        "exercise_min",
        "stress_avg",
        "sleep_score",
        "sleep_total_min",
        "sleep_deep_min",
        "sleep_light_min",
        "sleep_rem_min",
        "sleep_awake_min",
        "sleep_hr_avg",
        "sleep_hr_min",
        "sleep_hr_max",
    ],
    "sleep": [
        "date",
        "sleep_score",
        "main_min",
        "deep_pct",
        "light_pct",
        "rem_pct",
        "awake_pct",
        "awake_min",
        "awake_count",
        "naps_min",
        "window_start",
        "window_end",
    ],
    "hrv": [
        "date",
        "hrv_avg",
        "hrv_status",
        "hrv_normal_low",
        "hrv_normal_high",
        "hrv_baseline",
    ],
    "avg_hr": ["date", "avg_hr", "min_hr", "max_hr"],
    "rhr": ["date", "rhr"],
    "stress_daily": [
        "date",
        "stress_avg",
        "relaxed_min",
        "low_min",
        "medium_min",
        "high_min",
    ],
    "load": ["date", "load_comment", "load_short", "load_long", "load_ratio"],
    "activities": [
        "label_id",
        "sport_type",
        "sport",
        "date",
        "location",
        "distance_km",
        "duration_min",
        "avg_hr",
        "calories",
        "avg_speed_kmh",
        "avg_pace",
    ],
}

INT_TYPES = {
    "steps",
    "calories",
    "exercise_min",
    "stress_avg",
    "sleep_score",
    "sleep_total_min",
    "sleep_deep_min",
    "sleep_light_min",
    "sleep_rem_min",
    "sleep_awake_min",
    "sleep_hr_avg",
    "sleep_hr_min",
    "sleep_hr_max",
    "main_min",
    "deep_pct",
    "light_pct",
    "rem_pct",
    "awake_pct",
    "awake_min",
    "awake_count",
    "naps_min",
    "hrv_avg",
    "hrv_normal_low",
    "hrv_normal_high",
    "hrv_baseline",
    "avg_hr",
    "min_hr",
    "max_hr",
    "rhr",
    "relaxed_min",
    "low_min",
    "medium_min",
    "high_min",
    "load_short",
    "load_long",
    "sport_type",
    "avg_hr",
    "calories",
}
REAL_TYPES = {"load_ratio", "distance_km", "duration_min", "avg_speed_kmh"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS daily_health (
  date TEXT PRIMARY KEY, steps INTEGER, calories INTEGER, exercise_min INTEGER,
  stress_avg INTEGER, sleep_score INTEGER, sleep_total_min INTEGER,
  sleep_deep_min INTEGER, sleep_light_min INTEGER, sleep_rem_min INTEGER,
  sleep_awake_min INTEGER, sleep_hr_avg INTEGER, sleep_hr_min INTEGER,
  sleep_hr_max INTEGER
);
CREATE TABLE IF NOT EXISTS sleep (
  date TEXT PRIMARY KEY, sleep_score INTEGER, main_min INTEGER, deep_pct INTEGER,
  light_pct INTEGER, rem_pct INTEGER, awake_pct INTEGER, awake_min INTEGER,
  awake_count INTEGER, naps_min INTEGER, window_start TEXT, window_end TEXT
);
CREATE TABLE IF NOT EXISTS hrv (
  date TEXT PRIMARY KEY, hrv_avg INTEGER, hrv_status TEXT,
  hrv_normal_low INTEGER, hrv_normal_high INTEGER, hrv_baseline INTEGER
);
CREATE TABLE IF NOT EXISTS avg_hr (
  date TEXT PRIMARY KEY, avg_hr INTEGER, min_hr INTEGER, max_hr INTEGER
);
CREATE TABLE IF NOT EXISTS rhr (date TEXT PRIMARY KEY, rhr INTEGER);
CREATE TABLE IF NOT EXISTS stress_daily (
  date TEXT PRIMARY KEY, stress_avg INTEGER, relaxed_min INTEGER,
  low_min INTEGER, medium_min INTEGER, high_min INTEGER
);
CREATE TABLE IF NOT EXISTS load (
  date TEXT PRIMARY KEY, load_comment TEXT, load_short INTEGER,
  load_long INTEGER, load_ratio REAL
);
CREATE TABLE IF NOT EXISTS activities (
  label_id TEXT PRIMARY KEY, sport_type INTEGER, sport TEXT, date TEXT,
  location TEXT, distance_km REAL, duration_min REAL, avg_hr INTEGER,
  calories INTEGER, avg_speed_kmh REAL, avg_pace TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  date TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, fitness_json TEXT,
  recovery_json TEXT, devices_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
DROP VIEW IF EXISTS daily;
CREATE VIEW daily AS
SELECT d.date,
       d.steps, d.calories, d.exercise_min,
       COALESCE(st.stress_avg, d.stress_avg) AS stress_avg,
       COALESCE(s.sleep_score, d.sleep_score) AS sleep_score,
       COALESCE(s.main_min, d.sleep_total_min) AS sleep_total_min,
       s.naps_min,
       s.window_start, s.window_end,
       COALESCE(s.deep_pct, NULL) AS deep_pct,
       COALESCE(s.light_pct, NULL) AS light_pct,
       COALESCE(s.rem_pct, NULL) AS rem_pct,
       COALESCE(s.awake_pct, NULL) AS awake_pct,
       d.sleep_deep_min, d.sleep_light_min, d.sleep_rem_min, d.sleep_awake_min,
       d.sleep_hr_avg, d.sleep_hr_min, d.sleep_hr_max,
       h.hrv_avg, h.hrv_status, h.hrv_baseline, h.hrv_normal_low,
       h.hrv_normal_high,
       a.avg_hr, a.min_hr, a.max_hr,
       r.rhr,
       l.load_short, l.load_long, l.load_ratio, l.load_comment
FROM daily_health d
LEFT JOIN sleep s ON s.date = d.date
LEFT JOIN hrv h ON h.date = d.date
LEFT JOIN avg_hr a ON a.date = d.date
LEFT JOIN rhr r ON r.date = d.date
LEFT JOIN stress_daily st ON st.date = d.date
LEFT JOIN load l ON l.date = d.date;
"""

# Old schema (fetched_at TEXT PRIMARY KEY) -> new schema (date PK, idempotent
# per calendar day). Migrating also strips any legacy device serial numbers.
_SNAPSHOTS_MIGRATION = """
CREATE TABLE IF NOT EXISTS _snapshots_v2 (
  date TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, fitness_json TEXT,
  recovery_json TEXT, devices_json TEXT
);
INSERT OR REPLACE INTO _snapshots_v2 (date, fetched_at, fitness_json, recovery_json, devices_json)
SELECT substr(fetched_at, 1, 10) AS day, fetched_at, fitness_json, recovery_json, devices_json
FROM snapshots
WHERE fetched_at = (
  SELECT MAX(fetched_at) FROM snapshots WHERE substr(fetched_at, 1, 10) = day
);
DROP TABLE snapshots;
ALTER TABLE _snapshots_v2 RENAME TO snapshots;
"""

_SELECTABLE_META = {"last_sync", "last_run"}


def utcnow_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def connect(path="data/health.db"):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate_snapshots(conn)
    return conn


def _migrate_snapshots(conn):
    info = conn.execute("PRAGMA table_info(snapshots)").fetchall()
    cols = [r[1] for r in info]
    pk_cols = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5]]
    if "date" in cols and pk_cols == ["date"]:
        return
    conn.executescript(_SNAPSHOTS_MIGRATION)
    conn.commit()
    # Strip hardware identifiers from every legacy row (keep name/model).
    _sanitize_snapshot_rows(conn)
    conn.commit()


def _sanitize_snapshot_rows(conn):
    """Strip hardware identifiers from every stored snapshot row."""
    for row in conn.execute("SELECT date, devices_json FROM snapshots").fetchall():
        raw = row["devices_json"]
        if not raw:
            continue
        try:
            devices = json.loads(raw)
        except ValueError:
            continue
        if isinstance(devices, dict):
            devices = devices.get("devices", [])
        clean = []
        for d in devices if isinstance(devices, list) else []:
            clean.append({"name": d.get("name"), "model": d.get("model")})
        conn.execute(
            "UPDATE snapshots SET devices_json = ? WHERE date = ?",
            (json.dumps(clean, ensure_ascii=False), row["date"]),
        )
    return None


def upsert(conn, table, rows):
    """Idempotent insert-or-replace on the table's primary key.

    Every value keeps NULL for missing data; underscores never become 0.
    """
    if not rows:
        return 0
    columns = TABLES[table]
    placeholders = ",".join("?" for _ in columns)
    sql = f"INSERT OR REPLACE INTO {table} ({','.join(columns)}) VALUES ({placeholders})"
    values = []
    for row in rows:
        out = []
        for col in columns:
            value = row.get(col)
            if value is not None and col in INT_TYPES:
                try:
                    value = int(round(float(value)))
                except (TypeError, ValueError):
                    value = None
            elif value is not None and col in REAL_TYPES:
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    value = None
            out.append(value)
        values.append(out)
    conn.executemany(sql, values)
    conn.commit()
    return len(values)


def set_meta(conn, key, value):
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)", (key, str(value))
    )
    conn.commit()


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def add_snapshot(conn, payload):
    """One snapshot per calendar day (UTC date).

    Re-running the sync the same day updates the row instead of appending.
    """
    date = payload["fetched_at"][:10]
    conn.execute(
        "INSERT OR REPLACE INTO snapshots (date, fetched_at, fitness_json, recovery_json, devices_json) VALUES (?,?,?,?,?)",
        (
            date,
            payload["fetched_at"],
            json.dumps(payload["fitness"], ensure_ascii=False),
            json.dumps(payload["recovery"], ensure_ascii=False),
            json.dumps(payload["devices"], ensure_ascii=False),
        ),
    )
    conn.commit()


def export_csv(conn, table, path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    rows = conn.execute(f"SELECT * FROM {table}").fetchall()
    if not rows:
        Path(path).write_text("")
        return
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        for row in rows:
            writer.writerow(dict(row))


def export_series(path, rows, columns):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({c: row.get(c) for c in columns})


# --------------------------------------------------------------------------
# Derived metrics (shared definition file: see README 数据字典)
# --------------------------------------------------------------------------

STAGE_SOURCES = {
    # payload rows merge sleep-table percentages with daily_health minutes.
    # stage minutes: prefer real minutes (daily_health), else percent × total
    # (sleep table), else None — never 0 for missing.
    "deep": ("sleep_deep_min", "deep_pct"),
    "light": ("sleep_light_min", "light_pct"),
    "rem": ("sleep_rem_min", "rem_pct"),
    "awake": ("sleep_awake_min", "awake_pct"),
}


def derive_stage_min(row, minutes_key, pct_key):
    """Derive one sleep stage in minutes.

    Order: real minutes (daily_health) → percent of total (sleep table) →
    None. A genuinely None result marks the stage as missing so the frontend
    can say «分期缺失» instead of drawing a fake 0 bar.
    """
    minutes = row.get(minutes_key)
    if minutes is not None:
        return minutes
    total = row.get("sleep_total_min")
    pct = row.get(pct_key)
    if total is not None and pct is not None:
        return round(total * pct / 100)
    return None


def sleep_stage_metrics(row):
    stages = {
        key: derive_stage_min(row, minutes_key, pct_key)
        for key, (minutes_key, pct_key) in STAGE_SOURCES.items()
    }
    known = sum(1 for v in stages.values() if v is not None)
    stages["stage_completeness"] = known / len(stages)
    return stages


# --------------------------------------------------------------------------
# Correlations
# --------------------------------------------------------------------------


def _mean(values):
    return sum(values) / len(values) if values else 0.0


def pearson_with_ci(xs, ys):
    """Pearson r, sample size and a 95% CI (Fisher-z).

    Returns (r, n, ci_low, ci_high) with r=None when the correlation is
    undefined (constant inputs / insufficient overlap).
    """
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    n = len(pairs)
    if n < 8:
        return None, n, None, None
    mx, my = _mean([p[0] for p in pairs]), _mean([p[1] for p in pairs])
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    vx = sum((x - mx) ** 2 for x, _ in pairs)
    vy = sum((y - my) ** 2 for _, y in pairs)
    if vx <= 0 or vy <= 0:
        return None, n, None, None
    r = cov / (vx**0.5 * vy**0.5)
    r = max(-1.0, min(1.0, r))
    # Fisher z CI (undefined at r = ±1 → CI degenerates to the point itself)
    if n >= 4:
        if r >= 1.0:
            ci = (1.0, 1.0)
        elif r <= -1.0:
            ci = (-1.0, -1.0)
        else:
            z = 0.5 * math.log((1 + r) / (1 - r))
            se = 1 / math.sqrt(max(n - 3, 1))
            lo, hi = z - 1.96 * se, z + 1.96 * se
            ci = (
                (math.exp(2 * lo) - 1) / (math.exp(2 * lo) + 1),
                (math.exp(2 * hi) - 1) / (math.exp(2 * hi) + 1),
            )
    else:
        ci = (None, None)
    return r, n, ci[0], ci[1]


def _pairs(rows, x_key, y_key, by_date, delta_days):
    """Aligned (x, y) samples.

    Delta-days pairs a *calendar day* row (steps/stress/load: 北京时间自然日)
    with a *next-morning* row (sleep/HRV: 按醒来日索引). lag>0 shifts the
    paired y forward so e.g.「睡眠 → 次日 HRV」becomes lag=1.
    """
    xs, ys = [], []
    for row in rows:
        target = (
            datetime.date.fromisoformat(row["date"]) + datetime.timedelta(days=delta_days)
        ).isoformat()
        other = by_date.get(target)
        if not other:
            continue
        x = row.get(x_key)
        y = other.get(y_key)
        if x is None and y is None:
            continue
        xs.append(x)
        ys.append(y)
    return xs, ys


def _correlation(rows, label, x_key, y_key, lag=0):
    by_date = {r["date"]: r for r in rows}
    xs, ys = _pairs(rows, x_key, y_key, by_date, lag)
    r, n, lo, hi = pearson_with_ci(xs, ys)
    return {
        "label": label,
        "r": round(r, 3) if r is not None else None,
        "n": n,
        "ci_low": round(lo, 3) if lo is not None else None,
        "ci_high": round(hi, 3) if hi is not None else None,
        "lag": lag,
        "x_unit": _UNITS.get(x_key, ""),
        "y_unit": _UNITS.get(y_key, ""),
    }


UNITS = {
    "sleep_total_min": "min",
    "hrv_avg": "ms",
    "rhr": "bpm",
    "stress_avg": "分",
    "steps": "步",
    "load_short": "负荷",
    "load_long": "负荷",
    "avg_hr": "bpm",
}
_UNITS = UNITS

# 唯一权威的滞后相关清单（dashboard、analytics/metrics.json 共享）
CORRELATION_SPECS = [
    ("睡眠时长 → 次日 HRV", "sleep_total_min", "hrv_avg", 1),
    ("短期负荷 → 次日静息心率", "load_short", "rhr", 1),
    ("压力 → 当晚睡眠（次日记录）", "stress_avg", "sleep_total_min", 1),
    ("步数 → 当晚睡眠（次日记录）", "steps", "sleep_total_min", 1),
    ("睡眠时长 → 次日静息心率", "sleep_total_min", "rhr", 1),
]


def correlations(rows):
    return [
        _correlation(rows, label, x_key, y_key, lag)
        for label, x_key, y_key, lag in CORRELATION_SPECS
    ]


# --------------------------------------------------------------------------
# Dashboard payload
# --------------------------------------------------------------------------


def dashboard_payload(conn):
    """Full dashboard payload.

    All rows carry:
    - stage minutes with a completeness ratio (missing stays null)
    - explicit nulls (never 0) for missing metric values
    """
    rows = [dict(r) for r in conn.execute("SELECT * FROM daily ORDER BY date")]
    rows = [decorate_row(row) for row in rows]

    coverage = {}
    for table in ["daily_health", "sleep", "hrv", "avg_hr", "rhr", "stress_daily", "load", "activities"]:
        r = conn.execute(
            f"SELECT COUNT(*) n, MIN(date) a, MAX(date) b FROM {table}"
        ).fetchone()
        coverage[table] = {"rows": r["n"], "start": r["a"], "end": r["b"]}

    # "latest" snapshot = latest calendar day on which that value exists.
    # Every KPI records its own date so the frontend can show 数据日期.
    latest = {}
    for key in [
        "steps",
        "calories",
        "exercise_min",
        "stress_avg",
        "sleep_total_min",
        "sleep_score",
        "sleep_hr_avg",
        "hrv_avg",
        "hrv_baseline",
        "rhr",
        "avg_hr",
        "load_short",
        "load_long",
        "load_ratio",
    ]:
        value = None
        date = None
        for row in reversed(rows):
            if row.get(key) is not None:
                value = row[key]
                date = row["date"]
                break
        latest[key] = {"value": value, "date": date}

    snap = conn.execute(
        "SELECT * FROM snapshots ORDER BY date DESC LIMIT 1"
    ).fetchone()
    snapshot = {}
    if snap:
        snapshot = {
            "date": snap["date"],
            "fetched_at": snap["fetched_at"],
            "fitness": json.loads(snap["fitness_json"] or "{}"),
            "recovery": json.loads(snap["recovery_json"] or "{}"),
            "devices": json.loads(snap["devices_json"] or "[]"),
        }

    corr = correlations(rows)

    return {
        "generated_at": utcnow_iso(),
        "coverage": coverage,
        "latest": latest,
        "snapshot": snapshot,
        "correlations": corr,
        "daily": rows,
        "activities_recent": recent_activities(conn, 90),
        **analytics_blocks(conn),
    }


def recent_activities(conn, days=90):
    """运动记录（近 N 天）用于训练联动详情。

    裁剪字段：去掉 location / label_id / avg_speed_kmh（控制公开 JSON 体积
    与不必要的元数据）；仅当用户点击具体日期详情时按日期对齐展示。
    """
    rows = conn.execute(
        """
        SELECT date, sport, sport_type, distance_km, duration_min, avg_hr, calories
        FROM activities
        WHERE date >= date((SELECT MAX(date) FROM daily_health), ?)
        ORDER BY date, label_id
        """,
        (f"-{days} days",),
    ).fetchall()
    return [
        {
            "date": r["date"],
            "sport": r["sport"],
            "sport_type": r["sport_type"],
            "distance_km": r["distance_km"],
            "duration_min": r["duration_min"],
            "avg_hr": r["avg_hr"],
            "calories": r["calories"],
        }
        for r in rows
    ]


def analytics_blocks(conn):
    """Attach rolling series + insights (from analytics.build) without
    duplicating the daily rows."""
    from . import analytics

    payload = analytics.build(conn, write_metrics=True)
    return {"series": payload["series"], "insights": payload["insights"]}


def decorate_row(row):
    """Attach derived sleep-stage fields to one daily row (单一实现)."""
    sleep = sleep_stage_metrics(row)
    row.update(sleep)
    return row
