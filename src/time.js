// Timezone helpers using Intl only (no deps).

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Offset in ms of `tz` at instant `date` (local - UTC).
function tzOffset(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-11-20T09:00" (wall-clock in tz) -> Date (UTC instant). Strings with Z or an offset are taken as-is.
export function zonedToUtc(local, tz) {
  const s = String(local || '').trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Bad date/time: ${s}`);
    return d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`Bad date/time (use YYYY-MM-DDTHH:MM): ${s}`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 9), +(m[5] || 0), +(m[6] || 0));
  let utc = guess - tzOffset(new Date(guess), tz);
  const off2 = tzOffset(new Date(utc), tz);
  utc = guess - off2;
  return new Date(utc);
}

export function formatInZone(date, tz, opts = {}) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...opts,
  }).format(date);
}

// Start/end (UTC Dates) of the calendar day containing `date` in tz.
export function dayBoundsInZone(date, tz) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const start = zonedToUtc(`${ymd}T00:00:00`, tz);
  const next = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + 1));
  const end = zonedToUtc(next.toISOString().slice(0, 10) + 'T00:00:00', tz);
  return { start, end, ymd };
}

// Wall-clock ISO-ish string (no offset) of an instant in tz, e.g. 2026-11-20T09:00
export function utcToZonedString(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
