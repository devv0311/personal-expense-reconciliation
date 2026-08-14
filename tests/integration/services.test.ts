import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { DomainError, ExpenseId } from '../../src/domain/index.js';
import { listAuditEvents, schema } from '../../src/db/index.js';
import {
  approveAllocation,
  approveExpense,
  assertAmountChangeAllowed,
  distributeAdjustment,
  recordExpenseAdjustment,
  transitionExpense,
} from '../../src/services/index.js';
import type { ServiceError } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import {
  AS_USER,
  addExpense,
  allocationVersions,
  currentAllocationAmounts,
  seedCast,
} from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

/**
 * Service-level guarantees that only a real database can demonstrate: transactionality,
 * approval gating, immutability of approved amounts, and the audit trail.
 */

let database: TestDatabase;
let cast: Cast;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
});

const WHEN = new Date('2026-07-10T08:00:00Z');

async function anExpense(
  state: 'proposed' | 'classified' | 'approved' = 'approved',
): Promise<ExpenseId> {
  return addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(240000n),
    occurredAt: WHEN,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state,
  });
}

describe('an approved expense amount can never be mutated (invariant #6, ADR-0008)', () => {
  it('rejects a proposed change once the expense is approved', async () => {
    const expense = await anExpense('approved');

    let raised: DomainError | undefined;
    try {
      await assertAmountChangeAllowed(database.db, expense, paise(200000n));
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('IMMUTABLE_FIELD');
    expect(raised?.message).toMatch(/ExpenseAdjustment/);
  });

  it('rejects an increase as firmly as a decrease', async () => {
    const expense = await anExpense('approved');

    await expect(assertAmountChangeAllowed(database.db, expense, paise(300000n))).rejects.toThrow(
      /never change again/,
    );
  });

  it('still allows a correction before approval', async () => {
    const expense = await anExpense('classified');

    await expect(
      assertAmountChangeAllowed(database.db, expense, paise(200000n)),
    ).resolves.toBeUndefined();
  });

  it('exposes no service that could write the amount at all', async () => {
    const services: Record<string, unknown> = await import('../../src/services/index.js');
    const writers = Object.keys(services).filter(
      (name) => /^(set|update|change|edit|correct)/i.test(name) && /amount/i.test(name),
    );

    // `assertAmountChangeAllowed` is a guard, not a writer, so it is deliberately not
    // matched here: the point is that no function *performs* the change.
    expect(writers).toEqual([]);
    expect(Object.keys(services)).toContain('assertAmountChangeAllowed');
  });

  it('leaves the stored amount untouched after a rejected attempt', async () => {
    const expense = await anExpense('approved');
    await assertAmountChangeAllowed(database.db, expense, paise(200000n)).catch(() => undefined);

    const [row] = await database.db
      .select({ amount: schema.expenses.amount })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expense));

    expect(row?.amount).toBe(240000n);
  });
});

describe('lifecycle transitions are gated and audited', () => {
  it('refuses a transition the lifecycle does not draw', async () => {
    const expense = await anExpense('proposed');

    let raised: DomainError | undefined;
    try {
      await transitionExpense(database.db, { expenseId: expense, to: 'synced', audit: AS_USER });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('leaves the state unchanged when a transition is refused', async () => {
    const expense = await anExpense('proposed');
    await transitionExpense(database.db, {
      expenseId: expense,
      to: 'synced',
      audit: AS_USER,
    }).catch(() => undefined);

    const [row] = await database.db
      .select({ state: schema.expenses.state })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expense));

    expect(row?.state).toBe('proposed');
  });

  it('records old and new state on every accepted transition', async () => {
    const expense = await anExpense('classified');
    await approveExpense(database.db, { expenseId: expense, audit: AS_USER });

    const events = await listAuditEvents(database.db, 'expense', expense);

    expect(events).toHaveLength(1);
    expect(events[0]?.oldValue).toMatchObject({ state: 'classified' });
    expect(events[0]?.newValue).toMatchObject({ state: 'approved' });
    expect(events[0]?.actor).toBe('user');
  });

  it('refuses to allocate an expense that is not yet approved', async () => {
    const expense = await anExpense('classified');

    let raised: ServiceError | undefined;
    try {
      await approveAllocation(database.db, {
        expenseId: expense,
        decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
        decidedBy: 'manual',
        audit: AS_USER,
      });
    } catch (error) {
      raised = error as ServiceError;
    }

    expect(raised?.code).toBe('PRECONDITION_FAILED');
    expect(await allocationVersions(database.db, expense)).toEqual([]);
  });
});

describe('allocation approval is transactional', () => {
  it('writes nothing at all when the sum check fails', async () => {
    const expense = await anExpense('approved');

    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'exact',
        lines: [{ beneficiary: { type: 'person', id: cast.userPersonId }, amount: paise(1n) }],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    }).catch(() => undefined);

    const lines = await database.db
      .select({ id: schema.allocationLines.id })
      .from(schema.allocationLines);
    const events = await database.db.select({ id: schema.auditEvents.id }).from(schema.auditEvents);

    expect(await allocationVersions(database.db, expense)).toEqual([]);
    expect(lines).toEqual([]);
    expect(events).toEqual([]);
  });

  it('does not supersede the previous allocation when the new one is invalid', async () => {
    const expense = await anExpense('approved');
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'percentage',
        lines: [{ beneficiary: { type: 'person', id: cast.userPersonId }, percentage: '90' }],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    }).catch(() => undefined);

    const versions = await allocationVersions(database.db, expense);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.supersededAt).toBeNull();
    expect(await currentAllocationAmounts(database.db, expense)).toHaveLength(1);
  });

  it('refuses a group line whose group had no members on the expense date (ADR-0009)', async () => {
    const expense = await addExpense(database.db, {
      description: 'Bill dated before anyone joined the flat',
      amount: paise(210000n),
      occurredAt: new Date('2020-01-01T00:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });

    let raised: DomainError | undefined;
    try {
      await approveAllocation(database.db, {
        expenseId: expense,
        decision: {
          method: 'equal',
          beneficiaries: [{ type: 'group', id: cast.group['group_flat']! }],
        },
        decidedBy: 'manual',
        audit: AS_USER,
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('GROUP_EXPANSION_NO_MEMBERS');
    expect(await allocationVersions(database.db, expense)).toEqual([]);
  });
});

describe('adjustment distribution is transactional and idempotent-by-precondition', () => {
  async function seedAdjusted(): Promise<ExpenseId> {
    const expense = await anExpense('approved');
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_friend_a']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    await recordExpenseAdjustment(database.db, {
      expenseId: expense,
      kind: 'merchant_refund',
      amount: paise(40000n),
      occurredAt: WHEN,
      audit: AS_USER,
    });
    return expense;
  }

  it('refuses a second distribution when nothing is outstanding', async () => {
    const expense = await seedAdjusted();
    await distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER });

    let raised: ServiceError | undefined;
    try {
      await distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER });
    } catch (error) {
      raised = error as ServiceError;
    }

    expect(raised?.code).toBe('PRECONDITION_FAILED');
    expect(await allocationVersions(database.db, expense)).toHaveLength(2);
  });

  it('distributes two recorded adjustments together, to the same result', async () => {
    const expense = await seedAdjusted();
    await recordExpenseAdjustment(database.db, {
      expenseId: expense,
      kind: 'merchant_refund',
      amount: paise(20000n),
      occurredAt: WHEN,
      audit: AS_USER,
    });

    const result = await distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER });

    expect(result.distributedAmount).toBe(60000n);
    expect(result.netAmount).toBe(180000n);
    expect(
      (await currentAllocationAmounts(database.db, expense)).map((line) => line.amount),
    ).toEqual([90000n, 90000n]);
  });

  it('refuses to distribute against an expense with no allocation', async () => {
    const expense = await anExpense('approved');
    await recordExpenseAdjustment(database.db, {
      expenseId: expense,
      kind: 'merchant_refund',
      amount: paise(40000n),
      occurredAt: WHEN,
      audit: AS_USER,
    });

    await expect(
      distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER }),
    ).rejects.toThrow(/no current Allocation/);
  });

  it('rejects an adjustment whose payment is a debit rather than a credit', async () => {
    const expense = await anExpense('approved');
    const [batch] = await database.db
      .select({ id: schema.importBatches.id })
      .from(schema.importBatches);
    const [debit] = await database.db
      .insert(schema.payments)
      .values({
        accountId: cast.account['account_hdfc_upi']!,
        importBatchId: batch!.id,
        amount: paise(40000n),
        direction: 'debit',
        occurredAt: WHEN,
        rawDescription: 'NOT A REFUND',
        channel: 'upi',
      })
      .returning({ id: schema.payments.id });

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId: expense,
        kind: 'merchant_refund',
        amount: paise(40000n),
        adjustmentPaymentId: asId<'payment'>(debit!.id),
        occurredAt: WHEN,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/money coming \*back\*|is a debit/);
  });
});

describe('the audit log is append-only in practice as well as by policy', () => {
  it('accumulates events rather than replacing them', async () => {
    const expense = await anExpense('classified');
    await approveExpense(database.db, { expenseId: expense, audit: AS_USER });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const events = await listAuditEvents(database.db, 'expense', expense);

    expect(events.map((event) => event.newValue)).toEqual([
      expect.objectContaining({ state: 'approved' }),
      expect.objectContaining({ state: 'allocated' }),
    ]);
  });

  it('offers no repository function that updates or deletes an audit event', async () => {
    const repositories: Record<string, unknown> = await import('../../src/db/repositories.js');
    const names = Object.keys(repositories);

    expect(names.filter((name) => /audit/i.test(name) && /update|delete/i.test(name))).toEqual([]);
    expect(names).toContain('insertAuditEvent');
  });
});
