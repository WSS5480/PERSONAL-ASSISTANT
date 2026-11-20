// The agentic tool loop. Deliberately independent of Express, cookies and the DB so it can be
// reused (e.g. by the planned Domo Assistant). Inputs in, results out.
//
// runAssistant({ user, messages, tools, apiKey, ... }) ->
//   { status: 'done' | 'needs_client' | 'capped', text, messages, pendingApprovals, clientCalls, usage }
//
// - tools: registry tool definitions (see src/tools/registry.js).
// - needsApproval tools are NEVER executed here: requestApproval(toolUse, tool) records a pending action
//   and the model is told it is waiting for the user.
// - execution: 'client' tools pause the loop: status 'needs_client' with clientCalls; the caller later
//   appends { role:'user', content:[tool_result...] } to `messages` and calls runAssistant again.
import Anthropic from '@anthropic-ai/sdk';
import { toApiTools } from '../tools/registry.js';

export const defaultCreateClient = (apiKey) => new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 });
const MAX_RESULT_CHARS = 16_000;

const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

function resultContent(r) {
  let s = typeof r === 'string' ? r : JSON.stringify(r);
  if (s.length > MAX_RESULT_CHARS) s = s.slice(0, MAX_RESULT_CHARS) + '…[truncated]';
  return s;
}

export async function runAssistant({
  user, messages, tools, apiKey, model, system,
  createClient = defaultCreateClient, executeTool, requestApproval,
  maxIterations = 8, maxTokens = 1500, onUsage,
}) {
  if (!apiKey) throw new Error('runAssistant: apiKey is required');
  const client = createClient(apiKey);
  const apiTools = toApiTools(tools);
  if (apiTools.length) apiTools[apiTools.length - 1] = { ...apiTools[apiTools.length - 1], cache_control: { type: 'ephemeral' } };
  const systemBlocks = typeof system === 'string'
    ? [{ type: 'text', text: system }]
    : [{ type: 'text', text: system.static, cache_control: { type: 'ephemeral' } }, { type: 'text', text: system.dynamic }];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const convo = [...messages];
  const pendingApprovals = [];
  const usage = [];
  let lastText = '';

  for (let i = 0; i < maxIterations; i++) {
    const resp = await client.messages.create({
      model, max_tokens: maxTokens, system: systemBlocks, messages: convo,
      ...(apiTools.length ? { tools: apiTools } : {}),
    });
    if (resp.usage) { usage.push(resp.usage); await onUsage?.(resp.usage, resp.model || model); }
    convo.push({ role: 'assistant', content: resp.content });
    lastText = textOf(resp.content) || lastText;
    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
      return { status: 'done', text: textOf(resp.content), messages: convo, pendingApprovals, clientCalls: [], usage };
    }

    const results = [];
    const clientCalls = [];
    for (const tu of toolUses) {
      const tool = byName.get(tu.name);
      if (tool?.execution === 'client') { clientCalls.push(tu); continue; }
      if (tool?.needsApproval) {
        const pending = await requestApproval(tu, tool);
        pendingApprovals.push(pending);
        results.push({
          type: 'tool_result', tool_use_id: tu.id,
          content: `NOT DONE YET. Waiting for the user's approval. They see a card: "${pending.summary}" with Approve / Cancel. Tell them briefly what needs approval; do not say it is done.`,
        });
        continue;
      }
      // Unknown/unentitled tools still go through executeTool so the denial is enforced and audited.
      const r = await executeTool(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: resultContent(r.ok ? r.result : { error: r.error }), ...(r.ok ? {} : { is_error: true }) });
    }
    if (clientCalls.length) {
      return { status: 'needs_client', text: lastText, messages: convo, pendingApprovals, clientCalls, partialResults: results, usage };
    }
    convo.push({ role: 'user', content: results });
  }
  return {
    status: 'capped', messages: convo, pendingApprovals, clientCalls: [], usage,
    text: `${lastText ? lastText + '\n\n' : ''}I stopped after ${maxIterations} steps. Tell me how you'd like to continue.`,
  };
}
