/**
 * Response DTOs matching the API exactly (`src/api/*-routes.ts` in the parent repo).
 *
 * Every money field crosses the wire as an exact decimal string of paise (minor units) — the
 * API's `jsonResponse` serializes every `bigint` that way (`src/api/http.ts`). These types
 * describe what the server already computed; nothing here recomputes anything financial. See
 * `money.ts` for the one and only thing this app does to a money string: format it for display.
 */

export const EXPENSE_STATES = [
  "proposed",
  "classified",
  "review_required",
  "approved",
  "allocated",
  "ready_to_sync",
  "synced",
  "reconciled",
  "rejected",
] as const;
export type ExpenseState = (typeof EXPENSE_STATES)[number];

export interface ExpenseLedgerRow {
  readonly id: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly grossAmount: string;
  readonly netAmount: string;
  readonly currency: string;
  readonly occurredAt: string;
  readonly relationshipType: string;
  readonly paidByPersonId: string;
  readonly state: ExpenseState;
}

export type ObligationEvidenceStatus =
  "open_unconfirmed" | "believed_settled_unconfirmed_by_ledger" | "settled_confirmed";

export interface ObligationContribution {
  readonly debtorId: string;
  readonly creditorId: string;
  readonly amount: string;
  readonly expenseId: string;
}

export interface BalanceResult {
  readonly personAId: string;
  readonly personBId: string;
  readonly netBalance: string;
  readonly evidenceStatus: ObligationEvidenceStatus;
  readonly contributions: readonly ObligationContribution[];
}

export interface PersonSummary {
  readonly id: string;
  readonly displayName: string;
  readonly splitwiseUserId: string | null;
  readonly isUser: boolean;
}

export interface ReconciliationTotals {
  readonly ledgerTotalOutflow: string;
  readonly ledgerTransfersTotal: string;
  readonly ledgerInvestmentsTotal: string;
  readonly ledgerSettlementsTotal: string;
  readonly ledgerExplainedTotal: string;
  readonly ledgerUnexplainedTotal: string;
}

export interface ReconciliationDiscrepancy {
  readonly kind: string;
  readonly detail: string;
  readonly personAId?: string;
  readonly personBId?: string;
  readonly externalNetBalance?: string;
  readonly resolvedAt?: string | null;
}

export interface SplitwiseBalanceSnapshotEntry {
  readonly splitwiseUserId: string;
  readonly netBalance: string;
}

export interface RunReconciliationResult {
  readonly reconciliationRunId: string;
  readonly totals: ReconciliationTotals;
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
}

export interface ReconciliationRun {
  readonly id: string;
  readonly runAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totals: ReconciliationTotals;
  readonly splitwiseBalancesSnapshot: readonly SplitwiseBalanceSnapshotEntry[] | null;
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
  readonly resolvedAt: string | null;
}

/** The shape every route's error body takes (`src/api/http.ts`, `ApiErrorBody`). */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly field?: string;
  };
}
