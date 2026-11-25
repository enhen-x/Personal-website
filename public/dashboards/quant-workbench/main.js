import { esc, fmtNum, fmtPct, fmtMoneyShort, clamp, downloadCsv } from "./utils.js";
import { STATE, initPersistedLists, saveWatchlist, saveCompareList } from "./state.js";
import { quantFetch, fetchFinancialsChecked, fetchSharesSafe, showGlobalAlert, clearGlobalAlert } from "./api.js";
import { renderHealthAndStatus, renderOverview, runSnapshotScan, runStockProbe, exportInspectReportCsv, loadInspectData } from "./inspect.js";
import {
  setScreenerHandlers,
  initScreenerSortOptions,
  applyScreenerPreset,
  clearScreenerInputs,
  renderScreenerTable,
  runScreener
} from "./screener.js";
import {
  renderStockKlineCharts,
  renderStockFinCharts,
  renderValuationBandChart,
  resizeStockCharts
} from "./charts.js";
import { FIELD_ZH, getActiveStatementRowsAndCols, renderStatementTable } from "./statements-table.js";
import { renderValuationModels, renderStockValuation } from "./valuation-ui.js";
import {
  COMPARE_RESEARCH_MODES,
  setCompareHandlers,
  syncStockWatchButton,
  renderWatchlistBar,
  toggleCurrentStockWatchlist,
  addCompareStock,
  removeCompareStock,
  applyComparePreset,
  renderCompareBasketTags,
  syncCompareControls,
  loadComparePeers,
  getCompareRows,
  renderCompareScatter,
  renderCompareResults,
  performCompareSearch,
  loadIndustryPeers,
  renderIndustryPeersPanel,
  addTopRecommendedPeers
} from "./compare.js";

if (window.self !== window.top) {
  document.documentElement.classList.add("is-embedded");
}

function parseHash() {
  const raw = (window.location.hash || "").replace(/^#/, "");
  if (!raw || raw === "inspect") return { tab: "inspect" };
  if (raw === "screener") return { tab: "screener" };
  if (raw === "compare") return { tab: "compare" };
  if (raw === "stock") return { tab: "stock", code: STATE.stock.code };
  if (raw.startsWith("stock/")) {
    const code = decodeURIComponent(raw.slice(6)).trim().toUpperCase();
    return { tab: "stock", code: code || STATE.stock.code };
  }
  return { tab: "inspect" };
}

function setTab(tab, opts = {}) {
  const { updateHash = true, stockCode = null } = opts;
  if (stockCode) {
    STATE.stock.code = stockCode.trim().toUpperCase();
  }
  STATE.activeTab = tab;

  document.querySelectorAll("#primary-tabs button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.getElementById("pane-inspect").classList.toggle("hidden", tab !== "inspect");
  document.getElementById("pane-screener").classList.toggle("hidden", tab !== "screener");
  document.getElementById("pane-stock").classList.toggle("hidden", tab !== "stock");
  const cmpPane = document.getElementById("pane-compare");
  if (cmpPane) cmpPane.classList.toggle("hidden", tab !== "compare");

  const noteEl = document.getElementById("tab-context-note");
  if (tab === "inspect") {
    noteEl.textContent = "自动检验四库就绪度、数据新鲜度、同步任务与个股样本完整性";
    if (!STATE.inspectLoaded) loadInspectData();
  } else if (tab === "screener") {
    noteEl.textContent = "基于预计算快照的多因子选股筛选器（共 54 个返回字段，含申万行业、估值与股息率）";
    if (!STATE.screenerLoaded) runScreener(false);
  } else if (tab === "stock") {
    noteEl.textContent = "个股复权日 K 线、成交量、季度/累计营收利润趋势与三大财务报表";
    syncStockWatchButton();
    renderWatchlistBar();
    if (STATE.stock.loadedCode !== STATE.stock.code || !STATE.stock.klineData) {
      loadStockDashboard(STATE.stock.code);
    } else {
      requestAnimationFrame(() => renderAllStockCharts());
    }
  } else if (tab === "compare") {
    noteEl.textContent = "同一多维估值引擎测算多只同业标的的 PB-ROE / IRR / 股息增速二维性价比与横向对比矩阵";
    renderCompareBasketTags();
    syncCompareControls();
    const anchor = STATE.compare.peerAnchorCode && STATE.compare.codes.includes(STATE.compare.peerAnchorCode)
      ? STATE.compare.peerAnchorCode
      : (STATE.compare.codes[0] || STATE.stock.code);
    if (anchor) {
      loadIndustryPeers(anchor, { open: true });
    } else {
      renderIndustryPeersPanel();
    }
    if (!STATE.compare.loaded || STATE.compare.dirty) {
      loadComparePeers(false);
    } else {
      renderCompareResults();
    }
  }

  if (updateHash) {
    const targetHash = tab === "stock" ? `#stock/${encodeURIComponent(STATE.stock.code)}` : `#${tab}`;
    if (window.location.hash !== targetHash) {
      history.replaceState(null, "", targetHash);
    }
  }
}

function renderAllStockCharts() {
  if (STATE.activeTab !== "stock") return;
  renderStockKlineCharts();
  if (STATE.stock.valSnap) {
    renderValuationBandChart(STATE.stock.valSnap);
  }
  renderStockFinCharts();
}

function renderStockKPIs() {
  const kData = STATE.stock.klineData;
  const fin = STATE.stock.finData;
  const items = kData?.items || [];
  const unadjItems = STATE.stock.valKlineData?.items || (kData?.adjust === "none" ? items : []);
  const sym = kData?.symbol || STATE.stock.valKlineData?.symbol || fin?.symbol || { thscode: STATE.stock.code, name: "" };

  document.getElementById("stk-current-title").textContent = `${sym.thscode || STATE.stock.code} ${sym.name || ""}`;
  const badge = document.getElementById("stk-current-badge");
  badge.className = "status-pill pill-pass";
  badge.textContent = `${sym.exchange || "--"} · ${sym.currency || "CNY"}`;
  const resolvedCode = (sym.thscode || STATE.stock.code || "").trim().toUpperCase();
  if (resolvedCode && sym.name) {
    STATE.compare.names[resolvedCode] = sym.name;
    const wlHit = STATE.watchlist.find(it => it.code === resolvedCode);
    if (wlHit && wlHit.name !== sym.name) {
      wlHit.name = sym.name;
      saveWatchlist();
      renderWatchlistBar();
    }
  }
  syncStockWatchButton();
  renderWatchlistBar();

  if (unadjItems.length) {
    const last = unadjItems[unadjItems.length - 1];
    const prev = unadjItems.length > 1 ? unadjItems[unadjItems.length - 2] : last;
    const dayPct = prev.close > 0 ? ((last.close / prev.close - 1) * 100) : 0;

    document.getElementById("stk-kpi1-val").textContent = `¥${fmtNum(last.close)}`;
    const p1 = document.getElementById("stk-kpi1-pill");
    p1.className = `status-pill ${dayPct >= 0 ? "pill-hot" : "pill-pass"}`;
    p1.textContent = fmtPct(dayPct, 2, true);
    document.getElementById("stk-kpi1-bar").style.width = `${clamp(50 + dayPct * 5, 5, 100)}%`;
    document.getElementById("stk-kpi1-bar").style.background = dayPct >= 0 ? "var(--crimson)" : "var(--emerald)";
    document.getElementById("stk-kpi1-meta").textContent = `交易日 ${last.date} · 不复权口径 · 成交额 ${fmtMoneyShort(last.turnover)}`;
  } else {
    document.getElementById("stk-kpi1-val").textContent = "--";
    document.getElementById("stk-kpi1-meta").textContent = "暂无不复权行情数据";
  }

  if (items.length) {
    const last = items[items.length - 1];
    const first = items[0];
    const periodPct = first.close > 0 ? ((last.close / first.close - 1) * 100) : 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (const it of items) {
      if (it.high != null && it.high > hi) hi = it.high;
      if (it.low != null && it.low < lo) lo = it.low;
    }

    document.getElementById("stk-kpi2-val").textContent = fmtPct(periodPct, 2, true);
    const p2 = document.getElementById("stk-kpi2-pill");
    p2.className = `status-pill ${periodPct >= 0 ? "pill-hot" : "pill-pass"}`;
    p2.textContent = `${items.length} 交易日`;
    const posInRange = hi > lo ? ((last.close - lo) / (hi - lo)) * 100 : 50;
    document.getElementById("stk-kpi2-bar").style.width = `${clamp(posInRange, 0, 100)}%`;
    document.getElementById("stk-kpi2-meta").textContent = `区间低 ${fmtNum(lo)} / 高 ${fmtNum(hi)} · 当前位于区间 ${posInRange.toFixed(0)}% 分位`;
  } else {
    document.getElementById("stk-kpi2-val").textContent = "--";
    document.getElementById("stk-kpi2-meta").textContent = "暂无区间数据";
  }

  const inc0 = fin?.income_statements?.[0];
  const bal0 = fin?.balance_sheets?.[0];
  const cfs0 = fin?.cash_flow_statements?.[0];

  if (inc0) {
    document.getElementById("stk-kpi3-val").textContent = `${inc0.fiscal_year || "--"}${inc0.fiscal_period || ""}`;
    document.getElementById("stk-kpi3-pill").textContent = inc0.report_date || "--";
    document.getElementById("stk-kpi3-meta").textContent = `报告期末: ${inc0.period_end || "--"} · 累计加载 ${fin.income_statements.length} 期`;

    document.getElementById("stk-kpi4-val").textContent = fmtMoneyShort(inc0.q_parent_holder_net_profit);
    const qMargin = inc0.q_operating_income > 0 && inc0.q_parent_holder_net_profit !== null
      ? (inc0.q_parent_holder_net_profit / inc0.q_operating_income) * 100
      : null;
    const p4 = document.getElementById("stk-kpi4-pill");
    p4.className = `status-pill ${qMargin !== null && qMargin >= 15 ? "pill-pass" : "pill-mid"}`;
    p4.textContent = qMargin !== null ? `净利率 ${qMargin.toFixed(1)}%` : "单季";
    document.getElementById("stk-kpi4-bar").style.width = `${clamp((qMargin || 0) * 2, 0, 100)}%`;
    document.getElementById("stk-kpi4-meta").textContent =
      `单季营收 ${fmtMoneyShort(inc0.q_operating_income)} · 累计归母净利 ${fmtMoneyShort(inc0.parent_holder_net_profit)}`;
  } else {
    document.getElementById("stk-kpi3-val").textContent = "--";
    document.getElementById("stk-kpi4-val").textContent = "--";
  }

  if (bal0 || cfs0) {
    const debtPct = bal0?.debt_to_assets_pct;
    const qOcf = cfs0?.q_act_cash_flow_net;
    const qNp = inc0?.q_parent_holder_net_profit;
    const ratio = qOcf !== null && qOcf !== undefined && qNp > 0 ? qOcf / qNp : null;

    document.getElementById("stk-kpi5-val").textContent = debtPct !== null && debtPct !== undefined ? `${Number(debtPct).toFixed(1)}%` : "--";
    const p5 = document.getElementById("stk-kpi5-pill");
    p5.className = `status-pill ${ratio !== null && ratio >= 0.8 ? "pill-pass" : "pill-mid"}`;
    p5.textContent = ratio !== null ? `OCF/净利 ${ratio.toFixed(2)}x` : "负债率";
    document.getElementById("stk-kpi5-bar").style.width = `${clamp(debtPct || 0, 0, 100)}%`;
    document.getElementById("stk-kpi5-meta").textContent =
      `单季经营现金流 ${fmtMoneyShort(qOcf)} · 资产总计 ${fmtMoneyShort(bal0?.assets_total)}`;
  } else {
    document.getElementById("stk-kpi5-val").textContent = "--";
  }
}

async function loadStockKlineOnly() {
  const code = STATE.stock.code;
  document.getElementById("chart-stk-price").innerHTML = `<div class="chart-empty">加载 ${esc(code)} 日 K 线中…</div>`;
  document.getElementById("chart-stk-vol").innerHTML = `<div class="chart-empty">加载成交量中…</div>`;

  try {
    const kData = await quantFetch(`/api/stocks/${encodeURIComponent(code)}/kline`, {
      adjust: STATE.stock.adjust,
      limit: STATE.stock.klineLimit
    });
    clearGlobalAlert();
    STATE.stock.klineData = kData;
    let shouldReval = false;
    if (STATE.stock.adjust === "none" && STATE.stock.klineLimit >= 1250 && STATE.stock.valAllLoadedCode !== code) {
      STATE.stock.valKlineData = kData;
      shouldReval = true;
    }
    if (STATE.stock.adjust !== "none" && STATE.stock.klineLimit >= 250) {
      STATE.stock.valFwdKlineData = kData;
      STATE.stock.valFwdLoadedCode = code;
      shouldReval = true;
    }
    if (shouldReval) {
      renderStockValuation();
    }
    renderStockKPIs();
    renderStockKlineCharts();
  } catch (err) {
    document.getElementById("chart-stk-price").innerHTML = `<div class="chart-empty">K线加载失败：${esc(err.message)}</div>`;
    document.getElementById("chart-stk-vol").innerHTML = `<div class="chart-empty">--</div>`;
    showGlobalAlert(err);
  }
}

async function loadStockFinancialsOnly() {
  try {
    const finData = await fetchFinancialsChecked(STATE.stock.code, STATE.stock.stmtLimit);
    clearGlobalAlert();
    STATE.stock.finData = finData;
    if (STATE.stock.stmtLimit >= 40 && STATE.stock.valAllLoadedCode !== STATE.stock.code) {
      STATE.stock.valFinData = finData;
      renderStockValuation();
    }
    renderStockKPIs();
    renderStockFinCharts();
    renderStatementTable();
  } catch (err) {
    showGlobalAlert(err);
  }
}

async function loadFullHistoryValuation() {
  const code = STATE.stock.code;
  if (!code) return;
  if (STATE.stock.valAllLoadedCode === code) {
    if (STATE.stock.valFinData || STATE.stock.finData) renderStockValuation();
    return;
  }

  const statsEl = document.getElementById("val-band-stats");
  const box = document.getElementById("chart-stk-valband");
  if (statsEl) statsEl.textContent = "正在拉取全历史不复权行情与财报（最长覆盖 20+ 年）…";
  if (box) box.innerHTML = `<div class="chart-empty">正在载入全历史估值分位带…</div>`;

  try {
    const needShares = STATE.stock.shareData?.symbol?.thscode !== code || ((STATE.stock.shareData?.items?.length || 0) >= 200);
    const [kAll, finAll, shareAll] = await Promise.all([
      quantFetch(`/api/stocks/${encodeURIComponent(code)}/kline`, { adjust: "none", limit: 6000 }),
      fetchFinancialsChecked(code, 160),
      needShares ? fetchSharesSafe(code, 500) : Promise.resolve(STATE.stock.shareData)
    ]);
    if (STATE.stock.code !== code) return;
    STATE.stock.valKlineData = kAll;
    STATE.stock.valFinData = finAll;
    if (shareAll) STATE.stock.shareData = shareAll;
    STATE.stock.valAllLoadedCode = code;
    clearGlobalAlert();
    if (STATE.stock.valWindow === "all") {
      renderStockValuation();
    }
  } catch (err) {
    showGlobalAlert(err);
    if (STATE.stock.code === code && (STATE.stock.valFinData || STATE.stock.finData)) {
      renderStockValuation();
    }
  }
}

async function loadStockDashboard(code) {
  const clean = (code || STATE.stock.code || "600519.SH").trim().toUpperCase();
  STATE.stock.code = clean;
  STATE.stock.loadedCode = clean;
  STATE.stock.dcfAutoFittedCode = "";
  STATE.stock.valAllLoadedCode = "";
  STATE.stock.shareData = null;
  STATE.stock.valFwdKlineData = null;
  STATE.stock.valFwdLoadedCode = "";
  document.querySelectorAll(".stk-chip").forEach(b => b.classList.toggle("active", b.dataset.code === clean));

  document.getElementById("chart-stk-price").innerHTML = `<div class="chart-empty">正在载入 ${esc(clean)} 行情…</div>`;
  document.getElementById("chart-stk-vol").innerHTML = `<div class="chart-empty">载入中…</div>`;
  document.getElementById("chart-stk-valband").innerHTML = `<div class="chart-empty">计算历史估值分位带中…</div>`;
  document.getElementById("chart-stk-profit").innerHTML = `<div class="chart-empty">正在载入财报…</div>`;
  document.getElementById("chart-stk-cash").innerHTML = `<div class="chart-empty">载入中…</div>`;

  try {
    const wantAll = STATE.stock.valWindow === "all";
    const valKlineLimit = wantAll ? 6000 : 1250;
    const needExtraValKline = !(STATE.stock.adjust === "none" && STATE.stock.klineLimit >= valKlineLimit);
    const hasFwdInMain = STATE.stock.adjust !== "none" && STATE.stock.klineLimit >= 250;
    const valFinLimit = wantAll ? 160 : Math.max(40, STATE.stock.stmtLimit);
    const reqs = [
      quantFetch(`/api/stocks/${encodeURIComponent(clean)}/kline`, {
        adjust: STATE.stock.adjust,
        limit: STATE.stock.klineLimit
      }),
      fetchFinancialsChecked(clean, valFinLimit)
    ];
    let valKIdx = -1;
    if (needExtraValKline) {
      valKIdx = reqs.length;
      reqs.push(quantFetch(`/api/stocks/${encodeURIComponent(clean)}/kline`, {
        adjust: "none",
        limit: valKlineLimit
      }));
    }
    let fwdKIdx = -1;
    if (!hasFwdInMain) {
      fwdKIdx = reqs.length;
      reqs.push(quantFetch(`/api/stocks/${encodeURIComponent(clean)}/kline`, {
        adjust: "forward",
        limit: 260
      }));
    }
    const shareIdx = reqs.length;
    reqs.push(fetchSharesSafe(clean, 200));

    const results = await Promise.all(reqs);
    const kData = results[0];
    const finData = results[1];
    const valKData = valKIdx >= 0 ? results[valKIdx] : kData;
    const fwdKData = fwdKIdx >= 0 ? results[fwdKIdx] : kData;
    const shareData = results[shareIdx] || null;

    clearGlobalAlert();
    STATE.stock.klineData = kData;
    STATE.stock.valKlineData = valKData;
    STATE.stock.valFwdKlineData = fwdKData;
    STATE.stock.valFwdLoadedCode = clean;
    STATE.stock.valFinData = finData;
    STATE.stock.shareData = shareData;
    STATE.stock.valAllLoadedCode = wantAll ? clean : "";
    if (STATE.stock.stmtLimit < valFinLimit) {
      STATE.stock.finData = {
        symbol: finData.symbol,
        income_statements: (finData.income_statements || []).slice(0, STATE.stock.stmtLimit),
        balance_sheets: (finData.balance_sheets || []).slice(0, STATE.stock.stmtLimit),
        cash_flow_statements: (finData.cash_flow_statements || []).slice(0, STATE.stock.stmtLimit),
        adjustment_events: finData.adjustment_events || []
      };
    } else {
      STATE.stock.finData = finData;
    }

    renderStockKPIs();
    renderStockValuation();
    renderAllStockCharts();
    renderStatementTable();
  } catch (err) {
    document.getElementById("chart-stk-price").innerHTML = `<div class="chart-empty">标的数据加载失败：${esc(err.message)}</div>`;
    document.getElementById("chart-stk-valband").innerHTML = `<div class="chart-empty">--</div>`;
    document.getElementById("chart-stk-profit").innerHTML = `<div class="chart-empty">--</div>`;
    document.getElementById("chart-stk-cash").innerHTML = `<div class="chart-empty">--</div>`;
    showGlobalAlert(err);
  }
}

/* ==================== Search Autocomplete ==================== */
let searchTimer = null;
let cmpSearchTimer = null;
async function performStockSearch() {
  const q = document.getElementById("stk-search-input").value.trim();
  const exchange = document.getElementById("stk-search-ex").value;
  const dd = document.getElementById("stk-search-dropdown");

  if (!q) {
    dd.classList.add("hidden");
    return;
  }

  try {
    const res = await quantFetch("/api/stocks", { q, exchange: exchange || undefined, limit: 15 });
    const items = res.items || [];
    if (!items.length) {
      dd.innerHTML = `<div class="search-opt flat">未找到匹配 “${esc(q)}” 的标的</div>`;
    } else {
      dd.innerHTML = items.map(it => `
        <div class="search-opt" data-code="${esc(it.thscode)}">
          <span><strong>${esc(it.thscode)}</strong> · ${esc(it.name || it.ticker)}</span>
          <span class="mini-pill">${esc(it.exchange || "--")}</span>
        </div>
      `).join("");
      dd.querySelectorAll(".search-opt[data-code]").forEach(el => {
        el.addEventListener("click", () => {
          const c = el.dataset.code;
          document.getElementById("stk-search-input").value = c;
          dd.classList.add("hidden");
          setTab("stock", { stockCode: c });
          loadStockDashboard(c);
        });
      });
    }
    dd.classList.remove("hidden");
  } catch {
    dd.classList.add("hidden");
  }
}

function bindEvents() {
  document.querySelectorAll("#primary-tabs button").forEach(btn => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  document.getElementById("btn-refresh-global").addEventListener("click", () => loadInspectData(true));
  document.getElementById("btn-rerun-overview").addEventListener("click", () => loadInspectData(true));
  document.getElementById("btn-snap-scan").addEventListener("click", () => runSnapshotScan(true));
  document.getElementById("btn-inspect-csv").addEventListener("click", () => exportInspectReportCsv());
  document.getElementById("btn-retry-active").addEventListener("click", () => {
    if (STATE.activeTab === "inspect") loadInspectData(true);
    else if (STATE.activeTab === "screener") runScreener(false);
    else if (STATE.activeTab === "compare") loadComparePeers(true);
    else loadStockDashboard(STATE.stock.code);
  });

  // Tab 1 probe
  document.getElementById("btn-run-probe").addEventListener("click", () => {
    runStockProbe(document.getElementById("probe-code-input").value);
  });
  document.getElementById("probe-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runStockProbe(e.target.value);
  });
  document.querySelectorAll(".probe-chip").forEach(btn => {
    btn.addEventListener("click", () => runStockProbe(btn.dataset.code));
  });
  document.getElementById("btn-probe-to-stock").addEventListener("click", () => {
    const code = document.getElementById("probe-code-input").value.trim().toUpperCase() || "600519.SH";
    setTab("stock", { stockCode: code });
    loadStockDashboard(code);
  });

  // Tab 2 screener
  document.querySelectorAll(".scr-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      applyScreenerPreset(btn.dataset.preset);
      runScreener(true);
    });
  });
  document.getElementById("btn-scr-reset").addEventListener("click", () => {
    clearScreenerInputs();
    document.querySelectorAll(".scr-preset").forEach(b => b.classList.remove("active"));
    runScreener(true);
  });
  document.getElementById("btn-scr-apply").addEventListener("click", () => runScreener(true));
  document.getElementById("scr-form").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runScreener(true);
  });
  document.getElementById("f-sort-by").addEventListener("change", () => runScreener(true));
  document.getElementById("f-sort-dir").addEventListener("change", () => runScreener(true));
  document.getElementById("f-limit").addEventListener("change", () => runScreener(true));

  document.querySelectorAll("#seg-scr-view button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-scr-view button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.screener.view = btn.dataset.view;
      renderScreenerTable();
    });
  });

  document.getElementById("btn-scr-prev").addEventListener("click", () => {
    STATE.screener.offset = Math.max(0, STATE.screener.offset - STATE.screener.limit);
    runScreener(false);
  });
  document.getElementById("btn-scr-next").addEventListener("click", () => {
    STATE.screener.offset = STATE.screener.offset + STATE.screener.limit;
    runScreener(false);
  });

  document.getElementById("btn-scr-csv").addEventListener("click", () => {
    const items = STATE.screener.items || [];
    if (!items.length) return;
    const allKeys = Object.keys(items[0]);
    downloadCsv(
      `screener_${new Date().toISOString().slice(0, 10)}.csv`,
      allKeys,
      items.map(it => allKeys.map(k => it[k]))
    );
  });

  // Tab 3 stock search & controls
  const searchInput = document.getElementById("stk-search-input");
  searchInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(performStockSearch, 250);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      document.getElementById("stk-search-dropdown").classList.add("hidden");
      const val = searchInput.value.trim().toUpperCase();
      if (/^\d{6}\.(SH|SZ|BJ)$/.test(val)) {
        setTab("stock", { stockCode: val });
        loadStockDashboard(val);
      } else {
        performStockSearch();
      }
    }
  });
  document.getElementById("stk-search-ex").addEventListener("change", performStockSearch);
  document.getElementById("btn-stk-go").addEventListener("click", () => {
    const val = searchInput.value.trim().toUpperCase();
    document.getElementById("stk-search-dropdown").classList.add("hidden");
    if (/^\d{6}\.(SH|SZ|BJ)$/.test(val)) {
      setTab("stock", { stockCode: val });
      loadStockDashboard(val);
    } else {
      performStockSearch();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".stock-search-wrap")) {
      document.getElementById("stk-search-dropdown").classList.add("hidden");
      const cdd = document.getElementById("cmp-search-dropdown");
      if (cdd) cdd.classList.add("hidden");
    }
  });

  document.getElementById("btn-stk-watch").addEventListener("click", toggleCurrentStockWatchlist);
  document.getElementById("btn-stk-to-compare").addEventListener("click", () => {
    const code = (STATE.stock.code || "").trim().toUpperCase();
    const sym = STATE.stock.valSnap?.symSnap || STATE.stock.finData?.symbol || STATE.stock.klineData?.symbol;
    const name = sym?.name || STATE.compare.names[code] || "";
    addCompareStock(code, name, false);
    const btn = document.getElementById("btn-stk-to-compare");
    btn.textContent = "✓ 已加入对比";
    setTimeout(() => { btn.textContent = "+ 同业对比"; }, 1400);
  });

  document.querySelectorAll(".stk-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = btn.dataset.code;
      setTab("stock", { stockCode: c });
      loadStockDashboard(c);
    });
  });

  document.querySelectorAll("#seg-k-adjust button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-k-adjust button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.adjust = btn.dataset.val;
      loadStockKlineOnly();
    });
  });
  document.querySelectorAll("#seg-k-limit button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-k-limit button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.klineLimit = Number(btn.dataset.val) || 250;
      loadStockKlineOnly();
    });
  });
  document.querySelectorAll("#seg-k-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-k-mode button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.chartMode = btn.dataset.val;
      renderStockKlineCharts();
    });
  });

  ["chk-ma5", "chk-ma20", "chk-ma60"].forEach(id => {
    document.getElementById(id).addEventListener("change", (e) => {
      STATE.stock[id.replace("chk-", "")] = e.target.checked;
      renderStockKlineCharts();
    });
  });

  // Valuation controls
  document.querySelectorAll("#seg-val-metric button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-val-metric button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.valMetric = btn.dataset.val;
      if (STATE.stock.valSnap) renderValuationBandChart(STATE.stock.valSnap);
    });
  });
  document.querySelectorAll("#seg-val-window button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-val-window button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.valWindow = btn.dataset.val === "all" ? "all" : (Number(btn.dataset.val) || 1250);
      if (STATE.stock.valWindow === "all") {
        loadFullHistoryValuation();
      } else if (STATE.stock.valFinData || STATE.stock.finData) {
        renderStockValuation();
      }
    });
  });
  document.querySelectorAll("#seg-val-align button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-val-align button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.valAlignMode = btn.dataset.val === "period_end" ? "period_end" : "pit";
      if (STATE.stock.valFinData || STATE.stock.finData) {
        renderStockValuation();
      }
    });
  });
  document.querySelectorAll("#seg-dcf-base button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-dcf-base button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.dcfBase = btn.dataset.val;
      renderValuationModels();
    });
  });
  document.querySelectorAll("#seg-dcf-r-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.stock.dcfRMode = btn.dataset.val === "hist_gordon" ? "hist_gordon" : "capm";
      const snap = STATE.stock.valSnap;
      const presetKey = STATE.stock.dcfPreset === "custom" ? "neutral" : (STATE.stock.dcfPreset || "neutral");
      const p = snap?.dcfModel?.presetsByMode?.[STATE.stock.dcfRMode]?.[presetKey];
      if (p) {
        STATE.stock.dcfR = p.r;
      }
      renderValuationModels();
    });
  });
  document.getElementById("btn-dcf-netcash").addEventListener("click", () => {
    if (STATE.stock.valSnap?.isFinancial) return;
    STATE.stock.dcfNetCashAdj = !STATE.stock.dcfNetCashAdj;
    renderValuationModels();
  });
  document.getElementById("btn-rim-below-book").addEventListener("click", () => {
    STATE.stock.rimAllowBelowBook = !STATE.stock.rimAllowBelowBook;
    renderValuationModels();
  });
  document.querySelectorAll(".val-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".val-preset").forEach(b => b.classList.toggle("active", b === btn));
      const snap = STATE.stock.valSnap;
      const mode = btn.dataset.preset;
      STATE.stock.dcfPreset = mode;
      const rMode = STATE.stock.dcfRMode === "hist_gordon" ? "hist_gordon" : "capm";
      const p = snap?.dcfModel?.presetsByMode?.[rMode]?.[mode] || snap?.dcfModel?.presets?.[mode];
      if (p) {
        STATE.stock.dcfG1 = p.g1;
        STATE.stock.dcfG2 = p.g2;
        STATE.stock.dcfR = p.r;
        STATE.stock.dcfMos = p.mos;
      } else {
        if (mode === "conservative") {
          STATE.stock.dcfG1 = 4.0;
          STATE.stock.dcfG2 = 2.0;
          STATE.stock.dcfR = 9.5;
          STATE.stock.dcfMos = 25;
        } else if (mode === "optimistic") {
          STATE.stock.dcfG1 = 10.0;
          STATE.stock.dcfG2 = 3.0;
          STATE.stock.dcfR = 8.5;
          STATE.stock.dcfMos = 15;
        } else {
          STATE.stock.dcfG1 = 7.0;
          STATE.stock.dcfG2 = 2.5;
          STATE.stock.dcfR = 9.0;
          STATE.stock.dcfMos = 20;
        }
      }
      renderValuationModels();
    });
  });
  [
    ["rng-dcf-g1", "dcfG1"],
    ["rng-dcf-g2", "dcfG2"],
    ["rng-dcf-r", "dcfR"],
    ["rng-dcf-mos", "dcfMos"]
  ].forEach(([id, key]) => {
    document.getElementById(id).addEventListener("input", (e) => {
      STATE.stock[key] = Number(e.target.value);
      STATE.stock.dcfPreset = "custom";
      document.querySelectorAll(".val-preset").forEach(b => b.classList.remove("active"));
      renderValuationModels();
    });
  });

  document.querySelectorAll("#seg-fin-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-fin-mode button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.finMode = btn.dataset.val;
      renderStockFinCharts();
    });
  });
  document.querySelectorAll("#seg-stmt-type button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-stmt-type button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.stmtType = btn.dataset.val;
      renderStatementTable();
    });
  });
  document.querySelectorAll("#seg-stmt-cols button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-stmt-cols button").forEach(b => b.classList.toggle("active", b === btn));
      STATE.stock.stmtCols = btn.dataset.val;
      renderStatementTable();
    });
  });
  document.getElementById("btn-stmt-deltas").addEventListener("click", () => {
    STATE.stock.stmtShowDeltas = !STATE.stock.stmtShowDeltas;
    const show = STATE.stock.stmtShowDeltas;
    const btn = document.getElementById("btn-stmt-deltas");
    btn.classList.toggle("active", show);
    btn.setAttribute("aria-pressed", String(show));
    btn.textContent = show ? "同比/环比: 开" : "同比/环比: 关";
    document.getElementById("stmt-tbody").classList.toggle("hide-deltas", !show);
  });
  document.getElementById("sel-stmt-limit").addEventListener("change", (e) => {
    STATE.stock.stmtLimit = Number(e.target.value) || 40;
    loadStockFinancialsOnly();
  });
  document.getElementById("btn-stmt-csv").addEventListener("click", () => {
    const { rows, cols } = getActiveStatementRowsAndCols();
    if (!rows.length) return;
    downloadCsv(
      `${STATE.stock.code}_${STATE.stock.stmtType}.csv`,
      cols.map(c => FIELD_ZH[c] ? `${FIELD_ZH[c]}(${c})` : c),
      rows.map(r => cols.map(c => r[c]))
    );
  });

  // Tab 4 peer comparison controls
  const cmpSearch = document.getElementById("cmp-search-input");
  cmpSearch.addEventListener("input", () => {
    if (cmpSearchTimer) clearTimeout(cmpSearchTimer);
    cmpSearchTimer = setTimeout(performCompareSearch, 250);
  });
  cmpSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      document.getElementById("cmp-search-dropdown").classList.add("hidden");
      const val = cmpSearch.value.trim().toUpperCase();
      if (/^\d{6}\.(SH|SZ|BJ)$/.test(val)) {
        cmpSearch.value = "";
        addCompareStock(val, "", true);
      } else {
        performCompareSearch();
      }
    }
  });
  document.getElementById("btn-cmp-add").addEventListener("click", () => {
    const val = cmpSearch.value.trim().toUpperCase();
    document.getElementById("cmp-search-dropdown").classList.add("hidden");
    if (/^\d{6}\.(SH|SZ|BJ)$/.test(val)) {
      cmpSearch.value = "";
      addCompareStock(val, "", true);
    } else {
      performCompareSearch();
    }
  });
  document.getElementById("btn-cmp-clear").addEventListener("click", () => {
    STATE.compare.codes = [];
    STATE.compare.peerAnchorCode = "";
    STATE.compare.peerData = null;
    STATE.compare.peerError = "";
    STATE.compare.peerLoading = false;
    saveCompareList();
    renderCompareBasketTags();
    renderIndustryPeersPanel();
    renderCompareResults();
  });
  document.getElementById("btn-cmp-refresh").addEventListener("click", () => {
    loadComparePeers(true);
    if (STATE.compare.peerAnchorCode) {
      loadIndustryPeers(STATE.compare.peerAnchorCode, { open: STATE.compare.peerOpen, forceFresh: true });
    }
  });
  document.querySelectorAll(".cmp-preset").forEach(btn => {
    btn.addEventListener("click", () => applyComparePreset(btn.dataset.group));
  });
  document.querySelectorAll("#seg-cmp-peer-level button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.peerLevel = btn.dataset.val || "l2";
      if (STATE.compare.peerAnchorCode) {
        loadIndustryPeers(STATE.compare.peerAnchorCode, { open: true });
      }
    });
  });
  document.querySelectorAll("#seg-cmp-peer-sort button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.peerSortBy = btn.dataset.val || "total_market_cap";
      if (STATE.compare.peerAnchorCode) {
        loadIndustryPeers(STATE.compare.peerAnchorCode, { open: true });
      }
    });
  });
  document.getElementById("btn-cmp-peers-fill").addEventListener("click", () => {
    addTopRecommendedPeers(5);
  });
  document.getElementById("btn-cmp-peers-toggle").addEventListener("click", () => {
    STATE.compare.peerOpen = !STATE.compare.peerOpen;
    renderIndustryPeersPanel();
  });
  document.querySelectorAll("#seg-cmp-r-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.rMode = btn.dataset.val === "hist_gordon" ? "hist_gordon" : "capm";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-scenario button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.scenario = btn.dataset.val || "neutral";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-horizon button").forEach(btn => {
    btn.addEventListener("click", () => {
      const nextHz = btn.dataset.val || "ttm";
      STATE.compare.horizon = nextHz;
      const sortRemap = {
        pe: { ttm: "peTtm", "3y": "pe3yNorm", "5y": "pe5yNorm" },
        evEbit: { ttm: "evToEbitTtm", "3y": "evToEbit3y", "5y": "evToEbit5y" },
        roeToPb: { ttm: "roeToPbTtm", "3y": "roeToPb3y", "5y": "roeToPb5y" },
        fcf: { ttm: "fcfYieldPct", "3y": "fcf3yYieldPct", "5y": "fcf5yYieldPct" },
        roic: { ttm: "roic5yMean", "3y": "roic3yMean", "5y": "roic5yMean" }
      };
      for (const grp of Object.values(sortRemap)) {
        if (Object.values(grp).includes(STATE.compare.sortBy)) {
          STATE.compare.sortBy = grp[nextHz] || grp.ttm;
          break;
        }
      }
      renderCompareResults();
    });
  });
  document.getElementById("btn-cmp-netcash").addEventListener("click", () => {
    STATE.compare.netCashAdj = !STATE.compare.netCashAdj;
    renderCompareResults();
  });
  document.getElementById("btn-cmp-rim-below").addEventListener("click", () => {
    STATE.compare.rimAllowBelowBook = !STATE.compare.rimAllowBelowBook;
    renderCompareResults();
  });
  document.querySelectorAll("#seg-cmp-research-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      const nextMode = btn.dataset.val || "dividend";
      STATE.compare.researchMode = nextMode;
      const modeCfg = COMPARE_RESEARCH_MODES[nextMode];
      if (modeCfg) {
        STATE.compare.scatterMode = modeCfg.defaultView;
      }
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-div-elasticity button").forEach(btn => {
    btn.addEventListener("click", () => {
      const nextEl = btn.dataset.val || "dps_cagr";
      STATE.compare.divElasticityMode = nextEl;
      if (STATE.compare.sortBy === "divCagr3y" || STATE.compare.sortBy === "divElasticityForward") {
        STATE.compare.sortBy = nextEl === "forward_pot" ? "divElasticityForward" : "divCagr3y";
      }
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-div-risk button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.divRiskAxis = btn.dataset.val || "max_dd";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-qual-val button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.qualValAxis = btn.dataset.val || "pe_norm";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-qual-comp button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.qualCompAxis = btn.dataset.val || "irr";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-qual-cash button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.qualCashAxis = btn.dataset.val || "cash_conv";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-cyc-odds button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.cycleOddsAxis = btn.dataset.val || "pb_cheap";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-cyc-inflect button").forEach(btn => {
    btn.addEventListener("click", () => {
      const nextInflect = btn.dataset.val || "gm_yoy";
      STATE.compare.cycleInflectAxis = nextInflect;
      if (STATE.compare.sortBy === "qGmYoyPp" || STATE.compare.sortBy === "deltaRoeMarginPp") {
        STATE.compare.sortBy = nextInflect === "roe_delta" ? "deltaRoeMarginPp" : "qGmYoyPp";
      }
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-cyc-safety button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.cycleSafetyAxis = btn.dataset.val || "int_cov";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-gr-val button").forEach(btn => {
    btn.addEventListener("click", () => {
      const nextVal = btn.dataset.val || "peg";
      STATE.compare.growthValAxis = nextVal;
      if (STATE.compare.sortBy === "peg3y" || STATE.compare.sortBy === "psg") {
        STATE.compare.sortBy = nextVal === "psg" ? "psg" : "peg3y";
      }
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-gr-eff button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.growthEffAxis = btn.dataset.val || "roic";
      renderCompareResults();
    });
  });
  document.querySelectorAll("#seg-cmp-gr-cash button").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.compare.growthCashAxis = btn.dataset.val || "cash_conv";
      renderCompareResults();
    });
  });
  const cmpScatterSeg = document.getElementById("seg-cmp-scatter");
  if (cmpScatterSeg) {
    cmpScatterSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-val]");
      if (!btn) return;
      STATE.compare.scatterMode = btn.dataset.val || "div_return_stab";
      renderCompareResults();
    });
  }
  document.getElementById("btn-cmp-arrows").addEventListener("click", () => {
    STATE.compare.showGrowthArrows = !STATE.compare.showGrowthArrows;
    renderCompareResults();
  });
  document.getElementById("btn-cmp-risk-rings").addEventListener("click", () => {
    STATE.compare.showRiskRings = !STATE.compare.showRiskRings;
    renderCompareResults();
  });
  document.getElementById("btn-cmp-csv").addEventListener("click", () => {
    const rows = getCompareRows();
    if (!rows.length) return;
    const headers = [
      "code", "name", "mkt_cap", "unadj_close", "pe_ttm", "pe_3y_norm", "pe_5y_norm", "pe_pct_5y",
      "pb", "pb_3y_avg", "pb_5y_avg", "pb_pct_5y",
      "roe_ttm", "roe_3y_mean", "roe_5y_mean", "roe_3y_vol", "roe_3y_min",
      "roe_to_pb_ttm", "roe_to_pb_3y", "roe_to_pb_5y",
      "shareholder_yield_pct", "div_yield_ttm", "buyback_yield_pct", "buyback_source", "payout_pct",
      "div_stability_score", "div_stability_grade", "div_consec_years", "div_cv_5y", "div_cut_count_5y", "div_cagr_3y", "div_cagr_5y",
      "div_elasticity_fwd", "fcf_div_coverage", "capex_to_ocf_pct", "div_risk_flag",
      "fcf_yield_pct", "fcf_3y_yield_pct", "fcf_5y_yield_pct", "cash_conv_5y", "roic_5y_mean", "roe_vol_5y", "accrual_ratio_pct", "ar_to_rev_pct", "equity_basis", "roic_debt_basis", "est_ib_debt_ratio_pct", "quality_risk_flag",
      "ev_to_ebit_ttm", "ev_to_ebit_3y", "ev_to_ebit_5y", "ebit_yield_5y", "ebit_cycle_pos", "ev_debt_basis",
      "q_gm_yoy_pp", "delta_roe_margin_pp", "capex_to_rev_pct", "interest_coverage", "cash_to_debt_pct", "cycle_risk_flag",
      "np_cagr_3y", "rev_yoy_1y", "rev_cagr_3y", "np_accel_pp", "peg_3y", "psg", "rd_ratio_pct", "ttm_gm_pct", "fcf_margin_3y", "growth_risk_flag",
      "g1_base", "np_yoy_1y", "dcf_base", "dcf_mid", "dcf_upside_pct",
      "rim_mid", "rim_upside_pct", "implied_irr", "r_used", "net_cash_per_share",
      "debt_ratio_pct", "net_cash_to_mktcap", "vol_3y", "max_dd_3y", "risk_flag"
    ];
    downloadCsv(
      `peer_compare_${new Date().toISOString().slice(0, 10)}.csv`,
      headers,
      rows.map(r => [
        r.code, r.name, r.mktCap, r.unadjPrice, r.peTtm, r.pe3yNorm, r.pe5yNorm, r.pePct5y,
        r.pb, r.pb3yAvg, r.pb5yAvg, r.pbPct5y,
        r.roeTtm, r.roeMean3y, r.roeMean5y, r.roeVol3y, r.roeMin3y,
        r.roeToPbTtm, r.roeToPb3y, r.roeToPb5y,
        r.shareholderYieldPct, r.divYieldPct, r.buybackYieldPct, r.buybackSource, r.payoutPct,
        r.divStabilityScore, r.divStabilityGrade, r.divConsecYears, r.divCv5y, r.divCutCount5y, r.divCagr3y, r.divCagr5y,
        r.divElasticityForward, r.fcfDivCoverage, r.capexToOcfPct, r.divRiskFlag,
        r.fcfYieldPct, r.fcf3yYieldPct, r.fcf5yYieldPct, r.cashConv5y, r.roic5yMean, r.roeVol5y, r.accrualRatio, r.arToRevPct, r.equityBasis, r.roicDebtBasis, r.estIbDebtRatioPct, r.qualityRiskFlag,
        r.evToEbitTtm, r.evToEbit3y, r.evToEbit5y, r.ebitYield5y, r.ebitCyclePos, r.evDebtBasis,
        r.qGmYoyPp, r.deltaRoeMarginPp, r.capexToRevPct, r.interestCoverage, r.cashToDebtPct, r.cycleRiskFlag,
        r.npCagr3y, r.revYoy1yRaw, r.revCagr3y, r.npAccelPp, r.peg3y, r.psg, r.rdRatioPct, r.ttmGmPct, r.fcfMargin3y, r.growthRiskFlag,
        r.g1Base, r.npYoy1yRaw, r.dcfBase, r.dcfMid, r.dcfUpsidePct,
        r.rimMid, r.rimUpsidePct, r.impliedIrr, r.rUsed, r.netCashPerShare,
        r.debtRatioPct, r.netCashToMktCap, r.vol3y, r.maxDd3y, r.riskFlag
      ])
    );
  });

  window.addEventListener("hashchange", () => {
    const parsed = parseHash();
    setTab(parsed.tab, { updateHash: false, stockCode: parsed.code });
  });

  let lastViewportWidth = window.innerWidth;
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    const curWidth = window.innerWidth;
    if (Math.abs(curWidth - lastViewportWidth) < 2) return;
    lastViewportWidth = curWidth;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeStockCharts();
      if (STATE.activeTab === "compare") {
        renderCompareScatter(getCompareRows());
      }
    }, 120);
  });
}

function openStockTab(code, forceReloadIfSame = false) {
  const clean = (code || STATE.stock.code || "600519.SH").trim().toUpperCase();
  const sameLoaded = STATE.stock.loadedCode === clean && Boolean(STATE.stock.klineData);
  setTab("stock", { stockCode: clean });
  if (forceReloadIfSame && sameLoaded) {
    loadStockDashboard(clean);
  }
}

function initApp() {
  setScreenerHandlers({
    onOpenStock: (c) => openStockTab(c, false),
    onAddCompare: addCompareStock,
    onRemoveCompare: removeCompareStock
  });
  setCompareHandlers({
    onOpenStock: openStockTab
  });

  initPersistedLists();
  initScreenerSortOptions();
  applyScreenerPreset("liquid");
  bindEvents();
  syncStockWatchButton();
  renderWatchlistBar();

  const initial = parseHash();
  setTab(initial.tab, { updateHash: false, stockCode: initial.code });

  if (initial.tab !== "inspect") {
    quantFetch("/health").then(renderHealthAndStatus).catch(() => {});
    quantFetch("/api/overview").then(renderOverview).catch(() => {});
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp, { once: true });
} else {
  initApp();
}
