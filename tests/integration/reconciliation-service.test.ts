/**
 * `services.runReconciliation`'s Splitwise drift detection (`docs/roadmap.md` phase 15,
 * ADR-0041). The outflow-only arithmetic itself is covered exhaustively elsewhere
 * (`tests/scenarios/adjustments-settlements-and-exclusions.test.ts`); this file covers what's
 * new: `fetchBalances`, comparison, `drifted`, and reconciliation history/read.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { BeneficiaryRef, ExpenseId, PersonId, SettlementId } from '../../src/domain/index.js';
import { listAuditEvents, schema } from '../../src/db/index.js';
import {
  approveAllocation,
  connectSplitwiseIntegration,
  getReconciliationRun,
  listReconciliationRunHistory,
  recordSettlement,
  runReconciliation,
  syncExpenseToSplitwise,
  syncSettlementToSplitwise,
  transitionExpense,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const AS_USER = { actor: 'user', source: 'tests/integration/reconciliation-service' } as const;
const OCCURRED_AT = new Date('2026-07-10T19:20:00.000Z');
const JULY = {
  periodStart: new Date('2026-07-01T00:00:00.000Z'),
  periodEnd: new Date('2026-08-01T00:00:00.000Z'),
};

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
});

async function linkSplitwiseUser(personId: PersonId, splitwiseUserId: string): Promise<void> {
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId })
    .where(eq(schema.people.id, personId));
}

async function readyToSyncExpense(input: {
  readonly amount: bigint;
  readonly beneficiaries: readonly BeneficiaryRef[];
}): Promise<ExpenseId> {
  const expenseId = await addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(input.amount),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
  await approveAllocation(database.db, {
    expenseId,
    decision: { method: 'equal', beneficiaries: input.beneficiaries },
    decidedBy: 'manual',
    audit: AS_USER,
  });
  await transitionExpense(database.db, { expenseId, to: 'ready_to_sync', audit: AS_USER });
  return expenseId;
}

async function syncedExpenseWith(friendId: PersonId): Promise<ExpenseId> {
  const expenseId = await readyToSyncExpense({
    amount: 90_000n,
    beneficiaries: [
      { type: 'person', id: cast.userPersonId },
      { type: 'person', id: friendId },
    ],
  });
  await syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER });
  return expenseId;
}

async function syncedSettlementWith(friendId: PersonId): Promise<SettlementId> {
  const paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(50_000n),
    direction: 'debit',
    occurredAt: OCCURRED_AT,
    rawDescription: 'UPI-FRIEND-TRANSFER',
    channel: 'upi',
    state: 'normalized',
  });
  const { settlementId } = await recordSettlement(database.db, {
    paymentId,
    counterpartyPersonId: friendId,
    amount: paise(50_000n),
    audit: AS_USER,
  });
  await syncSettlementToSplitwise(database.db, {
    settlementId: settlementId as SettlementId,
    splitwise,
    audit: AS_USER,
  });
  return settlementId as SettlementId;
}

describe('runReconciliation — no Splitwise integration connected', () => {
  it('never calls fetchBalances, and stores no snapshot or discrepancies', async () => {
    let called = false;
    const watchedPort = {
      ...splitwise,
      fetchBalances: () => {
        called = true;
        return splitwise.fetchBalances();
      },
    };

    const result = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise: watchedPort,
      audit: AS_USER,
    });

    expect(called).toBe(false);
    expect(result.discrepancies).toEqual([]);
    const stored = await getReconciliationRun(
      database.db,
      asId<'reconciliation_run'>(result.reconciliationRunId),
    );
    expect(stored?.splitwiseBalancesSnapshot).toBeNull();
  });
});

describe('runReconciliation — Splitwise integration connected', () => {
  beforeEach(async () => {
    await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
    await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
    await linkSplitwiseUser(cast.person['person_friend_a']!, 'sw-friend-a');
  });

  it('records no discrepancy and drifts nothing when balances agree', async () => {
    const expenseId = await syncedExpenseWith(cast.person['person_friend_a']!);
    // The user paid 90,000 split evenly two ways: the friend owes 45,000.
    splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_000n) }]);

    const result = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    expect(result.discrepancies).toEqual([]);
    const [row] = await database.db
      .select({ syncStatus: schema.splitwiseExpenses.syncStatus })
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    expect(row?.syncStatus).toBe('synced');
  });

  it('surfaces a discrepancy and drifts a matching synced expense', async () => {
    const expenseId = await syncedExpenseWith(cast.person['person_friend_a']!);
    // We compute the friend owes 45,000 (positive owed-to-us convention is friend negative
    // from our netBalance perspective per computeNetBalance(user, friend)); Splitwise instead
    // reports 30,000 owed the other way — a real disagreement.
    splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(30_000n) }]);

    const result = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: 'splitwise_balance_mismatch',
      personAId: cast.userPersonId,
      personBId: cast.person['person_friend_a']!,
      externalNetBalance: 30_000n,
    });

    const [row] = await database.db
      .select({ id: schema.splitwiseExpenses.id, syncStatus: schema.splitwiseExpenses.syncStatus })
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    expect(row?.syncStatus).toBe('drifted');

    const auditRows = await listAuditEvents(database.db, 'splitwise_expense', row!.id);
    expect(auditRows.some((event) => event.action === 'update')).toBe(true);
  });

  it('drifts a matching synced settlement too', async () => {
    const settlementId = await syncedSettlementWith(cast.person['person_friend_a']!);
    splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(999_999n) }]);

    await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    const [row] = await database.db
      .select({ syncStatus: schema.splitwiseSettlements.syncStatus })
      .from(schema.splitwiseSettlements)
      .where(eq(schema.splitwiseSettlements.settlementId, settlementId));
    expect(row?.syncStatus).toBe('drifted');
  });

  it('leaves an unrelated friend pair untouched', async () => {
    await linkSplitwiseUser(cast.person['person_friend_b']!, 'sw-friend-b');
    const untouchedExpenseId = await syncedExpenseWith(cast.person['person_friend_b']!);
    const driftingExpenseId = await syncedExpenseWith(cast.person['person_friend_a']!);

    splitwise.setFriendBalances([
      { splitwiseUserId: 'sw-friend-a', netBalance: paise(0n) },
      { splitwiseUserId: 'sw-friend-b', netBalance: paise(-45_000n) },
    ]);

    await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    const rows = await database.db
      .select({
        expenseId: schema.splitwiseExpenses.expenseId,
        syncStatus: schema.splitwiseExpenses.syncStatus,
      })
      .from(schema.splitwiseExpenses);
    const byExpense = new Map(rows.map((r) => [r.expenseId, r.syncStatus]));
    expect(byExpense.get(driftingExpenseId)).toBe('drifted');
    expect(byExpense.get(untouchedExpenseId)).toBe('synced');
  });

  it('skips a friend Splitwise does not report at all, rather than assuming zero', async () => {
    await syncedExpenseWith(cast.person['person_friend_a']!);
    splitwise.setFriendBalances([]);

    const result = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    expect(result.discrepancies).toEqual([]);
  });

  it('stores the raw fetched balances as splitwiseBalancesSnapshot', async () => {
    splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(12_345n) }]);

    const result = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    const stored = await getReconciliationRun(
      database.db,
      asId<'reconciliation_run'>(result.reconciliationRunId),
    );
    expect(stored?.splitwiseBalancesSnapshot).toEqual([
      { splitwiseUserId: 'sw-friend-a', netBalance: '12345' },
    ]);
  });

  it('still computes and stores outflow totals when fetchBalances itself fails', async () => {
    await addExpense(database.db, {
      description: 'Groceries',
      amount: paise(50_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    splitwise.failNextFetchBalances('sandbox unreachable');

    const result = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    expect(result.totals.ledgerExplainedTotal).toBe(50_000n);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({ kind: 'splitwise_fetch_failed' });
    expect(result.discrepancies[0]?.detail).toContain('sandbox unreachable');

    const stored = await getReconciliationRun(
      database.db,
      asId<'reconciliation_run'>(result.reconciliationRunId),
    );
    expect(stored?.splitwiseBalancesSnapshot).toBeNull();
  });
});

describe('reconciliation history and single-run read', () => {
  it('lists runs newest first, and reads one back in full', async () => {
    const first = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-01T00:00:00.000Z'),
      splitwise,
      audit: AS_USER,
    });
    const second = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    const history = await listReconciliationRunHistory(database.db, {});
    expect(history.map((run) => run.id)).toEqual([
      second.reconciliationRunId,
      first.reconciliationRunId,
    ]);

    const read = await getReconciliationRun(
      database.db,
      asId<'reconciliation_run'>(second.reconciliationRunId),
    );
    expect(read?.totals.ledgerTotalOutflow).toBe(second.totals.ledgerTotalOutflow);
  });

  it('returns null for an unknown run id', async () => {
    const result = await getReconciliationRun(
      database.db,
      asId<'reconciliation_run'>('00000000-0000-0000-0000-000000000000'),
    );
    expect(result).toBeNull();
  });

  it('every reconciliation run writes exactly one audit event of its own, even with drift', async () => {
    await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
    await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
    await linkSplitwiseUser(cast.person['person_friend_a']!, 'sw-friend-a');
    await syncedExpenseWith(cast.person['person_friend_a']!);
    splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(1n) }]);

    const result = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    const reconciliationEvents = await listAuditEvents(
      database.db,
      'reconciliation_run',
      result.reconciliationRunId,
    );
    expect(reconciliationEvents).toHaveLength(1);
    expect(reconciliationEvents[0]?.entityId).toBe(result.reconciliationRunId);
  });
});
