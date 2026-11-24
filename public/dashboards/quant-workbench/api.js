export const API_CACHE = new Map();
export const INFLIGHT = new Map();
export const API_SCHEMA_VER = "3";

export function getClientCacheTtlMs(endpoint) {
  if (endpoint === "/health") return 20000;
  if (endpoint === "/api/overview") return 60000;
  if (endpoint === "/api/screener") return 180000;
  if (endpoint === "/api/stocks") return 300000;
  if (/\/kline$/.test(endpoint)) return 180000;
  if (/\/(financials|peers|shares)$/.test(endpoint)) return 600000;
  return 60000;
}

export function buildQuantUrl(endpoint, params = {}, fresh = false) {
  const url = new URL("/api/quant", window.location.origin);
  url.searchParams.set("endpoint", endpoint);
  const merged = { ...params };
  if (endpoint === "/api/screener" || endpoint === "/api/stocks" || /\/(financials|peers|shares)$/.test(endpoint)) {
    merged.v = API_SCHEMA_VER;
  }
  const keys = Object.keys(merged).sort();
  for (const k of keys) {
    const v = merged[k];
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  if (fresh) {
    url.searchParams.set("fresh", "1");
  }
  return url.toString();
}

export async function quantFetch(endpoint, params = {}, options = {}) {
  const fresh = Boolean(options?.fresh);
  const cacheKey = buildQuantUrl(endpoint, params, false);
  const fetchUrl = buildQuantUrl(endpoint, params, fresh);

  if (!fresh) {
    const cached = API_CACHE.get(cacheKey);
    if (cached) {
      if (Date.now() < cached.expiresAt) {
        updateLatencyBadge(cached.latencyMs, true);
        return cached.data;
      }
      API_CACHE.delete(cacheKey);
    }

    const pending = INFLIGHT.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const reqPromise = (async () => {
    const t0 = performance.now();
    let ok = false;
    let status = 0;
    let text = "";
    let latencyMs = null;

    const preloadMap = window.__QUANT_PRELOAD__;
    if (!fresh && preloadMap && preloadMap[cacheKey]) {
      const prePromise = preloadMap[cacheKey];
      delete preloadMap[cacheKey];
      const pre = await prePromise;
      if (pre) {
        ok = pre.ok;
        status = pre.status;
        text = pre.text;
        latencyMs = Number.isFinite(pre.latencyMs) ? pre.latencyMs : Math.round(performance.now() - t0);
      }
    }

    if (!status) {
      const res = await fetch(fetchUrl, fresh ? { cache: "no-store" } : undefined);
      const clientMs = Math.round(performance.now() - t0);
      const proxyMsHeader = res.headers.get("X-Proxy-Latency-Ms");
      latencyMs = proxyMsHeader ? Number(proxyMsHeader) : clientMs;
      ok = res.ok;
      status = res.status;
      text = await res.text();
    }

    updateLatencyBadge(latencyMs, false);

    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (!ok) {
      const err = new Error(payload?.error || payload?.detail || `HTTP ${status}`);
      err.status = status;
      err.code = payload?.code || "";
      err.hint = payload?.hint || "";
      err.detail = payload?.detail || "";
      throw err;
    }

    API_CACHE.set(cacheKey, {
      data: payload,
      latencyMs,
      expiresAt: Date.now() + getClientCacheTtlMs(endpoint)
    });
    return payload;
  })();

  if (!fresh) {
    INFLIGHT.set(cacheKey, reqPromise);
  }

  try {
    return await reqPromise;
  } finally {
    if (!fresh && INFLIGHT.get(cacheKey) === reqPromise) {
      INFLIGHT.delete(cacheKey);
    }
  }
}

export async function fetchFinancialsChecked(code, limit) {
  const ep = `/api/stocks/${encodeURIComponent(code)}/financials`;
  let data = await quantFetch(ep, { limit });
  if (data && !Array.isArray(data.adjustment_events)) {
    data = await quantFetch(ep, { limit }, { fresh: true });
  }
  return data;
}

export async function fetchSharesSafe(code, limit = 200, fresh = false) {
  try {
    return await quantFetch(
      `/api/stocks/${encodeURIComponent(code)}/shares`,
      { limit },
      fresh ? { fresh: true } : undefined
    );
  } catch {
    return null;
  }
}

export function updateLatencyBadge(ms, fromCache = false) {
  const el = document.getElementById("srv-latency");
  if (!el) return;
  if (fromCache) {
    el.textContent = "缓存";
    return;
  }
  if (!Number.isFinite(ms)) return;
  el.textContent = `${Math.round(ms)}ms`;
}

export function showGlobalAlert(err) {
  const banner = document.getElementById("global-alert");
  const titleEl = document.getElementById("global-alert-title");
  const descEl = document.getElementById("global-alert-desc");
  const badgeEl = document.getElementById("srv-badge");

  let title = "请求异常";
  let desc = err?.message || "未知错误";
  let isWarn = false;

  if (err?.code === "PROXY_NOT_CONFIGURED" || err?.code === "TOKEN_NOT_CONFIGURED") {
    title = "服务端代理尚未配置环境变量";
    desc = `${err.message}。${err.hint || "请在 Vercel Dashboard 或本地 .env 中设置 QUANT_API_BASE 与 QUANT_API_TOKEN。"}`;
    badgeEl.className = "regime-badge pill-mid";
    badgeEl.textContent = "未配置";
    isWarn = true;
  } else if (err?.status === 503) {
    title = "后端数据库写锁暂忙或快照未就绪 (503)";
    desc = "market.duckdb 可能正在执行每日同步写锁（通常持续数秒），请稍候重试。";
    badgeEl.className = "regime-badge pill-mid";
    badgeEl.textContent = "写锁暂忙";
    isWarn = true;
  } else if (err?.status === 401) {
    title = "后端接口鉴权失败 (401)";
    desc = "服务端代理携带的 QUANT_API_TOKEN 与远程 FastAPI .env 不匹配，请核对环境变量。";
    badgeEl.className = "regime-badge pill-hot";
    badgeEl.textContent = "鉴权失败";
  } else if (err?.status === 502 || err?.status === 504) {
    title = err?.status === 504 ? "Quant API 响应超时 (504)" : "无法连接到 Quant Data API (502)";
    desc = `${err.detail || err.message}。若在本地开发，请确认已开启 SSH 端口转发隧道（8000 -> 8000）；若在线上，请检查隧道/域名状态。`;
    badgeEl.className = "regime-badge pill-hot";
    badgeEl.textContent = "离线";
  } else {
    desc = `${err.message}${err.detail ? `（${err.detail}）` : ""}`;
  }

  banner.className = `alert-banner${isWarn ? " warn" : ""}`;
  titleEl.textContent = title;
  descEl.textContent = desc;
}

export function clearGlobalAlert() {
  const banner = document.getElementById("global-alert");
  banner.className = "alert-banner hidden";
}
