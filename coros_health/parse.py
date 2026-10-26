"""Parsers for the text output of COROS MCP health tools."""

import datetime
import re

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _int(value, default=None):
    if value is None:
        return default
    value = str(value).replace(",", "").strip()
    try:
        return int(float(value))
    except ValueError:
        return default


def to_minutes(text):
    """'5h 5min' / '45m' / '1h 18min' / '0 min' -> minutes."""
    if not text:
        return None
    text = text.strip().replace("min", "m")
    hours = re.search(r"(\d+)\s*h", text)
    mins = re.search(r"(\d+)\s*m", text)
    total = 0
    if hours:
        total += int(hours.group(1)) * 60
    if mins:
        total += int(mins.group(1))
    return total if hours or mins else None


def iso_date(value):
    try:
        return datetime.datetime.strptime(value, "%Y%m%d").date().isoformat()
    except ValueError:
        return None


def parse_daily_health(text):
    rows = []
    parts = re.split(r"\n--- (\d{8}) ---", text)
    for i in range(1, len(parts), 2):
        date = iso_date(parts[i])
        body = parts[i + 1]
        if not date:
            continue
        row = {"date": date}
        patterns = {
            "steps": r"Steps:\s*([\d,]+)",
            "calories": r"Calories:\s*([\d,]+)\s*kcal",
            "stress_avg": r"Stress:\s*Avg\s*(\d+)",
            "sleep_score": r"Sleep Summary:\s*\(Score:\s*(\d+)\)",
        }
        for key, pattern in patterns.items():
            m = re.search(pattern, body)
            row[key] = _int(m.group(1)) if m else None
        m = re.search(r"Exercise:\s*([^\n]+)", body)
        row["exercise_min"] = to_minutes(m.group(1)) if m else None
        for key, label in [
            ("sleep_total_min", "Total"),
            ("sleep_awake_min", "Awake"),
            ("sleep_deep_min", "Deep"),
            ("sleep_light_min", "Light"),
            ("sleep_rem_min", "REM"),
        ]:
            m = re.search(rf"^\s*{label}:\s*([^\n]+)$", body, re.MULTILINE)
            row[key] = to_minutes(m.group(1)) if m else None
        m = re.search(
            r"Sleep HR:\s*Avg\s*(\d+)\s*bpm(?:\s*\|\s*Min\s*(\d+)\s*bpm)?"
            r"(?:\s*\|\s*Max\s*(\d+)\s*bpm)?",
            body,
        )
        if m:
            row["sleep_hr_avg"] = _int(m.group(1))
            row["sleep_hr_min"] = _int(m.group(2)) if m.group(2) else None
            row["sleep_hr_max"] = _int(m.group(3)) if m.group(3) else None
        else:
            row["sleep_hr_avg"] = row["sleep_hr_min"] = row["sleep_hr_max"] = None
        rows.append(row)
    return rows


def parse_sleep_overview(text):
    rows = []
    parts = re.split(r"\n(\d{4}-\d{2}-\d{2})\n", text)
    for i in range(1, len(parts), 2):
        date, body = parts[i], parts[i + 1]
        row = {"date": date}
        patterns = {
            "sleep_score": r"Sleep Score:\s*(\d+)",
            "main_min": r"Main Sleep:\s*([^\n]+)",
            "deep_pct": r"Deep Sleep Ratio:\s*(\d+)%",
            "light_pct": r"Light Sleep Ratio:\s*(\d+)%",
            "rem_pct": r"REM Ratio:\s*(\d+)%",
            "awake_pct": r"Awake Ratio:\s*(\d+)%",
            "awake_min": r"Awake Time:\s*([^\n]+)",
            "awake_count": r"Awake Count:\s*(\d+)",
            "naps_min": r"Naps Total:\s*([^\n]+)",
        }
        for key, pattern in patterns.items():
            m = re.search(pattern, body)
            if not m:
                row[key] = None
            elif key in ("main_min", "awake_min", "naps_min"):
                row[key] = to_minutes(m.group(1))
            elif key == "awake_count":
                row[key] = _int(m.group(1))
            else:
                row[key] = _int(m.group(1))
        # Main Sleep Window may include dates ("2026-10-25 22:31 - 2026-10-26
        # 06:13") whose hyphens defeat splitting on the first "-"; split on
        # the last hyphen that is surrounded by spaces instead.
        m = re.search(r"Main Sleep Window:\s*([^\n]+)", body)
        if m:
            raw_parts = m.group(1).strip().rsplit(" - ", 1)
            if len(raw_parts) != 2:
                raw_parts = [m.group(1).strip(), None]
            start_raw, end_raw = raw_parts
        else:
            start_raw = end_raw = None

        def _hhmm(text):
            if not text:
                return None
            m = re.search(r"(\d{1,2}:\d{2})", text)
            return m.group(1) if m else text.strip()

        row["window_start"] = _hhmm(start_raw) if start_raw else None
        row["window_end"] = _hhmm(end_raw) if end_raw else None
        rows.append(row)
    return rows


def parse_hrv(text):
    assessments, series = [], []
    assessment_text, _, series_text = text.partition("Sleep HRV Time Series")
    parts = re.split(r"\n(\d{4}-\d{2}-\d{2}):\n", assessment_text)
    for i in range(1, len(parts), 2):
        date, body = parts[i], parts[i + 1]
        m = re.search(r"HRV Avg:\s*(\d+)\s*ms\s*[—-]\s*([^\n]+)", body)
        n = re.search(r"Normal Range:\s*(\d+)\s*-\s*(\d+)\s*ms", body)
        b = re.search(r"Baseline:\s*(\d+)\s*ms", body)
        if not m:
            continue
        assessments.append(
            {
                "date": date,
                "hrv_avg": _int(m.group(1)),
                "hrv_status": m.group(2).strip(),
                "hrv_normal_low": _int(n.group(1)) if n else None,
                "hrv_normal_high": _int(n.group(2)) if n else None,
                "hrv_baseline": _int(b.group(1)) if b else None,
            }
        )
    parts = re.split(r"\n(\d{4}-\d{2}-\d{2}):\n", series_text)
    for i in range(1, len(parts), 2):
        date, body = parts[i], parts[i + 1]
        for line in body.splitlines():
            m = re.search(
                r"timestamp=(\d+),\s*timezone=(-?\d+),\s*hrv=(\d+)\s*ms,"
                r"\s*status=(\d+),\s*confidence=(\d+)",
                line,
            )
            if m:
                series.append(
                    {
                        "date": date,
                        "ts": int(m.group(1)),
                        "timezone": int(m.group(2)),
                        "hrv": int(m.group(3)),
                        "status": int(m.group(4)),
                        "confidence": int(m.group(5)),
                    }
                )
    return assessments, series


def parse_stress_daily(text):
    rows = []
    parts = re.split(r"\n(\d{4}-\d{2}-\d{2}):\n", text)
    for i in range(1, len(parts), 2):
        date, body = parts[i], parts[i + 1]
        m = re.search(r"Average Stress:\s*(\d+)", body)
        if not m:
            continue
        row = {"date": date, "stress_avg": _int(m.group(1))}
        for key, label in [
            ("relaxed_min", "Relaxed"),
            ("low_min", "Low"),
            ("medium_min", "Medium"),
            ("high_min", "High"),
        ]:
            m = re.search(rf"{label}:\s*([^\n(]+)", body)
            row[key] = to_minutes(m.group(1)) if m else None
        rows.append(row)
    return rows


def parse_stress_series(text):
    series = []
    parts = re.split(r"\n(\d{4}-\d{2}-\d{2}):\n", text)
    for i in range(1, len(parts), 2):
        date, body = parts[i], parts[i + 1]
        for line in body.splitlines():
            m = re.search(
                r"timestamp=(\d+),\s*timezone=(-?\d+),\s*stress=(\d+),"
                r"\s*score=(\d+),\s*stressHrv=(\d+),\s*stressHr=(\d+)",
                line,
            )
            if m:
                series.append(
                    {
                        "date": date,
                        "ts": int(m.group(1)),
                        "timezone": int(m.group(2)),
                        "stress": int(m.group(3)),
                        "score": int(m.group(4)),
                        "stress_hrv": int(m.group(5)),
                        "stress_hr": int(m.group(6)),
                    }
                )
    return series


def parse_avg_hr(text):
    rows = []
    for m in re.finditer(
        r"(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm\s*\(Min:\s*(\d+),\s*Max:\s*(\d+)\)",
        text,
    ):
        rows.append(
            {
                "date": m.group(1),
                "avg_hr": _int(m.group(2)),
                "min_hr": _int(m.group(3)),
                "max_hr": _int(m.group(4)),
            }
        )
    return rows


def parse_rhr(text):
    return [
        {"date": m.group(1), "rhr": _int(m.group(2))}
        for m in re.finditer(r"(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm", text)
    ]


def parse_load(text):
    rows = []
    parts = re.split(r"\n(\d{4}-\d{2}-\d{2})\s*\n", text)
    for i in range(1, len(parts), 2):
        date, body = parts[i], parts[i + 1]
        row = {"date": date}
        for key, pattern in [
            ("load_comment", r"Comment:\s*([^\n]+)"),
            ("load_short", r"Short-Term Load:\s*(\d+)"),
            ("load_long", r"Long-Term Load:\s*(\d+)"),
            ("load_ratio", r"Load Ratio:\s*([\d.]+)"),
        ]:
            m = re.search(pattern, body)
            if key == "load_comment":
                row[key] = m.group(1).strip() if m else None
            elif key == "load_ratio":
                row[key] = float(m.group(1)) if m else None
            else:
                row[key] = _int(m.group(1)) if m else None
        rows.append(row)
    return rows


def parse_fitness(text):
    out = {}
    patterns = {
        "vo2max": r"VO2max:\s*(\d+)",
        "running_level": r"Running Level:\s*(\d+)",
        "threshold_pace": r"Threshold Pace:\s*([^\n]+)",
        "pred_5k": r"5 km Prediction:\s*([^\n]+)",
        "pred_10k": r"10 km Prediction:\s*([^\n]+)",
        "pred_half": r"Half Marathon Prediction:\s*([^\n]+)",
        "pred_marathon": r"(?<!Half )Marathon Prediction:\s*([^\n]+)",
    }
    for key, pattern in patterns.items():
        m = re.search(pattern, text)
        if not m:
            out[key] = None
        elif key in ("vo2max", "running_level"):
            out[key] = _int(m.group(1))
        else:
            out[key] = m.group(1).strip()
    return out


def parse_recovery(text):
    m = re.search(r"Recovery:\s*(\d+)%", text)
    lvl = re.search(r"Level:\s*([^\n]+)", text)
    eta = re.search(r"Estimated Full Recovery:\s*([^\n]+)", text)
    return {
        "recovery_pct": _int(m.group(1)) if m else None,
        "recovery_level": lvl.group(1).strip() if lvl else None,
        "recovery_eta": eta.group(1).strip() if eta else None,
    }


def parse_devices(text):
    """Device snapshots — ONLY non-sensitive fields survive.

    Serial numbers, Bluetooth IDs and warranty timestamps are hardware
    identifiers; they must never reach any file that is committed or
    published (dashboard/data.json, data/*.csv, data/health.db).
    """
    devices = []
    for block in re.split(r"\n\d+\.\s+", text)[1:]:
        name = block.splitlines()[0].strip()
        field = re.search(r"Model Name:\s*([^\n]+)", block)
        devices.append(
            {
                "name": name,
                "model": field.group(1).strip() if field else None,
            }
        )
    return devices


def parse_sports(text):
    """Activity summaries (all sports) from querySportRecords."""
    rows = []
    for block in re.split(r"\n(?=\s*\d+\.\s)", text):
        m = re.search(r"^\s*\d+\.\s+([^—]+)—\s*(\d{4}-\d{2}-\d{2})", block)
        if not m:
            continue
        sport_name = m.group(1).strip()
        date = m.group(2)
        label = re.search(r"LabelId:\s*(\d+)\s*\|\s*SportType:\s*(\d+)", block)
        dist = re.search(r"Distance:\s*([\d.]+)\s*km", block)
        dur = re.search(r"Duration:\s*([\d:]+)", block)
        hr = re.search(r"Avg HR:\s*(\d+)\s*bpm", block)
        cal = re.search(r"Calories:\s*(\d+)\s*kcal", block)
        location = re.search(r"Location:\s*([^\n]+)", block)
        speed = re.search(r"Average Speed:\s*([\d.]+)\s*km/h", block)
        pace = re.search(r"Average Pace:\s*([\d:]+)\s*/km", block)
        duration_min = None
        if dur:
            try:
                parts = [int(x) for x in dur.group(1).split(":")]
                if len(parts) == 3:
                    duration_min = parts[0] * 60 + parts[1] + parts[2] / 60
                elif len(parts) == 2:
                    duration_min = parts[0] + parts[1] / 60
            except ValueError:
                pass
        rows.append(
            {
                "label_id": label.group(1) if label else None,
                "sport_type": _int(label.group(2)) if label else None,
                "sport": sport_name,
                "date": date,
                "location": location.group(1).strip() if location else None,
                "distance_km": float(dist.group(1)) if dist else None,
                "duration_min": round(duration_min, 1) if duration_min else None,
                "avg_hr": _int(hr.group(1)) if hr else None,
                "calories": _int(cal.group(1)) if cal else None,
                "avg_speed_kmh": float(speed.group(1)) if speed else None,
                "avg_pace": pace.group(1) if pace else None,
            }
        )
    return rows
