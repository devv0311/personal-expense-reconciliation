import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paise, splitByLargestRemainder } from '../../src/domain/index.js';
import type {
  ExpenseId,
  ExpenseItemId,
  Paise,
  PaymentId,
  PersonId,
} from '../../src/domain/index.js';
import { insertExternalIntegration, insertSplitwiseExpense, schema } from '../../src/db/index.js';
import {
  approveAllocation,
  distributeAdjustment,
  getBalance,
  getRefundAllocationState,
  loadCurrentAllocation,
  recordExpenseAdjustment,
  recordSettlement,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import {
  AS_USER,
  addExpense,
  addExpenseItem,
  addManualNote,
  addPayment,
  allocationVersions,
  linkPaymentToExpense,
  seedCast,
} from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

/**
 * ADR-0018 (item refunds)'s scenario matrix, end to end: **financial event → adjustment →
 * net item cost → superseding allocation → obligation**.
 *
 * The domain unit tests prove the arithmetic. These prove the pipeline: that the refund
 * reaches the right beneficiary's debt, that the purchase it came off is still recorded
 * exactly as it happened, and that everything the ADR says must survive a refund — source
 * Payments, gross items, superseded allocation versions, already-recorded settlements — does.
 *
 * Every scenario runs against the real schema through the real services. Nothing here reaches
 * past `src/services` to write an allocation or an adjustment by hand.
 */

let database: TestDatabase;
let cast: Cast;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
});

/* ------------------------------------------------------------------ seeding helpers */

interface Basket {
  readonly expenseId: ExpenseId;
  readonly purchasePaymentId: PaymentId;
  /** The user's ₹600 item. */
  readonly mine: ExpenseItemId;
  /** The friend's ₹400 item. */
  readonly theirs: ExpenseItemId;
}

const PURCHASED_AT = new Date('2026-07-01T10:00:00Z');
const REFUNDED_AT = new Date('2026-07-05T10:00:00Z');

/**
 * ADR-0018's worked shared purchase: the user pays ₹1,000 for their own ₹600 item and a
 * friend's ₹400 item, and the allocation says exactly that.
 */
async function seedBasket(): Promise<Basket> {
  const expenseId = await addExpense(database.db, {
    description: 'Blinkit basket',
    amount: paise(100_000n),
    occurredAt: PURCHASED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
  });
  const purchasePaymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_upi']!,
    amount: paise(100_000n),
    direction: 'debit',
    occurredAt: PURCHASED_AT,
    rawDescription: 'UPI-BLINKIT-blinkit@axl',
    channel: 'upi',
    counterpartyType: 'merchant',
  });
  await linkPaymentToExpense(database.db, {
    paymentId: purchasePaymentId,
    expenseId,
    amount: paise(100_000n),
  });

  const mine = await addExpenseItem(database.db, {
    expenseId,
    description: 'Groceries (mine)',
    amount: paise(60_000n),
  });
  const theirs = await addExpenseItem(database.db, {
    expenseId,
    description: 'Cold brew (theirs)',
    amount: paise(40_000n),
  });

  await approveAllocation(database.db, {
    expenseId,
    decision: {
      method: 'item_based',
      lines: [
        { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: mine },
        {
          beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
          expenseItemId: theirs,
        },
      ],
    },
    decidedBy: 'manual',
    audit: AS_USER,
  });

  return { expenseId, purchasePaymentId, mine, theirs };
}

async function seedRefundCredit(amount: Paise, occurredAt = REFUNDED_AT): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_upi']!,
    amount,
    direction: 'credit',
    occurredAt,
    rawDescription: 'BLINKIT REFUND',
    channel: 'upi',
    counterpartyType: 'merchant',
  });
}

/* ------------------------------------------------------------------ reading helpers */

/** The current allocation's lines, with the item each one is attached to. */
async function currentLines(
  expenseId: ExpenseId,
): Promise<Array<{ beneficiaryId: string; expenseItemId: string | null; amount: bigint }>> {
  const rows = await database.db
    .select({
      beneficiaryId: schema.allocationLines.beneficiaryId,
      expenseItemId: schema.allocationLines.expenseItemId,
      amount: schema.allocationLines.amount,
      supersededAt: schema.allocations.supersededAt,
    })
    .from(schema.allocationLines)
    .innerJoin(schema.allocations, eq(schema.allocationLines.allocationId, schema.allocations.id))
    .where(eq(schema.allocations.expenseId, expenseId))
    .orderBy(asc(schema.allocationLines.beneficiaryId));

  return rows
    .filter((row) => row.supersededAt === null)
    .map((row) => ({
      beneficiaryId: row.beneficiaryId,
      expenseItemId: row.expenseItemId,
      amount: row.amount,
    }));
}

async function shareOf(expenseId: ExpenseId, personId: PersonId): Promise<bigint> {
  const lines = await currentLines(expenseId);
  return lines
    .filter((line) => line.beneficiaryId === personId)
    .reduce((total, line) => total + line.amount, 0n);
}

async function allocationTotal(expenseId: ExpenseId): Promise<bigint> {
  return (await currentLines(expenseId)).reduce((total, line) => total + line.amount, 0n);
}

async function balance(debtor: PersonId, creditor: PersonId): Promise<bigint> {
  const result = await getBalance(database.db, cast.userPersonId, debtor, creditor);
  return result.netBalance;
}

async function grossFacts(basket: Basket): Promise<{
  expenseAmount: bigint | undefined;
  itemAmounts: bigint[];
  paymentAmount: bigint | undefined;
}> {
  const [expense] = await database.db
    .select({ amount: schema.expenses.amount })
    .from(schema.expenses)
    .where(eq(schema.expenses.id, basket.expenseId));
  const items = await database.db
    .select({ amount: schema.expenseItems.amount })
    .from(schema.expenseItems)
    .where(eq(schema.expenseItems.expenseId, basket.expenseId))
    .orderBy(asc(schema.expenseItems.amount));
  const [payment] = await database.db
    .select({ amount: schema.payments.amount })
    .from(schema.payments)
    .where(eq(schema.payments.id, basket.purchasePaymentId));

  return {
    expenseAmount: expense?.amount,
    itemAmounts: items.map((item) => item.amount),
    paymentAmount: payment?.amount,
  };
}

/* ============================================================ 1. one-item partial refund */

describe('a partial refund of one item on a shared basket', () => {
  async function refundTheirItem(amount: bigint): Promise<Basket> {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(amount),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(amount) }],
      audit: AS_USER,
    });
    return basket;
  }

  it('leaves the allocation at the pre-refund figure until it is distributed', async () => {
    const basket = await refundTheirItem(15_000n);

    expect(await allocationTotal(basket.expenseId)).toBe(100_000n);
    const state = await getRefundAllocationState(database.db, basket.expenseId);
    expect(state.pendingDistribution).toBe(true);
    expect(state.obligationsReflectAdjustments).toBe(false);
  });

  it('reduces only the friend’s item, to ₹600 / ₹250 (ADR-0018’s worked example)', async () => {
    const basket = await refundTheirItem(15_000n);
    const result = await distributeAdjustment(database.db, {
      expenseId: basket.expenseId,
      audit: AS_USER,
    });

    expect(result.basis).toBe('item_attributed');
    expect(await shareOf(basket.expenseId, cast.userPersonId)).toBe(60_000n);
    expect(await shareOf(basket.expenseId, cast.person['person_friend_a']!)).toBe(25_000n);
    expect(await allocationTotal(basket.expenseId)).toBe(85_000n);
  });

  it('would have been ₹510 / ₹340 under the whole-expense proportional default', async () => {
    const basket = await refundTheirItem(15_000n);
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    // The exact failure ADR-0018 exists to prevent: ₹90 of a refund handed back to someone
    // whose item was never returned.
    expect(await shareOf(basket.expenseId, cast.userPersonId)).not.toBe(51_000n);
  });

  it('makes the friend owe ₹250, not ₹340', async () => {
    const basket = await refundTheirItem(15_000n);
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    expect(await balance(cast.person['person_friend_a']!, cast.userPersonId)).toBe(25_000n);
  });

  it('leaves the source Payment, gross expense and gross items exactly as recorded', async () => {
    const basket = await refundTheirItem(15_000n);
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    expect(await grossFacts(basket)).toEqual({
      expenseAmount: 100_000n,
      itemAmounts: [40_000n, 60_000n],
      paymentAmount: 100_000n,
    });
  });

  it('keeps the pre-refund allocation as a superseded version', async () => {
    const basket = await refundTheirItem(15_000n);
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const versions = await allocationVersions(database.db, basket.expenseId);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.supersededAt).not.toBeNull();
    expect(versions[1]?.supersededAt).toBeNull();
    expect(versions.every((version) => version.method === 'item_based')).toBe(true);
  });

  it('keeps every superseded line at its original amount', async () => {
    const basket = await refundTheirItem(15_000n);
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const versions = await allocationVersions(database.db, basket.expenseId);
    const superseded = await database.db
      .select({ amount: schema.allocationLines.amount })
      .from(schema.allocationLines)
      .where(eq(schema.allocationLines.allocationId, versions[0]!.id))
      .orderBy(asc(schema.allocationLines.amount));

    expect(superseded.map((line) => line.amount)).toEqual([40_000n, 60_000n]);
  });

  it('reports the same lines from the read as the distribution then writes', async () => {
    const basket = await refundTheirItem(15_000n);
    const preview = await getRefundAllocationState(database.db, basket.expenseId);
    const result = await distributeAdjustment(database.db, {
      expenseId: basket.expenseId,
      audit: AS_USER,
    });

    expect(preview.projectedLines?.map((line) => line.amount)).toEqual(
      result.lines.map((line) => line.amount),
    );
    expect(preview.reviewRequired).toBeNull();
  });
});

/* ============================================================== 2. multiple items, at once */

describe('one refund covering more than one item', () => {
  it('reduces each named item by its own attributed amount', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(35_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [
        { expenseItemId: basket.mine, amount: paise(20_000n) },
        { expenseItemId: basket.theirs, amount: paise(15_000n) },
      ],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    expect(await shareOf(basket.expenseId, cast.userPersonId)).toBe(40_000n);
    expect(await shareOf(basket.expenseId, cast.person['person_friend_a']!)).toBe(25_000n);
    expect(await allocationTotal(basket.expenseId)).toBe(65_000n);
  });
});

/* ================================================== 3 & 4. successive refunds and ceilings */

describe('successive refunds and cumulative ceilings', () => {
  it('lands in the same place whether distributed once or after each refund', async () => {
    const once = await seedBasket();
    for (const amount of [10_000n, 12_500n]) {
      await recordExpenseAdjustment(database.db, {
        expenseId: once.expenseId,
        kind: 'merchant_refund',
        amount: paise(amount),
        occurredAt: new Date(REFUNDED_AT.getTime() + Number(amount)),
        itemAttributions: [{ expenseItemId: once.theirs, amount: paise(amount) }],
        audit: AS_USER,
      });
    }
    await distributeAdjustment(database.db, { expenseId: once.expenseId, audit: AS_USER });

    const stepwise = await seedBasket();
    for (const amount of [10_000n, 12_500n]) {
      await recordExpenseAdjustment(database.db, {
        expenseId: stepwise.expenseId,
        kind: 'merchant_refund',
        amount: paise(amount),
        occurredAt: new Date(REFUNDED_AT.getTime() + Number(amount)),
        itemAttributions: [{ expenseItemId: stepwise.theirs, amount: paise(amount) }],
        audit: AS_USER,
      });
      await distributeAdjustment(database.db, { expenseId: stepwise.expenseId, audit: AS_USER });
    }

    expect(await allocationTotal(once.expenseId)).toBe(77_500n);
    expect(await shareOf(once.expenseId, cast.person['person_friend_a']!)).toBe(17_500n);
    expect(await shareOf(stepwise.expenseId, cast.person['person_friend_a']!)).toBe(17_500n);
    // Three versions for the stepwise expense, two for the batched one — the history differs,
    // the answer does not.
    expect(await allocationVersions(database.db, stepwise.expenseId)).toHaveLength(3);
  });

  it('refuses a refund that would take an item past its original gross cost (19.3)', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(30_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(30_000n) }],
      audit: AS_USER,
    });

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        occurredAt: new Date('2026-07-08T10:00:00Z'),
        itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_ITEM_CEILING_EXCEEDED' });

    // The first refund still distributes normally; the refused one left nothing behind.
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });
    expect(await allocationTotal(basket.expenseId)).toBe(70_000n);
  });

  it('refuses a second distribution when nothing new has been recorded', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    await expect(
      distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // Idempotent by refusal, not by rewriting: no third allocation version appeared.
    expect(await allocationVersions(database.db, basket.expenseId)).toHaveLength(2);
  });
});

/* ================================================== 5. duplicate and concurrent refunds */

describe('duplicate and concurrent refunds', () => {
  it('lets exactly one of two simultaneous over-ceiling refunds through (19.3)', async () => {
    const basket = await seedBasket();

    const both = await Promise.allSettled([
      recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(25_000n),
        occurredAt: REFUNDED_AT,
        itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(25_000n) }],
        audit: AS_USER,
      }),
      recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(25_000n),
        occurredAt: new Date('2026-07-05T10:00:01Z'),
        itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(25_000n) }],
        audit: AS_USER,
      }),
    ]);

    expect(both.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });
    expect(await shareOf(basket.expenseId, cast.person['person_friend_a']!)).toBe(15_000n);
  });

  it('never distributes a duplicated import twice — the second import is refused', async () => {
    const basket = await seedBasket();
    const credit = await seedRefundCredit(paise(15_000n));

    const record = {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      adjustmentPaymentId: credit,
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    } as const;

    await recordExpenseAdjustment(database.db, record);
    // The same credit cannot fund a second adjustment of the same size: the refund Payment is
    // immutable evidence, and what it actually returned is the ceiling (19.6).
    await expect(recordExpenseAdjustment(database.db, record)).rejects.toMatchObject({
      code: 'PAYMENT_BUDGET_EXCEEDED',
    });

    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });
    expect(await allocationTotal(basket.expenseId)).toBe(85_000n);
  });
});

/* ============================================ 6 & 7. shared quantities and paise rounding */

describe('a genuinely shared item, and the odd paisa', () => {
  interface SharedFlat {
    readonly expenseId: ExpenseId;
    readonly milk: ExpenseItemId;
    readonly cereal: ExpenseItemId;
  }

  /** A ₹1,000.01 flat order: ₹700.01 of milk split three ways, ₹300 of cereal for the user. */
  async function seedSharedFlatOrder(): Promise<SharedFlat> {
    const expenseId = await addExpense(database.db, {
      description: 'Flat grocery order',
      amount: paise(100_001n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    const milk = await addExpenseItem(database.db, {
      expenseId,
      description: 'Milk crate (shared 3 ways)',
      amount: paise(70_001n),
      quantity: '3',
    });
    const cereal = await addExpenseItem(database.db, {
      expenseId,
      description: 'Cereal (mine)',
      amount: paise(30_000n),
    });

    // ₹700.01 across three equal shares: 23334 / 23334 / 23333 by Largest Remainder.
    const milkShares = splitByLargestRemainder(paise(70_001n), [
      { key: cast.userPersonId, weight: 1n },
      { key: cast.person['person_flatmate_a']!, weight: 1n },
      { key: cast.person['person_flatmate_c']!, weight: 1n },
    ]);

    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'quantity_based',
        lines: [
          {
            beneficiary: { type: 'person', id: cast.userPersonId },
            expenseItemId: milk,
            amount: milkShares[0]!.amount,
          },
          {
            beneficiary: { type: 'person', id: cast.person['person_flatmate_a']! },
            expenseItemId: milk,
            amount: milkShares[1]!.amount,
          },
          {
            beneficiary: { type: 'person', id: cast.person['person_flatmate_c']! },
            expenseItemId: milk,
            amount: milkShares[2]!.amount,
          },
          { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: cereal },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    return { expenseId, milk, cereal };
  }

  it('splits a shared item’s remaining cost exactly, with the parts summing to the whole', async () => {
    const order = await seedSharedFlatOrder();
    await recordExpenseAdjustment(database.db, {
      expenseId: order.expenseId,
      kind: 'merchant_refund',
      amount: paise(20_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: order.milk, amount: paise(20_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: order.expenseId, audit: AS_USER });

    const lines = await currentLines(order.expenseId);
    const milkLines = lines.filter((line) => line.expenseItemId === order.milk);
    expect(milkLines.reduce((total, line) => total + line.amount, 0n)).toBe(50_001n);
    expect(await allocationTotal(order.expenseId)).toBe(80_001n);
    // ₹500.01 three ways: 16667 / 16667 / 16667 exactly.
    expect(milkLines.map((line) => line.amount).sort()).toEqual([16_667n, 16_667n, 16_667n]);
  });

  it('leaves the unshared item alone and the flatmates’ debts on the shared one', async () => {
    const order = await seedSharedFlatOrder();
    await recordExpenseAdjustment(database.db, {
      expenseId: order.expenseId,
      kind: 'merchant_refund',
      amount: paise(20_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: order.milk, amount: paise(20_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: order.expenseId, audit: AS_USER });

    const cereal = (await currentLines(order.expenseId)).find(
      (line) => line.expenseItemId === order.cereal,
    );
    expect(cereal?.amount).toBe(30_000n);
    expect(await balance(cast.person['person_flatmate_a']!, cast.userPersonId)).toBe(16_667n);
    expect(await balance(cast.person['person_flatmate_c']!, cast.userPersonId)).toBe(16_667n);
  });

  it('hands out a single leftover paisa deterministically, by beneficiary id', async () => {
    const order = await seedSharedFlatOrder();
    // ₹700.01 − ₹1 = 70000 paise across three shares: 23334 / 23333 / 23333.
    await recordExpenseAdjustment(database.db, {
      expenseId: order.expenseId,
      kind: 'merchant_refund',
      amount: paise(1n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: order.milk, amount: paise(1n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: order.expenseId, audit: AS_USER });

    const milkLines = (await currentLines(order.expenseId)).filter(
      (line) => line.expenseItemId === order.milk,
    );
    expect(milkLines.reduce((total, line) => total + line.amount, 0n)).toBe(70_000n);
    expect([...milkLines.map((line) => line.amount)].sort()).toEqual([23_333n, 23_333n, 23_334n]);
  });
});

/* ============================================ 8 & 9. a fully refunded item, and the lot */

describe('full refunds', () => {
  it('zeroes a fully refunded item without dropping its beneficiary', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(40_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(40_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const lines = await currentLines(basket.expenseId);
    expect(lines).toHaveLength(2);
    expect(await shareOf(basket.expenseId, cast.person['person_friend_a']!)).toBe(0n);
    expect(await shareOf(basket.expenseId, cast.userPersonId)).toBe(60_000n);
    expect(await balance(cast.person['person_friend_a']!, cast.userPersonId)).toBe(0n);
  });

  it('keeps one zero-amount line per beneficiary when the whole basket comes back (ADR-0013)', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(100_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [
        { expenseItemId: basket.mine, amount: paise(60_000n) },
        { expenseItemId: basket.theirs, amount: paise(40_000n) },
      ],
      audit: AS_USER,
    });
    const result = await distributeAdjustment(database.db, {
      expenseId: basket.expenseId,
      audit: AS_USER,
    });

    expect(result.netAmount).toBe(0n);
    const lines = await currentLines(basket.expenseId);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.amount === 0n)).toBe(true);
    // What was purchased, and by whom, is still answerable from the current allocation.
    expect(lines.map((line) => line.expenseItemId).sort()).toEqual(
      [basket.mine, basket.theirs].sort(),
    );
  });
});

/* ================================ 10, 11 & 12. attribution the ledger refuses to guess at */

describe('what the engine refuses rather than guesses', () => {
  it('will not distribute an item refund over an allocation that names no items', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Zepto order, split equally',
      amount: paise(90_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    const damaged = await addExpenseItem(database.db, {
      expenseId,
      description: 'Damaged item',
      amount: paise(30_000n),
    });
    await addExpenseItem(database.db, {
      expenseId,
      description: 'Everything else',
      amount: paise(60_000n),
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_flatmate_a']! },
          { type: 'person', id: cast.person['person_flatmate_c']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: damaged, amount: paise(15_000n) }],
      audit: AS_USER,
    });

    await expect(
      distributeAdjustment(database.db, { expenseId, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'REFUND_ITEM_OWNERSHIP_REQUIRED' });

    // Nothing was written, and the obligations still say so.
    expect(await allocationVersions(database.db, expenseId)).toHaveLength(1);
    const state = await getRefundAllocationState(database.db, expenseId);
    expect(state.reviewRequired?.code).toBe('REFUND_ITEM_OWNERSHIP_REQUIRED');
    expect(state.projectedLines).toBeNull();
    expect(state.obligationsReflectAdjustments).toBe(false);
  });

  it('distributes once a human re-approves the allocation against item ownership', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });

    // Re-approving against the *net* item costs is itself a complete distribution: the
    // allocation now sums to the net amount, so there is nothing left to distribute.
    await approveAllocation(database.db, {
      expenseId: basket.expenseId,
      decision: {
        method: 'item_based',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: basket.mine },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            expenseItemId: basket.theirs,
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    expect(await shareOf(basket.expenseId, cast.person['person_friend_a']!)).toBe(25_000n);
    await expect(
      distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses an attribution naming another expense’s item (19.1)', async () => {
    const basket = await seedBasket();
    const other = await seedBasket();

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        occurredAt: REFUNDED_AT,
        itemAttributions: [{ expenseItemId: other.theirs, amount: paise(15_000n) }],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_ATTRIBUTION_CROSS_EXPENSE' });
  });

  it('refuses a zero-amount attribution row (19.4)', async () => {
    const basket = await seedBasket();

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        occurredAt: REFUNDED_AT,
        itemAttributions: [
          { expenseItemId: basket.theirs, amount: paise(15_000n) },
          { expenseItemId: basket.mine, amount: paise(0n) },
        ],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'MONEY_NEGATIVE' });
  });

  it('refuses a negative attribution row — a clawback is new spend, not a negative refund', async () => {
    const basket = await seedBasket();

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        occurredAt: REFUNDED_AT,
        itemAttributions: [
          { expenseItemId: basket.theirs, amount: paise(20_000n) },
          { expenseItemId: basket.mine, amount: paise(-5_000n) },
        ],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'MONEY_NEGATIVE' });
  });

  it('refuses an incomplete attribution set rather than leaving a pending remainder (19.2)', async () => {
    const basket = await seedBasket();

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(20_000n),
        occurredAt: REFUNDED_AT,
        itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_ATTRIBUTION_SUM_MISMATCH' });

    expect(await database.db.select().from(schema.expenseAdjustments)).toHaveLength(0);
  });

  it('refuses a weight set for a refund whose distribution the attribution already decides', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });

    await expect(
      distributeAdjustment(database.db, {
        expenseId: basket.expenseId,
        customWeights: [1n, 0n],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'ALLOCATION_SHAPE_INVALID' });
  });
});

/* ================================================ 13. taxes, discounts and unrefunded fees */

describe('taxes, discounts and fees, on their evidenced paid-cost basis', () => {
  interface TaxedOrder {
    readonly expenseId: ExpenseId;
    readonly headphones: ExpenseItemId;
    readonly cable: ExpenseItemId;
    readonly gst: ExpenseItemId;
    readonly delivery: ExpenseItemId;
  }

  /**
   * A ₹1,180 order the user and a friend share: a ₹500 pair of headphones (after a ₹100
   * line-specific discount), a ₹300 cable, ₹180 of separately itemized GST split between them,
   * and a ₹200 delivery fee the merchant does not refund.
   */
  async function seedTaxedOrder(): Promise<TaxedOrder> {
    const expenseId = await addExpense(database.db, {
      description: 'Electronics order',
      amount: paise(118_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    // The agreed paid-cost basis: catalog ₹600 less a ₹100 line-specific discount. The
    // discount is part of what was payable, not a second post-purchase refund.
    const headphones = await addExpenseItem(database.db, {
      expenseId,
      description: 'Headphones (₹600 less ₹100 launch discount)',
      amount: paise(50_000n),
    });
    const cable = await addExpenseItem(database.db, {
      expenseId,
      description: 'USB-C cable',
      amount: paise(30_000n),
    });
    const gst = await addExpenseItem(database.db, {
      expenseId,
      description: 'GST (separately itemized component)',
      amount: paise(18_000n),
    });
    const delivery = await addExpenseItem(database.db, {
      expenseId,
      description: 'Delivery fee (non-refundable)',
      amount: paise(20_000n),
    });

    const friend = cast.person['person_friend_a']!;
    // ₹180 of tax on a ₹500/₹300 basis: 11250 / 6750 by the same Largest Remainder Method,
    // on the evidenced applicable basis rather than an invented one.
    const taxShares = splitByLargestRemainder(paise(18_000n), [
      { key: cast.userPersonId, weight: 50_000n },
      { key: friend, weight: 30_000n },
    ]);
    const deliveryShares = splitByLargestRemainder(paise(20_000n), [
      { key: cast.userPersonId, weight: 1n },
      { key: friend, weight: 1n },
    ]);

    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'item_based',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: headphones },
          { beneficiary: { type: 'person', id: friend }, expenseItemId: cable },
          {
            beneficiary: { type: 'person', id: cast.userPersonId },
            expenseItemId: gst,
            amount: taxShares[0]!.amount,
          },
          {
            beneficiary: { type: 'person', id: friend },
            expenseItemId: gst,
            amount: taxShares[1]!.amount,
          },
          {
            beneficiary: { type: 'person', id: cast.userPersonId },
            expenseItemId: delivery,
            amount: deliveryShares[0]!.amount,
          },
          {
            beneficiary: { type: 'person', id: friend },
            expenseItemId: delivery,
            amount: deliveryShares[1]!.amount,
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    return { expenseId, headphones, cable, gst, delivery };
  }

  it('refuses a refund of the catalog price above the item’s agreed paid-cost basis', async () => {
    const order = await seedTaxedOrder();

    // ₹600 was the shelf price; ₹500 was paid. Refunding ₹600 would return money the ledger
    // has no evidence ever left the account.
    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId: order.expenseId,
        kind: 'merchant_refund',
        amount: paise(60_000n),
        occurredAt: REFUNDED_AT,
        itemAttributions: [{ expenseItemId: order.headphones, amount: paise(60_000n) }],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_ITEM_CEILING_EXCEEDED' });
  });

  it('attributes a separately modeled tax refund to its own component item', async () => {
    const order = await seedTaxedOrder();
    // The merchant's own breakdown: ₹500 of goods plus the ₹90 of GST that rode on them.
    const gstOnHeadphones = 9_000n;
    await recordExpenseAdjustment(database.db, {
      expenseId: order.expenseId,
      kind: 'merchant_refund',
      amount: paise(50_000n + gstOnHeadphones),
      occurredAt: REFUNDED_AT,
      itemAttributions: [
        { expenseItemId: order.headphones, amount: paise(50_000n) },
        { expenseItemId: order.gst, amount: paise(gstOnHeadphones) },
      ],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: order.expenseId, audit: AS_USER });

    const lines = await currentLines(order.expenseId);
    const headphones = lines.find((line) => line.expenseItemId === order.headphones);
    const gstLines = lines.filter((line) => line.expenseItemId === order.gst);

    expect(headphones?.amount).toBe(0n);
    // ₹90 off a ₹180 tax component, apportioned across its two approved shares.
    expect(gstLines.reduce((total, line) => total + line.amount, 0n)).toBe(9_000n);
    expect(await allocationTotal(order.expenseId)).toBe(59_000n);
  });

  it('leaves a non-refunded delivery fee in the net cost, whole', async () => {
    const order = await seedTaxedOrder();
    await recordExpenseAdjustment(database.db, {
      expenseId: order.expenseId,
      kind: 'merchant_refund',
      amount: paise(50_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: order.headphones, amount: paise(50_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: order.expenseId, audit: AS_USER });

    const delivery = (await currentLines(order.expenseId)).filter(
      (line) => line.expenseItemId === order.delivery,
    );
    expect(delivery.reduce((total, line) => total + line.amount, 0n)).toBe(20_000n);

    const state = await getRefundAllocationState(database.db, order.expenseId);
    const feeState = state.items.find((item) => item.expenseItemId === order.delivery);
    expect(feeState).toMatchObject({
      grossAmount: 20_000n,
      refundedAmount: 0n,
      netAmount: 20_000n,
    });
  });

  it('never pushes a tax remainder into an unrelated item', async () => {
    const order = await seedTaxedOrder();
    await recordExpenseAdjustment(database.db, {
      expenseId: order.expenseId,
      kind: 'merchant_refund',
      amount: paise(50_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: order.headphones, amount: paise(50_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: order.expenseId, audit: AS_USER });

    const lines = await currentLines(order.expenseId);
    expect(lines.find((line) => line.expenseItemId === order.cable)?.amount).toBe(30_000n);
    expect(
      lines
        .filter((line) => line.expenseItemId === order.gst)
        .reduce((total, line) => total + line.amount, 0n),
    ).toBe(18_000n);
  });

  it('refunds against an order-level discount’s allocated paid-cost basis, not the shelf price', async () => {
    // A ₹1,000 order with a ₹100 order-level discount, allocated across the two *eligible*
    // items by their pre-discount price and exact Largest Remainder rounding. The delivery
    // fee is not eligible, so it keeps its full ₹100 and absorbs none of the discount.
    const eligible = [
      { description: 'Jacket', listPrice: 60_000n },
      { description: 'Socks', listPrice: 30_000n },
    ];
    const discountShares = splitByLargestRemainder(paise(10_000n), [
      { key: 'item-jacket', weight: eligible[0]!.listPrice },
      { key: 'item-socks', weight: eligible[1]!.listPrice },
    ]);
    const paidBasis = eligible.map(
      (item, index) => item.listPrice - (discountShares[index]?.amount ?? 0n),
    );
    expect(paidBasis).toEqual([53_333n, 26_667n]);

    const expenseId = await addExpense(database.db, {
      description: 'Order with a basket-wide discount',
      amount: paise(paidBasis[0]! + paidBasis[1]! + 10_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    const jacket = await addExpenseItem(database.db, {
      expenseId,
      description: 'Jacket (₹600 less its ₹66.67 share of the order discount)',
      amount: paise(paidBasis[0]!),
    });
    const socks = await addExpenseItem(database.db, {
      expenseId,
      description: 'Socks (₹300 less its ₹33.33 share)',
      amount: paise(paidBasis[1]!),
    });
    const shipping = await addExpenseItem(database.db, {
      expenseId,
      description: 'Shipping (not discount-eligible)',
      amount: paise(10_000n),
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'item_based',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: jacket },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            expenseItemId: socks,
          },
          { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: shipping },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    // Returning the socks gets back what was paid for them, not the ₹300 shelf price.
    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(30_000n),
        occurredAt: REFUNDED_AT,
        itemAttributions: [{ expenseItemId: socks, amount: paise(30_000n) }],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_ITEM_CEILING_EXCEEDED' });

    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(paidBasis[1]!),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: socks, amount: paise(paidBasis[1]!) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });

    expect(await shareOf(expenseId, cast.person['person_friend_a']!)).toBe(0n);
    // The jacket keeps its own discounted basis and the shipping keeps all ₹100.
    expect(await shareOf(expenseId, cast.userPersonId)).toBe(63_333n);
  });

  it('never changes the original item composition to make the refund fit', async () => {
    const order = await seedTaxedOrder();
    await recordExpenseAdjustment(database.db, {
      expenseId: order.expenseId,
      kind: 'merchant_refund',
      amount: paise(50_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: order.headphones, amount: paise(50_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: order.expenseId, audit: AS_USER });

    const items = await database.db
      .select({ amount: schema.expenseItems.amount })
      .from(schema.expenseItems)
      .where(eq(schema.expenseItems.expenseId, order.expenseId));
    expect(items.reduce((total, item) => total + item.amount, 0n)).toBe(118_000n);
    expect(items).toHaveLength(4);
  });
});

/* ================================================ 14. mixed legacy and item adjustments */

describe('a legacy whole-expense refund alongside an item-attributed one', () => {
  async function seedMixed(): Promise<Basket> {
    const basket = await seedBasket();
    // A goodwill credit the merchant gave for the order as a whole — no item came back.
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(8_500n),
      reason: 'Late delivery goodwill credit — no item returned',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      audit: AS_USER,
    });
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    return basket;
  }

  it('applies each reduction exactly once, and neither twice', async () => {
    const basket = await seedMixed();
    const result = await distributeAdjustment(database.db, {
      expenseId: basket.expenseId,
      audit: AS_USER,
    });

    expect(result.attributedReduction).toBe(15_000n);
    expect(result.unattributedReduction).toBe(8_500n);
    // ₹1,000 − ₹150 item − ₹85 goodwill = ₹765, and the lines say so.
    expect(await allocationTotal(basket.expenseId)).toBe(76_500n);
    expect(result.netAmount).toBe(76_500n);
  });

  it('keeps the item reduction off the other beneficiary’s share', async () => {
    const basket = await seedMixed();
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    // The user's ₹600 moved only by their proportional part of the ₹85 goodwill credit.
    expect(await shareOf(basket.expenseId, cast.userPersonId)).toBe(54_000n);
    expect(await shareOf(basket.expenseId, cast.person['person_friend_a']!)).toBe(22_500n);
  });

  it('reports the two reductions separately rather than as one number', async () => {
    const basket = await seedMixed();
    const state = await getRefundAllocationState(database.db, basket.expenseId);

    expect(state.basis).toBe('mixed');
    expect(state.attributedReduction).toBe(15_000n);
    expect(state.unattributedReduction).toBe(8_500n);
    // The item's net cost is its own gross less its own refund — the goodwill credit is not
    // pretended to live inside it.
    expect(state.items.find((item) => item.expenseItemId === basket.theirs)).toMatchObject({
      grossAmount: 40_000n,
      refundedAmount: 15_000n,
      netAmount: 25_000n,
    });
  });

  it('lets a human load the whole-expense part onto one beneficiary explicitly', async () => {
    const basket = await seedMixed();
    // `customWeights` is positionally aligned with the current allocation's lines, so the
    // weight set is built from that order rather than assumed — two `item_based` lines can
    // legitimately name the same beneficiary, which is why the contract is positional.
    const current = await loadCurrentAllocation(database.db, basket.expenseId);
    await distributeAdjustment(database.db, {
      expenseId: basket.expenseId,
      customWeights: current!.lines.map((line) => (line.expenseItemId === basket.mine ? 1n : 0n)),
      audit: AS_USER,
    });

    const lines = await currentLines(basket.expenseId);
    const mine = lines.find((line) => line.expenseItemId === basket.mine);
    const theirs = lines.find((line) => line.expenseItemId === basket.theirs);
    expect(mine?.amount).toBe(51_500n);
    // Their item still carries its own ₹150 refund and none of the ₹85 goodwill credit.
    expect(theirs?.amount).toBe(25_000n);
    expect(await allocationTotal(basket.expenseId)).toBe(76_500n);
  });

  it('applies a legacy refund alone through ADR-0008’s unchanged path', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(10_000n),
      occurredAt: REFUNDED_AT,
      audit: AS_USER,
    });
    const result = await distributeAdjustment(database.db, {
      expenseId: basket.expenseId,
      audit: AS_USER,
    });

    expect(result.basis).toBe('whole_expense');
    // ₹100 proportionally over ₹600/₹400: ₹60 / ₹40.
    expect(await shareOf(basket.expenseId, cast.userPersonId)).toBe(54_000n);
    expect(await shareOf(basket.expenseId, cast.person['person_friend_a']!)).toBe(36_000n);
  });
});

/* ============================================ 15 & 16. evidence-first and externally funded */

describe('refunds without a credit, and expenses the user never paid for', () => {
  it('distributes an evidence-first refund that has no Payment yet (19.6)', async () => {
    const basket = await seedBasket();
    await addManualNote(database.db, {
      text: 'Blinkit support confirmed a ₹150 refund for the cold brew; credit not in yet.',
      capturedAt: REFUNDED_AT,
      noteKind: 'documentation',
      expenseId: basket.expenseId,
    });
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      adjustmentPaymentId: null,
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    expect(await shareOf(basket.expenseId, cast.person['person_friend_a']!)).toBe(25_000n);
    // No Payment was fabricated to stand in for the credit that has not arrived.
    const credits = await database.db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(eq(schema.payments.direction, 'credit'));
    expect(credits).toHaveLength(0);
  });

  it('leaves an observed refund credit exactly as imported', async () => {
    const basket = await seedBasket();
    const credit = await seedRefundCredit(paise(15_000n));
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      adjustmentPaymentId: credit,
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const [row] = await database.db
      .select({ amount: schema.payments.amount, direction: schema.payments.direction })
      .from(schema.payments)
      .where(eq(schema.payments.id, credit));
    expect(row).toEqual({ amount: 15_000n, direction: 'credit' });
  });

  it('reduces the user’s own debt when a flatmate fronted the money (ADR-0006)', async () => {
    const flatmateA = cast.person['person_flatmate_a']!;
    const expenseId = await addExpense(database.db, {
      description: 'Flatmate A’s Amazon order for the flat',
      amount: paise(80_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: flatmateA,
    });
    const theirLamp = await addExpenseItem(database.db, {
      expenseId,
      description: 'Lamp (theirs)',
      amount: paise(50_000n),
    });
    const myKettle = await addExpenseItem(database.db, {
      expenseId,
      description: 'Kettle (mine)',
      amount: paise(30_000n),
    });
    // ADR-0006: an externally funded expense has evidence, and deliberately no Payment.
    await addManualNote(database.db, {
      text: 'Flatmate A paid for this order; my kettle is ₹300 of it.',
      capturedAt: PURCHASED_AT,
      noteKind: 'documentation',
      expenseId,
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'item_based',
        lines: [
          { beneficiary: { type: 'person', id: flatmateA }, expenseItemId: theirLamp },
          { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: myKettle },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    expect(await balance(cast.userPersonId, flatmateA)).toBe(30_000n);

    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(12_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: myKettle, amount: paise(12_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });

    expect(await balance(cast.userPersonId, flatmateA)).toBe(18_000n);
    // No Payment was invented for a purchase the user never made.
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });
});

/* ================================================ 17. an already-settled expense, refunded */

describe('a refund after the debt was already settled', () => {
  async function seedSettledThenRefunded(): Promise<Basket> {
    const basket = await seedBasket();
    const friend = cast.person['person_friend_a']!;

    // The friend pays their ₹400 share back in full, into the user's account.
    const settlementPayment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(40_000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-03T09:00:00Z'),
      rawDescription: 'UPI-FRIEND A-settling the basket',
      channel: 'upi',
      counterpartyType: 'person',
      counterpartyId: friend,
    });
    await recordSettlement(database.db, {
      paymentId: settlementPayment,
      counterpartyPersonId: friend,
      amount: paise(40_000n),
      reason: 'Cold brew share',
      audit: AS_USER,
    });
    expect(await balance(friend, cast.userPersonId)).toBe(0n);

    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });
    return basket;
  }

  it('shows the money now owed back to the friend as a reverse balance', async () => {
    await seedSettledThenRefunded();
    const friend = cast.person['person_friend_a']!;

    // Their share is ₹250; they paid ₹400. The ledger says the user owes ₹150 back.
    expect(await balance(friend, cast.userPersonId)).toBe(-15_000n);
    expect(await balance(cast.userPersonId, friend)).toBe(15_000n);
  });

  it('never rewrites or deletes the settlement that was already recorded', async () => {
    await seedSettledThenRefunded();

    const settlements = await database.db
      .select({ amount: schema.settlements.amount })
      .from(schema.settlements);
    expect(settlements).toEqual([{ amount: 40_000n }]);
  });

  it('fabricates no payout Payment for the money owed back', async () => {
    await seedSettledThenRefunded();

    const payments = await database.db
      .select({ amount: schema.payments.amount, direction: schema.payments.direction })
      .from(schema.payments)
      .orderBy(asc(schema.payments.amount));
    // Only the ₹1,000 purchase debit and the ₹400 settlement credit — nothing invented.
    expect(payments).toEqual([
      { amount: 40_000n, direction: 'credit' },
      { amount: 100_000n, direction: 'debit' },
    ]);
  });
});

/* ================================================ 18. a synced expense becoming stale */

describe('an already-synced expense, refunded', () => {
  async function seedSynced(basket: Basket): Promise<string> {
    const integrationId = await insertExternalIntegration(database.db, {
      type: 'splitwise',
      ownerUserId: cast.userId,
      externalAccountRef: 'sw-user-1',
      status: 'connected',
      connectedAt: PURCHASED_AT,
    });
    return insertSplitwiseExpense(database.db, {
      expenseId: basket.expenseId,
      externalIntegrationId: integrationId,
      splitwiseExpenseId: 'sw-expense-1',
      syncedAt: PURCHASED_AT,
      ourSnapshot: { amount: '100000' },
      theirSnapshot: { amount: '100000' },
      syncStatus: 'synced',
    });
  }

  async function syncStatusOf(expenseId: ExpenseId): Promise<string | undefined> {
    const [row] = await database.db
      .select({ syncStatus: schema.splitwiseExpenses.syncStatus })
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    return row?.syncStatus;
  }

  it('moves the synced row to stale when an item refund is distributed', async () => {
    const basket = await seedBasket();
    const splitwiseExpenseId = await seedSynced(basket);
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });

    // Recording alone does not touch the external record; only distribution does.
    expect(await syncStatusOf(basket.expenseId)).toBe('synced');

    const result = await distributeAdjustment(database.db, {
      expenseId: basket.expenseId,
      audit: AS_USER,
    });
    expect(result.staleSplitwiseExpenseIds).toEqual([splitwiseExpenseId]);
    expect(await syncStatusOf(basket.expenseId)).toBe('stale');
  });

  it('records a deletion proposal, not a zero-amount push, for a fully refunded expense', async () => {
    const basket = await seedBasket();
    await seedSynced(basket);
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(100_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [
        { expenseItemId: basket.mine, amount: paise(60_000n) },
        { expenseItemId: basket.theirs, amount: paise(40_000n) },
      ],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const [event] = await database.db
      .select({ newValue: schema.auditEvents.newValue })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'splitwise_expense'));
    expect(event?.newValue).toMatchObject({ syncStatus: 'stale', freshProposal: 'delete' });
  });
});

/* ============================================================ audit and determinism */

describe('the pipeline is auditable and deterministic', () => {
  it('records the item-first basis, both reductions and the net item costs', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    const result = await distributeAdjustment(database.db, {
      expenseId: basket.expenseId,
      audit: AS_USER,
    });

    const [event] = await database.db
      .select({ newValue: schema.auditEvents.newValue })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, result.allocationId));

    expect(event?.newValue).toMatchObject({
      basis: 'item_attributed',
      attributedReduction: '15000',
      unattributedReduction: '0',
      netAmount: '85000',
    });
    expect((event?.newValue as { itemNetCosts: unknown[] }).itemNetCosts).toContainEqual({
      expenseItemId: basket.theirs,
      grossAmount: '40000',
      refundedAmount: '15000',
      netAmount: '25000',
    });
  });

  it('produces byte-identical lines for two identically-seeded expenses', async () => {
    const first = await seedBasket();
    const second = await seedBasket();

    for (const basket of [first, second]) {
      await recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(13_337n),
        occurredAt: REFUNDED_AT,
        itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(13_337n) }],
        audit: AS_USER,
      });
      await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });
    }

    const amountsOf = async (basket: Basket): Promise<bigint[]> =>
      (await currentLines(basket.expenseId)).map((line) => line.amount).sort();
    expect(await amountsOf(first)).toEqual(await amountsOf(second));
    expect(await allocationTotal(first.expenseId)).toBe(86_663n);
  });

  it('carries an amount past IEEE-754 integer precision through the whole pipeline', async () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const expenseId = await addExpense(database.db, {
      description: 'A very large shared purchase',
      amount: paise(huge * 2n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    const ours = await addExpenseItem(database.db, {
      expenseId,
      description: 'Mine',
      amount: paise(huge),
    });
    const theirs = await addExpenseItem(database.db, {
      expenseId,
      description: 'Theirs',
      amount: paise(huge),
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'item_based',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: ours },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            expenseItemId: theirs,
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(huge - 1n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: theirs, amount: paise(huge - 1n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });

    expect(await shareOf(expenseId, cast.person['person_friend_a']!)).toBe(1n);
    expect(await shareOf(expenseId, cast.userPersonId)).toBe(huge);
  });
});

/* ============================================================ the read surface itself */

describe('getRefundAllocationState', () => {
  it('reports nothing pending for an expense with no adjustments at all', async () => {
    const basket = await seedBasket();
    const state = await getRefundAllocationState(database.db, basket.expenseId);

    expect(state).toMatchObject({
      basis: 'none',
      grossAmount: 100_000n,
      netAmount: 100_000n,
      attributedReduction: 0n,
      unattributedReduction: 0n,
      pendingReduction: 0n,
      pendingDistribution: false,
      obligationsReflectAdjustments: true,
      projectedLines: null,
      reviewRequired: null,
    });
    expect(state.currentAllocation?.total).toBe(100_000n);
  });

  it('shows gross beside net, per item, rather than replacing one with the other', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    const state = await getRefundAllocationState(database.db, basket.expenseId);

    expect(state.grossAmount).toBe(100_000n);
    expect(state.netAmount).toBe(85_000n);
    expect(state.items).toHaveLength(2);
    expect(state.items.find((item) => item.expenseItemId === basket.mine)).toMatchObject({
      description: 'Groceries (mine)',
      grossAmount: 60_000n,
      refundedAmount: 0n,
      netAmount: 60_000n,
    });
    expect(state.items.find((item) => item.expenseItemId === basket.theirs)).toMatchObject({
      description: 'Cold brew (theirs)',
      grossAmount: 40_000n,
      // The item's gross cost is still exactly what it was; only the derived figure moved.
      refundedAmount: 15_000n,
      netAmount: 25_000n,
    });
  });

  it('says obligations are current again once the refund is distributed', async () => {
    const basket = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const state = await getRefundAllocationState(database.db, basket.expenseId);
    expect(state.pendingDistribution).toBe(false);
    expect(state.obligationsReflectAdjustments).toBe(true);
    expect(state.basis).toBe('item_attributed');
  });

  it('reports an expense with no allocation yet without inventing one', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Approved, not yet allocated',
      amount: paise(50_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    const only = await addExpenseItem(database.db, {
      expenseId,
      description: 'The item',
      amount: paise(50_000n),
    });
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(5_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: only, amount: paise(5_000n) }],
      audit: AS_USER,
    });

    const state = await getRefundAllocationState(database.db, expenseId);
    expect(state.currentAllocation).toBeNull();
    expect(state.projectedLines).toBeNull();
    // The item's cost reduction is computed even though no allocation exists yet — ADR-0018
    // is explicit that it must be.
    expect(state.items[0]).toMatchObject({ netAmount: 45_000n, refundedAmount: 5_000n });
    expect(state.obligationsReflectAdjustments).toBe(false);
  });
});
