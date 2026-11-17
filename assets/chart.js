/* 自製 SVG 圖表：折線圖（可對數座標、估算段虛線、滑鼠十字線提示）、群組長條圖。
   顏色用 CSS 變數 --s1 … --s8，深淺色模式自動切換。 */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const DAY = 864e5;
  const dnum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const col = c => typeof c === "number" ? `var(--s${c})` : (c || "var(--ink)");

  function niceTicks(lo, hi, n) {
    const span = hi - lo || Math.abs(hi) || 1;
    const step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const f = step0 / mag, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  function logTicks(lo, hi) {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
      for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= lo && v <= hi) out.push(v); }
    if (out.length > 9) return out.filter(v => String(v)[0] === "1");
    return out;
  }
  function timeTicks(t0, t1, w) {
    const y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    const spanY = (t1 - t0) / (365.25 * DAY);
    const maxTicks = Math.max(2, Math.floor(w / 70));
    if (spanY < 1.5) { // 月份刻度
      const out = []; const d = new Date(t0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
      const step = Math.max(1, Math.ceil(spanY * 12 / maxTicks));
      for (; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + step))
        out.push({ t: d.getTime(), s: `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}` });
      return out;
    }
    const steps = [1, 2, 5, 10, 20, 25, 50];
    const step = steps.find(s => (y1 - y0) / s <= maxTicks) || 50;
    const out = [];
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const t = Date.UTC(y, 0, 1); if (t >= t0 && t <= t1) out.push({ t, s: String(y) });
    }
    return out;
  }

  // 每個像素欄只留下 首/最低/最高/尾 四點，畫幾萬筆資料也不會卡
  function decimate(xs, ys, i0, i1, xpx) {
    const out = []; let bucket = null, b = [];
    const flush = () => {
      if (!b.length) return;
      let mn = b[0], mx = b[0];
      for (const i of b) { if (ys[i] < ys[mn]) mn = i; if (ys[i] > ys[mx]) mx = i; }
      const set = [...new Set([b[0], mn, mx, b[b.length - 1]])].sort((a, c) => a - c);
      out.push(...set);
    };
    for (let i = i0; i < i1; i++) {
      const px = Math.round(xpx(xs[i]));
      if (px !== bucket) { flush(); b = []; bucket = px; }
      b.push(i);
    }
    flush();
    return out;
  }

  function attachResize(host, draw) {
    let w = 0;
    const ro = new ResizeObserver(() => { const nw = host.clientWidth; if (Math.abs(nw - w) > 2) { w = nw; draw(); } });
    ro.observe(host);
    host._ro && host._ro.disconnect(); host._ro = ro;
  }

  function legendHTML(series) {
    return '<div class="legend">' + series.map(s =>
      `<span><i style="background:${col(s.color)}"></i>${s.name}${s.estN ? '<em class="estk">（虛線＝估算）</em>' : ""}</span>`).join("") + "</div>";
  }

  /* 折線圖
     opt: { series:[{name,color,dates,values,estN}], log, yFmt, height, zero(bool), area(bool), tipFmt } */
  function line(host, opt) {
    const draw = () => {
      host.innerHTML = "";
      host.classList.add("cw");
      const ser = opt.series.filter(s => s.dates.length);
      if (!ser.length) { host.innerHTML = '<p class="note">這段期間沒有資料</p>'; return; }
      const W = Math.max(280, host.clientWidth), H = opt.height || 300;
      const labels = ser.length >= 2 && ser.length <= 4 && W > 520 && !opt.noLabels;
      const m = { l: 58, r: labels ? 74 : 14, t: 10, b: 26 };
      const xs = ser.map(s => s.dates.map(dnum));
      let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
      ser.forEach((s, k) => {
        t0 = Math.min(t0, xs[k][0]); t1 = Math.max(t1, xs[k][xs[k].length - 1]);
        for (const v of s.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
      });
      if (opt.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      const log = opt.log && lo > 0;
      let yt;
      if (log) { yt = logTicks(lo, hi); if (yt.length < 2) yt = niceTicks(lo, hi, 5); }
      else { const pad = (hi - lo) * 0.04 || 1; yt = niceTicks(lo - (opt.zero && lo === 0 ? 0 : pad), hi + pad, 5); lo = Math.min(lo, yt[0]); hi = Math.max(hi, yt[yt.length - 1]); }
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const X = t => m.l + (t - t0) / (t1 - t0 || 1) * iw;
      const Y = log ? v => m.t + ih - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1) * ih
                    : v => m.t + ih - (v - lo) / (hi - lo || 1) * ih;
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opt.aria || "折線圖" }, host);
      // 格線與座標
      for (const v of yt) {
        const y = Y(v); if (y < m.t - 1 || y > m.t + ih + 1) continue;
        el("line", { x1: m.l, x2: m.l + iw, y1: y, y2: y, class: "grid" }, svg);
        el("text", { x: m.l - 6, y: y + 4, "text-anchor": "end" }, svg).textContent = opt.yFmt ? opt.yFmt(v) : v;
      }
      if (opt.zero && lo < 0 && hi > 0) el("line", { x1: m.l, x2: m.l + iw, y1: Y(0), y2: Y(0), class: "base" }, svg);
      for (const tk of timeTicks(t0, t1, iw)) {
        el("text", { x: X(tk.t), y: H - 6, "text-anchor": "middle" }, svg).textContent = tk.s;
      }
      // 線
      ser.forEach((s, k) => {
        const x = xs[k], v = s.values, n = v.length, est = s.estN || 0;
        const toPath = idx => idx.map((i, j) => (j ? "L" : "M") + X(x[i]).toFixed(1) + "," + Y(v[i]).toFixed(1)).join("");
        if (opt.area) {
          const idx = decimate(x, v, 0, n, X);
          const d = toPath(idx) + `L${X(x[idx[idx.length - 1]]).toFixed(1)},${Y(0)}L${X(x[idx[0]]).toFixed(1)},${Y(0)}Z`;
          el("path", { d, fill: col(s.color), "fill-opacity": ser.length > 1 ? 0.12 : 0.2, stroke: "none" }, svg);
        }
        if (est > 0) el("path", { d: toPath(decimate(x, v, 0, Math.min(n, est + 1), X)), class: "ln est", stroke: col(s.color) }, svg);
        if (est < n) el("path", { d: toPath(decimate(x, v, Math.max(0, est), n, X)), class: "ln", stroke: col(s.color) }, svg);
      });
      // 線尾直接標名稱（2–4 條線時）
      if (labels) {
        const ends = ser.map((s, k) => ({ y: Y(s.values[s.values.length - 1]), name: s.name, k }))
          .sort((a, b) => a.y - b.y);
        for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
        for (const e of ends) el("text", { x: m.l + iw + 6, y: e.y + 4, class: "dl" }, svg).textContent = e.name;
      }
      // 滑鼠提示
      const vline = el("line", { y1: m.t, y2: m.t + ih, class: "hair", visibility: "hidden" }, svg);
      const dots = ser.map(s => el("circle", { r: 4, fill: col(s.color), class: "dot", visibility: "hidden" }, svg));
      const tip = document.createElement("div"); tip.className = "ct"; tip.hidden = true; host.appendChild(tip);
      const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
      const move = ev => {
        const r = svg.getBoundingClientRect();
        const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
        const t = t0 + (px * (W / r.width) - m.l) / iw * (t1 - t0);
        let rows = [], dateS = null, xpx = null;
        ser.forEach((s, k) => {
          const x = xs[k]; let lo2 = 0, hi2 = x.length - 1;
          if (t < x[0] - 5 * DAY || t > x[hi2] + 5 * DAY) { dots[k].setAttribute("visibility", "hidden"); return; }
          while (lo2 < hi2) { const mid = (lo2 + hi2 + 1) >> 1; if (x[mid] <= t) lo2 = mid; else hi2 = mid - 1; }
          const i = lo2;
          dots[k].setAttribute("cx", X(x[i])); dots[k].setAttribute("cy", Y(s.values[i])); dots[k].setAttribute("visibility", "visible");
          if (!dateS) { dateS = s.dates[i]; xpx = X(x[i]); }
          rows.push(`<div><i style="background:${col(s.color)}"></i>${s.name}：<b>${opt.tipFmt ? opt.tipFmt(s.values[i], s, i) : (opt.yFmt ? opt.yFmt(s.values[i]) : s.values[i])}</b>${i < (s.estN || 0) ? ' <span class="tag">估算</span>' : ""}</div>`);
        });
        if (!rows.length) return;
        vline.setAttribute("x1", xpx); vline.setAttribute("x2", xpx); vline.setAttribute("visibility", "visible");
        tip.innerHTML = `<div class="hd">${dateS}</div>` + rows.join("");
        tip.hidden = false;
        const sx = r.width / W, tw = tip.offsetWidth;
        let left = xpx * sx + 14; if (left + tw > r.width) left = xpx * sx - tw - 14;
        tip.style.left = Math.max(0, left) + "px"; tip.style.top = (m.t + 4) + "px";
      };
      const leave = () => { tip.hidden = true; vline.setAttribute("visibility", "hidden"); dots.forEach(d => d.setAttribute("visibility", "hidden")); };
      hit.addEventListener("mousemove", move); hit.addEventListener("touchmove", move, { passive: true });
      hit.addEventListener("mouseleave", leave); hit.addEventListener("touchend", leave);
      if (ser.length >= 2 || ser.some(s => s.estN)) host.insertAdjacentHTML("beforeend", legendHTML(ser));
    };
    draw(); attachResize(host, draw);
  }

  /* 群組長條圖（例如每年報酬）
     opt: { cats:[...], series:[{name,color,values:[...], est:[bool]}], yFmt, height } */
  function bars(host, opt) {
    const draw = () => {
      host.innerHTML = ""; host.classList.add("cw");
      const W = Math.max(280, host.clientWidth), H = opt.height || 260;
      const m = { l: 52, r: 10, t: 10, b: 26 };
      const ser = opt.series, cats = opt.cats;
      let lo = 0, hi = 0;
      for (const s of ser) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      const yt = niceTicks(lo, hi, 5); lo = Math.min(lo, yt[0]); hi = Math.max(hi, yt[yt.length - 1]);
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const Y = v => m.t + ih - (v - lo) / (hi - lo || 1) * ih;
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opt.aria || "長條圖" }, host);
      for (const v of yt) {
        el("line", { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), class: v === 0 ? "base" : "grid" }, svg);
        el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end" }, svg).textContent = opt.yFmt ? opt.yFmt(v) : v;
      }
      const gw = iw / cats.length, gap = Math.min(6, gw * 0.2);
      const bw = Math.max(1, (gw - gap) / ser.length - (ser.length > 1 ? 1 : 0));
      const every = Math.ceil(cats.length / Math.max(2, Math.floor(iw / 44)));
      const tip = document.createElement("div"); tip.className = "ct"; tip.hidden = true; host.appendChild(tip);
      cats.forEach((c, ci) => {
        const gx = m.l + ci * gw + gap / 2;
        ser.forEach((s, k) => {
          const v = s.values[ci]; if (v == null) return;
          const x = gx + k * (bw + (ser.length > 1 ? 1 : 0)), y0 = Y(0), y = Y(v);
          const h = Math.max(1, Math.abs(y - y0)), top = Math.min(y, y0), r = Math.min(3, bw / 2, h / 2);
          // 遠離基準線的那一端圓角
          const d = v >= 0
            ? `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y0}Z`
            : `M${x},${y0}V${top + h - r}Q${x},${top + h} ${x + r},${top + h}H${x + bw - r}Q${x + bw},${top + h} ${x + bw},${top + h - r}V${y0}Z`;
          el("path", { d, fill: col(s.color), "fill-opacity": s.est && s.est[ci] ? 0.4 : 1 }, svg);
        });
        if (ci % every === 0) el("text", { x: gx + (gw - gap) / 2, y: H - 6, "text-anchor": "middle" }, svg).textContent = c;
        const hit = el("rect", { x: m.l + ci * gw, y: m.t, width: gw, height: ih, fill: "transparent" }, svg);
        hit.addEventListener("mouseenter", () => {
          hit.setAttribute("class", "hov");
          tip.innerHTML = `<div class="hd">${c}${opt.catNote && opt.catNote[ci] ? " " + opt.catNote[ci] : ""}</div>` + ser.map((s) =>
            s.values[ci] == null ? "" : `<div><i style="background:${col(s.color)}"></i>${s.name}：<b>${opt.yFmt ? opt.yFmt(s.values[ci]) : s.values[ci]}</b>${s.est && s.est[ci] ? ' <span class="tag">估算</span>' : ""}${s.partial && s.partial[ci] ? ' <span class="tag">不滿一年</span>' : ""}</div>`).join("");
          tip.hidden = false;
          const r = svg.getBoundingClientRect(), sx = r.width / W, tw = tip.offsetWidth;
          let left = (m.l + (ci + 1) * gw) * sx + 6; if (left + tw > r.width) left = (m.l + ci * gw) * sx - tw - 6;
          tip.style.left = Math.max(0, left) + "px"; tip.style.top = "8px";
        });
        hit.addEventListener("mouseleave", () => { hit.removeAttribute("class"); tip.hidden = true; });
      });
      if (ser.length >= 2) host.insertAdjacentHTML("beforeend", legendHTML(ser));
    };
    draw(); attachResize(host, draw);
  }

  /* 迷你走勢線（首頁卡片） */
  function spark(host, dates, values, color) {
    host.innerHTML = "";
    const W = 160, H = 40, n = values.length; if (n < 2) return;
    let lo = Infinity, hi = -Infinity; for (const v of values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const xs = dates.map(dnum), t0 = xs[0], t1 = xs[n - 1];
    const X = t => (t - t0) / (t1 - t0) * W, Y = v => H - 2 - (v - lo) / (hi - lo || 1) * (H - 4);
    const idx = decimate(xs, values, 0, n, X);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "spark", "aria-hidden": "true" }, host);
    el("path", { d: idx.map((i, j) => (j ? "L" : "M") + X(xs[i]).toFixed(1) + "," + Y(values[i]).toFixed(1)).join(""), class: "ln", stroke: col(color) }, svg);
  }

  window.ETChart = { line, bars, spark };
})();
