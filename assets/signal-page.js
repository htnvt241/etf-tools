/* 「看 A 做 B」訊號回測頁面共用的畫面與流程（Kalman 趨勢回測、均線包絡策略）
   每頁只要提供 cfg：預設參數、讀自訂參數、產生買賣訊號、訊號圖的線、最佳化的格子。 */
(function () {
  const VER = "1124a";
  function init(cfg) {
    const { fmt } = ET, info = ETUI.info, cls = ETUI.cls, $ = id => document.getElementById(id);
    const SIGS = [{ k: "TWRI", name: "報酬指數" }, { k: "TWII", name: "加權指數" }];
    const TGTS = [{ k: "0050", name: "0050" }, { k: "00631L", name: "00631L" }];
    const COMBOS = []; SIGS.forEach(a => TGTS.forEach(b => COMBOS.push({ a, b, id: a.k + ">" + b.k, label: `看${a.name}做 ${b.name}` })));
    const D = {}, A = {}, B = {}, JM = {};
    const st = { opt: null, view: COMBOS[0].id };

    Promise.all(["TWRI", "TWII", "0050", "00631L"].map(k => ET.load(k).then(s => D[k] = s))).then(start)
      .catch(e => { $("out").innerHTML = `<div class="card err">資料讀取失敗：${e.message}</div>`; });

    function start() {
      B["0050"] = { dates: D["0050"].dates, adj: Float64Array.from(D["0050"].adj), estN: 0 };
      const c = ET.calibrate(D["00631L"], D["0050"], 2), ex = ET.extend(D["00631L"], D["0050"], 2, c.drag);
      B["00631L"] = { dates: ex.dates, adj: Float64Array.from(ex.adj), estN: ex.estN, drag: c.drag };
      // A 從 2003 年起（和報酬指數同一個起點，兩種訊號公平比較）
      SIGS.forEach(a => { const s = D[a.k], i0 = ET.lowerBound(s.dates, "2003-01-02"); A[a.k] = { dates: s.dates.slice(i0), px: Float64Array.from(s.adj.slice(i0)) }; });
      COMBOS.forEach(cb => JM[cb.id] = SB.alignMap(A[cb.a.k].dates, B[cb.b.k].dates));
      const last = [B["0050"].dates.at(-1), B["00631L"].dates.at(-1), A.TWRI.dates.at(-1), A.TWII.dates.at(-1)].sort()[0];
      $("start").value = "2004-01-02"; $("end").value = last; $("start").min = "2003-07-01"; $("end").max = last;
      run();
    }

    const cost = () => ({ disc: Math.max(0, +$("disc").value || 0), tax: Math.max(0, +$("tax").value || 0) / 100 });
    function range(bs) { return [Math.max(1, ET.lowerBound(bs.dates, $("start").value)), ET.floorIdx(bs.dates, $("end").value)]; }
    function paramSets(id) {
      const sets = [{ key: "def", name: "預設 " + cfg.fmt(cfg.DEF), ps: cfg.DEF }];
      if ($("useCustom").checked) { const ps = cfg.readCustom(); if (ps) sets.push({ key: "cus", name: "自訂 " + cfg.fmt(ps), ps }); }
      if (st.opt && st.opt[id]) { const o = st.opt[id]; sets.push({ key: "opt", name: "最佳化 " + cfg.fmt(o.ps), ps: o.ps, o }); }
      return sets;
    }
    function evalCombo(cb, sets) {
      const bs = B[cb.b.k], [i0, i1] = range(bs), cst = cost(), wins = SB.windows(bs.dates, i0, i1);
      const bh = SB.buyHold(bs.dates, bs.adj, i0, i1, true);
      bh.worst10 = wins.length ? Math.min(...wins.map(([s, e]) => SB.buyHold(bs.dates, bs.adj, s, e, false).cagr)) : NaN;
      const rows = [{ key: "bh", name: `一直持有 ${cb.b.name}`, r: bh }];
      for (const s of sets) {
        const ev = cfg.events(A[cb.a.k], cb.a.k, s.ps, JM[cb.id]);
        const r = SB.backtest(bs.dates, bs.adj, ev.on, ev.off, i0, i1, cst, true);
        r.worst10 = wins.length ? Math.min(...wins.map(([a, b]) => SB.backtest(bs.dates, bs.adj, ev.on, ev.off, a, b, cst, false).cagr)) : NaN;
        rows.push({ ...s, r });
      }
      return { cb, bs, i0, i1, rows };
    }
    function run() { if (!B["0050"]) return; render(COMBOS.map(cb => evalCombo(cb, paramSets(cb.id)))); }

    $("run").addEventListener("click", run);
    const clearOpt = () => { if (st.opt) { st.opt = null; $("optH").textContent = "期間或成本已改變，請重新跑最佳化。"; } };
    ["start", "end", "disc", "tax"].forEach(id => $(id).addEventListener("change", () => { clearOpt(); run(); }));
    document.querySelectorAll("#customBox input").forEach(x => x.addEventListener("change", run));
    $("useCustom").addEventListener("change", e => { $("customBox").hidden = !e.target.checked; run(); });
    document.querySelector(".quick").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
      $("start").value = b.dataset.q === "10y" ? ET.addYears($("end").value, -10) : b.dataset.q; clearOpt(); run(); });

    function render(res) {
      const yrs = res[0].rows[0].r.yrs, e6 = res.find(x => x.cb.b.k === "00631L");
      const anyEst = e6.i0 < e6.bs.estN;
      let h = `<section class="card"><h3>績效比較<span class="sub">${$("start").value} ～ ${$("end").value}，約 ${yrs.toFixed(1)} 年｜隔天收盤成交，空頭持有現金</span></h3>
        ${anyEst ? `<p class="note" style="margin:0 0 8px">00631L 在 ${e6.bs.dates[e6.bs.estN - 1]} 以前為推估價格<span class="esttag">含推估</span>（2×0050 減年成本 ${fmt.pct(B["00631L"].drag, 2)}，準確度中等）。</p>` : ""}
        <div class="tw"><table><thead><tr><th class="l">看 A 做 B</th><th class="l">參數</th><th>總報酬率</th><th>年化報酬率</th><th>最大回撤</th><th>報酬÷回撤${info("年化報酬率 ÷ 最大回撤。每承受 1% 的回撤，換到多少年化報酬，越高越好。")}</th>
        <th>最差 10 年區間年化${info("期間內每年起算一個 10 年區間（再加上最近 10 年），這組參數在最倒楣的那個 10 年的年化報酬。期間不滿 10 年時不計算。")}</th>
        <th>交易次數${info("完整的一買一賣算一次。期末還持有的那一筆也算一次（以期末市值計勝負）。")}</th><th>勝率${info("賺錢的交易占全部交易的比例。")}</th><th>持有時間</th></tr></thead><tbody>`;
      res.forEach(x => x.rows.forEach((row, ri) => {
        const r = row.r, bh = row.key === "bh";
        h += `<tr class="${ri === 0 ? "grp" : ""}${row.key === "opt" ? " hl" : ""}">${ri === 0 ? `<td rowspan="${x.rows.length}" class="l"><b>${x.cb.label}</b>${x.cb.b.k === "00631L" && x.i0 < x.bs.estN ? '<span class="esttag">含推估</span>' : ""}</td>` : ""}
          <td class="l">${row.name}${row.key === "opt" ? `<br><span class="sub">高原型，周圍參數平均分數 ${fmt.pct(row.o.nbRatio, 0)}</span>` : ""}</td>
          <td class="${cls(r.tot)}">${fmt.spct(r.tot, 1)}</td><td class="${cls(r.cagr)}"><b>${fmt.spct(r.cagr, 2)}</b></td><td class="neg">${fmt.pct(r.mdd, 1)}</td>
          <td>${SB.calmar(r).toFixed(2)}</td><td class="${cls(r.worst10)}">${isFinite(r.worst10) ? fmt.spct(r.worst10, 1) : "—"}</td>
          <td>${bh ? "—" : r.trades}</td><td>${bh || !r.trades ? "—" : fmt.pct(r.wins / r.trades, 0)}</td><td>${fmt.pct(r.inPct, 0)}</td></tr>`;
      }));
      h += `</tbody></table></div><p class="note">「一直持有」是同一段期間買進後不動的對照組。報酬指數和加權指數只是用來判斷多空的訊號，實際買賣的都是 0050 或 00631L。</p></section>
        <section class="card"><h3>走勢與買賣點<span class="sub">選一個組合查看</span></h3>
        <div class="tools" style="margin-bottom:8px"><div class="seg" id="viewSeg">${COMBOS.map(cb => `<button type="button" data-v="${cb.id}" class="${cb.id === st.view ? "on" : ""}">${cb.label}</button>`).join("")}</div>
        <label>參數 <select id="viewPs" class="selS"></select></label></div>
        <div class="sub" style="margin:4px 0">資產變化（起始＝1，對數座標）</div><div id="ch-val"></div>
        <div class="sub" style="margin:12px 0 4px">訊號：${cfg.sigTitle}（對數座標；▲ 買進、▼ 賣出，標在實際成交日）</div><div id="ch-sig"></div>
        <details style="margin-top:10px"><summary>每一筆交易</summary><div class="tw" id="trades"></div></details></section>`;
      $("out").innerHTML = h;
      const cur = () => res.find(r => r.cb.id === st.view);
      const fillPs = () => { const keep = $("viewPs").value; $("viewPs").innerHTML = cur().rows.filter(r => r.key !== "bh").map(r => `<option value="${r.key}">${r.name}</option>`).join(""); if ([...$("viewPs").options].some(o => o.value === keep)) $("viewPs").value = keep; };
      fillPs();
      $("viewSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; st.view = b.dataset.v;
        $("viewSeg").querySelectorAll("button").forEach(z => z.classList.toggle("on", z === b)); fillPs(); drawView(cur()); });
      $("viewPs").addEventListener("change", () => drawView(cur()));
      drawView(cur());
    }

    function drawView(x) {
      const row = x.rows.find(r => r.key === $("viewPs").value) || x.rows[1], bh = x.rows[0], bs = x.bs;
      const dates = bs.dates.slice(x.i0, x.i1 + 1), estN = Math.max(0, bs.estN - x.i0);
      const series = [{ name: bh.name, color: 8, dates, values: Array.from(bh.r.val), estN }];
      x.rows.filter(r => r.key !== "bh").forEach((r, k) => series.push({ name: r.name, color: [1, 3, 2][k], dates, values: Array.from(r.r.val), estN }));
      ETChart.line($("ch-val"), { series, log: true, height: 300, noLabels: true, yFmt: v => v.toFixed(v < 10 ? 1 : 0) + "x", tipFmt: v => v.toFixed(2) + " 倍" });
      const a = A[x.cb.a.k], j0 = ET.lowerBound(a.dates, dates[0]), j1 = ET.floorIdx(a.dates, dates[dates.length - 1]);
      const ad = a.dates.slice(j0, j1 + 1), cut = v => Array.from(v.slice(j0, j1 + 1));
      const sser = [{ name: x.cb.a.name, color: 8, dates: ad, values: cut(a.px) }]
        .concat(cfg.sigLines(a, x.cb.a.k, row.ps).map(l => ({ name: l.name, color: l.color, dates: ad, values: cut(l.values) })));
      const marks = row.r.log.map(e => { const j = ET.floorIdx(a.dates, bs.dates[e.i]); return { date: a.dates[j], value: a.px[j], type: e.act === "買進" ? "buy" : "sell" }; });
      ETChart.line($("ch-sig"), { height: 300, log: true, noLabels: true, marks, yFmt: v => fmt.num(v, 0), tipFmt: v => fmt.num(v, 0), series: sser });
      let t = `<table><thead><tr><th class="l">日期</th><th class="l">動作</th><th>價格（還原）</th><th>這筆交易報酬</th></tr></thead><tbody>`;
      row.r.log.forEach(e => { t += `<tr><td class="l">${bs.dates[e.i]}${e.i < bs.estN ? '<span class="esttag">推估</span>' : ""}</td><td class="l ${e.act === "買進" ? "pos" : "neg"}">${e.act}</td><td>${fmt.num(e.px, 2)}</td><td class="${e.ret !== undefined ? cls(e.ret) : ""}">${e.ret !== undefined ? fmt.spct(e.ret, 1) : ""}</td></tr>`; });
      if (row.r.openAtEnd) t += `<tr><td class="l">${bs.dates[x.i1]}</td><td class="l">持有中</td><td>${fmt.num(bs.adj[x.i1], 2)}</td><td></td></tr>`;
      if (!row.r.log.length) t += `<tr><td class="l" colspan="4">這段期間沒有交易</td></tr>`;
      $("trades").innerHTML = t + "</tbody></table>";
    }

    // ---------- 高原型最佳化：4 種組合各開一個 Worker 同時計算 ----------
    $("opt").addEventListener("click", () => {
      if (!B["0050"]) return;
      const t0 = performance.now(), cst = cost(), done = {}, prog = {};
      $("opt").disabled = true; $("optH").textContent = "計算中…";
      const jobs = COMBOS.map(cb => new Promise((ok, fail) => {
        const bs = B[cb.b.k], [i0, i1] = range(bs), a = A[cb.a.k];
        const w = new Worker(`assets/signal-worker.js?v=${VER}`);
        w.onmessage = ev => {
          const m = ev.data;
          if (m.type === "progress") { prog[cb.id] = m.done / m.total; const p = COMBOS.reduce((s, c) => s + (prog[c.id] || 0), 0) / COMBOS.length; $("optH").textContent = `計算中… ${(p * 100).toFixed(0)}%`; return; }
          w.terminate();
          if (m.best) done[cb.id] = { ps: cfg.opt.toPs(m.best.at), nbRatio: m.best.nbRatio, nWin: m.nWin };
          ok();
        };
        w.onerror = e => { w.terminate(); fail(e); };
        w.postMessage({ strategy: cfg.opt.strategy, grid: cfg.opt.grid, rad: cfg.opt.rad, aDates: a.dates, aPx: a.px, bDates: bs.dates, bAdj: bs.adj, i0, i1, cost: cst });
      }));
      Promise.all(jobs).then(() => {
        st.opt = done;
        const nWin = Object.values(done)[0]?.nWin || 0;
        $("optH").innerHTML = `完成（${((performance.now() - t0) / 1000).toFixed(1)} 秒）：每組參數在 ${nWin} 個 10 年區間各跑一次，分數＝70% 區間平均＋30% 最差區間（區間分數＝年化÷最大回撤），再取${cfg.opt.nbText}也好的高原。結果已加入比較表。`;
        run();
      }).catch(e => { $("optH").textContent = "最佳化失敗：" + (e.message || e); })
        .finally(() => { $("opt").disabled = false; });
    });
  }
  window.SPage = { init };
})();
