import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAssistant } from '../src/ai/loop.js';
import { fakeAnthropic, textMsg, toolMsg } from './helpers.js';

const echoTool = { name: 'echo', description: 'echo', input_schema: { type: 'object', properties: {} }, available: () => true, handler: async (_c, i) => i };
const sendTool = { name: 'send_it', description: 'send', input_schema: { type: 'object', properties: {} }, needsApproval: true, available: () => true, handler: async () => { throw new Error('must not run'); } };

test('tool_use -> tool_result -> final text', async () => {
  const ai = fakeAnthropic();
  ai.state.script = (_p, _k, n) => (n === 0 ? toolMsg('echo', { hi: 1 }, 'tu_1') : textMsg('All done'));
  const executed = [];
  const r = await runAssistant({
    user: { id: 1 }, messages: [{ role: 'user', content: 'go' }], tools: [echoTool], apiKey: 'k', model: 'm',
    system: { static: 'S', dynamic: 'D' }, createClient: ai.createClient,
    executeTool: async (name, input) => { executed.push(name); return { ok: true, result: input }; },
  });
  assert.equal(r.status, 'done');
  assert.equal(r.text, 'All done');
  assert.deepEqual(executed, ['echo']);
  const second = ai.calls[1].params;
  const last = second.messages[second.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'tu_1');
  assert.equal(last.content[0].content, JSON.stringify({ hi: 1 }));
  // prompt caching markers on tools and static system block
  assert.deepEqual(second.tools.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(second.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(second.system[1].cache_control, undefined);
});

test('iteration cap stops a runaway loop', async () => {
  const ai = fakeAnthropic();
  ai.state.script = () => toolMsg('echo', {});
  const r = await runAssistant({
    user: { id: 1 }, messages: [{ role: 'user', content: 'go' }], tools: [echoTool], apiKey: 'k', model: 'm', system: 'S',
    createClient: ai.createClient, executeTool: async () => ({ ok: true, result: {} }), maxIterations: 3,
  });
  assert.equal(r.status, 'capped');
  assert.equal(ai.calls.length, 3);
  assert.match(r.text, /stopped after 3 steps/);
});

test('approval tools are never executed inside the loop', async () => {
  const ai = fakeAnthropic();
  ai.state.script = (_p, _k, n) => (n === 0 ? toolMsg('send_it', { to: 'x' }) : textMsg('Waiting for your approval'));
  const executed = []; const pend = [];
  const r = await runAssistant({
    user: { id: 1 }, messages: [{ role: 'user', content: 'send' }], tools: [sendTool], apiKey: 'k', model: 'm', system: 'S',
    createClient: ai.createClient,
    executeTool: async (n) => { executed.push(n); return { ok: true, result: {} }; },
    requestApproval: async (tu) => { const p = { id: 'p1', summary: 'Send it' }; pend.push(tu); return p; },
  });
  assert.equal(executed.length, 0);
  assert.equal(pend.length, 1);
  assert.equal(r.pendingApprovals.length, 1);
  assert.match(ai.calls[1].params.messages.at(-1).content[0].content, /NOT DONE YET/);
});

test('unknown tool names still go through executeTool (which denies)', async () => {
  const ai = fakeAnthropic();
  ai.state.script = (_p, _k, n) => (n === 0 ? toolMsg('render_restart_service', { service_id: 's' }) : textMsg('ok'));
  const r = await runAssistant({
    user: { id: 1 }, messages: [{ role: 'user', content: 'x' }], tools: [echoTool], apiKey: 'k', model: 'm', system: 'S',
    createClient: ai.createClient, executeTool: async (n) => ({ ok: false, error: `Tool ${n} is not available to you.` }),
  });
  assert.equal(r.status, 'done');
  const tr = ai.calls[1].params.messages.at(-1).content[0];
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /not available/);
});

test('client-executed tools pause the loop', async () => {
  const ai = fakeAnthropic();
  ai.state.script = () => toolMsg('domo_browser_query', { sql: 'SELECT 1' }, 'tu_c');
  const clientTool = { ...echoTool, name: 'domo_browser_query', execution: 'client' };
  const r = await runAssistant({
    user: { id: 1 }, messages: [{ role: 'user', content: 'x' }], tools: [clientTool], apiKey: 'k', model: 'm', system: 'S',
    createClient: ai.createClient, executeTool: async () => assert.fail('server must not execute client tools'),
  });
  assert.equal(r.status, 'needs_client');
  assert.equal(r.clientCalls[0].id, 'tu_c');
});
