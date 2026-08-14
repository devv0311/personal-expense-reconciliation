/**
 * Database connection.
 *
 * Two drivers, one schema, one `Database` type:
 *
 *  - **node-postgres**, for a real PostgreSQL server (development, CI, production).
 *  - **PGlite**, PostgreSQL compiled to WebAssembly and run in-process, so the integration
 *    suite can execute a genuine Postgres engine — real `CHECK` constraints, real foreign
 *    keys, real partial unique indexes — on a machine with no Docker and no local server.
 *    See `docs/decisions/0017-integration-test-database.md`.
 *
 * Both are wired so `bigint` columns arrive as JavaScript `bigint`, never `number`. That is
 * not a nicety: paise amounts above 2^53 would silently lose precision through a `number`,
 * which is exactly the class of bug `invariants.md` #12 exists to prevent.
 */

import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';

import * as schema from './schema.js';

/**
 * The database handle every repository and service takes.
 *
 * Typed as the shared `PgDatabase` base rather than a specific driver's class, so nothing
 * above `src/db` can accidentally depend on which driver is in use.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A connected database plus the means to release it. */
export interface DatabaseHandle {
  readonly db: Database;
  readonly close: () => Promise<void>;
  /** Applies every migration in `drizzle/`, in order. */
  readonly migrate: () => Promise<void>;
}

/** Where the checked-in migrations live, relative to the repository root. */
export const MIGRATIONS_FOLDER = 'drizzle';

/**
 * PostgreSQL's `int8` type OID. node-postgres already returns it as a string; PGlite
 * returns a `number` unless told otherwise, so it is overridden below.
 */
const PG_INT8_OID = 20;

/** Connects to a real PostgreSQL server. */
export async function createPostgresDatabase(connectionString: string): Promise<DatabaseHandle> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });
  const db = drizzleNodePg(pool, { schema }) as unknown as Database;

  return {
    db,
    close: async () => {
      await pool.end();
    },
    migrate: async () => {
      await migrateNodePg(drizzleNodePg(pool, { schema }), {
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    },
  };
}

/**
 * Starts an in-process PostgreSQL (PGlite).
 *
 * `dataDir` defaults to an in-memory database, which is what the test suite wants: fresh
 * engine per suite, nothing left on disk.
 */
export async function createPgliteDatabase(dataDir?: string): Promise<DatabaseHandle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const client = new PGlite(dataDir, {
    // Keep int8 exact. Without this, PGlite hands back a JavaScript number and a paise
    // amount above 2^53 would come back subtly wrong rather than loudly wrong.
    parsers: { [PG_INT8_OID]: (value: string) => value },
    serializers: { [PG_INT8_OID]: (value: unknown) => String(value) },
  });
  const drizzled = drizzlePglite(client, { schema });

  return {
    db: drizzled as unknown as Database,
    close: async () => {
      await client.close();
    },
    migrate: async () => {
      await migratePglite(drizzled, { migrationsFolder: MIGRATIONS_FOLDER });
    },
  };
}

/**
 * Opens whichever database the environment provides.
 *
 * A `connectionString` (from `DATABASE_URL`, or `TEST_DATABASE_URL` in the suite) selects a
 * real server; its absence falls back to PGlite. The fallback exists so financial
 * persistence behaviour is always tested against a real Postgres engine somewhere, rather
 * than being skipped on a machine that happens to have no server installed.
 */
export async function openDatabase(connectionString?: string): Promise<DatabaseHandle> {
  return connectionString !== undefined && connectionString !== ''
    ? createPostgresDatabase(connectionString)
    : createPgliteDatabase();
}

export { schema };
