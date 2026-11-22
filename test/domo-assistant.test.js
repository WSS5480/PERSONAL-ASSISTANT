import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, toolMsg, textMsg } from './helpers.js';

const ORIGIN = 'https://abc123.domoapps.prod5.domo.com';
async function call(t, path, { method = 'GET', body, key, origin = ORIGIN } = {}) {
  const headers = { Origin: origin };
  if (key) headers['X-Domo-App-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(t.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json, headers: res.headers };
}
const DATASETS = [{ alias: 'SALES', name: 'Sales', description: 'Daily sales', columns: ['store', 'amount'] }];

test('Domo Assistant: not set up -> 503; wrong key -> 401; CORS only for Domo origins', async () => {
  const off = await startApp();
  try {
    assert.equal((await call(off, '/domo/chat', { method: 'POST', key: 'x', body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 503);
    assert.equal((await call(off, '/domo/ping')).body.ready, false);
  } finally { await off.close(); }

  const t = await startApp({ env: { DOMO_APP_KEY: 'secret-app-key', ANTHROPIC_API_KEY: 'house' } });
  try {
    const bad = await call(t, '/domo/chat', { method: 'POST', key: 'nope', body: { messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(bad.status, 401);
    assert.equal(t.ai.calls.length, 0, 'no model call without the key');
    const ping = await call(t, '/domo/ping', { key: 'secret-app-key' });
    assert.deepEqual(ping.body, { ok: true, ready: true, keyAccepted: true });
    assert.equal(ping.headers.get('access-control-allow-origin'), ORIGIN);
    const evil = await call(t, '/domo/ping', { key: 'secret-app-key', origin: 'https://evil.example.com' });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(t.base + '/domo/chat', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Domo-App-Key/i);
  } finally { await t.close(); }
});

test('Domo Assistant: query runs in the client - server pauses, then finishes; server never calls Domo', async () => {
  const t = await startApp({
    env: { DOMO_APP_KEY: 'secret-app-key', ANTHROPIC_API_KEY: 'house', DOMO_ANTHROPIC_API_KEY: 'domo-key' },
    script: (params, _key, i) => (i === 0 ? toolMsg('query_data', { alias: 'SALES', sql: 'SELECT SUM(amount) AS total FROM SALES' }, 'tu_1') : textMsg('Total sales are $1,200.')),
  });
  try {
    const first = await call(t, '/domo/chat', { method: 'POST', key: 'secret-app-key', body: { user: { id: '77', name: 'Pat Lee' }, datasets: DATASETS, messages: [{ role: 'user', content: 'total sales?' }] } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, 'needs_client');
    assert.deepEqual(first.body.calls, [{ id: 'tu_1', name: 'query_data', input: { alias: 'SALES', sql: 'SELECT SUM(amount) AS total FROM SALES' } }]);
    assert.equal(t.ai.keys[0], 'domo-key', 'uses the separate Domo AI key when set');
    const sys = t.ai.calls[0].params.system.map((b) => b.text).join('\n');
    assert.match(sys, /- SALES: Sales — Daily sales/); assert.match(sys, /Pat Lee/);
    assert.deepEqual(t.ai.calls[0].params.tools.map((x) => x.name), ['describe_dataset', 'query_data']);

    const messages = [...first.body.messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"rows":[{"total":1200}]}' }] }];
    const second = await call(t, '/domo/chat', { method: 'POST', key: 'secret-app-key', body: { user: { id: '77', name: 'Pat Lee' }, datasets: DATASETS, messages } });
    assert.equal(second.body.status, 'done');
    assert.equal(second.body.text, 'Total sales are $1,200.');
    assert.equal(t.fetchCalls.length, 0, 'the server itself never talks to Domo');

    const junk = await call(t, '/domo/chat', { method: 'POST', key: 'secret-app-key', body: { messages: [{ role: 'system', content: 'x' }] } });
    assert.equal(junk.status, 400);
  } finally { await t.close(); }
});

test('Domo Assistant: daily cap', async () => {
  const t = await startApp({ env: { DOMO_APP_KEY: 'k', ANTHROPIC_API_KEY: 'house', DOMO_DAILY_LIMIT: '2' } });
  try {
    const body = { user: { id: '1' }, datasets: [], messages: [{ role: 'user', content: 'hi' }] };
    assert.equal((await call(t, '/domo/chat', { method: 'POST', key: 'k', body })).status, 200);
    assert.equal((await call(t, '/domo/chat', { method: 'POST', key: 'k', body })).status, 200);
    assert.equal((await call(t, '/domo/chat', { method: 'POST', key: 'k', body })).status, 429);
  } finally { await t.close(); }
});

test('Domo Assistant: stable system prompt, dangling tool calls dropped, reasoning-block rejection retried once', async () => {
  let n = 0;
  const t = await startApp({
    env: { DOMO_APP_KEY: 'k', ANTHROPIC_API_KEY: 'house' },
    script: (params) => {
      n++;
      if (n === 1) { const e = new Error('messages.1.content.0: Invalid `signature` in `thinking` block.'); e.status = 400; throw e; }
      return textMsg('ok');
    },
  });
  try {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'sig' }, { type: 'text', text: 'hello' }] },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_dangling', name: 'query_data', input: { alias: 'SALES', sql: 'SELECT 1 FROM SALES' } }] },
      { role: 'user', content: 'third' },
    ];
    const r = await call(t, '/domo/chat', { method: 'POST', key: 'k', body: { user: { id: '1' }, datasets: DATASETS, messages } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.text, 'ok');
    assert.equal(t.ai.calls.length, 2, 'retried once');
    const sent1 = JSON.stringify(t.ai.calls[0].params.messages); const sent2 = JSON.stringify(t.ai.calls[1].params.messages);
    assert.ok(!sent1.includes('tu_dangling'), 'unanswered tool call removed');
    assert.ok(sent1.includes('"thinking"') && !sent2.includes('"thinking"'), 'retry drops reasoning blocks');
    const sys = t.ai.calls[0].params.system.map((b) => b.text).join('\n');
    assert.match(sys, /Today: \d{4}-\d{2}-\d{2} \(UTC\)/); assert.ok(!/\d{2}:\d{2}:\d{2}/.test(sys), 'no clock time in the system prompt');
  } finally { await t.close(); }
});
