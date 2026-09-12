/**
 * What a live balance reading is allowed to mean (audit row 37, ADR-0054).
 *
 * The audit's finding was that the waterfall compares statement boundaries a person entered as
 * evidence, and cannot fetch a current balance. Fetching one is the easy half. The hard half is
 * what happens next, and this module is that half: **a provider reading is a second opinion,
 * never a boundary.**
 *
 * The distinction is not pedantry. ADR-0017 (cash balance) 17.6 makes a `verified` ₹0
 * unaccounted delta mean something precise — complete evidence, zero cash delta, zero
 * unexplained movements. A number fetched from an API at an unstated instant is not evidence of
 * what a statement said at a period boundary: the instant is usually wrong, the read may have
 * failed, the account may have moved since, and nobody looked at it. Letting one fill a
 * boundary would manufacture `verified` closures out of an HTTP call, which is exactly the
 * failure mode this system exists to refuse.
 *
 * So a reading gets three things and no more: a **timestamp of its own**, a **comparison** to
 * what the ledger already believes, and a **verdict about its own usability**. None of the
 * three can be written into a snapshot.
 */

import { DomainError } from './errors.js';
import type { Paise } from './money.js';

/**
 * How usable one reading is for the comparison a person is looking at.
 *
 * `unusable` covers the two cases that look like data and are not: a provider that answered
 * without a balance, and one that answered without saying when the balance was true. A figure
 * with no instant attached cannot be compared to a period end at all — the comparison would be
 * "this account held ₹X at some point", which is not a statement about anything.
 */
export type BalanceReadingUsability = 'fresh' | 'stale' | 'unusable';

export interface BalanceReadingFacts {
  readonly balance: Paise | null;
  /** When the provider says the balance was true. */
  readonly asOf: Date | null;
  /** When this process asked. Always known, and never a substitute for `asOf`. */
  readonly fetchedAt: Date;
  readonly status: 'ok' | 'unavailable';
}

/**
 * How far out of date a reading may be, relative to the instant it is compared against,
 * before it is called stale.
 *
 * Twenty-six hours rather than twenty-four: an overnight batch and a timezone offset should
 * not, between them, turn yesterday evening's balance into a warning. Anything beyond that
 * genuinely is a different day's number.
 */
export const BALANCE_READING_FRESHNESS_MS = 26 * 60 * 60 * 1000;

/**
 * Classifies one reading against the instant it is being compared to.
 *
 * A reading *after* the comparison instant is not fresh in the useful sense — it describes a
 * later state of the account — but it is not unusable either, and the caller needs to be able
 * to say which. It is reported as `stale`, with the direction visible in the two timestamps
 * the caller already has.
 */
export function classifyBalanceReading(
  facts: BalanceReadingFacts,
  comparedTo: Date,
): BalanceReadingUsability {
  if (facts.status !== 'ok' || facts.balance === null || facts.asOf === null) return 'unusable';
  const drift = Math.abs(comparedTo.getTime() - facts.asOf.getTime());
  return drift <= BALANCE_READING_FRESHNESS_MS ? 'fresh' : 'stale';
}

/** What a reading says about a figure the ledger arrived at on its own. */
export type BalanceComparisonVerdict =
  /** Both are known and identical. Agreement between two independent sources. */
  | 'agrees'
  /** Both are known and differ. A real signal, and never resolved in either direction here. */
  | 'differs'
  /** One side is unknown, so there is nothing to compare — never "agrees". */
  | 'not_comparable';

export interface BalanceComparison {
  readonly verdict: BalanceComparisonVerdict;
  /** `reading − ledger`, signed, when both are known. `null` otherwise — never zero. */
  readonly difference: Paise | null;
  readonly usability: BalanceReadingUsability;
  /** Why this comparison proves nothing, when it proves nothing. */
  readonly caveat?: string;
}

/**
 * Compares a reading to a figure the ledger derived, without deciding which is right.
 *
 * Two things this deliberately will not do. It will not report `agrees` when either side is
 * unknown — an absence is not agreement, which is ADR-0046's rule and the one the audit's
 * eighth dead end was about. And it will not treat a `stale` reading's equality as agreement
 * either: two numbers matching across a two-day gap is a coincidence about a quiet account,
 * not a confirmation.
 */
export function compareBalanceReading(
  facts: BalanceReadingFacts,
  ledgerFigure: Paise | null,
  comparedTo: Date,
): BalanceComparison {
  const usability = classifyBalanceReading(facts, comparedTo);

  if (usability === 'unusable') {
    return {
      verdict: 'not_comparable',
      difference: null,
      usability,
      caveat:
        facts.status !== 'ok'
          ? 'The provider could not state a balance for this account, so nothing was compared.'
          : facts.balance === null
            ? 'The provider answered without a balance. That is not a zero balance.'
            : 'The provider gave no instant for this balance, so there is nothing to compare it ' +
              'to a period end with.',
    };
  }

  if (ledgerFigure === null) {
    return {
      verdict: 'not_comparable',
      difference: null,
      usability,
      caveat:
        'This account has no evidenced closing balance for the period, so the provider reading ' +
        'has nothing to agree or disagree with. A reading is never that evidence (ADR-0054).',
    };
  }

  const difference = (facts.balance as Paise) - ledgerFigure;
  const base: BalanceComparison = {
    verdict: difference === 0n ? 'agrees' : 'differs',
    difference: difference as Paise,
    usability,
  };
  if (usability === 'stale') {
    return {
      ...base,
      caveat:
        'This reading is from outside the period being compared, so it describes a different ' +
        'moment in the account. Neither a match nor a mismatch here settles anything.',
    };
  }
  return base;
}

/**
 * The guard that keeps a reading out of a snapshot.
 *
 * Called wherever a boundary is about to be written, so the rule is enforced at the write
 * rather than trusted to every caller. There is no "force" parameter and there is no
 * configuration that turns it off: a boundary is a statement balance somebody evidenced, and a
 * provider reading is not one however convenient it would be (ADR-0017 (cash balance), 17.5).
 *
 * @throws DomainError `BALANCE_READING_NOT_EVIDENCE`
 */
export function assertBoundaryIsNotAProviderReading(source: {
  readonly kind: 'evidence' | 'provider_reading';
}): void {
  if (source.kind === 'provider_reading') {
    throw new DomainError(
      'BALANCE_READING_NOT_EVIDENCE',
      'A live balance reading cannot be used as a period boundary. A boundary is a statement ' +
        'balance somebody evidenced; a reading is what an API said at some instant, and ' +
        'treating one as the other would let an HTTP call produce a verified ₹0 delta ' +
        '(ADR-0017 (cash balance), 17.5–17.6).',
    );
  }
}

/**
 * What a set of readings says about its own completeness.
 *
 * Separate from any individual reading, because "we asked about five accounts and heard about
 * three" is a fact about the *read*, and the two accounts nobody heard about must not read as
 * accounts with nothing to report.
 */
export interface BalanceReadCompleteness {
  readonly requested: number;
  readonly answered: number;
  readonly complete: boolean;
  readonly incompleteReason?: string;
}

export function summarizeReadCompleteness(
  requestedRefs: readonly string[],
  answeredRefs: readonly string[],
  providerSaysComplete: boolean,
  providerReason?: string,
): BalanceReadCompleteness {
  const answered = new Set(answeredRefs);
  const missing = requestedRefs.filter((ref) => !answered.has(ref));
  const complete = providerSaysComplete && missing.length === 0;
  if (complete) {
    return { requested: requestedRefs.length, answered: answeredRefs.length, complete: true };
  }
  return {
    requested: requestedRefs.length,
    answered: answeredRefs.length,
    complete: false,
    incompleteReason:
      missing.length > 0
        ? `${missing.length} of ${requestedRefs.length} linked accounts were not answered. ` +
          'Their absence says nothing about their balances.'
        : (providerReason ??
          'The provider reported the read as incomplete without saying why. Nothing absent ' +
            'from it can be read as nothing to report.'),
  };
}
