/**
 * Expense-level derived figures.
 *
 * `Expense.amount` is the gross, historical amount and never changes once the expense is
 * `approved` — by any mechanism, including an audited "new decision" (`invariants.md` #6,
 * ADR-0008). What a purchase currently costs, net of money that came back, is therefore
 * always **derived**, never stored: that is `netAmount`.
 */

import { DomainError } from './errors.js';
import { assertPositive, sumPaise } from './money.js';
import type { Paise } from './money.js';

/** Sums the adjustments recorded against one expense. */
export function totalAdjusted(adjustmentAmounts: readonly Paise[]): Paise {
  return sumPaise(adjustmentAmounts);
}

/**
 * `netAmount(expense) = expense.amount − Σ ExpenseAdjustment.amount`.
 *
 * Always recomputed, never stored (`domain-model.md`, `Expense`). This is the figure the
 * current `Allocation` must sum to (`invariants.md` #11) and the figure
 * `ledger_explained_total` accumulates (`invariants.md` #20) — not the gross amount.
 */
export function netAmount(grossAmount: Paise, adjustmentAmounts: readonly Paise[]): Paise {
  const adjusted = totalAdjusted(adjustmentAmounts);
  const net = grossAmount - adjusted;
  if (net < 0n) {
    throw new DomainError(
      'ADJUSTMENT_EXCEEDS_EXPENSE',
      `Adjustments totalling ${adjusted} paise exceed the expense's gross amount of ` +
        `${grossAmount} paise, which would make its net amount negative. An expense cannot ` +
        'be refunded or reimbursed for more than it cost (invariants.md #8).',
      { grossAmount: grossAmount.toString(), adjusted: adjusted.toString() },
    );
  }
  return net as Paise;
}

/**
 * How far the current allocation is from the expense's net amount — **signed**.
 *
 * An allocation sums to the net amount as of the moment it was decided, and drifts from it
 * whenever the net moves afterwards. The figure is derived from the ledger's own state rather
 * than tracked per adjustment, so recording two refunds and distributing once gives the same
 * result as distributing after each (`lifecycle.md`, ExpenseAdjustment lifecycle).
 *
 * Two directions, and both are real:
 *
 *  - **Positive** — the allocation is *ahead* of the net: a refund was recorded and not yet
 *    distributed. This is the ordinary case and the only one that existed before ADR-0052.
 *  - **Negative** — the allocation is *behind* the net: an adjustment was reversed as
 *    erroneous, so the expense costs more than the current shares sum to. This used to be
 *    unreachable, and the function threw on it, which was correct at the time: nothing could
 *    make the net amount rise. Reversal can, and a state the ledger can genuinely reach must
 *    be representable rather than an error (audit row 23, ADR-0052).
 *
 * Zero means the allocation is current. Callers asking "is a distribution pending?" therefore
 * test `!== 0n`, not `> 0n` — an expense whose shares are short by ₹2,000 because a refund was
 * reversed is exactly as out of date as one ahead by ₹2,000.
 */
export function undistributedAmount(currentLineTotal: Paise, currentNetAmount: Paise): Paise {
  return (currentLineTotal - currentNetAmount) as Paise;
}

/**
 * Invariant #8: `sum(ExpenseAdjustment.amount for one expense) <= that expense's gross
 * amount`, and each adjustment is a positive magnitude — there is no signed/negative
 * `ExpenseAdjustment` (`invariants.md` #12a, "Negative adjustments").
 */
export function validateAdjustmentTotal(
  grossAmount: Paise,
  adjustmentAmounts: readonly Paise[],
): void {
  for (const [index, amount] of adjustmentAmounts.entries()) {
    assertPositive(amount, `expenseAdjustments[${index}].amount`);
  }
  // Recomputing the net amount is the check: it throws when adjustments overshoot.
  netAmount(grossAmount, adjustmentAmounts);
}

/**
 * `domain-model.md`'s `ExpenseItem` invariant: when an expense is broken down into items at
 * all, their amounts must sum to exactly the expense's **gross** amount — never the net one.
 * `ExpenseItem`s "represent the original purchase's composition and are unaffected by later
 * adjustments, same as `Expense.amount` itself." An expense with no items at all is valid
 * (whole-expense `equal`/`exact`/`percentage` allocation needs none); a *partially* itemized
 * one is not, because a partial set could never be complete evidence of what was bought.
 */
export function validateExpenseItemsSum(itemAmounts: readonly Paise[], grossAmount: Paise): void {
  const total = sumPaise(itemAmounts);
  if (total !== grossAmount) {
    throw new DomainError(
      'EXPENSE_ITEMS_SUM_MISMATCH',
      `${itemAmounts.length} item(s) sum to ${total} paise, but the expense's gross amount is ` +
        `${grossAmount} paise. ExpenseItems must fully account for what the expense cost ` +
        '(domain-model.md, ExpenseItem invariant) — there is no partial itemization.',
      { total: total.toString(), grossAmount: grossAmount.toString() },
    );
  }
}
