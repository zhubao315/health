"""SQLite storage, CSV export and dashboard payload."""

import csv
import datetime
import gzip
import json
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
  fetched_at TEXT PRIMARY KEY, fitness_json TEXT, recovery_json TEXT,
  devices_json TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE VIEW IF NOT EXISTS daily AS
SELECT d.date,
       d.steps, d.calories, d.exercise_min,
       COALESCE(st.stress_avg, d.stress_avg) AS stress_avg,
       COALESCE(s.sleep_score, d.sleep_score) AS sleep_score,
       COALESCE(s.main_min, d.sleep_total_min) AS sleep_total_min,
       COALESCE(s.deep_pct, NULL) AS deep_pct,
       COALESCE(s.light_pct, NULL) AS light_pct,
       COALESCE(s.rem_pct, NULL) AS rem_pct,
       COALESCE(s.awake_pct, NULL) AS awake_pct,
       d.sleep_deep_min, d.sleep_light_min, d.sleep_rem_min, d.sleep_awake_min,
       d.sleep_hr_avg, d.sleep_hr_min, d.sleep_hr_max,
       h.hrv_avg, h.hrv_status, h.hrv_baseline,
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


def connect(path="data/health.db"):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def upsert(conn, table, rows):
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
    conn.execute(
        "INSERT OR REPLACE INTO snapshots (fetched_at, fitness_json, recovery_json, devices_json) VALUES (?,?,?,?)",
        (
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


def _pearson(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pairs) < 8:
        return None
    n = len(pairs)
    mx = sum(p[0] for p in pairs) / n
    my = sum(p[1] for p in pairs) / n
    cov = sum((p[0] - mx) * (p[1] - my) for p in pairs)
    vx = sum((p[0] - mx) ** 2 for p in pairs)
    vy = sum((p[1] - my) ** 2 for p in pairs)
    if vx <= 0 or vy <= 0:
        return None
    return cov / (vx**0.5 * vy**0.5)


def _correlation(rows, label, x_key, y_key, lag=0):
    by_date = {r["date"]: r for r in rows}
    xs, ys = [], []
    for row in rows:
        target = row["date"]
        if lag:
            target = (
                datetime.date.fromisoformat(row["date"])
                + datetime.timedelta(days=lag)
            ).isoformat()
        other = by_date.get(target)
        if other:
            xs.append(row.get(x_key))
            ys.append(other.get(y_key))
    r = _pearson(xs, ys)
    return {
        "label": label,
        "r": round(r, 3) if r is not None else None,
        "n": len([1 for x, y in zip(xs, ys) if x is not None and y is not None]),
    }


def dashboard_payload(conn):
    rows = [dict(r) for r in conn.execute("SELECT * FROM daily ORDER BY date")]
    coverage = {}
    for table in ["daily_health", "sleep", "hrv", "avg_hr", "rhr", "stress_daily", "load", "activities"]:
        r = conn.execute(
            f"SELECT COUNT(*) n, MIN(date) a, MAX(date) b FROM {table}"
        ).fetchone()
        coverage[table] = {"rows": r["n"], "start": r["a"], "end": r["b"]}

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
        "SELECT * FROM snapshots ORDER BY fetched_at DESC LIMIT 1"
    ).fetchone()
    snapshot = {}
    if snap:
        snapshot = {
            "fetched_at": snap["fetched_at"],
            "fitness": json.loads(snap["fitness_json"] or "{}"),
            "recovery": json.loads(snap["recovery_json"] or "{}"),
            "devices": json.loads(snap["devices_json"] or "[]"),
        }

    correlations = [
        _correlation(rows, "睡眠时长 → 次日 HRV", "sleep_total_min", "hrv_avg", 1),
        _correlation(rows, "短期负荷 → 次日静息心率", "load_short", "rhr", 1),
        _correlation(rows, "压力 → 当晚睡眠（次日记录）", "stress_avg", "sleep_total_min", 1),
        _correlation(rows, "步数 → 当晚睡眠（次日记录）", "steps", "sleep_total_min", 1),
        _correlation(rows, "睡眠时长 → 次日静息心率", "sleep_total_min", "rhr", 1),
    ]

    return {
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "coverage": coverage,
        "latest": latest,
        "snapshot": snapshot,
        "correlations": correlations,
        "daily": rows,
    }
