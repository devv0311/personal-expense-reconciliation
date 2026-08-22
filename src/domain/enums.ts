/**
 * Every closed value set in the model, as a `const` array plus its derived union type.
 *
 * These arrays are the single source of truth shared by `src/domain` (behaviour) and
 * `src/db` (the `CHECK` constraint value lists). Keeping them in one place is what stops
 * the schema and the domain drifting — a value added here and not to the database becomes
 * a failing integration test rather than a silently-rejected insert in production.
 *
 * Values and ordering follow `docs/architecture/database-design.md`.
 */

/* ------------------------------------------------------------------ accounts, people */

export const ACCOUNT_TYPES = ['bank', 'upi', 'card', 'cash', 'wallet'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/* ------------------------------------------------------------------------- payments */

export const PAYMENT_DIRECTIONS = ['debit', 'credit'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const PAYMENT_CHANNELS = ['upi', 'bank_transfer', 'card', 'cash', 'other'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

/** `investment_instrument` added per ADR-0011. */
export const PAYMENT_COUNTERPARTY_TYPES = [
  'merchant',
  'person',
  'internal_account',
  'investment_instrument',
  'unknown',
] as const;
export type PaymentCounterpartyType = (typeof PAYMENT_COUNTERPARTY_TYPES)[number];

/**
 * Counterparty types that put a payment outside spending entirely.
 *
 * A payment classified this way must never be linked to an `Expense`, and is excluded
 * from spend totals by this classification alone — not by its lifecycle state
 * (`invariants.md` #7, ADR-0011).
 */
export const NON_SPEND_COUNTERPARTY_TYPES = ['internal_account', 'investment_instrument'] as const;
export type NonSpendCounterpartyType = (typeof NON_SPEND_COUNTERPARTY_TYPES)[number];

/** ADR-0010. */
export const PAYMENT_REFERENCE_TYPES = [
  'upi_utr',
  'upi_rrn',
  'bank_reference',
  'card_reference',
  'merchant_order_id',
  'cheque_number',
  'other',
] as const;
export type PaymentReferenceType = (typeof PAYMENT_REFERENCE_TYPES)[number];

export const PAYMENT_STATES = ['imported', 'normalized', 'linked', 'ignored'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/* ------------------------------------------------------------------------- evidence */

export const EVIDENCE_TYPES = [
  'bank_line',
  'upi_notification',
  'receipt_image',
  'screenshot',
  'email_receipt',
  'manual_note',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/**
 * What a `manual_note` `Evidence` row is *asserting* (ADR-0018).
 *
 * Without this, one shape carries two opposite meanings: ADR-0006 documents an
 * externally-funded expense with a manual note, and ADR-0014 reads a manual note on a
 * contributing expense as "this debt was cleared". Both are `type = manual_note` with
 * `linked_expense_id` set, so the second rule fired on every instance of the first —
 * reporting an obligation as believed-settled the moment it was recorded.
 *
 * Set on manual notes and only on manual notes; see `validateEvidenceNoteKind`.
 */
export const EVIDENCE_NOTE_KINDS = ['documentation', 'settlement_claim'] as const;
export type EvidenceNoteKind = (typeof EVIDENCE_NOTE_KINDS)[number];

/**
 * The document formats evidence storage accepts.
 *
 * An allowlist rather than "whatever was uploaded", for two reasons. Storing arbitrary bytes
 * under a caller-supplied content type is a file-upload vulnerability with extra steps — the
 * type decides how a browser later renders the document back to the user. And phase 11's
 * extraction can only read formats it knows; accepting a `.docx` here would produce evidence
 * that is permanently unreadable by everything downstream of it.
 *
 * Every entry is something a phone camera, a screenshot, or an emailed receipt actually
 * produces. Widening the list is a decision, which is why it is a value set and not a regex.
 */
export const EVIDENCE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;
export type EvidenceMediaType = (typeof EVIDENCE_MEDIA_TYPES)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unknown'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/* ------------------------------------------------------------------------- expenses */

/**
 * Shrunk from the original seven values: `settlement` removed per ADR-0007 (it is the
 * `settlements` table now) and `reimbursement` removed per ADR-0008 (it is
 * `expense_adjustments.kind = 'third_party_reimbursement'` now).
 */
export const EXPENSE_RELATIONSHIP_TYPES = [
  'personal',
  'shared',
  'paid_on_behalf',
  'gift',
  'household_shared_flat',
] as const;
export type ExpenseRelationshipType = (typeof EXPENSE_RELATIONSHIP_TYPES)[number];

/**
 * The relationship types that can create an `Obligation` at all.
 *
 * `personal` and `gift` are absent by construction rather than filtered out afterwards —
 * a stronger guarantee than the original design's exclusion list, and the reason a gift
 * can never generate a debt or reach `READY_TO_SYNC` (`domain-model.md`, Obligation;
 * `scenario-analysis.md` §8).
 */
export const DEBT_CREATING_RELATIONSHIP_TYPES = [
  'shared',
  'paid_on_behalf',
  'household_shared_flat',
] as const;
export type DebtCreatingRelationshipType = (typeof DEBT_CREATING_RELATIONSHIP_TYPES)[number];

/**
 * `rejected` is last because it is an off-ramp, not a step: a proposal a human declined, or
 * one superseded by re-classification (ADR-0028). It is terminal, it is never `APPROVED`, and
 * no total counts it — every `ledger_*` bucket enumerates the states it sums, starting at
 * `approved` (`invariants.md` #20).
 */
export const EXPENSE_STATES = [
  'proposed',
  'classified',
  'review_required',
  'approved',
  'allocated',
  'ready_to_sync',
  'synced',
  'reconciled',
  'rejected',
] as const;
export type ExpenseState = (typeof EXPENSE_STATES)[number];

/* ----------------------------------------------------------------------- allocation */

export const ALLOCATION_METHODS = [
  'equal',
  'exact',
  'percentage',
  'item_based',
  'quantity_based',
  'custom',
] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

/**
 * Methods whose line amounts come straight from an `ExpenseItem`, where the Largest
 * Remainder Method is explicitly not invoked (`invariants.md` #12).
 */
export const ITEM_SOURCED_ALLOCATION_METHODS = ['item_based', 'quantity_based'] as const;
export type ItemSourcedAllocationMethod = (typeof ITEM_SOURCED_ALLOCATION_METHODS)[number];

export const BENEFICIARY_TYPES = ['person', 'group'] as const;
export type BeneficiaryType = (typeof BENEFICIARY_TYPES)[number];

/* ---------------------------------------------------------------------- adjustments */

export const EXPENSE_ADJUSTMENT_KINDS = ['merchant_refund', 'third_party_reimbursement'] as const;
export type ExpenseAdjustmentKind = (typeof EXPENSE_ADJUSTMENT_KINDS)[number];

/** `lifecycle.md`, "ExpenseAdjustment lifecycle". */
export const EXPENSE_ADJUSTMENT_STATES = ['recorded', 'distributed'] as const;
export type ExpenseAdjustmentState = (typeof EXPENSE_ADJUSTMENT_STATES)[number];

/* ----------------------------------------------------------------- AI, rules, audit */

export const AI_INFERENCE_STATUSES = [
  'pending',
  'accepted',
  'modified',
  'rejected',
  'superseded',
] as const;
export type AiInferenceStatus = (typeof AI_INFERENCE_STATUSES)[number];

/**
 * The nine operations `docs/architecture/ai-boundary.md` defines, as the closed set of
 * `ai_inferences.inference_type` values.
 *
 * All nine are listed because the interface they name is the contract, not because all nine
 * are implemented — phase 8 produces `classify_transaction` only. Listing them is what lets
 * the `CHECK` constraint reject a typo'd or invented inference type at the database, so a
 * proposal cannot enter the table under a name no operation produces.
 */
export const AI_INFERENCE_TYPES = [
  'classify_transaction',
  'normalize_merchant',
  'parse_receipt',
  'extract_receipt_items',
  'suggest_beneficiaries',
  'suggest_allocation',
  'group_into_occasion',
  'explain_anomaly',
  'propose_rule',
] as const;
export type AiInferenceType = (typeof AI_INFERENCE_TYPES)[number];

/**
 * What `ai.classifyTransaction` may propose a payment *is* (ADR-0007).
 *
 * Exactly two members. A self-transfer is deliberately absent: recognising one is
 * deterministic evidence over two payment rows, not a semantic judgement, so it never
 * becomes a proposal at all (ADR-0023).
 */
export const AI_PROPOSED_KINDS = ['expense', 'settlement'] as const;
export type ProposedKind = (typeof AI_PROPOSED_KINDS)[number];

export const RULE_ORIGINS = ['manual', 'promoted_from_repeated_ai_suggestion'] as const;
export type RuleOrigin = (typeof RULE_ORIGINS)[number];

export const AUDIT_ACTIONS = ['create', 'update', 'supersede', 'delete'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Entity types that can appear on an `AuditEvent`. Includes `settlement` and
 * `expense_adjustment`, both of which write authoritative state exactly as `allocation`
 * approval does (`invariants.md` #21).
 */
export const AUDITABLE_ENTITY_TYPES = [
  'payment',
  'expense',
  'expense_item',
  'payment_expense_link',
  'allocation',
  'allocation_line',
  'allocation_line_group_expansion',
  'settlement',
  'expense_adjustment',
  'merchant',
  'receipt',
  'ai_inference',
  'rule',
  'splitwise_expense',
  'splitwise_settlement',
  'reconciliation_run',
] as const;
export type AuditableEntityType = (typeof AUDITABLE_ENTITY_TYPES)[number];

/* ---------------------------------------------------------------- integrations/sync */

export const EXTERNAL_INTEGRATION_TYPES = ['splitwise'] as const;
export type ExternalIntegrationType = (typeof EXTERNAL_INTEGRATION_TYPES)[number];

export const EXTERNAL_INTEGRATION_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type ExternalIntegrationStatus = (typeof EXTERNAL_INTEGRATION_STATUSES)[number];

/** `stale` (our side changed) is deliberately distinct from `drifted` (theirs did). */
export const SPLITWISE_EXPENSE_SYNC_STATUSES = [
  'pending',
  'synced',
  'drifted',
  'stale',
  'sync_failed',
] as const;
export type SplitwiseExpenseSyncStatus = (typeof SPLITWISE_EXPENSE_SYNC_STATUSES)[number];

/** A settlement's amount cannot go stale the way an adjusted expense's can. */
export const SPLITWISE_SETTLEMENT_SYNC_STATUSES = [
  'pending',
  'synced',
  'drifted',
  'sync_failed',
] as const;
export type SplitwiseSettlementSyncStatus = (typeof SPLITWISE_SETTLEMENT_SYNC_STATUSES)[number];

/* ----------------------------------------------------------------------- predicates */

/** True when this relationship type can create an obligation between two people. */
export function createsObligation(
  relationshipType: ExpenseRelationshipType,
): relationshipType is DebtCreatingRelationshipType {
  return (DEBT_CREATING_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType);
}

/** True when this counterparty type puts a payment outside spending entirely. */
export function isNonSpendCounterparty(
  counterpartyType: PaymentCounterpartyType,
): counterpartyType is NonSpendCounterpartyType {
  return (NON_SPEND_COUNTERPARTY_TYPES as readonly string[]).includes(counterpartyType);
}

/** True when this allocation method copies its amounts from `ExpenseItem`s. */
export function isItemSourcedMethod(
  method: AllocationMethod,
): method is ItemSourcedAllocationMethod {
  return (ITEM_SOURCED_ALLOCATION_METHODS as readonly string[]).includes(method);
}
