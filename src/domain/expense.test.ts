import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  netAmount,
  totalAdjusted,
  undistributedAmount,
  validateAdjustmentTotal,
} from './expense.js';
import { paise } from './money.js';

describe('netAmount — invariant #8, ADR-0008', () => {
  it('equals the gross amount when there are no adjustments', () => {
    expect(netAmount(paise(90000n), [])).toBe(90000n);
  });

  it('subtracts a partial refund (fixtures/refund-partial.json)', () => {
    expect(netAmount(paise(90000n), [paise(15000n)])).toBe(75000n);
  });

  it('reaches exactly zero on a full refund (fixtures/refund-full.json)', () => {
    expect(netAmount(paise(45000n), [paise(45000n)])).toBe(0n);
  });

  it('reaches zero on a full third-party reimbursement (scenario §31)', () => {
    expect(netAmount(paise(120000n), [paise(120000n)])).toBe(0n);
  });

  it('subtracts several adjustments against one expense', () => {
    expect(netAmount(paise(90000n), [paise(15000n), paise(20000n), paise(5000n)])).toBe(50000n);
  });

  it('never mutates the gross amount it was given', () => {
    const gross = paise(90000n);
    netAmount(gross, [paise(15000n)]);

    expect(gross).toBe(90000n);
  });

  it('refuses to return a negative net amount', () => {
    // Guarded by validateAdjustmentTotal at write time; this is the defence in depth.
    expect(() => netAmount(paise(45000n), [paise(50000n)])).toThrow(DomainError);
  });
});

describe('totalAdjusted', () => {
  it('sums the adjustments against one expense', () => {
    expect(totalAdjusted([paise(15000n), paise(5000n)])).toBe(20000n);
  });

  it('is zero for an expense with no adjustments', () => {
    expect(totalAdjusted([])).toBe(0n);
  });
});

describe('undistributedAmount — what a superseding allocation still has to absorb', () => {
  it('is zero when the current allocation already sums to the net amount', () => {
    expect(undistributedAmount(paise(75000n), paise(75000n))).toBe(0n);
  });

  it('is the gap when an adjustment has been recorded but not distributed', () => {
    // Lines still sum to ₹900; a ₹150 refund has dropped the net amount to ₹750.
    expect(undistributedAmount(paise(90000n), paise(75000n))).toBe(15000n);
  });

  it('accumulates two recorded-but-undistributed adjustments into one figure', () => {
    expect(undistributedAmount(paise(90000n), paise(30000n))).toBe(60000n);
  });

  it('equals the whole allocation on a full refund', () => {
    expect(undistributedAmount(paise(45000n), paise(0n))).toBe(45000n);
  });

  it('refuses a net amount above the current lines, which would mean money appeared', () => {
    expect(() => undistributedAmount(paise(75000n), paise(90000n))).toThrow(DomainError);
  });
});

describe('validateAdjustmentTotal — an expense cannot be refunded for more than it cost', () => {
  it('accepts adjustments summing to less than the gross amount', () => {
    expect(() => validateAdjustmentTotal(paise(90000n), [paise(15000n)])).not.toThrow();
  });

  it('accepts adjustments summing to exactly the gross amount', () => {
    expect(() => validateAdjustmentTotal(paise(45000n), [paise(45000n)])).not.toThrow();
  });

  it('rejects adjustments exceeding the gross amount', () => {
    let raised: DomainError | undefined;
    try {
      validateAdjustmentTotal(paise(45000n), [paise(45000n), paise(1n)]);
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('ADJUSTMENT_EXCEEDS_EXPENSE');
  });

  it('rejects a zero-amount adjustment, which records nothing', () => {
    expect(() => validateAdjustmentTotal(paise(90000n), [paise(0n)])).toThrow(DomainError);
  });

  it('rejects a negative adjustment — there is no signed ExpenseAdjustment (#12a)', () => {
    expect(() => validateAdjustmentTotal(paise(90000n), [paise(-15000n)])).toThrow(DomainError);
  });
});
