// Publishes the Domo Assistant app into the owner's Domo, using the owner's own Domo access token.
// It gathers the datasets behind every pro-code design that has a live card, wires them all into the
// assistant's manifest, generates datasets.js (name + which apps use each dataset), and uploads the files.
// Design endpoints (/api/apps/v1/designs...) are the ones Domo's own tools use; they were verified from a
// signed-in browser session on 2026-11-20. Token auth on them is MUST-VERIFY (first run reports each step).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'domo-assistant');
const DESIGN_NAME = 'Domo Assistant';
export const TEAM_DESIGN_NAME = 'Domo Assistant - Team';
const MAX_DATASETS = 100;
const TIMEOUT_MS = 30000;

const base = (instance) => `https://${instance}.domo.com`;

async function call(ctx, token, url, init = {}) {
  const res = await ctx.fetch(url, { ...init, headers: { 'X-DOMO-Developer-Token': token, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) { const e = new Error(`Domo ${res.status} on ${new URL(url).pathname}: ${(data && (data.message || data.error)) || text.slice(0, 160) || 'request failed'}`); e.status = res.status; throw e; }
  return data;
}
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// A 300x300 thumbnail (Domo requires one before a card can be created): blue tile with a white speech bubble.
export function thumbnailPng() {
  const W = 300; const raw = Buffer.alloc((W * 4 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const bubble = (x >= 55 && x <= 245 && y >= 70 && y <= 195) || (y > 195 && y <= 235 && x >= 95 && x <= 95 + (235 - y));
      const dot = [105, 150, 195].some((cx) => (x - cx) ** 2 + (y - 132) ** 2 <= 169);
      const c = bubble && !dot ? [255, 255, 255] : [31, 95, 191];
      const o = y * (W * 4 + 1) + 1 + x * 4; raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function makeAlias(name, used) {
  let a = String(name || 'DATASET').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'DATASET';
  if (/^[0-9]/.test(a)) a = `D_${a}`;
  let out = a; let i = 2;
  while (used.has(out)) out = `${a}_${i++}`;
  used.add(out); return out;
}

// Collects { dataSetId -> { apps:Set } } from every design with a live card (skipping the assistant itself).
export async function collectAppDatasets(ctx, token, designName = DESIGN_NAME) {
  const root = base(ctx.config.domoInstance);
  const listed = await call(ctx, token, `${root}/api/apps/v1/designs?limit=300&offset=0`);
  const designs = (Array.isArray(listed) ? listed : (listed?.designs || listed?.data || [])).filter((d) => !d.deletedDate);
  const named = (n) => designs.find((d) => (d.name || '').trim().toLowerCase() === n.toLowerCase());
  const assistant = named(designName);
  const skip = new Set([named(DESIGN_NAME)?.id, named(TEAM_DESIGN_NAME)?.id].filter(Boolean));
  const byDs = new Map(); let appsWithCards = 0; let failed = 0;
  const todo = designs.filter((d) => !skip.has(d.id));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const d = todo[next++];
      try {
        const j = await call(ctx, token, `${root}/api/apps/v1/designs/${d.id}?parts=versions,cards`);
        const cards = (j.referencingCards || []).filter((c) => c.active !== false);
        if (!cards.length) continue;
        appsWithCards++;
        const vs = j.versions || []; const v = vs.find((x) => x.version === j.latestVersion) || vs[vs.length - 1];
        for (const m of (v?.datasetsMapping || [])) {
          if (!m.dataSetId) continue;
          if (!byDs.has(m.dataSetId)) byDs.set(m.dataSetId, { id: m.dataSetId, apps: new Set() });
          byDs.get(m.dataSetId).apps.add(String(j.name || d.name || '').trim());
        }
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return { designs: designs.length, appsWithCards, failed, assistant, datasets: [...byDs.values()] };
}

// audience 'owner': every dataset behind the owner's apps, in the design only he uses.
// audience 'team': a separate design for all Domo users that includes ONLY datasets with PDP switched on,
// because a dataset without PDP would show every row to every person who can open the card.
export async function publishDomoAssistant(ctx, token, { audience = 'owner' } = {}) {
  const team = audience === 'team';
  const designName = team ? TEAM_DESIGN_NAME : DESIGN_NAME;
  const root = base(ctx.config.domoInstance);
  const steps = [];
  const found = await collectAppDatasets(ctx, token, designName);
  steps.push(`Looked at ${found.designs} app designs: ${found.appsWithCards} have live cards${found.failed ? `, ${found.failed} could not be read` : ''}.`);

  // Name each dataset; most-used first so the cap keeps the important ones.
  const ranked = found.datasets.sort((a, b) => b.apps.size - a.apps.size);
  const used = new Set(); const entries = [];
  let next = 0; const named = new Array(ranked.length);
  const worker = async () => {
    while (next < ranked.length) {
      const i = next++;
      try { const j = await call(ctx, token, `${root}/api/data/v3/datasources/${ranked[i].id}?part=core`); named[i] = { name: j?.name || '', rows: j?.rowCount ?? null, pdp: j?.pdpEnabled }; } catch { named[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  const leftOut = [];
  if (team && !named.some((n) => n && typeof n.pdp === 'boolean')) {
    throw new Error('Domo did not say which datasets have PDP switched on, so the team version was not published. Nothing was changed.');
  }
  for (let i = 0; i < ranked.length && entries.length < MAX_DATASETS; i++) {
    if (!named[i] || !named[i].name) continue; // not readable with this login -> leave it out
    if (team && named[i].pdp !== true) { leftOut.push({ name: named[i].name, description: `no PDP on this dataset — used by: ${[...ranked[i].apps].filter(Boolean).slice(0, 6).join(', ')}` }); continue; }
    const apps = [...ranked[i].apps].filter(Boolean).slice(0, 8);
    entries.push({ alias: makeAlias(named[i].name, used), dataSetId: ranked[i].id, name: named[i].name,
      description: `used by: ${apps.join(', ')}${named[i].rows != null ? ` (${named[i].rows} rows)` : ''}`.slice(0, 300) });
  }
  if (!entries.length) throw new Error(team ? `None of the ${leftOut.length} datasets behind your apps has PDP switched on, so there is nothing safe to give all users yet. Nothing was changed.` : 'No datasets were found behind your Domo apps with this Domo login. Nothing was changed.');
  steps.push(`Found ${found.datasets.length} datasets behind those apps; wiring ${entries.length} into the ${team ? 'team ' : ''}assistant${team ? ` (PDP-protected only; ${leftOut.length} left out)` : ''}.`);

  const read = (f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8');
  const manifest = JSON.parse(read('manifest.json'));
  manifest.datasetsMapping = entries.map((e) => ({ alias: e.alias, dataSetId: e.dataSetId, fields: [] }));
  manifest.name = designName;

  // Create the design the first time; otherwise update its version with the new dataset list.
  let designId = found.assistant?.id;
  if (!designId) {
    const created = await call(ctx, token, `${root}/api/apps/v1/designs`, json(manifest));
    designId = created.id; steps.push(`Created the "${designName}" app design.`);
  }
  manifest.id = designId;

  const datasetsJs = `/* GENERATED by My Assistant on ${new Date().toISOString().slice(0, 10)} from the datasets behind the owner's Domo apps. */\nwindow.DA_DATASETS = ${JSON.stringify(entries.map((e) => ({ alias: e.alias, name: e.name, description: e.description })), null, 1)};\n`;
  let appJs = read('app.js').replace('__DOMO_APP_KEY__', ctx.config.domoAppKey);
  if (ctx.config.appUrl) appJs = appJs.replace(/var SERVER = '[^']*';/, `var SERVER = '${ctx.config.appUrl.replace(/\/+$/, '')}';`);
  const files = [
    ['manifest.json', JSON.stringify(manifest, null, 2), 'application/json'], ['datasets.js', datasetsJs, 'application/javascript'],
    ['app.js', appJs, 'application/javascript'], ['app.css', read('app.css'), 'text/css'], ['index.html', read('index.html'), 'text/html'],
  ];
  const upload = async ([name, body, type]) => {
    const fd = new FormData(); fd.append('file', new Blob([body], { type }), name);
    await call(ctx, token, `${root}/api/apps/v1/designs/${designId}/versions/${manifest.version}/assets?path=${encodeURIComponent(name)}`, { method: 'POST', body: fd });
  };
  // The manifest goes first and is verified before anything else changes, so a refused dataset list
  // leaves the working app exactly as it was.
  await upload(files[0]);

  // Confirm Domo now shows the new dataset list on the app. Uploading manifest.json is how Domo's own editor
  // saves the list; if that did not take, try updating the design directly. Never report success unverified.
  const wired = async () => {
    const j = await call(ctx, token, `${root}/api/apps/v1/designs/${designId}?parts=versions`);
    const vs = j.versions || []; const v = vs.find((x) => x.version === manifest.version) || vs[vs.length - 1];
    return new Set((v?.datasetsMapping || []).map((m) => m.dataSetId));
  };
  const want = entries.map((e) => e.dataSetId);
  let have = await wired();
  if (!want.every((id) => have.has(id))) {
    let detail = '';
    try { await call(ctx, token, `${root}/api/apps/v1/designs/${designId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest) }); } catch (e) { detail = e.message; }
    have = await wired();
    if (!want.every((id) => have.has(id))) {
      throw new Error(`Domo did not accept the new dataset list: it still shows ${have.size} of ${want.length} datasets connected to the app.${detail ? ` Direct update said: ${detail}.` : ''} The assistant in Domo was left as it was.`);
    }
  }
  steps.push(`Domo confirms ${want.length} datasets are connected.`);
  for (const f of files.slice(1)) await upload(f);
  if (!found.assistant) await upload(['thumbnail.png', thumbnailPng(), 'image/png']);
  steps.push(`Uploaded ${files.length} files.`);
  return { designId, audience, designUrl: `${root}/assetlibrary/${designId}`, datasets: entries.map((e) => ({ name: e.name, description: e.description })), leftOut, steps, created: !found.assistant };
}
