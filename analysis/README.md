# 分析指南

`data/health.db` 是主数据源，`data/daily.csv` 是它的每日视图导出。

## 表结构

- `daily`（视图）：每天一行，合并了睡眠、HRV、心率、压力、负荷
- `sleep`：睡眠分数、主睡眠时长、深/浅/REM/清醒占比、窗口、午睡
- `hrv`：夜间 HRV 平均值、正常区间、基线、状态
- `avg_hr`：日均心率 + 最低/最高
- `rhr`：静息心率
- `stress_daily`：日平均压力 + 各区间时长
- `load`：短期/长期训练负荷 + 负荷比
- `activities`：所有运动记录（跑步、骑行、徒步、步行等）
- `snapshots`：VO2max / 恢复 / 设备的每日快照

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

- 睡眠、HRV 的日期都是**醒来日**：D 日晚上的睡眠记在 D+1。
- 相关性不是因果；样本量小的时候 r 波动很大。
- 原始序列文件目前覆盖最近 90 天，之后每天增量累积；更早的每日聚合在 `data/daily.csv`。
- 3D/运动轨迹在另外三个运动仓库里，这里只保留运动摘要用于和健康指标对齐。
