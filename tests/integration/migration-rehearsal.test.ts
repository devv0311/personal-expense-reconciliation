/**
 * A rehearsal of the 0018 → 0021 upgrade, on scratch databases only.
 *
 * Migrations 0019–0021 have so far only ever run on a database created from nothing. The
 * question they have never been asked is the one that matters: applied to a ledger that is
 * *already populated* — source rows, approved decisions, an audit trail — do they preserve it?
 * `src/server.ts` calls `database.migrate()` on startup, so the first real answer to that
 * question would otherwise arrive during a restart, against the only copy that matters.
 *
 * This file answers it in advance, and then asks the three follow-ups a person would ask
 * before trusting it:
 *
 *  1. **Does anything change that should not?** A census of every table and a per-table row
 *     digest, taken at 0018 and again at 0021.
 *  2. **What happens when a migration fails halfway?** Proven by running one that does — in a
 *     *copy* of the migration set, never the repository's own files — rather than by reading
 *     the migrator's source and assuming.
 *  3. **Does a cold backup actually restore?** Proven by closing the handle, copying the
 *     directory, upgrading the original, and opening the copy to find it still at 0018.
 *
 * ## Safety
 *
 * Every database here lives in a directory created by `mkdtemp` under the OS temp directory,
 * and `assertScratchDirectory` re-checks that before anything opens it — including through
 * `isRealLedgerPath`, so the real ledger and every preserved copy of it are refused by the same
 * function the seed script uses. Nothing reads `DATABASE_URL`, `PGLITE_DATA_DIR` or
 * `TEST_DATABASE_URL`: every path in this file is constructed, never inherited, so there is no
 * ambient variable that could redirect it. No process is started, signalled or stopped; every
 * handle is closed by awaiting `close()`.
 *
 * Every row is invented, from the same synthetic cast the scenario suite uses.
 */

import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, MIGRATIONS_FOLDER, schema } from '../../src/db/index.js';
import type { DatabaseHandle } from '../../src/db/index.js';
import { isRealLedgerPath } from '../../src/db/real-ledger-guard.js';
import { paise } from '../../src/domain/index.js';
import { captureError, query } from '../support/database.js';
import { addExpense, addPayment, linkPaymentToExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

/* ------------------------------------------------------------------ where anything may live */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_MIGRATIONS = resolve(REPO_ROOT, MIGRATIONS_FOLDER);

/** The one directory this file is allowed to create anything under. */
let scratchRoot: string;

/**
 * Refuses any path that is not inside this run's scratch root.
 *
 * Three separate refusals, because they fail for different reasons: outside the scratch root
 * (a path built wrong), inside the repository (a scratch database committed by accident), and
 * the real ledger or a preserved copy of it — checked with the same predicate
 * `scripts/seed-dev-data.ts` is guarded by, so this file cannot be safe by a different
 * standard than the rest of the repository.
 */
function assertScratchDirectory(candidate: string): string {
  const target = resolve(candidate);
  const root = realpathSync(scratchRoot);

  const inScratch = relative(root, target);
  if (inScratch.startsWith('..') || inScratch === '') {
    throw new Error(`Refusing to use ${target}: it is not inside this run's scratch root.`);
  }
  const inRepo = relative(resolve(REPO_ROOT), target);
  if (!inRepo.startsWith('..')) {
    throw new Error(`Refusing to use ${target}: it is inside the repository.`);
  }
  if (isRealLedgerPath(target, REPO_ROOT)) {
    throw new Error(`Refusing to use ${target}: it is the real ledger or a copy of it.`);
  }
  return target;
}

/** A guarded `createPgliteDatabase` — the same factory `src/server.ts` opens the ledger with. */
async function openScratchDatabase(dir: string): Promise<DatabaseHandle> {
  return createPgliteDatabase(assertScratchDirectory(dir));
}

/**
 * Runs the installed migrator against a chosen folder.
 *
 * This is the same function `createPgliteDatabase().migrate()` calls — `migrate` from
 * `drizzle-orm/pglite/migrator` — given a different folder. Staging an *older* migration set
 * is the only reason the folder is a parameter: a database at 0018 has to be built by the
 * historical SQL and the historical journal, not by inferring what the schema used to be.
 */
async function migrateWith(handle: DatabaseHandle, migrationsFolder: string): Promise<void> {
  type Target = Parameters<typeof migratePglite>[0];
  await migratePglite(handle.db as unknown as Target, { migrationsFolder });
}

/* --------------------------------------------------------------- staging a historical folder */

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}
interface Journal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly JournalEntry[];
}

function readRepoJournal(): Journal {
  return JSON.parse(
    readFileSync(join(REPO_MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
}

/**
 * Copies the repository's migrations up to and including `lastIdx` into a scratch folder,
 * with a journal trimmed to match.
 *
 * The `.sql` files are copied byte for byte, so the sha256 the migrator records is the same one
 * the repository's own files produce. Nothing under `drizzle/` is written, moved or renamed.
 */
function stageMigrationsThrough(lastIdx: number, name: string): string {
  const folder = assertScratchDirectory(join(scratchRoot, name));
  mkdirSync(join(folder, 'meta'), { recursive: true });

  const journal = readRepoJournal();
  const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  for (const entry of entries) {
    cpSync(join(REPO_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return folder;
}

/* ------------------------------------------------------------------------------- the census */

/** Every base table in `public`, as the database itself reports them. */
async function listTables(handle: DatabaseHandle): Promise<readonly string[]> {
  const rows = await query<{ table_name: string }>(
    handle.db,
    sql`select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'
         order by table_name`,
  );
  return rows.map((row) => row.table_name);
}

/**
 * Row count and a content digest for every table, so "nothing changed" is a claim about the
 * rows themselves and not merely about how many there are.
 *
 * The digest is `md5` over every row's own text form, ordered by that text — deterministic
 * without needing to know any table's key, and sensitive to a single changed character in any
 * column of any row.
 */
async function census(
  handle: DatabaseHandle,
): Promise<Record<string, { rows: number; digest: string }>> {
  const result: Record<string, { rows: number; digest: string }> = {};
  for (const table of await listTables(handle)) {
    const rows = await query<{ n: number; digest: string | null }>(
      handle.db,
      sql.raw(
        `select count(*)::int as n,
                coalesce(md5(string_agg(t::text, '|' order by t::text)), '-') as digest
           from "${table}" t`,
      ),
    );
    result[table] = { rows: Number(rows[0]!.n), digest: rows[0]!.digest ?? '-' };
  }
  return result;
}

/** The migrations the database says it has applied, in the order it applied them. */
async function appliedMigrations(handle: DatabaseHandle): Promise<readonly number[]> {
  const rows = await query<{ created_at: string | number }>(
    handle.db,
    sql`select created_at from drizzle.__drizzle_migrations order by created_at asc`,
  );
  return rows.map((row) => Number(row.created_at));
}

/* ------------------------------------------------------------------- a population at 0018 */

/**
 * Source records, approved decisions, an audit trail, a rule, an allocation and a settlement.
 *
 * Deliberately built with the fixture helpers rather than through services: the subject here is
 * the migration, and a service would be free to write something a 2026-09 service happens to
 * write. Rows written directly are the rows a ledger at 0018 actually holds.
 */
async function populateAt0018(handle: DatabaseHandle): Promise<Cast> {
  const db = handle.db;
  const cast = await seedCast(db);
  const account = cast.account['account_hdfc_savings']!;

  const paymentIds: string[] = [];
  for (const [index, wording] of [
    'WHARFSIDE TEA ROOM',
    'WHARFSIDE TEA ROOM',
    'MONSOON HARDWARE CO',
    'CGST',
    'INTEREST',
  ].entries()) {
    paymentIds.push(
      await addPayment(db, cast, {
        accountId: account,
        amount: paise(BigInt(10_000 * (index + 1))),
        direction: 'debit',
        occurredAt: new Date(Date.UTC(2026, 6, index + 1)),
        rawDescription: wording,
        channel: 'card',
        state: 'normalized',
      }),
    );
  }

  // Two approved decisions — the thing an upgrade must not disturb.
  const expenseId = await addExpense(db, {
    description: 'tea, twice',
    amount: paise(30_000n),
    occurredAt: new Date(Date.UTC(2026, 6, 1)),
    relationshipType: 'personal',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
    category: 'Dining',
  });
  await linkPaymentToExpense(db, {
    paymentId: paymentIds[0]! as never,
    expenseId,
    amount: paise(10_000n),
  });

  const [allocation] = await db
    .insert(schema.allocations)
    .values({
      expenseId,
      method: 'equal',
      decidedAt: new Date(Date.UTC(2026, 6, 2)),
      decidedBy: 'user:invented',
    })
    .returning({ id: schema.allocations.id });
  await db.insert(schema.allocationLines).values({
    allocationId: allocation!.id,
    beneficiaryType: 'person',
    beneficiaryId: cast.userPersonId,
    amount: paise(30_000n),
  });

  await db.insert(schema.settlements).values({
    paymentId: paymentIds[2]!,
    counterpartyPersonId: cast.person['person_flatmate_a']!,
    amount: paise(5_000n),
    reason: 'invented settlement',
  });

  await db.insert(schema.rules).values({
    name: 'invented standing rule',
    matchPattern: { kind: 'contains', value: 'MONSOON HARDWARE CO' },
    proposedClassification: { category: 'Home' },
    origin: 'manual',
    action: 'set_expense_category',
    effect: 'propose',
  });

  // An audit trail, using entity types that are legal at 0018.
  for (const paymentId of paymentIds.slice(0, 3)) {
    await db.insert(schema.auditEvents).values({
      entityType: 'payment',
      entityId: paymentId,
      action: 'create',
      newValue: { imported: true },
      actor: 'user:invented',
      source: 'rehearsal',
    });
  }
  await db.insert(schema.auditEvents).values({
    entityType: 'expense',
    entityId: expenseId,
    action: 'update',
    oldValue: { state: 'pending' },
    newValue: { state: 'approved' },
    actor: 'user:invented',
    source: 'rehearsal',
    reason: 'confirmed by the person',
  });

  return cast;
}

/* ============================================================================ the rehearsal */

let journal: Journal;
let at0018Folder: string;

beforeAll(() => {
  scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'migration-rehearsal-')));
  journal = readRepoJournal();
  at0018Folder = stageMigrationsThrough(18, 'migrations-at-0018');
}, 60_000);

afterAll(() => {
  if (scratchRoot !== undefined) rmSync(scratchRoot, { recursive: true, force: true });
});

/** Opens a fresh scratch database and brings it to 0018 with the historical SQL. */
async function freshLedgerAt0018(name: string): Promise<{ handle: DatabaseHandle; dir: string }> {
  const dir = join(scratchRoot, name);
  const handle = await openScratchDatabase(dir);
  await migrateWith(handle, at0018Folder);
  return { handle, dir };
}

const whenOf = (idx: number): number => journal.entries.find((entry) => entry.idx === idx)!.when;

describe('the baseline: a populated ledger at migration 0018', () => {
  it('has no dismissals table and an audit check that predates the new entity type', async () => {
    const { handle } = await freshLedgerAt0018('ledger-baseline');
    try {
      await populateAt0018(handle);

      expect(await listTables(handle)).not.toContain('rule_proposal_dismissals');
      expect(await appliedMigrations(handle)).toEqual(
        journal.entries.filter((entry) => entry.idx <= 18).map((entry) => entry.when),
      );

      // The widening in 0020 is real work, not a formality: before it, the entity type the
      // dismissal audit uses is refused by the database.
      await expect(
        handle.db.execute(sql`
          insert into audit_events (entity_type, entity_id, action, new_value, actor)
          values ('rule_proposal_dismissal', gen_random_uuid(), 'create', '{}'::jsonb, 'user:invented')
        `),
      ).rejects.toThrow();
    } finally {
      await handle.close();
    }
  }, 120_000);
});

describe('upgrading 0018 → 0021 over a populated ledger', () => {
  it('preserves every pre-existing table and every row in it', async () => {
    const { handle } = await freshLedgerAt0018('ledger-upgrade');
    try {
      await populateAt0018(handle);
      const before = await census(handle);
      const tablesBefore = Object.keys(before);

      await handle.migrate(); // the repository's own folder, exactly as src/server.ts does

      const after = await census(handle);

      // Every table that existed still exists, with the same rows, byte for byte.
      for (const table of tablesBefore) {
        expect({ table, ...after[table] }).toEqual({ table, ...before[table] });
      }
      // And the only new one is the table 0019 adds.
      expect(Object.keys(after).filter((table) => !tablesBefore.includes(table))).toEqual([
        'rule_proposal_dismissals',
      ]);

      // Named explicitly, because "the digest matched" is only convincing if the rows it
      // covered are the ones that matter.
      expect(before['payments']!.rows).toBe(5);
      expect(before['expenses']!.rows).toBe(1);
      expect(before['audit_events']!.rows).toBe(4);
      expect(before['allocation_lines']!.rows).toBe(1);
      expect(before['settlements']!.rows).toBe(1);
      expect(before['rules']!.rows).toBe(1);
    } finally {
      await handle.close();
    }
  }, 120_000);

  it('records 0019, 0020 and 0021 in the journal table, in order, once each', async () => {
    const { handle } = await freshLedgerAt0018('ledger-journal');
    try {
      await populateAt0018(handle);
      await handle.migrate();

      expect(await appliedMigrations(handle)).toEqual(journal.entries.map((entry) => entry.when));
      expect(await appliedMigrations(handle)).toEqual([
        ...journal.entries.slice(0, 19).map((entry) => entry.when),
        whenOf(19),
        whenOf(20),
        whenOf(21),
      ]);
    } finally {
      await handle.close();
    }
  }, 120_000);

  it('adds the new entity type to the audit check without dropping the old ones', async () => {
    const { handle } = await freshLedgerAt0018('ledger-audit-check');
    try {
      await populateAt0018(handle);
      await handle.migrate();

      await handle.db.execute(sql`
        insert into audit_events (entity_type, entity_id, action, new_value, actor)
        values ('rule_proposal_dismissal', gen_random_uuid(), 'create', '{}'::jsonb, 'user:invented')
      `);
      // An entity type that was legal before is still legal.
      await handle.db.execute(sql`
        insert into audit_events (entity_type, entity_id, action, new_value, actor)
        values ('payment', gen_random_uuid(), 'create', '{}'::jsonb, 'user:invented')
      `);
      // And one that was never legal still is not.
      await expect(
        handle.db.execute(sql`
          insert into audit_events (entity_type, entity_id, action, new_value, actor)
          values ('not_an_entity', gen_random_uuid(), 'create', '{}'::jsonb, 'user:invented')
        `),
      ).rejects.toThrow();
    } finally {
      await handle.close();
    }
  }, 120_000);

  it('leaves a dismissal that persists, and refuses a restoration with no actor', async () => {
    const { handle } = await freshLedgerAt0018('ledger-dismissal');
    try {
      await populateAt0018(handle);
      await handle.migrate();

      await handle.db.execute(sql`
        insert into rule_proposal_dismissals (proposal_key, wording, category, dismissed_by, reason)
        values ('contains:WHARFSIDE TEA ROOM|Dining', 'contains "WHARFSIDE TEA ROOM"', 'Dining',
                'user:invented', 'too broad a wording')
      `);
      await handle.db.execute(sql`
        update rule_proposal_dismissals set restored_at = now(), restored_by = 'user:invented'
      `);
      const restored = await query<{ restored_by: string }>(
        handle.db,
        sql`select restored_by from rule_proposal_dismissals`,
      );
      expect(restored[0]!.restored_by).toBe('user:invented');

      // 0021's correction, checked on the upgraded database rather than on a fresh one.
      // `captureError` rather than `rejects.toThrow`: drizzle's wrapper message is only the
      // SQL, and the constraint name — the thing worth asserting on — is on the cause.
      const refusal = await captureError(() =>
        handle.db.execute(sql`
          insert into rule_proposal_dismissals
            (proposal_key, wording, category, dismissed_by, reason, restored_at, restored_by)
          values ('k', 'w', 'c', 'user:invented', 'r', now(), null)
        `),
      );
      expect(refusal.message).toContain('rule_proposal_dismissals_restored_check');
    } finally {
      await handle.close();
    }
  }, 120_000);

  it('creates no rule, no dismissal and no decision of its own', async () => {
    const { handle } = await freshLedgerAt0018('ledger-proposal-only');
    try {
      await populateAt0018(handle);
      const rulesBefore = (await census(handle))['rules']!;

      await handle.migrate();

      const after = await census(handle);
      // The migration is schema only: it proposes nothing, approves nothing, and writes no row.
      expect(after['rules']).toEqual(rulesBefore);
      expect(after['rule_proposal_dismissals']!.rows).toBe(0);
      expect(after['ai_inferences']!.rows).toBe(0);
    } finally {
      await handle.close();
    }
  }, 120_000);

  it('is a no-op when the migrator runs again', async () => {
    const { handle } = await freshLedgerAt0018('ledger-rerun');
    try {
      await populateAt0018(handle);
      await handle.migrate();
      const afterFirst = await census(handle);
      const appliedFirst = await appliedMigrations(handle);

      await handle.migrate();
      await handle.migrate();

      expect(await appliedMigrations(handle)).toEqual(appliedFirst);
      expect(await census(handle)).toEqual(afterFirst);
    } finally {
      await handle.close();
    }
  }, 120_000);
});

describe('a migration that fails partway', () => {
  /** A copy of the whole set, plus one migration that errors. The repository is not touched. */
  function stageFailingMigrations(): string {
    const folder = assertScratchDirectory(join(scratchRoot, 'migrations-failing'));
    cpSync(REPO_MIGRATIONS, folder, { recursive: true });
    // `drizzle/security` is unrelated to the migrator; copying it is harmless and copying the
    // folder wholesale is what keeps the .sql bytes identical.
    const tag = '9999_deliberate_failure';
    writeFileSync(
      join(folder, `${tag}.sql`),
      // A table first, so a partially-applied batch would be visible, then a guaranteed error.
      `CREATE TABLE "rehearsal_marker" ("id" integer);--> statement-breakpoint\nSELECT 1 / 0;\n`,
    );
    const staged = readRepoJournal();
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify(
        {
          ...staged,
          entries: [
            ...staged.entries,
            {
              idx: 22,
              version: '7',
              when: staged.entries[staged.entries.length - 1]!.when + 1_000,
              tag,
              breakpoints: true,
            },
          ],
        },
        null,
        2,
      ),
    );
    return folder;
  }

  /** A fingerprint of the repository's migration files, to prove nothing here edited them. */
  function migrationFilesFingerprint(): string {
    return readdirSync(REPO_MIGRATIONS)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => `${name}:${readFileSync(join(REPO_MIGRATIONS, name), 'utf8').length}`)
      .join('\n');
  }

  it('rolls the whole batch back, leaving the ledger exactly at 0018', async () => {
    const before = migrationFilesFingerprint();
    const failing = stageFailingMigrations();
    const { handle } = await freshLedgerAt0018('ledger-atomicity');
    try {
      await populateAt0018(handle);
      const censusAt0018 = await census(handle);

      const failure = await captureError(() => migrateWith(handle, failing));
      expect(failure.message).toMatch(/division by zero/i);

      // Not "0019 and 0020 went in and 9999 did not" — none of them did. The migrator runs the
      // whole pending batch inside one transaction, and this is that claim tested rather than
      // read off its source.
      expect(await appliedMigrations(handle)).toEqual(
        journal.entries.filter((entry) => entry.idx <= 18).map((entry) => entry.when),
      );
      const tables = await listTables(handle);
      expect(tables).not.toContain('rule_proposal_dismissals');
      expect(tables).not.toContain('rehearsal_marker');
      expect(await census(handle)).toEqual(censusAt0018);

      // And the recovery path: the failure left nothing to clean up, so the real set applies.
      await handle.migrate();
      expect(await appliedMigrations(handle)).toEqual(journal.entries.map((entry) => entry.when));
      for (const [table, state] of Object.entries(censusAt0018)) {
        expect({ table, ...(await census(handle))[table] }).toEqual({ table, ...state });
      }
    } finally {
      await handle.close();
    }
    expect(migrationFilesFingerprint()).toBe(before);
  }, 180_000);

  it('refuses 0021 loudly when a row already violates the corrected constraint', async () => {
    const through0020 = stageMigrationsThrough(20, 'migrations-at-0020');
    const { handle } = await freshLedgerAt0018('ledger-bad-row');
    try {
      await populateAt0018(handle);
      await migrateWith(handle, through0020);

      // The row 0019's constraint wrongly admitted: restored, by nobody.
      await handle.db.execute(sql`
        insert into rule_proposal_dismissals
          (proposal_key, wording, category, dismissed_by, reason, restored_at, restored_by)
        values ('k', 'w', 'c', 'user:invented', 'r', now(), null)
      `);

      // 0021 validates what is already there, so it fails rather than silently admitting it.
      await expect(handle.migrate()).rejects.toThrow();
      expect(await appliedMigrations(handle)).toEqual(
        journal.entries.filter((entry) => entry.idx <= 20).map((entry) => entry.when),
      );
    } finally {
      await handle.close();
    }
  }, 180_000);
});

describe('a cold backup, and restoring from it', () => {
  it('restores a pre-upgrade ledger while the upgraded one stays upgraded', async () => {
    const { handle, dir } = await freshLedgerAt0018('ledger-backup');
    const backupDir = assertScratchDirectory(join(scratchRoot, 'backup-at-0018'));
    const restoredDir = assertScratchDirectory(join(scratchRoot, 'restored-at-0018'));

    await populateAt0018(handle);
    const censusAt0018 = await census(handle);

    // A cold copy: the handle is closed and awaited *before* anything is read off disk. A copy
    // of a directory whose engine is still open is torn, and a torn PGlite has no repair.
    await handle.close();
    cpSync(dir, backupDir, { recursive: true });

    // Upgrade the original.
    const reopened = await openScratchDatabase(dir);
    try {
      await reopened.migrate();
      expect(await appliedMigrations(reopened)).toEqual(journal.entries.map((entry) => entry.when));
      expect(await listTables(reopened)).toContain('rule_proposal_dismissals');
    } finally {
      await reopened.close();
    }

    // Restore the backup into a *different* directory, so the upgraded one is still there to
    // compare against and nothing is overwritten to find out whether the copy was any good.
    cpSync(backupDir, restoredDir, { recursive: true });
    const restored = await openScratchDatabase(restoredDir);
    try {
      expect(await appliedMigrations(restored)).toEqual(
        journal.entries.filter((entry) => entry.idx <= 18).map((entry) => entry.when),
      );
      expect(await listTables(restored)).not.toContain('rule_proposal_dismissals');
      expect(await census(restored)).toEqual(censusAt0018);
    } finally {
      await restored.close();
    }

    // The upgraded original is untouched by the restore.
    const original = await openScratchDatabase(dir);
    try {
      expect(await appliedMigrations(original)).toEqual(journal.entries.map((entry) => entry.when));
    } finally {
      await original.close();
    }
  }, 240_000);

  it('leaves no postmaster.pid behind, which is how a hot copy can be spotted', async () => {
    const { handle, dir } = await freshLedgerAt0018('ledger-pidfile');
    await populateAt0018(handle);

    // While the engine is open the directory carries a `postmaster.pid`.
    expect(readdirSync(dir)).toContain('postmaster.pid');
    await handle.close();
    // An awaited `close()` removes it. So the file is a *witness*: a stopped directory that
    // still has one was copied while something held it open, and a copy taken then is torn —
    // which is worth checking, because a torn PGlite has no repair, only a restore.
    expect(readdirSync(dir)).not.toContain('postmaster.pid');

    const copy = assertScratchDirectory(join(scratchRoot, 'pidfile-copy'));
    cpSync(dir, copy, { recursive: true });
    expect(readdirSync(copy)).not.toContain('postmaster.pid');

    const reopened = await openScratchDatabase(copy);
    try {
      expect(await appliedMigrations(reopened)).toHaveLength(19);
    } finally {
      await reopened.close();
    }
  }, 180_000);
});
