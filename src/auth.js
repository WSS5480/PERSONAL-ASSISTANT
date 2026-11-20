// Sessions (DB-backed, signed cookie), auth middleware, CSRF header check, rate limiting.
import { randomId } from './crypto.js';

export const COOKIE = 'ma_sid';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'MyAssistant';
const SESSION_DAYS = 30;

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function createSession(ctx, res, userId) {
  const id = randomId(32);
  await ctx.db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [id, userId]);
  setCookie(ctx, res, ctx.secrets.sign(id), SESSION_DAYS * 86400);
}

export function setCookie(ctx, res, value, maxAge) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (ctx.config.secureCookies) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export async function destroySession(ctx, req, res) {
  if (req.sessionId) await ctx.db.query('DELETE FROM sessions WHERE id = $1', [req.sessionId]);
  setCookie(ctx, res, '', 0);
}

// Loads req.user if a valid session cookie is present. Never throws for missing auth.
export function loadUser(ctx) {
  return async (req, _res, next) => {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    const sid = raw && ctx.secrets.unsign(raw);
    if (sid) {
      const row = await ctx.db.one(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > now() AND u.disabled = FALSE`, [sid]);
      if (row) { req.user = row; req.sessionId = sid; }
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

// Blocks everything but password change while a temporary password is in force.
export function requirePasswordCurrent(req, res, next) {
  if (req.user?.must_change_password) return res.status(403).json({ error: 'Change your temporary password first.', mustChangePassword: true });
  next();
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  next();
};

// CSRF: every state-changing request must be JSON and carry the custom header (cross-site forms can't set it).
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) return res.status(403).json({ error: 'Missing request header.' });
  const ct = req.headers['content-type'] || '';
  if (req.headers['content-length'] && req.headers['content-length'] !== '0' && !ct.includes('application/json')) {
    return res.status(415).json({ error: 'JSON only.' });
  }
  next();
}

// Simple in-memory fixed-window limiter keyed by user id (or IP).
export function rateLimit({ windowMs, max, name }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = `${name}:${req.user?.id ?? req.ip}`;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
    if (++e.n > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests - wait a minute and try again.' });
    }
    next();
  };
}

// Public view of a user. Never includes secrets - only "set" + last 4.
export function publicUser(u, { admin = false } = {}) {
  const base = {
    id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone,
    accessLevel: u.access_level, district: u.district_label, store: u.store_label,
    mustChangePassword: u.must_change_password,
    domoToken: { set: !!u.domo_token_enc, last4: u.domo_token_enc ? u.domo_token_last4 : null },
  };
  if (admin) {
    Object.assign(base, {
      disabled: u.disabled, houseKeyAllowed: u.house_key_allowed, createdAt: u.created_at,
      aiKey: { set: !!u.ai_key_enc, last4: u.ai_key_enc ? u.ai_key_last4 : null },
    });
  }
  return base;
}
