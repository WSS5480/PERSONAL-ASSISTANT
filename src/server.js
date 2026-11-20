import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
// In production the embedded dev database must never be used: its data is wiped on every deploy
// and it does not fit in a small instance's memory. Fail fast with a clear message instead.
if (config.production && !config.databaseUrl) {
  console.error('[config] DATABASE_URL is not set. Add DATABASE_URL (the Internal Database URL of my-assistant-db) in the Render environment settings.');
  process.exit(1);
}
const db = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: process.env.PGLITE_DIR || (config.databaseUrl ? undefined : './.pglite-data') });
const { app } = createApp({ db, config });
app.listen(config.port, () => {
  console.log(`My Assistant listening on :${config.port} (db: ${db.kind}, model: ${config.model})`);
  const missing = ['ANTHROPIC_API_KEY', 'APP_URL'].filter((k) => !process.env[k]);
  if (missing.length) console.warn(`[config] not set: ${missing.join(', ')} (app still runs)`);
});
