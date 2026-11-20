// Domo tools. Each query runs with the CALLING user's own token only - never another user's,
// never a shared/fallback token - so Domo's PDP decides what rows they see.
import { domoQuery, domoDatasetMeta, validateSelect, MAX_ROWS, DOMO_TABLE_NAME } from '../integrations/domo.js';

const available = (ctx) => !!(ctx.config.domoInstance && ctx.user.domo_token_enc);
const columnCache = new Map(); // key `${userId}:${datasetId}` -> { columns, at }
const CACHE_MS = 30 * 60 * 1000;
const LIST_LIMIT = 40;

function userToken(ctx) {
  const token = ctx.secrets.decrypt(ctx.user.domo_token_enc);
  if (!token) throw new Error('No Domo token on your account.');
  return token;
}
async function catalogEntry(db, datasetId) {
  const row = await db.one('SELECT * FROM datasets WHERE dataset_id = $1 AND active', [String(datasetId || '').trim()]);
  if (!row) throw new Error('That dataset is not in the catalog. Use domo_list_datasets.');
  return row;
}

export default [
  {
    name: 'domo_list_datasets',
    description: 'List/search the Domo dataset catalog (names, ids, what each answers). Start here for any business-data question. Each entry has feeds_cards, which lists the dashboard cards and apps built on it - when the user names a dashboard, app or report, search for that name and prefer the dataset that feeds it. The catalog can be large: pass a search word (e.g. "sales", "inventory") rather than listing everything.',
    input_schema: { type: 'object', properties: { search: { type: 'string' } } },
    available,
    async handler(ctx, { search }) {
      const term = search?.trim() || null;
      const where = `active AND ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%' OR column_notes ILIKE '%'||$1||'%' OR used_by ILIKE '%'||$1||'%')`;
      const { n } = await ctx.db.one(`SELECT count(*)::int AS n FROM datasets WHERE ${where}`, [term]);
      const rows = await ctx.db.query(`SELECT name, dataset_id, left(description, 300) AS description, left(column_notes, 300) AS column_notes, left(used_by, 400) AS feeds_cards
        FROM datasets WHERE ${where} ORDER BY name LIMIT ${LIST_LIMIT}`, [term]);
      return {
        datasets: rows, total: n, sqlTableName: DOMO_TABLE_NAME,
        ...(n > rows.length ? { note: `Showing ${rows.length} of ${n}. Search with a word from the dataset name to narrow it.` } : {}),
      };
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
        description: entry.description, columnNotes: entry.column_notes, feedsCards: entry.used_by, sqlTableName: DOMO_TABLE_NAME,
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
