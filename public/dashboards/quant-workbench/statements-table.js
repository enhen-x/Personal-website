import { esc, fmtNum, fmtMoneyShort } from "./utils.js";
import { STATE } from "./state.js";
import { quarterIndex } from "./valuation-engine.js";

export const FIELD_ZH = {
  fiscal_year: "财年",
  fiscal_period: "季度",
  period_end: "报告期末",
  report_date: "披露日",
  effective_report_date: "PIT生效披露日",
  q_operating_income: "单季营业收入",
  q_operating_costs: "单季营业成本",
  q_operating_profit: "单季营业利润",
  q_net_profit: "单季净利润",
  q_parent_holder_net_profit: "单季归母净利润",
  operating_income: "营业收入(YTD)",
  total_operating_income: "营业总收入(YTD)",
  operating_costs: "营业成本(YTD)",
  operating_profit: "营业利润(YTD)",
  net_profit: "净利润(YTD)",
  parent_holder_net_profit: "归母净利润(YTD)",
  rd_expenses: "研发费用(YTD)",
  sale_expenses: "销售费用(YTD)",
  admin_expenses: "管理费用(YTD)",
  finance_expenses: "财务费用(YTD)",
  assets_total: "资产总计",
  total_liabilities: "负债合计",
  total_debt: "负债合计",
  holder_equity_total: "股东权益合计",
  parent_holder_equity_total: "归母股东权益",
  cash: "货币资金",
  monetary_fund: "货币资金",
  debt_to_assets_pct: "资产负债率(%)",
  q_act_cash_flow_net: "单季经营现金流净额",
  q_pay_fixed_assets_etc_cash: "单季购建固定资产支付现金",
  act_cash_flow_net: "经营现金流净额(YTD)",
  invest_cash_flow_net: "投资现金流净额(YTD)",
  finance_cash_flow_net: "筹资现金流净额(YTD)",
  pay_fixed_assets_etc_cash: "购建固定资产支付现金(YTD)"
};

export const CORE_COLS = {
  income: [
    "fiscal_year", "fiscal_period", "period_end", "report_date",
    "q_operating_income", "q_operating_costs", "q_operating_profit", "q_parent_holder_net_profit",
    "operating_income", "parent_holder_net_profit", "rd_expenses"
  ],
  balance: [
    "fiscal_year", "fiscal_period", "period_end", "report_date",
    "assets_total", "total_debt", "total_liabilities", "holder_equity_total",
    "cash", "monetary_fund", "debt_to_assets_pct"
  ],
  cashflow: [
    "fiscal_year", "fiscal_period", "period_end", "report_date",
    "q_act_cash_flow_net", "q_pay_fixed_assets_etc_cash",
    "act_cash_flow_net", "invest_cash_flow_net", "finance_cash_flow_net"
  ]
};

export function getActiveStatementRowsAndCols() {
  const fin = STATE.stock.finData;
  const type = STATE.stock.stmtType;
  const rows = type === "income"
    ? (fin?.income_statements || [])
    : (type === "balance" ? (fin?.balance_sheets || []) : (fin?.cash_flow_statements || []));

  if (!rows.length) return { rows: [], cols: [] };

  const allKeys = Array.from(new Set(rows.flatMap(r => Object.keys(r)))).filter(k => k !== "thscode" && k !== "market");
  let cols;
  if (STATE.stock.stmtCols === "core") {
    const preferred = CORE_COLS[type] || [];
    cols = preferred.filter(k => allKeys.includes(k));
    if (cols.length < 4) cols = allKeys.slice(0, 12);
  } else {
    const metaFirst = ["fiscal_year", "fiscal_period", "period_end", "report_date"].filter(k => allKeys.includes(k));
    const rest = allKeys.filter(k => !metaFirst.includes(k));
    cols = [...metaFirst, ...rest];
  }
  return { rows, cols };
}

export function calcStmtChange(curr, prev, isPctMetric) {
  if (curr === null || curr === undefined || curr === "" || prev === null || prev === undefined || prev === "") return null;
  const c = Number(curr);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
  if (isPctMetric) {
    return { val: c - p, unit: "pp" };
  }
  if (Math.abs(p) < 1e-9) return null;
  return { val: ((c - p) / Math.abs(p)) * 100, unit: "%" };
}

export function getStandaloneQuarterVal(row, col, rowByQi) {
  if (!row) return null;
  const v = row[col];
  if (v === null || v === undefined || v === "" || typeof v !== "number" || !Number.isFinite(v)) return null;
  const fp = String(row.fiscal_period || "").toUpperCase();
  if (fp === "Q1") return v;
  const qi = quarterIndex(row.fiscal_year, fp);
  if (!qi) return null;
  const prev = rowByQi.get(qi - 1);
  if (!prev || Number(prev.fiscal_year) !== Number(row.fiscal_year)) return null;
  const pv = prev[col];
  if (pv === null || pv === undefined || pv === "" || typeof pv !== "number" || !Number.isFinite(pv)) return null;
  return v - pv;
}

export function formatStmtDeltaHtml(prefix, chg) {
  if (!chg || !Number.isFinite(chg.val)) return `<span class="flat">${prefix}--</span>`;
  const v = chg.val;
  let txt;
  let cls;
  if (chg.unit === "pp") {
    if (Math.abs(v) < 0.005) {
      cls = "flat";
      txt = "0.00pp";
    } else {
      cls = v > 0 ? "up" : "down";
      txt = `${v > 0 ? "+" : ""}${v.toFixed(2)}pp`;
    }
  } else if (Math.abs(v) < 0.05) {
    cls = "flat";
    txt = "0.0%";
  } else if (v > 999) {
    cls = "up";
    txt = ">+999%";
  } else if (v < -999) {
    cls = "down";
    txt = "<-999%";
  } else {
    cls = v > 0 ? "up" : "down";
    txt = `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  }
  return `<span class="${cls}">${prefix}${txt}</span>`;
}

export function formatStmtDeltaPlain(chg) {
  if (!chg || !Number.isFinite(chg.val)) return "--";
  const v = chg.val;
  const sign = v > 0 ? "+" : "";
  return chg.unit === "pp" ? `${sign}${v.toFixed(2)}pp` : `${sign}${v.toFixed(2)}%`;
}

export function renderStatementTable() {
  const thead = document.getElementById("stmt-thead");
  const tbody = document.getElementById("stmt-tbody");
  tbody.classList.toggle("hide-deltas", !STATE.stock.stmtShowDeltas);
  const { rows, cols } = getActiveStatementRowsAndCols();

  if (!rows.length) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td colspan="8" class="center flat" style="padding:24px;">暂无该报表数据</td></tr>`;
    return;
  }

  const fin = STATE.stock.finData;
  const valFin = STATE.stock.valFinData;
  const type = STATE.stock.stmtType;
  const refArr = type === "income"
    ? [...(valFin?.income_statements || []), ...(fin?.income_statements || [])]
    : (type === "balance"
      ? [...(valFin?.balance_sheets || []), ...(fin?.balance_sheets || [])]
      : [...(valFin?.cash_flow_statements || []), ...(fin?.cash_flow_statements || [])]);
  const rowByQi = new Map();
  for (const item of refArr) {
    const qi = quarterIndex(item.fiscal_year, item.fiscal_period);
    if (qi && !rowByQi.has(qi)) rowByQi.set(qi, item);
  }
  const isFlowStmt = type === "income" || type === "cashflow";
  const META_HIDE_MOBILE = new Set(["period_end", "report_date", "effective_report_date"]);

  thead.innerHTML = `<tr>${cols.map((c, idx) =>
    `<th class="${idx < 4 ? "left" : ""}${META_HIDE_MOBILE.has(c) ? " stmt-meta-col" : ""}" title="${esc(c)}">${esc(FIELD_ZH[c] || c)}</th>`
  ).join("")}</tr>`;

  tbody.innerHTML = rows.map(r => {
    const qi = quarterIndex(r.fiscal_year, r.fiscal_period);
    const yoyRow = qi ? rowByQi.get(qi - 4) : null;
    const qoqRow = qi ? rowByQi.get(qi - 1) : null;

    return `
    <tr>
      ${cols.map((c, idx) => {
        const v = r[c];
        const metaCls = META_HIDE_MOBILE.has(c) ? " stmt-meta-col" : "";
        if (v === null || v === undefined || v === "") return `<td class="${idx < 4 ? "left" : ""}${metaCls} flat">--</td>`;
        if (c === "fiscal_year" || c === "fiscal_period" || c === "period_end" || c === "report_date" || c === "effective_report_date") {
          return `<td class="left mono${metaCls}">${esc(v)}</td>`;
        }
        const isPct = c.endsWith("_pct") || c.includes("ratio");
        if (isPct || typeof v === "number") {
          const mainStr = isPct ? `${fmtNum(v, 2)}%` : fmtMoneyShort(v);
          const yoyChg = calcStmtChange(v, yoyRow ? yoyRow[c] : null, isPct);
          let qoqChg = null;
          if (isFlowStmt && !c.startsWith("q_") && !isPct) {
            const currSq = getStandaloneQuarterVal(r, c, rowByQi);
            const prevSq = getStandaloneQuarterVal(qoqRow, c, rowByQi);
            qoqChg = calcStmtChange(currSq, prevSq, false);
          } else {
            qoqChg = calcStmtChange(v, qoqRow ? qoqRow[c] : null, isPct);
          }
          const titleTxt = `原始值: ${v} | 同比: ${formatStmtDeltaPlain(yoyChg)} | 环比: ${formatStmtDeltaPlain(qoqChg)}`;
          return `<td title="${esc(titleTxt)}"><span class="stmt-main">${esc(mainStr)}</span><span class="stmt-chg">${formatStmtDeltaHtml("同", yoyChg)}<span class="sep">/</span>${formatStmtDeltaHtml("环", qoqChg)}</span></td>`;
        }
        return `<td class="left${metaCls}">${esc(v)}</td>`;
      }).join("")}
    </tr>
  `;
  }).join("");
}
