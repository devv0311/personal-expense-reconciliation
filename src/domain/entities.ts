/**
 * Domain entity shapes, translated from `docs/domain/domain-model.md`.
 *
 * These are plain, readonly data structures — no methods, no persistence awareness, no
 * framework types. `src/db` maps rows onto them; `src/services` passes them into the pure
 * functions in this directory.
 *
 * Nullable columns are modelled as `T | null` rather than optional properties, so a field
 * that is absent in SQL is absent in TypeScript for the same reason and cannot be confused
 * with a field the caller merely forgot to set.
 *
 * Entities that exist purely as sync/AI metadata (`AIInference`, `Rule`, `SplitwiseExpense`,
 * `SplitwiseSettlement`, `ExternalIntegration`) are typed here because `src/db` persists
 * them and `domain.obligationEvidenceStatus` reads reconciliation output — but no
 * behaviour in this phase produces them (`docs/roadmap.md` phases 8, 14, 16).
 */

import type {
  AccountType,
  AiInferenceStatus,
  AllocationMethod,
  AuditAction,
  AuditableEntityType,
  BeneficiaryType,
  CashFlowCategory,
  CashFlowState,
  ConfidenceLevel,
  EvidenceNoteKind,
  EvidenceType,
  ExpenseAdjustmentKind,
  ExpenseRelationshipType,
  ExpenseState,
  ExternalIntegrationStatus,
  ExternalIntegrationType,
  PaymentChannel,
  PaymentCounterpartyType,
  PaymentDirection,
  PaymentReferenceType,
  PaymentState,
  ReconciliationVerificationStatus,
  RuleOrigin,
  SplitwiseExpenseSyncStatus,
  SplitwiseSettlementSyncStatus,
} from './enums.js';
import type {
  AccountId,
  AiInferenceId,
  AllocationId,
  AllocationLineGroupExpansionId,
  AllocationLineId,
  AuditEventId,
  EvidenceId,
  ExpenseAdjustmentId,
  ExpenseAdjustmentItemId,
  ExpenseId,
  ExpenseItemId,
  ExpenseOccasionId,
  ExternalIntegrationId,
  GroupId,
  GroupMembershipId,
  ImportBatchId,
  MerchantId,
  PaymentExpenseLinkId,
  PaymentId,
  PersonId,
  ReceiptId,
  ReceiptItemId,
  ReconciliationAccountSnapshotId,
  ReconciliationRunId,
  RuleId,
  SettlementId,
  SplitwiseExpenseId,
  SplitwiseSettlementId,
  UserId,
} from './ids.js';
import type { CurrencyCode, Paise } from './money.js';

/* ============================================================== people and structure */

/** The authenticated owner/operator. SYSTEM. */
export interface User {
  readonly id: UserId;
  readonly email: string;
  /** The `Person` row representing this user inside the financial graph. */
  readonly personId: PersonId;
  readonly createdAt: Date;
}

/** A party in the financial graph — the user, a flatmate, a friend. SYSTEM. */
export interface Person {
  readonly id: PersonId;
  readonly displayName: string;
  /** Set when this person also has a login. Exactly one `Person` maps to the user. */
  readonly linkedUserId: UserId | null;
  readonly splitwiseUserId: string | null;
  readonly notes: string | null;
  readonly archivedAt: Date | null;
}

/**
 * A named collection of people who share expenses. A data-entry convenience — never
 * itself a debtor or creditor (ADR-0009).
 */
export interface Group {
  readonly id: GroupId;
  readonly name: string;
  /** Advisory free-text label ("flat", "trip"); not structurally special-cased. */
  readonly type: string | null;
  readonly archivedAt: Date | null;
}

/**
 * Membership as a time-ranged fact, not a static link — required so a historical
 * allocation does not silently change meaning when someone moves in or out
 * (`scenario-analysis.md` §23, §33).
 */
export interface GroupMembership {
  readonly id: GroupMembershipId;
  readonly groupId: GroupId;
  readonly personId: PersonId;
  readonly joinedAt: Date;
  /** `null` means currently a member. */
  readonly leftAt: Date | null;
}

/** An account money moves through. Always owned by the user. SYSTEM. */
export interface Account {
  readonly id: AccountId;
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly type: AccountType;
  readonly institution: string | null;
  /** A redacted trailing identifier — never a full account or card number. */
  readonly last4: string | null;
  readonly currency: CurrencyCode;
  readonly isActive: boolean;
  readonly archivedAt: Date | null;
}

/** A normalized non-person counterparty. DERIVED resolution, SYSTEM registry. */
export interface Merchant {
  readonly id: MerchantId;
  readonly canonicalName: string;
  readonly defaultCategory: string | null;
  readonly archivedAt: Date | null;
}

/** A raw source string that resolves to exactly one merchant. */
export interface MerchantAlias {
  readonly merchantId: MerchantId;
  readonly rawPattern: string;
}

/* ================================================================= payments, sources */

/** One import operation. SOURCE/SYSTEM, immutable once created. */
export interface ImportBatch {
  readonly id: ImportBatchId;
  readonly sourceChannel: string;
  readonly fileReference: string | null;
  /** Content hash, so re-importing the same file is detectable. */
  readonly contentHash: string | null;
  readonly importedAt: Date;
  readonly parserVersion: string | null;
  readonly rowCount: number | null;
}

/**
 * What actually caused money to leave or enter an `Account` the user owns. SOURCE.
 *
 * `amount`, `occurredAt`, `rawDescription` and `accountId` are write-once
 * (`invariants.md` #4). A `Payment` can never, by itself, represent money someone else
 * spent — see `Expense.paidByPersonId` and ADR-0006.
 */
export interface Payment {
  readonly id: PaymentId;
  readonly accountId: AccountId;
  readonly importBatchId: ImportBatchId;
  readonly amount: Paise;
  readonly currency: CurrencyCode;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  readonly rawDescription: string;
  readonly channel: PaymentChannel;
  readonly counterpartyType: PaymentCounterpartyType;
  /** Polymorphic per `counterpartyType`; validated in `services`, no DB-level FK. */
  readonly counterpartyId: string | null;
  /** UTR/RRN/bank reference/order ID — the deterministic dedup key (ADR-0010). */
  readonly externalReference: string | null;
  readonly referenceType: PaymentReferenceType | null;
  /** Originating app/institution, e.g. `hdfc_bank_csv` — distinct from `channel`. */
  readonly sourceSystem: string | null;
  readonly state: PaymentState;
  readonly ignoredReason: string | null;
  /**
   * What role this movement plays in the account's cash, orthogonal to `counterpartyType`
   * (ADR-0017 (cash balance)).
   *
   * `null` on an ordinary purchase or investment debit, which keeps its existing
   * explanation. `null` on a credit means the credit is **unexplained** — never that it was
   * income.
   */
  readonly cashFlowCategory: CashFlowCategory | null;
  /**
   * Where this payment stands in the cash-flow *interpretation* lifecycle, alongside — never
   * instead of — `state` (`lifecycle.md`, "Cash-flow classification lifecycle").
   */
  readonly cashFlowState: CashFlowState;
  /** When the cash-flow role was approved; `null` until it is. */
  readonly cashFlowApprovedAt: Date | null;
  /** `'user'` or `'rule:<rule_id>'` — never `'ai'` and never a model's confidence. */
  readonly cashFlowApprovedBy: string | null;
}

/** Any document or information supporting an interpretation. SOURCE, immutable. */
export interface Evidence {
  readonly id: EvidenceId;
  readonly type: EvidenceType;
  /** `null` for manual notes, which have no file. */
  readonly storageRef: string | null;
  readonly rawText: string | null;
  readonly capturedAt: Date;
  readonly linkedPaymentId: PaymentId | null;
  readonly linkedExpenseId: ExpenseId | null;
  /**
   * What a manual note asserts (ADR-0018). Non-null exactly when `type = 'manual_note'`.
   *
   * Without it, documenting an externally-funded expense (ADR-0006) and claiming a debt was
   * cleared (ADR-0014) are the same row shape, and the second reading fires on every
   * instance of the first.
   */
  readonly noteKind: EvidenceNoteKind | null;
}

/**
 * The structured interpretation of receipt-type evidence. DERIVED.
 *
 * Deliberately has no `paymentId`/`expenseId` of its own — linkage runs through
 * `evidenceId`, or, when one receipt spans several expenses, through
 * `ReceiptItem → ExpenseItem → Expense` (`domain-model.md`, `Receipt`).
 */
export interface Receipt {
  readonly id: ReceiptId;
  readonly evidenceId: EvidenceId;
  readonly merchantId: MerchantId | null;
  readonly subtotal: Paise | null;
  readonly tax: Paise | null;
  readonly total: Paise | null;
  readonly currency: CurrencyCode;
  readonly extractionConfidence: ConfidenceLevel | null;
  readonly extractedAt: Date | null;
  readonly confirmedByUser: boolean;
}

/** A single line item on a receipt. DERIVED. */
export interface ReceiptItem {
  readonly id: ReceiptItemId;
  readonly receiptId: ReceiptId;
  readonly description: string;
  /** Quantity is a count/measure, not money — the one deliberately non-integer figure. */
  readonly quantity: string;
  readonly unitPrice: Paise | null;
  readonly lineTotal: Paise;
  readonly suggestedCategory: string | null;
}

/* ================================================================ expenses, spending */

/**
 * What the money was actually for — always a **spend event**, never a settlement or an
 * adjustment (`domain-model.md`, "two categories of financial event").
 */
export interface Expense {
  readonly id: ExpenseId;
  readonly description: string | null;
  /** Gross, historical. Never changes once `approved` (`invariants.md` #6). */
  readonly amount: Paise;
  readonly currency: CurrencyCode;
  readonly occurredAt: Date;
  readonly relationshipType: ExpenseRelationshipType;
  readonly category: string | null;
  readonly occasionId: ExpenseOccasionId | null;
  /**
   * Who actually fronted the money — **not necessarily the user** (ADR-0006). When this
   * is not the user's `Person`, the expense will never have a `PaymentExpenseLink`, by
   * design rather than as a pending state.
   */
  readonly paidByPersonId: PersonId;
  readonly state: ExpenseState;
}

/** The allocateable unit within an expense, for item/quantity-based allocation. */
export interface ExpenseItem {
  readonly id: ExpenseItemId;
  readonly expenseId: ExpenseId;
  readonly description: string;
  readonly amount: Paise;
  readonly quantity: string;
  readonly receiptItemId: ReceiptItemId | null;
}

/** An optional grouping of related expenses that happened together. */
export interface ExpenseOccasion {
  readonly id: ExpenseOccasionId;
  readonly name: string;
  readonly occurredStart: Date;
  /** `null` for a single-evening occasion; set for a trip (`scenario-analysis.md` §10). */
  readonly occurredEnd: Date | null;
  /** Suggestion defaults only — never retroactively alters an approved allocation. */
  readonly defaultParticipants: ReadonlyArray<{
    readonly type: BeneficiaryType;
    readonly id: string;
  }>;
}

/** The portion of a payment attributed to one expense. APPROVED. */
export interface PaymentExpenseLink {
  readonly id: PaymentExpenseLinkId;
  readonly paymentId: PaymentId;
  readonly expenseId: ExpenseId;
  readonly amount: Paise;
}

/* ============================================================ allocation and shares */

/**
 * How an expense is divided among beneficiaries. APPROVED.
 *
 * Versioned, never edited in place: a correction or an adjustment distribution creates a
 * new `Allocation` and sets `supersededAt` on the previous one (`invariants.md` #6).
 */
export interface Allocation {
  readonly id: AllocationId;
  readonly expenseId: ExpenseId;
  readonly method: AllocationMethod;
  readonly decidedAt: Date;
  /** `'manual'` or `'rule:<rule_id>'` (`invariants.md` #17). */
  readonly decidedBy: string;
  /** `null` while this is the current allocation for its expense. */
  readonly supersededAt: Date | null;
}

/** One beneficiary's share within an allocation. APPROVED. */
export interface AllocationLine {
  readonly id: AllocationLineId;
  readonly allocationId: AllocationId;
  readonly beneficiaryType: BeneficiaryType;
  /** A `PersonId` or `GroupId` per `beneficiaryType`; polymorphic, no single DB FK. */
  readonly beneficiaryId: string;
  /** Always authoritative, whatever the method. `>= 0` (`invariants.md` #12a). */
  readonly amount: Paise;
  /** Informational only when the method is `percentage` (`invariants.md` #13). */
  readonly percentage: string | null;
  readonly expenseItemId: ExpenseItemId | null;
}

/**
 * The per-member resolution of a `group`-typed line, snapshotted at approval time from
 * membership active as of `Expense.occurredAt`. Written once, never recomputed (ADR-0009).
 */
export interface AllocationLineGroupExpansion {
  readonly id: AllocationLineGroupExpansionId;
  readonly allocationLineId: AllocationLineId;
  readonly personId: PersonId;
  readonly amount: Paise;
}

/* =========================================================== discharge and adjustment */

/**
 * Discharges an existing obligation. Never an `Expense`, never has an `Allocation`
 * (`invariants.md` #9a, ADR-0007). Direction is read from the linked payment.
 */
export interface Settlement {
  readonly id: SettlementId;
  readonly paymentId: PaymentId;
  readonly counterpartyPersonId: PersonId;
  readonly amount: Paise;
  readonly reason: string | null;
  readonly recordedAt: Date;
}

/**
 * Money returned against an existing expense, without changing what that expense
 * originally cost (ADR-0008). `amount` is always a positive magnitude — there is no
 * signed/negative adjustment (`invariants.md` #12a).
 */
export interface ExpenseAdjustment {
  readonly id: ExpenseAdjustmentId;
  readonly originalExpenseId: ExpenseId;
  readonly kind: ExpenseAdjustmentKind;
  readonly amount: Paise;
  /** The credit payment documenting the money coming back; `null` if evidence-first. */
  readonly adjustmentPaymentId: PaymentId | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

/**
 * Which purchased item a refund/reimbursement actually gave money back for
 * (ADR-0018 (item refunds)).
 *
 * A cost reduction, never a beneficiary share: whole-expense proportional distribution
 * cannot express that the friend's ₹400 item was the one returned, and would quietly reduce
 * a debt owed by someone whose item was never refunded. Deliberately carries none of the
 * parent's context — expense identity, kind, date, approval and the optional credit
 * `Payment` all live on the `ExpenseAdjustment`, and duplicating them here would create two
 * places for them to disagree.
 */
export interface ExpenseAdjustmentItem {
  readonly id: ExpenseAdjustmentItemId;
  readonly expenseAdjustmentId: ExpenseAdjustmentId;
  /** The original purchased item. Its `expenseId` must equal the parent's `originalExpenseId` (19.1). */
  readonly expenseItemId: ExpenseItemId;
  /** Strictly positive integer paise. There is no zero, negative or signed attribution (19.4). */
  readonly amount: Paise;
}

/* ================================================================== audit and AI */

/** Append-only. Never edited, never deleted (`invariants.md` #22). */
export interface AuditEvent {
  readonly id: AuditEventId;
  readonly entityType: AuditableEntityType;
  readonly entityId: string;
  readonly action: AuditAction;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  /** `'user'`, `'rule:<rule_id>'`, or `'system'`. */
  readonly actor: string;
  readonly source: string | null;
  readonly reason: string | null;
  readonly aiInferenceId: AiInferenceId | null;
  readonly occurredAt: Date;
}

/** A single AI-produced proposal. DERIVED, always. */
export interface AiInference {
  readonly id: AiInferenceId;
  readonly inferenceType: string;
  readonly inputRefType: string;
  readonly inputRefId: string;
  readonly proposedOutput: unknown;
  readonly confidence: ConfidenceLevel;
  readonly modelProvider: string | null;
  readonly modelName: string | null;
  readonly promptVersion: string | null;
  readonly status: AiInferenceStatus;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly resultingRecordType: string | null;
  readonly resultingRecordId: string | null;
}

/** A user-approved pattern that pre-classifies future matching transactions. */
export interface Rule {
  readonly id: RuleId;
  readonly matchPattern: unknown;
  readonly proposedClassification: unknown;
  readonly origin: RuleOrigin;
  readonly active: boolean;
  readonly timesApplied: number;
}

/* ============================================================ integrations and sync */

export interface ExternalIntegration {
  readonly id: ExternalIntegrationId;
  readonly type: ExternalIntegrationType;
  readonly ownerUserId: UserId;
  readonly externalAccountRef: string | null;
  readonly status: ExternalIntegrationStatus;
  readonly connectedAt: Date | null;
  readonly lastSyncedAt: Date | null;
}

export interface SplitwiseExpense {
  readonly id: SplitwiseExpenseId;
  readonly expenseId: ExpenseId;
  readonly externalIntegrationId: ExternalIntegrationId;
  readonly splitwiseExpenseId: string;
  readonly syncedAt: Date;
  readonly ourSnapshot: unknown;
  readonly theirSnapshot: unknown;
  readonly syncStatus: SplitwiseExpenseSyncStatus;
}

export interface SplitwiseSettlement {
  readonly id: SplitwiseSettlementId;
  readonly settlementId: SettlementId;
  readonly externalIntegrationId: ExternalIntegrationId;
  readonly splitwiseTransactionId: string;
  readonly syncedAt: Date;
  readonly ourSnapshot: unknown;
  readonly theirSnapshot: unknown;
  readonly syncStatus: SplitwiseSettlementSyncStatus;
}

/* ====================================================================== reconciliation */

/** A recorded snapshot of a reconciliation check. SYSTEM (derived report). */
export interface ReconciliationRun {
  readonly id: ReconciliationRunId;
  readonly runAt: Date;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly ledgerTotalOutflow: Paise;
  readonly ledgerTransfersTotal: Paise;
  readonly ledgerInvestmentsTotal: Paise;
  readonly ledgerSettlementsTotal: Paise;
  /** Sums `netAmount(expense)`, not gross `Expense.amount` (ADR-0008). */
  readonly ledgerExplainedTotal: Paise;
  readonly ledgerUnexplainedTotal: Paise;
  readonly splitwiseBalancesSnapshot: unknown;
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
  readonly resolvedAt: Date | null;
}

/**
 * One surfaced gap. Only the shape `domain.obligationEvidenceStatus` actually reads is
 * modelled concretely (ADR-0014). Phase 15 (`docs/roadmap.md`), the reconciliation phase this
 * comment once deferred to, confirmed rather than resolved the deferral: `kind` stays a loose
 * `string` (`'splitwise_balance_mismatch'`, `'splitwise_fetch_failed'`, ADR-0041) — a union
 * would buy nothing `compareSplitwiseBalance`'s own return type doesn't already give its one
 * caller, and every consumer (`DiscrepancyList` in `web/`) already falls back gracefully for an
 * unrecognised kind by design.
 */
export interface ReconciliationDiscrepancy {
  readonly kind: string;
  readonly detail: string;
  /** Set for a pairwise balance discrepancy against Splitwise. */
  readonly personAId?: PersonId;
  readonly personBId?: PersonId;
  /** What Splitwise reports A owes B, when this discrepancy is a balance disagreement. */
  readonly externalNetBalance?: Paise;
  readonly resolvedAt?: Date | null;
}

/**
 * One gap surfaced by an account's cash reconciliation (ADR-0017 (cash balance), 17.6).
 *
 * Deliberately its own type rather than a reuse of {@link ReconciliationDiscrepancy}: that one
 * describes a disagreement with Splitwise between two *people*, this one describes a
 * disagreement about one *account's* cash, and the fields that explain each have nothing in
 * common. Sharing a shape would make both halves optional on every row and force every reader
 * to guess which kind it was holding.
 */
export interface CashReconciliationDiscrepancy {
  readonly kind: CashDiscrepancyKind;
  readonly detail: string;
  /** The signed or positive-magnitude figure the discrepancy is about, when there is one. */
  readonly amount?: Paise;
  /** The movement a transfer-pairing or coverage discrepancy points at. */
  readonly paymentId?: PaymentId;
}

/**
 * The gaps an account snapshot can surface.
 *
 * A closed set, unlike {@link ReconciliationDiscrepancy}'s loose `kind` — every value here is
 * produced by one branch of `domain.computeAccountCashSnapshot` and read by the verification
 * rule, so an unrecognised value would mean a snapshot nothing can classify.
 */
export type CashDiscrepancyKind =
  /** No evidenced opening balance, so the identity cannot be computed at all (17.5). */
  | 'missing_opening_balance'
  /** No evidenced closing balance, so there is nothing to check the arithmetic against (17.5). */
  | 'missing_closing_balance'
  /** `actual_ending_balance` and `expected_ending_balance` disagree (17.4). */
  | 'cash_balance_delta_nonzero'
  /** Debits this account cannot explain from approved links, settlements or categories (17.6). */
  | 'unexplained_debits'
  /** Credits this account cannot explain — including every unclassified credit (17.2, 17.6). */
  | 'unexplained_credits'
  /** An internal-transfer leg whose counter-leg is missing, out of scope, or in another period (17.3). */
  | 'unpaired_internal_transfer';

/**
 * One account's evidence-backed bank reconciliation for one run (ADR-0017 (cash balance)).
 *
 * SYSTEM, immutable, and deliberately **not** an editable balance authority: it records what
 * the inputs said at the moment the run happened. Later evidence produces a new run, never an
 * edit that certifies an old one (17.7).
 *
 * Balances and `cashBalanceDelta` are signed — an overdraft is a real balance — so the
 * non-negative money rule applies to the movement and explanation totals only, never to these.
 */
export interface ReconciliationAccountSnapshot {
  readonly id: ReconciliationAccountSnapshotId;
  readonly reconciliationRunId: ReconciliationRunId;
  readonly accountId: AccountId;
  readonly currency: CurrencyCode;
  /** The parent run's interval, half-open `[start, end)` for posted movements. */
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** Actual statement balances. `null` when the evidence is missing — never fabricated as zero. */
  readonly openingBalance: Paise | null;
  readonly closingBalance: Paise | null;
  readonly openingBalanceEvidenceId: EvidenceId | null;
  readonly closingBalanceEvidenceId: EvidenceId | null;
  /** Positive-magnitude totals of every distinct posted movement, gross and counted once. */
  readonly totalDebits: Paise;
  readonly totalCredits: Paise;
  /** Subsets of the totals above, not additional terms to add or subtract (17.3). */
  readonly internalTransferDebits: Paise;
  readonly internalTransferCredits: Paise;
  readonly explainedDebits: Paise;
  readonly unexplainedDebits: Paise;
  readonly explainedCredits: Paise;
  readonly unexplainedCredits: Paise;
  /** `opening + credits - debits`, and `closing - expected`. Both `null` until both boundaries are evidenced. */
  readonly expectedEndingBalance: Paise | null;
  readonly cashBalanceDelta: Paise | null;
  readonly verificationStatus: ReconciliationVerificationStatus;
  readonly discrepancies: readonly CashReconciliationDiscrepancy[];
  /**
   * The inputs this run actually read — payment ids, the classification behind each
   * explanation, and transfer pair references — so a later reclassification cannot
   * reinterpret a past run (17.7).
   */
  readonly provenance: unknown;
  readonly createdAt: Date;
}
