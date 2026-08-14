/**
 * Obligation and balance — who owes whom, in either direction.
 *
 * Deliberately **not** user-centric (ADR-0006). Any two `Person`s can have an obligation
 * between them: Flatmate C can owe Flatmate A from an expense Flatmate A fronted, with
 * the user involved only as the person whose ledger happens to record it.
 *
 * From `domain-model.md`:
 *
 * ```
 * GrossObligation(X owes Y) =
 *   Σ AllocationLine.amount (or, for group lines, AllocationLineGroupExpansion.amount)
 *     for lines on Expenses where
 *       Expense.paid_by_person_id = Y
 *       AND Expense.relationship_type ∈ {shared, paid_on_behalf, household_shared_flat}
 *       AND the line's resolved beneficiary = X
 *
 * NetBalance(X, Y) =
 *   GrossObligation(X owes Y) − GrossObligation(Y owes X)
 *   − Σ Settlement.amount where the linked Payment moved from X to Y
 *   + Σ Settlement.amount where the linked Payment moved from Y to X
 * ```
 *
 * These functions read only what they are given. An unobservable settlement between two
 * people neither of whom is the user (`invariants.md` #9b, `scenario-analysis.md` §34)
 * simply leaves the formula's inputs unchanged — there is no branch here that assumes
 * every real-world settlement is observable, and none that throws or silently zeroes a
 * balance when one is not.
 */

import type { ReconciliationDiscrepancy } from './entities.js';
import { createsObligation } from './enums.js';
import type { ExpenseRelationshipType, PaymentDirection } from './enums.js';
import { DomainError } from './errors.js';
import type { GroupExpansionRow } from './group-expansion.js';
import type { ExpenseId, PersonId } from './ids.js';
import type { Paise } from './money.js';

/** The subset of an `Expense` that obligation arithmetic reads. */
export interface BalanceExpense {
  readonly id: ExpenseId;
  readonly relationshipType: ExpenseRelationshipType;
  /** Who fronted the money. Obligations run **to** this person (ADR-0006). */
  readonly paidByPersonId: PersonId;
}

/**
 * One line of an expense's **current** allocation.
 *
 * Only current (non-superseded) allocations are passed in: an `Allocation` is
 * APPROVED-classified data, so its existence already means the split was approved, and a
 * superseded version has been replaced by a newer decision (`invariants.md` #6).
 */
export interface BalanceAllocationLine {
  readonly expenseId: ExpenseId;
  readonly beneficiaryType: 'person' | 'group';
  readonly beneficiaryId: string;
  readonly amount: Paise;
  /**
   * Required when `beneficiaryType === 'group'`. Balance always reads the expansion and
   * never the raw group line — a `Group` is never a debtor (`invariants.md` #2b).
   */
  readonly groupExpansion?: readonly GroupExpansionRow[];
}

/**
 * A settlement, projected against its linked `Payment`.
 *
 * `direction` comes from `payments.direction`, which is where a settlement's direction
 * lives — it is deliberately not stored a second time on `settlements` (ADR-0007).
 */
export interface BalanceSettlement {
  readonly counterpartyPersonId: PersonId;
  readonly direction: PaymentDirection;
  readonly amount: Paise;
}

export interface BalanceInput {
  /** The `Person` representing the system's own `User` — one end of every settlement. */
  readonly userPersonId: PersonId;
  readonly expenses: readonly BalanceExpense[];
  readonly currentAllocationLines: readonly BalanceAllocationLine[];
  readonly settlements: readonly BalanceSettlement[];
}

/** One beneficiary's debt to one payer, arising from one expense. */
export interface ObligationContribution {
  readonly debtorId: PersonId;
  readonly creditorId: PersonId;
  readonly amount: Paise;
  readonly expenseId: ExpenseId;
}

/**
 * The three-value, derived, read-only annotation on a standing balance (ADR-0014).
 *
 * Purely a display concern. It never mutates `NetBalance`, is never an `AIInference`, and
 * cannot itself mark a debt as cleared — only a real `Settlement` backed by a real
 * `Payment` does that.
 */
export type ObligationEvidenceStatus =
  'open_unconfirmed' | 'believed_settled_unconfirmed_by_ledger' | 'settled_confirmed';

/**
 * Every obligation the ledger's current allocations imply.
 *
 * A line whose resolved beneficiary is the expense's payer records that person's own
 * share and creates nothing (`invariants.md` #2a). `personal` and `gift` expenses never
 * reach this function's debt-creating branch at all — they are excluded by construction,
 * not filtered out afterwards.
 */
export function computeObligations(input: BalanceInput): readonly ObligationContribution[] {
  const expensesById = new Map(input.expenses.map((expense) => [expense.id, expense]));
  const obligations: ObligationContribution[] = [];

  for (const line of input.currentAllocationLines) {
    const expense = expensesById.get(line.expenseId);
    if (expense === undefined) {
      throw new DomainError(
        'UNKNOWN_REFERENCE',
        `Allocation line references expense ${line.expenseId}, which was not supplied to the ` +
          'balance computation.',
        { expenseId: line.expenseId },
      );
    }
    if (!createsObligation(expense.relationshipType)) continue;

    for (const share of resolveLineShares(line)) {
      if (share.personId === expense.paidByPersonId) continue; // the payer's own share
      if (share.amount === 0n) continue; // a zero share is no debt
      obligations.push({
        debtorId: share.personId,
        creditorId: expense.paidByPersonId,
        amount: share.amount,
        expenseId: expense.id,
      });
    }
  }
  return obligations;
}

/** `GrossObligation(debtor owes creditor)` — settlements are not netted in here. */
export function computeGrossObligation(
  input: BalanceInput,
  debtorId: PersonId,
  creditorId: PersonId,
): Paise {
  let total = 0n;
  for (const obligation of computeObligations(input)) {
    if (obligation.debtorId === debtorId && obligation.creditorId === creditorId) {
      total += obligation.amount;
    }
  }
  return total as Paise;
}

/**
 * Resolves which way the money moved for a settlement.
 *
 * A settlement is always anchored to a `Payment` through an account the user owns, so one
 * end is always the user's `Person`; `direction` decides which end.
 */
export function settlementParties(
  settlement: BalanceSettlement,
  userPersonId: PersonId,
): { readonly fromPersonId: PersonId; readonly toPersonId: PersonId } {
  return settlement.direction === 'debit'
    ? { fromPersonId: userPersonId, toPersonId: settlement.counterpartyPersonId }
    : { fromPersonId: settlement.counterpartyPersonId, toPersonId: userPersonId };
}

/**
 * `NetBalance(X, Y)`. Positive means X owes Y; negative means Y owes X.
 *
 * Always recomputed, never stored (`domain-model.md`, Obligation/Balance).
 */
export function computeNetBalance(
  input: BalanceInput,
  personXId: PersonId,
  personYId: PersonId,
): Paise {
  let net = computeGrossObligation(input, personXId, personYId);
  net = (net - computeGrossObligation(input, personYId, personXId)) as Paise;

  for (const settlement of input.settlements) {
    const { fromPersonId, toPersonId } = settlementParties(settlement, input.userPersonId);
    if (fromPersonId === personXId && toPersonId === personYId) {
      net = (net - settlement.amount) as Paise;
    } else if (fromPersonId === personYId && toPersonId === personXId) {
      net = (net + settlement.amount) as Paise;
    }
  }
  return net;
}

/** What `obligationEvidenceStatus` needs from the most recent reconciliation run. */
export interface ReconciliationEvidence {
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
}

export interface ObligationEvidenceInput {
  readonly netBalance: Paise;
  /** The expenses whose lines contribute to this pair's balance. */
  readonly contributingExpenseIds: readonly ExpenseId[];
  /** Expenses referenced by a `manual_note` `Evidence` row claiming the debt was cleared. */
  readonly manualNoteExpenseIds: readonly ExpenseId[];
  readonly latestReconciliationRun: ReconciliationEvidence | null;
  readonly personAId: PersonId;
  readonly personBId: PersonId;
}

/**
 * Annotates a standing balance so the product can show *"an obligation is expected here,
 * but this ledger has no settlement evidence for it"* rather than a bare number.
 *
 * Computed entirely from data already in the model — no fabricated `Payment` or
 * `Settlement` is ever involved (`invariants.md` #9b).
 *
 * @remarks
 * A zero balance reports `settled_confirmed`, exactly as ADR-0014 states. For two people
 * with no shared history the balance is also zero; callers decide whether a pair with no
 * obligations is worth displaying a status for at all — that is a presentation question,
 * not a ledger fact this function should invent an answer to.
 */
export function obligationEvidenceStatus(input: ObligationEvidenceInput): ObligationEvidenceStatus {
  if (input.netBalance === 0n) return 'settled_confirmed';

  const contributing = new Set(input.contributingExpenseIds);
  const hasManualNote = input.manualNoteExpenseIds.some((expenseId) => contributing.has(expenseId));
  if (hasManualNote) return 'believed_settled_unconfirmed_by_ledger';

  const magnitude = absolutePaise(input.netBalance);
  const externalSuggestsLower = (input.latestReconciliationRun?.discrepancies ?? []).some(
    (discrepancy) => {
      if (discrepancy.externalNetBalance === undefined) return false;
      if (!matchesPair(discrepancy, input.personAId, input.personBId)) return false;
      return absolutePaise(discrepancy.externalNetBalance) < magnitude;
    },
  );
  if (externalSuggestsLower) return 'believed_settled_unconfirmed_by_ledger';

  return 'open_unconfirmed';
}

/* ------------------------------------------------------------------------- internals */

/**
 * Resolves a line into the individual people who actually bear it.
 *
 * A `person` line is itself; a `group` line is its expansion rows and never the group.
 */
function resolveLineShares(line: BalanceAllocationLine): readonly GroupExpansionRow[] {
  if (line.beneficiaryType === 'person') {
    return [{ personId: line.beneficiaryId as PersonId, amount: line.amount }];
  }
  const expansion = line.groupExpansion;
  if (expansion === undefined || expansion.length === 0) {
    throw new DomainError(
      'GROUP_EXPANSION_MISSING',
      `Group-typed allocation line for group ${line.beneficiaryId} has no ` +
        'AllocationLineGroupExpansion rows. Balance reads only the expansion, so an ' +
        'unexpanded group line would silently contribute no obligation at all ' +
        '(invariants.md #2b, ADR-0009).',
      { groupId: line.beneficiaryId, expenseId: line.expenseId },
    );
  }
  return expansion;
}

function absolutePaise(value: Paise): bigint {
  const raw: bigint = value;
  return raw < 0n ? -raw : raw;
}

function matchesPair(
  discrepancy: { readonly personAId?: PersonId; readonly personBId?: PersonId },
  personAId: PersonId,
  personBId: PersonId,
): boolean {
  if (discrepancy.personAId === undefined || discrepancy.personBId === undefined) return false;
  return (
    (discrepancy.personAId === personAId && discrepancy.personBId === personBId) ||
    (discrepancy.personAId === personBId && discrepancy.personBId === personAId)
  );
}
