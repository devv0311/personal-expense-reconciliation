import { describe, expect, it } from 'vitest';

import {
  ALLOCATION_METHODS,
  DEBT_CREATING_RELATIONSHIP_TYPES,
  EXPENSE_ADJUSTMENT_KINDS,
  EXPENSE_RELATIONSHIP_TYPES,
  EXPENSE_STATES,
  NON_SPEND_COUNTERPARTY_TYPES,
  PAYMENT_COUNTERPARTY_TYPES,
  PAYMENT_STATES,
  SPLITWISE_EXPENSE_SYNC_STATUSES,
  createsObligation,
  isNonSpendCounterparty,
} from './enums.js';

describe('expense relationship types', () => {
  it('is the five-value enum ADR-0007 and ADR-0008 shrank it to', () => {
    expect([...EXPENSE_RELATIONSHIP_TYPES]).toEqual([
      'personal',
      'shared',
      'paid_on_behalf',
      'gift',
      'household_shared_flat',
    ]);
  });

  it('no longer carries "settlement" — a settlement is its own entity (ADR-0007)', () => {
    expect(EXPENSE_RELATIONSHIP_TYPES).not.toContain('settlement');
  });

  it('no longer carries "reimbursement" — that is an ExpenseAdjustment kind (ADR-0008)', () => {
    expect(EXPENSE_RELATIONSHIP_TYPES).not.toContain('reimbursement');
    expect([...EXPENSE_ADJUSTMENT_KINDS]).toEqual(['merchant_refund', 'third_party_reimbursement']);
  });
});

describe('the debt-creating relationship set (domain-model.md, Obligation)', () => {
  it('is exactly shared, paid_on_behalf and household_shared_flat', () => {
    expect([...DEBT_CREATING_RELATIONSHIP_TYPES]).toEqual([
      'shared',
      'paid_on_behalf',
      'household_shared_flat',
    ]);
  });

  it('excludes gift, so a gift can never generate a debt (scenario §8)', () => {
    expect(createsObligation('gift')).toBe(false);
  });

  it('excludes personal', () => {
    expect(createsObligation('personal')).toBe(false);
  });

  it.each(['shared', 'paid_on_behalf', 'household_shared_flat'] as const)(
    'includes %s',
    (relationshipType) => {
      expect(createsObligation(relationshipType)).toBe(true);
    },
  );

  it('is a subset of the full relationship enum', () => {
    for (const relationshipType of DEBT_CREATING_RELATIONSHIP_TYPES) {
      expect(EXPENSE_RELATIONSHIP_TYPES).toContain(relationshipType);
    }
  });
});

describe('payment counterparty types', () => {
  it('includes investment_instrument (ADR-0011)', () => {
    expect([...PAYMENT_COUNTERPARTY_TYPES]).toEqual([
      'merchant',
      'person',
      'internal_account',
      'investment_instrument',
      'unknown',
    ]);
  });

  it('treats internal transfers and investments as non-spend (invariants #7)', () => {
    expect([...NON_SPEND_COUNTERPARTY_TYPES]).toEqual([
      'internal_account',
      'investment_instrument',
    ]);
    expect(isNonSpendCounterparty('internal_account')).toBe(true);
    expect(isNonSpendCounterparty('investment_instrument')).toBe(true);
  });

  it('treats merchant, person and unknown counterparties as potentially spend', () => {
    expect(isNonSpendCounterparty('merchant')).toBe(false);
    expect(isNonSpendCounterparty('person')).toBe(false);
    expect(isNonSpendCounterparty('unknown')).toBe(false);
  });
});

describe('state enums match lifecycle.md', () => {
  it('lists the payment states', () => {
    expect([...PAYMENT_STATES]).toEqual(['imported', 'normalized', 'linked', 'ignored']);
  });

  it('lists the expense states in lifecycle order', () => {
    expect([...EXPENSE_STATES]).toEqual([
      'proposed',
      'classified',
      'review_required',
      'approved',
      'allocated',
      'ready_to_sync',
      'synced',
      'reconciled',
    ]);
  });

  it('lists all six allocation methods', () => {
    expect([...ALLOCATION_METHODS]).toEqual([
      'equal',
      'exact',
      'percentage',
      'item_based',
      'quantity_based',
      'custom',
    ]);
  });

  it('distinguishes stale from drifted on Splitwise expense sync (ADR-0008)', () => {
    expect([...SPLITWISE_EXPENSE_SYNC_STATUSES]).toEqual([
      'pending',
      'synced',
      'drifted',
      'stale',
      'sync_failed',
    ]);
  });
});
