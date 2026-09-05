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

/** One imported payment, for the polymorphic references that name one without a foreign key. */
async function seedPayment(): Promise<string> {
  const scaffold = await seedScaffold();
  const [payment] = await database.db
    .insert(schema.payments)
    .values({
      accountId: scaffold.accountId,
      importBatchId: scaffold.importBatchId,
      amount: 124000n,
      direction: 'debit',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'upi',
    })
    .returning({ id: schema.payments.id });
  return payment!.id;
}

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
        storageRef: `sha256/${'a'.repeat(64)}.jpg`,
        mediaType: 'image/jpeg',
        byteSize: 20_481,
        capturedAt: new Date(),
        noteKind: 'settlement_claim',
      }),
    );

    expect(error.message).toMatch(/evidence_note_kind_only_on_notes_check/);
  });

  it('rejects an unknown note kind', async () => {
    const error = await captureError(() =>
      database.db.execute(
        sql`insert into evidence (type, captured_at, raw_text, note_kind)
            values ('manual_note', now(), 'they said it was settled', 'probably_settled')`,
      ),
    );

    expect(error.message).toMatch(/evidence_note_kind_check/);
  });

  it('accepts the rejected expense state, and still refuses an invented one', async () => {
    const scaffold = await seedScaffold();

    const [row] = await database.db
      .insert(schema.expenses)
      .values({
        amount: 124_000n,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
        relationshipType: 'personal',
        paidByPersonId: scaffold.personId,
        state: 'rejected',
      })
      .returning({ state: schema.expenses.state });
    expect(row?.state).toBe('rejected');

    const error = await captureError(() =>
      database.db.execute(
        sql`insert into expenses (amount, occurred_at, relationship_type, paid_by_person_id, state)
            values (100, now(), 'personal', ${scaffold.personId}, 'dismissed')`,
      ),
    );
    expect(error.message).toMatch(/expenses_state_check/);
  });

  it('rejects an inference type no ai-boundary.md operation produces', async () => {
    const paymentId = await seedPayment();
    const error = await captureError(() =>
      database.db.execute(
        sql`insert into ai_inferences (inference_type, input_ref_type, input_ref_id,
                                       proposed_output, confidence)
            values ('guess_the_amount', 'payment', ${paymentId}, '{}'::jsonb, 'high')`,
      ),
    );

    expect(error.message).toMatch(/ai_inferences_inference_type_check/);
  });

  it('accepts the classification inference type phase 8 produces', async () => {
    const paymentId = await seedPayment();

    const [row] = await database.db
      .insert(schema.aiInferences)
      .values({
        inferenceType: 'classify_transaction',
        inputRefType: 'payment',
        inputRefId: paymentId,
        proposedOutput: { proposedKind: 'expense' },
        confidence: 'high',
      })
      .returning({ status: schema.aiInferences.status });

    // `pending` by default: an inference is a proposal until decideInference says otherwise.
    expect(row?.status).toBe('pending');
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

describe('evidence rows must carry the evidence they claim to', () => {
  const storedReceipt = {
    type: 'receipt_image' as const,
    storageRef: `sha256/${'c'.repeat(64)}.jpg`,
    mediaType: 'image/jpeg',
    byteSize: 20_481,
    capturedAt: new Date('2026-07-12T20:00:00Z'),
  };

  it('accepts a stored document described in full', async () => {
    const [row] = await database.db
      .insert(schema.evidence)
      .values(storedReceipt)
      .returning({ mediaType: schema.evidence.mediaType, byteSize: schema.evidence.byteSize });

    expect(row).toEqual({ mediaType: 'image/jpeg', byteSize: 20_481 });
  });

  it.each([
    ['a document with no media type', { mediaType: null }],
    ['a document with no byte size', { byteSize: null }],
    ['a media type describing a file that was never stored', { storageRef: null }],
  ])('rejects %s', async (_label, override) => {
    const error = await captureError(() =>
      database.db.insert(schema.evidence).values({ ...storedReceipt, ...override }),
    );

    expect(error.message).toMatch(/evidence_stored_document_check|evidence_content_present_check/);
  });

  it('rejects a media type this system does not store', async () => {
    const error = await captureError(() =>
      database.db
        .insert(schema.evidence)
        .values({ ...storedReceipt, mediaType: 'application/octet-stream' }),
    );

    expect(error.message).toMatch(/evidence_media_type_check/);
  });

  it('rejects an empty file, which is a failed upload rather than evidence', async () => {
    const error = await captureError(() =>
      database.db.insert(schema.evidence).values({ ...storedReceipt, byteSize: 0 }),
    );

    expect(error.message).toMatch(/evidence_byte_size_check/);
  });

  it('rejects a row with neither a document nor text', async () => {
    const error = await captureError(() =>
      database.db.insert(schema.evidence).values({
        type: 'screenshot',
        capturedAt: new Date(),
      }),
    );

    expect(error.message).toMatch(/evidence_content_present_check/);
  });

  it('rejects a manual note carrying a file — that is a receipt_image', async () => {
    const error = await captureError(() =>
      database.db.insert(schema.evidence).values({
        type: 'manual_note',
        noteKind: 'documentation',
        rawText: 'photo of the bill',
        storageRef: storedReceipt.storageRef,
        mediaType: 'image/jpeg',
        byteSize: 20_481,
        capturedAt: new Date(),
      }),
    );

    expect(error.message).toMatch(/evidence_note_has_no_document_check/);
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

/* ==================================== Phase 16 — ADR-0017 (cash balance) / ADR-0018 */

/** A run to hang account snapshots off. Its own totals satisfy invariant #20 trivially. */
async function seedReconciliationRun(): Promise<string> {
  const [row] = await database.db
    .insert(schema.reconciliationRuns)
    .values({
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-07-31T00:00:00Z'),
      ledgerTotalOutflow: 0n,
      ledgerTransfersTotal: 0n,
      ledgerInvestmentsTotal: 0n,
      ledgerSettlementsTotal: 0n,
      ledgerExplainedTotal: 0n,
      ledgerUnexplainedTotal: 0n,
    })
    .returning({ id: schema.reconciliationRuns.id });
  return row!.id;
}

/** One statement-balance evidence row, so a boundary can cite something immutable. */
async function seedStatementEvidence(): Promise<string> {
  const [row] = await database.db
    .insert(schema.evidence)
    .values({
      type: 'bank_line',
      rawText: 'Closing balance as on 31 Jul 2026: 5,000.00',
      capturedAt: new Date('2026-08-01T00:00:00Z'),
    })
    .returning({ id: schema.evidence.id });
  return row!.id;
}

interface SnapshotOverrides {
  [column: string]: unknown;
}

async function insertSnapshot(overrides: SnapshotOverrides = {}): Promise<void> {
  const scaffold = await seedScaffold();
  const runId = await seedReconciliationRun();
  await database.db.insert(schema.reconciliationAccountSnapshots).values({
    reconciliationRunId: runId,
    accountId: scaffold.accountId,
    periodStart: new Date('2026-07-01T00:00:00Z'),
    periodEnd: new Date('2026-08-01T00:00:00Z'),
    totalDebits: 0n,
    totalCredits: 0n,
    internalTransferDebits: 0n,
    internalTransferCredits: 0n,
    explainedDebits: 0n,
    unexplainedDebits: 0n,
    explainedCredits: 0n,
    unexplainedCredits: 0n,
    verificationStatus: 'incomplete',
    ...overrides,
  } as never);
}

describe('payments.cash_flow_category (ADR-0017 (cash balance), 17.2)', () => {
  async function insertPayment(overrides: SnapshotOverrides = {}): Promise<void> {
    const scaffold = await seedScaffold();
    await database.db.insert(schema.payments).values({
      accountId: scaffold.accountId,
      importBatchId: scaffold.importBatchId,
      amount: 124000n,
      direction: 'debit',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      rawDescription: 'UPI-BLINKIT9821PAYTM',
      channel: 'upi',
      ...overrides,
    } as never);
  }

  it('backfills every existing payment to the start of the cash-flow lifecycle', async () => {
    await insertPayment();

    const rows = await query<{ cash_flow_state: string; cash_flow_category: string | null }>(
      database.db,
      sql`select cash_flow_state, cash_flow_category from payments`,
    );

    // Conservative by design: a payment the ledger already explained is not thereby cash-flow
    // approved, and an approval is never guessed from `linked` or from model confidence.
    expect(rows[0]?.cash_flow_state).toBe('imported');
    expect(rows[0]?.cash_flow_category).toBeNull();
  });

  it('rejects a category outside the four ADR-0017 names', async () => {
    const error = await captureError(() =>
      insertPayment({ cashFlowCategory: 'INCOME', cashFlowState: 'cash_flow_classified' }),
    );

    expect(error.message).toContain('payments_cash_flow_category_check');
  });

  it('rejects a debit refund — arithmetically impossible, not a judgement call', async () => {
    const error = await captureError(() =>
      insertPayment({
        direction: 'debit',
        cashFlowCategory: 'REFUND',
        cashFlowState: 'cash_flow_classified',
      }),
    );

    expect(error.message).toContain('payments_cash_flow_direction_check');
  });

  it('rejects a debit external inflow', async () => {
    const error = await captureError(() =>
      insertPayment({
        direction: 'debit',
        cashFlowCategory: 'EXTERNAL_INFLOW',
        cashFlowState: 'cash_flow_classified',
      }),
    );

    expect(error.message).toContain('payments_cash_flow_direction_check');
  });

  it('accepts a peer settlement in either direction', async () => {
    for (const direction of ['debit', 'credit'] as const) {
      await database.truncateAll();
      await insertPayment({
        direction,
        cashFlowCategory: 'PEER_SETTLEMENT',
        cashFlowState: 'cash_flow_classified',
      });

      const rows = await query<{ count: string }>(
        database.db,
        sql`select count(*)::text as count from payments`,
      );
      expect(rows[0]?.count).toBe('1');
    }
  });

  it('refuses a category on a row that has not reached the classified state', async () => {
    const error = await captureError(() =>
      insertPayment({ direction: 'credit', cashFlowCategory: 'EXTERNAL_INFLOW' }),
    );

    expect(error.message).toContain('payments_cash_flow_category_state_check');
  });

  it('refuses to approve a credit with no category — unexplained, not income', async () => {
    const error = await captureError(() =>
      insertPayment({
        direction: 'credit',
        cashFlowState: 'approved',
        cashFlowApprovedAt: new Date('2026-08-01T00:00:00Z'),
        cashFlowApprovedBy: 'user',
      }),
    );

    expect(error.message).toContain('payments_cash_flow_approved_credit_check');
  });

  it('approves an ordinary debit with no category at all', async () => {
    await insertPayment({
      cashFlowState: 'approved',
      cashFlowApprovedAt: new Date('2026-08-01T00:00:00Z'),
      cashFlowApprovedBy: 'user',
    });

    const rows = await query<{ cash_flow_state: string }>(
      database.db,
      sql`select cash_flow_state from payments`,
    );
    expect(rows[0]?.cash_flow_state).toBe('approved');
  });

  it('refuses to approve a peer settlement whose counterparty is not a person', async () => {
    const error = await captureError(() =>
      insertPayment({
        direction: 'credit',
        counterpartyType: 'unknown',
        cashFlowCategory: 'PEER_SETTLEMENT',
        cashFlowState: 'approved',
        cashFlowApprovedAt: new Date('2026-08-01T00:00:00Z'),
        cashFlowApprovedBy: 'user',
      }),
    );

    expect(error.message).toContain('payments_cash_flow_approved_counterparty_check');
  });

  it('refuses to approve an internal transfer whose counterparty is not an owned account', async () => {
    const error = await captureError(() =>
      insertPayment({
        counterpartyType: 'merchant',
        cashFlowCategory: 'INTERNAL_TRANSFER',
        cashFlowState: 'approved',
        cashFlowApprovedAt: new Date('2026-08-01T00:00:00Z'),
        cashFlowApprovedBy: 'user',
      }),
    );

    expect(error.message).toContain('payments_cash_flow_approved_counterparty_check');
  });

  it('allows an unresolved counterparty while the role is still a proposal', async () => {
    // "An unresolved counterparty is allowed during normalization" — the counterparty rules
    // are approval gates, and demanding one earlier would make the rows that most need a
    // proposal the ones that cannot have one.
    await insertPayment({
      counterpartyType: 'unknown',
      direction: 'credit',
      cashFlowCategory: 'PEER_SETTLEMENT',
      cashFlowState: 'cash_flow_classified',
    });

    const rows = await query<{ count: string }>(
      database.db,
      sql`select count(*)::text as count from payments`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('refuses an approved role with no actor behind it', async () => {
    const error = await captureError(() =>
      insertPayment({ cashFlowState: 'approved', cashFlowApprovedAt: new Date() }),
    );

    // An approved role with no actor is an unattributable financial decision.
    expect(error.message).toContain('payments_cash_flow_approval_provenance_check');
  });

  it('refuses approval provenance on a row that was never approved', async () => {
    const error = await captureError(() =>
      insertPayment({ cashFlowState: 'normalized', cashFlowApprovedBy: 'user' }),
    );

    expect(error.message).toContain('payments_cash_flow_approval_provenance_check');
  });
});

describe('expense_adjustment_items (ADR-0018 (item refunds))', () => {
  async function seedAdjustmentAndItem(): Promise<{ adjustmentId: string; itemId: string }> {
    const scaffold = await seedScaffold();
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        description: 'Blinkit basket',
        amount: 100000n,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
        relationshipType: 'shared',
        paidByPersonId: scaffold.personId,
        state: 'approved',
      })
      .returning({ id: schema.expenses.id });
    const [item] = await database.db
      .insert(schema.expenseItems)
      .values({ expenseId: expense!.id, description: 'Cold brew', amount: 40000n })
      .returning({ id: schema.expenseItems.id });
    const [adjustment] = await database.db
      .insert(schema.expenseAdjustments)
      .values({
        originalExpenseId: expense!.id,
        kind: 'merchant_refund',
        amount: 15000n,
        occurredAt: new Date('2026-07-05T00:00:00Z'),
      })
      .returning({ id: schema.expenseAdjustments.id });
    return { adjustmentId: adjustment!.id, itemId: item!.id };
  }

  it('accepts a positive attribution', async () => {
    const { adjustmentId, itemId } = await seedAdjustmentAndItem();

    await database.db
      .insert(schema.expenseAdjustmentItems)
      .values({ expenseAdjustmentId: adjustmentId, expenseItemId: itemId, amount: 15000n });

    const rows = await query<{ amount: string }>(
      database.db,
      sql`select amount::text from expense_adjustment_items`,
    );
    expect(rows[0]?.amount).toBe('15000');
  });

  it('rejects a zero attribution — an item refunded for nothing (19.4)', async () => {
    const { adjustmentId, itemId } = await seedAdjustmentAndItem();

    const error = await captureError(() =>
      database.db
        .insert(schema.expenseAdjustmentItems)
        .values({ expenseAdjustmentId: adjustmentId, expenseItemId: itemId, amount: 0n }),
    );

    expect(error.message).toContain('expense_adjustment_items_amount_check');
  });

  it('rejects a negative attribution — a clawback is new spend, not a signed row (19.4)', async () => {
    const { adjustmentId, itemId } = await seedAdjustmentAndItem();

    const error = await captureError(() =>
      database.db
        .insert(schema.expenseAdjustmentItems)
        .values({ expenseAdjustmentId: adjustmentId, expenseItemId: itemId, amount: -1n }),
    );

    expect(error.message).toContain('expense_adjustment_items_amount_check');
  });

  it('allows one row per (adjustment, item) pair and no duplicates', async () => {
    const { adjustmentId, itemId } = await seedAdjustmentAndItem();
    await database.db
      .insert(schema.expenseAdjustmentItems)
      .values({ expenseAdjustmentId: adjustmentId, expenseItemId: itemId, amount: 10000n });

    const error = await captureError(() =>
      database.db
        .insert(schema.expenseAdjustmentItems)
        .values({ expenseAdjustmentId: adjustmentId, expenseItemId: itemId, amount: 5000n }),
    );

    expect(error.message).toContain('expense_adjustment_items_unique');
  });

  it('rejects an attribution pointing at no adjustment', async () => {
    const { itemId } = await seedAdjustmentAndItem();

    const error = await captureError(() =>
      database.db.insert(schema.expenseAdjustmentItems).values({
        expenseAdjustmentId: '00000000-0000-4000-8000-000000000000',
        expenseItemId: itemId,
        amount: 1000n,
      }),
    );

    expect(error.message).toMatch(/expense_adjustment_id|foreign key/i);
  });

  it('stores an attribution above IEEE-754 integer precision without loss', async () => {
    const scaffold = await seedScaffold();
    const huge = 9007199254740993n; // 2^53 + 1
    const [expense] = await database.db
      .insert(schema.expenses)
      .values({
        description: 'A very large purchase',
        amount: huge,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
        relationshipType: 'personal',
        paidByPersonId: scaffold.personId,
        state: 'approved',
      })
      .returning({ id: schema.expenses.id });
    const [item] = await database.db
      .insert(schema.expenseItems)
      .values({ expenseId: expense!.id, description: 'The item', amount: huge })
      .returning({ id: schema.expenseItems.id });
    const [adjustment] = await database.db
      .insert(schema.expenseAdjustments)
      .values({
        originalExpenseId: expense!.id,
        kind: 'merchant_refund',
        amount: huge,
        occurredAt: new Date('2026-07-05T00:00:00Z'),
      })
      .returning({ id: schema.expenseAdjustments.id });

    await database.db.insert(schema.expenseAdjustmentItems).values({
      expenseAdjustmentId: adjustment!.id,
      expenseItemId: item!.id,
      amount: huge,
    });

    const rows = await database.db.select().from(schema.expenseAdjustmentItems);
    expect(rows[0]?.amount).toBe(huge);
  });
});

describe('reconciliation_account_snapshots (ADR-0017 (cash balance), 17.4-17.7)', () => {
  it('accepts an incomplete snapshot with no boundary evidence at all', async () => {
    await insertSnapshot();

    const rows = await query<{ verification_status: string }>(
      database.db,
      sql`select verification_status from reconciliation_account_snapshots`,
    );
    expect(rows[0]?.verification_status).toBe('incomplete');
  });

  it('rejects an inverted or empty period', async () => {
    const error = await captureError(() =>
      insertSnapshot({ periodEnd: new Date('2026-07-01T00:00:00Z') }),
    );

    expect(error.message).toContain('reconciliation_account_snapshots_period_check');
  });

  it('rejects a coverage total that does not add up (17.4)', async () => {
    const error = await captureError(() => insertSnapshot({ totalDebits: 100n }));

    expect(error.message).toContain('reconciliation_account_snapshots_coverage_check');
  });

  it('rejects an internal-transfer subtotal larger than its own total (17.3)', async () => {
    const error = await captureError(() => insertSnapshot({ internalTransferCredits: 1n }));

    expect(error.message).toContain('reconciliation_account_snapshots_transfer_subset_check');
  });

  it('rejects a negative movement total, while allowing a negative balance', async () => {
    const error = await captureError(() =>
      insertSnapshot({ totalCredits: -1n, explainedCredits: -1n }),
    );

    expect(error.message).toContain('reconciliation_account_snapshots_movement_sign_check');
  });

  it('rejects a balance that cites no evidence (17.5)', async () => {
    const error = await captureError(() => insertSnapshot({ openingBalance: 500000n }));

    expect(error.message).toContain('reconciliation_account_snapshots_boundary_evidence_check');
  });

  it('rejects a derived balance published without both boundaries (17.5)', async () => {
    const error = await captureError(() => insertSnapshot({ expectedEndingBalance: 0n }));

    expect(error.message).toContain('reconciliation_account_snapshots_derived_presence_check');
  });

  it('rejects an expected ending balance that contradicts the movements (17.4)', async () => {
    const evidenceId = await seedStatementEvidence();
    const error = await captureError(() =>
      insertSnapshot({
        openingBalance: 500000n,
        openingBalanceEvidenceId: evidenceId,
        closingBalance: 500000n,
        closingBalanceEvidenceId: evidenceId,
        expectedEndingBalance: 499999n,
        cashBalanceDelta: 1n,
        verificationStatus: 'unreconciled',
      }),
    );

    expect(error.message).toContain('reconciliation_account_snapshots_identity_check');
  });

  it('stores a signed overdraft and a signed delta without clamping (17.4)', async () => {
    const evidenceId = await seedStatementEvidence();
    await insertSnapshot({
      openingBalance: -50000n,
      openingBalanceEvidenceId: evidenceId,
      closingBalance: -150000n,
      closingBalanceEvidenceId: evidenceId,
      totalDebits: 90000n,
      explainedDebits: 90000n,
      expectedEndingBalance: -140000n,
      cashBalanceDelta: -10000n,
      verificationStatus: 'unreconciled',
    });

    const rows = await database.db.select().from(schema.reconciliationAccountSnapshots);
    expect(rows[0]?.openingBalance).toBe(-50000n);
    expect(rows[0]?.cashBalanceDelta).toBe(-10000n);
  });

  it('refuses to store a verified snapshot with a non-zero delta (17.6)', async () => {
    const evidenceId = await seedStatementEvidence();
    const error = await captureError(() =>
      insertSnapshot({
        openingBalance: 500000n,
        openingBalanceEvidenceId: evidenceId,
        closingBalance: 400000n,
        closingBalanceEvidenceId: evidenceId,
        expectedEndingBalance: 500000n,
        cashBalanceDelta: -100000n,
        verificationStatus: 'verified',
      }),
    );

    expect(error.message).toContain('reconciliation_account_snapshots_verified_check');
  });

  it('refuses to store a verified snapshot over unexplained movement (17.6)', async () => {
    const evidenceId = await seedStatementEvidence();
    const error = await captureError(() =>
      insertSnapshot({
        openingBalance: 500000n,
        openingBalanceEvidenceId: evidenceId,
        closingBalance: 400000n,
        closingBalanceEvidenceId: evidenceId,
        totalDebits: 100000n,
        unexplainedDebits: 100000n,
        expectedEndingBalance: 400000n,
        cashBalanceDelta: 0n,
        verificationStatus: 'verified',
      }),
    );

    // A numeric zero over transactions nobody has identified is not a verified
    // ₹0 Unaccounted Delta, and the database says so rather than trusting the caller.
    expect(error.message).toContain('reconciliation_account_snapshots_verified_check');
  });

  it('refuses to store a verified snapshot with an unresolved discrepancy (17.6)', async () => {
    const evidenceId = await seedStatementEvidence();
    const error = await captureError(() =>
      insertSnapshot({
        openingBalance: 500000n,
        openingBalanceEvidenceId: evidenceId,
        closingBalance: 500000n,
        closingBalanceEvidenceId: evidenceId,
        expectedEndingBalance: 500000n,
        cashBalanceDelta: 0n,
        verificationStatus: 'verified',
        discrepancies: [{ kind: 'unpaired_internal_transfer', detail: 'leg missing' }],
      }),
    );

    expect(error.message).toContain('reconciliation_account_snapshots_verified_check');
  });

  it('refuses to store a verified snapshot with no boundary evidence (17.5)', async () => {
    const error = await captureError(() => insertSnapshot({ verificationStatus: 'verified' }));

    expect(error.message).toContain('reconciliation_account_snapshots_verified_check');
  });

  it('refuses to file complete inputs as incomplete', async () => {
    const evidenceId = await seedStatementEvidence();
    const error = await captureError(() =>
      insertSnapshot({
        openingBalance: 500000n,
        openingBalanceEvidenceId: evidenceId,
        closingBalance: 400000n,
        closingBalanceEvidenceId: evidenceId,
        expectedEndingBalance: 500000n,
        cashBalanceDelta: -100000n,
        verificationStatus: 'incomplete',
      }),
    );

    expect(error.message).toContain('reconciliation_account_snapshots_incomplete_check');
  });

  it('accepts a fully verified snapshot', async () => {
    const evidenceId = await seedStatementEvidence();
    await insertSnapshot({
      openingBalance: 500000n,
      openingBalanceEvidenceId: evidenceId,
      closingBalance: 400000n,
      closingBalanceEvidenceId: evidenceId,
      totalDebits: 100000n,
      explainedDebits: 100000n,
      expectedEndingBalance: 400000n,
      cashBalanceDelta: 0n,
      verificationStatus: 'verified',
    });

    const rows = await database.db.select().from(schema.reconciliationAccountSnapshots);
    expect(rows[0]?.verificationStatus).toBe('verified');
    expect(rows[0]?.cashBalanceDelta).toBe(0n);
  });

  it('allows one snapshot per account per run and no second opinion', async () => {
    const scaffold = await seedScaffold();
    const runId = await seedReconciliationRun();
    const values = {
      reconciliationRunId: runId,
      accountId: scaffold.accountId,
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-08-01T00:00:00Z'),
      totalDebits: 0n,
      totalCredits: 0n,
      internalTransferDebits: 0n,
      internalTransferCredits: 0n,
      explainedDebits: 0n,
      unexplainedDebits: 0n,
      explainedCredits: 0n,
      unexplainedCredits: 0n,
      verificationStatus: 'incomplete',
    };
    await database.db.insert(schema.reconciliationAccountSnapshots).values(values);

    const error = await captureError(() =>
      database.db.insert(schema.reconciliationAccountSnapshots).values(values),
    );

    expect(error.message).toContain('reconciliation_account_snapshots_unique');
  });

  it('carries no updated_at — a snapshot is never edited, only superseded by a new run', async () => {
    const rows = await query<{ column_name: string }>(
      database.db,
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'reconciliation_account_snapshots'`,
    );

    expect(rows.map((row) => row.column_name)).not.toContain('updated_at');
  });

  it('leaves ADR-0016 legacy runs with no account snapshots at all', async () => {
    await seedReconciliationRun();

    const rows = await query<{ count: string }>(
      database.db,
      sql`select count(*)::text as count from reconciliation_account_snapshots`,
    );

    // An outflow-only run stays exactly what it was; it is never presented as verified cash
    // reconciliation, and no backfill certifies it retroactively (17.7).
    expect(rows[0]?.count).toBe('0');
  });
});
