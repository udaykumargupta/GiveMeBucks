// DOM primitives: element builder, icons, sheets, toast, menu, confirm,
// and the small form controls every sheet uses (amount field, date chip,
// chips, segmented control). No app state lives here.
import { money, parseAmount, dateText } from './format.js';
import { todayLocal, addDays } from './dates.js';

/** Hyperscript. Strings become text nodes, so user data is never parsed as HTML. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v; // trusted markup only: icon(), logoSvg(), chart SVG
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  swap: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  warn: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/>',
};
/** Inline SVG markup for a stroke icon (static strings only; safe for `html:`). */
export function icon(name, cls = '') {
  return `<svg class="icon${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

/** The GiveMeBucks mark: a rising line in the brand's orange-to-yellow gradient. */
export function logoSvg(id = 'logo') {
  const g = `gmb-grad-${String(id).replace(/[^a-z0-9-]/gi, '')}`;
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#f05a28"/><stop offset="1" stop-color="#fbca0a"/></linearGradient></defs>` +
    `<path d="M4 24l7-8 5 5 11-13" fill="none" stroke="url(#${g})" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M21 8h6v6" fill="none" stroke="url(#${g})" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`)
  .replace(/-/g, '').slice(0, 12);

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

function trapTab(e, box) {
  if (e.key !== 'Tab') return;
  const items = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) { e.preventDefault(); box.focus(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ------------------------------------------------------------- keyboard
// One Escape handler for every layer, topmost first: menu → confirm → sheet.
const escStack = [];
let keysBound = false;
function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener('keydown', (e) => {
    const top = escStack[escStack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); top.onEsc(); }
    else if (top.box) trapTab(e, top.box);
  });
}
const pushLayer = (layer) => { bindKeys(); escStack.push(layer); };
const dropLayer = (layer) => { const i = escStack.indexOf(layer); if (i >= 0) escStack.splice(i, 1); };

// Keep phone sheet footers above the on-screen keyboard.
let vvBound = false;
function bindViewport() {
  if (vvBound || !window.visualViewport) return;
  vvBound = true;
  const vv = window.visualViewport;
  const sync = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
    document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}

// --------------------------------------------------------------- sheets
const sheets = []; // open sheets, bottom first
let routeHandler = null;
let popBound = false;
let ignorePops = 0;

function bindPop() {
  if (popBound) return;
  popBound = true;
  window.addEventListener('popstate', () => {
    if (ignorePops > 0) { ignorePops--; return; }
    // Back also dismisses a menu or a confirm left over the sheets (the confirm answers "cancel").
    closeMenu(false);
    if (confirmNow) confirmNow(null);
    // Back: close every sheet whose hash is no longer the current one.
    while (sheets.length) {
      const top = sheets[sheets.length - 1];
      if (top.hash && top.hash === location.hash) break;
      if (!top.hash && !top.pushed) break;
      top.close({ reason: 'back', fromHistory: true });
    }
    if (routeHandler && location.hash && !sheets.some((s) => s.hash === location.hash)) routeHandler(location.hash);
  });
}

/** Called with the new hash when Back/Forward lands on a hash no open sheet owns (deep links). */
export function onRoute(fn) { routeHandler = fn; bindPop(); }

/**
 * Open a sheet. size 'sm' = centred 480px dialog on desktop / bottom sheet
 * below 1024px; 'lg' = 560px right panel / full-height sheet.
 * `hash` (e.g. '#add-money') is pushed onto history so Back closes the sheet.
 * Returns a handle: { el, body, footer, close(), setTitle(text), setFooter(node), hash }.
 * `replace: true` swaps out the top sheet (its history step is reused).
 * `onClose({ reason })` runs once: reason 'close' | 'esc' | 'scrim' | 'back' | 'swipe' | 'replaced' | 'api'.
 */
export function openSheet({ size = 'sm', title = '', body, footer, onClose, hash, headerActions, label, initialFocus, replace = false } = {}) {
  bindPop();
  bindViewport();
  // `replace`: swap the top sheet for this one in place (no Back step in between).
  let inherited = false;
  const old = replace ? sheets[sheets.length - 1] : null;
  if (old) {
    inherited = old.pushed;
    old.close({ reason: 'replaced', fromHistory: true });
  }
  const prevFocus = document.activeElement;
  const prevKey = focusKey(prevFocus);
  const titleId = `sheet-title-${uid()}`;
  const titleEl = h('h2', { class: 'sheet-title', id: titleId }, title);
  const back = h('button', { class: 'icon-btn sheet-back', type: 'button', 'aria-label': 'Back', html: icon('back') });
  const x = h('button', { class: 'icon-btn sheet-x', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', html: icon('x') });
  const bodyEl = h('div', { class: 'sheet-body' }, body);
  const footEl = h('footer', { class: 'sheet-foot' }, footer);
  if (!footer) footEl.hidden = true;
  const grab = h('div', { class: 'sheet-grab', 'aria-hidden': 'true' });
  const box = h('section', {
    class: `sheet ${size === 'lg' ? 'lg' : 'sm'}`, role: 'dialog', 'aria-modal': 'true',
    ...(label ? { 'aria-label': label } : { 'aria-labelledby': titleId }), tabindex: '-1',
  },
  grab,
  h('header', { class: 'sheet-head' }, back, titleEl, h('div', { class: 'sheet-head-actions' }, headerActions), x),
  bodyEl, footEl);
  const scrim = h('div', { class: 'scrim' });
  const layerEl = h('div', { class: `sheet-layer ${size === 'lg' ? 'lg' : 'sm'}` }, scrim, box);
  document.body.appendChild(layerEl);
  document.documentElement.classList.add('has-sheet');

  let pushed = false;
  if (inherited && hash) {
    history.replaceState({ gmbSheet: hash }, '', hash);
    pushed = true;
  } else if (hash && location.hash !== hash) {
    history.pushState({ gmbSheet: hash }, '', hash);
    pushed = true;
  }

  let closed = false;
  const handle = {
    el: box, body: bodyEl, footer: footEl, hash: hash || null, size, pushed,
    setTitle(t) { titleEl.textContent = t; },
    setFooter(node) { footEl.replaceChildren(...[].concat(node ?? [])); footEl.hidden = node == null; },
    close({ reason = 'api', fromHistory = false } = {}) {
      if (closed) return;
      closed = true;
      dropLayer(layer);
      const i = sheets.indexOf(handle);
      if (i >= 0) sheets.splice(i, 1);
      layerEl.classList.remove('open');
      layerEl.classList.add('closing');
      const remove = () => layerEl.remove();
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) remove();
      else setTimeout(remove, 200);
      if (!sheets.length) document.documentElement.classList.remove('has-sheet');
      if (!fromHistory && hash) {
        if (pushed && location.hash === hash) { ignorePops++; history.back(); }
        else if (!pushed && location.hash === hash) history.replaceState(history.state, '', location.pathname + location.search);
      }
      restoreFocus(prevFocus, prevKey);
      onClose && onClose({ reason });
    },
  };
  const layer = { box, onEsc: () => handle.close({ reason: 'esc' }) };
  pushLayer(layer);
  sheets.push(handle);

  back.addEventListener('click', () => handle.close({ reason: 'close' }));
  x.addEventListener('click', () => handle.close({ reason: 'close' }));
  scrim.addEventListener('click', () => handle.close({ reason: 'scrim' }));
  swipeToClose(grab, box, () => handle.close({ reason: 'swipe' }));
  swipeToClose(box.querySelector('.sheet-head'), box, () => handle.close({ reason: 'swipe' }), true);

  requestAnimationFrame(() => {
    layerEl.classList.add('open');
    const target = typeof initialFocus === 'string' ? box.querySelector(initialFocus)
      : initialFocus instanceof Element ? initialFocus
        : isDesktop() ? box.querySelector('input:not([type=hidden]):not([readonly]):not([type=date]), textarea') : null;
    (target || box).focus({ preventScroll: true });
  });
  return handle;
}

// A save re-renders the page (and display sheets) before the sheet closes, so the button that
// opened it is often gone. Openers carry a stable data-focus-key; focus the live one instead.
const focusKey = (el) => (el && el.closest ? el.closest('[data-focus-key]')?.dataset.focusKey || null : null);
function restoreFocus(prev, key) {
  if (!prev || prev === document.body) return;
  if (document.contains(prev)) { prev.focus({ preventScroll: true }); return; }
  const top = sheets[sheets.length - 1];
  const scope = top ? top.el : document;
  const match = key ? [...scope.querySelectorAll('[data-focus-key]')].find((el) => el.dataset.focusKey === key && el.getClientRects().length > 0) : null;
  const target = match || (top ? top.el : document.getElementById('main'));
  if (target) target.focus({ preventScroll: true });
}

// Drag a phone bottom sheet down by its handle to dismiss it.
function swipeToClose(handleEl, box, close, headerOnly = false) {
  if (!handleEl) return;
  let startY = null, dy = 0;
  handleEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || isDesktop() || !box.classList.contains('sm')) return;
    if (headerOnly && e.target.closest('button')) return;
    startY = e.clientY; dy = 0;
    box.style.transition = 'none';
    // Keep the moves coming once the finger leaves the small handle.
    try { handleEl.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  });
  handleEl.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    box.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    box.style.transition = '';
    box.style.transform = '';
    if (dy > 90) close();
  };
  handleEl.addEventListener('pointerup', end);
  handleEl.addEventListener('pointercancel', end);
}

/** Close the top sheet (or all with `{ all: true }`). Returns true when something closed. */
export function closeSheet({ all = false, reason = 'api' } = {}) {
  if (!sheets.length) return false;
  if (all) while (sheets.length) sheets[sheets.length - 1].close({ reason });
  else sheets[sheets.length - 1].close({ reason });
  return true;
}
/** Open sheets, bottom first (handles from openSheet). */
export const openSheets = () => sheets.slice();
export const topSheet = () => sheets[sheets.length - 1] || null;

// ---------------------------------------------------------------- toast
let toastNow = null;
/** Remove the current toast at once (signing out must not leave its Undo or Retry behind). */
export function closeToast() { if (toastNow) toastNow.close(true); }
/**
 * One toast at a time; a new one replaces the old. `action: { label, onClick }`
 * adds a button (Undo, Retry, Reload). Stays open while hovered or focused.
 * `ms` default 6000; 0 keeps it until closed. `tone: 'error'` for failures.
 */
export function toast(message, { action, ms = 6000, tone } = {}) {
  let host = document.getElementById('toasts');
  if (!host) host = document.body.appendChild(h('div', { id: 'toasts', class: 'toast-host', role: 'status', 'aria-live': 'polite' }));
  if (toastNow) toastNow.close(true);
  const btn = action ? h('button', { class: 'toast-action', type: 'button' }, action.label) : null;
  const x = h('button', { class: 'icon-btn toast-x', type: 'button', 'aria-label': 'Dismiss', html: icon('x') });
  const el = h('div', { class: `toast${tone ? ` ${tone}` : ''}` }, h('span', { class: 'toast-msg' }, message), btn, x);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  let timer = null, held = false, done = false;
  const arm = () => { clearTimeout(timer); if (ms > 0 && !held) timer = setTimeout(() => api.close(), ms); };
  const api = {
    el,
    close(instant = false) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (toastNow === api) toastNow = null;
      if (instant) el.remove();
      else { el.classList.remove('in'); setTimeout(() => el.remove(), 160); }
    },
  };
  el.addEventListener('pointerenter', () => { held = true; clearTimeout(timer); });
  el.addEventListener('pointerleave', () => { held = el.contains(document.activeElement); arm(); });
  el.addEventListener('focusin', () => { held = true; clearTimeout(timer); });
  el.addEventListener('focusout', () => { setTimeout(() => { held = el.matches(':hover') || el.contains(document.activeElement); arm(); }, 0); });
  if (btn) btn.addEventListener('click', () => { api.close(); action.onClick(); });
  x.addEventListener('click', () => api.close());
  toastNow = api;
  arm();
  return api;
}

/** The 2px saving bar at the top of the viewport. */
export function busy(on) {
  let bar = document.getElementById('busy-bar');
  if (!bar) bar = document.body.appendChild(h('div', { id: 'busy-bar', class: 'busy-bar', 'aria-hidden': 'true' }));
  bar.classList.toggle('on', Boolean(on));
}

// ----------------------------------------------------------------- menu
let menuNow = null;
/**
 * Popover anchored to `anchor`. items: { label, icon?, onClick, danger?, disabled?, hint? }
 * | '-' (separator) | { header, sub? } | { node } (custom element, e.g. a segmented control).
 */
export function openMenu(anchor, items, { align = 'right', label = 'Menu' } = {}) {
  closeMenu();
  const buttons = [];
  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label },
    items.map((it) => {
      if (it === '-') return h('div', { class: 'menu-sep', role: 'separator' });
      if (it.header != null) return h('div', { class: 'menu-head' }, h('div', { class: 'menu-head-title' }, it.header), it.sub ? h('div', { class: 'menu-head-sub' }, it.sub) : null);
      if (it.node) return h('div', { class: 'menu-node' }, it.node);
      const b = h('button', {
        class: `menu-item${it.danger ? ' danger' : ''}`, type: 'button', role: 'menuitem', disabled: it.disabled,
        onclick: () => { closeMenu(); it.onClick && it.onClick(); },
      }, it.icon ? h('span', { class: 'menu-icon', html: icon(it.icon) }) : null, h('span', { class: 'menu-label' }, it.label),
      it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null);
      buttons.push(b);
      return b;
    }));
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const left = align === 'right' ? r.right - mw : r.left;
  const top = r.bottom + mh + 6 > window.innerHeight ? r.top - mh - 6 : r.bottom + 6;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - mh - 8, top))}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, left))}px`;
  anchor.setAttribute('aria-expanded', 'true');

  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    const move = (d) => { e.preventDefault(); const n = buttons.length; buttons[(i + d + n) % n]?.focus(); };
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1]?.focus(); }
  });
  const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(false); };
  setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
  const layer = { box: menu, onEsc: () => closeMenu() };
  pushLayer(layer);
  menuNow = (refocus) => {
    menu.remove();
    dropLayer(layer);
    document.removeEventListener('pointerdown', onDoc);
    anchor.setAttribute('aria-expanded', 'false');
    if (refocus) anchor.focus({ preventScroll: true });
  };
  (buttons[0] || menu).focus?.();
  return menu;
}
export function closeMenu(refocus = true) {
  if (!menuNow) return false;
  const fn = menuNow;
  menuNow = null;
  fn(refocus);
  return true;
}

// -------------------------------------------------------------- confirm
let confirmNow = null; // finish() of the open confirm, so Back can cancel it
/**
 * The app's only confirm dialog (Delete place, Replace from backup).
 * buttons: [{ label, value, kind: 'primary' | 'danger' | 'secondary' }], shown in order.
 * Resolves with the chosen button's value, or null on Esc / outside click.
 */
export function confirmDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const prevKey = focusKey(prevFocus);
    const titleId = `confirm-${uid()}`;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (confirmNow === finish) confirmNow = null;
      dropLayer(layer);
      wrap.remove();
      restoreFocus(prevFocus, prevKey);
      resolve(v);
    };
    const btns = buttons.map((b) => h('button', { class: `btn ${b.kind || 'secondary'}`, type: 'button', onclick: () => finish(b.value) }, b.label));
    const box = h('div', { class: 'confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('h2', { class: 'confirm-title', id: titleId }, title),
      message ? h('p', { class: 'confirm-text' }, message) : null,
      h('div', { class: 'confirm-actions' }, btns));
    const wrap = h('div', { class: 'confirm-layer' }, h('div', { class: 'scrim', onclick: () => finish(null) }), box);
    document.body.appendChild(wrap);
    const layer = { box, onEsc: () => finish(null) };
    pushLayer(layer);
    confirmNow = finish;
    const primary = btns[buttons.findIndex((b) => b.kind === 'primary')] || btns[0];
    requestAnimationFrame(() => (primary || box).focus());
  });
}

/** Save text as a file through a temporary link. */
export function download(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --------------------------------------------------------- amount field
/**
 * Text field that understands "1,23,456", "1.5L", "45k", "2cr", with a live
 * "₹1,50,000" preview. A leading "-" is accepted only with `allowNegative`.
 * Returns { el, input, preview, value() → number | null, valid(), text(), set(n|text), focus(), clear() }.
 * `onInput(value, text)` fires on every keystroke; `onEnter()` on Enter.
 */
export function amountField({ value, placeholder = '0', allowNegative = false, label, id = `amt-${uid()}`,
  onInput, onEnter, enterkeyhint = 'done', autofocus = false, previewEl } = {}) {
  const input = h('input', {
    class: 'amount-input', id, type: 'text', inputmode: 'decimal', autocomplete: 'off', autocorrect: 'off',
    spellcheck: 'false', enterkeyhint, placeholder, 'aria-label': label || null, autofocus: autofocus || null,
  });
  const preview = previewEl || h('span', { class: 'amount-preview', 'aria-live': 'polite' });
  const el = h('div', { class: 'amount' },
    h('label', { class: 'amount-box', for: id }, h('span', { class: 'amount-prefix', 'aria-hidden': 'true' }, '₹'), input),
    previewEl ? null : preview);

  const read = () => {
    const t = input.value.trim();
    if (!t) return { v: null, ok: true, empty: true };
    const v = parseAmount(t);
    if (v == null) return { v: null, ok: false, msg: 'Type an amount like 45000, 45k or 1.5L' };
    if (v < 0 && !allowNegative) return { v: null, ok: false, msg: "Can't be negative" };
    return { v, ok: true };
  };
  const paint = () => {
    const r = read();
    el.classList.toggle('invalid', !r.ok);
    input.setAttribute('aria-invalid', r.ok ? 'false' : 'true');
    preview.classList.toggle('error', !r.ok);
    preview.textContent = r.empty ? '' : r.ok ? money(r.v) : r.msg;
    return r;
  };
  input.addEventListener('input', () => { const r = paint(); onInput && onInput(r.v, input.value); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } });

  const api = {
    el, input, preview,
    value: () => read().v,
    valid: () => read().ok,
    empty: () => !input.value.trim(),
    text: () => input.value,
    set(v) { input.value = v == null ? '' : typeof v === 'number' ? String(v) : v; paint(); },
    clear() { api.set(''); },
    focus() { input.focus(); },
  };
  if (value != null) api.set(value);
  return api;
}

// ------------------------------------------------------------ date chip
/**
 * "(Today ▾)" chip over a native date picker. `max` defaults to today; `min` optional.
 * `long: true` reads "Today, 31 Oct". Returns { el, value() → iso, set(iso), setMin(iso), setMax(iso) }.
 */
export function dateChip({ value, today = todayLocal(), max = today, min, onChange, long = false, label = 'Date' } = {}) {
  let current = value || today;
  const text = h('span', { class: 'date-chip-text' });
  const input = h('input', { class: 'date-chip-input', type: 'date', 'aria-label': label, max: max || null, min: min || null, value: current });
  const el = h('label', { class: 'date-chip' }, text, h('span', { class: 'date-chip-caret', html: icon('down') }), input);
  const paint = () => {
    const d = dateText(current, today);
    const name = current === today ? 'Today' : current === addDays(today, -1) ? 'Yesterday' : null;
    text.textContent = name ? (long ? `${name}, ${d}` : name) : d;
    input.value = current;
  };
  const clamp = (iso) => {
    if (!iso) return current;
    if (input.max && iso > input.max) return input.max;
    if (input.min && iso < input.min) return input.min;
    return iso;
  };
  input.addEventListener('click', (e) => {
    if (typeof input.showPicker === 'function') { try { e.preventDefault(); input.showPicker(); } catch { /* not allowed here */ } }
  });
  input.addEventListener('change', () => {
    const next = clamp(input.value);
    const changed = next !== current;
    current = next;
    paint();
    if (changed && onChange) onChange(current);
  });
  paint();
  return {
    el,
    value: () => current,
    set(iso) { current = clamp(iso); paint(); },
    setMin(iso) { if (iso) input.min = iso; else input.removeAttribute('min'); current = clamp(current); paint(); },
    setMax(iso) { if (iso) input.max = iso; else input.removeAttribute('max'); current = clamp(current); paint(); },
  };
}

// --------------------------------------------------------------- chips
/**
 * Single-select chips (role radiogroup). options: [{ value, label, sub?, disabled? }].
 * `value` null = nothing chosen (no default). `scroll: true` keeps one row that
 * scrolls sideways on the phone. `cls` adds a class (e.g. 'type-grid').
 * Returns { el, value(), set(v), setOptions(options, v?) }.
 */
export function chips({ options = [], value = null, onChange, label, scroll = false, cls = '', render } = {}) {
  let current = value;
  const el = h('div', { class: `chips${scroll ? ' scroll' : ''}${cls ? ` ${cls}` : ''}`, role: 'radiogroup', 'aria-label': label || null });
  let btns = [];
  const sync = (focusSel = false) => {
    let tabSet = false;
    btns.forEach((b) => {
      const on = b.dataset.value === String(current);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on) tabSet = true;
      if (on && scroll) b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      if (on && focusSel) b.focus();
    });
    if (!tabSet) { const first = btns.find((b) => !b.disabled); if (first) first.tabIndex = 0; }
  };
  const choose = (opt, focusSel) => {
    if (opt.disabled) return;
    const changed = String(opt.value) !== String(current);
    current = opt.value;
    sync(focusSel);
    if (changed && onChange) onChange(current, opt);
  };
  const build = (opts) => {
    btns = opts.map((opt) => {
      const b = h('button', {
        class: 'chip', type: 'button', role: 'radio', 'data-value': String(opt.value), disabled: opt.disabled,
        onclick: () => choose(opt, false),
      }, render ? render(opt) : [h('span', { class: 'chip-label' }, opt.label), opt.sub ? h('span', { class: 'chip-sub' }, opt.sub) : null]);
      b._opt = opt;
      return b;
    });
    el.replaceChildren(...btns);
    sync();
  };
  el.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    const live = btns.filter((b) => !b.disabled);
    const i = live.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = live[(i + keys[e.key] + live.length) % live.length];
    choose(next._opt, true);
  });
  build(options);
  return {
    el,
    value: () => current,
    set(v) { current = v; sync(); },
    setOptions(opts, v = current) { current = opts.some((o) => String(o.value) === String(v)) ? v : null; build(opts); },
  };
}

// ----------------------------------------------------------- segmented
/** Two or three-way toggle, e.g. ( Trend | Monthly ), ( Dark | Light ). Returns { el, value(), set(v) }. */
export function segmented({ options, value, onChange, label } = {}) {
  let current = value ?? options[0]?.value;
  const btns = options.map((o) => h('button', {
    class: 'seg-btn', type: 'button', 'data-value': String(o.value),
    onclick: () => { if (o.value !== current) { current = o.value; sync(); onChange && onChange(current); } },
  }, o.icon ? h('span', { class: 'seg-icon', html: icon(o.icon) }) : null, o.label));
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label || null }, btns);
  const sync = () => btns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.value === String(current) ? 'true' : 'false'));
  sync();
  return { el, value: () => current, set(v) { current = v; sync(); } };
}
