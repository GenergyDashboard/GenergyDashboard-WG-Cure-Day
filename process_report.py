"""
process_report.py — Extracts PV Power(kW) for the configured station from GoodWe report.
Updates data/history.json with today's hourly data and daily totals.
"""
import json, sys, os
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
    report_date_str = None
    for col in df.columns:
        val = str(df.iloc[0, col])
        if "Report Date:" in val:
            report_date_str = val.split("Report Date:")[-1].strip()
            break
    if not report_date_str: raise ValueError("Could not find Report Date")
    report_date = datetime.strptime(report_date_str, "%d-%m-%Y").date()

    pv_row = None
    for idx in range(2, len(df)):
        if station_name.lower() in str(df.iloc[idx, 0]).lower() and "pv power" in str(df.iloc[idx, 1]).lower():
            pv_row = idx; break
    if pv_row is None: raise ValueError(f"PV Power row not found for '{station_name}'")

    hourly = {}
    for h in range(24):
        val = df.iloc[pv_row, h + 2]
        hourly[str(h)] = round(float(val), 2) if pd.notna(val) else None
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
