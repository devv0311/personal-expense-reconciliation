/**
 * Distributing an `ExpenseAdjustment` across an expense's current allocation.
 *
 * Recording an adjustment and reflecting it in the allocation are two separate, both-
 * visible steps (`lifecycle.md`, "ExpenseAdjustment lifecycle"). This module is the
 * arithmetic of the second one: given the current lines and the amount coming back, what
 * do the superseding allocation's lines look like?
 *
 * `invariants.md` #12 is explicit about the input: *"the adjustment amount is the `A` being
 * divided across the current `Allocation`'s lines; the default weight set is each line's
 * own pre-adjustment `amount`"*. So the **reduction** is what gets apportioned, and each
 * new line amount is `old − reduction`.
 *
 * ADR-0013 describes the full-refund case as "the Largest Remainder Method applied with a
 * total of 0 against the existing beneficiary set". The two descriptions coincide exactly
 * at that boundary — when the adjustment equals the lines' total, every line's reduction
 * equals its own amount and every new line is 0 — so there is no conflict; for a *partial*
 * adjustment, `invariants.md` #12's wording (apportion the adjustment) governs, since it
 * is the one that states the algorithm's input.
 */

import type { DraftAllocationLine } from './allocation.js';
import { DomainError } from './errors.js';
import { beneficiarySortKey } from './ids.js';
import { sumPaise } from './money.js';
import type { Paise } from './money.js';
import { splitByLargestRemainder } from './rounding.js';

export interface AdjustmentDistributionInput {
  /** The expense's **current** allocation lines, pre-adjustment. */
  readonly lines: readonly DraftAllocationLine[];
  /** The `ExpenseAdjustment.amount` being distributed. Always a positive magnitude. */
  readonly adjustmentAmount: Paise;
  /**
   * An explicit, non-proportional weight set, positionally aligned with `lines`.
   *
   * Positional rather than keyed by beneficiary because two `item_based` lines may
   * legitimately name the same beneficiary, which would make a keyed override ambiguous.
   * Omit for the proportional-to-existing-share default.
   */
  readonly customWeights?: readonly bigint[];
}

/** The default weight set: each line's own pre-adjustment amount. */
export function proportionalWeights(lines: readonly DraftAllocationLine[]): readonly bigint[] {
  return lines.map((line) => line.amount);
}

/**
 * Returns the superseding allocation's lines: the same beneficiaries, at reduced amounts,
 * summing to the expense's new net amount.
 *
 * Never clamps. A custom distribution that would drive a line below zero is rejected
 * outright, because clamping would make the distributed amounts stop summing to the
 * adjustment's amount — silently losing money from the ledger's arithmetic, which is worse
 * than refusing the input (`invariants.md` #12a).
 */
export function distributeAdjustment(
  input: AdjustmentDistributionInput,
): readonly DraftAllocationLine[] {
  if (input.lines.length === 0) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      'Cannot distribute an adjustment across an allocation with no lines. A fully refunded ' +
        'expense keeps one zero-amount line per original beneficiary, so there is always at ' +
        'least one line to distribute across (invariants.md #12a, ADR-0013).',
    );
  }
  if (input.adjustmentAmount < 0n) {
    throw new DomainError(
      'ADJUSTMENT_DISTRIBUTION_NEGATIVE',
      `Adjustment amount must be a positive magnitude, received ${input.adjustmentAmount} ` +
        'paise. There is no signed/negative ExpenseAdjustment (invariants.md #12a).',
      { adjustmentAmount: input.adjustmentAmount.toString() },
    );
  }

  const currentTotal = sumPaise(input.lines.map((line) => line.amount));
  if (input.adjustmentAmount > currentTotal) {
    throw new DomainError(
      'ADJUSTMENT_EXCEEDS_EXPENSE',
      `An adjustment of ${input.adjustmentAmount} paise cannot be distributed across lines ` +
        `totalling ${currentTotal} paise — the expense would end up with a negative net ` +
        'amount (invariants.md #8).',
      {
        adjustmentAmount: input.adjustmentAmount.toString(),
        currentTotal: currentTotal.toString(),
      },
    );
  }

  const weights = input.customWeights ?? proportionalWeights(input.lines);
  if (weights.length !== input.lines.length) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      `A custom adjustment distribution needs one weight per allocation line: got ` +
        `${weights.length} weights for ${input.lines.length} lines.`,
      { weights: String(weights.length), lines: String(input.lines.length) },
    );
  }

  const reductions = splitByLargestRemainder(
    input.adjustmentAmount,
    input.lines.map((line, index) => ({
      key: beneficiarySortKey(line.beneficiary),
      weight: weights[index] ?? 0n,
    })),
  );

  return input.lines.map((line, index) => {
    const reduction = reductions[index]?.amount ?? (0n as Paise);
    const remaining = line.amount - reduction;
    if (remaining < 0n) {
      throw new DomainError(
        'ADJUSTMENT_DISTRIBUTION_NEGATIVE',
        `This distribution assigns ${reduction} paise of the adjustment to ` +
          `${line.beneficiary.id}, whose share is only ${line.amount} paise. The allocation ` +
          'is rejected rather than clamped to zero, which would stop the distributed ' +
          'amounts summing to the adjustment (invariants.md #12a).',
        {
          beneficiaryId: line.beneficiary.id,
          lineAmount: line.amount.toString(),
          reduction: reduction.toString(),
        },
      );
    }
    return { ...line, amount: remaining as Paise };
  });
}
