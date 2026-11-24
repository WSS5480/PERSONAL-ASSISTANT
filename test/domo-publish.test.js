import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, owner, createUser } from './helpers.js';
import { makeAlias } from '../src/integrations/domo-publish.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001'; const P = 'aaaaaaaa-0000-0000-0000-000000000002'; const X = 'aaaaaaaa-0000-0000-0000-000000000003';
function routes(log, { hasAssistant = true, manifestTakes = true, putTakes = false, pdp = { pnl: true, inv: false } } = {}) {
  let mapping = [{ alias: 'OLD', dataSetId: A }];
  const designs = [{ id: 'd-pnl', name: 'Financial P & L' }, { id: 'd-inv', name: 'Inventory' }, { id: 'd-old', name: 'Old app' }];
  if (hasAssistant) designs.push({ id: 'd-asst', name: 'Domo Assistant' });
  const detail = {
    'd-pnl': { name: 'Financial P & L', latestVersion: '1.0.0', referencingCards: [{ id: 1, active: true }], versions: [{ version: '1.0.0', datasetsMapping: [{ alias: 'PNL', dataSetId: P }, { alias: 'INV', dataSetId: A }] }] },
    'd-inv': { name: 'Inventory', latestVersion: '1.0.0', referencingCards: [{ id: 2 }], versions: [{ version: '1.0.0', datasetsMapping: [{ alias: 'INVENTORY', dataSetId: A }] }] },
    'd-old': { name: 'Old app', latestVersion: '1.0.0', referencingCards: [], versions: [{ version: '1.0.0', datasetsMapping: [{ alias: 'X', dataSetId: X }] }] },
  };
  return [
    { match: (c) => /\/api\/apps\/v1\/designs\?limit/.test(c.url), respond: () => ({ body: designs }) },
    { match: (c) => /\/api\/apps\/v1\/designs\/(d-asst|d-new)\?parts=versions$/.test(c.url), respond: () => ({ body: { versions: [{ version: '0.1.0', datasetsMapping: mapping }] } }) },
    { match: (c) => /\/api\/apps\/v1\/designs\/[^/]+\?parts=/.test(c.url), respond: (c) => ({ body: detail[c.url.match(/designs\/([^/?]+)/)[1]] }) },
    { match: (c) => c.method === 'PUT' && /\/api\/apps\/v1\/designs\/[^/?]+$/.test(c.url), respond: (c) => { log.push(['put', c.body]); if (!putTakes) return { status: 405, body: { message: 'Not allowed' } }; mapping = JSON.parse(c.body).datasetsMapping; return { body: {} }; } },
    { match: (c) => /\/api\/data\/v3\/datasources\//.test(c.url), respond: (c) => ({ body: c.url.includes(P) ? { name: 'Store P&L by Month', rowCount: 5000, pdpEnabled: pdp.pnl } : { name: 'Inventory Disposition Final', rowCount: 384000, pdpEnabled: pdp.inv } }) },
    { match: (c) => c.method === 'POST' && /\/api\/apps\/v1\/designs$/.test(c.url), respond: (c) => { log.push(['create', c.body]); mapping = JSON.parse(c.body).datasetsMapping; return { body: { id: 'd-new' } }; } },
    { match: (c) => /\/versions$/.test(c.url), respond: (c) => { log.push(['version', c.body]); return { body: {} }; } },
    { match: (c) => /\/assets\?path=/.test(c.url), respond: async (c) => {
      log.push(['asset', c.url, c.body]);
      if (manifestTakes && c.url.includes('manifest.json')) mapping = JSON.parse(await c.body.get('file').text()).datasetsMapping;
      return { body: {} };
    } },
  ];
}

test('makeAlias: safe, unique', () => {
  const used = new Set();
  assert.equal(makeAlias('Store P&L by Month', used), 'STORE_P_L_BY_MONTH');
  assert.equal(makeAlias('store p l by month', used), 'STORE_P_L_BY_MONTH_2');
  assert.equal(makeAlias('2026 sales', used), 'D_2026_SALES');
});

test('Update Domo Assistant: owner only, uses the owner\'s token, wires datasets behind apps with live cards', async () => {
  const log = [];
  const t = await startApp({ env: { DOMO_INSTANCE: 'acme', DOMO_APP_KEY: 'app-key-123', APP_URL: 'https://assistant.example.com' }, routes: routes(log) });
  try {
    const o = await owner(t);
    const adm = await createUser(t, o, { email: 'adm@example.com', role: 'admin' });
    assert.equal((await adm.post('/api/admin/domo-assistant/publish', {})).status, 403);
    assert.equal((await o.post('/api/admin/domo-assistant/publish', {})).status, 400, 'needs the owner\'s Domo token');
    await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    t.fetchCalls.length = 0;
    const r = await o.post('/api/admin/domo-assistant/publish', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.designId, 'd-asst');
    assert.deepEqual(r.body.datasets.map((d) => d.name), ['Inventory Disposition Final', 'Store P&L by Month'], 'most-used first; unused app left out');
    assert.match(r.body.datasets[0].description, /used by: (Financial P & L, Inventory|Inventory, Financial P & L)/);
    assert.ok(t.fetchCalls.every((c) => c.headers['X-DOMO-Developer-Token'] === 'TOKEN-OWNER-9999' && c.url.startsWith('https://acme.domo.com/')));
    assert.ok(!log.some((x) => x[0] === 'create' || x[0] === 'put'), 'manifest upload was enough');
    assert.match(r.body.steps.join(' '), /Domo confirms 2 datasets are connected/);
    const assets = log.filter((x) => x[0] === 'asset').map((x) => decodeURIComponent(x[1].split('path=')[1]));
    assert.deepEqual(assets.sort(), ['app.css', 'app.js', 'datasets.js', 'index.html', 'manifest.json']);
    for (const resp of o.responses) assert.ok(!resp.includes('TOKEN-OWNER-9999') && !resp.includes('app-key-123'));
  } finally { await t.close(); }
});

test('Update Domo Assistant: creates the design when it does not exist; Domo errors are reported', async () => {
  const log = [];
  const t = await startApp({ env: { DOMO_INSTANCE: 'acme', DOMO_APP_KEY: 'k' }, routes: routes(log, { hasAssistant: false }) });
  try {
    const o = await owner(t);
    await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    const r = await o.post('/api/admin/domo-assistant/publish', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.designId, 'd-new'); assert.equal(r.body.created, true);
  } finally { await t.close(); }
  const bad = await startApp({ env: { DOMO_INSTANCE: 'acme', DOMO_APP_KEY: 'k' }, routes: [{ match: () => true, respond: () => ({ status: 401, body: { message: 'Full authentication is required' } }) }] });
  try {
    const o = await owner(bad);
    await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    const r = await o.post('/api/admin/domo-assistant/publish', {});
    assert.equal(r.status, 502); assert.match(r.body.error, /Domo 401/);
  } finally { await bad.close(); }
});

test('Update Domo Assistant: falls back to a direct update, and never reports success when Domo did not take the list', async () => {
  const viaPut = await startApp({ env: { DOMO_INSTANCE: 'acme', DOMO_APP_KEY: 'k' }, routes: routes([], { manifestTakes: false, putTakes: true }) });
  try {
    const o = await owner(viaPut); await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    const r = await o.post('/api/admin/domo-assistant/publish', {});
    assert.equal(r.status, 200, r.text);
  } finally { await viaPut.close(); }
  const stuck = await startApp({ env: { DOMO_INSTANCE: 'acme', DOMO_APP_KEY: 'k' }, routes: routes([], { manifestTakes: false, putTakes: false }) });
  try {
    const o = await owner(stuck); await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    const r = await o.post('/api/admin/domo-assistant/publish', {});
    assert.equal(r.status, 502);
    assert.match(r.body.error, /still shows 1 of 2 datasets/); assert.match(r.body.error, /Domo 405/);
  } finally { await stuck.close(); }
});

test('Team version: separate design, only PDP-protected datasets, the rest listed as left out; refuses when PDP status is unknown', async () => {
  const log = [];
  const t = await startApp({ env: { DOMO_INSTANCE: 'acme', DOMO_APP_KEY: 'k' }, routes: routes(log) });
  try {
    const o = await owner(t); await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    const r = await o.post('/api/admin/domo-assistant/publish', { audience: 'team' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.designId, 'd-new', 'team version is its own design, not the owner one');
    assert.deepEqual(r.body.datasets.map((d) => d.name), ['Store P&L by Month']);
    assert.deepEqual(r.body.leftOut.map((d) => d.name), ['Inventory Disposition Final']);
    const created = JSON.parse(log.find((x) => x[0] === 'create')[1]);
    assert.equal(created.name, 'Domo Assistant - Team');
    assert.deepEqual(created.datasetsMapping.map((m) => m.dataSetId), [P]);
    assert.ok(log.some((x) => x[0] === 'asset' && x[1].includes('thumbnail.png')), 'new design gets a thumbnail so a card can be created');
    assert.equal(r.body.designUrl, 'https://acme.domo.com/assetlibrary/d-new');
  } finally { await t.close(); }
  const unknown = await startApp({ env: { DOMO_INSTANCE: 'acme', DOMO_APP_KEY: 'k' }, routes: routes([], { pdp: {} }) });
  try {
    const o = await owner(unknown); await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    const r = await o.post('/api/admin/domo-assistant/publish', { audience: 'team' });
    assert.equal(r.status, 502); assert.match(r.body.error, /did not say which datasets have PDP/);
    assert.equal((await o.post('/api/admin/domo-assistant/publish', {})).status, 200, 'owner version unaffected');
  } finally { await unknown.close(); }
});
