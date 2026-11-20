const always = () => true;
export default [
  {
    name: 'save_note',
    description: 'Save a note (title optional).',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['body'] },
    available: always,
    async handler(ctx, input) { return { saved: await saveNote(ctx.db, ctx.user.id, input) }; },
  },
  {
    name: 'search_notes',
    description: 'Search notes by words in title or body; empty query lists recent notes.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    available: always,
    async handler(ctx, { query }) { return { notes: await searchNotes(ctx.db, ctx.user.id, query) }; },
  },
  {
    name: 'delete_note',
    description: 'Delete a note by id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    available: always,
    async handler(ctx, { id }) {
      if (!(await deleteNote(ctx.db, ctx.user.id, id))) throw new Error('No such note');
      return { deleted: id };
    },
  },
];

export async function saveNote(db, userId, { title, body }) {
  if (!body?.trim()) throw new Error('body is required');
  return db.one('INSERT INTO notes (user_id, title, body) VALUES ($1,$2,$3) RETURNING id, title, body, created_at',
    [userId, (title || '').trim().slice(0, 200), body.trim().slice(0, 20000)]);
}
export function searchNotes(db, userId, query) {
  return db.query(`SELECT id, title, body, created_at FROM notes WHERE user_id = $1
    AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%' OR body ILIKE '%' || $2 || '%') ORDER BY id DESC LIMIT 50`, [userId, query?.trim() || null]);
}
export async function deleteNote(db, userId, id) {
  return (await db.query('DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId])).length > 0;
}
