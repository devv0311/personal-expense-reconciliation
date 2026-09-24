import { describe, expect, it } from 'vitest';

import {
  PAYMENT_NATURES,
  natureCountsAsSpending,
  nonDebtRelationshipWords,
  paymentNature,
  shareObligationWords,
} from './connection.js';
import type { PaymentNatureInput } from './connection.js';

const BASE: PaymentNatureInput = {
  direction: 'debit',
  counterpartyType: 'unknown',
  cashFlowCategory: null,
  isDuplicateRepresentation: false,
  expenseLinkCount: 0,
  settlementCount: 0,
  adjustmentCount: 0,
};

describe('what one movement is, in plain words', () => {
  it('says nothing it has not been told', () => {
    expect(paymentNature(BASE)).toBe('not_yet_known');
  });

  it('never calls a transfer between your own accounts spending', () => {
    // A credit-card bill payment is the case that matters: it is a large debit to a merchant-
    // shaped narration, and counting it would double every card purchase it settles.
    expect(paymentNature({ ...BASE, counterpartyType: 'internal_account' })).toBe('transfer');
    expect(paymentNature({ ...BASE, cashFlowCategory: 'INTERNAL_TRANSFER' })).toBe('transfer');
    expect(natureCountsAsSpending('transfer')).toBe(false);
  });

  it('keeps an investment out of spending by its classification alone', () => {
    expect(paymentNature({ ...BASE, counterpartyType: 'investment_instrument' })).toBe(
      'investment',
    );
    expect(natureCountsAsSpending('investment')).toBe(false);
  });

  it('answers "a confirmed duplicate" before it answers anything else', () => {
    // The money was counted once already. Describing the copy as spending, or as a transfer,
    // would be describing a second movement that never happened (`invariants.md` #10).
    const duplicate = {
      ...BASE,
      isDuplicateRepresentation: true,
      counterpartyType: 'internal_account' as const,
      expenseLinkCount: 2,
    };
    expect(paymentNature(duplicate)).toBe('duplicate');
    expect(natureCountsAsSpending('duplicate')).toBe(false);
  });

  it('calls a movement that discharges a debt a settlement, not a purchase', () => {
    expect(paymentNature({ ...BASE, settlementCount: 1 })).toBe('settlement');
    expect(paymentNature({ ...BASE, cashFlowCategory: 'PEER_SETTLEMENT' })).toBe('settlement');
    expect(natureCountsAsSpending('settlement')).toBe(false);
  });

  it('calls money coming back against an expense a refund', () => {
    expect(paymentNature({ ...BASE, direction: 'credit', adjustmentCount: 1 })).toBe('refund');
    expect(paymentNature({ ...BASE, direction: 'credit', cashFlowCategory: 'REFUND' })).toBe(
      'refund',
    );
  });

  it('calls a movement that funds an expense spending', () => {
    expect(paymentNature({ ...BASE, expenseLinkCount: 1 })).toBe('spending');
    expect(natureCountsAsSpending('spending')).toBe(true);
  });

  it('leaves an unclassified credit unexplained rather than calling it income', () => {
    // `invariants.md` #11: unknown credits remain unexplained, never automatic income.
    expect(paymentNature({ ...BASE, direction: 'credit' })).toBe('not_yet_known');
    expect(
      paymentNature({ ...BASE, direction: 'credit', cashFlowCategory: 'EXTERNAL_INFLOW' }),
    ).toBe('money_in');
  });

  it('only ever returns one of the declared values', () => {
    const every = [
      paymentNature(BASE),
      paymentNature({ ...BASE, isDuplicateRepresentation: true }),
      paymentNature({ ...BASE, counterpartyType: 'internal_account' }),
      paymentNature({ ...BASE, counterpartyType: 'investment_instrument' }),
      paymentNature({ ...BASE, settlementCount: 1 }),
      paymentNature({ ...BASE, adjustmentCount: 1 }),
      paymentNature({ ...BASE, expenseLinkCount: 1 }),
      paymentNature({ ...BASE, direction: 'credit', cashFlowCategory: 'EXTERNAL_INFLOW' }),
    ];
    for (const nature of every) expect(PAYMENT_NATURES).toContain(nature);
    expect(new Set(every).size).toBe(8);
  });
});

describe('what a set of shares means for who owes whom', () => {
  it('names the payer as the creditor, whoever they are', () => {
    expect(
      shareObligationWords({
        relationshipType: 'shared',
        payerIsUser: false,
        payerName: 'Flatmate A',
      }),
    ).toBe('Everybody other than Flatmate A owes them their share.');
    expect(
      shareObligationWords({ relationshipType: 'shared', payerIsUser: true, payerName: 'Dev' }),
    ).toBe('Everybody other than you owes you their share.');
  });

  it('promises no debt for an expense that cannot create one', () => {
    for (const relationshipType of ['personal', 'gift']) {
      const words = shareObligationWords({ relationshipType, payerIsUser: true, payerName: 'Dev' });
      // Never the sentence that asserts a debt, in either direction.
      expect(words).not.toMatch(/owes (you|them) their share/);
      expect(words).toBe(nonDebtRelationshipWords(relationshipType));
    }
  });

  it('distinguishes a gift from something bought for one person', () => {
    expect(nonDebtRelationshipWords('gift')).toContain('a gift');
    expect(nonDebtRelationshipWords('personal')).toContain('bought for one person');
  });

  it('has nothing to say about a relationship that does create debts', () => {
    for (const relationshipType of ['shared', 'paid_on_behalf', 'household_shared_flat']) {
      expect(nonDebtRelationshipWords(relationshipType)).toBeNull();
    }
  });
});
