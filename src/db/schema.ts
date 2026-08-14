/**
 * The PostgreSQL schema, translated from `docs/architecture/database-design.md`.
 *
 * Conventions carried over from that document:
 *
 *  - Every monetary column is `bigint` **paise**. Never `numeric`, never `double precision`
 *    (`invariants.md` #12). Read back as a JavaScript `bigint`, never a `number`.
 *  - SOURCE tables (`payments`, `evidence`, `import_batches`) have no `updated_at` and are
 *    never `UPDATE`d by `src/services`. `drizzle/security/immutable-table-grants.sql`
 *    carries the role-level `REVOKE` that makes an accidental attempt fail at the database
 *    too, rather than silently succeed (defence in depth, `database-design.md`).
 *  - Cross-row sum invariants (allocation lines summing to net amount, links not exceeding
 *    a payment) are enforced in `src/domain` inside one transaction, not by triggers, so
 *    the rule lives in one place rather than split between TypeScript and SQL.
 *  - Per-row checks that a `CHECK` can express are expressed as one, and the enum value
 *    lists come from `src/domain/enums.ts` so the schema and the domain cannot drift.
 *  - Soft delete (`archived_at`) for anything financial history may reference.
 */

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  ACCOUNT_TYPES,
  AI_INFERENCE_STATUSES,
  ALLOCATION_METHODS,
  AUDITABLE_ENTITY_TYPES,
  AUDIT_ACTIONS,
  BENEFICIARY_TYPES,
  CONFIDENCE_LEVELS,
  EVIDENCE_NOTE_KINDS,
  EVIDENCE_TYPES,
  EXPENSE_ADJUSTMENT_KINDS,
  EXPENSE_RELATIONSHIP_TYPES,
  EXPENSE_STATES,
  EXTERNAL_INTEGRATION_STATUSES,
  EXTERNAL_INTEGRATION_TYPES,
  PAYMENT_CHANNELS,
  PAYMENT_COUNTERPARTY_TYPES,
  PAYMENT_DIRECTIONS,
  PAYMENT_REFERENCE_TYPES,
  PAYMENT_STATES,
  RULE_ORIGINS,
  SPLITWISE_EXPENSE_SYNC_STATUSES,
  SPLITWISE_SETTLEMENT_SYNC_STATUSES,
} from '../domain/enums.js';
import { SETTLEMENT_CLAIM_NOTE_KIND } from '../domain/evidence.js';

/**
 * Builds an `IN (...)` check from a domain enum array.
 *
 * `sql.raw` is safe here: the values come from `const` arrays in `src/domain/enums.ts`,
 * never from user input or a database read.
 */
function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);
}

/** Every table gets these two, per `database-design.md`'s conventions. */
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
/** A monetary column: integer minor units, read back as `bigint`. */
const paiseColumn = (name: string) => bigint(name, { mode: 'bigint' });

/* ==================================================================== people & structure */

/**
 * `people` and `users` reference each other (a user names its ledger `Person`; a person may
 * name its login). The `linked_user_id` FK is declared lazily so both directions keep a real
 * database-level constraint rather than one of them being downgraded to an application check.
 */
export const people = pgTable(
  'people',
  {
    id: id(),
    displayName: text('display_name').notNull(),
    linkedUserId: uuid('linked_user_id').references((): AnyPgColumn => users.id),
    splitwiseUserId: text('splitwise_user_id'),
    notes: text('notes'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // A User maps to exactly one Person; many people simply have no login.
    uniqueIndex('people_linked_user_id_unique')
      .on(table.linkedUserId)
      .where(sql`${table.linkedUserId} is not null`),
  ],
);

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  personId: uuid('person_id')
    .notNull()
    .references(() => people.id),
  passwordHash: text('password_hash'),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    type: text('type').notNull(),
    institution: text('institution'),
    /** A redacted trailing identifier only — never a full account or card number. */
    last4: text('last4'),
    currency: text('currency').notNull().default('INR'),
    isActive: boolean('is_active').notNull().default(true),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index('accounts_owner_active_idx').on(table.ownerUserId, table.isActive),
    check('accounts_type_check', oneOf('type', ACCOUNT_TYPES)),
    // Enforces `security-model.md`'s "no full account/card number is ever stored" at the
    // database, not only by convention.
    check('accounts_last4_check', sql`${table.last4} is null or ${table.last4} ~ '^[0-9]{1,4}$'`),
  ],
);

export const groups = pgTable('groups', {
  id: id(),
  name: text('name').notNull(),
  /** Advisory label ("flat", "trip") — never structurally special-cased. */
  type: text('type'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Membership as a time-ranged fact. Deliberately **no** unique constraint forcing one active
 * row per person/group: leaving and re-joining is valid, and each stint is its own row
 * (`scenario-analysis.md` §23).
 */
export const groupMemberships = pgTable(
  'group_memberships',
  {
    id: id(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index('group_memberships_lookup_idx').on(table.groupId, table.personId, table.joinedAt),
    check(
      'group_memberships_range_check',
      sql`${table.leftAt} is null or ${table.leftAt} >= ${table.joinedAt}`,
    ),
  ],
);

export const merchants = pgTable('merchants', {
  id: id(),
  canonicalName: text('canonical_name').notNull(),
  defaultCategory: text('default_category'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const merchantAliases = pgTable('merchant_aliases', {
  id: id(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id),
  /** An alias resolves to exactly one merchant. */
  rawPattern: text('raw_pattern').notNull().unique(),
  createdAt: createdAt(),
});

/* ========================================================================= payments */

/** SOURCE, immutable. No `updated_at` by design. */
export const importBatches = pgTable('import_batches', {
  id: id(),
  sourceChannel: text('source_channel').notNull(),
  fileReference: text('file_reference'),
  /** Content hash, so re-importing the same file is detectable. */
  contentHash: text('content_hash').unique(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  parserVersion: text('parser_version'),
  rowCount: integer('row_count'),
  createdAt: createdAt(),
});

/**
 * SOURCE, immutable. `amount`, `occurred_at`, `raw_description` and `account_id` are
 * write-once (`invariants.md` #4); corrections happen in other tables.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    importBatchId: uuid('import_batch_id')
      .notNull()
      .references(() => importBatches.id),
    amount: paiseColumn('amount').notNull(),
    currency: text('currency').notNull().default('INR'),
    direction: text('direction').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    rawDescription: text('raw_description').notNull(),
    channel: text('channel').notNull(),
    counterpartyType: text('counterparty_type').notNull().default('unknown'),
    /** Polymorphic per `counterparty_type`; validated in `services`, so no single FK. */
    counterpartyId: uuid('counterparty_id'),
    /** UTR/RRN/bank reference/order ID — the deterministic dedup key (ADR-0010). */
    externalReference: text('external_reference'),
    referenceType: text('reference_type'),
    /** Originating app/institution, e.g. `hdfc_bank_csv`. Distinct from `channel`. */
    sourceSystem: text('source_system'),
    state: text('state').notNull().default('imported'),
    ignoredReason: text('ignored_reason'),
    createdAt: createdAt(),
  },
  (table) => [
    index('payments_account_occurred_idx').on(table.accountId, table.occurredAt),
    index('payments_dedup_idx').on(table.amount, table.occurredAt, table.accountId),
    // Global, deliberately NOT scoped by account_id: one real transaction can land under two
    // different Account rows when two import channels capture it (ADR-0010's amendment).
    // A partial index, not a unique constraint — some sources legitimately reuse references.
    index('payments_external_reference_idx')
      .on(table.externalReference)
      .where(sql`${table.externalReference} is not null`),
    check('payments_amount_check', sql`${table.amount} > 0`),
    check('payments_direction_check', oneOf('direction', PAYMENT_DIRECTIONS)),
    check('payments_channel_check', oneOf('channel', PAYMENT_CHANNELS)),
    check(
      'payments_counterparty_type_check',
      oneOf('counterparty_type', PAYMENT_COUNTERPARTY_TYPES),
    ),
    check(
      'payments_reference_type_check',
      sql`${table.referenceType} is null or ${oneOf('reference_type', PAYMENT_REFERENCE_TYPES)}`,
    ),
    check('payments_state_check', oneOf('state', PAYMENT_STATES)),
  ],
);

/* ========================================================================= evidence */

/** SOURCE, immutable. Superseding evidence is a new row, never an edit. */
export const evidence = pgTable(
  'evidence',
  {
    id: id(),
    type: text('type').notNull(),
    /** Null for a manual note, which has no file. */
    storageRef: text('storage_ref'),
    rawText: text('raw_text'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    linkedPaymentId: uuid('linked_payment_id').references(() => payments.id),
    linkedExpenseId: uuid('linked_expense_id').references((): AnyPgColumn => expenses.id),
    /**
     * What a manual note asserts — documentation, or a claim that a debt was cleared
     * (ADR-0018). Required on manual notes, forbidden on every other evidence type.
     */
    noteKind: text('note_kind'),
    createdAt: createdAt(),
  },
  (table) => [
    index('evidence_linked_payment_idx').on(table.linkedPaymentId),
    index('evidence_linked_expense_idx').on(table.linkedExpenseId),
    // Settlement-claim notes are read on every balance query; a partial index keeps that
    // lookup off the far more numerous documentation rows.
    index('evidence_settlement_claim_idx')
      .on(table.linkedExpenseId)
      .where(sql.raw(`note_kind = '${SETTLEMENT_CLAIM_NOTE_KIND}'`)),
    check('evidence_type_check', oneOf('type', EVIDENCE_TYPES)),
    check(
      'evidence_note_kind_check',
      sql`${table.noteKind} is null or ${oneOf('note_kind', EVIDENCE_NOTE_KINDS)}`,
    ),
    // A manual note must say which of the two things it is; nothing else may claim to be
    // either. This is what stops one shape carrying two opposite meanings (ADR-0018).
    check(
      'evidence_note_kind_only_on_notes_check',
      sql`(${table.type} = 'manual_note') = (${table.noteKind} is not null)`,
    ),
  ],
);

/**
 * DERIVED. Deliberately has **no** `payment_id` or `expense_id` column — linkage runs
 * through `evidence_id`, or, when one receipt spans several expenses, through
 * `receipt_items → expense_items → expenses` (`database-design.md`).
 */
export const receipts = pgTable(
  'receipts',
  {
    id: id(),
    evidenceId: uuid('evidence_id')
      .notNull()
      .references(() => evidence.id),
    merchantId: uuid('merchant_id').references(() => merchants.id),
    subtotal: paiseColumn('subtotal'),
    tax: paiseColumn('tax'),
    total: paiseColumn('total'),
    currency: text('currency').notNull().default('INR'),
    extractionConfidence: text('extraction_confidence'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    confirmedByUser: boolean('confirmed_by_user').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('receipts_evidence_idx').on(table.evidenceId),
    check(
      'receipts_extraction_confidence_check',
      sql`${table.extractionConfidence} is null or ${oneOf('extraction_confidence', CONFIDENCE_LEVELS)}`,
    ),
  ],
);

export const receiptItems = pgTable(
  'receipt_items',
  {
    id: id(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id),
    description: text('description').notNull(),
    /** A count/measure, not money — the one deliberately non-integer numeric here. */
    quantity: numeric('quantity', { precision: 10, scale: 3 }).notNull().default('1'),
    unitPrice: paiseColumn('unit_price'),
    lineTotal: paiseColumn('line_total').notNull(),
    suggestedCategory: text('suggested_category'),
    createdAt: createdAt(),
  },
  (table) => [index('receipt_items_receipt_idx').on(table.receiptId)],
);

/* ========================================================================= expenses */

export const expenseOccasions = pgTable('expense_occasions', {
  id: id(),
  name: text('name').notNull(),
  occurredStart: date('occurred_start', { mode: 'date' }).notNull(),
  /** A range, not a single date — a trip spans days (`scenario-analysis.md` §10). */
  occurredEnd: date('occurred_end', { mode: 'date' }),
  defaultParticipants: jsonb('default_participants')
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
});

/**
 * `amount` is gross, historical, and joins the immutability class once the expense reaches
 * `approved` — it never changes again by any mechanism (`invariants.md` #6, ADR-0008).
 */
export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    description: text('description'),
    amount: paiseColumn('amount').notNull(),
    currency: text('currency').notNull().default('INR'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    relationshipType: text('relationship_type').notNull(),
    category: text('category'),
    occasionId: uuid('occasion_id').references(() => expenseOccasions.id),
    /** Who actually fronted the money — not necessarily the user (ADR-0006). */
    paidByPersonId: uuid('paid_by_person_id')
      .notNull()
      .references(() => people.id),
    state: text('state').notNull().default('proposed'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('expenses_state_idx').on(table.state),
    index('expenses_occasion_idx').on(table.occasionId),
    index('expenses_paid_by_idx').on(table.paidByPersonId),
    check('expenses_amount_check', sql`${table.amount} > 0`),
    check(
      'expenses_relationship_type_check',
      oneOf('relationship_type', EXPENSE_RELATIONSHIP_TYPES),
    ),
    check('expenses_state_check', oneOf('state', EXPENSE_STATES)),
  ],
);

export const expenseItems = pgTable(
  'expense_items',
  {
    id: id(),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id),
    description: text('description').notNull(),
    amount: paiseColumn('amount').notNull(),
    quantity: numeric('quantity', { precision: 10, scale: 3 }).notNull().default('1'),
    receiptItemId: uuid('receipt_item_id').references(() => receiptItems.id),
    createdAt: createdAt(),
  },
  (table) => [
    index('expense_items_expense_idx').on(table.expenseId),
    // Not in database-design.md's column list; added because a negative item amount would
    // silently break invariant #14's per-item sums. A strengthening, never a weakening.
    check('expense_items_amount_check', sql`${table.amount} >= 0`),
  ],
);

/**
 * Only ever created for a **self-funded** expense. An externally-funded expense never has
 * one, by design rather than as a pending state (ADR-0006).
 */
export const paymentExpenseLinks = pgTable(
  'payment_expense_links',
  {
    id: id(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id),
    amount: paiseColumn('amount').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payment_expense_links_unique').on(table.paymentId, table.expenseId),
    check('payment_expense_links_amount_check', sql`${table.amount} > 0`),
  ],
);

/* ======================================================================= allocation */

/**
 * Versioned, never edited in place. A correction or an adjustment distribution creates a new
 * row and stamps `superseded_at` on the previous one (`invariants.md` #6).
 */
export const allocations = pgTable(
  'allocations',
  {
    id: id(),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id),
    method: text('method').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    /** `'manual'` or `'rule:<rule_id>'` (`invariants.md` #17). */
    decidedBy: text('decided_by').notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // Exactly one current allocation per expense; superseded versions are kept forever.
    uniqueIndex('allocations_one_current_per_expense')
      .on(table.expenseId)
      .where(sql`${table.supersededAt} is null`),
    check('allocations_method_check', oneOf('method', ALLOCATION_METHODS)),
  ],
);

export const allocationLines = pgTable(
  'allocation_lines',
  {
    id: id(),
    allocationId: uuid('allocation_id')
      .notNull()
      .references(() => allocations.id),
    beneficiaryType: text('beneficiary_type').notNull(),
    /** A person or group id per `beneficiary_type`; validated in `services`. */
    beneficiaryId: uuid('beneficiary_id').notNull(),
    amount: paiseColumn('amount').notNull(),
    /** Informational only when the method is `percentage` (`invariants.md` #13). */
    percentage: numeric('percentage', { precision: 5, scale: 2 }),
    expenseItemId: uuid('expense_item_id').references(() => expenseItems.id),
    createdAt: createdAt(),
  },
  (table) => [
    index('allocation_lines_allocation_idx').on(table.allocationId),
    index('allocation_lines_beneficiary_idx').on(table.beneficiaryType, table.beneficiaryId),
    index('allocation_lines_expense_item_idx').on(table.expenseItemId),
    // `>= 0`, not `> 0`: a zero-amount line is the expected shape for an original
    // beneficiary of a fully refunded expense (`invariants.md` #12a, ADR-0013).
    check('allocation_lines_amount_check', sql`${table.amount} >= 0`),
    check('allocation_lines_beneficiary_type_check', oneOf('beneficiary_type', BENEFICIARY_TYPES)),
    check(
      'allocation_lines_percentage_check',
      sql`${table.percentage} is null or (${table.percentage} >= 0 and ${table.percentage} <= 100)`,
    ),
  ],
);

/**
 * Written exactly once, when the parent line is approved, from membership active as of the
 * expense's `occurred_at`. **Never updated or recomputed** — hence no `updated_at`, matching
 * the other write-once tables (ADR-0009, `scenario-analysis.md` §33).
 */
export const allocationLineGroupExpansions = pgTable(
  'allocation_line_group_expansions',
  {
    id: id(),
    allocationLineId: uuid('allocation_line_id')
      .notNull()
      .references(() => allocationLines.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id),
    amount: paiseColumn('amount').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('allocation_line_group_expansions_unique').on(
      table.allocationLineId,
      table.personId,
    ),
    check('allocation_line_group_expansions_amount_check', sql`${table.amount} >= 0`),
  ],
);

/* ============================================================ discharge & adjustment */

/**
 * Discharges an obligation. **No `allocation_id` column** — a `Settlement` never has an
 * `Allocation`, and there is deliberately no column a code path could attach one to
 * (`invariants.md` #9a, ADR-0007). Direction is read from the linked payment.
 */
export const settlements = pgTable(
  'settlements',
  {
    id: id(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    counterpartyPersonId: uuid('counterparty_person_id')
      .notNull()
      .references(() => people.id),
    amount: paiseColumn('amount').notNull(),
    reason: text('reason'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    index('settlements_payment_idx').on(table.paymentId),
    index('settlements_counterparty_idx').on(table.counterpartyPersonId),
    check('settlements_amount_check', sql`${table.amount} > 0`),
  ],
);

/** `amount` is always a positive magnitude — there is no signed adjustment (#12a). */
export const expenseAdjustments = pgTable(
  'expense_adjustments',
  {
    id: id(),
    originalExpenseId: uuid('original_expense_id')
      .notNull()
      .references(() => expenses.id),
    kind: text('kind').notNull(),
    amount: paiseColumn('amount').notNull(),
    /** Nullable: evidence-first is valid here exactly as for any other payment match. */
    adjustmentPaymentId: uuid('adjustment_payment_id').references(() => payments.id),
    reason: text('reason'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('expense_adjustments_expense_idx').on(table.originalExpenseId),
    check('expense_adjustments_amount_check', sql`${table.amount} > 0`),
    check('expense_adjustments_kind_check', oneOf('kind', EXPENSE_ADJUSTMENT_KINDS)),
  ],
);

/* ===================================================================== AI and rules */

export const aiInferences = pgTable(
  'ai_inferences',
  {
    id: id(),
    inferenceType: text('inference_type').notNull(),
    inputRefType: text('input_ref_type').notNull(),
    inputRefId: uuid('input_ref_id').notNull(),
    proposedOutput: jsonb('proposed_output').notNull(),
    confidence: text('confidence').notNull(),
    modelProvider: text('model_provider'),
    modelName: text('model_name'),
    promptVersion: text('prompt_version'),
    status: text('status').notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    resultingRecordType: text('resulting_record_type'),
    resultingRecordId: uuid('resulting_record_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('ai_inferences_input_idx').on(table.inputRefType, table.inputRefId, table.status),
    check('ai_inferences_confidence_check', oneOf('confidence', CONFIDENCE_LEVELS)),
    check('ai_inferences_status_check', oneOf('status', AI_INFERENCE_STATUSES)),
  ],
);

export const rules = pgTable(
  'rules',
  {
    id: id(),
    matchPattern: jsonb('match_pattern').notNull(),
    proposedClassification: jsonb('proposed_classification').notNull(),
    origin: text('origin').notNull(),
    active: boolean('active').notNull().default(true),
    timesApplied: integer('times_applied').notNull().default(0),
    createdAt: createdAt(),
  },
  () => [check('rules_origin_check', oneOf('origin', RULE_ORIGINS))],
);

/* ============================================================================ audit */

/** Append-only. No `UPDATE`/`DELETE` grants at the application-role level (#22). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value').notNull(),
    /** `'user'`, `'rule:<rule_id>'`, or `'system'`. */
    actor: text('actor').notNull(),
    source: text('source'),
    reason: text('reason'),
    aiInferenceId: uuid('ai_inference_id').references(() => aiInferences.id),
    /**
     * `clock_timestamp()`, deliberately not `now()`.
     *
     * PostgreSQL's `now()` is the *transaction* start time, so every event written inside one
     * audited unit of work would share a timestamp and `listAuditEvents`'s ordering would fall
     * through to a random UUID. An append-only log whose order is arbitrary cannot answer
     * "what happened, and then what happened next" — which is most of the point of keeping it
     * (`invariants.md` #21, #22).
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_events_entity_idx').on(table.entityType, table.entityId, table.occurredAt),
    check('audit_events_entity_type_check', oneOf('entity_type', AUDITABLE_ENTITY_TYPES)),
    check('audit_events_action_check', oneOf('action', AUDIT_ACTIONS)),
  ],
);

/* =============================================================== integrations & sync */

export const externalIntegrations = pgTable(
  'external_integrations',
  {
    id: id(),
    type: text('type').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    externalAccountRef: text('external_account_ref'),
    status: text('status').notNull().default('disconnected'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  () => [
    check('external_integrations_type_check', oneOf('type', EXTERNAL_INTEGRATION_TYPES)),
    check('external_integrations_status_check', oneOf('status', EXTERNAL_INTEGRATION_STATUSES)),
  ],
);

export const splitwiseExpenses = pgTable(
  'splitwise_expenses',
  {
    id: id(),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id),
    externalIntegrationId: uuid('external_integration_id')
      .notNull()
      .references(() => externalIntegrations.id),
    splitwiseExpenseId: text('splitwise_expense_id').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    ourSnapshot: jsonb('our_snapshot').notNull(),
    theirSnapshot: jsonb('their_snapshot'),
    syncStatus: text('sync_status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('splitwise_expenses_external_unique').on(
      table.externalIntegrationId,
      table.splitwiseExpenseId,
    ),
    check(
      'splitwise_expenses_sync_status_check',
      oneOf('sync_status', SPLITWISE_EXPENSE_SYNC_STATUSES),
    ),
  ],
);

export const splitwiseSettlements = pgTable(
  'splitwise_settlements',
  {
    id: id(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => settlements.id),
    externalIntegrationId: uuid('external_integration_id')
      .notNull()
      .references(() => externalIntegrations.id),
    splitwiseTransactionId: text('splitwise_transaction_id').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    ourSnapshot: jsonb('our_snapshot').notNull(),
    theirSnapshot: jsonb('their_snapshot'),
    syncStatus: text('sync_status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('splitwise_settlements_external_unique').on(
      table.externalIntegrationId,
      table.splitwiseTransactionId,
    ),
    check(
      'splitwise_settlements_sync_status_check',
      oneOf('sync_status', SPLITWISE_SETTLEMENT_SYNC_STATUSES),
    ),
  ],
);

/* =================================================================== reconciliation */

export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: id(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    periodStart: date('period_start', { mode: 'date' }).notNull(),
    periodEnd: date('period_end', { mode: 'date' }).notNull(),
    ledgerTotalOutflow: paiseColumn('ledger_total_outflow').notNull(),
    ledgerTransfersTotal: paiseColumn('ledger_transfers_total').notNull(),
    ledgerInvestmentsTotal: paiseColumn('ledger_investments_total').notNull(),
    ledgerSettlementsTotal: paiseColumn('ledger_settlements_total').notNull(),
    /** Sums `domain.netAmount(expense)`, not gross `expenses.amount` (ADR-0008). */
    ledgerExplainedTotal: paiseColumn('ledger_explained_total').notNull(),
    /** May legitimately be negative — an over-explained ledger must stay visible. */
    ledgerUnexplainedTotal: paiseColumn('ledger_unexplained_total').notNull(),
    splitwiseBalancesSnapshot: jsonb('splitwise_balances_snapshot'),
    discrepancies: jsonb('discrepancies')
      .notNull()
      .default(sql`'[]'::jsonb`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index('reconciliation_runs_period_idx').on(table.periodStart, table.periodEnd),
    check('reconciliation_runs_period_check', sql`${table.periodEnd} >= ${table.periodStart}`),
    // invariant #20's identity, enforceable per-row because every term is on this row.
    check(
      'reconciliation_runs_unexplained_identity_check',
      sql`${table.ledgerUnexplainedTotal} = ${table.ledgerTotalOutflow} - ${table.ledgerTransfersTotal} - ${table.ledgerInvestmentsTotal} - ${table.ledgerSettlementsTotal} - ${table.ledgerExplainedTotal}`,
    ),
  ],
);
