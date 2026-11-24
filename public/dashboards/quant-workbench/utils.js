export function esc(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "--";
  return Math.round(Number(n)).toLocaleString("en-US");
}

export function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "--";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

export function fmtPct(n, digits = 2, showPlus = true) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "--";
  const num = Number(n);
  const sign = showPlus && num > 0 ? "+" : "";
  return `${sign}${num.toFixed(digits)}%`;
}

export function fmtMoneyShort(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "--";
  const num = Number(n);
  const abs = Math.abs(num);
  if (abs >= 1e8) return `${(num / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(num / 1e4).toFixed(1)}万`;
  return fmtNum(num, 2);
}

export function fmtVol(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "--";
  const num = Number(n);
  const abs = Math.abs(num);
  if (abs >= 1e8) return `${(num / 1e8).toFixed(2)}亿股`;
  if (abs >= 1e4) return `${(num / 1e4).toFixed(1)}万股`;
  return `${fmtInt(num)}股`;
}

export function clsSign(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "flat";
  const num = Number(n);
  if (num > 0) return "up";
  if (num < 0) return "down";
  return "flat";
}

export function median(nums) {
  const valid = nums.filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  if (!valid.length) return null;
  valid.sort((a, b) => a - b);
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function daysBetweenIso(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((todayUtc - t) / 86400000);
}

export function csvCell(val) {
  const s = val === null || val === undefined ? "" : String(val);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadCsv(filename, headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(r.map(csvCell).join(","));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function addDaysIso(dateStr, days) {
  if (!dateStr) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return "";
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
  return dt.toISOString().slice(0, 10);
}

export function daysBetweenDates(d1, d2) {
  return Math.round((new Date(d2 + "T00:00:00Z") - new Date(d1 + "T00:00:00Z")) / 86400000);
}
