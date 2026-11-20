const always = () => true;
export default [
  {
    name: 'remember_fact',
    description: 'Save a lasting fact or preference about the user (e.g. "prefers morning meetings").',
    input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
    available: always,
    async handler(ctx, { fact }) {
      if (!fact?.trim()) throw new Error('fact is required');
      const row = await ctx.db.one('INSERT INTO memory_facts (user_id, fact) VALUES ($1,$2) RETURNING id, fact', [ctx.user.id, fact.trim().slice(0, 1000)]);
      return { saved: row };
    },
  },
  {
    name: 'recall_facts',
    description: 'List saved facts about the user, optionally filtered by a search word.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    available: always,
    async handler(ctx, { query }) {
      const rows = await ctx.db.query(
        `SELECT id, fact FROM memory_facts WHERE user_id = $1 AND ($2::text IS NULL OR fact ILIKE '%' || $2 || '%') ORDER BY id`,
        [ctx.user.id, query || null]);
      return { facts: rows };
    },
  },
  {
    name: 'forget_fact',
    description: 'Delete a saved fact by id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    available: always,
    async handler(ctx, { id }) {
      const rows = await ctx.db.query('DELETE FROM memory_facts WHERE id = $1 AND user_id = $2 RETURNING id', [id, ctx.user.id]);
      if (!rows.length) throw new Error('No such fact');
      return { deleted: id };
    },
  },
];
