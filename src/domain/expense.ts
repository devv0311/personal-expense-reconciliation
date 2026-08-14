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
 * How much of an expense's recorded adjustments the current allocation has not yet absorbed.
 *
 * An allocation sums to the net amount as of the moment it was decided. Once a later
 * `ExpenseAdjustment` is recorded, the two diverge by exactly the amount still awaiting
 * distribution — so the figure is derived from the ledger's own state rather than tracked
 * per adjustment. Recording two refunds and distributing once therefore gives the same
 * result as distributing after each (`lifecycle.md`, ExpenseAdjustment lifecycle).
 */
export function undistributedAmount(currentLineTotal: Paise, currentNetAmount: Paise): Paise {
  const pending = currentLineTotal - currentNetAmount;
  if (pending < 0n) {
    throw new DomainError(
      'ALLOCATION_SUM_MISMATCH',
      `The current allocation sums to ${currentLineTotal} paise but the expense's net amount ` +
        `is ${currentNetAmount} paise — the allocation is short, which cannot happen by ` +
        'recording an adjustment and means the two have drifted (invariants.md #11).',
      {
        currentLineTotal: currentLineTotal.toString(),
        currentNetAmount: currentNetAmount.toString(),
      },
    );
  }
  return pending as Paise;
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
