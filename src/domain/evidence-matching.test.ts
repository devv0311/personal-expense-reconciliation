import { describe, expect, it } from 'vitest';

import {
  assessEvidencePaymentMatch,
  matchEvidenceToPayments,
  summariseMatchConfidence,
  DEFAULT_EVIDENCE_INSTANT_SKEW_HOURS,
} from './evidence-matching.js';
import type {
  EvidenceMatchSignalResult,
  MatchableEvidence,
  MatchablePayment,
} from './evidence-matching.js';
import type { EvidenceObservationFields } from './evidence-observation.js';
import type { Paise } from './money.js';

const CAPTURED_AT = new Date('2026-07-05T20:12:00Z');
const OCCURRED_AT = new Date('2026-07-05T00:00:00Z');

function observation(
  overrides: Partial<EvidenceObservationFields> = {},
): EvidenceObservationFields {
  return {
    observedAmount: 45000n as Paise,
    observedDirection: 'debit',
    observedReference: '402312345678',
    observedReferenceType: 'upi_utr',
    observedAccountHint: '4821',
    observedMerchantText: 'SWIGGY',
    observedOccurredAt: null,
    derivation: 'parsed_from_text',
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceObservationFields> = {}): MatchableEvidence {
  return {
    evidenceId: 'evidence-1',
    capturedAt: CAPTURED_AT,
    observation: observation(overrides),
  };
}

function payment(overrides: Partial<MatchablePayment> = {}): MatchablePayment {
  return {
    paymentId: 'payment-1',
    amount: 45000n as Paise,
    direction: 'debit',
    occurredAt: OCCURRED_AT,
    externalReference: 'UPI/402312345678/SWIGGY',
    accountLast4: '4821',
    accountOwnedByUser: true,
    merchantName: 'Swiggy',
    rawDescription: 'UPI-SWIGGY.IN-SWIGGY-swiggy@icici',
    ...overrides,
  };
}

function verdict(signals: readonly EvidenceMatchSignalResult[], name: string): string | undefined {
  return signals.find((entry) => entry.signal === name)?.verdict;
}

describe('assessEvidencePaymentMatch — a matching reference', () => {
  it('is deterministic when nothing contradicts it', () => {
    const assessment = assessEvidencePaymentMatch(evidence(), payment());
    expect(assessment.strength).toBe('deterministic');
    expect(assessment.confidence).toBe('high');
    expect(assessment.eligible).toBe(true);
    expect(assessment.conflictingSignals).toEqual([]);
    expect(assessment.matchedSignals).toEqual([
      'reference',
      'amount',
      'direction',
      'account',
      'time',
      'merchant',
    ]);
  });

  it('still requires a decision — the strongest match is not an approval', () => {
    // ADR-0034/0037/0044: `evidence` linkage is write-once, so a wrong link is unrecoverable.
    // No strength and no confidence removes the human step.
    expect(assessEvidencePaymentMatch(evidence(), payment()).reasons).toContain(
      'link_decision_required',
    );
  });

  it('survives a disagreeing amount, flagged rather than hidden', () => {
    const assessment = assessEvidencePaymentMatch(
      evidence({ observedAmount: 45500n as Paise }),
      payment(),
    );
    expect(assessment.eligible).toBe(true);
    expect(assessment.conflictingSignals).toEqual(['amount']);
    expect(assessment.strength).toBe('probable');
    expect(assessment.confidence).toBe('low');
    expect(assessment.reasons).toContain('conflicting_signals');
  });
});

describe('assessEvidencePaymentMatch — no reference to compare', () => {
  const noReference = evidence({ observedReference: null, observedReferenceType: null });

  it('records the reference as absent, not as a disagreement', () => {
    const assessment = assessEvidencePaymentMatch(noReference, payment());
    expect(verdict(assessment.signals, 'reference')).toBe('absent');
    expect(assessment.conflictingSignals).toEqual([]);
  });

  it('is corroborated by amount and time, with the merchant lifting it to probable', () => {
    const assessment = assessEvidencePaymentMatch(noReference, payment());
    expect(assessment.eligible).toBe(true);
    expect(assessment.strength).toBe('probable');
    expect(assessment.confidence).toBe('medium');
  });

  it('is weak when amount and time are all there is', () => {
    const assessment = assessEvidencePaymentMatch(
      evidence({
        observedReference: null,
        observedReferenceType: null,
        observedMerchantText: null,
        observedAccountHint: null,
      }),
      payment(),
    );
    expect(assessment.strength).toBe('weak');
    expect(assessment.confidence).toBe('low');
    expect(assessment.reasons).toContain('weak_evidence');
  });

  it('offers nothing when the amount disagrees and no reference vouches for it', () => {
    const assessment = assessEvidencePaymentMatch(
      evidence({
        observedReference: null,
        observedReferenceType: null,
        observedAmount: 99900n as Paise,
      }),
      payment(),
    );
    expect(assessment.eligible).toBe(false);
    expect(assessment.disqualifications).toContain('uncorroborated');
    expect(assessment.reasons).toEqual([]);
  });
});

describe('assessEvidencePaymentMatch — structural disagreement disqualifies', () => {
  it('refuses an opposite direction: the other leg of a transfer is a different payment', () => {
    const assessment = assessEvidencePaymentMatch(evidence(), payment({ direction: 'credit' }));
    expect(assessment.eligible).toBe(false);
    expect(assessment.disqualifications).toContain('direction_conflict');
    expect(assessment.conflictingSignals).toContain('direction');
  });

  it('refuses a different account of the user’s', () => {
    const assessment = assessEvidencePaymentMatch(evidence(), payment({ accountLast4: '9013' }));
    expect(assessment.eligible).toBe(false);
    expect(assessment.disqualifications).toContain('account_conflict');
  });

  it('refuses money that moved on an account the user does not own', () => {
    const assessment = assessEvidencePaymentMatch(
      evidence(),
      payment({ accountOwnedByUser: false }),
    );
    expect(assessment.eligible).toBe(false);
    expect(assessment.disqualifications).toContain('account_not_owned');
  });

  it('treats a missing account tail on either side as absent, not as a mismatch', () => {
    expect(assessEvidencePaymentMatch(evidence(), payment({ accountLast4: null })).eligible).toBe(
      true,
    );
    expect(
      assessEvidencePaymentMatch(evidence({ observedAccountHint: null }), payment()).eligible,
    ).toBe(true);
  });
});

describe('assessEvidencePaymentMatch — time', () => {
  it('tolerates the skew between a stated instant and a date-only statement line', () => {
    // A bank CSV posts at UTC midnight; the notification fired at 20:12 the same evening.
    const assessment = assessEvidencePaymentMatch(
      evidence({ observedOccurredAt: new Date('2026-07-05T20:12:00Z') }),
      payment(),
    );
    expect(assessment.timeBasis).toBe('observed_instant');
    expect(verdict(assessment.signals, 'time')).toBe('matched');
    expect(assessment.timeSkewSeconds).toBe(20 * 3600 + 12 * 60);
  });

  it('conflicts once the stated instant is outside the bounded skew', () => {
    const farAway = new Date(
      OCCURRED_AT.getTime() + (DEFAULT_EVIDENCE_INSTANT_SKEW_HOURS + 1) * 60 * 60 * 1000,
    );
    const assessment = assessEvidencePaymentMatch(
      evidence({ observedOccurredAt: farAway }),
      payment(),
    );
    expect(verdict(assessment.signals, 'time')).toBe('conflicted');
    // The reference still vouches for it, so it is a flagged candidate rather than nothing.
    expect(assessment.eligible).toBe(true);
    expect(assessment.strength).toBe('probable');
  });

  it('falls back to capture time when the evidence states no instant', () => {
    const assessment = assessEvidencePaymentMatch(evidence(), payment());
    expect(assessment.timeBasis).toBe('captured_at');
  });

  it('conflicts when a capture is outside the window', () => {
    const assessment = assessEvidencePaymentMatch(
      evidence(),
      payment({ occurredAt: new Date('2026-06-01T00:00:00Z') }),
    );
    expect(verdict(assessment.signals, 'time')).toBe('conflicted');
  });
});

describe('assessEvidencePaymentMatch — merchant', () => {
  it('matches the resolved merchant through formatting differences', () => {
    expect(verdict(assessEvidencePaymentMatch(evidence(), payment()).signals, 'merchant')).toBe(
      'matched',
    );
  });

  it('matches a decayed narration that still contains the name', () => {
    const assessment = assessEvidencePaymentMatch(
      evidence({ observedMerchantText: 'Blinkit' }),
      payment({
        merchantName: null,
        rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      }),
    );
    expect(verdict(assessment.signals, 'merchant')).toBe('matched');
  });

  it('conflicts when the payment resolved to a different merchant', () => {
    const assessment = assessEvidencePaymentMatch(
      evidence({ observedMerchantText: 'Zomato' }),
      payment(),
    );
    expect(verdict(assessment.signals, 'merchant')).toBe('conflicted');
    expect(assessment.eligible).toBe(true);
    expect(assessment.reasons).toContain('conflicting_signals');
  });

  it('says nothing when the narration decayed and nothing resolved it', () => {
    const assessment = assessEvidencePaymentMatch(
      evidence({ observedMerchantText: 'Blinkit' }),
      payment({ merchantName: null, rawDescription: 'UPI/P2M/402312345678' }),
    );
    expect(verdict(assessment.signals, 'merchant')).toBe('absent');
    expect(assessment.conflictingSignals).toEqual([]);
  });
});

describe('matchEvidenceToPayments', () => {
  it('marks every candidate ambiguous when two payments share the amount and the day', () => {
    const collision = evidence({
      observedReference: null,
      observedReferenceType: null,
      observedAccountHint: null,
      observedMerchantText: null,
    });
    const result = matchEvidenceToPayments(collision, [
      payment({ paymentId: 'payment-a', externalReference: null }),
      payment({ paymentId: 'payment-b', externalReference: null }),
    ]);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.reasons).toContain('ambiguous_candidates');
    }
  });

  it('does not mark a lone candidate ambiguous', () => {
    const result = matchEvidenceToPayments(evidence(), [payment()]);
    expect(result.ambiguous).toBe(false);
    expect(result.candidates[0]?.reasons).not.toContain('ambiguous_candidates');
  });

  it('orders deterministic candidates ahead of weak ones', () => {
    const result = matchEvidenceToPayments(evidence(), [
      payment({
        paymentId: 'payment-weak',
        externalReference: null,
        merchantName: null,
        rawDescription: 'UPI/P2M/999',
        accountLast4: null,
      }),
      payment({ paymentId: 'payment-strong' }),
    ]);
    expect(result.candidates.map((candidate) => candidate.paymentId)).toEqual([
      'payment-strong',
      'payment-weak',
    ]);
  });

  it('keeps the disqualified payments in `assessments`, so the "why not" survives', () => {
    const result = matchEvidenceToPayments(evidence(), [payment({ direction: 'credit' })]);
    expect(result.candidates).toEqual([]);
    expect(result.assessments).toHaveLength(1);
    expect(result.assessments[0]?.disqualifications).toContain('direction_conflict');
  });

  it('orders candidates identically however the payments arrived', () => {
    // The candidate order is written to the database and shown to a reviewer, so it must not
    // depend on which row the pre-filter query happened to return first.
    const payments = [payment({ paymentId: 'payment-b' }), payment({ paymentId: 'payment-a' })];
    expect(matchEvidenceToPayments(evidence(), payments).candidates).toEqual(
      matchEvidenceToPayments(evidence(), [...payments].reverse()).candidates,
    );
    expect(
      matchEvidenceToPayments(evidence(), payments).candidates.map((c) => c.paymentId),
    ).toEqual(['payment-a', 'payment-b']);
  });
});

describe('summariseMatchConfidence', () => {
  it('describes the signal set and nothing more', () => {
    expect(summariseMatchConfidence('deterministic', 0)).toBe('high');
    expect(summariseMatchConfidence('probable', 0)).toBe('medium');
    expect(summariseMatchConfidence('weak', 0)).toBe('low');
  });

  it('steps down when a signal disagreed, and never below low', () => {
    expect(summariseMatchConfidence('deterministic', 1)).toBe('medium');
    expect(summariseMatchConfidence('probable', 1)).toBe('low');
    expect(summariseMatchConfidence('weak', 3)).toBe('low');
  });
});
