// Domo tools. Each query runs with the CALLING user's own token only - never another user's,
// never a shared/fallback token - so Domo's PDP decides what rows they see.
import { domoQuery, domoDatasetMeta, validateSelect, MAX_ROWS, DOMO_TABLE_NAME } from '../integrations/domo.js';

const available = (ctx) => !!(ctx.config.domoInstance && ctx.user.domo_token_enc);
const columnCache = new Map(); // key `${userId}:${datasetId}` -> { columns, at }
const CACHE_MS = 30 * 60 * 1000;

function userToken(ctx) {
  const token = ctx.secrets.decrypt(ctx.user.domo_token_enc);
  if (!token) throw new Error('No Domo token on your account.');
  return token;
}
async function catalogEntry(db, datasetId) {
  const row = await db.one('SELECT * FROM datasets WHERE dataset_id = $1', [String(datasetId || '').trim()]);
  if (!row) throw new Error('That dataset is not in the catalog. Use domo_list_datasets.');
  return row;
}

export default [
  {
    name: 'domo_list_datasets',
    description: 'List/search the Domo dataset catalog (names, ids, what each answers). Start here for any business-data question.',
    input_schema: { type: 'object', properties: { search: { type: 'string' } } },
    available,
    async handler(ctx, { search }) {
      const rows = await ctx.db.query(`SELECT name, dataset_id, description, column_notes FROM datasets
        WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%' OR column_notes ILIKE '%'||$1||'%') ORDER BY name`, [search?.trim() || null]);
      return { datasets: rows, sqlTableName: DOMO_TABLE_NAME };
    },
  },
  {
    name: 'domo_dataset_info',
    description: 'Get a catalog dataset\'s row count and column names (as visible to this user).',
    input_schema: { type: 'object', properties: { dataset_id: { type: 'string' } }, required: ['dataset_id'] },
    available,
    async handler(ctx, { dataset_id }) {
      const entry = await catalogEntry(ctx.db, dataset_id);
      const token = userToken(ctx);
      const meta = await domoDatasetMeta(ctx, token, entry.dataset_id);
      const key = `${ctx.user.id}:${entry.dataset_id}`;
      let cached = columnCache.get(key);
      if (!cached || Date.now() - cached.at > CACHE_MS) {
        const r = await domoQuery(ctx, token, entry.dataset_id, `SELECT * FROM ${DOMO_TABLE_NAME} LIMIT 1`);
        cached = { columns: r.columns, at: Date.now() };
        columnCache.set(key, cached);
      }
      return {
        name: meta.name || entry.name, rowCount: meta.rowCount, columnCount: meta.columnCount, columns: cached.columns,
        description: entry.description, columnNotes: entry.column_notes, sqlTableName: DOMO_TABLE_NAME,
      };
    },
  },
  {
    name: 'domo_query',
    description: `Run one read-only SELECT on a catalog dataset. Use FROM ${DOMO_TABLE_NAME} as the table name. Aggregate (SUM/COUNT/GROUP BY) instead of pulling raw rows; at most ${MAX_ROWS} rows come back.`,
    input_schema: { type: 'object', properties: { dataset_id: { type: 'string' }, sql: { type: 'string' } }, required: ['dataset_id', 'sql'] },
    available,
    async handler(ctx, { dataset_id, sql }) {
      const entry = await catalogEntry(ctx.db, dataset_id);
      const clean = validateSelect(sql);
      const r = await domoQuery(ctx, userToken(ctx), entry.dataset_id, clean);
      const truncated = r.rows.length > MAX_ROWS;
      const rows = r.rows.slice(0, MAX_ROWS);
      return {
        dataset: entry.name, columns: r.columns, rows, rowCount: r.rows.length, truncated,
        ...(truncated ? { note: `Only the first ${MAX_ROWS} of ${r.rows.length} rows are shown. Aggregate or filter for complete answers.` } : {}),
        _audit: `dataset ${entry.name} (${entry.dataset_id}) | ${clean.slice(0, 400)} | ${r.rows.length} rows`,
      };
    },
  },
];

export const _columnCache = columnCache;
