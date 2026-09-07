/**
 * `src/db` — schema, migrations, and data access.
 *
 * Depends on `src/domain` for types and value sets only, one-way. Never issues an `UPDATE`
 * against a SOURCE-classified column (`payments`, `evidence`, `import_batches`) — see
 * `src/db/README.md` and `drizzle/security/immutable-table-grants.sql`.
 */

export * from './client.js';
export * as schema from './schema.js';
export * from './repositories.js';
export * from './master-data-repositories.js';
export * from './payment-workspace-repositories.js';
export * from './history-repositories.js';
export * from './analytics-repositories.js';
export * from './job-repositories.js';
