// Per-user audit log of tool executions. Summaries must never contain secrets.
export async function audit(db, userId, tool, summary, outcome, approved = false) {
  await db.query('INSERT INTO audit_log (user_id, tool, summary, outcome, approved) VALUES ($1,$2,$3,$4,$5)',
    [userId, tool, String(summary || '').slice(0, 600), String(outcome).slice(0, 300), !!approved]);
}

export function summarizeInput(input) {
  try {
    const s = JSON.stringify(input ?? {}, (k, v) => (/token|key|secret|password/i.test(k) ? '[hidden]' : v));
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch { return ''; }
}
