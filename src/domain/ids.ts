/**
 * Branded identifier types.
 *
 * Every entity's `id` is a UUID string at rest (`docs/architecture/database-design.md`).
 * Branding them per-entity means a `PersonId` cannot be passed where a `GroupId` is
 * expected — which matters here more than usual, because `AllocationLine.beneficiary_id`
 * is polymorphic over `Person`/`Group` and a mix-up would silently produce a wrong
 * obligation rather than a type error.
 */

declare const ID_BRAND: unique symbol;

/** A UUID identifying an entity of type `T`. */
export type Id<T extends string> = string & { readonly [ID_BRAND]: T };

export type UserId = Id<'user'>;
export type PersonId = Id<'person'>;
export type GroupId = Id<'group'>;
export type GroupMembershipId = Id<'group_membership'>;
export type AccountId = Id<'account'>;
export type MerchantId = Id<'merchant'>;
export type ImportBatchId = Id<'import_batch'>;
export type PaymentId = Id<'payment'>;
export type EvidenceId = Id<'evidence'>;
export type EvidenceObservationId = Id<'evidence_observation'>;
export type EvidenceMatchCandidateId = Id<'evidence_match_candidate'>;
export type ReceiptId = Id<'receipt'>;
export type ReceiptItemId = Id<'receipt_item'>;
export type ExpenseId = Id<'expense'>;
export type ExpenseItemId = Id<'expense_item'>;
export type ExpenseOccasionId = Id<'expense_occasion'>;
export type PaymentExpenseLinkId = Id<'payment_expense_link'>;
export type AllocationId = Id<'allocation'>;
export type AllocationLineId = Id<'allocation_line'>;
export type AllocationLineGroupExpansionId = Id<'allocation_line_group_expansion'>;
export type SettlementId = Id<'settlement'>;
export type ExpenseAdjustmentId = Id<'expense_adjustment'>;
export type ExpenseAdjustmentItemId = Id<'expense_adjustment_item'>;
export type AiInferenceId = Id<'ai_inference'>;
export type RuleId = Id<'rule'>;
export type AuditEventId = Id<'audit_event'>;
export type ExternalIntegrationId = Id<'external_integration'>;
export type SplitwiseExpenseId = Id<'splitwise_expense'>;
export type SplitwiseSettlementId = Id<'splitwise_settlement'>;
export type ReconciliationRunId = Id<'reconciliation_run'>;
export type ReconciliationAccountSnapshotId = Id<'reconciliation_account_snapshot'>;

/**
 * Tags a raw string as an `Id` of a given entity type.
 *
 * A cast, not a validator — persistence and API boundaries are where UUID shape is
 * checked; `domain` receives already-validated data. Kept as a named function so those
 * casts are greppable rather than scattered `as` expressions.
 */
export function asId<T extends string>(value: string): Id<T> {
  return value as Id<T>;
}

/** A polymorphic reference to whoever benefited from an allocation line. */
export type BeneficiaryRef =
  | { readonly type: 'person'; readonly id: PersonId }
  | { readonly type: 'group'; readonly id: GroupId };

/**
 * The stable text key used to order a beneficiary in a split's tie-break
 * (`invariants.md` #12, step 4). Just the ID — the type discriminator is deliberately not
 * part of it, so the rule stays "sorted ascending as plain UUID text".
 */
export function beneficiarySortKey(ref: BeneficiaryRef): string {
  return ref.id;
}

/** Structural equality for beneficiary references. */
export function sameBeneficiary(a: BeneficiaryRef, b: BeneficiaryRef): boolean {
  return a.type === b.type && a.id === b.id;
}
