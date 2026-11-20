// Owner/admin console API. Role checks are server-side on every route.
import express from 'express';
import { requireRole, requirePasswordCurrent, publicUser } from '../auth.js';
import { hashPassword, last4 } from '../crypto.js';
import { normalizeRepo, listTokenRepos } from '../integrations/github.js';
import { isValidTimeZone } from '../time.js';
import { validEmail, validPassword } from './auth.js';
import { intId } from './api.js';
import { audit } from '../audit.js';
import { domoListAllDatasets, domoDatasetCards } from '../integrations/domo.js';

const ACCESS = ['executive', 'district', 'store'];

export function adminRoutes(ctx) {
  const r = express.Router();
  r.use(requireRole('owner', 'admin'), requirePasswordCurrent);

  async function withGrants(users) {
    const grants = await ctx.db.query('SELECT user_id, repo FROM repo_grants ORDER BY repo');
    return users.map((u) => ({ ...publicUser(u, { admin: true }), repos: grants.filter((g) => g.user_id === u.id).map((g) => g.repo) }));
  }

  // Loads the target user and blocks admins from touching the owner account.
  async function target(req, res) {
    const id = intId(req.params.id);
    if (!id) { res.status(400).json({ error: 'Bad id' }); return null; }
    const u = await ctx.db.one('SELECT * FROM users WHERE id = $1', [id]);
    if (!u) { res.status(404).json({ error: 'Not found' }); return null; }
    if (u.role === 'owner' && req.user.role !== 'owner') { res.status(403).json({ error: 'Only the owner can change the owner account.' }); return null; }
    return u;
  }

  r.get('/users', async (req, res) => {
    res.json({ users: await withGrants(await ctx.db.query('SELECT * FROM users ORDER BY id')) });
  });

  r.post('/users', async (req, res) => {
    const { email, name, password, role = 'user', accessLevel = 'store', district = '', store = '', timezone } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be user or admin.' });
    if (role !== 'user' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can create admins.' });
    if (!ACCESS.includes(accessLevel)) return res.status(400).json({ error: 'Bad access level.' });
    try {
      const u = await ctx.db.one(`INSERT INTO users (email, name, password_hash, role, access_level, district_label, store_label, timezone, must_change_password)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, TRUE) RETURNING *`,
      [String(email).trim().toLowerCase(), String(name || '').slice(0, 100), hashPassword(password), role, accessLevel,
        String(district).slice(0, 100), String(store).slice(0, 100), isValidTimeZone(timezone) ? timezone : 'America/Chicago']);
      res.status(201).json({ user: (await withGrants([u]))[0] });
    } catch (e) {
      if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: 'That email already has an account.' });
      throw e;
    }
  });

  r.patch('/users/:id', async (req, res) => {
    const u = await target(req, res); if (!u) return;
    const b = req.body || {};
    const sets = []; const vals = [u.id];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) set('name', String(b.name).slice(0, 100));
    if (b.accessLevel !== undefined) { if (!ACCESS.includes(b.accessLevel)) return res.status(400).json({ error: 'Bad access level.' }); set('access_level', b.accessLevel); }
    if (b.district !== undefined) set('district_label', String(b.district).slice(0, 100));
    if (b.store !== undefined) set('store_label', String(b.store).slice(0, 100));
    if (b.timezone !== undefined) { if (!isValidTimeZone(b.timezone)) return res.status(400).json({ error: 'Unknown timezone.' }); set('timezone', b.timezone); }
    if (b.disabled !== undefined) {
      if (u.id === req.user.id || u.role === 'owner') return res.status(400).json({ error: 'You cannot disable this account.' });
      set('disabled', !!b.disabled);
    }
    if (b.role !== undefined) {
      if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change roles.' });
      if (!['user', 'admin'].includes(b.role) || u.role === 'owner') return res.status(400).json({ error: 'Role must be user or admin (owner cannot be changed).' });
      set('role', b.role);
    }
    if (b.houseKeyAllowed !== undefined) {
      if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change house-key use.' });
      set('house_key_allowed', !!b.houseKeyAllowed);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    const updated = await ctx.db.one(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (b.disabled) await ctx.db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    res.json({ user: (await withGrants([updated]))[0] });
  });

  r.post('/users/:id/password', async (req, res) => {
    const u = await target(req, res); if (!u) return;
    if (!validPassword(req.body?.password)) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
    await ctx.db.query('UPDATE users SET password_hash = $2, must_change_password = TRUE WHERE id = $1', [u.id, hashPassword(req.body.password)]);
    await ctx.db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    res.json({ ok: true });
  });

  // Secrets: write-only. Responses carry only set + last 4.
  for (const [path, col, label] of [['ai-key', 'ai_key', 'AI key'], ['domo-token', 'domo_token', 'Domo token']]) {
    r.put(`/users/:id/${path}`, async (req, res) => {
      const u = await target(req, res); if (!u) return;
      const v = String(req.body?.value || '').trim();
      if (v.length < 8) return res.status(400).json({ error: `Paste the full ${label}.` });
      await ctx.db.query(`UPDATE users SET ${col}_enc = $2, ${col}_last4 = $3 WHERE id = $1`, [u.id, ctx.secrets.encrypt(v), last4(v)]);
      res.json({ set: true, last4: last4(v) });
    });
    r.delete(`/users/:id/${path}`, async (req, res) => {
      const u = await target(req, res); if (!u) return;
      await ctx.db.query(`UPDATE users SET ${col}_enc = NULL, ${col}_last4 = NULL WHERE id = $1`, [u.id]);
      res.json({ set: false, last4: null });
    });
  }

  r.put('/users/:id/repos', async (req, res) => {
    const u = await target(req, res); if (!u) return;
    let repos;
    try { repos = [...new Set((req.body?.repos || []).map(normalizeRepo))]; } catch (e) { return res.status(400).json({ error: e.message }); }
    await ctx.db.query('DELETE FROM repo_grants WHERE user_id = $1', [u.id]);
    for (const repo of repos) await ctx.db.query('INSERT INTO repo_grants (user_id, repo) VALUES ($1,$2)', [u.id, repo]);
    res.json({ repos });
  });

  r.get('/repos-available', async (req, res) => {
    if (!ctx.config.githubToken) return res.status(503).json({ error: 'GITHUB_TOKEN is not set.' });
    try { res.json({ repos: await listTokenRepos(ctx) }); } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Usage: summary tile per user -> daily detail.
  r.get('/usage', async (req, res) => {
    const rows = await ctx.db.query(`SELECT u.id, u.name, u.email, count(l.id)::int AS requests,
        COALESCE(sum(l.input_tokens),0)::int AS input_tokens, COALESCE(sum(l.output_tokens),0)::int AS output_tokens,
        max(l.created_at) AS last_used
      FROM users u LEFT JOIN usage_log l ON l.user_id = u.id AND l.created_at > now() - interval '30 days'
      GROUP BY u.id ORDER BY u.id`);
    res.json({ days: 30, users: rows });
  });
  r.get('/usage/:id', async (req, res) => {
    const u = await target(req, res); if (!u) return;
    const tz = isValidTimeZone(req.user.timezone) ? req.user.timezone : 'UTC';
    const rows = await ctx.db.query(`SELECT to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, count(*)::int AS requests,
        sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens,
        sum(cache_read_tokens)::int AS cache_read_tokens, string_agg(DISTINCT model, ', ') AS models
      FROM usage_log WHERE user_id = $1 AND created_at > now() - interval '90 days'
      GROUP BY 1 ORDER BY 1 DESC`, [u.id, tz]);
    res.json({ user: { id: u.id, name: u.name, email: u.email }, daily: rows });
  });

  r.get('/audit/:id', async (req, res) => {
    const u = await target(req, res); if (!u) return;
    res.json({
      user: { id: u.id, name: u.name, email: u.email },
      activity: await ctx.db.query('SELECT id, tool, summary, outcome, approved, created_at FROM audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT 300', [u.id]),
    });
  });

  // Dataset catalog
  r.get('/datasets', async (req, res) => res.json({ datasets: await ctx.db.query('SELECT * FROM datasets ORDER BY active DESC, name') }));
  const dsFields = (b) => ({
    name: String(b.name || '').trim().slice(0, 200), datasetId: String(b.datasetId || '').trim().slice(0, 100),
    description: String(b.description || '').slice(0, 4000), columnNotes: String(b.columnNotes || '').slice(0, 8000),
  });
  r.post('/datasets', async (req, res) => {
    const d = dsFields(req.body || {});
    if (!d.name || !/^[A-Za-z0-9-]{8,}$/.test(d.datasetId)) return res.status(400).json({ error: 'Name and a valid Domo dataset ID are required.' });
    try {
      res.status(201).json({ dataset: await ctx.db.one('INSERT INTO datasets (name, dataset_id, description, column_notes) VALUES ($1,$2,$3,$4) RETURNING *', [d.name, d.datasetId, d.description, d.columnNotes]) });
    } catch (e) {
      if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: 'That dataset ID is already in the catalog.' });
      throw e;
    }
  });
  // Fills the catalog with every dataset the signed-in admin's own Domo token can see. Existing entries are kept.
  r.post('/datasets/import', async (req, res) => {
    if (!ctx.config.domoInstance) return res.status(400).json({ error: 'DOMO_INSTANCE is not set in the Render environment settings.' });
    if (!req.user.domo_token_enc) return res.status(400).json({ error: 'Add your own Domo token in Settings first.' });
    let found;
    try {
      found = await domoListAllDatasets(ctx, ctx.secrets.decrypt(req.user.domo_token_enc));
    } catch (e) {
      return res.status(502).json({ error: `Domo did not return the dataset list: ${e.message}` });
    }
    let added = 0;
    for (const d of found) {
      if (!/^[A-Za-z0-9-]{8,}$/.test(d.id)) continue;
      const desc = [d.description, d.type ? `Source: ${d.type}` : '', d.rowCount != null ? `${d.rowCount} rows at import` : ''].filter(Boolean).join(' | ').slice(0, 4000);
      const rows = await ctx.db.query('INSERT INTO datasets (name, dataset_id, description) VALUES ($1,$2,$3) ON CONFLICT (dataset_id) DO NOTHING RETURNING id', [d.name.slice(0, 200), d.id, desc]);
      added += rows.length;
    }
    await audit(ctx.db, req.user.id, 'domo_catalog_import', `found ${found.length}, added ${added}`, 'ok');
    res.json({ found: found.length, added });
  });
  // Narrows the catalog to data that feeds dashboards and apps: looks up the cards built on each dataset
  // (with the signed-in admin's own Domo token), records their titles, and hides datasets no card uses.
  r.post('/datasets/match-cards', async (req, res) => {
    if (!ctx.config.domoInstance) return res.status(400).json({ error: 'DOMO_INSTANCE is not set in the Render environment settings.' });
    if (!req.user.domo_token_enc) return res.status(400).json({ error: 'Add your own Domo token in Settings first.' });
    const token = ctx.secrets.decrypt(req.user.domo_token_enc);
    const all = await ctx.db.query('SELECT id, dataset_id FROM datasets ORDER BY id LIMIT 3000');
    const results = new Array(all.length);
    let next = 0; let firstError = '';
    const worker = async () => {
      while (next < all.length) {
        const i = next++;
        try { results[i] = await domoDatasetCards(ctx, token, all[i].dataset_id); } catch (e) { results[i] = null; firstError ||= e.message; }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const failed = results.filter((x) => x === null).length;
    // If Domo refused most lookups, change nothing - never hide data on a failed check.
    if (all.length && failed > all.length / 2) return res.status(502).json({ error: `Domo did not return the cards for most datasets (${firstError}). Nothing was changed.` });
    let inUse = 0; let hidden = 0;
    for (let i = 0; i < all.length; i++) {
      const cards = results[i]; if (cards === null) continue;
      const titles = [...new Set(cards.map((c) => c.title))];
      const usedBy = titles.slice(0, 40).join('; ').slice(0, 2000) + (titles.length > 40 ? `; +${titles.length - 40} more` : '');
      await ctx.db.query('UPDATE datasets SET used_by = $2, active = $3 WHERE id = $1', [all[i].id, usedBy, titles.length > 0]);
      if (titles.length) inUse++; else hidden++;
    }
    await audit(ctx.db, req.user.id, 'domo_catalog_match_cards', `checked ${all.length}, in use ${inUse}, hidden ${hidden}, failed ${failed}`, 'ok');
    res.json({ checked: all.length, inUse, hidden, failed });
  });
  r.patch('/datasets/:id/active', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    const row = await ctx.db.one('UPDATE datasets SET active = $2 WHERE id = $1 RETURNING *', [id, !!req.body?.active]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ dataset: row });
  });
  r.put('/datasets/:id', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    const d = dsFields(req.body || {});
    if (!d.name || !/^[A-Za-z0-9-]{8,}$/.test(d.datasetId)) return res.status(400).json({ error: 'Name and a valid Domo dataset ID are required.' });
    const row = await ctx.db.one('UPDATE datasets SET name=$2, dataset_id=$3, description=$4, column_notes=$5 WHERE id=$1 RETURNING *', [id, d.name, d.datasetId, d.description, d.columnNotes]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ dataset: row });
  });
  r.delete('/datasets/:id', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    const rows = await ctx.db.query('DELETE FROM datasets WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return r;
}
