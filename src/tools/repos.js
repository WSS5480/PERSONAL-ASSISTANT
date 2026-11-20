// Read-only GitHub repository tools. Every call validates the repo against the caller's grants.
// The owner implicitly has every repo the server's GITHUB_TOKEN can see.
import { gh, normalizeRepo, safePath, listTokenRepos, MAX_FILE_BYTES } from '../integrations/github.js';

async function userGrants(ctx) {
  if (ctx.cache?.repoGrants) return ctx.cache.repoGrants;
  const rows = await ctx.db.query('SELECT repo FROM repo_grants WHERE user_id = $1 ORDER BY repo', [ctx.user.id]);
  const grants = rows.map((r) => r.repo);
  if (ctx.cache) ctx.cache.repoGrants = grants;
  return grants;
}
async function available(ctx) {
  if (!ctx.config.githubToken) return false;
  return ctx.user.role === 'owner' || (await userGrants(ctx)).length > 0;
}
export async function checkRepo(ctx, repo) {
  const r = normalizeRepo(repo);
  if (ctx.user.role === 'owner') return r;
  const grants = await ctx.db.query('SELECT 1 FROM repo_grants WHERE user_id = $1 AND repo = $2', [ctx.user.id, r]);
  if (!grants.length) throw new Error(`You don't have access to ${r}.`);
  return r;
}
const repoProp = { repo: { type: 'string', description: 'owner/name' } };

export default [
  {
    name: 'repo_list',
    description: 'List the code repositories this user can read.',
    input_schema: { type: 'object', properties: {} },
    available,
    async handler(ctx) {
      if (ctx.user.role === 'owner') return { repos: (await listTokenRepos(ctx)).map((r) => r.repo) };
      return { repos: await userGrants(ctx) };
    },
  },
  {
    name: 'repo_list_dir',
    description: 'List files/folders at a path in a repository (empty path = root).',
    input_schema: { type: 'object', properties: { ...repoProp, path: { type: 'string' } }, required: ['repo'] },
    available,
    async handler(ctx, { repo, path }) {
      const r = await checkRepo(ctx, repo);
      const data = await gh(ctx, `/repos/${r}/contents/${safePath(path)}`);
      const items = Array.isArray(data) ? data : [data];
      return { repo: r, items: items.map((i) => ({ name: i.name, path: i.path, type: i.type, size: i.size })) };
    },
  },
  {
    name: 'repo_read_file',
    description: `Read a text file from a repository (first ${MAX_FILE_BYTES / 1000} KB).`,
    input_schema: { type: 'object', properties: { ...repoProp, path: { type: 'string' } }, required: ['repo', 'path'] },
    available,
    async handler(ctx, { repo, path }) {
      const r = await checkRepo(ctx, repo);
      const p = safePath(path);
      if (!p) throw new Error('path is required');
      const data = await gh(ctx, `/repos/${r}/contents/${p}`);
      if (Array.isArray(data) || data.type !== 'file') throw new Error('That path is a folder, not a file');
      if (!data.content) return { repo: r, path: data.path, size: data.size, note: 'File too large to read through the API.' };
      const buf = Buffer.from(data.content, 'base64');
      return { repo: r, path: data.path, size: data.size, truncated: buf.length > MAX_FILE_BYTES, content: buf.subarray(0, MAX_FILE_BYTES).toString('utf8') };
    },
  },
  {
    name: 'repo_search_code',
    description: 'Search code in one repository.',
    input_schema: { type: 'object', properties: { ...repoProp, query: { type: 'string' } }, required: ['repo', 'query'] },
    available,
    async handler(ctx, { repo, query }) {
      const r = await checkRepo(ctx, repo);
      const q = `${String(query || '').replace(/\brepo:\S+/gi, '').trim()} repo:${r}`;
      const data = await gh(ctx, `/search/code?per_page=20&q=${encodeURIComponent(q)}`);
      return { repo: r, total: data.total_count, results: (data.items || []).map((i) => ({ path: i.path, name: i.name })) };
    },
  },
  {
    name: 'repo_recent_commits',
    description: 'Recent commits in a repository.',
    input_schema: { type: 'object', properties: { ...repoProp, count: { type: 'integer' } }, required: ['repo'] },
    available,
    async handler(ctx, { repo, count }) {
      const r = await checkRepo(ctx, repo);
      const n = Math.min(Math.max(Number(count) || 10, 1), 30);
      const data = await gh(ctx, `/repos/${r}/commits?per_page=${n}`);
      return { repo: r, commits: data.map((c) => ({ sha: c.sha?.slice(0, 7), message: c.commit?.message?.split('\n')[0], author: c.commit?.author?.name, date: c.commit?.author?.date })) };
    },
  },
];
