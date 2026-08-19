/**
 * The review queue — "what financial decisions are waiting for a human?" (`data-flow.md`
 * step 5).
 *
 * ```
 * services.listReviewQueue ─▶ db.listPendingClassificationInferences
 *                          ─▶ db.listRejectedClassifications
 *                          ─▶ db.listPossibleDuplicateCandidates + domain.isPossibleDuplicate
 *                          ─▶ domain.routeClassificationForReview  (the "why")
 *                          ─▶ domain.prioritiseReviewQueue         (the order)
 * ```
 *
 * A read, and only a read: it writes nothing, decides nothing, and holds no ranking of its own
 * — the order comes from `domain.prioritiseReviewQueue` and the reasons from phase 8's
 * routing, so the queue cannot disagree with the states it is describing (ADR-0029).
 *
 * Every item carries enough for a surface to explain itself without asking a second question:
 * the proposal, its confidence, what it is about, and every reason it is here.
 */

import {
  classificationReviewReasons,
  isPossibleDuplicate,
  possibleDuplicateKey,
  prioritiseReviewQueue,
  routeClassificationForReview,
} from '../domain/index.js';
import type {
  AiInferenceId,
  ConfidenceLevel,
  ExpenseId,
  ExpenseState,
  Paise,
  PaymentId,
  ProposedKind,
  ReviewItemKind,
  ReviewReason,
} from '../domain/index.js';
import { isAiContractError, parseTransactionClassification } from '../ai/index.js';
import type { TransactionClassification } from '../ai/index.js';
import {
  listDismissedDuplicatePairs,
  listPendingClassificationInferences,
  listPossibleDuplicateCandidates,
  listRejectedClassifications,
} from '../db/index.js';
import type { Executor, PaymentRow, PendingClassificationRow } from '../db/index.js';

/* --------------------------------------------------------------------------- options */

export interface ReviewQueueOptions {
  /** Applied **after** ordering, so the most important items are the ones kept. */
  readonly limit?: number;
  /** Restrict to some kinds. Omitted means all of them. */
  readonly kinds?: readonly ReviewItemKind[];
  /** Overrides `domain.DEFAULT_MATERIALITY_THRESHOLD_PAISE` when re-deriving the "why". */
  readonly materialityThreshold?: Paise;
  /**
   * How far apart two payments may be captured and still be offered as a possible duplicate.
   *
   * Defaults to 24 hours rather than `isPossibleDuplicate`'s own 60 seconds, for the reason
   * the importer widened its window: a bank statement carries a *date*, so two captures of one
   * transaction are the same calendar day rather than seconds apart, and a minute-wide window
   * would surface nothing at all from that source.
   */
  readonly duplicateWindowSeconds?: number;
}

const DEFAULT_DUPLICATE_WINDOW_SECONDS = 24 * 60 * 60;

/* ----------------------------------------------------------------------------- items */

/** The payment a review item is about, as a surface needs to show it. */
export interface ReviewPaymentView {
  readonly paymentId: PaymentId;
  readonly amount: Paise;
  readonly currency: string;
  readonly direction: 'debit' | 'credit';
  readonly occurredAt: Date;
  readonly description: string;
  readonly counterpartyType: string;
  readonly state: string;
}

/** The DERIVED expense behind an expense-kind proposal. Null for a settlement proposal. */
export interface ReviewExpenseView {
  readonly expenseId: ExpenseId;
  readonly state: ExpenseState;
  readonly description: string | null;
  readonly relationshipType: string;
  readonly category: string | null;
}

export interface ClassificationDecisionItem {
  readonly kind: 'classification_decision';
  /** The inference id — this item *is* one pending decision. */
  readonly id: string;
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly reasons: readonly ReviewReason[];
  readonly inferenceId: AiInferenceId;
  readonly confidence: ConfidenceLevel;
  readonly proposedAt: Date;
  /** `null` when the stored proposal no longer parses — see `malformed_proposal`. */
  readonly proposedKind: ProposedKind | null;
  readonly proposal: TransactionClassification | null;
  readonly model: {
    readonly provider: string | null;
    readonly name: string | null;
    readonly promptVersion: string | null;
  };
  readonly payment: ReviewPaymentView;
  readonly expense: ReviewExpenseView | null;
}

export interface PossibleDuplicateItem {
  readonly kind: 'possible_duplicate';
  /** The order-independent pair key, so one pair is one item however it was discovered. */
  readonly id: string;
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly reasons: readonly ReviewReason[];
  /** The later of the two — the one a reviewer would normally discard. */
  readonly payment: ReviewPaymentView;
  /** The earlier of the two — the one that would survive. */
  readonly candidate: ReviewPaymentView;
}

export interface RejectedClassificationItem {
  readonly kind: 'rejected_classification';
  /** The payment id — one item per unexplained payment, not per declined proposal. */
  readonly id: string;
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly reasons: readonly ReviewReason[];
  readonly payment: ReviewPaymentView;
  readonly inferenceId: AiInferenceId;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  /** The expense the declined proposal produced, now `rejected` (ADR-0028). */
  readonly expenseId: ExpenseId | null;
  readonly expenseState: ExpenseState | null;
}

export type ReviewQueueItem =
  ClassificationDecisionItem | PossibleDuplicateItem | RejectedClassificationItem;

export interface ReviewQueueResult {
  /** Ordered by `domain.prioritiseReviewQueue`; the limit is applied after ordering. */
  readonly items: readonly ReviewQueueItem[];
  /** How many items exist per kind **before** any limit — a UI's badge counts. */
  readonly counts: Readonly<Record<ReviewItemKind, number>>;
  readonly total: number;
  readonly truncated: boolean;
}

/* --------------------------------------------------------------------------- service */

/**
 * Everything currently waiting for a human, in the order it should be looked at.
 *
 * Reads only. Two calls against an unchanged ledger return identical results, including
 * order — which is what makes this safe for a surface to poll.
 */
export async function listReviewQueue(
  exec: Executor,
  options: ReviewQueueOptions = {},
): Promise<ReviewQueueResult> {
  const wanted = (kind: ReviewItemKind): boolean =>
    options.kinds === undefined || options.kinds.includes(kind);

  const items: ReviewQueueItem[] = [];
  if (wanted('classification_decision')) {
    items.push(...(await classificationItems(exec, options)));
  }
  if (wanted('possible_duplicate')) {
    items.push(...(await possibleDuplicateItems(exec, options)));
  }
  if (wanted('rejected_classification')) {
    items.push(...(await rejectedClassificationItems(exec)));
  }

  const ordered = prioritiseReviewQueue(items);
  const counts: Record<ReviewItemKind, number> = {
    classification_decision: 0,
    possible_duplicate: 0,
    rejected_classification: 0,
  };
  for (const item of ordered) counts[item.kind] += 1;

  const limited =
    options.limit === undefined ? ordered : ordered.slice(0, Math.max(0, options.limit));
  return {
    items: limited,
    counts,
    total: ordered.length,
    truncated: limited.length < ordered.length,
  };
}

/* ------------------------------------------------------------------------- internals */

async function classificationItems(
  exec: Executor,
  options: ReviewQueueOptions,
): Promise<ClassificationDecisionItem[]> {
  const rows = await listPendingClassificationInferences(exec);
  return rows.map((row) => toClassificationItem(row, options));
}

function toClassificationItem(
  row: PendingClassificationRow,
  options: ReviewQueueOptions,
): ClassificationDecisionItem {
  const proposal = parseStoredProposal(row.proposedOutput);
  const confidence = row.confidence as ConfidenceLevel;

  // A stored proposal that no longer parses is itself something a human must look at. It is
  // reported rather than thrown, because one unreadable row must not take the whole queue
  // down with it — and rejecting it is exactly the action the queue exists to offer.
  const reasons: readonly ReviewReason[] =
    proposal === null
      ? ['malformed_proposal']
      : classificationReviewReasons(
          routeClassificationForReview({
            confidence,
            amount: row.paymentAmount,
            proposedKind: proposal.proposedKind,
            ...(options.materialityThreshold === undefined
              ? {}
              : { materialityThreshold: options.materialityThreshold }),
          }),
        );

  return {
    kind: 'classification_decision',
    id: row.inferenceId,
    amount: row.paymentAmount,
    occurredAt: row.paymentOccurredAt,
    reasons,
    inferenceId: row.inferenceId,
    confidence,
    proposedAt: row.proposedAt,
    proposedKind: proposal?.proposedKind ?? null,
    proposal,
    model: {
      provider: row.modelProvider,
      name: row.modelName,
      promptVersion: row.promptVersion,
    },
    payment: {
      paymentId: row.paymentId,
      amount: row.paymentAmount,
      currency: row.paymentCurrency,
      direction: row.paymentDirection,
      occurredAt: row.paymentOccurredAt,
      description: row.paymentDescription,
      counterpartyType: row.paymentCounterpartyType,
      state: row.paymentState,
    },
    expense:
      row.expenseId === null || row.expenseState === null || row.expenseRelationshipType === null
        ? null
        : {
            expenseId: row.expenseId,
            state: row.expenseState,
            description: row.expenseDescription,
            relationshipType: row.expenseRelationshipType,
            category: row.expenseCategory,
          },
  };
}

/**
 * Re-validates a stored proposal on the way out of the database.
 *
 * It passed gate 1 on the way in (`ai-boundary.md`), and it is re-parsed again before it can
 * produce anything (`services.decideInference`). Parsing here too costs nothing and keeps one
 * rule true everywhere: a proposal is untrusted input at every boundary it crosses, including
 * a JSONB round trip.
 */
function parseStoredProposal(proposedOutput: unknown): TransactionClassification | null {
  try {
    return parseTransactionClassification(proposedOutput);
  } catch (error) {
    if (isAiContractError(error)) return null;
    throw error;
  }
}

async function possibleDuplicateItems(
  exec: Executor,
  options: ReviewQueueOptions,
): Promise<PossibleDuplicateItem[]> {
  const candidates = await listPossibleDuplicateCandidates(exec);
  if (candidates.length < 2) return [];

  const dismissed = new Set(await listDismissedDuplicatePairs(exec));
  const windowSeconds = options.duplicateWindowSeconds ?? DEFAULT_DUPLICATE_WINDOW_SECONDS;
  const items: PossibleDuplicateItem[] = [];

  // The candidate set is already narrowed to payments sharing an amount and a direction with
  // at least one other, so this pairs a handful of rows, not the ledger. The rule itself stays
  // in `domain` — this loop decides nothing.
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const earlier = candidates[i]!;
      const later = candidates[j]!;
      if (!isPossibleDuplicate(asCandidate(earlier), asCandidate(later), { windowSeconds })) {
        continue;
      }
      const id = possibleDuplicateKey(earlier.id, later.id);
      if (dismissed.has(id)) continue;
      items.push({
        kind: 'possible_duplicate',
        id,
        amount: later.amount,
        // The pair is as old as its earlier leg — that is when the money moved.
        occurredAt: earlier.occurredAt,
        reasons: ['possible_duplicate'],
        payment: toPaymentView(later),
        candidate: toPaymentView(earlier),
      });
    }
  }
  return items;
}

function asCandidate(payment: PaymentRow) {
  return {
    amount: payment.amount,
    occurredAt: payment.occurredAt,
    externalReference: payment.externalReference,
    direction: payment.direction,
  };
}

async function rejectedClassificationItems(exec: Executor): Promise<RejectedClassificationItem[]> {
  const rows = await listRejectedClassifications(exec);
  return rows.map((row) => ({
    kind: 'rejected_classification' as const,
    id: row.paymentId,
    amount: row.amount,
    occurredAt: row.occurredAt,
    reasons: ['payment_unexplained' as const],
    payment: {
      paymentId: row.paymentId,
      amount: row.amount,
      currency: row.currency,
      // A rejected classification only ever follows a debit — the AI leg classifies nothing
      // else (ADR-0027) — but the view carries what the row says rather than assuming it.
      direction: 'debit' as const,
      occurredAt: row.occurredAt,
      description: row.rawDescription,
      counterpartyType: row.counterpartyType,
      state: 'normalized',
    },
    inferenceId: row.inferenceId,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    expenseId: row.expenseId,
    expenseState: row.expenseState,
  }));
}

function toPaymentView(payment: PaymentRow): ReviewPaymentView {
  return {
    paymentId: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    direction: payment.direction,
    occurredAt: payment.occurredAt,
    description: payment.rawDescription,
    counterpartyType: payment.counterpartyType,
    state: payment.state,
  };
}
