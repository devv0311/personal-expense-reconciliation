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

export interface ExpensePage {
  readonly expenses: readonly ExpenseLedgerRow[];
  /** How many match across the whole ledger, not how many were returned (audit row 32). */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
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
  /** SHA-256 of `generatedText`, server-derived. Echoed back on send to pin what was read. */
  readonly contentDigest: string;
  readonly evidenceReferences: readonly ProofPackEvidenceRef[];
  readonly warnings: readonly ProofPackWarning[];
  readonly pack: ProofPack;
}

/* ------------------------------------------------------------------- proof-pack delivery */

/**
 * What this installation can actually send, if anything (ADR-0053).
 *
 * Read before the send form is shown, so an installation with no credentials states that
 * plainly rather than letting somebody type a phone number and then fail.
 */
export interface MessagingStatus {
  readonly transportId: string;
  readonly channel: string;
  readonly label: string;
  readonly configured: boolean;
  readonly unavailableReason?: string;
  readonly supportsAttachments: boolean;
  readonly endpointHost?: string;
  readonly maxAttachmentBytes?: number;
  readonly attachableEvidenceTypes: readonly string[];
  readonly maxAttempts: number;
}

export interface DeliveryAttachmentRecord {
  readonly evidenceId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

export const PROOF_PACK_DELIVERY_STATUSES = ["pending", "sent", "delivered", "failed"] as const;
export type ProofPackDeliveryStatus = (typeof PROOF_PACK_DELIVERY_STATUSES)[number];

/** One record of a pack having been put in front of somebody. Never a settlement. */
export interface ProofPackDelivery {
  readonly id: string;
  readonly recipientPersonId: string;
  readonly recipientDisplayName: string;
  readonly channel: string;
  readonly address: string;
  readonly bodyText: string;
  readonly contentDigest: string;
  readonly attachments: readonly DeliveryAttachmentRecord[];
  readonly packAsOf: string;
  readonly status: ProofPackDeliveryStatus;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly providerMessageId: string | null;
  readonly transportId: string;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
  readonly retryable: boolean;
}

export interface SendProofPackResult {
  readonly delivery: ProofPackDelivery;
  /** `false` when an identical pack had already gone and nothing was sent a second time. */
  readonly sentNow: boolean;
}

/* ---------------------------------------------------------------- live balance providers */

/** What this installation can read live, if anything (ADR-0054). */
export interface BalanceProviderStatus {
  readonly providerId: string;
  readonly label: string;
  readonly configured: boolean;
  readonly unavailableReason?: string;
  readonly endpointHost?: string;
  readonly linkedAccountCount: number;
  /** Always true. Restated by the API so the rule is not the screen's to remember. */
  readonly readingsAreNeverBoundaries: true;
}

export interface AccountProviderLink {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly externalAccountRef: string;
  readonly providerLabel: string | null;
  readonly linkedAt: string;
  readonly archivedAt: string | null;
  readonly accountName: string;
  readonly accountType: string;
  readonly accountLast4: string | null;
}

/** One thing a provider said about one account at one instant. Never a boundary. */
export interface AccountBalanceReading {
  readonly id: string;
  readonly accountId: string;
  readonly accountProviderLinkId: string;
  readonly providerId: string;
  readonly balance: string | null;
  readonly currency: string;
  readonly asOf: string | null;
  readonly fetchedAt: string;
  readonly status: "ok" | "unavailable";
  readonly failureReason: string | null;
  readonly readComplete: boolean;
  readonly readIncompleteReason: string | null;
}

export interface BalanceReadCompleteness {
  readonly requested: number;
  readonly answered: number;
  readonly complete: boolean;
  readonly incompleteReason?: string;
}

export interface RefreshBalancesResult {
  readonly provider: BalanceProviderStatus;
  readonly completeness: BalanceReadCompleteness;
  readonly readings: readonly AccountBalanceReading[];
  readonly fetchedAt: string;
}

export interface BalanceComparison {
  readonly verdict: "agrees" | "differs" | "not_comparable";
  readonly difference: string | null;
  readonly usability: "fresh" | "stale" | "unusable";
  readonly caveat?: string;
}

export interface AccountBalanceComparison {
  readonly accountId: string;
  readonly accountName: string;
  readonly reading: AccountBalanceReading | null;
  readonly linked: boolean;
  readonly comparison: BalanceComparison | null;
  readonly ledgerFigure: string | null;
}

export interface BalanceComparisonResult {
  readonly comparedTo: string;
  readonly provider: BalanceProviderStatus;
  readonly comparisons: readonly AccountBalanceComparison[];
  readonly note: string;
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

/** Something the statement reader read but wants the person to know. Never swallowed. */
export interface StatementImportWarning {
  readonly lineNumber: number | null;
  readonly message: string;
}

/**
 * What `POST /api/imports/statement` answers, over and above the CSV endpoint's result.
 *
 * `warnings` is the part that has to reach the screen. A PDF has no column structure, so the
 * reader can only report how many movements it *matched* — and, separately, how many dated
 * lines it saw and could not read. Dropping either would turn "nine is what we matched" into
 * "your statement had nine transactions", which is the silent-shortfall this ledger exists to
 * prevent.
 *
 * `closingBalanceCandidate` is a candidate and nothing more: importing never writes a cash
 * boundary (ADR-0017, 17.5).
 */
export type MultiFormatImportResult = ImportStatementResult & {
  readonly formatId: string;
  readonly warnings: readonly StatementImportWarning[];
  readonly closingBalanceCandidate: string | null;
  /**
   * What the import did about reading the rows it just wrote.
   *
   * The import reads them in the same request, so a person never has to know that reading is a
   * separate thing that happens. `ran: false` carries a sentence — a re-import had nothing new
   * to read, or the reading did not finish — and the import itself is unaffected either way:
   * those rows are committed.
   */
  readonly prepared: PreparedImport | undefined;
};

/**
 * What `POST /api/imports/preview` says about a file, before anything is imported (ADR-0066).
 *
 * Every figure here was computed by the API. `accountKind` is what the document says it is a
 * statement of — `bank` or `card` — and an import screen offers only accounts of that kind,
 * because the import refuses any other (ADR-0067); `null` when the document does not say, as a
 * CSV or XLSX never does. Nothing about reading a file writes anything.
 */
export type StatementPreview =
  | {
      readonly readable: true;
      readonly formatId: string;
      readonly formatLabel: string;
      readonly accountKind: string | null;
      readonly checksPrintedBalances: boolean;
      readonly movementCount: number;
      readonly debitCount: number;
      readonly creditCount: number;
      readonly totalDebits: string;
      readonly totalCredits: string;
      readonly firstDate: string | null;
      readonly lastDate: string | null;
      readonly closingBalance: string | null;
      readonly warnings: readonly string[];
      readonly alreadyImported: {
        readonly importBatchId: string;
        readonly importedAt: string;
      } | null;
    }
  | {
      readonly readable: false;
      readonly formatId: string;
      readonly problems: readonly { readonly lineNumber: number; readonly message: string }[];
    };

export type PreparedImport =
  | { readonly ran: true; readonly analysis: AnalysisResult }
  | { readonly ran: false; readonly reason: string };

/* --------------------------------------------------------------------------- overview */

/**
 * A figure, and whether the ledger can stand behind it.
 *
 * When `known` is false the screen says so in words. It never prints the amount as if it were
 * the answer: a summary reading ₹0 is indistinguishable from a summary that has not finished
 * looking, and that is the one confusion this product cannot afford.
 */
export interface OverviewFigure {
  readonly known: boolean;
  readonly amount: string | null;
  readonly unknownReason?: string;
}

export interface OverviewResult {
  readonly spending: {
    readonly period: { readonly start: string; readonly end: string };
    readonly total: OverviewFigure;
    readonly categories: readonly {
      readonly category: string | null;
      readonly netTotal: string;
      readonly expenseCount: number;
    }[];
    readonly caveats: { readonly excludes: readonly string[] };
  };
  readonly unexplained: {
    readonly total: OverviewFigure;
    readonly movementCount: number;
    readonly scanned: number;
    readonly complete: boolean;
    /** The newest few movements the total is made of — a sample, not the set. */
    readonly movements: readonly OverviewActivity[];
  };
  /** What is on file and has not been looked at yet. */
  readonly readiness: AnalysisReadiness;
  readonly attention: {
    /** The same number **Needs attention** shows — the queue plus the questions it never held. */
    readonly total: number;
    readonly reviewQueueTotal: number;
    readonly counts: Record<string, number>;
  };
  readonly people: {
    readonly toCollect: OverviewFigure;
    readonly toPay: OverviewFigure;
    readonly counterparties: readonly CounterpartyBalance[];
    /** Shared with, and square. Absence from `counterparties` alone cannot say this. */
    readonly settled: readonly CounterpartyBalance[];
  };
  readonly recent: readonly OverviewActivity[];
  readonly empty: boolean;
}

/** One person's standing balance. `netBalance` is signed: a leading `-` means the user owes. */
export interface CounterpartyBalance {
  readonly personId: string;
  readonly displayName: string;
  readonly netBalance: string;
  readonly contributingExpenseCount: number;
}

export interface OverviewActivity {
  readonly paymentId: string;
  readonly occurredAt: string;
  readonly description: string;
  readonly amount: string;
  readonly direction: "debit" | "credit";
  readonly status: "understood" | "needs_context";
}

/* ================================================= phase C — one event, and what it needs */

/**
 * A figure, and whether the ledger can stand behind it.
 *
 * Same contract as `OverviewFigure`, kept as its own name because the two reads are separate
 * and one is not derived from the other. `known: false` renders as words, never as an amount.
 */
export interface ConnectionFigure {
  readonly known: boolean;
  readonly amount: string | null;
  readonly unknownReason?: string;
}

/** What one supporting record says, in the terms the record itself uses. */
export interface ConnectionRecordReading {
  readonly name: string | null;
  readonly amount: string | null;
  readonly reference: string | null;
  readonly occurredAt: string | null;
}

export interface ConnectionSupportingRecord {
  readonly evidenceId: string;
  /** 'Bill or receipt', 'Screenshot', 'Payment message', 'Note you wrote'. */
  readonly label: string;
  /** The stored type. Details disclosure only. */
  readonly evidenceType: string;
  readonly capturedAt: string;
  /** `null` when the record is attached but nothing has read it. */
  readonly reading: ConnectionRecordReading | null;
}

export interface ConnectionProposal {
  readonly candidateId: string;
  readonly evidenceId: string;
  readonly label: string;
  readonly evidenceType: string;
  readonly capturedAt: string;
  readonly status: string;
  /** Plain sentences the API wrote. Never a signal name, never a score. */
  readonly whyRelated: readonly string[];
  readonly whyUnsure: readonly string[];
  readonly decidedAt: string | null;
}

export interface ConnectionShare {
  readonly name: string;
  readonly isYou: boolean;
  readonly amount: string;
  readonly beneficiaryKind: "person" | "group";
  readonly members: readonly { readonly name: string; readonly amount: string }[] | null;
}

export interface ConnectionRefund {
  readonly adjustmentId: string;
  readonly label: string;
  readonly amount: string;
  readonly occurredAt: string;
}

export interface ConnectionExpense {
  readonly expenseId: string;
  readonly whatItWas: string | null;
  readonly category: string | null;
  readonly grossAmount: string;
  readonly netAmount: string;
  readonly fundedByThisPayment: string;
  readonly paidBy: { readonly personId: string; readonly name: string; readonly isYou: boolean };
  /** `null` when nobody has been named — never an empty list, which reads as "nobody". */
  readonly shares: readonly ConnectionShare[] | null;
  readonly sharesUnknownReason: string | null;
  /** What the shares mean for who owes whom. The API's sentence — never inferred here. */
  readonly obligationNote: string | null;
  readonly refunds: readonly ConnectionRefund[];
  readonly state: ExpenseState;
}

export interface ConnectionSettlement {
  readonly settlementId: string;
  readonly counterpartyName: string;
  readonly amount: string;
  readonly label: string;
}

export interface ConnectionRefundOf {
  readonly adjustmentId: string;
  readonly expenseId: string;
  readonly whatItWas: string | null;
  readonly label: string;
  readonly amount: string;
}

export interface ConnectionDisagreement {
  readonly about: string;
  readonly detail: string;
  readonly values: readonly string[];
}

export const PAYMENT_NATURES = [
  "duplicate",
  "transfer",
  "investment",
  "settlement",
  "refund",
  "spending",
  "money_in",
  "not_yet_known",
] as const;
export type PaymentNature = (typeof PAYMENT_NATURES)[number];

/** The best name this event has, and which of the four sources established it. */
export interface ConnectionTitle {
  readonly text: string;
  readonly source: "counterparty" | "record" | "expense" | "narration";
}

export interface ConnectionResult {
  readonly paymentId: string;
  readonly nature: PaymentNature;
  readonly title: ConnectionTitle;
  readonly merchantName: string | null;
  /** The bank's own words. Immutable source — behind Details, never the headline. */
  readonly narration: string;
  readonly occurredAt: string;
  readonly amount: string;
  readonly direction: "debit" | "credit";
  readonly accountName: string;
  readonly countsAsSpending: boolean;
  readonly whyNotSpending: string | null;
  readonly spendingContribution: string;
  readonly unaccountedFor: ConnectionFigure;
  /** Decided by the API, never by comparing a figure to zero here. */
  readonly fullyAccountedFor: boolean;
  readonly duplicate: { readonly isDuplicate: boolean; readonly ofPaymentId: string | null };
  readonly supportingRecords: readonly ConnectionSupportingRecord[];
  readonly proposals: readonly ConnectionProposal[];
  readonly disagreements: readonly ConnectionDisagreement[];
  readonly expenses: readonly ConnectionExpense[];
  readonly settlements: readonly ConnectionSettlement[];
  readonly refundOf: readonly ConnectionRefundOf[];
  readonly openQuestions: readonly AttentionItem[];
  readonly details: {
    readonly channel: string;
    readonly reference: string | null;
    readonly referenceType: string | null;
    readonly counterpartyType: string;
    readonly paymentState: string;
    readonly cashFlowCategory: string | null;
    readonly cashFlowState: string;
    readonly importBatchId: string;
    readonly currency: string;
  };
}

/* --------------------------------------------------------- phase C — the real questions */

export type AttentionFactKind = "text" | "money" | "date" | "unknown";

/**
 * One fact needed to answer a question, typed rather than pre-formatted.
 *
 * The API says what kind of thing the value is and this package renders it — an amount through
 * `Money`, an instant through `formatDate`. `unknown` carries `null` and is rendered in words,
 * so a total nobody has read off a document can never print as `₹0.00`.
 */
export interface AttentionFact {
  readonly label: string;
  readonly kind: AttentionFactKind;
  readonly value: string | null;
}

export type AttentionSubject =
  | { readonly kind: "payment"; readonly paymentId: string }
  | { readonly kind: "payment_pair"; readonly paymentId: string; readonly otherPaymentId: string }
  | { readonly kind: "evidence"; readonly evidenceId: string }
  | { readonly kind: "expense"; readonly expenseId: string };

export interface AttentionItem {
  readonly id: string;
  readonly source: "review_queue" | "ledger";
  /** The review kind, or a ledger-derived one. A value this UI has not been taught still renders. */
  readonly kind: string;
  readonly question: string;
  readonly why: string;
  readonly reasons: readonly string[];
  readonly amount: { readonly known: boolean; readonly value: string | null };
  readonly occurredAt: string;
  readonly facts: readonly AttentionFact[];
  readonly subject: AttentionSubject;
  /** The queue item, when there is one — what the existing inspector answers. */
  readonly item: ReviewQueueItem | null;
  readonly suggestion: AttentionSuggestion | null;
}

/**
 * What a payment looks like it was for, with the reason and the other sensible answers.
 *
 * `countsAsPurchase` is the field a screen must read before it offers anything: a statement's
 * tax lines, instalment interest and repayments are not purchases of their own, and agreeing
 * with a category on one of them is how the same money reaches a total twice.
 */
/** The approved pattern that led a suggestion, so the screen can name it (ADR-0064). */
export interface AppliedRule {
  readonly ruleId: string;
  readonly ruleName: string;
  /** The text that matched. Shown so a person can see what fired and go and narrow it. */
  readonly wording: string;
  readonly category: string;
  readonly why: string;
}

export interface AttentionSuggestion {
  readonly inferenceId: string | null;
  readonly category: string | null;
  readonly confidence: ConfidenceLevel;
  readonly why: readonly string[];
  readonly alternatives: readonly { readonly category: string; readonly why: string }[];
  readonly everyCategory: readonly string[];
  readonly countsAsPurchase: boolean;
  /** Set when one of the person's own approved patterns chose this category. */
  readonly appliedRule?: AppliedRule | null;
}

export interface AttentionResult {
  readonly items: readonly AttentionItem[];
  readonly counts: Readonly<Record<ReviewItemKind, number>>;
  readonly reviewQueueTotal: number;
  readonly total: number;
  readonly truncated: boolean;
}

/* ============================================== phases D and E — analysing and explaining */

export interface AnalysisReadiness {
  readonly recordsAwaitingAnalysis: number;
  readonly documentsAwaitingAnalysis: number;
}

export const ANALYSIS_STAGES = ["read_records", "work_out_purpose", "connect_records"] as const;
export type AnalysisStageName = (typeof ANALYSIS_STAGES)[number];
export type AnalysisStageStatus = "done" | "partial" | "skipped" | "failed";

export interface AnalysisStage {
  readonly name: AnalysisStageName;
  readonly status: AnalysisStageStatus;
  /** One sentence the API wrote. Rendered as-is; never a state name or a code. */
  readonly summary: string;
  readonly unfinishedReason?: string;
  readonly recordsTouched: number;
}

export interface AnalysisResult {
  readonly recordsChecked: number;
  readonly connectionsFound: number;
  readonly suggestionsReady: number;
  readonly questionsForYou: number;
  readonly notUnderstood: number;
  readonly stages: readonly AnalysisStage[];
  /** False when any stage was skipped or failed. A screen must not say "done" over this. */
  readonly complete: boolean;
}

/* ----------------------------------------------------------------------- what you spent */

export interface SpendingMonth {
  readonly month: string;
  readonly netTotal: string;
  readonly expenseCount: number;
}

export interface SpendingSummaryResult {
  readonly period: { readonly start: string; readonly end: string };
  readonly total: OverviewFigure;
  readonly categories: readonly {
    readonly category: string | null;
    readonly netTotal: string;
    readonly grossTotal: string;
    readonly expenseCount: number;
  }[];
  readonly months: readonly SpendingMonth[];
  readonly own: {
    readonly share: string;
    readonly paidByYou: string;
    readonly frontedForOthers: string;
  };
  readonly cameBack: { readonly total: string };
  readonly unaccountedFor: {
    readonly total: OverviewFigure;
    readonly movementCount: number;
    readonly movements: readonly OverviewActivity[];
  };
  readonly caveats: AnalyticsCaveats;
}

/* --------------------------------------------------------------- one person's balance */

export interface PersonContribution {
  readonly expenseId: string;
  readonly whatItWas: string | null;
  readonly occurredAt: string;
  readonly amount: string;
  readonly direction: "collect" | "pay";
  readonly paidByName: string;
  readonly paidByIsYou: boolean;
  readonly paymentId: string | null;
}

export interface PersonSettlementLine {
  readonly settlementId: string;
  readonly paymentId: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly label: string;
  readonly reason: string | null;
}

export interface PersonBalanceSummary {
  readonly personId: string;
  readonly displayName: string;
  /** Always positive; `direction` says who owes whom. */
  readonly amount: string;
  readonly direction: "collect" | "pay" | "settled";
  readonly evidenceStatus: ObligationEvidenceStatus;
  readonly contributions: readonly PersonContribution[];
  readonly settlements: readonly PersonSettlementLine[];
  readonly pendingRefundExpenseIds: readonly string[];
}

/* ------------------------------------------------------------------- a split, previewed */

export interface AllocationPreviewShare {
  readonly beneficiaryType: "person" | "group";
  readonly beneficiaryId: string;
  readonly name: string;
  readonly isYou: boolean;
  readonly amount: string;
  readonly percentage: string | null;
  readonly members: readonly { readonly name: string; readonly amount: string }[] | null;
}

export interface AllocationPreviewObligation {
  readonly personId: string;
  readonly name: string;
  readonly amount: string;
  readonly direction: "collect" | "pay";
}

export interface AllocationPreviewResult {
  readonly expenseId: string;
  readonly grossAmount: string;
  readonly netAmount: string;
  readonly method: AllocationMethod;
  readonly paidBy: { readonly personId: string; readonly name: string; readonly isYou: boolean };
  readonly shares: readonly AllocationPreviewShare[];
  readonly obligations: readonly AllocationPreviewObligation[];
  /** Why nobody would owe anything, when nobody would. The API's own sentence. */
  readonly noObligationsBecause: string | null;
  readonly replacesExistingAllocation: boolean;
  /** Why this split cannot be approved as stated. A value, so it can be read before pressing. */
  readonly refusal: { readonly code: string; readonly message: string } | null;
}

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
  /**
   * What repairing this row would do to Splitwise, as the API decided it.
   *
   * Quoted, never derived: "the net is zero, so this deletes the entry" is a conclusion drawn
   * from the figures, and drawing it here would put a second copy of the repair's own rule
   * somewhere it could drift from it (ADR-0048).
   */
  readonly plannedRepair: SplitwiseRepairKind;
}

/**
 * Which of the three repairs happened, as the API named it — never inferred here from the
 * figures (ADR-0048: the frontend reads the ledger and recomputes nothing).
 */
export type SplitwiseRepairKind = "corrected" | "withdrawn" | "recreated";

export interface ResyncResult {
  readonly splitwiseExpenseId: string;
  readonly syncStatus: "synced" | "withdrawn";
  readonly repair: SplitwiseRepairKind;
  readonly previousExternalId: string;
  readonly previousSnapshot: unknown;
  readonly pushedNetAmount: string;
}

/** A settlement Splitwise holds a different figure for. */
export interface SettlementResyncCandidate {
  readonly splitwiseSettlementId: string;
  readonly settlementId: string;
  readonly externalId: string;
  readonly syncStatus: string;
  readonly syncedAt: string;
  readonly syncedSnapshot: unknown;
  readonly currentAmount: string;
  readonly counterpartyPersonId: string;
  readonly counterpartyName: string;
  /**
   * What repairing this settlement would do to Splitwise, as the API decided it.
   *
   * `corrected` for a drifted entry, `recreated` for one somebody deleted on their side
   * (ADR-0056). Quoted here, never derived from `syncStatus` — the same rule the expense side
   * follows (ADR-0048).
   */
  readonly plannedRepair: Extract<SplitwiseRepairKind, "corrected" | "recreated">;
}

export interface SettlementResyncResult {
  readonly splitwiseTransactionId: string;
  readonly syncStatus: "synced";
  readonly repair: Extract<SplitwiseRepairKind, "corrected" | "recreated">;
  readonly previousExternalId: string;
  readonly previousSnapshot: unknown;
  readonly pushedAmount: string;
}

/**
 * What the connected adapter can actually do, sent with the list rather than assumed.
 *
 * A screen that offered a repair the port cannot make would be promising something that will
 * fail — the "reachable" half of ADR-0050 read backwards.
 */
export interface SplitwiseRepairCapability {
  readonly canCorrect: boolean;
  readonly canWithdraw: boolean;
  readonly canCorrectSettlement: boolean;
}

export interface ResyncCandidates {
  readonly candidates: readonly ResyncCandidate[];
  readonly settlements: readonly SettlementResyncCandidate[];
  readonly capability: SplitwiseRepairCapability;
}

/* -------------------------------------------------------------------------- analytics */

export interface AnalyticsPeriod {
  readonly start: string;
  /** Exclusive. */
  readonly end: string;
}

/**
 * What an aggregate deliberately leaves out, carried with every result.
 *
 * Not decoration: a total shown without these is asserting more precision than the ledger has.
 */
export interface AnalyticsCaveats {
  readonly pendingRefundExpenseIds: readonly string[];
  readonly excludes: readonly string[];
}

export interface CategorySpend {
  readonly category: string | null;
  readonly netTotal: string;
  readonly grossTotal: string;
  readonly expenseCount: number;
}

export interface CategorySpendResult {
  readonly period: AnalyticsPeriod;
  readonly categories: readonly CategorySpend[];
  readonly netTotal: string;
  readonly caveats: AnalyticsCaveats;
}

export interface MonthlySpend {
  readonly month: string;
  readonly netTotal: string;
  readonly expenseCount: number;
}

export interface MonthlySpendResult {
  readonly period: AnalyticsPeriod;
  readonly months: readonly MonthlySpend[];
  readonly caveats: AnalyticsCaveats;
}

export interface OwnSpendResult {
  readonly period: AnalyticsPeriod;
  /** The user's own share — what they actually spent, as distinct from what passed through. */
  readonly ownShare: string;
  readonly paidByUser: string;
  readonly frontedForOthers: string;
  readonly caveats: AnalyticsCaveats;
}

export interface CounterpartyBalance {
  readonly personId: string;
  readonly displayName: string;
  /** Positive means they owe the user; negative the reverse. Quoted, never derived. */
  readonly netBalance: string;
  readonly contributingExpenseCount: number;
}

export interface OutstandingResult {
  readonly counterparties: readonly CounterpartyBalance[];
  readonly totalOwedToUser: string;
  readonly totalOwedByUser: string;
  readonly caveats: AnalyticsCaveats;
}

export interface UnsettledPaidOnBehalf {
  readonly expenseId: string;
  readonly description: string | null;
  readonly occurredAt: string;
  readonly netAmount: string;
  readonly owedToUser: string;
  readonly beneficiaries: readonly { readonly personId: string; readonly displayName: string }[];
}

export interface UnsettledResult {
  readonly expenses: readonly UnsettledPaidOnBehalf[];
  readonly totalOwedToUser: string;
  readonly caveats: AnalyticsCaveats;
}

/* ------------------------------------------------------------------------------ rules */

export const RULE_TEXT_OPERATORS = ["contains", "equals", "startsWith"] as const;
export type RuleTextOperator = (typeof RULE_TEXT_OPERATORS)[number];

export const RULE_EFFECTS = ["propose", "apply"] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

export interface RuleMatchPattern {
  readonly descriptionOperator?: RuleTextOperator;
  readonly description?: string;
  readonly direction?: PaymentDirection;
  readonly channel?: PaymentChannel;
  readonly accountId?: string;
  readonly amount?: string;
}

export type RuleAssertion =
  | { readonly action: "set_counterparty_type"; readonly counterpartyType: PaymentCounterpartyType }
  | { readonly action: "set_cash_flow_category"; readonly cashFlowCategory: CashFlowCategory }
  | { readonly action: "set_expense_category"; readonly category: string };

export interface RuleView {
  readonly id: string;
  readonly name: string;
  readonly match: RuleMatchPattern;
  readonly assertion: RuleAssertion;
  readonly effect: RuleEffect;
  readonly active: boolean;
  readonly origin: string;
  readonly timesApplied: number;
  readonly lastAppliedAt: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

export interface RuleOutcome {
  readonly paymentId: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly assertion: RuleAssertion;
  readonly effect: RuleEffect;
  readonly outcome: "applied" | "proposed" | "skipped";
  readonly reason?: string;
}

export interface ApplyRulesResult {
  readonly outcomes: readonly RuleOutcome[];
  /** Payments more than one rule matched — a disagreement only a person can settle. */
  readonly conflicts: readonly {
    readonly paymentId: string;
    readonly ruleIds: readonly string[];
  }[];
}

/* -------------------------------------------------------------------------- occasions */

export interface OccasionSummary {
  readonly id: string;
  readonly name: string;
  readonly occurredStart: string;
  readonly occurredEnd: string | null;
  readonly defaultParticipants: unknown;
  readonly createdAt: string;
  /** How many expenses it groups. A count, never a sum of money. */
  readonly expenseCount: number;
}

/* ------------------------------------------------------------------------------- jobs */

export const JOB_KINDS = [
  "import_bank_statement_csv",
  "normalize_payments",
  "classify_payments",
  "extract_receipt",
  "run_splitwise_audit",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobRecord {
  readonly id: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly payload: Record<string, unknown>;
  readonly result: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly actor: string;
  readonly scheduledFor: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export interface JobListResult {
  readonly jobs: readonly JobRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/* ============================ Splitwise remote-to-local change discovery (ADR-0056) */

/** What somebody did in Splitwise that this ledger can see and has to decide about. */
export type SplitwiseRemoteChangeKind =
  | "remote_expense_amount_changed"
  | "remote_settlement_amount_changed"
  | "remote_expense_deleted"
  | "remote_settlement_deleted"
  | "remote_expense_unlinked"
  | "remote_settlement_unlinked"
  | "remote_person_unmapped"
  | "remote_duplicate_candidate";

/**
 * What accepting a change writes, as the API decided it.
 *
 * Quoted here, never derived: which effect a kind carries is the service's own rule, and a
 * second copy of it in the browser is a copy that can drift (ADR-0048).
 */
export type SplitwiseRemoteChangeEffect =
  | "record_drift"
  | "record_external_deletion"
  | "adopt_expense_link"
  | "adopt_settlement_link"
  | "map_person"
  | "none";

export type SplitwiseRemoteChangeStatus = "proposed" | "accepted" | "rejected";

export const SPLITWISE_REMOTE_CHANGE_STATUSES: readonly SplitwiseRemoteChangeStatus[] = [
  "proposed",
  "accepted",
  "rejected",
];

export interface SplitwiseRemoteChange {
  readonly id: string;
  readonly remoteReadId: string;
  readonly lastObservedReadId: string;
  readonly kind: SplitwiseRemoteChangeKind;
  readonly effect: SplitwiseRemoteChangeEffect;
  readonly summary: string;
  /** What accepting will do, in words the API composed. */
  readonly consequence: string;
  /** How complete the read this was seen under was. `complete` is not the only honest answer. */
  readonly readStatus: SplitwiseExternalReadStatus;
  readonly readDetail: string | null;
  readonly personAId: string | null;
  readonly personBId: string | null;
  readonly expenseId: string | null;
  readonly settlementId: string | null;
  readonly externalReference: string | null;
  readonly externalUserReference: string | null;
  readonly amount: string | null;
  readonly localSnapshot: unknown;
  readonly remoteSnapshot: unknown;
  readonly subjects: unknown;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly status: SplitwiseRemoteChangeStatus;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly appliedEffect: SplitwiseRemoteChangeEffect | null;
  readonly appliedTargetId: string | null;
  readonly supersededAt: string | null;
  readonly supersededByChangeId: string | null;
}

export interface SplitwiseRemoteRead {
  readonly id: string;
  readonly runAt: string;
  readonly externalReadStatus: SplitwiseExternalReadStatus;
  readonly externalReadDetail: string | null;
  readonly pairsRead: number;
  readonly pairsUnchecked: number;
  readonly changesCreated: number;
  readonly changesReobserved: number;
  readonly changesSuperseded: number;
}

export interface SplitwiseRemoteChangeDetail {
  readonly change: SplitwiseRemoteChange;
  readonly discoveredBy: SplitwiseRemoteRead | null;
  readonly lastObservedBy: SplitwiseRemoteRead | null;
  /** True when accepting must name the local record to join to. */
  readonly needsTarget: boolean;
  /** False when this kind has nothing to apply — accepting is refused by name. */
  readonly acceptable: boolean;
}

export interface DiscoverRemoteChangesResult extends SplitwiseRemoteRead {
  readonly remoteReadId: string;
  readonly changes: readonly SplitwiseRemoteChange[];
}

export interface RemoteChangeDecisionResult {
  readonly changeId: string;
  readonly status: "accepted" | "rejected";
  readonly appliedEffect: string | null;
  readonly appliedTargetId: string | null;
  /** What actually happened, stated by the API so a confirmation quotes rather than guesses. */
  readonly appliedDescription: string;
}

/* ================================================ asking the ledger a question (ADR-0057) */

export interface LedgerQueryCapability {
  readonly kind: string;
  readonly answers: string;
  readonly example: string;
  readonly needsPeriod: boolean;
  readonly needsPerson: boolean;
  /** The service read every figure in an answer of this kind comes from. */
  readonly source: string;
}

export interface AskCapabilities {
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly configured: boolean;
    readonly unavailableReason?: string;
  };
  readonly queries: readonly LedgerQueryCapability[];
  readonly knownPeople: readonly string[];
  readonly knownCategories: readonly string[];
  /** Always false, and stated because it is the property that makes the surface safe. */
  readonly writes: false;
}

/** One figure in an answer. Money is exact paise as a string, formatted only for display. */
export interface LedgerAnswerFigure {
  readonly label: string;
  readonly amount: string | null;
  readonly count: number | null;
  readonly note: string | null;
}

export interface LedgerAnswerRecord {
  readonly type: "expense" | "payment" | "settlement" | "adjustment" | "person" | "finding" | "run";
  readonly id: string;
  readonly label: string;
  readonly amount: string | null;
  readonly occurredAt: string | null;
}

export interface LedgerAnswerLink {
  readonly label: string;
  readonly href: string;
}

export interface LedgerAnswer {
  readonly kind: string;
  readonly answered: boolean;
  /** How the question was read. The sentence that makes a wrong reading visible. */
  readonly interpretation: string;
  readonly headline: string;
  readonly period: { readonly start: string; readonly end: string } | null;
  readonly scope: string;
  readonly source: string | null;
  readonly figures: readonly LedgerAnswerFigure[];
  readonly records: readonly LedgerAnswerRecord[];
  readonly caveats: readonly string[];
  readonly uncertainties: readonly string[];
  readonly links: readonly LedgerAnswerLink[];
}

export interface AskResult {
  readonly question: string;
  readonly plan: {
    readonly kind: string;
    readonly period: { readonly start: string; readonly end: string } | null;
    readonly personName: string | null;
    readonly category: string | null;
    readonly searchTerm: string | null;
    readonly limit: number;
    readonly clarification: string | null;
  };
  readonly confidence: ConfidenceLevel;
  readonly modelInfo: {
    readonly provider: string;
    readonly model: string;
    readonly promptVersion: string;
  };
  readonly answer: LedgerAnswer;
}

/* ================================================= what has already been connected */

/**
 * The settled half of what **Needs attention** reports as open.
 *
 * `nameSource` is the field that keeps the row honest: on a ledger of imported statements most
 * movements have only the bank's own narration, and printing `UPI-AMZN9821PYTM` as though
 * somebody had chosen it is how a screen starts pretending to know more than it does.
 */
export interface LinkedPayment {
  readonly paymentId: string;
  readonly name: string;
  readonly nameSource: "counterparty" | "narration";
  readonly occurredAt: string;
  readonly amount: string;
  readonly direction: PaymentDirection;
}

/** Whether a person accepted an offer, or the record arrived already attached. */
export type LinkOrigin = "you_accepted" | "attached_when_added";

export interface ConfirmedLink {
  readonly evidenceId: string;
  readonly recordWords: string;
  readonly capturedAt: string;
  readonly payment: LinkedPayment | null;
  readonly noPaymentBecause?: string;
  readonly origin: LinkOrigin;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly why: readonly string[];
}

export interface ConfirmedLinksResult {
  readonly links: readonly ConfirmedLink[];
  readonly total: number;
  readonly truncated: boolean;
}

/* ================================ phase 2 — instalment timelines and quiet anomalies */

/**
 * How much the ledger knows about one step of an instalment plan (ADR-0062).
 *
 * `observed` is a row that exists; `expected` is the issuer's own count with no amount and no
 * date attached. A screen renders the word and never collapses the two — "the statement says
 * there are six" and "₹X is due" are different claims, and only one of them is a fact here.
 */
export type PositionCertainty = "observed" | "expected" | "inferred" | "unknown";

export type InstalmentComponent = "principal" | "interest" | "tax" | "fee";

export interface InstalmentCharge {
  readonly paymentId: string;
  readonly component: InstalmentComponent;
  readonly amount: string;
  readonly occurredAt: string;
  readonly narration: string;
  readonly position: number | null;
}

export interface InstalmentTimelineEntry {
  readonly number: number;
  readonly certainty: PositionCertainty;
  readonly charges: readonly InstalmentCharge[];
  readonly principal: string | null;
  readonly interest: string | null;
  readonly tax: string | null;
}

export interface InstalmentPlan {
  readonly planKey: string;
  readonly merchantName: string | null;
  /** `known: false` means no statement line stated a tenure. Never substitute a count. */
  readonly tenure: { readonly known: boolean; readonly of: number | null };
  readonly purchase: {
    readonly known: boolean;
    readonly paymentId: string | null;
    readonly amount: string | null;
    readonly occurredAt: string | null;
  };
  readonly positions: readonly InstalmentTimelineEntry[];
  readonly unpositionedCharges: readonly InstalmentCharge[];
  readonly observed: {
    readonly principal: string;
    readonly interest: string;
    readonly tax: string;
    readonly fee: string;
    readonly chargeCount: number;
  };
  readonly progress: { readonly seen: number; readonly of: number | null };
  /** What the plan does not know, in the API's own words. Rendered as-is. */
  readonly unknowns: readonly string[];
}

export interface InstalmentsResult {
  readonly plans: readonly InstalmentPlan[];
  readonly rowsRead: number;
}

export type AnomalyKind =
  "unexplained_interest" | "inconsistent_instalment" | "unusual_fee" | "repeated_charge";

export interface AnomalyEvidence {
  readonly paymentId: string;
  readonly occurredAt: string;
  readonly amount: string;
  readonly narration: string;
}

/**
 * Something worth a second look, stated as the comparison it is (ADR-0063).
 *
 * `headline` and `detail` are the API's own words and are rendered verbatim. This package must
 * not add a verdict, a severity or a recommendation to act on top of them.
 */
export interface Anomaly {
  readonly id: string;
  readonly kind: AnomalyKind;
  readonly headline: string;
  readonly detail: string;
  readonly evidence: readonly AnomalyEvidence[];
}

export interface AnomaliesResult {
  readonly anomalies: readonly Anomaly[];
  /** How many rows were compared. An empty list over a non-zero count is a real answer. */
  readonly rowsRead: number;
}

/* ================================ ADR-0064 — patterns a person may approve */

export interface LearningExample {
  readonly paymentId: string;
  readonly occurredAt: string;
  readonly narration: string;
}

/**
 * A pattern the ledger could learn, offered for approval.
 *
 * Nothing about it is active. It matches no payment and is stored nowhere until somebody
 * approves it, and the wording below is the exact text that would then be matched on.
 */
export interface LearnedRuleProposal {
  readonly id: string;
  readonly suggestedName: string;
  readonly wording: string;
  readonly operator: "contains" | "equals" | "startsWith";
  readonly category: string;
  readonly reason: string;
  readonly examples: readonly LearningExample[];
  /** What this wording would actually reach if approved (ADR-0065). */
  readonly reach: ProposalReach;
}

export interface ProposalReach {
  readonly alreadyFiled: number;
  /** The number that says a wording is too wide. Led with whenever it is not zero. */
  readonly wouldAlsoMatch: number;
  readonly examplesOfNewMatches: readonly LearningExample[];
}

/** A pattern somebody declined, kept so it can be read and brought back (ADR-0065). */
export interface DismissedPattern {
  readonly proposalKey: string;
  readonly wording: string;
  readonly category: string;
  readonly dismissedAt: string;
  readonly dismissedBy: string;
  readonly reason: string;
}

export interface RuleProposalsResult {
  readonly proposals: readonly LearnedRuleProposal[];
  readonly confirmationsRead: number;
  readonly dismissed: readonly DismissedPattern[];
}
