import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, owner, createUser, toolMsg, textMsg } from './helpers.js';

test('user B cannot read or modify user A\'s data', async () => {
  const t = await startApp({ env: { ANTHROPIC_API_KEY: 'sk-house' } });
  try {
    const o = await owner(t);
    const A = await createUser(t, o, { email: 'a@example.com' });
    const B = await createUser(t, o, { email: 'b@example.com' });

    const todo = (await A.post('/api/todos', { title: 'A secret todo' })).body.todo;
    const note = (await A.post('/api/notes', { body: 'A secret note' })).body.note;
    const rem = (await A.post('/api/reminders', { text: 'A reminder', due: '2020-01-01T09:00' })).body.reminder;
    await t.db.query("INSERT INTO memory_facts (user_id, fact) VALUES ($1, 'A likes tea')", [A.id]);
    const fact = (await A.get('/api/memory')).body.facts[0];

    // Lists are empty for B
    assert.equal((await B.get('/api/todos?all=1')).body.todos.length, 0);
    assert.equal((await B.get('/api/notes')).body.notes.length, 0);
    assert.equal((await B.get('/api/reminders?all=1')).body.reminders.length, 0);
    assert.equal((await B.get('/api/reminders/due')).body.reminders.length, 0);
    assert.equal((await B.get('/api/memory')).body.facts.length, 0);

    // Modify/delete A's rows -> 404 and rows untouched
    assert.equal((await B.patch(`/api/todos/${todo.id}`, { done: true })).status, 404);
    assert.equal((await B.del(`/api/todos/${todo.id}`)).status, 404);
    assert.equal((await B.del(`/api/notes/${note.id}`)).status, 404);
    assert.equal((await B.del(`/api/reminders/${rem.id}`)).status, 404);
    assert.equal((await B.post(`/api/reminders/${rem.id}/delivered`)).status, 404);
    assert.equal((await B.del(`/api/memory/${fact.id}`)).status, 404);
    assert.equal((await A.get('/api/todos')).body.todos[0].done, false);
    assert.equal((await A.get('/api/notes')).body.notes.length, 1);
    assert.equal((await A.get('/api/reminders/due')).body.reminders.length, 1);

    // Tools also scoped: B's model tries to delete A's todo by id
    await o.patch(`/api/admin/users/${B.id}`, { houseKeyAllowed: true });
    let i = 0;
    t.ai.state.script = () => (i++ === 0 ? toolMsg('delete_todo', { id: todo.id }) : textMsg('done'));
    await B.post('/api/chat', { message: 'delete todo' });
    assert.equal((await A.get('/api/todos')).body.todos.length, 1, 'A todo survives B tool call');

    // Audit: B sees only own, not A's
    const bAct = (await B.get('/api/activity')).body.activity;
    assert.ok(bAct.every((x) => !/A secret/.test(x.summary)));
    const aAct = (await A.get('/api/activity')).body.activity;
    assert.ok(aAct.every((x) => x.tool !== 'delete_todo'));
    // Owner can view B's audit
    const view = await o.get(`/api/admin/audit/${B.id}`);
    assert.equal(view.status, 200);
    assert.ok(view.body.activity.some((x) => x.tool === 'delete_todo'));
    // B's chat history doesn't include A's
    assert.equal((await A.get('/api/chat/history')).body.messages.length, 0);
  } finally { await t.close(); }
});
