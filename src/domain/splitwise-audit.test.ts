/**
 * The Splitwise auditing engine's arithmetic and attribution rules (phase 19, ADR-0046).
 *
 * Everything here is a direct call on pure functions — the persistence, review and idempotency
 * half lives in `tests/integration/splitwise-audit.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  assessExternalListingCompleteness,
  auditSplitwisePair,
  auditUnobservablePairs,
  canonicalJson,
  findingComparisonSource,
  findingDependsOnExternalRead,
  findingFingerprint,
} from './splitwise-audit.js';
import type {
  ExternalEntryView,
  ExternalPairObservation,
  LocalSettlementView,
  LocalSyncedExpenseView,
  SplitwiseAuditFindingDraft,
  SplitwisePairAuditInput,
} from './splitwise-audit.js';
import { asId } from './ids.js';
import { paise } from './money.js';

const dev = asId<'person'>('person_dev');
const friendA = asId<'person'>('person_friend_a');
const flatmateA = asId<'person'>('person_flatmate_a');
const flatmateC = asId<'person'>('person_flatmate_c');

const JULY_10 = new Date('2026-07-10T19:20:00.000Z');

/* ------------------------------------------------------------------------- builders */

function complete(entries: readonly ExternalEntryView[] = []): ExternalPairObservation {
  return { status: 'complete', detail: null, entries };
}

type ExpenseOverrides = Omit<Partial<LocalSyncedExpenseView>, 'friendShareNow'> & {
  readonly friendShareNow: bigint;
};

function syncedExpense(overrides: ExpenseOverrides): LocalSyncedExpenseView {
  const share = paise(overrides.friendShareNow);
  return {
    splitwiseExpenseRowId: asId<'splitwise_expense'>('sw_row_1'),
    expenseId: asId<'expense'>('expense_1'),
    externalId: 'sw-expense-1',
    syncStatus: 'synced',
    description: 'Group dinner',
    friendShareAtSync: share,
    expenseGrossAmount: paise(90_000n),
    expenseNetAmount: paise(90_000n),
    refundBasis: 'none',
    refundedTotal: paise(0n),
    adjustmentIds: [],
    ...overrides,
    friendShareNow: share,
  };
}

type EntryOverrides = Omit<Partial<ExternalEntryView>, 'pairNetBalance'> & {
  readonly pairNetBalance: bigint;
};

function entry(overrides: EntryOverrides): ExternalEntryView {
  return {
    externalId: 'sw-expense-1',
    kind: 'expense',
    description: 'Group dinner',
    totalAmount: paise(90_000n),
    deleted: false,
    occurredAt: JULY_10,
    ...overrides,
    pairNetBalance: paise(overrides.pairNetBalance),
  };
}

type SettlementOverrides = Omit<Partial<LocalSettlementView>, 'amount'> & {
  readonly amount: bigint;
};

function settlement(overrides: SettlementOverrides): LocalSettlementView {
  return {
    settlementId: asId<'settlement'>('settlement_1'),
    direction: 'debit',
    occurredAt: JULY_10,
    splitwiseSettlementRowId: null,
    externalId: null,
    syncStatus: null,
    ...overrides,
    amount: paise(overrides.amount),
  };
}

function pairInput(overrides: Partial<SplitwisePairAuditInput> = {}): SplitwisePairAuditInput {
  return {
    userPersonId: dev,
    friendPersonId: friendA,
    friendSplitwiseUserId: 'sw-friend-a',
    ourNetBalance: paise(0n),
    theirNetBalance: paise(0n),
    expenses: [],
    settlements: [],
    crossPayerObligationTotal: paise(0n),
    crossPayerExpenseCount: 0,
    external: complete(),
    ...overrides,
  };
}

function kinds(findings: readonly SplitwiseAuditFindingDraft[]): string[] {
  return findings.map((finding) => finding.kind);
}

/** The gap attribution is supposed to explain, and what the findings actually claim. */
function attributed(findings: readonly SplitwiseAuditFindingDraft[]): bigint {
  return findings
    .filter((finding) => finding.findingClass === 'discrepancy')
    .reduce((total, finding) => total + finding.balanceImpact, 0n);
}

/* ============================================================================= tests */

describe('auditSplitwisePair — agreement', () => {
  it('reports nothing at all when both ledgers agree on the pair and on every entry', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-45_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([entry({ pairNetBalance: -45_000n })]),
      }),
    );

    expect(findings).toEqual([]);
  });

  it('agrees on a fully refunded expense whose zero-valued lines both sides reflect', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(0n),
        theirNetBalance: paise(0n),
        expenses: [
          syncedExpense({
            friendShareNow: 0n,
            friendShareAtSync: paise(0n),
            expenseNetAmount: paise(0n),
            refundedTotal: paise(90_000n),
          }),
        ],
        external: complete([entry({ pairNetBalance: 0n, totalAmount: paise(0n) })]),
      }),
    );

    expect(findings).toEqual([]);
  });
});

describe('auditSplitwisePair — attributable disagreements', () => {
  it('names a synced expense Splitwise no longer holds', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(0n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([]),
      }),
    );

    expect(kinds(findings)).toEqual(['missing_external_expense']);
    expect(findings[0]).toMatchObject({
      scope: 'expense',
      confidence: 'high',
      amount: 45_000n,
      balanceImpact: 45_000n,
      expenseId: 'expense_1',
      externalReference: 'sw-expense-1',
    });
    // Attribution accounts for the whole gap, so nothing is left unexplained.
    expect(attributed(findings)).toBe(0n - -45_000n);
  });

  it('treats an entry Splitwise holds as deleted the same as an absent one', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(0n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([entry({ pairNetBalance: -45_000n, deleted: true })]),
      }),
    );

    expect(kinds(findings)).toEqual(['missing_external_expense']);
    expect(findings[0]?.externalSnapshot).toMatchObject({ deleted: true });
  });

  it('names a duplicated external expense, at medium confidence because ids differ', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-90_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([
          entry({ pairNetBalance: -45_000n }),
          entry({ externalId: 'sw-expense-99', pairNetBalance: -45_000n }),
        ]),
      }),
    );

    expect(kinds(findings)).toEqual(['duplicate_external_expense']);
    expect(findings[0]).toMatchObject({
      confidence: 'medium',
      externalReference: 'sw-expense-99',
      balanceImpact: -45_000n,
    });
    expect(attributed(findings)).toBe(-90_000n - -45_000n);
  });

  it('reports an external expense the ledger has no record of as ghost debt', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(0n),
        theirNetBalance: paise(-30_000n),
        expenses: [],
        external: complete([
          entry({ externalId: 'sw-expense-ghost', pairNetBalance: -30_000n, description: 'Cab' }),
        ]),
      }),
    );

    expect(kinds(findings)).toEqual(['unsupported_ghost_debt']);
    expect(findings[0]).toMatchObject({ scope: 'external_entry', confidence: 'high' });
  });

  it('reports a genuine amount disagreement on a record both sides still hold', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-50_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([entry({ pairNetBalance: -50_000n })]),
      }),
    );

    expect(kinds(findings)).toEqual(['external_amount_disagreement']);
    expect(findings[0]).toMatchObject({
      confidence: 'high',
      amount: 5_000n,
      balanceImpact: -5_000n,
    });
    expect(attributed(findings)).toBe(-50_000n - -45_000n);
  });
});

describe('auditSplitwisePair — stale is our side, drifted is theirs', () => {
  it('names a stale partial whole-expense refund and the debt it no longer supports', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-40_000n),
        theirNetBalance: paise(-45_000n),
        expenses: [
          syncedExpense({
            friendShareNow: 40_000n,
            friendShareAtSync: paise(45_000n),
            syncStatus: 'stale',
            refundBasis: 'whole_expense',
            refundedTotal: paise(10_000n),
            expenseNetAmount: paise(80_000n),
            adjustmentIds: [asId<'expense_adjustment'>('adjustment_1')],
          }),
        ],
        external: complete([entry({ pairNetBalance: -45_000n })]),
      }),
    );

    expect(kinds(findings)).toEqual(['stale_refund_partial']);
    expect(findings[0]).toMatchObject({
      confidence: 'high',
      amount: 5_000n,
      balanceImpact: -5_000n,
      expenseId: 'expense_1',
    });
    expect(findings[0]?.localSnapshot).toMatchObject({ syncStatus: 'stale' });
    expect(findings[0]?.evidence).toContainEqual({
      type: 'expense_adjustment',
      id: 'adjustment_1',
    });
    expect(attributed(findings)).toBe(-45_000n - -40_000n);
  });

  it('distinguishes a full refund from a partial one', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(0n),
        theirNetBalance: paise(-45_000n),
        expenses: [
          syncedExpense({
            friendShareNow: 0n,
            friendShareAtSync: paise(45_000n),
            syncStatus: 'stale',
            refundBasis: 'whole_expense',
            refundedTotal: paise(90_000n),
            expenseNetAmount: paise(0n),
          }),
        ],
        external: complete([entry({ pairNetBalance: -45_000n })]),
      }),
    );

    expect(kinds(findings)).toEqual(['stale_refund_full']);
    expect(findings[0]?.amount).toBe(45_000n);
  });

  it('names an item-attributed refund as its own cause, not a generic stale refund', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-30_000n),
        theirNetBalance: paise(-45_000n),
        expenses: [
          syncedExpense({
            friendShareNow: 30_000n,
            friendShareAtSync: paise(45_000n),
            syncStatus: 'stale',
            refundBasis: 'item_attributed',
            refundedTotal: paise(15_000n),
            expenseNetAmount: paise(75_000n),
          }),
        ],
        external: complete([entry({ pairNetBalance: -45_000n })]),
      }),
    );

    expect(kinds(findings)).toEqual(['unreflected_item_refund']);
    expect(findings[0]?.localSnapshot).toMatchObject({ refundBasis: 'item_attributed' });
    expect(findings[0]?.summary).toContain('specific purchased items');
  });

  it('reports a stale row Splitwise no longer holds as missing, not as lingering debt', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-40_000n),
        theirNetBalance: paise(0n),
        expenses: [
          syncedExpense({
            friendShareNow: 40_000n,
            friendShareAtSync: paise(45_000n),
            syncStatus: 'stale',
            refundBasis: 'whole_expense',
          }),
        ],
        external: complete([]),
      }),
    );

    expect(kinds(findings)).toEqual(['missing_external_expense']);
    expect(findings[0]?.balanceImpact).toBe(40_000n);
    expect(attributed(findings)).toBe(0n - -40_000n);
  });

  it('still reports staleness with no external detail, at lower confidence', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-40_000n),
        theirNetBalance: paise(-45_000n),
        expenses: [
          syncedExpense({
            friendShareNow: 40_000n,
            friendShareAtSync: paise(45_000n),
            syncStatus: 'stale',
            refundBasis: 'whole_expense',
          }),
        ],
        external: { status: 'unsupported', detail: 'no per-entry read', entries: [] },
      }),
    );

    expect(kinds(findings)).toEqual(['external_read_unsupported', 'stale_refund_partial']);
    expect(findings[1]?.confidence).toBe('medium');
    // The presumed external value is the payload this ledger actually sent, and it accounts
    // for the whole gap — so nothing is reported as unattributed.
    expect(attributed(findings)).toBe(-45_000n - -40_000n);
  });

  it('reports drift on a `drifted` row through the record both sides hold, not as staleness', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-60_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n, syncStatus: 'drifted' })],
        external: complete([entry({ pairNetBalance: -60_000n })]),
      }),
    );

    expect(kinds(findings)).toEqual(['external_amount_disagreement']);
  });
});

describe('auditSplitwisePair — settlements', () => {
  it('names a recorded settlement Splitwise was never told about', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-95_000n),
        theirNetBalance: paise(-45_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        settlements: [settlement({ amount: 50_000n, direction: 'debit' })],
        external: complete([entry({ pairNetBalance: -45_000n })]),
      }),
    );

    expect(kinds(findings)).toEqual(['missing_external_settlement']);
    expect(findings[0]).toMatchObject({
      scope: 'settlement',
      amount: 50_000n,
      balanceImpact: 50_000n,
      settlementId: 'settlement_1',
    });
    expect(attributed(findings)).toBe(-45_000n - -95_000n);
  });

  it('says nothing when an unsynced settlement is matched by an external payment entry', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-95_000n),
        theirNetBalance: paise(-95_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        settlements: [settlement({ amount: 50_000n, direction: 'debit' })],
        external: complete([
          entry({ pairNetBalance: -45_000n }),
          entry({
            externalId: 'sw-payment-7',
            kind: 'payment',
            description: 'Repayment',
            totalAmount: paise(50_000n),
            pairNetBalance: -50_000n,
          }),
        ]),
      }),
    );

    expect(findings).toEqual([]);
  });

  it('names a duplicated external payment', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-50_000n),
        theirNetBalance: paise(-100_000n),
        settlements: [
          settlement({
            amount: 50_000n,
            direction: 'debit',
            splitwiseSettlementRowId: asId<'splitwise_settlement'>('sw_settle_row_1'),
            externalId: 'sw-payment-1',
            syncStatus: 'synced',
          }),
        ],
        external: complete([
          entry({
            externalId: 'sw-payment-1',
            kind: 'payment',
            description: 'Repayment',
            totalAmount: paise(50_000n),
            pairNetBalance: -50_000n,
          }),
          entry({
            externalId: 'sw-payment-2',
            kind: 'payment',
            description: 'Repayment',
            totalAmount: paise(50_000n),
            pairNetBalance: -50_000n,
          }),
        ]),
      }),
    );

    expect(kinds(findings)).toEqual(['duplicate_external_settlement']);
    expect(findings[0]).toMatchObject({ externalReference: 'sw-payment-2', confidence: 'medium' });
    expect(attributed(findings)).toBe(-100_000n - -50_000n);
  });

  it('names an external payment the ledger has no Settlement for, and fabricates none', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(0n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([
          entry({ pairNetBalance: -45_000n }),
          entry({
            externalId: 'sw-payment-9',
            kind: 'payment',
            description: 'Cash back',
            totalAmount: paise(45_000n),
            pairNetBalance: 45_000n,
          }),
        ]),
      }),
    );

    expect(kinds(findings)).toEqual(['unrecorded_external_settlement']);
    expect(findings[0]?.summary).toContain('no Settlement is fabricated');
    expect(findings[0]?.settlementId).toBeNull();
  });

  it('names a settlement whose synced entry has vanished from a complete read', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-50_000n),
        theirNetBalance: paise(0n),
        settlements: [
          settlement({
            amount: 50_000n,
            direction: 'debit',
            splitwiseSettlementRowId: asId<'splitwise_settlement'>('sw_settle_row_1'),
            externalId: 'sw-payment-1',
            syncStatus: 'synced',
          }),
        ],
        external: complete([]),
      }),
    );

    expect(kinds(findings)).toEqual(['missing_external_settlement']);
    expect(findings[0]?.confidence).toBe('high');
  });

  it('flips the sign for a settlement the friend paid the user', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(50_000n),
        theirNetBalance: paise(0n),
        settlements: [settlement({ amount: 50_000n, direction: 'credit' })],
        external: complete([]),
      }),
    );

    expect(kinds(findings)).toEqual(['missing_external_settlement']);
    expect(findings[0]?.balanceImpact).toBe(-50_000n);
    expect(attributed(findings)).toBe(0n - 50_000n);
  });
});

describe('auditSplitwisePair — uncertainty is never dressed up as attribution', () => {
  it('reports an unexplained gap as an aggregate mismatch at unknown confidence', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-45_123n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: { status: 'unsupported', detail: 'no per-entry read', entries: [] },
      }),
    );

    expect(kinds(findings)).toEqual(['external_read_unsupported', 'unattributed_balance_mismatch']);
    expect(findings[1]).toMatchObject({
      scope: 'pair',
      confidence: 'unknown',
      amount: 123n,
      balanceImpact: -123n,
      expenseId: null,
      externalReference: null,
    });
  });

  it('reports a wholly unsupported external balance as pair-scope ghost debt', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(0n),
        theirNetBalance: paise(-77_700n),
        external: { status: 'unsupported', detail: 'no per-entry read', entries: [] },
      }),
    );

    expect(kinds(findings)).toEqual(['external_read_unsupported', 'unsupported_ghost_debt']);
    expect(findings[1]).toMatchObject({ scope: 'pair', confidence: 'low', amount: 77_700n });
  });

  it('leaves the part attribution explained attributed, and only the remainder unexplained', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-1_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([]),
      }),
    );

    expect(kinds(findings)).toEqual(['missing_external_expense', 'unattributed_balance_mismatch']);
    expect(findings[0]?.balanceImpact).toBe(45_000n);
    expect(findings[1]?.balanceImpact).toBe(-1_000n);
    expect(attributed(findings)).toBe(-1_000n - -45_000n);
  });
});

describe('auditSplitwisePair — an incomplete read is never agreement', () => {
  it('records an unsupported per-entry read and names no external record', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-45_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: { status: 'unsupported', detail: 'no per-entry read', entries: [] },
      }),
    );

    expect(kinds(findings)).toEqual(['external_read_unsupported']);
    expect(findings[0]?.findingClass).toBe('incomplete');
    expect(findings[0]?.externalSnapshot).toMatchObject({ readStatus: 'unsupported' });
  });

  it('records a failed per-entry read without inventing a missing expense', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-45_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: { status: 'failed', detail: 'sandbox unreachable', entries: [] },
      }),
    );

    expect(kinds(findings)).toEqual(['external_read_failed']);
    expect(findings[0]?.summary).toContain('sandbox unreachable');
  });

  it('never reports anything missing from a partial listing', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-45_000n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        settlements: [
          settlement({
            amount: 50_000n,
            splitwiseSettlementRowId: asId<'splitwise_settlement'>('sw_settle_row_1'),
            externalId: 'sw-payment-1',
            syncStatus: 'synced',
          }),
        ],
        external: { status: 'partial', detail: 'page truncated', entries: [] },
      }),
    );

    expect(kinds(findings)).toEqual(['external_read_partial']);
  });

  it('records a friend Splitwise did not report at all as inaccessible, not settled', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: null,
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([entry({ pairNetBalance: -45_000n })]),
      }),
    );

    expect(kinds(findings)).toEqual(['external_record_inaccessible']);
    expect(findings[0]?.findingClass).toBe('incomplete');
  });

  it('will not call an entry missing when the friend’s own balance went unreported', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: null,
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([]),
      }),
    );

    // Half a read is not a read: the entry listing came back empty, but the friends list had
    // nothing to say about this pair at all, so nothing is declared missing.
    expect(kinds(findings)).toEqual(['external_record_inaccessible']);
  });

  it('still reports a disagreement it can actually see on an unreported pair', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: null,
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([entry({ pairNetBalance: -50_000n })]),
      }),
    );

    expect(kinds(findings)).toEqual([
      'external_record_inaccessible',
      'external_amount_disagreement',
    ]);
  });

  it('downgrades a "complete" listing that cannot account for the reported balance', () => {
    const observation = assessExternalListingCompleteness(
      complete([entry({ pairNetBalance: -45_000n })]),
      paise(-90_000n),
    );

    expect(observation.status).toBe('partial');
    expect(observation.detail).toContain('not everything it holds');
  });

  it('leaves a listing that does account for the reported balance alone', () => {
    const observation = assessExternalListingCompleteness(
      complete([entry({ pairNetBalance: -45_000n })]),
      paise(-45_000n),
    );

    expect(observation.status).toBe('complete');
  });
});

describe('auditSplitwisePair — permanent limitations stay visible', () => {
  it('names expenses somebody else fronted as unattributable rather than agreed', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(20_000n),
        theirNetBalance: paise(20_000n),
        crossPayerObligationTotal: paise(20_000n),
        crossPayerExpenseCount: 2,
      }),
    );

    expect(kinds(findings)).toEqual(['cross_payer_attribution_unavailable']);
    expect(findings[0]).toMatchObject({ findingClass: 'limitation', confidence: 'unknown' });
    // A limitation explains none of the gap, by construction.
    expect(attributed(findings)).toBe(0n);
  });

  it('records a non-user pair as uncheckable, with the balance it computed locally', () => {
    const findings = auditUnobservablePairs([
      {
        personAId: flatmateA,
        personBId: flatmateC,
        netBalance: paise(-120_000n),
        expenseCount: 3,
      },
    ]);

    expect(kinds(findings)).toEqual(['non_user_settlement_unobservable']);
    expect(findings[0]).toMatchObject({
      findingClass: 'limitation',
      scope: 'pair',
      amount: 120_000n,
      balanceImpact: 0n,
      personAId: flatmateA,
      personBId: flatmateC,
    });
    expect(findings[0]?.summary).toContain('Unchecked, not agreed');
  });

  it('orders unobservable pairs deterministically', () => {
    const findings = auditUnobservablePairs([
      { personAId: flatmateC, personBId: friendA, netBalance: paise(1n), expenseCount: 1 },
      { personAId: flatmateA, personBId: flatmateC, netBalance: paise(2n), expenseCount: 1 },
    ]);

    expect(findings.map((finding) => finding.personAId)).toEqual([flatmateA, flatmateC]);
  });
});

describe('finding identity and materiality', () => {
  const base = auditSplitwisePair(
    pairInput({
      ourNetBalance: paise(-45_000n),
      theirNetBalance: paise(0n),
      expenses: [syncedExpense({ friendShareNow: 45_000n })],
      external: complete([]),
    }),
  );

  it('is stable across identical runs', () => {
    const repeat = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(0n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([]),
      }),
    );

    expect(findingFingerprint(repeat[0]!)).toBe(findingFingerprint(base[0]!));
    expect(findingComparisonSource(repeat[0]!)).toBe(findingComparisonSource(base[0]!));
  });

  it('keeps the fingerprint but changes the digest when the amounts move', () => {
    const later = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-30_000n),
        theirNetBalance: paise(0n),
        expenses: [syncedExpense({ friendShareNow: 30_000n })],
        external: complete([]),
      }),
    );

    expect(findingFingerprint(later[0]!)).toBe(findingFingerprint(base[0]!));
    expect(findingComparisonSource(later[0]!)).not.toBe(findingComparisonSource(base[0]!));
  });

  it('separates two findings about different records', () => {
    const other = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(0n),
        expenses: [
          syncedExpense({
            friendShareNow: 45_000n,
            expenseId: asId<'expense'>('expense_2'),
            externalId: 'sw-expense-2',
          }),
        ],
        external: complete([]),
      }),
    );

    expect(findingFingerprint(other[0]!)).not.toBe(findingFingerprint(base[0]!));
  });

  it('renders JSON canonically, so key order cannot change a digest', () => {
    expect(canonicalJson({ b: 1, a: 2n })).toBe('{"a":"2","b":1}');
    expect(canonicalJson({ a: 2n, b: 1 })).toBe(canonicalJson({ b: 1, a: 2n }));
  });

  it('knows which findings a failed read may not retire', () => {
    expect(findingDependsOnExternalRead('stale_refund_partial')).toBe(false);
    expect(findingDependsOnExternalRead('unreflected_item_refund')).toBe(false);
    expect(findingDependsOnExternalRead('non_user_settlement_unobservable')).toBe(false);
    expect(findingDependsOnExternalRead('missing_external_expense')).toBe(true);
    expect(findingDependsOnExternalRead('unattributed_balance_mismatch')).toBe(true);
  });
});

describe('exact integer arithmetic', () => {
  it('compares single paise without tolerance', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(-45_001n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([entry({ pairNetBalance: -45_001n })]),
      }),
    );

    expect(kinds(findings)).toEqual(['external_amount_disagreement']);
    expect(findings[0]?.amount).toBe(1n);
  });

  it('carries every amount as a bigint, never a number', () => {
    const findings = auditSplitwisePair(
      pairInput({
        ourNetBalance: paise(-45_000n),
        theirNetBalance: paise(0n),
        expenses: [syncedExpense({ friendShareNow: 45_000n })],
        external: complete([]),
      }),
    );

    for (const finding of findings) {
      expect(typeof finding.balanceImpact).toBe('bigint');
      if (finding.amount !== null) expect(typeof finding.amount).toBe('bigint');
    }
  });
});
