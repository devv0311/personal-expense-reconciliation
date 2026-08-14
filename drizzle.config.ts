import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * `drizzle-kit generate` reads `src/db/schema.ts` and emits a checked-in SQL migration under
 * `drizzle/` — no database connection required, so migrations are reviewable in a diff before
 * anything is applied. `DATABASE_URL` is only needed for `drizzle-kit migrate`/`studio`.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/expense_reconciliation_dev',
  },
  strict: true,
  verbose: true,
});
