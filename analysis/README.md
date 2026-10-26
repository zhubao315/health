# 分析指南

`data/health.db` 是主数据源，`data/daily.csv` 是它的每日视图导出。

## 表结构

- `daily`（视图）：每天一行，合并了睡眠、HRV、心率、压力、负荷；缺失值保持 NULL（`daily_health` 的睡眠分期分钟数由 `coros_health.db.sleep_stage_metrics` 统一推导：分钟 → 占比×总时长 → NULL，绝不转 0）
- `sleep`：睡眠分数、主睡眠时长、深/浅/REM/清醒占比、窗口、午睡
- `hrv`：夜间 HRV 平均值、正常区间、基线、状态
- `avg_hr`：日均心率 + 最低/最高
- `rhr`：静息心率
- `stress_daily`：日平均压力 + 各区间时长
- `load`：短期/长期训练负荷 + 负荷比
- `activities`：所有运动记录（跑步、骑行、徒步、步行等）
- `snapshots`：VO2max / 恢复 / 设备的每日快照（**按日一行**的幂等表，`date` 主键；设备仅存 name/model，序列号/蓝牙 ID 已剥离）

## 统计口径（与 dashboard 完全同源）

所有分析函数集中在 [`coros_health/metrics.py`](../coros_health/metrics.py)，相关性定义集中在 [`coros_health/db.py`](../coros_health/db.py) 的 `CORRELATION_SPECS`。`analysis/summary.md`（`health_analysis.py`）与前端共用同一套：

- **7 天滚动均值/中位数**：trailing、日期对齐、有效值 <5 → NULL（`rolling_mean` / `rolling_median`）
- **28 天个人基线**：trailing 28 天均值，有效值 <20 → NULL（`trailing_baseline`）
- **睡眠规律性**：1 − MAD(入睡时间, 7 d) / 120 min，入睡时间按 ±12 h 环绕（`sleep_regularity_series`）
- **HRV 偏差**：hrv_avg − 28 天 personal 基线，单位 ms；与设备自带 `hrv_baseline` 并存不下结论（`hrv_deviation_series`）
- **RHR 周趋势**：28 天窗内 7 天均值的前后两半之差，bpm/周（`rhr_trend_series`）
- **滞后相关**：`CORRELATION_SPECS` 唯一清单；任一侧缺失的对被剔除，n 报告**净可用对数**，CI 为 Fisher-z 95 % 区间
- **异常值**：滚动 60 天 MAD 稳健 z（阈值 3.5）；`data_quality.json` 记录 flag

## 快捷方式：analysis 目录生成的文件

- `summary.md`：`python analysis/health_analysis.py --days 30` 的输出
- `metrics.json`：每次构建 dashboard 时由 `coros_health.analytics.build()` 自动重算（洞察 + 各指标 7d/28d 個值 + 相关性快照）

## 常用查询

见 [`queries.sql`](queries.sql)。也可以直接用 pandas：

```python
import sqlite3, pandas as pd
con = sqlite3.connect("data/health.db")
df = pd.read_sql("SELECT * FROM daily ORDER BY date", con, parse_dates=["date"])
df["sleep_h"] = df.sleep_total_min / 60

# 7 天滚动平均
for col in ["sleep_h", "hrv_avg", "rhr", "stress_avg"]:
    df[f"{col}_7d"] = df[col].rolling(7).mean()

# 睡眠 → 次日 HRV
df["hrv_next"] = df.hrv_avg.shift(-1)
print(df[["sleep_h", "hrv_next"]].corr())
```

## 原始时间序列

```python
import pandas as pd
stress = pd.read_csv("data/stress_series.csv.gz", compression="gzip")
hrv = pd.read_csv("data/hrv_series.csv.gz", compression="gzip")

# 转成本地时间（timezone 是 COROS 的分钟偏移，北京时间 = 480）
stress["ts_local"] = pd.to_datetime(stress.ts, unit="s", utc=True) + pd.to_timedelta(
    stress.timezone, unit="m"
)
```

## 注意

- 睡眠、HRV 的日期都是**醒来日**：D 日晚上的睡眠记在 D+1；steps/stress/load/rhr 是**北京时间自然日**（见主 README 数据字典）。滞后相关已按此对齐。
- 相关性不是因果；样本量小的时候 r 波动很大，看 CI 宽度。
- 原始序列文件目前覆盖最近 90 天，之后每天增量累积；更早的每日聚合在 `data/daily.csv`。
- 3D/运动轨迹在另外三个运动仓库里，这里只保留运动摘要用于和健康指标对齐。
- 直接 pandas 出数时请复制 `coros_health/metrics.py` 的定义或调用它，别再写第二份口径。
