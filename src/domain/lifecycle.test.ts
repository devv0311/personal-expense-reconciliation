import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  assertExpenseTransition,
  assertPaymentTransition,
  canEnterReadyToSync,
  canTransitionAdjustment,
  canTransitionAiInference,
  canTransitionExpense,
  isExpenseAmountFrozen,
  canTransitionPayment,
  canTransitionSplitwiseExpenseSync,
  hasObligationCreatingLine,
  isPaymentTerminalWithoutLinking,
} from './lifecycle.js';
import { asId } from './ids.js';
import { paise } from './money.js';

const dev = asId<'person'>('person_dev');
const friendA = asId<'person'>('person_friend_a');

describe('payment lifecycle (lifecycle.md, Payment)', () => {
  it('moves imported → normalized', () => {
    expect(canTransitionPayment('imported', 'normalized')).toBe(true);
  });

  it('moves normalized → linked once an expense link or settlement exists', () => {
    expect(canTransitionPayment('normalized', 'linked')).toBe(true);
  });

  it('moves normalized → ignored for a confirmed duplicate', () => {
    expect(canTransitionPayment('normalized', 'ignored')).toBe(true);
  });

  it('moves imported → ignored for a duplicate confirmed at import time (ADR-0019)', () => {
    expect(canTransitionPayment('imported', 'ignored')).toBe(true);
  });

  it('still refuses to skip normalization on the way to linked', () => {
    // Being *explained* requires knowing what the payment is; being *discarded* does not.
    expect(canTransitionPayment('imported', 'linked')).toBe(false);
  });

  it('refuses to regress a linked payment', () => {
    expect(canTransitionPayment('linked', 'normalized')).toBe(false);
    expect(canTransitionPayment('linked', 'ignored')).toBe(false);
  });

  it('refuses to revive an ignored payment', () => {
    expect(canTransitionPayment('ignored', 'normalized')).toBe(false);
    expect(canTransitionPayment('ignored', 'linked')).toBe(false);
  });

  it('refuses a no-op transition, which would write a meaningless audit event', () => {
    expect(canTransitionPayment('normalized', 'normalized')).toBe(false);
  });

  it('throws with the states named when an invalid transition is attempted', () => {
    let raised: DomainError | undefined;
    try {
      assertPaymentTransition('imported', 'linked');
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('INVALID_STATE_TRANSITION');
    expect(raised?.details).toMatchObject({ from: 'imported', to: 'linked' });
  });
});

describe('payments that never need to be linked (invariant #7, ADR-0011, ADR-0015)', () => {
  it('treats a normalized internal transfer as a valid terminal state', () => {
    expect(isPaymentTerminalWithoutLinking('normalized', 'internal_account', 'debit')).toBe(true);
  });

  it('treats a normalized investment purchase as a valid terminal state', () => {
    expect(isPaymentTerminalWithoutLinking('normalized', 'investment_instrument', 'debit')).toBe(
      true,
    );
  });

  it('treats a normalized plain credit as a valid terminal state (V1 inflow scope)', () => {
    expect(isPaymentTerminalWithoutLinking('normalized', 'unknown', 'credit')).toBe(true);
  });

  it('does not excuse an ordinary debit from being explained', () => {
    expect(isPaymentTerminalWithoutLinking('normalized', 'merchant', 'debit')).toBe(false);
  });
});

describe('expense lifecycle (lifecycle.md, Expense)', () => {
  it('walks the full documented chain', () => {
    const chain = [
      ['proposed', 'classified'],
      ['classified', 'review_required'],
      ['review_required', 'approved'],
      ['approved', 'allocated'],
      ['allocated', 'ready_to_sync'],
      ['ready_to_sync', 'synced'],
      ['synced', 'reconciled'],
    ] as const;

    for (const [from, to] of chain) {
      expect(canTransitionExpense(from, to)).toBe(true);
    }
  });

  it('allows a high-confidence expense to pass classified → approved', () => {
    expect(canTransitionExpense('classified', 'approved')).toBe(true);
  });

  it('lets a personal or gift expense skip sync entirely: allocated → reconciled', () => {
    expect(canTransitionExpense('allocated', 'reconciled')).toBe(true);
  });

  it('lets a declined or superseded proposal reach the rejected off-ramp', () => {
    // ADR-0028: the DERIVED expense a classification proposal created has somewhere to go
    // when that proposal is declined, instead of sitting unapproved forever.
    expect(canTransitionExpense('classified', 'rejected')).toBe(true);
    expect(canTransitionExpense('review_required', 'rejected')).toBe(true);
  });

  it('never rejects an expense that was ever approved', () => {
    // Declining a *proposal* is cheap. Unwinding an approved financial record is not, and
    // this transition must not pretend otherwise.
    for (const from of [
      'approved',
      'allocated',
      'ready_to_sync',
      'synced',
      'reconciled',
    ] as const) {
      expect(canTransitionExpense(from, 'rejected')).toBe(false);
    }
  });

  it('never rejects an expense before it has been classified', () => {
    expect(canTransitionExpense('proposed', 'rejected')).toBe(false);
  });

  it('makes rejected terminal — no revival, no approval, no second thoughts', () => {
    for (const to of [
      'proposed',
      'classified',
      'review_required',
      'approved',
      'allocated',
      'ready_to_sync',
      'synced',
      'reconciled',
    ] as const) {
      expect(canTransitionExpense('rejected', to)).toBe(false);
    }
  });

  it('leaves a rejected expense’s amount unfrozen — it was never approved', () => {
    expect(isExpenseAmountFrozen('rejected')).toBe(false);
  });

  it('refuses to reach approved without being classified first', () => {
    expect(canTransitionExpense('proposed', 'approved')).toBe(false);
  });

  it('refuses to reach allocated straight from classified', () => {
    expect(canTransitionExpense('classified', 'allocated')).toBe(false);
  });

  it('refuses to sync before allocation', () => {
    expect(canTransitionExpense('approved', 'ready_to_sync')).toBe(false);
    expect(canTransitionExpense('approved', 'synced')).toBe(false);
  });

  it('lets a reconciled expense regress to review_required when drift is found (§25, §30)', () => {
    expect(canTransitionExpense('reconciled', 'review_required')).toBe(true);
    expect(canTransitionExpense('synced', 'review_required')).toBe(true);
    expect(canTransitionExpense('allocated', 'review_required')).toBe(true);
  });

  it('refuses to regress below review_required', () => {
    expect(canTransitionExpense('approved', 'classified')).toBe(false);
    expect(canTransitionExpense('reconciled', 'proposed')).toBe(false);
  });

  it('throws on an invalid transition', () => {
    expect(() => assertExpenseTransition('proposed', 'synced')).toThrow(DomainError);
  });
});

describe('canEnterReadyToSync — the corrected gate (lifecycle.md revision note, §8)', () => {
  const sharedLines = [
    { beneficiaryId: dev, amount: paise(80000n) },
    { beneficiaryId: friendA, amount: paise(80000n) },
  ];

  it('admits a shared expense with a non-payer beneficiary', () => {
    expect(
      canEnterReadyToSync({
        relationshipType: 'shared',
        paidByPersonId: dev,
        resolvedShares: sharedLines,
      }),
    ).toBe(true);
  });

  it('admits paid_on_behalf and household_shared_flat', () => {
    for (const relationshipType of ['paid_on_behalf', 'household_shared_flat'] as const) {
      expect(
        canEnterReadyToSync({ relationshipType, paidByPersonId: dev, resolvedShares: sharedLines }),
      ).toBe(true);
    }
  });

  it('refuses a gift, even though it has a non-payer beneficiary line', () => {
    // The exact case the original "allocation involves a non-self beneficiary" gate got
    // wrong: syncing a gift would tell the recipient they owe for their own present.
    expect(
      canEnterReadyToSync({
        relationshipType: 'gift',
        paidByPersonId: dev,
        resolvedShares: [{ beneficiaryId: friendA, amount: paise(250000n) }],
      }),
    ).toBe(false);
  });

  it('refuses a personal expense', () => {
    expect(
      canEnterReadyToSync({
        relationshipType: 'personal',
        paidByPersonId: dev,
        resolvedShares: [{ beneficiaryId: dev, amount: paise(65000n) }],
      }),
    ).toBe(false);
  });

  it('refuses a shared expense whose only beneficiary is the payer', () => {
    expect(
      canEnterReadyToSync({
        relationshipType: 'shared',
        paidByPersonId: dev,
        resolvedShares: [{ beneficiaryId: dev, amount: paise(65000n) }],
      }),
    ).toBe(false);
  });

  it('refuses a fully refunded shared expense, whose lines are all zero', () => {
    expect(
      canEnterReadyToSync({
        relationshipType: 'shared',
        paidByPersonId: dev,
        resolvedShares: [
          { beneficiaryId: dev, amount: paise(0n) },
          { beneficiaryId: friendA, amount: paise(0n) },
        ],
      }),
    ).toBe(false);
  });
});

describe('hasObligationCreatingLine', () => {
  it('is true when a non-payer holds a non-zero share', () => {
    expect(
      hasObligationCreatingLine(dev, [
        { beneficiaryId: dev, amount: paise(100n) },
        { beneficiaryId: friendA, amount: paise(100n) },
      ]),
    ).toBe(true);
  });

  it('is false when every share belongs to the payer', () => {
    expect(hasObligationCreatingLine(dev, [{ beneficiaryId: dev, amount: paise(100n) }])).toBe(
      false,
    );
  });
});

describe('ExpenseAdjustment lifecycle', () => {
  it('moves recorded → distributed', () => {
    expect(canTransitionAdjustment('recorded', 'distributed')).toBe(true);
  });

  it('does not move back', () => {
    expect(canTransitionAdjustment('distributed', 'recorded')).toBe(false);
  });
});

describe('AIInference lifecycle', () => {
  it.each(['accepted', 'modified', 'rejected', 'superseded'] as const)(
    'moves pending → %s',
    (to) => {
      expect(canTransitionAiInference('pending', to)).toBe(true);
    },
  );

  it('does not re-open a decided inference', () => {
    expect(canTransitionAiInference('accepted', 'pending')).toBe(false);
    expect(canTransitionAiInference('rejected', 'accepted')).toBe(false);
  });

  it('lets a superseded inference stay superseded rather than being deleted', () => {
    expect(canTransitionAiInference('superseded', 'accepted')).toBe(false);
  });
});

describe('SplitwiseExpense sync status', () => {
  it('moves pending → synced', () => {
    expect(canTransitionSplitwiseExpenseSync('pending', 'synced')).toBe(true);
  });

  it('moves synced → drifted when their side changed', () => {
    expect(canTransitionSplitwiseExpenseSync('synced', 'drifted')).toBe(true);
  });

  it('moves synced → stale when our side changed (ADR-0008)', () => {
    expect(canTransitionSplitwiseExpenseSync('synced', 'stale')).toBe(true);
  });

  it('never auto-resolves drift or staleness straight back to synced', () => {
    expect(canTransitionSplitwiseExpenseSync('drifted', 'synced')).toBe(false);
    expect(canTransitionSplitwiseExpenseSync('stale', 'synced')).toBe(false);
  });

  it('clears drift or staleness only through a fresh, re-confirmable proposal', () => {
    expect(canTransitionSplitwiseExpenseSync('drifted', 'pending')).toBe(true);
    expect(canTransitionSplitwiseExpenseSync('stale', 'pending')).toBe(true);
  });

  it('allows a failed sync to be retried', () => {
    expect(canTransitionSplitwiseExpenseSync('sync_failed', 'synced')).toBe(true);
  });
});
