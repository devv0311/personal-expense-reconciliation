import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  assertEvidenceImmutable,
  assertExpenseAmountImmutable,
  assertPaymentSourceImmutable,
} from './immutability.js';
import { paise } from './money.js';

describe('assertExpenseAmountImmutable — invariant #6, ADR-0008', () => {
  it.each(['proposed', 'classified', 'review_required'] as const)(
    'allows correcting the amount while still %s',
    (state) => {
      expect(() => assertExpenseAmountImmutable(state, paise(90000n), paise(85000n))).not.toThrow();
    },
  );

  it.each(['approved', 'allocated', 'ready_to_sync', 'synced', 'reconciled'] as const)(
    'refuses to change the amount once %s',
    (state) => {
      let raised: DomainError | undefined;
      try {
        assertExpenseAmountImmutable(state, paise(90000n), paise(85000n));
      } catch (error) {
        raised = error as DomainError;
      }

      expect(raised?.code).toBe('IMMUTABLE_FIELD');
    },
  );

  it('points the caller at ExpenseAdjustment as the correction path', () => {
    let raised: DomainError | undefined;
    try {
      assertExpenseAmountImmutable('approved', paise(90000n), paise(85000n));
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.message).toMatch(/ExpenseAdjustment/);
  });

  it('permits a no-op write of the identical amount', () => {
    expect(() =>
      assertExpenseAmountImmutable('approved', paise(90000n), paise(90000n)),
    ).not.toThrow();
  });

  it('refuses an increase just as firmly as a decrease', () => {
    // A post-approval price rise is new spend — a new Expense, never a mutated amount
    // and never a negative adjustment (invariants.md #12a).
    expect(() => assertExpenseAmountImmutable('approved', paise(90000n), paise(95000n))).toThrow(
      DomainError,
    );
  });
});

describe('assertPaymentSourceImmutable — invariant #4', () => {
  const imported = {
    amount: paise(124000n),
    occurredAt: new Date('2026-07-12T19:00:00Z'),
    rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    accountId: 'account_hdfc_savings',
  };

  it('allows a write that changes none of the source fields', () => {
    expect(() => assertPaymentSourceImmutable(imported, { ...imported })).not.toThrow();
  });

  it.each([
    ['amount', { amount: paise(124001n) }],
    ['occurredAt', { occurredAt: new Date('2026-07-12T19:00:01Z') }],
    ['rawDescription', { rawDescription: 'CORRECTED DESCRIPTION' }],
    ['accountId', { accountId: 'account_hdfc_upi' }],
  ])('refuses to overwrite %s', (field, change) => {
    let raised: DomainError | undefined;
    try {
      assertPaymentSourceImmutable(imported, { ...imported, ...change });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('IMMUTABLE_FIELD');
    expect(raised?.details).toMatchObject({ field });
  });

  it('explains that corrections happen elsewhere, not by editing the source', () => {
    let raised: DomainError | undefined;
    try {
      assertPaymentSourceImmutable(imported, { ...imported, amount: paise(1n) });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.message).toMatch(/ignored|Expense|Settlement/i);
  });
});

describe('assertEvidenceImmutable — invariant #4', () => {
  const captured = {
    storageRef: 'evidence/2026/07/receipt-001.jpg',
    rawText: 'SAMPLE RESTAURANT\nTOTAL 2840.00',
    capturedAt: new Date('2026-07-12T20:00:00Z'),
  };

  it('allows an unchanged write', () => {
    expect(() => assertEvidenceImmutable(captured, { ...captured })).not.toThrow();
  });

  it('refuses to overwrite the stored document reference', () => {
    expect(() =>
      assertEvidenceImmutable(captured, { ...captured, storageRef: 'evidence/other.jpg' }),
    ).toThrow(DomainError);
  });

  it('refuses to overwrite extracted raw text', () => {
    expect(() =>
      assertEvidenceImmutable(captured, { ...captured, rawText: 'corrected OCR' }),
    ).toThrow(/superseding|new Evidence/i);
  });
});
