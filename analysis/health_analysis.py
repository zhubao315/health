#!/usr/bin/env python3
"""Small stdlib-only health analysis: averages, monthly table, correlations.

统计口径与 dashboard 完全同源：相关性复用 coros_health.db.correlations
（唯一权威清单 CORRELATION_SPECS，含 Pearson r + Fisher 95 % CI + 有效对数 n），
不再自备一套 pearson/lagged，避免"两个面板各算各的"。

注意：本工具为**描述性摘要**，展示均值/趋势/相关系数，不做任何健康建议。
"""

import argparse
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

# allow `python analysis/health_analysis.py`(workflow 用法) to find the package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from coros_health import db  # noqa: E402

DB = Path("data/health.db")


def rows(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM daily ORDER BY date")]


def avg(values):
    """均值跳过缺失（None），永不把缺失当 0 平均。"""
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def fmt(value, digits=0):
    if value is None:
        return "—"
    return f"{value:,.{digits}f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--out", default="analysis/summary.md")
    args = parser.parse_args()

    # db.connect() 会顺带完成 nightly 重建的 schema/snapshot 迁移，保证
    # `analysis/health_analysis.py` 在干净 clone 上也能独立运行。
    conn = db.connect(str(DB))
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

    # 与 dashboard / analysis/metrics.json 共享同一份相关定义（含 CI 与 n）
    lines += [
        "",
        "## 相关性（Pearson r，Fisher 95 % CI，仅个人观察）",
        "",
        "| 关系 | r | 95 % CI | n | lag |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for spec in db.correlations(data):
        ci = "—"
        if spec["r"] is not None and spec["ci_low"] is not None:
            ci = f"[{spec['ci_low']:.3f}, {spec['ci_high']:.3f}]"
        lines.append(
            f"| {spec['label']} | {fmt(spec['r'], 3)} | {ci} | {spec['n']} | +{spec['lag']}d |"
        )

    lines += [
        "",
        "> 相关性不是因果。样本量、季节、训练周期都会影响结果；",
        "> CI 宽（低 n 或弱相关）表示这段时间的数据不足以支持该方向的结论。",
        "",
        "## 更多",
        "",
        "- SQL 示例：`analysis/queries.sql`",
        "- 原始数据：`data/daily.csv`、`data/health.db`、`data/*_series.csv.gz`",
        "- 数据质量审计：`dashboard/data_quality.json`（缺失率 / 断档 / 伪零 / 异常值）",
    ]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text("\n".join(lines))
    print(f"wrote {args.out} ({len(data)} days)")


if __name__ == "__main__":
    main()
