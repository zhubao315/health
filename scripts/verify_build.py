#!/usr/bin/env python3
"""交付前对账：脱敏 / 幂等 / 分期完整性 / 产物一致性。

用法：
    python scripts/verify_build.py
退出码非 0 表示有硬性问题（如快照仍含序列号、产物与库不一致）。
"""

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "health.db"
DATA_JSON = ROOT / "dashboard" / "data.json"
QUALITY = ROOT / "dashboard" / "data_quality.json"

problems = []


def check(cond, msg):
    print(("✅ " if cond else "❌ ") + msg)
    if not cond:
        problems.append(msg)


def main():
    check(DB.exists(), "data/health.db 存在")
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    blob = DATA_JSON.read_text()
    for needle in ("serial", "bluetooth", "Serial Number", "Bluetooth"):
        check(needle not in blob, f"data.json 不含 {needle!r}")

    conn.row_factory = sqlite3.Row
    days = conn.execute("SELECT COUNT(*) n, COUNT(DISTINCT date) d FROM snapshots").fetchone()
    check(days["n"] == days["d"], f"snapshots 每日一行（{days['n']} 行 / {days['d']} 个日期）")

    devices = conn.execute("SELECT devices_json FROM snapshots ORDER BY date DESC LIMIT 1").fetchone()
    ok_shape = True
    if devices and devices["devices_json"]:
        try:
            parsed = json.loads(devices["devices_json"])
        except ValueError:
            parsed = None
        for d in parsed or []:
            if set(d.keys()) - {"name", "model"}:
                ok_shape = False
    check(ok_shape, "设备快照仅含 name/model")

    rows = [dict(r) for r in conn.execute("SELECT * FROM daily ORDER BY date")]
    payload = json.loads(blob)
    check(len(payload["daily"]) == len(rows), f"data.json 行数与 daily 视图一致（{len(payload['daily'])}）")

    stage_bad = 0
    for row in payload["daily"]:
        for field in ("deep", "light", "rem", "awake"):
            v = row.get(field)
            if v is not None and v < 0:
                stage_bad += 1
    check(stage_bad == 0, "分期分钟无负值")

    missing_zero = sum(
        1
        for row in payload["daily"]
        if row.get("sleep_total_min") == 0 and row.get("sleep_score") is None
    )
    check(missing_zero == 0, "睡眠时长不存在伪零（0 且无睡眠分）")

    q = json.loads(QUALITY.read_text())
    check(q.get("latest_data_date") == rows[-1]["date"], "data_quality 最新日期与库一致")
    dup = {t: info["duplicate_keys"] for t, info in q["tables"].items() if info["duplicate_keys"]}
    check(not dup, f"无重复主键（{dup or '0'}）")
    check(
        q.get("sync_status") in ("ok", "warn"),
        f"sync_status = {q.get('sync_status')}（stale/empty 需人工看）",
    )

    print()
    if problems:
        print(f"FAIL: {len(problems)} 项")
        return 1
    print("VERIFY OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
