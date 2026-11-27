/* 各策略的訊號規則（策略頁和市場儀表板共用，保證兩邊算出的買賣日期一致）
   raw(a, ak, ps)：在指數 A 自己的交易日上產生 on（買進事件／狀態）和 off（賣出事件／狀態）
   events(...)：對齊到 B 的交易日（隔天收盤成交），給回測用
   last(a, ak, ps)：從頭跑一次「持有／現金」狀態，回傳最近一次買賣（儀表板用） */
(function (G) {
  const C = {};   // 快取：同一條線只算一次
  const memo = (k, f) => C[k] || (C[k] = f());
  const pct = v => (+v.toFixed(2)) + "%";

  const kalman = {
    DEF: { s: 50, l: 150 },
    fmt: ps => `${ps.s}／${ps.l}`,
    line: (a, ak, n) => memo("k" + ak + n + ":" + a.px.length, () => SB.kalman(a.px, n)),
    raw(a, ak, ps) {   // 狀態型：快線 > 慢線＝多頭
      const ks = this.line(a, ak, ps.s), kl = this.line(a, ak, ps.l), on = new Int8Array(a.px.length), off = new Int8Array(a.px.length);
      for (let j = 0; j < on.length; j++) { on[j] = ks[j] > kl[j] ? 1 : 0; off[j] = 1 - on[j]; }
      return { on, off, state: true };
    }
  };

  const envelope = {
    DEF: { n: 150, x: 2, y: 4.5 },
    fmt: ps => `${ps.n}日 +${pct(ps.x)}／−${pct(ps.y)}`,
    ma: (a, ak, n) => memo("m" + ak + n + ":" + a.px.length, () => SB.sma(a.px, n)),
    raw(a, ak, ps) {   // 事件型：收盤價向上穿越上軌＝買進；收盤價在下軌之下＝賣出
      const m = this.ma(a, ak, ps.n), px = a.px, ku = 1 + ps.x / 100, kd = 1 - ps.y / 100;
      const on = new Int8Array(px.length), off = new Int8Array(px.length);
      for (let j = 0; j < px.length; j++) {
        if (j > 0 && m[j - 1] === m[j - 1] && px[j] > m[j] * ku && px[j - 1] <= m[j - 1] * ku) on[j] = 1;
        if (m[j] === m[j] && px[j] < m[j] * kd) off[j] = 1;
      }
      return { on, off };
    }
  };

  // 月 KD：加權指數用證交所的每日最高、最低價（data/TWII_hl.csv），其他指數用每日收盤代替
  const HL = {}; let hlP = null;
  const kd = {
    DEF: { n: 9, t: 80 },
    fmt: ps => `KD ${ps.n}，門檻 ${ps.t}`,
    HL,
    loadHL() {
      return hlP || (hlP = fetch("data/TWII_hl.csv?v=" + Date.now().toString(36).slice(0, -4)).then(r => r.ok ? r.text() : "").catch(() => "").then(txt => {
        txt.trim().split(/\r?\n/).slice(1).forEach(l => { const [d, hi, lo] = l.split(","); if (d && +hi > 0) HL[d] = [+hi, +lo]; });
        return Object.keys(HL).length;
      }));
    },
    // 月 K 棒與 KD；最後一個月如果還沒結束（後面沒有下個月的資料），complete＝false，不產生訊號
    calc(a, ak, n) {
      return memo("kd" + ak + n + ":" + a.px.length + ":" + Object.keys(HL).length, () => {
        const useHL = ak === "TWII", bars = []; let cur = null;
        for (let j = 0; j < a.dates.length; j++) {
          const mo = a.dates[j].slice(0, 7), c = a.px[j], x = useHL && HL[a.dates[j]];
          const hi = x ? Math.max(x[0], c) : c, lo = x ? Math.min(x[1], c) : c;
          if (!cur || cur.mo !== mo) { if (cur) cur.complete = true; cur = { mo, hi, lo, cl: c, end: j, complete: false }; bars.push(cur); }
          else { cur.hi = Math.max(cur.hi, hi); cur.lo = Math.min(cur.lo, lo); cur.cl = c; cur.end = j; }
        }
        const K = new Float64Array(bars.length), D = new Float64Array(bars.length); let pk = 50, pd = 50;
        for (let m = 0; m < bars.length; m++) {
          let hh = -Infinity, ll = Infinity;
          for (let q = Math.max(0, m - n + 1); q <= m; q++) { hh = Math.max(hh, bars[q].hi); ll = Math.min(ll, bars[q].lo); }
          const rsv = hh > ll ? (bars[m].cl - ll) / (hh - ll) * 100 : 50;
          pk = pk * 2 / 3 + rsv / 3; pd = pd * 2 / 3 + pk / 3; K[m] = pk; D[m] = pd;
        }
        return { bars, K, D };
      });
    },
    raw(a, ak, ps, mix) {   // 事件型：月底 K 向上穿越 D＝買進（mix 時高檔改買第 2 檔）；月底 K < D＝賣出
      const k = this.calc(a, ak, ps.n), on = new Int8Array(a.px.length), off = new Int8Array(a.px.length);
      for (let m = 0; m < k.bars.length; m++) {
        if (!k.bars[m].complete) continue;
        const j = k.bars[m].end, K = k.K[m], D = k.D[m], pK = m ? k.K[m - 1] : 50, pD = m ? k.D[m - 1] : 50;
        if (K > D && pK <= pD) on[j] = mix && (K >= ps.t || D >= ps.t) ? 2 : 1;
        if (K < D) off[j] = 1;
      }
      return { on, off };
    }
  };

  const ST = { kalman, envelope, kd };
  Object.values(ST).forEach(s => {
    s.events = function (a, ak, ps, jm, b) {
      const r = this.raw(a, ak, ps, b && b.assets && b.assets.length > 1);
      return r.state ? { on: SB.alignState(r.on, jm), off: SB.alignState(r.off, jm) } : { on: SB.alignEvent(r.on, jm), off: SB.alignEvent(r.off, jm) };
    };
    // 回傳最近一次買賣：{ act, sig（訊號日）, trade（成交日；還沒到就是 null）, pos（目前是否持有） }
    s.last = function (a, ak, ps) {
      const r = this.raw(a, ak, ps, false); let pos = 0, lj = -1, act = "";
      for (let j = 0; j < r.on.length; j++) {
        if (!pos && r.on[j]) { pos = 1; lj = j; act = "買進"; }
        else if (pos && r.off[j]) { pos = 0; lj = j; act = "賣出"; }
      }
      return lj < 0 ? null : { act, sig: a.dates[lj], trade: a.dates[lj + 1] || null, pos };
    };
  });
  G.ST = ST;
})(typeof self !== "undefined" ? self : this);
