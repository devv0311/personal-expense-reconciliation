/**
 * Classification rules (`data-flow.md` step 3) — the deterministic half.
 *
 * Everything here is a rule about *whether* and *how* a payment may be classified, never a
 * judgement about what it means. The judgement is `ai.classifyTransaction`'s, and it arrives
 * as a proposal that these rules then route (`ai-boundary.md`).
 *
 * Pure: values in, values out. No I/O, no database, no clock, no AI.
 */

import { isNonSpendCounterparty } from './enums.js';
import type {
  ConfidenceLevel,
  PaymentCounterpartyType,
  PaymentDirection,
  PaymentState,
  ProposedKind,
} from './enums.js';
import { DomainError } from './errors.js';
import type { Paise } from './money.js';

/* ---------------------------------------------------------------------- eligibility */

/** Why a payment is not (fully) classifiable right now. */
export type ClassificationSkipReason =
  /** Classification acts on `normalized` payments only — the ADR-0021 idempotency pattern. */
  | 'not_normalized'
  /** A `classify_transaction` inference already exists for it; a re-run must not add a second. */
  | 'already_classified'
  /** Already known to be a transfer or an investment, so there is nothing left to decide (#7). */
  | 'non_spend_counterparty'
  /** A credit is never new spend; V1 does not classify inflow (ADR-0015, ADR-0027). */
  | 'credit_out_of_scope';

export interface ClassificationEligibilityInput {
  readonly state: PaymentState;
  readonly counterpartyType: PaymentCounterpartyType;
  readonly direction: PaymentDirection;
  /** Whether any `classify_transaction` `AIInference` already references this payment. */
  readonly hasClassificationInference: boolean;
}

/**
 * Three outcomes, not two — a credit is not simply ineligible.
 *
 * `deterministic_only` is the credit case: it takes no AI proposal, but it is still read by
 * the self-transfer pairing rule, which needs *both* legs of a transfer and so cannot be
 * restricted to debits (ADR-0023, ADR-0027).
 */
export type ClassificationEligibility =
  | { readonly outcome: 'eligible' }
  | { readonly outcome: 'deterministic_only'; readonly reason: ClassificationSkipReason }
  | { readonly outcome: 'skipped'; readonly reason: ClassificationSkipReason };

/**
 * Whether this payment may be classified, and by which leg.
 *
 * Order matters and is deliberate: state first (nothing about an unnormalized or already
 * explained payment is decidable), then the classifications that are already settled, then
 * the existing-proposal check, then direction.
 */
export function classificationEligibility(
  input: ClassificationEligibilityInput,
): ClassificationEligibility {
  if (input.state !== 'normalized') return { outcome: 'skipped', reason: 'not_normalized' };
  if (isNonSpendCounterparty(input.counterpartyType)) {
    return { outcome: 'skipped', reason: 'non_spend_counterparty' };
  }
  if (input.hasClassificationInference) {
    return { outcome: 'skipped', reason: 'already_classified' };
  }
  if (input.direction === 'credit') {
    return { outcome: 'deterministic_only', reason: 'credit_out_of_scope' };
  }
  return { outcome: 'eligible' };
}

/* ----------------------------------------------------------------- self-transfer pair */

/** The fields the self-transfer rule reads. A subset of a payment row, nothing derived. */
export interface TransferLeg {
  readonly paymentId: string;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  readonly externalReference: string | null;
  readonly state: PaymentState;
}

export interface SelfTransferMatchOptions {
  /** Tolerated clock skew between the two legs as captured. Default 60 seconds. */
  readonly windowSeconds?: number;
}

const DEFAULT_TRANSFER_WINDOW_SECONDS = 60;

/**
 * Whether two payments are the two legs of one transfer between the user's own accounts.
 *
 * Every `Payment` moves through an account the user owns (`domain-model.md`), so a debit and
 * a credit that share one bank reference, one amount and one instant are the same money
 * leaving one of the user's accounts and arriving in another. That is evidence, not
 * interpretation — which is why this is deterministic code and `proposedKind` has no
 * `transfer` member to propose (ADR-0023).
 *
 * Read alongside {@link isDeterministicDuplicate}, which requires the *same* direction: the
 * two rules are deliberate mirror images, and ADR-0019 made direction load-bearing precisely
 * because a transfer's legs otherwise collapse into a false duplicate.
 *
 * An `ignored` leg proves nothing — it is a row the ledger has already discarded — so a pair
 * involving one is not a match.
 */
export function isSelfTransferPair(
  a: TransferLeg,
  b: TransferLeg,
  options: SelfTransferMatchOptions = {},
): boolean {
  if (a.paymentId === b.paymentId) return false;
  if (a.state === 'ignored' || b.state === 'ignored') return false;
  if (a.externalReference === null || b.externalReference === null) return false;
  if (a.externalReference !== b.externalReference) return false;
  if (a.amount !== b.amount) return false;
  // Opposite directions: money left one account and arrived in another.
  if (a.direction === b.direction) return false;
  const windowSeconds = options.windowSeconds ?? DEFAULT_TRANSFER_WINDOW_SECONDS;
  const deltaMs = Math.abs(a.occurredAt.getTime() - b.occurredAt.getTime());
  return deltaMs <= windowSeconds * 1000;
}

/** The counter-leg proving `leg` is a self-transfer, if the candidate set contains one. */
export function findSelfTransferCounterLeg(
  leg: TransferLeg,
  candidates: readonly TransferLeg[],
  options: SelfTransferMatchOptions = {},
): TransferLeg | null {
  return candidates.find((candidate) => isSelfTransferPair(leg, candidate, options)) ?? null;
}

/* --------------------------------------------------------------------- review routing */

/**
 * The amount at or above which a classification is reviewed regardless of confidence
 * (`lifecycle.md`, REVIEW_REQUIRED: "the amount is above a materiality threshold").
 *
 * ₹5,000. A policy default, not a domain truth — every caller may override it, and the
 * number is expected to move as the ledger's real distribution of amounts becomes visible.
 */
export const DEFAULT_MATERIALITY_THRESHOLD_PAISE = 500_000n as Paise;

/** Why a proposal must be reviewed by a human before it can produce authoritative state. */
export type ClassificationReviewReason =
  /** Anything short of `high` — `unknown` means the model declined to guess. */
  | 'low_confidence'
  /** At or above the materiality threshold, however confident the model is. */
  | 'material_amount'
  /** A settlement is created directly as APPROVED, so it never auto-progresses (ADR-0026). */
  | 'settlement_kind';

export interface ReviewRoutingInput {
  readonly confidence: ConfidenceLevel;
  /** The payment's amount — what is at stake if the proposal is wrong. */
  readonly amount: Paise;
  readonly proposedKind: ProposedKind;
  readonly materialityThreshold?: Paise;
}

export interface ReviewRoute {
  readonly requiresReview: boolean;
  /** Every reason that applies, in a stable order — not just the first one found. */
  readonly reasons: readonly ClassificationReviewReason[];
}

/**
 * Routes a validated proposal to `CLASSIFIED` or `REVIEW_REQUIRED`.
 *
 * Confidence changes **friction**, never the requirement for approval (`invariants.md` #16):
 * a `high`-confidence, immaterial expense proposal ends at `CLASSIFIED`, which still requires
 * an explicit `decideInference` before it becomes APPROVED. Nothing here auto-approves,
 * because the only mechanism invariant #16 permits for that is a matched `Rule`, and `Rule`
 * is phase 16 (ADR-0024).
 */
export function routeClassificationForReview(input: ReviewRoutingInput): ReviewRoute {
  const threshold = input.materialityThreshold ?? DEFAULT_MATERIALITY_THRESHOLD_PAISE;
  const reasons: ClassificationReviewReason[] = [];
  if (input.confidence !== 'high') reasons.push('low_confidence');
  if (input.amount >= threshold) reasons.push('material_amount');
  if (input.proposedKind === 'settlement') reasons.push('settlement_kind');
  return { requiresReview: reasons.length > 0, reasons };
}

/* -------------------------------------------------------------------- decision actor */

/**
 * Who decided an `AIInference` — a person, or a `Rule` the person previously approved.
 *
 * There is no third member on purpose. `ai` is not an actor (`ai-boundary.md`: an
 * `AIInference` being accepted "always has a human or a human-approved `Rule` behind the
 * transition"), and `system` is not either — a decision no one is accountable for is exactly
 * what invariant #17 exists to make impossible.
 */
export type DecisionActor =
  | { readonly kind: 'user'; readonly actor: string }
  | { readonly kind: 'rule'; readonly ruleId: string; readonly actor: string };

const RULE_ACTOR_PREFIX = 'rule:';

/**
 * Parses an audit actor string for an inference decision, rejecting anything unattributable.
 *
 * Accepts `user`, `user:<id>`, and `rule:<rule_id>` — the forms `services/audit.ts` already
 * documents. Everything else fails loudly, so `system` or `ai` slipping into an `AuditMeta`
 * cannot silently become the author of a financial decision.
 */
export function parseDecisionActor(actor: string): DecisionActor {
  if (actor === 'user' || actor.startsWith('user:')) return { kind: 'user', actor };
  if (actor.startsWith(RULE_ACTOR_PREFIX)) {
    const ruleId = actor.slice(RULE_ACTOR_PREFIX.length);
    if (ruleId.length > 0) return { kind: 'rule', ruleId, actor };
  }
  throw new DomainError(
    'DECISION_ACTOR_INVALID',
    `"${actor}" cannot decide an AIInference. A decision is always attributable to a person ` +
      `("user" / "user:<id>") or to a previously-approved Rule ("rule:<rule_id>") — never to ` +
      'the model itself and never to the system (invariants.md #15, #17).',
    { actor },
  );
}
