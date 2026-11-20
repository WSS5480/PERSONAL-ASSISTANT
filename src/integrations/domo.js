// Domo REST via the user's OWN access token (Domo applies that user's PDP).
// Endpoints per Domo docs:
//   POST https://{instance}.domo.com/api/query/v1/execute/{datasetId}  body {"sql": "..."}
//   GET  https://{instance}.domo.com/api/data/v3/datasources/{datasetId}?part=core,permission
// MUST-VERIFY: SQL table name convention. Docs examples use a placeholder; we default to `table`.
export const DOMO_TABLE_NAME = 'table';
export const MAX_ROWS = 200;
const TIMEOUT_MS = 30000;

const base = (instance) => `https://${instance}.domo.com`;
const headers = (token) => ({ 'X-DOMO-Developer-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' });

// Single read-only SELECT only.
export function validateSelect(sql) {
  const s = String(sql || '').trim();
  if (!s) throw new Error('SQL is required');
  if (s.length > 5000) throw new Error('SQL too long');
  if (s.includes(';')) throw new Error('Only one statement allowed (no semicolons)');
  if (/--|\/\*/.test(s)) throw new Error('Comments are not allowed in SQL');
  if (!/^select\s/i.test(s)) throw new Error('Only SELECT queries are allowed');
  const noLiterals = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/`[^`]*`/g, '``');
  const bad = noLiterals.match(/\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|replace|exec|execute|call|into|attach|copy|set|commit|rollback)\b/i);
  if (bad) throw new Error(`Keyword not allowed in a read-only query: ${bad[1].toUpperCase()}`);
  return s;
}

// Normalizes both documented response shapes into { columns, rows: [objects] }.
export function normalizeQueryResponse(data) {
  if (Array.isArray(data)) {
    return { columns: data.length ? Object.keys(data[0]) : [], rows: data };
  }
  if (data && Array.isArray(data.rows)) {
    const columns = (data.columns || data.metadata?.map?.((m) => m.name) || []).map((c) => (typeof c === 'string' ? c : c?.name));
    const rows = data.rows.map((r) => (Array.isArray(r) ? Object.fromEntries(columns.map((c, i) => [c ?? `col${i}`, r[i]])) : r));
    return { columns: columns.length ? columns : rows[0] ? Object.keys(rows[0]) : [], rows };
  }
  return { columns: [], rows: [] };
}

async function domoFetch(ctx, url, init) {
  const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`Domo ${res.status}: ${data.message || data.error || 'request failed'}`);
  return data;
}

export async function domoQuery(ctx, token, datasetId, sql) {
  const data = await domoFetch(ctx, `${base(ctx.config.domoInstance)}/api/query/v1/execute/${encodeURIComponent(datasetId)}`,
    { method: 'POST', headers: headers(token), body: JSON.stringify({ sql }) });
  return normalizeQueryResponse(data);
}

export function domoDatasetMeta(ctx, token, datasetId) {
  return domoFetch(ctx, `${base(ctx.config.domoInstance)}/api/data/v3/datasources/${encodeURIComponent(datasetId)}?part=core,permission`,
    { method: 'GET', headers: headers(token) });
}

// Lists every dataset the token's user can see, via Domo's Data Center search endpoint
// (POST /api/data/ui/v3/datasources/search). Not in Domo's public API reference - it is the
// endpoint the Domo UI itself uses - so the response is read defensively. MUST-VERIFY live.
export async function domoListAllDatasets(ctx, token, { max = 2000, pageSize = 100 } = {}) {
  const out = [];
  const seen = new Set();
  for (let offset = 0; offset < max; offset += pageSize) {
    const data = await domoFetch(ctx, `${base(ctx.config.domoInstance)}/api/data/ui/v3/datasources/search`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ entities: ['DATASET'], filters: [], combineResults: true, query: '*', count: pageSize, offset }),
    });
    const items = Array.isArray(data) ? data : (data.dataSources || data.searchObjects || data.datasets || []);
    let fresh = 0;
    for (const d of items) {
      const id = String(d.id || d.databaseId || d.dataSourceId || '').trim();
      const name = String(d.name || d.displayName || '').trim();
      if (!id || !name || seen.has(id)) continue;
      seen.add(id); fresh++;
      out.push({ id, name, description: String(d.description || '').trim(), rowCount: d.rowCount ?? null, type: d.displayType || d.dataProviderType || d.type || '' });
    }
    if (items.length < pageSize || !fresh) break;
  }
  return out;
}
