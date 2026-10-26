"""Assemble analysis metrics into the dashboard payload + metrics.json.

Layering:
- metrics.py  纯计算（可独立测试）
- analytics.py 数据装配：从 daily 视图行 → series/insights blocks
- cli.py      调 analytics.build() 替换旧纯 payload 生成

Series blocks attach to dashboard/data.json:
  series.<key>.mean_7d / mean_28d      与 daily 对齐的滚动均值（None=样本不足）
  series.hrv.deviation                 HRV − 28 天个人基线（ms，None=基线未定）
  series.sleep.regularity              睡眠规律性（0–1，7 天窗口）
  series.sleep.target_gap              距离 8 h 目标的差额（分钟，可负）
  series.rhr.weekly_trend              静息心率 7 天均值的两周差（bpm/周）
insights block:
  七天/二十八天均值摘要、周五 Summary、可验证假设（明确标注为观察/假设）
"""

import datetime
import json
import statistics
from pathlib import Path

from . import db, metrics

TARGET_SLEEP_MIN = 480

METRIC_ROWS = [
    ("sleep_total_min", "睡眠时长", "min", 0),
    ("hrv_avg", "夜间HRV", "ms", 0),
    ("rhr", "静息心率", "bpm", 0),
    ("stress_avg", "平均压力", "分", 0),
    ("steps", "步数", "步", 0),
    ("load_short", "短期负荷", "负荷", 0),
    ("sleep_score", "睡眠分", "分", 0),
]


def _column(rows, key):
    return [r.get(key) for r in rows]


def build(conn, write_metrics=True):
    rows = [dict(r) for r in conn.execute("SELECT * FROM daily ORDER BY date")]
    rows = [db.decorate_row(r) for r in rows]
    dates = [r["date"] for r in rows]

    series = {}
    for key, label, unit, digits in METRIC_ROWS:
        values = _column(rows, key)
        series[key] = {
            "label": label,
            "unit": unit,
            "mean_7d": metrics.rolling_mean(values, 7, min_obs=5),
            "mean_28d": metrics.trailing_baseline(values, 28, min_obs=20),
            "median_7d": metrics.rolling_median(values, 7, min_obs=5),
        }

    # 睡眠专项
    bedtimes = [metrics.wrap_bedtime(r.get("window_start")) for r in rows]
    sleep_total = _column(rows, "sleep_total_min")
    base28 = metrics.trailing_baseline(sleep_total, 28, min_obs=20)
    series["sleep"] = {
        **series["sleep_total_min"],
        "regularity": metrics.sleep_regularity_series(bedtimes),
        "target_gap": [metrics.sleep_target_gap(v, TARGET_SLEEP_MIN) for v in sleep_total],
    }
    # 深睡比例（目标 13–23% 的观察口径，不作为医学建议）
    deep_pct = [
        round(r["deep"] / r["sleep_total_min"] * 100, 1)
        if r.get("deep") is not None and r.get("sleep_total_min")
        else None
        for r in rows
    ]
    series["sleep"]["deep_pct"] = deep_pct

    # HRV: 个人 28 天基线偏差（与设备 hrv_baseline 并存，不动原始字段）
    hrv_base28 = metrics.trailing_baseline(_column(rows, "hrv_avg"), 28, min_obs=20)
    series["hrv"] = {
        **series["hrv_avg"],
        "deviation": metrics.hrv_deviation_series(_column(rows, "hrv_avg"), hrv_base28),
        "device_baseline": _column(rows, "hrv_baseline"),
    }

    # RHR 趋势
    series["rhr"] = {
        **series["rhr"],
        "weekly_trend": metrics.rhr_trend_series(_column(rows, "rhr")),
    }

    payload = {"series": series, "insights": insights(rows, dates, series)}
    payload["metrics_version"] = "1.0"

    if write_metrics:
        write_metrics_json(rows, dates, series, conn)
    return payload


def insights(rows, dates, series):
    """叙述型洞察：只陈述计算结果，标注为观察/可验证假设，不下诊断。"""
    out = {"weekly": [], "hypotheses": []}
    if not rows:
        return out

    # 最近 6 周，周一为起点
    last_date = datetime.date.fromisoformat(dates[-1])
    this_monday = last_date - datetime.timedelta(days=last_date.weekday())
    for w in range(5, -1, -1):
        week_start = this_monday - datetime.timedelta(weeks=w)
        week_end = week_start + datetime.timedelta(days=6)
        label = f"{week_start.isoformat()[5:]}~{week_end.isoformat()[5:]}"
        bucket = [
            r
            for r in rows
            if week_start.isoformat() <= r["date"] <= week_end.isoformat()
        ]
        if not bucket:
            out["weekly"].append({"week": label, "days": 0})
            continue
        def wk_mean(key):
            vals = [r.get(key) for r in bucket if r.get(key) is not None]
            return round(statistics.fmean(vals), 1) if vals else None

        out["weekly"].append(
            {
                "week": label,
                "days": len(bucket),
                "sleep_h": round((wk_mean("sleep_total_min") or 0) / 60, 1) or None,
                "hrv": wk_mean("hrv_avg"),
                "rhr": wk_mean("rhr"),
                "stress": wk_mean("stress_avg"),
                "load_short": wk_mean("load_short"),
                "exercise_min": wk_mean("exercise_min"),
            }
        )

    # 可验证假设：对比最近 7 天 vs 前 28 天均值
    recent = rows[-7:]
    prior = rows[-35:-7]
    if recent and prior:
        for key, label, unit in [
            ("sleep_total_min", "睡眠时长", "min"),
            ("hrv_avg", "夜间HRV", "ms"),
            ("rhr", "静息心率", "bpm"),
            ("stress_avg", "平均压力", "分"),
        ]:
            rv = [r.get(key) for r in recent if r.get(key) is not None]
            pv = [r.get(key) for r in prior if r.get(key) is not None]
            if len(rv) >= 4 and len(pv) >= 10:
                delta = statistics.fmean(rv) - statistics.fmean(pv)
                out["hypotheses"].append(
                    {
                        "metric": key,
                        "label": label,
                        "unit": unit,
                        "delta": round(delta, 1),
                        "note": "最近 7 天均值 − 前 28 天均值；仅供参考，需结合训练与生活事件核对",
                    }
                )
    return out


def write_metrics_json(rows, dates, series, conn, path="analysis/metrics.json"):
    """持久化分析指标（任务 7：计算并保存）——含滞后相关与完整率。"""
    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "dates": {"first": dates[0] if dates else None, "last": dates[-1] if dates else None, "n": len(dates)},
        "definitions": METRIC_DEFINITIONS,
        "series_summaries": {},
        "correlations": correlations_from_daily(rows),
        "completeness": per_metric_completeness(rows),
    }
    for key, s in series.items():
        payload["series_summaries"][key] = {
            "avg_7d": s["mean_7d"][-1] if s.get("mean_7d") else None,
            "avg_28d": s["mean_28d"][-1] if s.get("mean_28d") else None,
        }
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return payload


def correlations_from_daily(rows):
    """经过日期对齐的滞后相关（r、n、95%CI、lag 日）。定义唯一来源：db.py。"""
    return db.correlations(rows)


def per_metric_completeness(rows):
    out = {}
    all_dates = [r["date"] for r in rows] if rows else []
    for key, label, unit, digits in METRIC_ROWS:
        values = [r.get(key) for r in rows]
        rate, ok = metrics.completeness(all_dates, values)
        out[key] = {"label": label, "complete_rate": rate, "days": ok}
    deep_rate, deep_ok = metrics.completeness(all_dates, [r.get("deep") for r in rows])
    out["sleep_stage_deep"] = {
        "label": "深睡分期",
        "complete_rate": deep_rate,
        "days": deep_ok,
    }
    return out


METRIC_DEFINITIONS = {
    "mean_7d": "尾随 7 天均值；窗口内有效样本 ≥5 才输出，否则 None",
    "mean_28d": "尾随 28 天个人基线；窗口内有效样本 ≥20 才输出，否则 None",
    "median_7d": "尾随 7 天中位数（抗离群）",
    "sleep.regularity": "1 − 睡点 MAD/120，0–1；≥5 晚有效入睡时间才输出",
    "sleep.target_gap": "睡眠时长 − 目标 480 min（负=不足）",
    "sleep.deep_pct": "深睡分钟 / 主睡眠时长 ×100",
    "hrv.deviation": "夜间 HRV − 28 天个人基线（ms）",
    "rhr.weekly_trend": "7 天均值的（后半 − 前半）差，跨 28 天窗口（bpm）",
    "correlations": "日期对齐滞后 Pearson r；样本不足 <8 或任一侧常数时 r=None",
    "anomaly_flags": "尾随 60 天滚动 MAD z>±3.5 判为异常节律（生理意义需人工核对）",
}
