/**
 * The database's own account of what a restored dismissal is.
 *
 * ADR-0065 says a dismissal is closed by setting `restored_at`/`restored_by` together, never by
 * deleting the row, so "declined this, changed my mind" stays legible. `learning-service` writes
 * both columns in one `update`, and that is the only writer in this repository — which is exactly
 * why the table has to say it too. A `CHECK` is the thing that still holds when a second writer
 * appears: a repair statement typed at a console, a future service, a restored backup being
 * patched by hand.
 *
 * These tests speak SQL directly and go nowhere near a service, because a service that happens to
 * pass both columns would hide a constraint that does not require them.
 *
 * **The defect this file was written for.** The first version of the constraint read:
 *
 *     (restored_at is null and restored_by is null)
 *       or (restored_at is not null and length(trim(restored_by)) > 0)
 *
 * With `restored_at` set and `restored_by` NULL, the first branch is FALSE and the second is
 * `TRUE and NULL` = NULL, so the whole predicate is NULL — and a `CHECK` admits NULL as
 * readily as TRUE. A restoration with no actor was accepted by the database: an undo with
 * nobody's name on it, in a table whose entire purpose is that a decision can be accounted for.
 * Migration 0021 adds the missing `restored_by is not null`.
 *
 * Every value here is invented. No row resembles a real record.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { captureError, createTestDatabase, query } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
});

/** Inserts one dismissal row with every column spelled out, so nothing defaults into place. */
async function insertDismissal(values: {
  readonly dismissedBy?: string;
  readonly reason?: string;
  readonly restoredAt?: 'now' | null;
  readonly restoredBy?: string | null;
}): Promise<void> {
  const restoredAt = values.restoredAt === 'now' ? sql`now()` : sql`null`;
  // `undefined` and an explicit `null` both mean SQL NULL here. Interpolating `undefined`
  // into a `sql` template renders *nothing*, which would be a syntax error rather than the
  // column value the test meant — worth spelling out, because the failure looks like a
  // constraint that did not fire.
  const restoredBy =
    values.restoredBy === null || values.restoredBy === undefined
      ? sql`null`
      : sql`${values.restoredBy}`;
  await database.db.execute(sql`
    insert into rule_proposal_dismissals
      (proposal_key, wording, category, dismissed_by, reason, restored_at, restored_by)
    values
      ('contains:WHARFSIDE TEA ROOM|Dining', 'contains "WHARFSIDE TEA ROOM"', 'Dining',
       ${values.dismissedBy ?? 'user:invented'}, ${values.reason ?? 'too broad a wording'},
       ${restoredAt}, ${restoredBy})
  `);
}

/** An open dismissal — the row every restoration starts from. */
async function insertOpenDismissal(): Promise<void> {
  await insertDismissal({ restoredAt: null, restoredBy: null });
}

async function countRows(): Promise<number> {
  const rows = await query<{ n: string | number }>(
    database.db,
    sql`select count(*)::int as n from rule_proposal_dismissals`,
  );
  return Number(rows[0]!.n);
}

const RESTORED_CHECK = 'rule_proposal_dismissals_restored_check';

describe('a restoration names who made it', () => {
  it('accepts a dismissal that has not been restored', async () => {
    await insertDismissal({ restoredAt: null, restoredBy: null });
    expect(await countRows()).toBe(1);
  });

  it('accepts a restoration carrying both an instant and an actor', async () => {
    await insertDismissal({ restoredAt: 'now', restoredBy: 'user:invented' });
    expect(await countRows()).toBe(1);
  });

  it('refuses a restoration whose actor is NULL', async () => {
    const error = await captureError(() =>
      insertDismissal({ restoredAt: 'now', restoredBy: null }),
    );
    expect(error.message).toContain(RESTORED_CHECK);
    expect(await countRows()).toBe(0);
  });

  it('refuses a restoration whose actor is empty', async () => {
    const error = await captureError(() => insertDismissal({ restoredAt: 'now', restoredBy: '' }));
    expect(error.message).toContain(RESTORED_CHECK);
  });

  it('refuses a restoration whose actor is only whitespace', async () => {
    // Spaces, because `trim(x)` is `trim(both ' ' from x)` — it strips spaces and nothing
    // else. A tab-only actor would still pass, here and in every other `length(trim(...)) > 0`
    // check in this schema; that is a property of the shared idiom, not of this table, and
    // narrowing it in one place would make the schema disagree with itself.
    const error = await captureError(() =>
      insertDismissal({ restoredAt: 'now', restoredBy: '     ' }),
    );
    expect(error.message).toContain(RESTORED_CHECK);
  });

  it('refuses an actor with no instant beside it', async () => {
    const error = await captureError(() =>
      insertDismissal({ restoredAt: null, restoredBy: 'user:invented' }),
    );
    expect(error.message).toContain(RESTORED_CHECK);
  });

  it('refuses an empty actor with no instant beside it', async () => {
    const error = await captureError(() => insertDismissal({ restoredAt: null, restoredBy: '' }));
    expect(error.message).toContain(RESTORED_CHECK);
  });
});

describe('closing an open dismissal by UPDATE, which is how the service does it', () => {
  it('accepts an update that sets both columns together', async () => {
    await insertOpenDismissal();
    await database.db.execute(sql`
      update rule_proposal_dismissals set restored_at = now(), restored_by = 'user:invented'
    `);
    const rows = await query<{ restored_by: string | null }>(
      database.db,
      sql`select restored_by from rule_proposal_dismissals`,
    );
    expect(rows[0]!.restored_by).toBe('user:invented');
  });

  it('refuses an update that sets the instant and leaves the actor NULL', async () => {
    await insertOpenDismissal();
    const error = await captureError(() =>
      database.db.execute(sql`update rule_proposal_dismissals set restored_at = now()`),
    );
    expect(error.message).toContain(RESTORED_CHECK);

    const rows = await query<{ restored_at: Date | null }>(
      database.db,
      sql`select restored_at from rule_proposal_dismissals`,
    );
    expect(rows[0]!.restored_at).toBeNull();
  });

  it('refuses an update that sets the instant and blanks the actor', async () => {
    await insertOpenDismissal();
    const error = await captureError(() =>
      database.db.execute(
        sql`update rule_proposal_dismissals set restored_at = now(), restored_by = '  '`,
      ),
    );
    expect(error.message).toContain(RESTORED_CHECK);
  });

  it('refuses an update that names an actor without an instant', async () => {
    await insertOpenDismissal();
    const error = await captureError(() =>
      database.db.execute(sql`update rule_proposal_dismissals set restored_by = 'user:invented'`),
    );
    expect(error.message).toContain(RESTORED_CHECK);
  });
});

describe('the two columns that were already required', () => {
  it('refuses a dismissal with no reason', async () => {
    const error = await captureError(() => insertDismissal({ reason: '   ' }));
    expect(error.message).toContain('rule_proposal_dismissals_reason_check');
  });

  it('refuses a dismissal with no actor', async () => {
    const error = await captureError(() => insertDismissal({ dismissedBy: '' }));
    expect(error.message).toContain('rule_proposal_dismissals_actor_check');
  });
});

describe('the constraint as the catalog reports it', () => {
  it('requires restored_by to be NOT NULL in the restored branch', async () => {
    const rows = await query<{ definition: string }>(
      database.db,
      sql`select pg_get_constraintdef(oid) as definition
            from pg_constraint
           where conname = ${RESTORED_CHECK}`,
    );
    expect(rows).toHaveLength(1);
    // Read from the catalog rather than from the migration file: this is what the database is
    // actually enforcing, whichever migration put it there.
    expect(rows[0]!.definition).toMatch(/restored_by IS NOT NULL/i);
  });
});
