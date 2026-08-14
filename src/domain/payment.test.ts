import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  assertPaymentCanFundExpense,
  isDeterministicDuplicate,
  isPossibleDuplicate,
  validatePaymentExplanationBudget,
} from './payment.js';
import type { DuplicateCandidate } from './payment.js';
import { paise } from './money.js';

describe('validatePaymentExplanationBudget — links and settlements share one budget', () => {
  it('accepts a payment fully explained by one expense link', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(124000n),
      linkAmounts: [paise(124000n)],
      settlementAmounts: [],
    });

    expect(result).toEqual({ explained: 124000n, unexplained: 0n });
  });

  it('accepts one payment split across two expenses (scenario §1)', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(124000n),
      linkAmounts: [paise(8000n), paise(116000n)],
      settlementAmounts: [],
    });

    expect(result.unexplained).toBe(0n);
  });

  it('surfaces a shortfall as unexplained rather than assuming rounding', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(124000n),
      linkAmounts: [paise(100000n)],
      settlementAmounts: [],
    });

    expect(result).toEqual({ explained: 100000n, unexplained: 24000n });
  });

  it('counts a settlement against the same budget as expense links (ADR-0007)', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(100000n),
      linkAmounts: [paise(40000n)],
      settlementAmounts: [paise(60000n)],
    });

    expect(result).toEqual({ explained: 100000n, unexplained: 0n });
  });

  it('rejects links plus settlements exceeding the payment', () => {
    let raised: DomainError | undefined;
    try {
      validatePaymentExplanationBudget({
        paymentAmount: paise(100000n),
        linkAmounts: [paise(60000n)],
        settlementAmounts: [paise(60000n)],
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('PAYMENT_BUDGET_EXCEEDED');
  });

  it('reports an unexplained payment with no links at all', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(500000n),
      linkAmounts: [],
      settlementAmounts: [],
    });

    expect(result.unexplained).toBe(500000n);
  });
});

describe('assertPaymentCanFundExpense — invariant #7', () => {
  it('rejects linking an internal transfer to an expense (scenario §14)', () => {
    let raised: DomainError | undefined;
    try {
      assertPaymentCanFundExpense('internal_account');
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('NON_SPEND_PAYMENT_LINKED');
  });

  it('rejects linking an investment purchase to an expense (scenario §32)', () => {
    expect(() => assertPaymentCanFundExpense('investment_instrument')).toThrow(DomainError);
  });

  it.each(['merchant', 'person', 'unknown'] as const)('allows a %s payment', (counterpartyType) => {
    expect(() => assertPaymentCanFundExpense(counterpartyType)).not.toThrow();
  });
});

describe('duplicate detection — invariant #10, ADR-0010', () => {
  const bankCapture: DuplicateCandidate = {
    amount: paise(124000n),
    occurredAt: new Date('2026-07-12T19:00:00Z'),
    externalReference: 'UPI/2607121234/BLINKIT',
    accountId: 'account_hdfc_savings',
  };
  const upiCapture: DuplicateCandidate = {
    amount: paise(124000n),
    occurredAt: new Date('2026-07-12T19:00:03Z'),
    externalReference: 'UPI/2607121234/BLINKIT',
    accountId: 'account_hdfc_upi',
  };

  it('matches the same charge captured by a bank CSV and a UPI export (§13)', () => {
    expect(isDeterministicDuplicate(bankCapture, upiCapture)).toBe(true);
  });

  it('does not require the two captures to share an account', () => {
    // This is the amendment that made the deterministic path reachable at all: a bank-CSV
    // capture and a UPI-export capture of one real transaction land on different Account
    // rows by construction (ADR-0010's amendment).
    expect(bankCapture.accountId).not.toBe(upiCapture.accountId);
    expect(isDeterministicDuplicate(bankCapture, upiCapture)).toBe(true);
  });

  it('is symmetric', () => {
    expect(isDeterministicDuplicate(upiCapture, bankCapture)).toBe(true);
  });

  it('does not match when the amounts differ', () => {
    expect(isDeterministicDuplicate(bankCapture, { ...upiCapture, amount: paise(124001n) })).toBe(
      false,
    );
  });

  it('does not match when the references differ', () => {
    expect(
      isDeterministicDuplicate(bankCapture, { ...upiCapture, externalReference: 'UPI/OTHER' }),
    ).toBe(false);
  });

  it('does not match when either reference is absent', () => {
    expect(isDeterministicDuplicate(bankCapture, { ...upiCapture, externalReference: null })).toBe(
      false,
    );
    expect(
      isDeterministicDuplicate(
        { ...bankCapture, externalReference: null },
        { ...upiCapture, externalReference: null },
      ),
    ).toBe(false);
  });

  it('does not match when the timestamps are outside the clock-skew window', () => {
    expect(
      isDeterministicDuplicate(bankCapture, {
        ...upiCapture,
        occurredAt: new Date('2026-07-13T19:00:00Z'),
      }),
    ).toBe(false);
  });

  it('matches within the window in either time order', () => {
    const earlier = { ...bankCapture, occurredAt: new Date('2026-07-12T18:59:30Z') };

    expect(isDeterministicDuplicate(earlier, upiCapture)).toBe(true);
  });

  it('flags a same-amount, same-time pair with no reference as a possible duplicate', () => {
    const a: DuplicateCandidate = { ...bankCapture, externalReference: null };
    const b: DuplicateCandidate = { ...upiCapture, externalReference: null };

    expect(isDeterministicDuplicate(a, b)).toBe(false);
    expect(isPossibleDuplicate(a, b)).toBe(true);
  });

  it('flags mismatched references at the same amount and time as only possible', () => {
    const other = { ...upiCapture, externalReference: 'UPI/DIFFERENT' };

    expect(isDeterministicDuplicate(bankCapture, other)).toBe(false);
    expect(isPossibleDuplicate(bankCapture, other)).toBe(true);
  });

  it('does not flag different amounts as a possible duplicate', () => {
    expect(isPossibleDuplicate(bankCapture, { ...upiCapture, amount: paise(50000n) })).toBe(false);
  });

  it('does not flag payments days apart as a possible duplicate', () => {
    expect(
      isPossibleDuplicate(bankCapture, {
        ...upiCapture,
        occurredAt: new Date('2026-07-20T19:00:00Z'),
      }),
    ).toBe(false);
  });

  it('lets the caller widen the matching window explicitly', () => {
    const nextDay = { ...upiCapture, occurredAt: new Date('2026-07-13T19:00:00Z') };

    expect(isDeterministicDuplicate(bankCapture, nextDay, { windowSeconds: 86_400 })).toBe(true);
  });
});
