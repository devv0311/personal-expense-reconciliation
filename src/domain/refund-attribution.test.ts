import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { asId } from './ids.js';
import type { ExpenseId, ExpenseItemId } from './ids.js';
import { paise } from './money.js';
import {
  attributionTotalsByItem,
  netItemAmount,
  remainingRefundableItemAmount,
  validateRefundAttribution,
} from './refund-attribution.js';
import type { RefundAttributionInput, RefundAttributionItemContext } from './refund-attribution.js';

const BASKET = asId<'expense'>('11111111-1111-4111-8111-111111111111') as ExpenseId;
const OTHER_EXPENSE = asId<'expense'>('22222222-2222-4222-8222-222222222222') as ExpenseId;

/** ADR-0018's worked example: the user's ₹600 item and the friend's ₹400 item in one ₹1,000 basket. */
const MINE = asId<'expense_item'>('aaaaaaaa-0000-4000-8000-000000000001') as ExpenseItemId;
const THEIRS = asId<'expense_item'>('aaaaaaaa-0000-4000-8000-000000000002') as ExpenseItemId;
const FOREIGN = asId<'expense_item'>('aaaaaaaa-0000-4000-8000-000000000003') as ExpenseItemId;

function item(
  expenseItemId: ExpenseItemId,
  grossAmount: bigint,
  overrides: Partial<RefundAttributionItemContext> = {},
): RefundAttributionItemContext {
  return {
    expenseItemId,
    expenseId: BASKET,
    grossAmount: paise(grossAmount),
    alreadyAttributed: paise(0n),
    ...overrides,
  };
}

function refund(overrides: Partial<RefundAttributionInput> = {}): RefundAttributionInput {
  return {
    expenseId: BASKET,
    adjustmentAmount: paise(15_000n),
    attributions: [{ expenseItemId: THEIRS, amount: paise(15_000n) }],
    items: [item(MINE, 60_000n), item(THEIRS, 40_000n)],
    expenseGrossAmount: paise(100_000n),
    otherAdjustmentAmounts: [],
    ...overrides,
  };
}

function codeOf(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('Expected the call to throw a DomainError, but it returned.');
}

describe("ADR-0018's worked shared-purchase example", () => {
  it('accepts a ₹150 refund attributed entirely to the friend’s ₹400 item', () => {
    expect(() => validateRefundAttribution(refund())).not.toThrow();
  });

  it('leaves the friend’s item at ₹250 net and the user’s ₹600 item untouched', () => {
    // The whole point of item attribution: a proportional distribution would have reduced the
    // user's ₹600 item too, for something the merchant never took back.
    expect(netItemAmount(paise(40_000n), [paise(15_000n)])).toBe(25_000n);
    expect(netItemAmount(paise(60_000n), [])).toBe(60_000n);
  });
});

describe('19.1 — the item belongs to the adjustment’s own expense', () => {
  it('rejects an item belonging to a different expense, however similar the purchase', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            attributions: [{ expenseItemId: FOREIGN, amount: paise(15_000n) }],
            items: [
              item(MINE, 60_000n),
              item(THEIRS, 40_000n),
              item(FOREIGN, 90_000n, { expenseId: OTHER_EXPENSE }),
            ],
          }),
        ),
      ),
    ).toBe('REFUND_ATTRIBUTION_CROSS_EXPENSE');
  });

  it('rejects an item nothing in the input set describes', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({ attributions: [{ expenseItemId: FOREIGN, amount: paise(15_000n) }] }),
        ),
      ),
    ).toBe('UNKNOWN_REFERENCE');
  });
});

describe('19.2 — attributions sum exactly to the adjustment', () => {
  it('rejects a partial proposal rather than recording an unexplained remainder', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(20_000n),
            attributions: [{ expenseItemId: THEIRS, amount: paise(15_000n) }],
          }),
        ),
      ),
    ).toBe('REFUND_ATTRIBUTION_SUM_MISMATCH');
  });

  it('rejects attributions that overshoot the adjustment', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(10_000n),
            attributions: [{ expenseItemId: THEIRS, amount: paise(15_000n) }],
          }),
        ),
      ),
    ).toBe('REFUND_ATTRIBUTION_SUM_MISMATCH');
  });

  it('rejects an empty set — that is a legacy whole-expense refund, not an item refund', () => {
    expect(codeOf(() => validateRefundAttribution(refund({ attributions: [] })))).toBe(
      'REFUND_ATTRIBUTION_SUM_MISMATCH',
    );
  });

  it('accepts a multi-item refund whose parts sum exactly', () => {
    expect(() =>
      validateRefundAttribution(
        refund({
          adjustmentAmount: paise(35_000n),
          attributions: [
            { expenseItemId: MINE, amount: paise(20_000n) },
            { expenseItemId: THEIRS, amount: paise(15_000n) },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('sums to the last paise, not to the nearest rupee', () => {
    expect(() =>
      validateRefundAttribution(
        refund({
          adjustmentAmount: paise(33_334n),
          attributions: [
            { expenseItemId: MINE, amount: paise(11_111n) },
            { expenseItemId: THEIRS, amount: paise(22_223n) },
          ],
        }),
      ),
    ).not.toThrow();

    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(33_334n),
            attributions: [
              { expenseItemId: MINE, amount: paise(11_111n) },
              { expenseItemId: THEIRS, amount: paise(22_222n) },
            ],
          }),
        ),
      ),
    ).toBe('REFUND_ATTRIBUTION_SUM_MISMATCH');
  });

  it('rejects one item attributed twice within a single adjustment', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(20_000n),
            attributions: [
              { expenseItemId: THEIRS, amount: paise(15_000n) },
              { expenseItemId: THEIRS, amount: paise(5_000n) },
            ],
          }),
        ),
      ),
    ).toBe('REFUND_ATTRIBUTION_DUPLICATE_ITEM');
  });
});

describe('19.3 — cumulative ceilings, never the newest row alone', () => {
  it('accepts a refund that exactly exhausts an item', () => {
    expect(() =>
      validateRefundAttribution(
        refund({
          adjustmentAmount: paise(40_000n),
          attributions: [{ expenseItemId: THEIRS, amount: paise(40_000n) }],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a single refund above the item’s gross cost', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(40_001n),
            attributions: [{ expenseItemId: THEIRS, amount: paise(40_001n) }],
          }),
        ),
      ),
    ).toBe('REFUND_ITEM_CEILING_EXCEEDED');
  });

  it('rejects a successive refund that fits on its own but not cumulatively', () => {
    // Three ₹40 refunds against a ₹100 item each pass a newest-row-only check, and together
    // take back more than the item ever cost. This is the case 19.3 calls out by name.
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(4_000n),
            attributions: [{ expenseItemId: THEIRS, amount: paise(4_000n) }],
            items: [
              item(MINE, 60_000n),
              item(THEIRS, 10_000n, { alreadyAttributed: paise(8_000n) }),
            ],
            otherAdjustmentAmounts: [paise(8_000n)],
          }),
        ),
      ),
    ).toBe('REFUND_ITEM_CEILING_EXCEEDED');
  });

  it('accepts a successive refund that still fits under the cumulative ceiling', () => {
    expect(() =>
      validateRefundAttribution(
        refund({
          adjustmentAmount: paise(2_000n),
          attributions: [{ expenseItemId: THEIRS, amount: paise(2_000n) }],
          items: [item(MINE, 60_000n), item(THEIRS, 10_000n, { alreadyAttributed: paise(8_000n) })],
          otherAdjustmentAmounts: [paise(8_000n)],
        }),
      ),
    ).not.toThrow();
  });

  it('still enforces the expense-wide ceiling when every item fits its own', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(40_000n),
            attributions: [{ expenseItemId: THEIRS, amount: paise(40_000n) }],
            // A legacy whole-expense adjustment already took ₹700 of the ₹1,000 basket.
            otherAdjustmentAmounts: [paise(70_000n)],
          }),
        ),
      ),
    ).toBe('ADJUSTMENT_EXCEEDS_EXPENSE');
  });

  it('reports the remaining refundable basis for an item', () => {
    expect(remainingRefundableItemAmount(paise(40_000n), [paise(15_000n)])).toBe(25_000n);
    expect(remainingRefundableItemAmount(paise(40_000n), [paise(40_000n)])).toBe(0n);
  });

  it('refuses to compute a negative net item cost', () => {
    expect(codeOf(() => netItemAmount(paise(40_000n), [paise(40_001n)]))).toBe(
      'REFUND_ITEM_CEILING_EXCEEDED',
    );
  });
});

describe('19.4 — strictly positive integer paise', () => {
  it('rejects a zero attribution, which asserts an item was refunded for nothing', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(15_000n),
            attributions: [
              { expenseItemId: THEIRS, amount: paise(15_000n) },
              { expenseItemId: MINE, amount: paise(0n) },
            ],
          }),
        ),
      ),
    ).toBe('MONEY_NEGATIVE');
  });

  it('rejects a negative attribution — a clawback is new spend, not a signed refund', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(10_000n),
            attributions: [
              { expenseItemId: THEIRS, amount: paise(15_000n) },
              { expenseItemId: MINE, amount: paise(-5_000n) },
            ],
          }),
        ),
      ),
    ).toBe('MONEY_NEGATIVE');
  });

  it('rejects a zero-amount parent adjustment', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            adjustmentAmount: paise(0n),
            attributions: [{ expenseItemId: THEIRS, amount: paise(0n) }],
          }),
        ),
      ),
    ).toBe('MONEY_NEGATIVE');
  });

  it('accepts a one-paise refund', () => {
    expect(() =>
      validateRefundAttribution(
        refund({
          adjustmentAmount: paise(1n),
          attributions: [{ expenseItemId: THEIRS, amount: paise(1n) }],
        }),
      ),
    ).not.toThrow();
  });
});

describe('19.6 — the refund credit is immutable evidence', () => {
  it('rejects adjustments drawing more than the credit that actually came back', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            refundPayment: { amount: paise(10_000n), alreadyAttributed: paise(0n) },
          }),
        ),
      ),
    ).toBe('PAYMENT_BUDGET_EXCEEDED');
  });

  it('counts what other adjustments already draw from the same credit', () => {
    expect(
      codeOf(() =>
        validateRefundAttribution(
          refund({
            refundPayment: { amount: paise(20_000n), alreadyAttributed: paise(10_000n) },
          }),
        ),
      ),
    ).toBe('PAYMENT_BUDGET_EXCEEDED');
  });

  it('accepts a partial draw, leaving the credit’s remainder unexplained', () => {
    expect(() =>
      validateRefundAttribution(
        refund({ refundPayment: { amount: paise(50_000n), alreadyAttributed: paise(0n) } }),
      ),
    ).not.toThrow();
  });

  it('accepts an evidence-first adjustment with no credit Payment at all', () => {
    expect(() => validateRefundAttribution(refund())).not.toThrow();
  });
});

describe('attributionTotalsByItem', () => {
  it('groups a set by item', () => {
    const totals = attributionTotalsByItem([
      { expenseItemId: MINE, amount: paise(20_000n) },
      { expenseItemId: THEIRS, amount: paise(15_000n) },
    ]);

    expect(totals.get(MINE)).toBe(20_000n);
    expect(totals.get(THEIRS)).toBe(15_000n);
  });

  it('sums repeated entries exactly rather than overwriting them', () => {
    const totals = attributionTotalsByItem([
      { expenseItemId: THEIRS, amount: paise(15_000n) },
      { expenseItemId: THEIRS, amount: paise(5_001n) },
    ]);

    expect(totals.get(THEIRS)).toBe(20_001n);
  });
});
