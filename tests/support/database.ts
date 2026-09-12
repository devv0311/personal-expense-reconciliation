/**
 * The integration-test database harness.
 *
 * `docs/testing/testing-strategy.md` requires integration tests against a real PostgreSQL
 * instance, not mocks, for financial persistence behaviour. This provides one either way:
 *
 *  - Set `TEST_DATABASE_URL` and the suite runs against that server. CI does this with a
 *    Postgres service container, so the canonical run is against stock PostgreSQL.
 *  - Leave it unset and the suite runs against PGlite — the same PostgreSQL engine compiled
 *    to WebAssembly, in-process. Real constraints, real foreign keys, real partial unique
 *    indexes; no Docker, no server install.
 *
 * The point of the fallback is that these tests always actually execute. A suite that is
 * silently skipped on the developer's machine is worse than no suite, because it reads as
 * coverage it is not providing. See `docs/decisions/0017-integration-test-database.md`.
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { openDatabase } from '../../src/db/client.js';
import type { Database, DatabaseHandle } from '../../src/db/client.js';

/** Every table the migration creates, in an order safe to truncate together. */
const ALL_TABLES = [
  'audit_events',
  'proof_pack_deliveries',
  'account_balance_readings',
  'account_provider_links',
  'jobs',
  'sessions',
  'splitwise_remote_changes',
  'splitwise_remote_reads',
  'splitwise_audit_findings',
  'splitwise_audit_runs',
  'reconciliation_account_snapshots',
  'reconciliation_runs',
  'splitwise_settlements',
  'splitwise_expenses',
  'external_integrations',
  'rules',
  'ai_inferences',
  'expense_adjustment_items',
  'expense_adjustments',
  'settlements',
  'allocation_line_group_expansions',
  'allocation_lines',
  'allocations',
  'payment_expense_links',
  'expense_items',
  'expenses',
  'expense_occasions',
  'receipt_items',
  'receipts',
  'evidence_match_candidates',
  'evidence_observations',
  'evidence',
  'payments',
  'import_batches',
  'merchant_aliases',
  'merchants',
  'group_memberships',
  'groups',
  'accounts',
  'users',
  'people',
] as const;

export interface TestDatabase extends DatabaseHandle {
  /** Empties every table, leaving the schema in place. */
  readonly truncateAll: () => Promise<void>;
  /** `'postgres'` when running against a server, `'pglite'` for the in-process engine. */
  readonly driver: 'postgres' | 'pglite';
}

/** Makes a database name unique per test file, per process, per run. */
let databaseCounter = 0;

/**
 * Creates a throwaway database on the server and returns a URL pointing at it.
 *
 * Vitest runs test files in parallel. PGlite gives each file its own in-process engine for
 * free, so isolation there is automatic; a single shared server does not, and without this
 * the files race each other running `CREATE TABLE` (`duplicate key value violates unique
 * constraint "pg_type_typname_nsp_index"`) and then truncate each other's rows mid-test.
 *
 * Creating one database per file makes the server behave the way PGlite already does, so the
 * two configurations really do run the same suite — which is what ADR-0017 claims.
 */
async function createIsolatedServerDatabase(
  baseUrl: string,
): Promise<{ url: string; drop: () => Promise<void> }> {
  const { Client } = await import('pg');
  databaseCounter += 1;
  const name = `pers_test_${process.pid}_${Date.now().toString(36)}_${databaseCounter}`;

  // Connect to the maintenance database to issue CREATE/DROP; a session cannot drop the
  // database it is connected to.
  const maintenanceUrl = new URL(baseUrl);
  const targetUrl = new URL(baseUrl);
  maintenanceUrl.pathname = '/postgres';
  targetUrl.pathname = `/${name}`;

  const runOnMaintenance = async (statement: string): Promise<void> => {
    const client = new Client({ connectionString: maintenanceUrl.toString() });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };

  await runOnMaintenance(`create database "${name}"`);

  return {
    url: targetUrl.toString(),
    // FORCE terminates any connection the pool has not yet released. Without it a lingering
    // session makes DROP hang until the runner times out.
    drop: () => runOnMaintenance(`drop database if exists "${name}" with (force)`),
  };
}

/**
 * Opens a migrated, empty database, isolated from every other test file.
 *
 * Call once per test file in `beforeAll`, and `truncateAll()` in `beforeEach` so each test
 * starts from a known-empty ledger.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  const usingServer = baseUrl !== undefined && baseUrl !== '';

  const isolated = usingServer ? await createIsolatedServerDatabase(baseUrl) : null;
  const handle = await openDatabase(isolated?.url);
  await handle.migrate();

  const truncateAll = async (): Promise<void> => {
    // One statement, so foreign keys never transiently block the reset.
    await handle.db.execute(
      sql.raw(`truncate table ${ALL_TABLES.map((table) => `"${table}"`).join(', ')} cascade`),
    );
  };
  await truncateAll();

  return {
    ...handle,
    truncateAll,
    driver: usingServer ? 'postgres' : 'pglite',
    close: async () => {
      await handle.close();
      if (isolated !== null) await isolated.drop();
    },
  };
}

/**
 * Runs a raw SQL query and returns its rows, normalised across drivers.
 *
 * node-postgres returns `{ rows }`; the PGlite driver returns the array directly. Tests that
 * introspect `information_schema` need one shape either way.
 */
export async function query<T>(db: Database, statement: SQL): Promise<T[]> {
  const result: unknown = await db.execute(statement);
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && 'rows' in result) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(`Unexpected query result shape: ${typeof result}`);
}

/**
 * Runs `body`, expecting it to fail, and returns the failure with its whole cause chain
 * flattened into `message`.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` whose own message is just the SQL —
 * the constraint name that actually matters lives on `error.cause`. Flattening here means a
 * test can assert on the constraint name (stable across PostgreSQL versions and drivers)
 * rather than on wrapper text.
 */
export async function captureError(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body();
  } catch (error) {
    const chain: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      chain.push(current.message);
      const constraint = (current as { constraint?: unknown }).constraint;
      if (typeof constraint === 'string') chain.push(constraint);
      const detail = (current as { detail?: unknown }).detail;
      if (typeof detail === 'string') chain.push(detail);
      current = current.cause;
    }
    const flattened = new Error(chain.join('\n'));
    flattened.cause = error;
    return flattened;
  }
  throw new Error('Expected the operation to fail, but it succeeded.');
}

export type { Database };
