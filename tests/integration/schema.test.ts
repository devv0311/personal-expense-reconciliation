import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { schema } from '../../src/db/index.js';
import { captureError, createTestDatabase, query } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  // Guarded: when beforeAll fails, `database` was never assigned, and an unguarded
  // call here reports a TypeError that buries the real setup error.
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
});

/** Minimal referential scaffolding: one user, their Person, an account, an import batch. */
async function seedScaffold(): Promise<{
  personId: string;
  userId: string;
  accountId: string;
  importBatchId: string;
}> {
  const db = database.db;
  const [person] = await db
    .insert(schema.people)
    .values({ displayName: 'Dev' })
    .returning({ id: schema.people.id });
  const [user] = await db
    .insert(schema.users)
    .values({ email: 'dev@example.test', personId: person!.id })
    .returning({ id: schema.users.id });
  await db
    .update(schema.people)
    .set({ linkedUserId: user!.id })
    .where(sql`${schema.people.id} = ${person!.id}`);
  const [account] = await db
    .insert(schema.accounts)
    .values({ ownerUserId: user!.id, name: 'HDFC Savings', type: 'bank', last4: '4821' })
    .returning({ id: schema.accounts.id });
  const [batch] = await db
    .insert(schema.importBatches)
    .values({ sourceChannel: 'bank_csv', parserVersion: 'test-1' })
    .returning({ id: schema.importBatches.id });

  return {
    personId: person!.id,
    userId: user!.id,
    accountId: account!.id,
    importBatchId: batch!.id,
  };
}

describe('the migration produces a working PostgreSQL schema', () => {
  it('runs against a real Postgres engine', async () => {
    const rows = await query<{ version: string }>(database.db, sql`select version()`);

    expect(rows[0]?.version).toMatch(/PostgreSQL/);
  });

  it('creates every table the design document specifies', async () => {
    const rows = await query<{ table_name: string }>(
      database.db,
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const tableNames = rows.map((row) => row.table_name);

    for (const expected of [
      'accounts',
      'ai_inferences',
      'allocation_line_group_expansions',
      'allocation_lines',
      'allocations',
      'audit_events',
      'evidence',
      'expense_adjustments',
      'expense_items',
      'expense_occasions',
      'expenses',
      'external_integrations',
      'group_memberships',
      'groups',
      'import_batches',
      'merchant_aliases',
      'merchants',
      'payment_expense_links',
      'payments',
      'people',
      'receipt_items',
      'receipts',
      'reconciliation_runs',
      'rules',
      'settlements',
      'splitwise_expenses',
      'splitwise_settlements',
      'users',
    ]) {
      expect(tableNames).toContain(expected);
    }
  });
});

describe('monetary columns are bigint, never floating point (invariant #12)', () => {
  it('stores every amount column as bigint', async () => {
    const rows = await query<{ table_name: string; column_name: string; data_type: string }>(
      database.db,
      sql`select table_name, column_name, data_type
          from information_schema.columns
          where table_schema = 'public'
            and (column_name like '%amount%' or column_name in
                 ('subtotal', 'tax', 'total', 'line_total', 'unit_price'))
          order by table_name, column_name`,
    );

    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      expect(`${row.table_name}.${row.column_name}:${row.data_type}`).toMatch(/:bigint$/);
    }
  });

  it('never uses a floating-point or numeric type for money', async () => {
    const rows = await query<{ table_name: string; column_name: string }>(
      database.db,
      sql`select table_name, column_name
          from information_schema.columns
          where table_schema = 'public'
            and data_type in ('double precision', 'real', 'money', 'numeric')`,
    );

    // The only non-integer numerics in the schema are a receipt/expense item quantity and an
    // informational allocation percentage — neither is a monetary value.
    expect(rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual([
      'allocation_lines.percentage',
      'expense_items.quantity',
      'receipt_items.quantity',
    ]);
  });

  it('round-trips a paise amount above IEEE-754 integer precision without loss', async () => {
    const scaffold = await seedScaffold();
    const beyondDoublePrecision = 9007199254740993n; // 2^53 + 1

    const [inserted] = await database.db
      .insert(schema.payments)
      .values({
        accountId: scaffold.accountId,
        importBatchId: scaffold.importBatchId,
        amount: beyondDoublePrecision,
        direction: 'debit',
        occurredAt: new Date('2026-07-12T19:00:00Z'),
        rawDescription: 'SYNTHETIC LARGE AMOUNT',
        channel: 'upi',
      })
      .returning({ amount: schema.payments.amount });

    expect(inserted?.amount).toBe(beyondDoublePrecision);
    expect(typeof inserted?.amount).toBe('bigint');
  });
});

describe('NOT NULL and foreign keys', () => {
  it('rejects a payment referencing an account that does not exist', async () => {
    const scaffold = await seedScaffold();
    const error = await captureError(() =>
      database.db.insert(schema.payments).values({
        accountId: '00000000-0000-0000-0000-000000000000',
        importBatchId: scaffold.importBatchId,
        amount: 100n,
        direction: 'debit',
        occurredAt: new Date(),
        rawDescription: 'orphan',
        channel: 'upi',
      }),
    );

    expect(error.message).toMatch(/foreign key|violates/i);
  });

  it('requires an expense to name who fronted the money (ADR-0006)', async () => {
    const error = await captureError(() =>
      database.db.execute(
        sql`insert into expenses (amount, occurred_at, relationship_type)
            values (100, now(), 'personal')`,
      ),
    );

    expect(error.message).toMatch(/paid_by_person_id|not-null|null value/i);
  });

  it('rejects an allocation line pointing at no allocation', async () => {
    const error = await captureError(() =>
      database.db.execute(
        sql`insert into allocation_lines (allocation_id, beneficiary_type, beneficiary_id, amount)
            values ('00000000-0000-0000-0000-000000000000', 'person',
                    '00000000-0000-0000-0000-000000000000', 100)`,
      ),
    );

    expect(error.message).toMatch(/foreign key|violates/i);
  });
});

describe('CHECK constraints enforce the invariants a per-row rule can express', () => {
  it('rejects a zero or negative payment amount', async () => {
    const scaffold = await seedScaffold();
    const error = await captureError(() =>
      database.db.insert(schema.payments).values({
        accountId: scaffold.accountId,
        importBatchId: scaffold.importBatchId,
        amount: 0n,
        direction: 'debit',
        occurredAt: new Date(),
        rawDescription: 'zero',
        channel: 'upi',
      }),
    );

    expect(error.message).toMatch(/payments_amount_check/);
  });

  it('rejects a relationship_type removed by ADR-0007 and ADR-0008', async () => {
    const scaffold = await seedScaffold();

    for (const removed of ['settlement', 'reimbursement']) {
      const error = await captureError(() =>
        database.db.execute(
          sql`insert into expenses (amount, occurred_at, relationship_type, paid_by_person_id)
              values (100, now(), ${removed}, ${scaffold.personId})`,
        ),
      );

      expect(error.message).toMatch(/expenses_relationship_type_check/);
    }
  });

  it('accepts a zero-amount allocation line (invariant #12a, ADR-0013)', async () => {
    const scaffold = await seedScaffold();
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        amount: 45000n,
        occurredAt: new Date('2026-06-28T14:00:00Z'),
        relationshipType: 'personal',
        paidByPersonId: scaffold.personId,
        state: 'allocated',
      })
      .returning({ id: schema.expenses.id });
    const [allocation] = await database.db
      .insert(schema.allocations)
      .values({
        expenseId: expense!.id,
        method: 'equal',
        decidedAt: new Date(),
        decidedBy: 'manual',
      })
      .returning({ id: schema.allocations.id });

    const [line] = await database.db
      .insert(schema.allocationLines)
      .values({
        allocationId: allocation!.id,
        beneficiaryType: 'person',
        beneficiaryId: scaffold.personId,
        amount: 0n,
      })
      .returning({ amount: schema.allocationLines.amount });

    expect(line?.amount).toBe(0n);
  });

  it('rejects a negative allocation line amount', async () => {
    const scaffold = await seedScaffold();
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        amount: 45000n,
        occurredAt: new Date(),
        relationshipType: 'personal',
        paidByPersonId: scaffold.personId,
      })
      .returning({ id: schema.expenses.id });
    const [allocation] = await database.db
      .insert(schema.allocations)
      .values({
        expenseId: expense!.id,
        method: 'equal',
        decidedAt: new Date(),
        decidedBy: 'manual',
      })
      .returning({ id: schema.allocations.id });

    const error = await captureError(() =>
      database.db.insert(schema.allocationLines).values({
        allocationId: allocation!.id,
        beneficiaryType: 'person',
        beneficiaryId: scaffold.personId,
        amount: -1n,
      }),
    );

    expect(error.message).toMatch(/allocation_lines_amount_check/);
  });

  it('rejects a negative or zero expense adjustment — there is no signed adjustment', async () => {
    const scaffold = await seedScaffold();
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        amount: 45000n,
        occurredAt: new Date(),
        relationshipType: 'personal',
        paidByPersonId: scaffold.personId,
      })
      .returning({ id: schema.expenses.id });

    for (const amount of [0n, -15000n]) {
      const error = await captureError(() =>
        database.db.insert(schema.expenseAdjustments).values({
          originalExpenseId: expense!.id,
          kind: 'merchant_refund',
          amount,
          occurredAt: new Date(),
        }),
      );

      expect(error.message).toMatch(/expense_adjustments_amount_check/);
    }
  });

  it('refuses to store anything longer than four digits in accounts.last4', async () => {
    const scaffold = await seedScaffold();
    const error = await captureError(() =>
      database.db.insert(schema.accounts).values({
        ownerUserId: scaffold.userId,
        name: 'Bad card',
        type: 'card',
        // Deliberately not a real-looking PAN: the point is the length, and the repo
        // keeps nothing card-shaped in it at all (security-model.md).
        last4: '00000000000000000',
      }),
    );

    expect(error.message).toMatch(/accounts_last4_check/);
  });

  it('rejects a reconciliation run whose totals break invariant #20', async () => {
    const error = await captureError(() =>
      database.db.insert(schema.reconciliationRuns).values({
        periodStart: new Date('2026-07-01T00:00:00Z'),
        periodEnd: new Date('2026-07-31T00:00:00Z'),
        ledgerTotalOutflow: 90000n,
        ledgerTransfersTotal: 0n,
        ledgerInvestmentsTotal: 0n,
        ledgerSettlementsTotal: 0n,
        ledgerExplainedTotal: 75000n,
        ledgerUnexplainedTotal: 0n, // should be 15000
      }),
    );

    expect(error.message).toMatch(/reconciliation_runs_unexplained_identity_check/);
  });

  it('stores a negative unexplained total — the integrity signal is not clamped (ADR-0016)', async () => {
    // An over-explained ledger (a double-linked payment, a mis-scoped period) is exactly what
    // this figure exists to surface. The CHECK enforces the identity, not the sign.
    const [run] = await database.db
      .insert(schema.reconciliationRuns)
      .values({
        periodStart: new Date('2026-07-01T00:00:00Z'),
        periodEnd: new Date('2026-07-31T00:00:00Z'),
        ledgerTotalOutflow: 10000n,
        ledgerTransfersTotal: 0n,
        ledgerInvestmentsTotal: 0n,
        ledgerSettlementsTotal: 0n,
        ledgerExplainedTotal: 90000n,
        ledgerUnexplainedTotal: -80000n,
      })
      .returning({ unexplained: schema.reconciliationRuns.ledgerUnexplainedTotal });

    expect(run?.unexplained).toBe(-80000n);
  });

  it('accepts a reconciliation run whose totals satisfy invariant #20', async () => {
    const [run] = await database.db
      .insert(schema.reconciliationRuns)
      .values({
        periodStart: new Date('2026-07-01T00:00:00Z'),
        periodEnd: new Date('2026-07-31T00:00:00Z'),
        ledgerTotalOutflow: 90000n,
        ledgerTransfersTotal: 0n,
        ledgerInvestmentsTotal: 0n,
        ledgerSettlementsTotal: 0n,
        ledgerExplainedTotal: 75000n,
        ledgerUnexplainedTotal: 15000n,
      })
      .returning({ unexplained: schema.reconciliationRuns.ledgerUnexplainedTotal });

    expect(run?.unexplained).toBe(15000n);
  });
});

describe('evidence.note_kind keeps one shape from carrying two meanings (ADR-0018)', () => {
  it('accepts a documenting manual note', async () => {
    const [row] = await database.db
      .insert(schema.evidence)
      .values({
        type: 'manual_note',
        rawText: 'Flatmate A paid the electrician, split three ways',
        capturedAt: new Date('2026-07-05T10:00:00Z'),
        noteKind: 'documentation',
      })
      .returning({ noteKind: schema.evidence.noteKind });

    expect(row?.noteKind).toBe('documentation');
  });

  it('accepts a settlement-claim manual note', async () => {
    const [row] = await database.db
      .insert(schema.evidence)
      .values({
        type: 'manual_note',
        rawText: 'Flatmate C says they repaid Flatmate A in cash',
        capturedAt: new Date('2026-07-22T10:00:00Z'),
        noteKind: 'settlement_claim',
      })
      .returning({ noteKind: schema.evidence.noteKind });

    expect(row?.noteKind).toBe('settlement_claim');
  });

  it('rejects a manual note that does not say which kind it is', async () => {
    const error = await captureError(() =>
      database.db.insert(schema.evidence).values({
        type: 'manual_note',
        rawText: 'ambiguous',
        capturedAt: new Date(),
      }),
    );

    expect(error.message).toMatch(/evidence_note_kind_only_on_notes_check/);
  });

  it('rejects a non-note evidence row that claims a kind', async () => {
    const error = await captureError(() =>
      database.db.insert(schema.evidence).values({
        type: 'receipt_image',
        storageRef: 'evidence/2026/07/receipt-001.jpg',
        capturedAt: new Date(),
        noteKind: 'settlement_claim',
      }),
    );

    expect(error.message).toMatch(/evidence_note_kind_only_on_notes_check/);
  });

  it('rejects an unknown note kind', async () => {
    const error = await captureError(() =>
      database.db.execute(
        sql`insert into evidence (type, captured_at, note_kind)
            values ('manual_note', now(), 'probably_settled')`,
      ),
    );

    expect(error.message).toMatch(/evidence_note_kind_check/);
  });

  it('accepts every other evidence type with no kind', async () => {
    const [row] = await database.db
      .insert(schema.evidence)
      .values({
        type: 'bank_line',
        rawText: 'UPI-BLINKIT',
        capturedAt: new Date(),
      })
      .returning({ noteKind: schema.evidence.noteKind });

    expect(row?.noteKind).toBeNull();
  });
});

describe('uniqueness', () => {
  it('allows only one current allocation per expense (invariant #6)', async () => {
    const scaffold = await seedScaffold();
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        amount: 90000n,
        occurredAt: new Date(),
        relationshipType: 'household_shared_flat',
        paidByPersonId: scaffold.personId,
      })
      .returning({ id: schema.expenses.id });

    await database.db.insert(schema.allocations).values({
      expenseId: expense!.id,
      method: 'equal',
      decidedAt: new Date(),
      decidedBy: 'manual',
    });

    const error = await captureError(() =>
      database.db.insert(schema.allocations).values({
        expenseId: expense!.id,
        method: 'exact',
        decidedAt: new Date(),
        decidedBy: 'manual',
      }),
    );

    expect(error.message).toMatch(/allocations_one_current_per_expense/);
  });

  it('allows many superseded allocations alongside one current one', async () => {
    const scaffold = await seedScaffold();
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        amount: 90000n,
        occurredAt: new Date(),
        relationshipType: 'household_shared_flat',
        paidByPersonId: scaffold.personId,
      })
      .returning({ id: schema.expenses.id });

    await database.db.insert(schema.allocations).values([
      {
        expenseId: expense!.id,
        method: 'equal',
        decidedAt: new Date('2026-07-08T18:00:00Z'),
        decidedBy: 'manual',
        supersededAt: new Date('2026-07-09T08:00:00Z'),
      },
      {
        expenseId: expense!.id,
        method: 'equal',
        decidedAt: new Date('2026-07-09T08:00:00Z'),
        decidedBy: 'manual',
      },
    ]);

    const rows = await database.db.select({ id: schema.allocations.id }).from(schema.allocations);

    expect(rows).toHaveLength(2);
  });

  it('allows one expansion row per person per group line, and no duplicates', async () => {
    const scaffold = await seedScaffold();
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        amount: 210000n,
        occurredAt: new Date(),
        relationshipType: 'household_shared_flat',
        paidByPersonId: scaffold.personId,
      })
      .returning({ id: schema.expenses.id });
    const [group] = await database.db
      .insert(schema.groups)
      .values({ name: 'Flat', type: 'flat' })
      .returning({ id: schema.groups.id });
    const [allocation] = await database.db
      .insert(schema.allocations)
      .values({
        expenseId: expense!.id,
        method: 'equal',
        decidedAt: new Date(),
        decidedBy: 'manual',
      })
      .returning({ id: schema.allocations.id });
    const [line] = await database.db
      .insert(schema.allocationLines)
      .values({
        allocationId: allocation!.id,
        beneficiaryType: 'group',
        beneficiaryId: group!.id,
        amount: 210000n,
      })
      .returning({ id: schema.allocationLines.id });

    await database.db
      .insert(schema.allocationLineGroupExpansions)
      .values({ allocationLineId: line!.id, personId: scaffold.personId, amount: 70000n });

    const error = await captureError(() =>
      database.db
        .insert(schema.allocationLineGroupExpansions)
        .values({ allocationLineId: line!.id, personId: scaffold.personId, amount: 70000n }),
    );

    expect(error.message).toMatch(/allocation_line_group_expansions_unique/);
  });

  it('links a payment to a given expense at most once', async () => {
    const scaffold = await seedScaffold();
    const [payment] = await database.db
      .insert(schema.payments)
      .values({
        accountId: scaffold.accountId,
        importBatchId: scaffold.importBatchId,
        amount: 124000n,
        direction: 'debit',
        occurredAt: new Date(),
        rawDescription: 'BLINKIT',
        channel: 'upi',
      })
      .returning({ id: schema.payments.id });
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        amount: 124000n,
        occurredAt: new Date(),
        relationshipType: 'personal',
        paidByPersonId: scaffold.personId,
      })
      .returning({ id: schema.expenses.id });

    await database.db
      .insert(schema.paymentExpenseLinks)
      .values({ paymentId: payment!.id, expenseId: expense!.id, amount: 124000n });

    const error = await captureError(() =>
      database.db
        .insert(schema.paymentExpenseLinks)
        .values({ paymentId: payment!.id, expenseId: expense!.id, amount: 1n }),
    );

    expect(error.message).toMatch(/payment_expense_links_unique/);
  });

  it('maps at most one Person to a given User login', async () => {
    const scaffold = await seedScaffold();
    const error = await captureError(() =>
      database.db
        .insert(schema.people)
        .values({ displayName: 'Impostor', linkedUserId: scaffold.userId }),
    );

    expect(error.message).toMatch(/people_linked_user_id_unique/);
  });

  it('allows many people with no login at all', async () => {
    await seedScaffold();
    await database.db
      .insert(schema.people)
      .values([{ displayName: 'Flatmate A' }, { displayName: 'Friend A' }]);

    const rows = await database.db.select({ id: schema.people.id }).from(schema.people);

    expect(rows).toHaveLength(3);
  });

  it('detects a re-imported file by content hash', async () => {
    await database.db
      .insert(schema.importBatches)
      .values({ sourceChannel: 'bank_csv', contentHash: 'sha256:abc' });

    const error = await captureError(() =>
      database.db
        .insert(schema.importBatches)
        .values({ sourceChannel: 'bank_csv', contentHash: 'sha256:abc' }),
    );

    expect(error.message).toMatch(/content_hash|unique/i);
  });
});

describe('the settlement table structurally cannot carry an allocation (invariant #9a)', () => {
  it('has no allocation_id column at all', async () => {
    const rows = await query<{ column_name: string }>(
      database.db,
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'settlements'`,
    );
    const columns = rows.map((row) => row.column_name);

    expect(columns).not.toContain('allocation_id');
    expect(columns).toEqual(
      expect.arrayContaining(['payment_id', 'counterparty_person_id', 'amount', 'recorded_at']),
    );
  });

  it('does not store direction, which is read from the linked payment', async () => {
    const rows = await query<{ column_name: string }>(
      database.db,
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'settlements'`,
    );

    expect(rows.map((row) => row.column_name)).not.toContain('direction');
  });
});

describe('write-once tables carry no updated_at column', () => {
  it.each(['payments', 'evidence', 'import_batches', 'allocation_line_group_expansions'])(
    '%s has no updated_at',
    async (tableName) => {
      const rows = await query<{ column_name: string }>(
        database.db,
        sql`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = ${tableName}`,
      );

      expect(rows.map((row) => row.column_name)).not.toContain('updated_at');
    },
  );
});
