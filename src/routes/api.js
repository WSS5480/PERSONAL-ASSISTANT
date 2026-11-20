// Signed-in user API. Every query is scoped to req.user.id.
import express from 'express';
import { requireUser, requirePasswordCurrent, requireRole, rateLimit, publicUser } from '../auth.js';
import { isValidTimeZone, dayBoundsInZone } from '../time.js';
import { last4 } from '../crypto.js';
import { addTodo, listTodos, setTodoDone, deleteTodo } from '../tools/todos.js';
import { createReminder, listReminders, dueReminders, deleteReminder } from '../tools/reminders.js';
import { saveNote, searchNotes, deleteNote } from '../tools/notes.js';
import { handleChat, approveAction, cancelAction, pendingActions, history } from '../ai/chat.js';
import { googleConfigured, googleConnected } from '../integrations/google.js';
import { render, servicesWithStatus } from '../integrations/render.js';

export const intId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const tzOf = (u) => (isValidTimeZone(u.timezone) ? u.timezone : 'America/Chicago');

export function apiRoutes(ctx) {
  const r = express.Router();
  r.use(requireUser);

  r.get('/me', async (req, res) => {
    const u = req.user;
    const tctx = { ...ctx, user: u, cache: {} };
    const g = await ctx.db.one('SELECT email FROM google_tokens WHERE user_id = $1', [u.id]);
    const grants = await ctx.db.query('SELECT repo FROM repo_grants WHERE user_id = $1 ORDER BY repo', [u.id]);
    res.json({
      user: publicUser(u),
      integrations: {
        google: { configured: googleConfigured(ctx.config), connected: await googleConnected(tctx), email: g?.email || null },
        domo: { configured: !!ctx.config.domoInstance, tokenSet: !!u.domo_token_enc, last4: u.domo_token_enc ? u.domo_token_last4 : null },
        repos: { configured: !!ctx.config.githubToken, all: u.role === 'owner', granted: grants.map((x) => x.repo) },
        render: { available: u.role === 'owner' && !!ctx.config.renderApiKey },
        ai: { hasOwnKey: !!u.ai_key_enc, houseKeyAllowed: u.house_key_allowed || u.role === 'owner' },
      },
    });
  });

  // Everything below requires a non-temporary password.
  r.use(requirePasswordCurrent);

  r.patch('/me', async (req, res) => {
    const { name, timezone } = req.body || {};
    if (timezone !== undefined && !isValidTimeZone(timezone)) return res.status(400).json({ error: 'Unknown timezone.' });
    const u = await ctx.db.one(`UPDATE users SET name = COALESCE($2, name), timezone = COALESCE($3, timezone) WHERE id = $1 RETURNING *`,
      [req.user.id, name !== undefined ? String(name).trim().slice(0, 100) : null, timezone ?? null]);
    res.json({ user: publicUser(u) });
  });

  r.put('/me/domo-token', async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (token.length < 8) return res.status(400).json({ error: 'Paste the full Domo access token.' });
    await ctx.db.query('UPDATE users SET domo_token_enc = $2, domo_token_last4 = $3 WHERE id = $1', [req.user.id, ctx.secrets.encrypt(token), last4(token)]);
    res.json({ domoToken: { set: true, last4: last4(token) } });
  });
  r.delete('/me/domo-token', async (req, res) => {
    await ctx.db.query('UPDATE users SET domo_token_enc = NULL, domo_token_last4 = NULL WHERE id = $1', [req.user.id]);
    res.json({ domoToken: { set: false, last4: null } });
  });

  // To-dos
  r.get('/todos', async (req, res) => res.json({ todos: await listTodos(ctx.db, req.user.id, req.query.all === '1') }));
  r.post('/todos', async (req, res) => {
    try { res.status(201).json({ todo: await addTodo(ctx.db, req.user.id, req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.patch('/todos/:id', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    const row = await setTodoDone(ctx.db, req.user.id, id, !!req.body?.done);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ todo: row });
  });
  r.delete('/todos/:id', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    if (!(await deleteTodo(ctx.db, req.user.id, id))) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // Reminders
  r.get('/reminders', async (req, res) => res.json({ reminders: await listReminders(ctx.db, req.user, { includeDelivered: req.query.all === '1' }) }));
  r.get('/reminders/due', async (req, res) => res.json({ reminders: await dueReminders(ctx.db, req.user) }));
  r.post('/reminders', async (req, res) => {
    try { res.status(201).json({ reminder: await createReminder(ctx.db, req.user, req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.post('/reminders/:id/delivered', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    const rows = await ctx.db.query('UPDATE reminders SET delivered = TRUE WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });
  r.delete('/reminders/:id', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    if (!(await deleteReminder(ctx.db, req.user.id, id))) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // Notes
  r.get('/notes', async (req, res) => res.json({ notes: await searchNotes(ctx.db, req.user.id, req.query.q) }));
  r.post('/notes', async (req, res) => {
    try { res.status(201).json({ note: await saveNote(ctx.db, req.user.id, req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.delete('/notes/:id', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    if (!(await deleteNote(ctx.db, req.user.id, id))) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // Memory
  r.get('/memory', async (req, res) => res.json({ facts: await ctx.db.query('SELECT id, fact, created_at FROM memory_facts WHERE user_id = $1 ORDER BY id', [req.user.id]) }));
  r.delete('/memory/:id', async (req, res) => {
    const id = intId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
    const rows = await ctx.db.query('DELETE FROM memory_facts WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // Activity (own audit log)
  r.get('/activity', async (req, res) => res.json({
    activity: await ctx.db.query('SELECT id, tool, summary, outcome, approved, created_at FROM audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT 200', [req.user.id]),
  }));

  // Home tiles
  r.get('/summary', async (req, res) => {
    const { start, end } = dayBoundsInZone(new Date(), tzOf(req.user));
    const t = await ctx.db.one('SELECT count(*)::int AS n FROM todos WHERE user_id = $1 AND done = FALSE', [req.user.id]);
    const rm = await ctx.db.one('SELECT count(*)::int AS n FROM reminders WHERE user_id = $1 AND delivered = FALSE AND due_at >= $2 AND due_at < $3',
      [req.user.id, start.toISOString(), end.toISOString()]);
    const p = await pendingActions(ctx.db, req.user.id);
    res.json({ openTodos: t.n, remindersToday: rm.n, pendingApprovals: p.length, appsAvailable: req.user.role === 'owner' && !!ctx.config.renderApiKey });
  });

  // Chat
  const chatLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'chat' });
  r.get('/chat/history', async (req, res) => res.json({ messages: await history(ctx.db, req.user.id, 50), pending: await pendingActions(ctx.db, req.user.id) }));
  r.post('/chat', chatLimiter, async (req, res) => {
    const out = await handleChat(ctx, req.user, req.body?.message);
    res.json({ reply: out.reply, pending: await pendingActions(ctx.db, req.user.id), noKey: !!out.noKey });
  });
  r.post('/chat/clear', async (req, res) => {
    await ctx.db.query('DELETE FROM messages WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  });
  r.get('/actions/pending', async (req, res) => res.json({ pending: await pendingActions(ctx.db, req.user.id) }));
  r.post('/actions/:id/approve', chatLimiter, async (req, res) => {
    const out = await approveAction(ctx, req.user, req.params.id);
    res.status(out.status || 200).json({ reply: out.reply, executed: !!out.executed, pending: await pendingActions(ctx.db, req.user.id) });
  });
  r.post('/actions/:id/cancel', async (req, res) => {
    const out = await cancelAction(ctx, req.user, req.params.id);
    res.status(out.status || 200).json({ reply: out.reply, pending: await pendingActions(ctx.db, req.user.id) });
  });

  // Google disconnect
  r.post('/google/disconnect', async (req, res) => {
    await ctx.db.query('DELETE FROM google_tokens WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  });

  // Apps (Render) - owner only
  const owner = requireRole('owner');
  const needRender = (req, res, next) => (ctx.config.renderApiKey ? next() : res.status(503).json({ error: 'RENDER_API_KEY is not set.' }));
  let appsCache = { at: 0, data: null };
  r.get('/apps', owner, needRender, async (req, res) => {
    try {
      if (!appsCache.data || Date.now() - appsCache.at > 60_000 || req.query.refresh === '1') appsCache = { at: Date.now(), data: await servicesWithStatus(ctx) };
      const services = appsCache.data;
      res.json({ count: services.length, failing: services.filter((s) => s.failing).length, services });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  r.get('/apps/:id/deploys', owner, needRender, async (req, res) => {
    try {
      const d = await render.deploys(ctx, req.params.id, 10);
      res.json({ deploys: d.map((x) => ({ id: x.id, status: x.status, createdAt: x.createdAt, finishedAt: x.finishedAt, commit: x.commit?.message?.split('\n')[0] || '' })) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  r.get('/apps/:id/logs', owner, needRender, async (req, res) => {
    try {
      const s = await render.service(ctx, req.params.id);
      res.json({ logs: await render.logs(ctx, s.ownerId, req.params.id, 80) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  return r;
}
