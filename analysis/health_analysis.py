#!/usr/bin/env python3
"""Small stdlib-only health analysis: averages, monthly table, correlations."""

import argparse
import sqlite3
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

DB = Path("data/health.db")


def rows(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM daily ORDER BY date")]


def avg(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def pearson(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pairs) < 8:
        return None, len(pairs)
    n = len(pairs)
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    vx = sum((x - mx) ** 2 for x, _ in pairs)
    vy = sum((y - my) ** 2 for _, y in pairs)
    if vx <= 0 or vy <= 0:
        return None, n
    return cov / (vx**0.5 * vy**0.5), n


def lagged(data, x_key, y_key, lag=1):
    by_date = {r["date"]: r for r in data}
    xs, ys = [], []
    for r in data:
        target = (date.fromisoformat(r["date"]) + timedelta(days=lag)).isoformat()
        other = by_date.get(target)
        if other:
            xs.append(r.get(x_key))
            ys.append(other.get(y_key))
    return pearson(xs, ys)


def fmt(value, digits=0):
    if value is None:
        return "—"
    return f"{value:,.{digits}f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--out", default="analysis/summary.md")
    args = parser.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    data = rows(conn)
    if not data:
        raise SystemExit("no data yet")

    recent = data[-args.days :]
    metrics = [
        ("sleep_total_min", "睡眠时长", "min", 0),
        ("hrv_avg", "HRV", "ms", 0),
        ("rhr", "静息心率", "bpm", 0),
        ("stress_avg", "平均压力", "", 0),
        ("steps", "步数", "步", 0),
        ("load_short", "短期负荷", "", 0),
    ]

    lines = [
        "# 健康数据摘要",
        "",
        f"数据范围：{data[0]['date']} → {data[-1]['date']}（{len(data)} 天）  ",
        f"最近 {args.days} 天概览，生成于 {date.today().isoformat()}。",
        "",
        f"## 最近 {args.days} 天",
        "",
        "| 指标 | 平均 | 最小 | 最大 |",
        "| --- | ---: | ---: | ---: |",
    ]
    for key, label, unit, digits in metrics:
        values = [r.get(key) for r in recent if r.get(key) is not None]
        if not values:
            continue
        lines.append(
            f"| {label} | {fmt(avg(values), digits)} {unit} | "
            f"{fmt(min(values), digits)} | {fmt(max(values), digits)} |"
        )

    monthly = defaultdict(list)
    for r in data:
        monthly[r["date"][:7]].append(r)
    lines += [
        "",
        "## 月度趋势",
        "",
        "| 月份 | 天数 | 睡眠 h | HRV ms | 静息心率 | 压力 | 步数 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for month in sorted(monthly)[-12:]:
        group = monthly[month]
        sleep = avg([r.get("sleep_total_min") for r in group])
        lines.append(
            f"| {month} | {len(group)} | "
            f"{fmt(sleep / 60 if sleep else None, 1)} | "
            f"{fmt(avg([r.get('hrv_avg') for r in group]))} | "
            f"{fmt(avg([r.get('rhr') for r in group]))} | "
            f"{fmt(avg([r.get('stress_avg') for r in group]))} | "
            f"{fmt(avg([r.get('steps') for r in group]))} |"
        )

    checks = [
        ("睡眠时长 → 次日 HRV", "sleep_total_min", "hrv_avg", 1),
        ("短期负荷 → 次日静息心率", "load_short", "rhr", 1),
        ("压力 → 当日睡眠时长", "stress_avg", "sleep_total_min", 0),
        ("步数 → 当日睡眠时长", "steps", "sleep_total_min", 0),
    ]
    lines += [
        "",
        "## 相关性（Pearson r，仅个人观察）",
        "",
        "| 关系 | r | n |",
        "| --- | ---: | ---: |",
    ]
    for label, x, y, lag in checks:
        r, n = lagged(data, x, y, lag)
        lines.append(f"| {label} | {fmt(r, 3)} | {n} |")

    lines += [
        "",
        "> 相关性不是因果。样本量、季节、训练周期都会影响结果；用于发现值得进一步看的线索。",
        "",
        "## 更多",
        "",
        "- SQL 示例：`analysis/queries.sql`",
        "- 原始数据：`data/daily.csv`、`data/health.db`、`data/*_series.csv.gz`",
    ]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text("\n".join(lines))
    print(f"wrote {args.out} ({len(data)} days)")


if __name__ == "__main__":
    main()
