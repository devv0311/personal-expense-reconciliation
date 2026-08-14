import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { computeUnexplained, validateReconciliationTotals } from './reconciliation.js';
import type { ReconciliationInput } from './reconciliation.js';
import { paise } from './money.js';

function ledger(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    payments: [],
    settlements: [],
    expenses: [],
    ...overrides,
  };
}

describe('computeUnexplained — invariant #20', () => {
  it('reports an empty period as all zeroes', () => {
    expect(computeUnexplained(ledger())).toEqual({
      ledgerTotalOutflow: 0n,
      ledgerTransfersTotal: 0n,
      ledgerInvestmentsTotal: 0n,
      ledgerSettlementsTotal: 0n,
      ledgerExplainedTotal: 0n,
      ledgerUnexplainedTotal: 0n,
    });
  });

  it('counts every debit payment towards outflow', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(124000n),
            counterpartyType: 'merchant',
            state: 'linked',
          },
          {
            direction: 'debit',
            amount: paise(65000n),
            counterpartyType: 'merchant',
            state: 'linked',
          },
        ],
      }),
    );

    expect(totals.ledgerTotalOutflow).toBe(189000n);
  });

  it('excludes credit payments from outflow', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'credit',
            amount: paise(45000n),
            counterpartyType: 'merchant',
            state: 'normalized',
          },
        ],
      }),
    );

    expect(totals.ledgerTotalOutflow).toBe(0n);
  });

  it('excludes a payment confirmed as a duplicate, so money is not counted twice (§13)', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(124000n),
            counterpartyType: 'merchant',
            state: 'linked',
          },
          {
            direction: 'debit',
            amount: paise(124000n),
            counterpartyType: 'merchant',
            state: 'ignored',
          },
        ],
      }),
    );

    expect(totals.ledgerTotalOutflow).toBe(124000n);
  });

  it('gives transfers their own bucket and nets them out (§14)', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(500000n),
            counterpartyType: 'internal_account',
            state: 'normalized',
          },
        ],
      }),
    );

    expect(totals.ledgerTransfersTotal).toBe(500000n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('gives investments their own bucket and nets them out (§32, ADR-0011)', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(500000n),
            counterpartyType: 'investment_instrument',
            state: 'normalized',
          },
        ],
      }),
    );

    expect(totals.ledgerInvestmentsTotal).toBe(500000n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('gives settlements their own bucket, never counting them as spend (§28, #9)', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(100000n),
            counterpartyType: 'person',
            state: 'linked',
          },
        ],
        settlements: [{ amount: paise(100000n), direction: 'debit' }],
      }),
    );

    expect(totals.ledgerSettlementsTotal).toBe(100000n);
    expect(totals.ledgerExplainedTotal).toBe(0n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('excludes a settlement received by the user, which was never outflow (§29)', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'credit',
            amount: paise(100000n),
            counterpartyType: 'person',
            state: 'linked',
          },
        ],
        settlements: [{ amount: paise(100000n), direction: 'credit' }],
      }),
    );

    expect(totals.ledgerSettlementsTotal).toBe(0n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('sums net amounts, not gross, for explained expenses (ADR-0008)', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(90000n),
            counterpartyType: 'merchant',
            state: 'linked',
          },
        ],
        expenses: [{ netAmount: paise(75000n), selfFunded: true }],
      }),
    );

    expect(totals.ledgerExplainedTotal).toBe(75000n);
    expect(totals.ledgerUnexplainedTotal).toBe(15000n);
  });

  it('contributes exactly zero for a fully refunded expense, not its gross amount', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(45000n),
            counterpartyType: 'merchant',
            state: 'linked',
          },
        ],
        expenses: [{ netAmount: paise(0n), selfFunded: true }],
      }),
    );

    expect(totals.ledgerExplainedTotal).toBe(0n);
    expect(totals.ledgerUnexplainedTotal).toBe(45000n);
  });

  it('excludes an externally-funded expense, which involved no outflow of the user’s (§26)', () => {
    // Flatmate A paid the electrician: a real, approved Expense with no PaymentExpenseLink
    // and no debit through any Account the user owns. Counting it as explained *outflow*
    // would drive ledger_unexplained_total negative.
    const totals = computeUnexplained(
      ledger({
        expenses: [{ netAmount: paise(300000n), selfFunded: false }],
      }),
    );

    expect(totals.ledgerExplainedTotal).toBe(0n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('surfaces unexplained money rather than hiding it', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(700000n),
            counterpartyType: 'unknown',
            state: 'normalized',
          },
        ],
      }),
    );

    expect(totals.ledgerUnexplainedTotal).toBe(700000n);
  });

  it('combines every bucket in one period', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(90000n),
            counterpartyType: 'merchant',
            state: 'linked',
          },
          {
            direction: 'debit',
            amount: paise(500000n),
            counterpartyType: 'internal_account',
            state: 'normalized',
          },
          {
            direction: 'debit',
            amount: paise(500000n),
            counterpartyType: 'investment_instrument',
            state: 'normalized',
          },
          {
            direction: 'debit',
            amount: paise(100000n),
            counterpartyType: 'person',
            state: 'linked',
          },
          {
            direction: 'debit',
            amount: paise(25000n),
            counterpartyType: 'unknown',
            state: 'normalized',
          },
        ],
        settlements: [{ amount: paise(100000n), direction: 'debit' }],
        expenses: [{ netAmount: paise(75000n), selfFunded: true }],
      }),
    );

    expect(totals).toEqual({
      ledgerTotalOutflow: 1215000n,
      ledgerTransfersTotal: 500000n,
      ledgerInvestmentsTotal: 500000n,
      ledgerSettlementsTotal: 100000n,
      ledgerExplainedTotal: 75000n,
      ledgerUnexplainedTotal: 40000n,
    });
  });

  it('can report a negative unexplained figure rather than clamping it to zero', () => {
    // Over-explained is a real signal (double-linked payments, a mis-scoped period) and
    // must be visible, not hidden behind a floor of zero.
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(10000n),
            counterpartyType: 'merchant',
            state: 'linked',
          },
        ],
        expenses: [{ netAmount: paise(90000n), selfFunded: true }],
      }),
    );

    expect(totals.ledgerUnexplainedTotal).toBe(-80000n);
  });
});

describe('validateReconciliationTotals — the identity always holds', () => {
  it('accepts totals computed by computeUnexplained', () => {
    const totals = computeUnexplained(
      ledger({
        payments: [
          {
            direction: 'debit',
            amount: paise(90000n),
            counterpartyType: 'merchant',
            state: 'linked',
          },
        ],
        expenses: [{ netAmount: paise(75000n), selfFunded: true }],
      }),
    );

    expect(() => validateReconciliationTotals(totals)).not.toThrow();
  });

  it('rejects hand-assembled totals that do not satisfy the identity', () => {
    expect(() =>
      validateReconciliationTotals({
        ledgerTotalOutflow: paise(90000n),
        ledgerTransfersTotal: paise(0n),
        ledgerInvestmentsTotal: paise(0n),
        ledgerSettlementsTotal: paise(0n),
        ledgerExplainedTotal: paise(75000n),
        ledgerUnexplainedTotal: paise(0n),
      }),
    ).toThrow(DomainError);
  });
});
