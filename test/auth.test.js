import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, owner } from './helpers.js';

test('first account is owner; sign-up closed without SIGNUP_CODE', async () => {
  const t = await startApp();
  try {
    const st = await t.client().get('/auth/status');
    assert.equal(st.body.firstUser, true);
    const o = await owner(t);
    const me = await o.get('/api/me');
    assert.equal(me.body.user.role, 'owner');
    const second = await t.client().post('/auth/signup', { email: 'b@example.com', password: 'password1' });
    assert.equal(second.status, 403);
    assert.match(second.body.error, /closed/i);
    const st2 = await t.client().get('/auth/status');
    assert.equal(st2.body.signupOpen, false);
  } finally { await t.close(); }
});

test('invite code sign-up', async () => {
  const t = await startApp({ env: { SIGNUP_CODE: 'letmein' } });
  try {
    await owner(t);
    const bad = await t.client().post('/auth/signup', { email: 'b@example.com', password: 'password1', inviteCode: 'nope' });
    assert.equal(bad.status, 403);
    const good = await t.client().post('/auth/signup', { email: 'b@example.com', password: 'password1', inviteCode: 'letmein' });
    assert.equal(good.status, 201);
    assert.equal(good.body.user.role, 'user');
    const dupe = await t.client().post('/auth/signup', { email: 'B@example.com', password: 'password1', inviteCode: 'letmein' });
    assert.equal(dupe.status, 409);
  } finally { await t.close(); }
});

test('sign in, wrong password, sign out, CSRF header required', async () => {
  const t = await startApp();
  try {
    await owner(t);
    const c = t.client();
    assert.equal((await c.post('/auth/signin', { email: 'owner@example.com', password: 'wrongpass' })).status, 401);
    assert.equal((await c.post('/auth/signin', { email: 'owner@example.com', password: 'ownerpass1' })).status, 200);
    assert.equal((await c.get('/api/todos')).status, 200);
    const noHeader = await c.req('POST', '/api/todos', { title: 'x' }, { csrf: false });
    assert.equal(noHeader.status, 403);
    await c.post('/auth/signout');
    assert.equal((await c.get('/api/todos')).status, 401);
  } finally { await t.close(); }
});

test('cookie is httpOnly, SameSite=Lax; Secure when APP_URL is https', async () => {
  const t = await startApp({ env: { APP_URL: 'https://x.onrender.com' } });
  try {
    const c = t.client();
    const r = await c.req('POST', '/auth/signup', { email: 'o@example.com', password: 'password1' });
    const sc = r.headers.getSetCookie().join(';');
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Secure/);
  } finally { await t.close(); }
});

test('admin-created user must change temporary password first', async () => {
  const t = await startApp();
  try {
    const o = await owner(t);
    await o.post('/api/admin/users', { email: 'u@example.com', password: 'temporary1' });
    const u = t.client();
    await u.post('/auth/signin', { email: 'u@example.com', password: 'temporary1' });
    const me = await u.get('/api/me');
    assert.equal(me.body.user.mustChangePassword, true);
    assert.equal((await u.get('/api/todos')).status, 403);
    assert.equal((await u.post('/auth/change-password', { currentPassword: 'temporary1', newPassword: 'newpass123' })).status, 200);
    assert.equal((await u.get('/api/todos')).status, 200);
  } finally { await t.close(); }
});

test('disabled user cannot sign in and loses sessions', async () => {
  const t = await startApp();
  try {
    const o = await owner(t);
    const r = await o.post('/api/admin/users', { email: 'u@example.com', password: 'temporary1' });
    const u = t.client();
    await u.post('/auth/signin', { email: 'u@example.com', password: 'temporary1' });
    await o.patch(`/api/admin/users/${r.body.user.id}`, { disabled: true });
    assert.equal((await u.get('/api/me')).status, 401);
    assert.equal((await t.client().post('/auth/signin', { email: 'u@example.com', password: 'temporary1' })).status, 401);
  } finally { await t.close(); }
});

test('healthz and security headers', async () => {
  const t = await startApp();
  try {
    const r = await t.client().get('/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { await t.close(); }
});

test('auth endpoints are rate limited', async () => {
  const t = await startApp();
  try {
    const c = t.client();
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await c.post('/auth/signin', { email: 'n@example.com', password: 'whatever1' })).status);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
    assert.equal(codes[11], 429);
  } finally { await t.close(); }
});

test('OWNER_EMAIL locks who can claim the first (owner) account', async () => {
  const t = await startApp({ env: { OWNER_EMAIL: 'Boss@Example.com' } });
  try {
    const stranger = await t.client().post('/auth/signup', { email: 'stranger@example.com', password: 'password1' });
    assert.equal(stranger.status, 403);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM users')).n, 0);
    const boss = await t.client().post('/auth/signup', { email: 'boss@example.com', password: 'password1' });
    assert.equal(boss.status, 201);
    assert.equal(boss.body.user.role, 'owner');
  } finally { await t.close(); }
});
