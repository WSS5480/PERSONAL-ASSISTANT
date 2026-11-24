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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'domo-assistant');
const APP_FILES = { 'manifest.json': 'application/json', 'index.html': 'text/html', 'app.css': 'text/css', 'app.js': 'text/javascript', 'datasets.js': 'text/javascript' };

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

export const DESCRIBE_TOOL = {
  name: 'describe_dataset',
  execution: 'client',
  description: 'Get the exact column names and three sample rows of one listed dataset. Call this before the first query on a dataset.',
  input_schema: { type: 'object', properties: { alias: { type: 'string', description: 'Dataset alias from the list' } }, required: ['alias'] },
};

export function buildDomoSystem(user, datasets, now = new Date(), canDescribe = true) {
  const list = datasets.length
    ? datasets.map((d) => `- ${d.alias}: ${d.name}${d.description ? ` — ${d.description}` : ''}${!canDescribe && d.columns?.length ? `\n  columns: ${d.columns.join(', ')}` : ''}`).join('\n')
    : '(no datasets are connected to this assistant yet)';
  return {
    static: [
      'You are the Domo Assistant, a business-data assistant that lives inside the company\'s Domo dashboards.',
      'Answer questions with real numbers by querying the datasets listed below. Never invent numbers.',
      'Finding the data:',
      '- The list gives each dataset\'s alias, its name, and the Domo apps and dashboards that use it. Pick the dataset whose name or apps match the question: financial measures (revenue, expenses, NOI, EBITDA, P&L lines, budget) come from P&L / financial datasets; inventory questions from inventory datasets; collections, calls, sales, purchasing and so on from theirs.',
      canDescribe ? '- Before the first query on a dataset, call describe_dataset to get its exact column names and sample rows. Never guess column names.' : '- Use only the column names listed for each dataset.',
      '- If the first dataset cannot answer, check the next most likely one or two before saying the data is not available. Only say data is missing after you have looked, and then name what you checked.',
      'Querying:',
      '- Only single read-only SELECT statements with query_data. Use the dataset alias as the table name. Put column names with spaces or symbols in backticks.',
      '- Aggregate in SQL (SUM, COUNT, AVG, GROUP BY, ORDER BY, LIMIT). Do not pull raw rows to add up yourself.',
      '- If a query fails, read the error, fix the SQL and try again, at most twice per dataset.',
      '- Domo already limits the rows to what this person is allowed to see (their store or district). Describe results as what they have access to; never suggest ways around that.',
      'Answering:',
      '- Short and practical: the key number first, then at most a few lines. Number list items. State the date range and the dataset you used. Format money with $ and commas.',
      '- If a term could mean different measures in the data (for example which line is NOI), say which one you used.',
      '- Plain text only. Do not use Markdown symbols such as ** or #.',
    ].join('\n'),
    // Date only, no clock time: this text must be identical on every request of one turn, because the
    // model's reasoning blocks are bound to the system prompt they were created with.
    dynamic: `Person asking: ${user.name || 'a Domo user'}.\nToday: ${now.toISOString().slice(0, 10)} (UTC).\nDatasets:\n${list}`,
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

  // The Domo app's own source files (APP_KEY is a placeholder here), so they can be pulled into Domo at publish time.
  r.get('/app-files/:name', (req, res) => {
    const type = APP_FILES[req.params.name];
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.type(type).send(fs.readFileSync(path.join(APP_DIR, req.params.name), 'utf8'));
  });

  // TEMPORARY (2026-11-24): lets the manager session pull app source out of the owner's signed-in Domo tab
  // by writing it to this service's log. Key-protected. Remove once the Executive Views work is merged.
  r.post('/relay', (req, res) => {
    if (!appKey || !sameKey(req.headers['x-domo-app-key'], appKey)) return res.status(401).json({ error: 'no' });
    const b = req.body || {};
    console.log(`[relay] ${clean(b.tag, 20)} ${Number(b.i) || 0}/${Number(b.n) || 0} ${String(b.data || '').replace(/[^A-Za-z0-9+/=]/g, '').slice(0, 6000)}`);
    res.json({ ok: true });
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
    const datasets = (Array.isArray(b.datasets) ? b.datasets : []).slice(0, 120).map((d) => ({
      alias: clean(d.alias, 80), name: clean(d.name, 160), description: clean(d.description, 300),
      columns: (Array.isArray(d.columns) ? d.columns : []).slice(0, 150).map((c) => clean(c, 100)).filter(Boolean),
    })).filter((d) => /^[A-Za-z0-9_]+$/.test(d.alias));
    // Older published copies of the Domo app cannot run describe_dataset; they send columns up front instead.
    const canDescribe = Array.isArray(b.caps) && b.caps.includes('describe');
    const messages = Array.isArray(b.messages) ? b.messages.slice(-MAX_MESSAGES) : [];
    while (messages.length && messages[0]?.role !== 'user') messages.shift();
    if (!messages.length || !messages.every((m) => (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))) {
      return res.status(400).json({ error: 'Bad conversation format.' });
    }
    // A tool call must be answered by the very next message. Drop any that are not (left over from a failed turn).
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const ids = m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'tool_use').map((b) => b.id) : [];
      if (!ids.length) continue;
      const next = messages[i + 1];
      const answered = next && next.role === 'user' && Array.isArray(next.content) && ids.every((id) => next.content.some((b) => b?.type === 'tool_result' && b.tool_use_id === id));
      if (!answered) messages.splice(i, 1);
    }
    while (messages.length && (messages[0].role !== 'user' || (Array.isArray(messages[0].content) && messages[0].content.some((b) => b?.type === 'tool_result')))) messages.shift();
    if (!messages.length) return res.status(400).json({ error: 'Bad conversation format.' });
    const run = (msgs) => runAssistant({
      user, messages: msgs, tools: !datasets.length ? [] : canDescribe ? [DESCRIBE_TOOL, QUERY_TOOL] : [QUERY_TOOL], apiKey, model: ctx.config.model,
        system: buildDomoSystem(user, datasets, new Date(now()), canDescribe), createClient: ctx.createClient,
        executeTool: async (name) => ({ ok: false, error: `Tool ${name} is not available.` }),
        requestApproval: async () => { throw new Error('No approval tools here'); },
        maxIterations: 6, maxTokens: 1500,
      onUsage: (u, model) => console.log(`[domo] usage user=${user.id || '?'} model=${model} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`),
    });
    const noThinking = (msgs) => msgs.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking') } : m)).filter((m) => !Array.isArray(m.content) || m.content.length);
    try {
      let out;
      try { out = await run(messages); } catch (err) {
        // Reasoning blocks from an earlier request can be rejected (e.g. the date rolled over). Retry once without them.
        if (err?.status === 400 && /thinking/i.test(err?.message || '')) out = await run(noThinking(messages)); else throw err;
      }
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
