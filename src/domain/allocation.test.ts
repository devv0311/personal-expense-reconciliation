import { describe, expect, it } from 'vitest';

import {
  buildAllocationLines,
  validateAllocationLineAmounts,
  validateAllocationSum,
  validateItemBasedLineSums,
} from './allocation.js';
import type { DraftAllocationLine } from './allocation.js';
import { DomainError } from './errors.js';
import { asId } from './ids.js';
import type { BeneficiaryRef, GroupId, PersonId } from './ids.js';
import { paise, sumPaise } from './money.js';

const dev = asId<'person'>('person_dev');
const flatmateA = asId<'person'>('person_flatmate_a');
const flatmateC = asId<'person'>('person_flatmate_c');
const friendA = asId<'person'>('person_friend_a');
const friendB = asId<'person'>('person_friend_b');
const flat = asId<'group'>('group_flat');

function person(id: PersonId): BeneficiaryRef {
  return { type: 'person', id };
}
function group(id: GroupId): BeneficiaryRef {
  return { type: 'group', id };
}
function amountFor(lines: readonly DraftAllocationLine[], id: string): bigint | undefined {
  return lines.find((line) => line.beneficiary.id === id)?.amount;
}

describe('equal-method allocation', () => {
  it('splits a ₹2,400 dinner three ways exactly (scenario §2)', () => {
    const lines = buildAllocationLines({
      method: 'equal',
      total: paise(240000n),
      beneficiaries: [person(dev), person(friendA), person(friendB)],
    });

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.amount === 80000n)).toBe(true);
    expect(sumPaise(lines.map((line) => line.amount))).toBe(240000n);
  });

  it('returns lines in the order the beneficiaries were given', () => {
    const lines = buildAllocationLines({
      method: 'equal',
      total: paise(240000n),
      beneficiaries: [person(friendB), person(dev), person(friendA)],
    });

    expect(lines.map((line) => line.beneficiary.id)).toEqual([friendB, dev, friendA]);
  });

  it('produces a single 100%-to-payer line for a personal expense (scenario §35)', () => {
    const lines = buildAllocationLines({
      method: 'equal',
      total: paise(65000n),
      beneficiaries: [person(dev)],
    });

    expect(lines).toEqual([
      { beneficiary: person(dev), amount: 65000n, percentage: null, expenseItemId: null },
    ]);
  });

  it('uses the Largest Remainder Method when the split is not exact', () => {
    const lines = buildAllocationLines({
      method: 'equal',
      total: paise(100000n),
      beneficiaries: [person(flatmateC), person(dev), person(flatmateA)],
    });

    // person_dev sorts first of the three, so it absorbs the odd paisa.
    expect(amountFor(lines, dev)).toBe(33334n);
    expect(amountFor(lines, flatmateA)).toBe(33333n);
    expect(amountFor(lines, flatmateC)).toBe(33333n);
    expect(sumPaise(lines.map((line) => line.amount))).toBe(100000n);
  });

  it('carries no percentage and no item reference', () => {
    const [line] = buildAllocationLines({
      method: 'equal',
      total: paise(100n),
      beneficiaries: [person(dev)],
    });

    expect(line?.percentage).toBeNull();
    expect(line?.expenseItemId).toBeNull();
  });

  it('accepts a group beneficiary as a single line (scenario §5, §33)', () => {
    const lines = buildAllocationLines({
      method: 'equal',
      total: paise(210000n),
      beneficiaries: [group(flat)],
    });

    expect(lines).toEqual([
      { beneficiary: group(flat), amount: 210000n, percentage: null, expenseItemId: null },
    ]);
  });

  it('rejects an empty beneficiary set', () => {
    expect(() =>
      buildAllocationLines({ method: 'equal', total: paise(100n), beneficiaries: [] }),
    ).toThrow(DomainError);
  });

  it('rejects the same beneficiary appearing twice', () => {
    expect(() =>
      buildAllocationLines({
        method: 'equal',
        total: paise(100n),
        beneficiaries: [person(dev), person(dev)],
      }),
    ).toThrow(/duplicate/i);
  });

  it('allows a person and a group that happen to share an id string', () => {
    const sameText = 'shared_uuid';
    const lines = buildAllocationLines({
      method: 'equal',
      total: paise(100n),
      beneficiaries: [
        { type: 'person', id: asId<'person'>(sameText) },
        { type: 'group', id: asId<'group'>(sameText) },
      ],
    });

    expect(lines).toHaveLength(2);
  });
});

describe('exact-method allocation (scenario §3, §6)', () => {
  it('keeps the amounts the user stated', () => {
    const lines = buildAllocationLines({
      method: 'exact',
      total: paise(284000n),
      lines: [
        { beneficiary: person(dev), amount: paise(120000n) },
        { beneficiary: person(friendA), amount: paise(96000n) },
        { beneficiary: person(friendB), amount: paise(68000n) },
      ],
    });

    expect(lines.map((line) => line.amount)).toEqual([120000n, 96000n, 68000n]);
  });

  it('allocates 100% to the beneficiary on a paid-on-behalf expense (scenario §7)', () => {
    const lines = buildAllocationLines({
      method: 'exact',
      total: paise(150000n),
      lines: [{ beneficiary: person(friendA), amount: paise(150000n) }],
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.amount).toBe(150000n);
  });

  it('rejects amounts that do not sum to the total, rather than adjusting them', () => {
    expect(() =>
      buildAllocationLines({
        method: 'exact',
        total: paise(100000n),
        lines: [
          { beneficiary: person(dev), amount: paise(50000n) },
          { beneficiary: person(friendA), amount: paise(49999n) },
        ],
      }),
    ).toThrow(/sum/i);
  });

  it('rejects a negative line amount', () => {
    expect(() =>
      buildAllocationLines({
        method: 'exact',
        total: paise(100n),
        lines: [
          { beneficiary: person(dev), amount: paise(200n) },
          { beneficiary: person(friendA), amount: paise(-100n) },
        ],
      }),
    ).toThrow(/>= 0/);
  });

  it('accepts a zero-amount line, which is a valid shape', () => {
    const lines = buildAllocationLines({
      method: 'exact',
      total: paise(100n),
      lines: [
        { beneficiary: person(dev), amount: paise(100n) },
        { beneficiary: person(friendA), amount: paise(0n) },
      ],
    });

    expect(lines[1]?.amount).toBe(0n);
  });
});

describe('percentage-method allocation — matrix case 4', () => {
  it('resolves 33/33/34 of ₹1,000 to stored amounts summing to exactly ₹1,000', () => {
    const lines = buildAllocationLines({
      method: 'percentage',
      total: paise(100000n),
      lines: [
        { beneficiary: person(dev), percentage: '33' },
        { beneficiary: person(friendA), percentage: '33' },
        { beneficiary: person(friendB), percentage: '34' },
      ],
    });

    expect(lines.map((line) => line.amount)).toEqual([33000n, 33000n, 34000n]);
    expect(sumPaise(lines.map((line) => line.amount))).toBe(100000n);
  });

  it('keeps percentage as informational alongside the authoritative amount (#13)', () => {
    const lines = buildAllocationLines({
      method: 'percentage',
      total: paise(100000n),
      lines: [
        { beneficiary: person(dev), percentage: '33' },
        { beneficiary: person(friendA), percentage: '33' },
        { beneficiary: person(friendB), percentage: '34' },
      ],
    });

    expect(lines.map((line) => line.percentage)).toEqual(['33.00', '33.00', '34.00']);
  });

  it('supports two-decimal percentages and still sums exactly', () => {
    const lines = buildAllocationLines({
      method: 'percentage',
      total: paise(100000n),
      lines: [
        { beneficiary: person(dev), percentage: '33.33' },
        { beneficiary: person(friendA), percentage: '33.33' },
        { beneficiary: person(friendB), percentage: '33.34' },
      ],
    });

    expect(sumPaise(lines.map((line) => line.amount))).toBe(100000n);
    expect(lines.map((line) => line.amount)).toEqual([33330n, 33330n, 33340n]);
  });

  it('applies the Largest Remainder Method when percentages do not divide evenly', () => {
    // 1/3 each of a total that is not divisible by 3.
    const lines = buildAllocationLines({
      method: 'percentage',
      total: paise(100n),
      lines: [
        { beneficiary: person(flatmateC), percentage: '33.33' },
        { beneficiary: person(dev), percentage: '33.33' },
        { beneficiary: person(flatmateA), percentage: '33.34' },
      ],
    });

    expect(sumPaise(lines.map((line) => line.amount))).toBe(100n);
  });
});

describe('percentage-method allocation — matrix case 5: percentages must sum to 100', () => {
  it('rejects percentages summing to less than 100 before any split is attempted', () => {
    expect(() =>
      buildAllocationLines({
        method: 'percentage',
        total: paise(100000n),
        lines: [
          { beneficiary: person(dev), percentage: '33' },
          { beneficiary: person(friendA), percentage: '33' },
          { beneficiary: person(friendB), percentage: '33' },
        ],
      }),
    ).toThrow(DomainError);
  });

  it('rejects percentages summing to more than 100', () => {
    expect(() =>
      buildAllocationLines({
        method: 'percentage',
        total: paise(100000n),
        lines: [
          { beneficiary: person(dev), percentage: '60' },
          { beneficiary: person(friendA), percentage: '50' },
        ],
      }),
    ).toThrow(/100/);
  });

  it('names the offending total in the error, and does not silently normalise', () => {
    let raised: DomainError | undefined;
    try {
      buildAllocationLines({
        method: 'percentage',
        total: paise(100000n),
        lines: [{ beneficiary: person(dev), percentage: '99.99' }],
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('PERCENTAGES_DO_NOT_SUM');
  });

  it('rejects a negative percentage', () => {
    expect(() =>
      buildAllocationLines({
        method: 'percentage',
        total: paise(100000n),
        lines: [
          { beneficiary: person(dev), percentage: '110' },
          { beneficiary: person(friendA), percentage: '-10' },
        ],
      }),
    ).toThrow(DomainError);
  });

  it('rejects a percentage with more precision than the schema stores', () => {
    expect(() =>
      buildAllocationLines({
        method: 'percentage',
        total: paise(100000n),
        lines: [{ beneficiary: person(dev), percentage: '100.000' }],
      }),
    ).toThrow(DomainError);
  });
});

describe('item-based allocation — matrix case 6', () => {
  const milk = asId<'expense_item'>('item_milk');
  const chicken = asId<'expense_item'>('item_chicken');

  it('copies each line amount verbatim from its ExpenseItem', () => {
    const lines = buildAllocationLines({
      method: 'item_based',
      lines: [
        { beneficiary: group(flat), expenseItemId: milk },
        { beneficiary: person(dev), expenseItemId: chicken },
      ],
      items: [
        { id: milk, amount: paise(8000n) },
        { id: chicken, amount: paise(116000n) },
      ],
    });

    expect(lines.map((line) => line.amount)).toEqual([8000n, 116000n]);
    expect(lines.map((line) => line.expenseItemId)).toEqual([milk, chicken]);
  });

  it('lets several beneficiaries share one item when explicit amounts are given', () => {
    const lines = buildAllocationLines({
      method: 'item_based',
      lines: [
        { beneficiary: person(dev), expenseItemId: milk, amount: paise(5000n) },
        { beneficiary: person(flatmateA), expenseItemId: milk, amount: paise(3000n) },
      ],
      items: [{ id: milk, amount: paise(8000n) }],
    });

    expect(sumPaise(lines.map((line) => line.amount))).toBe(8000n);
  });

  it('rejects lines whose amounts do not sum to their item (invariant #14, per item)', () => {
    expect(() =>
      buildAllocationLines({
        method: 'item_based',
        lines: [
          { beneficiary: person(dev), expenseItemId: milk, amount: paise(5000n) },
          { beneficiary: person(flatmateA), expenseItemId: milk, amount: paise(1000n) },
        ],
        items: [{ id: milk, amount: paise(8000n) }],
      }),
    ).toThrow(DomainError);
  });

  it('rejects a line referencing an item that is not part of the expense', () => {
    expect(() =>
      buildAllocationLines({
        method: 'item_based',
        lines: [{ beneficiary: person(dev), expenseItemId: chicken }],
        items: [{ id: milk, amount: paise(8000n) }],
      }),
    ).toThrow(/unknown|not part/i);
  });

  it('rejects an expense item that no line references', () => {
    expect(() =>
      buildAllocationLines({
        method: 'item_based',
        lines: [{ beneficiary: person(dev), expenseItemId: milk }],
        items: [
          { id: milk, amount: paise(8000n) },
          { id: chicken, amount: paise(116000n) },
        ],
      }),
    ).toThrow(DomainError);
  });
});

describe('validateAllocationSum — invariant #11', () => {
  const lines: DraftAllocationLine[] = [
    { beneficiary: person(dev), amount: paise(25000n), percentage: null, expenseItemId: null },
    {
      beneficiary: person(flatmateA),
      amount: paise(25000n),
      percentage: null,
      expenseItemId: null,
    },
    {
      beneficiary: person(flatmateC),
      amount: paise(25000n),
      percentage: null,
      expenseItemId: null,
    },
  ];

  it('passes when the lines sum to the net amount', () => {
    expect(() => validateAllocationSum(lines, paise(75000n))).not.toThrow();
  });

  it('fails against the gross amount when an adjustment has reduced the net amount', () => {
    // ₹900 gross, ₹150 refunded, so the current allocation must sum to ₹750, not ₹900.
    expect(() => validateAllocationSum(lines, paise(90000n))).toThrow(DomainError);
  });

  it('reports both figures so the mismatch is diagnosable', () => {
    let raised: DomainError | undefined;
    try {
      validateAllocationSum(lines, paise(90000n));
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('ALLOCATION_SUM_MISMATCH');
    expect(raised?.details).toMatchObject({ lineSum: '75000', netAmount: '90000' });
  });

  it('rejects an allocation with no lines at all (ADR-0013)', () => {
    expect(() => validateAllocationSum([], paise(0n))).toThrow(/at least one line/i);
  });

  it('passes for a net-zero allocation that still names every beneficiary', () => {
    const zeroed = lines.map((line) => ({ ...line, amount: paise(0n) }));

    expect(() => validateAllocationSum(zeroed, paise(0n))).not.toThrow();
  });
});

describe('validateAllocationLineAmounts — invariant #12a', () => {
  it('accepts zero-amount lines', () => {
    expect(() =>
      validateAllocationLineAmounts([
        { beneficiary: person(dev), amount: paise(0n), percentage: null, expenseItemId: null },
      ]),
    ).not.toThrow();
  });

  it('rejects a negative line amount', () => {
    expect(() =>
      validateAllocationLineAmounts([
        { beneficiary: person(dev), amount: paise(-1n), percentage: null, expenseItemId: null },
      ]),
    ).toThrow(DomainError);
  });
});

describe('validateItemBasedLineSums — invariant #14, tightened to per-item', () => {
  const cheap = asId<'expense_item'>('item_cheap');
  const pricey = asId<'expense_item'>('item_pricey');
  const items = [
    { id: cheap, amount: paise(8000n) },
    { id: pricey, amount: paise(116000n) },
  ];

  it('catches lines attached to the wrong item even when the grand total matches', () => {
    // The aggregate-only version of this invariant would pass this: 124000 total either
    // way. Per-item, it is a misallocation — `pricey` is covered twice, `cheap` not at all.
    const lines: DraftAllocationLine[] = [
      { beneficiary: person(dev), amount: paise(8000n), percentage: null, expenseItemId: pricey },
      {
        beneficiary: person(flatmateA),
        amount: paise(116000n),
        percentage: null,
        expenseItemId: pricey,
      },
    ];

    expect(() => validateItemBasedLineSums(lines, items)).toThrow(DomainError);
  });

  it('passes when every item is exactly covered', () => {
    const lines: DraftAllocationLine[] = [
      { beneficiary: person(dev), amount: paise(8000n), percentage: null, expenseItemId: cheap },
      {
        beneficiary: person(flatmateA),
        amount: paise(116000n),
        percentage: null,
        expenseItemId: pricey,
      },
    ];

    expect(() => validateItemBasedLineSums(lines, items)).not.toThrow();
  });

  it('ignores lines with no item reference', () => {
    const lines: DraftAllocationLine[] = [
      { beneficiary: person(dev), amount: paise(500n), percentage: null, expenseItemId: null },
    ];

    expect(() => validateItemBasedLineSums(lines, [])).not.toThrow();
  });
});
