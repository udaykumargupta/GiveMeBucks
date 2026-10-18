import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGoogleVerifier, createSessions, parseAllowlist, isAllowed, safeUserId, SESSION_TTL_MS } from '../lib/auth.js';

const CLIENT = 'test-client.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A Google-style ID token signed with our test key. */
function idToken(claims = {}, { kid = 'k1', alg = 'RS256', key = privateKey } = {}) {
  const header = b64({ alg, kid, typ: 'JWT' });
  const payload = b64({
    iss: 'https://accounts.google.com', aud: CLIENT, sub: '1234567890',
    email: 'Uday@Example.com', email_verified: true, name: 'Uday G', picture: 'https://lh3.googleusercontent.com/a/x',
    iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600, ...claims,
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function verifier({ keys = [jwk], calls = { n: 0 }, clientId = CLIENT } = {}) {
  return createGoogleVerifier({ clientId, now: () => NOW, fetchKeys: async () => { calls.n++; return { keys }; } });
}

test('accepts a valid Google ID token and returns the profile', async () => {
  const user = await verifier()(idToken());
  assert.deepEqual(user, { sub: '1234567890', email: 'uday@example.com', name: 'Uday G', picture: 'https://lh3.googleusercontent.com/a/x' });
});

test('rejects tokens meant for another app, from another issuer, or expired', async () => {
  const verify = verifier();
  await assert.rejects(verify(idToken({ aud: 'someone-else' })), /Invalid Google ID token/);
  await assert.rejects(verify(idToken({ iss: 'https://evil.example' })), /Invalid Google ID token/);
  await assert.rejects(verify(idToken({ exp: NOW / 1000 - 1 })), /Invalid Google ID token/);
  await assert.rejects(verify(idToken({ sub: '' })), /Invalid Google ID token/);
});

test('requires a verified email (boolean or the legacy "true" string)', async () => {
  const verify = verifier();
  await assert.rejects(verify(idToken({ email_verified: false })), /email is not verified/);
  assert.equal((await verify(idToken({ email_verified: 'true' }))).sub, '1234567890');
});

test('rejects tampered payloads, foreign signatures and algorithm tricks', async () => {
  const verify = verifier();
  const [h, , s] = idToken().split('.');
  await assert.rejects(verify(`${h}.${b64({ sub: '1', aud: CLIENT, iss: 'accounts.google.com', exp: NOW / 1000 + 60, email_verified: true })}.${s}`), /Invalid/);
  await assert.rejects(verify(idToken({}, { key: other.privateKey })), /Invalid Google ID token/);
  const [, p] = idToken().split('.');
  await assert.rejects(verify(`${b64({ alg: 'none', kid: 'k1' })}.${p}.`), /Invalid Google ID token/);
  await assert.rejects(verify(`${b64({ alg: 'HS256', kid: 'k1' })}.${p}.${s}`), /Invalid Google ID token/);
  for (const junk of ['', 'a.b', 'not-a-token', 'x.y.z']) await assert.rejects(verify(junk));
});

test('caches Google keys and refetches only for an unknown key id', async () => {
  const calls = { n: 0 };
  const verify = verifier({ calls });
  await verify(idToken());
  await verify(idToken());
  assert.equal(calls.n, 1);
  await assert.rejects(verify(idToken({}, { kid: 'rotated' })), /Could not verify Google ID token/);
  assert.equal(calls.n, 2);
});

test('refuses to verify when no client id is configured', async () => {
  await assert.rejects(verifier({ clientId: '' })(idToken()), (e) => e.status === 503);
});

test('session tokens round-trip and fail closed', () => {
  let clock = NOW;
  const sessions = createSessions({ secret: 'x'.repeat(48), ttlMs: 60_000, now: () => clock });
  const token = sessions.issue({ sub: '42', email: 'a@example.com', name: 'A', picture: 'p' });
  assert.deepEqual(sessions.verify(token), { sub: '42', email: 'a@example.com', name: 'A', picture: 'p', exp: NOW / 1000 + 60 });

  const [h, p, s] = token.split('.');
  const forged = b64({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: '43' });
  assert.equal(sessions.verify(`${h}.${forged}.${s}`), null, 'edited claims');
  assert.equal(sessions.verify(`${h}.${p}.${s.slice(0, -2)}xx`), null, 'bad signature');
  assert.equal(sessions.verify(`${b64({ alg: 'none' })}.${p}.`), null, 'alg none');
  assert.equal(createSessions({ secret: 'y'.repeat(48), now: () => clock }).verify(token), null, 'other secret');
  assert.equal(sessions.verify('garbage'), null);
  clock = NOW + 61_000;
  assert.equal(sessions.verify(token), null, 'expired');
});

test('sessions last 30 days by default (JWT_EXPIRATION_MS default)', () => {
  assert.equal(SESSION_TTL_MS, 2592000000);
  let clock = NOW;
  const sessions = createSessions({ secret: 'x'.repeat(48), now: () => clock });
  assert.equal(sessions.ttlMs, SESSION_TTL_MS);
  const token = sessions.issue({ sub: '42', email: 'a@example.com' });
  assert.equal(sessions.verify(token).exp, NOW / 1000 + 30 * 24 * 60 * 60);
  clock = NOW + 29 * 24 * 60 * 60 * 1000;
  assert.ok(sessions.verify(token), 'still signed in after 29 days');
  clock = NOW + SESSION_TTL_MS;
  assert.equal(sessions.verify(token), null, 'expired after 30 days');
});

test('session secret must be long enough', () => {
  assert.throws(() => createSessions({ secret: 'short' }), /at least 32/);
});

test('allowlist parsing and matching are case-insensitive; empty allows everyone', () => {
  const allow = parseAllowlist(' Uday@Example.com, b@example.org ;\nc@example.net ');
  assert.deepEqual([...allow], ['uday@example.com', 'b@example.org', 'c@example.net']);
  assert.equal(isAllowed('UDAY@example.com', allow), true);
  assert.equal(isAllowed('stranger@example.com', allow), false);
  assert.equal(isAllowed('anyone@example.org', parseAllowlist('')), true);
});

test('user ids are safe to use as file names', () => {
  assert.equal(safeUserId('1234567890'), '1234567890');
  assert.equal(safeUserId('../../etc/passwd'), 'etcpasswd');
  assert.throws(() => safeUserId('../'));
});
