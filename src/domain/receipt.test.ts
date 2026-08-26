import { describe, expect, it } from 'vitest';

import type { DomainError } from './errors.js';
import { paise } from './money.js';
import {
  assertReceiptDraftInformative,
  findCandidatePaymentMatches,
  isReceiptExtractableEvidenceType,
  lowerConfidence,
  receiptItemsSubtotal,
  receiptItemsSubtotalDiscrepancy,
  receiptPaymentDiscrepancy,
} from './receipt.js';

describe('isReceiptExtractableEvidenceType', () => {
  it.each(['receipt_image', 'email_receipt', 'screenshot'] as const)('accepts %s', (type) => {
    expect(isReceiptExtractableEvidenceType(type)).toBe(true);
  });

  it.each(['bank_line', 'upi_notification', 'manual_note'] as const)('refuses %s', (type) => {
    expect(isReceiptExtractableEvidenceType(type)).toBe(false);
  });
});

describe('lowerConfidence — the more cautious of two independent readings', () => {
  it.each([
    ['high', 'high', 'high'],
    ['high', 'medium', 'medium'],
    ['medium', 'low', 'low'],
    ['low', 'unknown', 'unknown'],
    ['unknown', 'high', 'unknown'],
  ] as const)('lowerConfidence(%s, %s) = %s', (a, b, expected) => {
    expect(lowerConfidence(a, b)).toBe(expected);
  });
});

describe('assertReceiptDraftInformative', () => {
  it('accepts a draft naming at least one figure', () => {
    expect(() =>
      assertReceiptDraftInformative({ subtotal: null, tax: null, total: paise(100n) }),
    ).not.toThrow();
  });

  it('refuses a draft naming nothing at all', () => {
    let raised: DomainError | undefined;
    try {
      assertReceiptDraftInformative({ subtotal: null, tax: null, total: null });
    } catch (error) {
      raised = error as DomainError;
    }
    expect(raised?.code).toBe('RECEIPT_DRAFT_INVALID');
  });
});

describe('receiptItemsSubtotal', () => {
  it('sums exactly, with no rounding involved', () => {
    const total = receiptItemsSubtotal([
      { lineTotal: paise(8_000n) },
      { lineTotal: paise(31_000n) },
      { lineTotal: paise(26_000n) },
    ]);
    expect(total).toBe(65_000n);
  });

  it('sums to zero across no items', () => {
    expect(receiptItemsSubtotal([])).toBe(0n);
  });
});

describe('receiptItemsSubtotalDiscrepancy — surfaced, never reconciled', () => {
  it('is null when there is no subtotal to compare against', () => {
    expect(receiptItemsSubtotalDiscrepancy(null, [{ lineTotal: paise(8_000n) }])).toBeNull();
  });

  it('is zero when the items agree with the stated subtotal exactly', () => {
    expect(receiptItemsSubtotalDiscrepancy(paise(8_000n), [{ lineTotal: paise(8_000n) }])).toBe(0n);
  });

  it('is positive when the items sum to more than the stated subtotal', () => {
    expect(receiptItemsSubtotalDiscrepancy(paise(8_000n), [{ lineTotal: paise(9_500n) }])).toBe(
      1_500n,
    );
  });

  it('is negative when the items sum to less than the stated subtotal', () => {
    expect(receiptItemsSubtotalDiscrepancy(paise(9_500n), [{ lineTotal: paise(8_000n) }])).toBe(
      -1_500n,
    );
  });
});

describe('receiptPaymentDiscrepancy — surfaced, never reconciled (scenario-analysis.md §20)', () => {
  it('is null with no linked payment', () => {
    expect(receiptPaymentDiscrepancy(paise(270_000n), null)).toBeNull();
  });

  it('is null with no extracted total', () => {
    expect(receiptPaymentDiscrepancy(null, paise(285_000n))).toBeNull();
  });

  it('is the tip a receipt did not show, per the fixture scenario', () => {
    // fixtures/receipt-amount-mismatch.json: receipt total 2700, payment 2850 (tip at the table).
    expect(receiptPaymentDiscrepancy(paise(270_000n), paise(285_000n))).toBe(-15_000n);
  });
});

describe('findCandidatePaymentMatches (ADR-0037)', () => {
  const capturedAt = new Date('2026-07-16T20:05:00Z');

  it('matches on exact amount within the default window', () => {
    const matches = findCandidatePaymentMatches({ total: paise(285_000n), capturedAt }, [
      { paymentId: 'p1', amount: paise(285_000n), occurredAt: new Date('2026-07-16T20:00:00Z') },
      { paymentId: 'p2', amount: paise(100_000n), occurredAt: new Date('2026-07-16T20:00:00Z') },
    ]);
    expect(matches.map((m) => m.paymentId)).toEqual(['p1']);
  });

  it('refuses a near-miss amount — exact match only', () => {
    const matches = findCandidatePaymentMatches({ total: paise(285_000n), capturedAt }, [
      { paymentId: 'p1', amount: paise(284_999n), occurredAt: capturedAt },
    ]);
    expect(matches).toHaveLength(0);
  });

  it('excludes a candidate outside the date window', () => {
    const matches = findCandidatePaymentMatches(
      { total: paise(285_000n), capturedAt },
      [
        {
          paymentId: 'p1',
          amount: paise(285_000n),
          occurredAt: new Date('2026-07-01T20:00:00Z'),
        },
      ],
      { windowDays: 3 },
    );
    expect(matches).toHaveLength(0);
  });

  it('returns nothing when the receipt has no extracted total', () => {
    const matches = findCandidatePaymentMatches({ total: null, capturedAt }, [
      { paymentId: 'p1', amount: paise(285_000n), occurredAt: capturedAt },
    ]);
    expect(matches).toHaveLength(0);
  });

  it('orders by closeness to the capture date, ties broken by id', () => {
    const matches = findCandidatePaymentMatches({ total: paise(285_000n), capturedAt }, [
      {
        paymentId: 'far',
        amount: paise(285_000n),
        occurredAt: new Date('2026-07-14T20:00:00Z'),
      },
      {
        paymentId: 'near',
        amount: paise(285_000n),
        occurredAt: new Date('2026-07-16T18:00:00Z'),
      },
    ]);
    expect(matches.map((m) => m.paymentId)).toEqual(['near', 'far']);
  });
});
