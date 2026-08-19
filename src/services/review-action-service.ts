/**
 * The review actions a human takes on the queue, other than deciding an inference.
 *
 * ```
 * services.reclassifyPayment        ─▶ supersede the pending proposal ─▶ ask again
 * services.confirmPossibleDuplicate ─▶ payment → ignored (duplicate_of:<canonical>)
 * services.dismissPossibleDuplicate ─▶ an audited "these two are different"
 * ```
 *
 * `services.decideInference` deliberately does **not** live here: it was phase 8's, it is the
 * only path from an `AIInference` to authoritative state, and moving it would make it look
 * like one review action among several rather than the gate everything else routes around.
 *
 * Every action in this module requires an attributable human actor. `domain.parseDecisionActor`
 * rejects `ai` and `system`, so a scheduled job cannot quietly confirm a duplicate or ask for a
 * re-classification on nobody's behalf (`invariants.md` #17).
 */

import {
  assertPaymentTransition,
  duplicateOfReason,
  isPossibleDuplicate,
  parseDecisionActor,
  parseDuplicateOfReason,
  possibleDuplicateKey,
} from '../domain/index.js';
import type { AiInferenceId, Paise, PaymentId } from '../domain/index.js';
import type { AiService } from '../ai/index.js';
import {
  findClassificationInferenceByPayment,
  getPaymentById,
  updatePaymentState,
} from '../db/index.js';
import type { AiInferenceRow, Database, Executor, PaymentRow } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { proposeClassification } from './classification-service.js';
import type { ClassificationOutcome } from './classification-service.js';
import { ServiceError } from './errors.js';
import { requirePayment } from './loaders.js';

/* -------------------------------------------------------------------- reclassification */

export interface ReclassifyPaymentInput {
  readonly paymentId: PaymentId;
  readonly ai: AiService;
  readonly materialityThreshold?: Paise;
  /** `actor` must be a person (`user`, `user:<id>`) or a `Rule` (`rule:<id>`). */
  readonly audit: AuditMeta;
}

export interface ReclassifyPaymentResult {
  /** The proposal this replaced, or `null` when the previous one was already decided. */
  readonly supersededInferenceId: AiInferenceId | null;
  readonly outcome: ClassificationOutcome;
}

/**
 * Asks the model again about a payment somebody has already been asked about.
 *
 * This is the **only** thing that lifts the idempotency rule. `classifyPayments` skips a
 * payment that already carries a classification inference (`already_classified`), which is what
 * makes a re-run a no-op — and re-classification has to be an explicit human act rather than
 * something a scheduled job does silently (ADR-0030).
 *
 * The old proposal and the new one move in **one transaction**: superseding first and asking
 * afterwards would leave a payment with a proposal marked `superseded` and nothing to replace
 * it if the model never answered — a state the queue shows as nothing at all.
 *
 * @throws DomainError `DECISION_ACTOR_INVALID` when nobody accountable is named.
 * @throws ServiceError `PRECONDITION_FAILED` when there is nothing to reconsider, or when the
 *   payment is already explained by an accepted decision.
 */
export async function reclassifyPayment(
  db: Database,
  input: ReclassifyPaymentInput,
): Promise<ReclassifyPaymentResult> {
  parseDecisionActor(input.audit.actor);

  const payment = await requirePayment(db, input.paymentId);
  if (payment.state !== 'normalized') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Payment ${payment.id} is "${payment.state}". Re-classification acts on a normalized ` +
        'payment: an explained one would have to be un-explained first, and an ignored one is ' +
        'out of the ledger’s concern.',
      { paymentId: payment.id, state: payment.state },
    );
  }

  const previous = await findClassificationInferenceByPayment(db, payment.id);
  if (previous === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Payment ${payment.id} has never been classified, so there is nothing to reconsider. ` +
        'Run classification for it instead (services.classifyPayments).',
      { paymentId: payment.id },
    );
  }
  if (previous.status === 'accepted' || previous.status === 'modified') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Payment ${payment.id} is already explained by an accepted classification ` +
        `(AIInference ${previous.id}). Unwinding an approved Expense or a Settlement is not a ` +
        'review action this phase offers.',
      { paymentId: payment.id, inferenceId: previous.id, status: previous.status },
    );
  }

  // A `rejected` proposal is not superseded: it was decided, and rejecting is a decision the
  // trail keeps. Only an undecided one is replaced.
  const supersede = previous.status === 'pending' ? previous : null;

  const outcome = await proposeClassification(db, {
    payment,
    ai: input.ai,
    audit: input.audit,
    ...(input.materialityThreshold === undefined
      ? {}
      : { materialityThreshold: input.materialityThreshold }),
    ...(supersede === null ? {} : { supersede }),
  });

  return { supersededInferenceId: supersede?.id ?? null, outcome };
}

/* ------------------------------------------------------------------ possible duplicates */

export interface PossibleDuplicateDecisionInput {
  /** The payment being judged — the copy that would be discarded if confirmed. */
  readonly paymentId: PaymentId;
  /** The payment it may duplicate. */
  readonly duplicateOfPaymentId: PaymentId;
  readonly audit: AuditMeta;
  /** Widens the window the pair is checked against, matching the queue's own option. */
  readonly windowSeconds?: number;
}

export interface ConfirmDuplicateResult {
  readonly paymentId: PaymentId;
  /** The head of the `duplicate_of` chain, which is what gets recorded (`invariants.md` #10). */
  readonly canonicalPaymentId: PaymentId;
  readonly pairKey: string;
}

const DEFAULT_REVIEW_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Confirms that a payment restates one the ledger already has.
 *
 * A human decision, not a rule: the deterministic path (ADR-0019) already discarded everything
 * a shared `external_reference` proves, and what is left here is a resemblance. So the pair is
 * re-checked against `domain.isPossibleDuplicate` — if it is not even a *candidate*, this is
 * refused rather than trusted, because "the reviewer said so" is not evidence that two
 * unrelated payments are the same money.
 *
 * The recorded `duplicate_of` names the **canonical** payment — the head of the chain — never
 * another ignored copy, so one hop always reaches the row that counts.
 */
export async function confirmPossibleDuplicate(
  db: Database,
  input: PossibleDuplicateDecisionInput,
): Promise<ConfirmDuplicateResult> {
  parseDecisionActor(input.audit.actor);
  const { payment, other } = await requirePair(db, input);

  const windowSeconds = input.windowSeconds ?? DEFAULT_REVIEW_WINDOW_SECONDS;
  if (!isPossibleDuplicate(asCandidate(payment), asCandidate(other), { windowSeconds })) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Payments ${payment.id} and ${other.id} are not a possible-duplicate pair: they differ ` +
        'in direction, amount, or timing beyond the review window, or a matching reference ' +
        'already made the answer deterministic (invariants.md #10).',
      { paymentId: payment.id, duplicateOfPaymentId: other.id },
    );
  }

  const canonicalPaymentId = await resolveCanonicalPayment(db, other);
  if (canonicalPaymentId === payment.id) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Payment ${payment.id} would be recorded as a duplicate of itself: ${other.id} already ` +
        'names it as its canonical payment.',
      { paymentId: payment.id, duplicateOfPaymentId: other.id },
    );
  }

  const pairKey = possibleDuplicateKey(payment.id, other.id);
  await runAudited(db, input.audit, async ({ exec, record }) => {
    const reason = duplicateOfReason(canonicalPaymentId);
    assertPaymentTransition(payment.state, 'ignored');
    await updatePaymentState(exec, payment.id, 'ignored', reason);
    await record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: { state: payment.state, ignoredReason: payment.ignoredReason },
      newValue: {
        state: 'ignored',
        ignoredReason: reason,
        possibleDuplicateDecision: 'confirmed',
        possibleDuplicatePairKey: pairKey,
        duplicateOfPaymentId: canonicalPaymentId,
      },
      reason:
        `Confirmed in review by ${input.audit.actor} as a restatement of ` +
        `${canonicalPaymentId}. The row is kept — the ledger did receive this evidence twice ` +
        '— and carries the reason it does not count (invariants.md #10).',
    });
  });

  return { paymentId: payment.id, canonicalPaymentId, pairKey };
}

export interface DismissDuplicateResult {
  readonly pairKey: string;
}

/**
 * Records that two lookalike payments are genuinely different.
 *
 * Nothing about either payment changes — they are both real, and both still count. What is
 * recorded is the *decision*, as an `AuditEvent`, which is also how the queue stops offering
 * the pair (ADR-0031). Without it a queue containing one unresolvable resemblance could never
 * be emptied, and a queue nobody can empty is one nobody reads.
 */
export async function dismissPossibleDuplicate(
  db: Database,
  input: PossibleDuplicateDecisionInput,
): Promise<DismissDuplicateResult> {
  parseDecisionActor(input.audit.actor);
  const { payment, other } = await requirePair(db, input);
  const pairKey = possibleDuplicateKey(payment.id, other.id);

  await runAudited(db, input.audit, async ({ record }) => {
    await record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: { state: payment.state },
      // Deliberately no state change: both payments stay exactly as they were. The event is
      // the whole point — it is the decision, and the queue reads it back.
      newValue: {
        state: payment.state,
        possibleDuplicateDecision: 'dismissed',
        possibleDuplicatePairKey: pairKey,
        otherPaymentId: other.id,
      },
      reason:
        `Dismissed in review by ${input.audit.actor}: ${payment.id} and ${other.id} resemble ` +
        'each other but are different transactions. Both continue to count.',
    });
  });

  return { pairKey };
}

/* ------------------------------------------------------------------------- internals */

async function requirePair(
  exec: Executor,
  input: PossibleDuplicateDecisionInput,
): Promise<{ payment: PaymentRow; other: PaymentRow }> {
  if (input.paymentId === input.duplicateOfPaymentId) {
    throw new ServiceError('PRECONDITION_FAILED', 'A payment cannot be a duplicate of itself.', {
      paymentId: input.paymentId,
    });
  }
  const payment = await requirePayment(exec, input.paymentId);
  const other = await requirePayment(exec, input.duplicateOfPaymentId);
  return { payment, other };
}

function asCandidate(payment: PaymentRow) {
  return {
    amount: payment.amount,
    occurredAt: payment.occurredAt,
    externalReference: payment.externalReference,
    direction: payment.direction,
  };
}

/**
 * Walks a payment back to the head of its `duplicate_of` chain.
 *
 * The importer does this within one reference's candidate set, which it already has in memory
 * (`invariants.md` #10). A possible duplicate shares no reference by definition, so the chain
 * is walked by id instead — bounded by a `seen` set, so stored data that loops cannot hang the
 * request.
 */
async function resolveCanonicalPayment(exec: Executor, from: PaymentRow): Promise<PaymentId> {
  const seen = new Set<string>([from.id]);
  let current = from;

  while (current.state === 'ignored') {
    const parentId = parseDuplicateOfReason(current.ignoredReason);
    if (parentId === null || seen.has(parentId)) break;
    const parent = await getPaymentById(exec, parentId as PaymentId);
    if (parent === null) break;
    seen.add(parentId);
    current = parent;
  }
  return current.id;
}

/** Re-exported so a caller can name an inference row without reaching into `src/db`. */
export type { AiInferenceRow };
