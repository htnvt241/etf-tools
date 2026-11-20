"""把 data/check.json 轉成 GitHub Issue 的內容（Markdown），印到標準輸出。"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPE = {"missing": "缺資料", "stale": "資料落後", "gap": "資料中斷", "jump": "跳格",
        "ratio": "原始／還原價異常", "rewrite": "歷史被改動", "lag": "暫時缺漏"}

with open(os.path.join(ROOT, "data", "check.json"), encoding="utf-8") as f:
    c = json.load(f)

lines = [f"**檢查時間**：{c['checked']}（台灣時間）", ""]
if c["status"] == "ok":
    lines.append("✅ 資料檢查恢復正常。")
else:
    lines += [
        f"⚠️ 發現 **{len(c['new'])}** 個新問題。以下標的這次**沒有更新**，網站繼續使用上一次的資料："
        f"{'、'.join(c['blocked'])}", "",
        "| 標的 | 類型 | 日期 | 說明 |", "|---|---|---|---|",
    ]
    for i in c["new"][:60]:
        lines.append(f"| {i['ticker']} | {TYPE.get(i['type'], i['type'])} | {i['date']} | {i['detail']} |")
    if len(c["new"]) > 60:
        lines.append(f"| … | | | 還有 {len(c['new']) - 60} 個 |")
    lines += ["", "處理方式：把這則通知的內容貼給 Claude，確認是資料錯誤（要修正）還是真實事件（可忽略），"
              "更新 `data/known_issues.json` 之後，下次自動更新就會恢復。"]
print("\n".join(lines))
