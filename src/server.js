import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: process.env.PGLITE_DIR || (config.databaseUrl ? undefined : './.pglite-data') });
const { app } = createApp({ db, config });
app.listen(config.port, () => {
  console.log(`My Assistant listening on :${config.port} (db: ${db.kind}, model: ${config.model})`);
  const missing = ['ANTHROPIC_API_KEY', 'APP_URL'].filter((k) => !process.env[k]);
  if (missing.length) console.warn(`[config] not set: ${missing.join(', ')} (app still runs)`);
});
