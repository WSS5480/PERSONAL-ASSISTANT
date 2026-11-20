// Tool registry. Each module exports an array of tool definitions:
//   { name, description, input_schema, needsApproval, available(ctx) -> bool, handler(ctx, input) -> result,
//     summarize?(input) -> string shown on approval cards / audit, execution?: 'server' | 'client' }
// To add a tool: write a module in src/tools/, add it to MODULES below. Nothing else to wire.
// `execution: 'client'` is reserved for the planned Domo Assistant (tool runs in the user's browser);
// the loop already supports pausing on such tools (see src/ai/loop.js).
import { audit, summarizeInput } from '../audit.js';
import memory from './memory.js';
import todos from './todos.js';
import reminders from './reminders.js';
import notes from './notes.js';
import google from './google.js';
import domo from './domo.js';
import repos from './repos.js';
import render from './render.js';

export const MODULES = [memory, todos, reminders, notes, google, domo, repos, render];
export const ALL_TOOLS = MODULES.flat();
const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export const getTool = (name) => BY_NAME.get(name) || null;

async function isAvailable(ctx, tool) {
  try { return !!(await tool.available(ctx)); } catch { return false; }
}

// Tools offered to the model for this user (role, grants and configuration decide).
export async function toolsForUser(ctx) {
  const out = [];
  for (const t of ALL_TOOLS) if (await isAvailable(ctx, t)) out.push(t);
  return out;
}

// Anthropic API tool definitions.
export const toApiTools = (tools) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

export const describeAction = (tool, input) => (tool.summarize ? tool.summarize(input) : `${tool.name} ${summarizeInput(input)}`);

// Executes a tool for ctx.user. Re-applies the availability check - a tool the user is not
// entitled to fails even if the model names it. Approval tools never run unless approved=true,
// which only the approval endpoint (driven by the user) sets.
export async function executeTool(ctx, name, input, { approved = false } = {}) {
  const tool = getTool(name);
  if (!tool || !(await isAvailable(ctx, tool))) {
    await audit(ctx.db, ctx.user.id, name, summarizeInput(input), 'denied: not available to this user');
    return { ok: false, error: `Tool ${name} is not available to you.` };
  }
  if (tool.needsApproval && !approved) {
    return { ok: false, error: 'This action needs the user\'s approval first.' };
  }
  try {
    const result = await tool.handler(ctx, input || {});
    const summary = result && typeof result === 'object' && result._audit ? result._audit : describeAction(tool, input);
    if (result && typeof result === 'object') delete result._audit;
    await audit(ctx.db, ctx.user.id, name, summary, 'ok', approved);
    return { ok: true, result };
  } catch (err) {
    await audit(ctx.db, ctx.user.id, name, describeAction(tool, input), `error: ${err.message}`, approved);
    return { ok: false, error: err.message };
  }
}
