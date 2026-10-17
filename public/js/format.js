// Number and text formatting. Units: 'indian' (₹12.4L, ₹1.2Cr) or
// 'international' (₹1.24M).
let units = 'indian';
export const setUnits = (u) => { units = u === 'international' ? 'international' : 'indian'; };
export const getUnits = () => units;

const full = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fullIntl = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function scaled(abs) {
  const steps = units === 'indian'
    ? [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']]
    : [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [n, suffix] of steps) {
    if (abs >= n) {
      const v = abs / n;
      const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
      return `${Number(v.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.round(abs));
}

/** ₹1,23,456 (full) or ₹1.23L (compact). */
export function money(v, { compact = false, sign = false } = {}) {
  if (v == null || Number.isNaN(v)) return '—';
  if (Math.abs(v) < 0.5) v = 0;
  const abs = Math.abs(v);
  const body = compact ? scaled(abs) : (units === 'indian' ? full : fullIntl).format(Math.round(abs));
  const prefix = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return `${prefix}₹${body}`;
}
export const moneyShort = (v, opts = {}) => money(v, { ...opts, compact: true });

export function pctFmt(v, { sign = true, digits = 1 } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = (Math.abs(v) * 100).toFixed(digits);
  const prefix = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return `${prefix}${s}%`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Parse "1,23,456", "₹ 1.5L", "2.3cr", "45k" into a number (or null). */
export function parseAmount(input) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase().replace(/[₹,\s]/g, '').replace(/^rs\.?/, '');
  if (!s) return null;
  let mult = 1;
  const m = s.match(/(cr|crore|l|lakh|lac|k|m)$/);
  if (m) {
    mult = { cr: 1e7, crore: 1e7, l: 1e5, lakh: 1e5, lac: 1e5, k: 1e3, m: 1e6 }[m[1]];
    s = s.slice(0, -m[1].length);
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * mult * 100) / 100 : null;
}

export function daysAgoText(days) {
  if (days == null) return 'never';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}
