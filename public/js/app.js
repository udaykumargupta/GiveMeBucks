// App shell: boot, sign-in gate, loading the v2 document, rendering the
// overview, hash routing for sheets, and save/undo. Every change is a pure
// action from actions.js applied to the current document; save() PUTs the
// result with the document's rev and keeps the before-image for Undo.
import { h, logoSvg, toast, closeToast, busy, download, confirmDialog, closeSheet, closeMenu, onRoute } from './ui.js';
import { api, loadConfig, authRequired, currentUser, signOut, onSignOut, renderGate, getConfig, backupNote } from './auth.js';
import { hideTip } from './charts.js';
import { todayLocal, dayLabel } from './dates.js';
import { isV2, isV1Shaped, migrate, validateDoc } from './model.js';
import { Ledger } from './ledger.js';
import { refusal } from './actions.js';
import { renderOverview, isPhone } from './views.js';
import { initSheets, openRoute, refreshSheets, openAccount } from './sheets.js';

const root = document.getElementById('app');
const THEME_COLOR = { dark: '#0d0f12', light: '#f5f6f8' };

// Per-browser view preferences only (never financial data).
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`gt.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`gt.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
// Settings of the old dashboard; gt.theme stays.
for (const k of ['range', 'yearMode', 'income', 'units', 'collapsed', 'privacy']) {
  try { localStorage.removeItem(`gt.${k}`); } catch { /* storage unavailable */ }
}

const state = {
  doc: null,        // the v2 document without legacyV1 (actions work on this)
  legacy: null,     // legacyV1 as stored on the server (kept out of every routine PUT)
  rev: 0,
  today: todayLocal(),
  L: null,
  user: null,
  local: true,
  theme: prefs.get('theme', 'dark') === 'light' ? 'light' : 'dark',
  ui: { nwMode: 'trend', spentTab: 'month', showClosed: false },
  saving: 0,
  saves: 0,         // PUTs started; a refetch that overlapped one is dropped
  epoch: 0,         // bumped on every sign-out: older Undo/Retry toasts must not act on the next account
};

// ------------------------------------------------------------------ theme
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLOR[t];
}
function setTheme(t) {
  state.theme = t === 'light' ? 'light' : 'dark';
  applyTheme(state.theme);
  prefs.set('theme', state.theme);
}
applyTheme(state.theme);

// --------------------------------------------------------------- the app API
// What views.js and sheets.js may use.
const app = {
  doc: () => state.doc,
  L: () => state.L,
  today: () => state.today,
  user: () => state.user,
  local: () => state.local,
  theme: () => state.theme,
  isPhone,
  setTheme,
  save,
  go: (hash, opts) => { if (!openRoute(hash, opts)) clearHash(hash); },
  openAccount: (anchor) => openAccount(anchor),
  exportBackup,
  importBackup,
  signOut: () => signOut(),
};
initSheets(app);

function clearHash(hash) {
  if (location.hash && (!hash || location.hash === hash)) history.replaceState(history.state, '', location.pathname + location.search);
}

// ----------------------------------------------------------------- render
function adopt(serverDoc) {
  const { legacyV1, ...doc } = serverDoc;
  state.doc = doc;
  state.legacy = legacyV1 || null;
  state.rev = Number.isInteger(doc.rev) ? doc.rev : 0;
}

function render() {
  if (!state.doc) return;
  state.today = todayLocal();
  state.L = new Ledger(state.doc, state.today);
  renderOverview(root, state.L, {
    app, ui: state.ui, user: state.user, local: state.local, legacy: state.legacy, today: state.today,
  });
}
/** Re-render the page and recompute every open sheet after the data changed. */
function renderAll(reason) {
  render();
  refreshSheets(reason);
}

// ------------------------------------------------------------- server I/O
const signedOut = () => authRequired() && !currentUser();

async function load() {
  const res = await api('/api/db', { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    if (!isV2(body)) throw new Error('The server sent data in the old format — restart the GiveMeBucks server.');
    adopt(body);
    return 'ok';
  }
  if (body.code === 'migration_failed') return 'migration_failed';
  throw new Error(body.error || body.message || `Server returned ${res.status}`);
}

let outdatedShown = false;
function showOutdated() {
  if (outdatedShown) return;
  outdatedShown = true;
  toast('GiveMeBucks was updated —', { ms: 0, action: { label: 'Reload', onClick: () => location.reload() } });
}

/**
 * PUT a document with the current rev. `legacy` (optional) is sent as legacyV1;
 * otherwise it is left out and the server keeps the stored one.
 * Throws a refusal with code offline | signed_out | conflict | outdated_client | invalid | server.
 */
async function put(doc, legacy) {
  const { savedAt, legacyV1, ...body } = doc;
  body.rev = state.rev;
  if (legacy) body.legacyV1 = legacy;
  state.saving++;
  state.saves++;
  busy(true);
  let res;
  try {
    res = await api('/api/db', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    if (signedOut()) throw refusal('Signed out', 'signed_out');
    throw refusal('Couldn’t save — check your connection.', 'offline');
  } finally {
    state.saving--;
    busy(state.saving > 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    state.doc = { ...body, rev: data.rev, savedAt: data.savedAt };
    delete state.doc.legacyV1;
    state.rev = data.rev;
    if (legacy) state.legacy = legacy;
    return;
  }
  if (res.status === 409 && data.db) {
    adopt(data.db);
    renderAll('conflict');
    throw refusal('Changed on another device — check and save again', 'conflict');
  }
  if (data.code === 'outdated_client') {
    showOutdated();
    throw refusal(data.error || 'GiveMeBucks was updated — reload the page.', 'outdated_client');
  }
  throw refusal(data.error || data.message || `Couldn’t save (error ${res.status})`, data.code || 'server');
}

/**
 * Apply a pure action and save it: run(doc) → { doc, message, unchanged? }.
 * A refusal thrown by run (or by the save) propagates to the caller, which
 * shows it inline. On success: re-render, then a toast with Undo (6 s; 10 s
 * after a delete) that puts the before-image back.
 * opts: { deleted, legacy (send this legacyV1), retry (the sheet's own save, for the offline toast) }.
 */
async function save(run, opts = {}) {
  state.today = todayLocal();
  const epoch = state.epoch;
  const mine = () => state.epoch === epoch && Boolean(state.doc);
  const before = state.doc;
  const beforeLegacy = state.legacy;
  const result = run(before);
  if (result.unchanged || result.doc === before) {
    if (result.message) toast(result.message);
    return result;
  }
  try {
    await put(result.doc, opts.legacy);
  } catch (err) {
    if (err.code === 'offline') {
      const retry = () => {
        if (!mine()) return;
        if (opts.retry) opts.retry();
        else save(run, opts).catch(() => {});
      };
      toast(err.message, { tone: 'error', ms: 0, action: { label: 'Retry', onClick: retry } });
    }
    throw err;
  }
  renderAll('saved');
  const savedRev = state.rev;
  toast(result.message || 'Saved', {
    ms: opts.deleted ? 10000 : 6000,
    action: { label: 'Undo', onClick: () => undo(before, opts.legacy ? beforeLegacy : null, savedRev, epoch) },
  });
  return result;
}

/** Put the before-image back, unless the document moved on since this save (another device or tab). */
async function undo(beforeDoc, legacy, savedRev, epoch) {
  if (state.epoch !== epoch || !state.doc) return; // signed out since: never write into another account
  if (savedRev != null && state.rev !== savedRev) {
    toast('Couldn’t undo — it changed since then.', { tone: 'error' });
    return;
  }
  try {
    await put(beforeDoc, legacy || undefined);
    renderAll('saved');
    toast('Undone');
  } catch (err) {
    if (err.code === 'signed_out') return;
    if (err.code === 'conflict') toast('Couldn’t undo — it changed on another device.', { tone: 'error' });
    else if (err.code === 'offline') toast(err.message, { tone: 'error', action: { label: 'Retry', onClick: () => undo(beforeDoc, legacy, savedRev, epoch) } });
    else if (err.code !== 'outdated_client') toast(err.message, { tone: 'error' });
  }
}

// ---------------------------------------------------------------- backups
function exportBackup() {
  if (!state.doc) return;
  const { rev, savedAt, ...doc } = state.doc;
  const out = { ...doc, ...(state.legacy ? { legacyV1: state.legacy } : {}), exportedAt: new Date().toISOString() };
  download(`givemebucks-backup-${todayLocal()}.json`, JSON.stringify(out, null, 2));
  toast('Backup exported');
}

function importBackup() {
  const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.remove();
    if (file) importFile(file);
  });
  document.body.appendChild(input);
  input.click();
}

async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t a GiveMeBucks backup (not valid JSON).', { tone: 'error' }); return; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) { toast('That file isn’t a GiveMeBucks backup.', { tone: 'error' }); return; }
  const { exportedAt, rev, savedAt, ...rest } = data;
  const today = todayLocal();
  const doc = isV1Shaped(rest) ? migrate(rest, today, new Date().toISOString()) : rest;
  if (!isV2(doc)) { toast('That file isn’t a GiveMeBucks backup.', { tone: 'error' }); return; }
  const check = validateDoc(doc, { today });
  if (!check.ok) { toast(`Can’t import this backup — ${check.error}`, { tone: 'error', ms: 0 }); return; }
  const { legacyV1, ...next } = doc;
  const latest = next.entries.reduce((m, e) => (e.date > m ? e.date : m), '');
  const counts = `${next.places.length} ${next.places.length === 1 ? 'place' : 'places'}, ${next.entries.length} ${next.entries.length === 1 ? 'entry' : 'entries'}${latest ? `, latest ${dayLabel(latest, true)}` : ''}`;
  const note = getConfig().storage === 'file' ? ` ${backupNote()}` : '';
  for (;;) {
    const choice = await confirmDialog({
      title: 'Import backup',
      message: `Replace all data with this backup? ${counts}.${note}`,
      buttons: [
        { label: 'Export current first', value: 'export', kind: 'secondary' },
        { label: 'Cancel', value: null, kind: 'secondary' },
        { label: 'Replace', value: 'replace', kind: 'danger' },
      ],
    });
    if (choice === 'export') { exportBackup(); continue; }
    if (choice !== 'replace') return;
    break;
  }
  try {
    await save(() => ({ doc: { ...next, version: 2, rev: state.rev }, message: 'Backup imported' }), { deleted: true, legacy: legacyV1 || undefined });
  } catch (err) {
    if (err.code !== 'signed_out' && err.code !== 'offline') toast(err.message, { tone: 'error' });
  }
}

// ---------------------------------------------------------------- screens
function blocker(title, text, buttons) {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('div', { class: 'blocker' }, h('div', { class: 'blocker-card' },
    h('div', { class: 'auth-logo', html: logoSvg('blocker') }),
    h('h1', {}, title),
    h('p', {}, text),
    h('div', { class: 'row' }, buttons))));
}

function showServerDown(err) {
  blocker('Can’t reach GiveMeBucks',
    `Check your connection, or start the server with “npm start” in the givemebucks folder. (${err.message})`,
    [h('button', { class: 'btn primary', type: 'button', onclick: () => openDashboard() }, 'Retry')]);
}

async function downloadOriginal() {
  try {
    const res = await api('/api/db/v1', { cache: 'no-store' });
    if (!res.ok) { toast('No data from the earlier version was found.', { tone: 'error' }); return; }
    download(`givemebucks-original-${todayLocal()}.json`, JSON.stringify(await res.json(), null, 2));
  } catch (err) {
    if (!signedOut()) toast(`Couldn’t download it (${err.message}).`, { tone: 'error' });
  }
}

function showMigrationFailed() {
  blocker('Couldn’t upgrade your data — nothing was changed.',
    'Your data from the earlier version is safe. Try again, or download it as a file.',
    [
      h('button', { class: 'btn primary', type: 'button', onclick: () => openDashboard() }, 'Retry'),
      h('button', { class: 'btn', type: 'button', onclick: downloadOriginal }, 'Download original data'),
    ]);
}

/** Sign-in page: first visit (when sign-in is on) and after signing out or a 401. */
function showGate({ expired = false } = {}) {
  state.epoch++;
  state.doc = null;
  state.L = null;
  closeToast();
  closeMenu(false);
  closeSheet({ all: true, reason: 'signout' });
  hideTip();
  clearHash();
  document.title = 'Sign in · GiveMeBucks';
  root.removeAttribute('aria-busy');
  renderGate(root, { expired, onSignedIn: () => openDashboard() });
}
onSignOut(({ expired }) => showGate({ expired }));

async function openDashboard() {
  state.local = !authRequired();
  state.user = state.local ? null : currentUser();
  let status;
  try {
    status = await load();
  } catch (err) {
    if (signedOut()) return; // a 401 already brought up the sign-in page
    showServerDown(err);
    return;
  }
  if (status === 'migration_failed') { showMigrationFailed(); return; }
  document.title = 'GiveMeBucks';
  render();
  if (location.hash && !openRoute(location.hash)) clearHash();
}

// ----------------------------------------------------------- page events
// Back/Forward onto a sheet hash that no open sheet owns.
onRoute((hash) => { if (state.doc && !openRoute(hash)) clearHash(hash); });

// Coming back to the tab: refetch. An open sheet recomputes its previews only.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.doc || state.saving) return;
  const saves = state.saves, epoch = state.epoch;
  try {
    const res = await api('/api/db', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    // A save that ran meanwhile already holds a newer document: never step back to this one.
    if (!state.doc || state.saving || state.saves !== saves || state.epoch !== epoch || !isV2(data)) return;
    if ((data.rev ?? 0) > state.rev) { adopt(data); renderAll('remote'); }
    else if (todayLocal() !== state.today) renderAll('day');
  } catch { /* offline or signed out: keep the current view */ }
});

// Chart windows differ on the phone (8 weeks / 6 months): redraw when crossing 640px.
let phoneLayout = isPhone();
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const now = isPhone();
    if (now !== phoneLayout && state.doc) { phoneLayout = now; render(); }
  }, 180);
});
// Charts scroll with the page; a stale tooltip would float in place.
window.addEventListener('scroll', hideTip, { passive: true });

(async function start() {
  try {
    await loadConfig();
  } catch (err) {
    showServerDown(err);
    return;
  }
  if (signedOut()) showGate();
  else openDashboard();
}());
