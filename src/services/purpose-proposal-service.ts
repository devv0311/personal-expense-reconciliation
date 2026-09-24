/**
 * Reading a statement line's own words into a proposal a person can confirm.
 *
 * ```
 * services.proposePurposeLocally ─▶ db.listPaymentPurposeContext   what else this ledger holds
 *                                ─▶ domain.inferPurpose            what the line is, and likely for
 *                                ─▶ the same proposal shape a model would have produced
 * ```
 *
 * **The leg that makes this product work with no provider configured.** `classifyPayments`
 * already had a deterministic leg — self-transfer pairing — and then stopped, reporting
 * `no_model_configured` for everything else. On a ledger of imported statements that is every
 * row: 120 payments, no proposals, nothing to confirm, and an Overview reporting ₹0 spent over
 * a statement it had read but not understood.
 *
 * This leg reads the line instead. It produces **exactly** the `TransactionClassification` a
 * model would have produced, stores it through the same `proposeClassification` path, routes it
 * for review through the same `routeClassificationForReview`, and is confirmed through the same
 * `decideInference`. There is no second approval path and no second definition of a category.
 *
 * ## What it refuses to propose
 *
 * A credit-card statement is mostly not purchases. Three kinds of row are deliberately left
 * without a proposal, because a proposal somebody might approve is a proposal that can put the
 * same money in a total twice:
 *
 *  - **a tax line** (`CGST`, `SGST`) — tax on another line of the same statement;
 *  - **an instalment repayment** — the purchase already happened on its own line;
 *  - **a credit** — money arriving is never an `Expense` (ADR-0027), and the cash-flow path
 *    (ADR-0017) is what decides what a credit was.
 *
 * Each still gets its plain explanation on its own screen; what it does not get is a suggestion
 * to agree with. **Interest and card fees are proposed**, because they are real costs — as
 * `Bills & subscriptions`, never as the merchant sitting next to them on the line.
 */

import { applyLearnedRule, inferPurpose, isSpendingCategory } from '../domain/index.js';
import type {
  AppliedRule,
  ApprovedCategoryRule,
  ClassificationSkipReason,
  ConfidenceLevel,
  PurposeReading,
  RelatedPayment,
  SpendingCategory,
} from '../domain/index.js';
import { listPaymentPurposeContext } from '../db/index.js';
import type { Executor, PaymentRow } from '../db/index.js';

/** The provenance a locally-read proposal records. Honest about there being no model. */
export const LOCAL_PURPOSE_READER = {
  provider: 'local',
  model: 'statement-description-reader',
  promptVersion: 'purpose@1',
} as const;

/** What the local reader decided about one payment. */
export type LocalPurposeOutcome =
  | {
      readonly outcome: 'proposal';
      readonly category: SpendingCategory;
      readonly confidence: ConfidenceLevel;
      readonly reading: PurposeReading;
      /** Set when an approved pattern led this reading, so the proposal can name it. */
      readonly appliedRule?: AppliedRule;
    }
  | {
      readonly outcome: 'no_proposal';
      readonly reason: ClassificationSkipReason;
      readonly reading: PurposeReading;
    };

/**
 * Every payment's words and confirmed categories, loaded once.
 *
 * `classifyPayments` loads it for the whole run rather than per payment: recurrence is a
 * property of the ledger, not of the row, and re-reading the ledger 120 times to answer the
 * same question 120 times is the kind of thing that turns a local tool slow for no reason.
 */
export async function loadPurposeContext(exec: Executor): Promise<readonly RelatedPayment[]> {
  const rows = await listPaymentPurposeContext(exec);
  return rows.map((row) => ({
    paymentId: row.paymentId,
    rawDescription: row.rawDescription,
    direction: row.direction,
    occurredAt: row.occurredAt,
    confirmedCategory: row.confirmedCategory,
  }));
}

/**
 * Reads one payment locally, and says whether that reading is worth proposing.
 *
 * Pure apart from its inputs, so the same call answers both the run that stores a proposal and
 * the screen that shows the alternatives beside it.
 */
export function readPurposeFor(
  payment: Pick<PaymentRow, 'id' | 'rawDescription' | 'direction'>,
  context: readonly RelatedPayment[],
  /**
   * Patterns the person has approved (ADR-0064). Omitted means none, which is what every caller
   * that predates learning passes and what a ledger with no approved rule has.
   */
  approvedRules: readonly ApprovedCategoryRule[] = [],
): LocalPurposeOutcome {
  // The payment's own row must not count as a sighting of itself, or every merchant would look
  // like it had been seen once before.
  const related = context.filter((row) => row.paymentId !== payment.id);
  const reading = inferPurpose({
    row: { rawDescription: payment.rawDescription, direction: payment.direction },
    related,
  });

  if (payment.direction === 'credit') {
    return { outcome: 'no_proposal', reason: 'credit_out_of_scope', reading };
  }
  if (reading.nature === 'tax_on_another_line' || reading.nature === 'instalment_principal') {
    return { outcome: 'no_proposal', reason: 'not_a_purchase_of_its_own', reading };
  }

  // An approved pattern outranks the lexicon, because it is a decision the person made rather
  // than a guess about a word. It still only *leads the suggestion*: the payment becomes a
  // proposal that somebody confirms, and the rule is named on it so they can see what fired.
  //
  // A rule whose category is not one this vocabulary knows falls through to the lexicon rather
  // than leading. `set_expense_category` accepts any string — a rule written before a category
  // was renamed, or by hand — and proposing a category the confirmation screen cannot offer
  // would produce a suggestion nobody can agree with.
  const applied = applyLearnedRule(approvedRules, payment.rawDescription);
  if (applied !== null && isSpendingCategory(applied.category)) {
    return {
      outcome: 'proposal',
      category: applied.category,
      confidence: 'high',
      reading,
      appliedRule: applied,
    };
  }

  const best = reading.candidates[0];
  if (best === undefined) {
    return { outcome: 'no_proposal', reason: 'nothing_to_go_on', reading };
  }
  return {
    outcome: 'proposal',
    category: best.category,
    confidence: best.confidence,
    reading,
  };
}
