// Publishes the Domo Assistant app into the owner's Domo, using the owner's own Domo access token.
// It gathers the datasets behind every pro-code design that has a live card, wires them all into the
// assistant's manifest, generates datasets.js (name + which apps use each dataset), and uploads the files.
// Design endpoints (/api/apps/v1/designs...) are the ones Domo's own tools use; they were verified from a
// signed-in browser session on 2026-11-20. Token auth on them is MUST-VERIFY (first run reports each step).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'domo-assistant');
const DESIGN_NAME = 'Domo Assistant';
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

export function makeAlias(name, used) {
  let a = String(name || 'DATASET').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'DATASET';
  if (/^[0-9]/.test(a)) a = `D_${a}`;
  let out = a; let i = 2;
  while (used.has(out)) out = `${a}_${i++}`;
  used.add(out); return out;
}

// Collects { dataSetId -> { apps:Set } } from every design with a live card (skipping the assistant itself).
export async function collectAppDatasets(ctx, token) {
  const root = base(ctx.config.domoInstance);
  const listed = await call(ctx, token, `${root}/api/apps/v1/designs?limit=300&offset=0`);
  const designs = (Array.isArray(listed) ? listed : (listed?.designs || listed?.data || [])).filter((d) => !d.deletedDate);
  const assistant = designs.find((d) => (d.name || '').trim().toLowerCase() === DESIGN_NAME.toLowerCase());
  const byDs = new Map(); let appsWithCards = 0; let failed = 0;
  const todo = designs.filter((d) => d.id !== assistant?.id);
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

export async function publishDomoAssistant(ctx, token) {
  const root = base(ctx.config.domoInstance);
  const steps = [];
  const found = await collectAppDatasets(ctx, token);
  steps.push(`Looked at ${found.designs} app designs: ${found.appsWithCards} have live cards${found.failed ? `, ${found.failed} could not be read` : ''}.`);

  // Name each dataset; most-used first so the cap keeps the important ones.
  const ranked = found.datasets.sort((a, b) => b.apps.size - a.apps.size);
  const used = new Set(); const entries = [];
  let next = 0; const named = new Array(ranked.length);
  const worker = async () => {
    while (next < ranked.length) {
      const i = next++;
      try { const j = await call(ctx, token, `${root}/api/data/v3/datasources/${ranked[i].id}?part=core`); named[i] = { name: j?.name || '', rows: j?.rowCount ?? null }; } catch { named[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  for (let i = 0; i < ranked.length && entries.length < MAX_DATASETS; i++) {
    if (!named[i] || !named[i].name) continue; // not readable with this login -> leave it out
    const apps = [...ranked[i].apps].filter(Boolean).slice(0, 8);
    entries.push({ alias: makeAlias(named[i].name, used), dataSetId: ranked[i].id, name: named[i].name,
      description: `used by: ${apps.join(', ')}${named[i].rows != null ? ` (${named[i].rows} rows)` : ''}`.slice(0, 300) });
  }
  if (!entries.length) throw new Error('No datasets were found behind your Domo apps with this Domo login. Nothing was changed.');
  steps.push(`Found ${found.datasets.length} datasets behind those apps; wiring ${entries.length} into the assistant.`);

  const read = (f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8');
  const manifest = JSON.parse(read('manifest.json'));
  manifest.datasetsMapping = entries.map((e) => ({ alias: e.alias, dataSetId: e.dataSetId, fields: [] }));

  // Create the design the first time; otherwise update its version with the new dataset list.
  let designId = found.assistant?.id;
  if (!designId) {
    const created = await call(ctx, token, `${root}/api/apps/v1/designs`, json(manifest));
    designId = created.id; steps.push('Created the Domo Assistant app design.');
  } else {
    manifest.id = designId;
    try {
      await call(ctx, token, `${root}/api/apps/v1/designs/${designId}/versions`, json(manifest));
      steps.push('Updated the app version with the new dataset list.');
    } catch (e1) {
      try {
        await call(ctx, token, `${root}/api/apps/v1/designs/${designId}/versions/${manifest.version}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest) });
        steps.push('Updated the app version with the new dataset list.');
      } catch (e2) { throw new Error(`Could not update the app's dataset list in Domo. ${e1.message} / ${e2.message}. Nothing else was changed.`); }
    }
  }
  manifest.id = designId;

  const datasetsJs = `/* GENERATED by My Assistant on ${new Date().toISOString().slice(0, 10)} from the datasets behind the owner's Domo apps. */\nwindow.DA_DATASETS = ${JSON.stringify(entries.map((e) => ({ alias: e.alias, name: e.name, description: e.description })), null, 1)};\n`;
  let appJs = read('app.js').replace('__DOMO_APP_KEY__', ctx.config.domoAppKey);
  if (ctx.config.appUrl) appJs = appJs.replace(/var SERVER = '[^']*';/, `var SERVER = '${ctx.config.appUrl.replace(/\/+$/, '')}';`);
  const files = [
    ['manifest.json', JSON.stringify(manifest, null, 2), 'application/json'], ['datasets.js', datasetsJs, 'application/javascript'],
    ['app.js', appJs, 'application/javascript'], ['app.css', read('app.css'), 'text/css'], ['index.html', read('index.html'), 'text/html'],
  ];
  for (const [name, body, type] of files) {
    const fd = new FormData(); fd.append('file', new Blob([body], { type }), name);
    await call(ctx, token, `${root}/api/apps/v1/designs/${designId}/versions/${manifest.version}/assets?path=${encodeURIComponent(name)}`, { method: 'POST', body: fd });
  }
  steps.push(`Uploaded ${files.length} files.`);
  return { designId, datasets: entries.map((e) => ({ name: e.name, description: e.description })), steps, created: !found.assistant };
}
