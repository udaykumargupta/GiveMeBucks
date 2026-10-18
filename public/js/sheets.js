// Every sheet over the overview (spec §4.4–4.15 minus the BUILD-SCOPE cuts):
// History, How this was worked out, Place detail, Add place, Update balances,
// Add money, Move money, Edit entry, Edit / Close / Delete place and the
// account menu. Sheets read through `app` (doc, Ledger, today) and change data
// only through app.save(run), where `run(doc)` is a pure action from actions.js.
// Ids for new places and entries are made once when a sheet opens, so a retry
// after a failed save repeats exactly the same change.
import {
  h, icon, openSheet, openSheets, openMenu, confirmDialog, toast, uid,
  amountField, dateChip, chips, segmented,
} from './ui.js';
import { lineChart } from './charts.js';
import { money, moneyShort, signed, daysAgoText, dateText } from './format.js';
import { addDays, dayLabel, monthLabel, rangeLabel, isDate, todayLocal } from './dates.js';
import { TYPES, typeInfo, isSpendable, touches, RISE_PROMPT_MIN } from './model.js';
import { Ledger } from './ledger.js';
import {
  addPlace, editPlace, closePlace, reopenPlace, deletePlace, addMoney, moveMoney, editEntry, deleteEntry,
  updateBalances, planPrompts, sameDayCheck, sameDayQuestion, suggestName, lastAdd, lastMove,
} from './actions.js';

let app = null;
/** Hand the sheets their app context: { doc(), L(), today(), save(run, opts), go(hash, opts), user(), local(), ... }. */
export function initSheets(appContext) { app = appContext; }

const NOTES = ['Salary', 'Bonus', 'Interest', 'Gift', 'Other'];
const RISE_CHOICES = [
  { value: 'from', label: 'From my place' },
  { value: 'income', label: 'Money came in' },
  { value: 'refund', label: 'Refund or cashback' },
  { value: 'correction', label: 'Correction' },
];
// On the day a place without a starting balance starts, the same answer saves a starting balance (§2.2).
const RISE_CHOICES_START = RISE_CHOICES.map((c) => (c.value === 'correction' ? { ...c, label: 'I already had it' } : c));
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;
const isPhone = () => window.matchMedia('(max-width: 639px)').matches;
const nowISO = () => new Date().toISOString();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------ live sheets
// Open sheets register a refresh(reason) hook. Display sheets rebuild their
// body; form sheets only recompute previews and never rebuild their inputs.
const live = new Map();
function track(sheet, refresh) { live.set(sheet, refresh); }
/** After any data change (save, undo, 409 reload, refetch on return): refresh every open sheet. */
export function refreshSheets(reason = 'saved') {
  const open = openSheets();
  for (const sheet of [...live.keys()]) if (!open.includes(sheet)) live.delete(sheet);
  // Top first, so a sheet whose subject is gone closes before the ones under it.
  for (const sheet of open.reverse()) {
    const fn = live.get(sheet);
    if (!fn || !openSheets().includes(sheet)) continue;
    try { fn(reason); } catch (err) { console.error(err); }
  }
}
const isOpen = (hash) => openSheets().some((s) => s.hash === hash);
function sheetFor(opts) {
  const sheet = openSheet({ ...opts, onClose: (e) => { live.delete(sheet); opts.onClose && opts.onClose(e); } });
  return sheet;
}
const noOpenPlaces = (L) => (L.places.length ? 'All your places are closed — reopen one or add a place.' : 'Add a place first.');
function gone(what) {
  toast(`That ${what} no longer exists.`);
  return false;
}

/** Open the sheet a hash names. Returns false when the hash is unknown or its target is gone. */
export function openRoute(hash, opts = {}) {
  const m = /^#([a-z-]+)(?:\/([A-Za-z0-9_-]+))?(?:\/([A-Za-z0-9_-]+))?$/.exec(hash || '');
  if (!m) return false;
  const [, a, b, c] = m;
  switch (a) {
    case 'history': return !b && openHistory();
    case 'place':
      if (!b) return false;
      if (c === 'edit') return openEditPlace(b);
      if (c === 'close') return openClosePlace(b);
      return !c && openPlace(b);
    case 'update': return !c && openUpdate(b || null);
    case 'add-money': return !b && openAddMoney(opts);
    case 'move': return !b && openMove(opts);
    case 'add-place': return !b && openAddPlace(opts);
    case 'entry': return Boolean(b) && !c && openEditEntry(b);
    case 'spent': return openExplain(b, c);
    case 'account': return !b && openAccount(null);
    default: return false;
  }
}

// ---------------------------------------------------------------- pieces
function field(label, control, { inline = true, forId } = {}) {
  return h('div', { class: `field${inline ? ' inline' : ''}` },
    forId ? h('label', { class: 'field-label', for: forId }, label) : h('span', { class: 'field-label' }, label),
    control);
}
function textInput({ value = '', max = 120, placeholder = '', label, onInput, onEnter }) {
  const id = `in-${uid()}`;
  const input = h('input', {
    class: 'input', id, type: 'text', value, maxlength: String(max), placeholder, autocomplete: 'off', 'aria-label': label || null,
    oninput: () => onInput && onInput(),
    onkeydown: (e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } },
  });
  return { input, id };
}
/** Chip options for places; a repeated name gets its type ("HDFC · Bank"). */
function placeOptions(places, all = places) {
  const count = new Map();
  for (const p of all) count.set(p.name.trim().toLowerCase(), (count.get(p.name.trim().toLowerCase()) || 0) + 1);
  return places.map((p) => ({ value: p.id, label: count.get(p.name.trim().toLowerCase()) > 1 ? `${p.name} · ${typeInfo(p.type).short}` : p.name }));
}

/** Footer: one-line note + primary button. */
function footer(label, onClick) {
  const note = h('div', { class: 'foot-note', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'button', onclick: () => onClick() }, label);
  return {
    el: [note, btn], note, btn,
    setNote(t) { note.textContent = t || ''; note.hidden = !t; },
    set(text, enabled) { btn.textContent = text; btn.disabled = !enabled; },
  };
}

/** Inline errors: a refusal in red, "changed on another device" in amber. */
function errorBox() {
  const err = h('div', { class: 'inline-error', role: 'alert', hidden: true });
  const warnText = h('span');
  const warn = h('div', { class: 'inline-warn', role: 'alert', hidden: true }, h('span', { html: icon('warn') }), warnText);
  return {
    el: [warn, err],
    show(e) {
      if (!e || e.code === 'signed_out') return;
      if (e.code === 'conflict') { warnText.textContent = e.message; warn.hidden = false; err.hidden = true; return; }
      err.textContent = e.message || String(e);
      err.hidden = false;
    },
    warn(text) { warnText.textContent = text; warn.hidden = false; },
    clear() { err.hidden = true; warn.hidden = true; },
  };
}

/**
 * The same-day question (§3.7): "Is ₹X already included in the ₹Y you entered
 * for HDFC on 31 Oct?" with two neutral buttons and no default. `key` names
 * the situation; the answer is forgotten when it changes.
 */
function sameDayBox(onAnswer) {
  const text = h('div', { class: 'question-text' });
  const ch = chips({
    label: 'Already included?',
    options: [{ value: 'yes', label: 'Yes, it’s included' }, { value: 'no', label: 'No, it came after' }],
    value: null,
    onChange: () => onAnswer(),
  });
  const el = h('div', { class: 'question', hidden: true }, text, ch.el);
  let key = null;
  return {
    el,
    get key() { return key; },
    update(question, k) {
      if (!question) { el.hidden = true; key = null; ch.set(null); return; }
      if (k !== key) { key = k; ch.set(null); }
      text.textContent = question;
      el.hidden = false;
    },
    answer() { return el.hidden || ch.value() == null ? undefined : ch.value() === 'yes'; },
    pending() { return !el.hidden && ch.value() == null; },
  };
}
const setsKey = (sets, date) => `${date}|${sets.map((s) => s.id).join(',')}`;

/**
 * Wire a form's save: run app.save(run), close on success, show refusals inline.
 * A same-day question thrown by the action (a case the live check missed) goes to `onSameDay`.
 * `btn` is the footer's primary button: Enter in a field does nothing while it is disabled.
 */
function submitter(sheet, { run, errors, refresh, onSameDay, deleted = false, btn = null }) {
  let inFlight = false;
  const go = async () => {
    if (inFlight) return;
    if (btn) {
      if (refresh) refresh();
      if (btn.disabled) return;
    }
    inFlight = true;
    errors.clear();
    try {
      await app.save(run, { retry: go, deleted });
      sheet.close({ reason: 'saved' });
    } catch (err) {
      if (err.code === 'same_day' && onSameDay) onSameDay(err);
      else errors.show(err);
    } finally {
      inFlight = false;
      refresh && refresh();
    }
  };
  return go;
}

function recordedText(at, today) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, ' ').toLowerCase();
  return `Recorded ${dateText(todayLocal(d), today)}, ${time}`;
}

// ---------------------------------------------------------------- history rows
function changeCell(day) {
  const starting = day.entries.filter((x) => x.caption && x.caption.type === 'starting').length;
  if (day.baseline && Math.round((day.change - day.baseline) * 100) === 0 && starting === day.entries.filter((x) => x.kind === 'set').length && starting) {
    return h('span', { class: 'hist-change' }, plural(starting, 'starting balance'));
  }
  if (day.change > 0) return h('span', { class: 'hist-change up' }, `▲ ${money(day.change)}`);
  if (day.change < 0) return h('span', { class: 'hist-change down' }, `▼ ${money(-day.change)}`);
  return h('span', { class: 'hist-change' }, '₹0');
}

/** A net-worth history entry: "HDFC Savings balance ₹95,000 / Spent ₹54,000 since 1 Oct". */
function historyEntry(L, e, caption) {
  let main, amt = '', sub = null, warn = false;
  if (e.kind === 'set') {
    main = `${L.name(e.placeId)} balance`;
    amt = money(e.amount);
    sub = caption ? caption.text : null;
    warn = caption && caption.type === 'rise';
  } else if (e.kind === 'add') {
    main = `Added ${money(e.amount)} to ${L.name(e.placeId)}${e.note ? ` · ${e.note}` : ''}`;
  } else {
    main = `Moved ${money(e.amount)} ${L.name(e.fromId)} → ${L.name(e.toId)}`;
    sub = e.note || null;
  }
  return h('button', { class: 'hist-entry', type: 'button', 'data-focus-key': `entry:${e.id}`, onclick: () => openEditEntry(e.id) },
    h('span', { class: 'hist-main' }, main, sub ? h('span', { class: `hist-sub${warn ? ' warn' : ''}` }, sub) : null),
    h('span', { class: 'hist-amt num' }, amt),
    h('span', { class: 'hist-chev', html: icon('right') }));
}

function historyBody() {
  const L = app.L();
  const today = app.today();
  const days = L.history();
  const upcoming = L.upcoming();
  if (!days.length && !upcoming.length) return [h('p', { class: 'empty-inline' }, 'Nothing recorded yet. Add a place to start.')];
  return [
    h('div', { class: 'hist-cols', 'aria-hidden': 'true' },
      h('span', { class: 'card-label' }, 'Date'), h('span', { class: 'card-label' }, 'Net worth'),
      h('span', { class: 'card-label' }, 'Change')),
    upcoming.length ? h('section', { class: 'hist-day' },
      h('h3', { class: 'hist-group-label card-label' }, 'Tomorrow'),
      upcoming.map((x) => historyEntry(L, x.entry, x.caption))) : null,
    days.map((d) => h('section', { class: 'hist-day', 'aria-label': dateText(d.date, today) },
      h('div', { class: 'hist-day-head' },
        h('span', { class: 'hist-date' }, dateText(d.date, today)),
        h('span', { class: 'hist-nw num' }, money(d.nw)),
        changeCell(d)),
      d.entries.map((x) => historyEntry(L, x.entry, x.caption)))),
  ];
}

/** Rebuild a display sheet's body, keeping its scroll position. */
function rebuild(sheet, build) {
  const top = sheet.body.scrollTop;
  const later = [];
  sheet.body.replaceChildren(...[].concat(build(later)).flat(Infinity).filter(Boolean));
  for (const fn of later) fn();
  sheet.body.scrollTop = top;
}

// ================================================================ History
export function openHistory() {
  if (isOpen('#history')) return true;
  const sheet = sheetFor({ size: 'lg', title: 'Net worth history', hash: '#history', body: [] });
  const build = () => rebuild(sheet, () => historyBody());
  build();
  track(sheet, build);
  return true;
}

// ================================================================ Explain
function periodTitle(p) { return p.kind === 'month' ? monthLabel(p.key, true) : p.label; }
function periodWord(p) {
  if (p.kind === 'month') return monthLabel(p.key, true).split(' ')[0];
  if (p.kind === 'week') return 'the week';
  return p.label;
}
function exLine(label, value, cls = '') {
  return h('div', { class: `ex-line${cls ? ` ${cls}` : ''}` }, h('span', {}, label), h('span', { class: 'num' }, value));
}

function explainBody(kind, key) {
  const L = app.L();
  const today = app.today();
  const p = L.period(kind, key);
  const ex = L.explain(p);
  const word = periodWord(p);
  const out = [h('p', { class: 'explain-intro' },
    'Spent = money that left your bank & cash and didn’t go to another of your places. Between two updates it is spread evenly over the days. Monthly growth uses the same spreading.')];
  if (p.status === 'untracked') out.push(h('p', { class: 'note-2' }, 'You weren’t tracking spending yet in this period.'));
  else if (p.current) {
    const ct = L.completeThrough();
    out.push(h('p', { class: 'note-2' }, ct && ct < today ? `So far — known up to ${dateText(ct, today)}.` : `So far — up to ${dateText(today, today)}.`));
  }
  if (p.firstTracked) out.push(h('p', { class: 'note-2' }, `Counted since you started tracking on ${dateText(L.trackingStart(), today)}.`));

  for (const pl of ex.places) {
    const block = h('section', { class: 'ex-place' },
      h('div', { class: 'ex-place-head' }, h('span', {}, pl.name), h('span', { class: 'num' }, money(pl.spent))));
    for (const g of pl.gaps) {
      const part = g.daysInPeriod === g.days ? ` · ${g.daysInPeriod} in ${word}` : ` · ${g.daysInPeriod} of ${g.days} days in ${word}`;
      const gap = h('div', { class: 'ex-gap' },
        exLine(`${dateText(g.anchorDate, today)} balance`, money(g.start)),
        g.added ? exLine('+ money added', `+ ${money(g.added)}`) : null,
        g.movedIn ? exLine('+ moved in from your places', `+ ${money(g.movedIn)}`) : null,
        g.movedOut ? exLine('− moved to your places', `− ${money(g.movedOut)}`) : null,
        exLine(`= expected on ${dateText(g.setDate, today)}`, money(g.expected)),
        exLine(`you entered on ${dateText(g.setDate, today)}`, money(g.entered)));
      if (g.spent >= 0) {
        gap.append(exLine(`spent ${rangeLabel(addDays(g.anchorDate, 1), g.setDate)} (${plural(g.days, 'day')})${part}`, money(g.inPeriod), 'total'));
      } else {
        gap.append(exLine(`${money(-g.spent)} more than expected${part}`, money(g.inPeriod), 'total'),
          h('div', { class: 'ex-line' }, h('button', { class: 'link-btn', type: 'button', onclick: () => explainRise(pl.placeId, g.setDate, g.entered) }, 'Explain ›')));
      }
      block.append(gap);
    }
    // A current period is always unknown after the last update; only a lagging place is worth a note then.
    const behind = p.current ? pl.lagging : pl.behind;
    if (behind) {
      block.append(h('p', { class: 'ex-note' }, pl.lastSetDate
        ? `Not updated since ${dateText(pl.lastSetDate, today)} — later spending isn’t known yet.`
        : 'No balance update yet — spending isn’t known yet.'));
    }
    if (!pl.gaps.length && !behind) block.append(h('p', { class: 'note' }, 'No balance updates in this period.'));
    out.push(block);
  }
  if (!ex.places.length) out.push(h('p', { class: 'empty-inline' }, 'No bank or cash was tracked in this period.'));
  if (ex.notCounted.length) {
    out.push(h('p', { class: 'ex-foot' }, `Not counted (investments): ${ex.notCounted.map((x) => `${x.name} ${signed(x.amount)}`).join(' · ')}`));
  }
  return out;
}

/** A rise in Explain: reopen that balance in Update balances, on its own day, where the four rise choices apply (§4.5). */
function explainRise(placeId, date, amount) {
  return openUpdate(placeId, { date, amount });
}

export function openExplain(kind, rawKey) {
  let key = rawKey;
  if (kind === 'week' || kind === 'month') {
    if (kind === 'month' ? !/^\d{4}-\d{2}$/.test(key) || !isDate(`${key}-01`) : !isDate(key)) return false;
  } else if (kind === 'fy') {
    key = Number(rawKey);
    if (!Number.isInteger(key) || key < 1990 || key > 2200) return false;
  } else return false;
  const hash = `#spent/${kind}/${rawKey}`;
  if (isOpen(hash)) return true;
  const titleOf = () => {
    const p = app.L().period(kind, key);
    return `${periodTitle(p)} · ${p.anyKnown ? `${money(p.spent)} spent` : 'not known yet'}`;
  };
  const sheet = sheetFor({ size: 'lg', title: titleOf(), hash, body: [] });
  const build = () => { sheet.setTitle(titleOf()); rebuild(sheet, () => explainBody(kind, key)); };
  build();
  track(sheet, build);
  return true;
}

// ================================================================ Place detail
function placeHistoryRow(x, today) {
  const e = x.entry;
  let label, sub = null;
  if (e.kind === 'set') {
    label = x.caption && x.caption.type === 'starting' ? 'Starting balance' : 'Balance';
    if (x.caption && x.caption.type !== 'starting' && x.caption.type !== 'balance') sub = x.caption.text;
  } else if (e.kind === 'add') label = `Added ${money(e.amount)}${e.note ? ` · ${e.note}` : ''}`;
  else label = x.caption ? x.caption.text : 'Move';
  const warn = x.caption && x.caption.type === 'rise';
  return h('button', { class: 'hist-entry', type: 'button', 'data-focus-key': `entry:${e.id}`, onclick: () => openEditEntry(e.id) },
    h('span', { class: 'hist-main dated' },
      h('span', { class: 'hist-when' }, dateText(e.date, today)),
      h('span', { class: 'hist-text' }, label, sub ? h('span', { class: `hist-sub${warn ? ' warn' : ''}` }, sub) : null)),
    h('span', { class: 'hist-amt num' }, x.value == null ? '' : money(x.value)),
    h('span', { class: 'hist-chev', html: icon('right') }));
}

function placeBody(id, later) {
  const L = app.L();
  const today = app.today();
  const p = L.place(id);
  const s = L.placeSummary(id);
  const updated = !s.open ? `Closed ${dateText(p.closedOn, today)}`
    : s.lastSetDate ? `Updated ${daysAgoText(s.daysSinceSet, s.lastSetDate, today)}` : `Added ${daysAgoText(null, p.createdOn, today)}`;
  const twoLabels = (long, short) => [h('span', { class: 'hide-phone' }, long), h('span', { class: 'only-phone' }, short)];
  const actions = s.open
    ? h('div', { class: 'detail-actions' },
      h('button', { class: 'btn primary', type: 'button', 'data-focus-key': 'detail-update', onclick: () => openUpdate(id) }, twoLabels('Update value', 'Update')),
      h('button', { class: 'btn', type: 'button', 'data-focus-key': 'detail-add', onclick: () => openAddMoney({ placeId: id }) }, twoLabels('+ Add money', '+ Add')),
      h('button', { class: 'btn', type: 'button', 'data-focus-key': 'detail-move', onclick: () => openMove({ fromId: id }) }, twoLabels('⇄ Move money', '⇄ Move')))
    : h('div', { class: 'detail-actions' }, h('button', { class: 'btn', type: 'button', 'data-focus-key': 'detail-reopen', onclick: () => reopen(id) }, 'Reopen'));
  const chartEl = h('div', { class: 'chart place' });
  later.push(() => lineChart(chartEl, {
    points: L.placeSeries(id), dots: true, markers: false,
    label: `${p.name} value over time, ${money(s.value)} now`,
    readout: (i) => `${dayLabel(i.date, true)} · ${money(i.value)}`,
  }));
  const rows = L.placeHistory(id);
  const upcoming = L.upcoming(id);
  return [
    h('p', { class: 'detail-sub' }, [s.typeLabel, p.note].filter(Boolean).join(' · ')),
    h('div', { class: 'row' },
      h('div', { class: 'detail-value num grow' }, money(s.value)),
      h('span', { class: `note-2${s.stale ? ' stale' : ''}` }, updated)),
    actions,
    chartEl,
    h('h3', { class: 'section-label' }, 'History'),
    upcoming.length ? [h('div', { class: 'hist-group-label card-label' }, 'Tomorrow'),
      upcoming.map((x) => placeHistoryRow({ ...x, value: null }, today))] : null,
    rows.length ? rows.map((x) => placeHistoryRow(x, today)) : h('p', { class: 'empty-inline' }, 'Nothing recorded yet.'),
  ];
}

async function reopen(id) {
  try { await app.save((doc) => reopenPlace(doc, { placeId: id, today: app.today() })); } catch (err) { if (err.code !== 'signed_out') toast(err.message, { tone: 'error' }); }
}

async function confirmDeletePlace(id) {
  const L = app.L();
  const p = L.place(id);
  if (!p) return;
  const n = app.doc().entries.filter((e) => touches(e, id)).length;
  const closed = !L.isOpen(id);
  const choice = await confirmDialog({
    title: `Delete ${p.name}?`,
    message: `Delete ${p.name} and its ${plural(n, 'entry', 'entries')}? Past spending and net worth will change.`,
    buttons: closed
      ? [{ label: 'Keep', value: null, kind: 'primary' }, { label: 'Delete', value: 'delete', kind: 'danger' }]
      : [{ label: 'Close instead', value: 'close', kind: 'primary' }, { label: 'Delete', value: 'delete', kind: 'danger' }],
  });
  if (choice === 'close') openClosePlace(id);
  if (choice !== 'delete') return;
  try {
    await app.save((doc) => deletePlace(doc, { placeId: id, today: app.today() }), { deleted: true });
  } catch (err) { if (err.code !== 'signed_out') toast(err.message, { tone: 'error' }); }
}

export function openPlace(id) {
  const hash = `#place/${id}`;
  if (isOpen(hash)) return true;
  const p0 = app.L().place(id);
  if (!p0) return gone('place');
  const more = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false', html: icon('dots') });
  const sheet = sheetFor({ size: 'lg', title: p0.name, hash, headerActions: more, body: [] });
  more.addEventListener('click', () => {
    const open = app.L().isOpen(id);
    openMenu(more, [
      { label: 'Edit place', icon: 'edit', onClick: () => openEditPlace(id) },
      open ? { label: 'Close place', icon: 'x', onClick: () => openClosePlace(id) } : { label: 'Reopen place', icon: 'undo', onClick: () => reopen(id) },
      '-',
      { label: 'Delete place', icon: 'trash', danger: true, onClick: () => confirmDeletePlace(id) },
    ], { label: 'Place actions' });
  });
  const build = () => {
    const p = app.L().place(id);
    if (!p) { sheet.close({ reason: 'gone' }); return; }
    sheet.setTitle(p.name);
    rebuild(sheet, (later) => placeBody(id, later));
  };
  build();
  track(sheet, build);
  return true;
}

// ================================================================ Add place
export function openAddPlace(opts = {}) {
  const hash = '#add-place';
  if (isOpen(hash)) return true;
  const today = app.today();
  const ids = { id: uid(), entryId: uid() };
  const first = app.doc().places.length === 0;
  let suggested = null;
  const errors = errorBox();
  const hint = h('p', { class: 'note-2', hidden: true }, 'Credit cards and loans aren’t places — the bill your bank pays is your spending.');
  const name = textInput({ max: 60, label: 'Name', placeholder: 'e.g. HDFC Savings', onInput: () => refresh(), onEnter: () => go() });
  const type = chips({
    label: 'Type', cls: 'type-grid', value: TYPES.some((t) => t.id === opts.type) ? opts.type : null,
    options: TYPES.map((t) => ({ value: t.id, label: t.label })),
    onChange: (t) => { prefillName(t); refresh(); },
  });
  const value = amountField({ label: 'Value', allowNegative: true, enterkeyhint: 'done', onInput: () => refresh(), onEnter: () => go() });
  const asOf = dateChip({ today, label: 'As of', onChange: () => refresh() });
  const src = chips({
    label: 'Where did it come from?', value: first ? 'had' : null, onChange: () => refresh(),
    options: [{ value: 'had', label: 'I already had it' }, { value: 'moved', label: 'Moved from…' }, { value: 'new', label: 'New money' }],
  });
  const from = chips({ label: 'Moved from', scroll: true, options: placeOptions(app.L().openPlaces()), value: null, onChange: () => refresh() });
  const ask = sameDayBox(() => refresh());
  const negNote = h('p', { class: 'inline-error', hidden: true }, 'Only a bank or cash place can be below ₹0.');
  const fromBox = h('div', { hidden: true, class: 'stack' }, from.el, ask.el);
  const srcBox = h('div', { hidden: true },
    h('h3', { class: 'section-label' }, 'Where did it come from?'), src.el, fromBox);
  const foot = footer('Add place', () => go());

  function prefillName(t) {
    if (!t) return;
    const s = suggestName(app.doc(), t);
    if (!name.input.value.trim() || name.input.value === suggested) {
      name.input.value = s;
      suggested = s;
      if (isDesktop()) { name.input.focus(); name.input.select(); }
    }
  }
  const read = () => {
    const t = type.value();
    const v = value.valid() ? value.value() : null;
    const source = v > 0 ? src.value() : v < 0 ? 'had' : undefined;
    return { t, v, source, fromId: source === 'moved' ? from.value() : null };
  };
  function refresh() {
    const { t, v, source, fromId } = read();
    hint.hidden = t !== 'other';
    const negBad = v != null && v < 0 && t && !isSpendable(t);
    negNote.hidden = !negBad;
    srcBox.hidden = !(v > 0);
    fromBox.hidden = srcBox.hidden || source !== 'moved';
    const fromPlace = fromId ? app.L().place(fromId) : null;
    asOf.setMin(fromPlace ? fromPlace.createdOn : null);
    if (fromPlace && v > 0) {
      const sets = sameDayCheck(app.doc(), { fromId, toId: '', date: asOf.value() });
      ask.update(sameDayQuestion(v, sets), setsKey(sets, asOf.value()));
    } else ask.update(null);
    const needSource = v > 0 && !source;
    const ok = t && value.valid() && !negBad && !needSource && !(source === 'moved' && !fromId) && !ask.pending();
    foot.setNote(!t ? 'Choose a type' : needSource ? 'Choose where it came from' : source === 'moved' && !fromId ? 'Choose the place it came from' : ask.pending() ? 'Answer the question above' : '');
    foot.btn.disabled = !ok;
  }
  const run = (doc) => {
    const { t, v, source, fromId } = read();
    return addPlace(doc, {
      ...ids, type: t, name: name.input.value, date: asOf.value(), value: v ?? 0, source,
      fromId: fromId || undefined, included: ask.answer(), today: app.today(), at: nowISO(),
    });
  };

  const sheet = sheetFor({
    size: 'sm', title: 'Add place', hash, footer: foot.el,
    body: [
      h('h3', { class: 'section-label' }, 'Type'), type.el, hint,
      h('div', { class: 'sheet-note' },
        field('Name', name.input, { forId: name.id }),
        field('Value', value.el),
        field('As of', asOf.el)),
      negNote, srcBox, errors.el,
    ],
    initialFocus: opts.type ? `#${name.id}` : undefined,
  });
  const go = submitter(sheet, { run, errors, refresh, btn: foot.btn, onSameDay: (err) => { ask.update(err.message, 'forced'); refresh(); } });
  if (opts.type) prefillName(opts.type);
  refresh();
  track(sheet, (reason) => { refresh(); if (reason === 'remote') errors.warn('Changed on another device — check and save again'); });
  return true;
}

// ================================================================ Update balances
/** "₹50,000 on 1 Oct + ₹1,20,000 added − ₹21,000 moved". */
function breakdownText(b, today) {
  if (!b || !(b.added || b.movedIn || b.movedOut)) return null;
  const parts = [b.startDate ? `${money(b.start)} on ${dateText(b.startDate, today)}` : '₹0'];
  if (b.added) parts.push(`+ ${money(b.added)} added`);
  if (b.movedIn) parts.push(`+ ${money(b.movedIn)} moved in`);
  if (b.movedOut) parts.push(`− ${money(b.movedOut)} moved`);
  return parts.join(' ');
}
const PREVIEW_TONE = { rise: 'warn', correction: 'warn', up: 'up', down: 'down' };

/**
 * Update balances, for every open place or (`#update/<id>`) one place.
 * opts.date / opts.amount reopen one saved balance (Explain's rise link): that day, that amount.
 */
export function openUpdate(placeId = null, opts = {}) {
  const hash = placeId ? `#update/${placeId}` : '#update';
  if (isOpen(hash)) return true;
  const L0 = app.L();
  const today = app.today();
  const startDate = isDate(opts.date) && opts.date <= today ? opts.date : null;
  let places;
  if (placeId) {
    const p = L0.place(placeId);
    if (!p) return gone('place');
    const pastOfClosed = startDate && p.closedOn && startDate <= p.closedOn;
    if (!L0.isOpen(placeId) && !pastOfClosed) { toast(`${p.name} is closed — reopen it to update it.`); return false; }
    places = [p];
  } else places = L0.openPlaces();
  if (!places.length) { toast(noOpenPlaces(L0)); return false; }

  const errors = errorBox();
  const date = dateChip({ today, value: startDate, long: true, label: 'Balance date', onChange: () => refresh() });
  const foot = footer('Save', () => go());
  const rows = [];
  const allOpen = L0.openPlaces();

  function makeRow(p) {
    const spendable = isSpendable(p.type);
    const s = L0.placeSummary(p.id);
    const r = { p, spendable, setId: uid(), flowId: uid(), exp: null, raw: null, needsPrompt: false, rise: 0, startsHere: false };
    r.expected = h('div', { class: 'ub-expected' });
    r.brk = h('div', { class: 'ub-break', hidden: true });
    r.amt = amountField({
      label: `${p.name} balance`, allowNegative: spendable, enterkeyhint: 'next',
      onInput: () => refresh(), onEnter: () => nextRow(r),
    });
    r.useExp = h('button', { class: 'chip', type: 'button', onclick: () => { r.amt.set(r.exp ?? 0); refresh(); r.amt.focus(); } }, 'Use expected');
    r.zero = p.type === 'cash' ? h('button', { class: 'chip', type: 'button', onclick: () => { r.amt.set(0); refresh(); } }, '₹0') : null;
    r.preview = h('div', { class: 'preview', 'aria-live': 'polite' });
    r.err = h('div', { class: 'inline-error', hidden: true });
    // Rise choices (bank/cash, rise ≥ ₹1,000): no default.
    r.choice = chips({ label: `Where did ${p.name}'s extra money come from?`, options: RISE_CHOICES, value: null, onChange: () => refresh() });
    r.from = chips({ label: 'From', scroll: true, options: placeOptions(allOpen.filter((q) => q.id !== p.id), allOpen), value: null, onChange: () => refresh() });
    r.flowAmt = amountField({ label: 'Amount', onInput: () => refresh() });
    r.note = chips({ label: 'What', scroll: true, options: NOTES.map((n) => ({ value: n, label: n })), value: null, onChange: () => refresh() });
    r.srcPrev = h('div', { class: 'flow-preview' });
    r.ask = sameDayBox(() => refresh());
    r.fromBox = h('div', { hidden: true, class: 'stack' }, h('div', { class: 'field-label' }, 'From'), r.from.el);
    r.amtBox = h('div', { hidden: true, class: 'stack' }, r.flowAmt.el);
    r.fromHint = h('p', { class: 'note-2', hidden: true }, 'If you also spent some of it, enter the full amount moved.');
    r.noteBox = h('div', { hidden: true, class: 'stack' }, r.note.el);
    r.promptTitle = h('div', { class: 'prompt-title' });
    r.prompt = h('div', { class: 'prompt', hidden: true },
      r.promptTitle, r.choice.el, r.fromBox, r.amtBox, r.fromHint, r.noteBox, r.srcPrev, r.ask.el);
    r.el = h('div', { class: 'ub-row' },
      h('div', { class: 'ub-head' },
        h('span', { class: 'ub-name' }, p.name),
        h('span', { class: `ub-meta${s.stale ? ' stale' : ''}` },
          `${typeInfo(p.type).short} · ${s.lastSetDate ? `updated ${daysAgoText(s.daysSinceSet, s.lastSetDate, today)}` : `added ${daysAgoText(null, s.createdOn, today)}`}`)),
      r.expected, r.brk,
      h('div', { class: 'ub-controls' }, r.amt.el, r.useExp, r.zero),
      r.preview, r.prompt, r.err);
    rows.push(r);
    return r;
  }

  const cash = places.filter((p) => isSpendable(p.type)).map(makeRow);
  const invest = places.filter((p) => !isSpendable(p.type)).map(makeRow);
  const collapse = !placeId && cash.length > 0 && invest.length > 0;
  const investBox = h('div', { hidden: collapse }, invest.map((r) => r.el));
  const toggle = collapse ? h('button', {
    class: 'ub-group-toggle', type: 'button', 'aria-expanded': 'false',
    onclick: () => {
      investBox.hidden = !investBox.hidden;
      toggle.setAttribute('aria-expanded', investBox.hidden ? 'false' : 'true');
      if (!investBox.hidden) invest[0].amt.focus();
    },
  }, h('span', { html: icon('right') }), `Savings & investments (${invest.length})`) : null;

  const visibleRows = () => rows.filter((r) => !r.el.closest('[hidden]'));
  function nextRow(r) {
    const vis = visibleRows();
    const i = vis.indexOf(r);
    if (i >= 0 && i < vis.length - 1) vis[i + 1].amt.focus();
    else if (!foot.btn.disabled) go();
  }
  // Enter on the last visible row reads "done".
  const syncEnterHints = () => {
    const vis = visibleRows();
    vis.forEach((r, i) => r.amt.input.setAttribute('enterkeyhint', i === vis.length - 1 ? 'done' : 'next'));
  };

  // What is typed now, with every selected rise answer. planPrompts() keeps only the answers a
  // row needs, judged on the planned result (another row's move can give this row a rise).
  function typedParams() {
    const L = app.L();
    const d = date.value();
    return {
      date: d, today: app.today(), at: nowISO(),
      rows: rows.map((r) => {
        const amount = r.amt.valid() ? r.amt.value() : null;
        const out = { placeId: r.p.id, amount, setId: r.setId };
        r.raw = amount == null || !L.place(r.p.id) ? null : L.previewSet(r.p.id, d, amount);
        const choice = r.choice.value();
        if (amount == null || !r.spendable || !choice) return out;
        out.choice = choice;
        if (choice === 'from' || choice === 'income') {
          out.flowId = r.flowId;
          if (!r.flowAmt.empty()) out.flowAmount = r.flowAmt.valid() ? r.flowAmt.value() : 'invalid';
        }
        if (choice === 'from') { out.fromId = r.from.value() || undefined; out.included = r.ask.answer(); }
        if (choice === 'income' && r.note.value()) out.flowNote = r.note.value();
        return out;
      }),
    };
  }

  function refresh() {
    const L = app.L();
    const d = date.value();
    const plan = planPrompts(app.doc(), typedParams());
    const pv = plan.preview;
    const byId = new Map(pv.rows.map((x) => [x.placeId, x]));
    let filled = 0, bad = false, afterL = null;
    for (const r of rows) {
      r.needsPrompt = plan.prompts.has(r.p.id);
      r.rise = plan.prompts.get(r.p.id) ?? 0;
      const startsHere = Boolean(L.place(r.p.id)) && d === L.place(r.p.id).createdOn;
      if (startsHere !== r.startsHere) {
        r.startsHere = startsHere;
        r.choice.setOptions(startsHere ? RISE_CHOICES_START : RISE_CHOICES);
      }
      const probs = pv.problems.filter((x) => x.placeId === r.p.id);
      const x = byId.get(r.p.id) || (L.place(r.p.id) ? { ...L.expectedAt(r.p.id, d), ...(r.raw || {}) } : null);
      if (!x) continue;
      // Expected, replaced-same-day and backfill lines.
      if (x.backfill) {
        r.exp = null;
        r.expected.textContent = `Before ${r.p.name} starts (${dateText(r.p.createdOn, today)}) — this becomes its new starting balance`;
        r.useExp.hidden = true;
      } else {
        r.exp = x.expected;
        r.expected.replaceChildren(`Expected ${money(x.expected)}`);
        if (x.replaces) r.expected.append(h('span', { class: 'note-2' }, ` · Replaces ${money(x.replaces.amount)} entered for ${dateText(d, today)}`));
        r.useExp.hidden = false;
      }
      const brk = breakdownText(x.breakdown, today);
      r.brk.textContent = brk || '';
      r.brk.hidden = !brk;

      const typed = !r.amt.empty();
      if (typed) { filled++; if (!r.amt.valid()) bad = true; }
      // Preview line.
      r.preview.className = 'preview';
      if (typed && r.amt.valid() && x.text) {
        r.preview.textContent = `→ ${x.text}`;
        if (PREVIEW_TONE[x.kind]) r.preview.classList.add(PREVIEW_TONE[x.kind]);
      } else r.preview.textContent = '';
      // Rise choices.
      r.prompt.hidden = !r.needsPrompt;
      if (r.needsPrompt) {
        const c = r.choice.value();
        r.promptTitle.textContent = `↑ ${money(r.rise)} more than expected. Where from?`;
        r.fromBox.hidden = c !== 'from';
        r.fromHint.hidden = c !== 'from';
        r.amtBox.hidden = c !== 'from' && c !== 'income';
        r.noteBox.hidden = c !== 'income';
        r.flowAmt.input.placeholder = String(r.rise);
        r.flowAmt.input.setAttribute('aria-label', c === 'income' ? 'Amount that came in' : 'Amount moved');
        const q = c === 'from' ? r.from.value() : null;
        r.srcPrev.replaceChildren();
        const typedSource = q ? rows.find((o) => o.p.id === q && !o.amt.empty() && o.amt.valid()) : null;
        if (typedSource) {
          r.srcPrev.append(h('span', {}, `Counted in the ${money(typedSource.amt.value())} you typed for ${L.name(q)}`));
        } else if (q && L.place(q)) {
          // The source as this save would leave it. A move placed before one of its balances
          // leaves the value alone and explains that balance's drop instead: less spending for
          // bank or cash, a smaller loss for an investment (never spending).
          const before = L.valueAt(q, d) ?? 0;
          const after = (afterL ||= new Ledger(pv.doc, app.today())).valueAt(q, d) ?? 0;
          const why = isSpendable(L.place(q).type) ? 'it counts as less spending there' : 'it counts as a smaller loss there';
          r.srcPrev.append(h('span', {}, after === before
            ? `${L.name(q)} stays ${money(after)} — ${why}`
            : [`${L.name(q)} ${money(before)} → `, h('span', { class: after < 0 ? 'warn' : '' }, money(after))]));
        }
        const sd = probs.find((x2) => x2.code === 'same_day');
        const k = `${q}|${d}`;
        if (c === 'from' && sd) r.ask.update(sd.message, k);
        else if (c !== 'from' || r.ask.key !== k) r.ask.update(null);
      } else r.ask.update(null);
      // Row errors (anything but the questions answered above).
      const other = probs.find((x2) => x2.code !== 'choose_rise' && x2.code !== 'same_day');
      r.err.textContent = other ? other.message : '';
      r.err.hidden = !other;
    }
    const choose = pv.problems.find((x) => x.code === 'choose_rise');
    const pendingQ = rows.some((r) => r.ask.pending());
    const general = pv.problems.find((x) => x.placeId == null);
    foot.setNote(bad ? 'Fix the amounts marked above'
      : choose ? choose.message
        : pendingQ ? 'Answer the question above'
          : general ? general.message : '');
    foot.set(filled ? `Save ${plural(filled, 'update')}` : 'Save', filled > 0 && !bad && pv.ok);
    syncEnterHints();
  }

  const run = (doc) => updateBalances(doc, planPrompts(doc, typedParams()).params);
  const sheet = sheetFor({
    size: 'lg', hash, footer: foot.el,
    title: placeId ? `Update ${places[0].name}` : 'Update balances',
    body: [
      field('On', date.el),
      h('p', { class: 'ub-intro' }, 'Type what your apps show now. Leave a row blank to skip it.'),
      errors.el,
      cash.map((r) => r.el),
      toggle,
      investBox,
    ],
  });
  const go = submitter(sheet, {
    run, errors, refresh, btn: foot.btn,
    onSameDay: (err) => {
      const r = rows.find((x) => x.p.id === err.placeId);
      if (r) r.ask.update(err.message, `${r.from.value()}|${date.value()}`);
      refresh();
    },
  });
  if (placeId && opts.amount != null && Number.isFinite(Number(opts.amount))) rows[0].amt.set(Number(opts.amount));
  refresh();
  track(sheet, (reason) => { refresh(); if (reason === 'remote') errors.warn('Changed on another device — check and save again'); });
  return true;
}

// ================================================================ Add money
export function openAddMoney(opts = {}) {
  const hash = '#add-money';
  if (isOpen(hash)) return true;
  const L0 = app.L();
  const open = L0.openPlaces();
  if (!open.length) { toast(noOpenPlaces(L0)); return false; }
  const today = app.today();
  const id = uid();
  const last = lastAdd(app.doc());
  const errors = errorBox();
  const noteOptions = NOTES.map((n) => ({ value: n, label: n }));
  if (last && last.note && !NOTES.includes(last.note)) noteOptions.unshift({ value: last.note, label: last.note });
  const startPlace = open.some((p) => p.id === opts.placeId) ? opts.placeId
    : last && open.some((p) => p.id === last.placeId) ? last.placeId : open.length === 1 ? open[0].id : null;
  const to = chips({ label: 'To', scroll: true, options: placeOptions(open), value: startPlace, onChange: () => { syncMin(); refresh(); } });
  const amt = amountField({ label: 'Amount', onInput: () => refresh(), onEnter: () => go() });
  const what = chips({ label: 'What', scroll: true, options: noteOptions, value: last && last.note ? last.note : null, onChange: () => refresh() });
  const on = dateChip({ today, label: 'Date', onChange: () => refresh() });
  const ask = sameDayBox(() => refresh());
  const flow = h('div', { class: 'flow-preview', 'aria-live': 'polite' });
  const foot = footer('Add money', () => go());
  const same = last ? h('button', {
    class: 'btn sm block same-last', type: 'button',
    onclick: () => { to.set(last.placeId); amt.set(last.amount); what.set(last.note || null); syncMin(); refresh(); },
  }, `↺ Same as last: ${isPhone() ? moneyShort(last.amount) : money(last.amount)}${last.note ? ` ${last.note}` : ''} → ${L0.name(last.placeId)}`) : null;

  function syncMin() {
    const p = to.value() ? app.L().place(to.value()) : null;
    on.setMin(p ? p.createdOn : null);
  }
  function refresh() {
    const L = app.L();
    const pid = to.value();
    const a = amt.value();
    const d = on.value();
    const sets = pid && a > 0 ? sameDayCheck(app.doc(), { placeId: pid, date: d }) : [];
    ask.update(sets.length ? sameDayQuestion(a, sets) : null, setsKey(sets, d));
    flow.replaceChildren();
    if (pid && a > 0 && L.place(pid)) {
      const before = L.valueAt(pid, d) ?? 0;
      flow.append(h('span', {}, ask.answer() === true
        ? `${L.name(pid)} stays ${money(before)} — it’s already in that balance`
        : `${L.name(pid)} ${money(before)} → ${money(before + a)}`));
    }
    foot.setNote(ask.pending() ? 'Answer the question above' : '');
    foot.set(a > 0 ? `Add ${money(a)}` : 'Add money', Boolean(pid) && a > 0 && !ask.pending());
  }
  const run = (doc) => addMoney(doc, {
    id, placeId: to.value(), amount: amt.value(), date: on.value(), note: what.value() || undefined,
    included: ask.answer(), today: app.today(), at: nowISO(),
  });
  const sheet = sheetFor({
    size: 'sm', title: 'Add money', hash, footer: foot.el,
    body: [
      same,
      field('To', to.el), field('Amount', amt.el), field('What', what.el), field('On', on.el),
      ask.el, flow,
      h('p', { class: 'note sheet-note' }, 'Refunds don’t need adding — they lower your spending automatically.'),
      errors.el,
    ],
  });
  const go = submitter(sheet, { run, errors, refresh, btn: foot.btn, onSameDay: (err) => { ask.update(err.message, 'forced'); refresh(); } });
  syncMin();
  refresh();
  track(sheet, (reason) => { refresh(); if (reason === 'remote') errors.warn('Changed on another device — check and save again'); });
  return true;
}

// ================================================================ Move money
export function openMove(opts = {}) {
  const hash = '#move';
  if (isOpen(hash)) return true;
  const L0 = app.L();
  const open = L0.openPlaces();
  if (open.length < 2) { toast(open.length || !L0.places.length ? 'Add a second place to move money between them.' : noOpenPlaces(L0)); return false; }
  const today = app.today();
  const id = uid();
  const last = lastMove(app.doc());
  const errors = errorBox();
  const has = (pid) => open.some((p) => p.id === pid);
  const fromStart = has(opts.fromId) ? opts.fromId : last && has(last.fromId) ? last.fromId : null;
  const toStart = last && has(last.toId) && last.toId !== fromStart && (!opts.fromId || last.fromId === opts.fromId) ? last.toId : null;
  const options = placeOptions(open);
  const from = chips({ label: 'From', scroll: true, options, value: fromStart, onChange: () => { syncMin(); refresh(); } });
  const to = chips({ label: 'To', scroll: true, options, value: toStart, onChange: () => { syncMin(); refresh(); } });
  const swap = h('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Swap from and to', title: 'Swap', html: icon('swap'),
    onclick: () => { const f = from.value(); from.set(to.value()); to.set(f); syncMin(); refresh(); },
  });
  const amt = amountField({ label: 'Amount', onInput: () => refresh(), onEnter: () => go() });
  const on = dateChip({ today, label: 'Date', onChange: () => refresh() });
  const note = textInput({ max: 120, label: 'Note', placeholder: 'optional', onEnter: () => go() });
  const ask = sameDayBox(() => refresh());
  const flow = h('div', { class: 'flow-preview', 'aria-live': 'polite' });
  const foot = footer('Move money', () => go());
  const same = last ? h('button', {
    class: 'btn sm block same-last', type: 'button',
    onclick: () => { from.set(last.fromId); to.set(last.toId); amt.set(last.amount); note.input.value = last.note || ''; syncMin(); refresh(); },
  }, `↺ Same as last: ${isPhone() ? moneyShort(last.amount) : money(last.amount)} ${L0.name(last.fromId)} → ${L0.name(last.toId)}`) : null;

  function syncMin() {
    const L = app.L();
    const dates = [from.value(), to.value()].map((pid) => (pid ? L.place(pid) : null)).filter(Boolean).map((p) => p.createdOn).sort();
    on.setMin(dates.length ? dates[dates.length - 1] : null);
  }
  function refresh() {
    const L = app.L();
    const f = from.value(), t = to.value(), a = amt.value(), d = on.value();
    const same2 = f && t && f === t;
    flow.replaceChildren();
    if (f && t && !same2 && a > 0 && L.place(f) && L.place(t)) {
      const fb = L.valueAt(f, d) ?? 0, tb = L.valueAt(t, d) ?? 0;
      flow.append(h('span', {}, `${L.name(f)} ${money(fb)} → ${money(fb - a)}`), h('span', {}, `${L.name(t)} ${money(tb)} → ${money(tb + a)}`));
      if (fb - a < 0) flow.append(h('span', { class: 'warn' }, `⚠ ${L.name(f)} would go to ${money(fb - a)} on ${dateText(d, today)}`));
    }
    const sets = f && t && !same2 && a > 0 ? sameDayCheck(app.doc(), { fromId: f, toId: t, date: d }) : [];
    ask.update(sets.length ? sameDayQuestion(a, sets) : null, setsKey(sets, d));
    foot.setNote(same2 ? 'Choose two different places' : ask.pending() ? 'Answer the question above' : '');
    foot.set(a > 0 ? `Move ${money(a)}` : 'Move money', Boolean(f && t) && !same2 && a > 0 && !ask.pending());
  }
  const run = (doc) => moveMoney(doc, {
    id, fromId: from.value(), toId: to.value(), amount: amt.value(), date: on.value(), note: note.input.value,
    included: ask.answer(), today: app.today(), at: nowISO(),
  });
  const sheet = sheetFor({
    size: 'sm', title: 'Move money', hash, footer: foot.el,
    body: [
      same,
      field('From', h('div', { class: 'row' }, h('div', { class: 'grow' }, from.el), swap)),
      field('To', to.el), field('Amount', amt.el), field('On', on.el), field('Note', note.input, { forId: note.id }),
      ask.el, flow,
      h('p', { class: 'note sheet-note' }, 'Not spending — the money stays yours.'),
      errors.el,
    ],
  });
  const go = submitter(sheet, { run, errors, refresh, btn: foot.btn, onSameDay: (err) => { ask.update(err.message, 'forced'); refresh(); } });
  syncMin();
  refresh();
  track(sheet, (reason) => { refresh(); if (reason === 'remote') errors.warn('Changed on another device — check and save again'); });
  return true;
}

// ================================================================ Edit entry
export function openEditEntry(id) {
  const hash = `#entry/${id}`;
  if (isOpen(hash)) return true;
  const doc0 = app.doc();
  const L0 = app.L();
  const today = app.today();
  const e = doc0.entries.find((x) => x.id === id);
  if (!e) return gone('entry');
  const errors = errorBox();
  const ask = sameDayBox(() => refresh());
  const foot = footer('Save', () => go());
  const maxDate = e.date > today ? e.date : today;
  const on = dateChip({ today, value: e.date, max: maxDate, label: 'Date', onChange: () => { syncMin(); refresh(); } });
  const note = textInput({ value: e.note || '', max: 120, label: 'Note', placeholder: 'optional', onInput: () => refresh(), onEnter: () => go() });
  const body = [];
  let title, amt, placeChips = {}, corr = null, starting = false, blockDelete = false, p = null;

  if (e.kind === 'set') {
    p = L0.place(e.placeId);
    starting = e.baseline === true && e.date === p.createdOn;
    blockDelete = starting && doc0.entries.some((x) => x.id !== e.id && touches(x, e.placeId));
    title = `Edit balance · ${p.name}`;
    amt = amountField({ label: 'Balance', value: e.amount, allowNegative: isSpendable(p.type), onInput: () => refresh(), onEnter: () => go() });
    body.push(field('Balance', amt.el), field('On', on.el), field('Note', note.input, { forId: note.id }));
    if (starting) body.push(h('p', { class: 'note-2' }, 'Starting balance — it isn’t spending or growth.'));
    const cap = L0.caption(e);
    if (!starting && cap && cap.type === 'rise' && cap.amount >= RISE_PROMPT_MIN) {
      // The four rise choices live in Update balances; reopen this balance there (§3.7).
      body.push(h('p', { class: 'note-2' }, `${money(cap.amount)} more than expected — `,
        h('button', { class: 'link-btn', type: 'button', onclick: () => explainRise(e.placeId, e.date, e.amount) }, 'say where it came from ›')));
    }
    if (!starting) {
      corr = h('input', { type: 'checkbox', checked: e.baseline === true, onchange: () => refresh() });
      body.push(h('label', { class: 'check' }, corr,
        h('span', {}, 'Correction — my earlier balance was wrong', h('span', { class: 'check-sub' }, 'Not spending, not growth'))));
    }
  } else {
    const places = L0.places.filter((q) => L0.isOpen(q.id) || touches(e, q.id));
    const opts = placeOptions(places);
    amt = amountField({ label: 'Amount', value: e.amount, onInput: () => refresh(), onEnter: () => go() });
    if (e.kind === 'add') {
      title = 'Edit added money';
      placeChips.to = chips({ label: 'To', scroll: true, options: opts, value: e.placeId, onChange: () => { syncMin(); refresh(); } });
      body.push(field('To', placeChips.to.el));
    } else {
      title = 'Edit move';
      placeChips.from = chips({ label: 'From', scroll: true, options: opts, value: e.fromId, onChange: () => { syncMin(); refresh(); } });
      placeChips.to = chips({ label: 'To', scroll: true, options: opts, value: e.toId, onChange: () => { syncMin(); refresh(); } });
      body.push(field('From', placeChips.from.el), field('To', placeChips.to.el));
    }
    body.push(field('Amount', amt.el), field('On', on.el), field('Note', note.input, { forId: note.id }));
  }
  const rec = e.at ? recordedText(e.at, today) : null;
  if (rec) body.push(h('p', { class: 'note sheet-note' }, rec));
  if (blockDelete) body.push(h('p', { class: 'note-2 sheet-note' }, 'To remove a starting balance, delete the place instead.'));
  body.push(ask.el, errors.el);

  function flowPlaces() {
    if (e.kind === 'add') return { placeId: placeChips.to.value() };
    if (e.kind === 'move') return { fromId: placeChips.from.value(), toId: placeChips.to.value() };
    return null;
  }
  function syncMin() {
    if (e.kind === 'set') { if (!starting) on.setMin(app.L().place(e.placeId)?.createdOn || null); return; }
    const L = app.L();
    const dates = Object.values(flowPlaces()).map((pid) => (pid ? L.place(pid) : null)).filter(Boolean).map((q) => q.createdOn).sort();
    on.setMin(dates.length ? dates[dates.length - 1] : null);
  }
  function refresh() {
    const a = amt.value();
    const d = on.value();
    const okAmount = amt.valid() && !amt.empty() && (e.kind === 'set' || a > 0);
    let pending = false, sameNote = '';
    if (e.kind !== 'set') {
      const fp = flowPlaces();
      const changed = d !== e.date || (e.kind === 'add' ? fp.placeId !== e.placeId : fp.fromId !== e.fromId || fp.toId !== e.toId);
      const valid = e.kind === 'add' ? fp.placeId : fp.fromId && fp.toId && fp.fromId !== fp.toId;
      if (e.kind === 'move' && fp.fromId && fp.fromId === fp.toId) sameNote = 'Choose two different places';
      const sets = changed && valid && a > 0 ? sameDayCheck(app.doc(), { ...fp, date: d, excludeId: e.id }) : [];
      ask.update(sets.length ? sameDayQuestion(a, sets) : null, setsKey(sets, d));
      pending = ask.pending();
    }
    foot.setNote(sameNote || (pending ? 'Answer the question above' : ''));
    foot.btn.disabled = !okAmount || pending || Boolean(sameNote);
  }
  const run = (doc) => {
    const base = { id, today: app.today(), amount: amt.value(), date: on.value(), note: note.input.value };
    if (e.kind === 'set') return editEntry(doc, { ...base, ...(starting ? {} : { baseline: corr.checked }) });
    return editEntry(doc, { ...base, ...flowPlaces(), included: ask.answer() });
  };

  const del = h('button', {
    class: 'link-btn danger', type: 'button', disabled: blockDelete,
    title: blockDelete ? 'Delete the place instead' : 'Delete this entry',
    html: `${icon('trash')}<span>Delete</span>`,
  });
  const sheet = sheetFor({ size: 'sm', title, hash, headerActions: del, footer: foot.el, body });
  const go = submitter(sheet, { run, errors, refresh, btn: foot.btn, onSameDay: (err) => { ask.update(err.message, 'forced'); refresh(); } });
  const remove = submitter(sheet, { run: (doc) => deleteEntry(doc, { id, today: app.today() }), errors, deleted: true });
  del.addEventListener('click', () => { if (!blockDelete) remove(); });
  syncMin();
  refresh();
  track(sheet, (reason) => {
    if (!app.doc().entries.some((x) => x.id === id)) { sheet.close({ reason: 'gone' }); return; }
    refresh();
    if (reason === 'remote') errors.warn('Changed on another device — check and save again');
  });
  return true;
}

// ================================================================ Edit place
export function openEditPlace(id) {
  const hash = `#place/${id}/edit`;
  if (isOpen(hash)) return true;
  const p = app.L().place(id);
  if (!p) return gone('place');
  const errors = errorBox();
  const name = textInput({ value: p.name, max: 60, label: 'Name', onInput: () => refresh(), onEnter: () => go() });
  const type = chips({ label: 'Type', cls: 'type-grid', options: TYPES.map((t) => ({ value: t.id, label: t.label })), value: p.type, onChange: () => refresh() });
  const note = textInput({ value: p.note || '', max: 200, label: 'Note', placeholder: 'Bank or platform, FD terms (optional)', onEnter: () => go() });
  const recalc = h('p', { class: 'note-2', hidden: true }, 'Past spending and growth will be recalculated.');
  const foot = footer('Save', () => go());
  function refresh() {
    recalc.hidden = isSpendable(type.value()) === isSpendable(p.type);
    foot.btn.disabled = !name.input.value.trim() || !type.value();
    foot.setNote(!name.input.value.trim() ? 'Enter a name' : '');
  }
  const run = (doc) => editPlace(doc, { id, name: name.input.value, type: type.value(), note: note.input.value, today: app.today() });
  const sheet = sheetFor({
    size: 'sm', title: `Edit ${p.name}`, hash, footer: foot.el,
    body: [
      field('Name', name.input, { forId: name.id }),
      h('h3', { class: 'section-label' }, 'Type'), type.el, recalc,
      h('div', { class: 'sheet-note' }, field('Note', note.input, { forId: note.id })),
      errors.el,
    ],
  });
  const go = submitter(sheet, { run, errors, refresh, btn: foot.btn });
  refresh();
  track(sheet, () => { if (!app.L().place(id)) sheet.close({ reason: 'gone' }); else refresh(); });
  return true;
}

// ================================================================ Close place
export function openClosePlace(id) {
  const hash = `#place/${id}/close`;
  if (isOpen(hash)) return true;
  const L0 = app.L();
  const p = L0.place(id);
  if (!p) return gone('place');
  if (!L0.isOpen(id)) { toast(`${p.name} is already closed.`); return false; }
  const today = app.today();
  const ids = { setId: uid(), moveId: uid() };
  const errors = errorBox();
  const lastDate = app.doc().entries.filter((e) => touches(e, id) && e.date <= today).map((e) => e.date).sort().pop();
  const on = dateChip({ today, min: lastDate && lastDate > p.createdOn ? lastDate : p.createdOn, label: 'Close date', onChange: () => refresh() });
  const valueLine = h('span', { class: 'note-2' });
  const where = chips({
    label: 'Where did it go?', value: null, onChange: () => refresh(),
    options: [{ value: 'moved', label: 'Moved to…' }, { value: 'gone', label: 'Spent or gone' }],
  });
  const others = L0.openPlaces().filter((q) => q.id !== id);
  const to = chips({ label: 'To', scroll: true, options: placeOptions(others, L0.openPlaces()), value: null, onChange: () => refresh() });
  const final = amountField({ label: 'Final amount', onInput: () => refresh(), onEnter: () => go() });
  const finalNote = h('p', { class: 'note-2' });
  const ask = sameDayBox(() => refresh());
  const movedBox = h('div', { hidden: true, class: 'sheet-note' },
    field('To', to.el), field('Final amount', final.el), finalNote, ask.el);
  const whereBox = h('div', { hidden: true }, h('h3', { class: 'section-label' }, 'Where did it go?'), where.el, movedBox);
  const foot = footer('Close place', () => go());

  const valueThen = () => app.L().valueAt(id, on.value()) ?? 0;
  function refresh() {
    const v = valueThen();
    valueLine.textContent = `Value then: ${money(v)}`;
    whereBox.hidden = v === 0;
    const c = v === 0 ? null : where.value();
    movedBox.hidden = c !== 'moved';
    final.input.placeholder = String(Math.max(0, v));
    finalNote.textContent = `Moved in full — the difference from ${money(v)} counts as spending or gain.`;
    const target = c === 'moved' ? to.value() : null;
    const f = final.empty() ? Math.max(0, v) : final.value();
    const sets = target && f > 0 ? sameDayCheck(app.doc(), { placeId: target, date: on.value() }) : [];
    ask.update(sets.length ? sameDayQuestion(f, sets) : null, setsKey(sets, on.value()));
    const ok = v === 0 || c === 'gone' || (c === 'moved' && target && final.valid());
    foot.setNote(v !== 0 && !c ? 'Choose where it went' : c === 'moved' && !target ? 'Choose the place it went to' : ask.pending() ? 'Answer the question above' : '');
    foot.btn.disabled = !ok || ask.pending();
  }
  const run = (doc) => {
    const v = valueThen();
    const moved = v !== 0 && where.value() === 'moved';
    return closePlace(doc, {
      placeId: id, date: on.value(), ...ids, today: app.today(), at: nowISO(),
      ...(moved ? { to: to.value(), final: final.empty() ? undefined : final.value(), included: ask.answer() } : {}),
    });
  };
  const sheet = sheetFor({
    size: 'sm', title: `Close ${p.name}`, hash, footer: foot.el,
    body: [
      h('div', { class: 'close-head' }, field('On', on.el), valueLine),
      whereBox,
      h('p', { class: 'note sheet-note' }, 'It leaves your list; its history stays.'),
      errors.el,
    ],
  });
  const go = submitter(sheet, { run, errors, refresh, btn: foot.btn, onSameDay: (err) => { ask.update(err.message, 'forced'); refresh(); } });
  refresh();
  track(sheet, (reason) => {
    if (!app.L().place(id)) { sheet.close({ reason: 'gone' }); return; }
    refresh();
    if (reason === 'remote') errors.warn('Changed on another device — check and save again');
  });
  return true;
}

// ================================================================ Account
function accountHeader() {
  if (app.local()) return { title: 'This Mac · local data', sub: null };
  const u = app.user() || {};
  return { title: u.name || u.email || 'Signed in', sub: u.name && u.email ? u.email : null };
}
function themeControl() {
  return segmented({
    label: 'Theme', value: app.theme(), onChange: (v) => app.setTheme(v),
    options: [{ value: 'dark', label: 'Dark', icon: 'moon' }, { value: 'light', label: 'Light', icon: 'sun' }],
  }).el;
}

/** The account menu: a popover from the avatar on desktop, an `sm` sheet (#account) below 1024px. */
export function openAccount(anchor) {
  const head = accountHeader();
  if (anchor && isDesktop()) {
    openMenu(anchor, [
      { header: head.title, sub: head.sub },
      { node: h('div', { class: 'row grow' }, h('span', { class: 'grow' }, 'Theme'), themeControl()) },
      { label: 'Export backup (.json)', icon: 'download', onClick: () => app.exportBackup() },
      { label: 'Import backup…', icon: 'upload', onClick: () => app.importBackup() },
      ...(app.local() ? [] : ['-', { label: 'Sign out', icon: 'logout', onClick: () => app.signOut() }]),
    ], { label: 'Account' });
    return true;
  }
  const hash = '#account';
  if (isOpen(hash)) return true;
  let sheet = null;
  const item = (label, ic, onClick) => h('button', { class: 'menu-item', type: 'button', onclick: onClick },
    h('span', { class: 'menu-icon', html: icon(ic) }), h('span', { class: 'menu-label' }, label));
  sheet = sheetFor({
    size: 'sm', title: head.title, hash,
    body: [
      head.sub ? h('p', { class: 'note-2' }, head.sub) : null,
      h('div', { class: 'account-theme' }, h('span', {}, 'Theme'), themeControl()),
      item('Export backup (.json)', 'download', () => app.exportBackup()),
      item('Import backup…', 'upload', () => { sheet.close({ reason: 'api' }); app.importBackup(); }),
      app.local() ? null : item('Sign out', 'logout', () => { sheet.close({ reason: 'api' }); app.signOut(); }),
    ],
  });
  return true;
}
