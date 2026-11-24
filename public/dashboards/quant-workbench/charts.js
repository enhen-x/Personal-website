import { esc, fmtNum, fmtPct, fmtMoneyShort, fmtVol } from "./utils.js";
import { STATE, CHARTS, destroyChart } from "./state.js";

export function createChartShell(containerId, legendItems, hintText = "拖拽放大 · 双击重置") {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  const legendBar = document.createElement("div");
  legendBar.className = "chart-legend-bar";

  const left = document.createElement("div");
  left.className = "chart-legend-items";
  for (const item of legendItems) {
    const el = document.createElement("span");
    el.className = "legend-item";
    if (item.kind === "swatch") {
      el.innerHTML = `<span class="legend-swatch" style="background:${item.color};"></span><span>${esc(item.label)}</span>`;
    } else {
      const h = item.thick ? 2.5 : 1.6;
      el.innerHTML = `<span class="legend-line" style="background:${item.color};height:${h}px;opacity:${item.opacity ?? 1};"></span><span>${esc(item.label)}</span>`;
    }
    left.appendChild(el);
  }

  const hint = document.createElement("span");
  hint.className = "chart-hint";
  hint.textContent = hintText;

  legendBar.appendChild(left);
  legendBar.appendChild(hint);

  const stage = document.createElement("div");
  stage.className = "chart-stage";

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  stage.appendChild(tooltip);

  container.appendChild(legendBar);
  container.appendChild(stage);

  const width = Math.max(260, stage.clientWidth || container.clientWidth || 640);
  const height = Math.max(120, (container.clientHeight || 280) - (legendBar.offsetHeight || 22) - 4);
  return { container, stage, tooltip, width, height };
}

export function attachBarTooltip(stage, tooltip, labels, rowsBuilder) {
  return (u) => {
    const idx = u.cursor.idx;
    if (idx == null || idx < 0 || idx >= labels.length) {
      tooltip.style.display = "none";
      return;
    }
    const res = rowsBuilder(idx);
    if (!res || !res.rows || !res.rows.length) {
      tooltip.style.display = "none";
      return;
    }
    let html = `<div class="tt-date">${esc(labels[idx])}</div>`;
    for (const r of res.rows) {
      html += `<div class="tt-row"><span class="tt-lbl"><span class="tt-dot" style="background:${r.color};"></span>${esc(r.name)}</span><span class="tt-val" style="${r.valStyle || ""}">${esc(r.val)}</span></div>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.display = "block";

    const dpr = window.devicePixelRatio || 1;
    const leftPx = u.cursor.left + (u.bbox.left / dpr);
    const topPx = u.cursor.top + (u.bbox.top / dpr);
    const sw = stage.clientWidth || 600;
    const sh = stage.clientHeight || 240;
    const tw = tooltip.offsetWidth || 180;
    const th = tooltip.offsetHeight || 90;
    const x = leftPx + 14 + tw > sw ? Math.max(4, leftPx - tw - 12) : leftPx + 14;
    const y = Math.max(4, Math.min(sh - th - 4, topPx - 18));
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  };
}

export function calcMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  let validCount = 0;
  for (let i = 0; i < closes.length; i++) {
    const v = closes[i];
    if (v !== null && v !== undefined) {
      sum += v;
      validCount++;
    }
    if (i >= period) {
      const old = closes[i - period];
      if (old !== null && old !== undefined) {
        sum -= old;
        validCount--;
      }
    }
    if (i >= period - 1 && validCount === period) {
      out[i] = +(sum / period).toFixed(3);
    }
  }
  return out;
}

export function renderStockKlineCharts() {
  destroyChart("stkPrice");
  destroyChart("stkVol");

  const kData = STATE.stock.klineData;
  const items = kData?.items || [];
  const priceBox = document.getElementById("chart-stk-price");
  const volBox = document.getElementById("chart-stk-vol");

  if (!items.length || typeof uPlot === "undefined") {
    priceBox.innerHTML = `<div class="chart-empty">${typeof uPlot === "undefined" ? "图表库加载中…" : "暂无日 K 线数据"}</div>`;
    volBox.innerHTML = `<div class="chart-empty">暂无成交量数据</div>`;
    return;
  }

  const n = items.length;
  const xIdx = new Array(n);
  const dates = new Array(n);
  const opens = new Array(n);
  const highs = new Array(n);
  const lows = new Array(n);
  const closes = new Array(n);
  const vols = new Array(n);
  const turns = new Array(n);
  const factors = new Array(n);

  for (let i = 0; i < n; i++) {
    const it = items[i];
    xIdx[i] = i;
    dates[i] = it.date;
    opens[i] = it.open;
    highs[i] = it.high;
    lows[i] = it.low;
    closes[i] = it.close;
    vols[i] = it.volume;
    turns[i] = it.turnover;
    factors[i] = it.factor;
  }

  const ma5 = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);

  const isCandle = STATE.stock.chartMode === "candle";
  const showMa5 = STATE.stock.ma5;
  const showMa20 = STATE.stock.ma20;
  const showMa60 = STATE.stock.ma60;

  const priceLegend = isCandle
    ? [{ kind: "swatch", color: "#B91C1C", label: "阳线 (涨)" }, { kind: "swatch", color: "#0F766E", label: "阴线 (跌)" }]
    : [{ color: "#111827", label: "收盘价", thick: true }];
  if (showMa5) priceLegend.push({ color: "#B45309", label: "MA5" });
  if (showMa20) priceLegend.push({ color: "#3730A3", label: "MA20" });
  if (showMa60) priceLegend.push({ color: "#0F766E", label: "MA60" });

  const pShell = createChartShell("chart-stk-price", priceLegend, "拖拽水平放大 · 双击复位");
  const vShell = createChartShell("chart-stk-vol", [
    { kind: "swatch", color: "#B91C1C", label: "阳量" },
    { kind: "swatch", color: "#0F766E", label: "阴量" }
  ], "与主图同步缩放");

  const xAxisConfig = {
    stroke: "#6B7280",
    font: '11px "Noto Sans SC", sans-serif',
    grid: { show: true, stroke: "#F3F4F6", width: 1 },
    ticks: { show: true, stroke: "#E5E7EB", width: 1, size: 4 },
    space: 75,
    incrs: [1, 2, 5, 10, 20, 30, 60, 120, 250, 500],
    values: (u, splits) => splits.map(v => {
      if (Math.abs(v - Math.round(v)) > 1e-6) return "";
      const i = Math.round(v);
      if (i < 0 || i >= n) return "";
      return n > 300 ? dates[i].slice(0, 7) : dates[i].slice(2);
    })
  };

  const onPriceCursor = attachBarTooltip(pShell.stage, pShell.tooltip, dates, (idx) => {
    const prevC = idx > 0 ? closes[idx - 1] : opens[idx];
    const chg = prevC > 0 && closes[idx] !== null ? ((closes[idx] / prevC - 1) * 100) : null;
    const isUp = (closes[idx] ?? 0) >= (opens[idx] ?? 0);
    const cColor = isUp ? "#B91C1C" : "#0F766E";
    const rows = [
      { name: "开盘", color: cColor, val: fmtNum(opens[idx]) },
      { name: "最高", color: cColor, val: fmtNum(highs[idx]) },
      { name: "最低", color: cColor, val: fmtNum(lows[idx]) },
      { name: "收盘", color: cColor, val: fmtNum(closes[idx]), valStyle: `color:${cColor}` },
      { name: "日涨跌", color: cColor, val: chg !== null ? fmtPct(chg, 2, true) : "--", valStyle: `color:${cColor}` },
      { name: "成交额", color: "#6B7280", val: fmtMoneyShort(turns[idx]) },
      { name: "复权因子", color: "#9CA3AF", val: fmtNum(factors[idx], 4) }
    ];
    if (showMa5 && ma5[idx] !== null) rows.push({ name: "MA5", color: "#B45309", val: fmtNum(ma5[idx]) });
    if (showMa20 && ma20[idx] !== null) rows.push({ name: "MA20", color: "#3730A3", val: fmtNum(ma20[idx]) });
    if (showMa60 && ma60[idx] !== null) rows.push({ name: "MA60", color: "#0F766E", val: fmtNum(ma60[idx]) });
    return { rows };
  });

  const onVolCursor = attachBarTooltip(vShell.stage, vShell.tooltip, dates, (idx) => {
    const isUp = (closes[idx] ?? 0) >= (opens[idx] ?? 0);
    const cColor = isUp ? "#B91C1C" : "#0F766E";
    return {
      rows: [
        { name: "成交量", color: cColor, val: fmtVol(vols[idx]) },
        { name: "成交额", color: "#6B7280", val: fmtMoneyShort(turns[idx]) }
      ]
    };
  });

  const priceOpts = {
    width: pShell.width,
    height: pShell.height,
    padding: [8, 12, 0, 0],
    legend: { show: false },
    cursor: {
      drag: { x: true, y: false },
      sync: { key: "stkKlineSync", scales: ["x", null] },
      points: { size: 5, width: 1.5 }
    },
    scales: {
      x: {
        time: false,
        range: (u, min, max) => (min == null || max == null || (min === 0 && max === n - 1))
          ? [-0.6, Math.max(0.6, n - 0.4)]
          : [min, max]
      },
      y: {
        range: (u) => {
          const xMin = Number.isFinite(u.scales.x.min) ? u.scales.x.min : 0;
          const xMax = Number.isFinite(u.scales.x.max) ? u.scales.x.max : (n - 1);
          const i0 = Math.max(0, Math.floor(xMin));
          const i1 = Math.min(n - 1, Math.ceil(xMax));
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = i0; i <= i1; i++) {
            const l = isCandle ? lows[i] : closes[i];
            const h = isCandle ? highs[i] : closes[i];
            if (l !== null && l < lo) lo = l;
            if (h !== null && h > hi) hi = h;
            if (showMa5 && ma5[i] !== null) { lo = Math.min(lo, ma5[i]); hi = Math.max(hi, ma5[i]); }
            if (showMa20 && ma20[i] !== null) { lo = Math.min(lo, ma20[i]); hi = Math.max(hi, ma20[i]); }
            if (showMa60 && ma60[i] !== null) { lo = Math.min(lo, ma60[i]); hi = Math.max(hi, ma60[i]); }
          }
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 10];
          const pad = (hi - lo) * 0.08 || hi * 0.05 || 1;
          return [Math.max(0, lo - pad), hi + pad];
        }
      }
    },
    axes: [
      xAxisConfig,
      {
        stroke: "#6B7280",
        font: '11px "Noto Sans SC", sans-serif',
        size: 56,
        gap: 6,
        grid: { show: true, stroke: "#F3F4F6", width: 1 },
        ticks: { show: false },
        values: (u, splits) => splits.map(v => v == null ? "" : Number(v).toFixed(v >= 100 ? 1 : 2))
      }
    ],
    series: [
      {},
      {
        label: "收盘",
        stroke: isCandle ? "rgba(0,0,0,0)" : "#111827",
        width: isCandle ? 0 : 1.7,
        points: { show: false }
      },
      { label: "MA5", show: showMa5, stroke: "#B45309", width: 1.3, points: { show: false } },
      { label: "MA20", show: showMa20, stroke: "#3730A3", width: 1.3, points: { show: false } },
      { label: "MA60", show: showMa60, stroke: "#0F766E", width: 1.3, points: { show: false } }
    ],
    hooks: {
      setCursor: [onPriceCursor],
      draw: [(u) => {
        if (!isCandle || !u.bbox || u.bbox.width <= 0 || u.bbox.height <= 0) return;
        const ctx = u.ctx;
        const dpr = window.devicePixelRatio || 1;
        const xMin = Number.isFinite(u.scales.x.min) ? u.scales.x.min : 0;
        const xMax = Number.isFinite(u.scales.x.max) ? u.scales.x.max : (n - 1);
        const i0 = Math.max(0, Math.floor(xMin));
        const i1 = Math.min(n - 1, Math.ceil(xMax));
        if (i1 < i0) return;
        const span = Math.max(1, i1 - i0 + 1);
        const bodyW = Math.max(1.5 * dpr, Math.min(12 * dpr, (u.bbox.width / span) * 0.62));

        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        for (let i = i0; i <= i1; i++) {
          const o = opens[i];
          const h = highs[i];
          const l = lows[i];
          const c = closes[i];
          if (o == null || h == null || l == null || c == null) continue;
          const x = u.valToPos(i, "x", true);
          const yO = u.valToPos(o, "y", true);
          const yC = u.valToPos(c, "y", true);
          const yH = u.valToPos(h, "y", true);
          const yL = u.valToPos(l, "y", true);
          const color = c >= o ? "#B91C1C" : "#0F766E";

          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = Math.max(1, 1.1 * dpr);

          ctx.beginPath();
          ctx.moveTo(x, yH);
          ctx.lineTo(x, yL);
          ctx.stroke();

          const top = Math.min(yO, yC);
          const boxH = Math.max(1.2 * dpr, Math.abs(yC - yO));
          ctx.fillRect(x - bodyW / 2, top, bodyW, boxH);
        }
        ctx.restore();
      }]
    }
  };

  const volOpts = {
    width: vShell.width,
    height: vShell.height,
    padding: [4, 12, 0, 0],
    legend: { show: false },
    cursor: {
      drag: { x: true, y: false },
      sync: { key: "stkKlineSync", scales: ["x", null] },
      points: { show: false }
    },
    scales: {
      x: {
        time: false,
        range: (u, min, max) => (min == null || max == null || (min === 0 && max === n - 1))
          ? [-0.6, Math.max(0.6, n - 0.4)]
          : [min, max]
      },
      y: {
        range: (u) => {
          const xMin = Number.isFinite(u.scales.x.min) ? u.scales.x.min : 0;
          const xMax = Number.isFinite(u.scales.x.max) ? u.scales.x.max : (n - 1);
          const i0 = Math.max(0, Math.floor(xMin));
          const i1 = Math.min(n - 1, Math.ceil(xMax));
          let mx = 0;
          for (let i = i0; i <= i1; i++) {
            if (vols[i] != null && vols[i] > mx) mx = vols[i];
          }
          return [0, mx > 0 ? mx * 1.12 : 100];
        }
      }
    },
    axes: [
      xAxisConfig,
      {
        stroke: "#6B7280",
        font: '11px "Noto Sans SC", sans-serif',
        size: 56,
        gap: 6,
        grid: { show: true, stroke: "#F3F4F6", width: 1 },
        ticks: { show: false },
        values: (u, splits) => splits.map(v => {
          if (!v) return "0";
          if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
          if (v >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
          return String(Math.round(v));
        })
      }
    ],
    series: [
      {},
      { label: "成交量", stroke: "rgba(0,0,0,0)", width: 0, points: { show: false } }
    ],
    hooks: {
      setCursor: [onVolCursor],
      draw: [(u) => {
        if (!u.bbox || u.bbox.width <= 0 || u.bbox.height <= 0) return;
        const ctx = u.ctx;
        const dpr = window.devicePixelRatio || 1;
        const xMin = Number.isFinite(u.scales.x.min) ? u.scales.x.min : 0;
        const xMax = Number.isFinite(u.scales.x.max) ? u.scales.x.max : (n - 1);
        const i0 = Math.max(0, Math.floor(xMin));
        const i1 = Math.min(n - 1, Math.ceil(xMax));
        if (i1 < i0) return;
        const span = Math.max(1, i1 - i0 + 1);
        const barW = Math.max(1.2 * dpr, Math.min(11 * dpr, (u.bbox.width / span) * 0.62));
        const y0 = u.valToPos(0, "y", true);

        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        for (let i = i0; i <= i1; i++) {
          const v = vols[i];
          if (v == null || v <= 0) continue;
          const x = u.valToPos(i, "x", true);
          const yV = u.valToPos(v, "y", true);
          ctx.fillStyle = (closes[i] ?? 0) >= (opens[i] ?? 0)
            ? "rgba(185, 28, 28, 0.65)"
            : "rgba(15, 118, 110, 0.65)";
          ctx.fillRect(x - barW / 2, yV, barW, Math.max(1, y0 - yV));
        }
        ctx.restore();
      }]
    }
  };

  const pricePlot = new uPlot(priceOpts, [xIdx, closes, ma5, ma20, ma60], pShell.stage);
  const volPlot = new uPlot(volOpts, [xIdx, vols], vShell.stage);

  pShell.stage.addEventListener("mouseleave", () => { pShell.tooltip.style.display = "none"; });
  vShell.stage.addEventListener("mouseleave", () => { vShell.tooltip.style.display = "none"; });

  CHARTS.stkPrice = { plot: pricePlot, containerId: "chart-stk-price" };
  CHARTS.stkVol = { plot: volPlot, containerId: "chart-stk-vol" };
}

export function renderStockFinCharts() {
  destroyChart("stkProfit");
  destroyChart("stkCash");

  const fin = STATE.stock.finData;
  const profitBox = document.getElementById("chart-stk-profit");
  const cashBox = document.getElementById("chart-stk-cash");

  if (!fin || typeof uPlot === "undefined") {
    profitBox.innerHTML = `<div class="chart-empty">${typeof uPlot === "undefined" ? "图表库加载中…" : "暂无财报趋势数据"}</div>`;
    cashBox.innerHTML = `<div class="chart-empty">暂无现金流与杠杆趋势数据</div>`;
    return;
  }

  const sortAsc = (arr) => [...(arr || [])].sort((a, b) => {
    const ya = Number(a.fiscal_year || 0);
    const yb = Number(b.fiscal_year || 0);
    if (ya !== yb) return ya - yb;
    return String(a.fiscal_period || "").localeCompare(String(b.fiscal_period || ""));
  });

  const inc = sortAsc(fin.income_statements);
  const balMap = new Map((fin.balance_sheets || []).map(r => [`${r.fiscal_year}-${r.fiscal_period}`, r]));
  const cfsMap = new Map((fin.cash_flow_statements || []).map(r => [`${r.fiscal_year}-${r.fiscal_period}`, r]));

  if (!inc.length) {
    profitBox.innerHTML = `<div class="chart-empty">暂无利润表记录</div>`;
    cashBox.innerHTML = `<div class="chart-empty">暂无现金流记录</div>`;
    return;
  }

  const isQ = STATE.stock.finMode === "quarter";
  const xIdx = inc.map((_, i) => i);
  const labels = inc.map(r => `${r.fiscal_year || ""}${r.fiscal_period || ""}`);
  const toYi = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? +(Number(v) / 1e8).toFixed(3) : null);

  const revArr = inc.map(r => toYi(isQ ? r.q_operating_income : r.operating_income));
  const npArr = inc.map(r => toYi(isQ ? r.q_parent_holder_net_profit : r.parent_holder_net_profit));

  const pShell = createChartShell("chart-stk-profit", [
    { kind: "swatch", color: "#3730A3", label: isQ ? "单季营业收入 (亿)" : "累计营业收入 (亿)" },
    { kind: "swatch", color: "#0F766E", label: isQ ? "单季归母净利 (亿)" : "累计归母净利 (亿)" }
  ], "悬停查看详细金额");

  const onProfitCursor = attachBarTooltip(pShell.stage, pShell.tooltip, labels, (idx) => ({
    rows: [
      { name: isQ ? "单季营收" : "累计营收", color: "#3730A3", val: revArr[idx] !== null ? `${fmtNum(revArr[idx])} 亿` : "--" },
      { name: isQ ? "单季归母净利" : "累计归母净利", color: "#0F766E", val: npArr[idx] !== null ? `${fmtNum(npArr[idx])} 亿` : "--" }
    ]
  }));

  const profitPlot = new uPlot({
    width: pShell.width,
    height: pShell.height,
    padding: [8, 10, 0, 0],
    legend: { show: false },
    cursor: { drag: { x: true, y: false }, points: { show: false } },
    scales: {
      x: {
        time: false,
        range: (u, min, max) => (min == null || max == null || (min === 0 && max === labels.length - 1))
          ? [-0.6, Math.max(0.6, labels.length - 0.4)]
          : [min, max]
      },
      y: {
        range: (u) => {
          let lo = 0;
          let hi = 0;
          for (let i = 0; i < labels.length; i++) {
            if (revArr[i] !== null) { lo = Math.min(lo, revArr[i]); hi = Math.max(hi, revArr[i]); }
            if (npArr[i] !== null) { lo = Math.min(lo, npArr[i]); hi = Math.max(hi, npArr[i]); }
          }
          const span = hi - lo || 1;
          return [lo < 0 ? lo - span * 0.1 : 0, hi + span * 0.12];
        }
      }
    },
    axes: [
      {
        stroke: "#6B7280",
        font: '11px "Noto Sans SC", sans-serif',
        grid: { show: true, stroke: "#F3F4F6", width: 1 },
        ticks: { show: true, stroke: "#E5E7EB", width: 1, size: 4 },
        space: 56,
        incrs: [1, 2, 4, 8, 12],
        values: (u, splits) => splits.map(v => {
          if (Math.abs(v - Math.round(v)) > 1e-6) return "";
          const i = Math.round(v);
          return labels[i] || "";
        })
      },
      {
        stroke: "#6B7280",
        font: '11px "Noto Sans SC", sans-serif',
        size: 54,
        gap: 6,
        grid: { show: true, stroke: "#F3F4F6", width: 1 },
        ticks: { show: false },
        values: (u, splits) => splits.map(v => v == null ? "" : `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}亿`)
      }
    ],
    series: [
      {},
      { label: "营收", stroke: "rgba(0,0,0,0)", width: 0, points: { show: false } },
      { label: "净利", stroke: "rgba(0,0,0,0)", width: 0, points: { show: false } }
    ],
    hooks: {
      setCursor: [onProfitCursor],
      draw: [(u) => {
        if (!u.bbox || u.bbox.width <= 0 || u.bbox.height <= 0) return;
        const ctx = u.ctx;
        const dpr = window.devicePixelRatio || 1;
        const xMin = Number.isFinite(u.scales.x.min) ? u.scales.x.min : 0;
        const xMax = Number.isFinite(u.scales.x.max) ? u.scales.x.max : (labels.length - 1);
        const i0 = Math.max(0, Math.floor(xMin));
        const i1 = Math.min(labels.length - 1, Math.ceil(xMax));
        if (i1 < i0) return;
        const span = Math.max(1, i1 - i0 + 1);
        const groupW = Math.min(24 * dpr, (u.bbox.width / span) * 0.72);
        const barW = Math.max(1.5 * dpr, groupW * 0.44);
        const yZero = u.valToPos(0, "y", true);

        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        // Zero line
        ctx.strokeStyle = "#D1D5DB";
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        ctx.moveTo(u.bbox.left, yZero);
        ctx.lineTo(u.bbox.left + u.bbox.width, yZero);
        ctx.stroke();

        for (let i = i0; i <= i1; i++) {
          const cx = u.valToPos(i, "x", true);
          if (revArr[i] !== null) {
            const yR = u.valToPos(revArr[i], "y", true);
            ctx.fillStyle = "rgba(55, 48, 163, 0.82)";
            ctx.fillRect(cx - barW - 0.5 * dpr, Math.min(yR, yZero), barW, Math.max(1, Math.abs(yZero - yR)));
          }
          if (npArr[i] !== null) {
            const yN = u.valToPos(npArr[i], "y", true);
            ctx.fillStyle = npArr[i] >= 0 ? "rgba(15, 118, 110, 0.85)" : "rgba(185, 28, 28, 0.8)";
            ctx.fillRect(cx + 0.5 * dpr, Math.min(yN, yZero), barW, Math.max(1, Math.abs(yZero - yN)));
          }
        }
        ctx.restore();
      }]
    }
  }, [xIdx, revArr, npArr], pShell.stage);
  pShell.stage.addEventListener("mouseleave", () => { pShell.tooltip.style.display = "none"; });
  CHARTS.stkProfit = { plot: profitPlot, containerId: "chart-stk-profit" };

  // Chart B: OCF vs NP + Debt-to-Assets %
  const ocfArr = inc.map(r => {
    const c = cfsMap.get(`${r.fiscal_year}-${r.fiscal_period}`);
    return toYi(isQ ? c?.q_act_cash_flow_net : c?.act_cash_flow_net);
  });
  const debtArr = inc.map(r => {
    const b = balMap.get(`${r.fiscal_year}-${r.fiscal_period}`);
    return b?.debt_to_assets_pct !== null && b?.debt_to_assets_pct !== undefined ? +Number(b.debt_to_assets_pct).toFixed(2) : null;
  });

  const cShell = createChartShell("chart-stk-cash", [
    { kind: "swatch", color: "#0F766E", label: isQ ? "单季经营现金流 (亿)" : "累计经营现金流 (亿)" },
    { kind: "swatch", color: "#9CA3AF", label: isQ ? "单季归母净利 (亿)" : "累计归母净利 (亿)" },
    { color: "#B45309", label: "资产负债率 (%)", thick: true }
  ], "右轴为负债率 %");

  const onCashCursor = attachBarTooltip(cShell.stage, cShell.tooltip, labels, (idx) => ({
    rows: [
      { name: isQ ? "单季经营现金流" : "累计经营现金流", color: "#0F766E", val: ocfArr[idx] !== null ? `${fmtNum(ocfArr[idx])} 亿` : "--" },
      { name: isQ ? "单季归母净利" : "累计归母净利", color: "#6B7280", val: npArr[idx] !== null ? `${fmtNum(npArr[idx])} 亿` : "--" },
      { name: "资产负债率", color: "#B45309", val: debtArr[idx] !== null ? `${fmtNum(debtArr[idx])}%` : "--" }
    ]
  }));

  const cashPlot = new uPlot({
    width: cShell.width,
    height: cShell.height,
    padding: [8, 8, 0, 0],
    legend: { show: false },
    cursor: { drag: { x: true, y: false }, points: { size: 5, width: 1.5 } },
    scales: {
      x: {
        time: false,
        range: (u, min, max) => (min == null || max == null || (min === 0 && max === labels.length - 1))
          ? [-0.6, Math.max(0.6, labels.length - 0.4)]
          : [min, max]
      },
      y: {
        range: (u) => {
          let lo = 0;
          let hi = 0;
          for (let i = 0; i < labels.length; i++) {
            if (ocfArr[i] !== null) { lo = Math.min(lo, ocfArr[i]); hi = Math.max(hi, ocfArr[i]); }
            if (npArr[i] !== null) { lo = Math.min(lo, npArr[i]); hi = Math.max(hi, npArr[i]); }
          }
          const span = hi - lo || 1;
          return [lo < 0 ? lo - span * 0.1 : 0, hi + span * 0.12];
        }
      },
      y2: {
        auto: false,
        range: [0, 100]
      }
    },
    axes: [
      {
        stroke: "#6B7280",
        font: '11px "Noto Sans SC", sans-serif',
        grid: { show: true, stroke: "#F3F4F6", width: 1 },
        ticks: { show: true, stroke: "#E5E7EB", width: 1, size: 4 },
        space: 56,
        incrs: [1, 2, 4, 8, 12],
        values: (u, splits) => splits.map(v => {
          if (Math.abs(v - Math.round(v)) > 1e-6) return "";
          const i = Math.round(v);
          return labels[i] || "";
        })
      },
      {
        scale: "y",
        stroke: "#6B7280",
        font: '11px "Noto Sans SC", sans-serif',
        size: 54,
        gap: 6,
        grid: { show: true, stroke: "#F3F4F6", width: 1 },
        ticks: { show: false },
        values: (u, splits) => splits.map(v => v == null ? "" : `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}亿`)
      },
      {
        scale: "y2",
        side: 1,
        stroke: "#B45309",
        font: '11px "Noto Sans SC", sans-serif',
        size: 42,
        gap: 5,
        grid: { show: false },
        ticks: { show: false },
        splits: () => [0, 25, 50, 75, 100],
        values: (u, splits) => splits.map(v => `${v}%`)
      }
    ],
    series: [
      {},
      { label: "现金流", scale: "y", stroke: "rgba(0,0,0,0)", width: 0, points: { show: false } },
      { label: "归母净利", scale: "y", stroke: "rgba(0,0,0,0)", width: 0, points: { show: false } },
      { label: "资产负债率", scale: "y2", stroke: "#B45309", width: 1.9, points: { show: true, size: 4, fill: "#FFFFFF", stroke: "#B45309" } }
    ],
    hooks: {
      setCursor: [onCashCursor],
      drawClear: [(u) => {
        if (!u.bbox || u.bbox.width <= 0 || u.bbox.height <= 0) return;
        const ctx = u.ctx;
        const dpr = window.devicePixelRatio || 1;
        const xMin = Number.isFinite(u.scales.x.min) ? u.scales.x.min : 0;
        const xMax = Number.isFinite(u.scales.x.max) ? u.scales.x.max : (labels.length - 1);
        const i0 = Math.max(0, Math.floor(xMin));
        const i1 = Math.min(labels.length - 1, Math.ceil(xMax));
        if (i1 < i0) return;
        const span = Math.max(1, i1 - i0 + 1);
        const groupW = Math.min(24 * dpr, (u.bbox.width / span) * 0.72);
        const barW = Math.max(1.5 * dpr, groupW * 0.44);
        const yZero = u.valToPos(0, "y", true);

        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        ctx.strokeStyle = "#D1D5DB";
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        ctx.moveTo(u.bbox.left, yZero);
        ctx.lineTo(u.bbox.left + u.bbox.width, yZero);
        ctx.stroke();

        for (let i = i0; i <= i1; i++) {
          const cx = u.valToPos(i, "x", true);
          if (ocfArr[i] !== null) {
            const yO = u.valToPos(ocfArr[i], "y", true);
            ctx.fillStyle = ocfArr[i] >= 0 ? "rgba(15, 118, 110, 0.78)" : "rgba(185, 28, 28, 0.75)";
            ctx.fillRect(cx - barW - 0.5 * dpr, Math.min(yO, yZero), barW, Math.max(1, Math.abs(yZero - yO)));
          }
          if (npArr[i] !== null) {
            const yN = u.valToPos(npArr[i], "y", true);
            ctx.fillStyle = "rgba(156, 163, 175, 0.72)";
            ctx.fillRect(cx + 0.5 * dpr, Math.min(yN, yZero), barW, Math.max(1, Math.abs(yZero - yN)));
          }
        }
        ctx.restore();
      }]
    }
  }, [xIdx, ocfArr, npArr, debtArr], cShell.stage);
  cShell.stage.addEventListener("mouseleave", () => { cShell.tooltip.style.display = "none"; });
  CHARTS.stkCash = { plot: cashPlot, containerId: "chart-stk-cash" };
}


export function renderValuationBandChart(snap) {
  destroyChart("stkValBand");
  const box = document.getElementById("chart-stk-valband");
  const statsEl = document.getElementById("val-band-stats");
  const metric = STATE.stock.valMetric;
  const band = snap?.bands?.[metric];

  const metaMap = {
    pe: { name: "PE_TTM (倍)", suffix: "x", lowerIsCheap: true },
    pb: { name: "市净率 PB (倍)", suffix: "x", lowerIsCheap: true },
    ps: { name: "市销率 PS_TTM (倍)", suffix: "x", lowerIsCheap: true },
    fcf: { name: "自由现金流收益率 FCF Yield (%)", suffix: "%", lowerIsCheap: false }
  };
  const cfg = metaMap[metric];

  if (!band || !band.validCount || typeof uPlot === "undefined") {
    statsEl.textContent = "有效历史样本不足";
    box.innerHTML = `<div class="chart-empty">当前窗口暂无有效的 ${esc(cfg.name)} 历史数据（可能存在亏损或数据缺失）</div>`;
    return;
  }

  const alignTxt = STATE.stock.valAlignMode === "pit" ? "PIT披露日" : "会计期末";
  const spanTxt = (band.firstDate && band.lastDate) ? `${band.firstDate} ~ ${band.lastDate} · ` : "";
  statsEl.textContent =
    `[${alignTxt} · 送转还原] ${spanTxt}有效交易日 ${band.validCount} 天 · 当前 ${fmtNum(band.latestVal)}${cfg.suffix} (${band.pct !== null ? band.pct.toFixed(1) + "%" : "--"} 分位) · P20=${fmtNum(band.p20)}${cfg.suffix} · P50=${fmtNum(band.p50)}${cfg.suffix} · P80=${fmtNum(band.p80)}${cfg.suffix}`;

  const n = band.dates.length;
  const xIdx = band.dates.map((_, i) => i);
  const shell = createChartShell("chart-stk-valband", [
    { color: "#111827", label: cfg.name, thick: true },
    { color: "#0F766E", label: cfg.lowerIsCheap ? "P20 低估线" : "P80 高回报线" },
    { color: "#6B7280", label: "P50 历史中位" },
    { color: "#B91C1C", label: cfg.lowerIsCheap ? "P80 高估线" : "P20 低回报线" }
  ], "拖拽水平放大 · 双击复位");

  const onCursor = attachBarTooltip(shell.stage, shell.tooltip, band.dates, (idx) => {
    const v = band.values[idx];
    const qPeriod = band.qLabels[idx] || "--";
    const qAlignDate = band.qAlignDates?.[idx] || "--";
    return {
      rows: [
        { name: cfg.name, color: "#111827", val: v !== null ? `${fmtNum(v)}${cfg.suffix}` : "--" },
        { name: "不复权价", color: "#6B7280", val: band.prices[idx] !== null ? `¥${fmtNum(band.prices[idx])}` : "--" },
        { name: STATE.stock.valAlignMode === "pit" ? "财报(PIT)" : "财报(期末)", color: "#3730A3", val: `${qPeriod} (${qAlignDate})` }
      ]
    };
  });

  const plot = new uPlot({
    width: shell.width,
    height: shell.height,
    padding: [8, 12, 0, 0],
    legend: { show: false },
    cursor: { drag: { x: true, y: false }, points: { size: 5, width: 1.5 } },
    scales: {
      x: {
        time: false,
        range: (u, min, max) => (min == null || max == null || (min === 0 && max === n - 1))
          ? [-0.6, Math.max(0.6, n - 0.4)]
          : [min, max]
      },
      y: {
        range: (u) => {
          const xMin = Number.isFinite(u.scales.x.min) ? u.scales.x.min : 0;
          const xMax = Number.isFinite(u.scales.x.max) ? u.scales.x.max : (n - 1);
          const i0 = Math.max(0, Math.floor(xMin));
          const i1 = Math.min(n - 1, Math.ceil(xMax));
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = i0; i <= i1; i++) {
            const v = band.values[i];
            if (v !== null) {
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          }
          if (band.p20 !== null) { lo = Math.min(lo, band.p20); hi = Math.max(hi, band.p20); }
          if (band.p80 !== null) { lo = Math.min(lo, band.p80); hi = Math.max(hi, band.p80); }
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 10];
          const pad = (hi - lo) * 0.10 || Math.abs(hi) * 0.1 || 1;
          return [metric === "fcf" ? lo - pad : Math.max(0, lo - pad), hi + pad];
        }
      }
    },
    axes: [
      {
        stroke: "#6B7280",
        font: '11px "Noto Sans SC", sans-serif',
        grid: { show: true, stroke: "#F3F4F6", width: 1 },
        ticks: { show: true, stroke: "#E5E7EB", width: 1, size: 4 },
        space: 75,
        incrs: [1, 2, 5, 10, 20, 30, 60, 120, 250, 500, 1000],
        values: (u, splits) => splits.map(v => {
          if (Math.abs(v - Math.round(v)) > 1e-6) return "";
          const i = Math.round(v);
          return (i >= 0 && i < n) ? band.dates[i].slice(0, 7) : "";
        })
      },
      {
        stroke: "#6B7280",
        font: '11px "Noto Sans SC", sans-serif',
        size: 54,
        gap: 6,
        grid: { show: true, stroke: "#F3F4F6", width: 1 },
        ticks: { show: false },
        values: (u, splits) => splits.map(v => v == null ? "" : `${Number(v).toFixed(1)}${cfg.suffix}`)
      }
    ],
    series: [
      {},
      { label: cfg.name, stroke: "#111827", width: 1.8, points: { show: false } }
    ],
    hooks: {
      setCursor: [onCursor],
      drawClear: [(u) => {
        if (!u.bbox || u.bbox.width <= 0 || u.bbox.height <= 0) return;
        if (band.p20 === null || band.p50 === null || band.p80 === null) return;
        const ctx = u.ctx;
        const dpr = window.devicePixelRatio || 1;
        const yMin = u.scales.y.min;
        const yMax = u.scales.y.max;
        if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        // Shade undervalued and overvalued zones
        const yP20 = u.valToPos(band.p20, "y", true);
        const yP80 = u.valToPos(band.p80, "y", true);
        const yBot = u.bbox.top + u.bbox.height;
        const yTop = u.bbox.top;

        if (cfg.lowerIsCheap) {
          ctx.fillStyle = "rgba(15, 118, 110, 0.08)";
          ctx.fillRect(u.bbox.left, yP20, u.bbox.width, Math.max(0, yBot - yP20));
          ctx.fillStyle = "rgba(185, 28, 28, 0.07)";
          ctx.fillRect(u.bbox.left, yTop, u.bbox.width, Math.max(0, yP80 - yTop));
        } else {
          ctx.fillStyle = "rgba(15, 118, 110, 0.08)";
          ctx.fillRect(u.bbox.left, yTop, u.bbox.width, Math.max(0, yP80 - yTop));
          ctx.fillStyle = "rgba(185, 28, 28, 0.07)";
          ctx.fillRect(u.bbox.left, yP20, u.bbox.width, Math.max(0, yBot - yP20));
        }

        const drawBandLine = (val, color, dash) => {
          if (val < yMin || val > yMax) return;
          const py = u.valToPos(val, "y", true);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2 * dpr;
          ctx.setLineDash(dash.map(x => x * dpr));
          ctx.beginPath();
          ctx.moveTo(u.bbox.left, py);
          ctx.lineTo(u.bbox.left + u.bbox.width, py);
          ctx.stroke();
        };
        drawBandLine(band.p20, cfg.lowerIsCheap ? "#0F766E" : "#B91C1C", [5, 4]);
        drawBandLine(band.p50, "#6B7280", [3, 3]);
        drawBandLine(band.p80, cfg.lowerIsCheap ? "#B91C1C" : "#0F766E", [5, 4]);

        ctx.restore();
      }]
    }
  }, [xIdx, band.values], shell.stage);

  shell.stage.addEventListener("mouseleave", () => { shell.tooltip.style.display = "none"; });
  CHARTS.stkValBand = { plot, containerId: "chart-stk-valband" };
}


export function resizeStockCharts() {
  if (STATE.activeTab !== "stock") return;
  for (const entry of [CHARTS.stkPrice, CHARTS.stkVol, CHARTS.stkValBand, CHARTS.stkProfit, CHARTS.stkCash]) {
    if (!entry || !entry.plot || !entry.containerId) continue;
    const container = document.getElementById(entry.containerId);
    if (!container) continue;
    const stage = container.querySelector(".chart-stage");
    const legendBar = container.querySelector(".chart-legend-bar");
    const width = Math.max(260, (stage && stage.clientWidth) || container.clientWidth || 640);
    const height = Math.max(120, (container.clientHeight || 280) - ((legendBar && legendBar.offsetHeight) || 22) - 4);
    if (width > 0 && height > 0) {
      entry.plot.setSize({ width, height });
    }
  }
}
