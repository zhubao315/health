"""Reusable, stdlib-only metric computations with explicit definitions.

Every function takes plain lists and returns plain numbers/None:
- Missing values are None; genuine zeros are kept as zeros. Nothing is
  silently cast from missing to 0.
- Rolling statistics require a minimum number of valid observations
  (min_obs) before yielding a value — short/mostly-empty windows return
  None instead of a misleading average.

Shared definitions (documented in README 数据字典):
- 7 d rolling mean/median, trailing, date-aligned (needs ≥5 valid values)
- 28 d personal baseline, trailing (needs ≥20 valid values)
- sleep regularity: 1 − bedtime MAD (rolling 7 d) / 120 min, clipped to [0, 1]
  (requires ≥5 valid bedtimes; bedtimes wrap around midnight to ±12 h)
- sleep target gap: sleep_total_min − target_min (target defaults 480 min)
- HRV deviation: hrv_avg − trailing-28 d personal baseline (needs the baseline)
  设备本身给出的 hrv_baseline 仍原生保留，两者含义不同、并存不下结论
- RHR trend: slope of the 7 d means over the trailing 28 d window (bpm/week)
- lagged correlation: date-aligned pairs with day lag (0 = same day),
  Pearson r + Fisher 95 % CI + n; pairs with either side missing are
  excluded and reported via n
- anomaly index: rolling MAD robust-z (threshold 3.5) per metric → dates
"""

import datetime
import statistics

SEVEN, TWENTY_EIGHT = 7, 28


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def valid(values):
    return [v for v in values if _is_num(v)]


def rolling_mean(values, window=SEVEN, min_obs=5):
    out = []
    for i in range(len(values)):
        w = valid(values[max(0, i - window + 1) : i + 1])
        out.append(round(statistics.fmean(w), 2) if len(w) >= min_obs else None)
    return out


def rolling_median(values, window=SEVEN, min_obs=5):
    out = []
    for i in range(len(values)):
        w = valid(values[max(0, i - window + 1) : i + 1])
        out.append(round(statistics.median(w), 2) if len(w) >= min_obs else None)
    return out


def trailing_baseline(values, window=TWENTY_EIGHT, min_obs=20):
    return rolling_mean(values, window=window, min_obs=min_obs)


def sleep_regularity_series(bedtimes, window=SEVEN, min_obs=5, max_spread=120.0):
    """bedtimes: float minutes-from-midnight wrapped to [-720, +720).

    regularity = max(0, 1 − MAD(bedtime, trailing 7 d) / max_spread)
    (MAD 用中位数偏差；与 std 相比对离群入睡更稳)
    """
    out = []
    for i in range(len(bedtimes)):
        w = [b for b in bedtimes[max(0, i - window + 1) : i + 1] if _is_num(b)]
        if len(w) < min_obs:
            out.append(None)
            continue
        med = statistics.median(w)
        mad = statistics.median(abs(b - med) for b in w)
        out.append(round(max(0.0, 1.0 - mad / max_spread), 3))
    return out


def wrap_bedtime(window_start):
    """'23:05' / '00:31' → minutes from midnight wrapped into (-720, +720]."""
    if not window_start or ":" not in window_start:
        return None
    hh, mm = window_start.split(":")[:2]
    try:
        minutes = int(hh) * 60 + int(mm)
    except ValueError:
        return None
    if minutes > 720:
        minutes -= 1440
    return minutes


def sleep_target_gap(sleep_min, target_min=480):
    if not _is_num(sleep_min):
        return None
    return sleep_min - target_min


def hrv_deviation_series(hrv_values, baseline_28d):
    """Relative deviation from the trailing 28 d personal baseline, in ms."""
    out = []
    for hrv, base in zip(hrv_values, baseline_28d):
        out.append(round(hrv - base, 2) if _is_num(hrv) and _is_num(base) else None)
    return out


def rhr_trend_series(rhr_values, step_days=SEVEN, span=TWENTY_EIGHT):
    """bpm-of-change per week across the trailing span, from 7 d means."""
    means = rolling_mean(rhr_values, window=SEVEN, min_obs=5)
    out = []
    for i in range(len(means)):
        window = [m for m in means[max(0, i - span + 1) : i + 1] if _is_num(m)]
        if len(window) < 4:
            out.append(None)
            continue
        early = statistics.fmean(window[: len(window) // 2])
        late = statistics.fmean(window[-(len(window) // 2) :])
        out.append(round(late - early, 2))
    return out


def pearson(xs, ys, min_pairs=8):
    """Pearson r with Fisher-z 95 % CI.

    Returns (r, n, ci_low, ci_high). Pairs with a missing side are dropped
    and the surviving count returned as n so callers can weigh the sample.
    """
    import math

    pairs = [(x, y) for x, y in zip(xs, ys) if _is_num(x) and _is_num(y)]
    n = len(pairs)
    if n < min_pairs:
        return None, n, None, None
    mx = statistics.fmean(x for x, _ in pairs)
    my = statistics.fmean(y for _, y in pairs)
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    vx = sum((x - mx) ** 2 for x, _ in pairs)
    vy = sum((y - my) ** 2 for _, y in pairs)
    if vx <= 0 or vy <= 0:
        return None, n, None, None
    r = max(-1.0, min(1.0, cov / (vx**0.5 * vy**0.5)))
    lo = hi = None
    if n >= 4:
        if r >= 1.0:  # Fisher z is undefined at ±1 → CI degenerates to the point
            lo = hi = 1.0
        elif r <= -1.0:
            lo = hi = -1.0
        else:
            z = math.log((1 + r) / (1 - r)) / 2
            se = 1 / (n - 3) ** 0.5
            lo = (math.exp(2 * (z - 1.96 * se)) - 1) / (math.exp(2 * (z - 1.96 * se)) + 1)
            hi = (math.exp(2 * (z + 1.96 * se)) - 1) / (math.exp(2 * (z + 1.96 * se)) + 1)
    return r, n, lo, hi


def align_lag(
    dates, x_values, y_values, lag=0
):
    """Pair (x on day i, y on day i + lag) keeping both dates' alignment.

    x/y 都是按自然日或醒来日索引；调用方须保证两个序列对齐同一日期轴。
    Missing days break the pair (excluded, count via n).
    """
    index = {d: i for i, d in enumerate(dates)}
    xs, ys = [], []
    for i, d in enumerate(dates):
        j = index.get(
            (datetime.date.fromisoformat(d) + datetime.timedelta(days=lag)).isoformat()
        )
        if j is None:
            continue
        xs.append(x_values[i])
        ys.append(y_values[j])
    return xs, ys


def anomaly_flags(values, dates, window=60, threshold=3.5, min_pairs=20):
    """Robust rolling-MAD z-scores; returns [(date, value, z), ...]."""
    flags = []
    for i in range(len(values)):
        hist = [v for v in values[max(0, i - window) : i] if _is_num(v)]
        v = values[i]
        if not _is_num(v) or len(hist) < min_pairs:
            continue
        med = statistics.median(hist)
        mad = statistics.median(abs(x - med) for x in hist)
        if mad == 0 and v == med:
            continue  # perfectly quiet history — every point gets z=inf otherwise
        z = 0.6745 * (v - med) / mad if mad else float("inf")
        if abs(z) > threshold:
            flags.append((dates[i], v, round(z, 2)))
    return flags


def completeness(dates, values):
    """Fraction of dates with a valid (non-None) value."""
    if not dates:
        return None, 0
    ok = sum(1 for v in values if _is_num(v))
    return round(ok / len(dates), 4), ok


def fill_missing(dates, joins: dict):
    """Left-join any {iso_date: value} map onto the full date axis."""
    return [joins.get(d) for d in dates]


def metric_summary(values, unit):
    vals = valid(values)
    if not vals:
        return {"avg_7d": None, "avg_28d": None, "unit": unit}
    return {
        "avg_7d": round(statistics.fmean(vals[-SEVEN:]), 2) if len(vals) else None,
        "avg_28d": round(statistics.fmean(vals[-TWENTY_EIGHT:]), 2),
        "unit": unit,
    }
