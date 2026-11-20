// Domo Assistant API: called by the Domo custom app (domo-assistant/) that runs inside Domo.
// The app's data queries run in the user's browser under their own Domo login (so Domo's PDP applies);
// this server only does the Claude reasoning. It never sees a Domo token and never queries Domo itself.
//
// Protocol (stateless): POST /domo/chat { user, datasets, messages } with header X-Domo-App-Key.
//  -> { status: 'done', text, messages }                      final answer
//  -> { status: 'needs_client', calls: [{id,name,input}], messages }   the app runs each query in Domo,
//     appends { role:'user', content:[{type:'tool_result', tool_use_id, content}] } and POSTs again.
import express from 'express';
import crypto from 'node:crypto';
import { runAssistant } from '../ai/loop.js';
import { rateLimit } from '../auth.js';

const ORIGIN_OK = /^https:\/\/[a-z0-9.-]+\.domo\.com$/i;
const MAX_MESSAGES = 60;
const sameKey = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clean = (s, n) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

export const QUERY_TOOL = {
  name: 'query_data',
  execution: 'client',
  description: 'Run one read-only SQL SELECT on one of the listed datasets. Use the dataset alias as the table name (FROM alias). Aggregate with SUM/COUNT/GROUP BY instead of pulling raw rows; at most 100 rows come back.',
  input_schema: {
    type: 'object',
    properties: { alias: { type: 'string', description: 'Dataset alias from the list' }, sql: { type: 'string', description: 'A single SELECT statement' } },
    required: ['alias', 'sql'],
  },
};

export function buildDomoSystem(user, datasets, now = new Date()) {
  const list = datasets.length
    ? datasets.map((d) => `- alias ${d.alias}: ${d.name}${d.description ? ` — ${d.description}` : ''}${d.columns.length ? `\n  columns: ${d.columns.join(', ')}` : ''}`).join('\n')
    : '(no datasets are connected to this assistant yet)';
  return {
    static: [
      'You are the Domo Assistant, a business-data assistant that lives inside the company\'s Domo dashboards.',
      'Answer questions with real numbers by querying the datasets listed below with the query_data tool. Never invent numbers.',
      'Rules:',
      '- Only single read-only SELECT statements. Use the dataset alias as the table name. Put column names with spaces or symbols in backticks.',
      '- Aggregate in SQL (SUM, COUNT, AVG, GROUP BY, ORDER BY, LIMIT). Do not pull raw rows to add up yourself.',
      '- Domo already limits the rows to what this person is allowed to see (their store or district). Describe results as "what you have access to"; never suggest ways around that.',
      '- If a query fails, read the error, fix the SQL (check column names) and try again, at most twice.',
      '- If the listed datasets cannot answer the question, say so plainly and say which data would be needed.',
      '- Keep answers short and practical: the key number first, then at most a few lines. Use a small list for breakdowns. Number list items.',
      '- State the date range you used. Format money with $ and commas.',
    ].join('\n'),
    dynamic: `Person asking: ${user.name || 'a Domo user'}.\nNow: ${now.toISOString()} (UTC).\nDatasets:\n${list}`,
  };
}

export function domoRoutes(ctx, { now = () => Date.now() } = {}) {
  const r = express.Router();
  const appKey = ctx.config.domoAppKey;
  const day = { key: '', n: 0 };

  r.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ORIGIN_OK.test(origin)) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, X-Domo-App-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' });
    }
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Connection test: tells the Domo app whether it reached this server and whether the server is ready.
  r.get('/ping', (req, res) => {
    res.json({ ok: true, ready: !!(appKey && (ctx.config.domoAnthropicApiKey || ctx.config.anthropicApiKey)), keyAccepted: appKey ? sameKey(req.headers['x-domo-app-key'], appKey) : false });
  });

  const limiter = rateLimit({ windowMs: 60_000, max: 20, name: 'domo' });
  r.post('/chat', (req, res, next) => {
    if (!appKey) return res.status(503).json({ error: 'The assistant server is not set up yet (DOMO_APP_KEY is missing).' });
    if (!sameKey(req.headers['x-domo-app-key'], appKey)) return res.status(401).json({ error: 'This Domo app is not authorized (app key mismatch).' });
    // Rate-limit per claimed Domo user (falls back to IP).
    const uid = clean(req.body?.user?.id, 60);
    if (uid) req.user = { id: `domo-${uid}` };
    next();
  }, limiter, async (req, res) => {
    const apiKey = ctx.config.domoAnthropicApiKey || ctx.config.anthropicApiKey;
    if (!apiKey) return res.status(503).json({ error: 'The AI key is not set on the assistant server.' });
    const today = new Date(now()).toISOString().slice(0, 10);
    if (day.key !== today) { day.key = today; day.n = 0; }
    if (++day.n > ctx.config.domoDailyLimit) return res.status(429).json({ error: 'The assistant has reached today\'s limit. Try again tomorrow.' });

    const b = req.body || {};
    const user = { id: clean(b.user?.id, 60), name: clean(b.user?.name, 100) };
    const datasets = (Array.isArray(b.datasets) ? b.datasets : []).slice(0, 40).map((d) => ({
      alias: clean(d.alias, 80), name: clean(d.name, 200), description: clean(d.description, 600),
      columns: (Array.isArray(d.columns) ? d.columns : []).slice(0, 150).map((c) => clean(c, 100)).filter(Boolean),
    })).filter((d) => /^[A-Za-z0-9_]+$/.test(d.alias));
    const messages = Array.isArray(b.messages) ? b.messages.slice(-MAX_MESSAGES) : [];
    while (messages.length && messages[0]?.role !== 'user') messages.shift();
    if (!messages.length || !messages.every((m) => (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))) {
      return res.status(400).json({ error: 'Bad conversation format.' });
    }
    try {
      const out = await runAssistant({
        user, messages, tools: datasets.length ? [QUERY_TOOL] : [], apiKey, model: ctx.config.model,
        system: buildDomoSystem(user, datasets, new Date(now())), createClient: ctx.createClient,
        executeTool: async (name) => ({ ok: false, error: `Tool ${name} is not available.` }),
        requestApproval: async () => { throw new Error('No approval tools here'); },
        maxIterations: 6, maxTokens: 1200,
        onUsage: (u, model) => console.log(`[domo] usage user=${user.id || '?'} model=${model} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`),
      });
      if (out.status === 'needs_client') {
        return res.json({ status: 'needs_client', text: out.text || '', messages: out.messages, calls: out.clientCalls.map((c) => ({ id: c.id, name: c.name, input: c.input })) });
      }
      res.json({ status: 'done', text: out.text || '(no reply)', messages: out.messages });
    } catch (err) {
      console.error('[domo] model error:', err?.status || '', err?.message);
      const s = err?.status;
      res.status(502).json({ error: s === 401 ? 'The AI key was rejected.' : s === 429 ? 'The AI service is busy. Try again shortly.' : s === 404 ? 'The AI model name is not recognized (ASSISTANT_MODEL).' : 'The AI service had a problem. Try again.' });
    }
  });
  return r;
}
