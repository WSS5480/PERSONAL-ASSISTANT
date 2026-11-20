import { googleConnected, googleApi } from '../integrations/google.js';
import { zonedToUtc, isValidTimeZone } from '../time.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const available = (ctx) => googleConnected(ctx);
const tzOf = (u) => (isValidTimeZone(u.timezone) ? u.timezone : 'America/Chicago');
const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();

function header(msg, name) {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}
function plainBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const p of part.parts || []) { const t = plainBody(p); if (t) return t; }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}
export function buildRaw({ to, cc, subject, body }) {
  const lines = [`To: ${oneLine(to)}`];
  if (cc) lines.push(`Cc: ${oneLine(cc)}`);
  lines.push(`Subject: ${oneLine(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', '', String(body || ''));
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}
const emailSchema = {
  type: 'object',
  properties: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
  required: ['to', 'subject', 'body'],
};

export default [
  {
    name: 'gmail_search',
    description: 'Search Gmail with Gmail search syntax (e.g. "from:bob is:unread newer_than:2d"). Returns up to 10 messages with sender, subject, date, snippet.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' } }, required: ['query'] },
    available,
    async handler(ctx, { query, max }) {
      const n = Math.min(Math.max(Number(max) || 10, 1), 10);
      const list = await googleApi(ctx, `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(n) })}`);
      const msgs = await Promise.all((list.messages || []).map((m) =>
        googleApi(ctx, `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
      return { messages: msgs.map((m) => ({ id: m.id, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet })) };
    },
  },
  {
    name: 'gmail_read',
    description: 'Read one Gmail message by id (plain text body, truncated).',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    available,
    async handler(ctx, { id }) {
      const m = await googleApi(ctx, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
      return { id: m.id, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'), body: plainBody(m.payload).slice(0, 8000) };
    },
  },
  {
    name: 'gmail_create_draft',
    description: 'Create a Gmail draft (not sent).',
    input_schema: emailSchema,
    available,
    summarize: (i) => `Create a draft email to ${oneLine(i.to)} - subject "${oneLine(i.subject)}"`,
    async handler(ctx, input) {
      const d = await googleApi(ctx, `${GMAIL}/drafts`, { method: 'POST', body: { message: { raw: buildRaw(input) } } });
      return { draftId: d.id };
    },
  },
  {
    name: 'gmail_send',
    description: 'Send an email from the user\'s Gmail. Requires the user\'s approval (a card is shown).',
    input_schema: emailSchema,
    needsApproval: true,
    available,
    summarize: (i) => `Send an email to ${oneLine(i.to)}${i.cc ? ` (cc ${oneLine(i.cc)})` : ''} - subject "${oneLine(i.subject)}": ${String(i.body || '').slice(0, 3000)}${String(i.body || '').length > 3000 ? ' …[message continues]' : ''}`,
    async handler(ctx, input) {
      const m = await googleApi(ctx, `${GMAIL}/messages/send`, { method: 'POST', body: { raw: buildRaw(input) } });
      return { sent: true, id: m.id };
    },
  },
  {
    name: 'calendar_list_events',
    description: "List Google Calendar events. start/end are wall-clock times in the user's timezone (YYYY-MM-DDTHH:MM); default next 7 days.",
    input_schema: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } } },
    available,
    async handler(ctx, { start, end }) {
      const tz = tzOf(ctx.user);
      const min = start ? zonedToUtc(start, tz) : new Date();
      const max = end ? zonedToUtc(end, tz) : new Date(min.getTime() + 7 * 86400000);
      const q = new URLSearchParams({ timeMin: min.toISOString(), timeMax: max.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50', timeZone: tz });
      const data = await googleApi(ctx, `${CAL}/events?${q}`);
      return { events: (data.items || []).map((e) => ({ id: e.id, summary: e.summary || '', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || '' })) };
    },
  },
  {
    name: 'calendar_create_event',
    description: "Create a Google Calendar event (start/end wall-clock in the user's timezone, YYYY-MM-DDTHH:MM). Requires approval.",
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } },
      required: ['summary', 'start', 'end'],
    },
    needsApproval: true,
    available,
    summarize: (i) => `Add calendar event "${oneLine(i.summary)}" from ${i.start} to ${i.end}${i.location ? ` at ${oneLine(i.location)}` : ''}`,
    async handler(ctx, i) {
      const tz = tzOf(ctx.user);
      const body = {
        summary: i.summary, location: i.location, description: i.description,
        start: { dateTime: zonedToUtc(i.start, tz).toISOString(), timeZone: tz },
        end: { dateTime: zonedToUtc(i.end, tz).toISOString(), timeZone: tz },
      };
      const e = await googleApi(ctx, `${CAL}/events`, { method: 'POST', body });
      return { created: true, id: e.id, link: e.htmlLink };
    },
  },
  {
    name: 'calendar_delete_event',
    description: 'Delete a Google Calendar event by id. Requires approval.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string', description: 'event title, for the approval card' } }, required: ['id'] },
    needsApproval: true,
    available,
    summarize: (i) => `Delete calendar event ${i.summary ? `"${oneLine(i.summary)}" ` : ''}(id ${i.id})`,
    async handler(ctx, { id }) {
      await googleApi(ctx, `${CAL}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return { deleted: id };
    },
  },
];
