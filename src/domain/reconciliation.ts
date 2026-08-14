/**
 * Reconciliation arithmetic — "unexplained money is always computed, never assumed to be
 * zero" (`invariants.md` #20).
 *
 * ```
 * ledger_unexplained_total = ledger_total_outflow
 *                          − ledger_transfers_total
 *                          − ledger_investments_total
 *                          − ledger_settlements_total
 *                          − ledger_explained_total
 * ```
 *
 * The formula is scoped to **outflow** (`domain-model.md`, `ReconciliationRun`, "V1 scope,
 * explicit"). Two consequences of that scoping are not spelled out term-by-term in
 * `invariants.md` #20 and are made explicit here, because getting either wrong makes the
 * identity produce a nonsensical figure rather than a wrong-but-plausible one:
 *
 *  - **`ledger_settlements_total` counts settlements carried by a `debit` payment only.**
 *    A settlement the user *received* (`scenario-analysis.md` §29) is a credit; it never
 *    entered `ledger_total_outflow`, so subtracting it would understate unexplained money
 *    by its full amount.
 *  - **`ledger_explained_total` counts self-funded expenses only.** An externally-funded
 *    expense (§26, §27 — someone else fronted the money, ADR-0006) is a real, approved
 *    `Expense` with no `PaymentExpenseLink` and no debit through any account the user
 *    owns. Counting its net amount as explained *outflow* would drive
 *    `ledger_unexplained_total` negative by construction the moment such an expense
 *    exists.
 *
 * Both readings follow from the formula's own outflow scoping. They are recorded as a
 * decision in `docs/decisions/0016-reconciliation-outflow-scoping.md` rather than assumed.
 */

import { isNonSpendCounterparty } from './enums.js';
import type { PaymentCounterpartyType, PaymentDirection, PaymentState } from './enums.js';
import { DomainError } from './errors.js';
import type { Paise } from './money.js';

/** A payment considered by a reconciliation run. */
export interface ReconciliationPayment {
  readonly direction: PaymentDirection;
  readonly amount: Paise;
  readonly counterpartyType: PaymentCounterpartyType;
  /** `ignored` payments — confirmed duplicates and out-of-scope rows — are excluded. */
  readonly state: PaymentState;
}

/** A settlement, projected against the direction of the payment that carried it. */
export interface ReconciliationSettlement {
  readonly amount: Paise;
  readonly direction: PaymentDirection;
}

/** An `APPROVED`-or-later expense considered by a reconciliation run. */
export interface ReconciliationExpense {
  /** `domain.netAmount(expense)` — gross minus adjustments, never gross (ADR-0008). */
  readonly netAmount: Paise;
  /** True when `paid_by_person_id` is the user's `Person` (ADR-0006). */
  readonly selfFunded: boolean;
}

export interface ReconciliationInput {
  readonly payments: readonly ReconciliationPayment[];
  readonly settlements: readonly ReconciliationSettlement[];
  readonly expenses: readonly ReconciliationExpense[];
}

/** The `reconciliation_runs` ledger totals. */
export interface ReconciliationTotals {
  readonly ledgerTotalOutflow: Paise;
  readonly ledgerTransfersTotal: Paise;
  readonly ledgerInvestmentsTotal: Paise;
  readonly ledgerSettlementsTotal: Paise;
  readonly ledgerExplainedTotal: Paise;
  readonly ledgerUnexplainedTotal: Paise;
}

/**
 * Computes every `ledger_*` total for a period, in deterministic integer arithmetic.
 *
 * `ledgerUnexplainedTotal` is surfaced whatever it comes to — including when it is
 * negative, which means the ledger has over-explained its own outflow (a double-linked
 * payment, a mis-scoped period). Clamping that to zero would hide exactly the kind of
 * arithmetic error this run exists to find.
 */
export function computeUnexplained(input: ReconciliationInput): ReconciliationTotals {
  let ledgerTotalOutflow = 0n;
  let ledgerTransfersTotal = 0n;
  let ledgerInvestmentsTotal = 0n;

  for (const payment of input.payments) {
    if (payment.state === 'ignored') continue; // a confirmed duplicate is not more money
    if (payment.direction !== 'debit') continue;

    ledgerTotalOutflow += payment.amount;
    if (payment.counterpartyType === 'internal_account') {
      ledgerTransfersTotal += payment.amount;
    } else if (payment.counterpartyType === 'investment_instrument') {
      ledgerInvestmentsTotal += payment.amount;
    }
  }

  let ledgerSettlementsTotal = 0n;
  for (const settlement of input.settlements) {
    if (settlement.direction !== 'debit') continue;
    ledgerSettlementsTotal += settlement.amount;
  }

  let ledgerExplainedTotal = 0n;
  for (const expense of input.expenses) {
    if (!expense.selfFunded) continue;
    ledgerExplainedTotal += expense.netAmount;
  }

  const ledgerUnexplainedTotal =
    ledgerTotalOutflow -
    ledgerTransfersTotal -
    ledgerInvestmentsTotal -
    ledgerSettlementsTotal -
    ledgerExplainedTotal;

  return {
    ledgerTotalOutflow: ledgerTotalOutflow as Paise,
    ledgerTransfersTotal: ledgerTransfersTotal as Paise,
    ledgerInvestmentsTotal: ledgerInvestmentsTotal as Paise,
    ledgerSettlementsTotal: ledgerSettlementsTotal as Paise,
    ledgerExplainedTotal: ledgerExplainedTotal as Paise,
    ledgerUnexplainedTotal: ledgerUnexplainedTotal as Paise,
  };
}

/**
 * Re-checks invariant #20's identity against a set of totals.
 *
 * Used before a `ReconciliationRun` row is written, so a total assembled by any path other
 * than {@link computeUnexplained} still cannot persist an inconsistent snapshot.
 */
export function validateReconciliationTotals(totals: ReconciliationTotals): void {
  const expected =
    totals.ledgerTotalOutflow -
    totals.ledgerTransfersTotal -
    totals.ledgerInvestmentsTotal -
    totals.ledgerSettlementsTotal -
    totals.ledgerExplainedTotal;

  if (expected !== totals.ledgerUnexplainedTotal) {
    throw new DomainError(
      'ALLOCATION_SUM_MISMATCH',
      `ledger_unexplained_total is ${totals.ledgerUnexplainedTotal} paise but the other totals ` +
        `imply ${expected} paise (invariants.md #20).`,
      {
        stated: totals.ledgerUnexplainedTotal.toString(),
        implied: expected.toString(),
      },
    );
  }
}

/** True when this counterparty type contributes to a non-spend bucket rather than spend. */
export function isExcludedFromSpend(counterpartyType: PaymentCounterpartyType): boolean {
  return isNonSpendCounterparty(counterpartyType);
}
