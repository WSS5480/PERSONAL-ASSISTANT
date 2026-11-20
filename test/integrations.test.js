import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, owner, createUser, ctxFor, userRow, toolMsg, textMsg } from './helpers.js';
import { toolsForUser, executeTool } from '../src/tools/registry.js';
import { validateSelect, normalizeQueryResponse } from '../src/integrations/domo.js';
import { zonedToUtc } from '../src/time.js';

const DS = 'a1b2c3d4-0000-1111-2222-333344445555';

function domoRoutes(rowsFor) {
  return [
    { match: (c) => /\/api\/query\/v1\/execute\//.test(c.url), respond: (c) => ({ body: rowsFor(c) }) },
    { match: (c) => /\/api\/data\/v3\/datasources\//.test(c.url), respond: () => ({ body: { name: 'Sales', rowCount: 999, columnCount: 2 } }) },
  ];
}

test('Domo: each user queries with their own token only; no token -> no tools', async () => {
  const t = await startApp({ env: { DOMO_INSTANCE: 'acme' }, routes: domoRoutes(() => [{ store: '1', sales: 10 }]) });
  try {
    const o = await owner(t);
    const A = await createUser(t, o, { email: 'a@example.com' });
    const B = await createUser(t, o, { email: 'b@example.com' });
    const C = await createUser(t, o, { email: 'c@example.com' });
    await o.post('/api/admin/datasets', { name: 'Sales', datasetId: DS, description: 'Daily sales by store' });
    await o.put(`/api/admin/users/${A.id}/domo-token`, { value: 'TOKEN-AAAA-1111' });
    assert.equal((await B.put('/api/me/domo-token', { token: 'TOKEN-BBBB-2222' })).status, 200);

    const a = await userRow(t, 'a@example.com'); const b = await userRow(t, 'b@example.com'); const c = await userRow(t, 'c@example.com');
    const names = async (u) => (await toolsForUser(ctxFor(t, u))).map((x) => x.name);
    assert.ok((await names(a)).includes('domo_query'));
    assert.ok(!(await names(c)).some((n) => n.startsWith('domo_')), 'no token -> no Domo tools');
    const denied = await executeTool(ctxFor(t, c), 'domo_query', { dataset_id: DS, sql: 'SELECT * FROM table' });
    assert.equal(denied.ok, false);

    t.fetchCalls.length = 0;
    const rb = await executeTool(ctxFor(t, b), 'domo_query', { dataset_id: DS, sql: 'SELECT store, SUM(sales) FROM table GROUP BY store' });
    assert.equal(rb.ok, true, rb.error);
    assert.equal(t.fetchCalls.length, 1);
    assert.equal(t.fetchCalls[0].headers['X-DOMO-Developer-Token'], 'TOKEN-BBBB-2222');
    assert.equal(t.fetchCalls[0].url, `https://acme.domo.com/api/query/v1/execute/${DS}`);
    assert.deepEqual(JSON.parse(t.fetchCalls[0].body), { sql: 'SELECT store, SUM(sales) FROM table GROUP BY store' });
    assert.ok(!JSON.stringify(t.fetchCalls).includes('TOKEN-AAAA-1111'), "B's request never carries A's token");

    // dataset info: columns via LIMIT 1, cached per user
    t.fetchCalls.length = 0;
    const info = await executeTool(ctxFor(t, a), 'domo_dataset_info', { dataset_id: DS });
    assert.deepEqual(info.result.columns, ['store', 'sales']);
    assert.ok(t.fetchCalls.every((f) => f.headers['X-DOMO-Developer-Token'] === 'TOKEN-AAAA-1111'));
    await executeTool(ctxFor(t, b), 'domo_dataset_info', { dataset_id: DS });
    assert.ok(t.fetchCalls.some((f) => /execute/.test(f.url) && f.headers['X-DOMO-Developer-Token'] === 'TOKEN-BBBB-2222'), 'B gets own column probe');

    // not in catalog -> rejected without a call
    t.fetchCalls.length = 0;
    const nc = await executeTool(ctxFor(t, a), 'domo_query', { dataset_id: 'zzzzzzzz-9999', sql: 'SELECT 1 FROM table' });
    assert.equal(nc.ok, false); assert.equal(t.fetchCalls.length, 0);

    // audit under the user who ran it with dataset + SQL + row count
    const audit = await t.db.query("SELECT * FROM audit_log WHERE tool = 'domo_query' AND outcome = 'ok'");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].user_id, b.id);
    assert.match(audit[0].summary, /Sales .*SELECT store.*\| 1 rows/);
  } finally { await t.close(); }
});

test('Domo: non-SELECT rejected, row cap 200, both response shapes', async () => {
  for (const bad of ['DELETE FROM table', 'SELECT 1; DROP TABLE x', 'UPDATE table SET a=1', 'select * from table -- x',
    'WITH x AS (SELECT 1) SELECT * FROM x', 'SELECT * INTO t2 FROM table', 'select * from table /* c */', '']) {
    assert.throws(() => validateSelect(bad), undefined, bad);
  }
  assert.equal(validateSelect("SELECT * FROM table WHERE status = 'deleted' AND note = 'drop it'"), "SELECT * FROM table WHERE status = 'deleted' AND note = 'drop it'");
  assert.equal(validateSelect('SELECT updated_at FROM table'), 'SELECT updated_at FROM table');

  assert.deepEqual(normalizeQueryResponse([{ a: 1 }]), { columns: ['a'], rows: [{ a: 1 }] });
  assert.deepEqual(normalizeQueryResponse({ columns: ['a', 'b'], rows: [[1, 2]], numRows: 1 }), { columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] });

  const many = Array.from({ length: 450 }, (_, i) => ({ i }));
  const t = await startApp({ env: { DOMO_INSTANCE: 'acme' }, routes: domoRoutes(() => ({ columns: ['i'], rows: many.map((r) => [r.i]), numRows: 450 })) });
  try {
    const o = await owner(t);
    await o.post('/api/admin/datasets', { name: 'Big', datasetId: DS });
    await o.put('/api/me/domo-token', { token: 'OWNER-TOKEN-1' });
    const me = await userRow(t, 'owner@example.com');
    const r = await executeTool(ctxFor(t, me), 'domo_query', { dataset_id: DS, sql: 'SELECT i FROM table' });
    assert.equal(r.result.rows.length, 200);
    assert.equal(r.result.truncated, true);
    assert.equal(r.result.rowCount, 450);
    assert.match(r.result.note, /first 200 of 450/);
    const rej = await executeTool(ctxFor(t, me), 'domo_query', { dataset_id: DS, sql: 'DELETE FROM table' });
    assert.equal(rej.ok, false);
  } finally { await t.close(); }
});

test('Repos: grants enforced at execution; path traversal rejected; owner sees all', async () => {
  const routes = [{ match: (c) => c.url.startsWith('https://api.github.com/'), respond: (c) => {
    if (/\/contents\//.test(c.url)) return { body: { type: 'file', path: 'README.md', size: 5, content: Buffer.from('hello').toString('base64') } };
    if (/\/user\/repos/.test(c.url)) return { body: [{ full_name: 'Steve/App-One', private: true }, { full_name: 'steve/secret', private: true }] };
    return { body: [] };
  } }];
  const t = await startApp({ env: { GITHUB_TOKEN: 'ghp_owner_token' }, routes });
  try {
    const o = await owner(t);
    const U = await createUser(t, o, { email: 'u@example.com' });
    const N = await createUser(t, o, { email: 'n@example.com' });
    const g = await o.put(`/api/admin/users/${U.id}/repos`, { repos: ['Steve/App-One', 'https://github.com/steve/app-one.git'] });
    assert.deepEqual(g.body.repos, ['steve/app-one']);
    assert.equal((await o.put(`/api/admin/users/${U.id}/repos`, { repos: ['../etc'] })).status, 400);
    await o.put(`/api/admin/users/${U.id}/repos`, { repos: ['Steve/App-One'] });

    const u = await userRow(t, 'u@example.com'); const n = await userRow(t, 'n@example.com'); const ow = await userRow(t, 'owner@example.com');
    const names = async (x) => (await toolsForUser(ctxFor(t, x))).map((y) => y.name);
    assert.ok((await names(u)).includes('repo_read_file'));
    assert.ok(!(await names(n)).some((x) => x.startsWith('repo_')), 'no grants -> no repo tools');

    const ok = await executeTool(ctxFor(t, u), 'repo_read_file', { repo: 'STEVE/app-one', path: 'README.md' });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.result.content, 'hello');
    assert.equal(t.fetchCalls.at(-1).headers.Authorization, 'Bearer ghp_owner_token');

    t.fetchCalls.length = 0;
    const no = await executeTool(ctxFor(t, u), 'repo_read_file', { repo: 'steve/secret', path: 'README.md' });
    assert.equal(no.ok, false); assert.match(no.error, /don't have access/);
    for (const p of ['../../x', 'a/../../b', 'a/%2e%2e/b', 'a\\b']) {
      const tr = await executeTool(ctxFor(t, u), 'repo_read_file', { repo: 'steve/app-one', path: p });
      assert.equal(tr.ok, false, p);
    }
    assert.equal(t.fetchCalls.length, 0, 'rejected calls never reach GitHub');
    const list = await executeTool(ctxFor(t, u), 'repo_list', {});
    assert.deepEqual(list.result.repos, ['steve/app-one']);

    // ungranted user: denied even if the model names the tool
    assert.equal((await executeTool(ctxFor(t, n), 'repo_read_file', { repo: 'steve/app-one', path: 'README.md' })).ok, false);
    // owner: any repo the token sees
    assert.equal((await executeTool(ctxFor(t, ow), 'repo_read_file', { repo: 'steve/secret', path: 'README.md' })).ok, true);
    const ol = await executeTool(ctxFor(t, ow), 'repo_list', {});
    assert.deepEqual(ol.result.repos, ['steve/app-one', 'steve/secret']);
  } finally { await t.close(); }
});

test('Render tools: owner only - invisible and non-executable for admin and user', async () => {
  const routes = [{ match: (c) => c.url.startsWith('https://api.render.com/'), respond: (c) => {
    if (/\/v1\/services\?/.test(c.url)) return { body: [{ service: { id: 'srv-1', name: 'web', ownerId: 'own-1', suspended: 'not_suspended', serviceDetails: { url: 'https://web.onrender.com' } }, cursor: 'c1' }] };
    if (/deploys/.test(c.url)) return { body: [{ deploy: { id: 'd1', status: 'build_failed' }, cursor: 'x' }] };
    return { body: {} };
  } }];
  const t = await startApp({ env: { RENDER_API_KEY: 'rnd_secret_key', ANTHROPIC_API_KEY: 'sk' }, routes });
  try {
    const o = await owner(t);
    const A = await createUser(t, o, { email: 'a@example.com', role: 'admin' });
    await createUser(t, o, { email: 'u@example.com' });
    for (const email of ['a@example.com', 'u@example.com']) {
      const row = await userRow(t, email);
      const names = (await toolsForUser(ctxFor(t, row))).map((x) => x.name);
      assert.ok(!names.some((n) => n.startsWith('render_')), `${email} sees no render tools`);
      for (const tool of ['render_list_services', 'render_trigger_deploy', 'render_restart_service', 'render_logs']) {
        const r = await executeTool(ctxFor(t, row), tool, { service_id: 'srv-1' }, { approved: true });
        assert.equal(r.ok, false, `${email} ${tool}`);
      }
    }
    assert.equal(t.fetchCalls.length, 0);
    // admin via chat: model names a render tool -> denied
    await o.patch(`/api/admin/users/${A.id}`, { houseKeyAllowed: true });
    t.ai.state.script = ((n = 0) => () => (n++ === 0 ? toolMsg('render_list_services', {}) : textMsg('ok')))();
    await A.post('/api/chat', { message: 'list my apps' });
    assert.equal(t.fetchCalls.length, 0);
    assert.ok(!t.ai.calls.at(-2).params.tools.some((x) => x.name.startsWith('render_')));

    // owner sees + uses them; apps tile works
    const ow = await userRow(t, 'owner@example.com');
    assert.ok((await toolsForUser(ctxFor(t, ow))).some((x) => x.name === 'render_restart_service'));
    const apps = await o.get('/api/apps');
    assert.equal(apps.status, 200);
    assert.equal(apps.body.count, 1);
    assert.equal(apps.body.failing, 1);
    assert.equal(t.fetchCalls[0].headers.Authorization, 'Bearer rnd_secret_key');
  } finally { await t.close(); }
});

test('Reminders: wall-clock in user timezone stored as UTC; due polling', async () => {
  assert.equal(zonedToUtc('2026-11-20T09:00', 'America/Chicago').toISOString(), '2026-11-20T15:00:00.000Z');
  assert.equal(zonedToUtc('2026-07-04T09:00', 'America/Chicago').toISOString(), '2026-07-04T14:00:00.000Z');
  assert.equal(zonedToUtc('2026-11-20T09:00', 'Asia/Tokyo').toISOString(), '2026-11-20T00:00:00.000Z');
  const t = await startApp({ env: { ANTHROPIC_API_KEY: 'sk' } });
  try {
    const o = await owner(t);
    await o.patch('/api/me', { timezone: 'America/New_York' });
    const r = await o.post('/api/reminders', { text: 'Call bank', due: '2026-12-01T10:30' });
    assert.equal(r.body.reminder.dueAt, '2026-12-01T15:30:00.000Z');
    const row = await t.db.one('SELECT due_at FROM reminders WHERE id = $1', [r.body.reminder.id]);
    assert.equal(new Date(row.due_at).toISOString(), '2026-12-01T15:30:00.000Z');
    // via the tool
    t.ai.state.script = ((n = 0) => () => (n++ === 0 ? toolMsg('create_reminder', { text: 'Lunch', due: '2026-12-02T12:00' }) : textMsg('Set.')))();
    await o.post('/api/chat', { message: 'remind me lunch' });
    const all = (await o.get('/api/reminders')).body.reminders;
    assert.equal(all.find((x) => x.text === 'Lunch').dueAt, '2026-12-02T17:00:00.000Z');
    // past one is due; delivered removes it
    const past = await o.post('/api/reminders', { text: 'Past', due: '2020-01-01T08:00' });
    const due = (await o.get('/api/reminders/due')).body.reminders;
    assert.deepEqual(due.map((x) => x.text), ['Past']);
    await o.post(`/api/reminders/${past.body.reminder.id}/delivered`);
    assert.equal((await o.get('/api/reminders/due')).body.reminders.length, 0);
    assert.equal((await o.patch('/api/me', { timezone: 'Mars/Base' })).status, 400);
  } finally { await t.close(); }
});

test('Google: not configured -> tools absent; OAuth state validated', async () => {
  const t = await startApp({ env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', APP_URL: 'http://localhost:3000' }, routes: [
    { match: (c) => c.url === 'https://oauth2.googleapis.com/token', respond: () => ({ body: { access_token: 'ya29.ACCESS', refresh_token: '1//REFRESH', expires_in: 3600 } }) },
  ] });
  try {
    const o = await owner(t);
    const ow = await userRow(t, 'owner@example.com');
    assert.ok(!(await toolsForUser(ctxFor(t, ow))).some((x) => x.name.startsWith('gmail_')), 'not connected -> no google tools');
    const start = await o.get('/auth/google/start');
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get('location'));
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/google/callback');
    const state = loc.searchParams.get('state');
    // bad state rejected
    const bad = await o.get('/auth/google/callback?code=abc&state=wrong');
    assert.match(bad.headers.get('location'), /google=failed/);
    // another user can't use my state
    const other = await createUser(t, o, { email: 'x@example.com' });
    const stolen = await other.get(`/auth/google/callback?code=abc&state=${state}`);
    assert.match(stolen.headers.get('location'), /google=failed/);
    // state was consumed by the failed attempt; start again
    const s2 = new URL((await o.get('/auth/google/start')).headers.get('location')).searchParams.get('state');
    const good = await o.get(`/auth/google/callback?code=abc&state=${s2}`);
    assert.match(good.headers.get('location'), /google=connected/);
    const tok = await t.db.one('SELECT * FROM google_tokens WHERE user_id = $1', [ow.id]);
    assert.ok(!tok.access_enc.includes('ya29'), 'stored encrypted');
    assert.ok((await toolsForUser(ctxFor(t, ow))).some((x) => x.name === 'gmail_send'));
    const me = await o.get('/api/me');
    assert.equal(me.body.integrations.google.connected, true);
    assert.ok(!me.text.includes('ya29') && !me.text.includes('REFRESH'));
  } finally { await t.close(); }
  const t2 = await startApp();
  try {
    await owner(t2);
    const row = await userRow(t2, 'owner@example.com');
    assert.ok(!(await toolsForUser(ctxFor(t2, row))).some((x) => /^(gmail|calendar)_/.test(x.name)));
  } finally { await t2.close(); }
});

test('Secrets never appear in any API response; stored encrypted', async () => {
  const t = await startApp({ env: { DOMO_INSTANCE: 'acme', GITHUB_TOKEN: 'ghp_SUPERSECRET', RENDER_API_KEY: 'rnd_SUPERSECRET', ANTHROPIC_API_KEY: 'sk-ant-HOUSESECRET' } });
  try {
    const o = await owner(t);
    const U = await createUser(t, o, { email: 'u@example.com' });
    const AI = 'sk-ant-api03-USERSECRET-abcd'; const DOMO = 'domo-USERSECRET-wxyz'; const OWND = 'domo-OWNERSECRET-5678';
    const r1 = await o.put(`/api/admin/users/${U.id}/ai-key`, { value: AI });
    assert.deepEqual(r1.body, { set: true, last4: 'abcd' });
    await o.put(`/api/admin/users/${U.id}/domo-token`, { value: DOMO });
    await o.put('/api/me/domo-token', { token: OWND });
    for (const p of ['/api/me', '/api/admin/users', '/api/admin/usage', `/api/admin/audit/${U.id}`, '/api/activity', '/api/summary']) await o.get(p);
    for (const p of ['/api/me', '/api/activity', '/api/chat/history']) await U.get(p);
    await U.post('/api/chat', { message: 'hi' });
    const all = [...o.responses, ...U.responses].join('\n');
    for (const s of [AI, DOMO, OWND, 'ghp_SUPERSECRET', 'rnd_SUPERSECRET', 'sk-ant-HOUSESECRET', 'USERSECRET', 'OWNERSECRET', 'password_hash', 'scrypt$']) {
      assert.ok(!all.includes(s), `response leaked ${s}`);
    }
    const users = (await o.get('/api/admin/users')).body.users;
    const u = users.find((x) => x.id === U.id);
    assert.deepEqual(u.aiKey, { set: true, last4: 'abcd' });
    assert.deepEqual(u.domoToken, { set: true, last4: 'wxyz' });
    const row = await userRow(t, 'u@example.com');
    assert.ok(row.ai_key_enc.startsWith('v1:') && !row.ai_key_enc.includes('USERSECRET'));
    assert.ok(!row.domo_token_enc.includes('USERSECRET'));
  } finally { await t.close(); }
});

test('Domo catalog import: uses the admin\'s own token, keeps existing entries, admin-only', async () => {
  const page = Array.from({ length: 3 }, (_, i) => ({ id: `bbbbbbbb-0000-0000-0000-00000000000${i}`, name: `Set ${i}`, description: `desc ${i}`, rowCount: 10 * i }));
  const t = await startApp({ env: { DOMO_INSTANCE: 'acme' }, routes: [
    { match: (c) => /\/api\/data\/ui\/v3\/datasources\/search/.test(c.url), respond: () => ({ body: { dataSources: page } }) },
  ] });
  try {
    const o = await owner(t);
    const U = await createUser(t, o, { email: 'u@example.com' });
    assert.equal((await U.post('/api/admin/datasets/import', {})).status, 403);
    assert.equal((await o.post('/api/admin/datasets/import', {})).status, 400, 'no token yet');
    await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    await o.post('/api/admin/datasets', { name: 'Mine', datasetId: page[0].id, description: 'keep me' });
    t.fetchCalls.length = 0;
    const r = await o.post('/api/admin/datasets/import', {});
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { found: 3, added: 2 });
    assert.equal(t.fetchCalls[0].headers['X-DOMO-Developer-Token'], 'TOKEN-OWNER-9999');
    const list = (await o.get('/api/admin/datasets')).body.datasets;
    assert.equal(list.length, 3);
    assert.equal(list.find((d) => d.dataset_id === page[0].id).description, 'keep me');
    for (const resp of o.responses) assert.ok(!resp.includes('TOKEN-OWNER-9999'));
  } finally { await t.close(); }
});

test('Domo catalog: keep only dashboard/app data hides unused datasets from the assistant; failed check changes nothing', async () => {
  const USED = 'cccccccc-0000-0000-0000-000000000001'; const UNUSED = 'cccccccc-0000-0000-0000-000000000002';
  let fail = false;
  const t = await startApp({ env: { DOMO_INSTANCE: 'acme' }, routes: [
    { match: (c) => /\/api\/content\/v1\/datasources\//.test(c.url), respond: (c) => (fail ? { status: 403, body: { message: 'no' } }
      : { body: c.url.includes(USED) ? [{ id: 1, title: 'Executive Dashboard - Sales' }, { id: 2, title: 'DMR Live!' }] : [] }) },
    { match: (c) => /\/api\/query\/v1\/execute\//.test(c.url), respond: () => ({ body: [{ a: 1 }] }) },
  ] });
  try {
    const o = await owner(t);
    await o.put('/api/me/domo-token', { token: 'TOKEN-OWNER-9999' });
    await o.post('/api/admin/datasets', { name: 'Sales', datasetId: USED });
    await o.post('/api/admin/datasets', { name: 'Scratch', datasetId: UNUSED });
    fail = true;
    assert.equal((await o.post('/api/admin/datasets/match-cards', {})).status, 502);
    assert.ok((await o.get('/api/admin/datasets')).body.datasets.every((d) => d.active), 'failed check must not hide anything');
    fail = false;
    const r = await o.post('/api/admin/datasets/match-cards', {});
    assert.deepEqual(r.body, { checked: 2, inUse: 1, hidden: 1, failed: 0 });
    const me = await userRow(t, 'owner@example.com');
    const list = await executeTool(ctxFor(t, me), 'domo_list_datasets', { search: 'executive' });
    assert.equal(list.result.datasets.length, 1);
    assert.match(list.result.datasets[0].feeds_cards, /Executive Dashboard/);
    const q = await executeTool(ctxFor(t, me), 'domo_query', { dataset_id: UNUSED, sql: 'SELECT * FROM table' });
    assert.equal(q.ok, false, 'hidden dataset cannot be queried');
    const ds = (await o.get('/api/admin/datasets')).body.datasets.find((d) => d.dataset_id === UNUSED);
    await o.patch(`/api/admin/datasets/${ds.id}/active`, { active: true });
    assert.equal((await executeTool(ctxFor(t, me), 'domo_query', { dataset_id: UNUSED, sql: 'SELECT * FROM table' })).ok, true);
  } finally { await t.close(); }
});
