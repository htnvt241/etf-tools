"""
資料檢查：缺漏、跳格（和相關指數交叉比對）、原始價／還原價錯置、歷史資料被改動。

每筆問題：{"ticker", "type", "date", "detail"}
type：
  missing   指數有交易、這檔卻沒資料的日子
  stale     這檔的最新日期落後同市場指數
  gap       兩筆資料之間隔太久（沒有參考指數的標的用）
  jump      單日漲跌和相關指數差太多（或單日漲跌大得不合理）
  ratio     還原價÷原始價的比例在非除息日突然改變（疑似原始價放進還原價，或反過來）
  rewrite   和上次存的資料相比，過去的價格被改掉了
  lag       最近幾個交易日的資料暫時缺漏（資料源晚補）：這次先不更新該檔、不發通知
"""
from datetime import date

# 標的 → (參考標的, 倍數, 容許差距)。每日報酬差距超過容許值就標為跳格
CROSS = {
    "0050":    ("TWII", 1, 0.03),
    "006208":  ("TWII", 1, 0.03),
    "00631L":  ("0050", 2, 0.04),
    "VOO":     ("GSPC", 1, 0.02),
    "VT":      ("GSPC", 1, 0.045),
    "QQQ":     ("NDX",  1, 0.03),
    "QLD":     ("QQQ",  2, 0.04),
    "SP500TR": ("GSPC", 1, 0.015),
    "TWRI":    ("TWII", 1, 0.015),
}
# 沒有參考標的：單日漲跌超過這個就標記
ABS_LIMIT = {"BND": 0.04, "TWII": 0.105, "GSPC": 0.13, "NDX": 0.2, "USDTWD": 0.05}
# 交易日曆：用哪個指數判斷有沒有缺資料
CALENDAR = {
    "0050": "TWII", "006208": "TWII", "00631L": "TWII",
    "VT": "GSPC", "VOO": "GSPC", "QQQ": "GSPC", "QLD": "GSPC", "BND": "GSPC", "SP500TR": "GSPC", "NDX": "GSPC", "TWRI": "TWII",
}
# 沒有日曆參考的標的，兩筆之間最多可以隔幾天（台灣春節可能連休 9 天）
MAX_GAP_DAYS = {"TWII": 12, "GSPC": 6, "USDTWD": 7}
# 有配息、應該檢查「還原÷原始」比例的標的（指數與匯率沒有這個比例）
HAS_RATIO = {"0050", "006208", "00631L", "VT", "VOO", "QQQ", "QLD", "BND"}


def _d(s):
    return date(int(s[:4]), int(s[5:7]), int(s[8:10]))


def check_missing(name, rows, all_rows):
    out = []
    ref = CALENDAR.get(name)
    if not ref or ref not in all_rows:
        return out
    mine = {r[0] for r in rows}
    ref_dates = [r[0] for r in all_rows[ref]]
    first, last = rows[0][0], rows[-1][0]
    recent = ref_dates[max(0, len(ref_dates) - 5)] if ref_dates else ""   # 最近 5 個交易日
    for d in ref_dates:
        if first <= d <= last and d not in mine:
            # 資料源常常晚一點才補上最近幾天：標成「lag」（這次先不更新這檔、不發通知），超過 5 個交易日還缺才算問題
            out.append({"ticker": name, "type": "lag" if d >= recent else "missing", "date": d,
                        "detail": f"{ref} 這天有交易，{name} 沒有資料" + ("（資料源可能還沒補上）" if d >= recent else "")})
    ref_last = ref_dates[-1]
    behind = [d for d in ref_dates if d > last]
    if len(behind) >= 2:
        out.append({"ticker": name, "type": "stale", "date": last,
                    "detail": f"最新資料只到 {last}，{ref} 已經到 {ref_last}（落後 {len(behind)} 個交易日）"})
    return out


def check_gap(name, rows):
    lim = MAX_GAP_DAYS.get(name)
    out = []
    if not lim:
        return out
    for i in range(1, len(rows)):
        g = (_d(rows[i][0]) - _d(rows[i - 1][0])).days
        if g > lim:
            out.append({"ticker": name, "type": "gap", "date": rows[i][0],
                        "detail": f"和前一筆 {rows[i-1][0]} 隔了 {g} 天"})
    return out


def check_jump(name, rows, all_rows):
    out = []
    if name in CROSS and CROSS[name][0] in all_rows:
        ref, lev, tol = CROSS[name]
        rmap = {r[0]: r[2] for r in all_rows[ref]}
        for i in range(1, len(rows)):
            d0, d1 = rows[i - 1][0], rows[i][0]
            if d0 not in rmap or d1 not in rmap:
                continue
            r = rows[i][2] / rows[i - 1][2] - 1
            rr = lev * (rmap[d1] / rmap[d0] - 1)
            if abs(r - rr) > tol:
                out.append({"ticker": name, "type": "jump", "date": d1,
                            "detail": f"單日 {r:+.1%}，但 {('2×' if lev == 2 else '')}{ref} 是 {rr:+.1%}"})
    elif name in ABS_LIMIT:
        lim = ABS_LIMIT[name]
        for i in range(1, len(rows)):
            r = rows[i][2] / rows[i - 1][2] - 1
            if abs(r) > lim:
                out.append({"ticker": name, "type": "jump", "date": rows[i][0],
                            "detail": f"單日 {r:+.1%}，超過合理範圍 ±{lim:.0%}"})
    return out


def check_ratio(name, rows, seed_last=None, fixed=()):
    """還原價÷原始價：除息日才會變（往現在越接近 1），而且一次變動不會太大。"""
    out = []
    if name not in HAS_RATIO:
        return out
    prev = None
    for d, c, a in rows:
        if seed_last and d <= seed_last:
            continue  # 校對過的底沒有原始價，不檢查
        q = a / c
        if prev is not None and prev[0] not in fixed:  # 剛修正過的隔天，比例本來就會小幅移動
            ch = q / prev[1] - 1
            if ch < -0.005 or ch > 0.15:
                out.append({"ticker": name, "type": "ratio", "date": d,
                            "detail": f"還原÷原始的比例從 {prev[1]:.4f} 變成 {q:.4f}（{prev[0]} → {d}）"})
        prev = (d, q)
    if rows and abs(rows[-1][2] / rows[-1][1] - 1) > 0.02:
        out.append({"ticker": name, "type": "ratio", "date": rows[-1][0],
                    "detail": f"最新一天還原價 {rows[-1][2]} 和原始價 {rows[-1][1]} 差超過 2%"})
    return out


def check_rewrite(name, rows, old_rows):
    """和上次的資料比：配息後整段歷史會等比例調整（正常），但不應該只有中間某一段被改。"""
    out = []
    if not old_rows:
        return out
    new = {r[0]: r[2] for r in rows}
    prev_f, prev_d = None, None
    tail_start = old_rows[max(0, len(old_rows) - 10)][0]  # 最近 10 天內的調整視為正常（除息）
    for d, _c, a in old_rows:
        if d not in new or a <= 0:
            continue
        f = new[d] / a
        if prev_f is not None and abs(f / prev_f - 1) > 0.01 and d < tail_start:
            out.append({"ticker": name, "type": "rewrite", "date": d,
                        "detail": f"和上次存的資料相比，{prev_d} 到 {d} 之間的歷史價格被改了 {f/prev_f-1:+.1%}"})
        prev_f, prev_d = f, d
    old_dates = sorted(r[0] for r in old_rows)
    dropped = [d for d in old_dates if d not in new and d >= rows[0][0]]
    if dropped:
        recent = old_dates[max(0, len(old_dates) - 5)]
        lag = all(d >= recent for d in dropped)   # 只少了最近幾天：資料源暫時漏掉，通常下次就恢復
        out.append({"ticker": name, "type": "lag" if lag else "rewrite", "date": min(dropped),
                    "detail": f"上次有、這次卻不見的日子 {len(dropped)} 天（最早 {min(dropped)}）" + ("，可能是資料源暫時漏掉" if lag else "")})
    return out


def run_all(name, rows, all_rows, old_rows=None, seed_last=None, fixed=()):
    issues = []
    issues += check_missing(name, rows, all_rows)
    issues += check_gap(name, rows)
    issues += check_jump(name, rows, all_rows)
    issues += check_ratio(name, rows, seed_last, fixed)
    issues += check_rewrite(name, rows, old_rows)
    return issues


def apply_fixes(rows, ref_rows, lev, fix_dates):
    """把指定日子的每日報酬，換成「參考標的報酬 × 倍數」，再從最新一天往回重建整條還原價。
    最新價格不變；錯誤那天之前的歷史會等比例修正。原始價也一起修正（維持當時的還原比例）。"""
    if not fix_dates:
        return rows, []
    rmap = {r[0]: r[2] for r in ref_rows}
    n = len(rows)
    rets = [None] * n
    done = []
    for i in range(1, n):
        d0, d1 = rows[i - 1][0], rows[i][0]
        r = rows[i][2] / rows[i - 1][2] - 1
        if d1 in fix_dates and d0 in rmap and d1 in rmap:
            r = lev * (rmap[d1] / rmap[d0] - 1)
            done.append(d1)
        rets[i] = r
    adj = [0.0] * n
    adj[-1] = rows[-1][2]
    for i in range(n - 1, 0, -1):
        adj[i - 1] = adj[i] / (1 + rets[i])
    out = []
    for i, (d, c, a) in enumerate(rows):
        if d in fix_dates and i > 0:
            c = adj[i] * (out[i - 1][1] / adj[i - 1])
        out.append((d, c, adj[i]))
    return out, done


def key(i):
    return f'{i["ticker"]}|{i["type"]}|{i["date"]}'
