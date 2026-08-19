/**
 * The review queue's ordering and its "why" (`data-flow.md` step 5, phase 9).
 *
 * Everything here is pure. The queue's *content* is a set of database reads
 * (`services.listReviewQueue`); what this module owns is the part that must not vary between
 * two reads of the same ledger — which item comes first, and what a UI is told about why each
 * one is waiting.
 *
 * Two properties are load-bearing:
 *
 *  - **Total order.** The comparison chain ends in the item's id, so no two entries can tie.
 *    A queue whose order depends on which row the database happened to return first is a
 *    queue that reorders itself under the reviewer, and this repository has already shipped
 *    that defect once (the audit-ordering fix in ADR-0018's wake).
 *  - **Every reason, not the first one.** `domain.routeClassificationForReview` already returns
 *    all of them; this module carries them through rather than collapsing them to a label, so
 *    the surface can explain itself completely.
 */

import type { Paise } from './money.js';
import type { ClassificationReviewReason, ReviewRoute } from './classification.js';

/* ------------------------------------------------------------------------------ kinds */

/**
 * What a queue entry is asking a human to do.
 *
 * Three kinds, and the split is by *decision*, not by entity: a pending classification is one
 * decision whether or not it has an `Expense` behind it (a settlement proposal has none —
 * ADR-0026), and a possible duplicate is a decision about two payments at once.
 */
export const REVIEW_ITEM_KINDS = [
  'classification_decision',
  'possible_duplicate',
  'rejected_classification',
] as const;
export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];

/** Why an item is in the queue. The classification reasons are phase 8's, unchanged. */
export type ReviewReason =
  | ClassificationReviewReason
  /** A pending proposal routing said needed no review — it still needs a decision (#16). */
  | 'decision_required'
  /** Two live payments that resemble each other without conclusive evidence (#10). */
  | 'possible_duplicate'
  /**
   * A stored proposal no longer parses.
   *
   * Unreachable through any write path — gate 1 validates before an `AIInference` exists — and
   * surfaced rather than thrown because one unreadable row must not take the whole queue down,
   * and rejecting it is exactly the action the queue offers.
   */
  | 'malformed_proposal'
  /** The proposal was declined, so this payment is money with no explanation. */
  | 'payment_unexplained';

/* --------------------------------------------------------------------------- ordering */

/**
 * The rank each kind sorts into, lowest first.
 *
 * The order is an argument, so it is written down rather than left in a comparator:
 *
 *  1. **`possible_duplicate`** — until it is resolved the ledger may be counting one
 *     transaction twice, and *every* downstream number is computed from those rows. It is also
 *     the cheapest decision to make (two rows, one question), so leaving it below slower work
 *     would be strictly worse.
 *  2. **`classification_decision` that routing flagged** — low confidence, a material amount,
 *     or a settlement, per `routeClassificationForReview` (ADR-0024).
 *  3. **`classification_decision` that routing did not flag** — a high-confidence, immaterial
 *     proposal. It still needs a decision, because nothing auto-approves; it just needs less
 *     of the reviewer's attention, which is exactly what "confidence changes friction" means.
 *  4. **`rejected_classification`** — a payment left unexplained by a decision already made.
 *     Nothing is wrong and nothing is at risk; it is unfinished rather than pending.
 */
export const REVIEW_RANKS = {
  possible_duplicate: 0,
  classification_flagged: 1,
  classification_routine: 2,
  rejected_classification: 3,
} as const;

/** The minimum a queue entry must carry to be ordered. Callers may carry much more. */
export interface ReviewQueueEntry {
  readonly kind: ReviewItemKind;
  /** Stable, unique identity — the inference id, or the two payment ids of a pair. */
  readonly id: string;
  /** What is at stake. Ordering only; no arithmetic is done on it here. */
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly reasons: readonly ReviewReason[];
}

/** The rank for one entry, including the flagged/routine split inside a classification. */
export function reviewRank(entry: ReviewQueueEntry): number {
  if (entry.kind === 'possible_duplicate') return REVIEW_RANKS.possible_duplicate;
  if (entry.kind === 'rejected_classification') return REVIEW_RANKS.rejected_classification;
  return entry.reasons.some((reason) => reason !== 'decision_required')
    ? REVIEW_RANKS.classification_flagged
    : REVIEW_RANKS.classification_routine;
}

/**
 * Orders a queue deterministically: rank, then amount descending, then oldest first, then id.
 *
 * Amount before age is deliberate — a ₹40,000 proposal from yesterday deserves attention
 * before a ₹120 one from last month — and age before id keeps the ordering meaningful rather
 * than merely stable. The id is the tie-break of last resort, present so that two entries can
 * never compare equal: without it, two identical-looking items would be ordered by whatever
 * the database returned first, which is not an order at all.
 *
 * Returns a new array; the input is not mutated.
 */
export function prioritiseReviewQueue<T extends ReviewQueueEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    const byRank = reviewRank(a) - reviewRank(b);
    if (byRank !== 0) return byRank;
    if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
    const byAge = a.occurredAt.getTime() - b.occurredAt.getTime();
    if (byAge !== 0) return byAge;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ---------------------------------------------------------------------------- reasons */

/**
 * The reasons a pending classification proposal is in the queue.
 *
 * Reuses phase 8's routing rather than re-deriving it, so the queue's explanation and the
 * expense's actual state cannot disagree. A proposal routing did not flag still appears —
 * `decision_required` is the honest reason, and omitting it would hide a decision nobody has
 * made (`invariants.md` #16).
 */
export function classificationReviewReasons(route: ReviewRoute): readonly ReviewReason[] {
  return route.reasons.length > 0 ? route.reasons : ['decision_required'];
}

/**
 * The stable identity of a possible-duplicate pair.
 *
 * Order-independent: the same two payments produce the same key whichever way round they are
 * discovered, so a pair cannot appear twice in one queue and a dismissal recorded against one
 * ordering still matches the other.
 */
export function possibleDuplicateKey(paymentIdA: string, paymentIdB: string): string {
  return paymentIdA < paymentIdB ? `${paymentIdA}:${paymentIdB}` : `${paymentIdB}:${paymentIdA}`;
}
