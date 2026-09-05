import { describe, expect, it } from 'vitest';

import {
  cashFlowCategoryAllowsDirection,
  categoryExplainsWholeMovement,
  validateCashFlowApproval,
  validateCashFlowDirection,
} from './cash-flow.js';
import type { CashFlowApprovalEvidence, CashFlowApprovalInput } from './cash-flow.js';
import {
  CASH_FLOW_CATEGORIES,
  CASH_FLOW_STATES,
  isCreditOnlyCashFlowCategory,
  requiredCounterpartyTypeForCashFlow,
} from './enums.js';
import type { CashFlowCategory, PaymentDirection } from './enums.js';
import { DomainError } from './errors.js';

/** No evidence at all — the starting point every approval test adds exactly what it needs to. */
function noEvidence(overrides: Partial<CashFlowApprovalEvidence> = {}): CashFlowApprovalEvidence {
  return {
    settlementCount: 0,
    expenseAdjustmentCount: 0,
    linkedEvidenceCount: 0,
    counterLegPaymentId: null,
    ownedAccount: true,
    ...overrides,
  };
}

function approval(overrides: Partial<CashFlowApprovalInput> = {}): CashFlowApprovalInput {
  return {
    direction: 'credit',
    counterpartyType: 'unknown',
    category: null,
    evidence: noEvidence(),
    ...overrides,
  };
}

function codeOf(body: () => void): string {
  try {
    body();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('Expected the call to throw a DomainError, but it returned.');
}

describe('the cash-flow enum matches ADR-0017 (cash balance) exactly', () => {
  it('has the four categories the ADR names, in its order', () => {
    expect([...CASH_FLOW_CATEGORIES]).toEqual([
      'PEER_SETTLEMENT',
      'REFUND',
      'INTERNAL_TRANSFER',
      'EXTERNAL_INFLOW',
    ]);
  });

  it('models the interpretation lifecycle as its own four states', () => {
    expect([...CASH_FLOW_STATES]).toEqual([
      'imported',
      'normalized',
      'cash_flow_classified',
      'approved',
    ]);
  });

  it('marks refunds and external inflows credit-only, and the other two either-way', () => {
    expect(isCreditOnlyCashFlowCategory('REFUND')).toBe(true);
    expect(isCreditOnlyCashFlowCategory('EXTERNAL_INFLOW')).toBe(true);
    expect(isCreditOnlyCashFlowCategory('PEER_SETTLEMENT')).toBe(false);
    expect(isCreditOnlyCashFlowCategory('INTERNAL_TRANSFER')).toBe(false);
  });

  it('names a required counterparty only where the role identifies one', () => {
    expect(requiredCounterpartyTypeForCashFlow('PEER_SETTLEMENT')).toBe('person');
    expect(requiredCounterpartyTypeForCashFlow('INTERNAL_TRANSFER')).toBe('internal_account');
    // A refund comes back from a merchant or a person; an external inflow's payer is routinely
    // an employer this ledger has no Person for, and inventing one is what ADR-0017 forbids.
    expect(requiredCounterpartyTypeForCashFlow('REFUND')).toBeNull();
    expect(requiredCounterpartyTypeForCashFlow('EXTERNAL_INFLOW')).toBeNull();
  });
});

describe('direction validation — 17.2, absolute at every stage', () => {
  const cases: Array<[CashFlowCategory, PaymentDirection, boolean]> = [
    ['PEER_SETTLEMENT', 'debit', true],
    ['PEER_SETTLEMENT', 'credit', true],
    ['INTERNAL_TRANSFER', 'debit', true],
    ['INTERNAL_TRANSFER', 'credit', true],
    ['REFUND', 'credit', true],
    ['REFUND', 'debit', false],
    ['EXTERNAL_INFLOW', 'credit', true],
    ['EXTERNAL_INFLOW', 'debit', false],
  ];

  for (const [category, direction, allowed] of cases) {
    it(`${allowed ? 'accepts' : 'rejects'} ${category} on a ${direction}`, () => {
      expect(cashFlowCategoryAllowsDirection(category, direction)).toBe(allowed);
      if (allowed) {
        expect(() => validateCashFlowDirection(category, direction)).not.toThrow();
      } else {
        expect(codeOf(() => validateCashFlowDirection(category, direction))).toBe(
          'CASH_FLOW_DIRECTION_INVALID',
        );
      }
    });
  }

  it('refuses a debit refund at approval too, not only at classification', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(
          approval({
            category: 'REFUND',
            direction: 'debit',
            evidence: noEvidence({ expenseAdjustmentCount: 1 }),
          }),
        ),
      ),
    ).toBe('CASH_FLOW_DIRECTION_INVALID');
  });
});

describe('approval with no category — 17.2', () => {
  it('approves an ordinary debit, which keeps its existing spend explanation', () => {
    expect(() =>
      validateCashFlowApproval(approval({ direction: 'debit', category: null })),
    ).not.toThrow();
  });

  it('refuses a credit, because an unclassified credit is unexplained, not income', () => {
    expect(
      codeOf(() => validateCashFlowApproval(approval({ direction: 'credit', category: null }))),
    ).toBe('CASH_FLOW_CATEGORY_REQUIRED');
  });
});

describe('PEER_SETTLEMENT approval — a person counterparty alone is insufficient', () => {
  it('refuses a person counterparty with no Settlement attribution', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(
          approval({ category: 'PEER_SETTLEMENT', counterpartyType: 'person' }),
        ),
      ),
    ).toBe('CASH_FLOW_EVIDENCE_INSUFFICIENT');
  });

  it('refuses a Settlement whose counterparty was never resolved to a person', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(
          approval({
            category: 'PEER_SETTLEMENT',
            counterpartyType: 'unknown',
            evidence: noEvidence({ settlementCount: 1 }),
          }),
        ),
      ),
    ).toBe('CASH_FLOW_EVIDENCE_INSUFFICIENT');
  });

  it('accepts a resolved person with real Settlement attribution, in either direction', () => {
    for (const direction of ['debit', 'credit'] as const) {
      expect(() =>
        validateCashFlowApproval(
          approval({
            direction,
            category: 'PEER_SETTLEMENT',
            counterpartyType: 'person',
            evidence: noEvidence({ settlementCount: 1 }),
          }),
        ),
      ).not.toThrow();
    }
  });
});

describe('REFUND approval — the adjustment it is a refund of', () => {
  it('refuses a credit no ExpenseAdjustment names', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(approval({ category: 'REFUND', counterpartyType: 'merchant' })),
      ),
    ).toBe('CASH_FLOW_EVIDENCE_INSUFFICIENT');
  });

  it('accepts a merchant refund backed by an adjustment', () => {
    expect(() =>
      validateCashFlowApproval(
        approval({
          category: 'REFUND',
          counterpartyType: 'merchant',
          evidence: noEvidence({ expenseAdjustmentCount: 1 }),
        }),
      ),
    ).not.toThrow();
  });

  it('accepts a third-party reimbursement from a person, since REFUND names no counterparty', () => {
    expect(() =>
      validateCashFlowApproval(
        approval({
          category: 'REFUND',
          counterpartyType: 'person',
          evidence: noEvidence({ expenseAdjustmentCount: 1 }),
        }),
      ),
    ).not.toThrow();
  });
});

describe('INTERNAL_TRANSFER approval — owned account and transfer evidence', () => {
  it('refuses a counterparty type that is not internal_account', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(
          approval({
            direction: 'debit',
            category: 'INTERNAL_TRANSFER',
            counterpartyType: 'merchant',
            evidence: noEvidence({ counterLegPaymentId: 'leg-2' }),
          }),
        ),
      ),
    ).toBe('CASH_FLOW_EVIDENCE_INSUFFICIENT');
  });

  it('refuses an account the user does not own', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(
          approval({
            direction: 'debit',
            category: 'INTERNAL_TRANSFER',
            counterpartyType: 'internal_account',
            evidence: noEvidence({ ownedAccount: false, counterLegPaymentId: 'leg-2' }),
          }),
        ),
      ),
    ).toBe('CASH_FLOW_EVIDENCE_INSUFFICIENT');
  });

  it('refuses a leg with neither a counter-leg nor attached evidence', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(
          approval({
            direction: 'debit',
            category: 'INTERNAL_TRANSFER',
            counterpartyType: 'internal_account',
          }),
        ),
      ),
    ).toBe('CASH_FLOW_EVIDENCE_INSUFFICIENT');
  });

  it('accepts a leg proved by its counter-leg', () => {
    expect(() =>
      validateCashFlowApproval(
        approval({
          direction: 'debit',
          category: 'INTERNAL_TRANSFER',
          counterpartyType: 'internal_account',
          evidence: noEvidence({ counterLegPaymentId: 'leg-2' }),
        }),
      ),
    ).not.toThrow();
  });

  it('accepts a cross-period leg proved by a document instead', () => {
    // 17.3 keeps a leg whose partner posts in another period visible as an unpaired transfer;
    // it does not make classifying that leg impossible.
    expect(() =>
      validateCashFlowApproval(
        approval({
          direction: 'credit',
          category: 'INTERNAL_TRANSFER',
          counterpartyType: 'internal_account',
          evidence: noEvidence({ linkedEvidenceCount: 1 }),
        }),
      ),
    ).not.toThrow();
  });
});

describe('EXTERNAL_INFLOW approval — never the automatic catch-all', () => {
  it('refuses a credit with no evidence of its own', () => {
    expect(codeOf(() => validateCashFlowApproval(approval({ category: 'EXTERNAL_INFLOW' })))).toBe(
      'CASH_FLOW_EVIDENCE_INSUFFICIENT',
    );
  });

  it('refuses a credit a Settlement already explains', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(
          approval({
            category: 'EXTERNAL_INFLOW',
            evidence: noEvidence({ linkedEvidenceCount: 1, settlementCount: 1 }),
          }),
        ),
      ),
    ).toBe('CASH_FLOW_EVIDENCE_INSUFFICIENT');
  });

  it('refuses a credit an ExpenseAdjustment already explains', () => {
    expect(
      codeOf(() =>
        validateCashFlowApproval(
          approval({
            category: 'EXTERNAL_INFLOW',
            evidence: noEvidence({ linkedEvidenceCount: 1, expenseAdjustmentCount: 1 }),
          }),
        ),
      ),
    ).toBe('CASH_FLOW_EVIDENCE_INSUFFICIENT');
  });

  it('accepts a salary credit with its own evidence and nothing else explaining it', () => {
    expect(() =>
      validateCashFlowApproval(
        approval({
          category: 'EXTERNAL_INFLOW',
          counterpartyType: 'unknown',
          evidence: noEvidence({ linkedEvidenceCount: 1 }),
        }),
      ),
    ).not.toThrow();
  });
});

describe('categoryExplainsWholeMovement — 17.1, each paise explained once', () => {
  it('explains an approved internal transfer and external inflow in full', () => {
    expect(categoryExplainsWholeMovement('INTERNAL_TRANSFER', 'approved')).toBe(true);
    expect(categoryExplainsWholeMovement('EXTERNAL_INFLOW', 'approved')).toBe(true);
  });

  it('leaves settlements and refunds to the records that reference them', () => {
    expect(categoryExplainsWholeMovement('PEER_SETTLEMENT', 'approved')).toBe(false);
    expect(categoryExplainsWholeMovement('REFUND', 'approved')).toBe(false);
  });

  it('explains nothing until the role is approved', () => {
    for (const state of ['imported', 'normalized', 'cash_flow_classified'] as const) {
      expect(categoryExplainsWholeMovement('EXTERNAL_INFLOW', state)).toBe(false);
      expect(categoryExplainsWholeMovement('INTERNAL_TRANSFER', state)).toBe(false);
    }
  });

  it('explains nothing when there is no category at all', () => {
    expect(categoryExplainsWholeMovement(null, 'approved')).toBe(false);
  });
});
