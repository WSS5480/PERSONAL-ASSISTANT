import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, owner, createUser } from './helpers.js';

const ADMIN_ENDPOINTS = [
  ['GET', '/api/admin/users'], ['POST', '/api/admin/users', { email: 'z@example.com', password: 'temporary1' }],
  ['PATCH', '/api/admin/users/1', { name: 'x' }], ['POST', '/api/admin/users/1/password', { password: 'temporary1' }],
  ['PUT', '/api/admin/users/1/ai-key', { value: 'sk-ant-xxxxxxxxxx' }], ['DELETE', '/api/admin/users/1/ai-key'],
  ['PUT', '/api/admin/users/1/domo-token', { value: 'domotoken123' }], ['DELETE', '/api/admin/users/1/domo-token'],
  ['PUT', '/api/admin/users/1/repos', { repos: ['a/b'] }], ['GET', '/api/admin/repos-available'],
  ['GET', '/api/admin/usage'], ['GET', '/api/admin/usage/1'], ['GET', '/api/admin/audit/1'],
  ['GET', '/api/admin/datasets'], ['POST', '/api/admin/datasets', { name: 'x', datasetId: 'abcdefgh-1234' }],
  ['PUT', '/api/admin/datasets/1', { name: 'x', datasetId: 'abcdefgh-1234' }], ['DELETE', '/api/admin/datasets/1'],
];
const OWNER_ENDPOINTS = [['GET', '/api/apps'], ['GET', '/api/apps/srv-1/deploys'], ['GET', '/api/apps/srv-1/logs']];

test('plain user gets 403 on every admin and owner endpoint', async () => {
  const t = await startApp({ env: { RENDER_API_KEY: 'rnd_key', GITHUB_TOKEN: 'ghp_x' } });
  try {
    const o = await owner(t);
    const u = await createUser(t, o, { email: 'u@example.com' });
    for (const [m, p, b] of [...ADMIN_ENDPOINTS, ...OWNER_ENDPOINTS]) {
      const r = await u.req(m, p, b);
      assert.equal(r.status, 403, `${m} ${p} should be 403, got ${r.status}`);
    }
    const anon = t.client();
    for (const [m, p, b] of ADMIN_ENDPOINTS) assert.equal((await anon.req(m, p, b)).status, 401, `${m} ${p} anon`);
    assert.equal(t.fetchCalls.length, 0, 'no outbound calls made');
  } finally { await t.close(); }
});

test('admin: allowed admin endpoints, but no owner-only powers', async () => {
  const t = await startApp({ env: { RENDER_API_KEY: 'rnd_key' } });
  try {
    const o = await owner(t);
    const a = await createUser(t, o, { email: 'a@example.com', role: 'admin' });
    const u = await createUser(t, o, { email: 'u@example.com' });
    const ownerId = (await o.get('/api/me')).body.user.id;
    assert.equal((await a.get('/api/admin/users')).status, 200);
    // role changes are owner-only
    assert.equal((await a.patch(`/api/admin/users/${u.id}`, { role: 'admin' })).status, 403);
    // house-key toggle is owner-only
    assert.equal((await a.patch(`/api/admin/users/${u.id}`, { houseKeyAllowed: true })).status, 403);
    // admin cannot create admins
    assert.equal((await a.post('/api/admin/users', { email: 'x@example.com', password: 'temporary1', role: 'admin' })).status, 403);
    // admin cannot touch the owner account
    assert.equal((await a.patch(`/api/admin/users/${ownerId}`, { name: 'hacked' })).status, 403);
    assert.equal((await a.put(`/api/admin/users/${ownerId}/domo-token`, { value: 'abcdefghijk' })).status, 403);
    assert.equal((await a.post(`/api/admin/users/${ownerId}/password`, { password: 'temporary1' })).status, 403);
    // admin can edit labels of a user
    const ok = await a.patch(`/api/admin/users/${u.id}`, { accessLevel: 'district', district: '9212' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.district, '9212');
    // Apps (Render) are owner only
    assert.equal((await a.get('/api/apps')).status, 403);
    // owner can change roles and house key
    assert.equal((await o.patch(`/api/admin/users/${u.id}`, { role: 'admin', houseKeyAllowed: true })).status, 200);
    // nobody can make another owner
    assert.equal((await o.patch(`/api/admin/users/${u.id}`, { role: 'owner' })).status, 400);
  } finally { await t.close(); }
});
