"""
每日更新股價資料（由 GitHub Actions 自動執行）。

對每個代號抓「全部歷史」的日收盤價與還原收盤價（含息、含分割調整），
寫成 data/<檔名>.csv，並更新 data/meta.json。

為什麼每次都重抓全部歷史：ETF 配息後，Yahoo 會回頭調整過去所有的
「還原收盤價」，只抓最新一天會跟舊資料對不起來。

安全機制：抓失敗、或抓到的資料筆數明顯比舊檔少，就保留舊檔不覆蓋。
"""
import csv
import json
import math
import os
import sys
import time
from datetime import datetime, timezone, timedelta

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# 檔名, Yahoo 代號, 顯示名稱, 類型, 幣別
TICKERS = [
    ("0050",    "0050.TW",   "元大台灣50",          "etf",   "TWD"),
    ("006208",  "006208.TW", "富邦台50",            "etf",   "TWD"),
    ("00631L",  "00631L.TW", "元大台灣50正2",       "etf",   "TWD"),
    ("VT",      "VT",        "Vanguard 全世界股票", "etf",   "USD"),
    ("VOO",     "VOO",       "Vanguard S&P 500",    "etf",   "USD"),
    ("QQQ",     "QQQ",       "Invesco 那斯達克100", "etf",   "USD"),
    ("QLD",     "QLD",       "ProShares 那斯達克100 正2", "etf", "USD"),
    ("BND",     "BND",       "Vanguard 美國整體債券", "etf", "USD"),
    ("TWII",    "^TWII",     "台灣加權指數",        "index", "TWD"),
    ("GSPC",    "^GSPC",     "S&P 500 指數",        "index", "USD"),
    ("SP500TR", "^SP500TR",  "S&P 500 含息報酬指數", "index", "USD"),
    ("USDTWD",  "TWD=X",     "美元兌台幣",          "fx",    "TWD"),
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def fetch_chart_api(symbol):
    """Yahoo chart API：回傳 [(date, close, adjclose), ...]"""
    p1 = -2208988800  # 1900-01-01，讓 S&P 500 能抓到 1927 年起
    p2 = int(time.time()) + 86400
    last_err = None
    for host in ("query2.finance.yahoo.com", "query1.finance.yahoo.com"):
        url = (f"https://{host}/v8/finance/chart/{requests.utils.quote(symbol)}"
               f"?period1={p1}&period2={p2}&interval=1d&events=div%2Csplit"
               f"&includeAdjustedClose=true")
        try:
            r = requests.get(url, headers={"User-Agent": UA}, timeout=60)
            r.raise_for_status()
            return parse_chart_json(r.json())
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2)
    raise RuntimeError(f"chart api failed: {last_err}")


def parse_chart_json(js):
    res = js["chart"]["result"][0]
    ts = res.get("timestamp") or []
    off = res.get("meta", {}).get("gmtoffset", 0) or 0
    q = res["indicators"]["quote"][0]
    closes = q.get("close") or []
    adj_block = res["indicators"].get("adjclose")
    adjs = adj_block[0]["adjclose"] if adj_block else closes
    rows = []
    for t, c, a in zip(ts, closes, adjs):
        if c is None or a is None:
            continue
        if not (math.isfinite(c) and math.isfinite(a)) or c <= 0 or a <= 0:
            continue
        d = (datetime.fromtimestamp(t, tz=timezone.utc) + timedelta(seconds=off)).date().isoformat()
        rows.append((d, float(c), float(a)))
    return dedupe(rows)


def fetch_yfinance(symbol):
    import yfinance as yf  # 只有 chart API 失敗時才用
    df = yf.download(symbol, period="max", auto_adjust=False, progress=False, actions=False)
    if df is None or df.empty:
        raise RuntimeError("yfinance empty")
    if hasattr(df.columns, "levels"):  # 新版 yfinance 是多層欄位
        df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]
    rows = []
    for idx, row in df.iterrows():
        c, a = row.get("Close"), row.get("Adj Close", row.get("Close"))
        try:
            c, a = float(c), float(a)
        except (TypeError, ValueError):
            continue
        if math.isfinite(c) and math.isfinite(a) and c > 0 and a > 0:
            rows.append((idx.date().isoformat(), c, a))
    return dedupe(rows)


def dedupe(rows):
    """同一天出現兩筆時（盤中暫存資料），保留最後一筆；依日期排序。"""
    out = {}
    for d, c, a in rows:
        out[d] = (d, c, a)
    return [out[k] for k in sorted(out)]


def clean_fx(rows):
    """匯率資料偶爾有單日異常跳動（例如突然 3 倍又跳回來），去掉這種點。"""
    if len(rows) < 3:
        return rows
    keep = [rows[0]]
    for i in range(1, len(rows) - 1):
        prev, cur, nxt = keep[-1][1], rows[i][1], rows[i + 1][1]
        jump_in = abs(cur / prev - 1)
        back = abs(nxt / prev - 1)
        if jump_in > 0.08 and back < 0.03:
            continue  # 跳出去又跳回來 → 錯誤資料
        keep.append(rows[i])
    keep.append(rows[-1])
    return keep


def read_existing(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.reader(f))[1:]


def write_csv(path, rows, decimals):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "close", "adj"])
        for d, c, a in rows:
            w.writerow([d, f"{c:.{decimals}f}".rstrip("0").rstrip("."),
                        f"{a:.{decimals}f}".rstrip("0").rstrip(".")])


def sanity_warnings(name, kind, rows):
    """列出單日漲跌超過 25%（非槓桿）或 45%（槓桿）的日子，寫進 log 方便人工檢查。"""
    lim = 0.45 if name in ("00631L", "QLD") else 0.25
    warns = []
    for i in range(1, len(rows)):
        r = rows[i][2] / rows[i - 1][2] - 1
        if abs(r) > lim:
            warns.append(f"{rows[i][0]} {r:+.1%}")
    return warns


def main():
    os.makedirs(DATA, exist_ok=True)
    meta_path = os.path.join(DATA, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    meta.setdefault("tickers", {})

    ok_count = 0
    for name, sym, label, kind, ccy in TICKERS:
        path = os.path.join(DATA, f"{name}.csv")
        old = read_existing(path)
        rows, src = None, None
        try:
            rows, src = fetch_chart_api(sym), "yahoo-chart"
        except Exception as e:  # noqa: BLE001
            print(f"[{name}] chart API 失敗：{e}；改用 yfinance")
            try:
                rows, src = fetch_yfinance(sym), "yfinance"
            except Exception as e2:  # noqa: BLE001
                print(f"[{name}] yfinance 也失敗：{e2}；保留舊資料")
        if rows and kind == "fx":
            rows = clean_fx(rows)
        if not rows:
            continue
        if old and len(rows) < len(old) * 0.97:
            print(f"[{name}] 新資料只有 {len(rows)} 筆，比舊資料 {len(old)} 筆少太多；保留舊資料")
            continue
        decimals = 4 if kind != "index" else 2
        write_csv(path, rows, decimals)
        warns = sanity_warnings(name, kind, rows)
        if warns:
            print(f"[{name}] 請檢查異常單日變動：{', '.join(warns[:10])}")
        meta["tickers"][name] = {
            "symbol": sym, "label": label, "kind": kind, "ccy": ccy,
            "first": rows[0][0], "last": rows[-1][0], "rows": len(rows), "source": src,
        }
        ok_count += 1
        print(f"[{name}] OK {rows[0][0]} ~ {rows[-1][0]}，{len(rows)} 筆（{src}）")
        time.sleep(1)

    meta["updated"] = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(f"完成：{ok_count}/{len(TICKERS)} 檔更新成功")
    if ok_count == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
