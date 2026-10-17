// App shell: loads data from the local server, renders the Grafana-style
// chrome (nav, time picker, variables) and the dashboard grid.
import * as C from './calc.js';
import { dashboardSpec } from './panels.js';
import { openCheckin, openIncome, openAccounts, openSettings } from './forms.js';
import { h, icon, logoSvg, toast, openModal, closeModal, closeDrawer, openMenu, closeMenu, confirmDialog, download } from './ui.js';
import { api, loadConfig, authRequired, currentUser, signOut, onSignOut, renderGate, getConfig } from './auth.js';
import { setUnits } from './format.js';
import { showTip, hideTip } from './charts.js';
import { sampleDb } from './sample.js';

// Per-browser view preferences (never financial data).
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`gt.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`gt.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  db: null,
  range: prefs.get('range', '12m'),
  vars: { yearMode: prefs.get('yearMode', 'fy'), income: prefs.get('income', 'all'), units: prefs.get('units', 'indian') },
  collapsed: prefs.get('collapsed', {}),
  theme: prefs.get('theme', 'dark'),
  privacy: prefs.get('privacy', false),
  saving: false,
};

const RANGES = [
  { id: '3m', label: 'Last 3 months', months: 3 },
  { id: '6m', label: 'Last 6 months', months: 6 },
  { id: '12m', label: 'Last 12 months', months: 12 },
  { id: '24m', label: 'Last 2 years', months: 24 },
  { id: '60m', label: 'Last 5 years', months: 60 },
  { id: 'ytd', label: 'This year so far' },
  { id: 'prev', label: 'Previous year' },
  { id: 'all', label: 'All time' },
];

const app = {
  db: () => state.db,
  ledger: () => new C.Ledger(state.db),
  save,
  replace,
};

const actions = {
  checkin: () => openCheckin(app),
  income: () => openIncome(app),
  accounts: (id) => openAccounts(app, typeof id === 'string' ? id : null),
  settings: () => openSettings(app),
};

// ------------------------------------------------------------- server I/O
async function load() {
  const r = await api('/api/db');
  if (!r.ok) throw new Error(`Server returned ${r.status}`);
  state.db = await r.json();
}

async function persist(next, msg, onError) {
  state.saving = true;
  renderSaveState();
  try {
    const r = await api('/api/db', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    if (r.status === 409) {
      state.db = (await r.json()).db;
      render();
      const m = 'Your data was changed in another tab — reloaded it. Please try again.';
      onError ? onError(m) : toast(m, 'warning');
      return false;
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const { rev } = await r.json();
    state.db = { ...next, rev };
    render();
    if (msg) toast(msg);
    return true;
  } catch (e) {
    if (authRequired() && !currentUser()) return false; // signed out; the sign-in page explains why
    const m = `Couldn't save (${e.message}). Is the GiveMeBucks server running?`;
    onError ? onError(m) : toast(m, 'error');
    return false;
  } finally {
    state.saving = false;
    renderSaveState();
  }
}

/** Apply a mutation to a copy of the data and save it. The mutator returns the success message or throws. */
async function save(mutator, { onError } = {}) {
  const next = structuredClone(state.db);
  next.accounts ||= []; next.snapshots ||= []; next.income ||= [];
  let msg;
  try { msg = mutator(next); } catch (e) { onError ? onError(e.message) : toast(e.message, 'error'); return false; }
  return persist(next, msg, onError);
}

async function replace(data, msg) {
  const next = { accounts: [], snapshots: [], income: [], settings: {}, meta: {}, ...data, rev: state.db.rev ?? 0 };
  return persist(next, msg);
}

// ------------------------------------------------------------------ ranges
function resolveRange(id, L) {
  const mode = state.vars.yearMode;
  const cur = C.monthOf(L.todayISO);
  const def = RANGES.find((r) => r.id === id) || RANGES[2];
  let months, label = def.label, endDay = L.today;
  if (def.months) {
    months = C.monthsBetween(C.addMonths(cur, -(def.months - 1)), cur);
  } else if (def.id === 'ytd') {
    const y = C.yearStartOf(cur, mode);
    months = C.yearMonths(y, mode).filter((k) => k <= cur);
    label = `This ${mode === 'fy' ? 'FY' : 'year'} so far (${C.yearLabel(y, mode)})`;
  } else if (def.id === 'prev') {
    const y = C.yearStartOf(cur, mode) - 1;
    months = C.yearMonths(y, mode);
    endDay = C.monthEndDay(months[11]);
    label = `Previous ${mode === 'fy' ? 'FY' : 'year'} (${C.yearLabel(y, mode)})`;
  } else {
    const start = L.historyStart ?? L.today;
    months = C.monthsBetween(C.monthOf(C.fromDay(start)), cur);
  }
  const startDay = C.monthStartDay(months[0]);
  return { id: def.id, label, months, startDay, endDay };
}

function sampleDays(start, end) {
  const span = end - start;
  const step = span <= 100 ? 1 : span <= 400 ? 3 : 7;
  const out = [];
  for (let d = start; d < end; d += step) out.push(d);
  out.push(end);
  return out;
}

// ---------------------------------------------------------------- chrome
function renderChrome(L, due) {
  const root = document.getElementById('app');
  const title = L.settings.title || 'Wealth Growth';
  const range = resolveRange(state.range, L);
  const lc = L.lastCheckin;

  const nav = h('nav', { class: 'sidemenu', 'aria-label': 'Main' },
    h('div', { class: 'logo', title: 'GiveMeBucks', html: logoSvg('nav') }),
    navBtn('apps', 'Dashboard', () => window.scrollTo({ top: 0, behavior: 'smooth' }), true),
    navBtn('plus', 'Update balances', actions.checkin),
    navBtn('rupee', 'Log income', actions.income),
    navBtn('wallet', 'Accounts', () => actions.accounts()),
    navBtn('bell', 'Needs your input', () => {
      if (state.collapsed.overview) toggleRow('overview');
      document.querySelector('[data-panel="alerts"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, false, due.filter((d) => d.severity !== 'info').length),
    h('div', { class: 'spacer' }),
    navBtn(state.theme === 'dark' ? 'sun' : 'moon', state.theme === 'dark' ? 'Light theme' : 'Dark theme', toggleTheme),
    navBtn('cog', 'Settings', actions.settings),
    authRequired() ? accountButton() : null);

  const timeBtn = h('button', { class: 'tool-btn', 'aria-haspopup': 'menu', onclick: (e) => openMenu(e.currentTarget, [
    { header: 'Time range' },
    ...RANGES.map((r) => ({ label: r.id === 'ytd' || r.id === 'prev' ? resolveRange(r.id, L).label : r.label, active: r.id === state.range, onClick: () => setRange(r.id) })),
  ], { align: 'right' }) }, h('span', { html: icon('clock') }), h('span', { class: 'tool-label' }, range.label), h('span', { html: icon('down', 'small') }));

  const top = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn mobile-only', 'aria-label': 'Menu', html: icon('menu'), onclick: () => document.body.classList.toggle('nav-open') }),
    h('div', { class: 'crumbs' },
      h('span', { class: 'crumb brand' }, 'GiveMeBucks'), h('span', { class: 'crumb-sep', html: icon('right', 'small') }),
      h('span', { class: 'crumb muted' }, 'Dashboards'), h('span', { class: 'crumb-sep', html: icon('right', 'small') }),
      h('h1', { class: 'crumb current' }, L.settings.owner ? `${L.settings.owner}'s ${title}` : title),
      h('span', { class: 'star', html: icon('star') })),
    h('div', { class: 'top-actions' },
      h('button', { class: 'btn primary', onclick: actions.checkin }, h('span', { html: icon('plus') }), h('span', { class: 'hide-sm' }, 'Update balances')),
      h('button', { class: 'btn secondary hide-sm', onclick: actions.income }, h('span', { html: icon('rupee') }), 'Log income'),
      h('button', { class: `icon-btn tool ${state.privacy ? 'on' : ''}`, title: state.privacy ? 'Show amounts (p)' : 'Hide amounts (p)', 'aria-pressed': state.privacy, html: icon(state.privacy ? 'eyeOff' : 'eye'), onclick: togglePrivacy }),
      timeBtn,
      h('button', { class: 'tool-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: refresh }, h('span', { html: icon('sync') }))));

  const variable = (label, key, options) => h('label', { class: 'variable' },
    h('span', { class: 'var-label' }, label),
    h('select', { onchange: (e) => setVar(key, e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: state.vars[key] === v }, l))));
  const sub = h('div', { class: 'subbar' },
    variable('Year', 'yearMode', [['fy', 'Financial year (Apr–Mar)'], ['calendar', 'Calendar year']]),
    variable('Income', 'income', [['all', 'All sources'], ['salary', 'Salary only']]),
    variable('Units', 'units', [['indian', 'Lakh / Crore'], ['international', 'K / M']]),
    h('div', { class: 'subbar-right' },
      h('span', { class: 'muted small' }, lc == null ? 'No check-ins yet' : `Last check-in ${C.dayLabel(lc, true)}`),
      h('span', { id: 'save-state', class: 'save-state' })));

  const banner = L.db.meta?.sample
    ? h('div', { class: 'banner' },
      h('span', { html: icon('info') }),
      h('span', {}, h('strong', {}, 'You are exploring sample data. '), 'Look around — every panel works. When you are ready, start fresh and add your own accounts.'),
      h('button', { class: 'btn primary sm', onclick: startFresh }, 'Start with my data'))
    : null;

  const main = h('div', { class: 'main' }, top, sub, banner, h('main', { id: 'dash', class: 'dash' }));
  root.replaceChildren(nav, main, h('div', { class: 'nav-scrim', onclick: () => document.body.classList.remove('nav-open') }));
  renderSaveState();
}

function navBtn(ic, label, onClick, active = false, badge = 0) {
  return h('button', { class: `nav-btn ${active ? 'active' : ''}`, 'aria-label': label, onclick: () => { document.body.classList.remove('nav-open'); onClick(); },
    onpointerenter: (e) => { const r = e.currentTarget.getBoundingClientRect(); showTip(r.right - 4, r.top - 6, { title: label }); },
    onpointerleave: hideTip },
  h('span', { html: icon(ic) }), h('span', { class: 'nav-text' }, label), badge ? h('span', { class: 'nav-badge' }, String(badge)) : null);
}

/** Google avatar at the bottom of the sidebar (like Grafana's profile button) with Sign out. */
function accountButton() {
  const u = currentUser() || { name: '', email: '' };
  const label = u.name || u.email || 'Account';
  const initials = h('span', { class: 'avatar initials' }, label.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
  const avatar = u.picture
    ? h('img', { class: 'avatar', src: u.picture, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.currentTarget.replaceWith(initials) })
    : initials;
  return h('button', {
    class: 'nav-btn account-btn', 'aria-label': `Signed in as ${label}`, 'aria-haspopup': 'menu',
    onclick: (e) => openMenu(e.currentTarget, [
      { header: u.email && u.name ? `${u.name} · ${u.email}` : label },
      { label: 'Sign out', icon: 'logout', onClick: () => signOut() },
    ], { placement: 'right' }),
    onpointerenter: (e) => { const r = e.currentTarget.getBoundingClientRect(); showTip(r.right - 4, r.top - 6, { title: label, foot: u.name ? u.email : undefined }); },
    onpointerleave: hideTip,
  }, avatar, h('span', { class: 'nav-text' }, label));
}

function renderSaveState() {
  const el = document.getElementById('save-state');
  if (!el) return;
  el.className = `save-state ${state.saving ? 'saving' : 'saved'}`;
  el.textContent = state.saving ? 'Saving…' : authRequired() ? 'Saved' : 'Saved locally';
}

// ------------------------------------------------------------- dashboard
function renderDashboard(L, due) {
  const dash = document.getElementById('dash');
  dash.replaceChildren();
  if (!L.accounts.length && !L.income.length) { dash.append(welcome()); return; }

  const range = resolveRange(state.range, L);
  // Sample from when tracking began; charts still draw the full range on the x-axis.
  const from = Math.min(range.endDay, Math.max(range.startDay, L.historyStart ?? range.startDay));
  const ctx = { L, range, vars: state.vars, due, actions, features: getConfig(), days: sampleDays(from, range.endDay) };
  const grid = h('div', { class: 'grid' });
  const queue = [];
  for (const row of dashboardSpec(ctx)) {
    const collapsed = !!state.collapsed[row.id];
    grid.append(h('div', { class: `row-header ${collapsed ? 'collapsed' : ''}` },
      h('button', { class: 'row-toggle', 'aria-expanded': String(!collapsed), onclick: () => toggleRow(row.id) },
        h('span', { html: icon(collapsed ? 'right' : 'down') }), row.title,
        collapsed ? h('span', { class: 'row-count' }, `(${row.panels.length} panels)`) : null)));
    if (collapsed) continue;
    for (const p of row.panels) {
      const { el, body } = panelShell(p, ctx);
      grid.append(el);
      queue.push([p, body]);
    }
  }
  dash.append(grid);
  for (const [p, body] of queue) renderPanel(p, body, ctx);
}

function renderPanel(p, body, ctx) {
  try {
    p.render(body, ctx);
  } catch (e) {
    console.error(`Panel ${p.id} failed`, e);
    body.replaceChildren(h('div', { class: 'chart-empty error' }, `Panel error: ${e.message}`));
  }
}

function panelShell(p, ctx) {
  const title = typeof p.title === 'function' ? p.title() : p.title;
  const body = h('div', { class: 'panel-body' });
  const info = p.desc ? h('span', { class: 'panel-info', tabindex: 0, role: 'note', 'aria-label': p.desc, html: icon('info') }) : null;
  if (info) {
    const show = () => { const r = info.getBoundingClientRect(); showTip(r.left, r.bottom, { title, foot: p.desc }); };
    info.addEventListener('pointerenter', show);
    info.addEventListener('focus', show);
    info.addEventListener('pointerleave', hideTip);
    info.addEventListener('blur', hideTip);
  }
  const menuBtn = h('button', { class: 'icon-btn panel-menu', 'aria-label': `${title} menu`, html: icon('dots'), onclick: (e) => openMenu(e.currentTarget, [
    { label: 'View', icon: 'expand', onClick: () => viewPanel(p, ctx, title) },
    { label: 'Inspect data', icon: 'table', disabled: !p.data, onClick: () => inspectPanel(p, title) },
  ], { align: 'right' }) });
  const el = h('section', { class: `panel w-${p.w}`, 'data-panel': p.id, style: { gridRow: `span ${p.h}` }, 'aria-label': title },
    h('header', { class: 'panel-header' }, alertBadge(p, ctx), h('h2', { class: 'panel-title' }, title), info, p.hint ? h('span', { class: 'panel-hint' }, p.hint) : null, menuBtn),
    body);
  return { el, body };
}

/** Red header badge when data behind this panel is due (like a firing Grafana alert). */
function alertBadge(p, ctx) {
  const firing = (p.alerts || []).length
    ? ctx.due.filter((d) => d.severity !== 'info' && p.alerts.some((a) => (a.endsWith('-') ? d.id.startsWith(a) : d.id === a)))
    : [];
  if (!firing.length) return null;
  const label = `Needs your input: ${firing.map((f) => f.title).join('; ')}`;
  const badge = h('button', { class: 'panel-alert', 'aria-label': label, html: icon('warn'), onclick: () => actions[firing[0].action]() });
  const show = () => {
    const r = badge.getBoundingClientRect();
    showTip(r.left, r.bottom + 4, { title: 'Needs your input', rows: firing.map((f) => ({ color: f.severity === 'critical' ? 'var(--critical)' : 'var(--warning)', key: 'rect', label: f.title, value: '', money: false })), foot: 'Click to update' });
  };
  badge.addEventListener('pointerenter', show);
  badge.addEventListener('focus', show);
  badge.addEventListener('pointerleave', hideTip);
  badge.addEventListener('blur', hideTip);
  return badge;
}

function viewPanel(p, ctx, title) {
  const body = h('div', { class: 'panel-body view' });
  openModal({ title, body, wide: true });
  renderPanel(p, body, ctx);
}

function inspectPanel(p, title) {
  const { columns, rows } = p.data();
  const csv = [columns, ...rows].map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  openModal({
    title: `${title} · data`, wide: true,
    body: h('div', {},
      h('div', { class: 'inline-actions' }, h('span', { class: 'muted small' }, `${rows.length} rows`),
        h('button', { class: 'btn secondary sm', onclick: () => download(`${title.replace(/[^\w]+/g, '-').toLowerCase()}.csv`, csv, 'text/csv') }, h('span', { html: icon('download') }), 'Download CSV')),
      h('div', { class: 'table-scroll inspect' }, h('table', { class: 'grid-table' },
        h('thead', {}, h('tr', {}, columns.map((c, i) => h('th', { class: i ? 'num' : '' }, c)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: i ? 'num money' : '' }, c)))))))),
  });
}

function welcome() {
  return h('div', { class: 'welcome' },
    h('div', { class: 'welcome-card' },
      h('h2', {}, 'Welcome to GiveMeBucks'),
      h('p', { class: 'muted' }, `Track your bank balances, earnings, investments and spending in one dashboard. ${getConfig().storage === 'database' ? 'Your data is private to your Google account.' : 'Everything stays on this Mac.'}`),
      h('ol', { class: 'steps' },
        h('li', {}, h('strong', {}, 'Add your accounts'), ' — your two bank accounts, plus FDs, mutual funds, stocks, EPF/PPF, gold.'),
        h('li', {}, h('strong', {}, 'Log this month\'s income'), ' — salary and anything else you earned.'),
        h('li', {}, h('strong', {}, 'Check in weekly'), ' — type in your bank balances; spending is worked out for you.'),
        h('li', {}, h('strong', {}, 'Get reminded'), getConfig().reminders === 'macos' ? ' — a macOS notification tells you what to update.' : ' — “Needs your input” on the dashboard tells you what to update.')),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn primary', onclick: () => actions.accounts() }, h('span', { html: icon('plus') }), 'Add my accounts'),
        h('button', { class: 'btn secondary', onclick: () => replace(sampleDb(C.todayISO()), 'Sample data loaded') }, 'Explore with sample data'))));
}

// ------------------------------------------------------------ interactions
function render() {
  if (!state.db) return;
  hideTip();
  closeMenu();
  setUnits(state.vars.units);
  document.documentElement.dataset.theme = state.theme;
  document.body.classList.toggle('privacy', !!state.privacy);
  const L = new C.Ledger(state.db);
  const due = C.dueItems(state.db);
  document.title = `${L.settings.title || 'Wealth Growth'} · GiveMeBucks`;
  const y = window.scrollY;
  renderChrome(L, due);
  renderDashboard(L, due);
  window.scrollTo(0, y);
}
const rerenderDash = () => {
  if (!state.db) return;
  const L = new C.Ledger(state.db);
  renderDashboard(L, C.dueItems(state.db));
};

function setRange(id) { state.range = id; prefs.set('range', id); render(); }
function setVar(key, value) { state.vars[key] = value; prefs.set(key, value); render(); }
function toggleRow(id) { state.collapsed[id] = !state.collapsed[id]; prefs.set('collapsed', state.collapsed); render(); }
function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; prefs.set('theme', state.theme); render(); }
function togglePrivacy() { state.privacy = !state.privacy; prefs.set('privacy', state.privacy); render(); }

async function refresh() {
  try { await load(); render(); toast('Refreshed'); } catch (e) { toast(`Refresh failed: ${e.message}`, 'error'); }
}

async function startFresh() {
  if (!(await confirmDialog({ title: 'Start with your own data?', message: 'This clears the sample data so you can add your real accounts.', confirmText: 'Clear sample data' }))) return;
  const ok = await replace({ accounts: [], snapshots: [], income: [], settings: { title: 'Wealth Growth' }, meta: {} }, 'Sample data cleared');
  if (ok) actions.accounts();
}

function route() {
  const r = location.hash.slice(1);
  if (r === 'checkin') actions.checkin();
  else if (r === 'income') actions.income();
  else if (r === 'accounts') actions.accounts();
  else if (r === 'settings') actions.settings();
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(rerenderDash, 180); });
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (closeMenu() || closeModal()) return; closeDrawer(); return; }
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'p') togglePrivacy();
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.db) return;
  try {
    const r = await api('/api/db');
    const db = await r.json();
    if ((db.rev ?? 0) !== (state.db.rev ?? 0)) { state.db = db; render(); }
  } catch { /* server offline; keep current view */ }
});
// Charts scroll with the page; a stale tooltip would float in place.
window.addEventListener('scroll', hideTip, { passive: true });

function showServerDown(e) {
  document.getElementById('app').replaceChildren(h('div', { class: 'welcome' }, h('div', { class: 'welcome-card' },
    h('h2', {}, 'Cannot reach the GiveMeBucks server'),
    h('p', { class: 'muted' }, `Start it with "npm start" in the givemebucks folder, then reload. (${e.message})`))));
}

/** Sign-in page, shown on first visit (when sign-in is enabled) and after signing out. */
function showGate({ expired = false } = {}) {
  state.db = null;
  closeMenu(); closeModal(); closeDrawer(true); hideTip();
  document.title = 'Sign in · GiveMeBucks';
  renderGate(document.getElementById('app'), { expired, onSignedIn: openDashboard });
}
onSignOut(({ expired }) => showGate({ expired }));

async function openDashboard() {
  try {
    await load();
  } catch (e) {
    if (authRequired() && !currentUser()) return; // a 401 already brought up the sign-in page
    showServerDown(e);
    return;
  }
  render();
  route();
}

(async function start() {
  document.documentElement.dataset.theme = state.theme;
  try {
    await loadConfig();
  } catch (e) {
    showServerDown(e);
    return;
  }
  if (authRequired() && !currentUser()) showGate();
  else openDashboard();
})();
