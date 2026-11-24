import { esc, fmtNum, fmtPct, fmtMoneyShort, clsSign, median, clamp } from "./utils.js";
import { STATE, PEER_PRESETS, saveWatchlist, saveCompareList } from "./state.js";
import { quantFetch, fetchFinancialsChecked } from "./api.js";
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

export function syncCompareControls() {
  const cmp = STATE.compare;
  document.querySelectorAll("#seg-cmp-r-mode button").forEach(b => b.classList.toggle("active", b.dataset.val === cmp.rMode));
  document.querySelectorAll("#seg-cmp-scenario button").forEach(b => b.classList.toggle("active", b.dataset.val === cmp.scenario));
  document.querySelectorAll("#seg-cmp-scatter button").forEach(b => b.classList.toggle("active", b.dataset.val === cmp.scatterMode));
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
}

export async function fetchOneComparePeer(code, forceFresh = false) {
  const enc = encodeURIComponent(code);
  const [fin, kNone, kFwd] = await Promise.all([
    forceFresh ? quantFetch(`/api/stocks/${enc}/financials`, { limit: 40 }, { fresh: true }) : fetchFinancialsChecked(code, 40),
    quantFetch(`/api/stocks/${enc}/kline`, { adjust: "none", limit: 1250 }, forceFresh ? { fresh: true } : undefined),
    quantFetch(`/api/stocks/${enc}/kline`, { adjust: "forward", limit: 260 }, forceFresh ? { fresh: true } : undefined)
  ]);
  const snap = evaluateStockValuation({
    finData: fin,
    kUnadj: kNone,
    kAdj: kFwd,
    valWindow: 1250,
    valAlignMode: STATE.stock.valAlignMode || "pit",
    dcfRMode: STATE.compare.rMode
  });
  if (snap.name) STATE.compare.names[code] = snap.name;
  STATE.compare.cache[code] = { fin, kNone, kFwd, snap };
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
  let lo = Math.min(...clean);
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
  if (forceZeroMin) lo = Math.max(0, lo);
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

  const mode = STATE.compare.scatterMode || "pb_roe";
  const configs = {
    pb_roe: {
      xLabel: "TTM ROE (%)",
      yLabel: "市净率 PB (倍)",
      subtitle: "横轴 TTM ROE · 纵轴 PB · 虚线为 PB = ROE / 同业平均折现率 r 理论均衡线 · 右下角占优",
      badge: "占优区：高ROE · 低PB",
      badgePos: "br",
      forceZeroX: false,
      forceZeroY: true,
      xFmt: v => `${v.toFixed(1)}%`,
      yFmt: v => `${v.toFixed(2)}x`,
      getX: r => r.roeTtm,
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
      xLabel: "5年净利增速均值 g₁ (%)",
      yLabel: "股息率 TTM (%)",
      subtitle: "横轴 5 年净利增速基准 g₁ · 纵轴近 12 月股息率 · 斜虚线为「股息率 + g₁ = 10%」等总回报线",
      badge: "占优区：高股息 · 高成长",
      badgePos: "tr",
      forceZeroX: false,
      forceZeroY: true,
      xFmt: v => `${v.toFixed(1)}%`,
      yFmt: v => `${v.toFixed(2)}%`,
      getX: r => r.g1Base,
      getY: r => r.divYieldPct
    },
    pe_pct: {
      xLabel: "近5年 PE 历史分位 (%)",
      yLabel: "市盈率 PE_TTM (倍)",
      subtitle: "横轴近 5 年 PIT+送转还原 PE 历史分位 · 纵轴当前 PE_TTM · 左下象限为低估值兼低历史分位",
      badge: "占优区：低PE · 低历史分位",
      badgePos: "bl",
      clampX: [0, 100],
      forceZeroY: true,
      xFmt: v => `${v.toFixed(0)}%`,
      yFmt: v => `${v.toFixed(1)}x`,
      getX: r => r.pePct5y,
      getY: r => r.peTtm
    }
  };
  const cfg = configs[mode] || configs.pb_roe;
  const subEl = document.getElementById("cmp-scatter-subtitle");
  if (subEl) subEl.textContent = cfg.subtitle;

  const pts = rows
    .map(r => ({ row: r, x: cfg.getX(r), y: cfg.getY(r) }))
    .filter(p => p.x !== null && p.y !== null && Number.isFinite(p.x) && Number.isFinite(p.y));

  const w = Math.max(290, wrap.clientWidth || 720);
  const isNarrow = w < 480;
  const h = isNarrow ? 340 : 420;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  if (!pts.length) {
    svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#6B7280" font-size="13" font-family="Noto Sans SC, sans-serif">${STATE.compare.loading ? "正在加载同业标的并测算…" : "当前篮子暂无足够的有效散点数据（请添加或切换指标模式）"}</text>`;
    return;
  }

  const pad = isNarrow ? { l: 46, r: 16, t: 26, b: 44 } : { l: 58, r: 28, t: 28, b: 48 };
  const plotW = Math.max(120, w - pad.l - pad.r);
  const plotH = Math.max(120, h - pad.t - pad.b);

  const [xLo, xHi] = niceAxisRange(pts.map(p => p.x), cfg.forceZeroX, cfg.clampX || null);
  const [yLo, yHi] = niceAxisRange(pts.map(p => p.y), cfg.forceZeroY, null);
  const toPxX = (v) => pad.l + ((v - xLo) / (xHi - xLo)) * plotW;
  const toPxY = (v) => pad.t + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

  const xTicks = makeTicks(xLo, xHi, isNarrow ? 4 : 6);
  const yTicks = makeTicks(yLo, yHi, 5);

  const parts = [];
  parts.push(`<defs><clipPath id="cmp-plot-clip"><rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" /></clipPath></defs>`);
  parts.push(`<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="#FFFFFF" stroke="#E5E7EB" stroke-width="1" />`);

  // Quadrant / Reference lines inside clipPath
  const refParts = [];
  const avgR = median(rows.map(r => r.rUsed)) || 8.0;
  if (mode === "pb_roe") {
    const medX = median(pts.map(p => p.x));
    if (medX != null) {
      const px = toPxX(medX);
      refParts.push(`<line x1="${px}" y1="${pad.t}" x2="${px}" y2="${pad.t + plotH}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="4 4" />`);
    }
    const yAtLo = Math.max(0, xLo / avgR);
    const yAtHi = Math.max(0, xHi / avgR);
    refParts.push(`<line x1="${toPxX(xLo)}" y1="${toPxY(yAtLo)}" x2="${toPxX(xHi)}" y2="${toPxY(yAtHi)}" stroke="#3730A3" stroke-width="1.3" stroke-dasharray="5 4" opacity="0.7" />`);
    refParts.push(`<text x="${pad.l + plotW - 8}" y="${toPxY(yAtHi) - 6}" text-anchor="end" font-size="10" fill="#3730A3" font-family="Noto Sans SC, sans-serif">PB = ROE / ${avgR.toFixed(1)}%</text>`);
  } else if (mode === "irr_upside") {
    const rx = toPxX(avgR);
    const ry = toPxY(0);
    refParts.push(`<rect x="${Math.max(pad.l, rx)}" y="${pad.t}" width="${Math.max(0, pad.l + plotW - Math.max(pad.l, rx))}" height="${Math.max(0, Math.min(pad.t + plotH, ry) - pad.t)}" fill="rgba(15,118,110,0.05)" />`);
    refParts.push(`<line x1="${rx}" y1="${pad.t}" x2="${rx}" y2="${pad.t + plotH}" stroke="#6B7280" stroke-width="1" stroke-dasharray="4 4" />`);
    refParts.push(`<line x1="${pad.l}" y1="${ry}" x2="${pad.l + plotW}" y2="${ry}" stroke="#0F766E" stroke-width="1.2" stroke-dasharray="5 4" />`);
  } else if (mode === "div_growth") {
    const yAtLo = 10 - xLo;
    const yAtHi = 10 - xHi;
    refParts.push(`<line x1="${toPxX(xLo)}" y1="${toPxY(yAtLo)}" x2="${toPxX(xHi)}" y2="${toPxY(yAtHi)}" stroke="#0F766E" stroke-width="1.2" stroke-dasharray="5 4" opacity="0.75" />`);
  } else if (mode === "pe_pct") {
    const medY = median(pts.map(p => p.y));
    const rx = toPxX(50);
    const ry = medY != null ? toPxY(medY) : pad.t + plotH * 0.5;
    refParts.push(`<rect x="${pad.l}" y="${Math.max(pad.t, ry)}" width="${Math.max(0, Math.min(pad.l + plotW, rx) - pad.l)}" height="${Math.max(0, pad.t + plotH - Math.max(pad.t, ry))}" fill="rgba(15,118,110,0.05)" />`);
    refParts.push(`<line x1="${rx}" y1="${pad.t}" x2="${rx}" y2="${pad.t + plotH}" stroke="#6B7280" stroke-width="1" stroke-dasharray="4 4" />`);
    refParts.push(`<line x1="${pad.l}" y1="${ry}" x2="${pad.l + plotW}" y2="${ry}" stroke="#6B7280" stroke-width="1" stroke-dasharray="4 4" />`);
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
      tt.innerHTML = `
        <div class="tt-date">${esc(r.name)} <span style="opacity:.7;font-weight:400;">(${esc(r.code)})</span></div>
        <div class="tt-row"><span class="tt-lbl">${esc(cfg.xLabel)}</span><span class="tt-val">${esc(cfg.xFmt(b.x))}</span></div>
        <div class="tt-row"><span class="tt-lbl">${esc(cfg.yLabel)}</span><span class="tt-val">${esc(cfg.yFmt(b.y))}</span></div>
        <div class="tt-row"><span class="tt-lbl">不复权价 / 市值</span><span class="tt-val">¥${fmtNum(r.unadjPrice)} / ${fmtMoneyShort(r.mktCap)}</span></div>
        <div class="tt-row"><span class="tt-lbl">隐含回报 IRR</span><span class="tt-val" style="color:${(r.impliedIrr ?? 0) >= 8 ? "#6EE7B7" : "#FCA5A5"};">${r.impliedIrr != null ? r.impliedIrr.toFixed(2) + "%" : "--"}</span></div>
        <div class="tt-row"><span class="tt-lbl">${esc(r.dcfBaseLabel)} 估值</span><span class="tt-val">¥${fmtNum(r.dcfMid)} (${esc(dcfUp)})</span></div>
        <div class="tt-row"><span class="tt-lbl">RIM 估值</span><span class="tt-val">¥${fmtNum(r.rimMid)} (${esc(rimUp)})</span></div>
        <div class="tt-row"><span class="tt-lbl">PE(分位) / 股息</span><span class="tt-val">${r.peTtm != null ? fmtNum(r.peTtm, 1) + "x" : "--"}(${r.pePct5y != null ? r.pePct5y.toFixed(0) + "%" : "--"}) / ${r.divYieldPct != null ? r.divYieldPct.toFixed(2) + "%" : "--"}</span></div>
        <div style="margin-top:4px;font-size:10px;opacity:0.75;">点击气泡进入个股深度看板 →</div>
      `;
      tt.style.display = "block";
      const tw = tt.offsetWidth || 220;
      const th = tt.offsetHeight || 160;
      const tx = b.cx + b.r + 14 + tw > w ? Math.max(6, b.cx - b.r - tw - 14) : (b.cx + b.r + 14);
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

  const cols = [
    { key: "code", label: "代码", align: "left", sortable: true },
    { key: "name", label: "简称", align: "left", sortable: false },
    { key: "mktCap", label: "总市值", align: "", sortable: true },
    { key: "unadjPrice", label: "不复权价", align: "", sortable: true },
    { key: "peTtm", label: "PE_TTM (5Y分位)", align: "", sortable: true },
    { key: "pb", label: "PB (5Y分位)", align: "", sortable: true },
    { key: "divYieldPct", label: "股息率 (派息率)", align: "", sortable: true },
    { key: "roeTtm", label: "TTM ROE", align: "", sortable: true },
    { key: "g1Base", label: "5Y净利增速", align: "", sortable: true },
    { key: "dcfUpsidePct", label: "绝对估值 (口径/空间)", align: "", sortable: true },
    { key: "rimUpsidePct", label: "RIM估值 (空间)", align: "", sortable: true },
    { key: "impliedIrr", label: "隐含回报 IRR", align: "", sortable: true },
    { key: "actions", label: "操作", align: "center", sortable: false }
  ];

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
        STATE.compare.sortDir = (k === "peTtm" || k === "pb" || k === "code") ? "asc" : "desc";
      }
      renderCompareResults();
    });
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="center flat" style="padding:28px;">${STATE.compare.loading ? "正在并发拉取并计算同业数据…" : "暂无可展示的对比数据"}</td></tr>`;
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
    const peSub = r.pePct5y != null ? `${r.pePct5y.toFixed(0)}% 分位` : "--";
    const pbSub = r.pbPct5y != null ? `${r.pbPct5y.toFixed(0)}% 分位` : "--";
    const paySub = r.payoutPct != null ? `派息 ${r.payoutPct.toFixed(0)}%` : "--";
    const irrColor = r.impliedIrr == null ? "var(--ink-faint)" : (r.impliedIrr >= (r.rUsed || 8) ? "var(--emerald)" : "var(--crimson)");
    return `
      <tr data-cmp-row="${esc(r.code)}">
        <td class="left mono"><strong>${esc(r.code)}</strong></td>
        <td class="left">${esc(r.name)}</td>
        <td class="mono">${esc(fmtMoneyShort(r.mktCap))}</td>
        <td class="mono">¥${fmtNum(r.unadjPrice)}</td>
        <td>${r.peTtm != null ? `<strong>${fmtNum(r.peTtm, 1)}x</strong><br><small class="flat" style="font-size:10.5px;">${peSub}</small>` : `<span class="flat">亏损/无</span>`}</td>
        <td>${r.pb != null ? `<strong>${fmtNum(r.pb, 2)}x</strong><br><small class="flat" style="font-size:10.5px;">${pbSub}</small>` : `--`}</td>
        <td>${r.divYieldPct != null ? `<strong>${r.divYieldPct.toFixed(2)}%</strong><br><small class="flat" style="font-size:10.5px;">${paySub}</small>` : `--`}</td>
        <td class="mono">${r.roeTtm != null ? `${r.roeTtm.toFixed(1)}%` : "--"}</td>
        <td class="mono ${clsSign(r.g1Base)}">${r.g1Base != null ? fmtPct(r.g1Base, 1, true) : "--"}</td>
        <td>${fmtUpsideCell(r.dcfMid, r.dcfUpsidePct, r.dcfBaseLabel)}</td>
        <td>${fmtUpsideCell(r.rimMid, r.rimUpsidePct)}</td>
        <td class="mono" style="font-weight:700;color:${irrColor};">${r.impliedIrr != null ? r.impliedIrr.toFixed(2) + "%" : "--"}<br><small class="flat" style="font-weight:400;font-size:10px;">r=${r.rUsed != null ? r.rUsed.toFixed(2) + "%" : "--"}</small></td>
        <td class="center">
          <button type="button" class="btn-mini" data-cmp-open="${esc(r.code)}">看板→</button>
          <button type="button" class="btn-mini" data-cmp-rm="${esc(r.code)}" style="margin-left:3px;">移除</button>
        </td>
      </tr>
    `;
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
