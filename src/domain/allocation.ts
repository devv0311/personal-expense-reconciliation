/**
 * Allocation arithmetic — turning "who benefited, and how it was divided" into exact,
 * stored line amounts.
 *
 * `AllocationLine.amount` is always authoritative regardless of method: even a
 * `percentage` line stores its resolved amount, so settlement math never re-derives a
 * figure from a percentage and a possibly-stale total (`invariants.md` #13).
 *
 * All division goes through `splitByLargestRemainder` (`invariants.md` #12) — except
 * `item_based`/`quantity_based`, whose amounts are copied verbatim from an already-exact
 * `ExpenseItem.amount`. Running the algorithm on those "for consistency" would silently
 * overwrite a user/receipt-sourced figure.
 */

import { DomainError } from './errors.js';
import type { AllocationMethod } from './enums.js';
import { beneficiarySortKey } from './ids.js';
import type { BeneficiaryRef, ExpenseItemId } from './ids.js';
import { assertNonNegative, paise, sumPaise } from './money.js';
import type { Paise } from './money.js';
import { splitByLargestRemainder } from './rounding.js';
import type { SplitWeight } from './rounding.js';

/** An allocation line before it has an id — the shape `services` persists. */
export interface DraftAllocationLine {
  readonly beneficiary: BeneficiaryRef;
  readonly amount: Paise;
  /** Informational, only set for the `percentage` method (`invariants.md` #13). */
  readonly percentage: string | null;
  readonly expenseItemId: ExpenseItemId | null;
}

/**
 * The subset of an `ExpenseItem` allocation arithmetic needs.
 *
 * `amount` is the item's **currently allocatable** cost: its immutable gross
 * `ExpenseItem.amount` less every refund attributed to it (ADR-0018 (item refunds), 19.5,
 * and invariants.md #14 in its tightened form). With no attributions the two are the same
 * figure, which is why callers that predate item refunds need no change.
 */
export interface AllocatableItem {
  readonly id: ExpenseItemId;
  readonly amount: Paise;
}

/** Split a total equally across beneficiaries. */
export interface EqualAllocationInput {
  readonly method: 'equal';
  readonly total: Paise;
  readonly beneficiaries: readonly BeneficiaryRef[];
}

/** Amounts stated outright by the user; they must already sum to the total. */
export interface ExactAllocationInput {
  readonly method: 'exact' | 'custom';
  readonly total: Paise;
  readonly lines: ReadonlyArray<{ readonly beneficiary: BeneficiaryRef; readonly amount: Paise }>;
}

/** Percentages stated by the user; amounts are resolved once, here. */
export interface PercentageAllocationInput {
  readonly method: 'percentage';
  readonly total: Paise;
  readonly lines: ReadonlyArray<{
    readonly beneficiary: BeneficiaryRef;
    /** An exact decimal with at most two places, e.g. `'33.33'`. */
    readonly percentage: string;
  }>;
}

/**
 * Lines drawn from `ExpenseItem`s.
 *
 * `item_based` divides nothing: each line's amount is an already-exact stored figure, copied.
 *
 * `quantity_based` is the one item-sourced shape that *does* divide, and only when an item is
 * itself shared: "three thalis, two of them mine" is a claim about units, and the money follows
 * from them. `units` supplies that claim, and the item's cost is split across the lines
 * referencing it by the Largest Remainder Method — the same single algorithm every other split
 * in this system uses (`invariants.md` #12), never a per-unit price rounded per line, which
 * would lose or invent paise on any cost that does not divide evenly.
 *
 * A line may still state an explicit `amount` instead; `units` and `amount` on the same line
 * are refused, because two answers to "how much is this line" is exactly the ambiguity this
 * layer exists to prevent.
 */
export interface ItemBasedAllocationInput {
  readonly method: 'item_based' | 'quantity_based';
  readonly lines: ReadonlyArray<{
    readonly beneficiary: BeneficiaryRef;
    readonly expenseItemId: ExpenseItemId;
    /** Defaults to the referenced item's full amount when one line covers one item. */
    readonly amount?: Paise;
    /**
     * How many of the item's units this beneficiary took. `quantity_based` only.
     *
     * A weight, in the Largest Remainder Method's sense: what matters is this line's share of
     * the units claimed against the item, so `2` of `1 + 2` is two thirds of the item's cost.
     */
    readonly units?: bigint;
  }>;
  readonly items: readonly AllocatableItem[];
}

export type AllocationInput =
  | EqualAllocationInput
  | ExactAllocationInput
  | PercentageAllocationInput
  | ItemBasedAllocationInput;

/** `numeric(5,2)` percentages are compared as hundredths of a percent. */
const PERCENTAGE_SCALE = 100n;
const ONE_HUNDRED_PERCENT = 100n * PERCENTAGE_SCALE;
const PERCENTAGE_PATTERN = /^(-?)(\d{1,3})(?:\.(\d{1,2}))?$/;

/**
 * Builds the exact, authoritative line amounts for an allocation.
 *
 * Pure: takes a decision, returns the lines that decision implies. Persisting them, and
 * writing the accompanying `AuditEvent`, is `services`' job.
 */
export function buildAllocationLines(input: AllocationInput): readonly DraftAllocationLine[] {
  switch (input.method) {
    case 'equal':
      return buildEqualLines(input);
    case 'exact':
    case 'custom':
      return buildExactLines(input);
    case 'percentage':
      return buildPercentageLines(input);
    case 'item_based':
    case 'quantity_based':
      return buildItemBasedLines(input);
  }
}

function buildEqualLines(input: EqualAllocationInput): readonly DraftAllocationLine[] {
  assertBeneficiariesUnique(input.beneficiaries);
  const shares = splitByLargestRemainder(
    input.total,
    input.beneficiaries.map((beneficiary) => ({
      key: beneficiarySortKey(beneficiary),
      weight: 1n,
    })),
  );
  return input.beneficiaries.map((beneficiary, index) => ({
    beneficiary,
    amount: shareAt(shares, index),
    percentage: null,
    expenseItemId: null,
  }));
}

function buildExactLines(input: ExactAllocationInput): readonly DraftAllocationLine[] {
  assertBeneficiariesUnique(input.lines.map((line) => line.beneficiary));
  if (input.lines.length === 0) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      'An allocation must have at least one line (invariants.md #12a).',
    );
  }
  for (const [index, line] of input.lines.entries()) {
    assertNonNegative(line.amount, `allocationLines[${index}].amount`);
  }
  const stated = sumPaise(input.lines.map((line) => line.amount));
  if (stated !== input.total) {
    throw new DomainError(
      'ALLOCATION_SUM_MISMATCH',
      `The stated ${input.method} amounts sum to ${stated} paise but the allocation must ` +
        `sum to ${input.total} paise. Amounts are rejected, never adjusted to fit.`,
      { method: input.method, lineSum: stated.toString(), total: input.total.toString() },
    );
  }
  return input.lines.map((line) => ({
    beneficiary: line.beneficiary,
    amount: line.amount,
    percentage: null,
    expenseItemId: null,
  }));
}

function buildPercentageLines(input: PercentageAllocationInput): readonly DraftAllocationLine[] {
  assertBeneficiariesUnique(input.lines.map((line) => line.beneficiary));
  if (input.lines.length === 0) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      'An allocation must have at least one line (invariants.md #12a).',
    );
  }

  const numerators = input.lines.map((line, index) =>
    parsePercentageNumerator(line.percentage, index),
  );
  const stated = numerators.reduce((total, numerator) => total + numerator, 0n);
  if (stated !== ONE_HUNDRED_PERCENT) {
    throw new DomainError(
      'PERCENTAGES_DO_NOT_SUM',
      `Stated percentages sum to ${formatPercentage(stated)}%, not 100%. This is rejected ` +
        'before any split is attempted, never silently normalised ' +
        '(testing-strategy.md rounding case 5).',
      { statedTotal: formatPercentage(stated) },
    );
  }

  const weights: SplitWeight[] = input.lines.map((line, index) => ({
    key: beneficiarySortKey(line.beneficiary),
    weight: numerators[index] ?? 0n,
  }));
  const shares = splitByLargestRemainder(input.total, weights);

  return input.lines.map((line, index) => ({
    beneficiary: line.beneficiary,
    amount: shareAt(shares, index),
    percentage: formatPercentage(numerators[index] ?? 0n),
    expenseItemId: null,
  }));
}

function buildItemBasedLines(input: ItemBasedAllocationInput): readonly DraftAllocationLine[] {
  if (input.lines.length === 0) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      'An allocation must have at least one line (invariants.md #12a).',
    );
  }
  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  const unitShares = resolveUnitShares(input);

  const lines: DraftAllocationLine[] = input.lines.map((line, index) => {
    const item = itemsById.get(line.expenseItemId);
    if (item === undefined) {
      throw new DomainError(
        'UNKNOWN_REFERENCE',
        `Line ${index} references expense item ${line.expenseItemId}, which is not part of ` +
          'this expense.',
        { index: String(index), expenseItemId: line.expenseItemId },
      );
    }
    if (line.units !== undefined && line.amount !== undefined) {
      throw new DomainError(
        'ALLOCATION_SHAPE_INVALID',
        `Line ${index} states both a unit count and an amount. One line has one amount: ` +
          'either the units decide it, or you state it outright.',
        { index: String(index) },
      );
    }
    if (line.units !== undefined && input.method !== 'quantity_based') {
      throw new DomainError(
        'ALLOCATION_SHAPE_INVALID',
        `Line ${index} states a unit count, but the method is "${input.method}". Units divide ` +
          'a shared item, which is what quantity_based means.',
        { index: String(index), method: input.method },
      );
    }
    // Either an already-exact stored figure, copied, or this line's Largest-Remainder share
    // of a shared item's cost — never a per-unit price multiplied out.
    const amount = unitShares.get(index) ?? line.amount ?? item.amount;
    assertNonNegative(amount, `allocationLines[${index}].amount`);
    return {
      beneficiary: line.beneficiary,
      amount,
      percentage: null,
      expenseItemId: line.expenseItemId,
    };
  });

  const referenced = new Set(input.lines.map((line) => line.expenseItemId));
  for (const item of input.items) {
    if (!referenced.has(item.id)) {
      throw new DomainError(
        'ALLOCATION_ITEM_SUM_MISMATCH',
        `Expense item ${item.id} (${item.amount} paise) has no allocation line. Every item ` +
          "must be accounted for, or the expense's items no longer sum to its amount " +
          '(invariants.md #14).',
        { expenseItemId: item.id },
      );
    }
  }
  validateItemBasedLineSums(lines, input.items);
  return lines;
}

/**
 * Resolves each unit-stated line's amount, by line index.
 *
 * Grouped per item and split once per item, so the remainder distribution is a property of
 * that item's cost rather than of the order lines happen to appear in. Items with no
 * unit-stated line are absent from the result and keep their existing behaviour.
 */
function resolveUnitShares(input: ItemBasedAllocationInput): Map<number, Paise> {
  const byItem = new Map<ExpenseItemId, Array<{ index: number; units: bigint }>>();
  for (const [index, line] of input.lines.entries()) {
    if (line.units === undefined) continue;
    if (line.units <= 0n) {
      throw new DomainError(
        'ALLOCATION_SHAPE_INVALID',
        `Line ${index} claims ${line.units} units. A beneficiary who took none of an item ` +
          'has no line for it — a zero-unit claim is an empty statement, not a zero share.',
        { index: String(index), units: line.units.toString() },
      );
    }
    const group = byItem.get(line.expenseItemId) ?? [];
    group.push({ index, units: line.units });
    byItem.set(line.expenseItemId, group);
  }

  const resolved = new Map<number, Paise>();
  if (byItem.size === 0) return resolved;

  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  for (const [expenseItemId, group] of byItem) {
    const item = itemsById.get(expenseItemId);
    if (item === undefined) {
      throw new DomainError(
        'UNKNOWN_REFERENCE',
        `Unit-based lines reference expense item ${expenseItemId}, which is not part of this ` +
          'expense.',
        { expenseItemId },
      );
    }
    // A line for the same item that states an amount instead of units would leave the item
    // over-allocated: the unit split already spends the item's whole cost.
    const mixed = input.lines.some(
      (line) =>
        line.expenseItemId === expenseItemId &&
        line.units === undefined &&
        line.amount !== undefined,
    );
    if (mixed) {
      throw new DomainError(
        'ALLOCATION_SHAPE_INVALID',
        `Expense item ${expenseItemId} has both unit-stated and amount-stated lines. The unit ` +
          "split already divides the item's whole cost, so a stated amount beside it would " +
          'allocate the item twice.',
        { expenseItemId },
      );
    }

    const shares = splitByLargestRemainder(
      item.amount,
      group.map((entry) => ({
        // Tie-break by beneficiary, exactly as every other split does (`invariants.md` #12,
        // step 4) — the line's position in the request must not decide who absorbs a paisa.
        key: beneficiarySortKey(input.lines[entry.index]!.beneficiary),
        weight: entry.units,
      })),
    );
    group.forEach((entry, position) => {
      resolved.set(entry.index, shareAt(shares, position));
    });
  }
  return resolved;
}

/**
 * Invariant #11: the current allocation's lines sum to the expense's **net** amount —
 * gross minus any `ExpenseAdjustment`s — not its gross `amount` (ADR-0008).
 */
export function validateAllocationSum(
  lines: readonly DraftAllocationLine[],
  netAmount: Paise,
): void {
  if (lines.length === 0) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      'An allocation must have at least one line, including when its net amount is zero — ' +
        'a fully refunded expense keeps one zero-amount line per original beneficiary ' +
        '(invariants.md #12a, ADR-0013).',
    );
  }
  const lineSum = sumPaise(lines.map((line) => line.amount));
  if (lineSum !== netAmount) {
    throw new DomainError(
      'ALLOCATION_SUM_MISMATCH',
      `Allocation lines sum to ${lineSum} paise but the expense's net amount is ` +
        `${netAmount} paise (invariants.md #11).`,
      { lineSum: lineSum.toString(), netAmount: netAmount.toString() },
    );
  }
}

/** Invariant #12a: no line amount is ever negative. Zero is valid. */
export function validateAllocationLineAmounts(lines: readonly DraftAllocationLine[]): void {
  for (const [index, line] of lines.entries()) {
    assertNonNegative(line.amount, `allocationLines[${index}].amount`);
  }
}

/**
 * Invariant #14, in its tightened form: the lines referencing **any single**
 * `ExpenseItem` must sum to that item's own amount.
 *
 * The aggregate-only version of this check passes even when lines are attached to the
 * wrong item, as long as the grand total happens to match — a real misallocation it
 * cannot see.
 */
export function validateItemBasedLineSums(
  lines: readonly DraftAllocationLine[],
  items: readonly AllocatableItem[],
): void {
  const perItem = new Map<ExpenseItemId, Paise>();
  for (const line of lines) {
    if (line.expenseItemId === null) continue;
    const running = perItem.get(line.expenseItemId) ?? paise(0n);
    perItem.set(line.expenseItemId, paise(running + line.amount));
  }

  const itemsById = new Map(items.map((item) => [item.id, item]));
  for (const [expenseItemId, allocated] of perItem) {
    const item = itemsById.get(expenseItemId);
    if (item === undefined) {
      throw new DomainError(
        'UNKNOWN_REFERENCE',
        `Allocation lines reference expense item ${expenseItemId}, which is not part of this ` +
          'expense.',
        { expenseItemId },
      );
    }
    if (allocated !== item.amount) {
      throw new DomainError(
        'ALLOCATION_ITEM_SUM_MISMATCH',
        `Allocation lines for expense item ${expenseItemId} sum to ${allocated} paise but the ` +
          `item's allocatable cost is ${item.amount} paise (invariants.md #14, checked per ` +
          'item, against the net cost after any attributed refunds — ADR-0018 (item refunds)).',
        {
          expenseItemId,
          allocated: allocated.toString(),
          itemAmount: item.amount.toString(),
        },
      );
    }
  }
}

/** True when this method's amounts come from `ExpenseItem`s rather than from a division. */
export function methodDividesATotal(method: AllocationMethod): boolean {
  return method !== 'item_based' && method !== 'quantity_based';
}

/* ------------------------------------------------------------------------- internals */

function assertBeneficiariesUnique(beneficiaries: readonly BeneficiaryRef[]): void {
  if (beneficiaries.length === 0) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      'An allocation must name at least one beneficiary — even a personal expense gets a ' +
        'trivial 100%-to-payer line (invariants.md #2).',
    );
  }
  const seen = new Set<string>();
  for (const beneficiary of beneficiaries) {
    const key = `${beneficiary.type}:${beneficiary.id}`;
    if (seen.has(key)) {
      throw new DomainError(
        'ALLOCATION_SHAPE_INVALID',
        `Duplicate beneficiary ${key} in one allocation. Each beneficiary gets exactly one ` +
          'line; a shared item is expressed by the line amount, not by repeating the line.',
        { beneficiary: key },
      );
    }
    seen.add(key);
  }
}

function shareAt(shares: ReadonlyArray<{ amount: Paise }>, index: number): Paise {
  const share = shares[index];
  /* c8 ignore next 3 -- unreachable: shares are returned one per input line, in order. */
  if (share === undefined) {
    throw new DomainError('SPLIT_INVALID_INPUT', `No share was computed for line ${index}.`);
  }
  return share.amount;
}

/** Parses `'33.33'` into 3333 hundredths of a percent. */
function parsePercentageNumerator(percentage: string, index: number): bigint {
  const match = typeof percentage === 'string' ? PERCENTAGE_PATTERN.exec(percentage) : null;
  if (match === null || match[1] === '-') {
    throw new DomainError(
      'PERCENTAGES_DO_NOT_SUM',
      `Line ${index} has percentage "${String(percentage)}", which is not a non-negative ` +
        'decimal with at most two places (the precision numeric(5,2) stores).',
      { index: String(index), percentage: String(percentage) },
    );
  }
  const [, , whole = '0', fraction = ''] = match;
  return BigInt(whole) * PERCENTAGE_SCALE + BigInt(fraction.padEnd(2, '0'));
}

/** Renders hundredths of a percent back as `numeric(5,2)` text. */
function formatPercentage(numerator: bigint): string {
  const whole = numerator / PERCENTAGE_SCALE;
  const fraction = numerator % PERCENTAGE_SCALE;
  return `${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
}
