/* ETF 組合最佳化：背景計算（Web Worker）
   輸入：每週報酬矩陣 R（T×n，依時間排列）、再平衡旗標 reb（長度 T）、年數 years、格距 step（%）
   對每一種比例組合（每格 step%，加總 100%）模擬每週淨值，算出年化報酬與最大回撤；
   再算「高原型」分數：把每個組合和它周圍的鄰居（任兩檔之間移動 1～3 格）一起看——
   報酬取鄰居平均、回撤取鄰居中最差的，這樣挑出來的配置，比例稍微改變結果也還是好。 */
self.onmessage = function (ev) {
  const { R, reb, T, n, years, step } = ev.data;
  const S = Math.round(100 / step);            // 總格數，例如 2% → 50 格
  // 列出所有組合（每檔 0～S 格，加總 S）
  const combos = [];
  (function gen(prefix, left, k) {
    if (k === n - 1) { combos.push(prefix.concat(left)); return; }
    for (let a = left; a >= 0; a--) gen(prefix.concat(a), left - a, k + 1);
  })([], S, 0);
  const M = combos.length;
  const cagr = new Float64Array(M), mdd = new Float64Array(M);
  const v = new Float64Array(n), w = new Float64Array(n);
  const t0 = Date.now();
  for (let c = 0; c < M; c++) {
    const cw = combos[c];
    for (let k = 0; k < n; k++) { w[k] = cw[k] / S; v[k] = w[k]; }
    let peak = 1, dd = 0, tot = 1;
    for (let t = 0; t < T; t++) {
      if (reb[t]) for (let k = 0; k < n; k++) v[k] = tot * w[k];
      tot = 0;
      const row = t * n;
      for (let k = 0; k < n; k++) { v[k] *= 1 + R[row + k]; tot += v[k]; }
      if (tot > peak) peak = tot; else { const d = tot / peak - 1; if (d < dd) dd = d; }
    }
    cagr[c] = Math.pow(tot, 1 / years) - 1;
    mdd[c] = dd;
    if ((c & 4095) === 0) self.postMessage({ type: "progress", done: c, total: M, phase: 1, ms: Date.now() - t0 });
  }
  // 高原型分數
  const key = cw => { let x = 0; for (let k = 0; k < n - 1; k++) x = x * (S + 1) + cw[k]; return x; };
  const idx = new Map();
  combos.forEach((cw, i) => idx.set(key(cw), i));
  const sCagr = new Float64Array(M), sMdd = new Float64Array(M), nNb = new Uint16Array(M);
  const tmp = new Array(n);
  for (let c = 0; c < M; c++) {
    const cw = combos[c];
    let sum = cagr[c], cnt = 1, worst = mdd[c];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      for (let s = 1; s <= 3; s++) {
        if (cw[i] - s < 0 || cw[j] + s > S) break;
        for (let k = 0; k < n; k++) tmp[k] = cw[k];
        tmp[i] -= s; tmp[j] += s;
        const q = idx.get(key(tmp));
        if (q === undefined) continue;
        sum += cagr[q]; cnt++;
        if (mdd[q] < worst) worst = mdd[q];
      }
    }
    sCagr[c] = sum / cnt; sMdd[c] = worst; nNb[c] = cnt;
    if ((c & 8191) === 0) self.postMessage({ type: "progress", done: c, total: M, phase: 2, ms: Date.now() - t0 });
  }
  const flat = new Uint8Array(M * n);
  combos.forEach((cw, i) => { for (let k = 0; k < n; k++) flat[i * n + k] = cw[k]; });
  self.postMessage({ type: "done", M, S, flat, cagr, mdd, sCagr, sMdd, ms: Date.now() - t0 },
    [flat.buffer, cagr.buffer, mdd.buffer, sCagr.buffer, sMdd.buffer]);
};
