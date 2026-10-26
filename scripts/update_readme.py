#!/usr/bin/env python3
"""Refresh the coverage table in README.md from data/health.db."""

import re
import sqlite3
from pathlib import Path

START = "<!-- STATS:START -->"
END = "<!-- STATS:END -->"

NAMES = {
    "daily_health": "每日健康汇总",
    "sleep": "睡眠",
    "hrv": "HRV",
    "avg_hr": "日均心率",
    "rhr": "静息心率",
    "stress_daily": "压力（日）",
    "load": "训练负荷",
    "activities": "运动记录",
}


def main():
    conn = sqlite3.connect("data/health.db")
    lines = [
        START,
        "| 数据表 | 行数 | 开始 | 结束 |",
        "| --- | ---: | --- | --- |",
    ]
    latest = None
    for table, name in NAMES.items():
        row = conn.execute(
            f"SELECT COUNT(*) n, MIN(date) a, MAX(date) b FROM {table}"
        ).fetchone()
        lines.append(f"| {name} | {row[0]:,} | {row[1] or '—'} | {row[2] or '—'} |")
        if row[2] and (latest is None or row[2] > latest):
            latest = row[2]
    lines.append(END)
    lines.append("")
    lines.append(f"> 最新数据：**{latest or '—'}** · 每天早上 08:00（北京时间）自动同步。")

    path = Path("README.md")
    content = path.read_text()
    if START not in content or END not in content:
        raise SystemExit("stats markers missing in README.md")
    content = re.sub(
        re.escape(START) + r".*?" + re.escape(END) + r"(?:\n\n> 最新数据：.*?自动同步。)?",
        "\n".join(lines),
        content,
        flags=re.S,
    )
    path.write_text(content)
    print(f"updated README.md, latest {latest}")


if __name__ == "__main__":
    main()
