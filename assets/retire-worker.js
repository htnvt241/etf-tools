/* 退休提領：穩健配置搜尋（Web Worker）
   對候選 ETF 的每一種比例：算出組合的月報酬（照再平衡方式）→ 每個 12 個月區塊的年報酬 →
   用「同一批」抽樣（每次模擬、每一年抽到哪個區塊都一樣）跑 10,000 次退休模擬，算成功率與期末資產。
   再挑「高原型」：周圍比例（任兩檔之間移動 5%～10%）的成功率也都達標。 */
self.onmessage = function (ev) {
  const P = ev.data;
  const { A, Mn, n, monthsYQ, reb, blocks, B, SIMS, N, cap, amt, method, infl, hair, target, step } = P;
  const S = Math.round(100 / step);
  const combos = [];
  (function gen(prefix, left, k) {
    if (k === n - 1) { combos.push(prefix.concat(left)); return; }
    for (let a = left; a >= 0; a--) gen(prefix.concat(a), left - a, k + 1);
  })([], S, 0);
  const M = combos.length, nb = blocks.length;
  const pr = new Float64Array(Mn), bf = new Float64Array(nb), v = new Float64Array(n), w = new Float64Array(n);
  const ends = new Float64Array(SIMS);
  const succ = new Float64Array(M), p10 = new Float64Array(M), med = new Float64Array(M);

  // 組合的區塊年報酬
  function blockFactors(cw) {
    for (let k = 0; k < n; k++) { w[k] = cw[k] / S; v[k] = w[k]; }
    let tot = 1;
    for (let m = 0; m < Mn; m++) {
      if (reb !== "none" && m > 0 && monthsYQ[m] !== monthsYQ[m - 1]) for (let k = 0; k < n; k++) v[k] = tot * w[k];
      let nt = 0; const row = m * n;
      for (let k = 0; k < n; k++) { v[k] *= 1 + A[row + k]; nt += v[k]; }
      pr[m] = nt / tot - 1; tot = nt;
    }
    for (let i = 0; i < nb; i++) { let f = 1; for (let j = blocks[i]; j < blocks[i] + 12; j++) f *= 1 + pr[j]; bf[i] = f * (1 - hair); }
  }
  // 跑 10,000 次；回傳成功率，期末實質資產寫進 ends
  function sims(a) {
    const rate0 = a / cap; let fails = 0;
    for (let s = 0; s < SIMS; s++) {
      let b = cap, wd = a, prev = 1, failed = false, defl = 1;
      for (let y = 0; y < N; y++) {
        if (y > 0) {
          if (method === "rule4") wd *= 1 + infl;
          else if (method === "guard") {
            if (!(prev < 1 && b > 0 && wd * (1 + infl) / b > rate0)) wd *= 1 + infl;
            if (b > 0) { const r2 = wd / b; if (r2 > rate0 * 1.2) wd *= 0.9; else if (r2 < rate0 * 0.8) wd *= 1.1; }
          }
          defl *= 1 + infl;
        }
        if (method === "pct") wd = b * rate0;
        const t = wd < b ? wd : b;
        if (!failed && t < wd - 1e-6) failed = true;
        const f = bf[B[s * N + y]];
        b = (b - t) * f; prev = f;
      }
      if (failed) fails++;
      ends[s] = b / (defl * (1 + infl));
    }
    return 1 - fails / SIMS;
  }
  function safe(cw) {   // 這個配置要達到目標成功率，第一年最多領多少
    blockFactors(cw);
    let lo = 0, hi = cap * 0.3;
    if (sims(hi) >= target) return hi;
    for (let k = 0; k < 22; k++) { const mid = (lo + hi) / 2; if (sims(mid) >= target) lo = mid; else hi = mid; }
    return lo;
  }

  const t0 = Date.now();
  const so = new Float64Array(SIMS);
  let bestSucc = -1;
  for (let c = 0; c < M; c++) {
    blockFactors(combos[c]);
    succ[c] = sims(amt);
    // 期末資產的百分位只在需要時才算（達標，或目前成功率最高），省下排序時間
    if (succ[c] >= target - 1e-9 || succ[c] >= bestSucc) {
      so.set(ends); so.sort();
      p10[c] = so[Math.round(0.1 * (SIMS - 1))]; med[c] = so[Math.round(0.5 * (SIMS - 1))];
    } else { p10[c] = -1; med[c] = -1; }
    if (succ[c] > bestSucc) bestSucc = succ[c];
    if ((c & 63) === 0) self.postMessage({ type: "progress", done: c, total: M, ms: Date.now() - t0 });
  }
  // 高原型：周圍比例（移動 5%～10%）的成功率也都達標
  const key = cw => { let x = 0; for (let k = 0; k < n - 1; k++) x = x * (S + 1) + cw[k]; return x; };
  const idx = new Map(); combos.forEach((cw, i) => idx.set(key(cw), i));
  const sMin = Math.max(1, Math.round(5 / step)), sMax = Math.max(sMin, Math.round(10 / step));
  const nbMin = new Float64Array(M), tmp = new Array(n);
  for (let c = 0; c < M; c++) {
    const cw = combos[c]; let mn = succ[c];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      for (let s = 1; s <= sMax; s++) {
        if (cw[i] - s < 0 || cw[j] + s > S) break;
        for (let k = 0; k < n; k++) tmp[k] = cw[k];
        tmp[i] -= s; tmp[j] += s;
        const q = idx.get(key(tmp)); if (q !== undefined && succ[q] < mn) mn = succ[q];
      }
    }
    nbMin[c] = mn;
  }
  const best = (ok, score) => { let b = -1; for (let c = 0; c < M; c++) if (ok(c) && (b < 0 || score(c) > score(b))) b = c; return b; };
  const eps = 1e-9;
  let plateau = true;
  let robust = best(c => nbMin[c] >= target - eps, c => p10[c]);
  let rich = best(c => nbMin[c] >= target - eps, c => med[c]);
  if (robust < 0) {   // 沒有高原型，退而求其次：本身達標即可
    plateau = false;
    robust = best(c => succ[c] >= target - eps, c => p10[c]);
    rich = best(c => succ[c] >= target - eps, c => med[c]);
  }
  const countOk = Array.from(succ).filter(x => x >= target - eps).length;
  // 排名清單（之後在主畫面用各配置「自己的完整歷史」逐一驗證，通過的才推薦）
  const okSet = [];
  for (let c = 0; c < M; c++) if ((plateau ? nbMin[c] : succ[c]) >= target - eps) okSet.push(c);
  const robustList = okSet.slice().sort((a, b) => p10[b] - p10[a]).slice(0, 25);
  const richList = okSet.slice().sort((a, b) => med[b] - med[a]).slice(0, 10);
  const all = Array.from({ length: M }, (_, i) => i);
  const topList = okSet.length ? [] : all.sort((a, b) => (succ[b] - succ[a]) || (p10[b] - p10[a])).slice(0, 15);
  const pack = c => ({ w: combos[c].map(x => x / S), succ: succ[c], p10: p10[c], med: med[c], nbMin: nbMin[c] });
  self.postMessage({ type: "done", M, countOk, plateau, robustList: robustList.map(pack), richList: richList.map(pack), topList: topList.map(pack), ms: Date.now() - t0 });
};
