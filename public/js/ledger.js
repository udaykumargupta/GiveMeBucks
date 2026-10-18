// The money rules (spec §3): every number on the page is derived here from
// (doc, today). Public methods take and return ISO dates ('YYYY-MM-DD');
// integer day numbers are used inside.
import {
  toDay, fromDay, monthKey, addMonths, monthStartDay, monthEndDay, weekStartDay,
  fyStartYear, fyRange, dayLabel, monthLabel, weekLabel, fyLabel, rangeLabel,
} from './dates.js';
import { GROUPS, typeInfo, isSpendable, compareEntries, touches, r2, RISE_PROMPT_MIN } from './model.js';

const INF = Number.POSITIVE_INFINITY;
const STALE_DAYS = 7;
// Kept local (not format.js) so the core has no UI dependency; same output as money().
const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
export function inr(v) {
  const n = Math.round(Math.abs(v));
  return `${v < 0 && n ? '−' : ''}₹${INR.format(n)}`;
}
const isoOf = (d) => (d == null ? null : fromDay(d));

// ---------------------------------------------------------------- periods
/** { kind, key, start, end, label } for a week (key = Monday ISO), month ('YYYY-MM') or fy (start year). */
export function periodRange(kind, key) {
  if (kind === 'week') {
    const s = weekStartDay(toDay(String(key)));
    return { kind, key: fromDay(s), start: fromDay(s), end: fromDay(s + 6), label: weekLabel(s) };
  }
  if (kind === 'month') return { kind, key, start: fromDay(monthStartDay(key)), end: fromDay(monthEndDay(key)), label: monthLabel(key) };
  if (kind === 'fy') {
    const y = Number(key);
    const [a, b] = fyRange(y);
    return { kind, key: y, start: fromDay(a), end: fromDay(b), label: fyLabel(y) };
  }
  throw new Error(`Unknown period kind ${kind}`);
}
/** The key of the period of `kind` containing `dateISO`. */
export function periodKey(kind, dateISO) {
  if (kind === 'week') return fromDay(weekStartDay(toDay(dateISO)));
  if (kind === 'month') return monthKey(dateISO);
  if (kind === 'fy') return fyStartYear(dateISO);
  throw new Error(`Unknown period kind ${kind}`);
}
/** The key `n` periods after `key` (negative n goes back). */
export function shiftPeriod(kind, key, n) {
  if (kind === 'week') return fromDay(toDay(key) + 7 * n);
  if (kind === 'month') return addMonths(key, n);
  if (kind === 'fy') return Number(key) + n;
  throw new Error(`Unknown period kind ${kind}`);
}

/**
 * The one-line preview under a balance row: { kind, text }. kind is one of
 * starting | correction | spent | asExpected | refund | rise | up | down | same.
 * `rise` = an unexplained rise ≥ ₹1,000 on bank/cash with no answer yet (the four choices are required).
 */
export function balanceLine({ name, spendable, adj, sinceDate, anchorDate, date, starting, backfill, correction, choice }) {
  const since = sinceDate ? dayLabel(sinceDate) : '';
  if (backfill) return { kind: 'starting', text: `This becomes ${name}'s new starting balance` };
  if (starting) return { kind: 'starting', text: 'Starting balance' };
  if (correction) {
    if (!spendable) return { kind: 'correction', text: `The ${inr(Math.abs(adj))} change won't count as growth` };
    const range = rangeLabel(anchorDate ? toDay(anchorDate) + 1 : date, date);
    return { kind: 'correction', text: `Spending for ${range} will count as ₹0, and the ${inr(Math.abs(adj))} won't count as growth` };
  }
  if (spendable) {
    if (adj < 0) return { kind: 'spent', text: `Spent ${inr(-adj)} since ${since}` };
    if (adj === 0) return { kind: 'asExpected', text: 'As expected' };
    if (adj < RISE_PROMPT_MIN || choice === 'refund') return { kind: 'refund', text: `${inr(adj)} more than expected — counted as a refund` };
    return { kind: 'rise', text: `${inr(adj)} more than expected` };
  }
  if (adj > 0) return { kind: 'up', text: `Up ${inr(adj)} since ${since}` };
  if (adj < 0) return { kind: 'down', text: `Down ${inr(-adj)} since ${since}` };
  return { kind: 'same', text: `No change since ${since}` };
}

export class Ledger {
  constructor(doc, todayISO) {
    this.doc = doc;
    this.todayISO = todayISO;
    this.today = toDay(todayISO);
    this.places = doc.places;
    this.P = new Map();
    for (const place of doc.places) {
      this.P.set(place.id, {
        place,
        created: toDay(place.createdOn),
        closed: place.closedOn ? toDay(place.closedOn) : null,
        spendable: isSpendable(place.type),
        E: [], tl: [], sets: [],
      });
    }
    const known = (e) => (e.kind === 'move' ? this.P.has(e.fromId) && this.P.has(e.toId) && e.fromId !== e.toId : this.P.has(e.placeId));
    const sorted = doc.entries.filter(known).sort(compareEntries).map((e) => ({ e, day: toDay(e.date) }));
    this.entries = sorted.filter((x) => x.day <= this.today);
    this.future = sorted.filter((x) => x.day > this.today);
    for (const x of this.entries) for (const id of x.e.kind === 'move' ? [x.e.fromId, x.e.toId] : [x.e.placeId]) this.P.get(id).E.push(x);

    this.sets = [];
    this.setById = new Map();
    for (const [pid, P] of this.P) {
      let v = null, prevDay = null, added = 0, movedIn = 0, movedOut = 0;
      for (const x of P.E) {
        const e = x.e;
        if (e.kind === 'set') {
          const before = v;
          const expected = before ?? 0;
          const adj = r2(e.amount - expected);
          const baseline = e.baseline === true;
          const anchor = Math.min(prevDay ?? P.created - 1, x.day - 1);
          const s = {
            e, id: e.id, placeId: pid, P, day: x.day, before, expected, adj, baseline,
            starting: baseline && x.day === P.created, anchor, L: x.day - anchor,
            prevSetDay: prevDay, added: r2(added), movedIn: r2(movedIn), movedOut: r2(movedOut),
          };
          P.sets.push(s);
          this.sets.push(s);
          this.setById.set(e.id, s);
          v = e.amount; prevDay = x.day; added = movedIn = movedOut = 0;
        } else {
          let f;
          if (e.kind === 'add') { f = e.amount; added += f; }
          else if (e.toId === pid) { f = e.amount; movedIn += f; }
          else { f = -e.amount; movedOut += e.amount; }
          v = r2((v ?? 0) + f);
        }
        P.tl.push({ day: x.day, value: v, e });
      }
    }
    this.sets.sort((a, b) => compareEntries(a.e, b.e));
    this._kt = new Map();
  }

  // ------------------------------------------------------------ places
  place(id) { return this.P.get(id)?.place; }
  name(id) { return this.P.get(id)?.place.name ?? '?'; }
  /** Closed means closedOn ≤ today. */
  isOpen(id) { const P = this.P.get(id); return !!P && (P.closed == null || P.closed > this.today); }
  openPlaces() { return this.places.filter((p) => this.isOpen(p.id)); }
  closedPlaces() { return this.places.filter((p) => !this.isOpen(p.id)); }

  // ------------------------------------------------------------ values
  /** A place's value at the end of `dateISO`, or null before anything is recorded. */
  valueAt(id, dateISO) { return this._valueAt(id, typeof dateISO === 'number' ? dateISO : toDay(dateISO)); }
  _valueAt(id, day) {
    const tl = this.P.get(id)?.tl;
    if (!tl) return null;
    let lo = 0, hi = tl.length - 1, v = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tl[mid].day <= day) { v = tl[mid].value; lo = mid + 1; } else hi = mid - 1;
    }
    return v;
  }
  current(id) { return this._valueAt(id, this.today); }
  netWorthAt(dateISO) { return this._nw(toDay(dateISO)); }
  _nw(day) { let s = 0; for (const id of this.P.keys()) s += this._valueAt(id, day) ?? 0; return r2(s); }
  netWorth() { return this._nw(this.today); }

  /** Day of p's last set dated ≤ today (ISO), or null. */
  lastSetDate(id) { return isoOf(this._lastSet(this.P.get(id))); }
  _lastSet(P) { return P && P.sets.length ? P.sets[P.sets.length - 1].day : null; }
  /** The latest set date on any place (the "updated …" line), or null. */
  latestSetDate() { return this.sets.length ? isoOf(Math.max(...this.sets.map((s) => s.day))) : null; }
  hasStartingBalance(id) { return this.P.get(id)?.sets.some((s) => s.starting) ?? false; }

  /** The derived facts of a saved set dated ≤ today (null otherwise). */
  setInfo(id) {
    const s = this.setById.get(id);
    return s ? this._setInfo(s) : null;
  }
  _setInfo(s) {
    const spendable = s.P.spendable;
    const correction = s.baseline && !s.starting;
    return {
      id: s.id, placeId: s.placeId, date: s.e.date, amount: s.e.amount,
      before: s.before, expected: s.expected, adj: s.adj,
      baseline: s.baseline, starting: s.starting, correction,
      anchorDate: fromDay(s.anchor), sinceDate: this._sinceDate(s), L: s.L,
      start: r2(s.expected - s.added - s.movedIn + s.movedOut),
      added: s.added, movedIn: s.movedIn, movedOut: s.movedOut,
      spendable,
      spent: spendable && !s.baseline ? r2(-s.adj) : 0,
      caption: this._setCaption(s),
    };
  }
  _sinceDate(s) { return fromDay(s.prevSetDay ?? s.P.created); }
  _setCaption(s) {
    if (s.starting) return { type: 'starting', text: 'Starting balance' };
    if (s.baseline) return { type: 'correction', text: 'Correction (not counted)' };
    const since = this._sinceDate(s);
    if (s.P.spendable) {
      const spent = r2(-s.adj);
      if (spent > 0) return { type: 'spent', amount: spent, since, text: `Spent ${inr(spent)} since ${dayLabel(since)}` };
      if (spent < 0) return { type: 'rise', amount: -spent, since, explain: true, text: `${inr(-spent)} more than expected` };
      return { type: 'asExpected', text: 'As expected' };
    }
    if (s.adj > 0) return { type: 'up', amount: s.adj, since, text: `Up ${inr(s.adj)}` };
    if (s.adj < 0) return { type: 'down', amount: -s.adj, since, text: `Down ${inr(-s.adj)}` };
    return { type: 'same', since, text: 'No change' };
  }
  _flowCaption(e, perspective) {
    if (e.kind === 'add') return { type: 'add', amount: e.amount, note: e.note || null, text: `Added ${inr(e.amount)}${e.note ? ` · ${e.note}` : ''}` };
    const incoming = perspective && perspective === e.toId;
    return {
      type: 'move', amount: e.amount, fromId: e.fromId, toId: e.toId, note: e.note || null,
      text: incoming ? `Moved ${inr(e.amount)} from ${this.name(e.fromId)}` : `Moved ${inr(e.amount)} to ${this.name(e.toId)}`,
    };
  }
  /** Caption for any entry (sets dated after today get a plain "Balance ₹X"). */
  caption(entryOrId, perspective) {
    const e = typeof entryOrId === 'string' ? this.doc.entries.find((x) => x.id === entryOrId) : entryOrId;
    if (!e) return null;
    if (e.kind !== 'set') return this._flowCaption(e, perspective);
    const s = this.setById.get(e.id);
    return s ? this._setCaption(s) : { type: 'balance', text: `Balance ${inr(e.amount)}` };
  }

  /** Flows recorded since the place's last set: { sinceDate, start, added, movedIn, movedOut, value }. */
  pending(id) {
    const P = this.P.get(id);
    if (!P) return null;
    const last = P.sets[P.sets.length - 1];
    let added = 0, movedIn = 0, movedOut = 0, firstDate = null;
    for (const x of P.E) {
      if (last && compareEntries(x.e, last.e) <= 0) continue;
      if (x.e.kind === 'add') added += x.e.amount;
      else if (x.e.toId === id) movedIn += x.e.amount;
      else movedOut += x.e.amount;
      firstDate = firstDate ?? x.e.date;
    }
    return {
      sinceDate: last ? last.e.date : null, start: last ? last.e.amount : 0, firstDate,
      added: r2(added), movedIn: r2(movedIn), movedOut: r2(movedOut), value: this.current(id),
    };
  }

  /**
   * What an Update-balances row sees for `placeId` on `dateISO` before anything is typed:
   * { expected, sinceDate, replaces: { id, amount, starting } | null, backfill, breakdown }.
   * Expected excludes a set already on that day (saving replaces it). `backfill` = the date is
   * before createdOn (the new balance becomes the starting balance; expected is null).
   */
  expectedAt(id, dateISO) {
    const P = this.P.get(id);
    if (!P) return null;
    if (toDay(dateISO) < P.created) return { expected: null, sinceDate: null, replaces: null, backfill: true, breakdown: null };
    const all = this.doc.entries.filter((e) => touches(e, id) && e.date <= dateISO).sort(compareEntries);
    const same = all.find((e) => e.kind === 'set' && e.date === dateISO) || null;
    let v = null, startDate = null, start = 0, added = 0, movedIn = 0, movedOut = 0;
    for (const e of all) {
      if (e === same) continue;
      if (e.kind === 'set') { v = e.amount; startDate = e.date; start = e.amount; added = movedIn = movedOut = 0; continue; }
      if (e.kind === 'add') added += e.amount;
      else if (e.toId === id) movedIn += e.amount;
      else movedOut += e.amount;
      v = r2((v ?? 0) + (e.kind === 'add' || e.toId === id ? e.amount : -e.amount));
    }
    return {
      expected: r2(v ?? 0),
      sinceDate: startDate ?? P.place.createdOn,
      replaces: same ? { id: same.id, amount: same.amount, starting: same.baseline === true && same.date === P.place.createdOn } : null,
      backfill: false,
      breakdown: { startDate, start, added: r2(added), movedIn: r2(movedIn), movedOut: r2(movedOut) },
    };
  }

  /**
   * The live preview of typing `amount` for `placeId` on `dateISO` (choice = the rise answer, if any):
   * { ...expectedAt(), amount, adj, spent, rise, needsChoice, kind, text }. See balanceLine() for kind/text.
   */
  previewSet(id, dateISO, amount, choice = null) {
    const P = this.P.get(id);
    const pre = this.expectedAt(id, dateISO);
    if (!pre) return null;
    const amt = r2(Number(amount));
    const starting = pre.backfill || !!(pre.replaces && pre.replaces.starting);
    const adj = starting ? 0 : r2(amt - pre.expected);
    const spendable = P.spendable;
    const correction = !starting && choice === 'correction';
    const rise = spendable && !starting && !correction ? Math.max(0, adj) : 0;
    const anchorDate = pre.backfill ? null : pre.breakdown.startDate ?? fromDay(P.created - 1);
    const line = balanceLine({
      name: P.place.name, spendable, adj, amount: amt, sinceDate: pre.sinceDate, anchorDate, date: dateISO,
      starting, backfill: pre.backfill, correction, choice,
    });
    return {
      ...pre, amount: amt, adj,
      spent: spendable && !starting && !correction ? r2(-adj) : 0,
      rise, needsChoice: rise >= RISE_PROMPT_MIN && !choice, ...line,
    };
  }

  // ------------------------------------------------------------ series and history
  /**
   * Net worth on every day with entries, plus today: [{ date, nw, change, baseline, starting }].
   * `baseline` = starting balances + corrections that day (not growth); `starting` = the starting-balance part.
   */
  trend() {
    const points = this._days();
    const last = points[points.length - 1];
    if (!last || last.day !== this.today) points.push({ day: this.today, nw: this._nw(this.today), baseline: 0, starting: 0, entries: [] });
    let prev = 0;
    return points.map((p) => {
      const out = { date: fromDay(p.day), nw: p.nw, change: r2(p.nw - prev), baseline: p.baseline, starting: p.starting };
      prev = p.nw;
      return out;
    });
  }
  // One record per day with entries ≤ today, oldest first, with NW at the end of the day.
  _days() {
    const vals = new Map();
    let nw = 0;
    const out = [];
    for (const x of this.entries) {
      let row = out[out.length - 1];
      if (!row || row.day !== x.day) { row = { day: x.day, nw: 0, baseline: 0, starting: 0, entries: [] }; out.push(row); }
      for (const pid of x.e.kind === 'move' ? [x.e.fromId, x.e.toId] : [x.e.placeId]) {
        const old = vals.get(pid) ?? 0;
        let v;
        if (x.e.kind === 'set') v = x.e.amount;
        else if (x.e.kind === 'add') v = old + x.e.amount;
        else v = old + (x.e.toId === pid ? x.e.amount : -x.e.amount);
        nw += v - old;
        vals.set(pid, v);
      }
      row.nw = r2(nw);
      row.entries.push(x.e);
      const s = this.setById.get(x.e.id);
      if (s && s.baseline) row.baseline = r2(row.baseline + s.adj);
      if (s && s.starting) row.starting = r2(row.starting + s.adj);
    }
    return out;
  }
  /**
   * Net-worth history, newest first: [{ date, nw, change, baseline, entries: [{ id, kind, entry, caption }] }].
   * `baseline` is the sum of starting balances and corrections that day (not growth).
   */
  history() {
    const days = this._days();
    let prev = 0;
    const rows = days.map((d) => {
      const row = {
        date: fromDay(d.day), nw: d.nw, change: r2(d.nw - prev), baseline: d.baseline,
        entries: d.entries.map((e) => ({ id: e.id, kind: e.kind, entry: e, caption: this.caption(e) })),
      };
      prev = d.nw;
      return row;
    });
    return rows.reverse();
  }
  /** Entries dated after today ("Tomorrow"), oldest first, optionally for one place. */
  upcoming(placeId) {
    return this.future.filter((x) => !placeId || touches(x.e, placeId))
      .map((x) => ({ id: x.e.id, kind: x.e.kind, date: x.e.date, entry: x.e, caption: this.caption(x.e, placeId) }));
  }
  /** One place's history, newest first: [{ id, kind, date, entry, value (running), set, caption }]. */
  placeHistory(id) {
    const P = this.P.get(id);
    if (!P) return [];
    return P.tl.map((t) => ({
      id: t.e.id, kind: t.e.kind, date: t.e.date, entry: t.e, value: t.value,
      set: t.e.kind === 'set', caption: this.caption(t.e, id),
    })).reverse();
  }
  /**
   * A place's value per day with entries (end of day), oldest first, plus a carried-forward
   * point at today (or the close date): [{ date, value, set }]. `set` marks recorded balances.
   */
  placeSeries(id, { from } = {}) {
    const P = this.P.get(id);
    if (!P) return [];
    const fromDayN = from ? toDay(from) : -INF;
    const out = [];
    for (const t of P.tl) {
      const last = out[out.length - 1];
      if (last && last.day === t.day) { last.value = t.value; last.set = last.set || t.e.kind === 'set'; } else out.push({ day: t.day, value: t.value, set: t.e.kind === 'set' });
    }
    const endDay = Math.min(this.today, P.closed ?? INF);
    let points = out.filter((p) => p.day >= fromDayN);
    if (fromDayN > -INF && points.length !== out.length && fromDayN <= endDay) {
      const v = this._valueAt(id, fromDayN);
      if (v != null && (!points.length || points[0].day > fromDayN)) points = [{ day: fromDayN, value: v, set: false }, ...points];
    }
    const last = points[points.length - 1];
    if (last && last.day < endDay) points.push({ day: endDay, value: last.value, set: false });
    return points.map((p) => ({ date: fromDay(p.day), value: p.value, set: p.set }));
  }
  /** The last `days` days of a place's value, for the 64×20 sparkline. */
  sparkline(id, days = 90) { return this.placeSeries(id, { from: fromDay(this.today - days + 1) }); }

  // ------------------------------------------------------------ spending and growth
  _overlap(s, a, b) {
    const lo = Math.max(s.anchor + 1, a), hi = Math.min(s.day, b);
    return hi >= lo ? hi - lo + 1 : 0;
  }
  _range(aISO, bISO) { return [toDay(aISO), Math.min(toDay(bISO), this.today)]; }
  /** Spending in [a, b] (b capped at today), optionally for one place. Unrounded. */
  spentIn(aISO, bISO, placeId) {
    const [a, b] = this._range(aISO, bISO);
    let sum = 0;
    for (const s of this.sets) {
      if (s.baseline || !s.P.spendable || (placeId && s.placeId !== placeId)) continue;
      const d = this._overlap(s, a, b);
      if (d) sum += (-s.adj / s.L) * d;
    }
    return sum;
  }
  /** Money added from outside (adds) dated in [a, b]. */
  addsIn(aISO, bISO) {
    const [a, b] = this._range(aISO, bISO);
    let sum = 0;
    for (const x of this.entries) if (x.e.kind === 'add' && x.day >= a && x.day <= b) sum += x.e.amount;
    return sum;
  }
  /** Investment gains/losses in [a, b], spread like spending. */
  investIn(aISO, bISO, placeId) {
    const [a, b] = this._range(aISO, bISO);
    let sum = 0;
    for (const s of this.sets) {
      if (s.baseline || s.P.spendable || (placeId && s.placeId !== placeId)) continue;
      const d = this._overlap(s, a, b);
      if (d) sum += (s.adj / s.L) * d;
    }
    return sum;
  }
  /** Starting balances and corrections (Σ adj of baseline sets) dated in [a, b]. */
  baselineIn(aISO, bISO) {
    const [a, b] = this._range(aISO, bISO);
    let sum = 0;
    for (const s of this.sets) if (s.baseline && s.day >= a && s.day <= b) sum += s.adj;
    return sum;
  }
  /** Net-worth growth in [a, b] = adds − spent + invest. */
  growthIn(aISO, bISO) {
    const [a, b] = this._range(aISO, bISO);
    let sum = this.addsIn(aISO, bISO);
    for (const s of this.sets) {
      if (s.baseline) continue;
      const d = this._overlap(s, a, b);
      if (d) sum += (s.adj / s.L) * d;
    }
    return sum;
  }

  // ------------------------------------------------------------ coverage
  _T(P) { return P.sets.some((s) => s.starting) ? P.created : P.created - 1; }
  _end(P) { return Math.min(this.today, P.closed ?? INF); }
  _knownThrough(P) {
    if (this._kt.has(P)) return this._kt.get(P);
    const base = this._lastSet(P) ?? this._T(P);
    let k;
    if (r2(this._valueAt(P.place.id, base) ?? 0) !== 0) k = base;
    else {
      const next = P.E.find((x) => x.e.kind !== 'set' && x.day > base);
      k = next ? Math.min(next.day - 1, this._end(P)) : this._end(P);
    }
    this._kt.set(P, k);
    return k;
  }
  /** The last day whose spending is known for a spendable place (ISO). */
  knownThrough(id) { const P = this.P.get(id); return P ? fromDay(this._knownThrough(P)) : null; }
  _spendables() { return [...this.P.values()].filter((P) => P.spendable); }
  _openSpendables() { return this._spendables().filter((P) => P.closed == null || P.closed > this.today); }
  /** min knownThrough over open spendable places (ISO), or null. */
  completeThrough() {
    const open = this._openSpendables();
    return open.length ? fromDay(Math.min(...open.map((P) => this._knownThrough(P)))) : null;
  }
  /** Open spendable places behind the others or over a week old, in place order. */
  lagging() {
    const open = this._openSpendables();
    let M = this.today - STALE_DAYS;
    for (const P of open) { const ls = this._lastSet(P); if (ls != null && ls > M) M = ls; }
    return open.filter((P) => this._knownThrough(P) < M).map((P) => P.place.id);
  }
  /** T of §3.5 (ISO): spending is tracked on the days after it. Min over spendable places, or null. */
  trackingStart() {
    const S = this._spendables();
    return S.length ? fromDay(Math.min(...S.map((P) => this._T(P)))) : null;
  }
  /** { status: none|untracked|current|complete|partial, firstTracked, anyKnown, completeSoFar }. */
  periodStatus(aISO, bISO) {
    const a = toDay(aISO), b = toDay(bISO);
    const S = this._spendables();
    if (!S.length) return { status: 'none', firstTracked: false, anyKnown: false, completeSoFar: false };
    const T = Math.min(...S.map((P) => this._T(P)));
    const firstTracked = a <= T && T < b;
    if (b <= T || a > this.today) return { status: 'untracked', firstTracked: false, anyKnown: false, completeSoFar: false };
    let complete = true, anyKnown = false;
    for (const P of S) {
      const lo = Math.max(a, this._T(P) + 1), hi = Math.min(b, this._end(P));
      if (lo > hi) continue;
      const k = this._knownThrough(P);
      if (hi > k) complete = false;
      if (k >= lo) anyKnown = true;
    }
    const current = a <= this.today && this.today <= b;
    return { status: current ? 'current' : complete ? 'complete' : 'partial', firstTracked, anyKnown, completeSoFar: complete };
  }

  /**
   * Everything the Spent card and the Monthly growth bars show for one period:
   * { kind, key, start, end, label, current, spent, adds, invest, baseline, growth,
   *   nwBefore, nwAfter, status, firstTracked, anyKnown, completeSoFar }. Amounts unrounded.
   */
  period(kind, key) {
    const r = periodRange(kind, key);
    const st = this.periodStatus(r.start, r.end);
    const a = toDay(r.start), b = Math.min(toDay(r.end), this.today);
    return {
      ...r,
      current: a <= this.today && this.today <= toDay(r.end),
      spent: this.spentIn(r.start, r.end),
      adds: this.addsIn(r.start, r.end),
      invest: this.investIn(r.start, r.end),
      baseline: this.baselineIn(r.start, r.end),
      growth: this.growthIn(r.start, r.end),
      nwBefore: this._nw(a - 1),
      nwAfter: this._nw(Math.max(b, a - 1)),
      ...st,
    };
  }
  /** The period of `kind` containing today. */
  currentPeriod(kind) { return this.period(kind, periodKey(kind, this.todayISO)); }
  /** The last `n` periods up to the current one, oldest first. */
  periods(kind, n) {
    const cur = periodKey(kind, this.todayISO);
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(this.period(kind, shiftPeriod(kind, cur, -i)));
    return out;
  }
  /** Monthly growth bars: the last `n` months, oldest first (same records as periods('month', n)). */
  monthlyGrowth(n = 12) { return this.periods('month', n); }
  /** True once some bank/cash balance update (not a starting balance) exists. */
  hasSpendingData() { return this.sets.some((s) => s.P.spendable && !s.baseline); }

  /**
   * "How this was worked out" for [a, b] (or a period object):
   * { start, end, spent, places: [{ placeId, name, spent, knownThrough, behind, lastSetDate, lagging, gaps: [...] }],
   *   notCounted: [{ placeId, name, amount }] }. `behind`: spending in the period (up to today and the
   *   place's close) isn't fully known for that place. Each gap:
   * { setId, anchorDate, setDate, start, added, movedIn, movedOut, expected, entered, spent, days, daysInPeriod, inPeriod }.
   */
  explain(aOrPeriod, bISO) {
    const [aISO, endISO] = typeof aOrPeriod === 'object' ? [aOrPeriod.start, aOrPeriod.end] : [aOrPeriod, bISO];
    const [a, b] = this._range(aISO, endISO);
    const lag = new Set(this.lagging());
    const places = [];
    const notCounted = [];
    for (const P of this.P.values()) {
      const id = P.place.id;
      if (!P.spendable) {
        const amount = this.investIn(aISO, endISO, id);
        if (r2(amount) !== 0) notCounted.push({ placeId: id, name: P.place.name, amount: r2(amount) });
        continue;
      }
      const gaps = [];
      for (const s of P.sets) {
        if (s.baseline) continue;
        const d = this._overlap(s, a, b);
        if (!d) continue;
        const spent = r2(-s.adj);
        gaps.push({
          setId: s.id, anchorDate: fromDay(s.anchor), setDate: s.e.date,
          start: r2(s.expected - s.added - s.movedIn + s.movedOut), added: s.added, movedIn: s.movedIn, movedOut: s.movedOut,
          expected: s.expected, entered: s.e.amount, spent, days: s.L, daysInPeriod: d, inPeriod: r2((spent / s.L) * d),
        });
      }
      // Same test as periodStatus: a place closed in the period is only tracked up to its close.
      const hi = Math.min(b, this._end(P));
      const tracked = Math.max(a, this._T(P) + 1) <= hi;
      if (!gaps.length && !tracked) continue;
      const k = this._knownThrough(P);
      places.push({
        placeId: id, name: P.place.name, spent: r2(this.spentIn(aISO, endISO, id)),
        knownThrough: fromDay(k), behind: tracked && hi > k, lastSetDate: isoOf(this._lastSet(P)), lagging: lag.has(id), gaps,
      });
    }
    return { start: aISO, end: endISO, spent: this.spentIn(aISO, endISO), places, notCounted };
  }

  // ------------------------------------------------------------ places card
  /** { id, name, type, typeLabel, group, spendable, open, createdOn, closedOn, value, lastSetDate, daysSinceSet, stale }. */
  placeSummary(id) {
    const P = this.P.get(id);
    if (!P) return null;
    const t = typeInfo(P.place.type);
    const last = this._lastSet(P);
    const open = this.isOpen(id);
    const daysSinceSet = last == null ? null : this.today - last;
    return {
      id, name: P.place.name, type: P.place.type, typeLabel: t.label, group: t.group, spendable: P.spendable,
      open, createdOn: P.place.createdOn, closedOn: P.place.closedOn || null, value: this.current(id) ?? 0,
      lastSetDate: isoOf(last), daysSinceSet,
      stale: P.spendable && open && (daysSinceSet == null || daysSinceSet > STALE_DAYS),
    };
  }
  /** Open places by group, in doc order: [{ id, label, total, places: [placeSummary] }]. */
  groups() {
    return GROUPS.map((g) => {
      const places = this.places.filter((p) => typeInfo(p.type).group === g.id && this.isOpen(p.id)).map((p) => this.placeSummary(p.id));
      return { id: g.id, label: g.label, total: r2(places.reduce((s, p) => s + p.value, 0)), places };
    });
  }
}
