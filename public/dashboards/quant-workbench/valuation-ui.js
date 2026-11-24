import { esc, fmtNum, fmtPct, fmtMoneyShort, clamp } from "./utils.js";
import { STATE } from "./state.js";
import { evaluateStockValuation, selectDefaultDcfBase, getBaseCashFlowByKey, calcTwoStageDCF, solveImpliedReturn, calcRIM } from "./valuation-engine.js";
import { renderValuationBandChart } from "./charts.js";

export function computeValuationSnapshot() {
  const finData = STATE.stock.valFinData || STATE.stock.finData;
  const kMain = STATE.stock.klineData;
  const kUnadj = STATE.stock.valKlineData || (kMain?.adjust === "none" ? kMain : null);
  const curCode = STATE.stock.code;
  const kAdj = (STATE.stock.valFwdKlineData && STATE.stock.valFwdLoadedCode === curCode && STATE.stock.valFwdKlineData.items?.length >= 2)
    ? STATE.stock.valFwdKlineData
    : ((kMain && kMain.adjust !== "none" && kMain.items?.length >= 2) ? kMain : null);
  return evaluateStockValuation({
    finData,
    kUnadj,
    kAdj,
    kMain,
    shareData: STATE.stock.shareData,
    valWindow: STATE.stock.valWindow,
    valAlignMode: STATE.stock.valAlignMode,
    dcfRMode: STATE.stock.dcfRMode
  });
}

export function autoFitDcfDefaults(snap) {
  const code = STATE.stock.code;
  if (STATE.stock.dcfAutoFittedCode === code) return;
  STATE.stock.dcfAutoFittedCode = code;

  const rMode = STATE.stock.dcfRMode === "hist_gordon" ? "hist_gordon" : "capm";
  const neut = snap?.dcfModel?.presetsByMode?.[rMode]?.neutral || snap?.dcfModel?.presets?.neutral;
  STATE.stock.dcfPreset = "neutral";
  STATE.stock.dcfG1 = neut ? neut.g1 : 7.0;
  STATE.stock.dcfG2 = neut ? neut.g2 : 2.5;
  STATE.stock.dcfR = neut ? neut.r : 9.0;
  STATE.stock.dcfMos = neut ? neut.mos : 20;
  STATE.stock.dcfBase = selectDefaultDcfBase(snap);

  document.querySelectorAll(".val-preset").forEach(b => b.classList.toggle("active", b.dataset.preset === "neutral"));
  syncValuationControls();
}

export function syncValuationControls() {
  document.getElementById("rng-dcf-g1").value = STATE.stock.dcfG1;
  document.getElementById("rng-dcf-g2").value = STATE.stock.dcfG2;
  document.getElementById("rng-dcf-r").value = STATE.stock.dcfR;
  document.getElementById("rng-dcf-mos").value = STATE.stock.dcfMos;

  document.getElementById("lbl-dcf-g1").textContent = `${STATE.stock.dcfG1.toFixed(1)}%`;
  document.getElementById("lbl-dcf-g2").textContent = `${STATE.stock.dcfG2.toFixed(1)}%`;
  document.getElementById("lbl-dcf-r").textContent = `${STATE.stock.dcfR.toFixed(2)}%`;
  document.getElementById("lbl-dcf-mos").textContent = `${STATE.stock.dcfMos}%`;

  const snap = STATE.stock.valSnap;
  const model = snap?.dcfModel;
  const rMode = STATE.stock.dcfRMode === "hist_gordon" ? "hist_gordon" : "capm";
  const g1HintEl = document.getElementById("hint-dcf-g1");
  if (g1HintEl && model) {
    g1HintEl.textContent = model.g1Hint;
    g1HintEl.title = model.g1Title || "";
  }
  const rHintEl = document.getElementById("hint-dcf-r");
  if (rHintEl && model) {
    rHintEl.textContent = model.rHintByMode?.[rMode] || model.rHint;
  }
  const mosHintEl = document.getElementById("hint-dcf-mos");
  if (mosHintEl && model) {
    mosHintEl.textContent = model.mosHint;
  }

  document.querySelectorAll("#seg-dcf-base button").forEach(b => b.classList.toggle("active", b.dataset.val === STATE.stock.dcfBase));
  document.querySelectorAll("#seg-val-metric button").forEach(b => b.classList.toggle("active", b.dataset.val === STATE.stock.valMetric));
  document.querySelectorAll("#seg-val-window button").forEach(b => b.classList.toggle("active", String(b.dataset.val) === String(STATE.stock.valWindow)));
  document.querySelectorAll("#seg-val-align button").forEach(b => b.classList.toggle("active", b.dataset.val === STATE.stock.valAlignMode));
  document.querySelectorAll("#seg-dcf-r-mode button").forEach(b => b.classList.toggle("active", b.dataset.val === rMode));
  document.querySelectorAll(".val-preset").forEach(b => b.classList.toggle("active", b.dataset.preset === STATE.stock.dcfPreset));

  const isFin = Boolean(snap?.isFinancial);
  const ncBtn = document.getElementById("btn-dcf-netcash");
  if (ncBtn) {
    const ncActive = Boolean(STATE.stock.dcfNetCashAdj && !isFin);
    ncBtn.disabled = isFin;
    ncBtn.classList.toggle("active", ncActive);
    ncBtn.setAttribute("aria-pressed", String(ncActive));
    ncBtn.textContent = isFin
      ? "DCF含净现金: 金融股不适用"
      : (ncActive ? "DCF含净现金: 开" : "DCF含净现金: 关");
  }
  const rimBtn = document.getElementById("btn-rim-below-book");
  if (rimBtn) {
    const rimActive = Boolean(STATE.stock.rimAllowBelowBook);
    rimBtn.classList.toggle("active", rimActive);
    rimBtn.setAttribute("aria-pressed", String(rimActive));
    rimBtn.textContent = rimActive ? "RIM允许破净: 开" : "RIM允许破净: 关";
  }
}

export function getActiveBaseCashFlow(snap) {
  return getBaseCashFlowByKey(snap, STATE.stock.dcfBase);
}

export function getEffectiveNetCashPerShare(snap) {
  if (!STATE.stock.dcfNetCashAdj || !snap || snap.isFinancial || STATE.stock.dcfBase === "div_ttm") return 0;
  const cash = snap.qNow?.cash;
  const debt = snap.qNow?.debt;
  const shares = snap.shares;
  if (cash != null && debt != null && shares > 0) {
    return (cash - debt) / shares;
  }
  return 0;
}

export function renderValuationKPIs(snap) {
  document.getElementById("val-unadj-price").textContent = snap.unadjPrice !== null ? `¥${fmtNum(snap.unadjPrice)}` : "--";
  document.getElementById("val-implied-shares").textContent = snap.shares !== null ? `${(snap.shares / 1e8).toFixed(2)}亿股` : "--";
  document.getElementById("val-implied-mktcap").textContent = snap.impliedMktCap !== null ? `${(snap.impliedMktCap / 1e8).toFixed(1)}亿元` : "--";
  document.getElementById("val-shares-src").textContent = snap.sharesSourceKind === "authoritative"
    ? `股本口径: 权威总股本 (${snap.sharesSrc})`
    : `股本估算期(兜底): ${snap.sharesSrc}${snap.isExactShares ? "" : " (顺延)"}`;

  const setCard = (id, mainText, pillText, pillCls, barPct, barColor, metaText) => {
    document.getElementById(id).textContent = mainText;
    const pEl = document.getElementById(`${id}-pill`);
    pEl.className = `status-pill ${pillCls}`;
    pEl.textContent = pillText;
    const bEl = document.getElementById(`${id}-bar`);
    bEl.style.width = `${clamp(barPct, 0, 100)}%`;
    if (barColor) bEl.style.background = barColor;
    document.getElementById(`${id}-meta`).textContent = metaText;
  };

  const pePct = snap.bands.pe.pct;
  setCard(
    "val-kpi-pe",
    snap.peTtm !== null ? `${fmtNum(snap.peTtm, 1)}x` : "亏损/无",
    pePct !== null ? `${pePct.toFixed(0)}% 分位` : "--",
    pePct !== null ? (pePct <= 25 ? "pill-pass" : (pePct >= 75 ? "pill-hot" : "pill-mid")) : "pill-fail",
    pePct ?? 0,
    pePct !== null && pePct <= 25 ? "var(--emerald)" : (pePct >= 75 ? "var(--crimson)" : "var(--ochre)"),
    snap.bands.pe.p50 !== null
      ? `P20 ${fmtNum(snap.bands.pe.p20, 1)}x · 中位 ${fmtNum(snap.bands.pe.p50, 1)}x · P80 ${fmtNum(snap.bands.pe.p80, 1)}x`
      : "盈利收益率 EY: " + (snap.peTtm > 0 ? `${(100 / snap.peTtm).toFixed(2)}%` : "--")
  );

  const pbPct = snap.bands.pb.pct;
  setCard(
    "val-kpi-pb",
    snap.pb !== null ? `${fmtNum(snap.pb, 2)}x` : "--",
    pbPct !== null ? `${pbPct.toFixed(0)}% 分位` : "--",
    pbPct !== null ? (pbPct <= 25 ? "pill-pass" : (pbPct >= 75 ? "pill-hot" : "pill-mid")) : "pill-fail",
    pbPct ?? 0,
    "var(--indigo)",
    snap.bvps !== null
      ? `每股净资产 ¥${fmtNum(snap.bvps)} · 中位 ${snap.bands.pb.p50 !== null ? fmtNum(snap.bands.pb.p50, 2) + "x" : "--"}`
      : "缺少净资产数据"
  );

  const psPct = snap.bands.ps.pct;
  setCard(
    "val-kpi-ps",
    snap.psTtm !== null ? `${fmtNum(snap.psTtm, 2)}x` : "--",
    psPct !== null ? `${psPct.toFixed(0)}% 分位` : "--",
    psPct !== null ? (psPct <= 25 ? "pill-pass" : (psPct >= 75 ? "pill-hot" : "pill-mid")) : "pill-fail",
    psPct ?? 0,
    "var(--ochre)",
    `TTM营收 ${fmtMoneyShort(snap.qNow?.ttmRev)} · 中位 ${snap.bands.ps.p50 !== null ? fmtNum(snap.bands.ps.p50, 2) + "x" : "--"}`
  );

  const fcfY = snap.fcfYieldPct;
  const fcfPct = snap.bands.fcf.pct;
  setCard(
    "val-kpi-fcf",
    fcfY !== null ? fmtPct(fcfY, 2, false) : "--",
    fcfY !== null ? (fcfY >= 5 ? "高现金回报" : (fcfY >= 2 ? "中性" : (fcfY >= 0 ? "偏低" : "负FCF"))) : "--",
    fcfY !== null ? (fcfY >= 5 ? "pill-pass" : (fcfY >= 0 ? "pill-mid" : "pill-hot")) : "pill-fail",
    fcfPct ?? clamp((fcfY || 0) * 10, 0, 100),
    fcfY !== null && fcfY >= 0 ? "var(--emerald)" : "var(--crimson)",
    `TTM FCF ${fmtMoneyShort(snap.qNow?.ttmFcf)} · P/FCF ${snap.pFcf !== null ? fmtNum(snap.pFcf, 1) + "x" : "--"}`
  );

  const divY = snap.approxDivYieldPct;
  const bb = snap.buybackYieldPct || 0;
  const shY = snap.shareholderYieldPct ?? divY;
  let divBaseMeta = "";
  if (snap.exDiv) {
    if (snap.exDiv.count > 0) {
      const dpsStr = fmtNum(snap.dpsTtm, snap.dpsTtm >= 10 ? 2 : 3);
      const payStr = snap.approxPayoutPct !== null ? `${snap.approxPayoutPct.toFixed(0)}%` : "--";
      divBaseMeta = `股息 ${divY !== null ? divY.toFixed(2) + "%" : "--"} (¥${dpsStr}·派息${payStr}${snap.exDiv.hasSplit ? "·含送转" : ""})`;
    } else {
      divBaseMeta = "近12月零现金除息";
    }
  } else {
    divBaseMeta = snap.qNow?.divIncludesBondInterest
      ? `股息 ${divY !== null ? divY.toFixed(2) + "%" : "--"} (含债券/优先股付息)`
      : `近似股息 ${divY !== null ? divY.toFixed(2) + "%" : "--"} · 派息 ${snap.approxPayoutPct !== null ? snap.approxPayoutPct.toFixed(0) + "%" : "--"}`;
  }
  const bbMeta = Math.abs(bb) >= 0.05
    ? ` · ${bb > 0 ? "净回购 +" : "净稀释 "}${bb.toFixed(2)}%${snap.buybackNote ? ` (${snap.buybackNote})` : ""}`
    : (snap.shareHistoryCount > 0 && !(snap.exDiv?.count > 0) ? " · 近12月股本无变动" : "");
  const divMeta = `${divBaseMeta}${bbMeta}`;

  let shPillText = "--";
  let shPillCls = "pill-fail";
  if (bb >= 0.05) {
    shPillText = `含回购 +${bb.toFixed(2)}%`;
    shPillCls = "pill-pass";
  } else if (bb <= -0.05) {
    shPillText = `含稀释 ${bb.toFixed(2)}%`;
    shPillCls = (shY !== null && shY < 0) ? "pill-hot" : "pill-mid";
  } else if (shY !== null) {
    shPillText = shY >= 3.0 ? "高股息" : (shY >= 1.5 ? "稳健" : (shY > 0 ? "低派息" : "零派息"));
    shPillCls = shY >= 3.0 ? "pill-pass" : (shY > 0 ? "pill-mid" : "pill-fail");
  }
  setCard(
    "val-kpi-div",
    shY !== null ? fmtPct(shY, 2, false) : "--",
    shPillText,
    shPillCls,
    shY !== null ? clamp(Math.max(0, shY) * 18, shY > 0 ? 4 : 0, 100) : 0,
    (shY !== null && shY < 0) ? "var(--crimson)" : "var(--emerald)",
    divMeta
  );
  const divMetaEl = document.getElementById("val-kpi-div-meta");
  if (divMetaEl) {
    const tipParts = [];
    if (snap.exDiv?.events?.length) {
      tipParts.push("除息: " + snap.exDiv.events.map(e => `${e.date} ¥${e.dps.toFixed(3)}/股`).join(" | "));
    }
    if (snap.buybackDetail) {
      const bd = snap.buybackDetail;
      tipParts.push(`历史股本: ${bd.prevDate} ${(bd.prevShares / 1e8).toFixed(2)}亿股 → ${bd.curDate} ${(bd.curShares / 1e8).toFixed(2)}亿股 (${bd.source}${bd.note ? "·" + bd.note : ""})`);
    }
    divMetaEl.title = tipParts.join("\n");
  }

  const peg = snap.peg;
  setCard(
    "val-kpi-peg",
    peg !== null ? fmtNum(peg, 2) : "--",
    peg !== null ? (peg <= 1.0 ? "PEG ≤ 1 占优" : (peg <= 1.8 ? "合理成长" : "成长溢价偏高")) : "不适用",
    peg !== null ? (peg <= 1.0 ? "pill-pass" : (peg <= 1.8 ? "pill-mid" : "pill-hot")) : "pill-fail",
    peg !== null ? clamp((peg / 2.5) * 100, 5, 100) : 0,
    "var(--indigo)",
    `${snap.cagrLabel}: ${snap.cagrNp !== null ? fmtPct(snap.cagrNp, 1, true) : "--"}`
  );

  // Overall valuation summary badge
  const overallPill = document.getElementById("val-overall-pill");
  const scores = [];
  if (pePct !== null) scores.push(pePct <= 25 ? 1 : (pePct >= 75 ? -1 : 0));
  if (pbPct !== null) scores.push(pbPct <= 25 ? 1 : (pbPct >= 75 ? -1 : 0));
  if (fcfY !== null) scores.push(fcfY >= 5 ? 1 : (fcfY < 1 ? -1 : 0));
  const netScore = scores.reduce((a, b) => a + b, 0);
  if (!scores.length) {
    overallPill.className = "status-pill pill-fail";
    overallPill.textContent = "部分指标缺失";
  } else if (netScore >= 2) {
    overallPill.className = "status-pill pill-pass";
    overallPill.textContent = "综合估值偏低 · 具备安全边际";
  } else if (netScore <= -2) {
    overallPill.className = "status-pill pill-hot";
    overallPill.textContent = "综合估值偏高 · 注意回撤风险";
  } else {
    overallPill.className = "status-pill pill-mid";
    overallPill.textContent = "综合估值中性 · 结合成长与DCF交叉验证";
  }
}


export function renderFootballField(snap) {
  const container = document.getElementById("val-football");
  const sumEl = document.getElementById("val-dcf-summary");
  const curPrice = snap.unadjPrice;
  const shares = snap.shares;
  const baseCF = getActiveBaseCashFlow(snap);
  const { dcfG1, dcfG2, dcfR, dcfMos, dcfBase, dcfNetCashAdj, rimAllowBelowBook } = STATE.stock;

  const dcfNameMap = {
    fcf_ttm: "两阶段 DCF",
    fcf_3y: "两阶段 DCF (3Y)",
    np_ttm: "两阶段 DCF (净利)",
    div_ttm: "两阶段 DDM (分红)"
  };
  const dcfLabel = dcfNameMap[dcfBase] || "两阶段 DCF";
  const dcfTag = dcfBase === "div_ttm" ? "DDM 中枢" : "DCF 中枢";
  const ncAdj = getEffectiveNetCashPerShare(snap);
  const ncActive = dcfNetCashAdj && !snap.isFinancial && dcfBase !== "div_ttm";

  const dcfMidObj = calcTwoStageDCF(baseCF, shares, dcfG1, dcfG2, dcfR);
  const dcfLowObj = calcTwoStageDCF(baseCF, shares, dcfG1, dcfG2, Math.min(18, dcfR + 1.0));
  const dcfHighObj = calcTwoStageDCF(baseCF, shares, dcfG1, dcfG2, Math.max(dcfG2 + 1.0, dcfR - 1.0));

  const applyNc = (obj) => {
    if (!obj) return null;
    const v = obj.valuePerShare + ncAdj;
    return v > 0 ? v : null;
  };
  const dcfMid = applyNc(dcfMidObj);
  const dcfLow = applyNc(dcfLowObj);
  const dcfHigh = applyNc(dcfHighObj);
  const dcfTarget = dcfMid !== null ? dcfMid * (1 - dcfMos / 100) : null;
  const opCurPrice = (curPrice > 0 && curPrice - ncAdj > 0) ? (curPrice - ncAdj) : null;
  const impliedR = opCurPrice !== null ? solveImpliedReturn(baseCF, shares, dcfG1, dcfG2, opCurPrice) : null;
  if (dcfMid !== null && curPrice > 0) {
    const upPct = ((dcfMid / curPrice - 1) * 100);
    const irrTxt = impliedR !== null ? ` · 现价隐含回报 ${impliedR.toFixed(2)}%` : "";
    const ncTxt = ncActive ? ` · 含净现金 ${ncAdj >= 0 ? "+" : ""}¥${fmtNum(ncAdj)}/股` : "";
    sumEl.textContent = `${dcfTag} ¥${fmtNum(dcfMid)} (${fmtPct(upPct, 1, true)}) · 安全边际买点 ¥${fmtNum(dcfTarget)}${irrTxt}${ncTxt}`;
  } else if (ncActive && dcfMidObj?.valuePerShare > 0 && dcfMidObj.valuePerShare + ncAdj <= 0) {
    sumEl.textContent = `计入净现金(${ncAdj >= 0 ? "+" : ""}¥${fmtNum(ncAdj)}/股)后权益估值 ≤ 0，可关闭「DCF含净现金」`;
  } else {
    sumEl.textContent = baseCF <= 0 ? "所选基期现金流 ≤ 0，可切换至“TTM 归母净利”" : "参数无效 (须满足 r > g₂ + 0.5%)";
  }

  const rimMid = calcRIM(snap.bvps, snap.roeTtm, snap.approxPayoutPct, dcfG2, dcfR, rimAllowBelowBook);
  const rimLow = calcRIM(snap.bvps, snap.roeTtm, snap.approxPayoutPct, dcfG2, Math.min(18, dcfR + 1.0), rimAllowBelowBook);
  const rimHigh = calcRIM(snap.bvps, snap.roeTtm, snap.approxPayoutPct, dcfG2, Math.max(dcfG2 + 1.0, dcfR - 1.0), rimAllowBelowBook);

  const peBand = snap.bands.pe;
  const peLow = (snap.epsTtm > 0 && peBand.p20 !== null) ? snap.epsTtm * peBand.p20 : null;
  const peMid = (snap.epsTtm > 0 && peBand.p50 !== null) ? snap.epsTtm * peBand.p50 : null;
  const peHigh = (snap.epsTtm > 0 && peBand.p80 !== null) ? snap.epsTtm * peBand.p80 : null;

  const pbBand = snap.bands.pb;
  const pbLow = (snap.bvps > 0 && pbBand.p20 !== null) ? snap.bvps * pbBand.p20 : null;
  const pbMid = (snap.bvps > 0 && pbBand.p50 !== null) ? snap.bvps * pbBand.p50 : null;
  const pbHigh = (snap.bvps > 0 && pbBand.p80 !== null) ? snap.bvps * pbBand.p80 : null;

  const models = [
    { name: dcfLabel, sub: `r=${dcfR.toFixed(1)}%±1% | MOS ${dcfMos}%${ncActive ? " | +净现金" : ""}`, low: dcfLow, mid: dcfMid, high: dcfHigh, target: dcfTarget, color: "" },
    { name: "剩余收益 RIM", sub: rimAllowBelowBook ? "PB-ROE 5年渐近(允许破净)" : "PB-ROE 5年渐近", low: rimLow, mid: rimMid, high: rimHigh, color: "indigo" },
    { name: "历史 PE_TTM 锚", sub: `P20 ~ P50 ~ P80`, low: peLow, mid: peMid, high: peHigh, color: "ochre" },
    { name: "历史 PB 锚", sub: `P20 ~ P50 ~ P80`, low: pbLow, mid: pbMid, high: pbHigh, color: "ochre" }
  ];

  const allNums = [];
  if (curPrice > 0) allNums.push(curPrice);
  for (const m of models) {
    if (m.low > 0) allNums.push(m.low);
    if (m.mid > 0) allNums.push(m.mid);
    if (m.high > 0) allNums.push(m.high);
    if (m.target > 0) allNums.push(m.target);
  }

  if (allNums.length < 2) {
    container.innerHTML = `<div class="flat" style="text-align:center;padding:30px 0;">当前标的可计算模型较少（可能存在亏损或样本不足）</div>`;
    return;
  }

  const refVals = [];
  if (curPrice > 0) refVals.push(curPrice);
  for (const m of models) {
    if (m.mid > 0) refVals.push(m.mid);
  }
  refVals.sort((a, b) => a - b);
  const rawMin = Math.min(...allNums);
  const rawMax = Math.max(...allNums);
  const medRef = refVals.length ? refVals[Math.floor(refVals.length / 2)] : (curPrice || rawMax);
  const anchor = Math.max(curPrice || 0, medRef || 0);
  const axisMin = Math.max(0, rawMin * 0.85);
  const cappedMax = (anchor > 0 && rawMax > anchor * 2.6) ? (anchor * 2.4) : (rawMax * 1.10);
  const axisMax = Math.max(axisMin + 1, cappedMax);
  const toPct = (v) => clamp(((v - axisMin) / (axisMax - axisMin)) * 100, 0, 100);
  const curPct = curPrice > 0 ? toPct(curPrice) : null;

  container.innerHTML = models.map((m, idx) => {
    const hasRange = m.low > 0 && m.high > 0 && m.mid > 0;
    const lo = hasRange ? Math.min(m.low, m.high) : null;
    const hi = hasRange ? Math.max(m.low, m.high) : null;
    const leftPct = lo !== null ? Math.min(97, toPct(lo)) : 0;
    const rightPct = hi !== null ? toPct(hi) : leftPct;
    const widthPct = (lo !== null && hi !== null) ? Math.max(2, Math.min(100 - leftPct, rightPct - leftPct)) : 0;
    const midPct = m.mid > 0 ? toPct(m.mid) : null;
    const mosPct = m.target > 0 ? toPct(m.target) : null;
    const upside = (m.mid > 0 && curPrice > 0) ? ((m.mid / curPrice - 1) * 100) : null;

    return `
      <div class="fb-row">
        <div class="fb-name">${esc(m.name)}<small>${esc(m.sub)}</small></div>
        <div class="fb-track">
          ${hasRange ? `<div class="fb-band ${m.color}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;"></div>` : ""}
          ${mosPct !== null ? `<div class="fb-mos-tick" style="left:${mosPct.toFixed(2)}%;" title="安全边际买点 ¥${fmtNum(m.target)}"></div>` : ""}
          ${midPct !== null ? `<div class="fb-mid-dot" style="left:${midPct.toFixed(2)}%;" title="中枢 ¥${fmtNum(m.mid)}"></div>` : ""}
          ${curPct !== null ? `<div class="fb-cur-line" style="left:${curPct.toFixed(2)}%;">${idx === 0 ? `<span class="fb-cur-label">现价 ¥${fmtNum(curPrice)}</span>` : ""}</div>` : ""}
        </div>
        <div class="fb-vals">
          ${hasRange
            ? `<strong>¥${fmtNum(m.mid)}</strong><small class="${upside !== null ? (upside >= 0 ? "down" : "up") : "flat"}" style="color:${upside >= 0 ? "var(--emerald)" : "var(--crimson)"};">${upside !== null ? fmtPct(upside, 1, true) : "--"} (${fmtNum(lo, 0)}~${fmtNum(hi, 0)})</small>`
            : `<span class="flat">不适用</span>`}
        </div>
      </div>
    `;
  }).join("");
}

export function renderDcfSensitivity(snap) {
  const wrap = document.getElementById("val-sens-wrap");
  const baseCF = getActiveBaseCashFlow(snap);
  const shares = snap.shares;
  const curPrice = snap.unadjPrice;
  const { dcfG1, dcfG2, dcfR } = STATE.stock;

  if (!(baseCF > 0) || !(shares > 0)) {
    wrap.innerHTML = `<div class="flat" style="text-align:center;padding:30px 0;">当前基期现金流 ≤ 0，无法生成 DCF 敏感性矩阵（请切换为“TTM 归母净利”或检查现金流）</div>`;
    return;
  }

  const ncAdj = getEffectiveNetCashPerShare(snap);
  const rSteps = [-1.0, -0.5, 0, 0.5, 1.0].map(d => +(clamp(dcfR + d, Math.max(dcfG2 + 1.0, 5.0), 16.0)).toFixed(2));
  const gSteps = [-4, -2, 0, 2, 4].map(d => +(dcfG1 + d).toFixed(1));

  let html = `<table class="sens-table"><thead><tr><th class="left">r \\ g₁</th>${gSteps.map(g => `<th>${g.toFixed(1)}%</th>`).join("")}</tr></thead><tbody>`;
  for (let ri = 0; ri < rSteps.length; ri++) {
    const rVal = rSteps[ri];
    html += `<tr><td class="left"><strong>${rVal.toFixed(2)}%</strong></td>`;
    for (let gi = 0; gi < gSteps.length; gi++) {
      const gVal = gSteps[gi];
      const res = calcTwoStageDCF(baseCF, shares, gVal, dcfG2, rVal);
      const rawVal = res ? res.valuePerShare + ncAdj : null;
      const val = (rawVal !== null && rawVal > 0) ? rawVal : null;
      const isCenter = ri === 2 && gi === 2;
      if (val === null) {
        html += `<td class="flat">--</td>`;
        continue;
      }
      const diff = curPrice > 0 ? ((val / curPrice - 1) * 100) : null;
      let cls = "hm-fair";
      if (diff !== null) {
        if (diff >= 15) cls = "hm-cheap";
        else if (diff <= -10) cls = "hm-rich";
      }
      if (isCenter) cls += " hm-center";
      html += `<td class="${cls}">¥${fmtNum(val, val >= 100 ? 0 : 1)}<span class="sens-sub">${diff !== null ? fmtPct(diff, 0, true) : ""}</span></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

export function renderDuPont(snap) {
  const grid = document.getElementById("val-dupont-grid");
  const acc = snap.accrualRatio;
  const netCash = snap.netCashToMktCap;
  const cards = [
    {
      lbl: "TTM ROE (估算)",
      val: snap.roeTtm !== null ? fmtPct(snap.roeTtm, 2, false) : "--",
      sub: "净利率 × 周转率 × 权益乘数"
    },
    {
      lbl: "销售净利率 (TTM)",
      val: snap.netMargin !== null ? fmtPct(snap.netMargin, 2, false) : "--",
      sub: "盈利护城河厚度"
    },
    {
      lbl: "总资产周转率 (TTM)",
      val: snap.assetTurnover !== null ? `${fmtNum(snap.assetTurnover, 2)}x` : "--",
      sub: "TTM营收 / 资产总计"
    },
    {
      lbl: "权益乘数",
      val: snap.equityMultiplier !== null ? `${fmtNum(snap.equityMultiplier, 2)}x` : "--",
      sub: "资产总计 / 股东权益"
    },
    {
      lbl: "应计比率 / 净现金比",
      val: `${acc !== null ? fmtPct(acc, 1, true) : "--"} / ${netCash !== null ? fmtPct(netCash, 1, true) : "--"}`,
      sub: acc !== null && acc <= 0 ? "应计 ≤ 0（盈利含金量高）" : "净现金=(现金-总负债)/市值"
    }
  ];
  grid.innerHTML = cards.map(c => `
    <div class="dp-card">
      <div class="dp-lbl">${esc(c.lbl)}</div>
      <div class="dp-val">${esc(c.val)}</div>
      <div class="dp-sub">${esc(c.sub)}</div>
    </div>
  `).join("");
}

export function renderDcfWarning(snap) {
  const warnEl = document.getElementById("val-dcf-warn");
  if (!warnEl || !snap) return;
  const base = STATE.stock.dcfBase;
  const baseCF = getActiveBaseCashFlow(snap);
  const ttmNp = snap.qNow?.ttmNp ?? 0;

  if (snap.isFinancial && (base === "fcf_ttm" || base === "fcf_3y")) {
    warnEl.innerHTML = `<div class="alert-title">金融标的 FCF 口径失真提示</div><div class="alert-desc">银行/保险/券商的经营现金流含客户存贷款、保费准备金及同业资金变动（当前基期 ${fmtMoneyShort(baseCF)}），直接套用 FCF 会显著高估 DCF。建议切换为上方「TTM 归母净利」或「TTM 分红(DDM)」口径。</div>`;
    warnEl.classList.remove("hidden");
  } else if (!snap.isFinancial && base !== "np_ttm" && baseCF > 0 && ttmNp > 0 && baseCF > ttmNp * 1.8) {
    warnEl.innerHTML = `<div class="alert-title">基期现金流显著高于净利提示</div><div class="alert-desc">所选基期现金流 (${fmtMoneyShort(baseCF)}) 达 TTM 归母净利 (${fmtMoneyShort(ttmNp)}) 的 ${(baseCF / ttmNp).toFixed(1)} 倍，DCF 结果可能受营运资金波动放大，建议切换「3年均值FCF」或「TTM 归母净利」交叉核对。</div>`;
    warnEl.classList.remove("hidden");
  } else {
    warnEl.classList.add("hidden");
    warnEl.textContent = "";
  }
}

export function renderValuationModels() {
  const snap = STATE.stock.valSnap;
  if (!snap) return;
  syncValuationControls();
  renderDcfWarning(snap);
  renderFootballField(snap);
  renderDcfSensitivity(snap);
}

export function renderStockValuation() {
  const snap = computeValuationSnapshot();
  STATE.stock.valSnap = snap;
  autoFitDcfDefaults(snap);
  renderValuationKPIs(snap);
  if (STATE.activeTab === "stock") {
    renderValuationBandChart(snap);
  }
  renderValuationModels();
  renderDuPont(snap);
}
