"""
process_report.py — Extracts PV Power(kW) for the configured station from GoodWe report.
Updates data/history.json with today's hourly data and daily totals.
"""
import json, sys, os, re
from datetime import datetime
import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
HISTORY_PATH = os.path.join(SCRIPT_DIR, "data", "history.json")
DEFAULT_REPORT = os.path.join(SCRIPT_DIR, "data", "raw_report.xlsx")

def load_json(path):
    with open(path) as f: return json.load(f)

def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f: json.dump(data, f, indent=2)

def extract_pv_power(report_path, station_name):
    df = pd.read_excel(report_path, header=None)

    # Search ALL rows and columns for "Report Date:" (may be in row 0, 1, or elsewhere)
    report_date_str = None
    for row_idx in range(min(10, len(df))):
        for col_idx in range(min(5, len(df.columns))):
            val = str(df.iloc[row_idx, col_idx])
            if "report date" in val.lower():
                # Handle formats like "Report Date:30-03-2026" or "Report Date: 30-03-2026"
                report_date_str = val.split(":")[-1].strip()
                # If the colon split grabbed too much (e.g. from time), try after "Date:"
                if "Date" in val:
                    report_date_str = val.split("Date:")[-1].strip()
                break
        if report_date_str: break

    if not report_date_str:
        # Fallback: try to extract date from filename (e.g. _20260330_)
        import re
        match = re.search(r'(\d{8})', os.path.basename(report_path))
        if match:
            ds = match.group(1)
            report_date_str = f"{ds[6:8]}-{ds[4:6]}-{ds[0:4]}"

    if not report_date_str: raise ValueError("Could not find Report Date in file or filename")

    # Parse date - handle both DD-MM-YYYY and YYYY-MM-DD
    report_date_str = report_date_str.strip()
    try:
        report_date = datetime.strptime(report_date_str, "%d-%m-%Y").date()
    except ValueError:
        try:
            report_date = datetime.strptime(report_date_str, "%Y-%m-%d").date()
        except ValueError:
            report_date = datetime.strptime(report_date_str, "%d/%m/%Y").date()

    # Find the header row (contains "Indicator" or hour columns like "00:00")
    header_row = None
    for row_idx in range(min(10, len(df))):
        row_vals = [str(df.iloc[row_idx, c]).lower() for c in range(min(5, len(df.columns)))]
        if 'indicator' in row_vals or '00:00' in row_vals:
            header_row = row_idx; break

    if header_row is None: header_row = 2  # fallback

    # Find PV Power row for our station (search all rows after header)
    pv_row = None
    for idx in range(header_row + 1, len(df)):
        cell0 = str(df.iloc[idx, 0]).lower()
        cell1 = str(df.iloc[idx, 1]).lower()
        if station_name.lower() in cell0 and "pv power" in cell1:
            pv_row = idx; break

    if pv_row is None: raise ValueError(f"PV Power row not found for '{station_name}'")

    # Extract hourly values (columns after Station Info + Indicator = hour columns)
    # Find which column has "00:00" to determine the offset
    hour_col_offset = 2  # default
    for col_idx in range(len(df.columns)):
        if str(df.iloc[header_row, col_idx]).strip() == '00:00':
            hour_col_offset = col_idx; break

    hourly = {}
    for h in range(24):
        col_idx = hour_col_offset + h
        if col_idx < len(df.columns):
            val = df.iloc[pv_row, col_idx]
            hourly[str(h)] = round(float(val), 2) if pd.notna(val) else None
        else:
            hourly[str(h)] = None
    return report_date, hourly

def main():
    report_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_REPORT
    if not os.path.exists(report_path): print(f"❌ Not found: {report_path}"); sys.exit(1)

    config = load_json(CONFIG_PATH)
    history = load_json(HISTORY_PATH) if os.path.exists(HISTORY_PATH) else {"monthly":[],"daily":{},"today":{"date":"","hourly_kw":[]}}
    station = config["station_name_in_report"]

    print(f"📊 Processing: {report_path} for {station}")
    report_date, hourly = extract_pv_power(report_path, station)
    date_str, month_str = str(report_date), report_date.strftime("%Y-%m")

    history["today"] = {"date": date_str, "hourly_kw": [hourly.get(str(h)) for h in range(24)]}

    valid = [v for v in hourly.values() if v and v > 0]
    daily_total = round(sum(valid), 1)

    if month_str not in history["daily"]: history["daily"][month_str] = []
    daily_list = history["daily"][month_str]
    found = False
    for entry in daily_list:
        if entry["date"] == date_str: entry["actual_kwh"] = daily_total; found = True; break
    if not found: daily_list.append({"date": date_str, "actual_kwh": daily_total})
    history["daily"][month_str] = sorted(daily_list, key=lambda x: x["date"])

    save_json(HISTORY_PATH, history)
    tariff = config["tariffs"][-1]["rate"]
    for t in config["tariffs"]:
        if t["from"] <= date_str <= t["to"]: tariff = t["rate"]; break
    print(f"📅 {report_date} | ⚡ {daily_total} kWh | 💰 R{daily_total*tariff:.2f} | ✅ Saved")

if __name__ == "__main__": main()
