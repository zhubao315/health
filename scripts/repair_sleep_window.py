#!/usr/bin/env python3
"""Repair sleep window fields broken by the old first-hyphen split.

The legacy parser split "Main Sleep Window: 2026-10-25 22:31 - 2026-10-26
06:13" at the hyphen *inside the date*, producing:
    window_start = "2026"
    window_end   = "10-25 22:31 - 2026-10-26 06:13"

Only rows matching that exact corruption are rebuilt, and we can only fix a
row when the mangled pair can be re-joined losslessly:
    start_part = window_start + first hyphen of window_end[:2]
Everything else is left untouched (no invented values).

Dry-run by default; print a diff sample. --execute writes back.
"""

import argparse
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BAD_START_RE = re.compile(r"^(\d{4})$")
BAD_END_RE = re.compile(
    r"^(\d{1,2})-(\d{1,2})\s(\d{1,2}:\d{2})\s-\s(\d{4}-\d{1,2}-\d{1,2}\s\d{1,2}:\d{2})$"
)
HHMM_RE = re.compile(r"(\d{1,2}:\d{2})")


def parse_bad(start, end):
    m = BAD_START_RE.match(start or "")
    e = BAD_END_RE.match(end or "")
    if not (m and e):
        return None
    month_day = e.group(1)  # "10-25"
    start_time = e.group(3)  # "22:31"
    end_full = e.group(4)  # "2026-10-26 06:13"
    year = m.group(1)
    return f"{year}-{month_day} {start_time}", end_full


def hhmm(text):
    m = HHMM_RE.search(text or "")
    return m.group(1) if m else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="data/health.db")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT date, window_start, window_end FROM sleep ORDER BY date"
    ).fetchall()

    fixes, unfixable = [], []
    for r in rows:
        broken = BAD_START_RE.match(r["window_start"] or "")
        rebuilt = parse_bad(r["window_start"], r["window_end"]) if broken else None
        if rebuilt is None:
            # 仅当前值本身就是坏格式才记为需要修；正常格式跳过。
            if broken:
                unfixable.append((r["date"], r["window_start"], r["window_end"]))
            continue
        rebuilt_start, rebuilt_end = rebuilt
        start, end = hhmm(rebuilt_start), hhmm(rebuilt_end)
        fixes.append((start, end, r["date"], r["window_start"], r["window_end"]))

    print(f"scan: {len(fixes)} fixable / {len(unfixable)} broken-but-unfixable")
    for f in fixes[:8]:
        print("  FIX", f)
    if unfixable:
        print("  UNFIXABLE sample:", unfixable[:5])
    if not args.execute:
        print("dry-run only; pass --execute to write back")
        return
    # 一行一条 UPDATE，幂等（修复后不再匹配坏格式）
    for (start, end, date, _ws, _we) in fixes:
        conn.execute(
            "UPDATE sleep SET window_start = ?, window_end = ? WHERE date = ?",
            (start, end, date),
        )
    conn.commit()
    print(f"repaired {len(fixes)} rows")


if __name__ == "__main__":
    main()
