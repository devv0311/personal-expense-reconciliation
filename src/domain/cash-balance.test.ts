import { describe, expect, it } from 'vitest';

import {
  NO_BOUNDARY_BALANCES,
  computeAccountCashSnapshot,
  consolidatedInternalTransferNet,
  explainedAmount,
  isDuplicateRepresentation,
  isInternalTransferLeg,
  pairInternalTransfers,
  validateAccountCashSnapshot,
  validateInternalTransferNeutrality,
  verificationStatus,
} from './cash-balance.js';
import type {
  AccountBoundaryBalances,
  AccountCashSnapshotDraft,
  AccountCashSnapshotInput,
  CashMovement,
} from './cash-balance.js';
import { DomainError } from './errors.js';
import { asId } from './ids.js';
import type { AccountId, EvidenceId, PaymentId } from './ids.js';
import { paise } from './money.js';

const ACCOUNT_A = asId<'account'>('11111111-1111-4111-8111-111111111111') as AccountId;
const ACCOUNT_B = asId<'account'>('22222222-2222-4222-8222-222222222222') as AccountId;
const OPENING_EVIDENCE = asId<'evidence'>('aaaaaaaa-0000-4000-8000-000000000001') as EvidenceId;
const CLOSING_EVIDENCE = asId<'evidence'>('aaaaaaaa-0000-4000-8000-000000000002') as EvidenceId;

const PERIOD_START = new Date('2026-07-01T00:00:00Z');
const PERIOD_END = new Date('2026-08-01T00:00:00Z');

let paymentCounter = 0;
function nextPaymentId(): PaymentId {
  paymentCounter += 1;
  return asId<'payment'>(`33333333-0000-4000-8000-${paymentCounter.toString().padStart(12, '0')}`);
}

function movement(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    paymentId: nextPaymentId(),
    accountId: ACCOUNT_A,
    direction: 'debit',
    amount: paise(100_000n),
    currency: 'INR',
    counterpartyType: 'merchant',
    cashFlowCategory: null,
    cashFlowState: 'normalized',
    state: 'normalized',
    ignoredReason: null,
    externalReference: null,
    explanation: {
      expenseLinkTotal: paise(0n),
      settlementTotal: paise(0n),
      adjustmentTotal: paise(0n),
    },
    ...overrides,
  };
}

function boundaries(opening: bigint, closing: bigint): AccountBoundaryBalances {
  return {
    openingBalance: paise(opening),
    openingBalanceEvidenceId: OPENING_EVIDENCE,
    closingBalance: paise(closing),
    closingBalanceEvidenceId: CLOSING_EVIDENCE,
  };
}

function snapshotInput(
  overrides: Partial<AccountCashSnapshotInput> = {},
): AccountCashSnapshotInput {
  return {
    accountId: ACCOUNT_A,
    currency: 'INR',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    movements: [],
    boundaries: NO_BOUNDARY_BALANCES,
    ...overrides,
  };
}

function codeOf(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('Expected the call to throw a DomainError, but it returned.');
}

describe('the cash identity — ADR-0017 (cash balance), 17.4', () => {
  it('reports an empty period against evidenced boundaries that did not move', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({ boundaries: boundaries(500_000n, 500_000n) }),
    );

    expect(snapshot.totalDebits).toBe(0n);
    expect(snapshot.totalCredits).toBe(0n);
    expect(snapshot.expectedEndingBalance).toBe(500_000n);
    expect(snapshot.cashBalanceDelta).toBe(0n);
    expect(snapshot.verificationStatus).toBe('verified');
  });

  it('computes expected ending cash as opening + credits - debits', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(1_000_000n, 1_150_000n),
        movements: [
          movement({
            direction: 'credit',
            amount: paise(400_000n),
            counterpartyType: 'internal_account',
          }),
          movement({ direction: 'debit', amount: paise(250_000n) }),
        ],
      }),
    );

    expect(snapshot.totalCredits).toBe(400_000n);
    expect(snapshot.totalDebits).toBe(250_000n);
    expect(snapshot.expectedEndingBalance).toBe(1_150_000n);
    expect(snapshot.cashBalanceDelta).toBe(0n);
  });

  it('counts a purchase and its later refund once each, never netted (17.4)', () => {
    // ADR-0017's worked case: 1,000 out and 200 back is 1,000 of debit and 200 of credit,
    // whatever the expense's net amount became.
    const purchase = movement({
      direction: 'debit',
      amount: paise(100_000n),
      explanation: {
        expenseLinkTotal: paise(100_000n),
        settlementTotal: paise(0n),
        adjustmentTotal: paise(0n),
      },
    });
    const refund = movement({
      direction: 'credit',
      amount: paise(20_000n),
      cashFlowCategory: 'REFUND',
      cashFlowState: 'approved',
      explanation: {
        expenseLinkTotal: paise(0n),
        settlementTotal: paise(0n),
        adjustmentTotal: paise(20_000n),
      },
    });

    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 420_000n),
        movements: [purchase, refund],
      }),
    );

    expect(snapshot.totalDebits).toBe(100_000n);
    expect(snapshot.totalCredits).toBe(20_000n);
    expect(snapshot.explainedDebits).toBe(100_000n);
    expect(snapshot.explainedCredits).toBe(20_000n);
    expect(snapshot.cashBalanceDelta).toBe(0n);
    expect(snapshot.verificationStatus).toBe('verified');
  });

  it('stores a signed negative delta rather than clamping it', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 300_000n),
        movements: [movement({ direction: 'debit', amount: paise(100_000n) })],
      }),
    );

    expect(snapshot.expectedEndingBalance).toBe(400_000n);
    expect(snapshot.cashBalanceDelta).toBe(-100_000n);
    expect(snapshot.verificationStatus).toBe('unreconciled');
    expect(snapshot.discrepancies.map((entry) => entry.kind)).toContain(
      'cash_balance_delta_nonzero',
    );
  });

  it('handles an overdraft, where both balances are legitimately negative', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(-50_000n, -150_000n),
        movements: [movement({ direction: 'debit', amount: paise(100_000n) })],
      }),
    );

    expect(snapshot.expectedEndingBalance).toBe(-150_000n);
    expect(snapshot.cashBalanceDelta).toBe(0n);
  });

  it('stays exact above IEEE-754 integer precision', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(huge, huge + 1n),
        movements: [
          movement({
            direction: 'credit',
            amount: paise(1n),
            counterpartyType: 'internal_account',
          }),
        ],
      }),
    );

    expect(snapshot.expectedEndingBalance).toBe(huge + 1n);
    expect(snapshot.cashBalanceDelta).toBe(0n);
  });

  it('rejects an empty or inverted period', () => {
    expect(
      codeOf(() => computeAccountCashSnapshot(snapshotInput({ periodEnd: PERIOD_START }))),
    ).toBe('CASH_SNAPSHOT_SHAPE_INVALID');
  });

  it('rejects a movement belonging to another account — accounts verify independently', () => {
    expect(
      codeOf(() =>
        computeAccountCashSnapshot(
          snapshotInput({ movements: [movement({ accountId: ACCOUNT_B })] }),
        ),
      ),
    ).toBe('CASH_SNAPSHOT_SHAPE_INVALID');
  });
});

describe('missing statement evidence — 17.5, unknown is not zero', () => {
  it('leaves the derived values null and the snapshot incomplete with no boundaries', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({ movements: [movement({ direction: 'debit', amount: paise(100_000n) })] }),
    );

    expect(snapshot.openingBalance).toBeNull();
    expect(snapshot.closingBalance).toBeNull();
    expect(snapshot.expectedEndingBalance).toBeNull();
    expect(snapshot.cashBalanceDelta).toBeNull();
    expect(snapshot.verificationStatus).toBe('incomplete');
    expect(snapshot.discrepancies.map((entry) => entry.kind)).toEqual([
      'missing_opening_balance',
      'missing_closing_balance',
      'unexplained_debits',
    ]);
  });

  it('stays incomplete when only the closing balance is missing', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: {
          openingBalance: paise(500_000n),
          openingBalanceEvidenceId: OPENING_EVIDENCE,
          closingBalance: null,
          closingBalanceEvidenceId: null,
        },
      }),
    );

    // Deliberately not published: an expected balance with nothing to check it against reads
    // as the account's actual cash, which is exactly the claim 17.5 refuses to make.
    expect(snapshot.expectedEndingBalance).toBeNull();
    expect(snapshot.verificationStatus).toBe('incomplete');
  });

  it('refuses a balance that cites no evidence', () => {
    expect(
      codeOf(() =>
        computeAccountCashSnapshot(
          snapshotInput({
            boundaries: {
              openingBalance: paise(500_000n),
              openingBalanceEvidenceId: null,
              closingBalance: paise(500_000n),
              closingBalanceEvidenceId: CLOSING_EVIDENCE,
            },
          }),
        ),
      ),
    ).toBe('CASH_SNAPSHOT_SHAPE_INVALID');
  });

  it('refuses an evidence reference with no balance behind it', () => {
    expect(
      codeOf(() =>
        computeAccountCashSnapshot(
          snapshotInput({
            boundaries: {
              openingBalance: null,
              openingBalanceEvidenceId: OPENING_EVIDENCE,
              closingBalance: null,
              closingBalanceEvidenceId: null,
            },
          }),
        ),
      ),
    ).toBe('CASH_SNAPSHOT_SHAPE_INVALID');
  });
});

describe('explanation coverage — 17.1, 17.6', () => {
  it('explains a debit by its expense link', () => {
    expect(
      explainedAmount(
        movement({
          amount: paise(100_000n),
          explanation: {
            expenseLinkTotal: paise(100_000n),
            settlementTotal: paise(0n),
            adjustmentTotal: paise(0n),
          },
        }),
      ),
    ).toBe(100_000n);
  });

  it('leaves a partially attributed movement with a visible remainder', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 400_000n),
        movements: [
          movement({
            direction: 'debit',
            amount: paise(100_000n),
            explanation: {
              expenseLinkTotal: paise(60_000n),
              settlementTotal: paise(0n),
              adjustmentTotal: paise(0n),
            },
          }),
        ],
      }),
    );

    expect(snapshot.explainedDebits).toBe(60_000n);
    expect(snapshot.unexplainedDebits).toBe(40_000n);
    // The bank arithmetic still closes; the *explanation* does not. Two independent facts.
    expect(snapshot.cashBalanceDelta).toBe(0n);
    expect(snapshot.verificationStatus).toBe('unreconciled');
  });

  it('caps explanation at the movement, so no paise is explained twice', () => {
    expect(
      explainedAmount(
        movement({
          amount: paise(100_000n),
          explanation: {
            expenseLinkTotal: paise(80_000n),
            settlementTotal: paise(80_000n),
            adjustmentTotal: paise(0n),
          },
        }),
      ),
    ).toBe(100_000n);
  });

  it('leaves an unclassified credit entirely unexplained (17.2)', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 600_000n),
        movements: [movement({ direction: 'credit', amount: paise(100_000n) })],
      }),
    );

    expect(snapshot.explainedCredits).toBe(0n);
    expect(snapshot.unexplainedCredits).toBe(100_000n);
    expect(snapshot.cashBalanceDelta).toBe(0n);
    // The arithmetic closes and the credit is still a mystery — which is precisely why a zero
    // delta on its own is never a verified ₹0 Unaccounted Delta.
    expect(snapshot.verificationStatus).toBe('unreconciled');
  });

  it('does not let a merely proposed classification explain anything', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 600_000n),
        movements: [
          movement({
            direction: 'credit',
            amount: paise(100_000n),
            cashFlowCategory: 'EXTERNAL_INFLOW',
            cashFlowState: 'cash_flow_classified',
          }),
        ],
      }),
    );

    expect(snapshot.unexplainedCredits).toBe(100_000n);
  });

  it('explains an approved external inflow in full', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 600_000n),
        movements: [
          movement({
            direction: 'credit',
            amount: paise(100_000n),
            cashFlowCategory: 'EXTERNAL_INFLOW',
            cashFlowState: 'approved',
          }),
        ],
      }),
    );

    expect(snapshot.explainedCredits).toBe(100_000n);
    expect(snapshot.unexplainedCredits).toBe(0n);
    expect(snapshot.verificationStatus).toBe('verified');
  });

  it('explains an investment purchase by its counterparty resolution alone (ADR-0011)', () => {
    expect(
      explainedAmount(
        movement({ amount: paise(500_000n), counterpartyType: 'investment_instrument' }),
      ),
    ).toBe(500_000n);
  });

  it('leaves a refund credit unexplained beyond what its adjustments attribute (19.6)', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(0n, 100_000n),
        movements: [
          movement({
            direction: 'credit',
            amount: paise(100_000n),
            cashFlowCategory: 'REFUND',
            cashFlowState: 'approved',
            explanation: {
              expenseLinkTotal: paise(0n),
              settlementTotal: paise(0n),
              adjustmentTotal: paise(70_000n),
            },
          }),
        ],
      }),
    );

    expect(snapshot.explainedCredits).toBe(70_000n);
    expect(snapshot.unexplainedCredits).toBe(30_000n);
  });
});

describe('completeness — 17.6, every distinct movement participates', () => {
  it('drops a confirmed duplicate, which is the same money written down twice', () => {
    const canonical = movement({ direction: 'debit', amount: paise(100_000n) });
    const duplicate = movement({
      direction: 'debit',
      amount: paise(100_000n),
      state: 'ignored',
      ignoredReason: `duplicate_of:${canonical.paymentId}`,
    });

    const snapshot = computeAccountCashSnapshot(
      snapshotInput({ movements: [canonical, duplicate] }),
    );

    expect(snapshot.totalDebits).toBe(100_000n);
    expect(isDuplicateRepresentation(duplicate)).toBe(true);
    expect(isDuplicateRepresentation(canonical)).toBe(false);
  });

  it('keeps an out-of-scope movement, which is real bank activity', () => {
    // "Legacy ignored/out_of_scope does not justify dropping a real bank movement from cash
    // reconciliation" — the row is excluded from *spend*, not from the statement.
    const outOfScope = movement({
      direction: 'debit',
      amount: paise(70_000n),
      state: 'ignored',
      ignoredReason: 'out_of_scope',
    });

    const snapshot = computeAccountCashSnapshot(snapshotInput({ movements: [outOfScope] }));

    expect(snapshot.totalDebits).toBe(70_000n);
    expect(snapshot.unexplainedDebits).toBe(70_000n);
    expect(isDuplicateRepresentation(outOfScope)).toBe(false);
  });

  it('keeps both legs of a genuine transfer, which are not duplicates of each other', () => {
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 500_000n),
        movements: [
          movement({
            direction: 'debit',
            amount: paise(150_000n),
            counterpartyType: 'internal_account',
            externalReference: 'NEFT/N072026001',
          }),
          movement({
            direction: 'credit',
            amount: paise(150_000n),
            counterpartyType: 'internal_account',
            externalReference: 'NEFT/N072026001',
          }),
        ],
      }),
    );

    expect(snapshot.totalDebits).toBe(150_000n);
    expect(snapshot.totalCredits).toBe(150_000n);
    expect(snapshot.internalTransferDebits).toBe(150_000n);
    expect(snapshot.internalTransferCredits).toBe(150_000n);
  });
});

describe('verification status — 17.6', () => {
  const complete = {
    openingBalance: paise(0n),
    closingBalance: paise(0n),
    cashBalanceDelta: paise(0n),
    unexplainedDebits: paise(0n),
    unexplainedCredits: paise(0n),
    discrepancies: [],
  };

  it('verifies only when every condition holds at once', () => {
    expect(verificationStatus(complete)).toBe('verified');
  });

  it('refuses to verify a zero delta over unexplained debits', () => {
    expect(verificationStatus({ ...complete, unexplainedDebits: paise(1n) })).toBe('unreconciled');
  });

  it('refuses to verify a zero delta over unexplained credits', () => {
    expect(verificationStatus({ ...complete, unexplainedCredits: paise(1n) })).toBe('unreconciled');
  });

  it('refuses to verify while any discrepancy is unresolved', () => {
    expect(
      verificationStatus({
        ...complete,
        discrepancies: [{ kind: 'unpaired_internal_transfer', detail: 'leg missing' }],
      }),
    ).toBe('unreconciled');
  });

  it('reports incomplete rather than unreconciled when the inputs are missing', () => {
    expect(verificationStatus({ ...complete, openingBalance: null, cashBalanceDelta: null })).toBe(
      'incomplete',
    );
  });
});

describe('internal transfer pairing and neutrality — 17.3', () => {
  function transferLeg(overrides: Partial<CashMovement>): CashMovement {
    return movement({
      counterpartyType: 'internal_account',
      externalReference: 'NEFT/N072026001',
      amount: paise(150_000n),
      ...overrides,
    });
  }

  it('pairs a debit and a credit sharing a reference across two accounts', () => {
    const out = transferLeg({ direction: 'debit', accountId: ACCOUNT_A });
    const back = transferLeg({ direction: 'credit', accountId: ACCOUNT_B });

    const pairing = pairInternalTransfers([out, back]);

    expect(pairing.pairs).toEqual([
      {
        debitPaymentId: out.paymentId,
        creditPaymentId: back.paymentId,
        amount: 150_000n,
        externalReference: 'NEFT/N072026001',
      },
    ]);
    expect(pairing.unpaired).toEqual([]);
  });

  it('refuses to pair two legs on the same account', () => {
    const pairing = pairInternalTransfers([
      transferLeg({ direction: 'debit', accountId: ACCOUNT_A }),
      transferLeg({ direction: 'credit', accountId: ACCOUNT_A }),
    ]);

    expect(pairing.pairs).toEqual([]);
    expect(pairing.unpaired).toHaveLength(2);
  });

  it('leaves a leg with no reference unpaired rather than guessing by amount', () => {
    const pairing = pairInternalTransfers([
      transferLeg({ direction: 'debit', accountId: ACCOUNT_A, externalReference: null }),
      transferLeg({ direction: 'credit', accountId: ACCOUNT_B, externalReference: null }),
    ]);

    expect(pairing.pairs).toEqual([]);
    expect(pairing.unpaired).toHaveLength(2);
  });

  it('surfaces a cross-period leg as unpaired instead of inventing its partner', () => {
    const pairing = pairInternalTransfers([
      transferLeg({ direction: 'debit', accountId: ACCOUNT_A }),
    ]);

    expect(pairing.pairs).toEqual([]);
    expect(pairing.unpaired).toHaveLength(1);
  });

  it('reports the unpaired leg on its own account as a discrepancy', () => {
    const leg = transferLeg({ direction: 'debit', accountId: ACCOUNT_A });
    const snapshot = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 350_000n),
        movements: [leg],
        unpairedTransferPaymentIds: [leg.paymentId],
      }),
    );

    expect(snapshot.cashBalanceDelta).toBe(0n);
    expect(snapshot.verificationStatus).toBe('unreconciled');
    expect(snapshot.discrepancies).toContainEqual(
      expect.objectContaining({ kind: 'unpaired_internal_transfer', paymentId: leg.paymentId }),
    );
  });

  it('is cash-neutral across matched legs in a consolidated scope', () => {
    const out = transferLeg({ direction: 'debit', accountId: ACCOUNT_A });
    const back = transferLeg({ direction: 'credit', accountId: ACCOUNT_B });
    const pairing = pairInternalTransfers([out, back]);

    const snapshots = [
      computeAccountCashSnapshot(
        snapshotInput({
          accountId: ACCOUNT_A,
          movements: [out],
          boundaries: boundaries(500_000n, 350_000n),
        }),
      ),
      computeAccountCashSnapshot(
        snapshotInput({
          accountId: ACCOUNT_B,
          movements: [back],
          boundaries: boundaries(0n, 150_000n),
        }),
      ),
    ];

    expect(consolidatedInternalTransferNet(snapshots)).toBe(0n);
    expect(() => validateInternalTransferNeutrality(snapshots, pairing)).not.toThrow();
    // Neither account claims spend or income for it, and both close.
    expect(snapshots.every((snapshot) => snapshot.verificationStatus === 'verified')).toBe(true);
  });

  it('does not assert neutrality while a leg is unpaired — a non-zero net is then correct', () => {
    const out = transferLeg({ direction: 'debit', accountId: ACCOUNT_A });
    const pairing = pairInternalTransfers([out]);
    const snapshots = [
      computeAccountCashSnapshot(
        snapshotInput({ movements: [out], boundaries: boundaries(500_000n, 350_000n) }),
      ),
    ];

    expect(consolidatedInternalTransferNet(snapshots)).toBe(-150_000n);
    expect(() => validateInternalTransferNeutrality(snapshots, pairing)).not.toThrow();
  });

  it('rejects a fully paired scope whose transfer subtotals do not cancel', () => {
    const out = transferLeg({ direction: 'debit', accountId: ACCOUNT_A });
    const back = transferLeg({ direction: 'credit', accountId: ACCOUNT_B });
    const pairing = pairInternalTransfers([out, back]);
    const lopsided = [
      computeAccountCashSnapshot(
        snapshotInput({ movements: [out], boundaries: boundaries(500_000n, 350_000n) }),
      ),
    ];

    expect(codeOf(() => validateInternalTransferNeutrality(lopsided, pairing))).toBe(
      'INTERNAL_TRANSFER_NOT_NEUTRAL',
    );
  });

  it('treats an approved INTERNAL_TRANSFER category as a leg, as well as the counterparty type', () => {
    expect(
      isInternalTransferLeg({
        counterpartyType: 'unknown',
        cashFlowCategory: 'INTERNAL_TRANSFER',
        cashFlowState: 'approved',
      }),
    ).toBe(true);
    expect(
      isInternalTransferLeg({
        counterpartyType: 'unknown',
        cashFlowCategory: 'INTERNAL_TRANSFER',
        cashFlowState: 'cash_flow_classified',
      }),
    ).toBe(false);
  });
});

describe('validateAccountCashSnapshot — the persistence gate, 17.7', () => {
  function draft(overrides: Partial<AccountCashSnapshotDraft> = {}): AccountCashSnapshotDraft {
    return {
      ...computeAccountCashSnapshot(snapshotInput({ boundaries: boundaries(0n, 0n) })),
      ...overrides,
    };
  }

  it('accepts what computeAccountCashSnapshot produced', () => {
    expect(() => validateAccountCashSnapshot(draft())).not.toThrow();
  });

  it('rejects a coverage total that does not add up', () => {
    expect(
      codeOf(() =>
        validateAccountCashSnapshot(
          draft({
            totalDebits: paise(100n),
            explainedDebits: paise(0n),
            unexplainedDebits: paise(0n),
          }),
        ),
      ),
    ).toBe('CASH_BALANCE_IDENTITY_MISMATCH');
  });

  it('rejects an expected ending balance that contradicts the movements', () => {
    expect(
      codeOf(() => validateAccountCashSnapshot(draft({ expectedEndingBalance: paise(1n) }))),
    ).toBe('CASH_BALANCE_IDENTITY_MISMATCH');
  });

  it('rejects a derived balance published without both boundaries', () => {
    expect(
      codeOf(() =>
        validateAccountCashSnapshot(
          draft({
            openingBalance: null,
            openingBalanceEvidenceId: null,
            closingBalance: null,
            closingBalanceEvidenceId: null,
          }),
        ),
      ),
    ).toBe('CASH_BALANCE_IDENTITY_MISMATCH');
  });

  it('rejects a negative movement total', () => {
    expect(
      codeOf(() =>
        validateAccountCashSnapshot(
          draft({
            totalDebits: paise(-1n),
            explainedDebits: paise(0n),
            unexplainedDebits: paise(-1n),
          }),
        ),
      ),
    ).toBe('MONEY_NEGATIVE');
  });

  it('rejects an internal-transfer subtotal larger than the total it is a subset of', () => {
    expect(
      codeOf(() => validateAccountCashSnapshot(draft({ internalTransferDebits: paise(100n) }))),
    ).toBe('CASH_BALANCE_IDENTITY_MISMATCH');
  });

  it('rejects a verified status the figures do not support', () => {
    const withUnexplained = computeAccountCashSnapshot(
      snapshotInput({
        boundaries: boundaries(500_000n, 400_000n),
        movements: [movement({ direction: 'debit', amount: paise(100_000n) })],
      }),
    );

    expect(
      codeOf(() =>
        validateAccountCashSnapshot({ ...withUnexplained, verificationStatus: 'verified' }),
      ),
    ).toBe('CASH_BALANCE_IDENTITY_MISMATCH');
  });
});
