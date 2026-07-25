// Minimal dual-driver database layer.
//
//   DATABASE_URL set   -> node-postgres Pool  (production / Neon)
//   DATABASE_URL unset -> @electric-sql/pglite (embedded Postgres, .data/pglite)
//
// The same standard-Postgres SQL runs on both. This is a deliberate, documented
// deviation from the "DATABASE_URL is always set" assumption in the spec so the
// app runs with zero signup locally while production still uses real Postgres.
// See DECISIONS.md.

import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..'); // ghostbus/
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

export type Params = ReadonlyArray<unknown>;
export interface Result<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: Params): Promise<Result<T>>;
}
export interface Db extends Queryable {
  driver: 'pg' | 'pglite';
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** True once close() has been called. Long-running background work (the pattern
   *  index takes ~109 s over Neon) polls this so it can abort quietly on shutdown
   *  instead of throwing "Cannot use a pool after calling end on the pool". */
  readonly closed: boolean;
}

/** Thrown by query() after close(). Distinguishable from a real database failure so
 *  callers can treat a shutdown as a benign abort rather than an error worth logging. */
export class DbClosedError extends Error {
  constructor() {
    super('database closed');
    this.name = 'DbClosedError';
  }
}
export const isDbClosed = (e: unknown): boolean =>
  e instanceof DbClosedError || (e instanceof Error && /pool after calling end/i.test(e.message));

let envLoaded = false;
function loadEnvOnce(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    try {
      // Node 20.12+/22+/24 built-in; no dotenv dependency needed.
      const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
      if (loader) loader(envPath);
    } catch {
      /* malformed .env is non-fatal; fall through to whatever is in process.env */
    }
  }
}

function makePg(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 4, // Neon free tier: keep the pool small.
  });
  let closed = false;
  const wrap = (c: pg.PoolClient | pg.Pool): Queryable => ({
    async query(sql, params) {
      if (closed) throw new DbClosedError();
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
  });
  return {
    driver: 'pg',
    get closed() { return closed; },
    query: wrap(pool).query,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* connection already dead */ }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      // Flip the flag BEFORE ending the pool so in-flight background work (the pattern
      // index) sees the shutdown on its next page and aborts quietly.
      closed = true;
      await pool.end();
    },
  };
}

async function makePglite(): Promise<Db> {
  const dataDir = process.env.PGLITE_DIR ?? join(ROOT, '.data', 'pglite');
  await mkdir(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  await client.waitReady;
  // PGlite reports affectedRows for writes but 0 for SELECTs; take the max so read
  // queries report rows.length (matching pg) and writes report the affected count.
  const norm = (r: { rows: unknown[]; affectedRows?: number }): Result => ({
    rows: r.rows as Record<string, unknown>[],
    rowCount: Math.max(r.affectedRows ?? 0, r.rows.length),
  });
  let closed = false;
  return {
    driver: 'pglite',
    get closed() { return closed; },
    async query(sql, params) {
      if (closed) throw new DbClosedError();
      return norm(await client.query(sql, params as unknown[])) as Result<never>;
    },
    async transaction(fn) {
      return await client.transaction(async (tx) => {
        return await fn({
          async query(sql, params) {
            return norm(await tx.query(sql, params as unknown[])) as Result<never>;
          },
        });
      });
    },
    async close() {
      closed = true; // see the pg branch: background work polls this to abort quietly
      await client.close();
    },
  };
}

// Split a migration script into individual statements. The migration files are
// authored to keep this safe: no semicolons inside string literals, and line
// comments are stripped first.
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigrations(db: Db): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  // Enforce NNN_name.sql so lexicographic sort can never silently misorder migrations.
  const bad = files.find((f) => !/^\d{3}_.+\.sql$/.test(f));
  if (bad) throw new Error(`migration filename violates NNN_name.sql convention: ${bad}`);
  const applied = new Set(
    (await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const statements = splitStatements(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.transaction(async (tx) => {
      for (const stmt of statements) await tx.query(stmt);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    console.log(`[migrate] applied ${file} (${statements.length} statements)`);
  }
}

let dbPromise: Promise<Db> | null = null;

/** Get the shared Db, running migrations on first call. */
export function getDb(): Promise<Db> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    loadEnvOnce();
    const url = process.env.DATABASE_URL;
    const db = url ? makePg(url) : await makePglite();
    await runMigrations(db);
    return db;
  })();
  return dbPromise;
}
