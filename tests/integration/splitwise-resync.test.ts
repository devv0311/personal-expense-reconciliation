/**
 * Repairing a Splitwise row this ledger has moved on from (ADR-0055).
 *
 * The behaviour under test is one sentence long: **the entry the other person is looking at is
 * the entry that changes.** Everything below is a way of holding that sentence to account — the
 * id must not move, a port that cannot edit in place must refuse rather than create a second
 * entry, a refusal must leave both ledgers exactly as they were, and the one deletion this
 * system performs must happen only where leaving the entry would assert a debt that no longer
 * exists.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { BeneficiaryRef, ExpenseId, PersonId, SettlementId } from '../../src/domain/index.js';
import {
  getSplitwiseExpenseByExpenseId,
  getSplitwiseSettlementBySettlementId,
  markSplitwiseSettlementDrifted,
  schema,
} from '../../src/db/index.js';
import {
  approveAllocation,
  connectSplitwiseIntegration,
  describeSplitwiseRepairCapability,
  distributeAdjustment,
  listResyncCandidates,
  listSettlementResyncCandidates,
  recordExpenseAdjustment,
  recordSettlement,
  resyncExpenseToSplitwise,
  resyncSettlementToSplitwise,
  reverseExpenseAdjustment,
  syncExpenseToSplitwise,
  syncSettlementToSplitwise,
  transitionExpense,
} from '../../src/services/index.js';
import { ServiceError } from '../../src/services/errors.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createFirstSyncOnlySplitwisePort, createMockSplitwisePort } from '../support/splitwise.js';

const AS_USER = { actor: 'user', source: 'tests/integration/splitwise-resync' } as const;
const OCCURRED_AT = new Date('2026-07-10T19:20:00.000Z');
const REASON = 'Half the order was refunded; their share is lower than what was pushed.';

let database: TestDatabase;
let cast: Cast;
let splitwise: ReturnType<typeof createMockSplitwisePort>;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  splitwise = createMockSplitwisePort();
  await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
  await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
  await linkSplitwiseUser(cast.person['person_friend_a']!, 'sw-friend-a');
});

async function linkSplitwiseUser(personId: PersonId, splitwiseUserId: string): Promise<void> {
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId })
    .where(eq(schema.people.id, personId));
}

/** A ₹900 dinner split two ways and already pushed to Splitwise as `sw-expense-1`. */
async function syncedDinner(amount = 90_000n): Promise<ExpenseId> {
  const beneficiaries: BeneficiaryRef[] = [
    { type: 'person', id: cast.userPersonId },
    { type: 'person', id: cast.person['person_friend_a']! },
  ];
  const expenseId = await addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(amount),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
  await approveAllocation(database.db, {
    expenseId,
    decision: { method: 'equal', beneficiaries },
    decidedBy: 'manual',
    audit: AS_USER,
  });
  await transitionExpense(database.db, { expenseId, to: 'ready_to_sync', audit: AS_USER });
  await syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER });
  return expenseId;
}

/** Records a refund and distributes it, which is what actually marks the sync row `stale`. */
async function refund(expenseId: ExpenseId, amount: bigint): Promise<void> {
  await recordExpenseAdjustment(database.db, {
    expenseId,
    kind: 'merchant_refund',
    amount: paise(amount),
    occurredAt: new Date('2026-07-14T09:00:00.000Z'),
    audit: AS_USER,
  });
  await distributeAdjustment(database.db, { expenseId, audit: AS_USER });
}

describe('resyncExpenseToSplitwise', () => {
  it('corrects the entry Splitwise already holds, at the same id, and creates nothing', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 30_000n);

    const result = await resyncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      reason: REASON,
      audit: AS_USER,
    });

    expect(result.repair).toBe('corrected');
    expect(result.syncStatus).toBe('synced');
    // The whole point: the id does not move, and no second entry appears in their ledger.
    expect(result.splitwiseExpenseId).toBe('sw-expense-1');
    expect(result.previousExternalId).toBe('sw-expense-1');
    expect(splitwise.createdExpenses).toHaveLength(1); // the original first sync, and nothing since
    expect(splitwise.updatedExpenses).toHaveLength(1);
    expect(splitwise.deletedEntries).toHaveLength(0);
  });

  it('pushes the current net and the rebuilt shares, never the gross figure', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 30_000n);

    const result = await resyncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      reason: REASON,
      audit: AS_USER,
    });

    expect(result.pushedNetAmount).toBe('60000');
    expect(splitwise.updatedExpenses[0]).toMatchObject({
      splitwiseExpenseId: 'sw-expense-1',
      amount: 60_000n,
      paidBySplitwiseUserId: 'sw-dev',
    });
    // ₹600 split equally between two people, from the superseding allocation — not ₹450 each.
    // Compared as a set: the allocation's lines come back in no guaranteed order, and which
    // beneficiary occupies `users__0__` in Splitwise's wire format carries no meaning.
    expect([...(splitwise.updatedExpenses[0]?.shares ?? [])]).toEqual(
      expect.arrayContaining([
        { splitwiseUserId: 'sw-dev', owedAmount: 30_000n },
        { splitwiseUserId: 'sw-friend-a', owedAmount: 30_000n },
      ]),
    );
    expect(splitwise.updatedExpenses[0]?.shares).toHaveLength(2);
  });

  it('records the correction against the same row, with the reason and what stood before', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 30_000n);
    await resyncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      reason: REASON,
      audit: AS_USER,
    });

    const link = await getSplitwiseExpenseByExpenseId(database.db, expenseId);
    expect(link?.syncStatus).toBe('synced');

    const [row] = await database.db
      .select()
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    expect(row?.splitwiseExpenseId).toBe('sw-expense-1');
    expect(row?.ourSnapshot).toMatchObject({
      netAmount: '60000',
      repair: 'corrected',
      previousExternalId: 'sw-expense-1',
      correctionReason: REASON,
    });

    const events = await database.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'splitwise_expense'));
    const correction = events.find((event) => event.reason === REASON);
    expect(correction?.oldValue).toMatchObject({ syncStatus: 'stale' });
    expect(correction?.newValue).toMatchObject({ syncStatus: 'synced' });
  });

  it('withdraws the entry when the net reaches zero, rather than leaving a debt standing', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 90_000n);

    const result = await resyncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      reason: 'The whole order was refunded.',
      audit: AS_USER,
    });

    expect(result.repair).toBe('withdrawn');
    expect(result.syncStatus).toBe('withdrawn');
    expect(splitwise.deletedEntries).toEqual([{ splitwiseEntryId: 'sw-expense-1' }]);
    expect(splitwise.updatedExpenses).toHaveLength(0);

    // The external id survives the withdrawal: an audit that could no longer see the entry it
    // once matched could not explain its own past findings.
    const [row] = await database.db
      .select()
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    expect(row?.splitwiseExpenseId).toBe('sw-expense-1');
    expect(row?.syncStatus).toBe('withdrawn');
  });

  it('refuses a second withdrawal: nothing is standing and nothing is left to assert', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 90_000n);
    await resyncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      reason: 'The whole order was refunded.',
      audit: AS_USER,
    });

    await expect(
      resyncExpenseToSplitwise(database.db, {
        expenseId,
        splitwise,
        reason: 'Again.',
        audit: AS_USER,
      }),
    ).rejects.toThrow(/already been withdrawn/);
    expect(splitwise.deletedEntries).toHaveLength(1);
  });

  it('recreates the entry when a withdrawn expense’s net comes back off zero', async () => {
    const expenseId = await syncedDinner();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(90_000n),
      occurredAt: new Date('2026-07-14T09:00:00.000Z'),
      audit: AS_USER,
    });
    const distributed = await distributeAdjustment(database.db, { expenseId, audit: AS_USER });
    expect(distributed.netAmount).toBe(0n);
    await resyncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      reason: 'The whole order was refunded.',
      audit: AS_USER,
    });

    // The refund was recorded against the wrong expense and is reversed; the dinner is owed
    // again, and Splitwise has nothing standing for it.
    const adjustments = await database.db
      .select()
      .from(schema.expenseAdjustments)
      .where(eq(schema.expenseAdjustments.originalExpenseId, expenseId));
    await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustments[0]!.id),
      reason: 'That refund belonged to a different order.',
      audit: AS_USER,
    });
    // Explicit weights, because every current line is zero and a fully-refunded allocation
    // holds no proportion to rebuild by (ADR-0013). The domain refuses to guess; the test says
    // out loud that this was an equal split.
    await distributeAdjustment(database.db, {
      expenseId,
      customWeights: [1n, 1n],
      audit: AS_USER,
    });

    const candidates = await listResyncCandidates(database.db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      syncStatus: 'withdrawn',
      currentNetAmount: '90000',
      plannedRepair: 'recreated',
    });

    const result = await resyncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      reason: 'Putting back the entry this ledger withdrew in error.',
      audit: AS_USER,
    });

    expect(result.repair).toBe('recreated');
    expect(result.syncStatus).toBe('synced');
    expect(result.splitwiseExpenseId).toBe('sw-expense-2');
    expect(result.previousExternalId).toBe('sw-expense-1');
    expect(splitwise.updatedExpenses).toHaveLength(0);
  });

  it('refuses, by name, when the adapter cannot correct an entry in place', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 30_000n);
    const firstSyncOnly = createFirstSyncOnlySplitwisePort();

    await expect(
      resyncExpenseToSplitwise(database.db, {
        expenseId,
        splitwise: firstSyncOnly,
        reason: REASON,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/updateExpense/);

    // The refusal is the feature: this port wrote nothing at all into somebody else's ledger,
    // where the version this replaced would have created a second entry through exactly it.
    expect(firstSyncOnly.createdExpenses).toHaveLength(0);
    const link = await getSplitwiseExpenseByExpenseId(database.db, expenseId);
    expect(link?.syncStatus).toBe('stale');
  });

  it('refuses to record a correction Splitwise answered with a different id', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 30_000n);
    splitwise.answerNextUpdateWithDifferentId('sw-expense-99');

    await expect(
      resyncExpenseToSplitwise(database.db, {
        expenseId,
        splitwise,
        reason: REASON,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/duplicate rather than a correction/);

    const [row] = await database.db
      .select()
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    expect(row?.splitwiseExpenseId).toBe('sw-expense-1');
    expect(row?.syncStatus).toBe('stale');
  });

  it('leaves both ledgers untouched when Splitwise refuses', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 30_000n);
    splitwise.failNextUpdateExpense('502 Bad Gateway');

    await expect(
      resyncExpenseToSplitwise(database.db, {
        expenseId,
        splitwise,
        reason: REASON,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/502 Bad Gateway/);

    const link = await getSplitwiseExpenseByExpenseId(database.db, expenseId);
    expect(link?.syncStatus).toBe('stale');
    const candidates = await listResyncCandidates(database.db);
    expect(candidates).toHaveLength(1);
  });

  it('refuses a row the two ledgers already agree about', async () => {
    const expenseId = await syncedDinner();

    await expect(
      resyncExpenseToSplitwise(database.db, {
        expenseId,
        splitwise,
        reason: REASON,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/already agree/);
    expect(splitwise.updatedExpenses).toHaveLength(0);
  });

  it('requires a reason before touching somebody else’s ledger', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 30_000n);

    await expect(
      resyncExpenseToSplitwise(database.db, {
        expenseId,
        splitwise,
        reason: '   ',
        audit: AS_USER,
      }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(splitwise.updatedExpenses).toHaveLength(0);
  });
});

describe('listResyncCandidates', () => {
  it('lists a stale row with the figure a repair would push, and excludes agreeing rows', async () => {
    const agreed = await syncedDinner();
    expect(await listResyncCandidates(database.db)).toHaveLength(0);

    await refund(agreed, 30_000n);
    const candidates = await listResyncCandidates(database.db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      syncStatus: 'stale',
      externalId: 'sw-expense-1',
      currentNetAmount: '60000',
      description: 'Group dinner',
      plannedRepair: 'corrected',
    });
  });

  it('says what repairing each row would do, so a screen never has to work it out', async () => {
    const corrected = await syncedDinner();
    await refund(corrected, 30_000n);
    const emptied = await syncedDinner(50_000n);
    await refund(emptied, 50_000n);

    const candidates = await listResyncCandidates(database.db);
    const byExpense = new Map(candidates.map((row) => [row.expenseId, row.plannedRepair]));
    expect(byExpense.get(corrected)).toBe('corrected');
    // Nothing in the browser decides that a zero net means a deletion; this read does.
    expect(byExpense.get(emptied)).toBe('withdrawn');
  });

  it('does not list a withdrawn row that still nets to zero', async () => {
    const expenseId = await syncedDinner();
    await refund(expenseId, 90_000n);
    await resyncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      reason: 'Fully refunded.',
      audit: AS_USER,
    });

    expect(await listResyncCandidates(database.db)).toHaveLength(0);
  });
});

describe('describeSplitwiseRepairCapability', () => {
  it('reports what the injected port can actually do', () => {
    expect(describeSplitwiseRepairCapability(splitwise)).toEqual({
      canCorrect: true,
      canWithdraw: true,
      canCorrectSettlement: true,
    });
    expect(describeSplitwiseRepairCapability(createFirstSyncOnlySplitwisePort())).toEqual({
      canCorrect: false,
      canWithdraw: false,
      canCorrectSettlement: false,
    });
  });
});

describe('resyncSettlementToSplitwise', () => {
  async function driftedSettlement(): Promise<SettlementId> {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(50_000n),
      direction: 'debit',
      occurredAt: OCCURRED_AT,
      rawDescription: 'UPI-FRIENDA-TRANSFER',
      channel: 'upi',
      state: 'normalized',
    });
    const { settlementId } = await recordSettlement(database.db, {
      paymentId,
      counterpartyPersonId: cast.person['person_friend_a']!,
      amount: paise(50_000n),
      audit: AS_USER,
    });
    const id = asId<'settlement'>(settlementId);
    await syncSettlementToSplitwise(database.db, { settlementId: id, splitwise, audit: AS_USER });
    const link = await getSplitwiseSettlementBySettlementId(database.db, id);
    await markSplitwiseSettlementDrifted(database.db, link!.id);
    return id;
  }

  it('corrects the settlement in place, at the same id', async () => {
    const settlementId = await driftedSettlement();

    const result = await resyncSettlementToSplitwise(database.db, {
      settlementId,
      splitwise,
      reason: 'Splitwise shows a different figure for this transfer.',
      audit: AS_USER,
    });

    expect(result.syncStatus).toBe('synced');
    expect(result.splitwiseTransactionId).toBe('sw-payment-1');
    expect(result.pushedAmount).toBe('50000');
    // Direction comes from the payment, via domain.settlementParties — a debit means the user
    // paid the friend, and correcting it must never quietly reverse that.
    expect(splitwise.updatedPayments).toEqual([
      {
        splitwiseTransactionId: 'sw-payment-1',
        amount: 50_000n,
        fromSplitwiseUserId: 'sw-dev',
        toSplitwiseUserId: 'sw-friend-a',
      },
    ]);
    expect(splitwise.recordedPayments).toHaveLength(1); // the original sync, and nothing since
  });

  it('lists a drifted settlement as a candidate, and stops listing it once repaired', async () => {
    const settlementId = await driftedSettlement();
    const before = await listSettlementResyncCandidates(database.db);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      syncStatus: 'drifted',
      externalId: 'sw-payment-1',
      currentAmount: '50000',
      counterpartyName: 'Friend A',
    });

    await resyncSettlementToSplitwise(database.db, {
      settlementId,
      splitwise,
      reason: 'Splitwise shows a different figure for this transfer.',
      audit: AS_USER,
    });

    expect(await listSettlementResyncCandidates(database.db)).toHaveLength(0);
  });

  it('refuses by name when the adapter cannot correct a settlement in place', async () => {
    const settlementId = await driftedSettlement();

    await expect(
      resyncSettlementToSplitwise(database.db, {
        settlementId,
        splitwise: createFirstSyncOnlySplitwisePort(),
        reason: 'Splitwise shows a different figure.',
        audit: AS_USER,
      }),
    ).rejects.toThrow(/updatePayment/);
  });

  it('leaves the row drifted when Splitwise refuses', async () => {
    const settlementId = await driftedSettlement();
    splitwise.failNextUpdatePayment('429 Too Many Requests');

    await expect(
      resyncSettlementToSplitwise(database.db, {
        settlementId,
        splitwise,
        reason: 'Splitwise shows a different figure.',
        audit: AS_USER,
      }),
    ).rejects.toThrow(/429 Too Many Requests/);

    const link = await getSplitwiseSettlementBySettlementId(database.db, settlementId);
    expect(link?.syncStatus).toBe('drifted');
  });
});
