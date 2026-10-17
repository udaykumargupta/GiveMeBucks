// Google sign-in in the browser, mirroring Kairos: read the client id from
// /api/public/config, render Google's "Sign in with Google" button, trade its ID
// token for our session token (POST /api/auth/google), keep that in
// localStorage, send it as a Bearer header, and sign out on any 401.
import { h, logoSvg } from './ui.js';

const TOKEN_KEY = 'gmb_jwt';
const GSI_SRC = 'https://accounts.google.com/gsi/client';

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }
let config = { googleClientId: null, authRequired: false, restricted: false };
const signOutListeners = new Set();

export async function loadConfig() {
  const res = await fetch('/api/public/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  config = await res.json();
  return config;
}
export const authRequired = () => Boolean(config.authRequired);

function claimsOf(t) {
  try {
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** The signed-in user from the stored token, or null when missing or expired. */
export function currentUser() {
  const c = token && claimsOf(token);
  if (!c || !(c.exp * 1000 > Date.now())) return null;
  return { email: c.email || '', name: c.name || '', picture: c.picture || '' };
}

/** fetch() for our API: adds the Bearer token; a 401 signs out and shows the sign-in page. */
export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && authRequired()) {
    signOut({ expired: true });
    throw new Error('Your session expired — please sign in again.');
  }
  return res;
}

export const onSignOut = (fn) => signOutListeners.add(fn);

export function signOut({ expired = false } = {}) {
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ }
  for (const fn of signOutListeners) fn({ expired });
}

let gsiLoading = null;
function loadGoogleScript() {
  if (window.google?.accounts?.id) return Promise.resolve();
  gsiLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gsiLoading = null; s.remove(); reject(new Error('Could not load Google sign-in')); };
    document.head.appendChild(s);
  });
  return gsiLoading;
}

/** Full-screen sign-in page. Calls onSignedIn(user) once the server accepts the Google login. */
export function renderGate(root, { onSignedIn, expired = false }) {
  const error = h('div', { class: 'auth-error', role: 'alert' }, expired ? 'Your session expired. Please sign in again.' : '');
  const slot = h('div', { class: 'gsi-button' }, h('span', { class: 'gsi-loading' }, 'Loading Google sign-in…'));
  root.replaceChildren(h('div', { class: 'auth-gate' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'auth-logo', html: logoSvg('gate') }),
      h('h1', {}, 'Welcome to GiveMeBucks'),
      h('p', { class: 'auth-intro' }, 'Sign in with Google to open your dashboard. Your money data stays private to your account.'),
      slot,
      error,
      config.restricted ? h('p', { class: 'auth-foot' }, 'Only invited Google accounts can sign in.') : null)));

  if (!config.googleClientId) {
    slot.replaceChildren(h('div', { class: 'gsi-missing' }, 'Google sign-in isn’t configured yet. Set GOOGLE_CLIENT_ID on the server and restart it.'));
    return;
  }

  async function onCredential(response) {
    error.textContent = '';
    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: response.credential }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.token) throw new Error(body.message || 'Sign-in failed. Please try again.');
      token = body.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* session still works for this tab */ }
      onSignedIn(body.user);
    } catch (e) {
      error.textContent = e.message;
    }
  }

  loadGoogleScript().then(() => {
    window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: onCredential });
    slot.replaceChildren();
    window.google.accounts.id.renderButton(slot, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
  }).catch(() => {
    slot.replaceChildren(h('div', { class: 'gsi-missing' }, 'Couldn’t load Google sign-in. Check your internet connection and reload the page.'));
  });
}
