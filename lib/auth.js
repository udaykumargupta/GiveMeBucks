// Google sign-in, the same way Kairos does it: the browser gets an ID token from
// Google Identity Services, we verify it ourselves against Google's published
// keys, then hand back our own short-lived HMAC-signed session token (sent as a
// Bearer header). Zero dependencies — only node:crypto and fetch.
import crypto from 'node:crypto';

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 60 * 60 * 1000;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
export const MIN_SECRET_LENGTH = 32;

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

const fromB64url = (s) => Buffer.from(s, 'base64url');
const toB64url = (v) => Buffer.from(v).toString('base64url');

async function fetchGoogleKeys() {
  const res = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Google key endpoint returned ${res.status}`);
  return res.json();
}

/**
 * Returns verify(idToken) → { sub, email, name, picture }. Google rotates its
 * signing keys, so the key set is cached for an hour and refetched when a token
 * names a key id we haven't seen.
 */
export function createGoogleVerifier({ clientId, fetchKeys = fetchGoogleKeys, now = Date.now }) {
  let cache = { keys: null, fetchedAt: 0 };

  async function keyFor(kid) {
    const fresh = cache.keys && now() - cache.fetchedAt < JWKS_TTL_MS;
    if (fresh && cache.keys.has(kid)) return cache.keys.get(kid);
    const jwks = await fetchKeys();
    const keys = new Map();
    for (const k of jwks?.keys || []) {
      if (k.kty !== 'RSA' || !k.kid) continue;
      try {
        keys.set(k.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' }));
      } catch { /* skip malformed keys */ }
    }
    cache = { keys, fetchedAt: now() };
    const key = keys.get(kid);
    if (!key) throw new Error('Token signed by an unknown Google key');
    return key;
  }

  return async function verifyGoogleIdToken(idToken) {
    if (!clientId) throw new AuthError('Google sign-in is not configured', 503);
    if (typeof idToken !== 'string' || !idToken.trim()) throw new AuthError('Missing Google ID token');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new AuthError('Invalid Google ID token');

    let header, claims;
    try {
      header = JSON.parse(fromB64url(parts[0]));
      claims = JSON.parse(fromB64url(parts[1]));
    } catch {
      throw new AuthError('Invalid Google ID token');
    }
    if (header.alg !== 'RS256') throw new AuthError('Invalid Google ID token');

    let key;
    try {
      key = await keyFor(header.kid);
    } catch {
      throw new AuthError('Could not verify Google ID token');
    }
    const signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]));
    if (!signed) throw new AuthError('Invalid Google ID token');

    if (!GOOGLE_ISSUERS.has(claims.iss)) throw new AuthError('Invalid Google ID token');
    if (claims.aud !== clientId) throw new AuthError('Invalid Google ID token');
    if (!(Number(claims.exp) * 1000 > now())) throw new AuthError('Invalid Google ID token');
    if (!claims.sub) throw new AuthError('Invalid Google ID token');
    // email_verified is normally a boolean but has historically appeared as "true".
    if (claims.email_verified !== true && claims.email_verified !== 'true') {
      throw new AuthError('Google account email is not verified');
    }
    return {
      sub: String(claims.sub),
      email: String(claims.email || '').trim().toLowerCase(),
      name: claims.name ? String(claims.name) : '',
      picture: claims.picture ? String(claims.picture) : '',
    };
  };
}

/** Our own session tokens: HS256 JWTs with sub, email, name, picture, iat, exp. */
export function createSessions({ secret, ttlMs = 7 * 24 * 60 * 60 * 1000, now = Date.now }) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const key = Buffer.from(secret, 'utf8');
  const header = toB64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const sign = (input) => crypto.createHmac('sha256', key).update(input).digest();

  return {
    ttlMs,
    issue(user) {
      const iat = Math.floor(now() / 1000);
      const claims = { sub: user.sub, email: user.email, name: user.name || '', iat, exp: iat + Math.floor(ttlMs / 1000) };
      if (user.picture) claims.picture = user.picture;
      const input = `${header}.${toB64url(JSON.stringify(claims))}`;
      return `${input}.${toB64url(sign(input))}`;
    },
    /** Every failure collapses to null ("not signed in"), like Kairos. */
    verify(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      try {
        // Pin the algorithm so a token can't talk us into a weaker scheme.
        if (JSON.parse(fromB64url(parts[0])).alg !== 'HS256') return null;
        const got = fromB64url(parts[2]);
        const want = sign(`${parts[0]}.${parts[1]}`);
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
        const claims = JSON.parse(fromB64url(parts[1]));
        if (!(Number(claims.exp) * 1000 > now())) return null;
        if (typeof claims.sub !== 'string' || !claims.sub) return null;
        return { sub: claims.sub, email: claims.email || '', name: claims.name || '', picture: claims.picture || '', exp: claims.exp };
      } catch {
        return null;
      }
    },
  };
}

/** "a@example.com, b@example.org" → Set of lowercase emails. An empty set means anyone may sign in. */
export function parseAllowlist(raw) {
  return new Set(String(raw || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export const isAllowed = (email, allow) => allow.size === 0 || allow.has(String(email || '').toLowerCase());

/** Google subject ids are digits; anything else is stripped so it is safe in a file name. */
export function safeUserId(sub) {
  const id = String(sub || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) throw new AuthError('Invalid user id');
  return id;
}
