// Builds the Express app. Dependencies are injectable for tests (db, fetch, Anthropic client factory).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecrets } from './crypto.js';
import { loadUser, csrfGuard, requireUser } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { apiRoutes } from './routes/api.js';
import { adminRoutes } from './routes/admin.js';
import { googleConfigured, startAuth, finishAuth } from './integrations/google.js';
import { defaultCreateClient } from './ai/loop.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ db, config, fetchImpl = globalThis.fetch, createClient = defaultCreateClient }) {
  const ctx = { db, config, secrets: createSecrets(config.sessionSecret), fetch: fetchImpl, createClient };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (config.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.get('/healthz', async (_req, res) => {
    try { await db.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use(express.json({ limit: '200kb' }));
  app.use(loadUser(ctx));
  app.use(['/api', '/auth'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(['/api', '/auth'], csrfGuard);

  // Google OAuth (browser navigations, GET).
  app.get('/auth/google/start', requireUser, async (req, res) => {
    if (!googleConfigured(config)) return res.redirect('/#settings');
    res.redirect(await startAuth(ctx, req.user.id));
  });
  app.get('/auth/google/callback', requireUser, async (req, res) => {
    try {
      await finishAuth(ctx, req.user.id, { code: req.query.code, state: req.query.state });
      res.redirect('/#settings?google=connected');
    } catch (e) {
      console.error('[google] callback:', e.message);
      res.redirect('/#settings?google=failed');
    }
  });

  app.use('/auth', authRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', apiRoutes(ctx));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(PUBLIC, {
    // Always revalidate the shell so a new deploy shows up on the next load (phones cache hard).
    setHeaders(res, file) { if (/\.(js|css|html|json)$/.test(file)) res.set('Cache-Control', 'no-cache'); },
  }));

  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too large.' });
    console.error('[error]', req.method, req.path, err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return { app, ctx };
}
