import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { BeneficiaryRef, ExpenseId, PersonId, SettlementId } from '../../src/domain/index.js';
import {
  getConnectedExternalIntegration,
  getSplitwiseExpenseByExpenseId,
  getSplitwiseSettlementBySettlementId,
  schema,
} from '../../src/db/index.js';
import {
  approveAllocation,
  connectSplitwiseIntegration,
  recordSettlement,
  syncExpenseToSplitwise,
  syncSettlementToSplitwise,
  transitionExpense,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const AS_USER = { actor: 'user', source: 'tests/integration/splitwise-sync' } as const;
const OCCURRED_AT = new Date('2026-07-10T19:20:00.000Z');

function bigintSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

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

/** `people.splitwise_user_id` — set directly, the same as any other scenario-setup fact. */
async function linkSplitwiseUser(personId: PersonId, splitwiseUserId: string): Promise<void> {
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId })
    .where(eq(schema.people.id, personId));
}

async function readyToSyncExpense(input: {
  readonly amount: bigint;
  readonly beneficiaries: readonly BeneficiaryRef[];
  readonly paidByPersonId?: PersonId;
}): Promise<ExpenseId> {
  const expenseId = await addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(input.amount),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: input.paidByPersonId ?? cast.userPersonId,
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

describe('connectSplitwiseIntegration', () => {
  it('records a connected ExternalIntegration', async () => {
    const result = await connectSplitwiseIntegration(database.db, {
      externalAccountRef: 'sandbox-account-1',
    });

    expect(result.status).toBe('connected');
    const stored = await getConnectedExternalIntegration(database.db, cast.userId, 'splitwise');
    expect(stored?.id).toBe(result.externalIntegrationId);
    expect(stored?.externalAccountRef).toBe('sandbox-account-1');
  });
});

describe('syncExpenseToSplitwise', () => {
  beforeEach(async () => {
    await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
    await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
    await linkSplitwiseUser(cast.person['person_friend_a']!, 'sw-friend-a');
  });

  it('syncs an equal split, using netAmount and transitioning the expense to synced', async () => {
    const expenseId = await readyToSyncExpense({
      amount: 90_000n,
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_friend_a']! },
      ],
    });

    const result = await syncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      audit: AS_USER,
    });

    expect(result.syncStatus).toBe('synced');
    expect(result.splitwiseExpenseId).toBe('sw-expense-1');
    expect(splitwise.createdExpenses).toHaveLength(1);
    expect(splitwise.createdExpenses[0]).toMatchObject({
      amount: 90_000n,
      paidBySplitwiseUserId: 'sw-dev',
    });
    const shares = splitwise.createdExpenses[0]!.shares;
    expect(shares).toHaveLength(2);
    expect(shares.map((s) => s.splitwiseUserId).sort()).toEqual(['sw-dev', 'sw-friend-a']);

    const row = await getSplitwiseExpenseByExpenseId(database.db, expenseId);
    expect(row?.syncStatus).toBe('synced');

    const [expenseRow] = await database.db
      .select({ state: schema.expenses.state })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expenseId));
    expect(expenseRow?.state).toBe('synced');
  });

  it('resolves a group-typed line to individual shares, never the raw group id', async () => {
    await linkSplitwiseUser(cast.person['person_flatmate_a']!, 'sw-flatmate-a');
    await linkSplitwiseUser(cast.person['person_flatmate_c']!, 'sw-flatmate-c');

    const expenseId = await readyToSyncExpense({
      amount: 90_000n,
      beneficiaries: [{ type: 'group', id: cast.group['group_flat']! }],
    });

    await syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER });

    const shares = splitwise.createdExpenses[0]!.shares;
    // Active flat members at OCCURRED_AT: Dev, Flatmate A, Flatmate C (people-and-groups.json).
    expect(shares.map((s) => s.splitwiseUserId).sort()).toEqual([
      'sw-dev',
      'sw-flatmate-a',
      'sw-flatmate-c',
    ]);
    expect(shares.reduce((sum, s) => sum + s.owedAmount, 0n)).toBe(90_000n);
    // Nothing in the payload names the group at all.
    const payloadJson = JSON.stringify(splitwise.createdExpenses[0], bigintSafeReplacer);
    expect(payloadJson).not.toContain(cast.group['group_flat']!);
  });

  it('refuses an expense that is not ready_to_sync', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Not allocated yet',
      amount: paise(50_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });

    await expect(
      syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(splitwise.createdExpenses).toHaveLength(0);
  });

  it('refuses a second sync of the same expense', async () => {
    const expenseId = await readyToSyncExpense({
      amount: 90_000n,
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_friend_a']! },
      ],
    });
    await syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER });

    await expect(
      syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(splitwise.createdExpenses).toHaveLength(1);
  });

  it('refuses when a beneficiary has no linked Splitwise user', async () => {
    const expenseId = await readyToSyncExpense({
      amount: 90_000n,
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_friend_b']! },
      ],
    });

    await expect(
      syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(splitwise.createdExpenses).toHaveLength(0);
  });

  it('refuses when no Splitwise integration is connected', async () => {
    await database.db.delete(schema.externalIntegrations);
    const expenseId = await readyToSyncExpense({
      amount: 90_000n,
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_friend_a']! },
      ],
    });

    await expect(
      syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('leaves no row and the expense still ready_to_sync when the port fails', async () => {
    const expenseId = await readyToSyncExpense({
      amount: 90_000n,
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_friend_a']! },
      ],
    });
    splitwise.failNextCreateExpense('sandbox unavailable');

    await expect(
      syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'SPLITWISE_SYNC_FAILED' });

    expect(await getSplitwiseExpenseByExpenseId(database.db, expenseId)).toBeNull();
    const [expenseRow] = await database.db
      .select({ state: schema.expenses.state })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expenseId));
    expect(expenseRow?.state).toBe('ready_to_sync');

    // Retrying — calling the same route again — now succeeds.
    const retried = await syncExpenseToSplitwise(database.db, {
      expenseId,
      splitwise,
      audit: AS_USER,
    });
    expect(retried.syncStatus).toBe('synced');
  });
});

describe('syncSettlementToSplitwise', () => {
  beforeEach(async () => {
    await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
    await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
    await linkSplitwiseUser(cast.person['person_friend_a']!, 'sw-friend-a');
  });

  async function recordTestSettlement(direction: 'debit' | 'credit'): Promise<SettlementId> {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(50_000n),
      direction,
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
    return asId<'settlement'>(settlementId);
  }

  it('syncs a settlement the user paid — user is the source', async () => {
    const settlementId = await recordTestSettlement('debit');

    const result = await syncSettlementToSplitwise(database.db, {
      settlementId,
      splitwise,
      audit: AS_USER,
    });

    expect(result.syncStatus).toBe('synced');
    expect(splitwise.recordedPayments[0]).toMatchObject({
      amount: 50_000n,
      fromSplitwiseUserId: 'sw-dev',
      toSplitwiseUserId: 'sw-friend-a',
    });
  });

  it('syncs a settlement the user received — user is the destination', async () => {
    const settlementId = await recordTestSettlement('credit');

    await syncSettlementToSplitwise(database.db, { settlementId, splitwise, audit: AS_USER });

    expect(splitwise.recordedPayments[0]).toMatchObject({
      fromSplitwiseUserId: 'sw-friend-a',
      toSplitwiseUserId: 'sw-dev',
    });
  });

  it('refuses a second sync of the same settlement', async () => {
    const settlementId = await recordTestSettlement('debit');
    await syncSettlementToSplitwise(database.db, { settlementId, splitwise, audit: AS_USER });

    await expect(
      syncSettlementToSplitwise(database.db, { settlementId, splitwise, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('leaves no row when the port fails', async () => {
    const settlementId = await recordTestSettlement('debit');
    splitwise.failNextRecordPayment('sandbox unavailable');

    await expect(
      syncSettlementToSplitwise(database.db, { settlementId, splitwise, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'SPLITWISE_SYNC_FAILED' });
    expect(await getSplitwiseSettlementBySettlementId(database.db, settlementId)).toBeNull();
  });
});
