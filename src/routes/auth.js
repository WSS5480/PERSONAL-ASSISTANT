import express from 'express';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../crypto.js';
import { createSession, destroySession, requireUser, rateLimit, publicUser } from '../auth.js';
import { isValidTimeZone } from '../time.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validEmail = (e) => EMAIL_RE.test(String(e || '')) && String(e).length <= 200;
export const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
const sameCode = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function authRoutes(ctx) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 10, name: 'auth' });

  r.get('/status', async (req, res) => {
    const { n } = await ctx.db.one('SELECT count(*)::int AS n FROM users');
    res.json({ signedIn: !!req.user, firstUser: n === 0, signupOpen: n === 0 || !!ctx.config.signupCode });
  });

  r.post('/signup', limiter, async (req, res) => {
    const { email, password, name, inviteCode, timezone } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const { n } = await ctx.db.one('SELECT count(*)::int AS n FROM users');
    let role = 'user';
    if (n === 0) role = 'owner';
    else if (!ctx.config.signupCode) return res.status(403).json({ error: 'Sign-up is closed. Ask the admin for an account.' });
    else if (!sameCode(inviteCode, ctx.config.signupCode)) return res.status(403).json({ error: 'Invalid invite code.' });
    const tz = isValidTimeZone(timezone) ? timezone : 'America/Chicago';
    let user;
    try {
      user = await ctx.db.one(`INSERT INTO users (email, name, password_hash, role, timezone, access_level)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(email).trim().toLowerCase(), String(name || '').trim().slice(0, 100), hashPassword(password), role, tz, role === 'owner' ? 'executive' : 'store']);
    } catch (e) {
      if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: role === 'owner' ? 'Owner already exists - try again.' : 'That email already has an account.' });
      throw e;
    }
    await createSession(ctx, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  r.post('/signin', limiter, async (req, res) => {
    const { email, password } = req.body || {};
    const user = await ctx.db.one('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
    if (!user || !verifyPassword(String(password || ''), user.password_hash) || user.disabled) {
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    await createSession(ctx, res, user.id);
    res.json({ user: publicUser(user) });
  });

  r.post('/signout', async (req, res) => {
    await destroySession(ctx, req, res);
    res.json({ ok: true });
  });

  r.post('/change-password', limiter, requireUser, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!verifyPassword(String(currentPassword || ''), req.user.password_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    if (newPassword === currentPassword) return res.status(400).json({ error: 'Pick a different password.' });
    await ctx.db.query('UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1', [req.user.id, hashPassword(newPassword)]);
    await ctx.db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.sessionId]);
    res.json({ ok: true });
  });

  return r;
}
