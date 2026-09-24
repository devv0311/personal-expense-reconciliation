/**
 * What still needs a person, phrased as the questions those decisions actually are.
 *
 * ```
 * services.listAttentionQuestions ─▶ services.listReviewQueue      (the items, the order)
 *                                 ─▶ services.listExpensePage      (expenses nobody is named on)
 *                                 ─▶ domain.attentionQuestion      (the wording)
 * ```
 *
 * **Not a second queue.** The items, their order and their counts are `listReviewQueue`'s,
 * untouched — re-ranking or re-deriving them here would produce a screen that disagrees with
 * the states it is describing (ADR-0029), and the whole point of composing rather than
 * rebuilding is that "what needs me" has one answer everywhere it is asked.
 *
 * What this adds is the framing. Each item carries the question it represents, the plain reason
 * it is being asked, and **only the facts needed to answer it** — not every field the queue
 * happens to hold. The original `ReviewQueueItem` travels with it, so the existing inspectors
 * and their `DecisionDialog`s remain the only way any of these is answered: this read introduces
 * no write path and no one-click approval.
 *
 * One question here is not a queue row at all. An approved expense with nobody named as a
 * beneficiary is a real outstanding human decision — "who shared this?" — that the ledger can
 * already see (`ListExpensesFilter.withoutAllocation`) and that the queue has never carried. It
 * is included, marked `ledger` rather than `review_queue`, and counted separately so the
 * queue's own total stays exactly what `/api/review` reports.
 */

import {
  attentionQuestion,
  documentWords,
  applyLearnedRule,
  inferPurpose,
  SPENDING_CATEGORIES,
} from '../domain/index.js';
import type {
  AppliedRule,
  ApprovedCategoryRule,
  AttentionQuestion,
  ConfidenceLevel,
  Paise,
  PersonId,
  RelatedPayment,
  ReviewItemKind,
} from '../domain/index.js';
import { listPeople } from '../db/index.js';
import type { Executor } from '../db/index.js';

import { loadApprovedCategoryRules } from './learning-service.js';
import { loadPurposeContext } from './purpose-proposal-service.js';

import { listExpensePage } from './expense-ledger-service.js';
import { listReviewQueue } from './review-service.js';
import type { ReviewQueueItem } from './review-service.js';

/* ----------------------------------------------------------------------------- facts */

/**
 * One fact a reader needs in order to answer the question, and what kind of thing it is.
 *
 * Typed rather than pre-formatted so that `web/` can render an amount with the product's own
 * money component and a date in the reader's locale — formatting, never arithmetic
 * (`web/CLAUDE.md` rule 1). `unknown` is its own kind on purpose: a total nobody has read off a
 * document is not zero, and a surface handed `kind: 'unknown'` cannot accidentally print one
 * (rule 2).
 */
export type AttentionFactKind = 'text' | 'money' | 'date' | 'unknown';

export interface AttentionFact {
  readonly label: string;
  readonly kind: AttentionFactKind;
  /** Exact paise for `money`, an instant for `date`, plain words for `text`, `null` otherwise. */
  readonly value: string | Paise | Date | null;
}

/* ----------------------------------------------------------------------------- items */

/** Where the question came from — the review queue, or a state the ledger can see directly. */
export type AttentionSource = 'review_queue' | 'ledger';

/** What the question is about, so a surface knows where answering it happens. */
export type AttentionSubject =
  | { readonly kind: 'payment'; readonly paymentId: string }
  | { readonly kind: 'payment_pair'; readonly paymentId: string; readonly otherPaymentId: string }
  | { readonly kind: 'evidence'; readonly evidenceId: string }
  | { readonly kind: 'expense'; readonly expenseId: string };

export interface AttentionItem {
  /** The queue item's own id, or `expense:<id>` for a ledger-derived question. */
  readonly id: string;
  readonly source: AttentionSource;
  /** The review kind, or `allocation_missing`. Carried raw so nothing is lost in translation. */
  readonly kind: string;
  readonly question: string;
  readonly why: string;
  /** The queue's own reason codes, for the details disclosure. Never the primary wording. */
  readonly reasons: readonly string[];
  /**
   * What is at stake, and whether anybody has established it.
   *
   * `known: false` for a document nothing has read: the queue carries zero there as "unknown"
   * (`domain/review.ts`), and a screen handed a bare zero would print a confident `₹0.00`.
   */
  readonly amount: { readonly known: boolean; readonly value: Paise | null };
  readonly occurredAt: Date;
  readonly facts: readonly AttentionFact[];
  readonly subject: AttentionSubject;
  /**
   * The full queue item, when this question is one.
   *
   * Present so the existing per-kind inspector answers it unchanged. `null` for a
   * ledger-derived question, which has no queue row and is answered on its expense's own screen.
   */
  readonly item: ReviewQueueItem | null;
  /**
   * What this payment looks like it was for, and what else it might be.
   *
   * Present only on a question about a payment's purpose. Re-derived from the payment's own
   * words on every read rather than stored beside the proposal: `domain.inferPurpose` is pure
   * and deterministic, so re-reading gives the same answer, and storing a second copy of the
   * alternatives is how a screen ends up offering choices the reader no longer agrees with.
   */
  readonly suggestion: AttentionSuggestion | null;
}

/** A confidence-aware suggestion, with the plain reason and the other sensible answers. */
export interface AttentionSuggestion {
  /** The inference a confirmation decides. `null` when the question carries no proposal. */
  readonly inferenceId: string | null;
  /** The category currently proposed, or `null` when nothing was proposed. */
  readonly category: string | null;
  readonly confidence: ConfidenceLevel;
  /** Plain sentences. Never a token list, never a score. */
  readonly why: readonly string[];
  /** Other categories worth offering first, best next. */
  readonly alternatives: readonly { readonly category: string; readonly why: string }[];
  /**
   * The approved pattern that matched this wording, or `null`.
   *
   * Present so the screen can name the rule and link to it. A rule that silently reordered a
   * suggestion with nothing on screen saying so would be exactly the invisible learning ADR-0064
   * replaced.
   */
  readonly appliedRule: AppliedRule | null;
  /** Every category a person may choose, for "Something else". */
  readonly everyCategory: readonly string[];
  /**
   * False when this line is not a purchase of its own — interest, a fee, a tax line, a repayment.
   *
   * The screen says so before it offers anything, because agreeing with a category on one of
   * these is how the same money reaches a total twice.
   */
  readonly countsAsPurchase: boolean;
}

export interface AttentionResult {
  readonly items: readonly AttentionItem[];
  /** Per review kind, straight from the queue — the same numbers `/api/review` reports. */
  readonly counts: Readonly<Record<ReviewItemKind, number>>;
  /** The review queue's own total. The nav badge's number, unchanged. */
  readonly reviewQueueTotal: number;
  /** Every question, including the ones the queue does not carry. */
  readonly total: number;
  readonly truncated: boolean;
}

export interface AttentionOptions {
  /**
   * How many questions to return, or `'all'` for every one of them.
   *
   * `'all'` exists for a caller that has to *find* a question rather than show a page of them —
   * a screen about one event asking which of these are about it. Taking the first page and
   * filtering would report "nothing needs you" about an event whose question happened to sit
   * past the page, which is the one answer that surface must never give wrongly.
   */
  readonly limit?: number | 'all';
  readonly kinds?: readonly ReviewItemKind[];
  /** Skips the ledger-derived questions, for a caller that wants the queue and nothing else. */
  readonly includeLedgerQuestions?: boolean;
}

const DEFAULT_LIMIT = 50;
const LEDGER_QUESTION_LIMIT = 25;

export async function listAttentionQuestions(
  db: Executor,
  options: AttentionOptions = {},
): Promise<AttentionResult> {
  const wantsLedgerQuestions =
    (options.includeLedgerQuestions ?? true) && options.kinds === undefined;

  const queue = await listReviewQueue(db, {
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
  });
  // Loaded once, and only when something on this page could use it: the reading needs to know
  // how often a merchant recurs, which is a question about the ledger rather than the row.
  const wantsPurpose = queue.items.some(needsPurposeReading);
  const [context, approvedRules] = wantsPurpose
    ? await Promise.all([loadPurposeContext(db), loadApprovedCategoryRules(db)])
    : [[] as readonly RelatedPayment[], [] as readonly ApprovedCategoryRule[]];
  const queueItems = queue.items.map((item) => toAttentionItem(item, context, approvedRules));

  const ledger = wantsLedgerQuestions
    ? await unallocatedExpenseQuestions(db, options.limit === 'all')
    : { items: [] as AttentionItem[], total: 0 };

  // The queue's order is `domain.prioritiseReviewQueue`'s and is preserved exactly. The
  // ledger-derived questions follow it rather than being interleaved: nothing about them
  // competes on materiality with a possible duplicate, and mixing two orderings would produce
  // a third that neither module decided.
  const all = [...queueItems, ...ledger.items];
  const limited =
    options.limit === 'all' ? all : all.slice(0, Math.max(0, options.limit ?? DEFAULT_LIMIT));

  // `total` counts every question the ledger has, including the ledger-derived ones this pass
  // did not fetch. A total that stopped at what was fetched would make the nav badge and the
  // front page quietly understate how much is waiting — a smaller number that looks finished.
  const total = queue.total + ledger.total;

  return {
    items: limited,
    counts: queue.counts,
    reviewQueueTotal: queue.total,
    total,
    truncated: limited.length < total,
  };
}

/** A stored category as this vocabulary spells it, or as it was stored when it is not one. */
function canonicalCategory(stored: string | null): string | null {
  if (stored === null) return null;
  const known = SPENDING_CATEGORIES.find(
    (category) => category.toLowerCase() === stored.trim().toLowerCase(),
  );
  return known ?? stored;
}

/* ------------------------------------------------------------------------- the queue */

function needsPurposeReading(item: ReviewQueueItem): boolean {
  return item.kind === 'classification_decision' || item.kind === 'rejected_classification';
}

function toAttentionItem(
  item: ReviewQueueItem,
  context: readonly RelatedPayment[],
  approvedRules: readonly ApprovedCategoryRule[],
): AttentionItem {
  const asked = askedFor(item);
  return {
    id: item.id,
    source: 'review_queue',
    kind: item.kind,
    question: asked.question,
    why: asked.why,
    reasons: item.reasons,
    amount: stakeOf(item),
    occurredAt: item.occurredAt,
    facts: factsFor(item),
    subject: subjectOf(item),
    item,
    suggestion: suggestionFor(item, context, approvedRules),
  };
}

/**
 * What the payment's own words say it was for, beside whatever was proposed about it.
 *
 * Two questions get one: *what was this payment for?* (a proposal waiting) and the same
 * question after somebody declined a proposal — where there is nothing proposed at all, and a
 * suggestion with no `inferenceId` is exactly what the screen needs in order to offer one.
 */
function suggestionFor(
  item: ReviewQueueItem,
  context: readonly RelatedPayment[],
  approvedRules: readonly ApprovedCategoryRule[],
): AttentionSuggestion | null {
  if (item.kind !== 'classification_decision' && item.kind !== 'rejected_classification') {
    return null;
  }

  const proposed =
    item.kind === 'classification_decision' && item.proposal?.proposedKind === 'expense'
      ? item.proposal.category
      : null;

  return readSuggestion({
    payment: item.payment,
    context,
    approvedRules,
    inferenceId: item.kind === 'classification_decision' ? item.inferenceId : null,
    confidence: item.kind === 'classification_decision' ? item.confidence : 'unknown',
    proposed,
  });
}

/**
 * The reading, shaped for a screen — shared by the queue's questions and the one the
 * connection view asks about a payment nobody has proposed anything for.
 *
 * Exported so `getPaymentConnection` composes the same suggestion rather than building a
 * second one that could word the same reading differently.
 */
export function readSuggestion(input: {
  readonly payment: {
    readonly paymentId: string;
    readonly description: string;
    readonly direction: 'debit' | 'credit';
  };
  readonly context: readonly RelatedPayment[];
  readonly inferenceId: string | null;
  readonly confidence: ConfidenceLevel;
  readonly proposed: string | null;
  /** Patterns the person approved (ADR-0064). Omitted means none are in play. */
  readonly approvedRules?: readonly ApprovedCategoryRule[];
}): AttentionSuggestion {
  const { payment, context, proposed } = input;
  const reading = inferPurpose({
    row: { rawDescription: payment.description, direction: payment.direction },
    related: context.filter((row) => row.paymentId !== payment.paymentId),
  });
  // The stored proposal leads when there is one — it is the thing a confirmation agrees with.
  // The reading supplies the reason and the alternatives either way.
  //
  // Matched case-insensitively against the vocabulary first: a category stored as `dining` by
  // something written before this vocabulary existed is the same answer as `Dining`, and
  // showing both — one as the suggestion and one as an alternative to it — offers somebody a
  // choice between a word and itself.
  const leading = canonicalCategory(proposed) ?? reading.candidates[0]?.category ?? null;
  const alternatives = reading.candidates
    .filter((candidate) => candidate.category !== leading)
    .map((candidate) => ({ category: candidate.category, why: candidate.why }));

  const leadingWhy = reading.candidates.find((candidate) => candidate.category === leading)?.why;

  // Which approved pattern, if any, matches this wording. Named on the card so a person can see
  // what fired and go and narrow it — a rule the reader cannot see is the thing ADR-0064 exists
  // to stop. It is added to the reasons rather than replacing them: the lexicon's reading is
  // still true, and the rule is why this category leads.
  const applied = applyLearnedRule(input.approvedRules ?? [], payment.description);
  const why = leadingWhy === undefined ? [...reading.why] : [...reading.why, leadingWhy];
  if (applied !== null) why.unshift(applied.why);

  return {
    inferenceId: input.inferenceId,
    category: leading,
    confidence: input.confidence,
    why,
    alternatives,
    everyCategory: SPENDING_CATEGORIES,
    countsAsPurchase: reading.countsAsPurchase,
    appliedRule: applied,
  };
}

function askedFor(item: ReviewQueueItem): AttentionQuestion {
  if (item.kind === 'classification_decision') {
    return attentionQuestion({
      kind: item.kind,
      reasons: item.reasons,
      proposedKind: item.proposedKind,
    });
  }
  if (item.kind === 'unmatched_evidence') {
    return attentionQuestion({
      kind: item.kind,
      reasons: item.reasons,
      candidateCount: item.matchCandidates.filter((candidate) => candidate.status === 'proposed')
        .length,
    });
  }
  return attentionQuestion({ kind: item.kind, reasons: item.reasons });
}

/**
 * What is at stake, and whether it is known.
 *
 * Only `unmatched_evidence` can be unknown, and only while nothing has read the document —
 * `domain/review.ts` documents that its zero means "nobody has established one". Every other
 * kind's amount is a payment's, which is a fact.
 */
function stakeOf(item: ReviewQueueItem): { known: boolean; value: Paise | null } {
  if (item.kind !== 'unmatched_evidence') return { known: true, value: item.amount };
  const established = item.receiptTotal ?? item.observation?.observedAmount ?? null;
  return established === null ? { known: false, value: null } : { known: true, value: established };
}

function subjectOf(item: ReviewQueueItem): AttentionSubject {
  switch (item.kind) {
    case 'possible_duplicate':
      return {
        kind: 'payment_pair',
        paymentId: item.payment.paymentId,
        otherPaymentId: item.candidate.paymentId,
      };
    case 'unmatched_evidence':
      return { kind: 'evidence', evidenceId: item.evidenceId };
    default:
      return { kind: 'payment', paymentId: item.payment.paymentId };
  }
}

/**
 * Only what is needed to decide.
 *
 * Deliberately short. The queue item carries the model, the prompt version, the stored proposal
 * and every reason code; none of those helps somebody answer "what was this payment for?", and
 * all of them are still reachable through the inspector this item travels with.
 */
function factsFor(item: ReviewQueueItem): readonly AttentionFact[] {
  switch (item.kind) {
    case 'classification_decision':
    case 'rejected_classification':
      return [
        { label: 'Payment', kind: 'money', value: item.payment.amount },
        { label: 'When', kind: 'date', value: item.payment.occurredAt },
        { label: 'What the record says', kind: 'text', value: item.payment.description },
      ];
    case 'possible_duplicate':
      return [
        { label: 'Both are for', kind: 'money', value: item.payment.amount },
        { label: 'First recorded', kind: 'date', value: item.candidate.occurredAt },
        { label: 'Recorded again', kind: 'date', value: item.payment.occurredAt },
        { label: 'What the record says', kind: 'text', value: item.payment.description },
      ];
    case 'unmatched_evidence': {
      const total = item.receiptTotal ?? item.observation?.observedAmount ?? null;
      const proposed = item.matchCandidates.filter(
        (candidate) => candidate.status === 'proposed',
      ).length;
      return [
        { label: 'Kind of record', kind: 'text', value: documentWords(item.evidenceType) },
        total === null
          ? { label: 'Total on it', kind: 'unknown', value: null }
          : { label: 'Total on it', kind: 'money', value: total },
        { label: 'Added', kind: 'date', value: item.capturedAt },
        {
          label: 'Payments it could be about',
          kind: 'text',
          value: proposed === 0 ? 'None suggested yet' : `${proposed}`,
        },
      ];
    }
  }
}

/* ------------------------------------------------------- questions the ledger can see */

/**
 * Approved expenses with nobody named as having benefited.
 *
 * Not in the review queue, and not added to it: the queue is about interpreting records, and
 * this is about an interpretation somebody already approved that cannot yet say who owes whom.
 * It is a genuine outstanding human decision, the ledger can already list it, and leaving it
 * off "what needs me" would mean the one screen named after outstanding decisions omitted a
 * whole class of them.
 */
async function unallocatedExpenseQuestions(
  db: Executor,
  everything = false,
): Promise<{ items: AttentionItem[]; total: number }> {
  // `personal` and `gift` are excluded: neither can create an obligation, so "who benefited
  // from this?" is a question their own record has already answered. Before this, confirming
  // what a payment was for immediately raised a new question about who shared it — a backlog
  // that grew by one every time somebody answered something.
  const first = await listExpensePage(db, {
    withoutAllocation: true,
    onlyObligationCapable: true,
    state: 'approved',
    limit: LEDGER_QUESTION_LIMIT,
  });
  // A caller asking for everything is looking for one particular question, so a page that
  // stopped short would answer "there is none" about a decision that exists. The second read
  // happens only when the first one was short of the total it reported.
  const page =
    everything && first.total > first.expenses.length
      ? await listExpensePage(db, {
          withoutAllocation: true,
          onlyObligationCapable: true,
          state: 'approved',
          limit: first.total,
        })
      : first;
  if (page.expenses.length === 0) return { items: [], total: page.total };

  const names = new Map<PersonId, string>();
  for (const person of await listPeople(db)) names.set(person.id, person.displayName);

  const asked = attentionQuestion({ kind: 'allocation_missing', reasons: [] });
  const items = page.expenses.map((expense) => ({
    id: `expense:${expense.id}`,
    source: 'ledger' as const,
    kind: 'allocation_missing',
    question: asked.question,
    why: asked.why,
    reasons: [],
    amount: { known: true, value: expense.netAmount },
    occurredAt: expense.occurredAt,
    facts: [
      {
        label: 'What it was',
        kind: 'text' as const,
        value: expense.description ?? 'No description recorded',
      },
      { label: 'Amount', kind: 'money' as const, value: expense.netAmount },
      { label: 'When', kind: 'date' as const, value: expense.occurredAt },
      {
        label: 'Paid by',
        kind: 'text' as const,
        value: names.get(expense.paidByPersonId) ?? 'Somebody not on the roster',
      },
    ],
    subject: { kind: 'expense' as const, expenseId: expense.id },
    item: null,
    // Nothing to read: "who shared this?" is a question about people, not about wording.
    suggestion: null,
  }));
  return { items, total: page.total };
}
