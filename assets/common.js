/* 共用：頂部導覽列、資料更新時間、ⓘ 說明提示 */
(function () {
  "use strict";
  const PAGES = [
    ["index.html", "市場儀表板"],
    ["backtest.html", "ETF 回測比較"],
    ["retire.html", "退休提領模擬"],
    ["optimize.html", "ETF 組合最佳化"],
    // 下拉選單：滑鼠移過去自動展開（手機點一下展開）。以後新增工具就加在 items 裡
    { title: "其他工具", items: [
      ["rebalance.html", "正二再平衡回測", "00631L 搭配現金的曝險再平衡：回測、爆倉掃描、最佳化、我的部位"],
      ["kalman.html", "Kalman 趨勢回測", "看報酬指數或加權指數的 Kalman 快慢線，決定 0050／00631L 進出"],
      ["envelope.html", "均線包絡策略", "看報酬指數或加權指數的均線上下軌（可設不同百分比），突破上軌買、跌破下軌賣"],
      ["kd.html", "月KD策略", "看報酬指數或加權指數的月 KD：正交買、負交賣；00631L 另有高檔改買 0050 的策略"],
    ] },
  ];
  const here = location.pathname.split("/").pop() || "index.html";
  const top = document.getElementById("top");
  if (top) {
    top.className = "top";
    const item = p => {
      if (!Array.isArray(p)) {
        const on = p.items.some(([h]) => h === here);
        return `<div class="dd${on ? " on" : ""}"><button type="button" class="ddt" aria-haspopup="true">${p.title} <span class="car">▾</span></button>
          <div class="ddm">${p.items.map(([h, t, d]) => `<a href="${h}" class="${h === here ? "on" : ""}"><b>${t}</b>${d ? `<small>${d}</small>` : ""}</a>`).join("")}</div></div>`;
      }
      const [h, t, soon] = p;
      return `<a href="${h}" class="${h === here ? "on" : ""}${soon ? " soon" : ""}">${t}</a>`;
    };
    top.innerHTML = `<a class="brand" href="index.html">ETF 工具箱</a><nav class="nav">${PAGES.map(item).join("")}</nav><span class="updated" id="updated"></span>`;
    // 觸控裝置沒有滑鼠：點一下展開／收合，點其他地方收合
    top.querySelectorAll(".dd").forEach(dd => dd.querySelector(".ddt").addEventListener("click", e => { e.stopPropagation(); dd.classList.toggle("open"); }));
    document.addEventListener("click", () => top.querySelectorAll(".dd.open").forEach(dd => dd.classList.remove("open")));
    ET.loadMeta().then(m => {
      if (m && m.updated) document.getElementById("updated").insertAdjacentText("afterbegin", "資料更新：" + m.updated);
    }).catch(() => {});
    fetch("data/check.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : null).then(c => {
      if (!c) return;
      const bad = c.status === "problem";
      document.getElementById("updated").insertAdjacentHTML("beforeend",
        ` <a class="chk-badge ${bad ? "bad" : "good"}" href="index.html#check">${bad ? "⚠ 資料檢查：" + c.new.length + " 個問題" : "✓ 資料檢查正常"}</a>`);
      window.ETCheck = c;
      document.dispatchEvent(new CustomEvent("etcheck", { detail: c }));
    }).catch(() => {});
  }
  window.ETUI = {
    info: t => `<button type="button" class="info" aria-label="說明" data-tip="${t.replace(/"/g, "&quot;")}">i</button>`,
    cls: x => x > 0 ? "pos" : x < 0 ? "neg" : "",
  };
  if (document.getElementById("tip")) return;   // 頁面自己有說明提示（例如正二再平衡回測），就不重複處理
  // ⓘ 說明：滑過或點擊顯示
  const tip = document.createElement("div"); tip.id = "tip"; tip.hidden = true; document.body.appendChild(tip);
  let pinned = null;
  function show(b) {
    tip.textContent = b.dataset.tip; tip.hidden = false;
    const r = b.getBoundingClientRect(), tw = Math.min(320, innerWidth - 16);
    tip.style.maxWidth = tw + "px";
    let left = Math.min(r.left, innerWidth - tip.offsetWidth - 8);
    let topY = r.bottom + 6; if (topY + tip.offsetHeight > innerHeight - 8) topY = r.top - tip.offsetHeight - 6;
    tip.style.left = Math.max(8, left) + "px"; tip.style.top = topY + "px";
  }
  document.addEventListener("mouseover", e => { const b = e.target.closest("button.info"); if (b && !pinned) show(b); });
  document.addEventListener("mouseout", e => { const b = e.target.closest("button.info"); if (b && !pinned) tip.hidden = true; });
  document.addEventListener("click", e => {
    const b = e.target.closest("button.info");
    if (b) { e.preventDefault(); if (pinned === b) { pinned = null; tip.hidden = true; } else { pinned = b; show(b); } return; }
    if (pinned) { pinned = null; tip.hidden = true; }
  });

})();
