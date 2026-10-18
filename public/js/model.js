// The v2 document: place types, ordering, validation and the v1 → v2
// migration. Pure, no DOM — imported by the browser and by the server.
import { toDay, fromDay, isDate, addDays, todayLocal, monthKey, addMonths, monthEndDay, occurrenceDay, dayLabel } from './dates.js';

// Fixed order: it drives the 3×3 type grid and the grouping.
export const GROUPS = [
  { id: 'cash', label: 'Bank & cash' },
  { id: 'invest', label: 'Savings & investments' },
];
export const TYPES = [
  { id: 'bank', label: 'Bank account', short: 'Bank', name: 'Bank', group: 'cash', spendable: true },
  { id: 'cash', label: 'Cash / wallet', short: 'Cash', name: 'Cash', group: 'cash', spendable: true },
  { id: 'fd', label: 'FD / RD', short: 'FD', name: 'FD', group: 'invest', spendable: false },
  { id: 'sip', label: 'SIP', short: 'SIP', name: 'SIP', group: 'invest', spendable: false },
  { id: 'mutual_fund', label: 'Mutual funds', short: 'Mutual funds', name: 'Mutual funds', group: 'invest', spendable: false },
  { id: 'stocks', label: 'Stocks', short: 'Stocks', name: 'Stocks', group: 'invest', spendable: false },
  { id: 'retirement', label: 'PF / PPF / NPS', short: 'PF', name: 'PF', group: 'invest', spendable: false },
  { id: 'gold', label: 'Gold', short: 'Gold', name: 'Gold', group: 'invest', spendable: false },
  { id: 'other', label: 'Others', short: 'Others', name: 'Other', group: 'invest', spendable: false },
];
const TYPE_BY_ID = new Map(TYPES.map((t) => [t.id, t]));
export const typeInfo = (type) => TYPE_BY_ID.get(type) || TYPE_BY_ID.get('other');
/** Bank and cash are spendable; the type alone decides. Accepts a type id or a place. */
export const isSpendable = (typeOrPlace) => {
  const type = typeof typeOrPlace === 'string' ? typeOrPlace : typeOrPlace && typeOrPlace.type;
  return TYPE_BY_ID.has(type) && TYPE_BY_ID.get(type).spendable;
};

/** A rise on bank or cash at or above this needs an explanation before saving. */
export const RISE_PROMPT_MIN = 1000;
export const LIMITS = { places: 200, entries: 50000, name: 60, placeNote: 200, entryNote: 120, amount: 1e12, minDate: '1990-01-01' };
export const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Round to paise; never returns −0. */
export function r2(x) {
  const v = Math.round(x * 100) / 100;
  return v === 0 ? 0 : v;
}
const hasTwoDecimals = (x) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;

export const emptyDoc = () => ({ version: 2, rev: 0, places: [], entries: [] });
export const isV2 = (doc) => !!doc && doc.version === 2;
export const isV1Shaped = (doc) => !!doc && typeof doc === 'object' && doc.version !== 2
  && (Array.isArray(doc.accounts) || Array.isArray(doc.snapshots) || Array.isArray(doc.income));

/** The place ids an entry touches (one for set/add, two for a move). */
export const entryPlaces = (e) => (e.kind === 'move' ? [e.fromId, e.toId] : [e.placeId]);
export const touches = (e, placeId) => (e.kind === 'move' ? e.fromId === placeId || e.toId === placeId : e.placeId === placeId);

/** Event order: (date, seq, id). */
export function compareEntries(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** floor(max seq) + 1, or 1 for a document without entries. */
export function nextSeq(doc) {
  let max = 0;
  for (const e of doc.entries || []) if (Number.isFinite(e.seq) && e.seq > max) max = e.seq;
  return Math.floor(max) + 1;
}

// ---------------------------------------------------------------------------
// validateDoc(doc, { today }) → { ok: true } | { ok: false, error, path }
// ---------------------------------------------------------------------------
const DOC_KEYS = new Set(['version', 'rev', 'savedAt', 'places', 'entries', 'legacyV1']);
const PLACE_KEYS = new Set(['id', 'name', 'type', 'createdOn', 'closedOn', 'note']);
const COMMON_KEYS = ['id', 'kind', 'date', 'amount', 'seq', 'note', 'at'];
const ENTRY_KEYS = {
  set: new Set([...COMMON_KEYS, 'placeId', 'baseline']),
  add: new Set([...COMMON_KEYS, 'placeId']),
  move: new Set([...COMMON_KEYS, 'fromId', 'toId']),
};
const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isISOTime = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));

export function validateDoc(doc, { today } = {}) {
  const fail = (path, reason) => ({ ok: false, path, error: `${path}: ${reason}` });
  if (!isPlainObject(doc)) return fail('document', 'not a GiveMeBucks document');
  for (const key of Object.keys(doc)) if (!DOC_KEYS.has(key)) return fail(key, 'unknown field');
  if (doc.version !== 2) return fail('version', 'must be 2');
  if ('rev' in doc && !(Number.isInteger(doc.rev) && doc.rev >= 0)) return fail('rev', 'must be a whole number ≥ 0');
  if ('savedAt' in doc && typeof doc.savedAt !== 'string') return fail('savedAt', 'must be a time');
  if ('legacyV1' in doc && !isPlainObject(doc.legacyV1)) return fail('legacyV1', 'must be an object');
  if (!Array.isArray(doc.places)) return fail('places', 'must be a list');
  if (doc.places.length > LIMITS.places) return fail('places', `at most ${LIMITS.places} places`);
  if (!Array.isArray(doc.entries)) return fail('entries', 'must be a list');
  if (doc.entries.length > LIMITS.entries) return fail('entries', `at most ${LIMITS.entries} entries`);

  const maxDate = addDays(isDate(today) ? today : todayLocal(), 1);
  const places = new Map();
  for (let i = 0; i < doc.places.length; i++) {
    const p = doc.places[i];
    const at = (f) => `places[${i}]${f ? `.${f}` : ''}`;
    if (!isPlainObject(p)) return fail(at(), 'must be an object');
    for (const key of Object.keys(p)) if (!PLACE_KEYS.has(key)) return fail(at(key), 'unknown field');
    if (typeof p.id !== 'string' || !PLACE_ID_RE.test(p.id)) return fail(at('id'), 'invalid id');
    if (places.has(p.id)) return fail(at('id'), `duplicate id ${p.id}`);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > LIMITS.name) return fail(at('name'), `must be 1–${LIMITS.name} characters`);
    if (!TYPE_BY_ID.has(p.type)) return fail(at('type'), `unknown type ${JSON.stringify(p.type)}`);
    if (!isDate(p.createdOn)) return fail(at('createdOn'), 'not a real date');
    if (p.createdOn > maxDate) return fail(at('createdOn'), 'is in the future');
    if ('closedOn' in p && (!isDate(p.closedOn) || p.closedOn < p.createdOn)) return fail(at('closedOn'), 'must be a real date on or after createdOn');
    if ('note' in p && (typeof p.note !== 'string' || p.note.length > LIMITS.placeNote)) return fail(at('note'), `at most ${LIMITS.placeNote} characters`);
    places.set(p.id, p);
  }

  const ids = new Set();
  const setDays = new Set();
  for (let i = 0; i < doc.entries.length; i++) {
    const e = doc.entries[i];
    const at = (f) => `entries[${i}]${f ? `.${f}` : ''}`;
    if (!isPlainObject(e)) return fail(at(), 'must be an object');
    const allowed = ENTRY_KEYS[e.kind];
    if (!allowed) return fail(at('kind'), 'must be set, add or move');
    for (const key of Object.keys(e)) if (!allowed.has(key)) return fail(at(key), `not allowed on a ${e.kind}`);
    if (typeof e.id !== 'string' || !ENTRY_ID_RE.test(e.id)) return fail(at('id'), 'invalid id');
    if (ids.has(e.id)) return fail(at('id'), `duplicate id ${e.id}`);
    ids.add(e.id);
    if (!isDate(e.date) || e.date < LIMITS.minDate) return fail(at('date'), 'not a real date');
    if (e.date > maxDate) return fail(at('date'), 'is in the future');
    if (!Number.isFinite(e.seq)) return fail(at('seq'), 'must be a number');
    if ('note' in e && (typeof e.note !== 'string' || e.note.length > LIMITS.entryNote)) return fail(at('note'), `at most ${LIMITS.entryNote} characters`);
    if ('at' in e && !isISOTime(e.at)) return fail(at('at'), 'must be an ISO time');
    if ('baseline' in e && e.baseline !== true) return fail(at('baseline'), 'may only be true');

    let touched;
    if (e.kind === 'move') {
      if (!places.has(e.fromId)) return fail(at('fromId'), 'unknown place');
      if (!places.has(e.toId)) return fail(at('toId'), 'unknown place');
      if (e.fromId === e.toId) return fail(at('toId'), 'must differ from fromId');
      touched = [places.get(e.fromId), places.get(e.toId)];
    } else {
      if (!places.has(e.placeId)) return fail(at('placeId'), 'unknown place');
      touched = [places.get(e.placeId)];
    }
    const amount = e.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > LIMITS.amount) return fail(at('amount'), 'must be a number up to 1e12');
    if (!hasTwoDecimals(amount)) return fail(at('amount'), 'at most 2 decimals');
    if (e.kind === 'set') {
      if (amount < 0 && !isSpendable(touched[0].type)) return fail(at('amount'), 'only bank or cash can be negative');
    } else if (!(amount > 0)) return fail(at('amount'), 'must be more than 0');

    for (const p of touched) {
      if (e.date < p.createdOn) return fail(at('date'), `before ${p.id} was created (${p.createdOn})`);
      if (p.closedOn && e.date > p.closedOn) return fail(at('date'), `after ${p.id} was closed (${p.closedOn})`);
    }
    if (e.kind === 'set') {
      const key = `${e.placeId}|${e.date}`;
      if (setDays.has(key)) return fail(at('date'), `a second balance for ${e.placeId} on ${e.date}`);
      setDays.add(key);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// migrate(v1, todayISO, nowISO) → v2 document (rev 0). Pure and deterministic.
// Monthly rules are not part of v2; SIP installments become plain moves.
// ---------------------------------------------------------------------------
export const SAMPLE_ACCOUNT_IDS = ['hdfc', 'sbi', 'mf', 'stocks', 'epf', 'gold', 'fd1', 'fd2'];
const V1_TYPE = { bank: 'bank', cash: 'cash', fd: 'fd', rd: 'fd', mutual_fund: 'mutual_fund', stocks: 'stocks', ppf: 'retirement', epf: 'retirement', nps: 'retirement', gold: 'gold', crypto: 'other', other: 'other' };
const MERGED_KIND_LABEL = { rd: 'RD', ppf: 'PPF', epf: 'EPF', nps: 'NPS', crypto: 'Crypto' };
const arr = (x) => (Array.isArray(x) ? x : []);
const nonEmpty = (o) => isPlainObject(o) && Object.keys(o).length > 0;
const numeric = (x) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) && Number.isFinite(Number(x));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Quarterly-compounded FD value (the v1 formula), frozen at maturity. */
export function fdValue(fd, day) {
  const start = toDay(fd.startDate);
  const end = isDate(fd.maturityDate) ? Math.min(day, toDay(fd.maturityDate)) : day;
  return Number(fd.principal) * Math.pow(1 + Number(fd.rate || 0) / 400, (4 * (end - start)) / 365);
}

export function migrate(input, todayISO, nowISO) {
  if (isV2(input)) return input;
  if (!isPlainObject(input)) return emptyDoc();
  const today = toDay(todayISO);
  const report = {
    places: 0, entries: 0, droppedIncomeBeforeTracking: 0, droppedFutureDated: 0, droppedAfterClose: 0,
    droppedInvalid: 0, replacedSameDay: 0, estimatedFdValues: 0, futureFds: [], sampleRemoved: null,
  };
  let accounts = arr(input.accounts), snapshots = arr(input.snapshots), income = arr(input.income);
  if (input.meta && input.meta.sample === true) {
    const sample = new Set(SAMPLE_ACCOUNT_IDS);
    const keptAccounts = accounts.filter((a) => !(a && sample.has(a.id)));
    const kept = new Set(keptAccounts.map((a) => a && a.id));
    const keptSnaps = snapshots.filter((s) => s && kept.has(s.accountId));
    const keptIncome = income.filter((i) => !(i && /^i\d+$/.test(String(i.id))));
    report.sampleRemoved = { accounts: accounts.length - keptAccounts.length, snapshots: snapshots.length - keptSnaps.length, income: income.length - keptIncome.length };
    accounts = keptAccounts; snapshots = keptSnaps; income = keptIncome;
  }
  const { rev, savedAt, ...archived } = input;
  const legacy = () => ({ migratedAt: nowISO, report, doc: clone(archived) });
  if (!accounts.length && !snapshots.length && !income.length) {
    const keep = report.sampleRemoved || nonEmpty(input.settings) || nonEmpty(input.meta);
    return keep ? { ...emptyDoc(), legacyV1: legacy() } : emptyDoc();
  }

  // 1. Places, one per account in the same order.
  const seenIds = new Set();
  const acc = accounts.map((a, i) => {
    if (!isPlainObject(a)) return null;
    let id = String(a.id ?? '');
    if (!PLACE_ID_RE.test(id) || seenIds.has(id)) id = `mig-p${i + 1}`;
    seenIds.add(id);
    const kind = a.kind;
    const sipAmount = a.sip && numeric(a.sip.amount) ? r2(Number(a.sip.amount)) : 0;
    const type = kind === 'mutual_fund' && sipAmount > 0 ? 'sip' : (V1_TYPE[kind] ?? 'other');
    const auto = kind === 'fd' && isPlainObject(a.fd) && Number(a.fd.principal) > 0 && isDate(a.fd.startDate);
    let fdTerms = null;
    if (kind === 'fd' && isPlainObject(a.fd) && isDate(a.fd.startDate)) {
      const rate = `${Number(a.fd.rate) || 0}%`;
      fdTerms = isDate(a.fd.maturityDate)
        ? `${rate} · ${dayLabel(a.fd.startDate, true)} → ${dayLabel(a.fd.maturityDate, true)}`
        : `${rate} · from ${dayLabel(a.fd.startDate, true)}`;
    }
    const institution = typeof a.institution === 'string' ? a.institution.trim() : '';
    const note = [MERGED_KIND_LABEL[kind], institution, fdTerms].filter(Boolean).join(' · ').slice(0, LIMITS.placeNote);
    const closedOn = isDate(a.closedOn) && toDay(a.closedOn) <= today ? a.closedOn : null;
    return {
      raw: a, index: i, oldId: a.id, id, auto,
      liquid: kind === 'bank' || kind === 'cash',
      pfb: a.paidFromBank ?? !['bank', 'cash', 'epf'].includes(kind),
      sip: sipAmount > 0 ? { amount: sipAmount, day: Math.min(31, Math.max(1, Math.round(Number(a.sip.day) || 1))) } : null,
      closed: closedOn ? toDay(closedOn) : null,
      closedOn,
      place: { id, name: String(a.name ?? '').trim().slice(0, LIMITS.name) || 'Place', type, ...(note ? { note } : {}) },
      snaps: [],
    };
  }).filter(Boolean);
  const byOldId = new Map();
  for (const a of acc) if (!byOldId.has(a.oldId)) byOldId.set(a.oldId, a);

  // 2. Normalise snapshots the way the old Ledger did.
  for (const s of snapshots) {
    const a = s && byOldId.get(s.accountId);
    if (!a || !isDate(s.date) || !numeric(s.value)) { report.droppedInvalid++; continue; }
    if (a.auto) continue; // v1 ignored them; they stay in legacyV1
    const explicit = s.invested != null && s.invested !== '' && numeric(s.invested);
    a.snaps.push({ id: String(s.id), day: toDay(s.date), date: s.date, value: r2(Number(s.value)), explicit, invested: explicit ? Number(s.invested) : null });
  }
  for (const a of acc) {
    a.snaps.sort((x, y) => x.day - y.day); // stable: the later one wins below
    const dedup = [];
    for (const s of a.snaps) {
      if (dedup.length && dedup[dedup.length - 1].day === s.day) { dedup[dedup.length - 1] = s; report.replacedSameDay++; } else dedup.push(s);
    }
    const kept = [];
    for (const s of dedup) {
      if (s.day > today) { report.droppedFutureDated++; continue; }
      if (a.closed != null && s.day >= a.closed) { report.droppedAfterClose++; continue; }
      kept.push(s);
    }
    let inv = null;
    for (const s of kept) { if (s.explicit) inv = s.invested; else if (inv == null) inv = s.value; s.inv = inv; }
    a.snaps = kept;
    a.first = kept.length ? kept[0].day : null;
  }

  // 3. Primary bank and bankFor(day, preferred).
  const withSnaps = (kind) => acc.filter((a) => a.raw.kind === kind && a.snaps.length);
  const pool = withSnaps('bank').length ? withSnaps('bank') : withSnaps('cash');
  const primary = [...pool].sort((x, y) => y.snaps.length - x.snaps.length || x.first - y.first || x.index - y.index)[0] || null;
  const others = acc.filter((a) => a.liquid && a.snaps.length).sort((x, y) => x.first - y.first || x.index - y.index);
  const qualifies = (a, day) => a && a.liquid && a.first != null && a.first < day && !(a.closed != null && day >= a.closed);
  const bankFor = (day, preferred) => [preferred, primary, ...others].find((c) => qualifies(c, day)) || null;

  // 4. Entries. Each carries a phase (0 closing set, 1 flow, 2 other set) for step 6.
  const out = [];
  let emitted = 0;
  const push = (e, phase, idx, order = emitted++) => out.push({ e, phase, idx, order });
  const trackStart = (() => {
    const firsts = acc.filter((a) => !a.auto && a.first != null).map((a) => a.first);
    return firsts.length ? Math.min(...firsts) : null;
  })();
  const installments = (a, afterDay, lastDay) => {
    const list = [];
    if (!a.sip || lastDay <= afterDay) return list;
    for (let k = monthKey(fromDay(afterDay)); toDay(`${k}-01`) <= lastDay; k = addMonths(k, 1)) {
      const d = occurrenceDay(k, a.sip.day);
      if (d > afterDay && d <= lastDay) list.push({ d, k });
    }
    return list;
  };
  const emitInstallment = (a, d, k) => {
    const id = `mig-sip-${a.id}-${k}`;
    const bank = a.pfb ? bankFor(d) : null;
    if (bank) push({ id, kind: 'move', fromId: bank.id, toId: a.id, date: fromDay(d), amount: a.sip.amount, note: 'Monthly' }, 1, a.index);
    else push({ id, kind: 'add', placeId: a.id, date: fromDay(d), amount: a.sip.amount, note: 'SIP' }, 1, a.index);
  };
  const fdEntry = (a, id, day, amount, extra = {}) => {
    report.estimatedFdValues++;
    push({ id, kind: 'set', placeId: a.id, date: fromDay(day), amount: r2(amount), ...extra, note: 'Estimated from FD rate' }, 2, a.index);
  };

  for (const a of acc) {
    if (a.liquid) {
      a.snaps.forEach((s, k) => push({ id: `s-${s.id}`, kind: 'set', placeId: a.id, date: s.date, amount: s.value, ...(k === 0 ? { baseline: true } : {}) }, 2, a.index));
    } else if (!a.auto) {
      let invEst = null;
      a.snaps.forEach((s, k) => {
        if (k === 0) {
          const bank = a.pfb && a.raw.openingFromBank ? bankFor(s.day) : null;
          if (bank && r2(s.inv) > 0) {
            push({ id: `mo-${s.id}`, kind: 'move', fromId: bank.id, toId: a.id, date: s.date, amount: r2(s.inv), note: 'Opening (from old app)' }, 1, a.index);
            push({ id: `s-${s.id}`, kind: 'set', placeId: a.id, date: s.date, amount: s.value }, 2, a.index);
          } else {
            push({ id: `s-${s.id}`, kind: 'set', placeId: a.id, date: s.date, amount: s.value, baseline: true }, 2, a.index);
          }
          invEst = s.inv;
          return;
        }
        const due = installments(a, a.snaps[k - 1].day, s.day);
        for (const { d, k: month } of due) emitInstallment(a, d, month);
        const expectedInv = invEst + due.length * (a.sip ? a.sip.amount : 0);
        if (s.explicit && a.pfb) {
          const residual = r2(s.inv - expectedInv);
          const bank = bankFor(s.day);
          if (residual !== 0 && bank) {
            const [fromId, toId] = residual > 0 ? [bank.id, a.id] : [a.id, bank.id];
            push({ id: `mi-${s.id}`, kind: 'move', fromId, toId, date: s.date, amount: Math.abs(residual), note: 'Adjustment from old app' }, 1, a.index);
          }
        }
        invEst = s.explicit ? s.inv : expectedInv;
        push({ id: `s-${s.id}`, kind: 'set', placeId: a.id, date: s.date, amount: s.value }, 2, a.index);
      });
      if (a.snaps.length) {
        const lastDay = Math.min(today, a.closed != null ? a.closed - 1 : today);
        for (const { d, k } of installments(a, a.snaps[a.snaps.length - 1].day, lastDay)) emitInstallment(a, d, k);
      }
    } else {
      const fd = a.raw.fd;
      const startDay = toDay(fd.startDate);
      const start = trackStart != null && startDay < trackStart ? trackStart : startDay;
      if (startDay > today) {
        report.futureFds.push(a.place.name);
      } else if (a.closed == null || start < a.closed) {
        const principal = r2(Number(fd.principal));
        if (start === startDay) {
          const bank = a.raw.openingFromBank ? bankFor(startDay) : null;
          if (bank) push({ id: `fo-${a.id}`, kind: 'move', fromId: bank.id, toId: a.id, date: fd.startDate, amount: principal, note: 'FD opened' }, 1, a.index);
          else push({ id: `fo-${a.id}`, kind: 'set', placeId: a.id, date: fd.startDate, amount: principal, baseline: true }, 2, a.index);
        } else {
          fdEntry(a, `fs-${a.id}`, start, fdValue(fd, start), { baseline: true });
        }
        const end = Math.min(a.closed != null ? a.closed - 1 : today, isDate(fd.maturityDate) ? toDay(fd.maturityDate) : Infinity);
        let lastMonthEnd = start;
        for (let k = monthKey(fromDay(start)); toDay(`${k}-01`) <= end; k = addMonths(k, 1)) {
          const E = monthEndDay(k);
          if (E > start && E <= end) { fdEntry(a, `fv-${a.id}-${k}`, E, fdValue(fd, E)); lastMonthEnd = E; }
        }
        if (a.closed == null && end > lastMonthEnd && end > start) fdEntry(a, `fv-${a.id}-end`, end, fdValue(fd, end));
      }
    }
  }

  // Income → adds into a tracked bank.
  for (const i of income) {
    const amount = i && numeric(i.amount) ? r2(Number(i.amount)) : NaN;
    if (!i || !isDate(i.date) || !(amount > 0)) { report.droppedInvalid++; continue; }
    const day = toDay(i.date);
    if (day > today) { report.droppedFutureDated++; continue; }
    const pref = i.accountId != null ? byOldId.get(i.accountId) : null;
    if (pref && pref.liquid && !(pref.closed != null && day >= pref.closed) && pref.first != null && pref.first >= day) {
      report.droppedIncomeBeforeTracking++; // already inside that account's opening balance
      continue;
    }
    const bank = bankFor(day, pref);
    if (!bank) { report.droppedIncomeBeforeTracking++; continue; }
    const note = [i.source, i.note].filter((x) => x != null && String(x).trim()).map((x) => String(x).trim()).join(' · ').slice(0, LIMITS.entryNote);
    push({ id: `i-${i.id}`, kind: 'add', placeId: bank.id, date: i.date, amount, ...(note ? { note } : {}) }, 1, bank.index, 1e9 + emitted++);
  }

  // Closed accounts: their value on closedOn − 1 moves to a bank. Done last, in
  // closing order, so the fold sees income and earlier closings into them.
  const byStep6 = (x, y) => (x.e.date < y.e.date ? -1 : x.e.date > y.e.date ? 1 : 0) || x.phase - y.phase || x.idx - y.idx || x.order - y.order;
  for (const a of acc.filter((x) => x.closed != null).sort((x, y) => x.closed - y.closed || x.index - y.index)) {
    const mine = out.filter((o) => touches(o.e, a.id) && o.e.date < a.closedOn).sort(byStep6);
    if (!mine.length) continue;
    let v = 0;
    if (a.auto) v = fdValue(a.raw.fd, a.closed - 1);
    else for (const { e } of mine) v = e.kind === 'set' ? e.amount : v + (e.kind === 'add' || e.toId === a.id ? e.amount : -e.amount);
    v = r2(v);
    const bank = (a.liquid || a.pfb) && v > 0 ? bankFor(a.closed) : null;
    push({ id: `c-${a.id}`, kind: 'set', placeId: a.id, date: a.closedOn, amount: bank ? v : 0, note: 'Closed' }, 0, a.index);
    if (bank) push({ id: `cm-${a.id}`, kind: 'move', fromId: a.id, toId: bank.id, date: a.closedOn, amount: v, note: 'Closed' }, 1, a.index);
  }

  // 5–6. Validate entry by entry, then number them in step-6 order.
  out.sort(byStep6);
  const typeOf = new Map(acc.map((a) => [a.id, a.place.type]));
  const seen = new Set();
  const entries = [];
  for (const { e } of out) {
    const ok = ENTRY_ID_RE.test(e.id) && !seen.has(e.id) && Number.isFinite(e.amount) && Math.abs(e.amount) <= LIMITS.amount
      && e.date >= LIMITS.minDate && (e.kind === 'set' ? e.amount >= 0 || isSpendable(typeOf.get(e.placeId)) : e.amount > 0);
    if (!ok) { report.droppedInvalid++; continue; }
    seen.add(e.id);
    entries.push({ ...e, seq: entries.length + 1 });
  }

  // 7. createdOn = the earliest date among the place's entries.
  const places = acc.map((a) => {
    let createdOn = null;
    for (const e of entries) if (touches(e, a.id) && (createdOn == null || e.date < createdOn)) createdOn = e.date;
    return { ...a.place, createdOn: createdOn || a.closedOn || todayISO, ...(a.closedOn ? { closedOn: a.closedOn } : {}) };
  });

  // 8. Archive.
  report.places = places.length;
  report.entries = entries.length;
  return { version: 2, rev: 0, places, entries, legacyV1: legacy() };
}
