import { esc, fmtNum, fmtPct, fmtMoneyShort, clsSign, median, clamp } from "./utils.js";
import { STATE, PEER_PRESETS, saveWatchlist, saveCompareList } from "./state.js";
import { quantFetch, fetchFinancialsChecked, fetchSharesSafe } from "./api.js";
import { evaluateStockValuation, computePeerMetrics } from "./valuation-engine.js";

let compareHandlers = {
  onOpenStock: null
};

export function setCompareHandlers(handlers = {}) {
  compareHandlers = { ...compareHandlers, ...handlers };
}

export function syncStockWatchButton() {
  const btn = document.getElementById("btn-stk-watch");
  if (!btn) return;
  const code = (STATE.stock.code || "").trim().toUpperCase();
  const inWl = STATE.watchlist.some(it => it.code === code);
  btn.classList.toggle("active", inWl);
  btn.textContent = inWl ? "★ 已在自选" : "☆ 加入自选";
}

export function renderWatchlistBar() {
  const bar = document.getElementById("stk-watchlist-bar");
  if (!bar) return;
  const curCode = (STATE.stock.code || "").trim().toUpperCase();
  if (!STATE.watchlist.length) {
    bar.innerHTML = `<span class="ctrl-label">我的自选池:</span><span class="flat" style="font-size:11.5px;">暂无自选标的，点击上方「☆ 加入自选」添加（最多 20 只）</span>`;
    return;
  }
  bar.innerHTML = `<span class="ctrl-label">我的自选池 (${STATE.watchlist.length}):</span>` + STATE.watchlist.map(it => {
    const active = it.code === curCode ? " active" : "";
    const label = it.name ? `${it.code} ${it.name}` : it.code;
    return `<span class="watch-pill${active}" data-wl-code="${esc(it.code)}">${esc(label)}<span class="x-del" data-wl-del="${esc(it.code)}" title="移出自选">×</span></span>`;
  }).join("");

  bar.querySelectorAll(".watch-pill[data-wl-code]").forEach(pill => {
    pill.addEventListener("click", (e) => {
      if (e.target.closest("[data-wl-del]")) return;
      const c = pill.dataset.wlCode;
      compareHandlers.onOpenStock?.(c, true);
    });
  });
  bar.querySelectorAll("[data-wl-del]").forEach(del => {
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const c = del.dataset.wlDel;
      STATE.watchlist = STATE.watchlist.filter(it => it.code !== c);
      saveWatchlist();
      syncStockWatchButton();
      renderWatchlistBar();
    });
  });
}

export function toggleCurrentStockWatchlist() {
  const code = (STATE.stock.code || "").trim().toUpperCase();
  if (!code) return;
  const idx = STATE.watchlist.findIndex(it => it.code === code);
  if (idx >= 0) {
    STATE.watchlist.splice(idx, 1);
  } else {
    const sym = STATE.stock.valSnap?.symSnap || STATE.stock.finData?.symbol || STATE.stock.klineData?.symbol;
    const name = sym?.name || STATE.compare.names[code] || "";
    STATE.watchlist.unshift({ code, name });
    if (STATE.watchlist.length > 20) STATE.watchlist = STATE.watchlist.slice(0, 20);
  }
  saveWatchlist();
  syncStockWatchButton();
  renderWatchlistBar();
}

let peerReqSeq = 0;

function swLevelLabel(lv) {
  if (lv === "l3") return "申万三级";
  if (lv === "l1") return "申万一级";
  return "申万二级";
}

export function syncPeerPanelControls() {
  const cmp = STATE.compare;
  const lv = cmp.peerLevel || "l2";
  const sb = cmp.peerSortBy || "total_market_cap";
  document.querySelectorAll("#seg-cmp-peer-level button").forEach(b => b.classList.toggle("active", b.dataset.val === lv));
  document.querySelectorAll("#seg-cmp-peer-sort button").forEach(b => b.classList.toggle("active", b.dataset.val === sb));
  const toggleBtn = document.getElementById("btn-cmp-peers-toggle");
  if (toggleBtn) {
    toggleBtn.textContent = cmp.peerOpen ? "收起" : "展开";
    toggleBtn.setAttribute("aria-expanded", String(Boolean(cmp.peerOpen)));
  }
  const listEl = document.getElementById("cmp-peers-list");
  if (listEl) {
    listEl.classList.toggle("hidden", !cmp.peerOpen);
  }
}

export function renderIndustryPeersPanel() {
  const panel = document.getElementById("cmp-peers-panel");
  const anchorEl = document.getElementById("cmp-peers-anchor-info");
  const listEl = document.getElementById("cmp-peers-list");
  const fillBtn = document.getElementById("btn-cmp-peers-fill");
  if (!panel || !listEl) return;

  const anchorCode = (STATE.compare.peerAnchorCode || "").trim().toUpperCase();
  if (!anchorCode) {
    panel.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  panel.classList.remove("hidden");
  syncPeerPanelControls();

  const data = STATE.compare.peerData?.target?.thscode === anchorCode ? STATE.compare.peerData : null;
  const target = data?.target;
  const anchorName = target?.name || STATE.compare.names[anchorCode] || "";

  if (anchorEl) {
    if (STATE.compare.peerLoading && !data) {
      anchorEl.innerHTML = `正在查询 <strong>${esc(anchorCode)}${anchorName ? " " + esc(anchorName) : ""}</strong> 的申万2021同行…`;
    } else if (data) {
      const pathParts = [target?.sw_l1_name, target?.sw_l2_name, target?.sw_l3_name].filter(Boolean);
      const pathText = pathParts.length ? pathParts.join(" › ") : (data.industry_name || "未分类");
      const effLv = data.effective_level || STATE.compare.peerLevel || "l2";
      const reqLv = data.requested_level || STATE.compare.peerLevel || "l2";
      const fallbackBadge = effLv !== reqLv
        ? `<span class="cmp-peers-fallback-pill">${esc(swLevelLabel(reqLv))}同行不足3只，已自动扩展至${esc(swLevelLabel(effLv))}</span>`
        : "";
      const cntTxt = data.total_in_industry != null ? ` · 当前${esc(swLevelLabel(effLv))}「${esc(data.industry_name || "--")}」共 ${data.total_in_industry} 只` : "";
      anchorEl.innerHTML = `锚定 <strong>${esc(anchorCode)} ${esc(anchorName)}</strong> · ${esc(pathText)}${cntTxt}${fallbackBadge}`;
    } else {
      anchorEl.innerHTML = `锚定 <strong>${esc(anchorCode)}${anchorName ? " " + esc(anchorName) : ""}</strong> · 点击篮子标签可切换锚点`;
    }
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  if (fillBtn) {
    const remaining = Math.max(0, 10 - STATE.compare.codes.length);
    const candidates = items.filter(it => it?.thscode && !STATE.compare.codes.includes(it.thscode));
    const canAdd = Math.min(5, remaining, candidates.length);
    fillBtn.disabled = Boolean(STATE.compare.peerLoading || canAdd === 0);
    if (remaining === 0) {
      fillBtn.textContent = "篮子已满(10)";
    } else if (canAdd > 0) {
      fillBtn.textContent = `+ 补齐前${canAdd}只`;
    } else {
      fillBtn.textContent = data ? "同行已全选" : "+ 补齐前5只";
    }
  }

  if (!STATE.compare.peerOpen) return;

  if (STATE.compare.peerLoading) {
    listEl.innerHTML = `<div class="flat" style="font-size:12px;padding:12px 4px;grid-column:1 / -1;">正在拉取申万同行业公司列表…</div>`;
    return;
  }
  if (STATE.compare.peerError) {
    listEl.innerHTML = `<div class="up" style="font-size:12px;padding:12px 4px;grid-column:1 / -1;">同行业推荐加载失败：${esc(STATE.compare.peerError)}</div>`;
    return;
  }
  if (!items.length) {
    listEl.innerHTML = `<div class="flat" style="font-size:12px;padding:12px 4px;grid-column:1 / -1;">当前申万行业下暂无更多可比公司（可切换上方「申万二级」或「申万一级」扩大范围）</div>`;
    return;
  }

  listEl.innerHTML = items.map(it => {
    const c = String(it.thscode || "").toUpperCase();
    const nm = it.name || c;
    const inBasket = STATE.compare.codes.includes(c);
    const subInd = it.sw_l3_name || it.sw_l2_name || data?.industry_name || "--";
    const peStr = it.pe_ttm != null ? `${fmtNum(it.pe_ttm, 1)}x` : "--";
    const pbStr = it.pb != null ? `${fmtNum(it.pb, 2)}x` : "--";
    const roeStr = it.roe_ttm_pct != null ? `${Number(it.roe_ttm_pct).toFixed(1)}%` : "--";
    const divStr = it.div_yield_ttm != null ? `${Number(it.div_yield_ttm).toFixed(2)}%` : "--";
    return `
      <div class="peer-card${inBasket ? " in-basket" : ""}">
        <div class="peer-card-top">
          <div style="min-width:0;">
            <div class="peer-card-name">${esc(nm)}</div>
            <div class="peer-card-code">${esc(c)}</div>
          </div>
          <button type="button" class="btn-mini btn-peer-toggle ${inBasket ? "added" : ""}" data-peer-code="${esc(c)}" data-peer-name="${esc(nm)}">${inBasket ? "✓ 已在" : "+ 加入"}</button>
        </div>
        <div class="peer-card-sub" title="${esc(subInd)}">${esc(subInd)} · 市值 ${esc(fmtMoneyShort(it.total_market_cap))}</div>
        <div class="peer-card-metrics">
          <span>PE <strong>${esc(peStr)}</strong></span>
          <span>PB <strong>${esc(pbStr)}</strong></span>
          <span>ROE <strong>${esc(roeStr)}</strong></span>
          <span>股息 <strong>${esc(divStr)}</strong></span>
        </div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".btn-peer-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = btn.dataset.peerCode;
      const nm = btn.dataset.peerName || "";
      if (STATE.compare.codes.includes(c)) {
        removeCompareStock(c, true);
      } else {
        addCompareStock(c, nm, true, { updatePeerAnchor: false });
      }
    });
  });
}

export async function loadIndustryPeers(anchorCode, opts = {}) {
  const { open = true, forceFresh = false } = opts;
  const clean = String(anchorCode || "").trim().toUpperCase();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(clean)) {
    peerReqSeq++;
    STATE.compare.peerAnchorCode = "";
    STATE.compare.peerData = null;
    STATE.compare.peerError = "";
    STATE.compare.peerLoading = false;
    renderCompareBasketTags();
    renderIndustryPeersPanel();
    return null;
  }

  STATE.compare.peerAnchorCode = clean;
  if (open) STATE.compare.peerOpen = true;

  const level = STATE.compare.peerLevel || "l2";
  const sortBy = STATE.compare.peerSortBy || "total_market_cap";
  const cacheKey = `${clean}|${level}|${sortBy}`;
  renderCompareBasketTags();

  if (!forceFresh && STATE.compare.peerCache[cacheKey]) {
    STATE.compare.peerData = STATE.compare.peerCache[cacheKey];
    STATE.compare.peerError = "";
    STATE.compare.peerLoading = false;
    renderIndustryPeersPanel();
    return STATE.compare.peerData;
  }

  const seq = ++peerReqSeq;
  STATE.compare.peerLoading = true;
  STATE.compare.peerError = "";
  renderIndustryPeersPanel();

  try {
    const data = await quantFetch(
      `/api/stocks/${encodeURIComponent(clean)}/peers`,
      { level, sort_by: sortBy, limit: 12, include_self: "false" },
      forceFresh ? { fresh: true } : undefined
    );
    if (seq !== peerReqSeq) return null;
    STATE.compare.peerLoading = false;
    STATE.compare.peerError = "";
    STATE.compare.peerData = data;
    STATE.compare.peerCache[cacheKey] = data;
    if (data?.target?.thscode && data.target.name) {
      STATE.compare.names[data.target.thscode] = data.target.name;
    }
    if (Array.isArray(data?.items)) {
      for (const it of data.items) {
        if (it?.thscode && it?.name) {
          STATE.compare.names[String(it.thscode).toUpperCase()] = it.name;
        }
      }
    }
    renderCompareBasketTags();
    renderIndustryPeersPanel();
    return data;
  } catch (err) {
    if (seq !== peerReqSeq) return null;
    STATE.compare.peerLoading = false;
    STATE.compare.peerError = err?.message || "请求失败";
    STATE.compare.peerData = null;
    renderIndustryPeersPanel();
    return null;
  }
}

export function addTopRecommendedPeers(maxAdd = 5) {
  const anchorCode = STATE.compare.peerAnchorCode;
  const data = STATE.compare.peerData?.target?.thscode === anchorCode ? STATE.compare.peerData : null;
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return 0;

  let added = 0;
  for (const it of items) {
    if (added >= maxAdd || STATE.compare.codes.length >= 10) break;
    const c = String(it?.thscode || "").trim().toUpperCase();
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(c) || STATE.compare.codes.includes(c)) continue;
    if (it.name) STATE.compare.names[c] = it.name;
    STATE.compare.codes.push(c);
    added++;
  }

  if (added > 0) {
    STATE.compare.dirty = true;
    saveCompareList();
    renderCompareBasketTags();
    renderIndustryPeersPanel();
    if (STATE.activeTab === "compare") {
      loadComparePeers(false);
    }
  }
  return added;
}

export function addCompareStock(code, name = "", reloadIfActive = true, opts = {}) {
  const { updatePeerAnchor = true } = opts;
  const clean = String(code || "").trim().toUpperCase();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(clean)) return false;
  if (name) STATE.compare.names[clean] = name;
  let listChanged = false;
  if (!STATE.compare.codes.includes(clean)) {
    if (STATE.compare.codes.length >= 10) {
      STATE.compare.codes.shift();
    }
    STATE.compare.codes.push(clean);
    STATE.compare.dirty = true;
    saveCompareList();
    listChanged = true;
  }
  if (updatePeerAnchor) {
    STATE.compare.peerAnchorCode = clean;
  }
  renderCompareBasketTags();
  if (reloadIfActive && STATE.activeTab === "compare") {
    if (listChanged) loadComparePeers(false);
    if (updatePeerAnchor) {
      loadIndustryPeers(clean, { open: true });
    } else {
      renderIndustryPeersPanel();
    }
  } else if (STATE.activeTab === "compare") {
    renderIndustryPeersPanel();
  }
  return true;
}

export function removeCompareStock(code, rerender = true) {
  const clean = String(code || "").trim().toUpperCase();
  const wasAnchor = clean === STATE.compare.peerAnchorCode;
  STATE.compare.codes = STATE.compare.codes.filter(c => c !== clean);
  delete STATE.compare.errors[clean];
  if (wasAnchor) {
    STATE.compare.peerAnchorCode = STATE.compare.codes[0] || "";
  }
  saveCompareList();
  renderCompareBasketTags();
  if (rerender && STATE.activeTab === "compare") {
    renderCompareResults();
    if (wasAnchor) {
      loadIndustryPeers(STATE.compare.peerAnchorCode, { open: STATE.compare.peerOpen });
    } else {
      renderIndustryPeersPanel();
    }
  }
}

export function applyComparePreset(groupKey) {
  document.querySelectorAll(".cmp-preset").forEach(b => b.classList.toggle("active", b.dataset.group === groupKey));
  if (groupKey === "watchlist") {
    const items = STATE.watchlist.slice(0, 10);
    if (!items.length) {
      const statusEl = document.getElementById("cmp-status");
      if (statusEl) statusEl.textContent = "自选池为空，请先在个股看板收藏标的";
      return;
    }
    STATE.compare.codes = items.map(it => {
      if (it.name) STATE.compare.names[it.code] = it.name;
      return it.code;
    });
  } else {
    const grp = PEER_PRESETS[groupKey];
    if (!grp) return;
    STATE.compare.codes = grp.items.map(it => {
      STATE.compare.names[it.code] = it.name;
      return it.code;
    });
  }
  STATE.compare.dirty = true;
  saveCompareList();
  renderCompareBasketTags();
  loadComparePeers(false);
  loadIndustryPeers(STATE.compare.codes[0] || "", { open: true });
}

export function renderCompareBasketTags() {
  const box = document.getElementById("cmp-basket-tags");
  if (!box) return;
  if (!STATE.compare.codes.length) {
    box.innerHTML = `<span class="flat" style="font-size:12px;">对比篮子为空，请通过上方搜索或点击 preset 导入同业标的</span>`;
    return;
  }
  const anchorCode = (STATE.compare.peerAnchorCode || "").trim().toUpperCase();
  box.innerHTML = `<span class="ctrl-label">对比标的 (${STATE.compare.codes.length}/10，点击切换同业推荐):</span>` + STATE.compare.codes.map(c => {
    const cached = STATE.compare.cache[c];
    const nm = cached?.snap?.name || STATE.compare.names[c] || "";
    const err = STATE.compare.errors[c];
    const lbl = nm ? `${c} ${nm}` : c;
    const errMark = err ? ` <span class="up" title="${esc(err)}">(失败)</span>` : "";
    const isAnchor = c === anchorCode ? " is-anchor" : "";
    return `<span class="cmp-tag${isAnchor}" data-cmp-tag="${esc(c)}" title="点击以该标的为锚点推荐申万同行业公司"><span>${esc(lbl)}${errMark}</span><span class="x-del" data-cmp-del="${esc(c)}" title="移除">×</span></span>`;
  }).join("");

  box.querySelectorAll(".cmp-tag[data-cmp-tag]").forEach(tag => {
    tag.addEventListener("click", (e) => {
      if (e.target.closest("[data-cmp-del]")) return;
      loadIndustryPeers(tag.dataset.cmpTag, { open: true });
    });
  });
  box.querySelectorAll("[data-cmp-del]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      removeCompareStock(el.dataset.cmpDel, true);
    });
  });
}

export const COMPARE_RESEARCH_MODES = {
  dividend: {
    label: "红利模式",
    brief: "吃现金回报 + 防缩水断供 + 赚提息弹性（风控外环自动切换红利排雷口径）",
    defaultView: "div_return_stab",
    views: [
      { val: "div_return_stab", label: "回报 vs 稳定性" },
      { val: "div_elast_cov", label: "弹性 vs 持续性" },
      { val: "div_return_risk", label: "回报 vs 低波回撤" }
    ]
  },
  quality: {
    label: "白马质量",
    brief: "高ROIC(去OPM) + 长期复利增速g与再投资效率ROIIC(区分复利白马/现金奶牛) + 真现金回款",
    defaultView: "quality_roic_val",
    views: [
      { val: "quality_roic_val", label: "ROIC vs 估值" },
      { val: "quality_compound_roiic", label: "增速 vs 再投资" },
      { val: "long_term_roe_pb", label: "复利回报 vs 稳健" },
      { val: "quality_roic_cash", label: "ROIC vs 含金量" }
    ]
  },
  cycle: {
    label: "周期右侧",
    brief: "左侧看PB/EV-EBIT赔率 + 右侧看毛利/ROE拐点 + 供给缩表与抗寒（风控外环自动切换周期排雷口径）",
    defaultView: "cycle_odds_inflection",
    views: [
      { val: "cycle_odds_inflection", label: "赔率 vs 景气拐点" },
      { val: "cycle_ev_ebit_pos", label: "EV/EBIT 周期水位" },
      { val: "cycle_supply_safety", label: "供给缩表 vs 抗寒" }
    ]
  },
  growth: {
    label: "成长模式",
    brief: "高增速消化估值(PEG/PSG) + 二阶加速与效率 + 自我造血防稀释（风控外环自动切换成长排雷口径）",
    defaultView: "growth_g_pe",
    views: [
      { val: "growth_g_pe", label: "成长性价比 PEG/PSG" },
      { val: "growth_accel_eff", label: "加速度 vs 投入效率" },
      { val: "growth_cash_self", label: "增速 vs 造血验证" }
    ]
  }
};

export function renderScatterSubTabs() {
  const cmp = STATE.compare;
  const rMode = COMPARE_RESEARCH_MODES[cmp.researchMode] ? cmp.researchMode : "dividend";
  const cfg = COMPARE_RESEARCH_MODES[rMode];
  const validVals = cfg.views.map(v => v.val);
  if (!validVals.includes(cmp.scatterMode)) {
    cmp.scatterMode = cfg.defaultView;
  }

  const seg = document.getElementById("seg-cmp-scatter");
  if (seg) {
    if (seg.dataset.renderedMode !== rMode || seg.querySelectorAll("button").length !== cfg.views.length) {
      seg.innerHTML = cfg.views.map(v =>
        `<button type="button" data-val="${esc(v.val)}"${v.val === cmp.scatterMode ? ' class="active"' : ""}>${esc(v.label)}</button>`
      ).join("");
      seg.dataset.renderedMode = rMode;
    } else {
      seg.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.val === cmp.scatterMode));
    }
  }
}

export function syncCompareControls() {
  const cmp = STATE.compare;
  const rMode = COMPARE_RESEARCH_MODES[cmp.researchMode] ? cmp.researchMode : "dividend";
  cmp.researchMode = rMode;
  renderScatterSubTabs();

  document.querySelectorAll("#seg-cmp-research-mode button").forEach(b => b.classList.toggle("active", b.dataset.val === rMode));
  const briefEl = document.getElementById("cmp-mode-brief");
  if (briefEl) briefEl.textContent = COMPARE_RESEARCH_MODES[rMode].brief;

  document.querySelectorAll("#seg-cmp-r-mode button").forEach(b => b.classList.toggle("active", b.dataset.val === cmp.rMode));
  document.querySelectorAll("#seg-cmp-scenario button").forEach(b => b.classList.toggle("active", b.dataset.val === cmp.scenario));
  document.querySelectorAll("#seg-cmp-horizon button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.horizon || "ttm")));

  const elWrap = document.getElementById("wrap-cmp-div-elasticity");
  if (elWrap) elWrap.classList.toggle("hidden", cmp.scatterMode !== "div_elast_cov");
  document.querySelectorAll("#seg-cmp-div-elasticity button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.divElasticityMode || "dps_cagr")));

  const rkWrap = document.getElementById("wrap-cmp-div-risk");
  if (rkWrap) rkWrap.classList.toggle("hidden", cmp.scatterMode !== "div_return_risk");
  document.querySelectorAll("#seg-cmp-div-risk button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.divRiskAxis || "max_dd")));

  const qvWrap = document.getElementById("wrap-cmp-qual-val");
  if (qvWrap) qvWrap.classList.toggle("hidden", cmp.scatterMode !== "quality_roic_val");
  document.querySelectorAll("#seg-cmp-qual-val button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.qualValAxis || "pe_norm")));

  const qgWrap = document.getElementById("wrap-cmp-qual-grow");
  if (qgWrap) qgWrap.classList.toggle("hidden", cmp.scatterMode !== "quality_compound_roiic");
  document.querySelectorAll("#seg-cmp-qual-grow button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.qualGrowAxis || "g_cagr")));

  const qcompWrap = document.getElementById("wrap-cmp-qual-comp");
  if (qcompWrap) qcompWrap.classList.toggle("hidden", cmp.scatterMode !== "long_term_roe_pb");
  document.querySelectorAll("#seg-cmp-qual-comp button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.qualCompAxis || "bogle_ret")));

  const qcWrap = document.getElementById("wrap-cmp-qual-cash");
  if (qcWrap) qcWrap.classList.toggle("hidden", cmp.scatterMode !== "quality_roic_cash");
  document.querySelectorAll("#seg-cmp-qual-cash button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.qualCashAxis || "cash_conv")));

  const coWrap = document.getElementById("wrap-cmp-cyc-odds");
  if (coWrap) coWrap.classList.toggle("hidden", cmp.scatterMode !== "cycle_odds_inflection");
  document.querySelectorAll("#seg-cmp-cyc-odds button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.cycleOddsAxis || "pb_cheap")));

  const ciWrap = document.getElementById("wrap-cmp-cyc-inflect");
  if (ciWrap) ciWrap.classList.toggle("hidden", cmp.scatterMode !== "cycle_odds_inflection");
  document.querySelectorAll("#seg-cmp-cyc-inflect button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.cycleInflectAxis || "gm_yoy")));

  const csWrap = document.getElementById("wrap-cmp-cyc-safety");
  if (csWrap) csWrap.classList.toggle("hidden", cmp.scatterMode !== "cycle_supply_safety");
  document.querySelectorAll("#seg-cmp-cyc-safety button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.cycleSafetyAxis || "int_cov")));

  const gvWrap = document.getElementById("wrap-cmp-gr-val");
  if (gvWrap) gvWrap.classList.toggle("hidden", cmp.scatterMode !== "growth_g_pe");
  document.querySelectorAll("#seg-cmp-gr-val button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.growthValAxis || "peg")));

  const geWrap = document.getElementById("wrap-cmp-gr-eff");
  if (geWrap) geWrap.classList.toggle("hidden", cmp.scatterMode !== "growth_accel_eff");
  document.querySelectorAll("#seg-cmp-gr-eff button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.growthEffAxis || "roic")));

  const gcWrap = document.getElementById("wrap-cmp-gr-cash");
  if (gcWrap) gcWrap.classList.toggle("hidden", cmp.scatterMode !== "growth_cash_self");
  document.querySelectorAll("#seg-cmp-gr-cash button").forEach(b => b.classList.toggle("active", b.dataset.val === (cmp.growthCashAxis || "cash_conv")));

  const goodLbl = document.getElementById("cmp-legend-ring-good");
  const badLbl = document.getElementById("cmp-legend-ring-bad");
  if (goodLbl && badLbl) {
    if (rMode === "dividend") {
      goodLbl.textContent = "稳健真红利";
      badLbl.textContent = "红利排雷(覆盖<1x/不稳/大回撤)";
    } else if (rMode === "quality") {
      goodLbl.textContent = "核心白马";
      badLbl.textContent = "白马排雷(净现<0.7x/高应计/高有息债/高波动)";
    } else if (rMode === "cycle") {
      goodLbl.textContent = "右侧拐点";
      badLbl.textContent = "周期排雷(高负债扩产/顶峰/低保障)";
    } else if (rMode === "growth") {
      goodLbl.textContent = "戴维斯双击";
      badLbl.textContent = "成长排雷(高PEG/失速/烧钱稀释)";
    } else {
      goodLbl.textContent = "低波稳健";
      badLbl.textContent = "高负债/高回撤预警";
    }
  }
  const ncBtn = document.getElementById("btn-cmp-netcash");
  if (ncBtn) {
    ncBtn.classList.toggle("active", cmp.netCashAdj);
    ncBtn.setAttribute("aria-pressed", String(cmp.netCashAdj));
    ncBtn.textContent = cmp.netCashAdj ? "DCF含净现金: 开" : "DCF含净现金: 关";
  }
  const rimBtn = document.getElementById("btn-cmp-rim-below");
  if (rimBtn) {
    rimBtn.classList.toggle("active", cmp.rimAllowBelowBook);
    rimBtn.setAttribute("aria-pressed", String(cmp.rimAllowBelowBook));
    rimBtn.textContent = cmp.rimAllowBelowBook ? "RIM允许破净: 开" : "RIM允许破净: 关";
  }
  const arrowBtn = document.getElementById("btn-cmp-arrows");
  if (arrowBtn) {
    arrowBtn.classList.toggle("active", Boolean(cmp.showGrowthArrows));
    arrowBtn.setAttribute("aria-pressed", String(Boolean(cmp.showGrowthArrows)));
    arrowBtn.textContent = cmp.showGrowthArrows ? "增速拖尾箭头: 开" : "增速拖尾箭头: 关";
  }
  const riskBtn = document.getElementById("btn-cmp-risk-rings");
  if (riskBtn) {
    riskBtn.classList.toggle("active", Boolean(cmp.showRiskRings));
    riskBtn.setAttribute("aria-pressed", String(Boolean(cmp.showRiskRings)));
    riskBtn.textContent = cmp.showRiskRings ? "风控外环: 开" : "风控外环: 关";
  }
}

export async function fetchOneComparePeer(code, forceFresh = false) {
  const enc = encodeURIComponent(code);
  const [fin, kNone, kFwd, shareData] = await Promise.all([
    forceFresh ? quantFetch(`/api/stocks/${enc}/financials`, { limit: 40 }, { fresh: true }) : fetchFinancialsChecked(code, 40),
    quantFetch(`/api/stocks/${enc}/kline`, { adjust: "none", limit: 1250 }, forceFresh ? { fresh: true } : undefined),
    quantFetch(`/api/stocks/${enc}/kline`, { adjust: "forward", limit: 750 }, forceFresh ? { fresh: true } : undefined),
    fetchSharesSafe(code, 80, forceFresh)
  ]);
  const snap = evaluateStockValuation({
    finData: fin,
    kUnadj: kNone,
    kAdj: kFwd,
    shareData,
    valWindow: 1250,
    valAlignMode: STATE.stock.valAlignMode || "pit",
    dcfRMode: STATE.compare.rMode
  });
  if (snap.name) STATE.compare.names[code] = snap.name;
  STATE.compare.cache[code] = { fin, kNone, kFwd, shareData, snap };
  delete STATE.compare.errors[code];
}

export async function loadComparePeers(forceReload = false) {
  const codes = [...STATE.compare.codes];
  const statusEl = document.getElementById("cmp-status");
  if (!codes.length) {
    STATE.compare.loaded = true;
    STATE.compare.dirty = false;
    if (statusEl) statusEl.textContent = "篮子为空";
    renderCompareResults();
    return;
  }

  const needFetch = forceReload ? codes : codes.filter(c => !STATE.compare.cache[c]);
  if (!needFetch.length) {
    STATE.compare.loaded = true;
    STATE.compare.dirty = false;
    if (statusEl) statusEl.textContent = `已就绪 · ${codes.length} 只标的（本地内存复用）`;
    renderCompareResults();
    return;
  }

  STATE.compare.loading = true;
  let done = 0;
  if (statusEl) statusEl.textContent = `正在并发拉取并估值计算 (0 / ${needFetch.length})…`;

  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, needFetch.length) }, async () => {
    while (cursor < needFetch.length) {
      const idx = cursor++;
      const c = needFetch[idx];
      try {
        await fetchOneComparePeer(c, forceReload);
      } catch (err) {
        STATE.compare.errors[c] = err?.message || "请求失败";
      } finally {
        done++;
        if (statusEl) statusEl.textContent = `测算进度 ${done} / ${needFetch.length}…`;
      }
    }
  });

  await Promise.all(workers);
  STATE.compare.loading = false;
  STATE.compare.loaded = true;
  STATE.compare.dirty = false;

  const okCount = codes.filter(c => STATE.compare.cache[c]?.snap).length;
  const errCount = codes.length - okCount;
  if (statusEl) {
    statusEl.textContent = errCount > 0
      ? `已计算 ${okCount} 只 · ${errCount} 只拉取失败`
      : `对比已就绪 · 共 ${okCount} 只标的`;
  }
  renderCompareBasketTags();
  renderCompareResults();
}

export function getCompareRows() {
  const opts = {
    rMode: STATE.compare.rMode,
    scenario: STATE.compare.scenario,
    netCashAdj: STATE.compare.netCashAdj,
    rimAllowBelowBook: STATE.compare.rimAllowBelowBook
  };
  const rows = [];
  for (const c of STATE.compare.codes) {
    const cached = STATE.compare.cache[c];
    if (!cached?.snap) continue;
    rows.push(computePeerMetrics(cached.snap, opts));
  }
  return rows;
}

export function niceAxisRange(vals, forceZeroMin = false, clampSpan = null) {
  const clean = vals.filter(v => v !== null && v !== undefined && Number.isFinite(v));
  if (!clean.length) return [0, 10];
  const rawMin = Math.min(...clean);
  let lo = rawMin;
  let hi = Math.max(...clean);
  let span = hi - lo;
  if (span < 1e-6) {
    const d = Math.max(1, Math.abs(lo) * 0.25);
    lo -= d;
    hi += d;
    span = hi - lo;
  }
  lo -= span * 0.14;
  hi += span * 0.16;
  if (forceZeroMin && rawMin >= 0) lo = Math.max(0, lo);
  if (clampSpan) {
    lo = Math.max(clampSpan[0], lo);
    hi = Math.min(clampSpan[1], hi);
  }
  if (hi - lo < 1e-6) hi = lo + 1;
  return [lo, hi];
}

export function makeTicks(lo, hi, targetCount = 5) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const rough = span / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step = mag;
  if (norm >= 5) step = 5 * mag;
  else if (norm >= 2) step = 2 * mag;
  const first = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = first; v <= hi + step * 1e-6; v += step) {
    out.push(+v.toFixed(6));
  }
  return out.length ? out : [lo, hi];
}

export function renderCompareScatter(rows) {
  const wrap = document.getElementById("cmp-scatter-wrap");
  const svg = document.getElementById("cmp-scatter-svg");
  const tt = document.getElementById("cmp-scatter-tooltip");
  if (!wrap || !svg) return;
  if (tt) tt.style.display = "none";

  const mode = STATE.compare.scatterMode || "div_return_stab";
  const isDivMode = STATE.compare.researchMode === "dividend";
  const isQualMode = STATE.compare.researchMode === "quality";
  const isCycleMode = STATE.compare.researchMode === "cycle";
  const isGrowthMode = STATE.compare.researchMode === "growth";
  const hz = STATE.compare.horizon || "ttm";
  const elMode = STATE.compare.divElasticityMode || "dps_cagr";
  const rkMode = STATE.compare.divRiskAxis || "max_dd";
  const qvMode = STATE.compare.qualValAxis || "pe_norm";
  const qGrow = STATE.compare.qualGrowAxis || "g_cagr";
  const qComp = STATE.compare.qualCompAxis || "bogle_ret";
  const qcMode = STATE.compare.qualCashAxis || "cash_conv";
  const cycOdds = STATE.compare.cycleOddsAxis || "pb_cheap";
  const cycInflect = STATE.compare.cycleInflectAxis || "gm_yoy";
  const cycSafety = STATE.compare.cycleSafetyAxis || "int_cov";
  const grVal = STATE.compare.growthValAxis || "peg";
  const grEff = STATE.compare.growthEffAxis || "roic";
  const grCash = STATE.compare.growthCashAxis || "cash_conv";
  const hzLabel = hz === "5y" ? "5年均" : (hz === "3y" ? "3年均" : "TTM");
  const ltTag = hz === "5y" ? "5年" : "3年";
  const allFin = rows.length > 0 && rows.every(r => r.isFinancial);
  const configs = {
    growth_g_pe: grVal === "psg"
      ? {
          xLabel: "3年营收复合增速 → 近1Y营收增速 (%)",
          yLabel: "市销率 PS_TTM (倍 · 覆盖高研发/微利成长)",
          subtitle: "横轴 3 年营收复合增速（拖尾箭头指向近 1Y 营收增速） · 纵轴当前市销率 PS_TTM · 射线为 PSG = 0.20x / 0.35x 前沿，右下兼顾高增长与低估值",
          badge: "占优区：高营收增速 · 低PSG / 箭头向右加速",
          badgePos: "br",
          forceZeroX: false,
          forceZeroY: true,
          xFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          yFmt: v => `${v.toFixed(1)}x`,
          getX: r => (r.revCagr3y ?? r.revYoy1y),
          getX2: r => r.revYoy1y,
          getY: r => r.psTtm
        }
      : {
          xLabel: hz === "3y" ? "3年净利复合增速 → 近1Y边际增速 (%)" : "5年净利基准增速 g₁ → 近1Y边际增速 (%)",
          yLabel: hz === "5y" ? "5年均利 PE (倍 · 越低越便宜)" : (hz === "3y" ? "3年均利 PE (倍 · 越低越便宜)" : "市盈率 PE_TTM (倍 · 越低越便宜)"),
          subtitle: `横轴${hz === "3y" ? "近 3 年净利复合增速" : " 5 年净利基准增速 g₁"}（拖尾箭头指向近 1Y 增速） · 纵轴${hz === "ttm" ? "当前 PE_TTM" : ltTag + "均利 PE"} · 绿射线 PEG = 1.0x 为成长黄金前沿，右下高增速低估值占优`,
          badge: "占优区：高增速 · 低PEG / 箭头向右加速",
          badgePos: "br",
          forceZeroX: false,
          forceZeroY: true,
          xFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          yFmt: v => `${v.toFixed(1)}x`,
          getX: r => (hz === "3y" ? (r.npCagr3y ?? r.g1Base) : (r.g1Base ?? r.npCagr3y)),
          getX2: r => r.npYoy1y,
          getY: r => (hz === "5y" ? (r.pe5yNorm ?? r.peTtm) : (hz === "3y" ? (r.pe3yNorm ?? r.peTtm) : r.peTtm))
        },
    growth_accel_eff: {
      xLabel: "净利增速二阶加速度 1Y−5Y (pp · >0为加速扩张)",
      yLabel: grEff === "rd"
        ? "研发费用率 R&D / 营收 (% · 技术投入强度)"
        : (grEff === "gm"
          ? "TTM 毛利率 (% · 产品定价权/护城河)"
          : `${hz === "3y" ? "3年" : "5年"} ROIC 均值 (% · 金融切ROE)`),
      subtitle: `横轴盈利增速二阶加速度（1Y−5Y，X=0 为加速/放缓分界） · 纵轴${grEff === "rd" ? "研发费用占营收比" : (grEff === "gm" ? "TTM 综合毛利率" : `${hz === "3y" ? "3" : "5"} 年平均 ROIC`)} · 绿斜线平衡加速势能与投入效率`,
      badge: grEff === "rd"
        ? "占优区：盈利加速 · 高研发投入强度"
        : (grEff === "gm" ? "占优区：盈利加速 · 高毛利定价权" : "占优区：盈利加速 · 高ROIC复利"),
      badgePos: "tr",
      forceZeroX: false,
      forceZeroY: grEff === "rd",
      xFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`,
      yFmt: v => `${v.toFixed(1)}%`,
      getX: r => r.npAccelPp,
      getY: r => (grEff === "rd"
        ? r.rdRatioPct
        : (grEff === "gm" ? r.ttmGmPct : (hz === "3y" ? (r.roic3yMean ?? r.roic5yMean) : (r.roic5yMean ?? r.roic3yMean))))
    },
    growth_cash_self: {
      xLabel: hz === "3y" ? "3年净利复合增速 (%)" : "近1年 TTM 净利同比增速 (%)",
      yLabel: grCash === "fcf_margin"
        ? "3年自由现金流利润率 FCF / 营收 (% · >0自我造血)"
        : "3年净现比 OCF / 归母净利 (倍 · ≥0.8x 真造血)",
      subtitle: `横轴${hz === "3y" ? "近 3 年净利复合增速" : "近 1 年净利同比增速"} · 纵轴${grCash === "fcf_margin" ? "3 年自由现金流利润率" : "3 年盈利现金含量"} · 红线下方配合净稀释预警烧钱续命的伪成长`,
      badge: grCash === "fcf_margin" ? "占优区：高增速 · 正FCF真造血" : "占优区：高增速 · 高净现比无水分",
      badgePos: "tr",
      forceZeroX: false,
      forceZeroY: false,
      xFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
      yFmt: v => (grCash === "fcf_margin" ? `${v.toFixed(1)}%` : `${v.toFixed(2)}x`),
      getX: r => (hz === "3y" ? (r.npCagr3y ?? r.npYoy1y) : (r.npYoy1y ?? r.npCagr3y)),
      getY: r => (grCash === "fcf_margin" ? (r.fcfMargin3y ?? r.fcfMarginTtm) : (r.cashConv3y ?? r.cashConv5y))
    },
    cycle_odds_inflection: {
      xLabel: cycOdds === "ebit_yield"
        ? `${hz === "3y" ? "3年" : "5年"}均 EBIT/EV 收益率 (% · 越右越便宜)`
        : "近5年 PB 历史便宜度 (% · 100-PB分位 · 越右越便宜)",
      yLabel: cycInflect === "roe_delta"
        ? "ΔROE 边际差 TTM-3Y均 (pp · >0为景气上行)"
        : "单季毛利率同比 ΔGM (pp · >0为右侧改善)",
      subtitle: cycOdds === "ebit_yield"
        ? `横轴 ${hz === "3y" ? "3" : "5"} 年均 EBIT/EV（非金融按有息/总负债近似 EV） · 纵轴${cycInflect === "roe_delta" ? "ΔROE 边际差" : "单季毛利率同比 ΔGM"} · Y=0 为景气拐点线，右上兼顾赔率与右侧拐头`
        : `横轴近 5 年 PB 历史便宜度(100-PB分位) · 纵轴${cycInflect === "roe_delta" ? "ΔROE 边际差" : "单季毛利率同比 ΔGM"} · Y=0 为景气拐点线，斜线右上兼顾底部赔率与景气反转`,
      badge: "占优区：高赔率 · 景气右侧拐头",
      badgePos: "tr",
      forceZeroX: false,
      ...(cycOdds === "ebit_yield" ? {} : { clampX: [0, 100] }),
      forceZeroY: false,
      xFmt: v => `${v.toFixed(cycOdds === "ebit_yield" ? 1 : 0)}%`,
      yFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`,
      getX: r => (cycOdds === "ebit_yield"
        ? (hz === "3y" ? (r.ebitYield3y ?? r.ebitYield5y ?? r.ebitYieldTtm) : (r.ebitYield5y ?? r.ebitYield3y ?? r.ebitYieldTtm))
        : r.pbCheapness5y),
      getY: r => (cycInflect === "roe_delta" ? r.deltaRoeMarginPp : r.qGmYoyPp)
    },
    cycle_ev_ebit_pos: {
      xLabel: `${hz === "3y" ? "3年" : "5年"}均化 EV/EBIT (倍 · 越左越便宜 · 非金融)`,
      yLabel: "盈利周期水位 (TTM EBIT ÷ 均化EBIT)",
      subtitle: `横轴 ${hz === "3y" ? "3" : "5"} 年均化 EV/EBIT（缺有息债务细项时按总负债近似计算，金融股免算） · 纵轴当期盈利相对跨周期中枢倍数 · Y=1.0x 为中枢，>1.5x 防顶部低PE接盘，左下为低估低位区`,
      badge: "占优区：低均化EV/EBIT · 盈利低于顶峰",
      badgePos: "bl",
      forceZeroX: true,
      forceZeroY: false,
      xFmt: v => `${v.toFixed(1)}x`,
      yFmt: v => `${v.toFixed(2)}x`,
      getX: r => (hz === "3y" ? (r.evToEbit3y ?? r.evToEbit5y ?? r.evToEbitTtm) : (r.evToEbit5y ?? r.evToEbit3y ?? r.evToEbitTtm)),
      getY: r => r.ebitCyclePos
    },
    cycle_supply_safety: {
      xLabel: "资本开支强度 CapEx / TTM 营收 (% · 越左扩产越克制)",
      yLabel: cycSafety === "cash_debt" ? "货币资金 / 总负债 (% · 越高越抗寒)" : "利息保障倍数 EBIT / 利息 (倍 · 越高越安全)",
      subtitle: `横轴资本开支占营收比（低值代表供给克制/停止盲目扩产） · 纵轴${cycSafety === "cash_debt" ? "货币资金对总负债覆盖率" : "EBIT 对利息费用保障倍数"} · 左上占优，红线下方为过冬脆弱警报区`,
      badge: cycSafety === "cash_debt" ? "占优区：低CapEx缩表 · 高现金/负债" : "占优区：低CapEx缩表 · 高利息保障",
      badgePos: "tl",
      forceZeroX: true,
      forceZeroY: cycSafety === "cash_debt",
      xFmt: v => `${v.toFixed(1)}%`,
      yFmt: v => (cycSafety === "cash_debt" ? `${v.toFixed(0)}%` : `${v.toFixed(1)}x`),
      getX: r => r.capexToRevPct,
      getY: r => (cycSafety === "cash_debt" ? r.cashToDebtPct : r.interestCoverage)
    },
    quality_roic_val: qvMode === "pb"
      ? {
          xLabel: hz === "ttm" ? "TTM ROE (%)" : `${ltTag}平均 ROE (%)`,
          yLabel: "当前市净率 PB (倍)",
          subtitle: `横轴 ${hz === "ttm" ? "TTM ROE" : ltTag + "平均 ROE"} · 纵轴当前 PB · 斜虚线为 PB = ROE / 同业平均折现率 r 合理估值前沿 · 右下角占优`,
          badge: `占优区：高${hz === "ttm" ? "" : ltTag}ROE · 低PB`,
          badgePos: "br",
          forceZeroX: false,
          forceZeroY: true,
          xFmt: v => `${v.toFixed(1)}%`,
          yFmt: v => `${v.toFixed(2)}x`,
          getX: r => (hz === "5y" ? r.roeMean5y : (hz === "3y" ? r.roeMean3y : r.roeTtm)),
          getY: r => r.pb
        }
      : {
          xLabel: hz === "3y"
            ? (allFin ? "3年 ROE 均值 (% · 金融)" : "3年 ROIC 均值 (% · 剔除杠杆)")
            : (allFin ? "5年 ROE 均值 (% · 金融)" : "5年 ROIC 均值 (% · 剔除杠杆)"),
          yLabel: hz === "ttm" ? "市盈率 PE_TTM (倍 · 越低越便宜)" : `${ltTag}均利 PE (倍 · 越低越便宜)`,
          subtitle: `横轴 ${hz === "3y" ? "3" : "5"} 年平均资本回报 ${allFin ? "ROE" : "ROIC"} · 纵轴${hz === "ttm" ? "当前 PE_TTM" : ltTag + "均利 PE"} · 斜射线为神奇公式前沿 (PE = 1.0×ROIC)，右下兼得高回报与低估值`,
          badge: "占优区：高ROIC · 低均利PE",
          badgePos: "br",
          forceZeroX: false,
          forceZeroY: true,
          xFmt: v => `${v.toFixed(1)}%`,
          yFmt: v => `${v.toFixed(1)}x`,
          getX: r => (hz === "3y" ? r.roic3yMean : (r.roic5yMean ?? r.roic3yMean)),
          getY: r => (hz === "5y" ? r.pe5yNorm : (hz === "3y" ? r.pe3yNorm : r.peTtm))
        },
    quality_roic_cash: qcMode === "ar_ratio"
      ? {
          xLabel: hz === "3y"
            ? (allFin ? "3年 ROE 均值 (% · 金融)" : "3年 ROIC 均值 (% · 剔除杠杆)")
            : (allFin ? "5年 ROE 均值 (% · 金融)" : "5年 ROIC 均值 (% · 剔除杠杆)"),
          yLabel: "应收账款 / TTM 营收 (% · 越低回款越真)",
          subtitle: `横轴 ${hz === "3y" ? "3" : "5"} 年平均 ROIC · 纵轴应收账款占营收比 · 斜射线下方占优，Y=35% 以上防渠道压货/回款恶化风险`,
          badge: "占优区：高ROIC · 低应收占比",
          badgePos: "br",
          forceZeroX: false,
          forceZeroY: true,
          xFmt: v => `${v.toFixed(1)}%`,
          yFmt: v => `${v.toFixed(1)}%`,
          getX: r => (hz === "3y" ? r.roic3yMean : (r.roic5yMean ?? r.roic3yMean)),
          getY: r => r.arToRevPct
        }
      : {
          xLabel: hz === "3y"
            ? (allFin ? "3年 ROE 均值 (% · 金融)" : "3年 ROIC 均值 (% · 剔除杠杆)")
            : (allFin ? "5年 ROE 均值 (% · 金融)" : "5年 ROIC 均值 (% · 剔除杠杆)"),
          yLabel: `${hz === "3y" ? "3年" : "5年"}盈利现金含量 OCF/归母净利 (倍)`,
          subtitle: `横轴 ${hz === "3y" ? "3" : "5"} 年平均 ROIC · 纵轴 ${hz === "3y" ? "3" : "5"} 年净现比 · 绿斜线平衡资本效率与现金含金量，Y=0.70x 以下为纸面富贵排雷红线`,
          badge: "占优区：高ROIC · 高盈利现金含量",
          badgePos: "tr",
          forceZeroX: false,
          forceZeroY: false,
          xFmt: v => `${v.toFixed(1)}%`,
          yFmt: v => `${v.toFixed(2)}x`,
          getX: r => (hz === "3y" ? r.roic3yMean : (r.roic5yMean ?? r.roic3yMean)),
          getY: r => (hz === "3y" ? (r.cashConv3y ?? r.cashConv5y) : (r.cashConv5y ?? r.cashConv3y))
        },
    div_return_stab: {
      xLabel: "综合股东回报率 (% · 股息+净回购)",
      yLabel: "分红稳定性评分 (0~100 · 连分/低CV/无缩水)",
      subtitle: "横轴综合股东回报率（现金股息+历史股本净回购） · 纵轴分红稳定性评分 · 绿斜线(稳健+10×回报≥115)平衡收益与确定性，Y=50分以下为红利陷阱红线",
      badge: "占优区：高股东回报 · 高稳定性",
      badgePos: "tr",
      forceZeroX: true,
      clampY: [0, 100],
      xFmt: v => `${v.toFixed(2)}%`,
      yFmt: v => `${v.toFixed(0)}分`,
      getX: r => r.shareholderYieldPct,
      getY: r => r.divStabilityScore
    },
    div_elast_cov: {
      xLabel: elMode === "forward_pot" ? "前瞻提息潜能 g₁×(1-派息率) (%)" : "历史股息弹性 DPS 3Y CAGR (%)",
      yLabel: allFin ? "盈利分红覆盖倍数 (x · 金融净利口径)" : "FCF 覆盖倍数 (x · FCF / (分红+回购))",
      subtitle: `横轴${elMode === "forward_pot" ? "前瞻提息潜能（盈利增速×留存比例）" : "近3年每股分红复合增速 DPS 3Y CAGR"} · 纵轴${hz === "3y" ? "3年均值" : "TTM"}现金流/盈利分红覆盖倍数 · 斜虚线衡量弹性与现金垫权衡，Y=1.0x 以下为透支警戒区`,
      badge: "占优区：提息高弹性 · 现金流充裕",
      badgePos: "tr",
      forceZeroX: false,
      forceZeroY: false,
      xFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
      yFmt: v => `${v.toFixed(2)}x`,
      getX: r => (elMode === "forward_pot" ? r.divElasticityForward : r.divCagr3y),
      getY: r => (hz === "3y" ? (r.fcf3yDivCoverage ?? r.fcfDivCoverage) : r.fcfDivCoverage)
    },
    div_return_risk: {
      xLabel: "综合股东回报率 (% · 股息+净回购)",
      yLabel: rkMode === "vol_3y" ? "近3年股价年化波动率 (% · 越低越稳)" : "近3年最大回撤幅度 (% · 越低越稳)",
      subtitle: `横轴综合股东回报率 · 纵轴近3年${rkMode === "vol_3y" ? "股价年化波动率" : "最大回撤幅度"} · 斜射线为「回报/风险」性价比前沿（越偏右下单位风险补偿越高）`,
      badge: `占优区：高回报 · ${rkMode === "vol_3y" ? "低波动" : "低回撤"}`,
      badgePos: "br",
      forceZeroX: true,
      forceZeroY: true,
      xFmt: v => `${v.toFixed(2)}%`,
      yFmt: v => `${v.toFixed(0)}%`,
      getX: r => r.shareholderYieldPct,
      getY: r => (rkMode === "vol_3y" ? r.vol3y : r.maxDd3yAbs)
    },
    pb_roe: {
      xLabel: hz === "ttm" ? "TTM ROE (%)" : `${ltTag}平均 ROE (%)`,
      yLabel: "当前市净率 PB (倍)",
      subtitle: `横轴 ${hz === "ttm" ? "TTM ROE" : ltTag + "平均 ROE"} · 纵轴当前 PB · 斜虚线为 PB = ROE / 同业平均折现率 r 合理估值前沿 · 右下角占优`,
      badge: `占优区：高${hz === "ttm" ? "" : ltTag}ROE · 低PB`,
      badgePos: "br",
      forceZeroX: false,
      forceZeroY: true,
      xFmt: v => `${v.toFixed(1)}%`,
      yFmt: v => `${v.toFixed(2)}x`,
      getX: r => (hz === "5y" ? r.roeMean5y : (hz === "3y" ? r.roeMean3y : r.roeTtm)),
      getY: r => r.pb
    },
    irr_upside: {
      xLabel: "现价隐含回报 IRR (%)",
      yLabel: "绝对估值空间 (%)",
      subtitle: "横轴现价隐含年化回报 IRR · 纵轴现价相对中性模型空间 · 右上象限兼备高回报与安全边际",
      badge: "占优区：高IRR · 正安全边际",
      badgePos: "tr",
      forceZeroX: false,
      forceZeroY: false,
      xFmt: v => `${v.toFixed(1)}%`,
      yFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
      getX: r => r.impliedIrr,
      getY: r => r.dcfUpsidePct ?? r.rimUpsidePct
    },
    div_growth: {
      xLabel: "5年净利增速 g₁ → 近1Y边际增速 (%)",
      yLabel: "股东总回报率 (%)",
      subtitle: "横轴 5Y 增速基准 g₁（拖尾箭头指向近1Y增速） · 纵轴股东总回报率(股息+净回购) · 斜虚线为 10% 等回报线",
      badge: "占优区：高股东回报 · 高成长 / 向右加速",
      badgePos: "tr",
      forceZeroX: false,
      forceZeroY: true,
      xFmt: v => `${v.toFixed(1)}%`,
      yFmt: v => `${v.toFixed(2)}%`,
      getX: r => r.g1Base,
      getX2: r => r.npYoy1y,
      getY: r => r.shareholderYieldPct
    },
    pe_pct: {
      xLabel: "近5年 PE 历史分位 (%)",
      yLabel: hz === "ttm" ? "市盈率 PE_TTM (倍)" : `${ltTag}均利 PE (倍)`,
      subtitle: `横轴近 5 年 PIT+ASOF 历史 PE 分位 · 纵轴${hz === "ttm" ? "当前 PE_TTM" : "现市值 / " + ltTag + "平均净利"} · 左下象限为低估值兼低历史分位`,
      badge: "占优区：低PE · 低历史分位",
      badgePos: "bl",
      clampX: [0, 100],
      forceZeroY: true,
      xFmt: v => `${v.toFixed(0)}%`,
      yFmt: v => `${v.toFixed(1)}x`,
      getX: r => r.pePct5y,
      getY: r => (hz === "5y" ? r.pe5yNorm : (hz === "3y" ? r.pe3yNorm : r.peTtm))
    },
    cf_return: {
      xLabel: hz === "ttm" ? "FCF 收益率 (%)" : `${ltTag}平均 FCF 收益率 (%)`,
      yLabel: "股东总回报率 (%)",
      subtitle: `横轴 ${hz === "ttm" ? "TTM" : ltTag + "均值"} FCF/市值 · 纵轴股东总回报率(股息+净回购) · 斜线为「股东回报 = FCF (100% 覆盖线)」，右下为有余粮真现金牛`,
      badge: "占优区：高FCF · 股东回报全覆盖",
      badgePos: "br",
      forceZeroX: false,
      forceZeroY: true,
      xFmt: v => `${v.toFixed(1)}%`,
      yFmt: v => `${v.toFixed(2)}%`,
      getX: r => (hz === "5y" ? r.fcf5yYieldPct : (hz === "3y" ? r.fcf3yYieldPct : r.fcfYieldPct)),
      getY: r => r.shareholderYieldPct
    },
    roic_stability: {
      xLabel: hz === "3y"
        ? (allFin ? "3年 ROE 均值 (% · 金融)" : "3年 ROIC 均值 (% · 剔除杠杆)")
        : (allFin ? "5年 ROE 均值 (% · 金融)" : "5年 ROIC 均值 (% · 剔除杠杆)"),
      yLabel: `${hz === "3y" ? "3年" : "5年"} ROE 波动率 (% · 越低越稳)`,
      subtitle: `横轴 ${hz === "3y" ? "3" : "5"} 年平均资本回报 ROIC（金融股自动标注 ROE 代理） · 纵轴 ${hz === "3y" ? "3" : "5"} 年 ROE 波动率 · 斜射线为「ROIC/波动」效率前沿（右下占优）`,
      badge: "占优区：高ROIC · 低盈利波动",
      badgePos: "br",
      forceZeroX: false,
      forceZeroY: true,
      xFmt: v => `${v.toFixed(1)}%`,
      yFmt: v => `${v.toFixed(1)}%`,
      getX: r => (hz === "3y" ? r.roic3yMean : r.roic5yMean),
      getY: r => (hz === "3y" ? (r.roeVol3y ?? r.roeVol5y) : r.roeVol5y)
    },
    div_stability: {
      xLabel: "分红稳定性评分 (0~100 · 连分/波动/缩水)",
      yLabel: "股东总回报率 (%)",
      subtitle: "横轴分红稳定性综合评分（连续分红年数+5年低波动+零缩水） · 纵轴股东总回报率 · 右上象限为高息稳健真红利，左上防突击分红陷阱",
      badge: "占优区：高回报 · 稳健真红利",
      badgePos: "tr",
      clampX: [0, 100],
      forceZeroY: true,
      xFmt: v => `${v.toFixed(0)}分`,
      yFmt: v => `${v.toFixed(2)}%`,
      getX: r => r.divStabilityScore,
      getY: r => r.shareholderYieldPct
    },
    quality_compound_roiic: qGrow === "bogle_ret"
      ? {
          xLabel: `${ltTag}复利总回报 = 股东回报 + 净利增速 g (%)`,
          yLabel: `${ltTag}留存再投资效率 ROIIC (Δ净利÷累计留存 %)`,
          subtitle: `横轴 Bogle/Terry Smith 复利总回报（股东总回报 + ${ltTag}净利复合增速） · 纵轴留存再投资增量回报 ROIIC · 右上为「复利白马」（既能滚雪球留存、每留1元还赚高回报），左侧/偏下为「现金奶牛」，0%以下为价值毁灭`,
          badge: "占优区：复利白马 (高总回报 · 高再投资效率)",
          badgePos: "tr",
          forceZeroX: false,
          forceZeroY: false,
          xFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          yFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          getX: r => (hz === "5y" ? (r.bogleRet5y ?? r.bogleRet3y) : (r.bogleRet3y ?? r.bogleRet5y)),
          getY: r => (hz === "5y" ? (r.roiic5yPct ?? r.roiic3yPct) : (r.roiic3yPct ?? r.roiic5yPct))
        }
      : {
          xLabel: `${ltTag}净利复合增速 g → 近1Y增速 (%)`,
          yLabel: `${ltTag}留存再投资效率 ROIIC (Δ净利÷累计留存 %)`,
          subtitle: `横轴 ${ltTag}净利复合增速（拖尾箭头指向近1Y增速） · 纵轴每留存1元利润的增量回报 ROIIC · 右上为真正把高ROIC再投资出去的「复利白马」，左侧为「现金奶牛」，Y<0%为无效/负效扩产`,
          badge: "占优区：复利白马 (高增速g · 高再投资效率)",
          badgePos: "tr",
          forceZeroX: false,
          forceZeroY: false,
          xFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          yFmt: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
          getX: r => (hz === "5y" ? (r.npCagr5y ?? r.g1Base) : (r.npCagr3y ?? r.g1Base)),
          getX2: r => r.npYoy1y,
          getY: r => (hz === "5y" ? (r.roiic5yPct ?? r.roiic3yPct) : (r.roiic3yPct ?? r.roiic5yPct))
        },
    long_term_roe_pb: qComp === "roe_pb"
      ? {
          xLabel: `${ltTag}平均 ROE / 当前 PB (% · 长期账面性价比)`,
          yLabel: `${ltTag} ROE 波动率 (% · 越低越稳)`,
          subtitle: `横轴 ${ltTag}平均 ROE / 当前 PB（长期隐含账面回报，当前口径：${hzLabel}） · 纵轴 ${ltTag} ROE 波动率 · 斜射线为「长期性价比/波动」效率前沿，越偏右下越稳健超值`,
          badge: `占优区：高${ltTag} ROE/PB · 低盈利波动`,
          badgePos: "br",
          forceZeroX: false,
          forceZeroY: true,
          xFmt: v => `${v.toFixed(1)}%`,
          yFmt: v => `${v.toFixed(1)}%`,
          getX: r => (hz === "5y" ? r.roeToPb5y : r.roeToPb3y),
          getY: r => (hz === "5y" ? r.roeVol5y : (r.roeVol3y ?? r.roeVol5y))
        }
      : (qComp === "irr"
        ? {
            xLabel: "现价隐含年化回报 IRR (% · 含成长复利)",
            yLabel: `${ltTag} ROE 波动率 (% · 越低越稳)`,
            subtitle: `横轴两阶段 DCF 现价隐含年化回报 IRR（综合当下估值与长期增速 g₁，避免静态 ROE/PB 错杀优质成长白马） · 纵轴 ${ltTag} ROE 波动率 · 斜射线为「风险调整复利前沿 (IRR ÷ 波动)」，越偏右下越稳健超值`,
            badge: "占优区：高隐含复利 IRR · 低盈利波动",
            badgePos: "br",
            forceZeroX: false,
            forceZeroY: true,
            xFmt: v => `${v.toFixed(1)}%`,
            yFmt: v => `${v.toFixed(1)}%`,
            getX: r => r.impliedIrr,
            getY: r => (hz === "5y" ? r.roeVol5y : (r.roeVol3y ?? r.roeVol5y))
          }
        : {
            xLabel: `${ltTag}复利总回报 = 股东回报 + 净利增速 g (%)`,
            yLabel: `${ltTag} ROE 波动率 (% · 越低越稳)`,
            subtitle: `横轴长期复利总回报（Bogle/Terry Smith 公式：股东回报率 + ${ltTag}净利复合增速 g，区分复利白马与零增长现金奶牛） · 纵轴 ${ltTag} ROE 波动率 · 斜射线衡量单位波动复利回报`,
            badge: "占优区：高复利总回报 · 低盈利波动",
            badgePos: "br",
            forceZeroX: false,
            forceZeroY: true,
            xFmt: v => `${v.toFixed(1)}%`,
            yFmt: v => `${v.toFixed(1)}%`,
            getX: r => (hz === "5y" ? (r.bogleRet5y ?? r.bogleRet3y) : (r.bogleRet3y ?? r.bogleRet5y)),
            getY: r => (hz === "5y" ? r.roeVol5y : (r.roeVol3y ?? r.roeVol5y))
          })
  };
  const cfg = configs[mode] || configs.pb_roe;
  const subEl = document.getElementById("cmp-scatter-subtitle");
  if (subEl) subEl.textContent = cfg.subtitle;

  const pts = rows
    .map(r => ({
      row: r,
      x: cfg.getX(r),
      x2: typeof cfg.getX2 === "function" ? cfg.getX2(r) : null,
      y: cfg.getY(r)
    }))
    .filter(p => p.x !== null && p.y !== null && Number.isFinite(p.x) && Number.isFinite(p.y));

  const w = Math.max(290, wrap.clientWidth || 720);
  const isNarrow = w < 480;
  const h = isNarrow ? 340 : 420;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  if (!pts.length) {
    const isAllFinCycleNonFin = !STATE.compare.loading && allFin && (
      mode === "cycle_ev_ebit_pos"
      || mode === "cycle_supply_safety"
      || (mode === "cycle_odds_inflection" && (cycOdds === "ebit_yield" || cycInflect === "gm_yoy"))
    );
    const isAllFinGrowthNonFin = !STATE.compare.loading && allFin && (
      (mode === "growth_accel_eff" && (grEff === "gm" || grEff === "rd"))
      || (mode === "growth_cash_self" && grCash === "fcf_margin")
    );
    if (isAllFinCycleNonFin) {
      svg.innerHTML = `<text x="${w / 2}" y="${h / 2 - 8}" text-anchor="middle" fill="#6B7280" font-size="${isNarrow ? 11.5 : 13}" font-family="Noto Sans SC, sans-serif"><tspan x="${w / 2}" dy="0">EV/EBIT、单季毛利率与 CapEx 仅适用于非金融实业标的</tspan><tspan x="${w / 2}" dy="18">请添加实业标的，或切换赔率/景气轴至「ΔROE边际差」</tspan></text>`;
    } else if (isAllFinGrowthNonFin) {
      svg.innerHTML = `<text x="${w / 2}" y="${h / 2 - 8}" text-anchor="middle" fill="#6B7280" font-size="${isNarrow ? 11.5 : 13}" font-family="Noto Sans SC, sans-serif"><tspan x="${w / 2}" dy="0">毛利率、研发率与 FCF 利润率仅适用于非金融实业标的</tspan><tspan x="${w / 2}" dy="18">请添加实业成长标的，或切换至「ROIC」/「3Y净现比」</tspan></text>`;
    } else if (isNarrow && !STATE.compare.loading) {
      svg.innerHTML = `<text x="${w / 2}" y="${h / 2 - 8}" text-anchor="middle" fill="#6B7280" font-size="12" font-family="Noto Sans SC, sans-serif"><tspan x="${w / 2}" dy="0">当前篮子暂无足够有效散点数据</tspan><tspan x="${w / 2}" dy="18">请添加标的或切换上方对比模式</tspan></text>`;
    } else {
      svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#6B7280" font-size="${isNarrow ? 12 : 13}" font-family="Noto Sans SC, sans-serif">${STATE.compare.loading ? "正在加载同业标的并测算…" : "当前篮子暂无足够的有效散点数据（请添加或切换指标模式）"}</text>`;
    }
    return;
  }

  const pad = isNarrow ? { l: 46, r: 16, t: 26, b: 44 } : { l: 58, r: 28, t: 28, b: 48 };
  const plotW = Math.max(120, w - pad.l - pad.r);
  const plotH = Math.max(120, h - pad.t - pad.b);

  const showArrows = (mode === "div_growth" || mode === "growth_g_pe" || (mode === "quality_compound_roiic" && qGrow === "g_cagr")) && Boolean(STATE.compare.showGrowthArrows);
  const showRings = Boolean(STATE.compare.showRiskRings);
  const xValsForRange = [];
  for (const p of pts) {
    xValsForRange.push(p.x);
    if (showArrows && p.x2 != null && Number.isFinite(p.x2)) {
      xValsForRange.push(p.x2);
    }
  }

  const [xLo, xHi] = niceAxisRange(xValsForRange, cfg.forceZeroX, cfg.clampX || null);
  const [yLo, yHi] = niceAxisRange(pts.map(p => p.y), cfg.forceZeroY, cfg.clampY || null);
  const toPxX = (v) => pad.l + ((v - xLo) / (xHi - xLo)) * plotW;
  const toPxY = (v) => pad.t + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

  const xTicks = makeTicks(xLo, xHi, isNarrow ? 4 : 6);
  const yTicks = makeTicks(yLo, yHi, 5);

  const parts = [];
  parts.push(
    `<defs>` +
      `<clipPath id="cmp-plot-clip"><rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" /></clipPath>` +
      `<marker id="cmp-arrow-up" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0.5 L5.5,3 L0,5.5 z" fill="#0F766E" /></marker>` +
      `<marker id="cmp-arrow-down" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0.5 L5.5,3 L0,5.5 z" fill="#DC2626" /></marker>` +
    `</defs>`
  );
  parts.push(`<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="#FFFFFF" stroke="#E5E7EB" stroke-width="1" />`);

  // Frontier / Sloped Efficiency & Hard-Floor Reference Lines inside clipPath
  const refParts = [];
  const avgR = median(rows.map(r => r.rUsed)) || 8.0;
  const xSpan = Math.max(1e-6, xHi - xLo);
  const ySpan = Math.max(1e-6, yHi - yLo);
  const addSlopeRegion = (yFn, side, fill) => {
    const xA = xLo - xSpan * 0.25;
    const xB = xHi + xSpan * 0.25;
    const yA = yFn(xA);
    const yB = yFn(xB);
    if (!Number.isFinite(yA) || !Number.isFinite(yB)) return;
    const yEdge = side === "above"
      ? Math.max(yHi + ySpan * 2.5, yA + ySpan, yB + ySpan)
      : Math.min(yLo - ySpan * 2.5, yA - ySpan, yB - ySpan);
    const ptsAttr = [
      `${toPxX(xA).toFixed(1)},${toPxY(yA).toFixed(1)}`,
      `${toPxX(xB).toFixed(1)},${toPxY(yB).toFixed(1)}`,
      `${toPxX(xB).toFixed(1)},${toPxY(yEdge).toFixed(1)}`,
      `${toPxX(xA).toFixed(1)},${toPxY(yEdge).toFixed(1)}`
    ].join(" ");
    refParts.push(`<polygon points="${ptsAttr}" fill="${fill}" />`);
  };
  const addSlopeLine = (yFn, stroke, width, dash, opacity, label, labelColor, preferSide = "right") => {
    const y0 = yFn(xLo);
    const y1 = yFn(xHi);
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return;
    const xA = xLo - xSpan * 0.25;
    const xB = xHi + xSpan * 0.25;
    const yA = yFn(xA);
    const yB = yFn(xB);
    if (!Number.isFinite(yA) || !Number.isFinite(yB)) return;
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
    refParts.push(`<line x1="${toPxX(xA).toFixed(1)}" y1="${toPxY(yA).toFixed(1)}" x2="${toPxX(xB).toFixed(1)}" y2="${toPxY(yB).toFixed(1)}" stroke="${stroke}" stroke-width="${width}"${dashAttr} opacity="${opacity}" />`);
    if (!label) return;
    // Intersect line with visible box [xLo, xHi] x [yLo, yHi] so label always sits cleanly inside chart
    const slope = (y1 - y0) / xSpan;
    let visX0 = xLo;
    let visX1 = xHi;
    if (Math.abs(slope) > 1e-9) {
      const txLo = xLo + (yLo - y0) / slope;
      const txHi = xLo + (yHi - y0) / slope;
      visX0 = Math.max(visX0, Math.min(txLo, txHi));
      visX1 = Math.min(visX1, Math.max(txLo, txHi));
    } else if (y0 < yLo || y0 > yHi) {
      return;
    }
    if (visX1 <= visX0 + xSpan * 0.04) return;
    const frac = preferSide === "left" ? 0.14 : (preferSide === "mid" ? 0.55 : 0.80);
    const lxVal = visX0 + (visX1 - visX0) * frac;
    const lyVal = yFn(lxVal);
    if (!Number.isFinite(lyVal)) return;
    const anchor = preferSide === "left" ? "start" : (preferSide === "mid" ? "middle" : "end");
    const rawPx = toPxX(lxVal) + (anchor === "start" ? 4 : (anchor === "end" ? -4 : 0));
    const px = clamp(rawPx, pad.l + (anchor === "start" ? 6 : 75), pad.l + plotW - (anchor === "end" ? 6 : 75));
    const rawPy = toPxY(lyVal);
    const py = rawPy - 7 >= pad.t + 14 ? rawPy - 6 : clamp(rawPy + 13, pad.t + 13, pad.t + plotH - 6);
    refParts.push(`<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" text-anchor="${anchor}" font-size="10" font-weight="600" fill="${labelColor || stroke}" font-family="Noto Sans SC, sans-serif">${esc(label)}</text>`);
  };
  const drawZeroX = () => {
    if (xLo < 0 && xHi > 0) {
      const xz = toPxX(0);
      refParts.push(`<line x1="${xz.toFixed(1)}" y1="${pad.t}" x2="${xz.toFixed(1)}" y2="${pad.t + plotH}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3" />`);
    }
  };

  if (mode === "div_return_stab") {
    // Sloped iso-value frontier: Stability + 10 * Yield >= 115, with hard floor Stability = 50
    addSlopeRegion(x => 115 - 10 * x, "above", "rgba(15,118,110,0.065)");
    const ry50 = toPxY(50);
    const brH = Math.max(0, pad.t + plotH - Math.max(pad.t, ry50));
    if (brH > 0) {
      refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ry50)}" width="${plotW}" height="${brH}" fill="rgba(185,28,28,0.055)" />`);
    }
    drawZeroX();
    addSlopeLine(x => 115 - 10 * x, "#0F766E", 1.35, "5 4", 0.85, "综合优势边界 (稳健+10×回报≥115)", "#0F766E", "right");
    refParts.push(`<line x1="${pad.l}" y1="${ry50}" x2="${pad.l + plotW}" y2="${ry50}" stroke="#DC2626" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.8" />`);
    if (ry50 >= pad.t + 14 && ry50 <= pad.t + plotH - 4) {
      refParts.push(`<text x="${pad.l + 8}" y="${ry50 - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">稳定性红线 50分</text>`);
    }
  } else if (mode === "div_elast_cov") {
    // Hard solvency floor at Y=1.0x + sloped elasticity-coverage iso-value frontier
    const slope = elMode === "forward_pot" ? -0.20 : -0.08;
    const baseInter = elMode === "forward_pot" ? 2.00 : 1.90;
    addSlopeRegion(x => baseInter + slope * x, "above", "rgba(15,118,110,0.065)");
    const ry1 = toPxY(1.0);
    const lowH = Math.max(0, pad.t + plotH - Math.max(pad.t, ry1));
    if (lowH > 0) {
      refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ry1)}" width="${plotW}" height="${lowH}" fill="rgba(185,28,28,0.055)" />`);
    }
    drawZeroX();
    const medInter = median(pts.map(p => p.y - slope * p.x));
    if (medInter != null && Math.abs(medInter - baseInter) > 0.08) {
      addSlopeLine(x => medInter + slope * x, "#6B7280", 1.0, "3 4", 0.65, "同业中位边界", "#6B7280", "left");
    }
    addSlopeLine(
      x => baseInter + slope * x,
      "#0F766E",
      1.35,
      "5 4",
      0.85,
      elMode === "forward_pot" ? "弹性-覆盖综合边界" : "增速-覆盖综合边界",
      "#0F766E",
      "right"
    );
    refParts.push(`<line x1="${pad.l}" y1="${ry1}" x2="${pad.l + plotW}" y2="${ry1}" stroke="#DC2626" stroke-width="1.3" stroke-dasharray="5 4" opacity="0.82" />`);
    if (ry1 >= pad.t + 14 && ry1 <= pad.t + plotH - 4) {
      refParts.push(`<text x="${pad.l + 8}" y="${ry1 - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">1.0x 覆盖警戒线</text>`);
    }
  } else if (mode === "div_return_risk") {
    // Upward Sharpe/Calmar efficiency ray: Y = X / ratio (below & right = higher return per unit risk)
    const baseRatio = rkMode === "vol_3y" ? 0.17 : 0.16;
    const rkBad = rkMode === "vol_3y" ? 42 : 45;
    addSlopeRegion(x => x / baseRatio, "below", "rgba(15,118,110,0.065)");
    const ryBad = toPxY(rkBad);
    const badH = Math.max(0, Math.min(pad.t + plotH, ryBad) - pad.t);
    if (badH > 0) {
      refParts.push(`<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${badH}" fill="rgba(185,28,28,0.04)" />`);
    }
    drawZeroX();
    const posRatios = pts.filter(p => p.x > 0 && p.y > 0.5).map(p => p.x / p.y);
    const medRatio = posRatios.length >= 2 ? median(posRatios) : null;
    if (medRatio != null && Math.abs(medRatio - baseRatio) > 0.015) {
      addSlopeLine(x => x / medRatio, "#6B7280", 1.0, "3 4", 0.7, `同业中位 (${medRatio.toFixed(2)}x)`, "#6B7280", "mid");
    }
    addSlopeLine(
      x => x / baseRatio,
      "#0F766E",
      1.35,
      "5 4",
      0.85,
      rkMode === "vol_3y" ? `回报/波动前沿 (${baseRatio.toFixed(2)}x)` : `Calmar 效率前沿 (${baseRatio.toFixed(2)}x)`,
      "#0F766E",
      "right"
    );
  } else if (mode === "cycle_odds_inflection") {
    const yFn = cycOdds === "ebit_yield" ? (x => 4.0 - 0.35 * x) : (x => 3.0 - 0.05 * x);
    addSlopeRegion(yFn, "above", "rgba(15,118,110,0.065)");
    const ryBad = toPxY(-4.0);
    const badH = Math.max(0, pad.t + plotH - Math.max(pad.t, ryBad));
    if (badH > 0) {
      refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ryBad)}" width="${plotW}" height="${badH}" fill="rgba(185,28,28,0.05)" />`);
    }
    if (cycOdds === "ebit_yield") drawZeroX();
    const ry0 = toPxY(0);
    if (ry0 >= pad.t && ry0 <= pad.t + plotH) {
      refParts.push(`<line x1="${pad.l}" y1="${ry0}" x2="${pad.l + plotW}" y2="${ry0}" stroke="#0F766E" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.75" />`);
      if (ry0 >= pad.t + 14 && ry0 <= pad.t + plotH - 4) {
        refParts.push(`<text x="${pad.l + 8}" y="${ry0 - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#0F766E" font-family="Noto Sans SC, sans-serif">0pp 景气拐点线</text>`);
      }
    }
    addSlopeLine(
      yFn,
      "#0F766E",
      1.35,
      "5 4",
      0.85,
      cycOdds === "ebit_yield" ? "赔率-拐点边界 (Δ+0.35×EBIT/EV≥4)" : "赔率-拐点边界 (Δ+0.05×便宜度≥3)",
      "#0F766E",
      "right"
    );
  } else if (mode === "cycle_ev_ebit_pos") {
    const yFn = x => 1.65 - 0.055 * x;
    addSlopeRegion(yFn, "below", "rgba(15,118,110,0.065)");
    const ryTop = toPxY(1.5);
    const topH = Math.max(0, Math.min(pad.t + plotH, ryTop) - pad.t);
    if (topH > 0) {
      refParts.push(`<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${topH}" fill="rgba(185,28,28,0.055)" />`);
    }
    if (ryTop >= pad.t && ryTop <= pad.t + plotH) {
      refParts.push(`<line x1="${pad.l}" y1="${ryTop}" x2="${pad.l + plotW}" y2="${ryTop}" stroke="#DC2626" stroke-width="1.25" stroke-dasharray="4 4" opacity="0.82" />`);
      if (ryTop >= pad.t + 14 && ryTop <= pad.t + plotH - 4) {
        refParts.push(`<text x="${pad.l + 8}" y="${ryTop - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">1.5x 周期顶部警戒线</text>`);
      }
    }
    const ryMid = toPxY(1.0);
    if (ryMid >= pad.t && ryMid <= pad.t + plotH) {
      refParts.push(`<line x1="${pad.l}" y1="${ryMid}" x2="${pad.l + plotW}" y2="${ryMid}" stroke="#6B7280" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.8" />`);
      if (ryMid >= pad.t + 14 && ryMid <= pad.t + plotH - 4) {
        refParts.push(`<text x="${pad.l + 8}" y="${ryMid - 5}" text-anchor="start" font-size="10" fill="#6B7280" font-family="Noto Sans SC, sans-serif">1.0x 跨周期中枢</text>`);
      }
    }
    if (yLo < 0 && yHi > 0) {
      const ryZ = toPxY(0);
      refParts.push(`<line x1="${pad.l}" y1="${ryZ}" x2="${pad.l + plotW}" y2="${ryZ}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="2 3" />`);
    }
    addSlopeLine(yFn, "#0F766E", 1.35, "5 4", 0.85, "跨周期估值防顶前沿", "#0F766E", "right");
  } else if (mode === "cycle_supply_safety") {
    if (cycSafety === "cash_debt") {
      const yFn = x => 20 + 1.5 * x;
      addSlopeRegion(yFn, "above", "rgba(15,118,110,0.065)");
      const ryFloor = toPxY(15);
      const lowH = Math.max(0, pad.t + plotH - Math.max(pad.t, ryFloor));
      if (lowH > 0) {
        refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ryFloor)}" width="${plotW}" height="${lowH}" fill="rgba(185,28,28,0.055)" />`);
      }
      if (ryFloor >= pad.t && ryFloor <= pad.t + plotH) {
        refParts.push(`<line x1="${pad.l}" y1="${ryFloor}" x2="${pad.l + plotW}" y2="${ryFloor}" stroke="#DC2626" stroke-width="1.25" stroke-dasharray="4 4" opacity="0.82" />`);
        if (ryFloor >= pad.t + 14 && ryFloor <= pad.t + plotH - 4) {
          refParts.push(`<text x="${pad.l + 8}" y="${ryFloor - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">15% 现金负债比警戒线</text>`);
        }
      }
      addSlopeLine(yFn, "#0F766E", 1.35, "5 4", 0.85, "缩表抗寒前沿 (现金比≥20%+1.5×CapEx)", "#0F766E", "right");
    } else {
      const yFn = x => 3.0 + 0.30 * x;
      addSlopeRegion(yFn, "above", "rgba(15,118,110,0.065)");
      const ryFloor = toPxY(2.0);
      const lowH = Math.max(0, pad.t + plotH - Math.max(pad.t, ryFloor));
      if (lowH > 0) {
        refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ryFloor)}" width="${plotW}" height="${lowH}" fill="rgba(185,28,28,0.055)" />`);
      }
      if (ryFloor >= pad.t && ryFloor <= pad.t + plotH) {
        refParts.push(`<line x1="${pad.l}" y1="${ryFloor}" x2="${pad.l + plotW}" y2="${ryFloor}" stroke="#DC2626" stroke-width="1.25" stroke-dasharray="4 4" opacity="0.82" />`);
        if (ryFloor >= pad.t + 14 && ryFloor <= pad.t + plotH - 4) {
          refParts.push(`<text x="${pad.l + 8}" y="${ryFloor - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">2.0x 利息保障红线</text>`);
        }
      }
      addSlopeLine(yFn, "#0F766E", 1.35, "5 4", 0.85, "缩表抗寒前沿 (保障≥3+0.3×CapEx)", "#0F766E", "right");
    }
  } else if (mode === "growth_g_pe") {
    drawZeroX();
    if (grVal === "psg") {
      addSlopeRegion(x => 0.20 * x, "below", "rgba(15,118,110,0.065)");
      addSlopeRegion(x => 0.45 * x, "above", "rgba(185,28,28,0.045)");
      addSlopeLine(x => 0.35 * x, "#6B7280", 1.0, "3 4", 0.72, "PSG = 0.35x 合理上限", "#6B7280", "mid");
      addSlopeLine(x => 0.20 * x, "#0F766E", 1.35, "5 4", 0.88, "PSG = 0.20x 黄金前沿", "#0F766E", "right");
    } else {
      addSlopeRegion(x => 1.0 * x, "below", "rgba(15,118,110,0.065)");
      addSlopeRegion(x => 2.2 * x, "above", "rgba(185,28,28,0.045)");
      addSlopeLine(x => 1.5 * x, "#6B7280", 1.0, "3 4", 0.72, "PEG = 1.5x 合理上限", "#6B7280", "mid");
      addSlopeLine(x => 1.0 * x, "#0F766E", 1.35, "5 4", 0.88, "PEG = 1.0x 黄金前沿", "#0F766E", "right");
    }
  } else if (mode === "growth_accel_eff") {
    const yFn = grEff === "rd"
      ? (x => 6.0 - 0.15 * x)
      : (grEff === "gm" ? (x => 30.0 - 0.50 * x) : (x => 12.0 - 0.25 * x));
    addSlopeRegion(yFn, "above", "rgba(15,118,110,0.065)");
    const rxStall = toPxX(-10.0);
    const stallW = Math.max(0, Math.min(pad.l + plotW, rxStall) - pad.l);
    if (stallW > 0) {
      refParts.push(`<rect x="${pad.l}" y="${pad.t}" width="${stallW}" height="${plotH}" fill="rgba(185,28,28,0.045)" />`);
    }
    const rx0 = toPxX(0);
    if (rx0 >= pad.l && rx0 <= pad.l + plotW) {
      refParts.push(`<line x1="${rx0}" y1="${pad.t}" x2="${rx0}" y2="${pad.t + plotH}" stroke="#0F766E" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.78" />`);
      if (rx0 >= pad.l + 6 && rx0 <= pad.l + plotW - 90) {
        refParts.push(`<text x="${rx0 + 5}" y="${pad.t + 14}" text-anchor="start" font-size="10" font-weight="600" fill="#0F766E" font-family="Noto Sans SC, sans-serif">0pp 加速/放缓分界</text>`);
      }
    }
    addSlopeLine(
      yFn,
      "#0F766E",
      1.35,
      "5 4",
      0.85,
      grEff === "rd" ? "加速-研发强度前沿" : (grEff === "gm" ? "加速-毛利护城河前沿" : "加速-ROIC效率前沿"),
      "#0F766E",
      "right"
    );
  } else if (mode === "growth_cash_self") {
    drawZeroX();
    if (grCash === "fcf_margin") {
      const yFn = x => 8.0 - 0.25 * x;
      addSlopeRegion(yFn, "above", "rgba(15,118,110,0.065)");
      const ry0 = toPxY(0);
      const lowH = Math.max(0, pad.t + plotH - Math.max(pad.t, ry0));
      if (lowH > 0) {
        refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ry0)}" width="${plotW}" height="${lowH}" fill="rgba(185,28,28,0.055)" />`);
      }
      if (ry0 >= pad.t && ry0 <= pad.t + plotH) {
        refParts.push(`<line x1="${pad.l}" y1="${ry0}" x2="${pad.l + plotW}" y2="${ry0}" stroke="#DC2626" stroke-width="1.25" stroke-dasharray="4 4" opacity="0.82" />`);
        if (ry0 >= pad.t + 14 && ry0 <= pad.t + plotH - 4) {
          refParts.push(`<text x="${pad.l + 8}" y="${ry0 - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">0% 自我造血红线</text>`);
        }
      }
      addSlopeLine(yFn, "#0F766E", 1.35, "5 4", 0.85, "增长-造血前沿 (FCF率+0.25×增速≥8)", "#0F766E", "right");
    } else {
      const yFn = x => 1.15 - 0.012 * x;
      addSlopeRegion(yFn, "above", "rgba(15,118,110,0.065)");
      const ry08 = toPxY(0.80);
      const lowH = Math.max(0, pad.t + plotH - Math.max(pad.t, ry08));
      if (lowH > 0) {
        refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ry08)}" width="${plotW}" height="${lowH}" fill="rgba(185,28,28,0.055)" />`);
      }
      if (ry08 >= pad.t && ry08 <= pad.t + plotH) {
        refParts.push(`<line x1="${pad.l}" y1="${ry08}" x2="${pad.l + plotW}" y2="${ry08}" stroke="#DC2626" stroke-width="1.25" stroke-dasharray="4 4" opacity="0.82" />`);
        if (ry08 >= pad.t + 14 && ry08 <= pad.t + plotH - 4) {
          refParts.push(`<text x="${pad.l + 8}" y="${ry08 - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">0.80x 造血红线</text>`);
        }
      }
      addSlopeLine(yFn, "#0F766E", 1.35, "5 4", 0.85, "增长-现金含金量前沿", "#0F766E", "right");
    }
  } else if (mode === "quality_roic_val") {
    drawZeroX();
    if (qvMode === "pb") {
      addSlopeRegion(x => x / avgR, "below", "rgba(15,118,110,0.06)");
      addSlopeLine(x => x / avgR, "#3730A3", 1.35, "5 4", 0.85, `PB = ROE / ${avgR.toFixed(1)}% (1x 合理线)`, "#3730A3", "right");
    } else {
      addSlopeRegion(x => x, "below", "rgba(15,118,110,0.065)");
      const posPeRatios = pts.filter(p => p.x > 0 && p.y > 0).map(p => p.y / p.x);
      const medPeRatio = posPeRatios.length >= 2 ? median(posPeRatios) : null;
      if (medPeRatio != null && Math.abs(medPeRatio - 1.0) > 0.12) {
        addSlopeLine(x => medPeRatio * x, "#6B7280", 1.0, "3 4", 0.7, `同业中位 (PE=${medPeRatio.toFixed(1)}×ROIC)`, "#6B7280", "mid");
      }
      addSlopeLine(x => x, "#0F766E", 1.35, "5 4", 0.85, "神奇公式前沿 (PE = 1.0×ROIC)", "#0F766E", "right");
    }
  } else if (mode === "quality_roic_cash") {
    drawZeroX();
    if (qcMode === "ar_ratio") {
      addSlopeRegion(x => x / 0.9, "below", "rgba(15,118,110,0.065)");
      const ry35 = toPxY(35);
      const topH = Math.max(0, Math.min(pad.t + plotH, ry35) - pad.t);
      if (topH > 0) {
        refParts.push(`<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${topH}" fill="rgba(185,28,28,0.05)" />`);
      }
      refParts.push(`<line x1="${pad.l}" y1="${ry35}" x2="${pad.l + plotW}" y2="${ry35}" stroke="#DC2626" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.8" />`);
      if (ry35 >= pad.t + 14 && ry35 <= pad.t + plotH - 4) {
        refParts.push(`<text x="${pad.l + 8}" y="${ry35 - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">高应收警戒线 35%</text>`);
      }
      addSlopeLine(x => x / 0.9, "#0F766E", 1.35, "5 4", 0.85, "低应收高效率前沿 (ROIC/应收 ≥ 0.9)", "#0F766E", "right");
    } else {
      addSlopeRegion(x => 1.25 - 0.015 * x, "above", "rgba(15,118,110,0.065)");
      const ry07 = toPxY(0.70);
      const lowH = Math.max(0, pad.t + plotH - Math.max(pad.t, ry07));
      if (lowH > 0) {
        refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ry07)}" width="${plotW}" height="${lowH}" fill="rgba(185,28,28,0.055)" />`);
      }
      const ry10 = toPxY(1.0);
      if (ry10 >= pad.t && ry10 <= pad.t + plotH) {
        refParts.push(`<line x1="${pad.l}" y1="${ry10}" x2="${pad.l + plotW}" y2="${ry10}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3" />`);
      }
      addSlopeLine(x => 1.25 - 0.015 * x, "#0F766E", 1.35, "5 4", 0.85, "盈利含金量前沿 (净现比+0.015×ROIC≥1.25)", "#0F766E", "right");
      refParts.push(`<line x1="${pad.l}" y1="${ry07}" x2="${pad.l + plotW}" y2="${ry07}" stroke="#DC2626" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.82" />`);
      if (ry07 >= pad.t + 14 && ry07 <= pad.t + plotH - 4) {
        refParts.push(`<text x="${pad.l + 8}" y="${ry07 - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">0.70x 含金量红线</text>`);
      }
    }
  } else if (mode === "pb_roe") {
    drawZeroX();
    addSlopeRegion(x => x / avgR, "below", "rgba(15,118,110,0.055)");
    addSlopeLine(x => x / avgR, "#3730A3", 1.35, "5 4", 0.8, `PB = ROE / ${avgR.toFixed(1)}% (1x 合理线)`, "#3730A3", "right");
  } else if (mode === "irr_upside") {
    const rx = toPxX(avgR);
    const ry = toPxY(0);
    refParts.push(`<rect x="${Math.max(pad.l, rx)}" y="${pad.t}" width="${Math.max(0, pad.l + plotW - Math.max(pad.l, rx))}" height="${Math.max(0, Math.min(pad.t + plotH, ry) - pad.t)}" fill="rgba(15,118,110,0.05)" />`);
    refParts.push(`<line x1="${rx}" y1="${pad.t}" x2="${rx}" y2="${pad.t + plotH}" stroke="#6B7280" stroke-width="1" stroke-dasharray="4 4" />`);
    refParts.push(`<line x1="${pad.l}" y1="${ry}" x2="${pad.l + plotW}" y2="${ry}" stroke="#0F766E" stroke-width="1.2" stroke-dasharray="5 4" />`);
  } else if (mode === "div_growth") {
    drawZeroX();
    addSlopeRegion(x => 10 - x, "above", "rgba(15,118,110,0.055)");
    addSlopeLine(x => 10 - x, "#0F766E", 1.35, "5 4", 0.85, "10% 等回报前沿 (g₁+回报=10%)", "#0F766E", "right");
  } else if (mode === "pe_pct") {
    const medY = median(pts.map(p => p.y));
    const rx = toPxX(50);
    const ry = medY != null ? toPxY(medY) : pad.t + plotH * 0.5;
    refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ry)}" width="${Math.max(0, Math.min(pad.l + plotW, rx) - pad.l)}" height="${Math.max(0, pad.t + plotH - Math.max(pad.t, ry))}" fill="rgba(15,118,110,0.05)" />`);
    refParts.push(`<line x1="${rx}" y1="${pad.t}" x2="${rx}" y2="${pad.t + plotH}" stroke="#6B7280" stroke-width="1" stroke-dasharray="4 4" />`);
    refParts.push(`<line x1="${pad.l}" y1="${ry}" x2="${pad.l + plotW}" y2="${ry}" stroke="#6B7280" stroke-width="1" stroke-dasharray="4 4" />`);
  } else if (mode === "cf_return") {
    const loB = Math.min(xLo, yLo) - 50;
    const hiB = Math.max(xHi, yHi) + 50;
    const abovePts = `${toPxX(loB)},${toPxY(loB)} ${toPxX(loB)},${toPxY(hiB)} ${toPxX(hiB)},${toPxY(hiB)}`;
    const belowPts = `${toPxX(0)},${toPxY(0)} ${toPxX(0)},${toPxY(loB)} ${toPxX(hiB)},${toPxY(loB)} ${toPxX(hiB)},${toPxY(hiB)}`;
    refParts.push(`<polygon points="${abovePts}" fill="rgba(185,28,28,0.04)" />`);
    refParts.push(`<polygon points="${belowPts}" fill="rgba(15,118,110,0.05)" />`);
    drawZeroX();
    refParts.push(`<line x1="${toPxX(loB)}" y1="${toPxY(loB)}" x2="${toPxX(hiB)}" y2="${toPxY(hiB)}" stroke="#0F766E" stroke-width="1.4" stroke-dasharray="5 4" />`);
    const tAnchor = Math.max(xLo + 0.5, Math.min(xHi, yHi) - (xHi - xLo) * 0.05);
    const lblY = clamp(toPxY(tAnchor) - 7, pad.t + 14, pad.t + plotH - 18);
    const lblX = clamp(toPxX(tAnchor), pad.l + 110, pad.l + plotW - 8);
    refParts.push(`<text x="${lblX.toFixed(1)}" y="${lblY.toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="#0F766E" font-family="Noto Sans SC, sans-serif">股东回报 = FCF (100% 覆盖线)</text>`);
  } else if (mode === "roic_stability") {
    drawZeroX();
    const posRatios = pts.filter(p => p.x > 0 && p.y > 0.5).map(p => p.x / p.y);
    const ratio = clamp(median(posRatios) || 3.0, 1.5, 8.0);
    addSlopeRegion(x => x / ratio, "below", "rgba(15,118,110,0.055)");
    addSlopeLine(x => x / ratio, "#0F766E", 1.35, "5 4", 0.85, `效率前沿 (ROIC/波动 = ${ratio.toFixed(1)}x)`, "#0F766E", "right");
  } else if (mode === "div_stability") {
    const rx75 = toPxX(75);
    const rx50 = toPxX(50);
    const ry4 = toPxY(4);
    refParts.push(`<rect x="${Math.max(pad.l, rx75)}" y="${pad.t}" width="${Math.max(0, pad.l + plotW - Math.max(pad.l, rx75))}" height="${Math.max(0, Math.min(pad.t + plotH, ry4) - pad.t)}" fill="rgba(15,118,110,0.06)" />`);
    refParts.push(`<rect x="${pad.l}" y="${pad.t}" width="${Math.max(0, Math.min(pad.l + plotW, rx50) - pad.l)}" height="${Math.max(0, Math.min(pad.t + plotH, ry4) - pad.t)}" fill="rgba(185,28,28,0.04)" />`);
    refParts.push(`<line x1="${rx75}" y1="${pad.t}" x2="${rx75}" y2="${pad.t + plotH}" stroke="#0F766E" stroke-width="1.2" stroke-dasharray="5 4" opacity="0.75" />`);
    refParts.push(`<line x1="${pad.l}" y1="${ry4}" x2="${pad.l + plotW}" y2="${ry4}" stroke="#6B7280" stroke-width="1" stroke-dasharray="4 4" />`);
    if (rx75 >= pad.l && rx75 <= pad.l + plotW - 10) {
      refParts.push(`<text x="${rx75 + 5}" y="${pad.t + 14}" text-anchor="start" font-size="10" fill="#0F766E" font-family="Noto Sans SC, sans-serif">稳健线 75分</text>`);
    }
  } else if (mode === "quality_compound_roiic") {
    drawZeroX();
    const yFn = qGrow === "bogle_ret" ? (x => 28 - 0.9 * x) : (x => 22 - 1.0 * x);
    addSlopeRegion(yFn, "above", "rgba(15,118,110,0.065)");
    const ry0 = toPxY(0);
    const lowH = Math.max(0, pad.t + plotH - Math.max(pad.t, ry0));
    if (lowH > 0) {
      refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ry0)}" width="${plotW}" height="${lowH}" fill="rgba(185,28,28,0.055)" />`);
    }
    if (ry0 >= pad.t && ry0 <= pad.t + plotH) {
      refParts.push(`<line x1="${pad.l}" y1="${ry0}" x2="${pad.l + plotW}" y2="${ry0}" stroke="#DC2626" stroke-width="1.25" stroke-dasharray="4 4" opacity="0.82" />`);
      if (ry0 >= pad.t + 14 && ry0 <= pad.t + plotH - 4) {
        refParts.push(`<text x="${pad.l + 8}" y="${ry0 - 5}" text-anchor="start" font-size="10" font-weight="600" fill="#DC2626" font-family="Noto Sans SC, sans-serif">0% 再投资价值毁灭红线</text>`);
      }
    }
    const ry12 = toPxY(12);
    if (ry12 >= pad.t && ry12 <= pad.t + plotH) {
      refParts.push(`<line x1="${pad.l}" y1="${ry12}" x2="${pad.l + plotW}" y2="${ry12}" stroke="#6B7280" stroke-width="1.05" stroke-dasharray="3 3" opacity="0.72" />`);
      if (ry12 >= pad.t + 14 && ry12 <= pad.t + plotH - 4) {
        refParts.push(`<text x="${pad.l + 8}" y="${ry12 - 5}" text-anchor="start" font-size="10" fill="#6B7280" font-family="Noto Sans SC, sans-serif">12% 合格再投资线</text>`);
      }
    }
    addSlopeLine(
      yFn,
      "#0F766E",
      1.35,
      "5 4",
      0.85,
      qGrow === "bogle_ret" ? "复利白马前沿 (ROIIC+0.9×总回报≥28)" : "复利白马前沿 (ROIIC+g≥22%)",
      "#0F766E",
      "right"
    );
  } else if (mode === "long_term_roe_pb") {
    drawZeroX();
    if (qComp === "roe_pb") {
      const posRatios = pts.filter(p => p.x > 0 && p.y > 0.5).map(p => p.x / p.y);
      const ratio = clamp(median(posRatios) || 2.5, 1.2, 7.0);
      addSlopeRegion(x => x / ratio, "below", "rgba(15,118,110,0.055)");
      addSlopeLine(x => x / ratio, "#0F766E", 1.35, "5 4", 0.85, `长期性价比前沿 (${ltTag} ROE/PB ÷ 波动 = ${ratio.toFixed(1)}x)`, "#0F766E", "right");
    } else {
      const rxAvg = toPxX(avgR);
      if (rxAvg >= pad.l && rxAvg <= pad.l + plotW) {
        refParts.push(`<line x1="${rxAvg.toFixed(1)}" y1="${pad.t}" x2="${rxAvg.toFixed(1)}" y2="${pad.t + plotH}" stroke="#6B7280" stroke-width="1" stroke-dasharray="4 4" opacity="0.75" />`);
        if (rxAvg <= pad.l + plotW - 72) {
          refParts.push(`<text x="${(rxAvg + 5).toFixed(1)}" y="${pad.t + 14}" text-anchor="start" font-size="10" fill="#6B7280" font-family="Noto Sans SC, sans-serif">同业折现率 ${avgR.toFixed(1)}%</text>`);
        }
      }
      const posRatios = pts.filter(p => p.x > 0 && p.y > 0.5).map(p => p.x / p.y);
      const ratio = clamp(median(posRatios) || 3.5, 1.5, 8.0);
      addSlopeRegion(x => x / ratio, "below", "rgba(15,118,110,0.06)");
      const lbl = qComp === "irr"
        ? `风险调整复利前沿 (IRR÷波动 = ${ratio.toFixed(1)}x)`
        : `复利总回报前沿 (总回报÷波动 = ${ratio.toFixed(1)}x)`;
      addSlopeLine(x => x / ratio, "#0F766E", 1.35, "5 4", 0.85, lbl, "#0F766E", "right");
    }
  }
  if ((mode === "div_growth" || mode === "cf_return" || mode === "div_stability") && yLo < 0 && yHi > 0) {
    const yZeroPx = toPxY(0);
    refParts.push(`<line x1="${pad.l}" y1="${yZeroPx}" x2="${pad.l + plotW}" y2="${yZeroPx}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3 3" />`);
  }

  // Gridlines & ticks
  for (const xv of xTicks) {
    const px = toPxX(xv);
    if (px < pad.l || px > pad.l + plotW) continue;
    parts.push(`<line x1="${px}" y1="${pad.t}" x2="${px}" y2="${pad.t + plotH}" stroke="#F3F4F6" stroke-width="1" />`);
    parts.push(`<text x="${px}" y="${pad.t + plotH + 16}" text-anchor="middle" font-size="10.5" fill="#6B7280" font-family="ui-monospace, monospace">${esc(cfg.xFmt(xv))}</text>`);
  }
  for (const yv of yTicks) {
    const py = toPxY(yv);
    if (py < pad.t || py > pad.t + plotH) continue;
    parts.push(`<line x1="${pad.l}" y1="${py}" x2="${pad.l + plotW}" y2="${py}" stroke="#F3F4F6" stroke-width="1" />`);
    parts.push(`<text x="${pad.l - 8}" y="${py + 3.5}" text-anchor="end" font-size="10.5" fill="#6B7280" font-family="ui-monospace, monospace">${esc(cfg.yFmt(yv))}</text>`);
  }

  parts.push(`<g clip-path="url(#cmp-plot-clip)">${refParts.join("")}</g>`);

  // Axis titles
  parts.push(`<text x="${pad.l + plotW / 2}" y="${h - 10}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#374151" font-family="Noto Sans SC, sans-serif">${esc(cfg.xLabel)}</text>`);
  const yAxisX = isNarrow ? 12 : 15;
  parts.push(`<text x="${yAxisX}" y="${pad.t + plotH / 2}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#374151" font-family="Noto Sans SC, sans-serif" transform="rotate(-90 ${yAxisX} ${pad.t + plotH / 2})">${esc(cfg.yLabel)}</text>`);

  // Sweet-spot badge
  const bx = cfg.badgePos.includes("r") ? (pad.l + plotW - 10) : (pad.l + 10);
  const by = cfg.badgePos.includes("b") ? (pad.t + plotH - 10) : (pad.t + 18);
  const bAnchor = cfg.badgePos.includes("r") ? "end" : "start";
  parts.push(`<text x="${bx}" y="${by}" text-anchor="${bAnchor}" font-size="10.5" font-weight="600" fill="#0F766E" opacity="0.85" font-family="Noto Sans SC, sans-serif">${esc(cfg.badge)}</text>`);

  // Prepare bubbles sorted large-to-small so small bubbles render on top
  const bubbles = pts.map(p => {
    const up = p.row.dcfUpsidePct ?? p.row.rimUpsidePct;
    const fill = up == null ? "#6B7280" : (up >= 15 ? "#0F766E" : (up <= -10 ? "#B91C1C" : "#374151"));
    const radius = 7 + clamp(Math.log10(Math.max(1e9, p.row.mktCap || 1e10) / 1e9), 0, 3.6) * 3.8;
    return {
      ...p,
      cx: toPxX(p.x),
      cy: toPxY(p.y),
      r: radius,
      fill,
      label: p.row.name || p.row.code
    };
  }).sort((a, b) => b.r - a.r);

  // Growth tail arrows layer (5Y -> 1Y)
  const arrowElems = [];
  if (showArrows) {
    for (const b of bubbles) {
      if (b.x2 == null || !Number.isFinite(b.x2) || Math.abs(b.x2 - b.x) < 0.8) continue;
      const isAccel = b.x2 > b.x;
      const sx = b.cx + (isAccel ? b.r * 0.72 : -b.r * 0.72);
      const tx = toPxX(b.x2);
      if (Math.abs(tx - sx) < 4) continue;
      const strokeColor = isAccel ? "#0F766E" : "#DC2626";
      const markerId = isAccel ? "cmp-arrow-up" : "cmp-arrow-down";
      arrowElems.push(`<line x1="${sx.toFixed(1)}" y1="${b.cy.toFixed(1)}" x2="${tx.toFixed(1)}" y2="${b.cy.toFixed(1)}" stroke="${strokeColor}" stroke-width="1.65" stroke-opacity="0.72" marker-end="url(#${markerId})" style="pointer-events:none;" />`);
    }
  }

  // Risk-control outer rings (mode-aware)
  const ringElems = [];
  if (showRings) {
    for (const b of bubbles) {
      const rFlag = isDivMode
        ? b.row.divRiskFlag
        : (isQualMode
          ? b.row.qualityRiskFlag
          : (isCycleMode ? b.row.cycleRiskFlag : (isGrowthMode ? b.row.growthRiskFlag : b.row.riskFlag)));
      if (rFlag === "high_risk") {
        ringElems.push(`<circle cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" r="${(b.r + 3.8).toFixed(1)}" fill="none" stroke="#DC2626" stroke-width="1.6" stroke-dasharray="3.5 2.5" stroke-opacity="0.92" style="pointer-events:none;" />`);
      } else if (rFlag === "low_vol") {
        ringElems.push(`<circle cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" r="${(b.r + 3.5).toFixed(1)}" fill="none" stroke="#0F766E" stroke-width="1.7" stroke-opacity="0.75" style="pointer-events:none;" />`);
      }
    }
  }

  // Collision-avoiding label placement
  const placedBoxes = [];
  const overlapArea = (a, b) => {
    const dx = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const dy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    return dx * dy;
  };
  const labelElems = [];
  for (const b of bubbles) {
    const lw = Math.max(44, b.label.length * 11 + 8);
    const lh = 15;
    const candidates = [
      { tx: b.cx + b.r + 5, ty: b.cy + 4, anchor: "start", bx1: b.cx + b.r + 4, by1: b.cy - 8 },
      { tx: b.cx, ty: b.cy - b.r - 5, anchor: "middle", bx1: b.cx - lw / 2, by1: b.cy - b.r - 17 },
      { tx: b.cx - b.r - 5, ty: b.cy + 4, anchor: "end", bx1: b.cx - b.r - 4 - lw, by1: b.cy - 8 },
      { tx: b.cx, ty: b.cy + b.r + 13, anchor: "middle", bx1: b.cx - lw / 2, by1: b.cy + b.r + 2 },
      { tx: b.cx + b.r + 5, ty: b.cy - b.r - 2, anchor: "start", bx1: b.cx + b.r + 4, by1: b.cy - b.r - 14 },
      { tx: b.cx - b.r - 5, ty: b.cy + b.r + 12, anchor: "end", bx1: b.cx - b.r - 4 - lw, by1: b.cy + b.r + 1 }
    ];
    let best = candidates[0];
    let bestScore = Infinity;
    for (const cand of candidates) {
      const box = { x1: cand.bx1, y1: cand.by1, x2: cand.bx1 + lw, y2: cand.by1 + lh };
      let score = 0;
      if (box.x1 < pad.l || box.x2 > pad.l + plotW || box.y1 < pad.t || box.y2 > pad.t + plotH) score += 2000;
      for (const pb of placedBoxes) score += overlapArea(box, pb) * 10;
      for (const ob of bubbles) {
        if (ob === b) continue;
        const bBox = { x1: ob.cx - ob.r, y1: ob.cy - ob.r, x2: ob.cx + ob.r, y2: ob.cy + ob.r };
        score += overlapArea(box, bBox) * 4;
      }
      if (score < bestScore) {
        bestScore = score;
        best = cand;
        if (score === 0) break;
      }
    }
    placedBoxes.push({ x1: best.bx1, y1: best.by1, x2: best.bx1 + lw, y2: best.by1 + lh });
    labelElems.push(`<text x="${best.tx.toFixed(1)}" y="${best.ty.toFixed(1)}" text-anchor="${best.anchor}" font-size="11" font-weight="600" fill="#111827" style="pointer-events:none;paint-order:stroke;stroke:#FFFFFF;stroke-width:3px;stroke-linejoin:round;" font-family="Noto Sans SC, sans-serif">${esc(b.label)}</text>`);
  }

  const dotElems = bubbles.map(b =>
    `<circle class="scatter-dot" data-cmp-dot="${esc(b.row.code)}" cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" r="${b.r.toFixed(1)}" fill="${b.fill}" fill-opacity="0.72" stroke="#FFFFFF" stroke-width="1.8" />`
  );

  if (arrowElems.length) {
    parts.push(`<g clip-path="url(#cmp-plot-clip)">${arrowElems.join("")}</g>`);
  }
  if (ringElems.length) {
    parts.push(`<g>${ringElems.join("")}</g>`);
  }
  parts.push(`<g>${dotElems.join("")}</g>`);
  parts.push(`<g>${labelElems.join("")}</g>`);
  svg.innerHTML = parts.join("");

  // Bind scatter interactions
  const byCode = new Map(bubbles.map(b => [b.row.code, b]));
  svg.querySelectorAll(".scatter-dot[data-cmp-dot]").forEach(dot => {
    const code = dot.dataset.cmpDot;
    const b = byCode.get(code);
    if (!b) return;
    const showTip = () => {
      const r = b.row;
      const dcfUp = r.dcfUpsidePct != null ? fmtPct(r.dcfUpsidePct, 1, true) : "--";
      const rimUp = r.rimUpsidePct != null ? fmtPct(r.rimUpsidePct, 1, true) : "--";
      const shTotal = r.shareholderYieldPct != null ? `${r.shareholderYieldPct.toFixed(2)}%` : "--";
      const divPart = r.divYieldPct != null ? `股息${r.divYieldPct.toFixed(2)}%` : "股息--";
      const bbVal = r.buybackYieldPct || 0;
      const bbPart = bbVal >= 0.05
        ? ` + 回购${bbVal.toFixed(2)}%`
        : (bbVal <= -0.05 ? ` - 稀释${Math.abs(bbVal).toFixed(2)}%` : "");
      const bbLbl = bbVal >= 0.05 ? "+回购" : (bbVal <= -0.05 ? "-稀释" : "");
      const bbNoteTag = (Math.abs(bbVal) >= 0.05 && r.buybackNote) ? ` · ${r.buybackNote}` : "";
      const fcfPart = r.fcfYieldPct != null ? `${r.fcfYieldPct.toFixed(1)}%` : "--";
      const ccPart = r.cashConv5y != null ? `${r.cashConv5y.toFixed(2)}x` : "--";
      const roicTag = r.roicIsRoeProxy ? "ROE" : "ROIC";
      const roicVal = r.roic5yMean != null ? `${r.roic5yMean.toFixed(1)}%` : "--";
      const roeVolVal = r.roeVol5y != null ? `${r.roeVol5y.toFixed(1)}%` : "--";
      const g5Val = r.g1Base != null ? fmtPct(r.g1Base, 1, true) : "--";
      const g1Val = r.npYoy1yRaw != null ? fmtPct(r.npYoy1yRaw, 1, true) : "--";
      const gDir = (r.npYoy1yRaw != null && r.g1Base != null)
        ? (r.npYoy1yRaw > r.g1Base + 0.8 ? " 加速↑" : (r.npYoy1yRaw < r.g1Base - 0.8 ? " 放缓↓" : " 持平"))
        : "";
      const debtStr = r.debtRatioPct != null ? `${r.debtRatioPct.toFixed(0)}%` : "--";
      const ncStr = r.netCashToMktCap != null ? fmtPct(r.netCashToMktCap, 0, true) : "--";
      const vol3Str = r.vol3y != null ? `${r.vol3y.toFixed(0)}%` : "--";
      const dd3Str = r.maxDd3y != null ? `${r.maxDd3y.toFixed(0)}%` : "--";
      const rFlag = isDivMode
        ? r.divRiskFlag
        : (isQualMode
          ? r.qualityRiskFlag
          : (isCycleMode ? r.cycleRiskFlag : (isGrowthMode ? r.growthRiskFlag : r.riskFlag)));
      const riskBadge = isDivMode
        ? (rFlag === "low_vol"
          ? ` <span style="color:#6EE7B7;">[稳健真红利]</span>`
          : (rFlag === "high_risk" ? ` <span style="color:#FCA5A5;">[红利排雷预警]</span>` : ""))
        : (isQualMode
          ? (rFlag === "low_vol"
            ? ` <span style="color:#6EE7B7;">[核心白马]</span>`
            : (rFlag === "high_risk" ? ` <span style="color:#FCA5A5;">[白马排雷预警]</span>` : ""))
          : (isCycleMode
            ? (rFlag === "low_vol"
              ? ` <span style="color:#6EE7B7;">[右侧拐点]</span>`
              : (rFlag === "high_risk" ? ` <span style="color:#FCA5A5;">[半山腰预警]</span>` : ""))
            : (isGrowthMode
              ? (rFlag === "low_vol"
                ? ` <span style="color:#6EE7B7;">[戴维斯双击]</span>`
                : (rFlag === "high_risk" ? ` <span style="color:#FCA5A5;">[成长排雷预警]</span>` : ""))
              : (rFlag === "low_vol"
                ? ` <span style="color:#6EE7B7;">[低波稳健]</span>`
                : (rFlag === "high_risk" ? ` <span style="color:#FCA5A5;">[高负债/回撤预警]</span>` : "")))));
      const covVal = hz === "3y" ? (r.fcf3yDivCoverage ?? r.fcfDivCoverage) : r.fcfDivCoverage;
      const covStr = covVal != null ? `${covVal.toFixed(2)}x${r.fcfCoverageIsProfitProxy ? "(净利)" : ""}` : "--";
      const capexStr = r.capexToOcfPct != null ? `CapEx/OCF ${r.capexToOcfPct.toFixed(0)}%` : (r.payoutPct != null ? `派息率 ${r.payoutPct.toFixed(0)}%` : "");
      const covLabel = r.fcfCoverageIsProfitProxy ? "盈利留存覆盖 (金融)" : "FCF 覆盖倍数";
      const covDetail = r.fcfCoverageIsProfitProxy
        ? `${covStr} · ${r.payoutBasis || "TTM"}派息 ${r.payoutPct != null ? r.payoutPct.toFixed(1) + "%" : "--"}`
        : `${covStr}${capexStr ? ` · ${capexStr}` : ""}`;
      const divBreakRow = r.divEventsShort
        ? `<div class="tt-row"><span class="tt-lbl">近12月除息拆解</span><span class="tt-val">${esc(r.divEventsShort)}</span></div>`
        : "";
      const dpsCagrStr = r.divCagr3y != null ? `3Y DPS ${fmtPct(r.divCagr3y, 1, true)}` : "3Y DPS --";
      const fwdPotStr = r.divElasticityForward != null ? `潜能 ${fmtPct(r.divElasticityForward, 1, true)}` : "潜能 --";
      const dstScore = r.divStabilityScore != null ? `${r.divStabilityScore}分(${r.divStabilityGrade || "--"})` : "--";
      const dstConsec = r.divConsecYears != null ? `连分${r.divConsecYears}年` : "";
      const dstCv = r.divCv5y != null ? ` · CV ${r.divCv5y.toFixed(2)}` : "";
      const dstCut = r.divCutCount5y > 0 ? ` · 缩水${r.divCutCount5y}次` : "";
      const trapBadge = r.divYieldTrap ? ` <span style="color:#FBBF24;">[高息波动提示]</span>` : "";

      tt.innerHTML = `
        <div class="tt-date">${esc(r.name)} <span style="opacity:.7;font-weight:400;">(${esc(r.code)})</span>${riskBadge}${trapBadge}</div>
        <div class="tt-row"><span class="tt-lbl">${esc(cfg.xLabel)}</span><span class="tt-val">${esc(cfg.xFmt(b.x))}</span></div>
        <div class="tt-row"><span class="tt-lbl">${esc(cfg.yLabel)}</span><span class="tt-val">${esc(cfg.yFmt(b.y))}</span></div>
        <div class="tt-row"><span class="tt-lbl">不复权价 / 市值</span><span class="tt-val">¥${fmtNum(r.unadjPrice)} / ${fmtMoneyShort(r.mktCap)}</span></div>
        <div class="tt-row"><span class="tt-lbl">隐含回报 IRR</span><span class="tt-val" style="color:${(r.impliedIrr ?? 0) >= 8 ? "#6EE7B7" : "#FCA5A5"};">${r.impliedIrr != null ? r.impliedIrr.toFixed(2) + "%" : "--"}</span></div>
        <div class="tt-row"><span class="tt-lbl">${esc(r.dcfBaseLabel)} / RIM</span><span class="tt-val">¥${fmtNum(r.dcfMid)}(${esc(dcfUp)}) / ¥${fmtNum(r.rimMid)}(${esc(rimUp)})</span></div>
        <div class="tt-row"><span class="tt-lbl">股东回报 (股息${bbLbl})</span><span class="tt-val">${esc(shTotal)} (${esc(divPart)}${esc(bbPart)}${esc(bbNoteTag)})</span></div>
        ${divBreakRow}
        <div class="tt-row"><span class="tt-lbl">分红稳定性</span><span class="tt-val">${esc(dstScore)}${dstConsec ? ` · ${esc(dstConsec + dstCv + dstCut)}` : ""}</span></div>
        <div class="tt-row"><span class="tt-lbl">${esc(covLabel)}</span><span class="tt-val">${esc(covDetail)}</span></div>
        <div class="tt-row"><span class="tt-lbl">股息弹性 (3Y/潜能)</span><span class="tt-val">${esc(dpsCagrStr)} / ${esc(fwdPotStr)}</span></div>
        <div class="tt-row"><span class="tt-lbl">FCF收益 / 5Y净现比</span><span class="tt-val">${esc(fcfPart)} / ${esc(ccPart)}</span></div>
        <div class="tt-row"><span class="tt-lbl">5Y ${esc(roicTag)} / ROE波动</span><span class="tt-val">${esc(roicVal)} (${esc(r.roicDebtBasis || "--")}) / ${esc(roeVolVal)}</span></div>
        <div class="tt-row"><span class="tt-lbl">再投资ROIIC / 复利总回报</span><span class="tt-val">${r.roiic3yPct != null ? fmtPct(r.roiic3yPct, 1, true) : "--"} (留存${r.reinvestRatePct != null ? r.reinvestRatePct.toFixed(0) + "%" : "--"}) / ${r.bogleRet3y != null ? fmtPct(r.bogleRet3y, 1, true) : "--"} [${esc(r.qualityArchetype || "均衡白马")}]</span></div>
        <div class="tt-row"><span class="tt-lbl">应计比率 / 应收占比</span><span class="tt-val">${r.accrualRatio != null ? fmtPct(r.accrualRatio, 1, true) : "--"} / ${r.arToRevPct != null ? r.arToRevPct.toFixed(1) + "%" : (r.isFinancial ? "金融免算" : "--")}</span></div>
        <div class="tt-row"><span class="tt-lbl">EV/EBIT (3Y/5Y · 水位)</span><span class="tt-val">${r.isFinancial ? "金融免算" : `${r.evToEbit3y != null ? r.evToEbit3y.toFixed(1) + "x" : "--"} / ${r.evToEbit5y != null ? r.evToEbit5y.toFixed(1) + "x" : "--"} · 水位 ${r.ebitCyclePos != null ? r.ebitCyclePos.toFixed(2) + "x" : "--"} (${r.evDebtBasis})`}</span></div>
        <div class="tt-row"><span class="tt-lbl">Δ毛利 / ΔROE / 抗寒</span><span class="tt-val">${r.qGmYoyPp != null ? fmtPct(r.qGmYoyPp, 1, true).replace("%", "pp") : (r.isFinancial ? "金融--" : "--")} / ${r.deltaRoeMarginPp != null ? fmtPct(r.deltaRoeMarginPp, 1, true).replace("%", "pp") : "--"} · 保障 ${r.interestCoverage != null ? r.interestCoverage.toFixed(1) + "x" : "--"} (现金/债 ${r.cashToDebtPct != null ? r.cashToDebtPct.toFixed(0) + "%" : "--"})</span></div>
        <div class="tt-row"><span class="tt-lbl">PEG / PSG / 加速度</span><span class="tt-val">${r.peg3y != null ? r.peg3y.toFixed(2) + "x" : "--"} / ${r.psg != null ? r.psg.toFixed(2) + "x" : "--"} · 加速度 ${r.npAccelPp != null ? fmtPct(r.npAccelPp, 1, true).replace("%", "pp") : "--"}</span></div>
        <div class="tt-row"><span class="tt-lbl">营收3Y/1Y · 研发/FCF率</span><span class="tt-val">${r.revCagr3y != null ? fmtPct(r.revCagr3y, 1, true) : "--"} / ${r.revYoy1yRaw != null ? fmtPct(r.revYoy1yRaw, 1, true) : "--"} · ${r.isFinancial ? "金融免算" : `研发 ${r.rdRatioPct != null ? r.rdRatioPct.toFixed(1) + "%" : "--"} · FCF率 ${r.fcfMargin3y != null ? r.fcfMargin3y.toFixed(1) + "%" : "--"}`}</span></div>
        <div class="tt-row"><span class="tt-lbl">3Y/5Y 均 ROE/PB</span><span class="tt-val">${r.roeToPb3y != null ? r.roeToPb3y.toFixed(1) + "%" : "--"} / ${r.roeToPb5y != null ? r.roeToPb5y.toFixed(1) + "%" : "--"} (3Y ROE ${r.roeMean3y != null ? r.roeMean3y.toFixed(1) + "%" : "--"} · 均PB ${r.pb3yAvg != null ? r.pb3yAvg.toFixed(2) + "x" : "--"})</span></div>
        <div class="tt-row"><span class="tt-lbl">增速 (5Y→1Y)</span><span class="tt-val">${esc(g5Val)} → ${esc(g1Val)}${esc(gDir)}</span></div>
        <div class="tt-row"><span class="tt-lbl">负债率 / 净现金比</span><span class="tt-val">${esc(debtStr)}${!r.isFinancial && r.estIbDebtRatioPct != null ? ` (有息≈${r.estIbDebtRatioPct.toFixed(0)}%)` : ""} / ${esc(ncStr)}</span></div>
        <div class="tt-row"><span class="tt-lbl">3Y波动 / 最大回撤</span><span class="tt-val">${esc(vol3Str)} / ${esc(dd3Str)}</span></div>
        <div style="margin-top:4px;font-size:10px;opacity:0.75;">点击气泡进入个股深度看板 →</div>
      `;
      tt.style.display = "block";
      const tw = Math.min(tt.offsetWidth || 250, w - 12);
      const th = tt.offsetHeight || 220;
      const rawTx = b.cx + b.r + 14 + tw > w ? (b.cx - b.r - tw - 14) : (b.cx + b.r + 14);
      const tx = clamp(rawTx, 6, Math.max(6, w - tw - 6));
      const ty = clamp(b.cy - th / 2, 6, Math.max(6, h - th - 6));
      tt.style.left = `${tx}px`;
      tt.style.top = `${ty}px`;
      document.querySelectorAll(`#cmp-tbody tr[data-cmp-row]`).forEach(tr => {
        tr.classList.toggle("is-hover", tr.dataset.cmpRow === code);
      });
    };
    dot.addEventListener("mouseenter", showTip);
    dot.addEventListener("mouseleave", () => {
      tt.style.display = "none";
      document.querySelectorAll(`#cmp-tbody tr.is-hover`).forEach(tr => tr.classList.remove("is-hover"));
    });
    dot.addEventListener("click", () => compareHandlers.onOpenStock?.(code, false));
  });
}

export function renderCompareTable(rows) {
  const thead = document.getElementById("cmp-thead");
  const tbody = document.getElementById("cmp-tbody");
  if (!thead || !tbody) return;

  const hz = STATE.compare.horizon || "ttm";
  const isDivMode = STATE.compare.researchMode === "dividend";
  const isQualMode = STATE.compare.researchMode === "quality";
  const isCycleMode = STATE.compare.researchMode === "cycle";
  const isGrowthMode = STATE.compare.researchMode === "growth";
  const elMode = STATE.compare.divElasticityMode || "dps_cagr";
  const cycInflect = STATE.compare.cycleInflectAxis || "gm_yoy";
  const grVal = STATE.compare.growthValAxis || "peg";
  const allFinTbl = rows.length > 0 && rows.every(r => r.isFinancial);
  const peKey = hz === "5y" ? "pe5yNorm" : (hz === "3y" ? "pe3yNorm" : "peTtm");
  const peLbl = hz === "5y" ? "5Y均利PE (5Y均PE)" : (hz === "3y" ? "3Y均利PE (3Y均PE)" : "PE_TTM (5Y分位)");
  const evEbitKey = hz === "5y" ? "evToEbit5y" : (hz === "3y" ? "evToEbit3y" : "evToEbitTtm");
  const evEbitLbl = hz === "5y" ? "5Y EV/EBIT (水位)" : (hz === "3y" ? "3Y EV/EBIT (水位)" : "EV/EBIT (周期水位)");
  const cycEdgeKey = cycInflect === "roe_delta" ? "deltaRoeMarginPp" : "qGmYoyPp";
  const cycEdgeLbl = cycInflect === "roe_delta" ? "ΔROE边际 (Δ毛利)" : "单季Δ毛利 (ΔROE)";
  const pegPsgKey = grVal === "psg" ? "psg" : "peg3y";
  const pegPsgLbl = grVal === "psg" ? "PSG (PS/营收增速)" : "PEG (3Y增速/加速)";
  const pbLbl = hz === "ttm" ? "PB (5Y分位)" : (hz === "3y" ? "PB (3Y均值)" : "PB (5Y均值)");
  const rpbKey = hz === "5y" ? "roeToPb5y" : (hz === "3y" ? "roeToPb3y" : "roeToPbTtm");
  const rpbLbl = hz === "5y" ? "5Y均ROE/PB (稳定)" : (hz === "3y" ? "3Y均ROE/PB (稳定)" : "ROE/PB (3Y/5Y均)");
  const covKey = hz === "3y" ? "fcf3yDivCoverage" : "fcfDivCoverage";
  const covLbl = allFinTbl
    ? (hz === "3y" ? "3Y盈利覆盖 (派息率)" : "盈利覆盖 (派息率)")
    : (hz === "3y" ? "3Y覆盖倍数 (CapEx/OCF)" : "FCF覆盖倍数 (CapEx/OCF)");
  const elKey = elMode === "forward_pot" ? "divElasticityForward" : "divCagr3y";
  const elLbl = elMode === "forward_pot" ? "提息潜能 (3Y DPS)" : "DPS 3Y增速 (提息潜能)";
  const fcfKey = hz === "5y" ? "fcf5yYieldPct" : (hz === "3y" ? "fcf3yYieldPct" : "fcfYieldPct");
  const fcfLbl = hz === "5y" ? "5Y均FCF (5Y净现比)" : (hz === "3y" ? "3Y均FCF (3Y净现比)" : "FCF收益 (5Y净现比)");
  const roicKey = hz === "3y" ? "roic3yMean" : "roic5yMean";
  const roicLbl = hz === "3y" ? "3Y ROIC (3Y波动)" : "5Y ROIC (5Y波动)";
  const roiicKey = hz === "5y" ? "roiic5yPct" : "roiic3yPct";
  const roiicLbl = hz === "5y" ? "5Y再投资ROIIC (类型)" : "3Y再投资ROIIC (类型)";

  const colMap = {
    code: { key: "code", label: "代码", align: "left", sortable: true },
    name: { key: "name", label: "简称", align: "left", sortable: false },
    mktCap: { key: "mktCap", label: "总市值", align: "", sortable: true },
    unadjPrice: { key: "unadjPrice", label: "不复权价", align: "", sortable: true },
    pe: { key: peKey, label: peLbl, align: "", sortable: true },
    evEbit: { key: evEbitKey, label: evEbitLbl, align: "", sortable: true },
    cycEdge: { key: cycEdgeKey, label: cycEdgeLbl, align: "", sortable: true },
    pb: { key: "pb", label: pbLbl, align: "", sortable: true },
    rpb: { key: rpbKey, label: rpbLbl, align: "", sortable: true },
    sh: { key: "shareholderYieldPct", label: "股东回报 (股息/净回购)", align: "", sortable: true },
    dst: { key: "divStabilityScore", label: "分红稳定性", align: "", sortable: true },
    cov: { key: covKey, label: covLbl, align: "", sortable: true },
    el: { key: elKey, label: elLbl, align: "", sortable: true },
    fcf: { key: fcfKey, label: fcfLbl, align: "", sortable: true },
    roic: { key: roicKey, label: roicLbl, align: "", sortable: true },
    roiic: { key: roiicKey, label: roiicLbl, align: "", sortable: true },
    qual: { key: "accrualRatio", label: "应计 / 应收比", align: "", sortable: true },
    pegPsg: { key: pegPsgKey, label: pegPsgLbl, align: "", sortable: true },
    grQuality: { key: "revYoy1y", label: "营收增速 (研发/FCF率)", align: "", sortable: true },
    g1Base: { key: "g1Base", label: "5Y→1Y净利增速", align: "", sortable: true },
    dcf: { key: "dcfUpsidePct", label: "绝对估值 (口径/空间)", align: "", sortable: true },
    rim: { key: "rimUpsidePct", label: "RIM估值 (空间)", align: "", sortable: true },
    irr: { key: "impliedIrr", label: "隐含回报 IRR", align: "", sortable: true },
    debt: { key: "debtRatioPct", label: "负债 / 净现金比", align: "", sortable: true },
    vol: { key: "vol3y", label: "3Y波动 / 回撤", align: "", sortable: true },
    actions: { key: "actions", label: "操作", align: "center", sortable: false }
  };

  const order = isDivMode
    ? ["code", "name", "mktCap", "unadjPrice", "sh", "dst", "cov", "el", "vol", "pe", "pb", "rpb", "fcf", "roic", "roiic", "qual", "pegPsg", "grQuality", "evEbit", "cycEdge", "g1Base", "dcf", "rim", "irr", "debt", "actions"]
    : (isQualMode
      ? ["code", "name", "mktCap", "unadjPrice", "roic", "roiic", "irr", "rpb", "fcf", "qual", "pe", "pb", "pegPsg", "grQuality", "evEbit", "cycEdge", "g1Base", "dcf", "rim", "debt", "sh", "vol", "dst", "cov", "el", "actions"]
      : (isCycleMode
        ? ["code", "name", "mktCap", "unadjPrice", "evEbit", "pb", "cycEdge", "debt", "pe", "rpb", "roic", "roiic", "fcf", "qual", "pegPsg", "grQuality", "g1Base", "dcf", "rim", "irr", "vol", "sh", "dst", "cov", "el", "actions"]
        : ["code", "name", "mktCap", "unadjPrice", "pegPsg", "g1Base", "grQuality", "roic", "roiic", "pe", "fcf", "qual", "dcf", "irr", "sh", "debt", "vol", "pb", "rpb", "evEbit", "cycEdge", "rim", "dst", "cov", "el", "actions"]));
  const cols = order.map(k => colMap[k]);

  thead.innerHTML = `<tr>${cols.map(c => {
    const active = STATE.compare.sortBy === c.key;
    const arrow = active ? (STATE.compare.sortDir === "asc" ? " ▲" : " ▼") : "";
    const cls = [c.align, c.sortable ? "sortable" : "", active ? "sort-active" : ""].filter(Boolean).join(" ");
    return `<th class="${cls}" ${c.sortable ? `data-cmp-sort="${esc(c.key)}"` : ""}>${esc(c.label)}${arrow}</th>`;
  }).join("")}</tr>`;

  thead.querySelectorAll("th[data-cmp-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.cmpSort;
      if (STATE.compare.sortBy === k) {
        STATE.compare.sortDir = STATE.compare.sortDir === "desc" ? "asc" : "desc";
      } else {
        STATE.compare.sortBy = k;
        STATE.compare.sortDir = (k === "peTtm" || k === "pe3yNorm" || k === "pe5yNorm" || k === "evToEbitTtm" || k === "evToEbit3y" || k === "evToEbit5y" || k === "peg3y" || k === "psg" || k === "pb" || k === "code" || k === "vol3y" || k === "debtRatioPct") ? "asc" : "desc";
      }
      renderCompareResults();
    });
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="center flat" style="padding:28px;">${STATE.compare.loading ? "正在并发拉取并计算同业数据…" : "暂无可展示的对比数据"}</td></tr>`;
    return;
  }

  const sk = STATE.compare.sortBy;
  const sdir = STATE.compare.sortDir === "asc" ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    const va = a[sk];
    const vb = b[sk];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string") return va.localeCompare(vb) * sdir;
    return (va - vb) * sdir;
  });

  const fmtUpsideCell = (val, up, subPrefix = "") => {
    if (val == null) return `<span class="flat">--</span>`;
    const cls = up == null ? "flat" : (up >= 15 ? "down" : (up <= -10 ? "up" : "flat"));
    const color = up == null ? "var(--ink-faint)" : (up >= 15 ? "var(--emerald)" : (up <= -10 ? "var(--crimson)" : "var(--ink-muted)"));
    const sub = `${subPrefix ? subPrefix + " · " : ""}${up != null ? fmtPct(up, 1, true) : "--"}`;
    return `<strong>¥${fmtNum(val)}</strong><br><small class="${cls}" style="color:${color};font-size:10.5px;">${esc(sub)}</small>`;
  };

  tbody.innerHTML = sorted.map(r => {
    const peMainVal = r[peKey];
    const peSub = hz === "5y"
      ? (r.pe5yAvg != null ? `5Y均PE ${fmtNum(r.pe5yAvg, 1)}x` : "--")
      : (hz === "3y"
        ? (r.pe3yAvg != null ? `3Y均PE ${fmtNum(r.pe3yAvg, 1)}x` : "--")
        : (r.pePct5y != null ? `${r.pePct5y.toFixed(0)}% 分位` : "--"));
    const pbSub = hz === "5y"
      ? (r.pb5yAvg != null ? `5Y均 ${fmtNum(r.pb5yAvg, 2)}x` : "--")
      : (hz === "3y"
        ? (r.pb3yAvg != null ? `3Y均 ${fmtNum(r.pb3yAvg, 2)}x` : "--")
        : (r.pbPct5y != null ? `${r.pbPct5y.toFixed(0)}% 分位` : "--"));
    const rpbMain = r[rpbKey];
    const rpbVolRef = hz === "5y" ? r.roeVol5y : (r.roeVol3y ?? r.roeVol5y);
    const rpbColor = rpbMain == null
      ? "var(--ink-faint)"
      : ((rpbMain >= (r.rUsed || 8) && (rpbVolRef == null || rpbVolRef <= 5))
        ? "var(--emerald)"
        : (rpbMain < 4 ? "var(--crimson)" : "var(--ink)"));
    const rpbSub = hz === "5y"
      ? `5Y ROE ${r.roeMean5y != null ? r.roeMean5y.toFixed(1) + "%" : "--"} · 波动±${r.roeVol5y != null ? r.roeVol5y.toFixed(1) + "%" : "--"}`
      : (hz === "3y"
        ? `3Y ROE ${r.roeMean3y != null ? r.roeMean3y.toFixed(1) + "%" : "--"} · 波动±${(r.roeVol3y ?? r.roeVol5y) != null ? (r.roeVol3y ?? r.roeVol5y).toFixed(1) + "%" : "--"}`
        : `3Y均 ${r.roeToPb3y != null ? r.roeToPb3y.toFixed(1) + "%" : "--"} · 5Y均 ${r.roeToPb5y != null ? r.roeToPb5y.toFixed(1) + "%" : "--"}`);
    const divTxt = r.divYieldPct != null ? `股息${r.divYieldPct.toFixed(1)}%` : "股息--";
    const bbVal = r.buybackYieldPct || 0;
    const bbHtml = bbVal >= 0.05
      ? `<span style="color:var(--emerald);">+回购${bbVal.toFixed(2)}%</span>`
      : (bbVal <= -0.05
        ? `<span style="color:var(--crimson);">稀释${bbVal.toFixed(2)}%</span>`
        : (r.payoutPct != null ? `·派息${r.payoutPct.toFixed(0)}%` : ""));
    const shColor = (r.shareholderYieldPct != null && r.shareholderYieldPct < 0) ? "color:var(--crimson);" : "";
    const fcfMain = r[fcfKey];
    const ccHorizon = hz === "3y" ? (r.cashConv3y ?? r.cashConv5y) : r.cashConv5y;
    const fcfSub = ccHorizon != null ? `${hz === "3y" ? "3Y" : "5Y"}净现 ${ccHorizon.toFixed(2)}x` : `${hz === "3y" ? "3Y" : "5Y"}净现 --`;
    const roicMain = r[roicKey];
    const roicVolShow = hz === "3y" ? (r.roeVol3y ?? r.roeVol5y) : r.roeVol5y;
    const roicSub = `${r.roicIsRoeProxy ? "ROE口径" : (r.roicDebtBasis || "剔杠杆")} · 波动${roicVolShow != null ? roicVolShow.toFixed(1) + "%" : "--"}`;
    const roicTitleAttr = ` title="${esc(`ROIC 投入资本口径: ${r.roicDebtBasis || "--"}；权益口径: ${r.equityBasis || "--"}`)}"`;
    const roiicMain = r[roiicKey];
    const roiicColor = roiicMain == null ? "var(--ink-faint)" : (roiicMain >= 15 ? "var(--emerald)" : (roiicMain < 0 ? "var(--crimson)" : "var(--ink)"));
    const roiicSub = `${r.qualityArchetype || "均衡白马"}${r.reinvestRatePct != null ? ` · 留存${r.reinvestRatePct.toFixed(0)}%` : ""}`;
    const bogleValShow = hz === "5y" ? (r.bogleRet5y ?? r.bogleRet3y) : (r.bogleRet3y ?? r.bogleRet5y);
    const roiicTitleAttr = ` title="${esc(`留存再投资增量回报 ROIIC = Δ归母净利 ÷ 累计留存净利；长期复利总回报(股东回报+g) = ${bogleValShow != null ? fmtPct(bogleValShow, 1, true) : "--"}`)}"`;
    const g1Sub = r.npYoy1yRaw != null ? `1Y ${fmtPct(r.npYoy1yRaw, 1, true)}` : "1Y --";
    const irrColor = r.impliedIrr == null ? "var(--ink-faint)" : (r.impliedIrr >= (r.rUsed || 8) ? "var(--emerald)" : "var(--crimson)");
    const debtTxt = r.debtRatioPct != null ? `${r.debtRatioPct.toFixed(0)}%` : "--";
    const ncSub = r.netCashToMktCap != null ? `净现 ${fmtPct(r.netCashToMktCap, 0, true)}` : "净现 --";
    const debtTitleAttr = !r.isFinancial
      ? ` title="${esc(`总负债率 ${debtTxt}，估算有息负债率 ${r.estIbDebtRatioPct != null ? r.estIbDebtRatioPct.toFixed(1) + "%" : "--"}（OPM 行业高总负债多为无息应付/预收）`)}"`
      : "";
    const volTxt = r.vol3y != null ? `${r.vol3y.toFixed(1)}%` : "--";
    const ddSub = r.maxDd3y != null ? `回撤 ${r.maxDd3y.toFixed(0)}%` : "--";
    const effRisk = isDivMode ? r.divRiskFlag : (isQualMode ? r.qualityRiskFlag : (isCycleMode ? r.cycleRiskFlag : (isGrowthMode ? r.growthRiskFlag : r.riskFlag)));
    const riskMark = isDivMode
      ? (effRisk === "low_vol"
        ? `<span style="color:var(--emerald);font-weight:600;">[真红利] </span>`
        : (effRisk === "high_risk" ? `<span style="color:var(--crimson);font-weight:600;">[排雷] </span>` : ""))
      : (isQualMode
        ? (effRisk === "low_vol"
          ? `<span style="color:var(--emerald);font-weight:600;">[白马] </span>`
          : (effRisk === "high_risk" ? `<span style="color:var(--crimson);font-weight:600;">[排雷] </span>` : ""))
        : (isCycleMode
          ? (effRisk === "low_vol"
            ? `<span style="color:var(--emerald);font-weight:600;">[拐点] </span>`
            : (effRisk === "high_risk" ? `<span style="color:var(--crimson);font-weight:600;">[半山腰] </span>` : ""))
          : (isGrowthMode
            ? (effRisk === "low_vol"
              ? `<span style="color:var(--emerald);font-weight:600;">[双击] </span>`
              : (effRisk === "high_risk" ? `<span style="color:var(--crimson);font-weight:600;">[排雷] </span>` : ""))
            : (effRisk === "low_vol"
              ? `<span style="color:var(--emerald);font-weight:600;">[低波] </span>`
              : (effRisk === "high_risk" ? `<span style="color:var(--crimson);font-weight:600;">[预警] </span>` : "")))));
    const covVal = r[covKey];
    const covColor = covVal == null ? "var(--ink-faint)" : (covVal >= 1.2 ? "var(--emerald)" : (covVal < 1.0 ? "var(--crimson)" : "var(--ink)"));
    const covSub = r.fcfCoverageIsProfitProxy
      ? `${r.payoutBasis && r.payoutBasis.includes("普通股") ? "普通股盈利" : "盈利覆盖"} · 派息${r.payoutPct != null ? r.payoutPct.toFixed(0) + "%" : "--"}`
      : `CapEx/OCF ${r.capexToOcfPct != null ? r.capexToOcfPct.toFixed(0) + "%" : "--"}`;
    const shTitleParts = [];
    if (r.divEventsDetail) shTitleParts.push(r.divEventsDetail);
    if (Math.abs(bbVal) >= 0.05) {
      shTitleParts.push(`${bbVal >= 0 ? "净回购" : "净稀释"}: ${bbVal >= 0 ? "+" : ""}${bbVal.toFixed(2)}% (${r.buybackSource}${r.buybackNote ? "·" + r.buybackNote : ""})`);
    }
    const shTitleAttr = shTitleParts.length ? ` title="${esc(shTitleParts.join("\n"))}"` : "";
    const covTitleTxt = r.fcfCoverageIsProfitProxy
      ? `金融股不适用实业FCF，采用「${r.payoutBasis || "TTM"}净利 ÷ 现金分红」≈ 1 ÷ 派息率，倍数越高代表留存收益缓冲越厚`
      : `FCF ÷ (现金分红 + 净回购)，≥1.0x 表示自由现金流全覆盖`;
    const covTitleAttr = ` title="${esc(covTitleTxt)}"`;
    const elMain = r[elKey];
    const elAlt = elMode === "forward_pot"
      ? `3Y DPS ${r.divCagr3y != null ? fmtPct(r.divCagr3y, 1, true) : "--"}`
      : `潜能 ${r.divElasticityForward != null ? fmtPct(r.divElasticityForward, 1, true) : "--"}`;
    const dstColor = r.divStabilityScore >= 75
      ? "var(--emerald)"
      : (r.divStabilityScore >= 50 ? "var(--ink)" : (r.divStabilityScore > 0 ? "var(--crimson)" : "var(--ink-faint)"));
    const dstSub = r.divStabilityScore > 0
      ? `连分${r.divConsecYears ?? 0}年${r.divCv5y != null ? ` · CV ${r.divCv5y.toFixed(2)}` : ""}${r.divCutCount5y > 0 ? ` · 缩水${r.divCutCount5y}次` : ""}`
      : "近5年无稳定派息";
    const dstTrap = r.divYieldTrap ? `<span style="color:#D97706;font-weight:600;">[慎] </span>` : "";

    const evEbitVal = r[evEbitKey];
    const evEbitSub = r.isFinancial
      ? "金融免算"
      : (r.ebitCyclePos != null ? `水位 ${r.ebitCyclePos.toFixed(2)}x · ${r.evDebtBasis}` : r.evDebtBasis);
    const evEbitTitle = r.isFinancial
      ? "金融行业不适用 EV/EBIT"
      : `EV 口径: ${r.evDebtBasis} (有息负债分项缺失时按总负债近似)；水位 = 当期 TTM EBIT ÷ ${hz === "3y" ? "3年" : "5年"}均化 EBIT (>1.5x 防高景气接盘)`;
    const cycEdgeMain = r[cycEdgeKey];
    const cycEdgeColor = cycEdgeMain == null ? "var(--ink-faint)" : (cycEdgeMain > 0 ? "var(--emerald)" : (cycEdgeMain < -3 ? "var(--crimson)" : "var(--ink)"));
    const cycEdgeAlt = cycInflect === "roe_delta"
      ? `Δ毛利 ${r.qGmYoyPp != null ? fmtPct(r.qGmYoyPp, 1, true).replace("%", "pp") : "--"}`
      : `ΔROE ${r.deltaRoeMarginPp != null ? fmtPct(r.deltaRoeMarginPp, 1, true).replace("%", "pp") : "--"}`;
    const cycCapexTxt = r.capexToRevPct != null ? ` · CapEx ${r.capexToRevPct.toFixed(0)}%` : "";
    const pegVal = r[pegPsgKey];
    const pegColor = pegVal == null
      ? "var(--ink-faint)"
      : (grVal === "psg"
        ? (pegVal <= 0.22 ? "var(--emerald)" : (pegVal > 0.45 ? "var(--crimson)" : "var(--ink)"))
        : (pegVal <= 1.2 ? "var(--emerald)" : (pegVal > 2.2 ? "var(--crimson)" : "var(--ink)")));
    const pegSub = grVal === "psg"
      ? `PS ${r.psTtm != null ? r.psTtm.toFixed(1) + "x" : "--"} · 3Y营收 ${r.revCagr3y != null ? fmtPct(r.revCagr3y, 1, true) : "--"}`
      : `加速度 ${r.npAccelPp != null ? fmtPct(r.npAccelPp, 1, true).replace("%", "pp") : "--"}${r.psg != null ? ` · PSG ${r.psg.toFixed(2)}x` : ""}`;
    const revSub = r.isFinancial
      ? `3Y营收 ${r.revCagr3y != null ? fmtPct(r.revCagr3y, 1, true) : "--"} · 金融免算`
      : `研发 ${r.rdRatioPct != null ? r.rdRatioPct.toFixed(1) + "%" : "--"} · FCF率 ${r.fcfMargin3y != null ? r.fcfMargin3y.toFixed(1) + "%" : "--"}`;

    const cellHtml = {
      code: `<td class="left mono"><strong>${esc(r.code)}</strong></td>`,
      name: `<td class="left">${esc(r.name)}</td>`,
      mktCap: `<td class="mono">${esc(fmtMoneyShort(r.mktCap))}</td>`,
      unadjPrice: `<td class="mono">¥${fmtNum(r.unadjPrice)}</td>`,
      [peKey]: `<td>${peMainVal != null ? `<strong>${fmtNum(peMainVal, 1)}x</strong><br><small class="flat" style="font-size:10.5px;">${peSub}</small>` : `<span class="flat">亏损/无</span>`}</td>`,
      [evEbitKey]: `<td title="${esc(evEbitTitle)}">${evEbitVal != null ? `<strong>${fmtNum(evEbitVal, 1)}x</strong><br><small class="flat" style="font-size:10.5px;">${esc(evEbitSub)}</small>` : `<span class="flat">${r.isFinancial ? "金融免算" : "亏损/无"}</span>`}</td>`,
      [cycEdgeKey]: `<td class="mono"><strong style="color:${cycEdgeColor};">${cycEdgeMain != null ? fmtPct(cycEdgeMain, 1, true).replace("%", "pp") : "--"}</strong><br><small class="flat" style="font-size:10.5px;">${esc(cycEdgeAlt + cycCapexTxt)}</small></td>`,
      [pegPsgKey]: `<td class="mono"><strong style="color:${pegColor};">${pegVal != null ? pegVal.toFixed(2) + "x" : "--"}</strong><br><small class="flat" style="font-size:10.5px;">${esc(pegSub)}</small></td>`,
      revYoy1y: `<td class="mono ${clsSign(r.revYoy1yRaw)}"><strong>${r.revYoy1yRaw != null ? fmtPct(r.revYoy1yRaw, 1, true) : "--"}</strong><br><small class="flat" style="font-size:10.5px;">${esc(revSub)}</small></td>`,
      pb: `<td>${r.pb != null ? `<strong>${fmtNum(r.pb, 2)}x</strong><br><small class="flat" style="font-size:10.5px;">${pbSub}</small>` : `--`}</td>`,
      [rpbKey]: `<td>${rpbMain != null ? `<strong style="color:${rpbColor};">${rpbMain.toFixed(1)}%</strong><br><small class="flat" style="font-size:10.5px;">${esc(rpbSub)}</small>` : `<span class="flat">--</span><br><small class="flat" style="font-size:10.5px;">${esc(rpbSub)}</small>`}</td>`,
      shareholderYieldPct: `<td${shTitleAttr}>${r.shareholderYieldPct != null ? `<strong style="${shColor}">${r.shareholderYieldPct.toFixed(2)}%</strong><br><small class="flat" style="font-size:10.5px;">${esc(divTxt)}${bbHtml}</small>` : `--`}</td>`,
      divStabilityScore: `<td>${dstTrap}<strong style="color:${dstColor};">${r.divStabilityScore ?? 0}分 ${esc(r.divStabilityGrade || "无分红")}</strong><br><small class="flat" style="font-size:10.5px;">${esc(dstSub)}</small></td>`,
      [covKey]: `<td${covTitleAttr}>${covVal != null ? `<strong style="color:${covColor};">${covVal.toFixed(2)}x</strong><br><small class="flat" style="font-size:10.5px;">${esc(covSub)}</small>` : `<span class="flat">--</span><br><small class="flat" style="font-size:10.5px;">${esc(covSub)}</small>`}</td>`,
      [elKey]: `<td class="mono ${clsSign(elMain)}"><strong>${elMain != null ? fmtPct(elMain, 1, true) : "--"}</strong><br><small class="flat" style="font-size:10.5px;">${esc(elAlt)}</small></td>`,
      [fcfKey]: `<td>${fcfMain != null ? `<strong>${fcfMain.toFixed(1)}%</strong><br><small class="flat" style="font-size:10.5px;">${esc(fcfSub)}</small>` : `<span class="flat">--</span><br><small class="flat" style="font-size:10.5px;">${esc(fcfSub)}</small>`}</td>`,
      [roicKey]: `<td${roicTitleAttr}>${roicMain != null ? `<strong>${roicMain.toFixed(1)}%</strong><br><small class="flat" style="font-size:10.5px;">${esc(roicSub)}</small>` : `--`}</td>`,
      [roiicKey]: `<td${roiicTitleAttr} class="mono">${roiicMain != null ? `<strong style="color:${roiicColor};">${fmtPct(roiicMain, 1, true)}</strong><br><small class="flat" style="font-size:10.5px;">${esc(roiicSub)}</small>` : `--`}</td>`,
      accrualRatio: `<td>${r.accrualRatio != null ? `<strong style="color:${r.accrualRatio > 8 ? "var(--crimson)" : (r.accrualRatio <= 2 ? "var(--emerald)" : "var(--ink)")};">${fmtPct(r.accrualRatio, 1, true)}</strong>` : `<span class="flat">--</span>`}<br><small class="flat" style="font-size:10.5px;">${r.arToRevPct != null ? `应收 ${r.arToRevPct.toFixed(1)}%` : (r.isFinancial ? "金融免算" : "应收 --")}</small></td>`,
      g1Base: `<td class="mono ${clsSign(r.g1Base)}"><strong>${r.g1Base != null ? fmtPct(r.g1Base, 1, true) : "--"}</strong><br><small class="flat" style="font-size:10.5px;">${esc(g1Sub)}</small></td>`,
      dcfUpsidePct: `<td>${fmtUpsideCell(r.dcfMid, r.dcfUpsidePct, r.dcfBaseLabel)}</td>`,
      rimUpsidePct: `<td>${fmtUpsideCell(r.rimMid, r.rimUpsidePct)}</td>`,
      impliedIrr: `<td class="mono" style="font-weight:700;color:${irrColor};">${r.impliedIrr != null ? r.impliedIrr.toFixed(2) + "%" : "--"}<br><small class="flat" style="font-weight:400;font-size:10px;">r=${r.rUsed != null ? r.rUsed.toFixed(2) + "%" : "--"}</small></td>`,
      debtRatioPct: `<td class="mono"${debtTitleAttr}>${esc(debtTxt)}<br><small class="flat" style="font-size:10.5px;">${esc(ncSub)}</small></td>`,
      vol3y: `<td class="mono">${riskMark}${esc(volTxt)}<br><small class="flat" style="font-size:10.5px;">${esc(ddSub)}</small></td>`,
      actions: `<td class="center"><button type="button" class="btn-mini" data-cmp-open="${esc(r.code)}">看板→</button><button type="button" class="btn-mini" data-cmp-rm="${esc(r.code)}" style="margin-left:3px;">移除</button></td>`
    };
    return `<tr data-cmp-row="${esc(r.code)}">${cols.map(c => cellHtml[c.key] || "<td>--</td>").join("")}</tr>`;
  }).join("");

  tbody.querySelectorAll("tr[data-cmp-row]").forEach(tr => {
    const code = tr.dataset.cmpRow;
    tr.addEventListener("mouseenter", () => {
      document.querySelectorAll("#cmp-scatter-svg .scatter-dot").forEach(d => {
        d.classList.toggle("is-active", d.dataset.cmpDot === code);
      });
    });
    tr.addEventListener("mouseleave", () => {
      document.querySelectorAll("#cmp-scatter-svg .scatter-dot.is-active").forEach(d => d.classList.remove("is-active"));
    });
  });
  tbody.querySelectorAll("[data-cmp-open]").forEach(btn => {
    btn.addEventListener("click", () => compareHandlers.onOpenStock?.(btn.dataset.cmpOpen, false));
  });
  tbody.querySelectorAll("[data-cmp-rm]").forEach(btn => {
    btn.addEventListener("click", () => removeCompareStock(btn.dataset.cmpRm, true));
  });
}

export function renderCompareResults() {
  syncCompareControls();
  const rows = getCompareRows();
  renderCompareScatter(rows);
  renderCompareTable(rows);
}

export async function performCompareSearch() {
  const inp = document.getElementById("cmp-search-input");
  const dd = document.getElementById("cmp-search-dropdown");
  if (!inp || !dd) return;
  const q = inp.value.trim();
  if (!q) {
    dd.classList.add("hidden");
    return;
  }
  try {
    const res = await quantFetch("/api/stocks", { q, limit: 15 });
    const items = res.items || [];
    if (!items.length) {
      dd.innerHTML = `<div class="search-opt flat">未找到匹配 “${esc(q)}” 的标的</div>`;
    } else {
      dd.innerHTML = items.map(it => {
        const metaTxt = [it.exchange || "--", it.sw_l2_name || it.sw_l1_name].filter(Boolean).join(" · ");
        return `
        <div class="search-opt" data-cmp-pick="${esc(it.thscode)}" data-cmp-pick-name="${esc(it.name || it.ticker || "")}">
          <span><strong>${esc(it.thscode)}</strong> · ${esc(it.name || it.ticker)}</span>
          <span class="mini-pill">${esc(metaTxt)}</span>
        </div>
      `;
      }).join("");
      dd.querySelectorAll(".search-opt[data-cmp-pick]").forEach(el => {
        el.addEventListener("click", () => {
          const c = el.dataset.cmpPick;
          const nm = el.dataset.cmpPickName;
          inp.value = "";
          dd.classList.add("hidden");
          addCompareStock(c, nm, true);
        });
      });
    }
    dd.classList.remove("hidden");
  } catch {
    dd.classList.add("hidden");
  }
}
