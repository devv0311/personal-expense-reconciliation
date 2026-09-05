/**
 * The item-level refund **allocation engine** (ADR-0018 (item refunds), Phase 18).
 *
 * `refund-attribution.ts` answers *what came back*; this module answers *what that means for
 * who owes whom*. Together they are the second half of ADR-0018's mandatory pipeline:
 *
 * ```text
 * financial event -> adjustment -> net item cost -> superseding allocation -> obligation
 * ```
 *
 * The rule this file exists to enforce is the one ADR-0008's whole-expense proportional
 * default cannot express: **a refund reduces only the item it came back for.** On ADR-0018's
 * worked basket — the user's ₹600 item and a friend's ₹400 item, one ₹1,000 payment — a ₹150
 * refund of the friend's item must leave the user's ₹600 exactly where it was. Apportioning
 * it across the current allocation would hand the user ₹90 of a refund the merchant issued
 * for something they never bought, and shrink a debt the friend still owes.
 *
 * Three properties the implementation is built around:
 *
 *  - **Recomputed from scratch, never incremented.** Every call rebuilds the lines from the
 *    items' immutable gross amounts, every attribution ever recorded, and the unattributed
 *    (legacy) reduction. Distributing two refunds at once therefore lands in the same place
 *    as distributing after each, and in the same place regardless of the order they arrived.
 *  - **Nothing invents ownership.** The weights come from the current allocation's own item
 *    lines — an approved human decision. When they cannot answer who owned a refunded item,
 *    the engine refuses (`REFUND_ITEM_OWNERSHIP_REQUIRED`) rather than falling back to the
 *    whole-basket default ADR-0018 forbids for a known item refund.
 *  - **The legacy reduction is applied once, separately, and stays visible.** Item targets are
 *    gross-minus-attribution and deliberately do *not* absorb a whole-expense refund; that
 *    reduction is distributed afterwards, over the item-derived lines, by ADR-0008's own
 *    `distributeAdjustment`. Neither reduction is counted twice, and neither disappears.
 *
 * Everything here is pure. Reading the attributions, taking the row lock and writing the
 * superseding `Allocation` is `services.distributeAdjustment`'s half of the same decision.
 */

import { distributeAdjustment } from './adjustment.js';
import type { DraftAllocationLine } from './allocation.js';
import { DomainError } from './errors.js';
import { beneficiarySortKey } from './ids.js';
import type { ExpenseItemId } from './ids.js';
import { sumPaise } from './money.js';
import type { Paise } from './money.js';
import { splitByLargestRemainder } from './rounding.js';

/**
 * One purchased item's gross cost, what has been refunded against it, and what it now costs.
 *
 * `grossAmount` is the immutable `ExpenseItem.amount` (19.5); `netAmount` is derived on every
 * read and never stored, exactly as `domain.netAmount` treats an expense.
 */
export interface ItemRefundBasis {
  readonly expenseItemId: ExpenseItemId;
  /** The item's original, immutable paid-cost basis — never rewritten by a refund (19.5). */
  readonly grossAmount: Paise;
  /** Cumulative `ExpenseAdjustmentItem.amount` across every adjustment naming this item. */
  readonly refundedAmount: Paise;
  /** `grossAmount − refundedAmount`. Never negative (19.3). */
  readonly netAmount: Paise;
}

/** An item as the ledger stores it, before attributions are applied. */
export interface GrossItem {
  readonly expenseItemId: ExpenseItemId;
  readonly grossAmount: Paise;
}

/**
 * Derives every item's current net cost from its gross amount and its cumulative refunds.
 *
 * Items with no attribution at all are still returned, at `refundedAmount = 0` — a
 * non-refunded delivery fee stays in the net cost of the basket precisely because it appears
 * here untouched, not because it was left out (ADR-0018, "Taxes and discounts").
 */
export function deriveItemRefundBases(
  items: readonly GrossItem[],
  refundedByItem: ReadonlyMap<ExpenseItemId, Paise>,
): readonly ItemRefundBasis[] {
  return items.map((item) => {
    const refundedAmount = refundedByItem.get(item.expenseItemId) ?? (0n as Paise);
    const netAmount = item.grossAmount - refundedAmount;
    if (netAmount < 0n) {
      throw new DomainError(
        'REFUND_ITEM_CEILING_EXCEEDED',
        `Refunds attributed to ExpenseItem ${item.expenseItemId} total ${refundedAmount} ` +
          `paise, above its original gross cost of ${item.grossAmount} paise. A net item ` +
          'cost is never negative (ADR-0018 (item refunds), 19.3).',
        {
          expenseItemId: item.expenseItemId,
          grossAmount: item.grossAmount.toString(),
          refundedAmount: refundedAmount.toString(),
        },
      );
    }
    return {
      expenseItemId: item.expenseItemId,
      grossAmount: item.grossAmount,
      refundedAmount,
      netAmount: netAmount as Paise,
    };
  });
}

export interface ItemAwareDistributionInput {
  /**
   * The expense's **current** allocation lines.
   *
   * Read twice over: as the beneficiary set the superseding version keeps, and as the
   * approved ownership weights each item's net cost is divided by. Never as a target — the
   * targets come from the items.
   */
  readonly lines: readonly DraftAllocationLine[];
  /** Every item of the expense, with its derived net cost. */
  readonly itemBases: readonly ItemRefundBasis[];
  /**
   * The total of every adjustment recorded **without** item attribution (ADR-0008's legacy
   * whole-expense path). Applied once, after the item stage, so item net totals never pretend
   * to contain it.
   */
  readonly legacyReduction: Paise;
  /**
   * An explicit, non-proportional distribution for the legacy reduction alone, positionally
   * aligned with `lines`. Omit for ADR-0008's proportional-to-existing-share default.
   */
  readonly legacyWeights?: readonly bigint[];
}

/**
 * Rebuilds an item-sourced allocation's lines from net item costs, then applies any
 * unattributed whole-expense reduction over the result.
 *
 * Returned in the same order as `lines`, so a caller can zip the new amounts straight back
 * onto the beneficiaries (and their `expenseItemId`s) they came from — a superseding version
 * keeps the same shape and the same people, at new amounts (ADR-0013).
 */
export function buildItemAwareAllocationLines(
  input: ItemAwareDistributionInput,
): readonly DraftAllocationLine[] {
  assertItemOwnershipIsExpressed(input.lines, input.itemBases);
  const itemStage = applyItemNetCosts(input.lines, input.itemBases);

  if (input.legacyReduction === 0n) {
    if (input.legacyWeights !== undefined) {
      throw new DomainError(
        'ALLOCATION_SHAPE_INVALID',
        'A custom weight set describes how an unattributed whole-expense reduction lands ' +
          'across beneficiaries, but every adjustment on this expense is item-attributed. ' +
          'An item refund is distributed by its attribution, not by a weight set ' +
          '(ADR-0018 (item refunds), "Calculation semantics").',
      );
    }
    return itemStage;
  }

  // ADR-0008's own distribution, over the item-derived lines. Reused rather than
  // re-implemented: "apply their recorded distribution once" means exactly this algorithm,
  // and a second copy of it here would be a second place for the rounding to disagree.
  return distributeAdjustment({
    lines: itemStage,
    adjustmentAmount: input.legacyReduction,
    ...(input.legacyWeights === undefined ? {} : { customWeights: input.legacyWeights }),
  });
}

/**
 * The total an item-aware rebuild will produce: `Σ net item cost − legacy reduction`.
 *
 * Stated separately so a caller can compare it against `domain.netAmount` before writing
 * anything. The two agree whenever the items account for the expense's gross amount, which
 * `domain.validateExpenseItemsSum` already requires of any itemized expense; when they do
 * not, the mismatch is a real disagreement about what the purchase contained and surfaces as
 * an `ALLOCATION_SUM_MISMATCH` rather than being papered over.
 */
export function itemAwareAllocationTotal(
  itemBases: readonly ItemRefundBasis[],
  legacyReduction: Paise,
): Paise {
  const itemTotal = sumPaise(itemBases.map((basis) => basis.netAmount));
  return (itemTotal - legacyReduction) as Paise;
}

/**
 * Invariant #14 in its ADR-0018 form: the lines referencing any single item sum to that
 * item's **net** cost — its gross amount less cumulative item refunds.
 *
 * Only meaningful while no unattributed reduction is in play; once a legacy whole-expense
 * refund has been distributed over the same lines, per-item sums are net cost less that
 * item's share of it, and the invariant's own text keeps those two reductions distinct.
 */
export function validateItemNetLineSums(
  lines: readonly DraftAllocationLine[],
  itemBases: readonly ItemRefundBasis[],
): void {
  const netById = new Map(itemBases.map((basis) => [basis.expenseItemId, basis]));
  const allocated = new Map<ExpenseItemId, Paise>();
  for (const line of lines) {
    if (line.expenseItemId === null) continue;
    const running = allocated.get(line.expenseItemId) ?? (0n as Paise);
    allocated.set(line.expenseItemId, (running + line.amount) as Paise);
  }

  for (const [expenseItemId, total] of allocated) {
    const basis = netById.get(expenseItemId);
    if (basis === undefined) {
      throw new DomainError(
        'UNKNOWN_REFERENCE',
        `Allocation lines reference expense item ${expenseItemId}, which is not part of this ` +
          'expense.',
        { expenseItemId },
      );
    }
    if (total !== basis.netAmount) {
      throw new DomainError(
        'ALLOCATION_ITEM_SUM_MISMATCH',
        `Allocation lines for expense item ${expenseItemId} sum to ${total} paise but its net ` +
          `cost after ${basis.refundedAmount} paise of item refunds is ${basis.netAmount} ` +
          `paise (its gross ${basis.grossAmount} paise is unchanged — invariants.md #14, ` +
          'ADR-0018 (item refunds), 19.5).',
        {
          expenseItemId,
          allocated: total.toString(),
          netAmount: basis.netAmount.toString(),
          grossAmount: basis.grossAmount.toString(),
        },
      );
    }
  }
}

/* ------------------------------------------------------------------------- internals */

/**
 * Refuses to proceed unless the current allocation actually says who owned each item.
 *
 * This is the guard behind ADR-0018's *"if item ownership is absent or conflicts with the
 * intended allocation, a human must approve the item mapping or method change before
 * distribution. Neither the AI nor the refund engine may invent beneficiary ownership."*
 * An `equal`/`percentage`/`exact`/`custom` allocation carries no `expense_item_id` on any
 * line, so it cannot answer whose item came back — and quietly answering "everyone's, in
 * proportion" is the exact behaviour ADR-0018 exists to stop.
 */
function assertItemOwnershipIsExpressed(
  lines: readonly DraftAllocationLine[],
  itemBases: readonly ItemRefundBasis[],
): void {
  if (lines.length === 0) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      'Cannot rebuild an allocation with no lines. A fully refunded expense keeps one ' +
        'zero-amount line per original beneficiary, so there is always at least one line ' +
        '(invariants.md #12a, ADR-0013).',
    );
  }

  const unattached = lines.filter((line) => line.expenseItemId === null).length;
  if (unattached > 0) {
    throw new DomainError(
      'REFUND_ITEM_OWNERSHIP_REQUIRED',
      `${unattached} of this expense's ${lines.length} current allocation lines name no ` +
        'ExpenseItem, so the ledger cannot say who owned the refunded item. An item refund ' +
        'is never redistributed with the whole-basket proportional default: approve an ' +
        'item mapping or an item-based allocation first (ADR-0018 (item refunds), ' +
        '"Calculation semantics").',
      { unattachedLines: String(unattached), totalLines: String(lines.length) },
    );
  }

  const known = new Set(itemBases.map((basis) => basis.expenseItemId));
  for (const line of lines) {
    const expenseItemId = line.expenseItemId;
    if (expenseItemId !== null && !known.has(expenseItemId)) {
      throw new DomainError(
        'UNKNOWN_REFERENCE',
        `Allocation line for ${line.beneficiary.id} references expense item ${expenseItemId}, ` +
          'which is not part of this expense.',
        { expenseItemId, beneficiaryId: line.beneficiary.id },
      );
    }
  }

  const covered = new Set(
    lines.map((line) => line.expenseItemId).filter((id): id is ExpenseItemId => id !== null),
  );
  for (const basis of itemBases) {
    if (covered.has(basis.expenseItemId)) continue;
    throw new DomainError(
      'REFUND_ITEM_OWNERSHIP_REQUIRED',
      `Expense item ${basis.expenseItemId} (net ${basis.netAmount} paise) has no line in the ` +
        'current allocation, so nobody is recorded as having benefited from it. Every item ' +
        'must be accounted for before its refund can move a share (invariants.md #14).',
      { expenseItemId: basis.expenseItemId, netAmount: basis.netAmount.toString() },
    );
  }
}

/** Stage one: each item's net cost, divided across that item's own approved lines. */
function applyItemNetCosts(
  lines: readonly DraftAllocationLine[],
  itemBases: readonly ItemRefundBasis[],
): readonly DraftAllocationLine[] {
  const indicesByItem = new Map<ExpenseItemId, number[]>();
  for (const [index, line] of lines.entries()) {
    const expenseItemId = line.expenseItemId;
    /* c8 ignore next -- unreachable: assertItemOwnershipIsExpressed rejects null first. */
    if (expenseItemId === null) continue;
    const bucket = indicesByItem.get(expenseItemId) ?? [];
    bucket.push(index);
    indicesByItem.set(expenseItemId, bucket);
  }

  const amounts = new Array<Paise>(lines.length).fill(0n as Paise);

  for (const basis of itemBases) {
    const indices = indicesByItem.get(basis.expenseItemId) ?? [];

    // One owner: the net cost *is* their share, copied exactly. ADR-0012 exempts item-sourced
    // lines from the rounding algorithm for this reason — there is no total being divided,
    // so running a split here would be arithmetic theatre over an already-exact figure.
    if (indices.length === 1) {
      amounts[indices[0] as number] = basis.netAmount;
      continue;
    }

    const weights = indices.map((index) => lines[index]?.amount ?? (0n as Paise));
    const weightTotal = sumPaise(weights);
    if (weightTotal === 0n && basis.netAmount > 0n) {
      throw new DomainError(
        'REFUND_ITEM_OWNERSHIP_REQUIRED',
        `Expense item ${basis.expenseItemId} is shared across ${indices.length} beneficiaries ` +
          `whose current shares are all zero, so there is no approved proportion to divide its ` +
          `remaining ${basis.netAmount} paise by. A human must restate the split before this ` +
          'refund can be distributed (ADR-0018 (item refunds), "Calculation semantics").',
        { expenseItemId: basis.expenseItemId, netAmount: basis.netAmount.toString() },
      );
    }

    // A genuinely shared item: the same Largest Remainder Method used everywhere else, with
    // the approved shares as weights and the documented `beneficiary_id`-ascending tie-break
    // (invariants.md #12, ADR-0012's ADR-0018 extension).
    const shares = splitByLargestRemainder(
      basis.netAmount,
      indices.map((index) => ({
        key: beneficiarySortKey((lines[index] as DraftAllocationLine).beneficiary),
        weight: lines[index]?.amount ?? 0n,
      })),
    );
    for (const [position, index] of indices.entries()) {
      amounts[index] = shares[position]?.amount ?? (0n as Paise);
    }
  }

  return lines.map((line, index) => ({ ...line, amount: amounts[index] ?? (0n as Paise) }));
}
