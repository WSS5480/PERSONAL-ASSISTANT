// Google OAuth (authorization-code flow) + token storage/refresh. Plain fetch to Google REST.
import { randomId } from '../crypto.js';

export const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const googleConfigured = (config) => !!(config.googleClientId && config.googleClientSecret && config.appUrl);
export const redirectUri = (config) => `${config.appUrl}/auth/google/callback`;

export async function googleConnected(ctx) {
  if (!googleConfigured(ctx.config)) return false;
  if (ctx.cache && 'googleConnected' in ctx.cache) return ctx.cache.googleConnected;
  const row = await ctx.db.one('SELECT user_id FROM google_tokens WHERE user_id = $1', [ctx.user.id]);
  if (ctx.cache) ctx.cache.googleConnected = !!row;
  return !!row;
}

export async function startAuth(ctx, userId) {
  const state = randomId(24);
  await ctx.db.query("DELETE FROM oauth_states WHERE expires_at < now()");
  await ctx.db.query("INSERT INTO oauth_states (state, user_id, expires_at) VALUES ($1,$2, now() + interval '10 minutes')", [state, userId]);
  const q = new URLSearchParams({
    client_id: ctx.config.googleClientId, redirect_uri: redirectUri(ctx.config), response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `${AUTH_URL}?${q}`;
}

// Validates state (exists, unexpired, belongs to the signed-in user), exchanges code, stores encrypted tokens.
export async function finishAuth(ctx, userId, { code, state }) {
  const row = await ctx.db.one('DELETE FROM oauth_states WHERE state = $1 RETURNING user_id, expires_at', [String(state || '')]);
  if (!row || row.user_id !== userId || new Date(row.expires_at) < new Date()) throw new Error('Invalid or expired sign-in state');
  if (!code) throw new Error('Missing code');
  const tok = await tokenRequest(ctx, { code, grant_type: 'authorization_code', redirect_uri: redirectUri(ctx.config) });
  let email = '';
  if (tok.id_token) {
    try { email = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()).email || ''; } catch { /* ignore */ }
  }
  await ctx.db.query(`INSERT INTO google_tokens (user_id, email, access_enc, refresh_enc, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)
    ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, access_enc = EXCLUDED.access_enc,
      refresh_enc = COALESCE(EXCLUDED.refresh_enc, google_tokens.refresh_enc), expires_at = EXCLUDED.expires_at`,
  [userId, email, ctx.secrets.encrypt(tok.access_token), tok.refresh_token ? ctx.secrets.encrypt(tok.refresh_token) : null, String(tok.expires_in || 3600)]);
  return { email };
}

async function tokenRequest(ctx, params) {
  const res = await ctx.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ctx.config.googleClientId, client_secret: ctx.config.googleClientSecret, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token error: ${body.error || res.status}`);
  return body;
}

export async function accessToken(ctx) {
  const row = await ctx.db.one('SELECT * FROM google_tokens WHERE user_id = $1', [ctx.user.id]);
  if (!row) throw new Error('Google is not connected - connect it in Settings.');
  if (new Date(row.expires_at).getTime() - 60000 > Date.now()) return ctx.secrets.decrypt(row.access_enc);
  if (!row.refresh_enc) throw new Error('Google sign-in expired - reconnect Google in Settings.');
  const tok = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: ctx.secrets.decrypt(row.refresh_enc) });
  await ctx.db.query("UPDATE google_tokens SET access_enc = $2, expires_at = now() + ($3 || ' seconds')::interval WHERE user_id = $1",
    [ctx.user.id, ctx.secrets.encrypt(tok.access_token), String(tok.expires_in || 3600)]);
  return tok.access_token;
}

export async function googleApi(ctx, url, { method = 'GET', body } = {}) {
  const token = await accessToken(ctx);
  const res = await ctx.fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${data.error?.message || 'request failed'}`);
  return data;
}
