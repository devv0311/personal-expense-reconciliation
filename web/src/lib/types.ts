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

/** One recorded repayment between the two people, as the balance read reports it. */
export interface BalanceSettlementLine {
  readonly settlementId: string;
  readonly paymentId: string;
  readonly fromPersonId: string;
  readonly toPersonId: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly reason: string | null;
}

export interface BalanceResult {
  readonly personAId: string;
  readonly personBId: string;
  readonly netBalance: string;
  readonly evidenceStatus: ObligationEvidenceStatus;
  readonly contributions: readonly ObligationContribution[];
  /**
   * The repayments already netted into `netBalance`.
   *
   * Gross obligations minus these settlements **is** the net, so a screen quoting one figure
   * can show both halves of it rather than leaving the subtraction unexplainable.
   */
  readonly settlements: readonly BalanceSettlementLine[];
  /**
   * Contributing expenses whose refund is recorded but not yet distributed — a caveat, not a
   * correction. `netBalance` is exactly what the current allocations say, and these have a
   * reduction no allocation reflects yet.
   */
  readonly pendingRefundExpenseIds: readonly string[];
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
  /** The `Receipt` extracted from this document, if one was. A pointer, not the extraction. */
  readonly receiptId: string | null;
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

/* ------------------------------------------------------------------ the payment workspace */

export const PAYMENT_DIRECTIONS = ["debit", "credit"] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const PAYMENT_CHANNELS = ["upi", "bank_transfer", "card", "cash", "other"] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

export const PAYMENT_COUNTERPARTY_TYPES = [
  "merchant",
  "person",
  "internal_account",
  "investment_instrument",
  "unknown",
] as const;
export type PaymentCounterpartyType = (typeof PAYMENT_COUNTERPARTY_TYPES)[number];

export const PAYMENT_REFERENCE_TYPES = [
  "upi_utr",
  "upi_rrn",
  "bank_reference",
  "card_reference",
  "merchant_order_id",
  "cheque_number",
  "other",
] as const;
export type PaymentReferenceType = (typeof PAYMENT_REFERENCE_TYPES)[number];

export const PAYMENT_STATES = ["imported", "normalized", "linked", "ignored"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * ADR-0017's cash-flow lifecycle, which runs beside the older `imported → normalized → linked`
 * one rather than replacing it. A payment has a position in both at once.
 */
export const CASH_FLOW_STATES = [
  "imported",
  "normalized",
  "cash_flow_classified",
  "approved",
] as const;
export type CashFlowState = (typeof CASH_FLOW_STATES)[number];

export const CASH_FLOW_CATEGORIES = [
  "PEER_SETTLEMENT",
  "REFUND",
  "INTERNAL_TRANSFER",
  "EXTERNAL_INFLOW",
] as const;
export type CashFlowCategory = (typeof CASH_FLOW_CATEGORIES)[number];

/** The two the schema's `CHECK` allows only on a credit (ADR-0017 (cash balance), 17.2). */
export const CREDIT_ONLY_CASH_FLOW_CATEGORIES: readonly CashFlowCategory[] = [
  "REFUND",
  "EXTERNAL_INFLOW",
];

export const ACCOUNT_TYPES = ["bank", "upi", "card", "cash", "wallet"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * One movement, with everything the ledger can say about what explains it.
 *
 * `explainedTotal` and `unexplainedTotal` are `domain.explainedAmount`'s own answers, computed
 * by the service and quoted here — this package subtracts nothing (ADR-0048). A zero
 * `unexplainedTotal` on a movement nobody has classified is not a verified zero, which is why
 * the state fields travel beside the figure rather than being collapsed into it.
 */
export interface PaymentWorkspaceItem {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly importBatchId: string;
  readonly amount: string;
  readonly currency: string;
  readonly direction: PaymentDirection;
  readonly occurredAt: string;
  readonly rawDescription: string;
  readonly channel: string;
  readonly counterpartyType: PaymentCounterpartyType;
  readonly counterpartyId: string | null;
  readonly counterpartyName: string | null;
  readonly externalReference: string | null;
  readonly referenceType: string | null;
  readonly sourceSystem: string | null;
  readonly state: PaymentState;
  readonly ignoredReason: string | null;
  readonly cashFlowCategory: CashFlowCategory | null;
  readonly cashFlowState: CashFlowState;
  readonly cashFlowApprovedAt: string | null;
  readonly cashFlowApprovedBy: string | null;
  readonly expenseLinkTotal: string;
  readonly settlementTotal: string;
  readonly adjustmentTotal: string;
  readonly evidenceCount: number;
  readonly expenseLinkCount: number;
  readonly settlementCount: number;
  readonly explainedTotal: string;
  readonly unexplainedTotal: string;
  readonly isDuplicateRepresentation: boolean;
}

export interface PaymentListResult {
  readonly payments: readonly PaymentWorkspaceItem[];
  /** Matching rows in the whole ledger, not on this page (audit row 32). */
  readonly total: number;
  /** False when `onlyUnexplained` narrowed the page after the count — say "at least", not "of". */
  readonly filteredTotalIsExact: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface CounterpartyOptions {
  readonly merchants: readonly { readonly id: string; readonly canonicalName: string }[];
  readonly people: readonly { readonly id: string; readonly displayName: string }[];
  readonly accounts: readonly { readonly id: string; readonly name: string }[];
}

export interface CashFlowDecisionResult {
  readonly paymentId: string;
  readonly cashFlowState: CashFlowState;
  readonly cashFlowCategory: CashFlowCategory | null;
}

/* -------------------------------------------------------------------- statement imports */

export interface ImportBatchSummary {
  readonly id: string;
  readonly sourceChannel: string;
  readonly fileReference: string | null;
  readonly contentHash: string | null;
  readonly parserVersion: string | null;
  readonly rowCount: number | null;
  readonly importedAt: string;
  readonly paymentCount: number;
  readonly ignoredCount: number;
}

export interface ImportHistoryResult {
  readonly batches: readonly ImportBatchSummary[];
  readonly total: number;
}

export interface ImportedDuplicate {
  readonly paymentId: string;
  readonly duplicateOfPaymentId: string;
  readonly externalReference: string;
}

/**
 * `already_imported` is a recognised no-op, not a failure: the file's content hash matched a
 * batch already on record, so nothing was written twice (`invariants.md` #10).
 */
export type ImportStatementResult =
  | {
      readonly outcome: "imported";
      readonly importBatchId: string;
      readonly contentHash: string;
      readonly paymentIds: readonly string[];
      readonly duplicates: readonly ImportedDuplicate[];
    }
  | {
      readonly outcome: "already_imported";
      readonly importBatchId: string;
      readonly contentHash: string;
      readonly previouslyImportedAt: string;
    };

export interface NormalizePaymentsResult {
  readonly normalizedPaymentIds: readonly string[];
  readonly channelRefinedCount: number;
  readonly merchantResolvedCount: number;
}

/** One entry per payment offered. A rejected answer is a fact about that payment, not the run. */
export type ClassificationOutcome =
  | { readonly outcome: "skipped"; readonly paymentId: string; readonly reason: string }
  | {
      readonly outcome: "internal_transfer";
      readonly paymentId: string;
      readonly counterLegPaymentId: string;
    }
  | {
      readonly outcome: "proposed";
      readonly paymentId: string;
      readonly inferenceId: string;
      readonly proposedKind: string;
      readonly confidence: string;
      readonly expenseId: string | null;
      readonly expenseState: ExpenseState | null;
    }
  | {
      readonly outcome: "rejected";
      readonly paymentId: string;
      readonly reason: string;
      readonly code: string;
    };

export interface ClassifyPaymentsResult {
  readonly outcomes: readonly ClassificationOutcome[];
}

/* ------------------------------------------------------------------------- master data */

export interface PersonDetail {
  readonly id: string;
  readonly displayName: string;
  readonly splitwiseUserId: string | null;
  readonly notes: string | null;
  readonly archivedAt: string | null;
  readonly isUser: boolean;
}

export interface MerchantDetail {
  readonly id: string;
  readonly canonicalName: string;
  readonly defaultCategory: string | null;
  readonly archivedAt: string | null;
  readonly aliases: readonly { readonly id: string; readonly rawPattern: string }[];
}

export interface GroupMembershipDetail {
  readonly id: string;
  readonly personId: string;
  readonly displayName: string;
  readonly joinedAt: string;
  readonly leftAt: string | null;
}

export interface GroupDetail {
  readonly id: string;
  readonly name: string;
  readonly type: string | null;
  readonly archivedAt: string | null;
  readonly memberships: readonly GroupMembershipDetail[];
}

/* ------------------------------------------------------------------- expense authoring */

export const EXPENSE_RELATIONSHIP_TYPES = [
  "personal",
  "shared",
  "paid_on_behalf",
  "gift",
  "household_shared_flat",
] as const;
export type ExpenseRelationshipType = (typeof EXPENSE_RELATIONSHIP_TYPES)[number];

export const ALLOCATION_METHODS = [
  "equal",
  "exact",
  "percentage",
  "item_based",
  "quantity_based",
  "custom",
] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

export interface BeneficiaryRef {
  readonly type: "person" | "group";
  readonly id: string;
}

export interface CreateExpenseResult {
  readonly expenseId: string;
  readonly state: ExpenseState;
  readonly fundedByPaymentIds: readonly string[];
  /** True when nobody's payment in this ledger funded it — somebody else paid (ADR-0006). */
  readonly externallyFunded: boolean;
}

export interface ExpenseFundingLink {
  readonly linkId: string;
  readonly paymentId: string;
  readonly amount: string;
}

/* ------------------------------------------------------------------------ settlements */

export interface SettlementRegisterEntry {
  readonly id: string;
  readonly paymentId: string;
  readonly counterpartyPersonId: string;
  readonly counterpartyName: string;
  readonly amount: string;
  readonly reason: string | null;
  readonly recordedAt: string;
  /** From the linked payment, which is what says which way the money actually moved. */
  readonly direction: PaymentDirection;
  readonly occurredAt: string;
  readonly paymentDescription: string;
}

export interface SettlementRegisterResult {
  readonly settlements: readonly SettlementRegisterEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/* --------------------------------------------------------------------------- history */

export interface AllocationVersionLine {
  readonly beneficiaryType: string;
  readonly beneficiaryId: string;
  readonly beneficiaryName: string | null;
  readonly amount: string;
  readonly expenseItemId: string | null;
}

/** The current version is the single row whose `supersededAt` is null. */
export interface AllocationVersion {
  readonly allocationId: string;
  readonly method: string;
  readonly decidedAt: string;
  readonly decidedBy: string;
  readonly supersededAt: string | null;
  readonly lines: readonly AllocationVersionLine[];
}

/**
 * One event from the trail reads (`GET /api/audit/...`, `.../history`).
 *
 * Distinct from `AuditEventRecord` because it is a different `SELECT`: the trail reads carry
 * `source` and the monotonic `sequence` the log is ordered by, and a type that pretended both
 * shapes were one would have a surface reading a field the API never sent.
 */
export interface AuditTrailEvent {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly actor: string;
  readonly source: string | null;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly sequence: string;
}

export interface ExpenseHistoryResult {
  readonly expenseId: string;
  readonly allocationVersions: readonly AllocationVersion[];
  readonly events: readonly AuditTrailEvent[];
  readonly sources: {
    readonly allocationIds: readonly string[];
    readonly adjustmentIds: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly settlementIds: readonly string[];
  };
}

/* --------------------------------------------------------------------- evidence library */

export const EVIDENCE_TYPES = [
  "bank_line",
  "upi_notification",
  "receipt_image",
  "screenshot",
  "email_receipt",
  "manual_note",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Everything except `manual_note`, which is typed rather than uploaded. */
export const EVIDENCE_DOCUMENT_TYPES = EVIDENCE_TYPES.filter((type) => type !== "manual_note");

/** The two shapes the deterministic parser knows how to read (`NOTIFICATION_EVIDENCE_TYPES`). */
export const NOTIFICATION_EVIDENCE_TYPES = ["bank_line", "upi_notification"] as const;
export type NotificationEvidenceType = (typeof NOTIFICATION_EVIDENCE_TYPES)[number];

export const EVIDENCE_NOTE_KINDS = ["documentation", "settlement_claim"] as const;
export type EvidenceNoteKind = (typeof EVIDENCE_NOTE_KINDS)[number];

export interface EvidenceLibraryRow {
  readonly id: string;
  readonly type: EvidenceType;
  readonly noteKind: EvidenceNoteKind | null;
  readonly storageRef: string | null;
  readonly mediaType: string | null;
  readonly byteSize: number | null;
  readonly rawText: string | null;
  readonly capturedAt: string;
  readonly createdAt: string;
  readonly linkedPaymentId: string | null;
  readonly linkedExpenseId: string | null;
  /** Whether a `Receipt` was extracted from it — a flag, never the extraction itself. */
  readonly hasReceipt: boolean;
  readonly hasObservation: boolean;
}

export interface EvidenceLibraryResult {
  readonly evidence: readonly EvidenceLibraryRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/* ---------------------------------------------------------------------------- session */

export interface SessionIdentity {
  readonly userId: string;
  readonly personId: string | null;
  readonly email: string;
  readonly actor: string;
  readonly expiresAt: string;
}

export interface SessionState {
  /** `null` means nobody is signed in — an answer, not a failure to answer. */
  readonly session: SessionIdentity | null;
  /** Whether a password exists at all. False on a fresh installation. */
  readonly authenticationConfigured: boolean;
  /** Whether this API process is enforcing it. A local run may deliberately not be. */
  readonly authenticationRequired: boolean;
}

/* --------------------------------------------------------------------- Splitwise sync */

export interface ResyncCandidate {
  readonly splitwiseExpenseId: string;
  readonly expenseId: string;
  readonly externalId: string;
  readonly syncStatus: string;
  readonly syncedAt: string;
  /** What was pushed when it was last synced — the figure Splitwise still holds. */
  readonly syncedSnapshot: unknown;
  /** The expense's current net, which is what a re-sync would push. */
  readonly currentNetAmount: string;
  readonly description: string | null;
}

export interface ResyncResult {
  readonly splitwiseExpenseId: string;
  readonly syncStatus: "synced";
  readonly previousSnapshot: unknown;
  readonly pushedNetAmount: string;
}
