// Test harness: in-memory PGlite, app on an ephemeral port, cookie-jar clients, fake fetch + fake Anthropic.
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';

export async function startApp({ env = {}, routes = [], script } = {}) {
  const config = loadConfig({ SESSION_SECRET: 'test-session-secret-123', ...env });
  const db = await createDb({});
  const fetchCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: { ...(init.headers || {}) }, body: init.body };
    fetchCalls.push(call);
    for (const r of routes) {
      if (r.match(call)) {
        const out = await r.respond(call);
        return new Response(JSON.stringify(out.body ?? {}), { status: out.status || 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ message: 'no mock' }), { status: 599 });
  };
  const ai = fakeAnthropic(script);
  const { app, ctx } = createApp({ db, config, fetchImpl, createClient: ai.createClient });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, ctx, db, config, fetchCalls, ai,
    client: () => new Client(base),
    async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await db.close(); },
  };
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.responses = []; }
  async req(method, path, body, { csrf = true } = {}) {
    const headers = {};
    if (csrf) headers['X-Requested-With'] = 'MyAssistant';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(this.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) { const v = c.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    this.responses.push(text);
    return { status: res.status, body: json, text, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }
}

// Scripted fake of the Anthropic client. `script(params, apiKey, callIndex)` returns a message.
export function fakeAnthropic(script) {
  const calls = [];
  const keys = [];
  const state = { script: script || (() => textMsg('ok')) };
  return {
    calls, keys, state,
    createClient(apiKey) {
      keys.push(apiKey);
      return { messages: { create: async (params) => { calls.push({ params: structuredClone(params), apiKey }); return state.script(params, apiKey, calls.length - 1); } } };
    },
  };
}
export const textMsg = (text) => ({ id: 'm', type: 'message', role: 'assistant', model: 'test-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } });
export const toolMsg = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({
  id: 'm', type: 'message', role: 'assistant', model: 'test-model', stop_reason: 'tool_use',
  content: [{ type: 'text', text: '' }, { type: 'tool_use', id, name, input }], usage: { input_tokens: 20, output_tokens: 8 },
});

// Signs up the owner (first account) and returns the client.
export async function owner(t, opts = {}) {
  const c = t.client();
  const r = await c.post('/auth/signup', { email: opts.email || 'owner@example.com', password: 'ownerpass1', name: 'Steve', timezone: 'America/Chicago' });
  if (r.status !== 201) throw new Error(`owner signup failed ${r.status} ${r.text}`);
  return c;
}

// Owner creates a user directly; the user signs in and changes the temp password.
export async function createUser(t, ownerClient, { email, role = 'user', ...rest } = {}) {
  const r = await ownerClient.post('/api/admin/users', { email, password: 'temporary1', role, name: email.split('@')[0], ...rest });
  if (r.status !== 201) throw new Error(`create user failed ${r.status} ${r.text}`);
  const c = t.client();
  await c.post('/auth/signin', { email, password: 'temporary1' });
  const ch = await c.post('/auth/change-password', { currentPassword: 'temporary1', newPassword: 'realpass99' });
  if (ch.status !== 200) throw new Error(`change pw failed ${ch.text}`);
  c.id = r.body.user.id;
  return c;
}

export function ctxFor(t, user) { return { ...t.ctx, user, cache: {} }; }
export async function userRow(t, email) { return t.db.one('SELECT * FROM users WHERE email = $1', [email]); }
