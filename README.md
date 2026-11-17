# ETF 工具箱

台股、美股 ETF 的回測與市場儀表板。純網頁（HTML + JavaScript），放在 GitHub Pages，不需要伺服器。

## 頁面

- **市場儀表板**（`index.html`）：台灣加權指數、S&P 500，以及各 ETF 的最新報酬
- **ETF 回測比較**（`backtest.html`）：單筆投入／定期定額、美股可切換美金或台幣、每年報酬、回撤、滾動報酬

## 資料怎麼更新

`.github/workflows/update-data.yml` 每個交易日自動執行兩次（台股收盤後、美股收盤後），
執行 `scripts/update_data.py` 從 Yahoo Finance 抓全部歷史，存成 `data/*.csv`，有變動就自動存回專案。

要手動更新：GitHub 專案頁 → **Actions** → 左邊「每日更新股價」→ **Run workflow**。

## 標的

| 檔名 | 標的 |
|---|---|
| 0050、006208、00631L | 台股 ETF |
| VT、VOO、QQQ、QLD、BND | 美股 ETF |
| TWII | 台灣加權指數（價格指數，不含息） |
| GSPC | S&P 500 指數（價格指數，不含息） |
| SP500TR | S&P 500 含息報酬指數（用來推估 VOO 上市前） |
| USDTWD | 美元兌台幣匯率 |

要新增標的：在 `scripts/update_data.py` 的 `TICKERS` 和 `assets/core.js` 的 `TICKERS` 各加一行。

本站僅供學習研究，不構成投資建議。
