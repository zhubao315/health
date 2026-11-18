"""Correlation-rigor helpers for HEALTH.

Stdlib only, pure functions. These are *exploratory* statistics: the dashboard
must never present them as causal or medical conclusions.

Why this module exists
----------------------
The dashboard historically showed only Pearson r with a Fisher CI, had a
minimum of 8 pairs, and interpreted five fixed comparisons independently.
This adds, without removing any existing field:

  * Spearman rho (rank-based, robust to non-linear monotone relationships)
  * a two-sided p value (normal/Fisher-z approximation, documented)
  * Benjamini-Hochberg FDR q values across the whole family of comparisons
  * an explicit minimum-sample gate and coverage metadata
"""

import math

MIN_SAMPLES = 30  # below this, correlations are reported but flagged, not trusted


def _mean(values):
    return sum(values) / len(values) if values else 0.0


def _ranks(values):
    """Average ranks with ties handled explicitly (no third-party deps)."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        average = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = average
        i = j + 1
    return ranks


def pearson(xs, ys):
    """Pearson r for two equal-length, numeric lists; None if undefined."""
    if len(xs) != len(ys) or len(xs) < 2:
        return None
    mx, my = _mean(xs), _mean(ys)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    return max(-1.0, min(1.0, cov / math.sqrt(vx * vy)))


def spearman(xs, ys):
    """Spearman rho for two equal-length, numeric lists; None if undefined."""
    if len(xs) != len(ys) or len(xs) < 2:
        return None
    return pearson(_ranks(xs), _ranks(ys))


def two_sided_p(r, n):
    """Two-sided p value for a correlation coefficient.

    Uses the Fisher-z normal approximation z = atanh(r) * sqrt(n-3), which is
    adequate for n >= 10 and keeps the health package dependency-free. Exact
    t-distribution p values would need scipy; the CI in db.py uses the same
    approximation, so the two stay consistent.
    """
    if r is None or n is None or n < 4:
        return None
    r = max(-1.0, min(1.0, r))
    if r >= 1.0 or r <= -1.0:
        return 0.0
    z = 0.5 * math.log((1 + r) / (1 - r)) * math.sqrt(n - 3)
    return math.erfc(abs(z) / math.sqrt(2))


def benjamini_hochberg(p_values):
    """Benjamini-Hochberg FDR-adjusted q values; None entries stay None."""
    indexed = [(i, p) for i, p in enumerate(p_values) if p is not None]
    m = len(indexed)
    q = [None] * len(p_values)
    if not m:
        return q
    order = sorted(indexed, key=lambda pair: pair[1])
    previous = 1.0
    for rank in range(m, 0, -1):
        i, p = order[rank - 1]
        previous = min(previous, p * m / rank)
        q[i] = min(1.0, previous)
    return q


def enrich(results):
    """Add rigor fields to db.correlations() output (family-level BH) in place."""
    p_values = [r.get("p_value") for r in results]
    q_values = benjamini_hochberg(p_values)
    for result, q in zip(results, q_values):
        n = result.get("n") or 0
        result["q_value_bh"] = round(q, 4) if q is not None else None
        result["min_samples"] = MIN_SAMPLES
        result["samples_ok"] = n >= MIN_SAMPLES
        result["method"] = "exploratory pearson + spearman; BH-FDR across 5 comparisons"
    return results
