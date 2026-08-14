/**
 * Immutability guards for SOURCE data and for approved financial facts.
 *
 * These make invariants #4 and #6 checkable in one place instead of relying on every call
 * site to remember them. They are the domain half of a two-layer defence: `src/db` also
 * denies `UPDATE` on the immutable columns at the database-role level, so an accidental
 * write fails loudly there too rather than silently succeeding
 * (`database-design.md`, Conventions).
 */

import type { ExpenseState } from './enums.js';
import { DomainError } from './errors.js';
import { isExpenseAmountFrozen } from './lifecycle.js';
import type { Paise } from './money.js';

/**
 * Invariant #6, in its strongest form: once an `Expense` is `approved`, its `amount`
 * never changes again — not even through the audited "new decision" mechanism that
 * `relationship_type` and `Allocation` still allow.
 */
export function assertExpenseAmountImmutable(
  state: ExpenseState,
  currentAmount: Paise,
  proposedAmount: Paise,
): void {
  if (currentAmount === proposedAmount) return;
  if (!isExpenseAmountFrozen(state)) return;
  throw new DomainError(
    'IMMUTABLE_FIELD',
    `Expense.amount is ${currentAmount} paise and the expense is "${state}"; it can never ` +
      `change again, by any mechanism (invariants.md #6, ADR-0008). Record an ` +
      'ExpenseAdjustment against this expense instead — a correction to what something cost ' +
      'is a new linked event, not a rewritten history.',
    {
      field: 'amount',
      state,
      currentAmount: currentAmount.toString(),
      proposedAmount: proposedAmount.toString(),
    },
  );
}

/** The `Payment` columns that are write-once (`invariants.md` #4). */
export interface PaymentSourceFields {
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly rawDescription: string;
  readonly accountId: string;
}

/**
 * Invariant #4: raw imported evidence is never overwritten.
 *
 * Corrections happen by creating or adjusting `Expense`/`Allocation`/`Settlement` records,
 * or by marking the payment `ignored` with a reason — never by mutating what the bank
 * actually said.
 */
export function assertPaymentSourceImmutable(
  current: PaymentSourceFields,
  proposed: PaymentSourceFields,
): void {
  const changed = firstChangedField(
    [
      ['amount', current.amount.toString(), proposed.amount.toString()],
      ['occurredAt', current.occurredAt.toISOString(), proposed.occurredAt.toISOString()],
      ['rawDescription', current.rawDescription, proposed.rawDescription],
      ['accountId', current.accountId, proposed.accountId],
    ],
    'Payment',
    'Corrections happen by creating or adjusting an Expense or Settlement, or by marking the ' +
      'payment ignored with a reason — never by editing what the source recorded ' +
      '(invariants.md #4).',
  );
  if (changed !== null) throw changed;
}

/** The `Evidence` columns that are write-once. */
export interface EvidenceSourceFields {
  readonly storageRef: string | null;
  readonly rawText: string | null;
  readonly capturedAt: Date;
}

/**
 * Invariant #4, for evidence. Superseding evidence — a clearer photo of the same receipt —
 * is a new `Evidence` row, not an edit to the existing one.
 */
export function assertEvidenceImmutable(
  current: EvidenceSourceFields,
  proposed: EvidenceSourceFields,
): void {
  const changed = firstChangedField(
    [
      ['storageRef', current.storageRef ?? '', proposed.storageRef ?? ''],
      ['rawText', current.rawText ?? '', proposed.rawText ?? ''],
      ['capturedAt', current.capturedAt.toISOString(), proposed.capturedAt.toISOString()],
    ],
    'Evidence',
    'Superseding evidence is recorded as a new Evidence row, never as an edit to an existing ' +
      'one (invariants.md #4).',
  );
  if (changed !== null) throw changed;
}

/* ------------------------------------------------------------------------- internals */

function firstChangedField(
  fields: ReadonlyArray<readonly [string, string, string]>,
  entity: string,
  guidance: string,
): DomainError | null {
  for (const [field, current, proposed] of fields) {
    if (current === proposed) continue;
    return new DomainError(
      'IMMUTABLE_FIELD',
      `${entity}.${field} is SOURCE data and is write-once. ${guidance}`,
      { entity, field, currentValue: current, proposedValue: proposed },
    );
  }
  return null;
}
