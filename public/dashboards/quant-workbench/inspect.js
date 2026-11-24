import { esc, fmtInt, fmtNum, fmtPct, fmtMoneyShort, clamp, daysBetweenIso } from "./utils.js";
import { STATE } from "./state.js";
import { quantFetch, showGlobalAlert, clearGlobalAlert } from "./api.js";

export function renderHealthAndStatus(health) {
  STATE.health = health;
  const pills = [
    { id: "rdy-market", label: "market_db", ok: Boolean(health?.market_db_exists) },
    { id: "rdy-fin", label: "financials_db", ok: Boolean(health?.financials_db_exists) },
    { id: "rdy-snap", label: "screener", ok: Boolean(health?.screener_snapshot_exists) },
    { id: "rdy-meta", label: "meta_db", ok: Boolean(health?.meta_db_exists) }
  ];

  const miniWrap = document.getElementById("mini-db-pills");
  miniWrap.innerHTML = pills.map(p =>
    `<span class="mini-pill ${p.ok ? "ok" : "bad"}">${esc(p.label)} ${p.ok ? "✓" : "✕"}</span>`
  ).join("");

  for (const p of pills) {
    const el = document.getElementById(p.id);
    if (el) {
      el.className = `status-pill ${p.ok ? "pill-pass" : "pill-hot"}`;
      el.textContent = p.ok ? "已就绪" : "缺失";
    }
  }

  const badge = document.getElementById("srv-badge");
  const allReady = pills.every(p => p.ok) && health?.status === "ok";
  if (allReady) {
    badge.className = "regime-badge pill-pass";
    badge.textContent = "在线 · 四库就绪";
  } else {
    badge.className = "regime-badge pill-mid";
    badge.textContent = "在线 · 部分未就绪";
  }
}

export function renderOverview(ov) {
  STATE.overview = ov;
  const sym = Number(ov?.symbols_count || 0);
  const snap = Number(ov?.screener_snapshot_rows || 0);
  const dk = ov?.daily_kline || {};
  const fin = ov?.financials || {};
  const inc = fin.income || {};
  const bal = fin.balance || {};
  const cfs = fin.cashflow || {};

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

  const ageDays = daysBetweenIso(dk.max_date);
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

  // 6-Rule Audit Table
  const audits = [];
  const h = STATE.health || {};
  const allDbs = h.market_db_exists && h.financials_db_exists && h.screener_snapshot_exists && h.meta_db_exists;
  audits.push({
    name: "1. 核心存储文件完整性",
    level: allDbs ? "pass" : "hot",
    badge: allDbs ? "通过" : "异常",
    obs: `market=${Boolean(h.market_db_exists)}, financials=${Boolean(h.financials_db_exists)}, screener=${Boolean(h.screener_snapshot_exists)}, meta=${Boolean(h.meta_db_exists)}`,
    rule: "要求四个库/快照文件全部存在"
  });

  audits.push({
    name: "2. 选股快照对股票目录覆盖率",
    level: covPct >= 90 ? "pass" : (covPct >= 70 ? "mid" : "hot"),
    badge: covPct >= 90 ? "通过" : (covPct >= 70 ? "警告" : "偏低"),
    obs: `${fmtInt(snap)} / ${fmtInt(sym)}（${covPct.toFixed(1)}%）`,
    rule: "≥ 90% 为通过，70%–90% 提示部分停牌/新股缺失，< 70% 需核查"
  });

  audits.push({
    name: "3. 日线行情新鲜度",
    level: ageDays !== null && ageDays <= 4 ? "pass" : (ageDays !== null && ageDays <= 10 ? "mid" : "hot"),
    badge: ageDays !== null && ageDays <= 4 ? "通过" : (ageDays !== null && ageDays <= 10 ? "滞后" : "陈旧"),
    obs: `最新交易日 ${dk.max_date || "--"}（距今 ${ageDays !== null ? ageDays : "--"} 天）`,
    rule: "考虑周末与节假日，≤ 4 天正常，5–10 天警告，> 10 天异常"
  });

  const pEnds = [inc.max_period_end, bal.max_period_end, cfs.max_period_end].filter(Boolean);
  const pAligned = pEnds.length === 3 && pEnds[0] === pEnds[1] && pEnds[1] === pEnds[2];
  const symSpread = Math.max(inc.symbols || 0, bal.symbols || 0, cfs.symbols || 0) - Math.min(inc.symbols || 0, bal.symbols || 0, cfs.symbols || 0);
  audits.push({
    name: "4. 三大财报报告期与标的对齐度",
    level: pAligned && symSpread <= 50 ? "pass" : (pAligned ? "mid" : "hot"),
    badge: pAligned && symSpread <= 50 ? "对齐" : (pAligned ? "微差" : "不一致"),
    obs: `期末(${inc.max_period_end || "--"} / ${bal.max_period_end || "--"} / ${cfs.max_period_end || "--"}) · 标的数量(${inc.symbols || 0} / ${bal.symbols || 0} / ${cfs.symbols || 0})`,
    rule: "要求三大报表 max_period_end 一致且覆盖标的数接近"
  });

  const adjRows = Number(dk.adjustment_events_rows || 0);
  audits.push({
    name: "5. 除权除息复权事件表",
    level: adjRows > 0 ? "pass" : "hot",
    badge: adjRows > 0 ? "通过" : "为空",
    obs: `${fmtInt(adjRows)} 条复权事件`,
    rule: "前/后复权计算依赖复权事件表非空"
  });

  const runs = Array.isArray(ov?.recent_runs) ? ov.recent_runs : [];
  const failedRuns = runs.filter(r => /fail|error|err/i.test(String(r.status || "")) || Boolean(r.error_message));
  const latestRun = runs[0];
  const latestOk = latestRun ? !(/fail|error|err/i.test(String(latestRun.status || "")) || Boolean(latestRun.error_message)) : false;
  audits.push({
    name: "6. 最近定时同步任务健康度",
    level: runs.length === 0 ? "mid" : (latestOk && failedRuns.length === 0 ? "pass" : (latestOk ? "mid" : "hot")),
    badge: runs.length === 0 ? "无记录" : (latestOk && failedRuns.length === 0 ? "全绿" : (latestOk ? "含历史异常" : "最新失败")),
    obs: latestRun ? `最新任务 ${latestRun.job_name || "--"} (${latestRun.status || "--"}) · 近10次异常 ${failedRuns.length} 次` : "暂无 sync_runs 记录",
    rule: "最近 1 次须成功且近 10 次无未恢复报错"
  });

  document.getElementById("audit-tbody").innerHTML = audits.map(a => `
    <tr>
      <td class="left"><strong>${esc(a.name)}</strong></td>
      <td class="center"><span class="status-pill pill-${a.level}">${esc(a.badge)}</span></td>
      <td class="left mono" style="white-space:normal;">${esc(a.obs)}</td>
      <td class="left" style="white-space:normal;color:var(--ink-muted);">${esc(a.rule)}</td>
    </tr>
  `).join("");

  // Watermarks
  const wm = ov?.watermarks || {};
  const wmEntries = Object.entries(wm);
  document.getElementById("watermarks-box").innerHTML = wmEntries.length
    ? wmEntries.map(([k, v]) => {
        const valText = typeof v === "object" && v !== null ? JSON.stringify(v, null, 2) : String(v ?? "--");
        return `<div class="wm-card"><div class="wm-key">${esc(k)}</div><div class="wm-val">${esc(valText)}</div></div>`;
      }).join("")
    : `<div class="wm-card"><div class="wm-val">暂无 watermarks 记录</div></div>`;

  // Recent Runs
  document.getElementById("runs-tbody").innerHTML = runs.length
    ? runs.map(r => {
        const st = String(r.status || "--");
        const isBad = /fail|error|err/i.test(st) || Boolean(r.error_message);
        const isOk = /ok|success|done|completed/i.test(st) && !isBad;
        const badgeCls = isBad ? "pill-hot" : (isOk ? "pill-pass" : "pill-mid");
        const msg = r.error_message || r.finished_at || r.started_at || r.updated_at || "--";
        return `
          <tr>
            <td class="left"><strong>${esc(r.job_name || "--")}</strong></td>
            <td class="center"><span class="status-pill ${badgeCls}">${esc(st)}</span></td>
            <td class="center">${esc(r.mode || "--")}</td>
            <td>${r.duration_sec !== null && r.duration_sec !== undefined ? fmtNum(r.duration_sec, 2) : "--"}</td>
            <td class="left" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;" title="${esc(msg)}">${esc(msg)}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="5" class="center flat">暂无定时同步执行记录</td></tr>`;
}

export async function runStockProbe(code) {
  const cleanCode = (code || document.getElementById("probe-code-input").value || "600519.SH").trim().toUpperCase();
  document.getElementById("probe-code-input").value = cleanCode;
  document.querySelectorAll(".probe-chip").forEach(b => b.classList.toggle("active", b.dataset.code === cleanCode));

  const tbody = document.getElementById("probe-tbody");
  tbody.innerHTML = `<tr><td colspan="4" class="center flat">正在抽检 ${esc(cleanCode)} 的复权 K 线与三大财报…</td></tr>`;

  try {
    const [kf, kn, fin] = await Promise.all([
      quantFetch(`/api/stocks/${encodeURIComponent(cleanCode)}/kline`, { adjust: "forward", limit: 10 }),
      quantFetch(`/api/stocks/${encodeURIComponent(cleanCode)}/kline`, { adjust: "none", limit: 10 }),
      quantFetch(`/api/stocks/${encodeURIComponent(cleanCode)}/financials`, { limit: 8 })
    ]);

    const itemsF = kf.items || [];
    const itemsN = kn.items || [];
    const inc = fin.income_statements || [];
    const bal = fin.balance_sheets || [];
    const cfs = fin.cash_flow_statements || [];

    let ascOk = itemsF.length > 0;
    let ohlcOk = itemsF.length > 0;
    for (let i = 0; i < itemsF.length; i++) {
      const it = itemsF[i];
      if (i > 0 && it.date <= itemsF[i - 1].date) ascOk = false;
      if (it.open == null || it.high == null || it.low == null || it.close == null || it.high < it.low) ohlcOk = false;
    }

    const lastF = itemsF[itemsF.length - 1];
    const lastN = itemsN[itemsN.length - 1];
    const qIncOk = inc.some(r => r.q_operating_income !== null && r.q_operating_income !== undefined && r.q_parent_holder_net_profit !== null);
    const balOk = bal.some(r => r.debt_to_assets_pct !== null && r.debt_to_assets_pct !== undefined);
    const cfsOk = cfs.some(r => r.q_act_cash_flow_net !== null && r.q_act_cash_flow_net !== undefined);

    const checks = [
      {
        dim: "K线日期升序与 OHLC 完整性",
        ok: ascOk && ohlcOk,
        obs: `${itemsF.length} 根样本 (${itemsF[0]?.date || "--"} → ${lastF?.date || "--"}) · 最新前复权收盘 ${fmtNum(lastF?.close)}`,
        desc: "校验日期严格升序、无空值且最高价 ≥ 最低价"
      },
      {
        dim: "前复权 vs 不复权与复权因子",
        ok: Boolean(lastF && lastN && lastF.factor !== null && lastF.factor !== undefined),
        obs: `前复权=${fmtNum(lastF?.close)} (factor=${fmtNum(lastF?.factor, 4)}) | 不复权=${fmtNum(lastN?.close)} (factor=${fmtNum(lastN?.factor, 4)})`,
        desc: "确认最新交易日两口径一致响应且复权因子非空"
      },
      {
        dim: "利润表及单季拆解字段",
        ok: inc.length > 0 && qIncOk,
        obs: `返回 ${inc.length} 期 · 最新 ${inc[0]?.fiscal_year || ""}${inc[0]?.fiscal_period || ""} 单季营收 ${fmtMoneyShort(inc[0]?.q_operating_income)}`,
        desc: "检验 q_operating_income / q_parent_holder_net_profit 等拆解字段"
      },
      {
        dim: "资产负债表与衍生负债率",
        ok: bal.length > 0 && balOk,
        obs: `返回 ${bal.length} 期 · 最新资产负债率 ${fmtPct(bal[0]?.debt_to_assets_pct, 2, false)}`,
        desc: "检验 debt_to_assets_pct 计算字段与报表对齐"
      },
      {
        dim: "现金流量表及单季经营现金流",
        ok: cfs.length > 0 && cfsOk,
        obs: `返回 ${cfs.length} 期 · 最新单季经营现金流 ${fmtMoneyShort(cfs[0]?.q_act_cash_flow_net)}`,
        desc: "检验 q_act_cash_flow_net / q_pay_fixed_assets_etc_cash 拆解字段"
      }
    ];

    tbody.innerHTML = checks.map(c => `
      <tr>
        <td class="left"><strong>${esc(c.dim)}</strong></td>
        <td class="center"><span class="status-pill ${c.ok ? "pill-pass" : "pill-hot"}">${c.ok ? "通过" : "异常"}</span></td>
        <td class="left mono" style="white-space:normal;">${esc(c.obs)}</td>
        <td class="left" style="white-space:normal;color:var(--ink-muted);">${esc(c.desc)}</td>
      </tr>
    `).join("");

    const snippet = {
      symbol: kf.symbol,
      latest_kline_forward_2: itemsF.slice(-2),
      latest_income_1: inc[0] || null,
      latest_balance_1: bal[0] || null,
      latest_cashflow_1: cfs[0] || null
    };
    document.getElementById("probe-raw-json").textContent = JSON.stringify(snippet, null, 2);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="center up">抽检失败: ${esc(err.message)}</td></tr>`;
    showGlobalAlert(err);
  }
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

