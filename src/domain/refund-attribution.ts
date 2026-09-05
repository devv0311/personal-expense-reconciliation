/**
 * Item-level refund attribution (ADR-0018 (item refunds), 19.1–19.6).
 *
 * ADR-0008 preserves gross purchase history by recording a refund as an `ExpenseAdjustment`
 * and re-versioning the allocation. What it cannot express is *which item came back*. On a
 * shared basket, distributing a refund proportionally over the current allocation reduces a
 * debt owed by someone whose item was never returned — the ₹1,000 basket in ADR-0018's worked
 * example, where the ₹150 refund belongs entirely to the friend's ₹400 item.
 *
 * The pipeline is fixed and this module is its first step:
 *
 * ```text
 * financial event -> adjustment -> net expense -> allocation -> obligation
 * ```
 *
 * So everything here is about **cost**, never about beneficiaries. These rows describe what
 * an item now costs; who owes whom is recomputed from that afterwards, by the allocation
 * engine (Phase 18). Nothing in this file reads or writes an `AllocationLine`.
 *
 * The two amounts a refund never touches are `Expense.amount` and `ExpenseItem.amount`
 * (19.5). Both are gross, historical and immutable; the net figures are derived on every
 * read, exactly as `domain.netAmount` already derives an expense's net cost.
 */

import { DomainError } from './errors.js';
import type { ExpenseId, ExpenseItemId } from './ids.js';
import { assertPositive, sumPaise } from './money.js';
import type { Paise } from './money.js';
import { validateAdjustmentTotal } from './expense.js';

/** One proposed attribution row: this much of the adjustment came back for this item. */
export interface RefundAttributionDraft {
  readonly expenseItemId: ExpenseItemId;
  /** Strictly positive integer paise. A clawback is new spend, not a negative row (19.4). */
  readonly amount: Paise;
}

/**
 * What the ledger already knows about one purchased item.
 *
 * `alreadyAttributed` is the sum over **every other recorded adjustment**, not just the most
 * recent one — 19.3 is explicit that checking only the newest row is wrong, because three
 * successive ₹40 refunds against a ₹100 item each pass a newest-row-only check and together
 * exceed what the item cost.
 */
export interface RefundAttributionItemContext {
  readonly expenseItemId: ExpenseItemId;
  /** The expense this item belongs to. Compared against the parent adjustment's (19.1). */
  readonly expenseId: ExpenseId;
  /** The item's original, immutable gross cost (19.5). */
  readonly grossAmount: Paise;
  /** Cumulative attributions from adjustments other than the one being validated. */
  readonly alreadyAttributed: Paise;
}

/** The refund credit an adjustment draws on, when one has been observed (19.6). */
export interface RefundPaymentContext {
  /** The credit `Payment`'s own amount. Never resized to fit item math. */
  readonly amount: Paise;
  /** What other adjustments already draw from this same credit. */
  readonly alreadyAttributed: Paise;
}

export interface RefundAttributionInput {
  /** The parent adjustment's `original_expense_id`. */
  readonly expenseId: ExpenseId;
  /** The parent `ExpenseAdjustment.amount` the rows must sum to exactly (19.2). */
  readonly adjustmentAmount: Paise;
  readonly attributions: readonly RefundAttributionDraft[];
  /** Every item of the parent expense that the attributions may name. */
  readonly items: readonly RefundAttributionItemContext[];
  /** The parent expense's gross amount, for the expense-wide ceiling (19.3). */
  readonly expenseGrossAmount: Paise;
  /** Adjustments already recorded against this expense, excluding the one being validated. */
  readonly otherAdjustmentAmounts: readonly Paise[];
  /** Omitted for an evidence-first adjustment whose cash has not been observed (19.6). */
  readonly refundPayment?: RefundPaymentContext;
}

/**
 * Validates one adjustment's complete item attribution set.
 *
 * Deliberately validates the **whole set at once** rather than row by row. 19.2's exact-sum
 * rule and 19.3's ceilings are properties of the set, and a per-row validator would let a
 * caller write half a proposal and call the result an approved item refund. Persisting the
 * set transactionally, under a lock over the parent expense, is the caller's other half of
 * 19.3 — this function is pure, so it cannot see a concurrent writer.
 *
 * An empty attribution set is rejected here, not treated as a legacy whole-expense
 * adjustment: legacy adjustments simply never call this function (19.2).
 */
export function validateRefundAttribution(input: RefundAttributionInput): void {
  assertPositive(input.adjustmentAmount, 'expenseAdjustment.amount');

  if (input.attributions.length === 0) {
    throw new DomainError(
      'REFUND_ATTRIBUTION_SUM_MISMATCH',
      'An item-attributed adjustment needs at least one ExpenseAdjustmentItem. A refund with ' +
        'no attribution is a legacy whole-expense adjustment, which keeps its own explicitly ' +
        'documented path and never reaches this validation (ADR-0018 (item refunds), 19.2).',
      { adjustmentAmount: input.adjustmentAmount.toString() },
    );
  }

  const itemsById = new Map(input.items.map((item) => [item.expenseItemId, item]));
  const seen = new Set<ExpenseItemId>();

  for (const [index, attribution] of input.attributions.entries()) {
    assertPositive(attribution.amount, `expenseAdjustmentItems[${index}].amount`);

    if (seen.has(attribution.expenseItemId)) {
      throw new DomainError(
        'REFUND_ATTRIBUTION_DUPLICATE_ITEM',
        `ExpenseItem ${attribution.expenseItemId} is attributed twice within one adjustment. ` +
          'There is one row per (adjustment, item) pair; a larger refund of one item is a ' +
          'larger amount on its single row (ADR-0018 (item refunds)).',
        { expenseItemId: attribution.expenseItemId },
      );
    }
    seen.add(attribution.expenseItemId);

    const item = itemsById.get(attribution.expenseItemId);
    if (item === undefined) {
      throw new DomainError(
        'UNKNOWN_REFERENCE',
        `ExpenseItem ${attribution.expenseItemId} was not among the parent expense's items, so ` +
          'its expense and its remaining refundable basis cannot be checked ' +
          '(ADR-0018 (item refunds), 19.1).',
        { expenseItemId: attribution.expenseItemId, expenseId: input.expenseId },
      );
    }
    // 19.1. The foreign keys alone cannot prove this: `expense_adjustment_items` references an
    // adjustment and an item, and nothing in either constraint says they concern one expense.
    if (item.expenseId !== input.expenseId) {
      throw new DomainError(
        'REFUND_ATTRIBUTION_CROSS_EXPENSE',
        `ExpenseItem ${attribution.expenseItemId} belongs to expense ${item.expenseId}, but its ` +
          `adjustment is against expense ${input.expenseId}. Cross-expense attribution is ` +
          'rejected even when the merchant, receipt or payer is the same ' +
          '(ADR-0018 (item refunds), 19.1).',
        {
          expenseItemId: attribution.expenseItemId,
          itemExpenseId: item.expenseId,
          adjustmentExpenseId: input.expenseId,
        },
      );
    }

    // 19.3, cumulative across every recorded refund of this item — never the newest row alone.
    const cumulative = item.alreadyAttributed + attribution.amount;
    if (cumulative > item.grossAmount) {
      throw new DomainError(
        'REFUND_ITEM_CEILING_EXCEEDED',
        `Refunds attributed to ExpenseItem ${attribution.expenseItemId} would total ` +
          `${cumulative} paise, above its original gross cost of ${item.grossAmount} paise. An ` +
          'item cannot be refunded for more than it cost, and a net item cost is never ' +
          'negative (ADR-0018 (item refunds), 19.3).',
        {
          expenseItemId: attribution.expenseItemId,
          cumulative: cumulative.toString(),
          grossAmount: item.grossAmount.toString(),
          alreadyAttributed: item.alreadyAttributed.toString(),
        },
      );
    }
  }

  // 19.2, exact — not "at most". An unexplained remainder must never become an approved item
  // refund; a partial proposal stays pending instead.
  const attributed = sumPaise(input.attributions.map((attribution) => attribution.amount));
  if (attributed !== input.adjustmentAmount) {
    throw new DomainError(
      'REFUND_ATTRIBUTION_SUM_MISMATCH',
      `Item attributions sum to ${attributed} paise but the adjustment is ` +
        `${input.adjustmentAmount} paise. An item-attributed adjustment is attributed exactly, ` +
        'with no remainder (ADR-0018 (item refunds), 19.2).',
      { attributed: attributed.toString(), adjustmentAmount: input.adjustmentAmount.toString() },
    );
  }

  // 19.3's second half: the parent expense's own cumulative ceiling still applies, so a set of
  // per-item refunds that each fit their item cannot together over-refund the expense.
  validateAdjustmentTotal(input.expenseGrossAmount, [
    ...input.otherAdjustmentAmounts,
    input.adjustmentAmount,
  ]);

  // 19.6. The credit is immutable evidence: adjustments drawn against it cannot exceed what
  // actually came back, and whatever is left over stays unexplained rather than being absorbed.
  if (input.refundPayment !== undefined) {
    const drawn = input.refundPayment.alreadyAttributed + input.adjustmentAmount;
    if (drawn > input.refundPayment.amount) {
      throw new DomainError(
        'PAYMENT_BUDGET_EXCEEDED',
        `Adjustments drawn against this refund credit would total ${drawn} paise, above the ` +
          `credit's own ${input.refundPayment.amount} paise. A Payment is never resized or ` +
          'fabricated to match item or allocation math (ADR-0018 (item refunds), 19.6).',
        { drawn: drawn.toString(), paymentAmount: input.refundPayment.amount.toString() },
      );
    }
  }
}

/**
 * `net_item_amount_i = ExpenseItem.amount_i - sum(attributions for item i)`.
 *
 * Derived on every read, never stored — the same treatment `domain.netAmount` gives an
 * expense, and for the same reason: storing it would create a second place for the item's
 * current cost to live and drift from the attribution rows that define it (19.5).
 */
export function netItemAmount(grossAmount: Paise, attributedAmounts: readonly Paise[]): Paise {
  const attributed = sumPaise(attributedAmounts);
  const net = grossAmount - attributed;
  if (net < 0n) {
    throw new DomainError(
      'REFUND_ITEM_CEILING_EXCEEDED',
      `Attributions totalling ${attributed} paise exceed the item's gross cost of ` +
        `${grossAmount} paise, which would make its net cost negative ` +
        '(ADR-0018 (item refunds), 19.3).',
      { grossAmount: grossAmount.toString(), attributed: attributed.toString() },
    );
  }
  return net as Paise;
}

/** How much of an item's original cost is still refundable (19.3). */
export function remainingRefundableItemAmount(
  grossAmount: Paise,
  attributedAmounts: readonly Paise[],
): Paise {
  return netItemAmount(grossAmount, attributedAmounts);
}

/**
 * The reduction an item-attributed refund set applies, per item.
 *
 * Returned as a map rather than applied to anything, because the allocation engine that
 * consumes it (Phase 18) has to combine it with approved item ownership and the allocation
 * method before any beneficiary's share moves. "Only beneficiaries of the affected item
 * receive its reduction" is a rule about allocation, and this module deliberately stops short
 * of it.
 */
export function attributionTotalsByItem(
  attributions: readonly RefundAttributionDraft[],
): ReadonlyMap<ExpenseItemId, Paise> {
  const totals = new Map<ExpenseItemId, Paise>();
  for (const attribution of attributions) {
    const previous = totals.get(attribution.expenseItemId) ?? (0n as Paise);
    totals.set(attribution.expenseItemId, (previous + attribution.amount) as Paise);
  }
  return totals;
}
