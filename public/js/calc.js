// Pure finance math, shared by the browser dashboard and the reminder server.
// Dates are ISO strings (YYYY-MM-DD) at the edges and integer "day numbers"
// (days since 1970-01-01, UTC) inside, so arithmetic never trips over DST.

export const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Account kinds and the allocation groups they roll up into. Group order is
// the validated categorical palette order, so it must not be shuffled.
// ---------------------------------------------------------------------------
export const GROUPS = [
  { id: 'bank', label: 'Bank & cash' },
  { id: 'fixed', label: 'Fixed deposits' },
  { id: 'mf', label: 'Mutual funds' },
  { id: 'equity', label: 'Stocks' },
  { id: 'retirement', label: 'Retirement' },
  { id: 'other', label: 'Gold, crypto & other' },
];

export const KINDS = {
  bank: { label: 'Bank account', group: 'bank', liquid: true, paidFromBank: false },
  cash: { label: 'Cash / wallet', group: 'bank', liquid: true, paidFromBank: false },
  fd: { label: 'Fixed deposit', group: 'fixed', paidFromBank: true },
  rd: { label: 'Recurring deposit', group: 'fixed', paidFromBank: true },
  mutual_fund: { label: 'Mutual funds', group: 'mf', paidFromBank: true },
  stocks: { label: 'Stocks', group: 'equity', paidFromBank: true },
  ppf: { label: 'PPF', group: 'retirement', paidFromBank: true },
  epf: { label: 'EPF', group: 'retirement', paidFromBank: false },
  nps: { label: 'NPS', group: 'retirement', paidFromBank: true },
  gold: { label: 'Gold', group: 'other', paidFromBank: true },
  crypto: { label: 'Crypto', group: 'other', paidFromBank: true },
  other: { label: 'Other investment', group: 'other', paidFromBank: true },
};

export const INCOME_SOURCES = ['Salary', 'Bonus', 'Freelance', 'Interest', 'Dividends', 'Rental', 'Other'];

export const DEFAULT_SETTINGS = {
  owner: '',
  title: 'Wealth Growth',
  goal: { target: 0, by: '' },
  reminders: {
    enabled: true,
    notifyAt: '20:00',
    bankEveryDays: 7,
    investmentEveryDays: 30,
    incomeDay: 1,
  },
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');

export function toDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}
export const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export const monthOf = (iso) => iso.slice(0, 7);
export function addMonths(key, n) {
  let [y, m] = key.split('-').map(Number);
  m += n;
  y += Math.floor((m - 1) / 12);
  m = (((m - 1) % 12) + 12) % 12 + 1;
  return `${y}-${pad(m)}`;
}
export const monthStartDay = (key) => toDay(`${key}-01`);
export const monthEndDay = (key) => toDay(`${addMonths(key, 1)}-01`) - 1;
export function monthsBetween(fromKey, toKey) {
  const out = [];
  for (let k = fromKey; k <= toKey; k = addMonths(k, 1)) out.push(k);
  return out;
}
// Weeks start on Monday. Day 0 (1970-01-01) was a Thursday.
export const weekStartDay = (day) => day - ((day + 3) % 7);

export function yearStartOf(monthKey, mode) {
  const [y, m] = monthKey.split('-').map(Number);
  return mode === 'calendar' || m >= 4 ? y : y - 1;
}
export function yearLabel(startYear, mode) {
  if (mode === 'calendar') return String(startYear);
  return `FY${pad(startYear % 100)}-${pad((startYear + 1) % 100)}`;
}
export function yearMonths(startYear, mode) {
  const first = mode === 'calendar' ? `${startYear}-01` : `${startYear}-04`;
  return Array.from({ length: 12 }, (_, i) => addMonths(first, i));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(key, withYear = true) {
  const [y, m] = key.split('-').map(Number);
  return withYear ? `${MONTHS[m - 1]} '${String(y).slice(2)}` : MONTHS[m - 1];
}
export function monthLabelLong(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export function dayLabel(day, withYear = false) {
  const [y, m, d] = fromDay(day).split('-').map(Number);
  return withYear ? `${d} ${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]}`;
}

export function withDefaults(db) {
  const s = db.settings || {};
  return {
    version: 1,
    rev: db.rev || 0,
    accounts: db.accounts || [],
    snapshots: db.snapshots || [],
    income: db.income || [],
    meta: db.meta || {},
    settings: {
      ...DEFAULT_SETTINGS,
      ...s,
      goal: { ...DEFAULT_SETTINGS.goal, ...(s.goal || {}) },
      reminders: { ...DEFAULT_SETTINGS.reminders, ...(s.reminders || {}) },
    },
  };
}

export const pct = (now, before) => (before ? (now - before) / Math.abs(before) : null);

// ---------------------------------------------------------------------------
// Ledger: indexes the raw db and answers "what was X worth on day D".
// ---------------------------------------------------------------------------
export class Ledger {
  constructor(rawDb, today = todayISO()) {
    this.db = withDefaults(rawDb);
    this.settings = this.db.settings;
    this.todayISO = today;
    this.today = toDay(today);

    this.accounts = this.db.accounts.map((a) => ({ ...a, meta: KINDS[a.kind] || KINDS.other }));
    this.byId = new Map(this.accounts.map((a) => [a.id, a]));

    this.snaps = new Map(this.accounts.map((a) => [a.id, []]));
    for (const s of this.db.snapshots) {
      const list = this.snaps.get(s.accountId);
      if (!list) continue;
      list.push({ ...s, day: toDay(s.date), value: Number(s.value) || 0 });
    }
    for (const [id, list] of this.snaps) {
      list.sort((a, b) => a.day - b.day);
      // Same-day duplicates: the later entry wins.
      const dedup = [];
      for (const s of list) {
        if (dedup.length && dedup[dedup.length - 1].day === s.day) dedup[dedup.length - 1] = s;
        else dedup.push(s);
      }
      // Carry "invested" forward; the first snapshot defaults to its own value.
      let inv = null;
      for (const s of dedup) {
        if (s.invested != null && s.invested !== '') inv = Number(s.invested);
        else if (inv == null) inv = s.value;
        s.inv = inv;
      }
      this.snaps.set(id, dedup);
    }

    this.income = this.db.income
      .map((i) => ({ ...i, day: toDay(i.date), amount: Number(i.amount) || 0, month: i.month || monthOf(i.date) }))
      .sort((a, b) => a.day - b.day);

    this.banks = this.accounts.filter((a) => a.meta.liquid);
    this.investments = this.accounts.filter((a) => !a.meta.liquid);
    this._intervals = null;
  }

  isClosedAt(acc, day) {
    return acc.closedOn && day >= toDay(acc.closedOn);
  }
  isActive(acc) {
    return !this.isClosedAt(acc, this.today);
  }
  isAuto(acc) {
    return acc.kind === 'fd' && acc.fd && Number(acc.fd.principal) > 0 && acc.fd.startDate;
  }
  paidFromBank(acc) {
    return acc.paidFromBank ?? acc.meta.paidFromBank;
  }

  // Quarterly-compounded FD value (the Indian bank default), frozen at maturity.
  fdValue(acc, day) {
    const { principal, rate, startDate, maturityDate } = acc.fd;
    const start = toDay(startDate);
    if (day < start) return null;
    const end = maturityDate ? Math.min(day, toDay(maturityDate)) : day;
    const years = (end - start) / 365;
    return Number(principal) * Math.pow(1 + Number(rate || 0) / 400, 4 * years);
  }

  snapAt(acc, day) {
    const list = this.snaps.get(acc.id) || [];
    let lo = 0, hi = list.length - 1, found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].day <= day) { found = list[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  firstDay(acc) {
    if (this.isAuto(acc)) return toDay(acc.fd.startDate);
    const list = this.snaps.get(acc.id);
    return list && list.length ? list[0].day : null;
  }
  lastUpdatedDay(acc) {
    if (this.isAuto(acc)) return this.today;
    const list = this.snaps.get(acc.id);
    return list && list.length ? list[list.length - 1].day : null;
  }

  // Monthly SIP installments that fell in (afterDay, day]. Between manual
  // updates they are added to both invested and value as an estimate.
  sipBetween(acc, afterDay, day) {
    const sip = acc.sip;
    if (acc.meta.liquid || !sip || !(Number(sip.amount) > 0) || day <= afterDay) return 0;
    let n = 0;
    for (let k = monthOf(fromDay(afterDay)); monthStartDay(k) <= day; k = addMonths(k, 1)) {
      const ms = monthStartDay(k);
      const d = ms + Math.min(Number(sip.day) || 1, monthEndDay(k) - ms + 1) - 1;
      if (d > afterDay && d <= day) n++;
    }
    return n * Number(sip.amount);
  }

  /** Value on `day`, or null when the account was not yet tracked. */
  valueAt(acc, day) {
    if (this.isClosedAt(acc, day)) return 0;
    if (this.isAuto(acc)) return this.fdValue(acc, day);
    const s = this.snapAt(acc, day);
    return s ? s.value + this.sipBetween(acc, s.day, Math.min(day, this.today)) : null;
  }
  investedAt(acc, day) {
    if (acc.meta.liquid) return null;
    if (this.isClosedAt(acc, day)) return 0;
    if (this.isAuto(acc)) return day >= toDay(acc.fd.startDate) ? Number(acc.fd.principal) : null;
    const s = this.snapAt(acc, day);
    return s ? s.inv + this.sipBetween(acc, s.day, Math.min(day, this.today)) : null;
  }
  current(acc) {
    return this.valueAt(acc, this.today) ?? 0;
  }

  // Bank balance for cash-flow maths: before an account's first check-in we
  // assume its first known balance, so adding an account is never "income".
  bankAt(acc, day) {
    const v = this.valueAt(acc, day);
    if (v != null) return v;
    const first = (this.snaps.get(acc.id) || [])[0];
    return first ? first.value : 0;
  }

  // Cumulative money that left the bank accounts for this investment.
  // Closing an investment returns its full value to the bank.
  flowAt(acc, day) {
    if (!this.paidFromBank(acc)) return 0;
    if (this.isClosedAt(acc, day)) {
      const before = toDay(acc.closedOn) - 1;
      return (this.investedAt(acc, before) ?? this.openingFlow(acc)) - (this.valueAt(acc, before) ?? 0);
    }
    const inv = this.investedAt(acc, day);
    return inv != null ? inv : this.openingFlow(acc);
  }
  openingFlow(acc) {
    if (acc.openingFromBank) return 0;
    if (this.isAuto(acc)) return Number(acc.fd.principal);
    const first = (this.snaps.get(acc.id) || [])[0];
    return first ? first.inv : 0;
  }

  totalAt(day, accounts = this.accounts) {
    let sum = 0, any = false;
    for (const a of accounts) {
      const v = this.valueAt(a, day);
      if (v != null) { sum += v; any = true; }
    }
    return any ? sum : null;
  }
  groupAt(groupId, day) {
    return this.totalAt(day, this.accounts.filter((a) => a.meta.group === groupId)) ?? 0;
  }

  /** First day you recorded anything — the start of usable history. FD start
   *  dates only count when nothing else has been recorded yet. */
  get historyStart() {
    let min = null;
    for (const list of this.snaps.values()) if (list.length && (min == null || list[0].day < min)) min = list[0].day;
    for (const i of this.income) if (min == null || i.day < min) min = i.day;
    if (min != null) return min;
    for (const a of this.accounts) {
      const d = this.firstDay(a);
      if (d != null && (min == null || d < min)) min = d;
    }
    return min;
  }

  // ---------------------------------------------------------------- income
  incomeBetween(fromExclusive, toInclusive) {
    let sum = 0;
    for (const i of this.income) if (i.day > fromExclusive && i.day <= toInclusive) sum += i.amount;
    return sum;
  }
  incomeByMonth() {
    const map = new Map();
    for (const i of this.income) {
      const m = map.get(i.month) || { total: 0, bySource: {} };
      m.total += i.amount;
      m.bySource[i.source || 'Other'] = (m.bySource[i.source || 'Other'] || 0) + i.amount;
      map.set(i.month, m);
    }
    return map;
  }
  incomeForMonth(key) {
    let sum = 0;
    for (const i of this.income) if (i.month === key) sum += i.amount;
    return sum;
  }
  /** Cash actually received during a calendar month (by date). */
  receivedInMonth(key) {
    return this.incomeBetween(monthStartDay(key) - 1, monthEndDay(key));
  }

  // -------------------------------------------------------------- expenses
  // Expense between two bank check-ins = what the banks lost, plus income that
  // came in, minus money moved into investments. Each interval's total is
  // spread evenly over its days so weeks and months can be summed fairly.
  get checkinDays() {
    const days = new Set();
    for (const a of this.banks) for (const s of this.snaps.get(a.id) || []) if (s.day <= this.today) days.add(s.day);
    return [...days].sort((a, b) => a - b);
  }
  get intervals() {
    if (this._intervals) return this._intervals;
    const days = this.checkinDays;
    const out = [];
    const bankTotal = (d) => this.banks.reduce((s, a) => s + this.bankAt(a, d), 0);
    const flowTotal = (d) => this.investments.reduce((s, a) => s + this.flowAt(a, d), 0);
    for (let i = 1; i < days.length; i++) {
      const a = days[i - 1], b = days[i];
      const income = this.incomeBetween(a, b);
      const invested = flowTotal(b) - flowTotal(a);
      const amount = bankTotal(a) - bankTotal(b) + income - invested;
      out.push({ from: a, to: b, amount, income, invested, rate: amount / (b - a) });
    }
    this._intervals = out;
    return out;
  }
  /** Expense for days in [start, end]. `covered` = days with check-in data. */
  expenseIn(start, end) {
    let amount = 0, covered = 0, invested = 0;
    for (const iv of this.intervals) {
      const lo = Math.max(iv.from + 1, start), hi = Math.min(iv.to, end);
      if (hi < lo) continue;
      const days = hi - lo + 1;
      amount += iv.rate * days;
      invested += (iv.invested / (iv.to - iv.from)) * days;
      covered += days;
    }
    const wanted = Math.min(end, this.today) - start + 1;
    return { amount: covered ? amount : null, invested, covered, wanted, complete: covered >= wanted && wanted > 0 };
  }
  get lastCheckin() {
    const d = this.checkinDays;
    return d.length ? d[d.length - 1] : null;
  }
  /** Average monthly spend across the last `n` fully covered months. */
  avgMonthlyExpense(n = 3) {
    const vals = [];
    let k = addMonths(monthOf(this.todayISO), -1);
    for (let guard = 0; vals.length < n && guard < 24; guard++, k = addMonths(k, -1)) {
      const e = this.expenseIn(monthStartDay(k), monthEndDay(k));
      if (e.complete) vals.push(e.amount);
    }
    return vals.length ? { value: vals.reduce((a, b) => a + b, 0) / vals.length, months: vals.length } : null;
  }

  // ------------------------------------------------------------ allocation
  allocation(day = this.today) {
    return GROUPS.map((g) => ({ ...g, value: this.groupAt(g.id, day) }));
  }
  holdings() {
    return this.accounts.map((a) => {
      const value = this.current(a);
      const invested = a.meta.liquid ? null : this.investedAt(a, this.today);
      const gain = invested != null ? value - invested : null;
      return {
        acc: a,
        value,
        invested,
        gain,
        ret: invested ? gain / invested : null,
        updated: this.lastUpdatedDay(a),
        active: this.isActive(a),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// What data is missing right now. Drives both the in-app alert list and the
// macOS reminder the server sends.
// ---------------------------------------------------------------------------
export function dueItems(rawDb, today = todayISO()) {
  const L = new Ledger(rawDb, today);
  const r = L.settings.reminders;
  const items = [];
  const ago = (d) => (d == null ? 'never' : `${L.today - d} day${L.today - d === 1 ? '' : 's'} ago`);

  if (!L.accounts.length) {
    items.push({
      id: 'setup', severity: 'warning', action: 'accounts',
      title: 'Add your accounts',
      detail: 'Add your two bank accounts and any FDs or mutual funds to start tracking.',
    });
    return items;
  }

  const staleBanks = L.banks.filter((a) => {
    if (!L.isActive(a)) return false;
    const d = L.lastUpdatedDay(a);
    return d == null || L.today - d >= r.bankEveryDays;
  });
  if (staleBanks.length) {
    const worst = Math.max(...staleBanks.map((a) => (L.lastUpdatedDay(a) == null ? 999 : L.today - L.lastUpdatedDay(a))));
    items.push({
      id: 'bank', severity: worst >= r.bankEveryDays * 2 ? 'critical' : 'warning', action: 'checkin',
      title: 'Update bank balances',
      detail: staleBanks.map((a) => `${a.name} (${ago(L.lastUpdatedDay(a))})`).join(', '),
    });
  }

  // Income: has anything landed since the most recent expected payday?
  const [ty, tm, td] = today.split('-').map(Number);
  const payDay = Math.min(Number(r.incomeDay) || 1, 28);
  let payKey = `${ty}-${pad(tm)}`;
  if (td < payDay) payKey = addMonths(payKey, -1);
  const payday = toDay(`${payKey}-${pad(payDay)}`);
  const graceOver = L.today - payday >= 2;
  const gotPaid = L.income.some((i) => i.day >= payday - 5);
  if (graceOver && !gotPaid) {
    items.push({
      id: 'income', severity: 'warning', action: 'income',
      title: `Log your earnings for ${monthLabel(payKey)}`,
      detail: `Nothing logged since your payday on ${dayLabel(payday)}.`,
    });
  }

  const staleInv = L.investments.filter((a) => {
    if (!L.isActive(a) || L.isAuto(a)) return false;
    const d = L.lastUpdatedDay(a);
    return d == null || L.today - d >= r.investmentEveryDays;
  });
  if (staleInv.length) {
    items.push({
      id: 'investments', severity: 'warning', action: 'checkin',
      title: 'Refresh investment values',
      detail: staleInv.map((a) => `${a.name} (${ago(L.lastUpdatedDay(a))})`).join(', '),
    });
  }

  for (const a of L.investments) {
    if (!L.isAuto(a) || !L.isActive(a) || !a.fd.maturityDate) continue;
    const m = toDay(a.fd.maturityDate);
    if (m <= L.today) {
      items.push({
        id: `fd-${a.id}`, severity: 'warning', action: 'accounts',
        title: `${a.name} has matured`,
        detail: `Matured on ${dayLabel(m, true)}. Close it in Accounts once the payout reaches your bank.`,
      });
    } else if (m - L.today <= 30) {
      items.push({
        id: `fd-${a.id}`, severity: 'info', action: 'accounts',
        title: `${a.name} matures in ${m - L.today} days`,
        detail: `Maturity on ${dayLabel(m, true)} — plan where to reinvest.`,
      });
    }
  }
  return items;
}
