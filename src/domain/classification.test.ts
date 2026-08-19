import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MATERIALITY_THRESHOLD_PAISE,
  classificationEligibility,
  findSelfTransferCounterLeg,
  isSelfTransferPair,
  parseDecisionActor,
  routeClassificationForReview,
} from './classification.js';
import type { ClassificationEligibilityInput, TransferLeg } from './classification.js';
import { isDeterministicDuplicate } from './payment.js';
import { isDomainError } from './errors.js';
import { paise } from './money.js';

const AT = new Date('2026-07-02T00:00:00.000Z');

function eligibilityInput(
  overrides: Partial<ClassificationEligibilityInput> = {},
): ClassificationEligibilityInput {
  return {
    state: 'normalized',
    counterpartyType: 'merchant',
    direction: 'debit',
    hasClassificationInference: false,
    ...overrides,
  };
}

function leg(overrides: Partial<TransferLeg> = {}): TransferLeg {
  return {
    paymentId: 'payment-a',
    amount: paise(1_500_000n),
    direction: 'debit',
    occurredAt: AT,
    externalReference: 'NEFT/N072026001',
    state: 'normalized',
    ...overrides,
  };
}

describe('classificationEligibility', () => {
  it('accepts a normalized, unclassified debit', () => {
    expect(classificationEligibility(eligibilityInput())).toEqual({ outcome: 'eligible' });
  });

  it('skips a payment that has not been normalized yet', () => {
    // Classification reads a counterparty and a channel that normalization writes; running
    // before it would classify a row whose evidence has not been read.
    expect(classificationEligibility(eligibilityInput({ state: 'imported' }))).toEqual({
      outcome: 'skipped',
      reason: 'not_normalized',
    });
  });

  it('skips a payment already explained or discarded', () => {
    for (const state of ['linked', 'ignored'] as const) {
      expect(classificationEligibility(eligibilityInput({ state }))).toEqual({
        outcome: 'skipped',
        reason: 'not_normalized',
      });
    }
  });

  it('skips a transfer or an investment — that classification is already settled', () => {
    for (const counterpartyType of ['internal_account', 'investment_instrument'] as const) {
      expect(classificationEligibility(eligibilityInput({ counterpartyType }))).toEqual({
        outcome: 'skipped',
        reason: 'non_spend_counterparty',
      });
    }
  });

  it('skips a payment that already carries a classification inference', () => {
    // A re-run must not produce a second proposal for one payment (the ADR-0021 pattern).
    expect(
      classificationEligibility(eligibilityInput({ hasClassificationInference: true })),
    ).toEqual({ outcome: 'skipped', reason: 'already_classified' });
  });

  it('leaves a credit to the deterministic leg only', () => {
    expect(classificationEligibility(eligibilityInput({ direction: 'credit' }))).toEqual({
      outcome: 'deterministic_only',
      reason: 'credit_out_of_scope',
    });
  });

  it('ranks an unnormalized credit as not-normalized, not as out-of-scope', () => {
    // Order matters: the more fundamental reason wins, so the returned reason is actionable.
    expect(
      classificationEligibility(eligibilityInput({ state: 'imported', direction: 'credit' })),
    ).toEqual({ outcome: 'skipped', reason: 'not_normalized' });
  });
});

describe('isSelfTransferPair', () => {
  it('pairs a debit and a credit sharing one reference, amount and instant', () => {
    const debit = leg({ paymentId: 'out', direction: 'debit' });
    const credit = leg({ paymentId: 'in', direction: 'credit' });

    expect(isSelfTransferPair(debit, credit)).toBe(true);
    expect(isSelfTransferPair(credit, debit)).toBe(true);
  });

  it('is the mirror image of duplicate detection, not an overlap of it', () => {
    // ADR-0019 made direction load-bearing for dedup precisely so a transfer's two legs are
    // not collapsed into one. The same evidence, read the other way round, identifies them.
    const debit = leg({ paymentId: 'out', direction: 'debit' });
    const credit = leg({ paymentId: 'in', direction: 'credit' });

    expect(isSelfTransferPair(debit, credit)).toBe(true);
    expect(isDeterministicDuplicate(debit, credit)).toBe(false);
  });

  it('refuses a pair in the same direction — that is a duplicate, not a transfer', () => {
    expect(isSelfTransferPair(leg({ paymentId: 'a' }), leg({ paymentId: 'b' }))).toBe(false);
  });

  it('refuses a payment paired with itself', () => {
    expect(isSelfTransferPair(leg(), leg({ direction: 'credit' }))).toBe(false);
  });

  it('requires a reference on both sides, and the same one', () => {
    const credit = leg({ paymentId: 'in', direction: 'credit' });

    expect(isSelfTransferPair(leg({ externalReference: null }), credit)).toBe(false);
    expect(isSelfTransferPair(leg(), { ...credit, externalReference: null })).toBe(false);
    expect(isSelfTransferPair(leg(), { ...credit, externalReference: 'NEFT/OTHER' })).toBe(false);
  });

  it('requires the same amount', () => {
    const credit = leg({ paymentId: 'in', direction: 'credit', amount: paise(1_500_001n) });

    expect(isSelfTransferPair(leg(), credit)).toBe(false);
  });

  it('ignores a leg the ledger has already discarded', () => {
    const credit = leg({ paymentId: 'in', direction: 'credit', state: 'ignored' });

    expect(isSelfTransferPair(leg(), credit)).toBe(false);
  });

  it('tolerates capture skew up to the window and no further', () => {
    const within = leg({
      paymentId: 'in',
      direction: 'credit',
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    const beyond = leg({
      paymentId: 'in',
      direction: 'credit',
      occurredAt: new Date(AT.getTime() + 60_001),
    });

    expect(isSelfTransferPair(leg(), within)).toBe(true);
    expect(isSelfTransferPair(leg(), beyond)).toBe(false);
    expect(isSelfTransferPair(leg(), beyond, { windowSeconds: 120 })).toBe(true);
  });
});

describe('findSelfTransferCounterLeg', () => {
  it('returns the matching leg out of a candidate set', () => {
    const debit = leg({ paymentId: 'out' });
    const unrelated = leg({ paymentId: 'other', externalReference: 'UPI/2607071500/P2P' });
    const counter = leg({ paymentId: 'in', direction: 'credit' });

    expect(findSelfTransferCounterLeg(debit, [unrelated, counter])).toBe(counter);
  });

  it('returns null when nothing pairs, including against itself', () => {
    const debit = leg({ paymentId: 'out' });

    expect(findSelfTransferCounterLeg(debit, [debit])).toBeNull();
    expect(findSelfTransferCounterLeg(debit, [])).toBeNull();
  });
});

describe('routeClassificationForReview', () => {
  const immaterial = paise(124_000n);

  it('lets a high-confidence, immaterial expense proposal reach CLASSIFIED', () => {
    expect(
      routeClassificationForReview({
        confidence: 'high',
        amount: immaterial,
        proposedKind: 'expense',
      }),
    ).toEqual({ requiresReview: false, reasons: [] });
  });

  it('routes every confidence short of high to review', () => {
    for (const confidence of ['medium', 'low', 'unknown'] as const) {
      expect(
        routeClassificationForReview({ confidence, amount: immaterial, proposedKind: 'expense' }),
      ).toEqual({ requiresReview: true, reasons: ['low_confidence'] });
    }
  });

  it('routes a material amount to review however confident the model is', () => {
    expect(
      routeClassificationForReview({
        confidence: 'high',
        amount: DEFAULT_MATERIALITY_THRESHOLD_PAISE,
        proposedKind: 'expense',
      }),
    ).toEqual({ requiresReview: true, reasons: ['material_amount'] });
  });

  it('treats the threshold as inclusive, and one paisa below it as immaterial', () => {
    const justBelow = paise(DEFAULT_MATERIALITY_THRESHOLD_PAISE - 1n);

    expect(
      routeClassificationForReview({
        confidence: 'high',
        amount: justBelow,
        proposedKind: 'expense',
      }).requiresReview,
    ).toBe(false);
  });

  it('honours a caller-supplied threshold', () => {
    expect(
      routeClassificationForReview({
        confidence: 'high',
        amount: immaterial,
        proposedKind: 'expense',
        materialityThreshold: paise(100_000n),
      }),
    ).toEqual({ requiresReview: true, reasons: ['material_amount'] });
  });

  it('always reviews a settlement proposal', () => {
    // Accepting one creates an APPROVED Settlement directly — there is no DERIVED state in
    // between for anyone to inspect afterwards (ADR-0026).
    expect(
      routeClassificationForReview({
        confidence: 'high',
        amount: immaterial,
        proposedKind: 'settlement',
      }),
    ).toEqual({ requiresReview: true, reasons: ['settlement_kind'] });
  });

  it('reports every reason that applies, in a stable order', () => {
    expect(
      routeClassificationForReview({
        confidence: 'unknown',
        amount: paise(1_500_000n),
        proposedKind: 'settlement',
      }),
    ).toEqual({
      requiresReview: true,
      reasons: ['low_confidence', 'material_amount', 'settlement_kind'],
    });
  });
});

describe('parseDecisionActor', () => {
  it('accepts a person', () => {
    expect(parseDecisionActor('user')).toEqual({ kind: 'user', actor: 'user' });
    expect(parseDecisionActor('user:dev')).toEqual({ kind: 'user', actor: 'user:dev' });
  });

  it('accepts a previously-approved rule, keeping its id for traceability', () => {
    expect(parseDecisionActor('rule:abc-123')).toEqual({
      kind: 'rule',
      ruleId: 'abc-123',
      actor: 'rule:abc-123',
    });
  });

  it('refuses the model itself, the system, and an anonymous rule', () => {
    for (const actor of ['ai', 'system', 'rule:', '', 'anthropic']) {
      let thrown: unknown;
      try {
        parseDecisionActor(actor);
      } catch (error) {
        thrown = error;
      }
      expect(isDomainError(thrown) && thrown.code).toBe('DECISION_ACTOR_INVALID');
    }
  });
});
