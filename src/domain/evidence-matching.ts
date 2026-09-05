/**
 * Context re-attachment: which `Payment` is this piece of evidence about? (Phase 17, ADR-0044)
 *
 * Pillar 1 of `CLAUDE.md` is the problem this solves. A UPI statement line decays to
 * `UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD` or worse, while the push notification that
 * arrived the same second knows the amount, the reference, the account tail and the merchant.
 * Matching the two puts the context back — **beside** the narration, never over it.
 *
 * Everything here is pure. Values in, verdicts out: no database, no clock, no model. That is
 * not decoration. `ai-boundary.md` gives deterministic evidence to application code, and every
 * signal compared below is deterministic — an exact reference, an exact amount, a direction, a
 * masked account tail, a bounded time window, a merchant string. A judgement call would belong
 * on the other side of that boundary, and there is none here.
 *
 * Three rules this module exists to keep, all of them from ADR-0034/0037 and carried forward
 * unchanged by ADR-0044:
 *
 *  1. **A match is a candidate, never a link.** Nothing here returns an instruction. The
 *     strongest possible result — a matching reference with nothing contradicting it — is
 *     still `strength: 'deterministic'` and `requires review`, because `evidence` linkage is
 *     write-once and a wrong link cannot be undone (ADR-0034).
 *  2. **Confidence describes, it never permits.** `summariseMatchConfidence` reports how much
 *     of the signal set agreed. No caller may read it as approval (ADR-0024).
 *  3. **Absent is not conflicted.** A notification with no account tail says nothing about the
 *     account; it does not disagree about it. Collapsing the two would turn silence into
 *     evidence.
 */

import type {
  ConfidenceLevel,
  EvidenceMatchSignal,
  EvidenceMatchStrength,
  PaymentDirection,
} from './enums.js';
import { EVIDENCE_MATCH_SIGNALS } from './enums.js';
import type { EvidenceMatchVerdict } from './enums.js';
import type { EvidenceObservationFields } from './evidence-observation.js';
import { normalizeReference, referencesMatch } from './evidence-observation.js';
import type { Paise } from './money.js';
import { DEFAULT_RECEIPT_MATCH_WINDOW_DAYS } from './receipt.js';

/* -------------------------------------------------------------------------- windows */

/**
 * How far a candidate payment's date may sit from the evidence's **capture** time.
 *
 * The same window ADR-0037 chose for receipts, and deliberately the same constant rather than
 * a second one beside it: a forwarded email receipt or a photographed paper one is routinely
 * captured after the purchase, and there is no reason for a notification's window and a
 * receipt's window to drift apart.
 */
export const DEFAULT_EVIDENCE_CAPTURE_WINDOW_DAYS = DEFAULT_RECEIPT_MATCH_WINDOW_DAYS;

/**
 * How far a candidate payment's instant may sit from an instant the evidence itself states.
 *
 * Wide on purpose, and the reason is in the data rather than in caution. A bank CSV carries a
 * **date**, which `integrations/bank-csv/parse.ts` fixes at UTC midnight; a UPI notification
 * carries the actual instant, 20:12 on that day. The two describe one transaction and sit
 * twenty hours apart before any clock skew is involved. A tight window here would reject every
 * genuine statement-to-notification match in the fixtures, which is the opposite of the job.
 */
export const DEFAULT_EVIDENCE_INSTANT_SKEW_HOURS = 36;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

export interface EvidenceMatchOptions {
  readonly captureWindowDays?: number;
  readonly instantSkewHours?: number;
}

/* --------------------------------------------------------------------------- inputs */

/** One evidence record, as the matcher needs it: its capture time and what it observed. */
export interface MatchableEvidence {
  readonly evidenceId: string;
  readonly capturedAt: Date;
  readonly observation: EvidenceObservationFields;
}

/** One payment the evidence could be about, with the account context the match needs. */
export interface MatchablePayment {
  readonly paymentId: string;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  readonly externalReference: string | null;
  /** The masked tail of the account this movement landed on, when the account records one. */
  readonly accountLast4: string | null;
  /** Money that moved on somebody else's account is not this user's movement to re-attach. */
  readonly accountOwnedByUser: boolean;
  /** The resolved merchant, when normalization found one. */
  readonly merchantName: string | null;
  /** SOURCE narration. Read for corroboration only — never rewritten (`invariants.md` #4). */
  readonly rawDescription: string;
}

/* -------------------------------------------------------------------------- results */

/** What one signal said, and the two values it said it about. */
export interface EvidenceMatchSignalResult {
  readonly signal: EvidenceMatchSignal;
  readonly verdict: EvidenceMatchVerdict;
  /** The evidence's side, as text a surface can show. `null` when the evidence is silent. */
  readonly evidenceValue: string | null;
  readonly paymentValue: string | null;
  /** One line explaining the verdict, so a reviewer never has to re-derive it. */
  readonly detail: string;
}

/** Why a candidate is waiting for a person. Recorded per candidate, never collapsed to a flag. */
export const EVIDENCE_MATCH_REVIEW_REASONS = [
  /** The baseline, present on every candidate: linking evidence is an explicit human act. */
  'link_decision_required',
  /** More than one payment is eligible — the set cannot pick between them, and neither may this. */
  'ambiguous_candidates',
  /** At least one signal disagreed. The candidate stands, flagged, rather than being hidden. */
  'conflicting_signals',
  /** Corroborated only by amount and time — the shape a same-amount coincidence also has. */
  'weak_evidence',
] as const;
export type EvidenceMatchReviewReason = (typeof EVIDENCE_MATCH_REVIEW_REASONS)[number];

/** Why a payment is not offered as a candidate at all. */
export const EVIDENCE_MATCH_DISQUALIFICATIONS = [
  'direction_conflict',
  'account_conflict',
  'account_not_owned',
  'uncorroborated',
] as const;
export type EvidenceMatchDisqualification = (typeof EVIDENCE_MATCH_DISQUALIFICATIONS)[number];

export interface EvidenceMatchAssessment {
  readonly paymentId: string;
  readonly signals: readonly EvidenceMatchSignalResult[];
  readonly matchedSignals: readonly EvidenceMatchSignal[];
  readonly conflictingSignals: readonly EvidenceMatchSignal[];
  readonly strength: EvidenceMatchStrength;
  /** A summary of the signal set. Never an approval (ADR-0024, ADR-0044). */
  readonly confidence: ConfidenceLevel;
  /** Whether this payment is offered as a candidate at all. */
  readonly eligible: boolean;
  /** Present exactly when `eligible` is false. */
  readonly disqualifications: readonly EvidenceMatchDisqualification[];
  readonly reasons: readonly EvidenceMatchReviewReason[];
  /** How far apart the two instants are, in seconds — the raw number behind the time verdict. */
  readonly timeSkewSeconds: number;
  /** Whether the time comparison used a stated instant or fell back to capture time. */
  readonly timeBasis: 'observed_instant' | 'captured_at';
}

export interface EvidenceMatchResult {
  /** Every payment considered, including the rejected ones and why. */
  readonly assessments: readonly EvidenceMatchAssessment[];
  /** The eligible subset, best first. */
  readonly candidates: readonly EvidenceMatchAssessment[];
  /** More than one eligible candidate: the evidence does not say which, so a person must. */
  readonly ambiguous: boolean;
}

/* ------------------------------------------------------------------------ the matcher */

/**
 * Compares one evidence observation against one payment, signal by signal.
 *
 * Eligibility is two rules, both stated positively so that neither is a judgement:
 *
 *  - **Nothing structural contradicts it.** A debit is not a credit; a movement on account
 *    `…4821` is not a movement on account `…9013`; money on an account this user does not own
 *    is not theirs to re-attach. Each of these is a different transaction, not a weaker match,
 *    so it produces no candidate rather than a low-confidence one.
 *  - **Something positively corroborates it.** Either the reference identifiers agree — which
 *    `invariants.md` #10 already treats as conclusive identity for a transaction — or the
 *    amount agrees *and* the timing is within the window. Amount alone is a coincidence
 *    waiting to happen; timing alone is not evidence at all.
 *
 * A reference match with a disagreeing amount or date stays a candidate: the UTR says these
 * are one transaction and the disagreement is exactly what a reviewer needs to see, not a
 * reason to hide the row.
 */
export function assessEvidencePaymentMatch(
  evidence: MatchableEvidence,
  payment: MatchablePayment,
  options: EvidenceMatchOptions = {},
): EvidenceMatchAssessment {
  const observation = evidence.observation;

  const timeBasis = observation.observedOccurredAt !== null ? 'observed_instant' : 'captured_at';
  const evidenceInstant = observation.observedOccurredAt ?? evidence.capturedAt;
  const skewMs = Math.abs(payment.occurredAt.getTime() - evidenceInstant.getTime());
  const toleranceMs =
    timeBasis === 'observed_instant'
      ? (options.instantSkewHours ?? DEFAULT_EVIDENCE_INSTANT_SKEW_HOURS) * MILLISECONDS_PER_HOUR
      : (options.captureWindowDays ?? DEFAULT_EVIDENCE_CAPTURE_WINDOW_DAYS) * MILLISECONDS_PER_DAY;

  const signals: EvidenceMatchSignalResult[] = [
    referenceSignal(observation, payment),
    amountSignal(observation, payment),
    directionSignal(observation, payment),
    accountSignal(observation, payment),
    timeSignal(evidenceInstant, payment, skewMs, toleranceMs, timeBasis),
    merchantSignal(observation, payment),
  ];

  const verdictOf = (signal: EvidenceMatchSignal): EvidenceMatchVerdict =>
    signals.find((entry) => entry.signal === signal)!.verdict;

  const matchedSignals = orderedSignals(signals, 'matched');
  const conflictingSignals = orderedSignals(signals, 'conflicted');

  const disqualifications: EvidenceMatchDisqualification[] = [];
  if (!payment.accountOwnedByUser) disqualifications.push('account_not_owned');
  if (verdictOf('direction') === 'conflicted') disqualifications.push('direction_conflict');
  if (verdictOf('account') === 'conflicted') disqualifications.push('account_conflict');

  const corroborated =
    verdictOf('reference') === 'matched' ||
    (verdictOf('amount') === 'matched' && verdictOf('time') === 'matched');
  if (!corroborated) disqualifications.push('uncorroborated');

  const strength = matchStrength(verdictOf, conflictingSignals.length);
  const eligible = disqualifications.length === 0;

  const reasons: EvidenceMatchReviewReason[] = ['link_decision_required'];
  if (conflictingSignals.length > 0) reasons.push('conflicting_signals');
  if (strength === 'weak') reasons.push('weak_evidence');

  return {
    paymentId: payment.paymentId,
    signals,
    matchedSignals,
    conflictingSignals,
    strength,
    confidence: summariseMatchConfidence(strength, conflictingSignals.length),
    eligible,
    disqualifications,
    reasons: eligible ? reasons : [],
    timeSkewSeconds: Math.round(skewMs / 1000),
    timeBasis,
  };
}

/**
 * Assesses every payment, and orders the ones that survive.
 *
 * The order is total — strength, then how many signals agreed, then how close in time, then
 * the payment id — for the same reason `prioritiseReviewQueue` is: a candidate list that
 * reorders itself between two reads of an unchanged ledger is a list a reviewer cannot trust,
 * and this one is written to the database, where an unstable order would show up as spurious
 * churn on every re-run.
 *
 * When more than one candidate survives, every one of them is marked `ambiguous_candidates`.
 * That is the same-amount collision case, and the honest reading of it is "the evidence does
 * not distinguish these", not "the first one is probably right".
 */
export function matchEvidenceToPayments(
  evidence: MatchableEvidence,
  payments: readonly MatchablePayment[],
  options: EvidenceMatchOptions = {},
): EvidenceMatchResult {
  const assessments = payments.map((payment) =>
    assessEvidencePaymentMatch(evidence, payment, options),
  );
  const eligible = assessments.filter((assessment) => assessment.eligible).sort(compareCandidates);
  const ambiguous = eligible.length > 1;

  const candidates = ambiguous
    ? eligible.map((assessment) => ({
        ...assessment,
        reasons: withAmbiguity(assessment.reasons),
      }))
    : eligible;

  // The ambiguity reason belongs on the stored assessment too, so a caller that keeps the
  // full list rather than the candidate list sees the same explanation.
  const withAmbiguousReasons = assessments.map((assessment) => {
    const candidate = candidates.find((entry) => entry.paymentId === assessment.paymentId);
    return candidate ?? assessment;
  });

  return { assessments: withAmbiguousReasons, candidates, ambiguous };
}

const STRENGTH_RANK: Readonly<Record<EvidenceMatchStrength, number>> = {
  deterministic: 0,
  probable: 1,
  weak: 2,
};

function compareCandidates(a: EvidenceMatchAssessment, b: EvidenceMatchAssessment): number {
  const byStrength = STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength];
  if (byStrength !== 0) return byStrength;
  const bySignals = b.matchedSignals.length - a.matchedSignals.length;
  if (bySignals !== 0) return bySignals;
  const bySkew = a.timeSkewSeconds - b.timeSkewSeconds;
  if (bySkew !== 0) return bySkew;
  return a.paymentId < b.paymentId ? -1 : a.paymentId > b.paymentId ? 1 : 0;
}

function withAmbiguity(
  reasons: readonly EvidenceMatchReviewReason[],
): readonly EvidenceMatchReviewReason[] {
  return reasons.includes('ambiguous_candidates') ? reasons : [...reasons, 'ambiguous_candidates'];
}

/**
 * How strongly the signals support this candidate.
 *
 * `deterministic` is reserved for a matching reference with nothing contradicting it, because
 * that is the one signal that identifies a transaction on its own — the same basis
 * `isDeterministicDuplicate` already uses. Everything else is `probable` at best: an amount
 * and a date agreeing is a shape two unrelated purchases can share, and saying otherwise would
 * dress a coincidence up as a fact.
 */
function matchStrength(
  verdictOf: (signal: EvidenceMatchSignal) => EvidenceMatchVerdict,
  conflicts: number,
): EvidenceMatchStrength {
  if (verdictOf('reference') === 'matched') {
    return conflicts === 0 ? 'deterministic' : 'probable';
  }
  const corroboratedByAmountAndTime =
    verdictOf('amount') === 'matched' && verdictOf('time') === 'matched';
  const hasSecondarySupport =
    verdictOf('merchant') === 'matched' || verdictOf('account') === 'matched';
  return corroboratedByAmountAndTime && hasSecondarySupport && conflicts === 0
    ? 'probable'
    : 'weak';
}

/**
 * The confidence level a candidate carries.
 *
 * Purely a restatement of the signal set for a surface to render, and deliberately not a
 * number: `ai-boundary.md`'s four levels are what the rest of this system already speaks, and
 * inventing a 0–100 score here would invite exactly the threshold rule ADR-0024 forbids. No
 * value returned by this function permits anything.
 */
export function summariseMatchConfidence(
  strength: EvidenceMatchStrength,
  conflicts: number,
): ConfidenceLevel {
  const base: ConfidenceLevel =
    strength === 'deterministic' ? 'high' : strength === 'probable' ? 'medium' : 'low';
  if (conflicts === 0) return base;
  return base === 'high' ? 'medium' : 'low';
}

/* ------------------------------------------------------------------------- the signals */

function orderedSignals(
  signals: readonly EvidenceMatchSignalResult[],
  verdict: EvidenceMatchVerdict,
): readonly EvidenceMatchSignal[] {
  return EVIDENCE_MATCH_SIGNALS.filter((signal) =>
    signals.some((entry) => entry.signal === signal && entry.verdict === verdict),
  );
}

function referenceSignal(
  observation: EvidenceObservationFields,
  payment: MatchablePayment,
): EvidenceMatchSignalResult {
  const evidenceValue = observation.observedReference;
  const paymentValue = payment.externalReference;
  if (normalizeReference(evidenceValue) === null || normalizeReference(paymentValue) === null) {
    return {
      signal: 'reference',
      verdict: 'absent',
      evidenceValue,
      paymentValue,
      detail:
        'One side carries no reference identifier, so there is nothing to compare. A missing ' +
        'UTR is silence, not disagreement.',
    };
  }
  const matched = referencesMatch(evidenceValue, paymentValue);
  return {
    signal: 'reference',
    verdict: matched ? 'matched' : 'conflicted',
    evidenceValue,
    paymentValue,
    detail: matched
      ? 'The reference identifiers name the same transaction once the bank’s packaging is ' +
        'stripped (domain.referencesMatch).'
      : 'Both sides carry a reference and they name different transactions.',
  };
}

function amountSignal(
  observation: EvidenceObservationFields,
  payment: MatchablePayment,
): EvidenceMatchSignalResult {
  const evidenceValue = observation.observedAmount;
  if (evidenceValue === null) {
    return {
      signal: 'amount',
      verdict: 'absent',
      evidenceValue: null,
      paymentValue: payment.amount.toString(),
      detail: 'The evidence states no amount — the partial-evidence case, not a mismatch.',
    };
  }
  const matched = evidenceValue === payment.amount;
  return {
    signal: 'amount',
    verdict: matched ? 'matched' : 'conflicted',
    evidenceValue: evidenceValue.toString(),
    paymentValue: payment.amount.toString(),
    detail: matched
      ? 'Exact match, to the paise. No tolerance is applied: money is compared exactly.'
      : 'The evidence and the payment state different amounts for the same movement.',
  };
}

function directionSignal(
  observation: EvidenceObservationFields,
  payment: MatchablePayment,
): EvidenceMatchSignalResult {
  const evidenceValue = observation.observedDirection;
  if (evidenceValue === null) {
    return {
      signal: 'direction',
      verdict: 'absent',
      evidenceValue: null,
      paymentValue: payment.direction,
      detail: 'The evidence does not say which way the money moved.',
    };
  }
  const matched = evidenceValue === payment.direction;
  return {
    signal: 'direction',
    verdict: matched ? 'matched' : 'conflicted',
    evidenceValue,
    paymentValue: payment.direction,
    detail: matched
      ? 'Both describe money moving the same way.'
      : 'Money leaving is never the same movement as money arriving — including the two legs ' +
        'of one transfer, which are two payments (ADR-0023).',
  };
}

function accountSignal(
  observation: EvidenceObservationFields,
  payment: MatchablePayment,
): EvidenceMatchSignalResult {
  const evidenceValue = observation.observedAccountHint;
  const paymentValue = payment.accountLast4;
  if (evidenceValue === null || paymentValue === null) {
    return {
      signal: 'account',
      verdict: 'absent',
      evidenceValue,
      paymentValue,
      detail:
        'One side records no masked account tail. Many notifications carry none, and an ' +
        'account this ledger never stored a tail for cannot disagree about one.',
    };
  }
  const matched = evidenceValue === paymentValue;
  return {
    signal: 'account',
    verdict: matched ? 'matched' : 'conflicted',
    evidenceValue,
    paymentValue,
    detail: matched
      ? 'The masked tails agree.'
      : 'The evidence describes a movement on a different account of the user’s.',
  };
}

function timeSignal(
  evidenceInstant: Date,
  payment: MatchablePayment,
  skewMs: number,
  toleranceMs: number,
  basis: 'observed_instant' | 'captured_at',
): EvidenceMatchSignalResult {
  const matched = skewMs <= toleranceMs;
  const hours = (skewMs / MILLISECONDS_PER_HOUR).toFixed(1);
  return {
    signal: 'time',
    verdict: matched ? 'matched' : 'conflicted',
    evidenceValue: evidenceInstant.toISOString(),
    paymentValue: payment.occurredAt.toISOString(),
    detail: matched
      ? `Within the window (${hours}h apart, compared against the evidence's ` +
        `${basis === 'observed_instant' ? 'stated instant' : 'capture time'}).`
      : `${hours}h apart, outside the window for the evidence's ` +
        `${basis === 'observed_instant' ? 'stated instant' : 'capture time'}.`,
  };
}

/**
 * Whether the evidence's merchant text and the payment describe the same counterparty.
 *
 * Compared against the resolved `Merchant` first and the raw narration second, on a
 * letters-and-digits key — the same shape `merchantAliasKey` reduces a description to, for the
 * same reason: `SWIGGY.IN`, `Swiggy` and `UPI-SWIGGY.IN-SWIGGY-swiggy@icici` are one merchant
 * wearing three formats.
 *
 * `conflicted` only when the payment has a *resolved* merchant that disagrees and the raw
 * narration does not contain the evidence's name either. A narration this system never
 * resolved is not a counter-claim about who was paid.
 */
function merchantSignal(
  observation: EvidenceObservationFields,
  payment: MatchablePayment,
): EvidenceMatchSignalResult {
  const evidenceValue = observation.observedMerchantText;
  if (evidenceValue === null) {
    return {
      signal: 'merchant',
      verdict: 'absent',
      evidenceValue: null,
      paymentValue: payment.merchantName,
      detail: 'The evidence names no merchant or counterparty.',
    };
  }

  const evidenceKey = merchantKey(evidenceValue);
  const merchantNameKey = payment.merchantName === null ? null : merchantKey(payment.merchantName);
  const narrationKey = merchantKey(payment.rawDescription);

  const inMerchantName = merchantNameKey !== null && keysOverlap(evidenceKey, merchantNameKey);
  const inNarration = keysOverlap(evidenceKey, narrationKey);

  if (inMerchantName || inNarration) {
    return {
      signal: 'merchant',
      verdict: 'matched',
      evidenceValue,
      paymentValue: payment.merchantName ?? payment.rawDescription,
      detail: inMerchantName
        ? 'The evidence names the merchant this payment already resolved to.'
        : 'The evidence’s merchant name appears in the payment’s own narration.',
    };
  }

  if (merchantNameKey !== null) {
    return {
      signal: 'merchant',
      verdict: 'conflicted',
      evidenceValue,
      paymentValue: payment.merchantName,
      detail:
        'The payment resolved to a different merchant, and the evidence’s name does not ' +
        'appear in the narration either.',
    };
  }

  return {
    signal: 'merchant',
    verdict: 'absent',
    evidenceValue,
    paymentValue: null,
    detail:
      'The payment has no resolved merchant, and its narration does not contain this name — ' +
      'nothing to agree or disagree with (a decayed UPI narration is exactly this case).',
  };
}

/** Letters and digits only, upper-cased — the merchant comparison key. */
function merchantKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Either key containing the other, with a floor so a two-letter fragment cannot match. */
const MIN_COMPARABLE_MERCHANT_LENGTH = 4;

function keysOverlap(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < MIN_COMPARABLE_MERCHANT_LENGTH) return shorter === longer;
  return longer.includes(shorter);
}
