// Render tools - OWNER ONLY (checked when offering AND when executing, via available()).
import { render, servicesWithStatus } from '../integrations/render.js';

const available = (ctx) => ctx.user.role === 'owner' && !!ctx.config.renderApiKey;
const idProp = { service_id: { type: 'string', description: 'Render service id (srv-...)' } };

export default [
  {
    name: 'render_list_workspaces',
    description: 'List Render workspaces.',
    input_schema: { type: 'object', properties: {} },
    available,
    async handler(ctx) { return { workspaces: await render.workspaces(ctx) }; },
  },
  {
    name: 'render_list_services',
    description: 'List all Render services across workspaces with status, URL and last deploy state.',
    input_schema: { type: 'object', properties: {} },
    available,
    async handler(ctx) {
      const services = await servicesWithStatus(ctx);
      return { count: services.length, failing: services.filter((s) => s.failing).length, services };
    },
  },
  {
    name: 'render_service_status',
    description: 'Details of one Render service.',
    input_schema: { type: 'object', properties: idProp, required: ['service_id'] },
    available,
    async handler(ctx, { service_id }) {
      const s = await render.service(ctx, service_id);
      return { id: s.id, name: s.name, type: s.type, suspended: s.suspended, url: s.serviceDetails?.url, branch: s.branch, repo: s.repo, updatedAt: s.updatedAt };
    },
  },
  {
    name: 'render_recent_deploys',
    description: 'Recent deploys of a Render service.',
    input_schema: { type: 'object', properties: idProp, required: ['service_id'] },
    available,
    async handler(ctx, { service_id }) {
      const d = await render.deploys(ctx, service_id, 10);
      return { deploys: d.map((x) => ({ id: x.id, status: x.status, createdAt: x.createdAt, finishedAt: x.finishedAt, commit: x.commit?.message?.split('\n')[0] })) };
    },
  },
  {
    name: 'render_logs',
    description: 'Recent log lines of a Render service (max 100).',
    input_schema: { type: 'object', properties: { ...idProp, lines: { type: 'integer' } }, required: ['service_id'] },
    available,
    async handler(ctx, { service_id, lines }) {
      const s = await render.service(ctx, service_id);
      return { logs: await render.logs(ctx, s.ownerId, service_id, Math.min(Math.max(Number(lines) || 50, 1), 100)) };
    },
  },
  {
    name: 'render_trigger_deploy',
    description: 'Start a new deploy of a Render service. Requires approval.',
    input_schema: { type: 'object', properties: { ...idProp, service_name: { type: 'string' } }, required: ['service_id'] },
    needsApproval: true,
    available,
    summarize: (i) => `Start a new deploy of Render service ${i.service_name ? `"${i.service_name}" ` : ''}(${i.service_id})`,
    async handler(ctx, { service_id }) { const d = await render.triggerDeploy(ctx, service_id); return { started: true, deployId: d.id, status: d.status }; },
  },
  {
    name: 'render_restart_service',
    description: 'Restart a Render service. Requires approval.',
    input_schema: { type: 'object', properties: { ...idProp, service_name: { type: 'string' } }, required: ['service_id'] },
    needsApproval: true,
    available,
    summarize: (i) => `Restart Render service ${i.service_name ? `"${i.service_name}" ` : ''}(${i.service_id})`,
    async handler(ctx, { service_id }) { await render.restart(ctx, service_id); return { restarted: true }; },
  },
];
