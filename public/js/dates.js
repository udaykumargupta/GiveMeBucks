// Calendar maths shared by the browser and the server. Dates are ISO strings
// (YYYY-MM-DD) at the edges and integer "day numbers" (days since 1970-01-01,
// UTC) inside, so arithmetic never trips over DST or time zones.

export const DAY_MS = 86400000;
const IST_OFFSET_MS = 5.5 * 3600000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');

export function toDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}
export const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** A real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromDay(toDay(s)) === s;
export const addDays = (iso, n) => fromDay(toDay(iso) + n);

/** The device's local date (browser "today"). */
export function todayLocal(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
/** The date in India (server "today"), whatever the host's time zone. */
export const todayIST = (now = new Date()) => fromDay(Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS));

// Months are 'YYYY-MM' keys.
export const monthKey = (iso) => iso.slice(0, 7);
export function addMonths(key, n) {
  let [y, m] = key.split('-').map(Number);
  m += n;
  y += Math.floor((m - 1) / 12);
  m = (((m - 1) % 12) + 12) % 12 + 1;
  return `${y}-${pad(m)}`;
}
export const monthStartDay = (key) => toDay(`${key}-01`);
export const monthEndDay = (key) => toDay(`${addMonths(key, 1)}-01`) - 1;
/** Day number of `day` (1–31) in month `key`, clamped to the month's last day. */
export function occurrenceDay(key, day) {
  const start = monthStartDay(key);
  return start + Math.min(day, monthEndDay(key) - start + 1) - 1;
}

// Weeks run Monday–Sunday. Day 0 (1970-01-01) was a Thursday.
export const weekStartDay = (day) => day - ((day + 3) % 7);

// Financial years run 1 Apr – 31 Mar and are named by the year they start in.
export function fyStartYear(iso) {
  const [y, m] = iso.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}
/** [first day, last day] (day numbers) of the FY starting in April of `startYear`. */
export const fyRange = (startYear) => [toDay(`${startYear}-04-01`), toDay(`${startYear + 1}-04-01`) - 1];

/** "1 Oct", or "1 Oct 2026" with `withYear`. Accepts a day number or an ISO date. */
export function dayLabel(day, withYear = false) {
  const [y, m, d] = (typeof day === 'number' ? fromDay(day) : day).split('-').map(Number);
  return withYear ? `${d} ${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]}`;
}
/** "2–31 Oct", "26 Sep–5 Oct", or one day "5 Oct" (day numbers or ISO dates; same year assumed for short forms). */
export function rangeLabel(from, to) {
  const a = typeof from === 'number' ? fromDay(from) : from;
  const b = typeof to === 'number' ? fromDay(to) : to;
  if (a === b) return dayLabel(a);
  const withYear = a.slice(0, 4) !== b.slice(0, 4);
  if (!withYear && a.slice(0, 7) === b.slice(0, 7)) return `${Number(a.slice(8))}–${dayLabel(b)}`;
  return `${dayLabel(a, withYear)}–${dayLabel(b, withYear)}`;
}
/** "Oct 2026", or "October 2026" with `long`. */
export function monthLabel(key, long = false) {
  const [y, m] = key.split('-').map(Number);
  return `${(long ? MONTHS_LONG : MONTHS)[m - 1]} ${y}`;
}
/** "26 Oct – 1 Nov" for the week starting on `startDay` (a Monday; day number or ISO). */
export function weekLabel(startDay) {
  const s = typeof startDay === 'number' ? startDay : toDay(startDay);
  return `${dayLabel(s)} – ${dayLabel(s + 6)}`;
}
/** "FY 26–27". */
export const fyLabel = (startYear) => `FY ${pad(startYear % 100)}–${pad((startYear + 1) % 100)}`;
