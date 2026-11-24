import { esc, fmtInt, fmtNum, fmtPct, fmtMoneyShort, clamp, daysBetweenDates, downloadCsv } from "./utils.js";
import { STATE } from "./state.js";
import { quantFetch, fetchSharesSafe, showGlobalAlert, clearGlobalAlert } from "./api.js";
import { quarterIndex, extractExDividendFromEvents } from "./valuation-engine.js";

const SNAP = { loading: false, loaded: false, result: null };
let LAST_PROBE = { code: "", checks: [] };

export function expectedLatestPeriodEnd(dateIso) {
  const s = String(dateIso || "").slice(0, 10);
  const m = /^(\d{4})-(\d{2}-\d{2})$/.exec(s);
  const y = m ? Number(m[1]) : new Date().getUTCFullYear();
  const md = m ? m[2] : new Date().toISOString().slice(5, 10);
  if (md >= "10-31") return `${y}-09-30`;
  if (md >= "08-31") return `${y}-06-30`;
  if (md >= "04-30") return `${y}-03-31`;
  return `${y - 1}-09-30`;
}

export function nominalLimitPct(code, name = "") {
  const clean = String(code || "").trim().toUpperCase();
  const nm = String(name || "").toUpperCase();
  if (clean.endsWith(".BJ")) return 30;
  if (nm.includes("ST")) return 5;
  if (/^(688|689|300|301)/.test(clean)) return 20;
  return 10;
}

export function ageDaysOf(v, todayIso) {
  if (v === null || v === undefined) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  if (!m) return null;
  const ref = /^\d{4}-\d{2}-\d{2}/.test(String(todayIso || ""))
    ? String(todayIso).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const d = daysBetweenDates(m[1], ref);
  return Number.isFinite(d) ? d : null;
}

export function levelBadge(level) {
  if (level === "pass") return "通过";
  if (level === "mid") return "警告";
  if (level === "hot") return "异常";
  return "跳过/无数据";
}

function watermarkGroup(key) {
  const k = String(key || "");
  if (k.startsWith("cn_daily_")) return "日线";
  if (k.startsWith("cn_fin_")) return "财报";
  if (k.startsWith("cn_shares_")) return "股本";
  if (k.startsWith("cn_sw_")) return "行业";
  if (k.startsWith("cn_val_")) return "估值";
  return "其他";
}

function extractWatermarkDate(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(val.trim());
    return m ? m[1] : null;
  }
  if (typeof val === "object") {
    for (const [k, v] of Object.entries(val)) {
      if (/_at$|_date$|date/i.test(k) && typeof v === "string") {
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
        if (m) return m[1];
      }
    }
  }
  return null;
}

function isBadRun(r) {
  return /fail|error|err/i.test(String(r?.status || "")) || Boolean(r?.error_message);
}

export function buildOverviewAudits(health, ov, todayIso) {
  const today = /^\d{4}-\d{2}-\d{2}/.test(String(todayIso || ""))
    ? String(todayIso).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const audits = [];
  const h = health || {};
  const sym = Number(ov?.symbols_count || 0);
  const snap = Number(ov?.screener_snapshot_rows || 0);
  const dk = ov?.daily_kline || {};
  const fin = ov?.financials || {};
  const inc = fin.income || {};
  const bal = fin.balance || {};
  const cfs = fin.cashflow || {};
  const sc = ov?.share_capital || null;

  // 1. Storage files
  const allDbs = Boolean(h.market_db_exists && h.financials_db_exists && h.screener_snapshot_exists && h.meta_db_exists);
  audits.push({
    name: "1. 核心存储文件完整性",
    level: allDbs ? "pass" : "hot",
    badge: allDbs ? "通过" : "异常",
    obs: `market=${Boolean(h.market_db_exists)}, financials=${Boolean(h.financials_db_exists)}, screener=${Boolean(h.screener_snapshot_exists)}, meta=${Boolean(h.meta_db_exists)}`,
    rule: "要求四个核心库/快照文件全部存在"
  });

  // 2. Symbol catalog scale
  audits.push({
    name: "2. A股股票目录规模",
    level: sym >= 4500 ? "pass" : (sym >= 3000 ? "mid" : "hot"),
    badge: sym >= 4500 ? "正常" : (sym >= 3000 ? "偏少" : "异常"),
    obs: `共 ${fmtInt(sym)} 只标的`,
    rule: "全市场 A 股正常应 ≥ 4,500 只，防止股票池截断或初始化不完整"
  });

  // 3. Snapshot coverage
  const covPct = sym > 0 ? (snap / sym) * 100 : 0;
  audits.push({
    name: "3. 选股快照对股票目录覆盖率",
    level: covPct >= 90 ? "pass" : (covPct >= 70 ? "mid" : "hot"),
    badge: covPct >= 90 ? "通过" : (covPct >= 70 ? "警告" : "偏低"),
    obs: `${fmtInt(snap)} / ${fmtInt(sym)}（${covPct.toFixed(1)}%）`,
    rule: "≥ 90% 为通过，70%–90% 提示部分停牌/新股缺失，< 70% 需核查"
  });

  // 4. Daily kline freshness
  const ageDays = ageDaysOf(dk.max_date, today);
  audits.push({
    name: "4. 日线行情新鲜度",
    level: ageDays !== null && ageDays <= 4 ? "pass" : (ageDays !== null && ageDays <= 10 ? "mid" : "hot"),
    badge: ageDays !== null && ageDays <= 4 ? "通过" : (ageDays !== null && ageDays <= 10 ? "滞后" : "陈旧"),
    obs: `最新交易日 ${dk.max_date || "--"}（距今 ${ageDays !== null ? ageDays : "--"} 天）`,
    rule: "考虑周末与节假日，≤ 4 天正常，5–10 天警告，> 10 天异常"
  });

  // 5. Daily kline history depth
  const minD = String(dk.min_date || "").slice(0, 10);
  const dkRows = Number(dk.rows || 0);
  const avgBars = sym > 0 ? Math.round(dkRows / sym) : 0;
  const depthLvl = minD && minD <= "2005-12-31" ? "pass" : (minD && minD <= "2015-12-31" ? "mid" : "hot");
  audits.push({
    name: "5. 日线历史深度",
    level: depthLvl,
    badge: depthLvl === "pass" ? "充足" : (depthLvl === "mid" ? "偏短" : "不足"),
    obs: `最早 ${minD || "--"} · 总计 ${fmtInt(dkRows)} 行（均值 ${fmtInt(avgBars)} 根/股）`,
    rule: "历史起点 ≤ 2005-12-31 满足长周期分位计算，≤ 2015-12-31 警告"
  });

  // 6. Adjustment events
  const adjRows = Number(dk.adjustment_events_rows || 0);
  const adjPerSym = sym > 0 ? (adjRows / sym).toFixed(1) : "--";
  audits.push({
    name: "6. 除权除息复权事件密度",
    level: adjRows > 0 ? "pass" : "hot",
    badge: adjRows > 0 ? "通过" : "为空",
    obs: `${fmtInt(adjRows)} 条复权事件（均值 ${adjPerSym} 条/股）`,
    rule: "前/后复权计算与 TTM 除息股息率均依赖复权事件表非空"
  });

  // 7. Financial symbol coverage
  const minFinSym = Math.min(Number(inc.symbols || 0), Number(bal.symbols || 0), Number(cfs.symbols || 0));
  const finCovPct = sym > 0 ? (minFinSym / sym) * 100 : 0;
  audits.push({
    name: "7. 三大财报覆盖率",
    level: finCovPct >= 95 ? "pass" : (finCovPct >= 85 ? "mid" : "hot"),
    badge: finCovPct >= 95 ? "完备" : (finCovPct >= 85 ? "偏低" : "缺失"),
    obs: `最低覆盖 ${fmtInt(minFinSym)} / ${fmtInt(sym)}（${finCovPct.toFixed(1)}%）· 利润${inc.symbols || 0} / 资产${bal.symbols || 0} / 现金${cfs.symbols || 0}`,
    rule: "三表最低标的覆盖率 ≥ 95% 为完备，85%–95% 警告，< 85% 异常"
  });

  // 8. Financial period & count alignment
  const pEnds = [inc.max_period_end, bal.max_period_end, cfs.max_period_end].filter(Boolean);
  const pAligned = pEnds.length === 3 && pEnds[0] === pEnds[1] && pEnds[1] === pEnds[2];
  const symSpread = Math.max(inc.symbols || 0, bal.symbols || 0, cfs.symbols || 0) - minFinSym;
  audits.push({
    name: "8. 三大财报报告期与标的对齐度",
    level: pAligned && symSpread <= 50 ? "pass" : (pAligned ? "mid" : "hot"),
    badge: pAligned && symSpread <= 50 ? "对齐" : (pAligned ? "微差" : "不一致"),
    obs: `期末(${inc.max_period_end || "--"} / ${bal.max_period_end || "--"} / ${cfs.max_period_end || "--"}) · 标的数量(${inc.symbols || 0} / ${bal.symbols || 0} / ${cfs.symbols || 0})`,
    rule: "要求三大报表 max_period_end 一致且标的差 ≤ 50"
  });

  // 9. Financial disclosure progress vs statutory deadline
  const expPe = expectedLatestPeriodEnd(today);
  const validPe = pEnds.map(s => String(s).slice(0, 10)).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
  const minMaxPe = validPe[0] || "";
  let progLvl = "hot";
  let progBadge = "严重滞后";
  if (minMaxPe) {
    if (minMaxPe >= expPe) {
      progLvl = "pass";
      progBadge = "同步";
    } else {
      const gap = ageDaysOf(minMaxPe, expPe);
      if (gap !== null && gap <= 100) {
        progLvl = "mid";
        progBadge = "滞后1季";
      }
    }
  }
  audits.push({
    name: "9. 财报披露进度 vs 法定期限",
    level: progLvl,
    badge: progBadge,
    obs: `当前最旧表期末 ${minMaxPe || "--"} · 法定应披露期末 ${expPe}`,
    rule: "对照 A 股一季报(04-30)/中报(08-31)/三季报(10-31) 法定期限"
  });

  // 10. Financial latest report_date freshness
  const repDates = [inc.max_report_date, bal.max_report_date, cfs.max_report_date]
    .map(s => String(s || "").slice(0, 10))
    .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
    .sort();
  const maxRepDate = repDates[repDates.length - 1] || "";
  const repAge = ageDaysOf(maxRepDate, today);
  audits.push({
    name: "10. 财报最新披露日新鲜度",
    level: repAge !== null && repAge <= 80 ? "pass" : (repAge !== null && repAge <= 120 ? "mid" : "hot"),
    badge: repAge !== null && repAge <= 80 ? "及时" : (repAge !== null && repAge <= 120 ? "偏旧" : "停更"),
    obs: `最新披露日 ${maxRepDate || "--"}（距今 ${repAge !== null ? repAge : "--"} 天）`,
    rule: "财报最新 report_date 距今 ≤ 80 天为正常季报窗，> 120 天异常"
  });

  // 11. Share capital coverage & freshness
  if (!sc) {
    audits.push({
      name: "11. 历史股本表覆盖与时效",
      level: "fail",
      badge: "未返回",
      obs: "/api/overview 未返回 share_capital 字段",
      rule: "历史股本用于净回购与 5Y ASOF 估值分位还原"
    });
  } else {
    const scSym = Number(sc.symbols || 0);
    const scRows = Number(sc.rows || 0);
    const scCov = sym > 0 ? (scSym / sym) * 100 : 0;
    const scAge = ageDaysOf(sc.max_change_date, today);
    const scLvl = scCov >= 95 && (scAge === null || scAge <= 120) ? "pass" : (scCov >= 85 ? "mid" : "hot");
    audits.push({
      name: "11. 历史股本表覆盖与时效",
      level: scLvl,
      badge: scLvl === "pass" ? "完备" : (scLvl === "mid" ? "偏低" : "异常"),
      obs: `${fmtInt(scRows)} 行 · ${fmtInt(scSym)} 标的 (${scCov.toFixed(1)}%) · ${sc.min_change_date || "--"} ~ ${sc.max_change_date || "--"}`,
      rule: "要求覆盖率 ≥ 95% 且最新变动日距今 ≤ 120 天"
    });
  }

  // 12. Watermarks freshness
  const wm = ov?.watermarks || {};
  const wmChecks = [];
  for (const [k, v] of Object.entries(wm)) {
    const dStr = extractWatermarkDate(v);
    if (!dStr) continue;
    const age = ageDaysOf(dStr, today);
    if (age === null) continue;
    const thresh = k.includes("sw_industry") ? 10 : 4;
    wmChecks.push({ key: k, date: dStr, age, thresh });
  }
  let wmLvl = "mid";
  let wmBadge = "无时间戳";
  let wmObs = "watermarks 中未解析出有效日期";
  if (wmChecks.length > 0) {
    const stale = wmChecks.filter(w => w.age > w.thresh);
    const severe = stale.some(w => w.age > w.thresh * 2);
    if (stale.length === 0) {
      wmLvl = "pass";
      wmBadge = "全最新";
      wmObs = `${wmChecks.length} 项均在时效内`;
    } else {
      wmLvl = severe ? "hot" : "mid";
      wmBadge = severe ? "严重过期" : "部分滞后";
      wmObs = `滞后 ${stale.length}/${wmChecks.length}: ` + stale.slice(0, 4).map(w => `${w.key}(${w.age}天)`).join(" · ");
    }
  }
  audits.push({
    name: "12. 水位线时效",
    level: wmLvl,
    badge: wmBadge,
    obs: wmObs,
    rule: "申万分类 ≤ 10 天、日线/财报/股本/估值水位线 ≤ 4 天"
  });

  // 13. Latest sync run health
  const runs = Array.isArray(ov?.recent_runs) ? ov.recent_runs : [];
  const failedRuns = runs.filter(isBadRun);
  const latestRun = runs[0];
  const latestOk = latestRun ? !isBadRun(latestRun) : false;
  audits.push({
    name: "13. 最近定时同步任务健康度",
    level: runs.length === 0 ? "mid" : (latestOk && failedRuns.length === 0 ? "pass" : (latestOk ? "mid" : "hot")),
    badge: runs.length === 0 ? "无记录" : (latestOk && failedRuns.length === 0 ? "全绿" : (latestOk ? "含历史异常" : "最新失败")),
    obs: latestRun ? `最新任务 ${latestRun.job_name || "--"} (${latestRun.status || "--"}) · 近10次异常 ${failedRuns.length} 次` : "暂无 sync_runs 记录",
    rule: "最近 1 次须成功且近 10 次无未恢复报错"
  });

  // 14. Per-job latest status
  const latestByJob = new Map();
  for (const r of runs) {
    const jn = r?.job_name || "unknown";
    if (!latestByJob.has(jn)) latestByJob.set(jn, r);
  }
  const jobFailNames = [];
  const jobObsList = [];
  for (const [jn, r] of latestByJob.entries()) {
    if (isBadRun(r)) jobFailNames.push(jn);
    jobObsList.push(`${jn}: ${r.status || "--"}`);
  }
  audits.push({
    name: "14. 各任务独立健康度",
    level: latestByJob.size === 0 ? "mid" : (jobFailNames.length === 0 ? "pass" : "hot"),
    badge: latestByJob.size === 0 ? "无记录" : (jobFailNames.length === 0 ? "全部正常" : `${jobFailNames.length} 个异常`),
    obs: jobObsList.length ? jobObsList.join(" · ") : "暂无任务分组记录",
    rule: "每个调度任务最近一次执行状态均需正常，防止某条同步链静默失败"
  });

  // 15. Sync duration anomaly
  const dursByJob = new Map();
  for (const r of runs) {
    const d = Number(r?.duration_sec);
    if (!Number.isFinite(d) || d < 0) continue;
    const jn = r?.job_name || "unknown";
    if (!dursByJob.has(jn)) dursByJob.set(jn, []);
    dursByJob.get(jn).push(d);
  }
  const durSpikes = [];
  for (const [jn, arr] of dursByJob.entries()) {
    const s = [...arr].sort((a, b) => a - b);
    const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    for (const d of arr) {
      if (d > 60 && d > med * 3) {
        durSpikes.push(`${jn} ${fmtNum(d, 0)}s(中位${fmtNum(med, 0)}s)`);
        break;
      }
    }
  }
  audits.push({
    name: "15. 同步耗时异常",
    level: durSpikes.length ? "mid" : "pass",
    badge: durSpikes.length ? "耗时飙升" : "稳定",
    obs: durSpikes.length ? durSpikes.join(" · ") : (dursByJob.size ? "近10次均未超出各自3倍中位数" : "暂无耗时样本"),
    rule: "单次耗时 > 60s 且超过该任务中位数 3 倍时提示网络或限流阻塞"
  });

  return audits;
}

export const SNAP_FIELD_GROUPS = [
  {
    group: "行业",
    fields: [
      { key: "sw_l1_code", note: "申万 2021 一级行业代码" },
      { key: "sw_l2_code", note: "申万 2021 二级行业代码" },
      { key: "sw_l3_code", note: "申万 2021 三级行业代码" }
    ]
  },
  {
    group: "行情",
    fields: [
      { key: "trade_date", note: "最新行情交易日" },
      { key: "close", note: "最新前复权收盘价" },
      { key: "unadj_close", note: "最新不复权收盘价" },
      { key: "avg_turnover_20d", note: "20日日均成交额" },
      { key: "pct_chg_20d", note: "近20日涨跌幅" },
      { key: "pct_chg_250d", note: "近250日涨跌幅" }
    ]
  },
  {
    group: "财报",
    fields: [
      { key: "fiscal_year", note: "最新财报年度" },
      { key: "report_date", note: "实际披露日期" },
      { key: "period_end", note: "报告期末日期" },
      { key: "ttm_operating_income", note: "TTM 营业收入" },
      { key: "ttm_parent_holder_net_profit", note: "TTM 归母净利润" },
      { key: "ttm_ocf", note: "TTM 经营现金流净额" },
      { key: "roe_ttm_pct", note: "TTM ROE (%)" },
      { key: "debt_to_assets_pct", note: "资产负债率 (%)" },
      { key: "gross_margin_pct", note: "毛利率 (金融股无毛利率属正常)" }
    ]
  },
  {
    group: "估值股本",
    fields: [
      { key: "total_shares", note: "权威总股本" },
      { key: "total_market_cap", note: "总市值" },
      { key: "pe_ttm", note: "PE_TTM (亏损股为空属正常)" },
      { key: "pb", note: "市净率 PB" },
      { key: "ps_ttm", note: "市销率 PS_TTM" },
      { key: "dps_ttm", note: "TTM 每股现金分红" },
      { key: "div_yield_ttm", note: "TTM 股息率 (%)" },
      { key: "pe_pct_5y", note: "近5年 PE 历史分位 (%)" },
      { key: "pb_pct_5y", note: "近5年 PB 历史分位 (%)" }
    ]
  }
];

function isPresent(val) {
  if (val === null || val === undefined || val === "") return false;
  if (typeof val === "number") return Number.isFinite(val);
  return true;
}

export function auditSnapshotRows(rawRows, { dailyMaxDate = null, todayIso } = {}) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const today = /^\d{4}-\d{2}-\d{2}/.test(String(todayIso || ""))
    ? String(todayIso).slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const dupSamples = [];
  let dupHits = 0;
  const byCode = new Map();
  for (const r of rows) {
    const code = r?.thscode;
    if (!code) continue;
    if (byCode.has(code)) {
      dupHits++;
      if (dupSamples.length < 6) dupSamples.push({ code, name: r?.name || "", val: "重复行" });
    } else {
      byCode.set(code, r);
    }
  }
  const uniqRows = [...byCode.values()];
  const totalUniq = uniqRows.length || 1;

  // Field coverage stats (27 fields)
  const fieldStats = [];
  for (const grp of SNAP_FIELD_GROUPS) {
    for (const f of grp.fields) {
      let nonNull = 0;
      for (const r of uniqRows) {
        if (isPresent(r?.[f.key])) nonNull++;
      }
      const missing = uniqRows.length - nonNull;
      const pct = uniqRows.length ? (nonNull / uniqRows.length) * 100 : 0;
      fieldStats.push({
        group: grp.group,
        key: f.key,
        note: f.note,
        nonNull,
        missing,
        pct
      });
    }
  }

  let maxTradeDate = "";
  const indMap = new Map();
  let unclassified = 0;
  for (const r of uniqRows) {
    const td = String(r?.trade_date || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(td) && td > maxTradeDate) maxTradeDate = td;
    if (!isPresent(r?.sw_l1_code)) {
      unclassified++;
    } else {
      const nm = r.sw_l1_name || r.sw_l1_code;
      indMap.set(nm, (indMap.get(nm) || 0) + 1);
    }
  }
  const industry = [...indMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const expPe = expectedLatestPeriodEnd(today);
  const rules = [];
  const pushRule = (name, rule, levelFn, hits, samples) => {
    rules.push({
      name,
      level: levelFn(hits),
      hits,
      samples: samples.slice(0, 6),
      rule
    });
  };

  // 1. Duplicate code
  pushRule(
    "1. 重复代码 (thscode)",
    "快照主键 thscode 不应出现重复",
    h => (h > 0 ? "hot" : "pass"),
    dupHits,
    dupSamples
  );

  // 2. Snapshot max trade date vs daily kline
  const dkDate = dailyMaxDate ? String(dailyMaxDate).slice(0, 10) : null;
  let tdMatchLevel = "fail";
  let tdMatchHits = 0;
  const tdSamples = [];
  if (dkDate) {
    if (maxTradeDate === dkDate) {
      tdMatchLevel = "pass";
    } else {
      tdMatchLevel = "hot";
      tdMatchHits = 1;
      tdSamples.push({ code: "快照", name: maxTradeDate || "--", val: `日线:${dkDate}` });
    }
  }
  rules.push({
    name: "2. 快照交易日 vs 日线库",
    level: tdMatchLevel,
    hits: tdMatchHits,
    samples: tdSamples,
    rule: "快照最新 trade_date 须与全库日线 max_date 一致"
  });

  // Helper to collect hits
  const scanCheck = (pred) => {
    let hits = 0;
    const samples = [];
    for (const r of uniqRows) {
      const val = pred(r);
      if (val !== null && val !== false) {
        hits++;
        if (samples.length < 6) {
          samples.push({ code: r.thscode, name: r.name || "", val: String(val) });
        }
      }
    }
    return { hits, samples };
  };

  // 3. Stale quote (>10d behind maxTradeDate)
  const r3 = scanCheck(r => {
    if (!maxTradeDate) return null;
    const d = ageDaysOf(r.trade_date, maxTradeDate);
    if (d !== null && d >= 10) return `${String(r.trade_date).slice(0, 10)}(-${d}d)`;
    return null;
  });
  pushRule(
    "3. 行情停更 (落后最新日 ≥ 10 天)",
    "停牌股属正常现象；命中率 ≤ 2% 通过，≤ 5% 警告，> 5% 异常",
    h => (h / totalUniq <= 0.02 ? "pass" : (h / totalUniq <= 0.05 ? "mid" : "hot")),
    r3.hits,
    r3.samples
  );

  // 4. Stale financials (>100d before expectedLatestPeriodEnd or null)
  const r4 = scanCheck(r => {
    const pe = String(r.period_end || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pe)) return "期末空";
    const gap = daysBetweenDates(pe, expPe);
    if (gap > 100) return pe;
    return null;
  });
  pushRule(
    "4. 财报严重滞后",
    `period_end 早于法定应披露期(${expPe})逾100天或为空；≤ 3% 通过，≤ 8% 警告`,
    h => (h / totalUniq <= 0.03 ? "pass" : (h / totalUniq <= 0.08 ? "mid" : "hot")),
    r4.hits,
    r4.samples
  );

  // 5. close vs unadj_close consistency
  const r5 = scanCheck(r => {
    const c = Number(r.close);
    const u = Number(r.unadj_close);
    if (!(c > 0) || !(u > 0)) return null;
    const rel = Math.abs(c - u) / u;
    if (rel > 0.005) return `Δ${(rel * 100).toFixed(1)}%`;
    return null;
  });
  pushRule(
    "5. 最新前复权价与不复权价一致",
    "最新交易日前复权系数应接近 1，偏差 > 0.5% 提示复权错位",
    h => (h === 0 ? "pass" : (h / totalUniq <= 0.005 ? "mid" : "hot")),
    r5.hits,
    r5.samples
  );

  // 6. market cap formula
  const r6 = scanCheck(r => {
    const u = Number(r.unadj_close);
    const s = Number(r.total_shares);
    const mc = Number(r.total_market_cap);
    if (!(u > 0) || !(s > 0) || !(mc > 0)) return null;
    const rel = Math.abs(u * s - mc) / mc;
    if (rel > 0.02) return `Δ${(rel * 100).toFixed(1)}%`;
    return null;
  });
  pushRule(
    "6. 总市值口径一致性 (现价×股本)",
    "|不复权价×总股本 − 总市值| / 总市值 ≤ 2%",
    h => (h === 0 ? "pass" : (h / totalUniq <= 0.01 ? "mid" : "hot")),
    r6.hits,
    r6.samples
  );

  // 7. dividend yield consistency
  const r7 = scanCheck(r => {
    const dps = Number(r.dps_ttm);
    const u = Number(r.unadj_close);
    const dy = Number(r.div_yield_ttm);
    if (!(dps > 0) || !(u > 0) || !Number.isFinite(dy)) return null;
    const calc = (dps / u) * 100;
    const tol = Math.max(0.05, calc * 0.03);
    if (Math.abs(calc - dy) > tol) return `${calc.toFixed(2)}vs${dy.toFixed(2)}%`;
    return null;
  });
  pushRule(
    "7. 股息率口径一致性 (分红/现价)",
    "dps_ttm > 0 时 |dps/unadj_close×100 − div_yield_ttm| ≤ max(0.05, 3%相对误差)",
    h => (h === 0 ? "pass" : (h / totalUniq <= 0.01 ? "mid" : "hot")),
    r7.hits,
    r7.samples
  );

  // 8. ROE consistency
  const r8 = scanCheck(r => {
    const np = Number(r.ttm_parent_holder_net_profit);
    const eq = Number(r.holder_equity_total);
    const roe = Number(r.roe_ttm_pct);
    if (!(eq > 0) || !Number.isFinite(np) || !Number.isFinite(roe)) return null;
    const calc = (np / eq) * 100;
    if (Math.abs(calc - roe) > 0.5) return `${calc.toFixed(1)}vs${roe.toFixed(1)}%`;
    return null;
  });
  pushRule(
    "8. TTM ROE 口径一致性",
    "holder_equity_total > 0 时 |TTM净利/权益×100 − roe_ttm_pct| ≤ 0.5%",
    h => (h / totalUniq <= 0.01 ? "pass" : (h / totalUniq <= 0.05 ? "mid" : "hot")),
    r8.hits,
    r8.samples
  );

  // 9. 5Y percentile range
  const r9 = scanCheck(r => {
    const peP = r.pe_pct_5y;
    const pbP = r.pb_pct_5y;
    if (isPresent(peP) && (peP < 0 || peP > 100)) return `PE分位:${peP.toFixed(1)}`;
    if (isPresent(pbP) && (pbP < 0 || pbP > 100)) return `PB分位:${pbP.toFixed(1)}`;
    return null;
  });
  pushRule(
    "9. 5年估值分位越界 ([0, 100])",
    "pe_pct_5y 与 pb_pct_5y 非空值均须落在 [0, 100]",
    h => (h > 0 ? "hot" : "pass"),
    r9.hits,
    r9.samples
  );

  // 10. Debt ratio bounds
  const r10 = scanCheck(r => {
    const dr = r.debt_to_assets_pct;
    if (isPresent(dr) && (dr < 0 || dr > 100)) return `${dr.toFixed(1)}%`;
    return null;
  });
  pushRule(
    "10. 资产负债率越界 (<0 或 >100%)",
    "资不抵债极少数个股允许 > 100%，排查异常负值或单位错位",
    h => (h > 0 ? "hot" : "pass"),
    r10.hits,
    r10.samples
  );

  // 11. Shares / market cap <= 0
  const r11 = scanCheck(r => {
    if (isPresent(r.total_shares) && r.total_shares <= 0) return `股本:${r.total_shares}`;
    if (isPresent(r.total_market_cap) && r.total_market_cap <= 0) return `市值:${r.total_market_cap}`;
    return null;
  });
  pushRule(
    "11. 总股本/总市值非正值",
    "non-null 总股本与总市值必须严格大于 0",
    h => (h > 0 ? "hot" : "pass"),
    r11.hits,
    r11.samples
  );

  // 12. Daily pct limit
  const r12 = scanCheck(r => {
    const p1 = Number(r.pct_chg_1d);
    if (!Number.isFinite(p1)) return null;
    const lim = nominalLimitPct(r.thscode, r.name);
    if (Math.abs(p1) > lim + 0.6) return `${p1 >= 0 ? "+" : ""}${p1.toFixed(1)}%(限${lim}%)`;
    return null;
  });
  pushRule(
    "12. 单日涨跌幅超板限",
    "按主板10%/双创20%/北交30%/ST5%校验；新股首日或复牌无涨跌幅可命中",
    h => (h === 0 ? "pass" : "mid"),
    r12.hits,
    r12.samples
  );

  // 13. Valuation extremes
  const r13 = scanCheck(r => {
    if (isPresent(r.pe_ttm) && r.pe_ttm > 1000) return `PE:${r.pe_ttm.toFixed(0)}`;
    if (isPresent(r.pb) && r.pb > 100) return `PB:${r.pb.toFixed(0)}`;
    if (isPresent(r.div_yield_ttm) && r.div_yield_ttm > 20) return `股息:${r.div_yield_ttm.toFixed(1)}%`;
    return null;
  });
  pushRule(
    "13. 估值极值排查 (PE>1000 / PB>100 / 股息>20%)",
    "微利或特别分红个股可触发极值提示，供核对异常除权/微利失真",
    h => (h === 0 ? "pass" : "mid"),
    r13.hits,
    r13.samples
  );

  // 14. Missing SW classification
  const r14 = scanCheck(r => (!isPresent(r.sw_l1_code) ? "未分类" : null));
  pushRule(
    "14. 申万行业分类缺失",
    "sw_l1_code 为空比例 ≤ 0.5% 通过，≤ 3% 警告，> 3% 异常",
    h => (h / totalUniq <= 0.005 ? "pass" : (h / totalUniq <= 0.03 ? "mid" : "hot")),
    r14.hits,
    r14.samples
  );

  return {
    scanned: rows.length,
    unique: uniqRows.length,
    maxTradeDate,
    fieldStats,
    rules,
    industry,
    unclassified
  };
}

export function buildProbeChecks({
  code,
  itemsF = [],
  itemsN = [],
  fin = null,
  sharesData = null,
  peers = null,
  overviewMaxDate = null,
  todayIso = ""
} = {}) {
  const today = /^\d{4}-\d{2}-\d{2}/.test(String(todayIso || ""))
    ? String(todayIso).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const fArr = Array.isArray(itemsF) ? itemsF : [];
  const nArr = Array.isArray(itemsN) ? itemsN : [];
  const inc = Array.isArray(fin?.income_statements) ? fin.income_statements : [];
  const bal = Array.isArray(fin?.balance_sheets) ? fin.balance_sheets : [];
  const cfs = Array.isArray(fin?.cash_flow_statements) ? fin.cash_flow_statements : [];
  const adjEvs = Array.isArray(fin?.adjustment_events) ? fin.adjustment_events : [];
  const sym = fin?.symbol || {};
  const shItems = Array.isArray(sharesData?.items) ? sharesData.items : (Array.isArray(sharesData) ? sharesData : []);

  const checks = [];
  const add = (group, dim, level, obs, desc) => checks.push({ group, dim, level, obs, desc });

  // === Group 1: 行情 (7 checks) ===
  const gK = "行情";
  let ascOk = fArr.length > 0;
  let dupDates = 0;
  for (let i = 1; i < fArr.length; i++) {
    if (fArr[i].date === fArr[i - 1].date) { ascOk = false; dupDates++; }
    else if (fArr[i].date < fArr[i - 1].date) ascOk = false;
  }
  add(
    gK,
    "1. K线日期严格升序无重复",
    fArr.length === 0 ? "hot" : (ascOk ? "pass" : "hot"),
    fArr.length ? `${fArr.length} 根 (${fArr[0]?.date || "--"} → ${fArr[fArr.length - 1]?.date || "--"}) · 重复${dupDates}` : "前复权 K 线为空",
    "校验日K线按 date 严格递增且无重复交易日"
  );

  let ohlcBad = 0;
  for (const it of fArr) {
    const { open: o, high: h, low: l, close: c, volume: v, turnover: t } = it || {};
    if (o == null || h == null || l == null || c == null) { ohlcBad++; continue; }
    if (!(h >= l && l <= Math.min(o, c) + 1e-6 && h >= Math.max(o, c) - 1e-6)) { ohlcBad++; continue; }
    if ((v != null && v < 0) || (t != null && t < 0)) ohlcBad++;
  }
  add(
    gK,
    "2. OHLC 包络与量能非负",
    fArr.length === 0 ? "hot" : (ohlcBad === 0 ? "pass" : "hot"),
    fArr.length ? (ohlcBad === 0 ? `全量 ${fArr.length} 根 OHLC 与成交量/额正常` : `异常 ${ohlcBad} 根`) : "无 K 线样本",
    "要求 low ≤ min(open,close) ≤ max(open,close) ≤ high 且 volume/turnover ≥ 0"
  );

  const lastF = fArr[fArr.length - 1];
  const lastN = nArr[nArr.length - 1];
  let closeAlignLvl = "hot";
  let closeAlignObs = "前复权或不复权最新 K 线缺失";
  if (lastF && lastN && lastF.close > 0 && lastN.close > 0) {
    const sameDt = lastF.date === lastN.date;
    const rel = Math.abs(lastF.close - lastN.close) / lastN.close;
    closeAlignLvl = sameDt && rel <= 0.005 ? "pass" : (sameDt ? "mid" : "hot");
    closeAlignObs = `前复权=${fmtNum(lastF.close)} (${lastF.date}) | 不复权=${fmtNum(lastN.close)} (${lastN.date}) · 偏差 ${(rel * 100).toFixed(2)}%`;
  }
  add(gK, "3. 前复权 vs 不复权最新收盘一致", closeAlignLvl, closeAlignObs, "最新交易日前复权收盘应等于不复权收盘 (偏差 ≤ 0.5%)");

  let alignDiff = 0;
  let datesEq = false;
  if (fArr.length && nArr.length) {
    const fSet = new Set(fArr.map(x => x.date));
    const nSet = new Set(nArr.map(x => x.date));
    for (const d of fSet) if (!nSet.has(d)) alignDiff++;
    for (const d of nSet) if (!fSet.has(d)) alignDiff++;
    datesEq = alignDiff === 0 && fArr.length === nArr.length;
  }
  add(
    gK,
    "4. 两口径交易日完全对齐",
    !fArr.length || !nArr.length ? "hot" : (datesEq ? "pass" : "mid"),
    fArr.length && nArr.length ? `前复权 ${fArr.length} 根 vs 不复权 ${nArr.length} 根 · 差异 ${alignDiff} 日` : "缺少对比序列",
    "要求 forward 与 none 返回完全一致的交易日集合"
  );

  let maxGap = 0;
  let maxGapAt = "";
  for (let i = 1; i < fArr.length; i++) {
    const g = daysBetweenDates(fArr[i - 1].date, fArr[i].date);
    if (Number.isFinite(g) && g > maxGap) {
      maxGap = g;
      maxGapAt = `${fArr[i - 1].date}~${fArr[i].date}`;
    }
  }
  add(
    gK,
    "5. 停牌/缺失最大日期间隔",
    fArr.length < 2 ? "fail" : (maxGap <= 15 ? "pass" : (maxGap <= 60 ? "mid" : "hot")),
    fArr.length >= 2 ? `最大间隔 ${maxGap} 天 (${maxGapAt})` : "样本不足 2 根",
    "考虑春节/国庆长假，≤ 15 天正常，16–60 天长期停牌警告，> 60 天异常"
  );

  const lim = nominalLimitPct(code, sym.name);
  const startIdx = fArr.length < 260 ? 6 : 1;
  let limHits = 0;
  let maxPctAbs = 0;
  let maxPctStr = "--";
  for (let i = startIdx; i < fArr.length; i++) {
    const p0 = Number(fArr[i - 1].close);
    const p1 = Number(fArr[i].close);
    if (!(p0 > 0) || !(p1 > 0)) continue;
    const pct = ((p1 / p0) - 1) * 100;
    if (Math.abs(pct) > maxPctAbs) {
      maxPctAbs = Math.abs(pct);
      maxPctStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (${fArr[i].date})`;
    }
    if (Math.abs(pct) > lim + 0.6) limHits++;
  }
  add(
    gK,
    "6. 涨跌幅名义限制校验",
    fArr.length <= startIdx ? "fail" : (limHits === 0 ? "pass" : "mid"),
    fArr.length > startIdx ? `超 ${lim}% 限制 ${limHits} 次 · 最大波动 ${maxPctStr}` : "有效 K 线不足",
    `按板块名义涨跌幅限制 ±${lim}% 核验前复权日收益`
  );

  const lastDate = lastF?.date || lastN?.date || "";
  let kFreshLvl = "hot";
  let kFreshObs = "无最新交易日";
  if (lastDate) {
    if (overviewMaxDate && /^\d{4}-\d{2}-\d{2}/.test(String(overviewMaxDate))) {
      const ovDt = String(overviewMaxDate).slice(0, 10);
      const diff = daysBetweenDates(lastDate, ovDt);
      kFreshLvl = diff <= 0 ? "pass" : (diff <= 10 ? "mid" : "hot");
      kFreshObs = `个股最新 ${lastDate} vs 全库最新 ${ovDt}（差 ${diff} 天）`;
    } else {
      const age = ageDaysOf(lastDate, today);
      kFreshLvl = age !== null && age <= 4 ? "pass" : (age !== null && age <= 10 ? "mid" : "hot");
      kFreshObs = `个股最新 ${lastDate}（距今 ${age ?? "--"} 天）`;
    }
  }
  add(gK, "7. 个股行情新鲜度 vs 全库最新日", kFreshLvl, kFreshObs, "与全库日线 max_date 对齐或距今 ≤ 4 天为通过");

  // === Group 2: 复权与分红 (4 checks) ===
  const gA = "复权与分红";
  let evAsc = adjEvs.length > 0;
  let evBadVal = 0;
  for (let i = 0; i < adjEvs.length; i++) {
    const e = adjEvs[i];
    if (i > 0 && String(e.ex_date || "") < String(adjEvs[i - 1].ex_date || "")) evAsc = false;
    if ((Number(e.dividend_per_share) || 0) < 0 || (Number(e.per_share_bonus) || 0) < 0) evBadVal++;
  }
  add(
    gA,
    "8. 除权除息事件序列合法性",
    adjEvs.length === 0 ? "mid" : (evAsc && evBadVal === 0 ? "pass" : "hot"),
    adjEvs.length ? `共 ${adjEvs.length} 条 (${adjEvs[0]?.ex_date || "--"} ~ ${adjEvs[adjEvs.length - 1]?.ex_date || "--"}) · 负值 ${evBadVal}` : "无分红送转记录",
    "事件须按 ex_date 升序排列且每股分红/送转比例非负"
  );

  const firstBarDt = fArr[0]?.date || "";
  const winEvs = firstBarDt ? adjEvs.filter(e => String(e.ex_date || "").slice(0, 10) >= firstBarDt && String(e.ex_date || "").slice(0, 10) <= lastDate) : [];
  let evChecked = 0;
  let evJumped = 0;
  if (fArr.length >= 2 && winEvs.length > 0) {
    for (const e of winEvs) {
      const exD = String(e.ex_date).slice(0, 10);
      const idx = fArr.findIndex(b => b.date >= exD);
      if (idx > 0) {
        evChecked++;
        const f0 = Number(fArr[idx - 1].factor);
        const f1 = Number(fArr[idx].factor);
        if (f0 > 0 && f1 > 0 && Math.abs(f1 / f0 - 1) > 1e-5) evJumped++;
      }
    }
  }
  add(
    gA,
    "9. 除权日复权因子跳变一致",
    evChecked === 0 ? "fail" : (evJumped === evChecked ? "pass" : (evJumped > 0 ? "mid" : "hot")),
    evChecked ? `窗内 ${evChecked} 次除权事件，复权因子正确跳变 ${evJumped} 次` : "当前 K 线区间内无除权事件",
    "每个除权除息日对应的 K 线复权因子须发生 > 1e-5 跳变"
  );

  const snapDps = sym.dps_ttm != null && sym.dps_ttm !== "" ? Number(sym.dps_ttm) : null;
  const exTtm = lastDate && adjEvs.length ? extractExDividendFromEvents(adjEvs, lastDate) : null;
  let dpsLvl = "fail";
  let dpsObs = "缺少除息或快照 dps_ttm 字段";
  if (exTtm && snapDps !== null && Number.isFinite(snapDps)) {
    const calc = exTtm.dpsTtm;
    if (calc <= 0.001 && snapDps <= 0.001) {
      dpsLvl = "pass";
      dpsObs = "近12月均无现金分红 (¥0.000)";
    } else {
      const denom = Math.max(0.01, Math.abs(snapDps));
      const rel = Math.abs(calc - snapDps) / denom;
      dpsLvl = rel <= 0.03 ? "pass" : (rel <= 0.15 ? "mid" : "hot");
      dpsObs = `事件复算 ¥${calc.toFixed(3)} vs 快照 ¥${snapDps.toFixed(3)} (偏差 ${(rel * 100).toFixed(1)}%)`;
    }
  } else if (exTtm) {
    dpsLvl = "mid";
    dpsObs = `事件复算 ¥${exTtm.dpsTtm.toFixed(3)} · 快照未提供 dps_ttm`;
  }
  add(gA, "10. TTM 每股分红事件复算", dpsLvl, dpsObs, "近12个月除息折算每股分红与 symbol.dps_ttm 偏差 ≤ 3%");

  const snapDy = sym.div_yield_ttm != null && sym.div_yield_ttm !== "" ? Number(sym.div_yield_ttm) : null;
  const snapPx = sym.unadj_close != null && Number(sym.unadj_close) > 0 ? Number(sym.unadj_close) : (lastN?.close > 0 ? Number(lastN.close) : null);
  let dyLvl = "fail";
  let dyObs = "缺少股息率或价格基数";
  if (snapDps !== null && snapDy !== null && snapPx > 0) {
    const calcDy = (snapDps / snapPx) * 100;
    const diff = Math.abs(calcDy - snapDy);
    dyLvl = diff <= 0.05 ? "pass" : "mid";
    dyObs = `复算 ${calcDy.toFixed(2)}% vs 快照 ${snapDy.toFixed(2)}% (Δ${diff.toFixed(2)}%)`;
  }
  add(gA, "11. 股息率 = TTM分红 / 不复权价", dyLvl, dyObs, "要求 |dps_ttm / unadj_close × 100 − div_yield_ttm| ≤ 0.05%");

  // === Group 3: 三大财报 (8 checks) ===
  const gF = "三大财报";
  let qGaps = 0;
  for (let i = 1; i < inc.length; i++) {
    const qCur = quarterIndex(inc[i - 1].fiscal_year, inc[i - 1].fiscal_period);
    const qPrev = quarterIndex(inc[i].fiscal_year, inc[i].fiscal_period);
    if (qCur && qPrev && qCur - qPrev > 1) qGaps++;
  }
  add(
    gF,
    "12. 财报报告期连续性 (无跳期)",
    inc.length < 2 ? "hot" : (qGaps === 0 ? "pass" : "mid"),
    inc.length ? `近 ${inc.length} 期 (${inc[inc.length - 1]?.fiscal_year}${inc[inc.length - 1]?.fiscal_period} → ${inc[0]?.fiscal_year}${inc[0]?.fiscal_period}) · 跳期 ${qGaps} 次` : "利润表为空",
    "按季度索引检验连续报告期是否出现中间缺期"
  );

  const keySlice = arr => arr.slice(0, 8).map(r => `${r.fiscal_year}-${r.fiscal_period}`).sort().join("|");
  const triAligned = inc.length > 0 && bal.length > 0 && cfs.length > 0 && keySlice(inc) === keySlice(bal) && keySlice(bal) === keySlice(cfs);
  add(
    gF,
    "13. 三大报表报告期严格对齐",
    !inc.length || !bal.length || !cfs.length ? "hot" : (triAligned ? "pass" : "mid"),
    `最近 ${Math.min(8, Math.max(inc.length, bal.length, cfs.length))} 期键集合${triAligned ? "完全一致" : `存在错位 (利${inc.length}/资${bal.length}/现${cfs.length})`}`,
    "利润表、资产负债表、现金流量表近8期季度键须一一对应"
  );

  let repBad = 0;
  for (const r of inc) {
    const pe = String(r.period_end || "").slice(0, 10);
    const rd = String(r.report_date || "").slice(0, 10);
    const erd = String(r.effective_report_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pe) || !/^\d{4}-\d{2}-\d{2}$/.test(rd) || !/^\d{4}-\d{2}-\d{2}$/.test(erd)) { repBad++; continue; }
    const lag = daysBetweenDates(pe, rd);
    if (lag < 0 || lag > 200) repBad++;
  }
  add(
    gF,
    "14. 披露日期合规性与滞后天数",
    inc.length === 0 ? "hot" : (repBad === 0 ? "pass" : "mid"),
    inc.length ? `检验 ${inc.length} 期 · 日期合规违规 ${repBad} 期` : "无利润表记录",
    "要求 report_date ≥ period_end、滞后 ≤ 200 天且 PIT effective_report_date 非空"
  );

  const checkYtdIdentity = (rows, ytdField, qField, ytdField2, qField2) => {
    const byY = new Map();
    for (const r of rows) {
      const y = Number(r.fiscal_year);
      const fp = String(r.fiscal_period || "").toUpperCase();
      if (!byY.has(y)) byY.set(y, {});
      byY.get(y)[fp] = r;
    }
    let yearsOk = 0;
    let yearsTotal = 0;
    for (const qMap of byY.values()) {
      if (qMap.Q1 && qMap.Q2 && qMap.Q3 && qMap.Q4) {
        yearsTotal++;
        const sum1 = [qMap.Q1, qMap.Q2, qMap.Q3, qMap.Q4].reduce((s, r) => s + (Number(r[qField]) || 0), 0);
        const ytd1 = Number(qMap.Q4[ytdField]);
        const ok1 = Number.isFinite(ytd1) && Math.abs(sum1 - ytd1) <= Math.max(1e6, Math.abs(ytd1) * 0.01);
        let ok2 = true;
        if (ytdField2 && qField2) {
          const sum2 = [qMap.Q1, qMap.Q2, qMap.Q3, qMap.Q4].reduce((s, r) => s + (Number(r[qField2]) || 0), 0);
          const ytd2 = Number(qMap.Q4[ytdField2]);
          ok2 = Number.isFinite(ytd2) && Math.abs(sum2 - ytd2) <= Math.max(1e6, Math.abs(ytd2) * 0.01);
        }
        if (ok1 && ok2) yearsOk++;
      }
    }
    return { yearsTotal, yearsOk };
  };

  const incId = checkYtdIdentity(inc, "operating_income", "q_operating_income", "parent_holder_net_profit", "q_parent_holder_net_profit");
  add(
    gF,
    "15. 利润表 YTD 与单季拆分恒等式",
    incId.yearsTotal === 0 ? "fail" : (incId.yearsOk === incId.yearsTotal ? "pass" : "hot"),
    incId.yearsTotal ? `${incId.yearsOk} / ${incId.yearsTotal} 个完整财年 Q1~Q4 单季之和 = Q4 累计` : "近12期内无完整4季度财年样本",
    "同一财年 Σ(Q1..Q4 单季营收/归母净利) 须等于 Q4 年报累计 (误差 ≤ max(100万, 1%))"
  );

  const cfsId = checkYtdIdentity(cfs, "act_cash_flow_net", "q_act_cash_flow_net");
  add(
    gF,
    "16. 现金流量表 YTD 与单季恒等式",
    cfsId.yearsTotal === 0 ? "fail" : (cfsId.yearsOk === cfsId.yearsTotal ? "pass" : "hot"),
    cfsId.yearsTotal ? `${cfsId.yearsOk} / ${cfsId.yearsTotal} 个完整财年单季 OCF 之和 = Q4 累计` : "近12期内无完整4季度现金流样本",
    "同一财年 Σ(Q1..Q4 q_act_cash_flow_net) 须等于 Q4 act_cash_flow_net"
  );

  let balCheckN = 0;
  let balErr = 0;
  for (const r of bal.slice(0, 8)) {
    const a = Number(r.assets_total);
    const d = Number(r.total_debt);
    const e = Number(r.holder_equity_total);
    if (a > 0 && Number.isFinite(d) && Number.isFinite(e)) {
      balCheckN++;
      if (Math.abs(a - (d + e)) / a > 0.01) balErr++;
    }
  }
  add(
    gF,
    "17. 资产负债表恒等式 (资产≈负债+权益)",
    balCheckN === 0 ? "hot" : (balErr === 0 ? "pass" : "hot"),
    balCheckN ? `核验 ${balCheckN} 期 · 恒等式超差 ${balErr} 期` : "缺少总资产/负债/权益字段",
    "要求 |assets_total − (total_debt + holder_equity_total)| / assets_total ≤ 1%"
  );

  let drCheckN = 0;
  let drErr = 0;
  for (const r of bal.slice(0, 8)) {
    const a = Number(r.assets_total);
    const d = Number(r.total_debt);
    const dr = Number(r.debt_to_assets_pct);
    if (a > 0 && Number.isFinite(d) && Number.isFinite(dr)) {
      drCheckN++;
      if (Math.abs((d / a) * 100 - dr) > 0.05) drErr++;
    }
  }
  add(
    gF,
    "18. 资产负债率衍生字段核验",
    drCheckN === 0 ? "hot" : (drErr === 0 ? "pass" : "mid"),
    drCheckN ? `核验 ${drCheckN} 期 · 最新 ${fmtPct(bal[0]?.debt_to_assets_pct, 2, false)} · 偏差 ${drErr} 期` : "缺少负债率衍生字段",
    "检验 debt_to_assets_pct ≈ total_debt / assets_total × 100 (≤ 0.05%)"
  );

  const nullChecks = [
    { arr: inc.slice(0, 4), label: "利润", fields: ["operating_income", "parent_holder_net_profit", "basic_eps"] },
    { arr: bal.slice(0, 4), label: "资产", fields: ["assets_total", "total_debt", "holder_equity_total", "cash"] },
    { arr: cfs.slice(0, 4), label: "现金流", fields: ["act_cash_flow_net", "pay_fixed_assets_etc_cash"] }
  ];
  let totalSlots = 0;
  let nullSlots = 0;
  const nullFields = [];
  for (const g of nullChecks) {
    for (const f of g.fields) {
      let misses = 0;
      for (const r of g.arr) {
        totalSlots++;
        if (!isPresent(r?.[f])) { nullSlots++; misses++; }
      }
      if (misses > 0) nullFields.push(`${f}(${misses})`);
    }
  }
  const nullPct = totalSlots > 0 ? (nullSlots / totalSlots) * 100 : 100;
  add(
    gF,
    "19. 近4期核心财报字段空值率",
    totalSlots === 0 ? "hot" : (nullSlots === 0 ? "pass" : (nullPct <= 10 ? "mid" : "hot")),
    totalSlots ? `空值 ${nullSlots}/${totalSlots} (${nullPct.toFixed(1)}%)${nullFields.length ? " · " + nullFields.slice(0, 4).join(", ") : ""}` : "无财报数据",
    "检验近4期9个核心字段缺失情况（0% 通过，≤10% 警告）"
  );

  // === Group 4: 股本·估值·行业 (10 checks) ===
  const gV = "股本·估值·行业";
  let shDescOk = shItems.length > 0;
  let shBadVal = 0;
  for (let i = 0; i < shItems.length; i++) {
    const it = shItems[i];
    if (i > 0 && String(it.change_date || "") > String(shItems[i - 1].change_date || "")) shDescOk = false;
    if (!(Number(it.total_shares) > 0)) shBadVal++;
    if (it.float_shares != null && Number(it.total_shares) > 0 && Number(it.float_shares) > Number(it.total_shares) * 1.001) shBadVal++;
  }
  const latestSh = shItems[0];
  add(
    gV,
    "20. 历史股本变动序列合法性",
    shItems.length === 0 ? "hot" : (shDescOk && shBadVal === 0 ? "pass" : "hot"),
    shItems.length ? `${shItems.length} 条 · 最新 ${latestSh?.change_date || "--"} ${(Number(latestSh?.total_shares) / 1e8).toFixed(2)}亿股 (${latestSh?.change_reason || "--"})` : "未返回股本记录",
    "校验股本按 change_date 降序、total_shares > 0 且流通股 ≤ 总股本"
  );

  const symShares = Number(sym.total_shares);
  const shLatestNum = Number(latestSh?.total_shares);
  let shMatchLvl = "fail";
  let shMatchObs = "缺少股本表或快照 total_shares";
  if (symShares > 0 && shLatestNum > 0) {
    const rel = Math.abs(symShares - shLatestNum) / shLatestNum;
    shMatchLvl = rel <= 0.01 ? "pass" : (rel <= 0.05 ? "mid" : "hot");
    shMatchObs = `股本表 ${(shLatestNum / 1e8).toFixed(2)}亿 vs 快照 ${(symShares / 1e8).toFixed(2)}亿 (Δ${(rel * 100).toFixed(2)}%)`;
  }
  add(gV, "21. 最新股本表 vs 估值快照股本", shMatchLvl, shMatchObs, "share_capital 最新总股本与 symbol.total_shares 偏差 ≤ 1%");

  const refShares = shLatestNum > 0 ? shLatestNum : (symShares > 0 ? symShares : 0);
  const latInc = inc[0];
  const epsNum = Number(latInc?.basic_eps);
  const npNum = Number(latInc?.parent_holder_net_profit);
  let epsShLvl = "fail";
  let epsShObs = "EPS 过小或缺少利润表，跳过反推校验";
  if (refShares > 0 && Number.isFinite(epsNum) && Math.abs(epsNum) >= 0.05 && Number.isFinite(npNum) && npNum * epsNum > 0) {
    const impliedSh = npNum / epsNum;
    const rel = Math.abs(impliedSh - refShares) / refShares;
    epsShLvl = rel <= 0.10 ? "pass" : (rel <= 0.25 ? "mid" : "hot");
    epsShObs = `EPS隐含 ${(impliedSh / 1e8).toFixed(2)}亿 vs 权威 ${(refShares / 1e8).toFixed(2)}亿 (Δ${(rel * 100).toFixed(1)}%)`;
  }
  add(gV, "22. 财报 EPS 隐含股本交叉验证", epsShLvl, epsShObs, "净利/EPS（含加权股本与永续债差异）与总股本偏差 ≤ 10% 通过");

  const symMktCap = Number(sym.total_market_cap);
  const symUnadj = Number(sym.unadj_close);
  let mcLvl = "fail";
  let mcObs = "缺少快照总市值或股价/股本";
  if (symMktCap > 0 && symUnadj > 0 && symShares > 0) {
    const calcMc = symUnadj * symShares;
    const rel = Math.abs(calcMc - symMktCap) / symMktCap;
    mcLvl = rel <= 0.01 ? "pass" : (rel <= 0.05 ? "mid" : "hot");
    mcObs = `计算 ${fmtMoneyShort(calcMc)} vs 快照 ${fmtMoneyShort(symMktCap)} (Δ${(rel * 100).toFixed(2)}%)`;
  }
  add(gV, "23. 总市值 = 不复权价 × 总股本", mcLvl, mcObs, "验证 symbol.total_market_cap 与 unadj_close × total_shares 口径一致");

  const symTd = String(sym.trade_date || "").slice(0, 10);
  let pxAlignLvl = "fail";
  let pxAlignObs = "缺少快照或 K 线不复权收盘价";
  if (symUnadj > 0 && lastN?.close > 0) {
    const diff = Math.abs(symUnadj - lastN.close);
    const sameD = symTd === lastN.date;
    pxAlignLvl = sameD && diff <= 0.01 ? "pass" : "mid";
    pxAlignObs = `快照 ¥${fmtNum(symUnadj)} (${symTd || "--"}) vs K线 ¥${fmtNum(lastN.close)} (${lastN.date})`;
  }
  add(gV, "24. 快照不复权价与 K 线对齐", pxAlignLvl, pxAlignObs, "symbol.trade_date 须等于最新不复权 K 线日期且收盘价差 ≤ ¥0.01");

  // Compute TTM net profit from latest 4 consecutive single quarters (or Q4 if 0..3 unavailable)
  let ttmNp = null;
  if (inc.length >= 4) {
    let ok = true;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      if (k > 0) {
        const qPrev = quarterIndex(inc[k - 1].fiscal_year, inc[k - 1].fiscal_period);
        const qCur = quarterIndex(inc[k].fiscal_year, inc[k].fiscal_period);
        if (qPrev - qCur !== 1) ok = false;
      }
      const qv = Number(inc[k].q_parent_holder_net_profit);
      if (!Number.isFinite(qv)) ok = false;
      else sum += qv;
    }
    if (ok) ttmNp = sum;
  }
  if (ttmNp === null) {
    const q4 = inc.find(r => String(r.fiscal_period || "").toUpperCase() === "Q4" && r.parent_holder_net_profit != null);
    if (q4) ttmNp = Number(q4.parent_holder_net_profit);
  }
  const symPe = sym.pe_ttm != null && sym.pe_ttm !== "" ? Number(sym.pe_ttm) : null;
  let peLvl = "fail";
  let peObs = "无法复算 PE_TTM";
  if (ttmNp !== null && symMktCap > 0) {
    if (ttmNp <= 0) {
      peLvl = symPe === null || symPe <= 0 ? "pass" : "mid";
      peObs = `TTM 归母净利为负 (${fmtMoneyShort(ttmNp)}) · 快照 PE=${symPe ?? "null"}`;
    } else if (symPe !== null && symPe > 0) {
      const calcPe = symMktCap / ttmNp;
      const rel = Math.abs(calcPe - symPe) / symPe;
      peLvl = rel <= 0.05 ? "pass" : (rel <= 0.15 ? "mid" : "hot");
      peObs = `财报复算 ${fmtNum(calcPe, 2)}x vs 快照 ${fmtNum(symPe, 2)}x (Δ${(rel * 100).toFixed(1)}%)`;
    }
  }
  add(gV, "25. PE_TTM 财报 TTM 净利复算", peLvl, peObs, "以总市值 / 近4季单季净利复算，核对 symbol.pe_ttm (≤ 5%)");

  const latEq = bal[0]?.holder_equity_total != null ? Number(bal[0].holder_equity_total) : null;
  const symPb = sym.pb != null && sym.pb !== "" ? Number(sym.pb) : null;
  let pbLvl = "fail";
  let pbObs = "无法复算 PB";
  if (latEq > 0 && symMktCap > 0 && symPb > 0) {
    const calcPb = symMktCap / latEq;
    const rel = Math.abs(calcPb - symPb) / symPb;
    pbLvl = rel <= 0.08 ? "pass" : (rel <= 0.20 ? "mid" : "hot");
    pbObs = `总权益口径 ${fmtNum(calcPb, 2)}x vs 快照 ${fmtNum(symPb, 2)}x (含少数股东权益差异 ${(rel * 100).toFixed(1)}%)`;
  }
  add(gV, "26. PB 财报最新净资产复算", pbLvl, pbObs, "核对总市值/所有者权益与快照 PB (≤ 8% 通过)");

  const p5Pe = sym.pe_pct_5y;
  const p5Pb = sym.pb_pct_5y;
  const p5Bad = (isPresent(p5Pe) && (p5Pe < 0 || p5Pe > 100)) || (isPresent(p5Pb) && (p5Pb < 0 || p5Pb > 100));
  add(
    gV,
    "27. 近5年 PE/PB 历史分位边界 [0, 100]",
    p5Bad ? "hot" : (!isPresent(p5Pe) && !isPresent(p5Pb) ? "mid" : "pass"),
    `PE 5Y分位=${isPresent(p5Pe) ? p5Pe.toFixed(1) + "%" : "null"} · PB 5Y分位=${isPresent(p5Pb) ? p5Pb.toFixed(1) + "%" : "null"}`,
    "近5年分位非空值必须在 [0, 100] 区间内"
  );

  const swFilled = [sym.sw_l1_code, sym.sw_l2_code, sym.sw_l3_code].filter(isPresent).length;
  add(
    gV,
    "28. 申万一/二/三级行业归属完整",
    swFilled === 3 ? "pass" : (swFilled > 0 ? "mid" : "hot"),
    swFilled > 0 ? `${sym.sw_l1_name || "--"}(${sym.sw_l1_code || "--"}) / ${sym.sw_l2_name || "--"}(${sym.sw_l2_code || "--"}) / ${sym.sw_l3_name || "--"}(${sym.sw_l3_code || "--"})` : "申万行业分类缺失",
    "要求申万 2021 一/二/三级代码与名称全部就绪"
  );

  let peerLvl = "mid";
  let peerObs = "/peers 接口不可用或未返回";
  if (peers && peers.target) {
    const eff = peers.effective_level || "l2";
    const tgtCode = peers.target[`sw_${eff}_code`] || peers.industry_code;
    const symLvCode = sym[`sw_${eff}_code`];
    const peerItems = Array.isArray(peers.items) ? peers.items : [];
    const hasSelf = peerItems.some(it => it.thscode === code);
    const codeMatch = !symLvCode || !tgtCode || tgtCode === symLvCode;
    peerLvl = !hasSelf && codeMatch ? "pass" : "hot";
    peerObs = `生效层级 ${eff.toUpperCase()} (${peers.industry_name || "--"}) · 同行 ${peerItems.length} 家 · 自排除=${!hasSelf}`;
  }
  add(gV, "29. 同申万行业接口一致性与排重", peerLvl, peerObs, "同行 target 行业代码须与标的归属一致且默认不包含自身");

  return checks;
}

export function renderHealthAndStatus(health) {
  STATE.health = health;
  const pills = [
    { id: "rdy-market", label: "market_db", ok: Boolean(health?.market_db_exists) },
    { id: "rdy-fin", label: "financials_db", ok: Boolean(health?.financials_db_exists) },
    { id: "rdy-snap", label: "screener", ok: Boolean(health?.screener_snapshot_exists) },
    { id: "rdy-meta", label: "meta_db", ok: Boolean(health?.meta_db_exists) }
  ];

  const miniWrap = document.getElementById("mini-db-pills");
  if (miniWrap) {
    miniWrap.innerHTML = pills.map(p =>
      `<span class="mini-pill ${p.ok ? "ok" : "bad"}">${esc(p.label)} ${p.ok ? "✓" : "✕"}</span>`
    ).join("");
  }

  for (const p of pills) {
    const el = document.getElementById(p.id);
    if (el) {
      el.className = `status-pill ${p.ok ? "pill-pass" : "pill-hot"}`;
      el.textContent = p.ok ? "已就绪" : "缺失";
    }
  }

  const badge = document.getElementById("srv-badge");
  if (badge) {
    const allReady = pills.every(p => p.ok) && health?.status === "ok";
    if (allReady) {
      badge.className = "regime-badge pill-pass";
      badge.textContent = "在线 · 四库就绪";
    } else {
      badge.className = "regime-badge pill-mid";
      badge.textContent = "在线 · 部分未就绪";
    }
  }
}

export function renderOverview(ov) {
  STATE.overview = ov;
  const today = new Date().toISOString().slice(0, 10);
  const sym = Number(ov?.symbols_count || 0);
  const snap = Number(ov?.screener_snapshot_rows || 0);
  const dk = ov?.daily_kline || {};
  const fin = ov?.financials || {};
  const inc = fin.income || {};
  const bal = fin.balance || {};
  const cfs = fin.cashflow || {};
  const sc = ov?.share_capital || null;

  document.getElementById("hdr-symbols").textContent = fmtInt(sym);
  document.getElementById("hdr-latest-date").textContent = dk.max_date || "--";
  document.getElementById("hdr-snap-rows").textContent = fmtInt(snap);

  const covPct = sym > 0 ? (snap / sym) * 100 : 0;
  document.getElementById("insp-kpi1-val").textContent = `${fmtInt(sym)} 只`;
  document.getElementById("insp-kpi1-bar").style.width = `${clamp(covPct, 0, 100)}%`;
  const p1 = document.getElementById("insp-kpi1-pill");
  p1.className = `status-pill ${covPct >= 90 ? "pill-pass" : (covPct >= 70 ? "pill-mid" : "pill-hot")}`;
  p1.textContent = `快照覆盖 ${covPct.toFixed(1)}%`;
  document.getElementById("insp-kpi1-meta").textContent = `选股快照行数: ${fmtInt(snap)} 行`;

  const ageDays = ageDaysOf(dk.max_date, today);
  document.getElementById("insp-kpi2-val").textContent = `${fmtInt(dk.rows)} 行`;
  document.getElementById("insp-kpi2-bar").style.width = dk.rows > 0 ? "100%" : "0%";
  const p2 = document.getElementById("insp-kpi2-pill");
  p2.className = `status-pill ${ageDays !== null && ageDays <= 4 ? "pill-pass" : (ageDays !== null && ageDays <= 10 ? "pill-mid" : "pill-hot")}`;
  p2.textContent = ageDays !== null ? (ageDays <= 0 ? "今日最新" : `距今 ${ageDays} 天`) : "--";
  document.getElementById("insp-kpi2-meta").textContent =
    `区间: ${dk.min_date || "--"} ~ ${dk.max_date || "--"} · 复权事件 ${fmtInt(dk.adjustment_events_rows)} 条`;

  const finCards = [
    { idx: 3, obj: inc, name: "利润表" },
    { idx: 4, obj: bal, name: "资产负债表" },
    { idx: 5, obj: cfs, name: "现金流量表" }
  ];
  for (const fc of finCards) {
    const fSym = Number(fc.obj.symbols || 0);
    const fCov = sym > 0 ? (fSym / sym) * 100 : 0;
    document.getElementById(`insp-kpi${fc.idx}-val`).textContent = `${fmtInt(fc.obj.rows)} 行`;
    document.getElementById(`insp-kpi${fc.idx}-bar`).style.width = `${clamp(fCov, 0, 100)}%`;
    const pill = document.getElementById(`insp-kpi${fc.idx}-pill`);
    pill.className = `status-pill ${fCov >= 90 ? "pill-pass" : (fCov >= 70 ? "pill-mid" : "pill-fail")}`;
    pill.textContent = `${fmtInt(fSym)} 标的`;
    document.getElementById(`insp-kpi${fc.idx}-meta`).textContent =
      `报告期: ${fc.obj.min_period_end || "--"} ~ ${fc.obj.max_period_end || "--"} · 最新披露 ${fc.obj.max_report_date || "--"}`;
  }

  // 6th KPI: Share Capital
  const kpi6Val = document.getElementById("insp-kpi6-val");
  if (kpi6Val) {
    const kpi6Bar = document.getElementById("insp-kpi6-bar");
    const kpi6Pill = document.getElementById("insp-kpi6-pill");
    const kpi6Meta = document.getElementById("insp-kpi6-meta");
    if (sc) {
      const scSym = Number(sc.symbols || 0);
      const scCov = sym > 0 ? (scSym / sym) * 100 : 0;
      kpi6Val.textContent = `${fmtInt(sc.rows)} 行`;
      kpi6Bar.style.width = `${clamp(scCov, 0, 100)}%`;
      kpi6Pill.className = `status-pill ${scCov >= 95 ? "pill-pass" : (scCov >= 85 ? "pill-mid" : "pill-fail")}`;
      kpi6Pill.textContent = `${fmtInt(scSym)} 标的`;
      kpi6Meta.textContent = `变动区间: ${sc.min_change_date || "--"} ~ ${sc.max_change_date || "--"}`;
    } else {
      kpi6Val.textContent = "--";
      kpi6Bar.style.width = "0%";
      kpi6Pill.className = "status-pill pill-fail";
      kpi6Pill.textContent = "未返回";
      kpi6Meta.textContent = "/api/overview 未返回 share_capital";
    }
  }

  // 15-Rule Audit Table
  const audits = buildOverviewAudits(STATE.health, ov, today);
  STATE.overviewAudits = audits;
  document.getElementById("audit-tbody").innerHTML = audits.map(a => `
    <tr>
      <td class="left"><strong>${esc(a.name)}</strong></td>
      <td class="center"><span class="status-pill pill-${a.level}">${esc(a.badge)}</span></td>
      <td class="left mono" style="white-space:normal;">${esc(a.obs)}</td>
      <td class="left" style="white-space:normal;color:var(--ink-muted);">${esc(a.rule)}</td>
    </tr>
  `).join("");

  const auditSumEl = document.getElementById("audit-summary");
  if (auditSumEl) {
    const cnt = { pass: 0, mid: 0, hot: 0, fail: 0 };
    for (const a of audits) cnt[a.level] = (cnt[a.level] || 0) + 1;
    const rate = audits.length ? Math.round((cnt.pass / audits.length) * 100) : 0;
    auditSumEl.innerHTML =
      `<span class="status-pill pill-pass">通过 ${cnt.pass}</span>` +
      (cnt.mid ? `<span class="status-pill pill-mid">警告 ${cnt.mid}</span>` : "") +
      (cnt.hot ? `<span class="status-pill pill-hot">异常 ${cnt.hot}</span>` : "") +
      (cnt.fail ? `<span class="status-pill pill-fail">跳过 ${cnt.fail}</span>` : "") +
      `<span class="mini-pill">${audits.length}项 · 通过率 ${rate}%</span>`;
  }

  // Watermarks (grouped + sorted + age pill)
  const wm = ov?.watermarks || {};
  const wmEntries = Object.entries(wm).sort((a, b) => {
    const ga = watermarkGroup(a[0]);
    const gb = watermarkGroup(b[0]);
    return ga !== gb ? ga.localeCompare(gb) : a[0].localeCompare(b[0]);
  });
  document.getElementById("watermarks-box").innerHTML = wmEntries.length
    ? wmEntries.map(([k, v]) => {
        const grp = watermarkGroup(k);
        const valText = typeof v === "object" && v !== null ? JSON.stringify(v, null, 2) : String(v ?? "--");
        const dStr = extractWatermarkDate(v);
        const age = dStr ? ageDaysOf(dStr, today) : null;
        const thresh = k.includes("sw_industry") ? 10 : 4;
        const agePill = age !== null
          ? `<div class="wm-age"><span class="status-pill ${age <= thresh ? "pill-pass" : (age <= thresh * 2 ? "pill-mid" : "pill-hot")}">${age <= 0 ? "今日最新" : `${age} 天前`}</span></div>`
          : "";
        return `<div class="wm-card"><div class="wm-group">${esc(grp)}</div><div class="wm-key">${esc(k)}</div><div class="wm-val">${esc(valText)}</div>${agePill}</div>`;
      }).join("")
    : `<div class="wm-card"><div class="wm-val">暂无 watermarks 记录</div></div>`;

  // Recent Runs (7 columns)
  const runs = Array.isArray(ov?.recent_runs) ? ov.recent_runs : [];
  document.getElementById("runs-tbody").innerHTML = runs.length
    ? runs.map(r => {
        const st = String(r.status || "--");
        const isBad = isBadRun(r);
        const isOk = /ok|success|done|completed/i.test(st) && !isBad;
        const badgeCls = isBad ? "pill-hot" : (isOk ? "pill-pass" : "pill-mid");
        const startStr = r.started_at ? String(r.started_at).slice(0, 16).replace("T", " ") : "--";
        const rowParts = [];
        if (r.target_date) rowParts.push(String(r.target_date).slice(0, 10));
        if (r.rows_kline != null) rowParts.push(`K线 ${fmtInt(r.rows_kline)}`);
        if (r.rows_adj_events != null) rowParts.push(`复权 ${fmtInt(r.rows_adj_events)}`);
        if (r.rows_symbols != null) rowParts.push(`标的 ${fmtInt(r.rows_symbols)}`);
        const targetInfo = rowParts.length ? rowParts.join(" · ") : "--";
        const msg = r.error_message || r.finished_at || r.updated_at || "--";
        return `
          <tr>
            <td class="left"><strong>${esc(r.job_name || "--")}</strong></td>
            <td class="center"><span class="status-pill ${badgeCls}">${esc(st)}</span></td>
            <td class="center">${esc(r.mode || "--")}</td>
            <td class="mono">${esc(startStr)}</td>
            <td class="mono">${r.duration_sec !== null && r.duration_sec !== undefined ? fmtNum(r.duration_sec, 2) : "--"}</td>
            <td class="left mono" style="white-space:normal;">${esc(targetInfo)}</td>
            <td class="left" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;" title="${esc(msg)}">${esc(msg)}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="7" class="center flat">暂无定时同步执行记录</td></tr>`;
}

export function renderSnapshotScan(res, totalExpected) {
  const kpiWrap = document.getElementById("snap-scan-kpis");
  const fieldTbody = document.getElementById("snap-field-tbody");
  const ruleTbody = document.getElementById("snap-rule-tbody");
  const indBox = document.getElementById("snap-industry-box");
  if (!res || !kpiWrap || !fieldTbody || !ruleTbody || !indBox) return;

  const total = Number(totalExpected || res.scanned || res.unique || 0);
  const uniq = res.unique || 0;
  const freshCnt = res.rules.find(r => r.name.startsWith("3."))?.hits ?? 0;
  const freshPct = uniq > 0 ? clamp(((uniq - freshCnt) / uniq) * 100, 0, 100) : 0;
  const swMiss = res.rules.find(r => r.name.startsWith("14."))?.hits ?? res.unclassified ?? 0;
  const swPct = uniq > 0 ? clamp(((uniq - swMiss) / uniq) * 100, 0, 100) : 0;
  const valFields = res.fieldStats.filter(f => f.group === "估值股本");
  const valAvgPct = valFields.length ? valFields.reduce((s, f) => s + f.pct, 0) / valFields.length : 0;

  kpiWrap.innerHTML = [
    { lbl: "扫描唯一行 / 快照总行", val: `${fmtInt(uniq)} / ${fmtInt(total)}` },
    { lbl: `行情近10日活跃 (${res.maxTradeDate || "--"})`, val: `${freshPct.toFixed(1)}%` },
    { lbl: "申万一级分类覆盖率", val: `${swPct.toFixed(1)}%` },
    { lbl: "估值股本 9 字段平均完整率", val: `${valAvgPct.toFixed(1)}%` }
  ].map(c => `<div class="snap-stat"><div class="snap-stat-lbl">${esc(c.lbl)}</div><div class="snap-stat-val">${esc(c.val)}</div></div>`).join("");

  fieldTbody.innerHTML = res.fieldStats.map(f => {
    const color = f.pct >= 95 ? "var(--emerald)" : (f.pct >= 80 ? "var(--ochre)" : "var(--crimson)");
    return `
      <tr>
        <td class="left"><span class="mini-pill">${esc(f.group)}</span></td>
        <td class="left mono"><strong>${esc(f.key)}</strong></td>
        <td class="left">
          <span class="cov-track"><span class="cov-fill" style="width:${clamp(f.pct, 0, 100).toFixed(1)}%;background:${color};"></span></span>
          <span class="mono" style="color:${color};font-weight:600;">${f.pct.toFixed(1)}%</span>
        </td>
        <td class="mono">${fmtInt(f.missing)}</td>
        <td class="left" style="white-space:normal;color:var(--ink-muted);">${esc(f.note)}</td>
      </tr>
    `;
  }).join("");

  ruleTbody.innerHTML = res.rules.map(r => {
    const samplesHtml = r.samples.length
      ? r.samples.map(s =>
          `<button type="button" class="sample-chip" data-probe-code="${esc(s.code)}" title="点击立即抽检 ${esc(s.code)}">${esc(s.code)} ${esc(s.name)} (${esc(s.val)})</button>`
        ).join("")
      : `<span class="flat">--</span>`;
    return `
      <tr>
        <td class="left"><strong>${esc(r.name)}</strong></td>
        <td class="center"><span class="status-pill pill-${r.level}">${esc(levelBadge(r.level))}</span></td>
        <td class="mono">${fmtInt(r.hits)}</td>
        <td class="left" style="white-space:normal;">${samplesHtml}</td>
        <td class="left" style="white-space:normal;color:var(--ink-muted);">${esc(r.rule)}</td>
      </tr>
    `;
  }).join("");

  ruleTbody.querySelectorAll(".sample-chip[data-probe-code]").forEach(btn => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.probeCode;
      if (!code || code === "快照") return;
      runStockProbe(code);
      document.getElementById("probe-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  const topInd = res.industry.slice(0, 15);
  const moreCnt = Math.max(0, res.industry.length - topInd.length);
  indBox.innerHTML =
    `<span class="ctrl-label">申万一级分布 (${res.industry.length}类):</span>` +
    topInd.map(it => `<span class="mini-pill">${esc(it.name)} ${fmtInt(it.count)}</span>`).join("") +
    (moreCnt > 0 ? `<span class="mini-pill">其余 ${moreCnt} 类</span>` : "") +
    `<span class="mini-pill ${res.unclassified > 0 ? "bad" : "ok"}">未分类 ${fmtInt(res.unclassified)}</span>`;
}

export async function runSnapshotScan(forceFresh = false) {
  if (SNAP.loading) return;
  const statusEl = document.getElementById("snap-scan-status");
  SNAP.loading = true;
  if (statusEl) {
    statusEl.style.color = "var(--ink-muted)";
    statusEl.textContent = "扫描中 0 / --…";
  }

  try {
    const pageLimit = 500;
    const baseParams = { sort_by: "avg_turnover_20d", sort_dir: "desc", limit: pageLimit, offset: 0 };
    const first = await quantFetch("/api/screener", baseParams, { fresh: forceFresh });
    const total = Number(first?.total || first?.items?.length || 0);
    const allRows = [...(first?.items || [])];
    if (statusEl) statusEl.textContent = `扫描中 ${fmtInt(allRows.length)} / ${fmtInt(total)}…`;

    const offsets = [];
    for (let off = pageLimit; off < total; off += pageLimit) {
      offsets.push(off);
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, offsets.length) }, async () => {
      while (cursor < offsets.length) {
        const off = offsets[cursor++];
        const res = await quantFetch("/api/screener", { ...baseParams, offset: off }, { fresh: forceFresh });
        if (Array.isArray(res?.items)) allRows.push(...res.items);
        if (statusEl) statusEl.textContent = `扫描中 ${fmtInt(allRows.length)} / ${fmtInt(total)}…`;
      }
    });
    if (workers.length) await Promise.all(workers);

    const today = new Date().toISOString().slice(0, 10);
    const audited = auditSnapshotRows(allRows, {
      dailyMaxDate: STATE.overview?.daily_kline?.max_date || null,
      todayIso: today
    });
    SNAP.result = audited;
    SNAP.loaded = true;
    renderSnapshotScan(audited, total);

    const ruleBad = audited.rules.filter(r => r.level === "hot").length;
    if (statusEl) {
      statusEl.style.color = ruleBad > 0 ? "var(--crimson)" : "var(--emerald)";
      statusEl.textContent = `已扫描 ${fmtInt(audited.unique)} 只 · 异常规则 ${ruleBad} 项`;
    }
  } catch (err) {
    if (statusEl) {
      statusEl.style.color = "var(--crimson)";
      statusEl.textContent = `扫描失败: ${err?.message || "请求异常"}`;
    }
  } finally {
    SNAP.loading = false;
  }
}

export async function runStockProbe(code) {
  const cleanCode = (code || document.getElementById("probe-code-input").value || "600519.SH").trim().toUpperCase();
  document.getElementById("probe-code-input").value = cleanCode;
  document.querySelectorAll(".probe-chip").forEach(b => b.classList.toggle("active", b.dataset.code === cleanCode));

  const tbody = document.getElementById("probe-tbody");
  const sumEl = document.getElementById("probe-summary");
  if (sumEl) sumEl.innerHTML = "";
  tbody.innerHTML = `<tr><td colspan="4" class="center flat">正在并发抽检 ${esc(cleanCode)} 的前/不复权 K 线、三大财报、历史股本与申万同行…</td></tr>`;

  try {
    const [kf, kn, fin, sharesData, peers] = await Promise.all([
      quantFetch(`/api/stocks/${encodeURIComponent(cleanCode)}/kline`, { adjust: "forward", limit: 260 }),
      quantFetch(`/api/stocks/${encodeURIComponent(cleanCode)}/kline`, { adjust: "none", limit: 260 }),
      quantFetch(`/api/stocks/${encodeURIComponent(cleanCode)}/financials`, { limit: 12 }),
      fetchSharesSafe(cleanCode, 60),
      quantFetch(`/api/stocks/${encodeURIComponent(cleanCode)}/peers`, { level: "l2", limit: 5 }).catch(() => null)
    ]);

    const itemsF = kf.items || [];
    const itemsN = kn.items || [];
    const today = new Date().toISOString().slice(0, 10);
    const checks = buildProbeChecks({
      code: cleanCode,
      itemsF,
      itemsN,
      fin,
      sharesData,
      peers,
      overviewMaxDate: STATE.overview?.daily_kline?.max_date || null,
      todayIso: today
    });
    LAST_PROBE = { code: cleanCode, checks };

    const groupOrder = ["行情", "复权与分红", "三大财报", "股本·估值·行业"];
    const rowsHtml = [];
    for (const grp of groupOrder) {
      const grpChecks = checks.filter(c => c.group === grp);
      if (!grpChecks.length) continue;
      const gPass = grpChecks.filter(c => c.level === "pass").length;
      rowsHtml.push(`<tr class="probe-group-row"><td colspan="4">${esc(grp)}（${gPass} / ${grpChecks.length} 项通过）</td></tr>`);
      for (const c of grpChecks) {
        rowsHtml.push(`
          <tr>
            <td class="left"><strong>${esc(c.dim)}</strong></td>
            <td class="center"><span class="status-pill pill-${c.level}">${esc(levelBadge(c.level))}</span></td>
            <td class="left mono" style="white-space:normal;">${esc(c.obs)}</td>
            <td class="left" style="white-space:normal;color:var(--ink-muted);">${esc(c.desc)}</td>
          </tr>
        `);
      }
    }
    tbody.innerHTML = rowsHtml.join("");

    if (sumEl) {
      const cnt = { pass: 0, mid: 0, hot: 0, fail: 0 };
      for (const c of checks) cnt[c.level] = (cnt[c.level] || 0) + 1;
      sumEl.innerHTML =
        `<span class="status-pill pill-pass">通过 ${cnt.pass}</span>` +
        (cnt.mid ? `<span class="status-pill pill-mid">警告 ${cnt.mid}</span>` : "") +
        (cnt.hot ? `<span class="status-pill pill-hot">异常 ${cnt.hot}</span>` : "") +
        (cnt.fail ? `<span class="status-pill pill-fail">跳过 ${cnt.fail}</span>` : "");
    }

    const inc = fin?.income_statements || [];
    const bal = fin?.balance_sheets || [];
    const cfs = fin?.cash_flow_statements || [];
    const adj = fin?.adjustment_events || [];
    const shItems = sharesData?.items || [];
    const snippet = {
      symbol_snapshot: fin?.symbol || kf?.symbol || null,
      latest_kline_forward_2: itemsF.slice(-2),
      latest_income_1: inc[0] || null,
      latest_balance_1: bal[0] || null,
      latest_cashflow_1: cfs[0] || null,
      latest_adjustment_events_3: adj.slice(-3),
      latest_shares_2: shItems.slice(0, 2),
      peers_summary: peers
        ? { effective_level: peers.effective_level, industry_name: peers.industry_name, count: peers.items?.length || 0 }
        : null
    };
    document.getElementById("probe-raw-json").textContent = JSON.stringify(snippet, null, 2);
  } catch (err) {
    LAST_PROBE = { code: cleanCode, checks: [] };
    tbody.innerHTML = `<tr><td colspan="4" class="center up">抽检失败: ${esc(err.message)}</td></tr>`;
    showGlobalAlert(err);
  }
}

export function exportInspectReportCsv() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const a of (STATE.overviewAudits || [])) {
    rows.push(["全库检验", a.name, a.badge, a.obs, a.rule]);
  }
  for (const r of (SNAP.result?.rules || [])) {
    const sampleTxt = r.samples.length ? ` · 样本: ${r.samples.map(s => `${s.code}(${s.val})`).join("; ")}` : "";
    rows.push(["快照扫描", r.name, levelBadge(r.level), `命中 ${r.hits}${sampleTxt}`, r.rule]);
  }
  for (const c of (LAST_PROBE.checks || [])) {
    rows.push([`个股抽检 ${LAST_PROBE.code}/${c.group}`, c.dim, levelBadge(c.level), c.obs, c.desc]);
  }
  if (!rows.length) return;
  downloadCsv(`数据检验报告_${today}.csv`, ["类别", "检验项目", "判定", "观测值", "标准说明"], rows);
}

export async function loadInspectData(forceFresh = false) {
  try {
    const [health, overview] = await Promise.all([
      quantFetch("/health", {}, { fresh: forceFresh }),
      quantFetch("/api/overview", {}, { fresh: forceFresh })
    ]);
    clearGlobalAlert();
    renderHealthAndStatus(health);
    renderOverview(overview);
    STATE.inspectLoaded = true;

    if (forceFresh || !SNAP.loaded) {
      runSnapshotScan(forceFresh);
    }

    if (!STATE.screenerLoaded && !window.__SCR_PREFETCHED__) {
      window.__SCR_PREFETCHED__ = true;
      setTimeout(() => {
        if (!STATE.screenerLoaded) {
          quantFetch("/api/screener", {
            sort_by: "avg_turnover_20d",
            sort_dir: "desc",
            limit: 50,
            offset: 0
          }).catch(() => {});
        }
      }, 150);
    }
  } catch (err) {
    showGlobalAlert(err);
    try {
      const health = await quantFetch("/health", {}, { fresh: forceFresh });
      renderHealthAndStatus(health);
    } catch {}
  }
}
