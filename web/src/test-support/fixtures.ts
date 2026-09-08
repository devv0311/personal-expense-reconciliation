/**
 * Synthetic API responses, in exactly the shape the real API sends.
 *
 * Every money field is an exact decimal string of paise, every timestamp is an ISO-8601
 * string, and nothing here is derived from anything else — these stand in for what the backend
 * computed, so a test that asserts a rendered figure is asserting the frontend quoted it rather
 * than re-deriving it. Nothing here is real financial data (`fixtures/README.md`).
 */

import type {
  AccountSnapshotsResult,
  AccountSummary,
  BalanceResult,
  ClassificationDecisionItem,
  CounterpartyOptions,
  EvidenceMatchCandidateView,
  EvidenceRecord,
  ExpenseLedgerRow,
  GroupDetail,
  ImportBatchSummary,
  MerchantDetail,
  PaymentListResult,
  PaymentWorkspaceItem,
  PersonDetail,
  PersonSummary,
  PossibleDuplicateItem,
  ProofPackPreview,
  ReconciliationAccountSnapshot,
  ReconciliationRun,
  RefundAllocationState,
  ReviewQueueResult,
  SplitwiseAuditFinding,
  SplitwiseAuditFindingDetail,
  SplitwiseAuditRun,
  UnmatchedEvidenceItem,
} from "@/lib/types";

export const DEV: PersonSummary = {
  id: "p-dev",
  displayName: "Dev",
  splitwiseUserId: "sw-dev",
  isUser: true,
};
export const ALEX: PersonSummary = {
  id: "p-alex",
  displayName: "Alex",
  splitwiseUserId: "sw-alex",
  isUser: false,
};
export const PEOPLE = [DEV, ALEX];

export const ACCOUNT: AccountSummary = {
  id: "a-hdfc",
  name: "HDFC Savings",
  type: "bank",
  institution: "HDFC Bank",
  last4: "4821",
  currency: "INR",
  isActive: true,
  archivedAt: null,
};

/* ------------------------------------------------------------------------------ review */

export const CLASSIFICATION_ITEM: ClassificationDecisionItem = {
  kind: "classification_decision",
  id: "inf-1",
  amount: "124000",
  occurredAt: "2026-08-19T13:10:00.000Z",
  reasons: ["low_confidence", "material_amount"],
  inferenceId: "inf-1",
  confidence: "medium",
  proposedAt: "2026-08-19T13:11:00.000Z",
  proposedKind: "expense",
  proposal: { proposedKind: "expense", relationshipType: "shared", category: "dining" },
  model: { provider: "synthetic", name: "scripted-classifier-v1", promptVersion: "v1" },
  payment: {
    paymentId: "pay-1",
    amount: "124000",
    currency: "INR",
    direction: "debit",
    occurredAt: "2026-08-19T13:10:00.000Z",
    description: "UPI-ZOMATO4471-SAMPLE RESTAURANT PVT LTD",
    counterpartyType: "merchant",
    state: "classified",
  },
  expense: null,
};

export const DUPLICATE_ITEM: PossibleDuplicateItem = {
  kind: "possible_duplicate",
  id: "dup-1",
  amount: "64000",
  occurredAt: "2026-08-08T11:30:00.000Z",
  reasons: ["possible_duplicate"],
  payment: {
    paymentId: "pay-later",
    amount: "64000",
    currency: "INR",
    direction: "debit",
    occurredAt: "2026-08-08T11:35:00.000Z",
    description: "UPI-UNKNOWN-MERCHANT-8841",
    counterpartyType: "unknown",
    state: "normalized",
  },
  candidate: {
    paymentId: "pay-earlier",
    amount: "64000",
    currency: "INR",
    direction: "debit",
    occurredAt: "2026-08-08T11:30:00.000Z",
    description: "UPI-UNKNOWN-MERCHANT-8841",
    counterpartyType: "unknown",
    state: "normalized",
  },
};

export const MATCH_CANDIDATE: EvidenceMatchCandidateView = {
  candidateId: "cand-1",
  evidenceId: "ev-1",
  paymentId: "pay-1",
  strength: "probable",
  confidence: "medium",
  matchedSignals: ["amount", "direction", "account", "time"],
  conflictingSignals: [],
  signals: [
    {
      signal: "reference",
      verdict: "absent",
      evidenceValue: "884120993741",
      paymentValue: null,
      detail: "One side carries no reference identifier, so there is nothing to compare.",
    },
    {
      signal: "amount",
      verdict: "matched",
      evidenceValue: "64000",
      paymentValue: "64000",
      detail: "Exact match, to the paise.",
    },
    {
      signal: "merchant",
      verdict: "conflicted",
      evidenceValue: "PEPPERMILL CAFE",
      paymentValue: "BLINKIT",
      detail: "The two names do not agree.",
    },
  ],
  reviewReasons: ["link_decision_required", "conflicting_signals"],
  status: "proposed",
  decidedAt: null,
  decidedBy: null,
  requiresReview: true,
  matcherVersion: "evidence-match/1",
};

export const UNMATCHED_EVIDENCE_ITEM: UnmatchedEvidenceItem = {
  kind: "unmatched_evidence",
  id: "ev-1",
  amount: "64000",
  occurredAt: "2026-08-08T11:31:00.000Z",
  reasons: ["evidence_unmatched"],
  evidenceId: "ev-1",
  evidenceType: "upi_notification",
  storageRef: null,
  mediaType: null,
  byteSize: null,
  capturedAt: "2026-08-08T11:31:00.000Z",
  ingestedAt: "2026-09-01T10:00:00.000Z",
  receiptId: null,
  receiptTotal: null,
  candidateMatches: [],
  observation: {
    evidenceId: "ev-1",
    observedAmount: "64000",
    observedDirection: "debit",
    observedReference: "884120993741",
    observedReferenceType: "upi_utr",
    observedAccountHint: "4821",
    observedMerchantText: "PEPPERMILL CAFE",
    observedOccurredAt: null,
    derivation: "parsed_from_text",
  },
  matchCandidates: [MATCH_CANDIDATE],
};

export function reviewQueue(
  items: ReviewQueueResult["items"] = [CLASSIFICATION_ITEM, UNMATCHED_EVIDENCE_ITEM],
): ReviewQueueResult {
  const counts = {
    classification_decision: 0,
    possible_duplicate: 0,
    rejected_classification: 0,
    unmatched_evidence: 0,
  };
  for (const item of items) counts[item.kind] += 1;
  return { items, counts, total: items.length, truncated: false };
}

/* -------------------------------------------------------------------------- evidence */

export const EVIDENCE: EvidenceRecord = {
  id: "ev-1",
  type: "upi_notification",
  noteKind: null,
  storageRef: null,
  mediaType: null,
  byteSize: null,
  rawText:
    "Rs.640.00 debited from A/c XX4821 on 08-Aug-26 to PEPPERMILL CAFE. UPI Ref 884120993741.",
  capturedAt: "2026-08-08T11:31:00.000Z",
  linkedPaymentId: null,
  linkedExpenseId: null,
  createdAt: "2026-09-01T10:00:00.000Z",
};

/* -------------------------------------------------------------- expenses and refunds */

export const EXPENSE: ExpenseLedgerRow = {
  id: "exp-1",
  description: "Blinkit — weekly groceries",
  category: "groceries",
  grossAmount: "215000",
  netAmount: "150000",
  currency: "INR",
  occurredAt: "2026-08-11T19:20:00.000Z",
  relationshipType: "shared",
  paidByPersonId: "p-dev",
  state: "allocated",
};

/** A recorded item refund that has **not** been distributed — ADR-0018's pending state. */
export const REFUND_STATE_PENDING: RefundAllocationState = {
  expenseId: "exp-1",
  grossAmount: "215000",
  netAmount: "150000",
  basis: "item_attributed",
  attributedReduction: "65000",
  unattributedReduction: "0",
  pendingReduction: "65000",
  pendingDistribution: true,
  obligationsReflectAdjustments: false,
  items: [
    {
      expenseItemId: "item-oil",
      description: "Cold-pressed olive oil (returned)",
      quantity: "1.000",
      grossAmount: "65000",
      refundedAmount: "65000",
      netAmount: "0",
    },
    {
      expenseItemId: "item-coffee",
      description: "Coffee beans, 1kg",
      quantity: "1.000",
      grossAmount: "90000",
      refundedAmount: "0",
      netAmount: "90000",
    },
    {
      expenseItemId: "item-staples",
      description: "Household staples",
      quantity: "1.000",
      grossAmount: "52000",
      refundedAmount: "0",
      netAmount: "52000",
    },
    {
      expenseItemId: "item-delivery",
      description: "Delivery and handling",
      quantity: "1.000",
      grossAmount: "8000",
      refundedAmount: "0",
      netAmount: "8000",
    },
  ],
  currentAllocation: {
    id: "alloc-1",
    method: "item_based",
    total: "215000",
    lines: [
      {
        beneficiaryType: "person",
        beneficiaryId: "p-dev",
        expenseItemId: "item-oil",
        amount: "65000",
      },
      {
        beneficiaryType: "person",
        beneficiaryId: "p-alex",
        expenseItemId: "item-coffee",
        amount: "90000",
      },
      {
        beneficiaryType: "person",
        beneficiaryId: "p-dev",
        expenseItemId: "item-staples",
        amount: "52000",
      },
      {
        beneficiaryType: "person",
        beneficiaryId: "p-dev",
        expenseItemId: "item-delivery",
        amount: "8000",
      },
    ],
  },
  projectedLines: [
    { beneficiaryType: "person", beneficiaryId: "p-dev", expenseItemId: "item-oil", amount: "0" },
    {
      beneficiaryType: "person",
      beneficiaryId: "p-alex",
      expenseItemId: "item-coffee",
      amount: "90000",
    },
    {
      beneficiaryType: "person",
      beneficiaryId: "p-dev",
      expenseItemId: "item-staples",
      amount: "52000",
    },
    {
      beneficiaryType: "person",
      beneficiaryId: "p-dev",
      expenseItemId: "item-delivery",
      amount: "8000",
    },
  ],
  reviewRequired: null,
};

/** The same expense once the distribution has been approved: nothing left pending. */
export const REFUND_STATE_SETTLED: RefundAllocationState = {
  ...REFUND_STATE_PENDING,
  pendingReduction: "0",
  pendingDistribution: false,
  obligationsReflectAdjustments: true,
  currentAllocation: {
    ...REFUND_STATE_PENDING.currentAllocation!,
    id: "alloc-2",
    total: "150000",
    lines: REFUND_STATE_PENDING.projectedLines!,
  },
};

/** An item refund the ledger cannot allocate, because it cannot say who owned the item. */
export const REFUND_STATE_REVIEW_REQUIRED: RefundAllocationState = {
  ...REFUND_STATE_PENDING,
  projectedLines: null,
  reviewRequired: {
    code: "REFUND_ITEM_OWNERSHIP_REQUIRED",
    message:
      "This refund names an item with no allocation line, so who benefited from it cannot be " +
      "determined without a decision.",
  },
};

/* ------------------------------------------------------------------- reconciliation */

export const RUN: ReconciliationRun = {
  id: "run-1",
  runAt: "2026-09-01T09:00:00.000Z",
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  totals: {
    ledgerTotalOutflow: "2643000",
    ledgerTransfersTotal: "1500000",
    ledgerInvestmentsTotal: "0",
    ledgerSettlementsTotal: "0",
    ledgerExplainedTotal: "890000",
    ledgerUnexplainedTotal: "253000",
  },
  splitwiseBalancesSnapshot: null,
  discrepancies: [],
  resolvedAt: null,
};

const BASE_SNAPSHOT: ReconciliationAccountSnapshot = {
  id: "snap-1",
  reconciliationRunId: "run-1",
  accountId: "a-hdfc",
  currency: "INR",
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  openingBalance: null,
  closingBalance: null,
  openingBalanceEvidenceId: null,
  closingBalanceEvidenceId: null,
  totalDebits: "2643000",
  totalCredits: "225000",
  internalTransferDebits: "1500000",
  internalTransferCredits: "0",
  explainedDebits: "2455000",
  unexplainedDebits: "188000",
  explainedCredits: "225000",
  unexplainedCredits: "0",
  expectedEndingBalance: null,
  cashBalanceDelta: null,
  verificationStatus: "incomplete",
  discrepancies: [
    {
      kind: "missing_opening_balance",
      detail: "No evidenced opening balance for this account and period.",
    },
  ],
  createdAt: "2026-09-01T09:00:00.000Z",
};

/** No statement balance at all: unknown, and never rendered as a zero. */
export const SNAPSHOT_INCOMPLETE: AccountSnapshotsResult = {
  reconciliationRunId: "run-1",
  snapshots: [BASE_SNAPSHOT],
};

/** The delta is zero and the boundaries are evidenced, but debits remain unexplained. */
export const SNAPSHOT_UNRECONCILED: AccountSnapshotsResult = {
  reconciliationRunId: "run-1",
  snapshots: [
    {
      ...BASE_SNAPSHOT,
      openingBalance: "5000000",
      closingBalance: "2582000",
      openingBalanceEvidenceId: "ev-statement",
      closingBalanceEvidenceId: "ev-statement",
      expectedEndingBalance: "2582000",
      cashBalanceDelta: "0",
      verificationStatus: "unreconciled",
      discrepancies: [
        {
          kind: "unexplained_debits",
          detail: "188000 paise of debits on this account are not covered by an approved link.",
        },
      ],
    },
  ],
};

/** Everything closes: evidenced boundaries, zero delta, nothing unexplained either way. */
export const SNAPSHOT_VERIFIED: AccountSnapshotsResult = {
  reconciliationRunId: "run-1",
  snapshots: [
    {
      ...BASE_SNAPSHOT,
      openingBalance: "5000000",
      closingBalance: "2770000",
      openingBalanceEvidenceId: "ev-statement",
      closingBalanceEvidenceId: "ev-statement",
      unexplainedDebits: "0",
      explainedDebits: "2643000",
      expectedEndingBalance: "2770000",
      cashBalanceDelta: "0",
      verificationStatus: "verified",
      discrepancies: [],
    },
  ],
};

/* ------------------------------------------------------------------- Splitwise audit */

export const AUDIT_RUN_FAILED_READ: SplitwiseAuditRun = {
  id: "audit-1",
  runAt: "2026-09-01T09:00:00.000Z",
  reconciliationRunId: null,
  externalIntegrationId: "int-1",
  externalReadStatus: "failed",
  externalReadDetail: "Splitwise.fetchBalances is not configured in this environment.",
  pairsAudited: 0,
  pairsUnchecked: 1,
  findingsCreated: 1,
  findingsReobserved: 0,
  findingsSuperseded: 0,
};

export const AUDIT_RUN_COMPLETE: SplitwiseAuditRun = {
  ...AUDIT_RUN_FAILED_READ,
  externalReadStatus: "complete",
  externalReadDetail: null,
  pairsAudited: 1,
  pairsUnchecked: 0,
};

export const FINDING: SplitwiseAuditFinding = {
  id: "find-1",
  auditRunId: "audit-1",
  lastObservedAuditRunId: "audit-1",
  reconciliationRunId: null,
  kind: "missing_external_settlement",
  findingClass: "discrepancy",
  scope: "settlement",
  summary: "This ledger records a settlement Splitwise has no record of.",
  confidence: "medium",
  amount: "160000",
  balanceImpact: "-160000",
  personAId: "p-dev",
  personBId: "p-alex",
  expenseId: null,
  settlementId: "set-1",
  externalReference: null,
  localSnapshot: { amount: "160000", direction: "credit" },
  externalSnapshot: { present: false, readStatus: "unsupported" },
  evidence: [{ id: "set-1", type: "settlement" }],
  firstObservedAt: "2026-09-01T09:00:00.000Z",
  lastObservedAt: "2026-09-01T09:00:00.000Z",
  reviewStatus: "open",
  reviewedAt: null,
  reviewedBy: null,
  reviewReason: null,
  supersededAt: null,
  supersededByFindingId: null,
  supersedeReason: null,
};

export const UNATTRIBUTED_FINDING: SplitwiseAuditFinding = {
  ...FINDING,
  id: "find-2",
  kind: "unattributed_balance_mismatch",
  scope: "pair",
  confidence: "unknown",
  summary: "50000 paise of the pair's gap is left over that no record in evidence explains.",
  amount: "50000",
  balanceImpact: "0",
};

export const FINDING_DETAIL: SplitwiseAuditFindingDetail = {
  finding: FINDING,
  history: [
    {
      entityType: "splitwise_audit_finding",
      entityId: "find-1",
      action: "create",
      actor: "system",
      occurredAt: "2026-09-01T09:00:00.000Z",
      reason: null,
      oldValue: null,
      newValue: { kind: "missing_external_settlement" },
    },
  ],
};

/* ---------------------------------------------------------------------- proof packs */

export const PROOF_PACK: ProofPackPreview = {
  intendedRecipient: { id: "p-alex", displayName: "Alex" },
  asOf: "2026-09-01T09:00:00.000Z",
  generatedText:
    "Expense summary for Alex\nAs of 1 Sep 2026. Derived from my records — not yet confirmed by you.\n\nWHERE THIS STANDS\nAlex owes me ₹900.00.",
  evidenceReferences: [
    {
      evidenceId: "ev-1",
      type: "upi_notification",
      capturedAt: "2026-08-08T11:31:00.000Z",
      label: "Notification",
    },
  ],
  warnings: [
    {
      code: "UNRESOLVED_AUDIT_FINDINGS",
      message: "1 Splitwise audit finding is still open for this balance.",
      severity: "caution",
    },
  ],
  pack: {
    user: { personId: "p-dev", displayName: "Dev" },
    recipient: { personId: "p-alex", displayName: "Alex" },
    asOf: "2026-09-01T09:00:00.000Z",
    netBalance: "-90000",
    netDirection: "recipient_owes_user",
    amountOwed: "90000",
    evidenceStatus: "open_unconfirmed",
    expenseLines: [
      {
        expenseId: "exp-1",
        description: "Blinkit — weekly groceries",
        occurredAt: "2026-08-11T19:20:00.000Z",
        payer: "you",
        shareDirection: "recipient_owes_user",
        grossAmount: "215000",
        attributedItemRefunds: "65000",
        unattributedRefunds: "0",
        netAmount: "150000",
        recipientShare: "90000",
        refundBasis: "item_attributed",
        pendingDistribution: false,
        reviewRequired: null,
        conflictingEvidence: false,
        evidence: [],
      },
    ],
    settlements: [
      {
        settlementId: "set-1",
        occurredAt: "2026-08-06T18:00:00.000Z",
        direction: "recipient_paid_you",
        amount: "160000",
      },
    ],
    openAuditFindings: [
      {
        findingId: "find-1",
        kind: "missing_external_settlement",
        findingClass: "discrepancy",
        summary: "This ledger records a settlement Splitwise has no record of.",
        confidence: "medium",
        reviewStatus: "open",
      },
    ],
    warnings: [
      {
        code: "UNRESOLVED_AUDIT_FINDINGS",
        message: "1 Splitwise audit finding is still open for this balance.",
        severity: "caution",
      },
    ],
    generatedText: "Expense summary for Alex",
  },
};

export const BALANCE: BalanceResult = {
  personAId: "p-dev",
  personBId: "p-alex",
  netBalance: "-90000",
  evidenceStatus: "open_unconfirmed",
  contributions: [{ debtorId: "p-alex", creditorId: "p-dev", amount: "90000", expenseId: "exp-1" }],
  settlements: [],
  pendingRefundExpenseIds: [],
};

/* -------------------------------------------------------------------- payment workspace */

/** An unexplained debit: nothing links to it, and nobody has said what it was for. */
export const UNEXPLAINED_PAYMENT: PaymentWorkspaceItem = {
  id: "pay-1",
  accountId: ACCOUNT.id,
  accountName: ACCOUNT.name,
  importBatchId: "batch-1",
  amount: "184000",
  currency: "INR",
  direction: "debit",
  occurredAt: "2026-08-05T09:15:00.000Z",
  rawDescription: "UPI-BLINKIT-PAYU@AXIS-517290",
  channel: "upi",
  counterpartyType: "unknown",
  counterpartyId: null,
  counterpartyName: null,
  externalReference: "517290",
  referenceType: "upi_utr",
  sourceSystem: "hdfc-savings-export",
  state: "imported",
  ignoredReason: null,
  cashFlowCategory: null,
  cashFlowState: "imported",
  cashFlowApprovedAt: null,
  cashFlowApprovedBy: null,
  expenseLinkTotal: "0",
  settlementTotal: "0",
  adjustmentTotal: "0",
  evidenceCount: 0,
  expenseLinkCount: 0,
  settlementCount: 0,
  explainedTotal: "0",
  unexplainedTotal: "184000",
  isDuplicateRepresentation: false,
};

/** A credit with a proposed refund role, waiting on the approval step and its evidence gate. */
export const CLASSIFIED_CREDIT: PaymentWorkspaceItem = {
  ...UNEXPLAINED_PAYMENT,
  id: "pay-2",
  amount: "40000",
  direction: "credit",
  rawDescription: "REFUND BLINKIT ORDER 8842",
  state: "normalized",
  cashFlowState: "cash_flow_classified",
  cashFlowCategory: "REFUND",
  unexplainedTotal: "40000",
};

/** Explained by an expense link — the case that must never read as an unverified zero. */
export const EXPLAINED_PAYMENT: PaymentWorkspaceItem = {
  ...UNEXPLAINED_PAYMENT,
  id: "pay-3",
  rawDescription: "UPI-SWIGGY-8817",
  state: "linked",
  expenseLinkTotal: "184000",
  expenseLinkCount: 1,
  explainedTotal: "184000",
  unexplainedTotal: "0",
};

export function paymentPage(
  payments: readonly PaymentWorkspaceItem[],
  overrides: Partial<PaymentListResult> = {},
): PaymentListResult {
  return {
    payments,
    total: payments.length,
    filteredTotalIsExact: true,
    limit: 50,
    offset: 0,
    ...overrides,
  };
}

export const COUNTERPARTY_OPTIONS: CounterpartyOptions = {
  merchants: [{ id: "m-blinkit", canonicalName: "Blinkit" }],
  people: [
    { id: DEV.id, displayName: DEV.displayName },
    { id: ALEX.id, displayName: ALEX.displayName },
  ],
  accounts: [{ id: ACCOUNT.id, name: ACCOUNT.name }],
};

export const IMPORT_BATCH: ImportBatchSummary = {
  id: "batch-1",
  sourceChannel: "bank_statement",
  fileReference: "august.csv",
  contentHash: "b1a2c3",
  parserVersion: "bank-csv/1",
  rowCount: 42,
  importedAt: "2026-09-01T04:30:00.000Z",
  paymentCount: 42,
  ignoredCount: 2,
};

/* ------------------------------------------------------------------------- master data */

export const PERSON_DETAILS: readonly PersonDetail[] = [
  {
    id: DEV.id,
    displayName: DEV.displayName,
    splitwiseUserId: DEV.splitwiseUserId,
    notes: null,
    archivedAt: null,
    isUser: true,
  },
  {
    id: ALEX.id,
    displayName: ALEX.displayName,
    splitwiseUserId: null,
    notes: "Flatmate",
    archivedAt: null,
    isUser: false,
  },
];

export const MERCHANT: MerchantDetail = {
  id: "m-blinkit",
  canonicalName: "Blinkit",
  defaultCategory: "groceries",
  archivedAt: null,
  aliases: [{ id: "al-1", rawPattern: "UPI-BLINKIT-PAYU@AXIS" }],
};

export const MERCHANT_WITHOUT_ALIAS: MerchantDetail = {
  id: "m-swiggy",
  canonicalName: "Swiggy",
  defaultCategory: null,
  archivedAt: null,
  aliases: [],
};

export const GROUP: GroupDetail = {
  id: "g-flat",
  name: "Flat 402",
  type: "flatmates",
  archivedAt: null,
  memberships: [
    {
      id: "gm-1",
      personId: DEV.id,
      displayName: DEV.displayName,
      joinedAt: "2026-01-01T00:00:00.000Z",
      leftAt: null,
    },
    {
      id: "gm-2",
      personId: ALEX.id,
      displayName: ALEX.displayName,
      joinedAt: "2026-03-01T00:00:00.000Z",
      leftAt: "2026-08-01T00:00:00.000Z",
    },
  ],
};
