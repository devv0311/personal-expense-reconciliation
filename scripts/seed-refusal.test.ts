/**
 * That `scripts/seed-dev-data.ts` refuses *before* it opens anything.
 *
 * The unit tests in `src/db/real-ledger-guard.test.ts` prove the decision is correct. This file
 * proves the script actually makes that decision first, by running it for real as a subprocess
 * and looking at what it did and did not reach.
 *
 * The discriminator is what the script reaches. Both branches run `database.migrate()` as their
 * very next step, and that migration's first statement is `CREATE SCHEMA IF NOT EXISTS "drizzle"`
 * — a string that appears in the output if and only if a database was opened. (Checking for
 * `ECONNREFUSED` instead would be unreliable: `pg` connects lazily, so `createPostgresDatabase`
 * returns happily against a closed port and the failure surfaces inside a Drizzle wrapper that
 * may not spell the socket error out.) Seeing the refusal, and never that marker, and never the
 * script's own opening banner, is what "before any database is opened" means operationally.
 *
 * Everything here is synthetic: a closed loopback port, a temporary directory, and paths that
 * name no real record.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

/** Port 1 is privileged and never listening, so a real connection attempt refuses immediately. */
const UNREACHABLE = 'postgres://seed:seed@127.0.0.1:1/would_have_been_written';

/** The first thing the script prints once it has a database in hand. */
const SEEDING_BANNER = 'Seeding a synthetic development scenario';

/**
 * The first statement `database.migrate()` runs. It reaches the output only if the script got as
 * far as opening something — which is precisely the thing the guard must prevent.
 */
const MIGRATION_TOUCHED_A_DATABASE = 'CREATE SCHEMA IF NOT EXISTS';

interface Run {
  readonly status: number;
  readonly output: string;
}

/**
 * Runs the seed script with a controlled environment and returns what it said.
 *
 * `PATH`, `HOME` and the Node bits are passed through so `tsx` resolves; everything that chooses
 * a database is set explicitly, so a variable exported in the developer's own shell cannot make
 * this test pass or fail by accident.
 */
function runSeed(env: Record<string, string>): Run {
  const base: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    NODE_OPTIONS: '',
  };
  try {
    const output = execFileSync('npx', ['tsx', 'scripts/seed-dev-data.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...base, ...env },
      timeout: 120_000,
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('the seed script refuses an ambient DATABASE_URL', () => {
  it('never attempts the connection', () => {
    // The gap this closes. The Postgres branch used to call `createPostgresDatabase` with
    // whatever DATABASE_URL held, with no check in front of it at all.
    const run = runSeed({ DATABASE_URL: UNREACHABLE });

    expect(run.status).not.toBe(0);
    expect(run.output).toContain('refuses to run with DATABASE_URL set');
    // If the guard had not run first, the script would have reached `migrate()` against that URL
    // and this marker would be in the output.
    expect(run.output).not.toContain(MIGRATION_TOUCHED_A_DATABASE);
    expect(run.output).not.toContain(SEEDING_BANNER);
  }, 130_000);

  it('refuses even when a synthetic URL is also present', () => {
    const run = runSeed({
      DATABASE_URL: UNREACHABLE,
      SYNTHETIC_DATABASE_URL: 'postgres://seed:seed@127.0.0.1:1/scratch',
    });

    expect(run.status).not.toBe(0);
    expect(run.output).toContain('refuses to run with DATABASE_URL set');
    expect(run.output).not.toContain(MIGRATION_TOUCHED_A_DATABASE);
    expect(run.output).not.toContain(SEEDING_BANNER);
  }, 130_000);
});

describe('the seed script refuses a missing or real PGlite target', () => {
  it('creates nothing on disk when no target is named', () => {
    // `createPgliteDatabase` calls `mkdirSync(…, { recursive: true })`, so "did a directory
    // appear?" is a direct observation of whether the database was reached.
    const scratch = mkdtempSync(join(tmpdir(), 'seed-refusal-'));
    const wouldBeCreated = join(scratch, 'never-created');

    const run = runSeed({});

    expect(run.status).not.toBe(0);
    expect(run.output).toContain('refuses to run without PGLITE_DATA_DIR');
    expect(existsSync(wouldBeCreated)).toBe(false);
    expect(run.output).not.toContain(MIGRATION_TOUCHED_A_DATABASE);
    expect(run.output).not.toContain(SEEDING_BANNER);
  }, 130_000);

  it('refuses the real ledger by name without opening it', () => {
    // Names the path only; the script must not reach it. Nothing in this test reads, writes or
    // copies anything under `local-data/`.
    const run = runSeed({ PGLITE_DATA_DIR: './local-data/pglite-dev' });

    expect(run.status).not.toBe(0);
    expect(run.output).toContain('refuses to run against the real ledger');
    expect(run.output).not.toContain(MIGRATION_TOUCHED_A_DATABASE);
    expect(run.output).not.toContain(SEEDING_BANNER);
  }, 130_000);
});
