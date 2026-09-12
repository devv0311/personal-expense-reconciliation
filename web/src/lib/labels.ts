/**
 * Human wording for the closed value sets the API sends.
 *
 * Nothing here is financial and nothing here decides anything: it turns a stored enum into the
 * sentence a person reads. Two rules hold throughout:
 *
 * 1. **Every map falls back to the raw value**, never to "Unknown". A value this file has not
 *    been taught still renders — as its own identifier — because a finding or a review reason
 *    the UI cannot name is still a finding the reader must see (`discrepancy-list.tsx` set
 *    this precedent in phase 15).
 * 2. **A label never softens a state.** "Incomplete" is not "Pending"; an unattributed
 *    mismatch is not "Minor". The wording tracks what the backend actually said.
 */

/** `review_required` → `Review required`. The generic fallback for any snake_case value. */
export function sentenceCase(value: string): string {
  const [first, ...rest] = value.split("_");
  if (first === undefined) return value;
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} ${rest.join(" ")}`.trim();
}

function labelled(map: Record<string, string>) {
  return (value: string): string => map[value] ?? sentenceCase(value);
}

/* ---------------------------------------------------------------------------- review */

export const reviewKindLabel = labelled({
  classification_decision: "Classification",
  possible_duplicate: "Possible duplicate",
  rejected_classification: "Unexplained payment",
  unmatched_evidence: "Unmatched evidence",
});

export const reviewKindDescription = labelled({
  classification_decision:
    "A model proposed what this payment is. Nothing is state until you decide.",
  possible_duplicate: "Two live payments resemble each other. Confirming one discards it.",
  rejected_classification: "The proposal was declined, so this is money with no explanation.",
  unmatched_evidence: "A stored document attached to nothing.",
});

export const reviewReasonLabel = labelled({
  low_confidence: "Low confidence",
  material_amount: "Material amount",
  settlement_kind: "Settlement proposal",
  decision_required: "Decision required",
  possible_duplicate: "Resembles another payment",
  malformed_proposal: "Stored proposal no longer parses",
  payment_unexplained: "Payment has no explanation",
  evidence_unmatched: "Attached to nothing",
  ambiguous_evidence_match: "More than one payment could match",
  conflicting_evidence_signals: "A signal disagreed",
});

export const confidenceLabel = labelled({
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  unknown: "Confidence unknown",
});

/* -------------------------------------------------------------------------- evidence */

export const evidenceTypeLabel = labelled({
  bank_line: "Bank statement line",
  upi_notification: "UPI notification",
  receipt_image: "Receipt image",
  screenshot: "Screenshot",
  email_receipt: "Email receipt",
  manual_note: "Manual note",
});

export const matchSignalLabel = labelled({
  reference: "Reference",
  amount: "Amount",
  direction: "Direction",
  account: "Account",
  time: "Time",
  merchant: "Merchant",
});

export const matchVerdictLabel = labelled({
  matched: "Agrees",
  conflicted: "Disagrees",
  absent: "Not stated",
});

export const matchStrengthLabel = labelled({
  deterministic: "Deterministic",
  probable: "Probable",
  weak: "Weak",
});

export const matchStatusLabel = labelled({
  proposed: "Waiting on you",
  accepted: "Accepted",
  dismissed: "Dismissed",
  superseded: "Superseded",
});

export const matchReviewReasonLabel = labelled({
  link_decision_required: "Linking evidence is an explicit decision",
  ambiguous_candidates: "More than one payment is eligible",
  conflicting_signals: "At least one signal disagreed",
  weak_evidence: "Corroborated only by amount and time",
});

/* ------------------------------------------------------------------ cash reconciliation */

export const verificationStatusLabel = labelled({
  incomplete: "Incomplete",
  unreconciled: "Unreconciled",
  verified: "Verified",
});

/**
 * What each verification status actually means, spelled out.
 *
 * `incomplete` gets the longest sentence on purpose: it is the one a reader is most likely to
 * mistake for "fine", and `CLAUDE.md`'s third pillar is explicit that arithmetic closure alone
 * is not a verified ₹0.
 */
export const verificationStatusDetail = labelled({
  incomplete:
    "Not checked. A statement balance is missing, so there is no closing figure to check the " +
    "movements against — unknown, not zero.",
  unreconciled: "Checked, and it does not close. The signed difference is below.",
  verified:
    "Both boundaries are evidenced, the delta is zero, and nothing on this account is " +
    "unexplained in either direction.",
});

export const cashDiscrepancyLabel = labelled({
  missing_opening_balance: "No evidenced opening balance",
  missing_closing_balance: "No evidenced closing balance",
  cash_balance_delta_nonzero: "The statement does not close",
  unexplained_debits: "Debits this account cannot explain",
  unexplained_credits: "Credits this account cannot explain",
  unpaired_internal_transfer: "A transfer leg with no counter-leg in this run",
});

export const accountTypeLabel = labelled({
  bank: "Bank",
  card: "Card",
  upi: "UPI",
  wallet: "Wallet",
  cash: "Cash",
});

/* ------------------------------------------------------------------- the Splitwise audit */

export const auditFindingKindLabel = labelled({
  missing_external_expense: "Missing from Splitwise",
  duplicate_external_expense: "Duplicated in Splitwise",
  stale_refund_partial: "Stale after a partial refund",
  stale_refund_full: "Stale after a full refund",
  unreflected_item_refund: "Item refund not reflected",
  missing_external_settlement: "Settlement missing from Splitwise",
  duplicate_external_settlement: "Settlement duplicated in Splitwise",
  unrecorded_external_settlement: "Splitwise payment this ledger has no settlement for",
  external_amount_disagreement: "Both sides disagree on the amount",
  unsupported_ghost_debt: "Ghost debt — nothing here supports it",
  unattributed_balance_mismatch: "Unattributed mismatch",
  external_read_failed: "Splitwise read failed",
  external_read_unsupported: "Splitwise read not supported",
  external_read_partial: "Splitwise read was partial",
  external_record_inaccessible: "Splitwise did not report this person",
  non_user_settlement_unobservable: "Between two people this ledger cannot observe",
  cross_payer_attribution_unavailable: "Someone else paid — drift cannot be attributed",
});

export const auditFindingClassLabel = labelled({
  discrepancy: "Disagreement",
  limitation: "Observability limit",
  incomplete: "Incomplete check",
});

export const auditFindingClassDetail = labelled({
  discrepancy: "The two ledgers say different things.",
  limitation: "A permanent boundary on what this system can see — not a bug, and not fixable.",
  incomplete: "The check could not be completed. Absence proves nothing here.",
});

export const auditReviewStatusLabel = labelled({
  open: "Open",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  dismissed: "Dismissed",
});

export const externalReadStatusLabel = labelled({
  complete: "Complete",
  partial: "Partial",
  unsupported: "Not supported",
  failed: "Failed",
  skipped: "Not attempted",
});

export const externalReadStatusDetail = labelled({
  complete: "Every entry Splitwise holds for the audited scope was read back.",
  partial: "Some of it was read. Absence of a record proves nothing under this status.",
  unsupported: "The connected adapter does not implement the per-entry read at all.",
  failed: "The read was attempted and errored.",
  skipped: "No Splitwise integration is connected, so nothing was read.",
});

export const auditScopeLabel = labelled({
  integration: "Integration",
  pair: "Pair (aggregate)",
  expense: "Expense",
  settlement: "Settlement",
  external_entry: "Splitwise entry",
});

/* ------------------------------------------------------------------------ proof packs */

export const proofPackWarningLabel = labelled({
  NO_SHARED_HISTORY: "No shared history",
  UNRESOLVED_AUDIT_FINDINGS: "Unresolved Splitwise findings",
  PENDING_REFUND_DISTRIBUTION: "A refund has not reached the allocation yet",
  REFUND_ALLOCATION_REVIEW_REQUIRED: "A refund needs a decision before it can be allocated",
  BELIEVED_SETTLED_UNCONFIRMED: "Believed settled, not confirmed",
  REVERSE_BALANCE_AFTER_SETTLEMENT: "A refund reversed the balance after a settlement",
  MIXED_LEGACY_AND_ITEM_ADJUSTMENTS: "Mixed adjustment basis",
  CONTRIBUTING_EXPENSE_NOT_APPROVED: "A contributing expense is not approved",
  CONFLICTING_EVIDENCE: "Two evidence records disagree",
  MISSING_SUPPORTING_EVIDENCE: "No supporting evidence",
});

export const refundBasisLabel = labelled({
  none: "No adjustment recorded",
  whole_expense: "Whole expense",
  item_attributed: "Attributed to items",
  mixed: "Mixed",
});

export const adjustmentKindLabel = labelled({
  merchant_refund: "Merchant refund",
  third_party_reimbursement: "Third-party reimbursement",
});

export const allocationMethodLabel = labelled({
  equal: "Equal",
  exact: "Exact",
  percentage: "Percentage",
  item_based: "Item-based",
  quantity_based: "Quantity-based",
  custom: "Custom",
});

/* ------------------------------------------------------------------ the payment workspace */

export const paymentStateLabel = labelled({
  imported: "Imported",
  normalized: "Normalized",
  linked: "Linked",
  ignored: "Ignored",
});

export const paymentStateDetail = labelled({
  imported: "Read from a statement or typed in. Nothing has interpreted it yet.",
  normalized: "Channel and merchant resolved deterministically. Not yet explained.",
  linked: "Attached to what it paid for.",
  ignored: "Kept for provenance and counted by nothing — usually a confirmed duplicate.",
});

export const cashFlowStateLabel = labelled({
  imported: "Not started",
  normalized: "Ready to classify",
  cash_flow_classified: "Proposed, not approved",
  approved: "Approved",
});

export const cashFlowCategoryLabel = labelled({
  PEER_SETTLEMENT: "Peer settlement",
  REFUND: "Refund",
  INTERNAL_TRANSFER: "Internal transfer",
  EXTERNAL_INFLOW: "External inflow",
});

/**
 * What approving each category will require, in the person's own words before they press it.
 *
 * These are ADR-0017's evidence gates (17.1–17.3) stated ahead of the request rather than
 * discovered through a refusal: the service checks them regardless, and a reader who is told
 * why beforehand can go and record the missing evidence instead of guessing.
 */
export const cashFlowCategoryGate = labelled({
  PEER_SETTLEMENT: "Needs a recorded settlement against this payment.",
  REFUND: "Needs a recorded expense adjustment against this payment, and a credit.",
  INTERNAL_TRANSFER: "Needs both legs: an account you own, and the counter-leg named.",
  EXTERNAL_INFLOW: "Needs linked evidence for the credit, and a credit direction.",
});

export const counterpartyTypeLabel = labelled({
  merchant: "Merchant",
  person: "Person",
  internal_account: "Own account",
  investment_instrument: "Investment",
  unknown: "Unknown",
});

export const counterpartyTypeDetail = labelled({
  merchant: "A shop, service or platform. The ordinary spending case.",
  person: "Money that moved between you and someone else.",
  internal_account: "A transfer between two accounts you own. Never spending (invariant #7).",
  investment_instrument: "A purchase of an asset. Never spending (invariant #7).",
  unknown: "Nobody has said. Deliberately not a guess.",
});

export const paymentChannelLabel = labelled({
  upi: "UPI",
  bank_transfer: "Bank transfer",
  card: "Card",
  cash: "Cash",
  other: "Other",
});

export const referenceTypeLabel = labelled({
  upi_utr: "UPI UTR",
  upi_rrn: "UPI RRN",
  bank_reference: "Bank reference",
  card_reference: "Card reference",
  merchant_order_id: "Merchant order id",
  cheque_number: "Cheque number",
  other: "Other reference",
});

export const sourceChannelLabel = labelled({
  bank_statement: "Bank statement",
  manual_entry: "Typed in by hand",
});

export const classificationOutcomeLabel = labelled({
  proposed: "Proposal recorded",
  internal_transfer: "Matched as an internal transfer",
  skipped: "Skipped",
  rejected: "Model answer refused",
});

export const classificationSkipLabel = labelled({
  not_normalized: "Not normalized yet",
  already_classified: "Already classified",
  non_spend_counterparty: "A transfer or investment — never spending",
  credit_out_of_scope: "A credit, which this path does not classify",
});

/* ------------------------------------------------------------------------------ rules */

export const ruleActionLabel = labelled({
  set_counterparty_type: "Set the counterparty type",
  set_cash_flow_category: "Set the cash-flow role",
  set_expense_category: "Set the expense category",
});

export const ruleEffectLabel = labelled({
  propose: "Propose it",
  apply: "Apply it unattended",
});

export const ruleEffectDetail = labelled({
  propose: "Records a suggestion for you to accept or reject. Writes nothing on its own.",
  apply:
    "Writes the fact without asking, attributed to the rule rather than to you. Only ever a " +
    "restatement of a decision you have already made — no rule touches an allocation or an amount.",
});

export const ruleOutcomeLabel = labelled({
  applied: "Applied",
  proposed: "Proposed",
  skipped: "Skipped",
});

export const ruleOperatorLabel = labelled({
  contains: "contains",
  equals: "is exactly",
  startsWith: "starts with",
});

/* ------------------------------------------------------------------------------- jobs */

export const jobKindLabel = labelled({
  import_bank_statement_csv: "Import a statement",
  normalize_payments: "Normalize payments",
  classify_payments: "Classify payments",
  extract_receipt: "Extract a receipt",
  run_splitwise_audit: "Run a Splitwise audit",
});

export const jobStatusLabel = labelled({
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
});

/* --------------------------------- changes somebody made in Splitwise (ADR-0056) */

export const remoteChangeKindLabel = labelled({
  remote_expense_amount_changed: "They changed the amount",
  remote_settlement_amount_changed: "They changed a repayment",
  remote_expense_deleted: "They deleted the entry",
  remote_settlement_deleted: "They deleted the repayment",
  remote_expense_unlinked: "An expense this ledger has no link for",
  remote_settlement_unlinked: "A repayment this ledger has no link for",
  remote_person_unmapped: "A Splitwise friend nobody here is mapped to",
  remote_duplicate_candidate: "Two indistinguishable entries",
});

/**
 * What accepting writes, in four words.
 *
 * The sentence version comes from the API as `consequence` and is quoted, not composed here:
 * these are a table column, not the statement somebody confirms against (ADR-0048).
 */
export const remoteChangeEffectLabel = labelled({
  record_drift: "Records what they hold",
  record_external_deletion: "Marks the entry gone",
  adopt_expense_link: "Links it to an expense",
  adopt_settlement_link: "Links it to a repayment",
  map_person: "Maps the account to a person",
  none: "Nothing to apply",
});

export const remoteChangeStatusLabel = labelled({
  proposed: "Waiting on you",
  accepted: "Accepted",
  rejected: "Rejected",
});
