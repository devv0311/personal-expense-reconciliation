/**
 * Item-level refund attribution through the service (ADR-0018 (item refunds), 19.1–19.6).
 *
 * The domain unit tests prove the rules; these prove the transaction. Every case here is
 * about something a pure function cannot see: what other rows already attribute, whether a
 * rejected set left an adjustment behind, whether two concurrent refunds can both fit under
 * one ceiling, and whether the original purchase composition survived.
 */

import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paise } from '../../src/domain/index.js';
import type { ExpenseId, ExpenseItemId, Paise, PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import { recordExpenseAdjustment } from '../../src/services/index.js';
import { addExpense, addExpenseItem, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';

let database: TestDatabase;
let cast: Cast;

const audit = { actor: 'user', source: 'tests/refund-attribution' } as const;

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

/**
 * ADR-0018's worked example: a ₹1,000 basket the user paid for, holding the user's ₹600 item
 * and a friend's ₹400 item.
 */
async function seedBasket(): Promise<{
  expenseId: ExpenseId;
  mine: ExpenseItemId;
  theirs: ExpenseItemId;
}> {
  const expenseId = await addExpense(database.db, {
    description: 'Blinkit basket',
    amount: paise(100_000n),
    occurredAt: new Date('2026-07-01T10:00:00Z'),
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
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
  return { expenseId, mine, theirs };
}

async function seedRefundCredit(amount: Paise): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount,
    direction: 'credit',
    occurredAt: new Date('2026-07-05T10:00:00Z'),
    rawDescription: 'BLINKIT REFUND',
    channel: 'upi',
    counterpartyType: 'merchant',
  });
}

async function attributionsFor(expenseId: ExpenseId) {
  return database.db
    .select({
      expenseItemId: schema.expenseAdjustmentItems.expenseItemId,
      amount: schema.expenseAdjustmentItems.amount,
    })
    .from(schema.expenseAdjustmentItems)
    .innerJoin(
      schema.expenseAdjustments,
      eq(schema.expenseAdjustmentItems.expenseAdjustmentId, schema.expenseAdjustments.id),
    )
    .where(eq(schema.expenseAdjustments.originalExpenseId, expenseId))
    .orderBy(asc(schema.expenseAdjustmentItems.amount));
}

describe('the worked shared-purchase example (ADR-0018 (item refunds))', () => {
  it('attributes a ₹150 refund entirely to the friend’s ₹400 item', async () => {
    const { expenseId, mine, theirs } = await seedBasket();

    const result = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
      audit,
    });

    expect(result.netAmountAfter).toBe(85_000n);
    expect(result.itemAttributions).toEqual([
      { expenseItemId: theirs, amount: 15_000n, netItemAmount: 25_000n },
    ]);
    // The user's item is untouched: a proportional distribution would have reduced it too,
    // for something the merchant never took back.
    const rows = await database.db
      .select({ id: schema.expenseItems.id, amount: schema.expenseItems.amount })
      .from(schema.expenseItems)
      .where(eq(schema.expenseItems.expenseId, expenseId));
    expect(rows.find((row) => row.id === mine)?.amount).toBe(60_000n);
    expect(rows.find((row) => row.id === theirs)?.amount).toBe(40_000n);
  });

  it('leaves the original purchase composition and gross amount untouched (19.5)', async () => {
    const { expenseId, theirs } = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
      audit,
    });

    const [expense] = await database.db
      .select({ amount: schema.expenses.amount })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expenseId));
    const items = await database.db
      .select({ amount: schema.expenseItems.amount })
      .from(schema.expenseItems)
      .where(eq(schema.expenseItems.expenseId, expenseId));

    expect(expense?.amount).toBe(100_000n);
    expect(items.reduce((total, item) => total + item.amount, 0n)).toBe(100_000n);
  });

  it('leaves the refund credit Payment exactly as imported (19.6)', async () => {
    const { expenseId, theirs } = await seedBasket();
    const creditId = await seedRefundCredit(paise(15_000n));

    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      adjustmentPaymentId: creditId,
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
      audit,
    });

    const [credit] = await database.db
      .select({ amount: schema.payments.amount, direction: schema.payments.direction })
      .from(schema.payments)
      .where(eq(schema.payments.id, creditId));
    expect(credit?.amount).toBe(15_000n);
    expect(credit?.direction).toBe('credit');
  });

  it('audits the attribution against its own entity, not only the adjustment', async () => {
    const { expenseId, theirs } = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
      audit,
    });

    const events = await database.db
      .select({ newValue: schema.auditEvents.newValue })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'expense_adjustment_item'));

    expect(events).toHaveLength(1);
    expect(events[0]?.newValue).toMatchObject({ amount: '15000', netItemAmount: '25000' });
  });
});

describe('multi-item, successive and full refunds', () => {
  it('records a refund covering two items in one adjustment', async () => {
    const { expenseId, mine, theirs } = await seedBasket();

    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(35_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [
        { expenseItemId: mine, amount: paise(20_000n) },
        { expenseItemId: theirs, amount: paise(15_000n) },
      ],
      audit,
    });

    expect(await attributionsFor(expenseId)).toEqual([
      { expenseItemId: theirs, amount: 15_000n },
      { expenseItemId: mine, amount: 20_000n },
    ]);
  });

  it('accumulates successive refunds against one item', async () => {
    const { expenseId, theirs } = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
      audit,
    });

    const second = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(10_000n),
      occurredAt: new Date('2026-07-08T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(10_000n) }],
      audit,
    });

    expect(second.netAmountAfter).toBe(75_000n);
    expect(second.itemAttributions[0]?.netItemAmount).toBe(15_000n);
  });

  it('allows an item to be fully refunded, down to a zero net cost', async () => {
    const { expenseId, theirs } = await seedBasket();

    const result = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(40_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(40_000n) }],
      audit,
    });

    expect(result.itemAttributions[0]?.netItemAmount).toBe(0n);
  });

  it('allows the whole expense to be refunded item by item', async () => {
    const { expenseId, mine, theirs } = await seedBasket();

    const result = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(100_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [
        { expenseItemId: mine, amount: paise(60_000n) },
        { expenseItemId: theirs, amount: paise(40_000n) },
      ],
      audit,
    });

    expect(result.netAmountAfter).toBe(0n);
  });

  it('handles a third-party reimbursement exactly as a merchant refund', async () => {
    const { expenseId, theirs } = await seedBasket();

    const result = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'third_party_reimbursement',
      amount: paise(15_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
      audit,
    });

    // The distinction lives in `ExpenseAdjustment.kind`; the attribution shape does not vary.
    expect(result.itemAttributions[0]?.netItemAmount).toBe(25_000n);
  });
});

describe('rejected attribution leaves nothing behind', () => {
  async function expectRefusal(
    input: Parameters<typeof recordExpenseAdjustment>[1],
    code: string,
  ): Promise<void> {
    await expect(recordExpenseAdjustment(database.db, input)).rejects.toMatchObject({ code });

    const adjustments = await database.db.select().from(schema.expenseAdjustments);
    const attributions = await database.db.select().from(schema.expenseAdjustmentItems);
    // The item refund and the financial event it attributes are one decision; half of one is
    // not a smaller version of it.
    expect(adjustments).toHaveLength(0);
    expect(attributions).toHaveLength(0);
  }

  it('refuses attributions that do not sum to the adjustment (19.2)', async () => {
    const { expenseId, theirs } = await seedBasket();

    await expectRefusal(
      {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(20_000n),
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
        audit,
      },
      'REFUND_ATTRIBUTION_SUM_MISMATCH',
    );
  });

  it('refuses an item belonging to a different expense (19.1)', async () => {
    const { expenseId } = await seedBasket();
    const otherExpenseId = await addExpense(database.db, {
      description: 'A different Blinkit basket',
      amount: paise(50_000n),
      occurredAt: new Date('2026-06-01T10:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    const foreignItem = await addExpenseItem(database.db, {
      expenseId: otherExpenseId,
      description: 'Same merchant, different order',
      amount: paise(50_000n),
    });

    await expectRefusal(
      {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [{ expenseItemId: foreignItem, amount: paise(15_000n) }],
        audit,
      },
      'REFUND_ATTRIBUTION_CROSS_EXPENSE',
    );
  });

  it('refuses a cumulative attribution above the item’s gross cost (19.3)', async () => {
    const { expenseId, theirs } = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(30_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(30_000n) }],
      audit,
    });

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        occurredAt: new Date('2026-07-08T10:00:00Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
        audit,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_ITEM_CEILING_EXCEEDED' });

    // The first refund survives; only the second is refused.
    expect(await attributionsFor(expenseId)).toHaveLength(1);
  });

  it('refuses a zero-amount attribution (19.4)', async () => {
    const { expenseId, mine, theirs } = await seedBasket();

    await expectRefusal(
      {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [
          { expenseItemId: theirs, amount: paise(15_000n) },
          { expenseItemId: mine, amount: paise(0n) },
        ],
        audit,
      },
      'MONEY_NEGATIVE',
    );
  });

  it('refuses to draw more from a refund credit than actually came back (19.6)', async () => {
    const { expenseId, theirs } = await seedBasket();
    const creditId = await seedRefundCredit(paise(10_000n));

    await expectRefusal(
      {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        adjustmentPaymentId: creditId,
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
        audit,
      },
      'PAYMENT_BUDGET_EXCEEDED',
    );
  });

  it('counts what other adjustments already draw from the same credit (19.6)', async () => {
    const { expenseId, mine, theirs } = await seedBasket();
    const creditId = await seedRefundCredit(paise(20_000n));
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      adjustmentPaymentId: creditId,
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
      audit,
    });

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(10_000n),
        adjustmentPaymentId: creditId,
        occurredAt: new Date('2026-07-06T10:00:00Z'),
        itemAttributions: [{ expenseItemId: mine, amount: paise(10_000n) }],
        audit,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_BUDGET_EXCEEDED' });
  });

  it('refuses item attribution against an expense that was never itemized', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'A whole-expense purchase',
      amount: paise(100_000n),
      occurredAt: new Date('2026-07-01T10:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    const { theirs } = await seedBasket();

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(15_000n),
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(15_000n) }],
        audit,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('legacy whole-expense refunds keep ADR-0008’s path (19.2)', () => {
  it('records an adjustment with no attribution rows at all', async () => {
    const { expenseId } = await seedBasket();

    const result = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      audit,
    });

    expect(result.itemAttributions).toEqual([]);
    expect(await attributionsFor(expenseId)).toHaveLength(0);
    expect(result.netAmountAfter).toBe(85_000n);
  });

  it('still enforces the expense-wide ceiling alongside an item refund', async () => {
    const { expenseId, theirs } = await seedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(70_000n),
      occurredAt: new Date('2026-07-04T10:00:00Z'),
      audit,
    });

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(40_000n),
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(40_000n) }],
        audit,
      }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_EXCEEDS_EXPENSE' });
  });
});

describe('concurrency — one remaining ceiling cannot be spent twice (19.3)', () => {
  it('refuses the second of two simultaneous refunds of the same item', async () => {
    const { expenseId, theirs } = await seedBasket();

    const both = await Promise.allSettled([
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(25_000n),
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(25_000n) }],
        audit,
      }),
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(25_000n),
        occurredAt: new Date('2026-07-05T10:00:01Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(25_000n) }],
        audit,
      }),
    ]);

    // Both fit on their own against the ₹400 item; together they exceed it. Exactly one
    // survives, whichever wins the row lock on the parent expense.
    expect(both.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await attributionsFor(expenseId)).toEqual([{ expenseItemId: theirs, amount: 25_000n }]);
  });

  it('lets two simultaneous refunds that both fit through', async () => {
    const { expenseId, mine, theirs } = await seedBasket();

    const both = await Promise.allSettled([
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(20_000n),
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(20_000n) }],
        audit,
      }),
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(20_000n),
        occurredAt: new Date('2026-07-05T10:00:01Z'),
        itemAttributions: [{ expenseItemId: mine, amount: paise(20_000n) }],
        audit,
      }),
    ]);

    expect(both.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(await attributionsFor(expenseId)).toHaveLength(2);
  });
});

describe('integer paise, end to end', () => {
  it('attributes an odd-paise refund exactly, with no rounding anywhere', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'An awkward total',
      amount: paise(33_334n),
      occurredAt: new Date('2026-07-01T10:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    const first = await addExpenseItem(database.db, {
      expenseId,
      description: 'Item A',
      amount: paise(11_111n),
    });
    const second = await addExpenseItem(database.db, {
      expenseId,
      description: 'Item B',
      amount: paise(22_223n),
    });

    const result = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(33_334n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [
        { expenseItemId: first, amount: paise(11_111n) },
        { expenseItemId: second, amount: paise(22_223n) },
      ],
      audit,
    });

    expect(result.netAmountAfter).toBe(0n);
    expect(result.itemAttributions.every((entry) => entry.netItemAmount === 0n)).toBe(true);
  });

  it('stores an attribution above IEEE-754 integer precision without loss', async () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const expenseId = await addExpense(database.db, {
      description: 'A very large purchase',
      amount: paise(huge),
      occurredAt: new Date('2026-07-01T10:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    const itemId = await addExpenseItem(database.db, {
      expenseId,
      description: 'The item',
      amount: paise(huge),
    });

    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(huge - 1n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      itemAttributions: [{ expenseItemId: itemId, amount: paise(huge - 1n) }],
      audit,
    });

    const rows = await attributionsFor(expenseId);
    expect(rows[0]?.amount).toBe(huge - 1n);
  });

  it('refuses a one-paise overshoot of an item’s ceiling', async () => {
    const { expenseId, theirs } = await seedBasket();

    await expect(
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(40_001n),
        occurredAt: new Date('2026-07-05T10:00:00Z'),
        itemAttributions: [{ expenseItemId: theirs, amount: paise(40_001n) }],
        audit,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_ITEM_CEILING_EXCEEDED' });
  });
});
