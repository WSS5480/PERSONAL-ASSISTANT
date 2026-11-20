import { zonedToUtc, formatInZone, isValidTimeZone } from '../time.js';
const always = () => true;
const tzOf = (u) => (isValidTimeZone(u.timezone) ? u.timezone : 'America/Chicago');

export default [
  {
    name: 'create_reminder',
    description: "Create a reminder. due is the wall-clock time in the user's own timezone, format YYYY-MM-DDTHH:MM (no offset).",
    input_schema: { type: 'object', properties: { text: { type: 'string' }, due: { type: 'string' } }, required: ['text', 'due'] },
    available: always,
    async handler(ctx, input) { return { created: await createReminder(ctx.db, ctx.user, input) }; },
  },
  {
    name: 'list_reminders',
    description: 'List upcoming (undelivered) reminders.',
    input_schema: { type: 'object', properties: {} },
    available: always,
    async handler(ctx) { return { reminders: await listReminders(ctx.db, ctx.user) }; },
  },
  {
    name: 'delete_reminder',
    description: 'Delete a reminder by id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    available: always,
    async handler(ctx, { id }) {
      if (!(await deleteReminder(ctx.db, ctx.user.id, id))) throw new Error('No such reminder');
      return { deleted: id };
    },
  },
];

const view = (u) => (r) => ({ id: r.id, text: r.text, dueAt: new Date(r.due_at).toISOString(), dueLocal: formatInZone(new Date(r.due_at), tzOf(u)), delivered: r.delivered });

export async function createReminder(db, user, { text, due }) {
  if (!text?.trim()) throw new Error('text is required');
  const dueAt = zonedToUtc(due, tzOf(user));
  const row = await db.one('INSERT INTO reminders (user_id, text, due_at) VALUES ($1,$2,$3) RETURNING *', [user.id, text.trim().slice(0, 500), dueAt.toISOString()]);
  return view(user)(row);
}
export async function listReminders(db, user, { includeDelivered = false } = {}) {
  const rows = await db.query(`SELECT * FROM reminders WHERE user_id = $1 ${includeDelivered ? '' : 'AND delivered = FALSE'} ORDER BY due_at`, [user.id]);
  return rows.map(view(user));
}
export async function dueReminders(db, user) {
  const rows = await db.query('SELECT * FROM reminders WHERE user_id = $1 AND delivered = FALSE AND due_at <= now() ORDER BY due_at', [user.id]);
  return rows.map(view(user));
}
export async function deleteReminder(db, userId, id) {
  return (await db.query('DELETE FROM reminders WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId])).length > 0;
}
