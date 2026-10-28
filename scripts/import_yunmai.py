#!/usr/bin/env python3
"""Import Yunmai (好轻) body-composition records into data/health.db.

Input: JSON with {"rows": [...]} as returned by the Yunmai chart-list API
(or the file produced by scripts/fetch_yunmai.py).

One row per calendar day (the last weigh-in wins); metrics the scale did not
report stay NULL — never 0.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from coros_health import db  # noqa: E402

FIELD_MAP = {
    "weight": "weight_kg",
    "fat": "body_fat_pct",
    "bmi": "bmi",
    "muscle": "muscle_pct",
    "water": "water_pct",
    "bone": "bone_kg",
    "protein": "protein_pct",
    "visFat": "visceral_fat",
    "bmr": "bmr",
    "somaAge": "body_age",
}

# metrics older rows report as 0 when the scale only measured weight
NEVER_ZERO = {"fat", "muscle", "water", "bone", "protein", "somaAge"}


def to_row(rec):
    out = {
        "date": rec["createTime"][:10],
        "measured_at": rec["createTime"],
    }
    for src, dst in FIELD_MAP.items():
        value = rec.get(src)
        if isinstance(value, (int, float)) and not (src in NEVER_ZERO and value == 0):
            out[dst] = (
                round(float(value), 2)
                if dst
                in (
                    "weight_kg",
                    "body_fat_pct",
                    "bmi",
                    "muscle_pct",
                    "water_pct",
                    "bone_kg",
                    "protein_pct",
                )
                else int(value)
            )
        else:
            out[dst] = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rows_json")
    ap.add_argument("--db", default="data/health.db")
    args = ap.parse_args()

    payload = json.loads(Path(args.rows_json).read_text())
    rows = payload.get("rows", payload)
    by_day = {}
    for rec in sorted(rows, key=lambda r: r["createTime"]):
        by_day[rec["createTime"][:10]] = to_row(rec)  # last weigh-in of the day wins

    conn = db.connect(args.db)
    db.upsert(conn, "body", list(by_day.values()))

    got = conn.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM body").fetchone()
    print(f"body: {got[0]} days, {got[1]} -> {got[2]}")
    missing = conn.execute(
        "SELECT COUNT(*) FROM body WHERE body_fat_pct IS NULL"
    ).fetchone()[0]
    print(f"weight-only days (no body fat): {missing}")
    db.export_csv(conn, "body", "data/body.csv")


if __name__ == "__main__":
    main()
