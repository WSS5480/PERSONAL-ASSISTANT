// Render REST API. NOT verified against the live API yet (see HANDOFF MUST-VERIFY). All paths live here.
const API = 'https://api.render.com/v1';

async function call(ctx, method, path) {
  const res = await ctx.fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.config.renderApiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`Render ${res.status}: ${data.message || 'request failed'}`);
  return data;
}

const unwrap = (items, key) => (Array.isArray(items) ? items.map((x) => x?.[key] ?? x) : []);

export const render = {
  async workspaces(ctx) {
    return unwrap(await call(ctx, 'GET', '/owners?limit=100'), 'owner').map((o) => ({ id: o.id, name: o.name, type: o.type }));
  },
  async services(ctx) {
    const out = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const page = await call(ctx, 'GET', `/services?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(page) || !page.length) break;
      out.push(...unwrap(page, 'service'));
      cursor = page[page.length - 1]?.cursor;
      if (!cursor || page.length < 100) break;
    }
    return out;
  },
  service: (ctx, id) => call(ctx, 'GET', `/services/${encodeURIComponent(id)}`),
  async deploys(ctx, id, limit = 5) {
    return unwrap(await call(ctx, 'GET', `/services/${encodeURIComponent(id)}/deploys?limit=${limit}`), 'deploy');
  },
  async logs(ctx, ownerId, serviceId, limit = 50) {
    const q = new URLSearchParams({ ownerId, resource: serviceId, limit: String(limit), direction: 'backward' });
    const data = await call(ctx, 'GET', `/logs?${q}`);
    return (data.logs || []).map((l) => ({ time: l.timestamp, message: String(l.message || '').slice(0, 500) }));
  },
  triggerDeploy: (ctx, id) => call(ctx, 'POST', `/services/${encodeURIComponent(id)}/deploys`),
  restart: (ctx, id) => call(ctx, 'POST', `/services/${encodeURIComponent(id)}/restart`),
};

export const serviceUrl = (s) => s.serviceDetails?.url || (s.slug ? `https://${s.slug}.onrender.com` : '');
export const isFailing = (s, lastDeploy) => !!lastDeploy && /failed|canceled/i.test(lastDeploy.status || '');

// Services with their latest deploy (one extra call per service, run in parallel).
export async function servicesWithStatus(ctx) {
  const services = await render.services(ctx);
  return Promise.all(services.slice(0, 60).map(async (s) => {
    let last = null;
    try { [last] = await render.deploys(ctx, s.id, 1); } catch { /* keep null */ }
    return {
      id: s.id, name: s.name, type: s.type, ownerId: s.ownerId, url: serviceUrl(s),
      suspended: s.suspended === 'suspended', updatedAt: s.updatedAt,
      lastDeploy: last ? { id: last.id, status: last.status, finishedAt: last.finishedAt, commit: last.commit?.message?.split('\n')[0]?.slice(0, 120) || '' } : null,
      failing: isFailing(s, last),
    };
  }));
}
