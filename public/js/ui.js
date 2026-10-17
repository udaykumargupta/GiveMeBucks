// DOM helpers: element builder, icons, drawer, modal, confirm, toast, menus.

/** Hyperscript. Strings become text nodes, so user data is never parsed as HTML. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v; // trusted static markup only (icons)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const P = {
  apps: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.9 17.9A10.1 10.1 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  dots: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h.01"/>',
  rupee: '<path d="M6 4h12M6 9h12M14.5 20L6 12h3a4 4 0 0 0 0-8"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  dn: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  warn: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  fire: '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8a7 7 0 0 0 7 7z"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  table: '<path d="M3 5h18v14H3zM3 10h18M3 15h18M9 5v14"/>',
  bank: '<path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  chart: '<path d="M3 3v18h18M7 15l4-4 3 3 6-7"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};
export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
export const iconEl = (name, cls) => h('span', { class: 'icon-wrap', html: icon(name, cls) });

// --------------------------------------------------------------- toasts
export function toast(message, kind = 'success') {
  let host = document.getElementById('toasts');
  if (!host) host = document.body.appendChild(h('div', { id: 'toasts', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast ${kind}` },
    h('span', { class: 'toast-icon', html: icon(kind === 'success' ? 'check' : kind === 'error' ? 'x' : 'warn') }),
    h('span', {}, message));
  host.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3600);
}

// --------------------------------------------------------------- drawer
let drawerClose = null;
export function openDrawer({ title, subtitle, body, footer, width = 560, onClose }) {
  closeDrawer(true);
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { width: `min(${width}px, 100vw)` } },
    h('header', { class: 'drawer-header' },
      h('div', {}, h('h2', {}, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', html: icon('x'), onclick: () => closeDrawer() })),
    h('div', { class: 'drawer-body' }, body),
    footer ? h('footer', { class: 'drawer-footer' }, footer) : null);
  const backdrop = h('div', { class: 'backdrop', onclick: () => closeDrawer() });
  document.body.append(backdrop, panel);
  requestAnimationFrame(() => { panel.classList.add('open'); backdrop.classList.add('open'); });
  drawerClose = () => {
    panel.remove(); backdrop.remove();
    onClose && onClose();
  };
  setTimeout(() => panel.querySelector('input:not([type=hidden]):not([readonly]), select, textarea')?.focus(), 60);
  return panel;
}
export function closeDrawer(silent) {
  if (drawerClose) {
    const fn = drawerClose;
    drawerClose = null;
    fn();
  }
  if (!silent && location.hash) history.replaceState(null, '', location.pathname);
}
export const drawerOpen = () => !!drawerClose;

// ---------------------------------------------------------------- modal
let modalClose = null;
export function openModal({ title, body, wide = false, onClose }) {
  closeModal();
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'modal-header' }, h('h2', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', html: icon('x'), onclick: () => closeModal() })),
    h('div', { class: 'modal-body' }, body));
  const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap) closeModal(); } }, box);
  document.body.appendChild(wrap);
  modalClose = () => { wrap.remove(); onClose && onClose(); };
  return box;
}
export function closeModal() {
  if (modalClose) { const fn = modalClose; modalClose = null; fn(); return true; }
  return false;
}

export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; closeModal(); resolve(v); } };
    const body = h('div', {},
      h('p', { class: 'confirm-text' }, message),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn secondary', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, confirmText)));
    openModal({ title, body, onClose: () => { if (!done) { done = true; resolve(false); } } });
    setTimeout(() => body.querySelector(`.btn.${danger ? 'danger' : 'primary'}`)?.focus(), 30);
  });
}

// ----------------------------------------------------------- dropdowns
let menuClose = null;
export function openMenu(anchor, items, { align = 'left' } = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' },
    items.map((it) => it === '-' ? h('div', { class: 'menu-sep' }) : it.header ? h('div', { class: 'menu-header' }, it.header) :
      h('button', {
        class: `menu-item ${it.active ? 'active' : ''}`, role: 'menuitemradio', 'aria-checked': it.active ? 'true' : 'false',
        disabled: it.disabled, onclick: () => { closeMenu(); it.onClick(); },
      }, h('span', { class: 'menu-check', html: it.active ? icon('check') : (it.icon ? icon(it.icon) : '') }), h('span', {}, it.label),
      it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null)));
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, align === 'right' ? r.right - mw : r.left))}px`;
  const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
  menuClose = () => { menu.remove(); document.removeEventListener('pointerdown', onDoc); };
  menu.querySelector('.menu-item')?.focus();
}
export function closeMenu() {
  if (menuClose) { const fn = menuClose; menuClose = null; fn(); return true; }
  return false;
}

export function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 12);
