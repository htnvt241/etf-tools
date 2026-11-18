"""
每日更新股價資料（由 GitHub Actions 自動執行）。

對每個代號抓「全部歷史」的日收盤價與還原收盤價（含息、含分割調整），
寫成 data/<檔名>.csv，並更新 data/meta.json。

為什麼每次都重抓全部歷史：ETF 配息後，Yahoo 會回頭調整過去所有的
「還原收盤價」，只抓最新一天會跟舊資料對不起來。

安全機制：抓失敗、或抓到的資料筆數明顯比舊檔少，就保留舊檔不覆蓋。
"""
import bisect
import csv
import hashlib
import json
import math
import os
import sys
import time
from datetime import datetime, timezone, timedelta

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import checks  # noqa: E402

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
    ("NDX",     "^NDX",      "那斯達克 100 指數",   "index", "USD"),
    ("USDTWD",  "TWD=X",     "美元兌台幣",          "fx",    "TWD"),
]

# 台股 ETF 的早期還原股價，Yahoo 的資料有錯（缺 2009 年以前、分割日期錯置、
# 00631L 早期價格異常），所以改用已校對過的歷史當底（data/seed/），
# 底之後的新交易日，再接上 Yahoo 的每日漲跌幅。
SEEDED = {"0050", "00631L"}
# 修改補資料／修正的邏輯時把這個數字加 1，下次執行就不會把「邏輯改變造成的歷史變動」誤判成資料被竄改
LOGIC_VERSION = "4"

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
    # 盤中執行時，Yahoo 會給「今天到目前為止」的價格，不是收盤價 → 去掉
    drop_date = None
    try:
        reg = res["meta"]["currentTradingPeriod"]["regular"]
        if time.time() < reg["end"] + 20 * 60:
            drop_date = (datetime.fromtimestamp(reg["end"], tz=timezone.utc) + timedelta(seconds=off)).date().isoformat()
    except (KeyError, TypeError):
        pass
    rows = []
    for t, c, a in zip(ts, closes, adjs):
        if c is None or a is None:
            continue
        if not (math.isfinite(c) and math.isfinite(a)) or c <= 0 or a <= 0:
            continue
        d = (datetime.fromtimestamp(t, tz=timezone.utc) + timedelta(seconds=off)).date().isoformat()
        if d == drop_date:
            continue
        rows.append((d, float(c), float(a)))
    return dedupe(rows)


def merge_seed(name, rows, ref_rows=None, lev=1, skip=()):
    """以 data/seed/<name>.csv 為底，之後的日子用 Yahoo 的每日漲跌幅接上去。
    底裡面若連續缺 2 天以上，用參考標的（0050→加權指數、00631L→2×0050）的走勢補上，頭尾對齊底的價格。
    參考標的價格沒變的日子（颱風假、停止交易時資料源常會重複前一天的價格）不補。"""
    path = os.path.join(DATA, "seed", f"{name}.csv")
    with open(path, newline="", encoding="utf-8") as f:
        seed = [(d, float(a)) for d, a in list(csv.reader(f))[1:]]
    ymap = {d: (c, a) for d, c, a in rows}
    filled = []
    if ref_rows:
        rdates = [r[0] for r in ref_rows]
        rmap = {r[0]: r[2] for r in ref_rows}
        for k in range(1, len(seed)):
            p_d, p_v = seed[k - 1]
            q_d, q_v = seed[k]
            if p_d not in rmap or q_d not in rmap:
                continue
            mids, prev_v = [], rmap[p_d]
            for d in rdates[bisect.bisect_right(rdates, p_d):bisect.bisect_left(rdates, q_d)]:
                if rmap[d] != prev_v and d not in skip:
                    mids.append(d)
                prev_v = rmap[d]
            if len(mids) < 2:
                continue
            # 參考標的的每日報酬 × 倍數，連成一條路徑，再等比例調整讓終點對上底的價格
            path_v, v, last = [], p_v, rmap[p_d]
            for d in mids + [q_d]:
                v *= 1 + lev * (rmap[d] / last - 1)
                last = rmap[d]
                path_v.append(v)
            adjust = q_v / path_v[-1]
            for j, d in enumerate(mids, 1):
                filled.append((d, path_v[j - 1] * adjust ** (j / (len(mids) + 1))))
    if filled:
        print(f"[{name}] 底資料缺 {len(filled)} 天，已用參考標的走勢補上：{', '.join(d for d, _ in filled)}")
        seed = sorted(seed + filled)
    last_d, last_v = seed[-1]
    out = [(d, a, a) for d, a in seed]
    if last_d in ymap:  # 底的最後一天，收盤價用 Yahoo 的實際價格
        out[-1] = (last_d, ymap[last_d][0], last_v)
    prev = ymap.get(last_d)
    if prev is None:
        print(f"[{name}] Yahoo 找不到 {last_d} 的資料，無法接上新資料")
        return out
    v = last_v
    for d, c, a in rows:
        if d <= last_d:
            continue
        v *= a / prev[1]
        out.append((d, c, v))
        prev = (c, a)
    return out


def merge_fx_seed(yahoo):
    """Yahoo 的匯率 2004 年才開始，2004/10–2006/05、2008/07–08 有缺口，早期數值也有偏差。
    data/seed/USDTWD.csv 是美聯準會 FRED 的歷史資料（1983 年起，手動下載一次）。
    （FRED 網站擋 GitHub 的伺服器，沒辦法每天自動抓。）"""
    path = os.path.join(DATA, "seed", "USDTWD.csv")
    if not os.path.exists(path):
        return yahoo, False
    with open(path, newline="", encoding="utf-8") as f:
        seed = []
        for row in list(csv.reader(f))[1:]:
            try:
                v = float(row[1])
            except (ValueError, IndexError):
                continue
            if v > 0:
                seed.append((row[0], v, v))
    if not seed:
        return yahoo, False
    # FRED（美聯準會中午匯率）比 Yahoo 早期資料準確（Yahoo 2004–2008 偏差 3–4%），
    # 所以 FRED 有的日子一律用 FRED，FRED 最後一天之後才接 Yahoo。
    last = seed[-1][0]
    return seed + [r for r in yahoo if r[0] > last], True


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


def seed_last_date(name):
    with open(os.path.join(DATA, "seed", f"{name}.csv"), encoding="utf-8") as f:
        return f.read().strip().splitlines()[-1].split(",")[0]


def load_known():
    path = os.path.join(DATA, "known_issues.json")
    if not os.path.exists(path):
        return {"fix": [], "ignore": []}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    os.makedirs(DATA, exist_ok=True)
    meta_path = os.path.join(DATA, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    meta.setdefault("tickers", {})
    known = load_known()
    known_note = {e["key"]: e.get("note", "") for e in known["fix"] + known["ignore"]}
    fix_keys = {e["key"] for e in known["fix"]}
    # 修正清單或底資料變了，歷史本來就會變，這次不做「歷史被改動」檢查
    fix_version = hashlib.md5((LOGIC_VERSION + json.dumps(sorted(fix_keys)) + "".join(
        str(os.path.getsize(os.path.join(DATA, "seed", f))) for f in sorted(os.listdir(os.path.join(DATA, "seed")))
    )).encode()).hexdigest()[:10]
    same_fix = meta.get("fix_version") == fix_version

    # 1) 抓資料
    raw, src, old = {}, {}, {}
    for name, sym, label, kind, ccy in TICKERS:
        path = os.path.join(DATA, f"{name}.csv")
        old[name] = [(d, float(c), float(a)) for d, c, a in read_existing(path)]
        rows = None
        try:
            rows, src[name] = fetch_chart_api(sym), "yahoo-chart"
        except Exception as e:  # noqa: BLE001
            print(f"[{name}] chart API 失敗：{e}；改用 yfinance")
            try:
                rows, src[name] = fetch_yfinance(sym), "yfinance"
            except Exception as e2:  # noqa: BLE001
                print(f"[{name}] yfinance 也失敗：{e2}；保留舊資料")
        if rows and kind == "fx":
            rows = clean_fx(rows)
            rows, used = merge_fx_seed(rows)
            if used:
                src[name] = "yahoo+fred-seed"
        if rows and kind == "etf":
            # 上市前的「掛牌價」常是一長串相同價格（例如 006208 上市前都是 30），去掉
            k = 0
            while k + 1 < len(rows) and rows[k][1] == rows[k + 1][1]:
                k += 1
            if k >= 3:
                print(f"[{name}] 去掉上市前重複的掛牌價 {k} 筆：{rows[0][0]} ~ {rows[k - 1][0]}")
                rows = rows[k:]
        if rows:
            raw[name] = rows
        time.sleep(1)

    # 1b) 台股用校對過的底（0050 先做，00631L 用接好的 0050 補缺口）
    for name, *_ in TICKERS:
        if name in SEEDED and name in raw:
            ref, lev, _tol = checks.CROSS[name]
            skip = {k.split("|")[2] for k in known_note if k.startswith(name + "|missing|")}
            raw[name] = merge_seed(name, raw[name], raw.get(ref), lev, skip)
            src[name] += "+seed"

    # 2) 套用已確認的修正（依 TICKERS 順序：0050 先於 00631L、QQQ 先於 QLD）
    fixed_log = []
    for name, *_ in TICKERS:
        dates = {k.split("|")[2] for k in fix_keys if k.startswith(name + "|")}
        if not dates or name not in raw or name not in checks.CROSS:
            continue
        ref, lev, _tol = checks.CROSS[name]
        if ref not in raw:
            continue
        # 只修正「現在確實還被偵測為跳格」的日子（資料源自己改好了就不再動）
        flagged = {i["date"] for i in checks.check_jump(name, raw[name], raw)}
        dates &= flagged
        raw[name], done = checks.apply_fixes(raw[name], raw[ref], lev, dates)
        for d in done:
            fixed_log.append({"ticker": name, "date": d, "note": known_note.get(f"{name}|jump|{d}", "")})
        if done:
            print(f"[{name}] 已用 {('2×' if lev == 2 else '')}{ref} 修正 {len(done)} 天：{', '.join(sorted(done))}")

    # 3) 檢查
    new_issues, ignored, stale = [], [], []
    blocked = set()
    for name, *_ in TICKERS:
        if name not in raw:
            continue
        seed_last = seed_last_date(name) if name in SEEDED else None
        fixed_dates = {f["date"] for f in fixed_log if f["ticker"] == name}
        issues = checks.run_all(name, raw[name], raw, old[name] if same_fix else None, seed_last, fixed_dates)
        for i in issues:
            k = checks.key(i)
            if k in known_note:
                if k not in fix_keys:
                    ignored.append(dict(i, note=known_note[k]))
            elif i["type"] == "stale":
                stale.append(i)
            else:
                new_issues.append(i)
                blocked.add(name)
    for i in new_issues:
        print(f"[{i['ticker']}] ⚠ 新問題 {i['type']} {i['date']}：{i['detail']}")

    # 4) 存檔（有新問題的標的保留舊資料不覆蓋）
    ok_count = 0
    for name, sym, label, kind, ccy in TICKERS:
        if name not in raw:
            continue
        rows = raw[name]
        if name in blocked and old[name]:
            print(f"[{name}] 有新問題，這次不更新，保留舊資料")
            continue
        if old[name] and len(rows) < len(old[name]) * 0.97:
            print(f"[{name}] 新資料只有 {len(rows)} 筆，比舊資料 {len(old[name])} 筆少太多；保留舊資料")
            blocked.add(name)
            new_issues.append({"ticker": name, "type": "rewrite", "date": rows[-1][0],
                               "detail": f"新資料只有 {len(rows)} 筆，比上次 {len(old[name])} 筆少太多"})
            continue
        write_csv(os.path.join(DATA, f"{name}.csv"), rows, 4 if kind != "index" else 2)
        meta["tickers"][name] = {
            "symbol": sym, "label": label, "kind": kind, "ccy": ccy,
            "first": rows[0][0], "last": rows[-1][0], "rows": len(rows), "source": src.get(name, ""),
        }
        ok_count += 1
        print(f"[{name}] OK {rows[0][0]} ~ {rows[-1][0]}，{len(rows)} 筆（{src.get(name, '')}）")

    now = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    meta["updated"] = now
    meta["fix_version"] = fix_version
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    report = {
        "checked": now,
        "status": "problem" if new_issues else "ok",
        "new": new_issues, "blocked": sorted(blocked), "stale": stale,
        "fixed": fixed_log, "ignored": ignored,
    }
    with open(os.path.join(DATA, "check.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(f"完成：{ok_count}/{len(TICKERS)} 檔更新；新問題 {len(new_issues)} 個、"
          f"已修正 {len(fixed_log)} 天、已確認真實或無害 {len(ignored)} 個、落後 {len(stale)} 檔")
    if ok_count == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
