export const STATE = {
  activeTab: "inspect",
  health: null,
  overview: null,
  inspectLoaded: false,
  screenerLoaded: false,
  screener: {
    view: "overview",
    offset: 0,
    limit: 50,
    sort_by: "avg_turnover_20d",
    sort_dir: "desc",
    total: 0,
    items: []
  },
  stock: {
    code: "600519.SH",
    loadedCode: "",
    adjust: "forward",
    klineLimit: 250,
    chartMode: "candle",
    ma5: true,
    ma20: true,
    ma60: true,
    finMode: "quarter",
    stmtType: "income",
    stmtCols: "core",
    stmtShowDeltas: true,
    stmtLimit: 40,
    klineData: null,
    valKlineData: null,
    valFwdKlineData: null,
    valFwdLoadedCode: "",
    finData: null,
    valFinData: null,
    valAllLoadedCode: "",
    valMetric: "pe",
    valWindow: 1250,
    valAlignMode: "pit",
    dcfBase: "fcf_ttm",
    dcfPreset: "neutral",
    dcfRMode: "capm",
    dcfNetCashAdj: false,
    rimAllowBelowBook: false,
    dcfG1: 10,
    dcfG2: 2.5,
    dcfR: 9.0,
    dcfMos: 20,
    dcfAutoFittedCode: "",
    valSnap: null
  },
  watchlist: [],
  compare: {
    loaded: false,
    dirty: true,
    loading: false,
    codes: [],
    names: {},
    cache: {},
    errors: {},
    scatterMode: "pb_roe",
    rMode: "capm",
    scenario: "neutral",
    netCashAdj: false,
    rimAllowBelowBook: false,
    sortBy: "impliedIrr",
    sortDir: "desc",
    peerAnchorCode: "",
    peerLevel: "l2",
    peerSortBy: "total_market_cap",
    peerOpen: true,
    peerLoading: false,
    peerError: "",
    peerData: null,
    peerCache: {}
  }
};

export const LS_WATCHLIST_KEY = "quant_workbench_watchlist_v1";
export const LS_COMPARE_KEY = "quant_workbench_compare_v1";
export const DEFAULT_WATCHLIST = [
  { code: "600519.SH", name: "贵州茅台" },
  { code: "600036.SH", name: "招商银行" },
  { code: "601318.SH", name: "中国平安" },
  { code: "002594.SZ", name: "比亚迪" },
  { code: "600900.SH", name: "长江电力" }
];
export const PEER_PRESETS = {
  fin: {
    label: "金融高息",
    items: [
      { code: "600036.SH", name: "招商银行" },
      { code: "601398.SH", name: "工商银行" },
      { code: "601288.SH", name: "农业银行" },
      { code: "601166.SH", name: "兴业银行" },
      { code: "601318.SH", name: "中国平安" },
      { code: "601601.SH", name: "中国太保" }
    ]
  },
  liquor: {
    label: "白酒核心",
    items: [
      { code: "600519.SH", name: "贵州茅台" },
      { code: "000858.SZ", name: "五粮液" },
      { code: "000568.SZ", name: "泸州老窖" },
      { code: "600809.SH", name: "山西汾酒" },
      { code: "002304.SZ", name: "洋河股份" }
    ]
  },
  dividend: {
    label: "红利公用/能源",
    items: [
      { code: "600900.SH", name: "长江电力" },
      { code: "601088.SH", name: "中国神华" },
      { code: "601225.SH", name: "陕西煤业" },
      { code: "600028.SH", name: "中国石化" },
      { code: "600938.SH", name: "中国海油" }
    ]
  },
  mfg: {
    label: "高端制造/新能源",
    items: [
      { code: "002594.SZ", name: "比亚迪" },
      { code: "300750.SZ", name: "宁德时代" },
      { code: "300124.SZ", name: "汇川技术" },
      { code: "000333.SZ", name: "美的集团" },
      { code: "000651.SZ", name: "格力电器" }
    ]
  }
};

export function lsGetJson(key) {
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function lsSetJson(key, val) {
  try { window.localStorage?.setItem(key, JSON.stringify(val)); } catch {}
}

export function initPersistedLists() {
  const savedWl = lsGetJson(LS_WATCHLIST_KEY);
  if (Array.isArray(savedWl) && savedWl.length) {
    STATE.watchlist = savedWl
      .filter(it => it && it.code)
      .slice(0, 20)
      .map(it => ({ code: String(it.code).trim().toUpperCase(), name: String(it.name || "") }));
  } else {
    STATE.watchlist = DEFAULT_WATCHLIST.map(x => ({ ...x }));
  }

  const savedCmp = lsGetJson(LS_COMPARE_KEY);
  if (Array.isArray(savedCmp) && savedCmp.length) {
    const codes = [];
    for (const it of savedCmp) {
      const c = String(typeof it === "string" ? it : it?.code || "").trim().toUpperCase();
      if (c && !codes.includes(c) && codes.length < 10) {
        codes.push(c);
        if (typeof it === "object" && it?.name) STATE.compare.names[c] = String(it.name);
      }
    }
    STATE.compare.codes = codes;
  }
  if (!STATE.compare.codes.length) {
    STATE.compare.codes = PEER_PRESETS.fin.items.map(it => {
      STATE.compare.names[it.code] = it.name;
      return it.code;
    });
  }
}

export function saveWatchlist() {
  lsSetJson(LS_WATCHLIST_KEY, STATE.watchlist);
}

export function saveCompareList() {
  lsSetJson(
    LS_COMPARE_KEY,
    STATE.compare.codes.map(c => ({ code: c, name: STATE.compare.names[c] || "" }))
  );
}

export const CHARTS = {};

export function destroyChart(key) {
  if (CHARTS[key]) {
    try { CHARTS[key].plot.destroy(); } catch {}
    delete CHARTS[key];
  }
}
