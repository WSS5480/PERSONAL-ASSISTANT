import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, owner, createUser, toolMsg, textMsg } from './helpers.js';
import { NO_KEY_MESSAGE } from '../src/ai/keys.js';

test('AI key selection: owner env key, own key, no key, house-key toggle', async () => {
  const t = await startApp({ env: { ANTHROPIC_API_KEY: 'sk-house-key' } });
  try {
    t.ai.state.script = () => textMsg('hello');
    const o = await owner(t);
    const u = await createUser(t, o, { email: 'u@example.com' });

    // owner uses env key
    assert.equal((await o.post('/api/chat', { message: 'hi' })).body.reply, 'hello');
    assert.equal(t.ai.keys.at(-1), 'sk-house-key');

    // user with no key: clear message, no AI call, no fallback
    const before = t.ai.keys.length;
    const r = await u.post('/api/chat', { message: 'hi' });
    assert.equal(r.body.reply, NO_KEY_MESSAGE);
    assert.equal(r.body.noKey, true);
    assert.equal(t.ai.keys.length, before);

    // house-key toggle on -> env key
    await o.patch(`/api/admin/users/${u.id}`, { houseKeyAllowed: true });
    await u.post('/api/chat', { message: 'hi' });
    assert.equal(t.ai.keys.at(-1), 'sk-house-key');

    // own key assigned -> own key wins
    await o.put(`/api/admin/users/${u.id}/ai-key`, { value: 'sk-user-own-key-9999' });
    await u.post('/api/chat', { message: 'hi' });
    assert.equal(t.ai.keys.at(-1), 'sk-user-own-key-9999');

    // toggle off + key cleared -> no key again
    await o.patch(`/api/admin/users/${u.id}`, { houseKeyAllowed: false });
    await o.del(`/api/admin/users/${u.id}/ai-key`);
    const n = t.ai.keys.length;
    assert.equal((await u.post('/api/chat', { message: 'hi' })).body.reply, NO_KEY_MESSAGE);
    assert.equal(t.ai.keys.length, n);

    // usage recorded per user, visible in admin usage
    const usage = (await o.get('/api/admin/usage')).body.users;
    assert.ok(usage.find((x) => x.id === u.id).requests >= 2);
    const daily = await o.get(`/api/admin/usage/${u.id}`);
    assert.equal(daily.status, 200);
    assert.ok(daily.body.daily[0].input_tokens > 0);
  } finally { await t.close(); }
});

test('owner with no ANTHROPIC_API_KEY gets a clear message (no crash)', async () => {
  const t = await startApp();
  try {
    const o = await owner(t);
    const r = await o.post('/api/chat', { message: 'hi' });
    assert.equal(r.status, 200);
    assert.match(r.body.reply, /ANTHROPIC_API_KEY/);
    assert.equal(t.ai.calls.length, 0);
  } finally { await t.close(); }
});

test('AI errors become a friendly reply', async () => {
  const t = await startApp({ env: { ANTHROPIC_API_KEY: 'sk-house' } });
  try {
    t.ai.state.script = () => { const e = new Error('bad key'); e.status = 401; throw e; };
    const o = await owner(t);
    const r = await o.post('/api/chat', { message: 'hi' });
    assert.equal(r.status, 200);
    assert.match(r.body.reply, /rejected/);
  } finally { await t.close(); }
});

test('chat runs tools and the system prompt carries user context', async () => {
  const t = await startApp({ env: { ANTHROPIC_API_KEY: 'sk-house' } });
  try {
    const o = await owner(t);
    await t.db.query("INSERT INTO memory_facts (user_id, fact) VALUES (1, 'Prefers short answers')");
    t.ai.state.script = (_p, _k, n) => (n === 0 ? toolMsg('add_todo', { title: 'Call vendor', priority: 'high' }) : textMsg('Added.'));
    const r = await o.post('/api/chat', { message: 'add a todo to call vendor' });
    assert.equal(r.body.reply, 'Added.');
    const todos = (await o.get('/api/todos')).body.todos;
    assert.equal(todos[0].title, 'Call vendor');
    const sys = t.ai.calls[0].params.system.map((b) => b.text).join('\n');
    assert.match(sys, /Steve/); assert.match(sys, /America\/Chicago/); assert.match(sys, /Prefers short answers/); assert.match(sys, /number them/);
    const hist = (await o.get('/api/chat/history')).body.messages;
    assert.deepEqual(hist.map((m) => m.role), ['user', 'assistant']);
    const act = (await o.get('/api/activity')).body.activity;
    assert.equal(act[0].tool, 'add_todo');
  } finally { await t.close(); }
});

const renderRoutes = (calls) => [
  { match: (c) => c.method === 'POST' && /\/services\/srv-1\/deploys$/.test(c.url), respond: () => { calls.deploy++; return { body: { id: 'dep-1', status: 'created' } }; } },
];

test('approval gate: not executed until approved; other user cannot approve; cancel works; yes/no by text', async () => {
  const calls = { deploy: 0 };
  const t = await startApp({ env: { ANTHROPIC_API_KEY: 'sk-house', RENDER_API_KEY: 'rnd' }, routes: renderRoutes(calls) });
  try {
    const o = await owner(t);
    const other = await createUser(t, o, { email: 'x@example.com', role: 'admin' });
    await o.patch(`/api/admin/users/${other.id}`, { houseKeyAllowed: true });

    let step = 0;
    t.ai.state.script = (p) => {
      const last = p.messages.at(-1);
      if (typeof last.content === 'string' && /deploy/.test(last.content) && step++ % 2 === 0) return toolMsg('render_trigger_deploy', { service_id: 'srv-1', service_name: 'web' });
      return textMsg('Please approve the deploy.');
    };
    const r = await o.post('/api/chat', { message: 'deploy web' });
    assert.equal(calls.deploy, 0, 'not executed before approval');
    assert.equal(r.body.pending.length, 1);
    const action = r.body.pending[0];
    assert.match(action.summary, /deploy of Render service "web"/);

    // another user can't approve or cancel it
    assert.equal((await other.post(`/api/actions/${action.id}/approve`)).status, 404);
    assert.equal((await other.post(`/api/actions/${action.id}/cancel`)).status, 404);
    // another user's "yes" doesn't touch it
    await other.post('/api/chat', { message: 'yes' });
    assert.equal(calls.deploy, 0);

    // model "approving" (calling the tool again) still doesn't execute
    t.ai.state.script = (_p, _k) => toolMsg('render_trigger_deploy', { service_id: 'srv-1' });
    const again = await o.post('/api/chat', { message: 'I said go, just do the deploy now' });
    assert.equal(calls.deploy, 0);
    assert.ok(again.body.pending.length >= 2);
    // cancel all but the first
    for (const p of again.body.pending.slice(1)) assert.equal((await o.post(`/api/actions/${p.id}/cancel`)).status, 200);

    // owner approves via button
    t.ai.state.script = () => textMsg('Deploy started.');
    const ap = await o.post(`/api/actions/${action.id}/approve`);
    assert.equal(ap.status, 200);
    assert.equal(ap.body.executed, true);
    assert.equal(calls.deploy, 1);
    assert.equal(ap.body.reply, 'Deploy started.');
    // can't approve twice
    assert.equal((await o.post(`/api/actions/${action.id}/approve`)).status, 404);
    assert.equal(calls.deploy, 1);
    const act = (await o.get('/api/activity')).body.activity;
    assert.ok(act.some((a) => a.tool === 'render_trigger_deploy' && a.approved && a.outcome === 'ok'));

    // typed "yes" approves the latest pending; typed "no" cancels
    t.ai.state.script = ((n = 0) => () => (n++ === 0 ? toolMsg('render_trigger_deploy', { service_id: 'srv-1' }) : textMsg('ok')))();
    await o.post('/api/chat', { message: 'deploy again' });
    const no = await o.post('/api/chat', { message: 'no' });
    assert.match(no.body.reply, /cancelled/i);
    assert.equal(calls.deploy, 1);
    t.ai.state.script = ((n = 0) => () => (n++ === 0 ? toolMsg('render_trigger_deploy', { service_id: 'srv-1' }) : textMsg('ok')))();
    await o.post('/api/chat', { message: 'deploy again' });
    t.ai.state.script = () => textMsg('Started again.');
    const yes = await o.post('/api/chat', { message: 'Yes' });
    assert.equal(calls.deploy, 2);
    assert.equal(yes.body.reply, 'Started again.');
    assert.equal(yes.body.pending.length, 0);
  } finally { await t.close(); }
});

test('expired approvals cannot be approved', async () => {
  const calls = { deploy: 0 };
  const t = await startApp({ env: { ANTHROPIC_API_KEY: 'sk', RENDER_API_KEY: 'rnd' }, routes: renderRoutes(calls) });
  try {
    const o = await owner(t);
    t.ai.state.script = ((n = 0) => () => (n++ === 0 ? toolMsg('render_trigger_deploy', { service_id: 'srv-1' }) : textMsg('ok')))();
    const r = await o.post('/api/chat', { message: 'deploy' });
    await t.db.query("UPDATE pending_actions SET expires_at = now() - interval '1 minute'");
    assert.equal((await o.post(`/api/actions/${r.body.pending[0].id}/approve`)).status, 404);
    assert.equal(calls.deploy, 0);
  } finally { await t.close(); }
});
