// Chat service: history, key selection, approvals, usage. Used by the /api/chat route.
import { randomId } from '../crypto.js';
import { audit } from '../audit.js';
import { runAssistant } from './loop.js';
import { buildSystem } from './prompt.js';
import { selectApiKey } from './keys.js';
import { toolsForUser, executeTool, describeAction, getTool } from '../tools/registry.js';

const HISTORY_WINDOW = 20;
const APPROVAL_MINUTES = 30;
const YES = /^\s*(yes|yeah|yep|yup|approve|approved|do it|go ahead|confirm|confirmed|send it)\b[\s.!]*(please)?[\s.!]*$/i;
const NO = /^\s*(no|nope|cancel|cancelled|stop|don'?t|do not|never ?mind|abort)\b[\s.!]*$/i;

async function saveMessage(db, userId, role, content) {
  await db.query('INSERT INTO messages (user_id, role, content) VALUES ($1,$2,$3)', [userId, role, String(content || '').slice(0, 20000)]);
}

export async function history(db, userId, limit = 50) {
  const rows = await db.query('SELECT id, role, content, created_at FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [userId, limit]);
  return rows.reverse();
}

// Bounded window, starting with a user turn, consecutive same-role turns merged.
async function modelWindow(db, userId) {
  const rows = await history(db, userId, HISTORY_WINDOW);
  while (rows.length && rows[0].role !== 'user') rows.shift();
  const out = [];
  for (const r of rows) {
    if (out.length && out[out.length - 1].role === r.role) out[out.length - 1].content += `\n\n${r.content}`;
    else out.push({ role: r.role, content: r.content });
  }
  return out;
}

export async function pendingActions(db, userId) {
  await db.query("UPDATE pending_actions SET status = 'expired' WHERE user_id = $1 AND status = 'pending' AND expires_at < now()", [userId]);
  return db.query("SELECT id, tool, summary, created_at, expires_at FROM pending_actions WHERE user_id = $1 AND status = 'pending' ORDER BY created_at", [userId]);
}

function toolCtx(ctx, user) { return { ...ctx, user, cache: {} }; }

async function runModel(ctx, user, keyInfo, extraUserText) {
  const tctx = toolCtx(ctx, user);
  const tools = await toolsForUser(tctx);
  const facts = await ctx.db.query('SELECT id, fact FROM memory_facts WHERE user_id = $1 ORDER BY id', [user.id]);
  const messages = await modelWindow(ctx.db, user.id);
  if (extraUserText) {
    if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += `\n\n${extraUserText}`;
    else messages.push({ role: 'user', content: extraUserText });
  }
  const created = [];
  const result = await runAssistant({
    user, messages, tools, apiKey: keyInfo.apiKey, model: ctx.config.model,
    system: buildSystem(user, facts),
    createClient: ctx.createClient,
    executeTool: (name, input) => executeTool(tctx, name, input),
    requestApproval: async (toolUse, tool) => {
      const id = randomId(18);
      const summary = describeAction(tool, toolUse.input);
      await ctx.db.query(`INSERT INTO pending_actions (id, user_id, tool, input, summary, expires_at)
        VALUES ($1,$2,$3,$4,$5, now() + interval '${APPROVAL_MINUTES} minutes')`, [id, user.id, tool.name, JSON.stringify(toolUse.input || {}), summary]);
      await audit(ctx.db, user.id, tool.name, summary, 'pending approval');
      const p = { id, tool: tool.name, summary };
      created.push(p);
      return p;
    },
    onUsage: (u, model) => ctx.db.query(`INSERT INTO usage_log (user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, key_source)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [user.id, model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, keyInfo.source]),
  });
  return { text: result.text || '(no reply)', status: result.status, pending: created };
}

function aiErrorText(err) {
  const status = err?.status;
  if (status === 401) return 'The AI key was rejected. Ask the admin to check the key.';
  if (status === 429) return 'The AI service is busy or the key hit its limit. Try again shortly.';
  if (status === 404) return 'The AI model name is not recognized. Check ASSISTANT_MODEL.';
  return `The AI service had a problem${status ? ` (${status})` : ''}. Try again.`;
}

export async function handleChat(ctx, user, text) {
  const msg = String(text || '').trim().slice(0, 8000);
  if (!msg) return { reply: 'Say or type something.', pending: [] };

  // A typed/spoken yes/no answers the most recent pending approval. Only the user's own message can do this.
  const pend = await pendingActions(ctx.db, user.id);
  if (pend.length && (YES.test(msg) || NO.test(msg))) {
    const latest = pend[pend.length - 1];
    await saveMessage(ctx.db, user.id, 'user', msg);
    return YES.test(msg) ? approveAction(ctx, user, latest.id, { alreadySavedUserMessage: true }) : cancelAction(ctx, user, latest.id);
  }

  const keyInfo = selectApiKey(user, ctx.config, ctx.secrets);
  await saveMessage(ctx.db, user.id, 'user', msg);
  if (keyInfo.error) {
    await saveMessage(ctx.db, user.id, 'assistant', keyInfo.error);
    return { reply: keyInfo.error, pending: [], noKey: true };
  }
  let out;
  try {
    out = await runModel(ctx, user, keyInfo);
  } catch (err) {
    console.error('[chat] model error:', err?.status || '', err?.message);
    const reply = aiErrorText(err);
    await saveMessage(ctx.db, user.id, 'assistant', reply);
    return { reply, pending: [] };
  }
  await saveMessage(ctx.db, user.id, 'assistant', out.text);
  return { reply: out.text, pending: out.pending };
}

// Executes a pending action. Only callable for the action's own user (user_id is in the WHERE clause).
export async function approveAction(ctx, user, actionId, { alreadySavedUserMessage = false } = {}) {
  const row = await ctx.db.one(`UPDATE pending_actions SET status = 'approved'
    WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > now() RETURNING *`, [String(actionId), user.id]);
  if (!row) return { reply: 'That approval is no longer waiting (expired, already handled, or not yours).', pending: [], status: 404 };
  if (!alreadySavedUserMessage) await saveMessage(ctx.db, user.id, 'user', `Approve: ${row.summary}`);
  const input = typeof row.input === 'string' ? JSON.parse(row.input) : row.input;
  const r = await executeTool(toolCtx(ctx, user), row.tool, input, { approved: true });
  if (!r.ok) await ctx.db.query("UPDATE pending_actions SET status = 'failed' WHERE id = $1", [row.id]);

  const notice = `[App notice: the user APPROVED "${row.summary}". ${r.ok ? `It was executed. Result: ${JSON.stringify(r.result).slice(0, 4000)}` : `It FAILED: ${r.error}`}. Confirm to the user in one or two short sentences.]`;
  const keyInfo = selectApiKey(user, ctx.config, ctx.secrets);
  let reply = r.ok ? `Done: ${row.summary}.` : `That failed: ${r.error}`;
  let pending = [];
  if (!keyInfo.error) {
    try { const out = await runModel(ctx, user, keyInfo, notice); reply = out.text; pending = out.pending; } catch (err) { console.error('[approve] model error:', err?.message); }
  }
  await saveMessage(ctx.db, user.id, 'assistant', reply);
  return { reply, pending, executed: r.ok };
}

export async function cancelAction(ctx, user, actionId) {
  const row = await ctx.db.one(`UPDATE pending_actions SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`, [String(actionId), user.id]);
  if (!row) return { reply: 'Nothing to cancel.', pending: [], status: 404 };
  await audit(ctx.db, user.id, row.tool, row.summary, 'cancelled by user');
  const reply = `Okay, cancelled: ${row.summary}.`;
  await saveMessage(ctx.db, user.id, 'assistant', reply);
  return { reply, pending: [] };
}

export { getTool };
