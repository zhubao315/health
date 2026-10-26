-- Example queries for data/health.db (SQLite).
-- Open with: sqlite3 data/health.db

-- 1. 最近 30 天的每日明细
SELECT date, steps, sleep_total_min, hrv_avg, rhr, stress_avg, load_short, load_ratio
FROM daily
ORDER BY date DESC
LIMIT 30;

-- 2. 每月平均睡眠 / HRV / 静息心率
SELECT substr(date, 1, 7) AS month,
       ROUND(AVG(sleep_total_min) / 60.0, 1) AS sleep_h,
       ROUND(AVG(hrv_avg), 1) AS hrv,
       ROUND(AVG(rhr), 1) AS rhr,
       ROUND(AVG(stress_avg), 1) AS stress
FROM daily
GROUP BY month
ORDER BY month;

-- 3. 睡眠最差的 20 天
SELECT date, sleep_total_min, sleep_score, hrv_avg, rhr, load_short
FROM daily
WHERE sleep_total_min IS NOT NULL
ORDER BY sleep_total_min
LIMIT 20;

-- 4. 高负荷但 HRV 偏低的日子
SELECT date, load_short, load_long, load_ratio, hrv_avg, hrv_baseline, rhr
FROM daily
WHERE load_short > 100 AND hrv_avg < hrv_baseline
ORDER BY date DESC;

-- 5. 运动记录（所有运动类型）
SELECT date, sport, distance_km, duration_min, avg_hr, calories
FROM activities
ORDER BY date DESC
LIMIT 50;

-- 6. 原始压力序列（需要先 gunzip）
-- data/stress_series.csv.gz 的列：date,ts,timezone,stress,score,stress_hrv,stress_hr
-- 原始 HRV 序列：data/hrv_series.csv.gz 的列：date,ts,timezone,hrv,status,confidence
