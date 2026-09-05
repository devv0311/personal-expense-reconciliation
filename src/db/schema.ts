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
  bigserial,
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
  AI_INFERENCE_TYPES,
  ALLOCATION_METHODS,
  AUDITABLE_ENTITY_TYPES,
  AUDIT_ACTIONS,
  BENEFICIARY_TYPES,
  CASH_FLOW_CATEGORIES,
  CASH_FLOW_STATES,
  CONFIDENCE_LEVELS,
  EVIDENCE_MATCH_SIGNALS,
  EVIDENCE_MATCH_STATUSES,
  EVIDENCE_MATCH_STRENGTHS,
  EVIDENCE_MEDIA_TYPES,
  EVIDENCE_NOTE_KINDS,
  EVIDENCE_OBSERVATION_DERIVATIONS,
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
  RECONCILIATION_VERIFICATION_STATUSES,
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
    /**
     * What role this movement plays in the account's cash — orthogonal to
     * `counterparty_type`, which says who was on the other side (ADR-0017 (cash balance)).
     *
     * DERIVED interpretation layered on immutable SOURCE columns, exactly as `state` is.
     * Null on an ordinary purchase or investment debit; null on a credit means that credit
     * is **unexplained**, which is why the checks below refuse to let one reach `approved`.
     */
    cashFlowCategory: text('cash_flow_category'),
    /** The interpretation lifecycle that runs alongside `state`, never instead of it. */
    cashFlowState: text('cash_flow_state').notNull().default('imported'),
    cashFlowApprovedAt: timestamp('cash_flow_approved_at', { withTimezone: true }),
    /** `'user'` or `'rule:<rule_id>'` — never a model, never a confidence (`ai-boundary.md`). */
    cashFlowApprovedBy: text('cash_flow_approved_by'),
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
    // The cash-reconciliation review queue: unapproved credits are exactly the rows that
    // leave an account unable to close, so they are read on every run.
    index('payments_cash_flow_state_idx')
      .on(table.cashFlowState, table.direction)
      .where(sql`${table.cashFlowState} <> 'approved'`),
    check(
      'payments_cash_flow_category_check',
      sql`${table.cashFlowCategory} is null or ${oneOf('cash_flow_category', CASH_FLOW_CATEGORIES)}`,
    ),
    check('payments_cash_flow_state_check', oneOf('cash_flow_state', CASH_FLOW_STATES)),
    // 17.2, absolute and row-local: a debit refund or a debit external inflow is not a
    // borderline judgement, it is arithmetically impossible.
    check(
      'payments_cash_flow_direction_check',
      sql`${table.cashFlowCategory} is null
          or ${table.cashFlowCategory} not in ('REFUND', 'EXTERNAL_INFLOW')
          or ${table.direction} = 'credit'`,
    ),
    // Assigning a category *is* the classification, so a category cannot exist on a row that
    // has not reached the classified state. This is what keeps the lifecycle explicit rather
    // than something a reader has to infer from which columns happen to be filled in.
    check(
      'payments_cash_flow_category_state_check',
      sql`${table.cashFlowCategory} is null
          or ${table.cashFlowState} in ('cash_flow_classified', 'approved')`,
    ),
    // An unclassified credit is unexplained; EXTERNAL_INFLOW is never the automatic catch-all
    // that closes a discrepancy (17.2). Debits may be approved with a null category, keeping
    // their existing spend/investment explanation.
    check(
      'payments_cash_flow_approved_credit_check',
      sql`${table.cashFlowState} <> 'approved'
          or ${table.direction} = 'debit'
          or ${table.cashFlowCategory} is not null`,
    ),
    // The counterparty requirements ADR-0017's table imposes *before approval* — deliberately
    // not before classification, because "an unresolved counterparty is allowed during
    // normalization" and demanding one earlier would make the rows that most need a proposal
    // impossible to propose for.
    check(
      'payments_cash_flow_approved_counterparty_check',
      sql`${table.cashFlowState} <> 'approved'
          or ${table.cashFlowCategory} is null
          or (${table.cashFlowCategory} = 'PEER_SETTLEMENT' and ${table.counterpartyType} = 'person')
          or (${table.cashFlowCategory} = 'INTERNAL_TRANSFER' and ${table.counterpartyType} = 'internal_account')
          or ${table.cashFlowCategory} in ('REFUND', 'EXTERNAL_INFLOW')`,
    ),
    // Approval provenance is present exactly when the role is approved: an approved role with
    // no actor is an unattributable financial decision (`invariants.md` #17, #21).
    check(
      'payments_cash_flow_approval_provenance_check',
      sql`(${table.cashFlowState} = 'approved') = (${table.cashFlowApprovedAt} is not null)
          and (${table.cashFlowState} = 'approved') = (${table.cashFlowApprovedBy} is not null)`,
    ),
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
    /**
     * What the stored document is, and how big it was — present exactly when `storage_ref`
     * is.
     *
     * Facts about the document rather than about the store, which is why they live here and
     * not only in the object's own metadata: a reader has to know how to render a document
     * before fetching it, and a ledger that cannot describe its own evidence without calling
     * out to storage has put the description in the wrong place.
     */
    mediaType: text('media_type'),
    byteSize: integer('byte_size'),
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
    // The idempotent-ingest lookup: the same bytes arriving twice resolve to the row that
    // already holds them rather than to a second copy of it.
    index('evidence_storage_ref_idx').on(table.storageRef),
    // Evidence with no home, which is what the review queue asks for.
    //
    // Widened in phase 17 from "a stored document" to "a stored document, or a bank/UPI
    // notification". A forwarded SMS has no file and is exactly the record that re-attaches a
    // decayed narration, so leaving it out of the queue would hide the phase's own input.
    // Manual notes stay out: their links were chosen by the person who typed them.
    index('evidence_unmatched_idx')
      .on(table.capturedAt)
      .where(
        sql.raw(
          "(storage_ref is not null or type in ('bank_line', 'upi_notification')) and " +
            'linked_payment_id is null and linked_expense_id is null',
        ),
      ),
    check('evidence_type_check', oneOf('type', EVIDENCE_TYPES)),
    check(
      'evidence_media_type_check',
      sql`${table.mediaType} is null or ${oneOf('media_type', EVIDENCE_MEDIA_TYPES)}`,
    ),
    // `media_type` and `byte_size` describe a stored document, so they are present exactly
    // when one is. A storage_ref with no media type is a document nothing can open; a media
    // type with no storage_ref describes a file that was never stored.
    check(
      'evidence_stored_document_check',
      sql`(${table.storageRef} is null) = (${table.mediaType} is null)
          and (${table.storageRef} is null) = (${table.byteSize} is null)`,
    ),
    check('evidence_byte_size_check', sql`${table.byteSize} is null or ${table.byteSize} > 0`),
    // Evidence must contain evidence. A row with neither a document nor text supports no
    // claim about anything, and would sit in the review queue forever as a receipt with
    // nothing in it.
    check(
      'evidence_content_present_check',
      sql`${table.storageRef} is not null or ${table.rawText} is not null`,
    ),
    // A note is typed text; a photograph of a receipt is `receipt_image`. Storing one as the
    // other hides it from every reader that looks for a document.
    check(
      'evidence_note_has_no_document_check',
      sql`${table.type} <> 'manual_note' or ${table.storageRef} is null`,
    ),
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
 * DERIVED, phase 17 (ADR-0044): the structured reading of one `Evidence` record.
 *
 * `evidence` is SOURCE and immutable, so an interpretation of it cannot live on that row —
 * exactly the reasoning that put `receipts` in its own table. This is the same shape for the
 * payment-side records a receipt does not cover: a bank SMS, a UPI push notification, and any
 * document whose amount and reference someone has read into structured form.
 *
 * Every column is nullable because partial evidence is the normal case: a notification that
 * states an amount and a reference but no account tail records exactly those two. What is not
 * optional is that the row observes *something* — enforced below, and again in
 * `domain.validateEvidenceObservation`.
 */
export const evidenceObservations = pgTable(
  'evidence_observations',
  {
    id: id(),
    /** One reading per evidence record. A better reading replaces this one; it never doubles it. */
    evidenceId: uuid('evidence_id')
      .notNull()
      .unique()
      .references(() => evidence.id),
    observedAmount: paiseColumn('observed_amount'),
    observedDirection: text('observed_direction'),
    /** As observed, with the bank's own punctuation intact — kept for display. */
    observedReference: text('observed_reference'),
    /** Letters and digits only, upper-cased: the form the matcher compares (ADR-0044). */
    observedReferenceNormalized: text('observed_reference_normalized'),
    observedReferenceType: text('observed_reference_type'),
    /**
     * Masked trailing digits only.
     *
     * The same `~ '^[0-9]{1,4}$'` rule `accounts.last4` carries, and for the same reason: an
     * SMS is where `A/C XXXX4821` enters this system, so it is where `security-model.md`'s
     * "no full account or card number is ever stored" has to be enforced.
     */
    observedAccountHint: text('observed_account_hint'),
    observedMerchantText: text('observed_merchant_text'),
    /** The instant the evidence states, which a date-only statement line does not carry. */
    observedOccurredAt: timestamp('observed_occurred_at', { withTimezone: true }),
    /** `caller_supplied` or `parsed_from_text` — both deterministic, neither a model. */
    derivation: text('derivation').notNull(),
    /**
     * The deterministic identity of the **notification** this reading came in on.
     *
     * Unique, so the same SMS forwarded twice resolves to the row it already has — the rule
     * `ingestEvidenceDocument` applies to bytes, applied to text that has no content address of
     * its own (`domain.notificationDedupeKey`).
     *
     * **Null for a reading of an `Evidence` row that already existed** — a receipt's extracted
     * total, a human's correction — because that row's own id is already its identity.
     * PostgreSQL's unique indexes ignore nulls, which is exactly the shape wanted: two receipts
     * that happen to total the same amount are two readings, not a collision.
     */
    notificationKey: text('notification_key').unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The reference lookup the matcher pre-filters on.
    index('evidence_observations_reference_idx')
      .on(table.observedReferenceNormalized)
      .where(sql`${table.observedReferenceNormalized} is not null`),
    index('evidence_observations_amount_idx').on(table.observedAmount, table.observedOccurredAt),
    check(
      'evidence_observations_direction_check',
      sql`${table.observedDirection} is null or ${oneOf('observed_direction', PAYMENT_DIRECTIONS)}`,
    ),
    check(
      'evidence_observations_reference_type_check',
      sql`${table.observedReferenceType} is null
          or ${oneOf('observed_reference_type', PAYMENT_REFERENCE_TYPES)}`,
    ),
    check(
      'evidence_observations_derivation_check',
      oneOf('derivation', EVIDENCE_OBSERVATION_DERIVATIONS),
    ),
    check(
      'evidence_observations_amount_check',
      sql`${table.observedAmount} is null or ${table.observedAmount} > 0`,
    ),
    // `security-model.md`: never a full account or card number, at the database and not only
    // by convention — the same check `accounts.last4` already carries.
    check(
      'evidence_observations_account_hint_check',
      sql`${table.observedAccountHint} is null or ${table.observedAccountHint} ~ '^[0-9]{1,4}$'`,
    ),
    // A reading that read nothing would enter the matcher, contribute no signal, and assert
    // forever that this document was understood when it was not.
    check(
      'evidence_observations_not_empty_check',
      sql`${table.observedAmount} is not null
          or ${table.observedDirection} is not null
          or ${table.observedReference} is not null
          or ${table.observedAccountHint} is not null
          or ${table.observedMerchantText} is not null
          or ${table.observedOccurredAt} is not null`,
    ),
    // The normalized form is present exactly when there is a reference to normalize, so a
    // matcher pre-filter reading only the normalized column cannot miss a row that has one.
    check(
      'evidence_observations_reference_normalized_check',
      sql`(${table.observedReference} is null) = (${table.observedReferenceNormalized} is null)`,
    ),
  ],
);

/**
 * DERIVED, phase 17 (ADR-0044): one recorded "this evidence might be about that payment".
 *
 * A candidate is **not** a link and can never become one on its own. `evidence` linkage stays
 * write-once and stays a human act (ADR-0034/0037); what this table adds is that the offer is
 * recorded with its reasoning, so a reviewer sees the same signals the matcher saw, a re-run
 * changes nothing unless the ledger changed, and a decision is attributable afterwards.
 *
 * The one constraint worth reading twice is `evidence_match_candidates_decision_check`: a
 * candidate reaches `accepted` or `dismissed` **only** with a recorded actor and instant. That
 * is what makes "no confidence threshold silently approves an evidence link" a property of the
 * schema rather than a promise in a service.
 */
export const evidenceMatchCandidates = pgTable(
  'evidence_match_candidates',
  {
    id: id(),
    evidenceId: uuid('evidence_id')
      .notNull()
      .references(() => evidence.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    strength: text('strength').notNull(),
    /** A summary of the signal set, in `ai-boundary.md`'s four levels. Never an approval. */
    confidence: text('confidence').notNull(),
    /** The signal names that agreed, e.g. `["reference","amount"]`. */
    matchedSignals: jsonb('matched_signals').notNull(),
    /** The signal names that disagreed. Empty is not the same as "not checked". */
    conflictingSignals: jsonb('conflicting_signals').notNull(),
    /** The full per-signal provenance: verdict, both values, and why (`domain`'s own output). */
    signals: jsonb('signals').notNull(),
    /** Every reason this candidate is waiting for a person (`EVIDENCE_MATCH_REVIEW_REASONS`). */
    reviewReasons: jsonb('review_reasons').notNull(),
    status: text('status').notNull().default('proposed'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** `'user'` or `'rule:<rule_id>'` — never a model, never `system` (`invariants.md` #17). */
    decidedBy: text('decided_by'),
    /**
     * Which matcher produced this.
     *
     * A re-run under a changed matcher legitimately produces different candidates, and without
     * this the difference would be indistinguishable from the ledger having changed.
     */
    matcherVersion: text('matcher_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One offer per (evidence, payment) pair: a re-run updates the row it already wrote rather
    // than appending a second opinion about the same two records.
    uniqueIndex('evidence_match_candidates_pair_idx').on(table.evidenceId, table.paymentId),
    index('evidence_match_candidates_evidence_idx').on(table.evidenceId, table.status),
    index('evidence_match_candidates_payment_idx').on(table.paymentId, table.status),
    check('evidence_match_candidates_strength_check', oneOf('strength', EVIDENCE_MATCH_STRENGTHS)),
    check('evidence_match_candidates_confidence_check', oneOf('confidence', CONFIDENCE_LEVELS)),
    check('evidence_match_candidates_status_check', oneOf('status', EVIDENCE_MATCH_STATUSES)),
    // A decision is attributable or it is not a decision. `proposed`/`superseded` are the
    // matcher's own states and carry no actor, because nobody decided them.
    check(
      'evidence_match_candidates_decision_check',
      sql`(${table.status} in ('accepted', 'dismissed'))
            = (${table.decidedAt} is not null)
          and (${table.status} in ('accepted', 'dismissed'))
            = (${table.decidedBy} is not null)`,
    ),
    check(
      'evidence_match_candidates_signals_shape_check',
      sql`jsonb_typeof(${table.matchedSignals}) = 'array'
          and jsonb_typeof(${table.conflictingSignals}) = 'array'
          and jsonb_typeof(${table.signals}) = 'array'
          and jsonb_typeof(${table.reviewReasons}) = 'array'`,
    ),
    // Every recorded signal is one of the six the domain defines, so an invented signal name
    // cannot enter the table even if a caller writes the JSON by hand. `<@` is jsonb array
    // containment — a plain operator, because a CHECK may not contain a subquery.
    check(
      'evidence_match_candidates_signal_names_check',
      sql.raw(
        `matched_signals <@ '${JSON.stringify(EVIDENCE_MATCH_SIGNALS)}'::jsonb ` +
          `and conflicting_signals <@ '${JSON.stringify(EVIDENCE_MATCH_SIGNALS)}'::jsonb`,
      ),
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

/**
 * The item-level attribution of a refund/reimbursement (ADR-0018 (item refunds)).
 *
 * Write-once, like every other record of an observed financial event: a correction is a new
 * adjustment, never an edit of this one. Deliberately carries nothing the parent already
 * holds — expense identity, kind, date, approval context, the optional credit `Payment` — so
 * there is no second place for any of them to disagree.
 *
 * 19.1 (the item belongs to the adjustment's own expense) is **not** expressible as a row
 * `CHECK`: it spans three tables. It is enforced in `domain.validateRefundAttribution`, inside
 * the same transaction that writes these rows, and the foreign keys below deliberately do not
 * pretend to cover it.
 */
export const expenseAdjustmentItems = pgTable(
  'expense_adjustment_items',
  {
    id: id(),
    expenseAdjustmentId: uuid('expense_adjustment_id')
      .notNull()
      .references(() => expenseAdjustments.id),
    expenseItemId: uuid('expense_item_id')
      .notNull()
      .references(() => expenseItems.id),
    amount: paiseColumn('amount').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // One row per (adjustment, item): a larger refund of one item is a larger amount on its
    // single row, not a second row (ADR-0018 (item refunds)).
    uniqueIndex('expense_adjustment_items_unique').on(
      table.expenseAdjustmentId,
      table.expenseItemId,
    ),
    // The cumulative-ceiling lookup (19.3): every attribution ever recorded against one item.
    index('expense_adjustment_items_item_idx').on(table.expenseItemId),
    // 19.4: strictly positive. `> 0`, not `>= 0` — a zero-amount attribution asserts that an
    // item was refunded for nothing, and a clawback is new spend under ADR-0008, not a
    // negative row here.
    check('expense_adjustment_items_amount_check', sql`${table.amount} > 0`),
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
    // The nine operations `ai-boundary.md` defines, and nothing else: an inference type no
    // operation produces cannot enter the table even if a caller invents one.
    check('ai_inferences_inference_type_check', oneOf('inference_type', AI_INFERENCE_TYPES)),
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
    /**
     * Monotonic insertion order, and the only thing `listAuditEvents` orders by.
     *
     * `occurred_at` cannot carry this. It resolves to milliseconds, so two events written in
     * quick succession — a `create` and the `update` that immediately follows it, the common
     * shape inside one audited unit of work — routinely share a timestamp, and the tiebreak
     * then falls to a random UUID. An append-only log whose order is a coin flip cannot
     * answer "what happened, and then what happened next", which is most of why it exists
     * (`invariants.md` #21, #22). A sequence is exact regardless of clock resolution.
     *
     * `occurred_at` is still the human-facing *when*; this is the *order*.
     */
    sequence: bigserial('sequence', { mode: 'bigint' }).notNull(),
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

/**
 * One account's evidence-backed bank reconciliation for one run
 * (ADR-0017 (cash balance), "ReconciliationAccountSnapshot").
 *
 * The second, independent identity alongside `reconciliation_runs`' outflow one:
 *
 * ```text
 * expected_ending_balance = opening_balance + total_credits - total_debits
 * cash_balance_delta      = closing_balance - expected_ending_balance
 * ```
 *
 * Immutable. A later interpretation produces a new run with new snapshots; it never edits an
 * old one from `incomplete` to `verified`, which is why there is no `updated_at` and no
 * update path in `repositories.ts` (17.7).
 *
 * Two conventions here differ from the rest of this file, both deliberately:
 *
 *  - **Balances carry no non-negative check.** An overdraft is a real balance and
 *    `cash_balance_delta` is a signed disagreement. Only the movement and explanation totals —
 *    positive magnitudes of what the statement actually posted — are constrained `>= 0`.
 *  - **Every arithmetic identity is a row `CHECK`.** Unusually for this schema, which normally
 *    leaves cross-row sums to `src/domain`, all of ADR-0017's identities have every term on
 *    one row, and 17.7 asks for them "as persistence constraints".
 */
export const reconciliationAccountSnapshots = pgTable(
  'reconciliation_account_snapshots',
  {
    id: id(),
    reconciliationRunId: uuid('reconciliation_run_id')
      .notNull()
      .references(() => reconciliationRuns.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    currency: text('currency').notNull().default('INR'),
    /**
     * The parent run's interval, as an explicit-timezone half-open `[start, end)` range.
     *
     * `timestamptz` rather than the run's `date`, per ADR-0017's "use an explicit timezone and
     * half-open interval for posted movements": which side of midnight a movement posted on
     * decides which statement it belongs to, and a bare date cannot answer that.
     */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    /** Actual statement balances. Null when the evidence is missing — never a fabricated zero. */
    openingBalance: paiseColumn('opening_balance'),
    closingBalance: paiseColumn('closing_balance'),
    openingBalanceEvidenceId: uuid('opening_balance_evidence_id').references(() => evidence.id),
    closingBalanceEvidenceId: uuid('closing_balance_evidence_id').references(() => evidence.id),
    totalDebits: paiseColumn('total_debits').notNull(),
    totalCredits: paiseColumn('total_credits').notNull(),
    /** Subsets of the totals above, not additional terms to add or subtract (17.3). */
    internalTransferDebits: paiseColumn('internal_transfer_debits').notNull(),
    internalTransferCredits: paiseColumn('internal_transfer_credits').notNull(),
    explainedDebits: paiseColumn('explained_debits').notNull(),
    unexplainedDebits: paiseColumn('unexplained_debits').notNull(),
    explainedCredits: paiseColumn('explained_credits').notNull(),
    unexplainedCredits: paiseColumn('unexplained_credits').notNull(),
    expectedEndingBalance: paiseColumn('expected_ending_balance'),
    cashBalanceDelta: paiseColumn('cash_balance_delta'),
    verificationStatus: text('verification_status').notNull(),
    discrepancies: jsonb('discrepancies')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * The inputs this run actually read — counted payment ids, and the transfer legs it could
     * not pair — so a later reclassification cannot reinterpret a past run (17.7).
     */
    provenance: jsonb('provenance')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [
    // One snapshot per account per run: each account is verified independently, and a second
    // row for the same pair would be a second opinion about one period (17.6).
    uniqueIndex('reconciliation_account_snapshots_unique').on(
      table.reconciliationRunId,
      table.accountId,
    ),
    index('reconciliation_account_snapshots_account_idx').on(table.accountId, table.periodEnd),
    check(
      'reconciliation_account_snapshots_period_check',
      sql`${table.periodEnd} > ${table.periodStart}`,
    ),
    check(
      'reconciliation_account_snapshots_status_check',
      oneOf('verification_status', RECONCILIATION_VERIFICATION_STATUSES),
    ),
    // Movement and explanation totals are positive magnitudes of what actually posted.
    // Balances are deliberately absent from this list.
    check(
      'reconciliation_account_snapshots_movement_sign_check',
      sql`${table.totalDebits} >= 0 and ${table.totalCredits} >= 0
          and ${table.explainedDebits} >= 0 and ${table.unexplainedDebits} >= 0
          and ${table.explainedCredits} >= 0 and ${table.unexplainedCredits} >= 0
          and ${table.internalTransferDebits} >= 0 and ${table.internalTransferCredits} >= 0`,
    ),
    // 17.4's coverage identity: partial attribution leaves a visible remainder rather than a
    // total that quietly stops adding up.
    check(
      'reconciliation_account_snapshots_coverage_check',
      sql`${table.totalDebits} = ${table.explainedDebits} + ${table.unexplainedDebits}
          and ${table.totalCredits} = ${table.explainedCredits} + ${table.unexplainedCredits}`,
    ),
    check(
      'reconciliation_account_snapshots_transfer_subset_check',
      sql`${table.internalTransferDebits} <= ${table.totalDebits}
          and ${table.internalTransferCredits} <= ${table.totalCredits}`,
    ),
    // 17.5: a balance and the Evidence it comes from are present together or not at all. A
    // balance with no evidence is a number somebody typed.
    check(
      'reconciliation_account_snapshots_boundary_evidence_check',
      sql`(${table.openingBalance} is null) = (${table.openingBalanceEvidenceId} is null)
          and (${table.closingBalance} is null) = (${table.closingBalanceEvidenceId} is null)`,
    ),
    // Both derived values exist exactly when both boundaries do.
    check(
      'reconciliation_account_snapshots_derived_presence_check',
      sql`(${table.expectedEndingBalance} is null)
            = (${table.openingBalance} is null or ${table.closingBalance} is null)
          and (${table.cashBalanceDelta} is null) = (${table.expectedEndingBalance} is null)`,
    ),
    // ADR-0017's two identities, enforceable per row because every term is on this row.
    check(
      'reconciliation_account_snapshots_identity_check',
      sql`${table.expectedEndingBalance} is null
          or (${table.expectedEndingBalance}
                = ${table.openingBalance} + ${table.totalCredits} - ${table.totalDebits}
              and ${table.cashBalanceDelta}
                = ${table.closingBalance} - ${table.expectedEndingBalance})`,
    ),
    // 17.6, as a constraint rather than a convention: `verified` requires evidenced
    // boundaries, a zero delta, zero unexplained movement in both directions, and no
    // unresolved discrepancy. A numeric zero over unknown transactions is not a verified
    // ₹0 Unaccounted Delta, and this is the check that makes claiming otherwise impossible.
    check(
      'reconciliation_account_snapshots_verified_check',
      sql`${table.verificationStatus} <> 'verified'
          or (${table.cashBalanceDelta} = 0
              and ${table.unexplainedDebits} = 0
              and ${table.unexplainedCredits} = 0
              and ${table.openingBalanceEvidenceId} is not null
              and ${table.closingBalanceEvidenceId} is not null
              and jsonb_array_length(${table.discrepancies}) = 0)`,
    ),
    // The mirror image: inputs complete enough to disagree cannot be filed as `incomplete`,
    // which would hide a real disagreement behind "we did not have enough to check".
    check(
      'reconciliation_account_snapshots_incomplete_check',
      sql`${table.verificationStatus} <> 'incomplete' or ${table.cashBalanceDelta} is null`,
    ),
  ],
);
