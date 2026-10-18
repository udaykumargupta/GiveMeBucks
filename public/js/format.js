// Number and text formatting. Indian grouping (₹12,34,567) and Indian short
// units (₹1.23L, ₹2.46Cr) only. Negatives use U+2212 and never read "−₹0".
import { dayLabel, toDay } from './dates.js';

const MINUS = '−';
const full = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const SHORT_UNITS = [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']];

/** Rupee-rounded; anything that rounds to 0 is plain 0 (no "−₹0"). */
const rupees = (v) => {
  const r = Math.round(Math.abs(v)) * Math.sign(v);
  return r === 0 ? 0 : r;
};

function short(abs) {
  for (const [n, suffix] of SHORT_UNITS) {
    const v = abs / n;
    const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
    const shown = Number(v.toFixed(digits));
    // 99,999 reads ₹1L rather than ₹100K.
    if (shown >= 1) return `${shown}${suffix}`;
  }
  return String(Math.round(abs));
}

/** '₹12,34,567', '−₹3,000', '₹0'. null/NaN → '—'. */
export function money(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const r = rupees(v);
  return `${r < 0 ? MINUS : ''}₹${full.format(Math.abs(r))}`;
}

/** Compact Indian form for axes, sparklines and tight spaces: '₹1.23L', '₹12.3L', '₹2.46Cr', '₹45K'. */
export function moneyShort(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const r = rupees(v);
  if (r === 0) return '₹0';
  const body = short(Math.abs(r));
  return body === '0' ? '₹0' : `${r < 0 ? MINUS : ''}₹${body}`;
}

/** '+₹62,000', '−₹3,000', '₹0' (zero carries no sign). `{ short: true }` uses moneyShort. */
export function signed(v, { short: compact = false } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const r = rupees(v);
  const body = compact ? moneyShort(Math.abs(r)) : money(Math.abs(r));
  if (r === 0 || body === '₹0') return '₹0';
  return `${r < 0 ? MINUS : '+'}${body}`;
}

/** 0.123 → '+12.3%'. */
export function pctFmt(v, { sign = true, digits = 1 } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = (Math.abs(v) * 100).toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  const prefix = v < 0 ? MINUS : sign && v > 0 ? '+' : '';
  return `${prefix}${s}%`;
}

const UNIT_MULT = { '₹': 1, k: 1e3, l: 1e5, cr: 1e7 };
const SUFFIX_MULT = { cr: 1e7, crore: 1e7, crores: 1e7, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, k: 1e3 };

/**
 * Parse what people type into an amount field: "1,23,456", "₹ 1.5L", "2cr",
 * "45k", "-5,000". `unit` ('K' | 'L' | 'Cr') multiplies a bare number; a typed
 * suffix wins over it. Returns rupees rounded to paise, or null.
 */
export function parseAmount(input, unit) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase()
    .replace(/[−–]/g, '-')
    .replace(/^rs\.?/, '')
    .replace(/[₹,\s_]/g, '')
    .replace(/^rs\.?/, '');
  if (!s) return null;
  let mult = 1;
  const m = s.match(/(crores|crore|cr|lakhs|lakh|lacs|lac|l|k)$/);
  if (m) {
    mult = SUFFIX_MULT[m[1]];
    s = s.slice(0, -m[1].length);
  } else if (unit) {
    mult = UNIT_MULT[String(unit).toLowerCase()] || 1;
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s) * mult;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

/** '31 Oct' within `todayISO`'s year, '31 Oct 2025' otherwise. */
export function dateText(iso, todayISO) {
  if (!iso) return '—';
  return dayLabel(iso, !todayISO || iso.slice(0, 4) !== todayISO.slice(0, 4));
}

/**
 * "today", "yesterday", "16 days ago"; from 30 days on, the date itself
 * ("12 Oct") when `iso` and `todayISO` are given. `days` may be null ("never").
 */
export function daysAgoText(days, iso, todayISO) {
  if (days == null) {
    if (!iso || !todayISO) return 'never';
    days = toDay(todayISO) - toDay(iso);
  }
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30 || !iso) return `${days} days ago`;
  return dateText(iso, todayISO);
}
