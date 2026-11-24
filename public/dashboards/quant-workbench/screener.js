import { esc, fmtInt, fmtNum, fmtPct, fmtMoneyShort, fmtVol, clsSign, median } from "./utils.js";
import { STATE } from "./state.js";
import { quantFetch, showGlobalAlert, clearGlobalAlert } from "./api.js";

let screenerHandlers = {
  onOpenStock: null,
  onAddCompare: null,
  onRemoveCompare: null
};

export function setScreenerHandlers(handlers = {}) {
  screenerHandlers = { ...screenerHandlers, ...handlers };
}

export const SCREENER_FIELDS = [
  { key: "avg_turnover_20d", label: "20日均额", view: ["overview", "price"], fmt: "money", sortable: true },
  { key: "close", label: "收盘价(前复权)", view: ["overview", "price"], fmt: "num2", sortable: true },
  { key: "unadj_close", label: "不复权价", view: ["valuation", "price"], fmt: "num2", sortable: true },
  { key: "total_market_cap", label: "总市值", view: ["overview", "valuation"], fmt: "money", sortable: true },
  { key: "pe_ttm", label: "PE_TTM", view: ["overview", "valuation"], fmt: "num2", sortable: true },
  { key: "pb", label: "PB", view: ["overview", "valuation"], fmt: "num2", sortable: true },
  { key: "ps_ttm", label: "PS_TTM", view: ["valuation"], fmt: "num2", sortable: true },
  { key: "pcf_ttm", label: "PCF_TTM", view: ["valuation"], fmt: "num2", sortable: true },
  { key: "div_yield_ttm", label: "股息率%", view: ["overview", "valuation"], fmt: "pct", sortable: true },
  { key: "dps_ttm", label: "每股分红(TTM)", view: ["valuation"], fmt: "num3", sortable: true },
  { key: "pe_pct_5y", label: "5年PE分位%", view: ["valuation"], fmt: "pct1", sortable: true },
  { key: "pb_pct_5y", label: "5年PB分位%", view: ["valuation"], fmt: "pct1", sortable: true },
  { key: "total_shares", label: "总股本", view: ["valuation", "safety"], fmt: "vol", sortable: true },
  { key: "pct_chg_1d", label: "1日涨跌%", view: ["overview", "price"], fmt: "pctColor", sortable: true },
  { key: "pct_chg_5d", label: "5日涨跌%", view: ["price"], fmt: "pctColor", sortable: true },
  { key: "pct_chg_20d", label: "20日涨跌%", view: ["overview", "price"], fmt: "pctColor", sortable: true },
  { key: "pct_chg_60d", label: "60日涨跌%", view: ["price"], fmt: "pctColor", sortable: true },
  { key: "pct_chg_250d", label: "250日涨跌%", view: ["price"], fmt: "pctColor", sortable: true },
  { key: "volume", label: "成交量", view: ["price"], fmt: "vol", sortable: true },
  { key: "turnover", label: "当日成交额", view: ["price"], fmt: "money", sortable: true },
  { key: "trade_date", label: "行情日", view: ["price"], fmt: "text", sortable: true },
  { key: "roe_ttm_pct", label: "TTM ROE%", view: ["overview", "profit"], fmt: "pct", sortable: true },
  { key: "q_rev_yoy_pct", label: "单季营收YoY%", view: ["overview", "profit"], fmt: "pctColor", sortable: true },
  { key: "q_np_yoy_pct", label: "单季净利YoY%", view: ["overview", "profit"], fmt: "pctColor", sortable: true },
  { key: "gross_margin_pct", label: "毛利率%", view: ["overview", "profit"], fmt: "pct", sortable: true },
  { key: "net_margin_pct", label: "净利率%", view: ["profit"], fmt: "pct", sortable: true },
  { key: "rd_ratio_pct", label: "研发费用率%", view: ["profit"], fmt: "pct", sortable: true },
  { key: "q_operating_income", label: "单季营收", view: ["profit"], fmt: "money", sortable: true },
  { key: "q_parent_holder_net_profit", label: "单季归母净利", view: ["profit"], fmt: "money", sortable: true },
  { key: "ttm_operating_income", label: "TTM营收", view: ["profit"], fmt: "money", sortable: true },
  { key: "ttm_parent_holder_net_profit", label: "TTM归母净利", view: ["profit"], fmt: "money", sortable: true },
  { key: "debt_to_assets_pct", label: "资产负债率%", view: ["overview", "safety"], fmt: "pct", sortable: true },
  { key: "ocf_to_np_ratio", label: "OCF/净利润", view: ["overview", "safety"], fmt: "num2", sortable: true },
  { key: "cash_to_debt_ratio", label: "现金/总负债", view: ["safety"], fmt: "num2", sortable: true },
  { key: "ttm_ocf", label: "TTM经营现金流", view: ["safety"], fmt: "money", sortable: true },
  { key: "assets_total", label: "资产总计", view: ["safety"], fmt: "money", sortable: true },
  { key: "holder_equity_total", label: "股东权益", view: ["safety"], fmt: "money", sortable: true },
  { key: "cash", label: "货币资金", view: ["safety"], fmt: "money", sortable: true },
  { key: "total_debt", label: "负债合计", view: ["safety"], fmt: "money", sortable: true },
  { key: "fiscal_period_full", label: "最新财报期", view: ["overview", "safety"], fmt: "fiscal", sortable: false },
  { key: "report_date", label: "披露日", view: ["safety"], fmt: "text", sortable: true },
  { key: "period_end", label: "报告期末", view: ["safety"], fmt: "text", sortable: true },
  { key: "currency", label: "币种", view: ["safety"], fmt: "text", sortable: false }
];

export const SCREENER_PRESETS = {
  liquid: { sort_by: "avg_turnover_20d", sort_dir: "desc" },
  quality: { min_roe: 15, max_debt_ratio: 60, min_ocf_to_np: 0.8, min_turnover_20d_yi: 0.5, sort_by: "roe_ttm_pct", sort_dir: "desc" },
  value_div: { max_pe: 15, min_div_yield: 4, min_roe: 10, min_turnover_20d_yi: 0.5, sort_by: "div_yield_ttm", sort_dir: "desc" },
  deep_pb: { max_pb: 1.0, min_roe: 8, min_div_yield: 3, min_turnover_20d_yi: 0.5, sort_by: "pb", sort_dir: "asc" },
  pb_roe: { min_roe: 12, max_pb_pct_5y: 30, max_pe_pct_5y: 40, min_ocf_to_np: 0.7, sort_by: "roe_ttm_pct", sort_dir: "desc" },
  growth: { min_q_rev_yoy: 15, min_q_np_yoy: 20, min_gross_margin: 30, min_roe: 10, sort_by: "q_np_yoy_pct", sort_dir: "desc" },
  rd: { min_rd_ratio: 5, min_gross_margin: 35, max_debt_ratio: 55, sort_by: "rd_ratio_pct", sort_dir: "desc" },
  momentum: { min_pct_60d: 15, min_turnover_20d_yi: 1.0, min_q_np_yoy: 0, sort_by: "pct_chg_60d", sort_dir: "desc" },
  rebound: { max_pct_250d: -15, min_roe: 10, min_ocf_to_np: 0.8, sort_by: "roe_ttm_pct", sort_dir: "desc" }
};

export function initScreenerSortOptions() {
  const sel = document.getElementById("f-sort-by");
  const sortableCols = SCREENER_FIELDS.filter(f => f.sortable);
  sel.innerHTML = sortableCols.map(f =>
    `<option value="${esc(f.key)}" ${f.key === "avg_turnover_20d" ? "selected" : ""}>${esc(f.label)} (${esc(f.key)})</option>`
  ).join("");
}

export function clearScreenerInputs() {
  document.querySelectorAll("#scr-form input").forEach(inp => { inp.value = ""; });
  document.getElementById("f-exchange").value = "";
  document.getElementById("f-sort-by").value = "avg_turnover_20d";
  document.getElementById("f-sort-dir").value = "desc";
}

export function applyScreenerPreset(presetName) {
  clearScreenerInputs();
  const p = SCREENER_PRESETS[presetName] || {};
  if (p.min_roe !== undefined) document.getElementById("f-min-roe").value = p.min_roe;
  if (p.max_debt_ratio !== undefined) document.getElementById("f-max-debt").value = p.max_debt_ratio;
  if (p.min_ocf_to_np !== undefined) document.getElementById("f-min-ocf").value = p.min_ocf_to_np;
  if (p.min_turnover_20d_yi !== undefined) document.getElementById("f-min-turnover").value = p.min_turnover_20d_yi;
  if (p.min_q_rev_yoy !== undefined) document.getElementById("f-min-rev-yoy").value = p.min_q_rev_yoy;
  if (p.min_q_np_yoy !== undefined) document.getElementById("f-min-np-yoy").value = p.min_q_np_yoy;
  if (p.min_gross_margin !== undefined) document.getElementById("f-min-gm").value = p.min_gross_margin;
  if (p.min_rd_ratio !== undefined) document.getElementById("f-min-rd").value = p.min_rd_ratio;
  if (p.min_pct_60d !== undefined) document.getElementById("f-min-pct60").value = p.min_pct_60d;
  if (p.max_pct_250d !== undefined) document.getElementById("f-max-pct250").value = p.max_pct_250d;
  if (p.min_pe !== undefined) document.getElementById("f-min-pe").value = p.min_pe;
  if (p.max_pe !== undefined) document.getElementById("f-max-pe").value = p.max_pe;
  if (p.min_pb !== undefined) document.getElementById("f-min-pb").value = p.min_pb;
  if (p.max_pb !== undefined) document.getElementById("f-max-pb").value = p.max_pb;
  if (p.min_ps !== undefined) document.getElementById("f-min-ps").value = p.min_ps;
  if (p.max_ps !== undefined) document.getElementById("f-max-ps").value = p.max_ps;
  if (p.min_div_yield !== undefined) document.getElementById("f-min-div").value = p.min_div_yield;
  if (p.max_div_yield !== undefined) document.getElementById("f-max-div").value = p.max_div_yield;
  if (p.min_mkt_cap_yi !== undefined) document.getElementById("f-min-mktcap").value = p.min_mkt_cap_yi;
  if (p.max_mkt_cap_yi !== undefined) document.getElementById("f-max-mktcap").value = p.max_mkt_cap_yi;
  if (p.max_pe_pct_5y !== undefined) document.getElementById("f-max-pe-pct5y").value = p.max_pe_pct_5y;
  if (p.max_pb_pct_5y !== undefined) document.getElementById("f-max-pb-pct5y").value = p.max_pb_pct_5y;
  if (p.sort_by) document.getElementById("f-sort-by").value = p.sort_by;
  if (p.sort_dir) document.getElementById("f-sort-dir").value = p.sort_dir;

  document.querySelectorAll(".scr-preset").forEach(b => b.classList.toggle("active", b.dataset.preset === presetName));
}

export function readScreenerParams() {
  const val = (id) => document.getElementById(id).value.trim();
  const numVal = (id) => {
    const s = val(id);
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  const turnoverYi = numVal("f-min-turnover");
  const minMktCapYi = numVal("f-min-mktcap");
  const maxMktCapYi = numVal("f-max-mktcap");
  const limit = Number(document.getElementById("f-limit").value) || 50;
  STATE.screener.limit = limit;
  STATE.screener.sort_by = document.getElementById("f-sort-by").value || "avg_turnover_20d";
  STATE.screener.sort_dir = document.getElementById("f-sort-dir").value || "desc";

  return {
    q: val("f-q") || undefined,
    exchange: val("f-exchange") || undefined,
    min_close: numVal("f-min-close"),
    max_close: numVal("f-max-close"),
    min_turnover_20d: turnoverYi !== undefined ? Math.round(turnoverYi * 1e8) : undefined,
    min_pct_1d: numVal("f-min-pct1"),
    max_pct_1d: numVal("f-max-pct1"),
    min_pct_20d: numVal("f-min-pct20"),
    max_pct_20d: numVal("f-max-pct20"),
    min_pct_60d: numVal("f-min-pct60"),
    max_pct_60d: numVal("f-max-pct60"),
    min_pct_250d: numVal("f-min-pct250"),
    max_pct_250d: numVal("f-max-pct250"),
    min_q_rev_yoy: numVal("f-min-rev-yoy"),
    min_q_np_yoy: numVal("f-min-np-yoy"),
    min_gross_margin: numVal("f-min-gm"),
    min_net_margin: numVal("f-min-nm"),
    min_roe: numVal("f-min-roe"),
    max_debt_ratio: numVal("f-max-debt"),
    min_ocf_to_np: numVal("f-min-ocf"),
    min_rd_ratio: numVal("f-min-rd"),
    min_pe: numVal("f-min-pe"),
    max_pe: numVal("f-max-pe"),
    min_pb: numVal("f-min-pb"),
    max_pb: numVal("f-max-pb"),
    min_ps: numVal("f-min-ps"),
    max_ps: numVal("f-max-ps"),
    min_div_yield: numVal("f-min-div"),
    max_div_yield: numVal("f-max-div"),
    min_mkt_cap: minMktCapYi !== undefined ? Math.round(minMktCapYi * 1e8) : undefined,
    max_mkt_cap: maxMktCapYi !== undefined ? Math.round(maxMktCapYi * 1e8) : undefined,
    max_pe_pct_5y: numVal("f-max-pe-pct5y"),
    max_pb_pct_5y: numVal("f-max-pb-pct5y"),
    sort_by: STATE.screener.sort_by,
    sort_dir: STATE.screener.sort_dir,
    limit,
    offset: STATE.screener.offset
  };
}

export function formatScreenerCell(row, col) {
  if (col.fmt === "fiscal") {
    return `${row.fiscal_year || "--"}${row.fiscal_period || ""}`;
  }
  const v = row[col.key];
  if (v === null || v === undefined || v === "") return `<span class="flat">--</span>`;
  if (col.fmt === "money") return `<span title="${esc(v)}">${esc(fmtMoneyShort(v))}</span>`;
  if (col.fmt === "vol") return `<span title="${esc(v)}">${esc(fmtVol(v))}</span>`;
  if (col.fmt === "num2") return esc(fmtNum(v, 2));
  if (col.fmt === "num3") return esc(fmtNum(v, 3));
  if (col.fmt === "pct") return esc(fmtPct(v, 2, false));
  if (col.fmt === "pct1") return esc(fmtPct(v, 1, false));
  if (col.fmt === "pctColor") return `<span class="${clsSign(v)}">${esc(fmtPct(v, 2, true))}</span>`;
  return esc(String(v));
}

export function renderScreenerTable() {
  const view = STATE.screener.view;
  const cols = SCREENER_FIELDS.filter(f => f.view.includes(view));
  const items = STATE.screener.items || [];
  const total = STATE.screener.total || 0;
  const offset = STATE.screener.offset || 0;
  const limit = STATE.screener.limit || 50;

  // Summary strip
  document.getElementById("scr-total").textContent = fmtInt(total);
  const medPe = median(items.filter(i => i.pe_ttm > 0 && i.pe_ttm < 500).map(i => i.pe_ttm));
  const medDiv = median(items.filter(i => i.div_yield_ttm !== null && i.div_yield_ttm !== undefined).map(i => i.div_yield_ttm));
  const medRoe = median(items.map(i => i.roe_ttm_pct));
  const medGm = median(items.map(i => i.gross_margin_pct));
  const medDebt = median(items.map(i => i.debt_to_assets_pct));
  const validPct1 = items.filter(i => i.pct_chg_1d !== null && i.pct_chg_1d !== undefined);
  const upRatio = validPct1.length ? (validPct1.filter(i => i.pct_chg_1d > 0).length / validPct1.length) * 100 : null;
  document.getElementById("scr-med-pe").textContent = medPe !== null ? `${medPe.toFixed(1)}x` : "--";
  document.getElementById("scr-med-div").textContent = medDiv !== null ? `${medDiv.toFixed(2)}%` : "--";
  document.getElementById("scr-med-roe").textContent = medRoe !== null ? `${medRoe.toFixed(1)}%` : "--";
  document.getElementById("scr-med-gm").textContent = medGm !== null ? `${medGm.toFixed(1)}%` : "--";
  document.getElementById("scr-med-debt").textContent = medDebt !== null ? `${medDebt.toFixed(1)}%` : "--";
  document.getElementById("scr-up-ratio").textContent = upRatio !== null ? `${upRatio.toFixed(0)}%` : "--";

  const thead = document.getElementById("scr-thead");
  const tbody = document.getElementById("scr-tbody");

  thead.innerHTML = `
    <tr>
      <th class="left">代码</th>
      <th class="left">简称</th>
      <th class="center">市场</th>
      ${cols.map(c => {
        const isActive = STATE.screener.sort_by === c.key;
        const arrow = isActive ? (STATE.screener.sort_dir === "asc" ? " ▲" : " ▼") : "";
        const cls = [c.sortable ? "sortable" : "", isActive ? "sort-active" : ""].filter(Boolean).join(" ");
        return `<th class="${cls}" data-sort="${c.sortable ? esc(c.key) : ""}">${esc(c.label)}${arrow}</th>`;
      }).join("")}
      <th class="center">对比</th>
    </tr>
  `;

  thead.querySelectorAll("th[data-sort]").forEach(th => {
    const key = th.dataset.sort;
    if (!key) return;
    th.addEventListener("click", () => {
      if (STATE.screener.sort_by === key) {
        STATE.screener.sort_dir = STATE.screener.sort_dir === "desc" ? "asc" : "desc";
      } else {
        STATE.screener.sort_by = key;
        STATE.screener.sort_dir = "desc";
      }
      document.getElementById("f-sort-by").value = STATE.screener.sort_by;
      document.getElementById("f-sort-dir").value = STATE.screener.sort_dir;
      STATE.screener.offset = 0;
      runScreener(false);
    });
  });

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="${cols.length + 4}" class="center flat" style="padding:28px;">当前筛选条件下暂无匹配股票</td></tr>`;
  } else {
    tbody.innerHTML = items.map(row => {
      const inCmp = STATE.compare.codes.includes(row.thscode);
      return `
      <tr class="clickable" data-code="${esc(row.thscode)}">
        <td class="left mono"><strong>${esc(row.thscode)}</strong></td>
        <td class="left">${esc(row.name || row.ticker || "--")}</td>
        <td class="center"><span class="mini-pill">${esc(row.exchange || "--")}</span></td>
        ${cols.map(c => `<td>${formatScreenerCell(row, c)}</td>`).join("")}
        <td class="center">
          <button type="button" class="btn-mini btn-scr-cmp ${inCmp ? "added" : ""}" data-cmp-code="${esc(row.thscode)}" data-cmp-name="${esc(row.name || row.ticker || "")}">${inCmp ? "✓ 已加" : "+对比"}</button>
        </td>
      </tr>
    `;
    }).join("");

    tbody.querySelectorAll(".btn-scr-cmp").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const c = btn.dataset.cmpCode;
        const nm = btn.dataset.cmpName;
        if (STATE.compare.codes.includes(c)) {
          screenerHandlers.onRemoveCompare?.(c, false);
          btn.classList.remove("added");
          btn.textContent = "+对比";
        } else {
          const ok = Boolean(screenerHandlers.onAddCompare?.(c, nm, false));
          if (ok) {
            btn.classList.add("added");
            btn.textContent = "✓ 已加";
          }
        }
      });
    });

    tbody.querySelectorAll("tr[data-code]").forEach(tr => {
      tr.addEventListener("click", () => {
        screenerHandlers.onOpenStock?.(tr.dataset.code);
      });
    });
  }

  const from = total > 0 ? offset + 1 : 0;
  const to = Math.min(offset + items.length, total);
  const curPage = Math.floor(offset / limit) + 1;
  const maxPage = Math.max(1, Math.ceil(total / limit));
  document.getElementById("scr-page-info").textContent = `第 ${from} - ${to} 条 / 共 ${fmtInt(total)} 条`;
  document.getElementById("scr-page-num").textContent = `${curPage} / ${maxPage}`;
  document.getElementById("btn-scr-prev").disabled = offset <= 0;
  document.getElementById("btn-scr-next").disabled = offset + limit >= total;
}

export async function runScreener(resetOffset = true) {
  if (resetOffset) STATE.screener.offset = 0;
  const params = readScreenerParams();
  const tbody = document.getElementById("scr-tbody");
  tbody.innerHTML = `<tr><td colspan="12" class="center flat" style="padding:24px;">正在筛选全市场快照…</td></tr>`;

  try {
    const data = await quantFetch("/api/screener", params);
    clearGlobalAlert();
    STATE.screener.total = Number(data.total || 0);
    STATE.screener.items = Array.isArray(data.items) ? data.items : [];
    STATE.screenerLoaded = true;
    renderScreenerTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="12" class="center up" style="padding:24px;">筛选请求失败：${esc(err.message)}</td></tr>`;
    showGlobalAlert(err);
  }
}
