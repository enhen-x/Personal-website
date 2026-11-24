const ALLOWED_ENDPOINT_PATTERNS = [
  /^\/health$/,
  /^\/api\/overview$/,
  /^\/api\/stocks$/,
  /^\/api\/screener$/,
  /^\/api\/stocks\/[A-Za-z0-9._-]+\/(kline|financials|peers|shares)$/,
];

function isAllowedEndpoint(endpoint) {
  if (!endpoint || endpoint.includes('..') || endpoint.includes('?') || endpoint.includes('#')) {
    return false;
  }
  return ALLOWED_ENDPOINT_PATTERNS.some((pattern) => pattern.test(endpoint));
}

function getCacheControl(endpoint, isFresh) {
  if (isFresh) return 'no-store';
  if (endpoint === '/health') {
    return 'public, max-age=15, s-maxage=30, stale-while-revalidate=60';
  }
  if (endpoint === '/api/overview') {
    return 'public, max-age=30, s-maxage=120, stale-while-revalidate=600';
  }
  if (endpoint === '/api/screener') {
    return 'public, max-age=60, s-maxage=300, stale-while-revalidate=1800';
  }
  if (endpoint === '/api/stocks') {
    return 'public, max-age=120, s-maxage=600, stale-while-revalidate=3600';
  }
  if (/^\/api\/stocks\/[A-Za-z0-9._-]+\/kline$/.test(endpoint)) {
    return 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600';
  }
  if (/^\/api\/stocks\/[A-Za-z0-9._-]+\/financials$/.test(endpoint)) {
    return 'public, max-age=300, s-maxage=1800, stale-while-revalidate=86400';
  }
  if (/^\/api\/stocks\/[A-Za-z0-9._-]+\/peers$/.test(endpoint)) {
    return 'public, max-age=120, s-maxage=1800, stale-while-revalidate=86400';
  }
  if (/^\/api\/stocks\/[A-Za-z0-9._-]+\/shares$/.test(endpoint)) {
    return 'public, max-age=300, s-maxage=1800, stale-while-revalidate=86400';
  }
  return 'no-store';
}

function jsonResponse(payload, status, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export async function GET(request) {
  const start = Date.now();
  const reqUrl = new URL(request.url);
  const endpoint = (reqUrl.searchParams.get('endpoint') || '').trim();

  if (!isAllowedEndpoint(endpoint)) {
    return jsonResponse(
      {
        error: '不允许的接口路径',
        code: 'INVALID_ENDPOINT',
      },
      400,
    );
  }

  const base = (process.env.QUANT_API_BASE || '').trim().replace(/\/+$/, '');
  const token = (process.env.QUANT_API_TOKEN || '').trim();

  if (!base) {
    return jsonResponse(
      {
        error: '服务端未配置 QUANT_API_BASE',
        code: 'PROXY_NOT_CONFIGURED',
        hint: '请在 Vercel 环境变量（或本地 .env）中配置 QUANT_API_BASE 与 QUANT_API_TOKEN',
      },
      503,
    );
  }

  if (endpoint !== '/health' && !token) {
    return jsonResponse(
      {
        error: '服务端未配置 QUANT_API_TOKEN',
        code: 'TOKEN_NOT_CONFIGURED',
        hint: '请在 Vercel 环境变量（或本地 .env）中配置 QUANT_API_TOKEN',
      },
      503,
    );
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(`${base}${endpoint}`);
    if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
      throw new Error('QUANT_API_BASE 必须以 http:// 或 https:// 开头');
    }
  } catch (err) {
    console.error('[api/quant] invalid QUANT_API_BASE:', err);
    return jsonResponse(
      {
        error: '服务端 QUANT_API_BASE 配置无效',
        code: 'INVALID_UPSTREAM_BASE',
        detail: err?.message || 'Invalid URL',
      },
      503,
    );
  }

  const isFresh = reqUrl.searchParams.get('fresh') === '1';

  for (const [key, value] of reqUrl.searchParams.entries()) {
    if (key !== 'endpoint' && key !== 'fresh' && key !== 'v' && value !== '') {
      upstreamUrl.searchParams.append(key, value);
    }
  }

  const headers = {
    Accept: 'application/json',
  };
  if (endpoint !== '/health') {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    });

    const elapsedMs = Date.now() - start;
    const body = await upstreamRes.arrayBuffer();
    const cachePolicy = upstreamRes.status === 200 ? getCacheControl(endpoint, isFresh) : 'no-store';

    const responseHeaders = {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': cachePolicy,
      'X-Proxy-Latency-Ms': String(elapsedMs),
    };
    if (cachePolicy !== 'no-store') {
      responseHeaders['CDN-Cache-Control'] = cachePolicy;
    }

    return new Response(body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const isTimeout =
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';

    console.error('[api/quant] upstream error:', err);
    return jsonResponse(
      {
        error: isTimeout ? '请求 Quant Data API 超时（15s）' : '无法连接到 Quant Data API 服务',
        code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
        detail: err?.message || 'Network error',
      },
      isTimeout ? 504 : 502,
      { 'X-Proxy-Latency-Ms': String(elapsedMs) },
    );
  }
}
