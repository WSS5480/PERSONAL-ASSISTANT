// GitHub REST (read-only) with the owner's GITHUB_TOKEN. Server-side only.
const API = 'https://api.github.com';
export const MAX_FILE_BYTES = 100_000;

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function normalizeRepo(repo) {
  const r = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').toLowerCase();
  if (!REPO_RE.test(r) || r.split('/').some((p) => p === '.' || p === '..')) throw new Error(`Invalid repository name: ${repo}`);
  return r;
}

export function safePath(p) {
  const s = String(p ?? '').trim();
  if (s.includes('\0') || s.includes('\\')) throw new Error('Invalid path');
  const parts = s.split('/').filter((x) => x !== '' && x !== '.');
  if (parts.some((x) => x === '..' || /%2e%2e|%2f/i.test(x))) throw new Error('Path traversal is not allowed');
  return parts.map(encodeURIComponent).join('/');
}

export async function gh(ctx, path) {
  const res = await ctx.fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${ctx.config.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'my-assistant' },
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data.message || 'request failed'}`);
  return data;
}

export async function listTokenRepos(ctx) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(ctx, `/user/repos?per_page=100&sort=pushed&page=${page}`);
    out.push(...batch.map((r) => ({ repo: r.full_name.toLowerCase(), private: r.private, pushedAt: r.pushed_at, description: r.description || '' })));
    if (batch.length < 100) break;
  }
  return out;
}
