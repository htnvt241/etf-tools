/* 「看 A 做 B」訊號回測共用引擎：Kalman 趨勢回測、均線包絡策略共用（網頁和 Web Worker 都能載入）
   規則：B 第 i 天收盤時，依「前一個交易日（含）以前 A 的訊號」調整持倉（隔天收盤成交）。
   on[i]＝1：若持有現金就全部買進 B；off[i]＝1：若持有 B 就全部賣出、改持有現金（不計利息）。 */
(function (G) {
  const DAY = 86400000, FEE = 0.001425;
  const dnum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const years = (a, b) => (dnum(b) - dnum(a)) / (365.25 * DAY);
  function lowerBound(dates, d) { let lo = 0, hi = dates.length; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] < d) lo = m + 1; else hi = m; } return lo; }
  const floorIdx = (dates, d) => lowerBound(dates, d + "￿") - 1;
  function addYears(s, n) { const y = +s.slice(0, 4) + n; let m = s.slice(5, 7), d = s.slice(8, 10); if (m === "02" && d === "29") d = "28"; return `${y}-${m}-${d}`; }

  // jmap[i]＝B 第 i 天要參考的 A 最後一天（A 日期 ≤ B 前一個交易日），-1 表示還沒有
  function alignMap(aDates, bDates) {
    const jm = new Int32Array(bDates.length); jm[0] = -1; let j = -1;
    for (let i = 1; i < bDates.length; i++) { while (j + 1 < aDates.length && aDates[j + 1] <= bDates[i - 1]) j++; jm[i] = j; }
    return jm;
  }
  // 狀態型訊號（例如多頭＝1）：取最近一天的狀態
  function alignState(arr, jm) { const o = new Int8Array(jm.length); for (let i = 1; i < jm.length; i++) o[i] = jm[i] >= 0 ? arr[jm[i]] : 0; return o; }
  // 事件型訊號（例如「今天向上穿越」）：上一個 B 交易日之後到這次之間，A 只要有一天發生就算（保留事件的代碼，例如要買第幾檔）
  function alignEvent(arr, jm) {
    const o = new Int8Array(jm.length);
    for (let i = 1; i < jm.length; i++) { const a = Math.max(0, i > 1 ? jm[i - 1] + 1 : jm[i]); for (let j = a; j <= jm[i]; j++) if (arr[j]) { o[i] = arr[j]; break; } }
    return o;
  }

  function fees(cost) { return { buy: FEE * cost.disc, sell: FEE * cost.disc + cost.tax }; }

  // 完整回測（含每日資產、交易紀錄）
  // p：一檔的價格陣列，或多檔價格陣列的清單（同一組日期）；on[i] 的值＝要買第幾檔（1＝第一檔）
  function backtest(dates, p, on, off, i0, i1, cost, keep) {
    const f = fees(cost), P = Array.isArray(p) ? p : [p];
    let cash = 1, sh = 0, pos = 0, h = 0, peak = 1, mdd = 0, inDays = 0, entryVal = 0, wins = 0, trades = 0;
    const val = keep ? new Float64Array(i1 - i0 + 1) : null, log = keep ? [] : null;
    for (let i = i0; i <= i1; i++) {
      if (!pos && on[i]) { h = on[i] - 1; const q = P[h][i]; sh = cash / (q * (1 + f.buy)); entryVal = cash; cash = 0; pos = 1; if (keep) log.push({ i, act: "買進", px: q, asset: h }); }
      else if (pos && off[i]) { const q = P[h][i]; cash = sh * q * (1 - f.sell); trades++; if (cash > entryVal) wins++; if (keep) log.push({ i, act: "賣出", px: q, asset: h, ret: cash / entryVal - 1 }); sh = 0; pos = 0; }
      const v = cash + sh * P[h][i];
      if (pos) inDays++;
      if (v > peak) peak = v; else { const d = v / peak - 1; if (d < mdd) mdd = d; }
      if (keep) val[i - i0] = v;
    }
    const fin = cash + sh * P[h][i1];
    if (pos) { trades++; if (fin > entryVal) wins++; }   // 期末仍持有的那一筆，以期末市值計勝負
    const yrs = years(dates[i0], dates[i1]);
    return { fin, tot: fin - 1, cagr: Math.pow(fin, 1 / yrs) - 1, mdd, trades, wins, inPct: inDays / (i1 - i0 + 1), val, log, i0, i1, yrs, openAtEnd: pos === 1, heldAtEnd: h };
  }
  // 精簡版：只算「年化 ÷ 最大回撤」，最佳化時大量呼叫
  function calmarFast(p, on, off, s, e, f, yrs) {
    let cash = 1, sh = 0, pos = 0, peak = 1, mdd = 0;
    for (let i = s; i <= e; i++) {
      if (!pos && on[i]) { sh = cash / (p[i] * (1 + f.buy)); cash = 0; pos = 1; }
      else if (pos && off[i]) { cash = sh * p[i] * (1 - f.sell); sh = 0; pos = 0; }
      const v = cash + sh * p[i];
      if (v > peak) peak = v; else { const d = v / peak - 1; if (d < mdd) mdd = d; }
    }
    const fin = cash + sh * p[e];
    return (Math.pow(fin, 1 / yrs) - 1) / Math.max(0.01, -mdd);
  }
  function buyHold(dates, p, i0, i1, keep) {
    let peak = 0, mdd = 0; const val = keep ? new Float64Array(i1 - i0 + 1) : null;
    for (let i = i0; i <= i1; i++) { const v = p[i] / p[i0]; if (v > peak) peak = v; else { const d = v / peak - 1; if (d < mdd) mdd = d; } if (keep) val[i - i0] = v; }
    const fin = p[i1] / p[i0], yrs = years(dates[i0], dates[i1]);
    return { fin, tot: fin - 1, cagr: Math.pow(fin, 1 / yrs) - 1, mdd, trades: 0, wins: 0, inPct: 1, val, i0, i1, yrs };
  }
  // 10 年區間：期間內每年 1/1 起算一個，再加上「最近 10 年」
  function windows(dates, i0, i1) {
    const out = [], y0 = +dates[i0].slice(0, 4), endD = dates[i1];
    for (let y = y0; ; y++) {
      const s = Math.max(i0, lowerBound(dates, `${y}-01-01`)), eD = `${y + 10}-01-01`;
      if (eD > endD) break;
      const e = lowerBound(dates, eD) - 1;
      if (e - s > 2000) out.push([s, e]);
    }
    const s = lowerBound(dates, addYears(endD, -10));
    if (s >= i0 && (!out.length || out[out.length - 1][0] !== s)) out.push([s, i1]);
    return out;
  }
  const calmar = r => r.cagr / Math.max(0.01, -r.mdd);
  // 單一參數的最佳化分數：70% 各 10 年區間平均＋30% 最差區間
  function windowScore(p, on, off, wins, f, wyrs) {
    let sum = 0, mn = Infinity;
    for (let k = 0; k < wins.length; k++) { const c = calmarFast(p, on, off, wins[k][0], wins[k][1], f, wyrs[k]); sum += c; if (c < mn) mn = c; }
    return 0.7 * sum / wins.length + 0.3 * mn;
  }
  /* 高原型挑選（任意維度的格子）
     score：攤平的分數（NaN＝無效組合）；dims：各維格數；rad：各維看前後幾格。
     每個點的高原分數＝周圍有效點的平均 − 0.5 × 標準差；周圍有效點不到完整數量的 2/3（邊角）不列入。 */
  function plateau(score, dims, rad) {
    const nd = dims.length, stride = new Array(nd); let full = 1;
    stride[nd - 1] = 1; for (let d = nd - 2; d >= 0; d--) stride[d] = stride[d + 1] * dims[d + 1];
    rad.forEach(r => full *= 2 * r + 1);
    const offs = []; (function rec(d, cur) { if (d === nd) { offs.push(cur.slice()); return; } for (let o = -rad[d]; o <= rad[d]; o++) { cur.push(o); rec(d + 1, cur); cur.pop(); } })(0, []);
    let best = null; const idx = new Array(nd);
    for (let f = 0; f < score.length; f++) {
      if (!isFinite(score[f])) continue;
      let r = f; for (let d = 0; d < nd; d++) { idx[d] = Math.floor(r / stride[d]); r -= idx[d] * stride[d]; }
      let n = 0, s1 = 0, s2 = 0;
      for (const o of offs) {
        let g = 0, ok = true;
        for (let d = 0; d < nd; d++) { const v = idx[d] + o[d]; if (v < 0 || v >= dims[d]) { ok = false; break; } g += v * stride[d]; }
        if (!ok || !isFinite(score[g])) continue;
        n++; s1 += score[g]; s2 += score[g] * score[g];
      }
      if (n * 3 < full * 2) continue;
      const m = s1 / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m)), ps = m - 0.5 * sd;
      if (!best || ps > best.ps) best = { at: idx.slice(), ps, self: score[f], nbMean: m, nbRatio: m / score[f] };
    }
    return best;
  }
  function sma(px, n) {
    const o = new Float64Array(px.length).fill(NaN); let s = 0;
    for (let i = 0; i < px.length; i++) { s += px[i]; if (i >= n) s -= px[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  function kalman(src, length, R = 0.01, Q = 0.1) {
    const n = src.length, out = new Float64Array(n); let est = NaN, errEst = 1.0; const errMeas = R * length;
    for (let i = 0; i < n; i++) {
      if (isNaN(est)) est = i > 0 ? src[i - 1] : src[i];
      const gain = errEst / (errEst + errMeas);
      est = est + gain * (src[i] - est);
      errEst = (1 - gain) * errEst + Q / length;
      out[i] = est;
    }
    return out;
  }
  G.SB = { years, lowerBound, floorIdx, addYears, alignMap, alignState, alignEvent, fees, backtest, calmarFast, buyHold, windows, calmar, windowScore, plateau, sma, kalman };
})(typeof self !== "undefined" ? self : this);
