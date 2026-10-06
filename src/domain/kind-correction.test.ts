import { describe, expect, it } from 'vitest';

import { EXPENSE_RELATIONSHIP_TYPES, EXPENSE_STATES } from './enums.js';
import { checkKindCorrection, kindCorrectionTargets } from './kind-correction.js';
import type { ExpenseState } from './enums.js';

const ok = (overrides: Partial<Parameters<typeof checkKindCorrection>[0]> = {}) =>
  checkKindCorrection({
    currentRelationshipType: 'personal',
    expectedRelationshipType: 'personal',
    targetRelationshipType: 'shared',
    state: 'approved',
    ...overrides,
  });

describe('checkKindCorrection', () => {
  it('allows personal → each debt-creating kind, while approved or allocated', () => {
    for (const state of ['approved', 'allocated'] as const) {
      for (const target of ['shared', 'paid_on_behalf', 'household_shared_flat']) {
        expect(ok({ state, targetRelationshipType: target })).toBeNull();
      }
    }
  });

  it('refuses a correction to a kind that creates no debt, or to the same kind', () => {
    for (const target of ['personal', 'gift', 'settlement', '']) {
      expect(ok({ targetRelationshipType: target })?.reason).toBe('target_not_debt_creating');
    }
  });

  it('refuses when the ledger no longer holds the kind the person saw — before anything else', () => {
    const refusal = ok({
      currentRelationshipType: 'shared',
      expectedRelationshipType: 'personal',
      state: 'reconciled',
    });
    expect(refusal?.reason).toBe('kind_changed_since_read');
    expect(refusal?.message).toMatch(/now recorded as shared/);
  });

  it('refuses every kind but personal as the starting point', () => {
    for (const kind of EXPENSE_RELATIONSHIP_TYPES.filter((k) => k !== 'personal')) {
      expect(ok({ currentRelationshipType: kind, expectedRelationshipType: kind })?.reason).toBe(
        'not_personal',
      );
    }
  });

  it('sends a not-yet-approved expense back to its question, and refuses closed history', () => {
    for (const state of ['proposed', 'classified', 'review_required'] as const) {
      expect(ok({ state })?.reason).toBe('not_yet_approved');
    }
    for (const state of ['ready_to_sync', 'synced', 'reconciled', 'rejected'] as const) {
      expect(ok({ state })?.reason).toBe('closed');
    }
  });

  it('is exhaustive over every state: only approved and allocated pass', () => {
    const passing = (EXPENSE_STATES as readonly ExpenseState[]).filter(
      (state) => ok({ state }) === null,
    );
    expect(passing).toEqual(['approved', 'allocated']);
  });
});

describe('kindCorrectionTargets', () => {
  it('offers the three debt-creating kinds only for an approved or allocated personal expense', () => {
    expect(kindCorrectionTargets({ relationshipType: 'personal', state: 'approved' })).toEqual([
      'shared',
      'paid_on_behalf',
      'household_shared_flat',
    ]);
    expect(
      kindCorrectionTargets({ relationshipType: 'personal', state: 'allocated' }),
    ).toHaveLength(3);
    expect(
      kindCorrectionTargets({ relationshipType: 'personal', state: 'review_required' }),
    ).toEqual([]);
    expect(kindCorrectionTargets({ relationshipType: 'shared', state: 'approved' })).toEqual([]);
    expect(kindCorrectionTargets({ relationshipType: 'gift', state: 'allocated' })).toEqual([]);
  });

  it('agrees with checkKindCorrection everywhere', () => {
    for (const kind of EXPENSE_RELATIONSHIP_TYPES) {
      for (const state of EXPENSE_STATES) {
        const offered = kindCorrectionTargets({ relationshipType: kind, state }).length > 0;
        const allowed =
          checkKindCorrection({
            currentRelationshipType: kind,
            expectedRelationshipType: kind,
            targetRelationshipType: 'shared',
            state,
          }) === null;
        expect(offered).toBe(allowed);
      }
    }
  });
});
