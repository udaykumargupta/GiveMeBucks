// The overview: header, the Net worth, Spent and Places cards, the empty
// state, the one-time upgrade line and the phone bottom bar (spec §4.2–4.6,
// §4.13). Everything is drawn from a Ledger; clicks go through `state.app`
// (open a sheet by hash, re-render), so this file holds no data logic.
import { h, icon, logoSvg, segmented } from './ui.js';
import { lineChart, barChart, sparkline } from './charts.js';
import { money, moneyShort, signed, daysAgoText, dateText } from './format.js';
import { dayLabel, monthLabel, monthKey, weekLabel } from './dates.js';
import { TYPES } from './model.js';
import { periodKey } from './ledger.js';

export const isPhone = () => window.matchMedia('(max-width: 639px)').matches;
export const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;
const MINUS = '−';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The hash that opens "How this was worked out" for a period. */
export const explainHash = (kind, key) => `#spent/${kind}/${key}`;

/**
 * Draw the whole overview into `root`.
 * state = { app, ui: { nwMode, spentTab, showClosed }, user, local, legacy, today }.
 */
export function renderOverview(root, L, state) {
  const later = []; // charts are drawn once their containers are in the page
  const hasPlaces = L.places.length > 0;
  // With every place closed the global actions have nothing to act on.
  const hasOpen = L.openPlaces().length > 0;
  const main = h('main', { class: 'page', id: 'main', tabindex: '-1' },
    upgradeLine(state),
    hasPlaces
      ? h('div', { class: 'ov-grid' },
        h('div', { class: 'ov-col' }, netWorthCard(L, state, later), mountable(() => spentCard(L, state), later)),
        h('div', { class: 'ov-col' }, placesCard(L, state)))
      : emptyState(state));
  root.replaceChildren(...[header(state, hasOpen), main, hasOpen ? bottomBar(state) : null].filter(Boolean));
  root.removeAttribute('aria-busy');
  for (const fn of later) fn();
}

// A card that can redraw itself in place (Spent tabs) without re-rendering the page.
function mountable(build, later) {
  const { el, draw } = build();
  later.push(draw);
  el._rebuild = () => {
    const next = build();
    el.replaceWith(next.el);
    next.el._rebuild = el._rebuild;
    next.draw();
    return next.el;
  };
  return el;
}

// ------------------------------------------------------------------ header
// Long label, and the short one used from 640px up to the point the long ones fit.
const twoLabels = (long, short) => [h('span', { class: 'lbl-long' }, long), h('span', { class: 'lbl-short' }, short)];

function header(state, hasOpen) {
  const { app } = state;
  const actions = hasOpen ? [
    h('button', { class: 'btn primary', type: 'button', 'data-focus-key': 'update', onclick: () => app.go('#update') }, twoLabels('Update balances', 'Update')),
    h('button', { class: 'btn', type: 'button', 'data-focus-key': 'add-money', onclick: () => app.go('#add-money') }, twoLabels('+ Add money', '+ Add')),
    h('button', { class: 'btn', type: 'button', 'data-focus-key': 'move', onclick: () => app.go('#move') }, twoLabels('⇄ Move money', '⇄ Move')),
  ] : [];
  return h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
    h('a', {
      class: 'brand', href: '/', 'aria-label': 'GiveMeBucks',
      onclick: (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
      html: `${logoSvg('top')}<span>GiveMeBucks</span>`,
    }),
    h('div', { class: 'topbar-actions' }, actions, avatarButton(state))));
}

function initials(user) {
  const src = (user.name || user.email || '?').trim();
  const parts = src.split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 && user.name ? parts[1][0] : '')).toUpperCase();
}

function avatarButton(state) {
  const { user, local } = state;
  const btn = h('button', {
    class: 'avatar', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-focus-key': 'account',
    'aria-label': local || !user ? 'Account · This Mac · local data' : `Account · ${user.name || user.email}`,
    onclick: () => state.app.openAccount(btn),
  });
  if (local || !user) btn.innerHTML = icon('dots');
  else if (user.picture) {
    const img = h('img', { src: user.picture, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(initials(user)));
    btn.append(img);
  } else btn.append(initials(user));
  return btn;
}

// ------------------------------------------------------------- upgrade line
function upgradeLine(state) {
  const lv = state.legacy;
  if (!lv || !lv.migratedAt || !lv.report) return null;
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem('gt.upgradeSeen')); } catch { /* storage unavailable */ }
  if (seen === lv.migratedAt) return null;
  const r = lv.report;
  const dropped = (r.droppedIncomeBeforeTracking || 0) + (r.droppedFutureDated || 0) + (r.droppedAfterClose || 0) + (r.droppedInvalid || 0);
  const parts = [`Your data was upgraded: ${plural(r.places || 0, 'place')}, ${plural(r.entries || 0, 'entry', 'entries')}.`];
  if (dropped) parts.push(`Not carried over (kept in your backup): ${plural(dropped, 'item')}.`);
  if (r.estimatedFdValues) parts.push('FD values are now estimates you update yourself.');
  if (r.sampleRemoved) parts.push('Sample data removed.');
  const el = h('div', { class: 'notice', role: 'status' }, h('span', {}, parts.join(' ')),
    h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', html: icon('x'),
      onclick: () => {
        try { localStorage.setItem('gt.upgradeSeen', JSON.stringify(lv.migratedAt)); } catch { /* ignore */ }
        el.remove();
      },
    }));
  return el;
}

// ----------------------------------------------------------- net worth card
// "Cash not updated since 15 Oct — not counted yet"
function lagText(L, today, ids = L.lagging()) {
  if (!ids.length) {
    const ct = L.completeThrough();
    return ct ? `Spending after ${dateText(ct, today)} not counted yet` : 'Spending not counted yet';
  }
  const since = ids.map((id) => L.lastSetDate(id) || L.knownThrough(id)).sort()[0];
  const names = joinNames(ids.map((id) => L.name(id)));
  return `${names} not updated since ${dateText(since, today)} — not counted yet`;
}

function netWorthCard(L, state, later) {
  const { app, ui, today } = state;
  const m = L.currentPeriod('month');
  const g = Math.round(m.growth);
  const delta = h('div', { class: 'delta' });
  if (!Math.round(m.adds) && !m.anyKnown && !Math.round(m.invest)) delta.append('No change recorded this month');
  else if (g === 0) delta.append('No change this month');
  else delta.append(h('span', { class: g > 0 ? 'up' : 'down' }, `${g > 0 ? '▲' : '▼'} ${money(Math.abs(g))}`), ' this month');
  const latest = L.latestSetDate();
  if (latest) delta.append(` · updated ${daysAgoText(null, latest, today)}`);
  if (m.status === 'current' && !m.completeSoFar) {
    const why = lagText(L, today);
    delta.append(h('span', { class: 'dot-warn', role: 'img', 'aria-label': why, title: why }));
  }

  const chartEl = h('div', { class: 'chart nw' });
  const draw = () => (ui.nwMode === 'monthly' ? monthlyChart(chartEl, L, state) : trendChart(chartEl, L, state));
  const seg = segmented({
    label: 'Net worth chart',
    options: [{ value: 'trend', label: 'Trend' }, { value: 'monthly', label: 'Monthly' }],
    value: ui.nwMode,
    onChange: (v) => { ui.nwMode = v; draw(); },
  });
  later.push(draw);
  return h('section', { class: 'card', 'aria-labelledby': 'nw-label' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-label', id: 'nw-label' }, 'Net worth'),
      h('button', { class: 'link-btn', type: 'button', 'data-focus-key': 'history', onclick: () => app.go('#history') }, 'History ›')),
    h('div', { class: 'hero num' }, money(L.netWorth())),
    delta,
    h('div', { class: 'chart-toolbar' }, seg.el),
    chartEl);
}

// A day's change split into growth and its starting balances / corrections, which are never growth:
// { change: '+₹2,000 that day' | null, base: '₹50,000 starting balance' | null }.
function dayChange(point) {
  if (!point) return { change: null, base: null };
  const base = point.baseline || 0;
  const g = Math.round((point.change - base) * 100) / 100;
  const what = !point.starting ? 'correction' : point.starting === base ? 'starting balance' : 'starting balance and correction';
  return { change: g ? `${signed(g)} that day` : null, base: base ? `${money(base)} ${what}` : null };
}

function trendChart(el, L) {
  const points = L.trend();
  lineChart(el, {
    points, key: 'nw',
    label: `Net worth over time, ${money(L.netWorth())} today`,
    readout: (i) => { const c = dayChange(i.point); return [dayLabel(i.date, true), money(i.value), c.change, c.base].filter(Boolean).join(' · '); },
    tooltip: (i) => {
      const c = dayChange(i.point);
      return { title: dayLabel(i.date, true), lines: [money(i.value), ...(c.change ? [c.change] : [])], foot: c.base ? `${c.base} — not growth` : null };
    },
  });
}

// The months that have anything recorded (growth bars start at the first tracked month).
function trackedMonths(L, n) {
  const first = L.trend().find((p) => p.nw !== 0 || p.baseline) || null;
  const firstKey = first ? monthKey(first.date) : null;
  if (!firstKey) return [];
  return L.periods('month', n).filter((p) => p.key >= firstKey);
}

function growthState(p) {
  if (p.current) return 'current';
  return p.status === 'partial' ? 'partial' : 'complete';
}

function growthTip(p) {
  const spentPart = p.spent >= 0 ? `${MINUS} ${money(p.spent)} spent` : `+ ${money(-p.spent)} refunds`;
  const investPart = Math.round(p.invest) ? ` ${p.invest < 0 ? MINUS : '+'} ${money(Math.abs(p.invest))} investments` : '';
  const foot = [
    p.baseline ? `${money(p.baseline)} of starting balances not counted` : null,
    p.current ? 'so far' : p.status === 'partial' ? 'some spending not known yet' : null,
  ].filter(Boolean).join(' · ');
  return {
    title: `${monthLabel(p.key, true)} · ${signed(p.growth)}`,
    lines: [`= ${money(p.adds)} in ${spentPart}${investPart}`, `Net worth ${money(p.nwBefore)} → ${money(p.nwAfter)}`],
    foot: foot || null,
  };
}

function monthlyChart(el, L) {
  const months = trackedMonths(L, isPhone() ? 6 : 12);
  barChart(el, {
    tone: 'growth',
    label: `Net worth growth per month, last ${plural(months.length, 'month')}`,
    bars: months.map((p) => ({ key: p.key, label: monthLabel(p.key).split(' ')[0], value: p.growth, state: growthState(p), period: p })),
    tooltip: (b) => growthTip(b.period),
    readout: (b) => `${monthLabel(b.key)} · ${signed(b.value)}`,
    emptyText: 'The graph fills in as you update.',
  });
}

// --------------------------------------------------------------- spent card
const TABS = [
  { kind: 'week', label: 'This week', short: 'Week' },
  { kind: 'month', label: 'This month', short: 'Month' },
  { kind: 'fy', label: null, short: null },
];
const WINDOW = { week: [12, 8], month: [12, 6], fy: [10, 10] };

function barLabel(kind, p) {
  if (kind === 'week') return dayLabel(p.start);
  if (kind === 'month') return monthLabel(p.key).split(' ')[0];
  return p.label.replace('FY ', '');
}
const periodName = (p) => (p.kind === 'month' ? monthLabel(p.key, true) : p.label);

/** Places behind in a past period: "Cash not updated since 15 Oct". */
function partialText(L, p, today) {
  const behind = L.explain(p).places.filter((x) => x.behind);
  if (!behind.length) return 'Some spending not known yet';
  const since = behind.map((x) => x.lastSetDate || x.knownThrough).sort()[0];
  return `${joinNames(behind.map((x) => x.name))} not updated since ${dateText(since, today)}`;
}

function spentTip(L, p, today) {
  const lines = [{ label: 'Spent', value: p.anyKnown ? money(p.spent) : 'Not known yet', tone: p.anyKnown && Math.round(p.spent) < 0 ? 'warn' : undefined }];
  let foot = null;
  if (p.current) foot = p.completeSoFar ? 'so far' : `so far · ${lagText(L, today)}`;
  else if (p.status === 'partial') foot = partialText(L, p, today);
  if (p.firstTracked) {
    const since = `since you started tracking on ${dateText(L.trackingStart(), today)}`;
    foot = foot ? `${foot} · ${since}` : since;
  }
  return { title: periodName(p), lines, foot };
}

function spendBars(L, kind) {
  const [desk, phone] = WINDOW[kind];
  const start = L.trackingStart();
  let list = L.periods(kind, isPhone() ? phone : desk);
  if (start) {
    const firstKey = periodKey(kind, start);
    list = list.filter((p) => p.key >= firstKey);
  }
  return list;
}

function lastSpendUpdate(L) {
  let last = null;
  for (const p of L.places) {
    const d = L.placeSummary(p.id);
    if (d.spendable && d.lastSetDate && (!last || d.lastSetDate > last)) last = d.lastSetDate;
  }
  return last;
}

function spentCaption(L, state) {
  const { app, today } = state;
  const ids = L.lagging();
  const monthName = monthLabel(monthKey(today), true).split(' ')[0];
  if (ids.length === 1) {
    const id = ids[0];
    const name = L.name(id);
    const btn = h('button', { class: 'link-btn', type: 'button', onclick: () => app.go(`#update/${id}`) }, `Update ${name}`);
    const pend = L.pending(id);
    const last = L.lastSetDate(id);
    if (pend && pend.movedIn > 0 && pend.firstDate) {
      return h('p', { class: 'caption' }, `${name}: ${money(pend.movedIn)} moved in on ${dateText(pend.firstDate, today)}, not updated since — `, btn);
    }
    if (!last) return h('p', { class: 'caption' }, `${name} has no balance yet — `, btn, ` to complete ${monthName}.`);
    return h('p', { class: 'caption' }, `${name} was last updated ${dateText(last, today)} — `, btn, ` to complete ${monthName}.`);
  }
  if (ids.length > 1) {
    const since = ids.map((id) => L.lastSetDate(id) || L.knownThrough(id)).sort()[0];
    return h('p', { class: 'caption' }, `${joinNames(ids.map((id) => L.name(id)))} aren't updated since ${dateText(since, today)} — `,
      h('button', { class: 'link-btn', type: 'button', onclick: () => app.go('#update') }, 'Update'));
  }
  const ct = L.completeThrough();
  return ct ? h('p', { class: 'caption' }, `Up to date till ${dateText(ct, today)}.`) : null;
}

function spentCard(L, state) {
  const { app, ui, today } = state;
  const headCur = () => L.currentPeriod(ui.spentTab);
  const head = h('div', { class: 'card-head' },
    h('h2', { class: 'card-label', id: 'spent-label' }, 'Spent'),
    h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'How this was worked out', title: 'How this was worked out', html: icon('info'),
      onclick: () => { const p = headCur(); app.go(explainHash(p.kind, p.key)); },
    }));
  const card = h('section', { class: 'card', 'aria-labelledby': 'spent-label' }, head);
  if (headCur().status === 'none') {
    card.append(h('div', { class: 'empty-inline' },
      h('p', {}, 'Add a bank account or cash to see spending'),
      h('button', { class: 'btn', type: 'button', onclick: () => app.go('#add-place') }, '+ Add place')));
    return { el: card, draw: () => {} };
  }

  const lastUpdate = lastSpendUpdate(L);
  const values = [];
  const tabs = h('div', { class: 'stat-tabs', role: 'group', 'aria-label': 'Spending period' }, TABS.map((t) => {
    const p = L.currentPeriod(t.kind);
    const known = p.anyKnown;
    const neg = known && Math.round(p.spent) < 0;
    const value = h('span', { class: `stat-value num${neg ? ' negative' : ''}` }, known ? money(p.spent) : '—');
    if (known) values.push([value, p.spent]);
    const subText = !known
      ? (lastUpdate ? `Not known yet · last update ${dateText(lastUpdate, today)}` : 'Not known yet')
      : t.kind === 'week' ? weekLabel(p.start) : t.kind === 'month' ? `${monthLabel(p.key).split(' ')[0]} so far` : 'so far';
    const dot = known && !p.completeSoFar ? h('span', { class: 'dot-warn', role: 'img', 'aria-label': lagText(L, today), title: lagText(L, today) }) : null;
    const label = t.label
      ? [h('span', { class: 'hide-phone' }, t.label), h('span', { class: 'only-phone' }, t.short)]
      : p.label;
    const selected = ui.spentTab === t.kind;
    return h('button', {
      class: 'stat-tab', type: 'button', 'aria-pressed': selected ? 'true' : 'false', 'data-kind': t.kind,
      title: selected ? 'How this was worked out' : null,
      onclick: () => {
        if (ui.spentTab === t.kind) { app.go(explainHash(p.kind, p.key)); return; }
        ui.spentTab = t.kind;
        const next = card._rebuild();
        next.querySelector(`.stat-tab[data-kind="${t.kind}"]`)?.focus();
      },
    }, h('span', { class: 'stat-label' }, label), value, h('span', { class: 'stat-sub', title: subText }, subText, dot));
  }));
  card.append(tabs);

  const sel = L.currentPeriod(ui.spentTab);
  if (sel.anyKnown && Math.round(sel.spent) < 0) {
    card.append(h('p', { class: 'caption' }, 'More came in than went out — ',
      h('button', { class: 'link-btn', type: 'button', onclick: () => app.go(explainHash(sel.kind, sel.key)) }, 'see how ›')));
  }

  const chartEl = h('div', { class: 'chart spent tappable' });
  const hasData = L.hasSpendingData();
  card.append(hasData ? chartEl : h('p', { class: 'empty-inline' }, 'Spending appears after your next balance update.'));
  const caption = spentCaption(L, state);
  if (caption) card.append(caption);

  const draw = () => {
    // Phone fallback: a number too wide for its column goes compact (₹12.3L).
    for (const [el, v] of values) if (el.scrollWidth > el.clientWidth + 1) el.textContent = moneyShort(v);
    if (!hasData) return;
    const kind = ui.spentTab;
    const list = spendBars(L, kind);
    const word = kind === 'week' ? 'week' : kind === 'month' ? 'month' : 'financial year';
    barChart(chartEl, {
      tone: 'spend',
      label: `Spending per ${word}, last ${plural(list.length, word)}`,
      bars: list.map((p) => ({ key: String(p.key), label: barLabel(kind, p), value: p.anyKnown ? p.spent : null, state: p.status, period: p })),
      tooltip: (b) => spentTip(L, b.period, today),
      readout: (b) => `${periodName(b.period)} · ${b.value == null ? 'not known yet' : money(b.value)}`,
      onTap: (b) => app.go(explainHash(kind, b.key)),
      emptyText: 'Spending appears after your next balance update.',
    });
  };
  return { el: card, draw };
}

// -------------------------------------------------------------- places card
function placeRow(L, s, state) {
  const { app, today } = state;
  const ago = s.lastSetDate ? daysAgoText(s.daysSinceSet, s.lastSetDate, today) : `added ${daysAgoText(null, s.createdOn, today)}`;
  const meta = s.open ? `${s.typeLabel} · ${ago}` : `${s.typeLabel} · closed ${dateText(s.closedOn, today)}`;
  return h('button', {
    class: 'place-row', type: 'button', 'data-focus-key': `place:${s.id}`, onclick: () => app.go(`#place/${s.id}`),
    'aria-label': `${s.name}, ${money(s.value)}, ${meta}`,
  },
  h('span', { class: 'grow' },
    h('span', { class: 'place-name' }, s.name),
    h('span', { class: `place-meta${s.stale ? ' stale' : ''}` }, meta)),
  h('span', { class: 'place-spark', html: sparkline(L.sparkline(s.id)) }),
  h('span', { class: 'place-value num' }, money(s.value)),
  h('span', { class: 'place-chev', html: icon('right') }));
}

function placesCard(L, state) {
  const { app, ui } = state;
  const groups = L.groups().filter((g) => g.places.length);
  const closed = L.closedPlaces();
  const closedList = h('div', { hidden: !ui.showClosed }, closed.map((p) => placeRow(L, L.placeSummary(p.id), state)));
  const toggle = closed.length ? h('button', {
    class: 'closed-toggle', type: 'button', 'aria-expanded': ui.showClosed ? 'true' : 'false',
    onclick: () => {
      ui.showClosed = !ui.showClosed;
      closedList.hidden = !ui.showClosed;
      toggle.setAttribute('aria-expanded', ui.showClosed ? 'true' : 'false');
    },
  }, `Closed (${closed.length})`, h('span', { html: icon('right') })) : null;
  return h('section', { class: 'card', 'aria-labelledby': 'places-label' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-label', id: 'places-label' }, 'Places'),
      h('button', { class: 'link-btn', type: 'button', 'data-focus-key': 'add-place', onclick: () => app.go('#add-place') }, '+ Add place')),
    groups.map((g) => h('div', { class: 'group' },
      h('div', { class: 'group-head' }, h('h3', { class: 'group-label' }, g.label), h('span', { class: 'group-total num' }, money(g.total))),
      g.places.map((s) => placeRow(L, s, state)))),
    groups.length ? null : h('p', { class: 'empty-inline' }, 'Every place is closed.'),
    toggle, closedList);
}

// -------------------------------------------------------------- empty state
function emptyState(state) {
  const { app } = state;
  return h('section', { class: 'empty', 'aria-labelledby': 'empty-title' },
    h('h1', { class: 'empty-title', id: 'empty-title' }, 'Where is your money?'),
    h('p', { class: 'empty-text' }, 'Add each place with what’s in it today — bank accounts, cash, FDs, SIPs, mutual funds. Net worth and spending work themselves out; you never log expenses.'),
    h('div', { class: 'type-grid', role: 'group', 'aria-label': 'Add a place' },
      TYPES.map((t) => h('button', { class: 'type-tile', type: 'button', onclick: () => app.go('#add-place', { type: t.id }) }, t.label))),
    h('p', { class: 'empty-tip' }, 'Tip: 1.5L, 45k and 1,23,456 all work.'));
}

// --------------------------------------------------------------- bottom bar
function bottomBar(state) {
  const { app } = state;
  return h('nav', { class: 'bottombar', 'aria-label': 'Actions' },
    h('button', { class: 'btn primary', type: 'button', 'data-focus-key': 'update', onclick: () => app.go('#update') }, 'Update'),
    h('button', { class: 'btn', type: 'button', 'data-focus-key': 'add-money', onclick: () => app.go('#add-money') }, '+ Add money'),
    h('button', { class: 'btn', type: 'button', 'data-focus-key': 'move', onclick: () => app.go('#move') }, '⇄ Move'));
}
