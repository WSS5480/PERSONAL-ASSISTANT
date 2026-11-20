const always = () => true;
export default [
  {
    name: 'add_todo',
    description: 'Add a to-do. Optional due_date (YYYY-MM-DD) and priority (low/normal/high).',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, due_date: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] } },
      required: ['title'],
    },
    available: always,
    async handler(ctx, input) { return { added: await addTodo(ctx.db, ctx.user.id, input) }; },
  },
  {
    name: 'list_todos',
    description: 'List to-dos. By default only open ones.',
    input_schema: { type: 'object', properties: { include_done: { type: 'boolean' } } },
    available: always,
    async handler(ctx, { include_done }) { return { todos: await listTodos(ctx.db, ctx.user.id, include_done) }; },
  },
  {
    name: 'complete_todo',
    description: 'Mark a to-do done by id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    available: always,
    async handler(ctx, { id }) {
      const row = await setTodoDone(ctx.db, ctx.user.id, id, true);
      if (!row) throw new Error('No such to-do');
      return { completed: row };
    },
  },
  {
    name: 'delete_todo',
    description: 'Delete a to-do by id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    available: always,
    async handler(ctx, { id }) {
      if (!(await deleteTodo(ctx.db, ctx.user.id, id))) throw new Error('No such to-do');
      return { deleted: id };
    },
  },
];

export async function addTodo(db, userId, { title, due_date, priority }) {
  if (!title?.trim()) throw new Error('title is required');
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) throw new Error('due_date must be YYYY-MM-DD');
  const p = ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';
  return db.one('INSERT INTO todos (user_id, title, due_date, priority) VALUES ($1,$2,$3,$4) RETURNING id, title, due_date::text, priority, done',
    [userId, title.trim().slice(0, 500), due_date || null, p]);
}
export function listTodos(db, userId, includeDone = false) {
  return db.query(`SELECT id, title, due_date::text, priority, done FROM todos WHERE user_id = $1 ${includeDone ? '' : 'AND done = FALSE'}
    ORDER BY done, (priority = 'high') DESC, due_date NULLS LAST, id`, [userId]);
}
export function setTodoDone(db, userId, id, done) {
  return db.one(`UPDATE todos SET done = $3, done_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1 AND user_id = $2
    RETURNING id, title, due_date::text, priority, done`, [id, userId, !!done]);
}
export async function deleteTodo(db, userId, id) {
  return (await db.query('DELETE FROM todos WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId])).length > 0;
}
