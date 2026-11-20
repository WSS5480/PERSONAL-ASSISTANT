// One query interface over real Postgres (DATABASE_URL) or embedded PGlite (local dev / tests).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations.sql');

export async function createDb({ databaseUrl, pgliteDir } = {}) {
  let db;
  if (databaseUrl) {
    const pg = (await import('pg')).default;
    const ssl = /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl, max: 5 });
    db = {
      kind: 'postgres',
      async query(sql, params = []) { return (await pool.query(sql, params)).rows; },
      async exec(sql) { await pool.query(sql); },
      async close() { await pool.end(); },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = pgliteDir ? new PGlite(pgliteDir) : new PGlite();
    db = {
      kind: 'pglite',
      async query(sql, params = []) { return (await lite.query(sql, params)).rows; },
      async exec(sql) { await lite.exec(sql); },
      async close() { await lite.close(); },
    };
  }
  db.one = async (sql, params) => (await db.query(sql, params))[0] || null;
  await db.exec(fs.readFileSync(MIGRATIONS, 'utf8'));
  return db;
}
