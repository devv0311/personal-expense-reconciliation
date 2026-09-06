import { describe, expect, it } from 'vitest';

import type { DraftAllocationLine } from './allocation.js';
import { DomainError } from './errors.js';
import { asId } from './ids.js';
import type { BeneficiaryRef, ExpenseItemId, PersonId } from './ids.js';
import { paise, sumPaise } from './money.js';
import type { Paise } from './money.js';
import {
  buildItemAwareAllocationLines,
  deriveItemRefundBases,
  itemAwareAllocationTotal,
  validateItemNetLineSums,
} from './refund-allocation.js';
import type { ItemRefundBasis } from './refund-allocation.js';

const dev = asId<'person'>('person_dev');
const friendA = asId<'person'>('person_friend_a');
const flatmateA = asId<'person'>('person_flatmate_a');
const flatmateC = asId<'person'>('person_flatmate_c');

const mine = asId<'expense_item'>('item_a_mine');
const theirs = asId<'expense_item'>('item_b_theirs');
const shared = asId<'expense_item'>('item_c_shared');

function person(id: PersonId): BeneficiaryRef {
  return { type: 'person', id };
}

function line(
  id: PersonId,
  amount: bigint,
  expenseItemId: ExpenseItemId | null,
): DraftAllocationLine {
  return { beneficiary: person(id), amount: paise(amount), percentage: null, expenseItemId };
}

function amounts(lines: readonly DraftAllocationLine[]): bigint[] {
  return lines.map((entry) => entry.amount);
}

function refunds(
  entries: ReadonlyArray<[ExpenseItemId, bigint]>,
): ReadonlyMap<ExpenseItemId, Paise> {
  return new Map(entries.map(([id, amount]) => [id, paise(amount)]));
}

/** ADR-0018's worked basket: the user's ₹600 item and a friend's ₹400 item. */
function basket(
  refundedByItem: ReadonlyMap<ExpenseItemId, Paise> = new Map(),
): readonly ItemRefundBasis[] {
  return deriveItemRefundBases(
    [
      { expenseItemId: mine, grossAmount: paise(60_000n) },
      { expenseItemId: theirs, grossAmount: paise(40_000n) },
    ],
    refundedByItem,
  );
}

const basketLines = [line(dev, 60_000n, mine), line(friendA, 40_000n, theirs)];

describe('deriveItemRefundBases — gross stays gross, net is derived', () => {
  it('subtracts cumulative attributions without touching the gross amount', () => {
    const bases = basket(refunds([[theirs, 15_000n]]));

    expect(bases).toEqual([
      { expenseItemId: mine, grossAmount: 60_000n, refundedAmount: 0n, netAmount: 60_000n },
      { expenseItemId: theirs, grossAmount: 40_000n, refundedAmount: 15_000n, netAmount: 25_000n },
    ]);
  });

  it('returns never-refunded items untouched, so a non-refunded fee stays in the net cost', () => {
    const fee = asId<'expense_item'>('item_delivery_fee');
    const bases = deriveItemRefundBases(
      [
        { expenseItemId: theirs, grossAmount: paise(40_000n) },
        { expenseItemId: fee, grossAmount: paise(3_000n) },
      ],
      refunds([[theirs, 40_000n]]),
    );

    expect(bases[0]?.netAmount).toBe(0n);
    // The merchant took the item back; the delivery charge is not coming back with it.
    expect(bases[1]).toMatchObject({ refundedAmount: 0n, netAmount: 3_000n });
  });

  it('refuses attributions that would make an item cost less than nothing (19.3)', () => {
    expect(() => basket(refunds([[theirs, 40_001n]]))).toThrow(DomainError);
    try {
      basket(refunds([[theirs, 40_001n]]));
    } catch (error) {
      expect((error as DomainError).code).toBe('REFUND_ITEM_CEILING_EXCEEDED');
    }
  });
});

describe('buildItemAwareAllocationLines — the worked shared-purchase example', () => {
  it('takes the whole ₹150 refund off the friend’s item and leaves the user’s ₹600 alone', () => {
    const result = buildItemAwareAllocationLines({
      lines: basketLines,
      itemBases: basket(refunds([[theirs, 15_000n]])),
      legacyReduction: paise(0n),
    });

    // ADR-0018's worked example, exactly: ₹600 and ₹250, totalling ₹850.
    expect(amounts(result)).toEqual([60_000n, 25_000n]);
    expect(sumPaise(amounts(result).map(paise))).toBe(85_000n);
  });

  it('is what the whole-expense proportional default would have got wrong', () => {
    const result = buildItemAwareAllocationLines({
      lines: basketLines,
      itemBases: basket(refunds([[theirs, 15_000n]])),
      legacyReduction: paise(0n),
    });

    // Proportionally, ₹150 over ₹600/₹400 lines is ₹90/₹60 — handing the user ₹90 back for
    // an item the merchant never took, and shrinking a debt the friend still owes.
    expect(result[0]?.amount).not.toBe(51_000n);
    expect(result[1]?.amount).not.toBe(34_000n);
  });

  it('keeps every beneficiary, its item link and its percentage field', () => {
    const result = buildItemAwareAllocationLines({
      lines: basketLines,
      itemBases: basket(refunds([[theirs, 15_000n]])),
      legacyReduction: paise(0n),
    });

    expect(result.map((entry) => entry.beneficiary.id)).toEqual([dev, friendA]);
    expect(result.map((entry) => entry.expenseItemId)).toEqual([mine, theirs]);
    expect(result.every((entry) => entry.percentage === null)).toBe(true);
  });

  it('zeroes a fully refunded item without erasing its beneficiary (ADR-0013)', () => {
    const result = buildItemAwareAllocationLines({
      lines: basketLines,
      itemBases: basket(refunds([[theirs, 40_000n]])),
      legacyReduction: paise(0n),
    });

    expect(amounts(result)).toEqual([60_000n, 0n]);
    expect(result).toHaveLength(2);
  });

  it('keeps one zero-amount line per beneficiary when the whole basket comes back', () => {
    const result = buildItemAwareAllocationLines({
      lines: basketLines,
      itemBases: basket(
        refunds([
          [mine, 60_000n],
          [theirs, 40_000n],
        ]),
      ),
      legacyReduction: paise(0n),
    });

    expect(amounts(result)).toEqual([0n, 0n]);
    expect(result.map((entry) => entry.beneficiary.id)).toEqual([dev, friendA]);
  });
});

describe('buildItemAwareAllocationLines — genuinely shared items', () => {
  const sharedLines = [
    line(dev, 50_000n, shared),
    line(flatmateA, 30_000n, shared),
    line(flatmateC, 20_000n, shared),
  ];
  const sharedItem = (refunded: bigint): readonly ItemRefundBasis[] =>
    deriveItemRefundBases(
      [{ expenseItemId: shared, grossAmount: paise(100_000n) }],
      refunds([[shared, refunded]]),
    );

  it('apportions a shared item’s net cost by its approved shares, exactly', () => {
    const result = buildItemAwareAllocationLines({
      lines: sharedLines,
      itemBases: sharedItem(50_000n),
      legacyReduction: paise(0n),
    });

    expect(amounts(result)).toEqual([25_000n, 15_000n, 10_000n]);
    expect(sumPaise(amounts(result).map(paise))).toBe(50_000n);
  });

  it('hands out the odd paise by Largest Remainder, never by dropping it', () => {
    const result = buildItemAwareAllocationLines({
      lines: [line(dev, 1n, shared), line(flatmateA, 1n, shared), line(flatmateC, 1n, shared)],
      itemBases: deriveItemRefundBases(
        [{ expenseItemId: shared, grossAmount: paise(3n) }],
        refunds([[shared, 1n]]),
      ),
      legacyReduction: paise(0n),
    });

    // 2 paise across three equal shares: two lines get 1, one gets 0, and the parts still
    // sum to the whole (invariants.md #12).
    expect(sumPaise(amounts(result).map(paise))).toBe(2n);
    expect([...amounts(result)].sort()).toEqual([0n, 1n, 1n]);
  });

  it('breaks an exact tie by beneficiary id ascending, deterministically', () => {
    const first = buildItemAwareAllocationLines({
      lines: [line(flatmateC, 1n, shared), line(flatmateA, 1n, shared)],
      itemBases: deriveItemRefundBases(
        [{ expenseItemId: shared, grossAmount: paise(2n) }],
        refunds([[shared, 1n]]),
      ),
      legacyReduction: paise(0n),
    });

    // `person_flatmate_a` sorts before `person_flatmate_c`, so the odd paisa is theirs —
    // whichever order the lines happen to arrive in.
    expect(first.find((entry) => entry.beneficiary.id === flatmateA)?.amount).toBe(1n);
    expect(first.find((entry) => entry.beneficiary.id === flatmateC)?.amount).toBe(0n);
  });

  it('is idempotent: rebuilding from its own output changes nothing', () => {
    const once = buildItemAwareAllocationLines({
      lines: sharedLines,
      itemBases: sharedItem(33_333n),
      legacyReduction: paise(0n),
    });
    const twice = buildItemAwareAllocationLines({
      lines: once,
      itemBases: sharedItem(33_333n),
      legacyReduction: paise(0n),
    });

    expect(amounts(twice)).toEqual(amounts(once));
    expect(sumPaise(amounts(once).map(paise))).toBe(66_667n);
  });

  it('reaches the same place whether two refunds are applied together or one at a time', () => {
    const together = buildItemAwareAllocationLines({
      lines: sharedLines,
      itemBases: sharedItem(20_000n),
      legacyReduction: paise(0n),
    });
    const stepOne = buildItemAwareAllocationLines({
      lines: sharedLines,
      itemBases: sharedItem(7_777n),
      legacyReduction: paise(0n),
    });
    const stepTwo = buildItemAwareAllocationLines({
      lines: stepOne,
      itemBases: sharedItem(20_000n),
      legacyReduction: paise(0n),
    });

    expect(amounts(stepTwo)).toEqual(amounts(together));
  });

  it('refuses a shared item whose approved shares are all zero', () => {
    expect(() =>
      buildItemAwareAllocationLines({
        lines: [line(dev, 0n, shared), line(flatmateA, 0n, shared)],
        itemBases: sharedItem(0n),
        legacyReduction: paise(0n),
      }),
    ).toThrow(/no approved proportion/);
  });

  it('still gives a sole owner their item’s full net cost even from a zeroed line', () => {
    const result = buildItemAwareAllocationLines({
      lines: [line(dev, 0n, mine), line(friendA, 0n, theirs)],
      itemBases: basket(refunds([[theirs, 15_000n]])),
      legacyReduction: paise(0n),
    });

    // One line for one item is not a division: ownership is unambiguous whatever the line
    // currently reads, so the exact net cost is copied onto it (ADR-0012).
    expect(amounts(result)).toEqual([60_000n, 25_000n]);
  });
});

describe('buildItemAwareAllocationLines — mixed legacy and item adjustments', () => {
  it('applies the unattributed reduction once, after the item stage', () => {
    const result = buildItemAwareAllocationLines({
      lines: basketLines,
      itemBases: basket(refunds([[theirs, 15_000n]])),
      legacyReduction: paise(8_500n),
    });

    // Item stage: ₹600 / ₹250 = ₹850. Legacy ₹85 proportionally: ₹60 / ₹25.
    expect(amounts(result)).toEqual([54_000n, 22_500n]);
    expect(sumPaise(amounts(result).map(paise))).toBe(76_500n);
  });

  it('never lets the item reduction be spread across unrelated items’ beneficiaries', () => {
    const result = buildItemAwareAllocationLines({
      lines: basketLines,
      itemBases: basket(refunds([[theirs, 15_000n]])),
      legacyReduction: paise(8_500n),
    });

    // The user's line moved only by their share of the *whole-expense* ₹85 refund — never by
    // a paisa of the ₹150 that came back for the friend's item.
    expect(60_000n - (result[0]?.amount ?? 0n)).toBe(6_000n);
  });

  it('honours an explicit non-proportional weight set for the legacy reduction alone', () => {
    const result = buildItemAwareAllocationLines({
      lines: basketLines,
      itemBases: basket(refunds([[theirs, 15_000n]])),
      legacyReduction: paise(8_500n),
      legacyWeights: [1n, 0n],
    });

    expect(amounts(result)).toEqual([51_500n, 25_000n]);
    expect(sumPaise(amounts(result).map(paise))).toBe(76_500n);
  });

  it('refuses weights when the whole reduction is item-attributed', () => {
    expect(() =>
      buildItemAwareAllocationLines({
        lines: basketLines,
        itemBases: basket(refunds([[theirs, 15_000n]])),
        legacyReduction: paise(0n),
        legacyWeights: [1n, 0n],
      }),
    ).toThrow(/item refund is distributed by its attribution/);
  });

  it('refuses a legacy reduction larger than the items have left', () => {
    expect(() =>
      buildItemAwareAllocationLines({
        lines: basketLines,
        itemBases: basket(refunds([[theirs, 40_000n]])),
        legacyReduction: paise(70_000n),
      }),
    ).toThrow(/negative net/);
  });
});

describe('buildItemAwareAllocationLines — ownership is never invented', () => {
  it('refuses an allocation whose lines name no item at all', () => {
    let raised: DomainError | undefined;
    try {
      buildItemAwareAllocationLines({
        lines: [line(dev, 60_000n, null), line(friendA, 40_000n, null)],
        itemBases: basket(refunds([[theirs, 15_000n]])),
        legacyReduction: paise(0n),
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('REFUND_ITEM_OWNERSHIP_REQUIRED');
    expect(raised?.message).toMatch(/approve an item mapping/);
  });

  it('refuses when only some lines carry an item link', () => {
    expect(() =>
      buildItemAwareAllocationLines({
        lines: [line(dev, 60_000n, mine), line(friendA, 40_000n, null)],
        itemBases: basket(),
        legacyReduction: paise(0n),
      }),
    ).toThrow(/name no ExpenseItem/);
  });

  it('refuses when a purchased item has no beneficiary line', () => {
    let raised: DomainError | undefined;
    try {
      buildItemAwareAllocationLines({
        lines: [line(dev, 60_000n, mine)],
        itemBases: basket(),
        legacyReduction: paise(0n),
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('REFUND_ITEM_OWNERSHIP_REQUIRED');
  });

  it('refuses a line pointing at an item that is not part of this expense', () => {
    let raised: DomainError | undefined;
    try {
      buildItemAwareAllocationLines({
        lines: [line(dev, 60_000n, mine), line(friendA, 40_000n, shared)],
        itemBases: basket(),
        legacyReduction: paise(0n),
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('UNKNOWN_REFERENCE');
  });

  it('refuses an allocation with no lines at all', () => {
    expect(() =>
      buildItemAwareAllocationLines({
        lines: [],
        itemBases: basket(),
        legacyReduction: paise(0n),
      }),
    ).toThrow(/at least one line/);
  });
});

describe('itemAwareAllocationTotal', () => {
  it('is the net item total less the unattributed reduction', () => {
    expect(itemAwareAllocationTotal(basket(refunds([[theirs, 15_000n]])), paise(8_500n))).toBe(
      76_500n,
    );
  });

  it('equals the expense net amount when the items account for the gross amount', () => {
    // ₹1,000 gross − ₹150 item refund − ₹85 whole-expense refund.
    expect(itemAwareAllocationTotal(basket(refunds([[theirs, 15_000n]])), paise(8_500n))).toBe(
      100_000n - 15_000n - 8_500n,
    );
  });
});

describe('validateItemNetLineSums — invariant #14 against net item costs', () => {
  it('accepts lines summing per item to that item’s net cost', () => {
    expect(() =>
      validateItemNetLineSums(
        [line(dev, 60_000n, mine), line(friendA, 25_000n, theirs)],
        basket(refunds([[theirs, 15_000n]])),
      ),
    ).not.toThrow();
  });

  it('rejects lines still summing to the item’s gross cost after a refund', () => {
    let raised: DomainError | undefined;
    try {
      validateItemNetLineSums(
        [line(dev, 60_000n, mine), line(friendA, 40_000n, theirs)],
        basket(refunds([[theirs, 15_000n]])),
      );
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('ALLOCATION_ITEM_SUM_MISMATCH');
    // The message has to name both figures: the gross cost is still true, it is simply no
    // longer what there is to allocate.
    expect(raised?.message).toMatch(/gross 40000 paise is unchanged/);
  });

  it('rejects a line referencing an item outside the expense', () => {
    expect(() => validateItemNetLineSums([line(dev, 60_000n, shared)], basket())).toThrow(
      /not part of this expense/,
    );
  });

  it('ignores lines with no item link, which belong to another method entirely', () => {
    expect(() => validateItemNetLineSums([line(dev, 1n, null)], basket())).not.toThrow();
  });
});
