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
  /** One per account — ADR-0017's second identity, written by the same run (phase 16). */
  readonly accountSnapshots: readonly ReconciliationAccountSnapshot[];
  /** The phase 19 audit this run produced, or `null` when no integration is connected. */
  readonly splitwiseAuditRunId: string | null;
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

/* ============================================================ phase 21 — the review queue */

export const REVIEW_ITEM_KINDS = [
  "classification_decision",
  "possible_duplicate",
  "rejected_classification",
  "unmatched_evidence",
] as const;
export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low", "unknown"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface ReviewPaymentView {
  readonly paymentId: string;
  readonly amount: string;
  readonly currency: string;
  readonly direction: "debit" | "credit";
  readonly occurredAt: string;
  readonly description: string;
  readonly counterpartyType: string;
  readonly state: string;
}

export interface ReviewExpenseView {
  readonly expenseId: string;
  readonly state: ExpenseState;
  readonly description: string | null;
  readonly relationshipType: string;
  readonly category: string | null;
}

export interface ClassificationDecisionItem {
  readonly kind: "classification_decision";
  readonly id: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly reasons: readonly string[];
  readonly inferenceId: string;
  readonly confidence: ConfidenceLevel;
  readonly proposedAt: string;
  readonly proposedKind: "expense" | "settlement" | null;
  /** The model's structured proposal, exactly as stored. Rendered, never interpreted. */
  readonly proposal: Record<string, unknown> | null;
  readonly model: {
    readonly provider: string | null;
    readonly name: string | null;
    readonly promptVersion: string | null;
  };
  readonly payment: ReviewPaymentView;
  readonly expense: ReviewExpenseView | null;
}

export interface PossibleDuplicateItem {
  readonly kind: "possible_duplicate";
  readonly id: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly reasons: readonly string[];
  /** The later of the two — the one a reviewer would normally discard. */
  readonly payment: ReviewPaymentView;
  /** The earlier of the two — the one that would survive. */
  readonly candidate: ReviewPaymentView;
}

export interface RejectedClassificationItem {
  readonly kind: "rejected_classification";
  readonly id: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly reasons: readonly string[];
  readonly payment: ReviewPaymentView;
  readonly inferenceId: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly expenseId: string | null;
  readonly expenseState: ExpenseState | null;
}

export interface UnmatchedEvidenceCandidateMatch {
  readonly paymentId: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly description: string;
}

export interface UnmatchedEvidenceItem {
  readonly kind: "unmatched_evidence";
  readonly id: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly reasons: readonly string[];
  readonly evidenceId: string;
  readonly evidenceType: string;
  readonly storageRef: string | null;
  readonly mediaType: string | null;
  readonly byteSize: number | null;
  readonly capturedAt: string;
  readonly ingestedAt: string;
  readonly receiptId: string | null;
  readonly receiptTotal: string | null;
  readonly candidateMatches: readonly UnmatchedEvidenceCandidateMatch[];
  readonly observation: EvidenceObservationView | null;
  readonly matchCandidates: readonly EvidenceMatchCandidateView[];
}

export type ReviewQueueItem =
  | ClassificationDecisionItem
  | PossibleDuplicateItem
  | RejectedClassificationItem
  | UnmatchedEvidenceItem;

export interface ReviewQueueResult {
  readonly items: readonly ReviewQueueItem[];
  readonly counts: Readonly<Record<ReviewItemKind, number>>;
  readonly total: number;
  readonly truncated: boolean;
}

/* ==================================================== phase 21 — evidence & re-attachment */

export const EVIDENCE_MATCH_SIGNALS = [
  "reference",
  "amount",
  "direction",
  "account",
  "time",
  "merchant",
] as const;
export type EvidenceMatchSignal = (typeof EVIDENCE_MATCH_SIGNALS)[number];

export type EvidenceMatchVerdict = "matched" | "conflicted" | "absent";
export type EvidenceMatchStrength = "deterministic" | "probable" | "weak";
export type EvidenceMatchStatus = "proposed" | "accepted" | "dismissed" | "superseded";

/** One signal's verdict, with both sides of the comparison it made (ADR-0044). */
export interface EvidenceMatchSignalResult {
  readonly signal: EvidenceMatchSignal;
  readonly verdict: EvidenceMatchVerdict;
  readonly evidenceValue: string | null;
  readonly paymentValue: string | null;
  readonly detail: string;
}

export interface EvidenceObservationView {
  readonly evidenceId: string;
  readonly observedAmount: string | null;
  readonly observedDirection: "debit" | "credit" | null;
  readonly observedReference: string | null;
  readonly observedReferenceType: string | null;
  readonly observedAccountHint: string | null;
  readonly observedMerchantText: string | null;
  readonly observedOccurredAt: string | null;
  readonly derivation: "caller_supplied" | "parsed_from_text";
}

export interface EvidenceMatchCandidateView {
  readonly candidateId: string;
  readonly evidenceId: string;
  readonly paymentId: string;
  readonly strength: EvidenceMatchStrength;
  readonly confidence: ConfidenceLevel;
  readonly matchedSignals: readonly string[];
  readonly conflictingSignals: readonly string[];
  /** The per-signal verdicts, stored as JSON by the service. */
  readonly signals: readonly EvidenceMatchSignalResult[] | null;
  readonly reviewReasons: readonly string[];
  readonly status: EvidenceMatchStatus;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  /** Always `true` — a property of the design, not a computed threshold (ADR-0044). */
  readonly requiresReview: true;
  readonly matcherVersion: string;
}

export interface EvidenceRecord {
  readonly id: string;
  readonly type: string;
  readonly noteKind: string | null;
  readonly storageRef: string | null;
  readonly mediaType: string | null;
  readonly byteSize: number | null;
  readonly rawText: string | null;
  readonly capturedAt: string;
  readonly linkedPaymentId: string | null;
  readonly linkedExpenseId: string | null;
  readonly createdAt: string;
}

export interface EvidenceMatchesResult {
  readonly evidenceId: string;
  readonly candidates: readonly EvidenceMatchCandidateView[];
}

export interface DecideEvidenceMatchResult {
  readonly candidate: EvidenceMatchCandidateView;
  readonly evidence: EvidenceRecord;
  readonly outcome: "accepted" | "dismissed" | "unchanged";
}

export interface MatchEvidenceContextResult {
  readonly evidenceId: string;
  readonly observation: EvidenceObservationView | null;
  readonly candidates: readonly EvidenceMatchCandidateView[];
  readonly ambiguous: boolean;
  readonly outcome: "matched" | "unchanged" | "no_observation" | "already_linked";
}

/* ------------------------------------------------------------------------- the receipt */

export interface ReceiptItemRecord {
  readonly id: string;
  readonly receiptId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string | null;
  readonly lineTotal: string;
  readonly suggestedCategory: string | null;
}

export interface ReceiptRecord {
  readonly id: string;
  readonly evidenceId: string;
  readonly merchantId: string | null;
  readonly subtotal: string | null;
  readonly tax: string | null;
  readonly total: string | null;
  readonly currency: string;
  readonly extractionConfidence: ConfidenceLevel | null;
  readonly extractedAt: string | null;
  readonly confirmedByUser: boolean;
  readonly createdAt: string;
}

export interface ReceiptView {
  readonly receipt: ReceiptRecord;
  readonly items: readonly ReceiptItemRecord[];
  readonly itemsSubtotalDiscrepancy: string | null;
  readonly paymentDiscrepancy: string | null;
  readonly candidateMatches: readonly UnmatchedEvidenceCandidateMatch[];
}

/* --------------------------------------------------------------------- payment context */

export interface ContextValue {
  readonly value: string;
  readonly evidenceIds: readonly string[];
}

export interface ContextConflict {
  readonly field: "amount" | "direction" | "reference" | "merchant";
  readonly values: readonly ContextValue[];
  readonly detail: string;
}

export interface ContextEvidenceSource {
  readonly evidenceId: string;
  readonly evidenceType: string;
  readonly capturedAt: string;
  readonly observation: Omit<EvidenceObservationView, "evidenceId"> | null;
}

export interface ReattachedContext {
  readonly paymentId: string;
  /** `Payment.raw_description`, exactly as the bank wrote it. Never replaced. */
  readonly narration: string;
  readonly merchantCandidates: readonly ContextValue[];
  readonly references: readonly ContextValue[];
  readonly observedInstants: readonly ContextValue[];
  readonly conflicts: readonly ContextConflict[];
  readonly sources: readonly ContextEvidenceSource[];
  readonly observedSourceCount: number;
}

export interface PaymentContextResult {
  readonly context: ReattachedContext;
}

/* ==================================================== phase 21 — items, refunds, allocation */

export interface ExpenseItemRecord {
  readonly id: string;
  readonly expenseId: string;
  readonly description: string;
  readonly amount: string;
  readonly quantity: string;
  readonly receiptItemId: string | null;
}

export type RefundBasis = "none" | "whole_expense" | "item_attributed" | "mixed";

export interface RefundAllocationItemState {
  readonly expenseItemId: string;
  readonly description: string;
  readonly quantity: string;
  /** The item's original, immutable paid-cost basis — never rewritten by a refund (19.5). */
  readonly grossAmount: string;
  readonly refundedAmount: string;
  readonly netAmount: string;
}

export interface RefundAllocationLineState {
  readonly beneficiaryType: "person" | "group";
  readonly beneficiaryId: string;
  readonly expenseItemId: string | null;
  readonly amount: string;
}

export interface RefundAllocationState {
  readonly expenseId: string;
  readonly grossAmount: string;
  readonly netAmount: string;
  readonly basis: RefundBasis;
  readonly attributedReduction: string;
  readonly unattributedReduction: string;
  readonly pendingReduction: string;
  readonly pendingDistribution: boolean;
  readonly obligationsReflectAdjustments: boolean;
  readonly items: readonly RefundAllocationItemState[];
  readonly currentAllocation: {
    readonly id: string;
    readonly method: string;
    readonly total: string;
    readonly lines: readonly RefundAllocationLineState[];
  } | null;
  readonly projectedLines: readonly RefundAllocationLineState[] | null;
  readonly reviewRequired: { readonly code: string; readonly message: string } | null;
}

export const EXPENSE_ADJUSTMENT_KINDS = ["merchant_refund", "third_party_reimbursement"] as const;
export type ExpenseAdjustmentKind = (typeof EXPENSE_ADJUSTMENT_KINDS)[number];

/* ============================================ phase 21 — accounts and the cash waterfall */

export interface AccountSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly institution: string | null;
  /** A redacted trailing fragment, at most four digits. Never a full number. */
  readonly last4: string | null;
  readonly currency: string;
  readonly isActive: boolean;
  readonly archivedAt: string | null;
}

export type ReconciliationVerificationStatus = "incomplete" | "unreconciled" | "verified";

export type CashDiscrepancyKind =
  | "missing_opening_balance"
  | "missing_closing_balance"
  | "cash_balance_delta_nonzero"
  | "unexplained_debits"
  | "unexplained_credits"
  | "unpaired_internal_transfer";

export interface CashReconciliationDiscrepancy {
  readonly kind: CashDiscrepancyKind;
  readonly detail: string;
  readonly amount?: string;
  readonly paymentId?: string;
}

/**
 * ADR-0017's second identity, per account, exactly as the run stored it.
 *
 * `openingBalance`/`closingBalance`/`expectedEndingBalance`/`cashBalanceDelta` are `null` when
 * the statement evidence is missing — unknown, never zero (17.5). Nothing in `web/` may
 * substitute a zero for one of these.
 */
export interface ReconciliationAccountSnapshot {
  readonly id: string;
  readonly reconciliationRunId: string;
  readonly accountId: string;
  readonly currency: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingBalance: string | null;
  readonly closingBalance: string | null;
  readonly openingBalanceEvidenceId: string | null;
  readonly closingBalanceEvidenceId: string | null;
  readonly totalDebits: string;
  readonly totalCredits: string;
  readonly internalTransferDebits: string;
  readonly internalTransferCredits: string;
  readonly explainedDebits: string;
  readonly unexplainedDebits: string;
  readonly explainedCredits: string;
  readonly unexplainedCredits: string;
  readonly expectedEndingBalance: string | null;
  readonly cashBalanceDelta: string | null;
  readonly verificationStatus: ReconciliationVerificationStatus;
  readonly discrepancies: readonly CashReconciliationDiscrepancy[];
  readonly createdAt: string;
}

export interface AccountSnapshotsResult {
  readonly reconciliationRunId: string;
  readonly snapshots: readonly ReconciliationAccountSnapshot[];
}

/** One account's evidenced statement boundaries, as the run form submits them. */
export interface AccountBoundaryDraft {
  readonly accountId: string;
  readonly openingBalance?: string;
  readonly openingBalanceEvidenceId?: string;
  readonly closingBalance?: string;
  readonly closingBalanceEvidenceId?: string;
}

/* ======================================================== phase 21 — the Splitwise audit */

export const SPLITWISE_AUDIT_REVIEW_STATUSES = [
  "open",
  "acknowledged",
  "resolved",
  "dismissed",
] as const;
export type SplitwiseAuditReviewStatus = (typeof SPLITWISE_AUDIT_REVIEW_STATUSES)[number];

export const SPLITWISE_AUDIT_REVIEW_DECISIONS = ["acknowledged", "resolved", "dismissed"] as const;
export type SplitwiseAuditReviewDecision = (typeof SPLITWISE_AUDIT_REVIEW_DECISIONS)[number];

export const SPLITWISE_AUDIT_FINDING_CLASSES = ["discrepancy", "limitation", "incomplete"] as const;
export type SplitwiseAuditFindingClass = (typeof SPLITWISE_AUDIT_FINDING_CLASSES)[number];

export type SplitwiseExternalReadStatus =
  "complete" | "partial" | "unsupported" | "failed" | "skipped";

export interface SplitwiseAuditRun {
  readonly id: string;
  readonly runAt: string;
  readonly reconciliationRunId: string | null;
  readonly externalIntegrationId: string | null;
  readonly externalReadStatus: SplitwiseExternalReadStatus;
  readonly externalReadDetail: string | null;
  readonly pairsAudited: number;
  readonly pairsUnchecked: number;
  readonly findingsCreated: number;
  readonly findingsReobserved: number;
  readonly findingsSuperseded: number;
}

export interface SplitwiseAuditFinding {
  readonly id: string;
  readonly auditRunId: string;
  readonly lastObservedAuditRunId: string;
  readonly reconciliationRunId: string | null;
  readonly kind: string;
  readonly findingClass: SplitwiseAuditFindingClass;
  readonly scope: string;
  readonly summary: string;
  readonly confidence: ConfidenceLevel;
  readonly amount: string | null;
  /** The signed part of the pair gap this record accounts for. Attribution is earned. */
  readonly balanceImpact: string;
  readonly personAId: string | null;
  readonly personBId: string | null;
  readonly expenseId: string | null;
  readonly settlementId: string | null;
  readonly externalReference: string | null;
  readonly localSnapshot: unknown;
  readonly externalSnapshot: unknown;
  readonly evidence: unknown;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly reviewStatus: SplitwiseAuditReviewStatus;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly reviewReason: string | null;
  readonly supersededAt: string | null;
  readonly supersededByFindingId: string | null;
  readonly supersedeReason: string | null;
}

/**
 * One append-only `AuditEvent`, exactly as `db.listAuditEvents` selects it.
 *
 * Deliberately without an `id`: the read does not select one, and a surface that keyed a list
 * on a field the API never sends would look correct and silently re-render every row.
 */
export interface AuditEventRecord {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly actor: string;
  readonly occurredAt: string;
  readonly reason: string | null;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

export interface SplitwiseAuditFindingDetail {
  readonly finding: SplitwiseAuditFinding;
  readonly history: readonly AuditEventRecord[];
}

export interface SplitwiseAuditRunDetail {
  readonly run: SplitwiseAuditRun;
  readonly findings: readonly SplitwiseAuditFinding[];
}

export interface RunSplitwiseAuditResult {
  readonly splitwiseAuditRunId: string;
  readonly externalReadStatus: SplitwiseExternalReadStatus;
  readonly externalReadDetail: string | null;
  readonly pairsAudited: number;
  readonly pairsUnchecked: number;
  readonly findingsCreated: number;
  readonly findingsReobserved: number;
  readonly findingsSuperseded: number;
  readonly findings: readonly SplitwiseAuditFinding[];
}

/* =========================================================== phase 21 — the proof pack */

export type ProofPackWarningCode =
  | "NO_SHARED_HISTORY"
  | "UNRESOLVED_AUDIT_FINDINGS"
  | "PENDING_REFUND_DISTRIBUTION"
  | "REFUND_ALLOCATION_REVIEW_REQUIRED"
  | "BELIEVED_SETTLED_UNCONFIRMED"
  | "REVERSE_BALANCE_AFTER_SETTLEMENT"
  | "MIXED_LEGACY_AND_ITEM_ADJUSTMENTS"
  | "CONTRIBUTING_EXPENSE_NOT_APPROVED"
  | "CONFLICTING_EVIDENCE"
  | "MISSING_SUPPORTING_EVIDENCE";

export interface ProofPackWarning {
  readonly code: ProofPackWarningCode;
  readonly message: string;
  readonly severity: "info" | "caution";
}

export interface ProofPackEvidenceRef {
  readonly evidenceId: string;
  readonly type: string;
  readonly capturedAt: string;
  readonly label: string | null;
}

export interface ProofPackExpenseLine {
  readonly expenseId: string;
  readonly description: string;
  readonly occurredAt: string;
  readonly payer: "you" | "recipient";
  readonly shareDirection: "recipient_owes_user" | "user_owes_recipient";
  readonly grossAmount: string;
  readonly attributedItemRefunds: string;
  readonly unattributedRefunds: string;
  readonly netAmount: string;
  readonly recipientShare: string;
  readonly refundBasis: RefundBasis;
  readonly pendingDistribution: boolean;
  readonly reviewRequired: { readonly code: string; readonly message: string } | null;
  readonly conflictingEvidence: boolean;
  readonly evidence: readonly ProofPackEvidenceRef[];
}

export interface ProofPackSettlementLine {
  readonly settlementId: string;
  readonly occurredAt: string;
  readonly direction: "you_paid_recipient" | "recipient_paid_you";
  readonly amount: string;
}

export interface ProofPackAuditFindingRef {
  readonly findingId: string;
  readonly kind: string;
  readonly findingClass: string;
  readonly summary: string;
  readonly confidence: string;
  readonly reviewStatus: string;
}

export interface ProofPackParty {
  readonly personId: string;
  readonly displayName: string;
}

export interface ProofPack {
  readonly user: ProofPackParty;
  readonly recipient: ProofPackParty;
  readonly asOf: string;
  /** Positive means the user owes the recipient; negative the reverse. Quoted, never derived. */
  readonly netBalance: string;
  readonly netDirection: "recipient_owes_user" | "user_owes_recipient" | "settled";
  readonly amountOwed: string;
  readonly evidenceStatus: ObligationEvidenceStatus;
  readonly expenseLines: readonly ProofPackExpenseLine[];
  readonly settlements: readonly ProofPackSettlementLine[];
  readonly openAuditFindings: readonly ProofPackAuditFindingRef[];
  readonly warnings: readonly ProofPackWarning[];
  readonly generatedText: string;
}

export interface ProofPackPreview {
  readonly intendedRecipient: { readonly id: string; readonly displayName: string };
  readonly asOf: string;
  readonly generatedText: string;
  readonly evidenceReferences: readonly ProofPackEvidenceRef[];
  readonly warnings: readonly ProofPackWarning[];
  readonly pack: ProofPack;
}
