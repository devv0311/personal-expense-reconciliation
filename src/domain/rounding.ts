/**
 * The Largest Remainder Method — the **one** algorithm this system uses to divide a total
 * amount of money across lines.
 *
 * Specified in full in `docs/domain/invariants.md` #12 and decided in
 * `docs/decisions/0012-deterministic-money-rounding.md`. Implemented exactly once, here,
 * and called from every site that divides a total:
 *
 *   - `equal`-method `AllocationLine`s (weight 1 each)
 *   - `percentage`-method `AllocationLine`s (weight = the stated percentage numerator)
 *   - `AllocationLineGroupExpansion` rows (weight 1 per resolved member, or overrides)
 *   - `ExpenseAdjustment` distribution (weight = each line's pre-adjustment amount, or a
 *     user-supplied custom weight set)
 *
 * It is deliberately **not** used for `item_based`/`quantity_based` lines: their amount is
 * copied verbatim from an already-exact `ExpenseItem.amount`, so there is no total being
 * divided and nothing to round (`invariants.md` #12, "Where it explicitly does not apply").
 */

import { DomainError } from './errors.js';
import type { Paise } from './money.js';

/** One line participating in a division, with its deterministic tie-break key. */
export interface SplitWeight {
  /**
   * The tie-break key: `beneficiary_id` for an allocation line, `person_id` for a group
   * expansion row (`invariants.md` #12, step 4). Compared as plain text, ascending.
   */
  readonly key: string;
  /** A non-negative integer weight. Equal splits use 1; percentages use the numerator. */
  readonly weight: bigint;
}

/** One line's resolved, exact share. */
export interface SplitShare {
  readonly key: string;
  readonly amount: Paise;
}

/** Builds an equal-weight input set: every line weighted 1. */
export function equalWeights(keys: readonly string[]): SplitWeight[] {
  return keys.map((key) => ({ key, weight: 1n }));
}

/**
 * Divides `total` across `weights` so the parts sum to the whole, exactly, every time.
 *
 * 1. `W = Σ w_i`
 * 2. `base_i = floor(total × w_i ÷ W)` — bigint integer division, never a float
 * 3. `remainder = total − Σ base_i` (always `0 ≤ remainder < N`)
 * 4. rank lines by fractional remainder `(total × w_i) mod W`, descending; ties broken by
 *    `key` ascending, then by input position (see note below)
 * 5. the top `remainder` ranked lines each get one extra minor unit
 *
 * Shares are returned in **input order**, so a caller can zip them straight back onto the
 * lines they came from.
 *
 * @remarks
 * Step 4's tie-break is specified in `invariants.md` #12 down to the ID. Two lines can
 * legitimately share an ID (two item-based lines naming the same beneficiary), so input
 * position completes the ordering — without it, equal-ID ties would fall through to
 * `Array.prototype.sort`'s implementation-defined behaviour and the "identical inputs
 * produce byte-identical output" guarantee would not hold. This is a completion of the
 * documented rule at a point the rule is silent, not a departure from it.
 */
export function splitByLargestRemainder(
  total: Paise,
  weights: readonly SplitWeight[],
): readonly SplitShare[] {
  if (weights.length === 0) {
    throw new DomainError(
      'SPLIT_INVALID_INPUT',
      'Cannot divide an amount across zero lines. An allocation always has at least one ' +
        'line, including when the amount being divided is zero (invariants.md #12a).',
    );
  }
  if (total < 0n) {
    throw new DomainError(
      'SPLIT_INVALID_INPUT',
      `The total being divided must be >= 0, received ${total} paise.`,
      { total: total.toString() },
    );
  }

  let totalWeight = 0n;
  for (const [index, entry] of weights.entries()) {
    if (entry.key === '') {
      throw new DomainError(
        'SPLIT_INVALID_INPUT',
        `Line ${index} has an empty tie-break key; ordering would be ambiguous.`,
        { index: String(index) },
      );
    }
    if (entry.weight < 0n) {
      throw new DomainError(
        'SPLIT_INVALID_INPUT',
        `Line ${index} (${entry.key}) has a negative weight (${entry.weight}). ` +
          'Weights are non-negative by construction (invariants.md #12a).',
        { index: String(index), key: entry.key, weight: entry.weight.toString() },
      );
    }
    totalWeight += entry.weight;
  }

  if (totalWeight === 0n) {
    if (total === 0n) {
      // Degenerate but well-defined: nothing to divide, nothing to divide it by. Every
      // line gets zero, which is the same shape a full refund produces (ADR-0013).
      return weights.map((entry) => ({ key: entry.key, amount: 0n as Paise }));
    }
    throw new DomainError(
      'SPLIT_INVALID_INPUT',
      `Cannot divide ${total} paise across lines whose weights sum to zero — there is no ` +
        'proportion to divide by. Supply an explicit weight set instead.',
      { total: total.toString() },
    );
  }

  // Step 2/3: floor share and fractional remainder, in exact integer arithmetic.
  const ranked = weights.map((entry, index) => {
    const scaled = total * entry.weight;
    return {
      index,
      key: entry.key,
      base: scaled / totalWeight,
      fraction: scaled % totalWeight,
    };
  });

  let distributed = 0n;
  for (const line of ranked) {
    distributed += line.base;
  }
  const remainder = total - distributed;

  // Step 4: rank by fractional remainder desc, then key asc, then input position asc.
  const order = [...ranked].sort((a, b) => {
    if (a.fraction !== b.fraction) return a.fraction > b.fraction ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.index - b.index;
  });

  // Step 5: hand out the leftover minor units, one each, to the top-ranked lines.
  //
  // `remainder` is strictly less than the number of lines by construction, so it is a small
  // count — a *rank*, never an amount. Converting it to a `number` here is converting an
  // index, not money; no monetary value passes through a JavaScript number anywhere in this
  // function.
  const linesReceivingAnExtraUnit = Number(remainder);
  const extra = new Set<number>();
  for (let rank = 0; rank < linesReceivingAnExtraUnit; rank += 1) {
    const winner = order[rank];
    /* c8 ignore next 3 -- unreachable: remainder < N is guaranteed by construction. */
    if (winner === undefined) {
      throw new DomainError('SPLIT_INVALID_INPUT', 'Remainder exceeded the number of lines.');
    }
    extra.add(winner.index);
  }

  return ranked.map((line) => ({
    key: line.key,
    amount: (line.base + (extra.has(line.index) ? 1n : 0n)) as Paise,
  }));
}
