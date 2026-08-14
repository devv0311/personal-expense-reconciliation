import { describe, expect, it } from 'vitest';

import type { DraftAllocationLine } from './allocation.js';
import { distributeAdjustment, proportionalWeights } from './adjustment.js';
import { DomainError } from './errors.js';
import { asId } from './ids.js';
import type { BeneficiaryRef, PersonId } from './ids.js';
import { paise, sumPaise } from './money.js';

const dev = asId<'person'>('person_dev');
const flatmateA = asId<'person'>('person_flatmate_a');
const flatmateC = asId<'person'>('person_flatmate_c');
const friendA = asId<'person'>('person_friend_a');
const friendB = asId<'person'>('person_friend_b');

function person(id: PersonId): BeneficiaryRef {
  return { type: 'person', id };
}
function line(id: PersonId, amount: bigint): DraftAllocationLine {
  return { beneficiary: person(id), amount: paise(amount), percentage: null, expenseItemId: null };
}
function amounts(lines: readonly DraftAllocationLine[]): bigint[] {
  return lines.map((l) => l.amount);
}

describe('proportionalWeights — the documented default weight set', () => {
  it('weights each line by its own pre-adjustment amount', () => {
    expect(proportionalWeights([line(dev, 50000n), line(flatmateA, 30000n)])).toEqual([
      50000n,
      30000n,
    ]);
  });
});

describe('distributeAdjustment — matrix case 9: proportional default, exact division', () => {
  it('reduces three equal ₹300 lines by ₹50 each for a ₹150 refund', () => {
    // fixtures/refund-partial.json: ₹900 across three flatmates, ₹150 refunded.
    const result = distributeAdjustment({
      lines: [line(dev, 30000n), line(flatmateA, 30000n), line(flatmateC, 30000n)],
      adjustmentAmount: paise(15000n),
    });

    expect(amounts(result)).toEqual([25000n, 25000n, 25000n]);
    expect(sumPaise(amounts(result).map(paise))).toBe(75000n);
  });

  it('preserves every beneficiary and every non-amount field', () => {
    const result = distributeAdjustment({
      lines: [line(dev, 30000n), line(flatmateA, 30000n), line(flatmateC, 30000n)],
      adjustmentAmount: paise(15000n),
    });

    expect(result.map((l) => l.beneficiary.id)).toEqual([dev, flatmateA, flatmateC]);
    expect(result.every((l) => l.percentage === null && l.expenseItemId === null)).toBe(true);
  });
});

describe('distributeAdjustment — matrix case 10: proportional default, with remainder', () => {
  it('divides a ₹333 refund across ₹500/₹300/₹200 lines exactly', () => {
    const result = distributeAdjustment({
      lines: [line(dev, 50000n), line(flatmateA, 30000n), line(flatmateC, 20000n)],
      adjustmentAmount: paise(33300n),
    });

    expect(amounts(result)).toEqual([33350n, 20010n, 13340n]);
    expect(sumPaise(amounts(result).map(paise))).toBe(66700n);
  });

  it('ranks the reduction by fractional remainder, not by line size', () => {
    // A ₹10 refund against ₹300/₹300/₹100 lines. Floor reductions are 428/428/142
    // (sum 998, remainder 2) and the fractional remainders are 40000/40000/60000 — so the
    // *smallest* line has the largest fraction and takes one of the two spare paise, while
    // one of the two three-times-larger lines takes none.
    const result = distributeAdjustment({
      lines: [line(dev, 30000n), line(flatmateA, 30000n), line(flatmateC, 10000n)],
      adjustmentAmount: paise(1000n),
    });

    expect(amounts(result)).toEqual([29571n, 29572n, 9857n]);
    expect(sumPaise(amounts(result).map(paise))).toBe(69000n);
  });

  it('always leaves the new lines summing to the new net amount', () => {
    for (let adjustment = 0n; adjustment <= 90000n; adjustment += 137n) {
      const result = distributeAdjustment({
        lines: [line(dev, 50000n), line(flatmateA, 30000n), line(flatmateC, 10000n)],
        adjustmentAmount: paise(adjustment),
      });

      expect(sumPaise(amounts(result).map(paise))).toBe(90000n - adjustment);
    }
  });
});

describe('distributeAdjustment — matrix case 11: full refund, single beneficiary', () => {
  it('leaves exactly one line at zero, never an empty array (ADR-0013)', () => {
    // fixtures/refund-full.json: ₹450 USB cable, fully refunded.
    const result = distributeAdjustment({
      lines: [line(dev, 45000n)],
      adjustmentAmount: paise(45000n),
    });

    expect(result).toHaveLength(1);
    expect(result).not.toEqual([]);
    expect(result[0]?.amount).toBe(0n);
    expect(result[0]?.beneficiary.id).toBe(dev);
  });
});

describe('distributeAdjustment — matrix case 12: full refund, several beneficiaries', () => {
  it('leaves three zero-amount lines naming the same three beneficiaries', () => {
    const result = distributeAdjustment({
      lines: [line(dev, 80000n), line(friendA, 80000n), line(friendB, 80000n)],
      adjustmentAmount: paise(240000n),
    });

    expect(result).toHaveLength(3);
    expect(amounts(result)).toEqual([0n, 0n, 0n]);
    expect(result.map((l) => l.beneficiary.id)).toEqual([dev, friendA, friendB]);
  });

  it('agrees with ADR-0013’s "split a total of zero" description of the same outcome', () => {
    // ADR-0013 describes the net-zero result as the Largest Remainder Method applied with
    // a total of 0; invariants.md #12 specifies the input as the adjustment amount. The two
    // descriptions coincide exactly at the full-refund boundary, which is what this asserts.
    const viaAdjustment = distributeAdjustment({
      lines: [line(dev, 80000n), line(friendA, 80000n), line(friendB, 80000n)],
      adjustmentAmount: paise(240000n),
    });

    expect(amounts(viaAdjustment)).toEqual([0n, 0n, 0n]);
  });
});

describe('distributeAdjustment — a custom, non-proportional distribution', () => {
  it('lets a refund benefit only one beneficiary (scenario §12)', () => {
    const result = distributeAdjustment({
      lines: [line(dev, 30000n), line(flatmateA, 30000n), line(flatmateC, 30000n)],
      adjustmentAmount: paise(15000n),
      customWeights: [1n, 0n, 0n],
    });

    expect(amounts(result)).toEqual([15000n, 30000n, 30000n]);
    expect(sumPaise(amounts(result).map(paise))).toBe(75000n);
  });

  it('requires one weight per line', () => {
    expect(() =>
      distributeAdjustment({
        lines: [line(dev, 30000n), line(flatmateA, 30000n)],
        adjustmentAmount: paise(15000n),
        customWeights: [1n],
      }),
    ).toThrow(DomainError);
  });
});

describe('distributeAdjustment — matrix case 13: a line driven below zero is rejected', () => {
  it('rejects a ₹150 refund loaded entirely onto a beneficiary whose share was ₹100', () => {
    let raised: DomainError | undefined;
    try {
      distributeAdjustment({
        lines: [line(dev, 10000n), line(flatmateA, 80000n)],
        adjustmentAmount: paise(15000n),
        customWeights: [1n, 0n],
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('ADJUSTMENT_DISTRIBUTION_NEGATIVE');
  });

  it('names the offending line and both figures', () => {
    let raised: DomainError | undefined;
    try {
      distributeAdjustment({
        lines: [line(dev, 10000n), line(flatmateA, 80000n)],
        adjustmentAmount: paise(15000n),
        customWeights: [1n, 0n],
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.details).toMatchObject({
      beneficiaryId: dev,
      lineAmount: '10000',
      reduction: '15000',
    });
  });

  it('never clamps to zero — clamping would stop the parts summing to the whole', () => {
    expect(() =>
      distributeAdjustment({
        lines: [line(dev, 10000n), line(flatmateA, 80000n)],
        adjustmentAmount: paise(15000n),
        customWeights: [1n, 0n],
      }),
    ).toThrow();
  });

  it('cannot be driven negative by the proportional default, by construction', () => {
    // The default weights are the lines' own amounts, and the adjustment total is capped
    // at the expense's gross amount, so base_i <= line_i always holds (#12a).
    for (let adjustment = 0n; adjustment <= 90000n; adjustment += 13n) {
      const result = distributeAdjustment({
        lines: [line(dev, 50000n), line(flatmateA, 30000n), line(flatmateC, 10000n)],
        adjustmentAmount: paise(adjustment),
      });

      expect(result.every((l) => l.amount >= 0n)).toBe(true);
    }
  });
});

describe('distributeAdjustment — invalid input', () => {
  it('rejects an adjustment larger than the lines it is distributed across', () => {
    expect(() =>
      distributeAdjustment({
        lines: [line(dev, 10000n)],
        adjustmentAmount: paise(10001n),
      }),
    ).toThrow(DomainError);
  });

  it('rejects an empty line set', () => {
    expect(() => distributeAdjustment({ lines: [], adjustmentAmount: paise(1n) })).toThrow(
      DomainError,
    );
  });

  it('rejects a negative adjustment amount', () => {
    expect(() =>
      distributeAdjustment({ lines: [line(dev, 10000n)], adjustmentAmount: paise(-1n) }),
    ).toThrow(DomainError);
  });

  it('handles a zero adjustment as a no-op that still returns every line', () => {
    const result = distributeAdjustment({
      lines: [line(dev, 30000n), line(flatmateA, 30000n)],
      adjustmentAmount: paise(0n),
    });

    expect(amounts(result)).toEqual([30000n, 30000n]);
  });

  it('distributes across an already fully-refunded allocation without dividing by zero', () => {
    const result = distributeAdjustment({
      lines: [line(dev, 0n), line(flatmateA, 0n)],
      adjustmentAmount: paise(0n),
    });

    expect(amounts(result)).toEqual([0n, 0n]);
  });
});
