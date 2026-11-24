/* 「看 A 做 B」高原型最佳化（在背景執行，不卡畫面）。一個 Worker 負責一種組合。 */
importScripts("signal-bt.js?v=1124b");
onmessage = ev => {
  const m = ev.data, jm = SB.alignMap(m.aDates, m.bDates), f = SB.fees(m.cost), p = m.bAdj, px = m.aPx, nA = px.length;
  let wins = SB.windows(m.bDates, m.i0, m.i1); if (!wins.length) wins = [[m.i0, m.i1]];
  const wyrs = wins.map(([s, e]) => SB.years(m.bDates[s], m.bDates[e]));
  const g = m.grid, tmp = new Int8Array(nA);
  let score, dims;
  if (m.strategy === "kalman") {
    // 格子：快線 S × 慢線 L，快線要小於慢線
    const S = g.S, L = g.L; dims = [S.length, L.length]; score = new Float64Array(S.length * L.length).fill(NaN);
    const K = {}; const kl = n => K[n] || (K[n] = SB.kalman(px, n));
    for (let a = 0; a < S.length; a++) {
      for (let b = 0; b < L.length; b++) {
        if (S[a] >= L[b]) continue;
        const ks = kl(S[a]), kL = kl(L[b]);
        for (let j = 0; j < nA; j++) tmp[j] = ks[j] > kL[j] ? 1 : 0;
        const on = SB.alignState(tmp, jm), off = new Int8Array(on.length);
        for (let i = 0; i < on.length; i++) off[i] = 1 - on[i];
        score[a * L.length + b] = SB.windowScore(p, on, off, wins, f, wyrs);
      }
      postMessage({ type: "progress", done: a + 1, total: S.length });
    }
  } else {
    // 均線包絡：均線 N × 上軌 X% × 下軌 Y%
    const N = g.N, X = g.X, Y = g.Y; dims = [N.length, X.length, Y.length]; score = new Float64Array(N.length * X.length * Y.length).fill(NaN);
    for (let a = 0; a < N.length; a++) {
      const ma = SB.sma(px, N[a]);
      const ons = X.map(x => { const k = 1 + x / 100; tmp.fill(0);
        for (let j = 1; j < nA; j++) if (ma[j - 1] === ma[j - 1] && px[j] > ma[j] * k && px[j - 1] <= ma[j - 1] * k) tmp[j] = 1;
        return SB.alignEvent(tmp, jm); });
      const offs = Y.map(y => { const k = 1 - y / 100; tmp.fill(0);
        for (let j = 0; j < nA; j++) if (ma[j] === ma[j] && px[j] < ma[j] * k) tmp[j] = 1;
        return SB.alignEvent(tmp, jm); });
      for (let b = 0; b < X.length; b++) for (let c = 0; c < Y.length; c++)
        score[(a * X.length + b) * Y.length + c] = SB.windowScore(p, ons[b], offs[c], wins, f, wyrs);
      postMessage({ type: "progress", done: a + 1, total: N.length });
    }
  }
  postMessage({ type: "done", best: SB.plateau(score, dims, m.rad), nWin: wins.length });
};
