"""Incremental updater for the CSI 300 dynamic valuation dashboard datasets.

Fetches only recent CSIndex / CN10Y observations and Eastmoney secondary-bond fund
NAVs after the latest baseline date, recomputes all zero-lookahead rolling metrics,
validates data integrity, and writes compact JSONs consumed by the dashboard.
"""

from __future__ import annotations

import argparse
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, TypeVar

import numpy as np
import pandas as pd
import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_CSV = REPO_ROOT / "scripts" / "data" / "csi300_base_history.csv"
CODES_JSON = REPO_ROOT / "scripts" / "data" / "secbond_codes.json"
CORE_JSON = REPO_ROOT / "public" / "dashboards" / "data" / "csi300-core.json"
BENCH93_JSON = REPO_ROOT / "public" / "dashboards" / "data" / "csi300-930897.json"
DASHBOARD_HTML = REPO_ROOT / "public" / "dashboards" / "csi300-valuation-dashboard.html"

BJT = timezone(timedelta(hours=8))
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://fundf10.eastmoney.com/",
}
_THREAD_LOCAL = threading.local()
T = TypeVar("T")


def get_session() -> requests.Session:
    """Return a thread-local requests Session for connection pooling."""
    sess = getattr(_THREAD_LOCAL, "session", None)
    if sess is None:
        sess = requests.Session()
        sess.headers.update(HEADERS)
        _THREAD_LOCAL.session = sess
    return sess


def fetch_with_retry(fn: Callable[[], T], name: str, retries: int = 3) -> T:
    """Run an external network fetch with exponential backoff."""
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt < retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"[retry] {name} failed ({exc}); sleeping {wait}s...")
                time.sleep(wait)
    raise RuntimeError(f"{name} failed after {retries} attempts: {last_exc}")


def rolling_pct_rank(arr: np.ndarray, window: int, min_periods: int) -> np.ndarray:
    """Zero-lookahead rolling percentile rank in [0, 100] over trailing window."""
    out = np.full(len(arr), np.nan, dtype=float)
    valid_vals: list[float] = []
    for i, v in enumerate(arr):
        if np.isnan(v):
            continue
        valid_vals.append(float(v))
        if len(valid_vals) >= min_periods:
            win = np.asarray(valid_vals[-window:], dtype=float)
            out[i] = float(np.mean(win <= v) * 100.0)
    return out


def expanding_pct_rank(arr: np.ndarray, min_periods: int) -> np.ndarray:
    """Zero-lookahead expanding percentile rank in [0, 100] using data <= t."""
    out = np.full(len(arr), np.nan, dtype=float)
    valid_vals: list[float] = []
    for i, v in enumerate(arr):
        if np.isnan(v):
            continue
        valid_vals.append(float(v))
        if len(valid_vals) >= min_periods:
            win = np.asarray(valid_vals, dtype=float)
            out[i] = float(np.mean(win <= v) * 100.0)
    return out


def rolling_quantiles_on_valid(
    arr: np.ndarray, window: int, min_periods: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute zero-lookahead rolling P20, P50, P80 on valid non-NaN observations."""
    n = len(arr)
    p20 = np.full(n, np.nan, dtype=float)
    p50 = np.full(n, np.nan, dtype=float)
    p80 = np.full(n, np.nan, dtype=float)
    valid_vals: list[float] = []
    for i, v in enumerate(arr):
        if np.isnan(v):
            continue
        valid_vals.append(float(v))
        if len(valid_vals) >= min_periods:
            win = np.asarray(valid_vals[-window:], dtype=float)
            q20, q50, q80 = np.percentile(win, [20, 50, 80])
            p20[i], p50[i], p80[i] = float(q20), float(q50), float(q80)
    return p20, p50, p80


def _round_list(series: pd.Series, decimals: int = 2) -> list:
    out = []
    for v in series.to_numpy():
        if pd.isna(v):
            out.append(None)
        else:
            out.append(round(float(v), decimals))
    return out


def fetch_csindex_json(symbol: str, start_yyyymmdd: str, end_yyyymmdd: str) -> pd.DataFrame:
    """Fetch official CSIndex daily index-perf JSON directly."""
    url = "https://www.csindex.com.cn/csindex-home/perf/index-perf"
    headers = {
        "User-Agent": HEADERS["User-Agent"],
        "Referer": "https://www.csindex.com.cn/",
    }
    r = requests.get(
        url,
        params={"indexCode": symbol, "startDate": start_yyyymmdd, "endDate": end_yyyymmdd},
        headers=headers,
        timeout=15,
    )
    r.raise_for_status()
    rows = (r.json() or {}).get("data") or []
    if not rows:
        raise RuntimeError(f"{symbol} returned empty data from CSIndex")
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["tradeDate"], format="%Y%m%d", errors="coerce")
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["peg"] = pd.to_numeric(df["peg"], errors="coerce") if "peg" in df.columns else np.nan
    return df


def fetch_recent_csindex(start_yyyymmdd: str, end_yyyymmdd: str) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Fetch recent CSIndex H00300, 000300, and 930897 daily series."""
    def _get_h300() -> pd.DataFrame:
        df = fetch_csindex_json("H00300", start_yyyymmdd, end_yyyymmdd)
        df = df.rename(columns={"close": "h00300", "peg": "h00300_pe"})
        df.loc[df["h00300_pe"] <= 0, "h00300_pe"] = np.nan
        return (
            df[["date", "h00300", "h00300_pe"]]
            .dropna(subset=["date", "h00300"])
            .drop_duplicates("date")
            .sort_values("date")
            .reset_index(drop=True)
        )

    def _get_p300() -> pd.DataFrame:
        df = fetch_csindex_json("000300", start_yyyymmdd, end_yyyymmdd)
        df = df.rename(columns={"close": "p300"})
        return (
            df[["date", "p300"]]
            .dropna(subset=["date", "p300"])
            .drop_duplicates("date")
            .sort_values("date")
            .reset_index(drop=True)
        )

    def _get_930897() -> pd.DataFrame:
        df = fetch_csindex_json("930897", start_yyyymmdd, end_yyyymmdd)
        df = df.rename(columns={"close": "idx_930897"})
        return (
            df[["date", "idx_930897"]]
            .dropna(subset=["date", "idx_930897"])
            .drop_duplicates("date")
            .sort_values("date")
            .reset_index(drop=True)
        )

    h300 = fetch_with_retry(_get_h300, "CSIndex H00300")
    p300 = fetch_with_retry(_get_p300, "CSIndex 000300")
    idx93 = fetch_with_retry(_get_930897, "CSIndex 930897")
    return h300, p300, idx93


def fetch_recent_cn10y(start_yyyymmdd: str) -> pd.DataFrame:
    """Fetch recent China 10Y Treasury Yield directly from Eastmoney datacenter."""
    def _get() -> pd.DataFrame:
        url = "https://datacenter.eastmoney.com/api/data/get"
        headers = {
            "User-Agent": HEADERS["User-Agent"],
            "Referer": "https://data.eastmoney.com/",
        }
        r = requests.get(
            url,
            params={
                "type": "RPTA_WEB_TREASURYYIELD",
                "sty": "SOLAR_DATE,EMM00166466",
                "st": "SOLAR_DATE",
                "sr": "-1",
                "token": "894050c76af8597a853f5b408b759f5d",
                "p": "1",
                "ps": "200",
            },
            headers=headers,
            timeout=15,
        )
        r.raise_for_status()
        rows = ((r.json() or {}).get("result") or {}).get("data") or []
        if not rows:
            raise RuntimeError("Eastmoney treasury yield returned empty data")
        df = pd.DataFrame(rows)
        df["date"] = pd.to_datetime(df["SOLAR_DATE"], errors="coerce").dt.normalize()
        df["cn10y"] = pd.to_numeric(df["EMM00166466"], errors="coerce")
        cutoff = pd.to_datetime(start_yyyymmdd, format="%Y%m%d")
        df = df[df["date"] >= cutoff]
        return (
            df[["date", "cn10y"]]
            .dropna(subset=["date", "cn10y"])
            .drop_duplicates("date")
            .sort_values("date")
            .reset_index(drop=True)
        )

    return fetch_with_retry(_get, "China 10Y Treasury Yield")


def fetch_fund_recent_returns(code: str, target_dates: set[str]) -> dict[str, float]:
    """Fetch recent daily percentage returns (clipped to [-0.15, 0.15]) for one fund."""
    url = f"https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=25"
    sess = get_session()
    for attempt in range(3):
        try:
            r = sess.get(url, timeout=10)
            if r.status_code != 200:
                time.sleep(0.3 * (attempt + 1))
                continue
            payload = r.json()
            rows = (payload.get("Data") or {}).get("LSJZList") or []
            out: dict[str, float] = {}
            for item in rows:
                dt = str(item.get("FSRQ") or "").strip()
                if dt not in target_dates:
                    continue
                jzzzl = str(item.get("JZZZL") or "").strip()
                if not jzzzl:
                    continue
                try:
                    ret = float(jzzzl) / 100.0
                except ValueError:
                    continue
                if np.isfinite(ret):
                    out[dt] = float(np.clip(ret, -0.15, 0.15))
            return out
        except Exception:  # noqa: BLE001
            time.sleep(0.4 * (attempt + 1))
    return {}


def fetch_incremental_fund_returns(codes: list[str], target_dates: list[str]) -> dict[str, list[float]]:
    """Concurrently collect daily returns across the 400 secondary bond funds."""
    target_set = set(target_dates)
    by_date: dict[str, list[float]] = {dt: [] for dt in target_dates}
    ok_funds = 0
    with ThreadPoolExecutor(max_workers=12) as executor:
        futures = {executor.submit(fetch_fund_recent_returns, c, target_set): c for c in codes}
        for fut in as_completed(futures):
            res = fut.result()
            if res:
                ok_funds += 1
                for dt, ret in res.items():
                    by_date[dt].append(ret)
    print(f"Fetched Eastmoney lsjz returns from {ok_funds}/{len(codes)} funds.")
    return by_date


def append_new_trading_days(base_df: pd.DataFrame) -> tuple[pd.DataFrame, int, int]:
    """Backfill recent official 930897 observations and append complete new trading days."""
    last_date: pd.Timestamp = base_df["date"].max()
    today_bjt = datetime.now(BJT).date()
    end_str = today_bjt.strftime("%Y%m%d")
    start_str = (last_date - timedelta(days=60)).date().strftime("%Y%m%d")
    cn10y_start_str = (last_date - timedelta(days=75)).date().strftime("%Y%m%d")

    print(f"Latest baseline date: {last_date.date()} | Checking window {start_str} -> {end_str}...")
    h300_df, p300_df, idx93_df = fetch_recent_csindex(start_str, end_str)
    cn10y_df = fetch_recent_cn10y(cn10y_start_str)

    # Backfill official idx_930897 on existing baseline dates (replaces prior T+0 estimates)
    backfilled = 0
    if not idx93_df.empty:
        official_93 = dict(zip(idx93_df["date"], idx93_df["idx_930897"]))
        for idx in base_df.index:
            dt = base_df.at[idx, "date"]
            if dt in official_93:
                new_v = float(official_93[dt])
                old_v = base_df.at[idx, "idx_930897"]
                if pd.isna(old_v) or abs(float(old_v) - new_v) > 1e-4:
                    base_df.at[idx, "idx_930897"] = new_v
                    backfilled += 1
    if backfilled > 0:
        print(f"Backfilled official CSIndex 930897 on {backfilled} existing date(s).")

    cand = h300_df[h300_df["date"] > last_date].copy()
    if cand.empty:
        print("No new CSIndex H00300 trading days found.")
        return base_df, 0, backfilled

    cand = cand.merge(p300_df, on="date", how="left")
    cand = cand.merge(idx93_df, on="date", how="left")
    cand = cand.merge(cn10y_df, on="date", how="left")
    cand = cand.sort_values("date").reset_index(drop=True)

    # Apply the same ffill limits across baseline tail + candidate rows
    tail_ref = base_df.tail(10)[["date", "p300", "cn10y"]].copy()
    combined_fill = pd.concat([tail_ref, cand[["date", "p300", "cn10y"]]], ignore_index=True)
    combined_fill["p300"] = combined_fill["p300"].ffill(limit=3)
    combined_fill["cn10y"] = combined_fill["cn10y"].ffill(limit=5)
    cand["p300"] = combined_fill["p300"].iloc[len(tail_ref) :].to_numpy()
    cand["cn10y"] = combined_fill["cn10y"].iloc[len(tail_ref) :].to_numpy()

    target_dates = cand["date"].dt.strftime("%Y-%m-%d").tolist()
    codes = json.loads(CODES_JSON.read_text(encoding="utf-8"))
    fund_rets_by_date = fetch_incremental_fund_returns(codes, target_dates)

    prev_ew = float(base_df["ew_secbond"].iloc[-1])
    prev_93 = float(base_df["idx_930897"].iloc[-1])
    new_rows = []
    for _, row in cand.iterrows():
        dt_str = row["date"].strftime("%Y-%m-%d")
        rets = fund_rets_by_date.get(dt_str, [])
        missing_fields = [
            col
            for col in ("h00300", "p300", "h00300_pe", "cn10y")
            if pd.isna(row[col])
        ]
        if missing_fields or len(rets) < 200:
            print(
                f"Stopping before {dt_str}: incomplete core data "
                f"(missing={missing_fields}, valid_funds={len(rets)}/{len(codes)})."
            )
            break

        ew_ret = float(np.mean(rets))
        prev_ew = prev_ew * (1.0 + ew_ret)
        if pd.notna(row["idx_930897"]):
            val_93 = float(row["idx_930897"])
            tag_93 = f"{val_93:.2f}"
        else:
            # CSIndex 930897 publishes T+1; estimate temporarily using EW daily return until official backfill
            val_93 = prev_93 * (1.0 + ew_ret)
            tag_93 = f"{val_93:.2f}(est)"
        prev_93 = val_93

        new_rows.append(
            {
                "date": row["date"],
                "h00300": float(row["h00300"]),
                "p300": float(row["p300"]),
                "h00300_pe": float(row["h00300_pe"]),
                "ew_secbond": prev_ew,
                "idx_930897": val_93,
                "cn10y": float(row["cn10y"]),
            }
        )
        print(
            f"  + {dt_str}: H00300={row['h00300']:.2f}, P300={row['p300']:.2f}, "
            f"PE={row['h00300_pe']:.2f}, 930897={tag_93}, "
            f"CN10Y={row['cn10y']:.2f}, funds={len(rets)}, ew_ret={ew_ret*100:+.3f}%"
        )

    if not new_rows:
        return base_df, 0, backfilled

    updated = pd.concat([base_df, pd.DataFrame(new_rows)], ignore_index=True)
    updated = updated.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    return updated, len(new_rows), backfilled


def compute_panel_and_payloads(base_df: pd.DataFrame) -> tuple[dict, dict, pd.DataFrame]:
    """Recompute all dynamic valuation indicators and split payloads."""
    df = base_df.sort_values("date").drop_duplicates("date").reset_index(drop=True).copy()

    tr_ratio = df["h00300"] / df["p300"]
    daily_div_rate = (tr_ratio / tr_ratio.shift(1) - 1.0).clip(lower=0.0).fillna(0.0)
    div_pts = pd.Series((df["p300"] * daily_div_rate).values, index=pd.DatetimeIndex(df["date"]))
    ttm_div_pts = div_pts.rolling("365D").sum().values
    df["dy_ttm"] = (ttm_div_pts / df["p300"]) * 100.0
    df.loc[df["date"] < pd.Timestamp("2005-12-31"), "dy_ttm"] = np.nan

    df["ey"] = 100.0 / df["h00300_pe"]
    df["log_r_ew"] = np.log(df["h00300"] / df["ew_secbond"])

    first93_idx = df["idx_930897"].first_valid_index()
    if first93_idx is None:
        raise RuntimeError("idx_930897 has no valid rows")
    scale_93 = df.loc[first93_idx, "ew_secbond"] / df.loc[first93_idx, "idx_930897"]
    df["idx_930897_scaled"] = df["idx_930897"] * scale_93
    df["log_r_93"] = np.log(df["h00300"] / df["idx_930897_scaled"])

    ew_arr = df["log_r_ew"].to_numpy()
    df["pct_ew_3y"] = rolling_pct_rank(ew_arr, window=756, min_periods=500)
    df["pct_ew_5y"] = rolling_pct_rank(ew_arr, window=1260, min_periods=750)
    df["pct_ew_exp"] = expanding_pct_rank(ew_arr, min_periods=500)
    df["log_r_ew_p20"], df["log_r_ew_p50"], df["log_r_ew_p80"] = rolling_quantiles_on_valid(
        ew_arr, window=1260, min_periods=750
    )

    arr93 = df["log_r_93"].to_numpy()
    df["pct_93_3y"] = rolling_pct_rank(arr93, window=756, min_periods=500)
    df["pct_93_5y"] = rolling_pct_rank(arr93, window=1260, min_periods=750)
    df["pct_93_exp"] = expanding_pct_rank(arr93, min_periods=500)
    df["log_r_93_p20"], df["log_r_93_p50"], df["log_r_93_p80"] = rolling_quantiles_on_valid(
        arr93, window=1260, min_periods=750
    )

    last = df.iloc[-1]
    ey_hist_pct = round(float((df["ey"].dropna() <= last["ey"]).mean() * 100.0), 1)
    dy_hist_pct = round(float((df["dy_ttm"].dropna() <= last["dy_ttm"]).mean() * 100.0), 1)

    # Sanity assertions before writing any outputs
    assert len(df) >= 5314, f"Unexpected row count: {len(df)}"
    assert df["date"].is_monotonic_increasing and df["date"].is_unique, "Dates not strictly increasing"
    assert float(last["h00300"]) > 1000.0, f"Invalid H00300: {last['h00300']}"
    assert float(last["p300"]) > 1000.0, f"Invalid P300: {last['p300']}"
    assert 2.0 < float(last["ey"]) < 25.0, f"Invalid EY: {last['ey']}"
    assert 0.5 < float(last["dy_ttm"]) < 10.0, f"Invalid DY_TTM: {last['dy_ttm']}"
    assert 0.5 < float(last["cn10y"]) < 8.0, f"Invalid CN10Y: {last['cn10y']}"
    assert 0.0 <= float(last["pct_ew_5y"]) <= 100.0, f"Invalid pct_ew_5y: {last['pct_ew_5y']}"

    core_payload = {
        "dates": df["date"].dt.strftime("%Y-%m-%d").tolist(),
        "h300": _round_list(df["h00300"], 2),
        "ey": _round_list(df["ey"], 2),
        "dy": _round_list(df["dy_ttm"], 2),
        "cn10y": _round_list(df["cn10y"], 2),
        "log_ew": _round_list(df["log_r_ew"], 4),
        "log_ew_p20": _round_list(df["log_r_ew_p20"], 4),
        "log_ew_p50": _round_list(df["log_r_ew_p50"], 4),
        "log_ew_p80": _round_list(df["log_r_ew_p80"], 4),
        "pct_ew_3y": _round_list(df["pct_ew_3y"], 1),
        "pct_ew_5y": _round_list(df["pct_ew_5y"], 1),
        "pct_ew_exp": _round_list(df["pct_ew_exp"], 1),
        "meta": {
            "latest_date": str(last["date"].date()),
            "ey_hist_pct": ey_hist_pct,
            "dy_hist_pct": dy_hist_pct,
        },
    }

    bench93_payload = {
        "log_93": _round_list(df["log_r_93"], 4),
        "log_93_p20": _round_list(df["log_r_93_p20"], 4),
        "log_93_p50": _round_list(df["log_r_93_p50"], 4),
        "log_93_p80": _round_list(df["log_r_93_p80"], 4),
        "pct_93_3y": _round_list(df["pct_93_3y"], 1),
        "pct_93_5y": _round_list(df["pct_93_5y"], 1),
        "pct_93_exp": _round_list(df["pct_93_exp"], 1),
    }

    return core_payload, bench93_payload, df


def write_if_changed(path: Path, content: str) -> bool:
    """Write UTF-8 LF text only when content differs from disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    return True


def update_dashboard_version(latest_date_str: str) -> bool:
    """Bump DATA_VERSION in the dashboard HTML to match latest_date (YYYYMMDD)."""
    version = latest_date_str.replace("-", "")
    html = DASHBOARD_HTML.read_text(encoding="utf-8")
    new_html, count = re.subn(
        r'(const DATA_VERSION = ")[0-9]{8}(";)',
        rf"\g<1>{version}\g<2>",
        html,
    )
    if count != 1:
        raise RuntimeError(f"Expected 1 DATA_VERSION token in {DASHBOARD_HTML}, found {count}")
    if new_html == html:
        return False
    newline = "\r\n" if "\r\n" in html else "\n"
    with open(DASHBOARD_HTML, "w", encoding="utf-8", newline="") as f:
        f.write(new_html.replace("\r\n", "\n").replace("\n", newline))
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Incrementally update CSI 300 valuation dashboard JSONs.")
    parser.add_argument(
        "--recompute-only",
        action="store_true",
        help="Offline mode: recompute JSON payloads solely from scripts/data/csi300_base_history.csv",
    )
    args = parser.parse_args()

    base_df = pd.read_csv(BASE_CSV, parse_dates=["date"]).sort_values("date").reset_index(drop=True)
    added_days = 0
    backfilled = 0
    if not args.recompute_only:
        base_df, added_days, backfilled = append_new_trading_days(base_df)

    core_payload, bench93_payload, full_df = compute_panel_and_payloads(base_df)
    latest_date = core_payload["meta"]["latest_date"]

    changed = False
    if added_days > 0 or backfilled > 0:
        out_csv_df = base_df.copy()
        out_csv_df["date"] = out_csv_df["date"].dt.strftime("%Y-%m-%d")
        csv_text = out_csv_df.to_csv(index=False, float_format="%.10g", lineterminator="\n")
        changed |= write_if_changed(BASE_CSV, csv_text)

    core_text = json.dumps(core_payload, separators=(",", ":"), ensure_ascii=False)
    bench93_text = json.dumps(bench93_payload, separators=(",", ":"), ensure_ascii=False)

    changed |= write_if_changed(CORE_JSON, core_text)
    changed |= write_if_changed(BENCH93_JSON, bench93_text)
    changed |= update_dashboard_version(latest_date)

    last = full_df.iloc[-1]
    print(
        f"Latest date: {latest_date} | rows={len(full_df)} | added_days={added_days} | "
        f"EY={last['ey']:.2f}% | DY={last['dy_ttm']:.2f}% | CN10Y={last['cn10y']:.2f}% | "
        f"5Y_pct={last['pct_ew_5y']:.1f}% | files_changed={changed}"
    )


if __name__ == "__main__":
    main()
