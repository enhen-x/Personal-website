import { fmtPct, median, clamp, daysBetweenDates, addDaysIso } from "./utils.js";

export function quarterIndex(fy, fp) {
  const qMap = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
  const q = qMap[String(fp || "").toUpperCase()] || 0;
  const y = Number(fy);
  if (!Number.isFinite(y) || !q) return 0;
  return y * 4 + q;
}

export function calcQuantile(sortedArr, q) {
  if (!sortedArr.length) return null;
  const idx = (sortedArr.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

export function percentileRank(arr, val) {
  if (!arr.length || val === null || val === undefined || !Number.isFinite(val)) return null;
  let le = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] <= val) le++;
  }
  return (le / arr.length) * 100;
}

export function resolveEffectiveReportDate(r) {
  const erd = String(r?.effective_report_date || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(erd)) return erd;
  const pe = String(r?.period_end || `${r?.fiscal_year || 2000}-12-31`).slice(0, 10);
  const rd = String(r?.report_date || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(rd) && /^\d{4}-\d{2}-\d{2}$/.test(pe)) {
    const lag = daysBetweenDates(pe, rd);
    if (lag >= 0 && lag <= 200) return rd;
  }
  const fp = String(r?.fiscal_period || "").toUpperCase();
  const fallbackLag = fp === "Q1" ? 30 : (fp === "Q2" ? 60 : (fp === "Q3" ? 30 : 115));
  return addDaysIso(pe, fallbackLag) || pe;
}

export function buildSplitMultiplierHelper(adjustmentEvents) {
  const events = (adjustmentEvents || [])
    .filter(e => e && e.ex_date)
    .map(e => {
      const perShareBonus = Number(e.per_share_bonus) || 0;
      const allotmentRatio = Number(e.allotment_ratio) || 0;
      return {
        ex_date: String(e.ex_date).slice(0, 10),
        per_share_bonus: perShareBonus,
        allotment_ratio: allotmentRatio,
        bonusRatio: 1 + perShareBonus,
        ratio: 1 + perShareBonus + allotmentRatio,
        dividend_per_share: Number(e.dividend_per_share) || 0
      };
    })
    .sort((a, b) => a.ex_date.localeCompare(b.ex_date));

  const splitEvents = events.filter(e => e.ratio > 1.0001);
  let cum = 1;
  const cumSteps = splitEvents.map(e => {
    const before = cum;
    cum *= e.ratio;
    return { ex_date: e.ex_date, before, after: cum };
  });

  const bonusEvents = events.filter(e => e.bonusRatio > 1.0001);
  let bonusCum = 1;
  const bonusCumSteps = bonusEvents.map(e => {
    const before = bonusCum;
    bonusCum *= e.bonusRatio;
    return { ex_date: e.ex_date, before, after: bonusCum };
  });

  const getMultAt = (dateStr) => {
    if (!dateStr || !cumSteps.length) return 1;
    let mult = 1;
    for (let i = 0; i < cumSteps.length; i++) {
      if (cumSteps[i].ex_date <= dateStr) mult = cumSteps[i].after;
      else break;
    }
    return mult;
  };

  const getMultBefore = (dateStr) => {
    if (!dateStr || !cumSteps.length) return 1;
    let mult = 1;
    for (let i = 0; i < cumSteps.length; i++) {
      if (cumSteps[i].ex_date < dateStr) mult = cumSteps[i].after;
      else break;
    }
    return mult;
  };

  const getBonusMultAt = (dateStr) => {
    if (!dateStr || !bonusCumSteps.length) return 1;
    let mult = 1;
    for (let i = 0; i < bonusCumSteps.length; i++) {
      if (bonusCumSteps[i].ex_date <= dateStr) mult = bonusCumSteps[i].after;
      else break;
    }
    return mult;
  };

  return { events, splitEvents, cumSteps, bonusEvents, bonusCumSteps, getMultAt, getMultBefore, getBonusMultAt };
}

export function normalizeShareTimeline(shareData, maxDate = "2099-12-31") {
  const raw = Array.isArray(shareData) ? shareData : (Array.isArray(shareData?.items) ? shareData.items : []);
  if (!raw.length) return [];
  const capDate = /^\d{4}-\d{2}-\d{2}/.test(String(maxDate || "")) ? String(maxDate).slice(0, 10) : "2099-12-31";
  const byDate = new Map();
  for (const it of raw) {
    if (!it || !it.change_date) continue;
    const cd = String(it.change_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cd) || cd > capDate) continue;
    const tot = Number(it.total_shares);
    if (!(tot > 0) || !Number.isFinite(tot)) continue;
    byDate.set(cd, {
      change_date: cd,
      announce_date: it.announce_date ? String(it.announce_date).slice(0, 10) : "",
      reason_code: String(it.reason_code || ""),
      change_reason: String(it.change_reason || "").trim(),
      total_shares: tot
    });
  }
  return [...byDate.values()].sort((a, b) => a.change_date.localeCompare(b.change_date));
}

export function computeNetBuybackFromShares(shareData, refDate, splitHelper) {
  const effectiveRefDate = /^\d{4}-\d{2}-\d{2}/.test(String(refDate || ""))
    ? String(refDate).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const rows = normalizeShareTimeline(shareData, effectiveRefDate);
  if (!rows.length) return null;

  const curIdx = rows.length - 1;
  const curRow = rows[curIdx];
  const targetPrevDate = addDaysIso(effectiveRefDate, -365) || effectiveRefDate;

  let prevIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].change_date <= targetPrevDate) {
      prevIdx = i;
      break;
    }
  }
  if (prevIdx < 0) return null;

  const prevRow = rows[prevIdx];
  if (prevIdx === curIdx) {
    return {
      buybackYieldPct: 0,
      rawPct: 0,
      source: "历史股本(无变动)",
      note: "近12月总股本无变动",
      prevDate: prevRow.change_date,
      curDate: curRow.change_date,
      prevShares: prevRow.total_shares,
      curShares: curRow.total_shares,
      adjPrevShares: prevRow.total_shares,
      bonusFactor: 1,
      reasons: []
    };
  }

  const matchedStepIdx = new Set();
  let bonusFactor = 1;
  const prevPlus10 = addDaysIso(prevRow.change_date, 10) || prevRow.change_date;
  const prevMinus10 = addDaysIso(prevRow.change_date, -10) || prevRow.change_date;
  const curMinus10 = addDaysIso(curRow.change_date, -10) || curRow.change_date;
  const curPlus10 = addDaysIso(curRow.change_date, 10) || curRow.change_date;

  for (const be of (splitHelper?.bonusEvents || [])) {
    const k = be.bonusRatio;
    const exD = be.ex_date;
    if (!(k > 1.0001) || !exD) continue;
    if (exD > prevPlus10 && exD < curMinus10) {
      bonusFactor *= k;
      for (let idx = prevIdx + 1; idx <= curIdx; idx++) {
        if (matchedStepIdx.has(idx)) continue;
        if (Math.abs(daysBetweenDates(rows[idx].change_date, exD)) <= 10) {
          const stepRatio = rows[idx].total_shares / rows[idx - 1].total_shares;
          if (/送股|转增|红股|拆/.test(rows[idx].change_reason) || (stepRatio >= k * 0.82 && stepRatio <= k * 1.18)) {
            matchedStepIdx.add(idx);
          }
        }
      }
    } else if (exD >= prevMinus10 && exD <= curPlus10) {
      for (let idx = prevIdx + 1; idx <= curIdx; idx++) {
        if (matchedStepIdx.has(idx)) continue;
        if (Math.abs(daysBetweenDates(rows[idx].change_date, exD)) <= 10) {
          const stepRatio = rows[idx].total_shares / rows[idx - 1].total_shares;
          if (/送股|转增|红股|拆/.test(rows[idx].change_reason) || (stepRatio >= k * 0.82 && stepRatio <= k * 1.18)) {
            bonusFactor *= k;
            matchedStepIdx.add(idx);
            break;
          }
        }
      }
    }
  }

  // Fallback if adjustment_events lacks a pure bonus-split entry
  for (let idx = prevIdx + 1; idx <= curIdx; idx++) {
    if (matchedStepIdx.has(idx)) continue;
    const rsn = rows[idx].change_reason;
    if (/送股|转增/.test(rsn) && !/增发|配股|回购|激励|转债/.test(rsn)) {
      const stepRatio = rows[idx].total_shares / rows[idx - 1].total_shares;
      if (stepRatio >= 1.05 && stepRatio <= 10) {
        bonusFactor *= stepRatio;
        matchedStepIdx.add(idx);
      }
    }
  }

  const adjPrevShares = prevRow.total_shares * bonusFactor;
  const rawPct = adjPrevShares > 0 ? ((adjPrevShares - curRow.total_shares) / adjPrevShares) * 100 : 0;
  const buybackYieldPct = Math.abs(rawPct) < 0.05 ? 0 : clamp(rawPct, -15, 15);

  const betweenRows = rows.slice(prevIdx + 1, curIdx + 1);
  const allReasons = [];
  for (const br of betweenRows) {
    if (br.change_reason && !allReasons.includes(br.change_reason)) {
      allReasons.push(br.change_reason);
    }
  }
  const nonPeriodic = allReasons.filter(r => r !== "定期报告");
  const reasons = (nonPeriodic.length ? nonPeriodic : allReasons).slice(0, 2);

  let source = "历史股本(无变动)";
  let note = reasons.length ? reasons.join("/") : "股本基本不变";
  if (buybackYieldPct >= 0.05) {
    source = "历史股本净回购";
    note = reasons.length ? reasons.join("/") : "股本收缩";
  } else if (buybackYieldPct <= -0.05) {
    source = "历史股本净稀释";
    note = reasons.length ? reasons.join("/") : "股本扩张";
  }

  return {
    buybackYieldPct,
    rawPct,
    source,
    note,
    prevDate: prevRow.change_date,
    curDate: curRow.change_date,
    prevShares: prevRow.total_shares,
    curShares: curRow.total_shares,
    adjPrevShares,
    bonusFactor,
    reasons
  };
}

export function extractExDividendFromEvents(adjustmentEvents, lastDate, splitHelper) {
  if (!Array.isArray(adjustmentEvents) || !lastDate || lastDate === "--") return null;
  const sh = splitHelper || buildSplitMultiplierHelper(adjustmentEvents);
  const multNow = sh.getMultAt(lastDate) || 1;
  const cashEvents = [];
  for (const e of adjustmentEvents) {
    if (!e || !e.ex_date) continue;
    const exDate = String(e.ex_date).slice(0, 10);
    if (exDate > lastDate) continue;
    const rawDps = Number(e.dividend_per_share);
    if (!(rawDps > 0)) continue;
    const multBefore = sh.getMultBefore(exDate) || 1;
    const adjFactor = multNow / multBefore;
    const dps = rawDps / (adjFactor > 0 ? adjFactor : 1);
    if (dps > 0.0005) {
      cashEvents.push({
        date: exDate,
        rawDps,
        splitK: 1 + (Number(e.per_share_bonus) || 0) + (Number(e.allotment_ratio) || 0),
        dps
      });
    }
  }
  cashEvents.sort((a, b) => a.date.localeCompare(b.date));

  const in365 = cashEvents.filter(e => daysBetweenDates(e.date, lastDate) <= 365);
  let chosen = in365;
  let note = "官方除息事件";

  if (chosen.length === 2 && daysBetweenDates(chosen[0].date, chosen[1].date) >= 280) {
    chosen = chosen.slice(-1);
    note = "官方除息(去重跨期年报)";
  } else if (
    chosen.length === 3 &&
    daysBetweenDates(chosen[0].date, chosen[1].date) >= 125 &&
    daysBetweenDates(chosen[1].date, chosen[2].date) >= 125
  ) {
    chosen = chosen.slice(-2);
    note = "官方除息(去重跨期中期)";
  } else if (chosen.length === 0) {
    const near = cashEvents.filter(e => {
      const d = daysBetweenDates(e.date, lastDate);
      return d > 365 && d <= 395;
    });
    if (near.length === 1) {
      chosen = near;
      note = "官方除息(近13月顺延)";
    }
  }

  const dpsTtm = chosen.reduce((s, e) => s + e.dps, 0);
  const hasSplit = sh.splitEvents.some(se => chosen.some(ce => se.ex_date >= ce.date && se.ex_date <= lastDate));
  return {
    dpsTtm,
    count: chosen.length,
    events: chosen,
    hasSplit,
    source: "events",
    note
  };
}

export function computeDividendStability(adjustmentEvents, lastDate, splitHelper) {
  const emptyRes = {
    divStabilityScore: 0,
    divStabilityGrade: "无分红",
    divConsecYears: 0,
    divYearsIn5: 0,
    divCv5y: null,
    divCutCount5y: 0,
    divCagr3y: null,
    divCagr5y: null
  };
  if (!Array.isArray(adjustmentEvents) || !adjustmentEvents.length) return emptyRes;

  const refDate = (lastDate && /^\d{4}-\d{2}-\d{2}/.test(String(lastDate)))
    ? String(lastDate).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const curYear = Number(refDate.slice(0, 4));
  const curMonth = Number(refDate.slice(5, 7));
  if (!Number.isFinite(curYear) || !Number.isFinite(curMonth)) return emptyRes;

  const sh = splitHelper || buildSplitMultiplierHelper(adjustmentEvents);
  const multNow = sh.getMultAt(refDate) || 1;
  const byYear = new Map();

  for (const e of adjustmentEvents) {
    if (!e || !e.ex_date) continue;
    const exDate = String(e.ex_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate) || exDate > refDate) continue;
    const rawDps = Number(e.dividend_per_share);
    if (!(rawDps > 0)) continue;
    const multBefore = sh.getMultBefore(exDate) || 1;
    const adjFactor = multNow / multBefore;
    const dps = rawDps / (adjFactor > 0 ? adjFactor : 1);
    if (dps > 0.0005 && Number.isFinite(dps)) {
      const y = Number(exDate.slice(0, 4));
      byYear.set(y, (byYear.get(y) || 0) + dps);
    }
  }

  const hasPaid = (y) => (byYear.get(y) || 0) > 0.0005;
  let anyPaid = false;
  for (const v of byYear.values()) {
    if (v > 0.0005) {
      anyPaid = true;
      break;
    }
  }
  if (!anyPaid) return emptyRes;

  const anchorYear = (hasPaid(curYear) || curMonth > 8) ? curYear : (curYear - 1);
  let divConsecYears = 0;
  for (let y = anchorYear; y >= anchorYear - 25; y--) {
    if (hasPaid(y)) divConsecYears++;
    else break;
  }

  const curDay = Number(refDate.slice(8, 10)) || 1;
  const winEndYear = (curMonth === 12 && curDay >= 28) ? curYear : (curYear - 1);

  const vals5 = [];
  for (let y = winEndYear - 4; y <= winEndYear; y++) {
    vals5.push(byYear.get(y) || 0);
  }
  const divYearsIn5 = vals5.filter(v => v > 0.0005).length;
  const mean5 = vals5.reduce((a, b) => a + b, 0) / 5;

  let divCv5y = null;
  if (divYearsIn5 >= 2 && mean5 > 0) {
    const var5 = vals5.reduce((s, v) => s + (v - mean5) ** 2, 0) / 4;
    divCv5y = Math.sqrt(var5) / mean5;
  }

  let divCutCount5y = 0;
  for (let i = 1; i < vals5.length; i++) {
    if (vals5[i - 1] > 0.0005 && vals5[i] < vals5[i - 1] * 0.90) {
      divCutCount5y++;
    }
  }

  const divCagr3y = (vals5[1] > 0.0005 && vals5[4] > 0.0005)
    ? clamp((Math.pow(vals5[4] / vals5[1], 1 / 3) - 1) * 100, -50, 80)
    : null;
  const divCagr5y = (vals5[0] > 0.0005 && vals5[4] > 0.0005)
    ? clamp((Math.pow(vals5[4] / vals5[0], 1 / 4) - 1) * 100, -50, 80)
    : null;

  const consecPts = Math.min(40, divConsecYears * 4);
  const freqPts = (divYearsIn5 / 5) * 20;
  const cvPts = divCv5y !== null ? clamp((1 - divCv5y / 0.85) * 25, 0, 25) : 0;
  const noCutPts = Math.max(0, 15 - divCutCount5y * 7.5);
  const divStabilityScore = Math.round(clamp(consecPts + freqPts + cvPts + noCutPts, 0, 100));

  let divStabilityGrade = "波动";
  if (divStabilityScore === 0) divStabilityGrade = "无分红";
  else if (divStabilityScore >= 75 && divConsecYears >= 5) divStabilityGrade = "稳健";
  else if (divStabilityScore >= 50) divStabilityGrade = "较稳";

  return {
    divStabilityScore,
    divStabilityGrade,
    divConsecYears,
    divYearsIn5,
    divCv5y,
    divCutCount5y,
    divCagr3y,
    divCagr5y
  };
}

export function detectFinancialCompany(symbolName, incRow, balRow, ttmOcf, ttmNp) {
  const name = String(symbolName || "");
  if (/银行|保险|证券|信托|金融|人寿|人保|太保|中国平安|中金公司|东方财富|申万宏源|国泰君安|国泰海通|期货|金租|产融/.test(name)) {
    return true;
  }
  const opInc = Number(incRow?.operating_income);
  const intExp = Number(incRow?.interest_expenses);
  if (Number.isFinite(opInc) && opInc > 0 && Number.isFinite(intExp) && intExp > opInc * 0.15) {
    return true;
  }
  const debtRatio = Number(balRow?.debt_to_assets_pct);
  if (Number.isFinite(debtRatio) && debtRatio > 84 && ttmNp > 0 && ttmOcf > ttmNp * 2.2) {
    return true;
  }
  return false;
}

export function buildQuarterlyValuationSeries(finData, symbolName = "") {
  const incList = [...(finData?.income_statements || [])].sort((a, b) => quarterIndex(a.fiscal_year, a.fiscal_period) - quarterIndex(b.fiscal_year, b.fiscal_period));
  const balMap = new Map((finData?.balance_sheets || []).map(r => [`${r.fiscal_year}-${r.fiscal_period}`, r]));
  const cfsMap = new Map((finData?.cash_flow_statements || []).map(r => [`${r.fiscal_year}-${r.fiscal_period}`, r]));

  if (!incList.length) return [];

  const idxByYm = new Map();
  const divGrossYtd = new Array(incList.length).fill(null);
  const intExpYtd = new Array(incList.length).fill(null);
  const basicEpsYtd = new Array(incList.length).fill(null);
  const profitTotalYtd = new Array(incList.length).fill(null);
  const opProfitYtd = new Array(incList.length).fill(null);
  const opCostsYtd = new Array(incList.length).fill(null);
  const revYtd = new Array(incList.length).fill(null);
  const rdExpYtd = new Array(incList.length).fill(null);
  for (let i = 0; i < incList.length; i++) {
    const r = incList[i];
    const fp = String(r.fiscal_period || "").toUpperCase();
    const key = `${r.fiscal_year}-${r.fiscal_period}`;
    idxByYm.set(`${r.fiscal_year}-${fp}`, i);

    const c = cfsMap.get(key);
    if (c && c.pay_dividends_profits_interest_cash != null) {
      const divGross = Number(c.pay_dividends_profits_interest_cash);
      if (Number.isFinite(divGross)) divGrossYtd[i] = Math.max(0, divGross);
    }
    if (r.interest_expenses != null) {
      const intExp = Number(r.interest_expenses);
      if (Number.isFinite(intExp)) intExpYtd[i] = Math.max(0, intExp);
    }
    if (r.basic_eps != null && Number.isFinite(Number(r.basic_eps))) {
      basicEpsYtd[i] = Number(r.basic_eps);
    }
    if (r.profit_total != null && Number.isFinite(Number(r.profit_total))) {
      profitTotalYtd[i] = Number(r.profit_total);
    }
    if (r.operating_profit != null && Number.isFinite(Number(r.operating_profit))) {
      opProfitYtd[i] = Number(r.operating_profit);
    }
    if (r.operating_costs != null && Number.isFinite(Number(r.operating_costs))) {
      opCostsYtd[i] = Number(r.operating_costs);
    }
    if (r.operating_income != null && Number.isFinite(Number(r.operating_income))) {
      revYtd[i] = Number(r.operating_income);
    }
    const rdRaw = r.rd_expenses ?? r.research_and_development_expenses ?? r.rd_exp ?? null;
    if (rdRaw != null && Number.isFinite(Number(rdRaw))) {
      rdExpYtd[i] = Math.max(0, Number(rdRaw));
    }
  }

  const rawSharesArr = incList.map(r => {
    const np = Number(r.parent_holder_net_profit);
    const eps = Number(r.basic_eps);
    if (Number.isFinite(np) && Number.isFinite(eps) && Math.abs(eps) >= 0.05 && np * eps > 0) {
      return { shares: np / eps, src: `${r.fiscal_year}${r.fiscal_period}` };
    }
    return null;
  });

  // Forward-fill then backward-fill shares across quarters
  const filledShares = new Array(incList.length).fill(null);
  let lastValid = null;
  for (let i = 0; i < incList.length; i++) {
    if (rawSharesArr[i]) lastValid = rawSharesArr[i];
    filledShares[i] = lastValid;
  }
  let nextValid = null;
  for (let i = incList.length - 1; i >= 0; i--) {
    if (rawSharesArr[i]) nextValid = rawSharesArr[i];
    if (!filledShares[i]) filledShares[i] = nextValid;
  }

  const calcYtdTtm = (arr, i, fy, fp) => {
    if (fp === "Q4") return arr[i] !== null ? arr[i] : null;
    const prevQ4Idx = idxByYm.get(`${fy - 1}-Q4`);
    const prevSameIdx = idxByYm.get(`${fy - 1}-${fp}`);
    if (
      prevQ4Idx !== undefined &&
      prevSameIdx !== undefined &&
      arr[prevQ4Idx] !== null &&
      arr[prevSameIdx] !== null &&
      arr[i] !== null
    ) {
      return arr[prevQ4Idx] - arr[prevSameIdx] + arr[i];
    }
    return null;
  };

  const quarters = [];
  for (let i = 0; i < incList.length; i++) {
    const r = incList[i];
    const key = `${r.fiscal_year}-${r.fiscal_period}`;
    const b = balMap.get(key) || {};
    const c = cfsMap.get(key) || {};
    const qi = quarterIndex(r.fiscal_year, r.fiscal_period);
    const fp = String(r.fiscal_period || "").toUpperCase();
    const fy = Number(r.fiscal_year);

    let ttmRev = null;
    let ttmNp = null;
    let ttmOcf = null;
    let ttmCapex = null;

    if (i >= 3 && qi - quarterIndex(incList[i - 3].fiscal_year, incList[i - 3].fiscal_period) === 3) {
      let revS = 0, npS = 0, ocfS = 0, capS = 0;
      let revOk = true, npOk = true, ocfOk = true, capOk = true;
      for (let k = i - 3; k <= i; k++) {
        const rk = incList[k];
        const ck = cfsMap.get(`${rk.fiscal_year}-${rk.fiscal_period}`) || {};
        if (rk.q_operating_income == null) revOk = false; else revS += Number(rk.q_operating_income);
        if (rk.q_parent_holder_net_profit == null) npOk = false; else npS += Number(rk.q_parent_holder_net_profit);
        if (ck.q_act_cash_flow_net == null) ocfOk = false; else ocfS += Number(ck.q_act_cash_flow_net);
        if (ck.q_pay_fixed_assets_etc_cash == null) capOk = false; else capS += Math.max(0, Number(ck.q_pay_fixed_assets_etc_cash));
      }
      if (revOk) ttmRev = revS;
      if (npOk) ttmNp = npS;
      if (ocfOk) ttmOcf = ocfS;
      if (capOk) ttmCapex = capS;
    }

    // Fall back to Q4 full-year YTD figures when consecutive single-quarter fields are unavailable
    if (fp === "Q4") {
      if (ttmRev === null && r.operating_income != null) ttmRev = Number(r.operating_income);
      if (ttmNp === null && r.parent_holder_net_profit != null) ttmNp = Number(r.parent_holder_net_profit);
      if (ttmOcf === null && c.act_cash_flow_net != null) ttmOcf = Number(c.act_cash_flow_net);
      if (ttmCapex === null && c.pay_fixed_assets_etc_cash != null) ttmCapex = Math.max(0, Number(c.pay_fixed_assets_etc_cash));
    }

    // Compute TTM gross dividends/interest cash payout using exact YTD identity (prevQ4 - prevSameQ + curr)
    let ttmDivGross = null;
    const currCfsExists = Boolean(c && c.act_cash_flow_net != null);
    if (fp === "Q4") {
      if (divGrossYtd[i] !== null) ttmDivGross = divGrossYtd[i];
    } else {
      const prevQ4Idx = idxByYm.get(`${fy - 1}-Q4`);
      const prevSameIdx = idxByYm.get(`${fy - 1}-${fp}`);
      const prevQ4Div = prevQ4Idx !== undefined ? divGrossYtd[prevQ4Idx] : null;
      if (prevQ4Div !== null && prevSameIdx !== undefined && (divGrossYtd[i] !== null || currCfsExists)) {
        ttmDivGross = Math.max(0, prevQ4Div - (divGrossYtd[prevSameIdx] ?? 0) + (divGrossYtd[i] ?? 0));
      } else {
        for (let k = i; k >= Math.max(0, i - 4); k--) {
          if (String(incList[k].fiscal_period || "").toUpperCase() === "Q4" && divGrossYtd[k] !== null) {
            ttmDivGross = divGrossYtd[k];
            break;
          }
        }
      }
    }

    // Compute TTM interest expense using the same YTD identity
    let ttmIntExp = null;
    if (fp === "Q4") {
      if (intExpYtd[i] !== null) ttmIntExp = intExpYtd[i];
    } else {
      const prevQ4Idx = idxByYm.get(`${fy - 1}-Q4`);
      const prevSameIdx = idxByYm.get(`${fy - 1}-${fp}`);
      const prevQ4Int = prevQ4Idx !== undefined ? intExpYtd[prevQ4Idx] : null;
      if (prevQ4Int !== null && prevSameIdx !== undefined) {
        ttmIntExp = Math.max(0, prevQ4Int - (intExpYtd[prevSameIdx] ?? 0) + (intExpYtd[i] ?? 0));
      } else {
        for (let k = i; k >= Math.max(0, i - 4); k--) {
          if (String(incList[k].fiscal_period || "").toUpperCase() === "Q4" && intExpYtd[k] !== null) {
            ttmIntExp = intExpYtd[k];
            break;
          }
        }
      }
    }

    // Compute TTM ordinary basic EPS (for perpetual-bond / preferred-stock deduction on banks/financials)
    let ttmBasicEps = null;
    let ttmBasicEpsStartDate = null;
    if (fp === "Q4") {
      if (basicEpsYtd[i] !== null) {
        ttmBasicEps = basicEpsYtd[i];
        ttmBasicEpsStartDate = `${fy - 1}-12-31`;
      }
    } else {
      const prevQ4Idx = idxByYm.get(`${fy - 1}-Q4`);
      const prevSameIdx = idxByYm.get(`${fy - 1}-${fp}`);
      if (
        prevQ4Idx !== undefined &&
        prevSameIdx !== undefined &&
        basicEpsYtd[prevQ4Idx] !== null &&
        basicEpsYtd[prevSameIdx] !== null &&
        basicEpsYtd[i] !== null
      ) {
        ttmBasicEps = basicEpsYtd[prevQ4Idx] - basicEpsYtd[prevSameIdx] + basicEpsYtd[i];
        ttmBasicEpsStartDate = String(incList[prevSameIdx].period_end || `${fy - 1}-01-01`).slice(0, 10);
      } else {
        for (let k = i; k >= Math.max(0, i - 4); k--) {
          if (String(incList[k].fiscal_period || "").toUpperCase() === "Q4" && basicEpsYtd[k] !== null) {
            break;
          }
        }
      }
    }

    // Compute TTM EBIT & single-quarter Gross Margin (%) for cyclical analysis
    const ttmProfitTotal = calcYtdTtm(profitTotalYtd, i, fy, fp);
    let ttmOpProfit = calcYtdTtm(opProfitYtd, i, fy, fp);
    if (ttmOpProfit === null && i >= 3 && qi - quarterIndex(incList[i - 3].fiscal_year, incList[i - 3].fiscal_period) === 3) {
      let opS = 0;
      let opOk = true;
      for (let k = i - 3; k <= i; k++) {
        if (incList[k].q_operating_profit == null) { opOk = false; break; }
        opS += Number(incList[k].q_operating_profit);
      }
      if (opOk) ttmOpProfit = opS;
    }
    const ebitBase = ttmProfitTotal !== null ? ttmProfitTotal : ttmOpProfit;
    const ttmEbit = ebitBase !== null ? (ebitBase + (ttmIntExp !== null && ttmIntExp > 0 ? ttmIntExp : 0)) : null;

    let qRev = r.q_operating_income != null && Number.isFinite(Number(r.q_operating_income))
      ? Number(r.q_operating_income)
      : null;
    if (qRev === null) {
      if (fp === "Q1") qRev = revYtd[i];
      else if (i >= 1 && Number(incList[i - 1].fiscal_year) === fy && qi - quarterIndex(incList[i - 1].fiscal_year, incList[i - 1].fiscal_period) === 1 && revYtd[i] !== null && revYtd[i - 1] !== null) {
        qRev = revYtd[i] - revYtd[i - 1];
      }
    }
    let qCost = r.q_operating_costs != null && Number.isFinite(Number(r.q_operating_costs))
      ? Number(r.q_operating_costs)
      : null;
    if (qCost === null) {
      if (fp === "Q1") qCost = opCostsYtd[i];
      else if (i >= 1 && Number(incList[i - 1].fiscal_year) === fy && qi - quarterIndex(incList[i - 1].fiscal_year, incList[i - 1].fiscal_period) === 1 && opCostsYtd[i] !== null && opCostsYtd[i - 1] !== null) {
        qCost = opCostsYtd[i] - opCostsYtd[i - 1];
      }
    }
    const qGrossMarginPct = (qRev > 0 && qCost !== null && Number.isFinite(qCost))
      ? clamp(((qRev - qCost) / qRev) * 100, -50, 99)
      : null;

    // TTM R&D expenses, YTD R&D ratio fallback, TTM operating costs & TTM gross margin (%)
    const ttmRd = calcYtdTtm(rdExpYtd, i, fy, fp);
    const ytdRdRatioPct = (rdExpYtd[i] !== null && revYtd[i] > 0)
      ? clamp((rdExpYtd[i] / revYtd[i]) * 100, 0, 80)
      : null;
    let ttmOpCosts = calcYtdTtm(opCostsYtd, i, fy, fp);
    if (ttmOpCosts === null && i >= 3 && qi - quarterIndex(incList[i - 3].fiscal_year, incList[i - 3].fiscal_period) === 3) {
      let costS = 0;
      let costOk = true;
      for (let k = i - 3; k <= i; k++) {
        if (incList[k].q_operating_costs == null) { costOk = false; break; }
        costS += Number(incList[k].q_operating_costs);
      }
      if (costOk) ttmOpCosts = costS;
    }
    const ttmGrossMarginPct = (ttmRev > 0 && ttmOpCosts !== null && Number.isFinite(ttmOpCosts))
      ? clamp(((ttmRev - ttmOpCosts) / ttmRev) * 100, -50, 99)
      : qGrossMarginPct;

    const isFinQ = detectFinancialCompany(symbolName, r, b, ttmOcf, ttmNp);
    const ttmFcf = ttmOcf !== null ? (ttmOcf - (ttmCapex || 0)) : null;
    const equity = b.holder_equity_total != null ? Number(b.holder_equity_total) : null;
    const assets = b.assets_total != null ? Number(b.assets_total) : null;
    const cash = b.cash != null ? Number(b.cash) : null;
    const accountsReceivable = b.accounts_receivable != null && Number.isFinite(Number(b.accounts_receivable))
      ? Math.max(0, Number(b.accounts_receivable))
      : null;
    const debt = b.total_debt != null ? Number(b.total_debt) : null;
    const tsRaw = b.treasury_stock ?? b.less_treasury_stock ?? null;
    const treasuryStock = tsRaw != null && Number.isFinite(Number(tsRaw)) ? Math.max(0, Number(tsRaw)) : null;
    const scRaw = b.paid_in_capital ?? b.share_capital ?? null;
    const shareCapital = scRaw != null && Number.isFinite(Number(scRaw)) ? Math.max(0, Number(scRaw)) : null;
    const ibKeys = ["short_term_loan", "non_current_liab_due_1y", "long_term_loan", "bonds_payable", "lease_liab"];
    let ibDebtSum = 0;
    let hasIbDebt = false;
    for (const k of ibKeys) {
      if (b[k] != null && Number.isFinite(Number(b[k]))) {
        ibDebtSum += Math.max(0, Number(b[k]));
        hasIbDebt = true;
      }
    }
    const ibDebt = hasIbDebt ? ibDebtSum : null;

    const erd = resolveEffectiveReportDate(r);
    const sharesBasisDate = String(r.report_date || erd || r.period_end || `${r.fiscal_year}-12-31`).slice(0, 10);

    quarters.push({
      qi,
      label: `${r.fiscal_year}${r.fiscal_period}`,
      period_end: r.period_end || `${r.fiscal_year}-12-31`,
      report_date: r.report_date || "",
      effective_report_date: erd,
      sharesBasisDate,
      shares: filledShares[i]?.shares || null,
      sharesSrc: filledShares[i]?.src || "--",
      isExactShares: Boolean(rawSharesArr[i]),
      ttmRev,
      ttmNp,
      ttmBasicEps,
      ttmBasicEpsStartDate,
      ttmOcf,
      ttmCapex,
      ttmFcf,
      ttmEbit,
      qGrossMarginPct,
      ttmRd,
      ytdRdRatioPct,
      ttmGrossMarginPct,
      ttmDivGross,
      ttmIntExp,
      ttmDiv: ttmDivGross,
      isFinancial: isFinQ,
      divIncludesBondInterest: isFinQ,
      equity,
      assets,
      cash,
      accountsReceivable,
      debt,
      treasuryStock,
      shareCapital,
      ibDebt
    });
  }

  // Apply consistent company-level financial classification based on the latest 4 quarters
  const recentStart = Math.max(0, quarters.length - 4);
  const companyIsFinancial = quarters.slice(recentStart).some(q => q.isFinancial);
  for (let i = 0; i < quarters.length; i++) {
    const q = quarters[i];
    const isFin = companyIsFinancial || q.isFinancial;
    q.isFinancial = isFin;
    if (q.ttmDivGross === null) {
      q.ttmDiv = null;
      q.divIncludesBondInterest = false;
    } else if (isFin) {
      q.ttmDiv = q.ttmDivGross;
      q.divIncludesBondInterest = true;
    } else if (q.ttmIntExp !== null && q.ttmIntExp > 0 && q.ttmIntExp < q.ttmDivGross * 0.75) {
      q.ttmDiv = Math.max(0, q.ttmDivGross - q.ttmIntExp);
      q.divIncludesBondInterest = false;
    } else {
      q.ttmDiv = q.ttmDivGross;
      q.divIncludesBondInterest = Boolean(q.ttmIntExp !== null && q.ttmIntExp > 0);
    }
  }

  return quarters;
}

export function computeHistoricalSeriesStats(bars, quarters, metric, opts = {}) {
  const alignMode = opts.alignMode === "period_end" ? "period_end" : "pit";
  const authTotalShares = Number(opts.authTotalShares) > 0 ? Number(opts.authTotalShares) : null;
  const authTradeDate = String(opts.authTradeDate || "2099-12-31").slice(0, 10);
  const splitHelper = opts.splitHelper || null;
  const shareTimeline = Array.isArray(opts.shareTimeline) ? opts.shareTimeline : [];
  const multNow = splitHelper ? (splitHelper.getMultAt(authTradeDate) || 1) : 1;

  const orderedQ = alignMode === "pit"
    ? [...quarters].sort((a, b) => (a.effective_report_date || a.period_end).localeCompare(b.effective_report_date || b.period_end) || (a.qi - b.qi))
    : quarters;

  const n = bars.length;
  const dates = new Array(n);
  const prices = new Array(n);
  const values = new Array(n);
  const qLabels = new Array(n);
  const qAlignDates = new Array(n);
  const validVals = [];

  let qPtr = -1;
  let sPtr = -1;
  let firstValidIdx = -1;
  let lastValidIdx = -1;
  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    dates[i] = bar.date;
    const unadj = Number(bar.close);
    prices[i] = unadj;

    while (qPtr + 1 < orderedQ.length) {
      const nextQ = orderedQ[qPtr + 1];
      const nextDate = alignMode === "pit" ? nextQ.effective_report_date : nextQ.period_end;
      if (nextDate <= bar.date) qPtr++;
      else break;
    }
    const q = qPtr >= 0 ? orderedQ[qPtr] : null;
    qLabels[i] = q ? q.label : "--";
    qAlignDates[i] = q ? (alignMode === "pit" ? q.effective_report_date : q.period_end) : "--";

    while (sPtr + 1 < shareTimeline.length && shareTimeline[sPtr + 1].change_date <= bar.date) {
      sPtr++;
    }

    let dayShares = null;
    if (sPtr >= 0) {
      const sRow = shareTimeline[sPtr];
      if (sPtr === shareTimeline.length - 1 && bar.date > sRow.change_date && splitHelper) {
        const mS = splitHelper.getMultAt(sRow.change_date) || 1;
        const mD = splitHelper.getMultAt(bar.date) || 1;
        dayShares = sRow.total_shares * (mD / mS);
      } else {
        dayShares = sRow.total_shares;
      }
    } else if (authTotalShares > 0) {
      const multDay = splitHelper ? (splitHelper.getMultAt(bar.date) || 1) : 1;
      dayShares = authTotalShares * (multDay / multNow);
    } else if (q && q.shares > 0) {
      const multDay = splitHelper ? (splitHelper.getMultAt(bar.date) || 1) : 1;
      const multQ = splitHelper ? (splitHelper.getMultAt(q.sharesBasisDate || q.period_end) || 1) : 1;
      dayShares = q.shares * (multDay / multQ);
    }

    let v = null;
    if (q && dayShares > 0 && unadj > 0) {
      const mktCap = unadj * dayShares;
      if (metric === "pe" && q.ttmNp > 0) {
        const pe = mktCap / q.ttmNp;
        if (pe > 0 && pe <= 200) v = +pe.toFixed(2);
      } else if (metric === "pb" && q.equity > 0) {
        const pb = mktCap / q.equity;
        if (pb > 0 && pb <= 50) v = +pb.toFixed(2);
      } else if (metric === "ps" && q.ttmRev > 0) {
        const ps = mktCap / q.ttmRev;
        if (ps > 0 && ps <= 60) v = +ps.toFixed(2);
      } else if (metric === "fcf" && q.ttmFcf !== null) {
        const fy = (q.ttmFcf / mktCap) * 100;
        if (fy >= -30 && fy <= 30) v = +fy.toFixed(2);
      }
    }
    values[i] = v;
    if (v !== null) {
      if (firstValidIdx === -1) firstValidIdx = i;
      lastValidIdx = i;
      validVals.push(v);
    }
  }

  const trimStart = firstValidIdx > 0 ? firstValidIdx : 0;
  const outDates = trimStart > 0 ? dates.slice(trimStart) : dates;
  const outPrices = trimStart > 0 ? prices.slice(trimStart) : prices;
  const outValues = trimStart > 0 ? values.slice(trimStart) : values;
  const outQLabels = trimStart > 0 ? qLabels.slice(trimStart) : qLabels;
  const outQAlignDates = trimStart > 0 ? qAlignDates.slice(trimStart) : qAlignDates;

  const sorted = [...validVals].sort((a, b) => a - b);
  const p20 = calcQuantile(sorted, 0.2);
  const p50 = calcQuantile(sorted, 0.5);
  const p80 = calcQuantile(sorted, 0.8);
  const mean = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : null;
  const latestVal = [...outValues].reverse().find(v => v !== null) ?? null;
  const pct = latestVal !== null ? percentileRank(sorted, latestVal) : null;
  const firstDate = firstValidIdx >= 0 ? dates[firstValidIdx] : "";
  const lastDate = lastValidIdx >= 0 ? dates[lastValidIdx] : "";

  return {
    dates: outDates,
    prices: outPrices,
    values: outValues,
    qLabels: outQLabels,
    qAlignDates: outQAlignDates,
    validCount: sorted.length,
    firstDate,
    lastDate,
    p20,
    p50,
    p80,
    mean,
    latestVal,
    pct
  };
}

export function extractExDividendTTM(noneItems, adjItems, cfsUpperBound, shares) {
  if (!noneItems?.length || !adjItems?.length || adjItems.length < 2) return null;
  const noneByDate = new Map(noneItems.map(b => [b.date, b]));
  const raw = [];

  for (let i = 1; i < adjItems.length; i++) {
    const f0 = Number(adjItems[i - 1].factor);
    const f1 = Number(adjItems[i].factor);
    if (!(f0 > 0) || !(f1 > 0)) continue;
    const ratio = f1 / f0;
    if (ratio <= 1.00015) continue;

    const prevBar = noneByDate.get(adjItems[i - 1].date);
    if (!prevBar || !(prevBar.close > 0)) continue;
    const prevC = Number(prevBar.close);
    const naiveDiv = prevC * (1 - 1 / ratio);

    let splitK = 1;
    let dpsOld = naiveDiv;
    const naiveTotalCash = shares > 0 ? naiveDiv * shares : null;
    const isLikelySplit =
      ratio > 1.18 ||
      (ratio > 1.095 && cfsUpperBound > 0 && naiveTotalCash !== null && naiveTotalCash > cfsUpperBound * 1.45) ||
      (ratio > 1.08 && cfsUpperBound === 0);

    if (isLikelySplit) {
      const kGuess = Math.floor((ratio + 1e-5) * 20) / 20;
      if (kGuess >= 1.05) {
        splitK = kGuess;
        dpsOld = Math.max(0, prevC * (1 - kGuess / ratio));
        if (cfsUpperBound > 0 && shares > 0 && (dpsOld / splitK) * shares > cfsUpperBound * 1.45) {
          const kFine = Math.floor((ratio + 1e-5) * 100) / 100;
          if (kFine >= 1.05) {
            splitK = kFine;
            dpsOld = Math.max(0, prevC * (1 - kFine / ratio));
          }
        }
      } else {
        dpsOld = 0;
      }
    }

    raw.push({
      date: adjItems[i].date,
      ratio,
      splitK,
      dpsOld
    });
  }

  // Normalize historical pre-split per-share dividends onto current share basis
  let cumSplitAfter = 1;
  for (let i = raw.length - 1; i >= 0; i--) {
    raw[i].dps = raw[i].dpsOld / (cumSplitAfter * raw[i].splitK);
    cumSplitAfter *= raw[i].splitK;
  }

  const lastDate = adjItems[adjItems.length - 1].date;
  const in365 = raw.filter(e => daysBetweenDates(e.date, lastDate) <= 365 && e.dps > 0.0005);
  let chosen = in365;
  let note = "近12月除息";

  if (chosen.length === 2 && daysBetweenDates(chosen[0].date, chosen[1].date) >= 280) {
    chosen = chosen.slice(-1);
    note = "近12月除息(去重跨期年报)";
  } else if (
    chosen.length === 3 &&
    daysBetweenDates(chosen[0].date, chosen[1].date) >= 125 &&
    daysBetweenDates(chosen[1].date, chosen[2].date) >= 125
  ) {
    chosen = chosen.slice(-2);
    note = "近12月除息(去重跨期中期)";
  } else if (chosen.length === 0) {
    const near = raw.filter(e => {
      const d = daysBetweenDates(e.date, lastDate);
      return d > 365 && d <= 395 && e.dps > 0.0005;
    });
    if (near.length === 1) {
      chosen = near;
      note = "近13月除息(跨期顺延)";
    }
  }

  const dpsTtm = chosen.reduce((s, e) => s + e.dps, 0);
  return {
    dpsTtm,
    count: chosen.length,
    events: chosen,
    hasSplit: chosen.some(e => e.splitK > 1),
    source: "exdiv",
    note
  };
}

export function computeMedianHistDivYield(bars, adjustmentEvents, splitHelper, kAdj) {
  if (!bars?.length) return null;
  const histBars = bars.length >= 65 ? bars.slice(0, -1) : bars;
  let winBars = histBars.slice(-1250);
  if (winBars.length < 20) return null;

  let sh = splitHelper;
  let cashEvs = Array.isArray(adjustmentEvents)
    ? adjustmentEvents
      .filter(e => e && e.ex_date && Number(e.dividend_per_share) > 0)
      .map(e => {
        const exDate = String(e.ex_date).slice(0, 10);
        return {
          exDate,
          ts: Date.parse(exDate + "T00:00:00Z"),
          rawDps: Number(e.dividend_per_share),
          multBefore: (sh ? sh.getMultBefore(exDate) : 1) || 1
        };
      })
      .filter(e => Number.isFinite(e.ts))
      .sort((a, b) => a.ts - b.ts)
    : [];

  let step = 5;
  if (!cashEvs.length && kAdj?.items?.length >= 60) {
    const adjItems = kAdj.items;
    const noneByDate = new Map(bars.map(b => [String(b.date).slice(0, 10), b]));
    const derivedEvents = [];
    for (let i = 1; i < adjItems.length; i++) {
      const f0 = Number(adjItems[i - 1].factor);
      const f1 = Number(adjItems[i].factor);
      if (!(f0 > 0) || !(f1 > 0)) continue;
      const ratio = f1 / f0;
      if (ratio <= 1.00015) continue;
      const prevBar = noneByDate.get(String(adjItems[i - 1].date).slice(0, 10));
      if (!prevBar || !(prevBar.close > 0)) continue;
      const prevC = Number(prevBar.close);
      let splitK = 1;
      let dpsOld = prevC * (1 - 1 / ratio);
      if (ratio > 1.18) {
        const kGuess = Math.floor((ratio + 1e-5) * 20) / 20;
        if (kGuess >= 1.05) {
          splitK = kGuess;
          dpsOld = Math.max(0, prevC * (1 - kGuess / ratio));
        } else {
          dpsOld = 0;
        }
      }
      derivedEvents.push({
        ex_date: String(adjItems[i].date).slice(0, 10),
        dividend_per_share: dpsOld,
        per_share_bonus: splitK > 1 ? splitK - 1 : 0,
        allotment_ratio: 0
      });
    }
    if (!derivedEvents.length) return null;
    sh = buildSplitMultiplierHelper(derivedEvents);
    cashEvs = derivedEvents
      .filter(e => e.dividend_per_share > 0.0005)
      .map(e => ({
        exDate: e.ex_date,
        ts: Date.parse(e.ex_date + "T00:00:00Z"),
        rawDps: e.dividend_per_share,
        multBefore: sh.getMultBefore(e.ex_date) || 1
      }))
      .filter(e => Number.isFinite(e.ts))
      .sort((a, b) => a.ts - b.ts);
    const minCovDate = addDaysIso(String(adjItems[0].date).slice(0, 10), 365);
    winBars = minCovDate ? winBars.filter(b => String(b.date).slice(0, 10) >= minCovDate) : [];
    if (winBars.length < 15 || !cashEvs.length) return null;
    step = winBars.length < 120 ? 1 : 5;
  } else if (!cashEvs.length) {
    return null;
  } else if (winBars.length < 60) {
    return null;
  }

  const samples = [];
  let posCount = 0;
  for (let i = 0; i < winBars.length; i += step) {
    const b = winBars[i];
    const px = Number(b?.close);
    if (!(px > 0) || !b.date) continue;
    const dStr = String(b.date).slice(0, 10);
    const ts = Date.parse(dStr + "T00:00:00Z");
    if (!Number.isFinite(ts)) continue;
    const multDay = (sh ? sh.getMultAt(dStr) : 1) || 1;
    const winStart = ts - 365 * 86400000;
    let dps12m = 0;
    for (let j = 0; j < cashEvs.length; j++) {
      const ev = cashEvs[j];
      if (ev.ts > ts) break;
      if (ev.ts >= winStart) {
        dps12m += ev.rawDps * (ev.multBefore / multDay);
      }
    }
    const dy = clamp((dps12m / px) * 100, 0, 30);
    if (dy > 0) posCount++;
    samples.push(dy);
  }
  if (!samples.length || posCount < samples.length * 0.2) return null;
  return median(samples);
}

export function buildDcfScenarioModel(quarters, kAdj, kUnadj, cagrNp, isFinancial, qNow, adjEvents, splitHelper, dcfRModeOpt = "capm") {
  const roundHalf = (v) => Math.round(v * 2) / 2;
  const roundQtr = (v) => Math.round(v * 4) / 4;

  // 5-year rolling annual TTM net profit YoY growth series
  const yoySamples = [];
  for (let k = 0; k < 5; k++) {
    const iC = quarters.length - 1 - 4 * k;
    const iP = quarters.length - 1 - 4 * (k + 1);
    if (iP >= 0 && quarters[iC]?.ttmNp > 0 && quarters[iP]?.ttmNp > 0) {
      const yoy = (quarters[iC].ttmNp / quarters[iP].ttmNp - 1) * 100;
      if (Number.isFinite(yoy)) {
        yoySamples.push({ label: quarters[iC].label, yoy });
      }
    }
  }

  const n = yoySamples.length;
  const rawMeanUnclipped = n ? yoySamples.reduce((s, x) => s + x.yoy, 0) / n : null;
  const winMean = yoySamples.map(x => clamp(x.yoy, -20, 30));
  const winVol = yoySamples.map(x => clamp(x.yoy, -40, 60));

  const mean5Y = n ? (winMean.reduce((a, b) => a + b, 0) / n) : (cagrNp ?? 6.0);
  const meanVol = n ? (winVol.reduce((a, b) => a + b, 0) / n) : 0;
  const std5Y = n > 1
    ? Math.sqrt(winVol.reduce((a, b) => a + (b - meanVol) ** 2, 0) / (n - 1))
    : 4.0;

  const baseG1 = roundHalf(clamp(mean5Y, 1.0, 18.0));
  const deltaG1 = roundHalf(clamp(std5Y * 0.35, 1.0, Math.min(3.5, Math.max(1.5, baseG1 * 0.5))));
  const baseG2 = baseG1 <= 4.0 ? 2.0 : 2.5;

  // 1Y realized annualized volatility from trailing 250 bars up to T-1 (independent of today's spot close)
  const volBarsRaw = (kAdj?.items?.length >= 20 ? kAdj.items : kUnadj?.items) || [];
  const volBarsBase = volBarsRaw.length >= 25 ? volBarsRaw.slice(0, -1) : volBarsRaw;
  const volSlice = volBarsBase.slice(-250);
  const rets = [];
  for (let i = 1; i < volSlice.length; i++) {
    const p0 = Number(volSlice[i - 1].close);
    const p1 = Number(volSlice[i].close);
    if (p0 > 0 && p1 > 0) rets.push(Math.log(p1 / p0));
  }
  let vol1Y = 24.0;
  if (rets.length >= 20) {
    const rMean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const rVar = rets.reduce((a, b) => a + (b - rMean) ** 2, 0) / Math.max(1, rets.length - 1);
    vol1Y = Math.sqrt(rVar * 242) * 100;
  }

  // Pure risk CAPM (spot-price independent: uses book equity scale instead of current market cap)
  const rf = 2.0;
  const erp = 5.5;
  const betaVol = clamp(vol1Y / 20.0, 0.72, 1.65);
  const eqScale = Number(qNow?.equity) || 0;
  const sizeAdj = eqScale >= 1000e8 ? -0.25 : (eqScale > 0 && eqScale < 100e8 ? 0.50 : 0);
  const debtRatio = (qNow?.assets > 0 && qNow?.debt != null) ? (qNow.debt / qNow.assets) * 100 : 0;
  const levAdj = (!isFinancial && debtRatio > 70) ? 0.35 : 0;
  const rCapm = clamp(rf + erp * betaVol + sizeAdj + levAdj, 6.25, 11.75);

  // Optional spot-independent 5Y historical median dividend yield + g fit
  const divYield5YMed = computeMedianHistDivYield(kUnadj?.items || [], adjEvents, splitHelper, kAdj);
  let rGordonHist = null;
  let rTargetHist = rCapm;
  if (divYield5YMed !== null && divYield5YMed >= 1.0) {
    const gEff = Math.min(baseG1, baseG2 + (baseG1 - baseG2) * 0.40);
    rGordonHist = clamp(divYield5YMed * (1 + gEff / 100) + gEff, 6.00, 11.50);
    rTargetHist = 0.65 * rGordonHist + 0.35 * rCapm;
  }

  const baseRCapm = roundQtr(clamp(rCapm, Math.max(6.25, baseG2 + 2.5), 12.0));
  const baseRHist = roundQtr(clamp(rTargetHist, Math.max(6.00, baseG2 + 2.5), 12.0));
  const deltaR = vol1Y >= 32 ? 0.75 : 0.50;

  const roundFive = (v) => Math.round(v / 5) * 5;
  const baseMos = roundFive(clamp(8 + baseG1 * 1.5, 10, 35));
  const consMos = Math.min(45, baseMos + 5);
  const optMos = Math.max(5, baseMos - 5);

  const consG2 = Math.max(1.0, +(baseG2 - 0.5).toFixed(1));
  const optG2 = Math.min(3.5, +(baseG2 + 0.5).toFixed(1));
  const makePresets = (baseR) => ({
    conservative: {
      g1: +(baseG1 - deltaG1).toFixed(1),
      g2: consG2,
      r: Math.min(15.0, +(baseR + deltaR).toFixed(2)),
      mos: consMos
    },
    neutral: {
      g1: baseG1,
      g2: baseG2,
      r: baseR,
      mos: baseMos
    },
    optimistic: {
      g1: Math.min(28.0, +(baseG1 + deltaG1).toFixed(1)),
      g2: optG2,
      r: Math.max(optG2 + 1.5, +(baseR - deltaR).toFixed(2)),
      mos: optMos
    }
  });

  const presetsByMode = {
    capm: makePresets(baseRCapm),
    hist_gordon: makePresets(baseRHist)
  };
  const rHintByMode = {
    capm: `纯风险CAPM(无风险2%+波动率${vol1Y.toFixed(0)}%+规模/杠杆) · 脱离现价 · 情景±${deltaR.toFixed(2)}%`,
    hist_gordon: rGordonHist !== null
      ? `5年中位股息(${divYield5YMed.toFixed(1)}%)+增速→${rGordonHist.toFixed(1)}%与CAPM(${rCapm.toFixed(1)}%)拟合 · 脱离现价 · 情景±${deltaR.toFixed(2)}%`
      : (divYield5YMed === null
        ? `缺少近5年除息记录，自动回退纯风险CAPM(${rCapm.toFixed(2)}%) · 情景±${deltaR.toFixed(2)}%`
        : `近5年中位股息(${divYield5YMed.toFixed(2)}%)不足1%，自动回退纯风险CAPM(${rCapm.toFixed(2)}%) · 情景±${deltaR.toFixed(2)}%`)
  };
  const activeMode = dcfRModeOpt === "hist_gordon" ? "hist_gordon" : "capm";

  const g1Hint = n >= 2
    ? `近${n}年净利YoY均值 ${rawMeanUnclipped.toFixed(1)}% · 波动带 ±${deltaG1.toFixed(1)}%`
    : "历史年数不足，按可用净利增速拟合";
  const g1Title = n >= 2
    ? `近${n}年年度净利YoY: ${yoySamples.map(x => `${x.label} ${fmtPct(x.yoy, 1, true)}`).join(", ")}`
    : "";
  const mosHint = `按中性g₁(${baseG1.toFixed(1)}%)匹配基准 ${baseMos}% · 买入价=公允×(1−MOS)`;

  return {
    mean5Y,
    rawMeanUnclipped,
    std5Y,
    vol1Y,
    rCapm,
    rGordon: rGordonHist,
    divYield5YMed,
    deltaG1,
    deltaR,
    baseMos,
    yoySamples,
    presetsByMode,
    presets: presetsByMode[activeMode],
    rHintByMode,
    g1Hint,
    g1Title,
    rHint: rHintByMode[activeMode],
    mosHint
  };
}

export function selectDefaultDcfBase(snap) {
  const ttmFcf = snap?.qNow?.ttmFcf ?? 0;
  const ttmNp = snap?.qNow?.ttmNp ?? 0;
  const fcf3y = snap?.fcf3yAvg ?? 0;
  const ttmDistorted = ttmNp > 0 && ttmFcf > ttmNp * 1.8;
  const fcf3yDistorted = ttmNp > 0 && fcf3y > ttmNp * 1.8;

  if (snap?.isFinancial) {
    return ttmNp > 0 ? "np_ttm" : (((snap.ttmDivActual ?? snap.qNow?.ttmDiv) || 0) > 0 ? "div_ttm" : "fcf_3y");
  }
  if (ttmFcf <= 0 || ttmDistorted) {
    if (fcf3y > 0 && !fcf3yDistorted) return "fcf_3y";
    if (ttmNp > 0) return "np_ttm";
    return ((snap?.ttmDivActual ?? snap?.qNow?.ttmDiv) || 0) > 0 ? "div_ttm" : "fcf_ttm";
  }
  return "fcf_ttm";
}

export function evaluateStockValuation({ finData, kUnadj, kAdj, kMain = null, shareData = null, valWindow = 1250, valAlignMode = "pit", dcfRMode = "capm" }) {
  const symSnap = finData?.symbol || kMain?.symbol || kUnadj?.symbol || null;
  const code = symSnap?.thscode || "";
  const symbolName = symSnap?.name || kMain?.symbol?.name || kUnadj?.symbol?.name || "";
  const quarters = buildQuarterlyValuationSeries(finData, symbolName);
  const qNow = quarters[quarters.length - 1] || null;
  const adjEvents = Array.isArray(finData?.adjustment_events) ? finData.adjustment_events : [];
  const splitHelper = buildSplitMultiplierHelper(adjEvents);

  // Strictly use direct unadjusted close (adjust=none)
  let unadjPrice = null;
  let priceDate = "--";
  if (kUnadj?.items?.length) {
    const lb = kUnadj.items[kUnadj.items.length - 1];
    unadjPrice = Number(lb.close);
    priceDate = lb.date;
  }

  const shareTimeline = normalizeShareTimeline(shareData, priceDate && priceDate !== "--" ? priceDate : "2099-12-31");
  const authTotalSharesRaw = Number(symSnap?.total_shares);
  const authTradeDate = String(symSnap?.trade_date || priceDate || "2099-12-31").slice(0, 10);
  let shares = null;
  let sharesSrc = qNow?.sharesSrc || "--";
  let isExactShares = Boolean(qNow?.isExactShares);
  let sharesSourceKind = "implied";
  if (Number.isFinite(authTotalSharesRaw) && authTotalSharesRaw > 0) {
    const mSnap = splitHelper.getMultAt(authTradeDate) || 1;
    const mNow = (priceDate && priceDate !== "--" ? splitHelper.getMultAt(priceDate) : mSnap) || mSnap;
    shares = authTotalSharesRaw * (mNow / mSnap);
    sharesSrc = symSnap?.trade_date ? `快照 ${symSnap.trade_date}` : "权威总股本";
    isExactShares = true;
    sharesSourceKind = "authoritative";
  } else if (shareTimeline.length > 0) {
    const latestShare = shareTimeline[shareTimeline.length - 1];
    const mShare = splitHelper.getMultAt(latestShare.change_date) || 1;
    const mNow = (priceDate && priceDate !== "--" ? splitHelper.getMultAt(priceDate) : mShare) || mShare;
    shares = latestShare.total_shares * (mNow / mShare);
    sharesSrc = `股本表 ${latestShare.change_date}`;
    isExactShares = true;
    sharesSourceKind = "authoritative";
  } else if (qNow?.shares > 0) {
    const mQ = splitHelper.getMultAt(qNow.sharesBasisDate || qNow.period_end) || 1;
    const mNow = (priceDate && priceDate !== "--" ? splitHelper.getMultAt(priceDate) : mQ) || mQ;
    shares = qNow.shares * (mNow / mQ);
  }

  const impliedMktCap = (unadjPrice > 0 && shares > 0) ? unadjPrice * shares : null;

  // 3Y average FCF (from latest 12 quarters = 3 annual FCF points: q[n-1], q[n-5], q[n-9])
  const fcfSamples = [];
  for (let idx = quarters.length - 1; idx >= 0 && fcfSamples.length < 3; idx -= 4) {
    if (quarters[idx].ttmFcf !== null) fcfSamples.push(quarters[idx].ttmFcf);
  }
  const fcf3yAvg = fcfSamples.length ? fcfSamples.reduce((a, b) => a + b, 0) / fcfSamples.length : null;

  // 3Y / 2Y / 1Y Net Profit CAGR
  let cagrNp = null;
  let cagrLabel = "3年CAGR";
  const tryHorizon = (lagQuarters, years, lbl) => {
    const prevIdx = quarters.length - 1 - lagQuarters;
    if (prevIdx >= 0 && qNow?.ttmNp > 0 && quarters[prevIdx]?.ttmNp > 0) {
      cagrNp = (Math.pow(qNow.ttmNp / quarters[prevIdx].ttmNp, 1 / years) - 1) * 100;
      cagrLabel = lbl;
      return true;
    }
    return false;
  };
  if (!tryHorizon(12, 3, "3年净利CAGR")) {
    if (!tryHorizon(8, 2, "2年净利CAGR")) {
      tryHorizon(4, 1, "1年净利YoY");
    }
  }

  const epsTtm = (shares > 0 && qNow?.ttmNp !== null) ? qNow.ttmNp / shares : null;
  const bvps = (shares > 0 && qNow?.equity !== null) ? qNow.equity / shares : null;
  const isFinCompany = Boolean(qNow?.isFinancial);

  // Align financial payout/coverage denominator to ordinary shareholders (deducting perpetual-bond / preferred interest when basic_eps reflects it)
  let epsForPayout = epsTtm;
  let payoutBasis = "归母TTM";
  let ordinaryNpTtm = qNow?.ttmNp ?? null;
  let ordinaryNpRatio = 1;
  if (isFinCompany && shares > 0 && qNow?.ttmBasicEps > 0 && epsTtm > 0) {
    const mStart = qNow.ttmBasicEpsStartDate ? (splitHelper.getMultAt(qNow.ttmBasicEpsStartDate) || 1) : 1;
    const mEnd = (priceDate && priceDate !== "--") ? (splitHelper.getMultAt(priceDate) || 1) : mStart;
    const epsNoSplit = Math.abs(mEnd / mStart - 1) < 0.001;
    if (epsNoSplit) {
      const ordRatio = qNow.ttmBasicEps / epsTtm;
      if (ordRatio >= 0.65 && ordRatio <= 1.02) {
        epsForPayout = qNow.ttmBasicEps;
        if (ordRatio < 0.995) {
          payoutBasis = "普通股TTM(扣永续债)";
          ordinaryNpTtm = qNow.ttmBasicEps * shares;
          ordinaryNpRatio = ordRatio;
        }
      }
    }
  }

  const peTtm = (impliedMktCap && qNow?.ttmNp > 0) ? impliedMktCap / qNow.ttmNp : null;
  const pb = (impliedMktCap && qNow?.equity > 0) ? impliedMktCap / qNow.equity : null;
  const psTtm = (impliedMktCap && qNow?.ttmRev > 0) ? impliedMktCap / qNow.ttmRev : null;
  const fcfYieldPct = (impliedMktCap && qNow?.ttmFcf !== null) ? (qNow.ttmFcf / impliedMktCap) * 100 : null;
  const pFcf = (impliedMktCap && qNow?.ttmFcf > 0) ? impliedMktCap / qNow.ttmFcf : null;

  const snapDpsRaw = symSnap?.dps_ttm !== null && symSnap?.dps_ttm !== undefined ? Number(symSnap.dps_ttm) : null;
  const exDivFromEvents = (adjEvents.length > 0 && priceDate && priceDate !== "--")
    ? extractExDividendFromEvents(adjEvents, priceDate, splitHelper)
    : null;
  const exDiv = exDivFromEvents !== null
    ? exDivFromEvents
    : ((kUnadj?.items?.length >= 2 && kAdj?.items?.length >= 2)
      ? extractExDividendTTM(kUnadj.items, kAdj.items, qNow?.ttmDivGross ?? 0, shares)
      : null);

  let dpsTtm = null;
  let ttmDivActual = null;
  let approxDivYieldPct = null;
  let approxPayoutPct = null;
  if (exDiv !== null && (exDiv.count > 0 || snapDpsRaw === null)) {
    dpsTtm = exDiv.dpsTtm;
    approxDivYieldPct = (unadjPrice > 0) ? (dpsTtm / unadjPrice) * 100 : null;
    approxPayoutPct = (epsForPayout > 0) ? (dpsTtm / epsForPayout) * 100 : null;
    ttmDivActual = (shares > 0) ? dpsTtm * shares : (qNow?.ttmDiv ?? null);
  } else if (snapDpsRaw !== null && Number.isFinite(snapDpsRaw)) {
    dpsTtm = snapDpsRaw;
    approxDivYieldPct = (unadjPrice > 0) ? (dpsTtm / unadjPrice) * 100 : null;
    approxPayoutPct = (epsForPayout > 0) ? (dpsTtm / epsForPayout) * 100 : null;
    ttmDivActual = (shares > 0) ? dpsTtm * shares : (qNow?.ttmDiv ?? null);
  } else if (exDiv !== null) {
    dpsTtm = exDiv.dpsTtm;
    approxDivYieldPct = (unadjPrice > 0) ? (dpsTtm / unadjPrice) * 100 : null;
    approxPayoutPct = (epsForPayout > 0) ? (dpsTtm / epsForPayout) * 100 : null;
    ttmDivActual = (shares > 0) ? dpsTtm * shares : (qNow?.ttmDiv ?? null);
  } else {
    approxDivYieldPct = (impliedMktCap && qNow?.ttmDiv !== null) ? (qNow.ttmDiv / impliedMktCap) * 100 : null;
    const npDenom = isFinCompany ? ordinaryNpTtm : qNow?.ttmNp;
    approxPayoutPct = (npDenom > 0 && qNow?.ttmDiv !== null) ? (qNow.ttmDiv / npDenom) * 100 : null;
    ttmDivActual = qNow?.ttmDiv ?? null;
  }

  const dcfModel = buildDcfScenarioModel(
    quarters,
    kAdj,
    kUnadj,
    cagrNp,
    Boolean(qNow?.isFinancial),
    qNow,
    adjEvents,
    splitHelper,
    dcfRMode
  );

  const peg = (peTtm > 0 && cagrNp > 0) ? peTtm / cagrNp : null;
  const divStability = computeDividendStability(adjEvents, priceDate, splitHelper);

  // DuPont, quality & P2-4 peer upgrade metrics
  const netMargin = (qNow?.ttmRev > 0 && qNow?.ttmNp !== null) ? (qNow.ttmNp / qNow.ttmRev) * 100 : null;
  const assetTurnover = (qNow?.assets > 0 && qNow?.ttmRev !== null) ? qNow.ttmRev / qNow.assets : null;
  const equityMultiplier = (qNow?.equity > 0 && qNow?.assets !== null) ? qNow.assets / qNow.equity : null;
  const roeTtm = (qNow?.equity > 0 && qNow?.ttmNp !== null) ? (qNow.ttmNp / qNow.equity) * 100 : null;
  const accrualRatio = (qNow?.assets > 0 && qNow?.ttmNp !== null && qNow?.ttmOcf !== null)
    ? ((qNow.ttmNp - qNow.ttmOcf) / qNow.assets) * 100
    : null;
  const arToRevPct = (!isFinCompany && qNow?.ttmRev > 0 && qNow?.accountsReceivable != null)
    ? clamp((qNow.accountsReceivable / qNow.ttmRev) * 100, 0, 200)
    : null;
  const netCashToMktCap = (impliedMktCap && qNow?.cash !== null && qNow?.debt !== null)
    ? ((qNow.cash - qNow.debt) / impliedMktCap) * 100
    : null;

  // Buyback / Dilution & Shareholder Yield:
  // 1) Official backend fields, 2) Split-adjusted historical share capital net buyback/dilution, 3) Balance sheet proxy
  const qPrev4 = quarters.length >= 5 ? quarters[quarters.length - 5] : null;
  const hasNumField = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  const officialBbYield = hasNumField(symSnap?.buyback_yield_ttm)
    ? Number(symSnap.buyback_yield_ttm)
    : (hasNumField(symSnap?.buyback_ttm) && impliedMktCap > 0
      ? (Number(symSnap.buyback_ttm) / impliedMktCap) * 100
      : null);
  let buybackYieldPct = 0;
  let buybackRawPct = 0;
  let buybackSource = "仅现金分红";
  let buybackNote = "";
  let buybackDetail = null;
  if (officialBbYield !== null && officialBbYield >= 0) {
    buybackYieldPct = clamp(officialBbYield, 0, 20);
    buybackRawPct = officialBbYield;
    buybackSource = buybackYieldPct >= 0.01 ? "官方回购口径" : "仅现金分红";
  } else {
    const histBb = computeNetBuybackFromShares(shareTimeline, priceDate, splitHelper);
    if (histBb !== null) {
      buybackYieldPct = histBb.buybackYieldPct;
      buybackRawPct = histBb.rawPct;
      buybackSource = histBb.source;
      buybackNote = histBb.note;
      buybackDetail = histBb;
    } else {
      let buybackRaw = 0;
      if (impliedMktCap > 0 && qNow?.treasuryStock != null && qPrev4?.treasuryStock != null) {
        const deltaTs = qNow.treasuryStock - qPrev4.treasuryStock;
        if (deltaTs > impliedMktCap * 0.0005) {
          buybackRaw += (deltaTs / impliedMktCap) * 100;
        }
      }
      if (qNow?.shareCapital > 0 && qPrev4?.shareCapital > 0) {
        const mPrev4 = splitHelper.getMultAt(qPrev4.period_end) || 1;
        const mNowSc = splitHelper.getMultAt(qNow.period_end) || 1;
        const adjPrevSc = qPrev4.shareCapital * (mNowSc / mPrev4);
        const shrinkRatio = adjPrevSc > 0 ? (adjPrevSc - qNow.shareCapital) / adjPrevSc : 0;
        if (shrinkRatio >= 0.001 && shrinkRatio <= 0.15) {
          buybackRaw += shrinkRatio * 100;
        }
      }
      const hasEstimatedBuyback = buybackRaw >= 0.05;
      buybackYieldPct = hasEstimatedBuyback ? clamp(buybackRaw, 0, 15) : 0;
      buybackRawPct = buybackYieldPct;
      buybackSource = hasEstimatedBuyback ? "库存股/注销估算" : "仅现金分红";
    }
  }
  const shareholderYieldPct = approxDivYieldPct !== null
    ? (approxDivYieldPct + buybackYieldPct)
    : (Math.abs(buybackYieldPct) >= 0.05 ? buybackYieldPct : null);

  // 3Y & 5Y Normalized Cash Conversion, ROIC Mean, ROE Mean/Vol/Min, and Earnings/FCF Averages
  let sumOcf3y = 0;
  let sumNp3y = 0;
  let cfPairs3y = 0;
  let sumOcf5y = 0;
  let sumNp5y = 0;
  let cfPairs5y = 0;
  const roeSamples3y = [];
  const roeSamples5y = [];
  const roicSamples3y = [];
  const roicSamples5y = [];
  const npSamples3y = [];
  const npSamples5y = [];
  const fcfSamples5y = [];
  const ebitSamples3y = [];
  const ebitSamples5y = [];
  let sumFcf3y = 0;
  let sumRev3y = 0;
  let fcfRevPairs3y = 0;
  for (let k = 0; k < 5; k++) {
    const idx = quarters.length - 1 - 4 * k;
    if (idx < 0) break;
    const q = quarters[idx];
    if (q?.ttmNp !== null && Number.isFinite(q.ttmNp)) {
      if (k < 3) npSamples3y.push(q.ttmNp);
      npSamples5y.push(q.ttmNp);
    }
    if (!isFinCompany && q?.ttmEbit !== null && Number.isFinite(q.ttmEbit)) {
      if (k < 3) ebitSamples3y.push(q.ttmEbit);
      ebitSamples5y.push(q.ttmEbit);
    }
    if (k < 3 && !isFinCompany && q?.ttmFcf !== null && Number.isFinite(q.ttmFcf) && q?.ttmRev > 0) {
      sumFcf3y += q.ttmFcf;
      sumRev3y += q.ttmRev;
      fcfRevPairs3y++;
    }
    if (q?.ttmFcf !== null && Number.isFinite(q.ttmFcf)) {
      fcfSamples5y.push(q.ttmFcf);
    }
    if (q?.ttmOcf !== null && q?.ttmNp !== null && Number.isFinite(q.ttmOcf) && Number.isFinite(q.ttmNp)) {
      if (k < 3) {
        sumOcf3y += q.ttmOcf;
        sumNp3y += q.ttmNp;
        cfPairs3y++;
      }
      sumOcf5y += q.ttmOcf;
      sumNp5y += q.ttmNp;
      cfPairs5y++;
    }
    if (q?.equity > 0 && q?.ttmNp !== null && Number.isFinite(q.ttmNp)) {
      const roeVal = clamp((q.ttmNp / q.equity) * 100, -60, 80);
      if (k < 3) roeSamples3y.push(roeVal);
      roeSamples5y.push(roeVal);
      if (!isFinCompany) {
        const nopat = q.ttmNp + (q.ttmIntExp > 0 ? q.ttmIntExp * 0.75 : 0);
        const nonCashDebt = q.ibDebt != null ? q.ibDebt : Math.max(0, (q.debt || 0) - (q.cash || 0));
        const ic = Math.max(q.equity * 0.6, q.equity + nonCashDebt);
        if (ic > 0) {
          const roicVal = clamp((nopat / ic) * 100, -50, 80);
          if (k < 3) roicSamples3y.push(roicVal);
          roicSamples5y.push(roicVal);
        }
      }
    }
  }
  const calcMean = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const calcStd = (arr) => {
    if (arr.length < 2) return null;
    const m = calcMean(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
  };
  const cashConv3y = (cfPairs3y >= 1 && sumNp3y > 0) ? clamp(sumOcf3y / sumNp3y, -5, 10) : null;
  const cashConv5y = (cfPairs5y >= 1 && sumNp5y > 0) ? clamp(sumOcf5y / sumNp5y, -5, 10) : null;
  const roeMean3y = calcMean(roeSamples3y);
  const roeMin3y = roeSamples3y.length ? Math.min(...roeSamples3y) : null;
  const roeVol3y = calcStd(roeSamples3y);
  const roeMean5y = calcMean(roeSamples5y);
  const roeMin5y = roeSamples5y.length ? Math.min(...roeSamples5y) : null;
  const roeVol5y = calcStd(roeSamples5y) ?? dcfModel?.std5Y ?? null;
  const roicIsRoeProxy = isFinCompany;
  const roic3yMean = isFinCompany ? (roeMean3y !== null ? roeMean3y : roeTtm) : calcMean(roicSamples3y);
  const roic5yMean = isFinCompany ? (roeMean5y !== null ? roeMean5y : roeTtm) : calcMean(roicSamples5y);
  const np3yAvg = calcMean(npSamples3y);
  const np5yAvg = calcMean(npSamples5y);
  const pe3yNorm = (impliedMktCap > 0 && np3yAvg > 0) ? (impliedMktCap / np3yAvg) : null;
  const pe5yNorm = (impliedMktCap > 0 && np5yAvg > 0) ? (impliedMktCap / np5yAvg) : null;
  const fcf5yAvg = calcMean(fcfSamples5y);
  const fcf3yYieldPct = (impliedMktCap > 0 && fcf3yAvg !== null) ? (fcf3yAvg / impliedMktCap) * 100 : null;
  const fcf5yYieldPct = (impliedMktCap > 0 && fcf5yAvg !== null) ? (fcf5yAvg / impliedMktCap) * 100 : null;
  const ebit3yAvg = calcMean(ebitSamples3y);
  const ebit5yAvg = calcMean(ebitSamples5y);
  const evDebtUsed = qNow?.ibDebt != null ? qNow.ibDebt : (qNow?.debt != null ? qNow.debt : null);
  const evDebtBasis = isFinCompany ? "金融免算" : (qNow?.ibDebt != null ? "有息负债" : (qNow?.debt != null ? "总负债近似" : "--"));
  const evRaw = (!isFinCompany && impliedMktCap > 0 && evDebtUsed !== null)
    ? (impliedMktCap + evDebtUsed - (qNow?.cash || 0))
    : null;
  const enterpriseValue = (evRaw !== null && Number.isFinite(evRaw) && evRaw > 0) ? evRaw : null;
  const evToEbitTtm = (enterpriseValue > 0 && qNow?.ttmEbit > 0) ? clamp(enterpriseValue / qNow.ttmEbit, 0.5, 200) : null;
  const evToEbit3y = (enterpriseValue > 0 && ebit3yAvg > 0) ? clamp(enterpriseValue / ebit3yAvg, 0.5, 200) : null;
  const evToEbit5y = (enterpriseValue > 0 && ebit5yAvg > 0) ? clamp(enterpriseValue / ebit5yAvg, 0.5, 200) : null;
  const ebitYieldTtm = (enterpriseValue > 0 && qNow?.ttmEbit !== null && Number.isFinite(qNow.ttmEbit))
    ? clamp((qNow.ttmEbit / enterpriseValue) * 100, -50, 80)
    : null;
  const ebitYield3y = (enterpriseValue > 0 && ebit3yAvg !== null && Number.isFinite(ebit3yAvg))
    ? clamp((ebit3yAvg / enterpriseValue) * 100, -50, 80)
    : null;
  const ebitYield5y = (enterpriseValue > 0 && ebit5yAvg !== null && Number.isFinite(ebit5yAvg))
    ? clamp((ebit5yAvg / enterpriseValue) * 100, -50, 80)
    : null;
  const ebitNormRef = ebit5yAvg ?? ebit3yAvg;
  const ebitCyclePos = (!isFinCompany && qNow?.ttmEbit !== null && Number.isFinite(qNow.ttmEbit) && ebitNormRef > 0)
    ? clamp(qNow.ttmEbit / ebitNormRef, -2, 5)
    : null;
  const qGmLatest = (!isFinCompany && qNow?.qGrossMarginPct != null && Number.isFinite(qNow.qGrossMarginPct))
    ? qNow.qGrossMarginPct
    : null;
  const qGmYoyPp = (!isFinCompany && qNow?.qGrossMarginPct != null && qPrev4?.qGrossMarginPct != null)
    ? clamp(qNow.qGrossMarginPct - qPrev4.qGrossMarginPct, -40, 40)
    : null;
  const deltaRoeMarginPp = (roeTtm !== null && roeMean3y !== null)
    ? clamp(roeTtm - roeMean3y, -40, 40)
    : null;
  const capexToRevPct = (!isFinCompany && qNow?.ttmRev > 0 && qNow?.ttmCapex !== null && Number.isFinite(qNow.ttmCapex))
    ? clamp((Math.abs(qNow.ttmCapex) / qNow.ttmRev) * 100, 0, 100)
    : null;
  const interestCoverage = (!isFinCompany && qNow?.ttmEbit !== null && Number.isFinite(qNow.ttmEbit))
    ? (qNow.ttmIntExp > 0
      ? clamp(qNow.ttmEbit / qNow.ttmIntExp, -10, 50)
      : (qNow.ttmIntExp === 0 && qNow.ttmEbit > 0 ? 50 : null))
    : null;
  const cashToDebtPct = (!isFinCompany && qNow?.debt > 0 && qNow?.cash !== null && Number.isFinite(qNow.cash))
    ? clamp((qNow.cash / qNow.debt) * 100, 0, 500)
    : null;

  // Dividend/Shareholder-Return Cash Flow Coverage & CapEx Intensity
  const cashDivOut = (ttmDivActual > 0) ? ttmDivActual : ((qNow?.ttmDiv > 0) ? qNow.ttmDiv : 0);
  const netBuybackOut = (impliedMktCap > 0 && buybackYieldPct > 0) ? (impliedMktCap * (buybackYieldPct / 100)) : 0;
  const shCashOutflow = cashDivOut + netBuybackOut;
  let fcfDivCoverage = null;
  let fcf3yDivCoverage = null;
  const fcfCoverageIsProfitProxy = isFinCompany;
  if (isFinCompany) {
    if (cashDivOut > 0 && ordinaryNpTtm !== null && Number.isFinite(ordinaryNpTtm)) {
      fcfDivCoverage = clamp(ordinaryNpTtm / cashDivOut, -3, 10);
    }
    if (cashDivOut > 0 && np3yAvg !== null && Number.isFinite(np3yAvg)) {
      fcf3yDivCoverage = clamp((np3yAvg * ordinaryNpRatio) / cashDivOut, -3, 10);
    }
  } else {
    if (shCashOutflow > 0 && qNow?.ttmFcf !== null && Number.isFinite(qNow.ttmFcf)) {
      fcfDivCoverage = clamp(qNow.ttmFcf / shCashOutflow, -3, 10);
    }
    if (shCashOutflow > 0 && fcf3yAvg !== null && Number.isFinite(fcf3yAvg)) {
      fcf3yDivCoverage = clamp(fcf3yAvg / shCashOutflow, -3, 10);
    }
  }
  const capexToOcfPct = (!isFinCompany && qNow?.ttmOcf > 0 && qNow?.ttmCapex !== null && Number.isFinite(qNow.ttmCapex))
    ? clamp((Math.abs(qNow.ttmCapex) / qNow.ttmOcf) * 100, 0, 200)
    : null;

  // Marginal 1Y TTM Net Profit YoY
  let npYoy1yRaw = null;
  let npYoy1y = null;
  if (qNow?.ttmNp !== null && qPrev4?.ttmNp > 0) {
    npYoy1yRaw = ((qNow.ttmNp / qPrev4.ttmNp) - 1) * 100;
    if (Number.isFinite(npYoy1yRaw)) {
      npYoy1y = clamp(npYoy1yRaw, -40, 60);
    } else {
      npYoy1yRaw = null;
    }
  }

  // P2-6c Growth Mode metrics: 3Y NP CAGR, 1Y/3Y Rev Growth, R&D Ratio, TTM Gross Margin, FCF Margin, PEG (3Y), PSG
  const qPrev12 = quarters.length >= 13 ? quarters[quarters.length - 13] : null;
  const qPrev8 = quarters.length >= 9 ? quarters[quarters.length - 9] : null;
  let npCagr3yRaw = null;
  if (qNow?.ttmNp > 0 && qPrev12?.ttmNp > 0) {
    npCagr3yRaw = (Math.pow(qNow.ttmNp / qPrev12.ttmNp, 1 / 3) - 1) * 100;
  } else if (qNow?.ttmNp > 0 && qPrev8?.ttmNp > 0) {
    npCagr3yRaw = (Math.pow(qNow.ttmNp / qPrev8.ttmNp, 1 / 2) - 1) * 100;
  } else if (cagrNp !== null && Number.isFinite(cagrNp)) {
    npCagr3yRaw = cagrNp;
  }
  const npCagr3y = (npCagr3yRaw !== null && Number.isFinite(npCagr3yRaw))
    ? clamp(npCagr3yRaw, -40, 80)
    : null;

  const revYoy1yRaw = (qNow?.ttmRev !== null && qPrev4?.ttmRev > 0)
    ? ((qNow.ttmRev / qPrev4.ttmRev) - 1) * 100
    : null;
  const revYoy1y = (revYoy1yRaw !== null && Number.isFinite(revYoy1yRaw))
    ? clamp(revYoy1yRaw, -40, 80)
    : null;
  let revCagr3yRaw = null;
  if (qNow?.ttmRev > 0 && qPrev12?.ttmRev > 0) {
    revCagr3yRaw = (Math.pow(qNow.ttmRev / qPrev12.ttmRev, 1 / 3) - 1) * 100;
  } else if (qNow?.ttmRev > 0 && qPrev8?.ttmRev > 0) {
    revCagr3yRaw = (Math.pow(qNow.ttmRev / qPrev8.ttmRev, 1 / 2) - 1) * 100;
  }
  const revCagr3y = (revCagr3yRaw !== null && Number.isFinite(revCagr3yRaw))
    ? clamp(revCagr3yRaw, -40, 80)
    : null;

  const rdRatioPct = !isFinCompany
    ? ((qNow?.ttmRev > 0 && qNow?.ttmRd !== null && Number.isFinite(qNow.ttmRd))
      ? clamp((qNow.ttmRd / qNow.ttmRev) * 100, 0, 80)
      : (qNow?.ytdRdRatioPct ?? null))
    : null;
  const ttmGmPct = (!isFinCompany && qNow?.ttmGrossMarginPct != null && Number.isFinite(qNow.ttmGrossMarginPct))
    ? qNow.ttmGrossMarginPct
    : null;
  const fcfMarginTtm = (!isFinCompany && qNow?.ttmRev > 0 && qNow?.ttmFcf !== null && Number.isFinite(qNow.ttmFcf))
    ? clamp((qNow.ttmFcf / qNow.ttmRev) * 100, -80, 80)
    : null;
  const fcfMargin3y = (!isFinCompany && sumRev3y > 0 && fcfRevPairs3y >= 1)
    ? clamp((sumFcf3y / sumRev3y) * 100, -80, 80)
    : fcfMarginTtm;
  const peg3y = (peTtm > 0 && npCagr3y > 0)
    ? clamp(peTtm / npCagr3y, 0.05, 10)
    : (peg !== null && Number.isFinite(peg) && peg > 0 ? clamp(peg, 0.05, 10) : null);
  const revGrowthForPsg = revCagr3y > 0 ? revCagr3y : (revYoy1y > 0 ? revYoy1y : null);
  const psg = (psTtm > 0 && revGrowthForPsg > 0)
    ? clamp(psTtm / revGrowthForPsg, 0.01, 5)
    : null;

  // 3Y Realized Volatility & Max Drawdown from trailing 750 total-return bars
  const riskBarsRaw = (kAdj?.items?.length >= 45 ? kAdj.items : kUnadj?.items) || [];
  const riskBars = riskBarsRaw.slice(-750);
  const rets3y = [];
  let peak3y = -Infinity;
  let minDd3y = 0;
  let validDdPts = 0;
  for (let i = 0; i < riskBars.length; i++) {
    const p = Number(riskBars[i].close);
    if (!(p > 0)) continue;
    validDdPts++;
    if (p > peak3y) peak3y = p;
    if (peak3y > 0) {
      const dd = ((p / peak3y) - 1) * 100;
      if (dd < minDd3y) minDd3y = dd;
    }
    if (i > 0) {
      const pPrev = Number(riskBars[i - 1].close);
      if (pPrev > 0) rets3y.push(Math.log(p / pPrev));
    }
  }
  let vol3y = null;
  if (rets3y.length >= 40) {
    const rMean = rets3y.reduce((a, b) => a + b, 0) / rets3y.length;
    const rVar = rets3y.reduce((s, x) => s + (x - rMean) ** 2, 0) / (rets3y.length - 1);
    vol3y = Math.sqrt(rVar * 242) * 100;
  }
  const maxDd3y = validDdPts >= 20 ? minDd3y : null;

  const debtRatioPct = (qNow?.assets > 0 && qNow?.debt != null) ? (qNow.debt / qNow.assets) * 100 : null;
  const ibDebtRatioPct = (qNow?.assets > 0 && qNow?.ibDebt != null) ? (qNow.ibDebt / qNow.assets) * 100 : null;
  const isHighRiskFlag = (!isFinCompany && debtRatioPct !== null && debtRatioPct > 70)
    || (maxDd3y !== null && maxDd3y < -45)
    || (vol3y !== null && vol3y > 42);
  const isLowVolFlag = !isHighRiskFlag
    && vol3y !== null && vol3y <= 24
    && maxDd3y !== null && maxDd3y >= -25
    && (isFinCompany || debtRatioPct === null || debtRatioPct <= 60);
  const riskFlag = isHighRiskFlag ? "high_risk" : (isLowVolFlag ? "low_vol" : "normal");

  // Historical bands (PIT vs period_end + split-adjusted share restoration)
  const barsAll = kUnadj?.items || [];
  const barsWin = valWindow === "all"
    ? barsAll
    : barsAll.slice(-Math.min(barsAll.length, Number(valWindow) || 1250));
  const bandOpts = {
    alignMode: valAlignMode,
    authTotalShares: (Number.isFinite(authTotalSharesRaw) && authTotalSharesRaw > 0) ? authTotalSharesRaw : null,
    authTradeDate,
    splitHelper,
    shareTimeline
  };
  const bands = {
    pe: computeHistoricalSeriesStats(barsWin, quarters, "pe", bandOpts),
    pb: computeHistoricalSeriesStats(barsWin, quarters, "pb", bandOpts),
    ps: computeHistoricalSeriesStats(barsWin, quarters, "ps", bandOpts),
    fcf: computeHistoricalSeriesStats(barsWin, quarters, "fcf", bandOpts)
  };

  const tailValidMean = (arr, tailLen, minPts = 20) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const sub = arr.slice(-tailLen).filter(v => v !== null && v !== undefined && Number.isFinite(v));
    return sub.length >= minPts ? (sub.reduce((a, b) => a + b, 0) / sub.length) : null;
  };
  const pb3yAvg = tailValidMean(bands.pb?.values, 750);
  const pb5yAvg = tailValidMean(bands.pb?.values, 1250);
  const pe3yAvg = tailValidMean(bands.pe?.values, 750);
  const pe5yAvg = tailValidMean(bands.pe?.values, 1250);

  const roeToPbTtm = (roeTtm !== null && pb > 0) ? (roeTtm / pb) : null;
  const roeToPb3y = (roeMean3y !== null && pb > 0) ? (roeMean3y / pb) : null;
  const roeToPb5y = (roeMean5y !== null && pb > 0) ? (roeMean5y / pb) : null;
  const histRoeToPb3y = (roeMean3y !== null && pb3yAvg > 0) ? (roeMean3y / pb3yAvg) : null;
  const histRoeToPb5y = (roeMean5y !== null && pb5yAvg > 0) ? (roeMean5y / pb5yAvg) : null;

  return {
    code,
    name: symbolName,
    symSnap,
    priceDate,
    unadjPrice,
    shares,
    sharesSrc,
    sharesSourceKind,
    isExactShares,
    impliedMktCap,
    isFinancial: Boolean(qNow?.isFinancial),
    divIncludesBondInterest: Boolean(qNow?.divIncludesBondInterest),
    qNow,
    quarters,
    fcf3yAvg,
    fcf5yAvg,
    fcf3yYieldPct,
    fcf5yYieldPct,
    fcfDivCoverage,
    fcf3yDivCoverage,
    fcfCoverageIsProfitProxy,
    capexToOcfPct,
    cagrNp,
    cagrLabel,
    dcfModel,
    peTtm,
    pe3yNorm,
    pe5yNorm,
    pe3yAvg,
    pe5yAvg,
    pb,
    pb3yAvg,
    pb5yAvg,
    psTtm,
    fcfYieldPct,
    pFcf,
    dpsTtm,
    exDiv,
    ttmDivActual,
    approxDivYieldPct,
    approxPayoutPct,
    epsOrdinaryTtm: epsForPayout,
    payoutBasis,
    ordinaryNpRatio,
    divStability,
    buybackYieldPct,
    buybackRawPct,
    buybackSource,
    buybackNote,
    buybackDetail,
    shareHistoryCount: shareTimeline.length,
    shareholderYieldPct,
    cashConv3y,
    cashConv5y,
    roeMean3y,
    roeMean5y,
    roeMin3y,
    roeMin5y,
    roeVol3y,
    roeVol5y,
    roic3yMean,
    roic5yMean,
    roicIsRoeProxy,
    roeToPbTtm,
    roeToPb3y,
    roeToPb5y,
    histRoeToPb3y,
    histRoeToPb5y,
    npYoy1y,
    npYoy1yRaw,
    vol3y,
    maxDd3y,
    debtRatioPct,
    ibDebtRatioPct,
    riskFlag,
    peg,
    epsTtm,
    bvps,
    netMargin,
    assetTurnover,
    equityMultiplier,
    roeTtm,
    accrualRatio,
    arToRevPct,
    netCashToMktCap,
    enterpriseValue,
    evDebtBasis,
    evToEbitTtm,
    evToEbit3y,
    evToEbit5y,
    ebitYieldTtm,
    ebitYield3y,
    ebitYield5y,
    ebitCyclePos,
    qGmLatest,
    qGmYoyPp,
    deltaRoeMarginPp,
    capexToRevPct,
    interestCoverage,
    cashToDebtPct,
    npCagr3y,
    npCagr3yRaw,
    revYoy1y,
    revYoy1yRaw,
    revCagr3y,
    revCagr3yRaw,
    rdRatioPct,
    ttmGmPct,
    fcfMarginTtm,
    fcfMargin3y,
    peg3y,
    psg,
    bands
  };
}

export function getBaseCashFlowByKey(snap, baseKey) {
  if (!snap) return null;
  if (baseKey === "fcf_3y") return snap.fcf3yAvg;
  if (baseKey === "np_ttm") return snap.qNow?.ttmNp ?? null;
  if (baseKey === "div_ttm") return snap.ttmDivActual ?? snap.qNow?.ttmDiv ?? null;
  return snap.qNow?.ttmFcf ?? null;
}

export function computePeerMetrics(snap, opts = {}) {
  const rMode = opts.rMode === "hist_gordon" ? "hist_gordon" : "capm";
  const scenario = ["conservative", "neutral", "optimistic"].includes(opts.scenario) ? opts.scenario : "neutral";
  const netCashAdj = Boolean(opts.netCashAdj);
  const rimAllowBelowBook = Boolean(opts.rimAllowBelowBook);

  const scen = snap?.dcfModel?.presetsByMode?.[rMode]?.[scenario]
    || snap?.dcfModel?.presetsByMode?.[rMode]?.neutral
    || snap?.dcfModel?.presets?.neutral
    || null;
  const dcfBase = selectDefaultDcfBase(snap);
  const dcfBaseLabelMap = {
    fcf_ttm: "TTM FCF",
    fcf_3y: "3年FCF",
    np_ttm: "TTM净利",
    div_ttm: "DDM"
  };
  const baseCF = getBaseCashFlowByKey(snap, dcfBase);
  const ncAdj = (netCashAdj && !snap.isFinancial && dcfBase !== "div_ttm" && snap.shares > 0 && snap.qNow?.cash != null && snap.qNow?.debt != null)
    ? (snap.qNow.cash - snap.qNow.debt) / snap.shares
    : 0;
  const dcfRaw = scen ? calcTwoStageDCF(baseCF, snap.shares, scen.g1, scen.g2, scen.r)?.valuePerShare : null;
  const dcfMid = (dcfRaw != null && dcfRaw + ncAdj > 0) ? (dcfRaw + ncAdj) : null;
  const curPrice = snap.unadjPrice;
  const dcfUpsidePct = (dcfMid > 0 && curPrice > 0) ? ((dcfMid / curPrice - 1) * 100) : null;
  const rimMid = scen ? calcRIM(snap.bvps, snap.roeTtm, snap.approxPayoutPct, scen.g2, scen.r, rimAllowBelowBook) : null;
  const rimUpsidePct = (rimMid > 0 && curPrice > 0) ? ((rimMid / curPrice - 1) * 100) : null;
  const opCur = (curPrice > 0 && curPrice - ncAdj > 0) ? (curPrice - ncAdj) : null;
  const impliedIrr = (scen && opCur != null) ? solveImpliedReturn(baseCF, snap.shares, scen.g1, scen.g2, opCur) : null;
  const roicSpread = (snap.roic5yMean != null && scen?.r != null) ? (snap.roic5yMean - scen.r) : null;
  const dstab = snap.divStability || {};
  const divStabilityScore = dstab.divStabilityScore ?? 0;
  const divStabilityGrade = dstab.divStabilityGrade || "无分红";
  const divConsecYears = dstab.divConsecYears ?? 0;
  const divYearsIn5 = dstab.divYearsIn5 ?? 0;
  const divCv5y = dstab.divCv5y ?? null;
  const divCutCount5y = dstab.divCutCount5y ?? 0;
  const divCagr3y = dstab.divCagr3y ?? null;
  const divCagr5y = dstab.divCagr5y ?? null;
  const divYieldTrap = Boolean(snap.approxDivYieldPct != null && snap.approxDivYieldPct >= 4 && divStabilityScore < 50);
  const retainRatio = snap.approxPayoutPct != null ? clamp(1 - snap.approxPayoutPct / 100, 0, 1) : 0.5;
  const divElasticityForward = (scen?.g1 != null && Number.isFinite(scen.g1))
    ? clamp(scen.g1 * retainRatio, -20, 40)
    : null;
  const maxDd3yAbs = (snap.maxDd3y != null && Number.isFinite(snap.maxDd3y))
    ? Math.abs(snap.maxDd3y)
    : null;
  const isDivVeto = (!snap.isFinancial && snap.fcfDivCoverage != null && snap.fcfDivCoverage < 1.0)
    || (snap.isFinancial && snap.approxPayoutPct != null && snap.approxPayoutPct > 90)
    || (divStabilityScore < 50 || divCutCount5y >= 2)
    || (snap.maxDd3y != null && snap.maxDd3y < -45)
    || ((snap.buybackYieldPct ?? 0) <= -3.0);
  const isDivShield = !isDivVeto
    && divStabilityScore >= 75
    && (snap.fcfDivCoverage != null && snap.fcfDivCoverage >= 1.2)
    && (snap.vol3y != null && snap.vol3y <= 24)
    && (snap.maxDd3y != null && snap.maxDd3y >= -25);
  const divRiskFlag = isDivVeto ? "high_risk" : (isDivShield ? "low_vol" : "normal");

  const qRoicRef = snap.roic5yMean ?? snap.roic3yMean ?? snap.roeMean5y ?? snap.roeTtm;
  const qCashConvRef = snap.cashConv5y ?? snap.cashConv3y;
  const qRoeVolRef = snap.roeVol5y ?? snap.roeVol3y;
  const isQualityVeto = (!snap.isFinancial && qCashConvRef != null && qCashConvRef < 0.70)
    || (!snap.isFinancial && snap.accrualRatio != null && snap.accrualRatio > 8.0)
    || (!snap.isFinancial && snap.debtRatioPct != null && snap.debtRatioPct > 65)
    || (qRoeVolRef != null && qRoeVolRef > 8.0)
    || (snap.roeMin5y != null && snap.roeMin5y < 5.0);
  const isQualityShield = !isQualityVeto
    && (qRoicRef != null && qRoicRef >= 12.0)
    && (snap.isFinancial || (qCashConvRef != null && qCashConvRef >= 0.90))
    && (qRoeVolRef != null && qRoeVolRef <= 4.5)
    && (snap.isFinancial || snap.accrualRatio == null || snap.accrualRatio <= 4.0);
  const qualityRiskFlag = isQualityVeto ? "high_risk" : (isQualityShield ? "low_vol" : "normal");

  const pbCheapness5y = snap.bands?.pb?.pct != null ? clamp(100 - snap.bands.pb.pct, 0, 100) : null;
  const cycEbitYieldRef = snap.ebitYield5y ?? snap.ebitYield3y ?? snap.ebitYieldTtm;
  const isCycleVeto = (!snap.isFinancial && snap.debtRatioPct != null && snap.debtRatioPct > 70 && (snap.cashToDebtPct == null || snap.cashToDebtPct < 20))
    || (!snap.isFinancial && snap.interestCoverage != null && snap.interestCoverage < 2.0)
    || (snap.qGmYoyPp != null && snap.qGmYoyPp < -4.0 && (snap.capexToOcfPct == null || snap.capexToOcfPct > 100))
    || (snap.ebitCyclePos != null && snap.ebitCyclePos > 1.8 && snap.bands?.pb?.pct != null && snap.bands.pb.pct > 70)
    || (snap.maxDd3y != null && snap.maxDd3y < -55);
  const isCycleShield = !isCycleVeto
    && ((pbCheapness5y != null && pbCheapness5y >= 55) || (cycEbitYieldRef != null && cycEbitYieldRef >= 8.0))
    && ((snap.qGmYoyPp != null && snap.qGmYoyPp > 0) || (snap.deltaRoeMarginPp != null && snap.deltaRoeMarginPp > 0))
    && (snap.isFinancial || snap.debtRatioPct == null || snap.debtRatioPct <= 60);
  const cycleRiskFlag = isCycleVeto ? "high_risk" : (isCycleShield ? "low_vol" : "normal");

  const npAccelPp = (snap.npYoy1y != null && scen?.g1 != null)
    ? clamp(snap.npYoy1y - scen.g1, -50, 50)
    : ((snap.npYoy1y != null && snap.npCagr3y != null) ? clamp(snap.npYoy1y - snap.npCagr3y, -50, 50) : null);
  const revAccelPp = (snap.revYoy1y != null && snap.revCagr3y != null)
    ? clamp(snap.revYoy1y - snap.revCagr3y, -50, 50)
    : null;
  const gPegRef = snap.peg3y ?? ((snap.peTtm > 0 && scen?.g1 > 0) ? clamp(snap.peTtm / scen.g1, 0.05, 10) : snap.peg);
  const gCashConvRef = snap.cashConv3y ?? snap.cashConv5y;
  const gRoicRef = snap.roic3yMean ?? snap.roic5yMean ?? snap.roeMean3y ?? snap.roeTtm;
  const isGrowthVeto = (gPegRef != null && gPegRef > 2.2)
    || (npAccelPp != null && npAccelPp < -12.0 && (snap.npYoy1y == null || snap.npYoy1y < 10))
    || (!snap.isFinancial && gCashConvRef != null && gCashConvRef < 0.60 && (snap.buybackYieldPct ?? 0) <= -2.0)
    || (!snap.isFinancial && snap.fcfMargin3y != null && snap.fcfMargin3y < -5.0 && (snap.buybackYieldPct ?? 0) <= -2.0)
    || (snap.npYoy1y != null && snap.npYoy1y < -15.0 && (snap.revYoy1y == null || snap.revYoy1y < 0));
  const isGrowthShield = !isGrowthVeto
    && (npAccelPp != null && npAccelPp > 0)
    && ((gPegRef != null && gPegRef <= 1.2) || (snap.psg != null && snap.psg <= 0.22 && snap.revYoy1y != null && snap.revYoy1y >= 15))
    && (gRoicRef != null && gRoicRef >= 10.0)
    && (snap.isFinancial || gCashConvRef == null || gCashConvRef >= 0.80);
  const growthRiskFlag = isGrowthVeto ? "high_risk" : (isGrowthShield ? "low_vol" : "normal");

  const fmtDpsTrim = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "--";
    return Number(n.toFixed(4)).toString();
  };
  const exEvs = snap.exDiv?.events || [];
  let divEventsShort = "";
  let divEventsDetail = "";
  if (exEvs.length > 0 && snap.dpsTtm > 0) {
    const partsShort = exEvs.map(e => `${String(e.date).slice(2)} ¥${fmtDpsTrim(e.dps)}`);
    const partsFull = exEvs.map(e => `${e.date} 派¥${fmtDpsTrim(e.dps)}/股`);
    divEventsShort = `${exEvs.length}次除息 共¥${fmtDpsTrim(snap.dpsTtm)} (${partsShort.join(" + ")})`;
    const pxTxt = curPrice > 0 ? ` ÷ 现价¥${curPrice.toFixed(2)}` : "";
    const dyTxt = snap.approxDivYieldPct != null ? ` = 股息率${snap.approxDivYieldPct.toFixed(2)}%` : "";
    const payTxt = snap.approxPayoutPct != null ? `\n派息率: ${snap.payoutBasis || "归母TTM"} ≈ ${snap.approxPayoutPct.toFixed(1)}%` : "";
    divEventsDetail = `近12个月除息 (${snap.exDiv.note || "TTM"}): ${partsFull.join(" + ")} = ¥${fmtDpsTrim(snap.dpsTtm)}/股${pxTxt}${dyTxt}${payTxt}`;
  } else if (snap.exDiv?.count === 0) {
    divEventsShort = "近12月零现金除息";
    divEventsDetail = "近12个月无现金分红除息记录";
  }

  return {
    code: snap.code,
    name: snap.name || snap.code,
    isFinancial: Boolean(snap.isFinancial),
    unadjPrice: curPrice,
    mktCap: snap.impliedMktCap,
    peTtm: snap.peTtm,
    pe3yNorm: snap.pe3yNorm ?? null,
    pe5yNorm: snap.pe5yNorm ?? null,
    pe3yAvg: snap.pe3yAvg ?? null,
    pe5yAvg: snap.pe5yAvg ?? null,
    pePct5y: snap.bands?.pe?.pct ?? null,
    pb: snap.pb,
    pb3yAvg: snap.pb3yAvg ?? null,
    pb5yAvg: snap.pb5yAvg ?? null,
    pbPct5y: snap.bands?.pb?.pct ?? null,
    psTtm: snap.psTtm,
    dpsTtm: snap.dpsTtm ?? null,
    divYieldPct: snap.approxDivYieldPct,
    buybackYieldPct: snap.buybackYieldPct ?? 0,
    buybackRawPct: snap.buybackRawPct ?? (snap.buybackYieldPct ?? 0),
    buybackSource: snap.buybackSource || "仅现金分红",
    buybackNote: snap.buybackNote || "",
    buybackDetail: snap.buybackDetail || null,
    shareholderYieldPct: snap.shareholderYieldPct ?? snap.approxDivYieldPct ?? null,
    payoutPct: snap.approxPayoutPct,
    payoutBasis: snap.payoutBasis || "归母TTM",
    divEventsShort,
    divEventsDetail,
    divStabilityScore,
    divStabilityGrade,
    divConsecYears,
    divYearsIn5,
    divCv5y,
    divCutCount5y,
    divCagr3y,
    divCagr5y,
    divElasticityForward,
    divYieldTrap,
    fcfDivCoverage: snap.fcfDivCoverage ?? null,
    fcf3yDivCoverage: snap.fcf3yDivCoverage ?? null,
    fcfCoverageIsProfitProxy: Boolean(snap.fcfCoverageIsProfitProxy),
    capexToOcfPct: snap.capexToOcfPct ?? null,
    maxDd3yAbs,
    divRiskFlag,
    fcfYieldPct: snap.fcfYieldPct ?? null,
    fcf3yYieldPct: snap.fcf3yYieldPct ?? null,
    fcf5yYieldPct: snap.fcf5yYieldPct ?? null,
    cashConv3y: snap.cashConv3y ?? null,
    cashConv5y: snap.cashConv5y ?? null,
    roeTtm: snap.roeTtm,
    roeMean3y: snap.roeMean3y ?? null,
    roeMean5y: snap.roeMean5y ?? null,
    roeMin3y: snap.roeMin3y ?? null,
    roeMin5y: snap.roeMin5y ?? null,
    roeVol3y: snap.roeVol3y ?? null,
    roic3yMean: snap.roic3yMean ?? null,
    roic5yMean: snap.roic5yMean ?? null,
    roicIsRoeProxy: Boolean(snap.roicIsRoeProxy),
    roicSpread,
    roeVol5y: snap.roeVol5y ?? null,
    roeToPbTtm: snap.roeToPbTtm ?? null,
    roeToPb3y: snap.roeToPb3y ?? null,
    roeToPb5y: snap.roeToPb5y ?? null,
    histRoeToPb3y: snap.histRoeToPb3y ?? null,
    histRoeToPb5y: snap.histRoeToPb5y ?? null,
    g1Base: scen?.g1 ?? null,
    npYoy1y: snap.npYoy1y ?? null,
    npYoy1yRaw: snap.npYoy1yRaw ?? null,
    vol3y: snap.vol3y ?? null,
    maxDd3y: snap.maxDd3y ?? null,
    debtRatioPct: snap.debtRatioPct ?? null,
    ibDebtRatioPct: snap.ibDebtRatioPct ?? null,
    netCashToMktCap: snap.netCashToMktCap ?? null,
    accrualRatio: snap.accrualRatio ?? null,
    arToRevPct: snap.arToRevPct ?? null,
    qualityRiskFlag,
    enterpriseValue: snap.enterpriseValue ?? null,
    evDebtBasis: snap.evDebtBasis || "--",
    evToEbitTtm: snap.evToEbitTtm ?? null,
    evToEbit3y: snap.evToEbit3y ?? null,
    evToEbit5y: snap.evToEbit5y ?? null,
    ebitYieldTtm: snap.ebitYieldTtm ?? null,
    ebitYield3y: snap.ebitYield3y ?? null,
    ebitYield5y: snap.ebitYield5y ?? null,
    ebitCyclePos: snap.ebitCyclePos ?? null,
    qGmLatest: snap.qGmLatest ?? null,
    qGmYoyPp: snap.qGmYoyPp ?? null,
    deltaRoeMarginPp: snap.deltaRoeMarginPp ?? null,
    capexToRevPct: snap.capexToRevPct ?? null,
    interestCoverage: snap.interestCoverage ?? null,
    cashToDebtPct: snap.cashToDebtPct ?? null,
    pbCheapness5y,
    cycleRiskFlag,
    npCagr3y: snap.npCagr3y ?? null,
    revYoy1y: snap.revYoy1y ?? null,
    revYoy1yRaw: snap.revYoy1yRaw ?? null,
    revCagr3y: snap.revCagr3y ?? null,
    npAccelPp,
    revAccelPp,
    rdRatioPct: snap.rdRatioPct ?? null,
    ttmGmPct: snap.ttmGmPct ?? null,
    fcfMarginTtm: snap.fcfMarginTtm ?? null,
    fcfMargin3y: snap.fcfMargin3y ?? null,
    peg3y: snap.peg3y ?? null,
    psg: snap.psg ?? null,
    growthRiskFlag,
    riskFlag: snap.riskFlag || "normal",
    dcfBase,
    dcfBaseLabel: dcfBaseLabelMap[dcfBase] || "DCF",
    dcfMid,
    dcfUpsidePct,
    rimMid,
    rimUpsidePct,
    impliedIrr,
    rUsed: scen?.r ?? null,
    netCashPerShare: ncAdj,
    snap
  };
}

export function calcTwoStageDCF(baseCF, shares, g1Pct, g2Pct, rPct) {
  const g1 = g1Pct / 100;
  const g2 = g2Pct / 100;
  const r = rPct / 100;
  if (!(baseCF > 0) || !(shares > 0) || !(r > g2 + 0.005)) return null;

  let pvStage1 = 0;
  let cf = baseCF;
  for (let t = 1; t <= 5; t++) {
    cf *= (1 + g1);
    pvStage1 += cf / Math.pow(1 + r, t);
  }
  const tv = (cf * (1 + g2)) / (r - g2);
  const pvTerminal = tv / Math.pow(1 + r, 5);
  return {
    valuePerShare: (pvStage1 + pvTerminal) / shares,
    pvStage1: pvStage1 / shares,
    pvTerminal: pvTerminal / shares
  };
}

export function solveImpliedReturn(baseCF, shares, g1Pct, g2Pct, curPrice) {
  if (!(baseCF > 0) || !(shares > 0) || !(curPrice > 0)) return null;
  const rLoInit = g2Pct + 0.55;
  const rHiInit = 45.0;
  const vAtLo = calcTwoStageDCF(baseCF, shares, g1Pct, g2Pct, rLoInit)?.valuePerShare;
  const vAtHi = calcTwoStageDCF(baseCF, shares, g1Pct, g2Pct, rHiInit)?.valuePerShare;
  if (!(vAtLo > 0) || !(vAtHi > 0)) return null;
  if (curPrice >= vAtLo || curPrice <= vAtHi) return null;

  let lo = rLoInit;
  let hi = rHiInit;
  for (let iter = 0; iter < 28; iter++) {
    const mid = (lo + hi) / 2;
    const vMid = calcTwoStageDCF(baseCF, shares, g1Pct, g2Pct, mid)?.valuePerShare;
    if (!(vMid > 0)) return null;
    if (vMid > curPrice) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function calcRIM(bvps, roePct, payoutPct, g2Pct, rPct, allowBelowBook = false) {
  const r = rPct / 100;
  const g2 = g2Pct / 100;
  if (!(bvps > 0) || !(r > g2 + 0.005)) return null;

  const roe0 = clamp((roePct ?? 10) / 100, -0.25, 0.45);
  const targetRoe = allowBelowBook
    ? clamp(roe0 * 0.72, 0.02, 0.30)
    : clamp(Math.max(r, roe0 * 0.72), 0.04, 0.30);
  const retention = clamp(1 - (payoutPct != null ? payoutPct / 100 : 0.30), 0.15, 0.90);

  let bv = bvps;
  let pvRI = 0;
  for (let t = 1; t <= 5; t++) {
    const roeT = roe0 + ((targetRoe - roe0) * (t - 1)) / 5;
    const ri = (roeT - r) * bv;
    pvRI += ri / Math.pow(1 + r, t);
    bv *= (1 + Math.max(-0.15, roeT * retention));
  }
  const termRI = ((targetRoe - r) * bv) / (r - g2);
  const pvTerm = termRI / Math.pow(1 + r, 5);
  const rawVal = bvps + pvRI + pvTerm;
  const minFloor = allowBelowBook ? bvps * 0.25 : bvps * 0.4;
  return clamp(rawVal, minFloor, bvps * 12);
}
