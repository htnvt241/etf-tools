/* 共用：頂部導覽列、資料更新時間、ⓘ 說明提示 */
(function () {
  "use strict";
  const PAGES = [
    ["index.html", "市場儀表板"],
    ["backtest.html", "ETF 回測比較"],
    ["retire.html", "退休提領模擬"],
    ["optimize.html", "ETF 組合最佳化"],
  ];
  const here = location.pathname.split("/").pop() || "index.html";
  const top = document.getElementById("top");
  if (top) {
    top.className = "top";
    top.innerHTML = `<a class="brand" href="index.html">ETF 工具箱</a><nav class="nav">${
      PAGES.map(([h, t, soon]) => `<a href="${h}" class="${h === here ? "on" : ""}${soon ? " soon" : ""}">${t}</a>`).join("")
    }</nav><span class="updated" id="updated"></span>`;
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
  window.ETUI = {
    info: t => `<button type="button" class="info" aria-label="說明" data-tip="${t.replace(/"/g, "&quot;")}">i</button>`,
    cls: x => x > 0 ? "pos" : x < 0 ? "neg" : "",
  };
})();
