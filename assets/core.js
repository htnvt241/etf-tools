/* 共用：標的設定、讀取資料、估算延伸、匯率換算、各種計算。
   瀏覽器裡掛在 window.ET；在 node 測試時用 module.exports。 */
(function (root) {
  "use strict";

  // 每檔固定一個顏色（顏色跟著標的走，不因選擇順序改變）
  const TICKERS = {
    "0050":   { label: "0050",   name: "元大台灣50",            ccy: "TWD", kind: "etf", color: 1 },
    "006208": { label: "006208", name: "富邦台50",              ccy: "TWD", kind: "etf", color: 3,
                ext: { base: "0050", lev: 1, note: "上市前用 0050 推估（追蹤同一個指數）" } },
    "00631L": { label: "00631L", name: "元大台灣50正2",         ccy: "TWD", kind: "etf", color: 2,
                ext: { base: "0050", lev: 2, note: "上市前用 0050 每日報酬 ×2 減成本推估" } },
    "VT":     { label: "VT",     name: "Vanguard 全世界股票",   ccy: "USD", kind: "etf", color: 6 },
    "VOO":    { label: "VOO",    name: "Vanguard S&P 500",      ccy: "USD", kind: "etf", color: 7,
                ext: { base: "SP500TR", lev: 1, note: "上市前用 S&P 500 含息報酬指數減成本推估" } },
    "QQQ":    { label: "QQQ",    name: "Invesco 那斯達克100",   ccy: "USD", kind: "etf", color: 4 },
    "QLD":    { label: "QLD",    name: "ProShares 那斯達克100 正2", ccy: "USD", kind: "etf", color: 5,
                ext: { base: "QQQ", lev: 2, note: "上市前用 QQQ 每日報酬 ×2 減成本推估" } },
    "BND":    { label: "BND",    name: "Vanguard 美國整體債券", ccy: "USD", kind: "etf", color: 8 },
    "TWII":   { label: "加權指數", name: "台灣加權指數（不含息）", ccy: "TWD", kind: "index" },
    "GSPC":   { label: "S&P 500", name: "S&P 500 指數（不含息）", ccy: "USD", kind: "index" },
    "SP500TR":{ label: "S&P 500 含息", name: "S&P 500 含息報酬指數", ccy: "USD", kind: "index" },
    "USDTWD": { label: "美元/台幣", name: "美元兌台幣匯率", ccy: "TWD", kind: "fx" },
  };
  const ETF_LIST = ["0050", "006208", "00631L", "VT", "VOO", "QQQ", "QLD", "BND"];

  // ---------- 日期 ----------
  const DAY = 864e5;
  function dnum(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function dstr(n) { return new Date(n).toISOString().slice(0, 10); }
  function years(a, b) { return (dnum(b) - dnum(a)) / (365.25 * DAY); }
  function addYears(s, n) {
    const y = +s.slice(0, 4) + n; let m = s.slice(5, 7), d = s.slice(8, 10);
    if (m === "02" && d === "29") d = "28";
    return `${y}-${m}-${d}`;
  }
  // 第一個 >= d 的位置
  function lowerBound(dates, d) {
    let lo = 0, hi = dates.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < d) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // 最後一個 <= d 的位置（沒有就 -1）
  function floorIdx(dates, d) { return lowerBound(dates, d + "￿") - 1; }

  // ---------- 讀資料 ----------
  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    const n = lines.length - 1;
    const dates = new Array(n), close = new Float64Array(n), adj = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = lines[i + 1].split(",");
      dates[i] = p[0]; close[i] = +p[1]; adj[i] = +p[2];
    }
    return { dates, close, adj };
  }
  const cache = {};
  function load(name, base) {
    base = base || "data/";
    if (!cache[name]) {
      cache[name] = fetch(base + name + ".csv", { cache: "no-cache" })
        .then(r => { if (!r.ok) throw new Error(name + " 資料讀取失敗"); return r.text(); })
        .then(parseCSV);
    }
    return cache[name];
  }
  function loadMeta(base) {
    return fetch((base || "data/") + "meta.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : {});
  }

  // ---------- 用基準標的往前推估 ----------
  // 回傳 {drag, years}：年化成本（小數），用兩者重疊期間校準。
  // 推估每日報酬 = lev × 基準報酬 − drag/252
  function calibrate(target, base, lev) {
    const i0 = lowerBound(base.dates, target.dates[0]);
    let logEst = 0, n = 0, prevB = null, firstD = null, lastD = null;
    let j = 0;
    for (let i = i0; i < base.dates.length; i++) {
      const d = base.dates[i];
      while (j < target.dates.length && target.dates[j] < d) j++;
      if (j >= target.dates.length) break;
      if (target.dates[j] !== d) continue;
      if (prevB !== null) { logEst += Math.log(1 + lev * (base.adj[i] / prevB - 1)); n++; }
      else firstD = j;
      prevB = base.adj[i]; lastD = j;
    }
    if (n < 250 || firstD === null) return { drag: 0, years: 0 };
    const logAct = Math.log(target.adj[lastD] / target.adj[firstD]);
    const yrs = n / 252;
    return { drag: (logEst - logAct) / yrs, years: yrs };
  }

  // 把基準標的「上市前」那段接在 target 前面。回傳新序列，estN = 前面幾筆是估算的
  function extend(target, base, lev, drag) {
    const first = target.dates[0];
    const k = lowerBound(base.dates, first); // base 在 target 第一天的位置
    const kk = (k < base.dates.length && base.dates[k] === first) ? k : k - 1;
    if (kk <= 0) return { dates: target.dates, adj: target.adj, close: target.close, estN: 0 };
    const pre = [], val = [];
    let v = target.adj[0];
    for (let i = kk; i > 0; i--) {
      const r = lev * (base.adj[i] / base.adj[i - 1] - 1) - drag / 252;
      v = v / (1 + r);
      pre.push(base.dates[i - 1]); val.push(v);
    }
    pre.reverse(); val.reverse();
    const n = pre.length, m = target.dates.length;
    const dates = pre.concat(target.dates);
    const adj = new Float64Array(n + m);
    adj.set(val, 0); adj.set(target.adj, n);
    return { dates, adj, close: null, estN: n };
  }

  // ---------- 匯率換算 ----------
  // 把美元計價的序列換成台幣：每天乘上當天（或之前最近一天）的匯率。匯率資料開始前的日子會被切掉。
  function toTWD(s, fx) {
    const out = { dates: [], adj: [], estN: 0 };
    let j = -1;
    for (let i = 0; i < s.dates.length; i++) {
      while (j + 1 < fx.dates.length && fx.dates[j + 1] <= s.dates[i]) j++;
      if (j < 0) continue;
      if (i < s.estN) out.estN++;
      out.dates.push(s.dates[i]); out.adj.push(s.adj[i] * fx.adj[j]);
    }
    out.adj = Float64Array.from(out.adj);
    return out;
  }

  // 依期間切片
  function slice(s, start, end) {
    const a = lowerBound(s.dates, start), b = floorIdx(s.dates, end) + 1;
    return {
      dates: s.dates.slice(a, b),
      adj: s.adj.slice(a, b),
      estN: Math.max(0, Math.min((s.estN || 0) - a, b - a)),
    };
  }

  // ---------- 計算 ----------
  function maxDrawdown(vals) {
    let peak = -Infinity, mdd = 0, pi = 0, from = 0, to = 0;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] > peak) { peak = vals[i]; pi = i; }
      const dd = vals[i] / peak - 1;
      if (dd < mdd) { mdd = dd; from = pi; to = i; }
    }
    return { mdd, from, to };
  }
  function drawdownSeries(vals) {
    const out = new Float64Array(vals.length); let peak = -Infinity;
    for (let i = 0; i < vals.length; i++) { if (vals[i] > peak) peak = vals[i]; out[i] = vals[i] / peak - 1; }
    return out;
  }
  function volatility(vals) {
    let s = 0, s2 = 0, n = 0;
    for (let i = 1; i < vals.length; i++) { const r = Math.log(vals[i] / vals[i - 1]); s += r; s2 += r * r; n++; }
    if (n < 2) return NaN;
    const mean = s / n;
    return Math.sqrt((s2 / n - mean * mean) * n / (n - 1)) * Math.sqrt(252);
  }
  // 日曆年度報酬。第一年從期間第一天算（partial=true）
  function annualReturns(s) {
    const out = []; let startV = s.adj[0], startI = 0, y = s.dates[0].slice(0, 4);
    for (let i = 1; i <= s.dates.length; i++) {
      const yy = i < s.dates.length ? s.dates[i].slice(0, 4) : null;
      if (yy !== y) {
        const endV = s.adj[i - 1];
        out.push({ year: +y, ret: endV / startV - 1,
                   partial: startI === 0 && s.dates[0].slice(5) > "01-10" || (yy === null && s.dates[i - 1].slice(5) < "12-20"),
                   est: startI < (s.estN || 0) });
        startV = endV; startI = i; y = yy;
      }
    }
    return out;
  }

  // 單筆投入
  function lumpSum(s, amount) {
    const v0 = s.adj[0], n = s.adj.length;
    const value = new Float64Array(n);
    for (let i = 0; i < n; i++) value[i] = amount * s.adj[i] / v0;
    const yrs = years(s.dates[0], s.dates[n - 1]);
    const fin = value[n - 1];
    return {
      dates: s.dates, value, invested: amount, final: fin,
      totalRet: fin / amount - 1,
      cagr: yrs > 0 ? Math.pow(fin / amount, 1 / yrs) - 1 : NaN,
      mdd: maxDrawdown(value), vol: volatility(s.adj), years: yrs,
    };
  }

  // 定期定額：每月第一個交易日買進（可買零股，不計手續費）
  function dca(s, amount) {
    const n = s.adj.length; let units = 0, inv = 0, month = "";
    const value = new Float64Array(n), invested = new Float64Array(n), flows = [];
    for (let i = 0; i < n; i++) {
      const m = s.dates[i].slice(0, 7);
      if (m !== month) { month = m; units += amount / s.adj[i]; inv += amount; flows.push([s.dates[i], -amount]); }
      value[i] = units * s.adj[i]; invested[i] = inv;
    }
    const fin = value[n - 1];
    flows.push([s.dates[n - 1], fin]);
    let worst = 0, wi = 0;
    for (let i = 0; i < n; i++) { const r = value[i] / invested[i] - 1; if (r < worst) { worst = r; wi = i; } }
    return {
      dates: s.dates, value, investedSeries: invested, invested: inv, final: fin,
      totalRet: fin / inv - 1, irr: xirr(flows), worstLoss: worst, worstAt: s.dates[wi],
      mdd: maxDrawdown(s.adj), vol: volatility(s.adj), years: years(s.dates[0], s.dates[n - 1]),
      buys: flows.length - 1,
    };
  }

  // 年化內部報酬率（定期定額的年化報酬）
  function xirr(flows) {
    const t0 = dnum(flows[0][0]);
    const f = r => flows.reduce((a, [d, c]) => a + c / Math.pow(1 + r, (dnum(d) - t0) / (365.25 * DAY)), 0);
    let lo = -0.99, hi = 5, flo = f(lo), fhi = f(hi);
    if (flo * fhi > 0) return NaN;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (Math.abs(fm) < 1e-7) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  // 滾動報酬：每個月第一個交易日當起點，持有 N 年的年化報酬
  function rolling(s, N) {
    const pts = []; let month = "";
    for (let i = 0; i < s.dates.length; i++) {
      const m = s.dates[i].slice(0, 7);
      if (m === month) continue;
      month = m;
      const endD = addYears(s.dates[i], N);
      const j = lowerBound(s.dates, endD);
      if (j >= s.dates.length) break;
      const r = Math.pow(s.adj[j] / s.adj[i], 1 / years(s.dates[i], s.dates[j])) - 1;
      pts.push({ date: s.dates[i], end: s.dates[j], ret: r, est: i < (s.estN || 0) });
    }
    if (!pts.length) return { pts, n: 0 };
    const rs = pts.map(p => p.ret).sort((a, b) => a - b);
    const q = p => rs[Math.min(rs.length - 1, Math.max(0, Math.round(p * (rs.length - 1))))];
    let minP = pts[0], maxP = pts[0];
    for (const p of pts) { if (p.ret < minP.ret) minP = p; if (p.ret > maxP.ret) maxP = p; }
    return {
      pts, n: pts.length, posRate: rs.filter(r => r > 0).length / rs.length,
      min: minP, max: maxP, p25: q(0.25), median: q(0.5), p75: q(0.75),
    };
  }

  // 首頁用：各期間報酬
  function periodChange(s, i, calYears) {
    const n = s.dates.length, last = s.dates[n - 1];
    if (calYears === "ytd") {
      const j = floorIdx(s.dates, (+last.slice(0, 4) - 1) + "-12-31");
      return j >= 0 ? s.adj[n - 1] / s.adj[j] - 1 : NaN;
    }
    const j = floorIdx(s.dates, addYears(last, -calYears));
    return j >= 0 && s.dates[0] <= addYears(last, -calYears) ? s.adj[n - 1] / s.adj[j] - 1 : NaN;
  }

  // ---------- 格式 ----------
  const fmt = {
    pct(x, d = 1) { return isFinite(x) ? (x * 100).toFixed(d) + "%" : "—"; },
    spct(x, d = 1) { return isFinite(x) ? (x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%" : "—"; },
    num(x, d = 0) { return isFinite(x) ? x.toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—"; },
    money(x, ccy) {
      if (!isFinite(x)) return "—";
      if (ccy === "USD") return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 });
      return "NT$" + Math.round(x).toLocaleString("zh-TW");
    },
  };

  const ET = { TICKERS, ETF_LIST, dnum, dstr, years, addYears, lowerBound, floorIdx, parseCSV, load, loadMeta,
    calibrate, extend, toTWD, slice, maxDrawdown, drawdownSeries, volatility, annualReturns,
    lumpSum, dca, xirr, rolling, periodChange, fmt };
  if (typeof module !== "undefined" && module.exports) module.exports = ET; else root.ET = ET;
})(typeof window !== "undefined" ? window : globalThis);
