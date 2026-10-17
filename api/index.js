// Vercel entry point. vercel.json rewrites every /api/* request here; the
// files in public/ are served by Vercel's CDN. Same handler as the local
// server, but a deployment fails closed: until Google sign-in and a database
// are configured, it serves no data at all. Anyone with a Google account can
// sign in (each gets a private dashboard) unless ALLOWED_EMAILS restricts it.
import { createHandler } from '../lib/app.js';
import { createGoogleVerifier, createSessions, parseAllowlist, MIN_SECRET_LENGTH } from '../lib/auth.js';
import { neonStorage, databaseUrl } from '../lib/storage.js';

export function createVercelHandler(env = process.env) {
  const get = (key) => String(env[key] ?? '').trim();
  const clientId = get('GOOGLE_CLIENT_ID');
  const secret = get('JWT_SECRET');
  const allow = parseAllowlist(get('ALLOWED_EMAILS'));
  const dbUrl = databaseUrl(env);

  const setupMissing = [];
  if (!clientId) setupMissing.push('GOOGLE_CLIENT_ID');
  if (secret.length < MIN_SECRET_LENGTH) setupMissing.push(`JWT_SECRET (${MIN_SECRET_LENGTH}+ characters)`);
  if (!dbUrl) setupMissing.push('DATABASE_URL (connect a Neon database)');

  const ready = setupMissing.length === 0;
  const auth = ready
    ? {
      enabled: true, clientId, allow,
      sessions: createSessions({ secret, ttlMs: Number(get('JWT_EXPIRATION_MS')) || 7 * 24 * 60 * 60 * 1000 }),
      verifyGoogle: createGoogleVerifier({ clientId }),
    }
    : { enabled: false, clientId, allow };
  // No macOS in the cloud; reminders are local-only for now.
  const reminders = { kind: 'none', test: async () => false, status: () => ({}) };
  const storage = ready ? neonStorage(dbUrl) : { kind: 'database' };

  return createHandler({ publicDir: null, auth, storage, reminders, requireAuth: true, setupMissing });
}

let handler;
export default function vercelHandler(req, res) {
  handler ||= createVercelHandler();
  return handler(req, res);
}
