// Pure mutations: fn(doc, params) → { doc, message }. Nothing here touches the
// network or the DOM. Callers generate every new id before calling, keep the
// before-doc for Undo, and catch the Error thrown when an action is refused
// (its message is shown to the person; `code` says which question to ask).
import { isDate, dayLabel, addDays, todayLocal } from './dates.js';
import {
  typeInfo, isSpendable, compareEntries, nextSeq, touches, validateDoc, r2,
  RISE_PROMPT_MIN, LIMITS, PLACE_ID_RE, ENTRY_ID_RE, TYPES,
} from './model.js';
import { Ledger, inr, balanceLine } from './ledger.js';

/** An Error with a human message, plus a machine `code` and extra fields for the UI. */
export function refusal(message, code = 'refused', extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}
const clone = (doc) => structuredClone(doc);

// ---------------------------------------------------------------- shared checks
function placeOf(doc, id) {
  if (!id) throw refusal('Choose a place', 'choose_place');
  const p = doc.places.find((x) => x.id === id);
  if (!p) throw refusal('That place no longer exists — reload and try again', 'missing');
  return p;
}
function checkDate(date, today) {
  if (!isDate(date) || date < LIMITS.minDate) throw refusal('Pick a valid date', 'invalid_date');
  if (date > today) throw refusal('Pick a date up to today', 'future_date');
}
/** The place exists on `date`: not before createdOn, not after closedOn. */
function checkPlaceOn(p, date) {
  if (date < p.createdOn) throw refusal(`${p.name} starts on ${dayLabel(p.createdOn)} — pick that day or later`, 'before_created');
  if (p.closedOn && date > p.closedOn) throw refusal(`${p.name} was closed on ${dayLabel(p.closedOn)}`, 'after_closed');
}
function checkAmount(value, { negative = false, zero = false } = {}) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw refusal('Enter an amount', 'invalid_amount');
  if (Math.abs(n) > LIMITS.amount) throw refusal('That amount is too large', 'invalid_amount');
  const v = r2(n);
  if (v < 0 && !negative) throw refusal('The amount can’t be negative here', 'invalid_amount');
  if (v === 0 && !zero) throw refusal('Enter an amount more than ₹0', 'invalid_amount');
  return v;
}
function checkNewId(doc, id, kind) {
  const re = kind === 'place' ? PLACE_ID_RE : ENTRY_ID_RE;
  const taken = kind === 'place' ? doc.places.some((p) => p.id === id) : doc.entries.some((e) => e.id === id);
  if (typeof id !== 'string' || !re.test(id) || taken) throw refusal('Internal error: bad new id', 'bad_id');
  return id;
}
const cleanNote = (note, max = LIMITS.entryNote) => (typeof note === 'string' && note.trim() ? note.trim().slice(0, max) : null);
const stamp = (at) => (typeof at === 'string' && at ? { at } : {});
const todayOf = (params) => (isDate(params && params.today) ? params.today : todayLocal());

/** Runs validateDoc as a last guard so an action can never produce a document the server rejects. */
function done(doc, today, message, extra = {}) {
  const v = validateDoc(doc, { today });
  if (!v.ok) throw refusal(`Couldn't save this change (${v.error})`, 'invalid_doc', { path: v.path });
  return { doc, message, ...extra };
}

// ---------------------------------------------------------------- same-day check (§3.7)
/**
 * The saved balances on `date` for every place a flow touches:
 * [{ id, placeId, name, amount, date, seq, starting }]. Empty means no question is needed.
 * `flow` = { placeId } for an add, { fromId, toId } for a move, plus `date` and optional `excludeId`.
 */
export function sameDayCheck(doc, flow) {
  const ids = flow.placeId ? [flow.placeId] : [flow.fromId, flow.toId];
  const out = [];
  for (const pid of ids) {
    const p = doc.places.find((x) => x.id === pid);
    const s = p && doc.entries.find((e) => e.kind === 'set' && e.placeId === pid && e.date === flow.date && e.id !== flow.excludeId);
    if (s) out.push({ id: s.id, placeId: pid, name: p.name, amount: s.amount, date: s.date, seq: s.seq, starting: s.baseline === true && s.date === p.createdOn });
  }
  return out;
}
/** "Is ₹15,000 already included in the ₹95,000 you entered for HDFC Savings on 31 Oct?" */
export function sameDayQuestion(amount, sets) {
  if (!sets.length) return null;
  const what = sets.length === 1
    ? `the ${inr(sets[0].amount)} you entered for ${sets[0].name}`
    : `the balances you entered for ${sets.map((s) => s.name).join(' and ')}`;
  return `Is ${inr(amount)} already included in ${what} on ${dayLabel(sets[0].date)}?`;
}
/** §2.3 rule 3: a seq just before saved set S, above every lower same-day entry of the involved places. */
function seqBefore(doc, S, placeIds, excludeIds = []) {
  let lo = 0;
  for (const e of doc.entries) {
    if (e.date !== S.date || excludeIds.includes(e.id) || e.seq >= S.seq) continue;
    if (placeIds.some((id) => touches(e, id)) && e.seq > lo) lo = e.seq;
  }
  return { lo, seq: (lo + S.seq) / 2 };
}
/**
 * Seq for a flow on a day that may already hold saved balances: rule 3 when "included",
 * rule 4 (next) otherwise. Throws the same-day question when it is unanswered.
 */
function flowSeq(doc, flow, amount, included, excludeIds = []) {
  const sets = sameDayCheck(doc, { ...flow, excludeId: excludeIds[0] }).filter((s) => !excludeIds.includes(s.id));
  if (!sets.length || included === false) return { seq: nextSeq(doc), sets };
  if (included !== true) throw refusal(sameDayQuestion(amount, sets), 'same_day', { sets });
  const S = sets.reduce((a, b) => (b.seq < a.seq ? b : a));
  const ids = flow.placeId ? [flow.placeId] : [flow.fromId, flow.toId];
  return { seq: seqBefore(doc, S, ids, excludeIds).seq, sets, before: S };
}

// ---------------------------------------------------------------- names and "same as last"
/** The type's default name, or "FD 2", "FD 3"… when it is taken. */
export function suggestName(doc, type) {
  const base = typeInfo(type).name;
  const taken = new Set(doc.places.map((p) => p.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
const isOpenPlace = (doc, id) => doc.places.some((p) => p.id === id && !p.closedOn);
/** The most recent add into an open place (event order), or null. */
export function lastAdd(doc) {
  let best = null;
  for (const e of doc.entries) if (e.kind === 'add' && isOpenPlace(doc, e.placeId) && (!best || compareEntries(e, best) > 0)) best = e;
  return best;
}
/** The most recent move between two open places (event order), or null. */
export function lastMove(doc) {
  let best = null;
  for (const e of doc.entries) if (e.kind === 'move' && isOpenPlace(doc, e.fromId) && isOpenPlace(doc, e.toId) && (!best || compareEntries(e, best) > 0)) best = e;
  return best;
}

// ---------------------------------------------------------------- places
/**
 * addPlace(doc, { id, type, name?, note?, date, value?, source?: 'had'|'moved'|'new', fromId?, included?, entryId, today, at? })
 * value 0 → place only. 'had' → starting balance; 'moved' → move fromId → new place; 'new' → add "New money".
 */
export function addPlace(doc, params) {
  const today = todayOf(params);
  const next = clone(doc);
  const id = checkNewId(next, params.id, 'place');
  if (!TYPES.some((t) => t.id === params.type)) throw refusal('Choose a type', 'invalid_type');
  const name = (typeof params.name === 'string' && params.name.trim() ? params.name.trim() : suggestName(next, params.type));
  if (name.length > LIMITS.name) throw refusal(`Keep the name under ${LIMITS.name} characters`, 'invalid_name');
  const date = params.date;
  checkDate(date, today);
  const note = cleanNote(params.note, LIMITS.placeNote);
  const place = { id, name, type: params.type, createdOn: date, ...(note ? { note } : {}) };
  const spendable = isSpendable(params.type);
  const value = params.value == null || params.value === '' ? 0 : checkAmount(params.value, { negative: spendable, zero: true });
  const source = params.source ?? (value !== 0 && doc.places.length === 0 ? 'had' : undefined);
  next.places.push(place);
  if (value === 0) return done(next, today, `Added ${name}`);
  if (!source) throw refusal('Choose where it came from', 'choose_source');
  if (value < 0 && source !== 'had') throw refusal('Enter an amount more than ₹0', 'invalid_amount');
  const entryId = checkNewId(next, params.entryId, 'entry');

  if (source === 'had') {
    next.entries.push({ id: entryId, kind: 'set', placeId: id, date, amount: value, seq: nextSeq(next), baseline: true, ...stamp(params.at) });
  } else if (source === 'new') {
    next.entries.push({ id: entryId, kind: 'add', placeId: id, date, amount: value, seq: nextSeq(next), note: 'New money', ...stamp(params.at) });
  } else if (source === 'moved') {
    const from = placeOf(next, params.fromId);
    if (from.id === id) throw refusal('Choose another place', 'invalid_place');
    checkPlaceOn(from, date);
    const { seq } = flowSeq(next, { fromId: from.id, toId: id, date }, value, params.included);
    next.entries.push({ id: entryId, kind: 'move', fromId: from.id, toId: id, date, amount: value, seq, ...stamp(params.at) });
  } else {
    throw refusal('Choose where it came from', 'choose_source');
  }
  return done(next, today, `Added ${name}`);
}

/** editPlace(doc, { id, name?, type?, note? }) — note '' removes it. */
export function editPlace(doc, params) {
  const today = todayOf(params);
  const next = clone(doc);
  const p = placeOf(next, params.id);
  if (params.name !== undefined) {
    const name = String(params.name).trim();
    if (!name) throw refusal('Enter a name', 'invalid_name');
    if (name.length > LIMITS.name) throw refusal(`Keep the name under ${LIMITS.name} characters`, 'invalid_name');
    p.name = name;
  }
  if (params.type !== undefined && params.type !== p.type) {
    if (!TYPES.some((t) => t.id === params.type)) throw refusal('Choose a type', 'invalid_type');
    const negative = next.entries.some((e) => e.kind === 'set' && e.placeId === p.id && e.amount < 0);
    if (!isSpendable(params.type) && negative) throw refusal(`${p.name} has a negative balance — only a bank or cash place can hold one`, 'negative_balance');
    p.type = params.type;
  }
  if (params.note !== undefined) {
    const note = cleanNote(params.note, LIMITS.placeNote);
    if (note) p.note = note; else delete p.note;
  }
  return done(next, today, `Saved ${p.name}`);
}

/**
 * closePlace(doc, { placeId, date, to?, final?, setId, moveId, included?, today, at? })
 * With `to`: set(final) on date, then move(final) to `to` (final defaults to the value then).
 * Without `to` ("Spent or gone"): set(0). Always writes a set on the date, then closedOn = date.
 */
export function closePlace(doc, params) {
  const today = todayOf(params);
  const next = clone(doc);
  const p = placeOf(next, params.placeId);
  if (p.closedOn) throw refusal(`${p.name} is already closed`, 'closed');
  const date = params.date;
  checkDate(date, today);
  checkPlaceOn(p, date);
  if (next.entries.some((e) => touches(e, p.id) && e.date > date)) throw refusal(`${p.name} has entries after ${dayLabel(date)}`, 'entries_after');

  const existing = next.entries.find((e) => e.kind === 'set' && e.placeId === p.id && e.date === date);
  const valueThen = valueOn(next, p.id, date);
  const setId = existing ? existing.id : checkNewId(next, params.setId, 'entry');
  const keep = existing ? { ...(existing.baseline ? { baseline: true } : {}), ...(existing.note ? { note: existing.note } : {}) } : {};

  // "Moved to…" with no target must never fall through to the ₹0 "Spent or gone" close.
  if ('to' in params && !params.to) throw refusal('Choose the place it went to', 'choose_place');
  if (params.to) {
    const to = placeOf(next, params.to);
    if (to.id === p.id) throw refusal('Choose another place', 'invalid_place');
    checkPlaceOn(to, date);
    const final = params.final == null || params.final === '' ? Math.max(0, valueThen) : checkAmount(params.final, { zero: true });
    if (final > 0) {
      const moveId = checkNewId(next, params.moveId, 'entry');
      const sets = sameDayCheck(next, { placeId: to.id, date });
      let setSeq, moveSeq;
      if (sets.length && params.included === undefined) throw refusal(sameDayQuestion(final, sets), 'same_day', { sets });
      if (sets.length && params.included === true) {
        // The close set and the move sit just before the target's balance, so they must also come
        // after every same-day entry of the closing place; otherwise the place would end the day non-zero.
        const later = next.entries.some((e) => e !== existing && e.date === date && touches(e, p.id) && e.seq > sets[0].seq);
        if (later) {
          throw refusal(`${p.name} has entries on ${dayLabel(date)} after the balance you entered for ${to.name} — answer No, or close it on a later day`, 'close_order');
        }
        const { lo } = seqBefore(next, sets[0], [p.id, to.id], existing ? [existing.id] : []);
        setSeq = lo + (sets[0].seq - lo) / 3;
        moveSeq = lo + (2 * (sets[0].seq - lo)) / 3;
      } else {
        setSeq = nextSeq(next);
        moveSeq = setSeq + 1;
      }
      next.entries = next.entries.filter((e) => e !== existing);
      next.entries.push({ id: setId, kind: 'set', placeId: p.id, date, amount: final, seq: setSeq, ...keep, ...stamp(params.at) });
      next.entries.push({ id: moveId, kind: 'move', fromId: p.id, toId: to.id, date, amount: final, seq: moveSeq, ...stamp(params.at) });
      p.closedOn = date;
      return done(next, today, `Closed ${p.name}`);
    }
  }
  const seq = nextSeq(next);
  next.entries = next.entries.filter((e) => e !== existing);
  next.entries.push({ id: setId, kind: 'set', placeId: p.id, date, amount: 0, seq, ...keep, ...stamp(params.at) });
  p.closedOn = date;
  return done(next, today, `Closed ${p.name}`);
}
// A place's value at the end of a day, folding every entry up to it.
function valueOn(doc, id, date) {
  let v = 0;
  for (const e of doc.entries.filter((x) => touches(x, id) && x.date <= date).sort(compareEntries)) {
    if (e.kind === 'set') v = e.amount;
    else v = r2(v + (e.kind === 'add' || e.toId === id ? e.amount : -e.amount));
  }
  return v;
}

/** reopenPlace(doc, { placeId }) clears closedOn. */
export function reopenPlace(doc, params) {
  const next = clone(doc);
  const p = placeOf(next, params.placeId);
  delete p.closedOn;
  return done(next, todayOf(params), `Reopened ${p.name}`);
}

/** deletePlace(doc, { placeId }) removes the place and every entry touching it (both sides of its moves). */
export function deletePlace(doc, params) {
  const next = clone(doc);
  const p = placeOf(next, params.placeId);
  next.places = next.places.filter((x) => x.id !== p.id);
  next.entries = next.entries.filter((e) => !touches(e, p.id));
  return done(next, todayOf(params), `Deleted ${p.name}`);
}

// ---------------------------------------------------------------- money in and between places
/** addMoney(doc, { id, placeId, amount, date, note?, included?, today, at? }) */
export function addMoney(doc, params) {
  const today = todayOf(params);
  const next = clone(doc);
  const p = placeOf(next, params.placeId);
  const amount = checkAmount(params.amount);
  checkDate(params.date, today);
  checkPlaceOn(p, params.date);
  const id = checkNewId(next, params.id, 'entry');
  const { seq, before } = flowSeq(next, { placeId: p.id, date: params.date }, amount, params.included);
  if (before && before.starting) return { doc, message: `Already counted in ${p.name}'s starting balance`, unchanged: true };
  const note = cleanNote(params.note);
  next.entries.push({ id, kind: 'add', placeId: p.id, date: params.date, amount, seq, ...(note ? { note } : {}), ...stamp(params.at) });
  return done(next, today, `Added ${inr(amount)} to ${p.name}`);
}

/** moveMoney(doc, { id, fromId, toId, amount, date, note?, included?, today, at? }) */
export function moveMoney(doc, params) {
  const today = todayOf(params);
  const next = clone(doc);
  const from = placeOf(next, params.fromId);
  const to = placeOf(next, params.toId);
  if (from.id === to.id) throw refusal('Choose two different places', 'invalid_place');
  const amount = checkAmount(params.amount);
  checkDate(params.date, today);
  checkPlaceOn(from, params.date);
  checkPlaceOn(to, params.date);
  const id = checkNewId(next, params.id, 'entry');
  const { seq } = flowSeq(next, { fromId: from.id, toId: to.id, date: params.date }, amount, params.included);
  const note = cleanNote(params.note);
  next.entries.push({ id, kind: 'move', fromId: from.id, toId: to.id, date: params.date, amount, seq, ...(note ? { note } : {}), ...stamp(params.at) });
  return done(next, today, `Moved ${inr(amount)} to ${to.name}`);
}

// ---------------------------------------------------------------- edit and delete entries
/**
 * editEntry(doc, { id, amount?, date?, note?, baseline?, placeId?, fromId?, toId?, included?, today })
 * set: amount, date, note, baseline (Correction; ignored on a starting balance)
 * add: placeId, amount, date, note · move: fromId, toId, amount, date, note
 */
export function editEntry(doc, params) {
  const today = todayOf(params);
  const next = clone(doc);
  const e = next.entries.find((x) => x.id === params.id);
  if (!e) throw refusal('That entry no longer exists — reload and try again', 'missing');
  const old = { ...e };
  const date = params.date ?? e.date;
  if (date !== old.date) checkDate(date, today);
  else if (!isDate(date)) throw refusal('Pick a valid date', 'invalid_date');
  if (params.note !== undefined) { const note = cleanNote(params.note); if (note) e.note = note; else delete e.note; }

  if (e.kind === 'set') {
    const p = placeOf(next, e.placeId);
    const starting = e.baseline === true && e.date === p.createdOn;
    if (params.amount !== undefined) e.amount = checkAmount(params.amount, { negative: isSpendable(p.type), zero: true });
    if (!starting && params.baseline !== undefined) { if (params.baseline) e.baseline = true; else delete e.baseline; }
    if (date !== old.date) {
      if (next.entries.some((x) => x !== e && x.kind === 'set' && x.placeId === p.id && x.date === date)) {
        throw refusal(`${p.name} already has a balance on ${dayLabel(date)} — edit that one`, 'set_exists');
      }
      if (p.closedOn && date > p.closedOn) throw refusal(`${p.name} was closed on ${dayLabel(p.closedOn)}`, 'after_closed');
      if (starting) {
        const others = next.entries.filter((x) => x !== e && touches(x, p.id));
        const first = others.reduce((m, x) => (m == null || x.date < m ? x.date : m), null);
        if (first && date > first) throw refusal(`${p.name}'s starting balance can't be after its first other entry (${dayLabel(first)})`, 'start_after_first');
        p.createdOn = date;
        const sameDay = others.filter((x) => x.date === date);
        if (sameDay.length) e.seq = Math.min(...sameDay.map((x) => x.seq)) / 2;
      } else {
        if (date < p.createdOn) throw refusal(`${p.name} starts on ${dayLabel(p.createdOn)} — use Update balances to add an earlier balance`, 'before_created');
        e.seq = nextSeq(next);
      }
      e.date = date;
    }
    return done(next, today, 'Saved');
  }

  if (params.amount !== undefined) e.amount = checkAmount(params.amount);
  if (e.kind === 'add' && params.placeId !== undefined) e.placeId = placeOf(next, params.placeId).id;
  if (e.kind === 'move') {
    if (params.fromId !== undefined) e.fromId = placeOf(next, params.fromId).id;
    if (params.toId !== undefined) e.toId = placeOf(next, params.toId).id;
    if (e.fromId === e.toId) throw refusal('Choose two different places', 'invalid_place');
  }
  const placesChanged = e.kind === 'add' ? e.placeId !== old.placeId : e.fromId !== old.fromId || e.toId !== old.toId;
  for (const pid of e.kind === 'add' ? [e.placeId] : [e.fromId, e.toId]) {
    const p = placeOf(next, pid);
    if (date < p.createdOn) throw refusal(`${p.name} starts on ${dayLabel(p.createdOn)} — use Update balances to add an earlier balance`, 'before_created');
    if (p.closedOn && date > p.closedOn) throw refusal(`${p.name} was closed on ${dayLabel(p.closedOn)}`, 'after_closed');
  }
  if (date !== old.date || placesChanged) {
    const flow = e.kind === 'add' ? { placeId: e.placeId, date } : { fromId: e.fromId, toId: e.toId, date };
    const { seq, before } = flowSeq(next, flow, e.amount, params.included, [e.id]);
    if (e.kind === 'add' && before && before.starting) {
      throw refusal(`That money is already counted in ${before.name}'s starting balance — delete this entry instead`, 'in_starting');
    }
    e.seq = seq;
    e.date = date;
  }
  return done(next, today, 'Saved');
}

/** deleteEntry(doc, { id }) — a starting balance can only go while it is the place's only entry. */
export function deleteEntry(doc, params) {
  const next = clone(doc);
  const e = next.entries.find((x) => x.id === params.id);
  if (!e) throw refusal('That entry no longer exists — reload and try again', 'missing');
  if (e.kind === 'set' && e.baseline === true) {
    const p = placeOf(next, e.placeId);
    if (e.date === p.createdOn && next.entries.some((x) => x !== e && touches(x, p.id))) throw refusal('Delete the place instead', 'starting_balance');
  }
  next.entries = next.entries.filter((x) => x !== e);
  const what = e.kind === 'set' ? 'Balance' : e.kind === 'add' ? 'Added money' : 'Move';
  return done(next, todayOf(params), `${what} deleted`);
}

// ---------------------------------------------------------------- update balances (multi-row)
/*
 * params = { date, today, at?, rows: [{
 *   placeId, amount,             // blank rows (amount null/'') are skipped
 *   setId,                       // new id; ignored when a set already exists that day (it is replaced, same id)
 *   choice?: 'from'|'income'|'refund'|'correction',   // for a rise on bank/cash
 *   fromId?, flowId?, flowAmount?, flowNote?,          // 'from': move fromId → place; 'income': add (note e.g. 'Salary')
 *   included?,                   // answer to the same-day question for a 'from' move
 * }] }
 */
export function updateBalances(doc, params) {
  const plan = planBalances(doc, params, true);
  const n = plan.rows.length;
  const message = n === 1 ? `Saved ${plan.rows[0].name}'s balance` : `Saved ${n} balances`;
  return done(plan.doc, plan.today, message);
}

/**
 * Live preview of an Update-balances sheet. Never throws for missing answers; returns
 * { doc, ok, problems: [{ placeId, code, message, sets? }], rows: [rowPreview] } where rowPreview =
 * { placeId, name, setId, amount, expected, replaces, backfill, breakdown, rise, adj, spent, kind, text, needsChoice, choice }.
 * Rows without an amount carry only { placeId, name, expected, replaces, backfill, breakdown }.
 */
export function previewBalances(doc, params) {
  try {
    const plan = planBalances(doc, params, false);
    return { doc: plan.doc, ok: plan.problems.length === 0, problems: plan.problems, rows: plan.previews };
  } catch (err) {
    return { doc, ok: false, problems: [{ placeId: null, code: err.code || 'refused', message: err.message }], rows: [] };
  }
}

/**
 * Which Update-balances rows must show the rise choices. It is judged on the planned result,
 * not on each row alone: a "From my place" move chosen on one row lowers the source row's
 * expected and can give that row a rise of its own (§3.7). A row keeps its choice only while
 * it would need one without it; other choices are dropped. A from/income flow with no amount
 * gets the row's planned rise. → { params, preview: previewBalances(), prompts: Map(placeId → rise) }
 */
export function planPrompts(doc, params) {
  const rows = Array.isArray(params.rows) ? params.rows : [];
  const bare = (row) => {
    const { choice, fromId, flowId, flowAmount, flowNote, included, ...rest } = row;
    return rest;
  };
  const withChoices = (keep, skip = null) => ({
    ...params, rows: rows.map((row) => (row.choice && keep.has(row.placeId) && row.placeId !== skip ? row : bare(row))),
  });
  const rowOf = (pv, id) => pv.rows.find((x) => x.placeId === id);
  const keep = new Set(rows.filter((row) => row.choice).map((row) => row.placeId));
  const rise = new Map();
  // Dropping one choice can remove another row's need (its rise came from that move): repeat until stable.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...keep]) {
      const x = rowOf(previewBalances(doc, withChoices(keep, id)), id);
      if (x && x.needsChoice) rise.set(id, x.rise);
      else { keep.delete(id); rise.delete(id); changed = true; }
    }
  }
  const out = withChoices(keep);
  out.rows = out.rows.map((row) => ((row.choice === 'from' || row.choice === 'income') && (row.flowAmount == null || row.flowAmount === '')
    ? { ...row, flowAmount: rise.get(row.placeId) } : row));
  const preview = previewBalances(doc, out);
  const prompts = new Map(rise);
  for (const x of preview.rows) if (x.needsChoice) prompts.set(x.placeId, x.rise);
  return { params: out, preview, prompts };
}

function planBalances(doc, params, strict) {
  const today = todayOf(params);
  const date = params.date;
  checkDate(date, today);
  const problems = [];
  const problem = (err, placeId) => {
    if (strict) throw err;
    problems.push({ placeId, code: err.code, message: err.message, ...(err.sets ? { sets: err.sets } : {}) });
  };
  const before = new Ledger(doc, today);
  const next = clone(doc);
  const allRows = Array.isArray(params.rows) ? params.rows : [];
  const seen = new Set();
  const rows = [];
  const previews = [];

  for (const row of allRows) {
    const p = next.places.find((x) => x.id === row.placeId);
    if (!p) { problem(refusal('That place no longer exists — reload and try again', 'missing'), row.placeId); continue; }
    if (seen.has(p.id)) { problem(refusal(`${p.name} is listed twice`, 'duplicate_row'), p.id); continue; }
    seen.add(p.id);
    const base = { placeId: p.id, name: p.name, ...before.expectedAt(p.id, date) };
    previews.push(base);
    if (row.amount == null || row.amount === '') continue;
    try {
      if (p.closedOn && date > p.closedOn) throw refusal(`${p.name} was closed on ${dayLabel(p.closedOn)}`, 'after_closed');
      const amount = checkAmount(row.amount, { negative: isSpendable(p.type), zero: true });
      rows.push({ row, p, amount, base, spendable: isSpendable(p.type), preview: base });
    } catch (err) { problem(err, p.id); }
  }
  if (strict && !rows.length) throw refusal('Enter at least one balance', 'empty');

  // Backfill and same-day replacement happen before anything is added.
  for (const r of rows) {
    const existing = next.entries.find((e) => e.kind === 'set' && e.placeId === r.p.id && e.date === date);
    r.backfill = date < r.p.createdOn;
    r.starting = r.backfill || (existing ? existing.baseline === true && existing.date === r.p.createdOn : false);
    r.setId = existing ? existing.id : r.row.setId;
    r.keepNote = existing && existing.note ? existing.note : null;
    if (existing) next.entries = next.entries.filter((e) => e !== existing);
    if (r.backfill) {
      const oldStart = next.entries.find((e) => e.kind === 'set' && e.placeId === r.p.id && e.baseline === true && e.date === r.p.createdOn);
      if (oldStart) delete oldStart.baseline;
      r.p.createdOn = date;
    }
    r.rawAdj = r.backfill ? 0 : r2(r.amount - r.base.expected);
  }

  // New flows first (rule 2), in row order; a flow that must sit before an already-saved set uses rule 3.
  const mid = new Ledger(next, today);
  const rowPlaces = new Set(rows.map((r) => r.p.id));
  const flows = [];
  let seq = nextSeq(next);
  for (const r of rows) {
    const choice = r.spendable && !r.starting ? r.row.choice : undefined;
    r.choice = choice;
    if (choice !== 'income' && choice !== 'from') continue;
    try {
      const amount = r.row.flowAmount == null || r.row.flowAmount === '' ? r.rawAdj : checkAmount(r.row.flowAmount);
      if (!(amount > 0)) throw refusal('Enter the amount that came in', 'invalid_amount');
      const id = r.row.flowId;
      if (typeof id !== 'string' || !ENTRY_ID_RE.test(id) || next.entries.some((e) => e.id === id) || flows.some((f) => f.e.id === id)) throw refusal('Internal error: bad new id', 'bad_id');
      if (choice === 'income') {
        const note = cleanNote(r.row.flowNote);
        flows.push({ e: { id, kind: 'add', placeId: r.p.id, date, amount, ...(note ? { note } : {}), ...stamp(params.at) } });
        continue;
      }
      const q = next.places.find((x) => x.id === r.row.fromId);
      if (!q || q.id === r.p.id) throw refusal(`Choose where ${r.p.name}'s ${inr(r.rawAdj)} came from`, 'choose_rise', { placeId: r.p.id });
      const move = { id, kind: 'move', fromId: q.id, toId: r.p.id, date, amount, ...stamp(params.at) };
      let fixedSeq = null;
      if (!rowPlaces.has(q.id)) {
        const Sq = sourceSet(mid, q.id, r.p, date, amount);
        if (Sq) {
          move.date = Sq.date;
          fixedSeq = seqBefore(next, Sq, [q.id, r.p.id]).seq;
        } else {
          const sets = sameDayCheck(next, { placeId: q.id, date });
          if (sets.length && r.row.included === undefined) throw refusal(sameDayQuestion(amount, sets), 'same_day', { sets, placeId: r.p.id });
          if (sets.length && r.row.included === true) fixedSeq = seqBefore(next, sets[0], [q.id, r.p.id]).seq;
        }
      }
      checkPlaceOn(q, move.date);
      flows.push({ e: move, fixedSeq });
    } catch (err) { problem(err, r.p.id); }
  }
  for (const f of flows) next.entries.push({ ...f.e, seq: f.fixedSeq ?? seq++ });
  for (const r of rows) {
    const e = { id: r.setId, kind: 'set', placeId: r.p.id, date, amount: r.amount, seq: seq++, ...stamp(params.at) };
    if (r.starting || r.choice === 'correction') e.baseline = true;
    if (r.keepNote) e.note = r.keepNote;
    if (!r.setId || (!r.row.setId && !r.base.replaces)) { problem(refusal('Internal error: bad new id', 'bad_id'), r.p.id); continue; }
    next.entries.push(e);
  }

  // Rises on bank/cash need a choice (§3.7), judged after this sheet's own flows.
  const after = new Ledger(next, today);
  for (const r of rows) {
    const info = after.setInfo(r.setId);
    if (!info) continue;
    const rise = r.spendable && !info.baseline ? Math.max(0, r2(info.adj)) : 0;
    const needsChoice = rise >= RISE_PROMPT_MIN && !r.choice;
    if (needsChoice) problem(refusal(`Choose where ${r.p.name}'s ${inr(rise)} came from`, 'choose_rise', { placeId: r.p.id }), r.p.id);
    Object.assign(r.preview, rowPreview(r, info, rise, needsChoice));
  }
  return { doc: next, today, rows: rows.map((r) => ({ ...r, name: r.p.name })), previews, problems };
}

// q's saved non-baseline set inside p's gap whose drop covers the amount (closest drop; latest on a tie).
function sourceSet(L, qId, p, date, amount) {
  const prev = L.doc.entries.filter((e) => e.kind === 'set' && e.placeId === p.id && e.date < date).sort(compareEntries).pop();
  const anchor = prev ? prev.date : addDays(p.createdOn, -1);
  let best = null;
  for (const e of L.doc.entries) {
    if (e.kind !== 'set' || e.placeId !== qId || e.date <= anchor || e.date > date) continue;
    const info = L.setInfo(e.id);
    if (!info || info.baseline) continue;
    const drop = r2(-info.adj);
    if (drop < amount) continue;
    const d = Math.abs(drop - amount);
    if (!best || d < best.d || (d === best.d && e.date > best.e.date)) best = { e, d };
  }
  return best && best.e;
}

function rowPreview(r, info, rise, needsChoice) {
  const line = balanceLine({
    name: r.p.name, spendable: r.spendable, adj: info.adj, sinceDate: info.sinceDate, anchorDate: info.anchorDate, date: info.date,
    starting: info.starting || r.backfill, backfill: r.backfill, correction: info.correction, choice: r.choice,
  });
  return { setId: r.setId, amount: r.amount, rise, adj: info.adj, spent: info.spent, needsChoice, choice: r.choice ?? null, ...line };
}
