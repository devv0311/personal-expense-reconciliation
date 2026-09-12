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
  DOCUMENT_TEXT_SOURCES,
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
  JOB_KINDS,
  JOB_STATUSES,
  MESSAGE_CHANNELS,
  PAYMENT_CHANNELS,
  PAYMENT_COUNTERPARTY_TYPES,
  PAYMENT_DIRECTIONS,
  PAYMENT_REFERENCE_TYPES,
  PAYMENT_STATES,
  PROOF_PACK_DELIVERY_STATUSES,
  RECONCILIATION_VERIFICATION_STATUSES,
  RULE_ACTIONS,
  RULE_EFFECTS,
  RULE_ORIGINS,
  SPLITWISE_AUDIT_FINDING_CLASSES,
  SPLITWISE_AUDIT_FINDING_KINDS,
  SPLITWISE_AUDIT_FINDING_SCOPES,
  SPLITWISE_AUDIT_REVIEW_STATUSES,
  SPLITWISE_EXPENSE_SYNC_STATUSES,
  SPLITWISE_EXTERNAL_READ_STATUSES,
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
    /**
     * The corrected record that replaces this one (audit row 13, ADR-0052).
     *
     * ADR-0034 makes linkage write-once: evidence attached to the wrong payment could never be
     * moved, and the audit found there was no way to say so either. This is that way, and it
     * is a **supersession, not an edit**: the wrong row keeps its links, its text and its
     * place in history, and a new row carrying the same immutable source facts with the
     * corrected links takes over from it. Nothing is rewritten, so "why did this ledger once
     * believe that receipt paid for this?" stays answerable.
     */
    supersededByEvidenceId: uuid('superseded_by_evidence_id').references(
      (): AnyPgColumn => evidence.id,
    ),
    /** Why. Required whenever a row is superseded — a correction with no account is not one. */
    supersedeReason: text('supersede_reason'),
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
            'linked_payment_id is null and linked_expense_id is null and ' +
            // A superseded row is history, not an open question: offering it in the review
            // queue would ask a person to re-decide a link they have already corrected.
            'superseded_by_evidence_id is null',
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
    // A supersession names both its replacement and its reason, or neither. A row marked
    // replaced with no account of why is a correction nobody can review.
    check(
      'evidence_supersede_reason_check',
      sql`(${table.supersededByEvidenceId} is null) = (${table.supersedeReason} is null)`,
    ),
    // A row cannot replace itself. Without this the correction path could produce a cycle of
    // length one, and "follow the chain to the current record" would never terminate.
    check(
      'evidence_supersede_self_check',
      sql`${table.supersededByEvidenceId} is null or ${table.supersededByEvidenceId} <> ${table.id}`,
    ),
    index('evidence_superseded_by_idx').on(table.supersededByEvidenceId),
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
    /**
     * Where the text this extraction read actually came from (audit row 14, ADR-0051).
     *
     * `evidence_raw_text` — the record already carried text, typed or forwarded.
     * `pdf_text_layer` — lifted locally off a generated PDF; nothing left the machine.
     * `model_vision` — a multimodal model transcribed the document's bytes, which is the one
     * path on which a document crosses the local boundary and is off unless configured.
     *
     * Recorded rather than inferred, because "the receipt says ₹1,240" and "a model reading a
     * photograph of the receipt says ₹1,240" are different claims, and the person confirming
     * the extraction is entitled to know which one is in front of them.
     */
    textSource: text('text_source'),
    /** Which model transcribed it, when one did. Null on every local path. */
    textModel: text('text_model'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('receipts_evidence_idx').on(table.evidenceId),
    check(
      'receipts_extraction_confidence_check',
      sql`${table.extractionConfidence} is null or ${oneOf('extraction_confidence', CONFIDENCE_LEVELS)}`,
    ),
    check(
      'receipts_text_source_check',
      sql`${table.textSource} is null or ${oneOf('text_source', DOCUMENT_TEXT_SOURCES)}`,
    ),
    // A model name without a model-read source, or a `model_vision` source with no model
    // named, would each be a provenance record that does not describe anything.
    // `is distinct from` rather than `=`, so the rule also holds for a row whose `text_source`
    // is null (every receipt written before ADR-0051): plain `=` yields NULL there, and a
    // NULL check passes, which would have let a model name sit on a row that never named a
    // model-read source.
    check(
      'receipts_text_model_check',
      sql`(${table.textSource} is distinct from 'model_vision') = (${table.textModel} is null)`,
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
    /**
     * When a corrected breakdown replaced this item (audit row 17).
     *
     * An `ExpenseItem` is a DERIVED reading of what was bought, and a wrong first reading has
     * to be fixable — but not by mutation. A correction writes a whole new item set and stamps
     * the old rows here, exactly as an `Allocation` is superseded rather than edited
     * (`invariants.md` #6). Every current-item read filters on this being null; the superseded
     * rows stay forever, because an old allocation line still points at them and "why did this
     * expense once divide that way?" has to remain answerable.
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
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
    /**
     * When this adjustment was reversed as erroneous (audit row 23, ADR-0052).
     *
     * A refund recorded that never happened — a mis-typed amount, an adjustment against the
     * wrong expense — had no way out: the row is append-only by design, and every path that
     * counts money counted it. The three columns here are the same shape `allocations`
     * already uses for supersession, and the same grant: **everything else on the row stays
     * immutable**, and the reversal is a stamp rather than an edit, so the erroneous record
     * and the reason it was wrong both survive (`invariants.md` #22).
     *
     * A reversed adjustment is excluded from every read that *counts* it and included in
     * every read that *recounts* it — the expense timeline still shows it, with its reversal.
     */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    /** Why it was wrong. Required whenever a row is reversed. */
    reversalReason: text('reversal_reason'),
    /** Who reversed it — `'user'`/`'user:<id>'`, the same actor shape an `AuditEvent` carries. */
    reversedBy: text('reversed_by'),
    createdAt: createdAt(),
  },
  (table) => [
    index('expense_adjustments_expense_idx').on(table.originalExpenseId),
    check('expense_adjustments_amount_check', sql`${table.amount} > 0`),
    check('expense_adjustments_kind_check', oneOf('kind', EXPENSE_ADJUSTMENT_KINDS)),
    // All three, or none. A reversal with no reason is a figure that changed with no account
    // of why, which is the one thing an append-only financial record must never allow.
    check(
      'expense_adjustments_reversal_check',
      sql`(${table.reversedAt} is null) = (${table.reversalReason} is null)
          and (${table.reversedAt} is null) = (${table.reversedBy} is null)`,
    ),
    // The lookup every money read now applies.
    index('expense_adjustments_active_idx')
      .on(table.originalExpenseId)
      .where(sql.raw('reversed_at is null')),
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
    /** What a person calls this rule in the list. Not an identifier. */
    name: text('name').notNull().default(''),
    matchPattern: jsonb('match_pattern').notNull(),
    proposedClassification: jsonb('proposed_classification').notNull(),
    origin: text('origin').notNull(),
    /** {@link RULE_ACTIONS} — what the rule asserts about a payment it matches. */
    action: text('action').notNull().default('set_counterparty_type'),
    /**
     * {@link RULE_EFFECTS}. `propose` is the default and the safe one: a matched payment
     * becomes a review-queue item. `apply` is opt-in per rule and writes with
     * `actor = 'rule:<id>'`, which is only defensible because the match is exact and the
     * rule's author is the human who approved it (`ai-boundary.md`).
     */
    effect: text('effect').notNull().default('propose'),
    active: boolean('active').notNull().default(true),
    timesApplied: integer('times_applied').notNull().default(0),
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('rules_origin_check', oneOf('origin', RULE_ORIGINS)),
    check('rules_action_check', oneOf('action', RULE_ACTIONS)),
    check('rules_effect_check', oneOf('effect', RULE_EFFECTS)),
    check(
      'rules_pattern_shape_check',
      sql`jsonb_typeof(${table.matchPattern}) = 'object'
          and jsonb_typeof(${table.proposedClassification}) = 'object'`,
    ),
  ],
);

/* ====================================================================== sessions & jobs */

/**
 * One signed-in browser (`security-model.md`, "single-user session authentication").
 *
 * Only a **hash** of the session token is stored, for the same reason `users.password_hash`
 * is a hash: this database holds a person's entire financial life, and a stolen dump must
 * not also be a set of working credentials. `expires_at` is enforced on every read, not by a
 * sweeper — an expired row is dead the moment it is read, whether or not anything deleted it.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    check('sessions_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

/**
 * Out-of-band work (`system-architecture.md`'s "lightweight Postgres-backed job queue").
 *
 * A job is an orchestration record, never a financial one: nothing here holds an amount, and
 * every kind it can run calls a service that already refuses to approve anything on its own.
 * `attempts`/`last_error` exist so a failure is visible and retryable rather than silent —
 * the same reason `import_batches` keeps a content hash.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('queued'),
    /** The job's input. Never raw document bytes — those live in the evidence store. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    result: jsonb('result'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    /** Who queued it — `'user'` or `'system'`, exactly as an `AuditEvent` actor. */
    actor: text('actor').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('jobs_status_scheduled_idx').on(table.status, table.scheduledFor),
    check('jobs_kind_check', oneOf('kind', JOB_KINDS)),
    check('jobs_status_check', oneOf('status', JOB_STATUSES)),
    check('jobs_attempts_check', sql`${table.attempts} >= 0 and ${table.maxAttempts} >= 1`),
    // Three one-directional rules, not two equivalences. A terminal job finished; a queued
    // one has not started; a running one has. Deliberately *not* "queued ⟺ not started":
    // a job cancelled before it ever ran is terminal with no `started_at`, which is the
    // honest record of what happened to it, and an equivalence here would forbid saying so.
    check(
      'jobs_terminal_check',
      sql`(${table.status} in ('succeeded', 'failed', 'cancelled')) = (${table.finishedAt} is not null)
          and (${table.status} <> 'queued' or ${table.startedAt} is null)
          and (${table.status} <> 'running' or ${table.startedAt} is not null)`,
    ),
  ],
);

/* ========================================================= live balance providers */

/**
 * Which of this ledger's accounts a balance provider can be asked about (audit row 37).
 *
 * The mapping, and nothing else. No credential appears on this row: the token belongs to the
 * adapter's closure, built from the environment in `src/server.ts`, and there is deliberately
 * no column that could carry one — a database backup should not be a credential leak
 * (`security-model.md`).
 *
 * `external_account_ref` is the provider's own handle for the account. Like `accounts.last4`
 * it is an identifier fragment rather than an account number, and it is the provider's string
 * rather than anything this ledger invents.
 */
export const accountProviderLinks = pgTable(
  'account_provider_links',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    /** The provider this ref belongs to — `BalanceProviderCapabilities.providerId`. */
    providerId: text('provider_id').notNull(),
    externalAccountRef: text('external_account_ref').notNull(),
    /** A label the provider gave, for a person to check they mapped the right account. */
    providerLabel: text('provider_label'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    /** Unlinking is an archive, not a delete: past readings still name this link. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // One live link per (provider, ref): two accounts claiming the same remote account would
    // make every reading ambiguous about which of them it describes.
    uniqueIndex('account_provider_links_ref_unique')
      .on(table.providerId, table.externalAccountRef)
      .where(sql`archived_at is null`),
    uniqueIndex('account_provider_links_account_unique')
      .on(table.accountId, table.providerId)
      .where(sql`archived_at is null`),
  ],
);

/**
 * One thing a provider said about one account at one instant. Immutable.
 *
 * **Not evidence, and never a boundary** (ADR-0054). A `ReconciliationAccountSnapshot`'s
 * opening and closing balances still come only from a statement somebody evidenced; a reading
 * is a second opinion recorded beside the ledger's own arithmetic so the two can be compared.
 * The grants file revokes UPDATE and DELETE on this table for the same reason it does on
 * `payments` and `evidence`: what a provider said at a moment does not change afterwards.
 *
 * `balance` is nullable and signed. Null is "the provider did not state one" and is never zero
 * (ADR-0017 (cash balance), 17.5); negative is an overdrawn account, which is a real balance.
 *
 * `as_of` is the provider's own instant and is separate from `fetched_at`, which is when this
 * process asked. A balance from six hours ago compared against a period ending yesterday is a
 * stale read, and keeping only one of the two timestamps would make that unknowable.
 */
export const accountBalanceReadings = pgTable(
  'account_balance_readings',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    accountProviderLinkId: uuid('account_provider_link_id')
      .notNull()
      .references(() => accountProviderLinks.id),
    providerId: text('provider_id').notNull(),
    balance: paiseColumn('balance'),
    currency: text('currency').notNull().default('INR'),
    asOf: timestamp('as_of', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull(),
    failureReason: text('failure_reason'),
    /**
     * Whether the read this reading came from answered about every account it asked about.
     *
     * Carried onto each row rather than kept only on a run record, so a reading can never be
     * quoted without the completeness of the read that produced it — ADR-0046's rule that an
     * absence under an incomplete check is not agreement.
     */
    readComplete: boolean('read_complete').notNull(),
    readIncompleteReason: text('read_incomplete_reason'),
    createdAt: createdAt(),
  },
  (table) => [
    index('account_balance_readings_account_idx').on(table.accountId, table.fetchedAt),
    check('account_balance_readings_status_check', sql`status in ('ok', 'unavailable')`),
    // `ok` means a balance and an instant both came back; anything short of that is
    // `unavailable` with a reason. Without this an `ok` row could carry a null balance, and
    // every reader downstream would have to remember that null is not zero.
    check(
      'account_balance_readings_shape_check',
      sql`(${table.status} = 'ok') = (${table.balance} is not null and ${table.asOf} is not null)
          and (${table.status} <> 'unavailable' or ${table.failureReason} is not null)
          and (${table.readComplete} or ${table.readIncompleteReason} is not null)`,
    ),
  ],
);

/* ============================================================ proof-pack delivery */

/**
 * A record that a proof pack was put in front of somebody (audit row 42).
 *
 * ADR-0047 is emphatic that a pack is derived and persists nothing, and this table does not
 * contradict it: it records the **outward act**, not the figures. A proof pack generated and
 * never sent still writes nothing anywhere.
 *
 * `body_text` is stored anyway, and deliberately. It is the only way to answer "what exactly
 * did I send them" after the ledger has moved on — a question whose answer cannot be
 * re-derived, because re-deriving it would produce today's pack rather than the one that was
 * actually sent. It is a record of a message, not a second copy of the balance.
 *
 * Immutable in the parts that describe what left: `recipient_person_id`, `channel`,
 * `address`, `body_text`, `content_digest` and `attachments` are written once and never
 * updated. Only the delivery's own progress — status, attempts, provider id and error — moves.
 */
export const proofPackDeliveries = pgTable(
  'proof_pack_deliveries',
  {
    id: id(),
    recipientPersonId: uuid('recipient_person_id')
      .notNull()
      .references(() => people.id),
    channel: text('channel').notNull(),
    /**
     * The canonical recipient address — a phone number. Personal data, and treated as such:
     * never sent to a model, never included in a proof pack's own text, never logged.
     */
    address: text('address').notNull(),
    /**
     * The exact text handed to the transport, byte for byte what the preview showed.
     * Already through the redaction boundary: an unredacted pack is refused before it
     * reaches this table (ADR-0047's fail-closed export check).
     */
    bodyText: text('body_text').notNull(),
    /** SHA-256 of `body_text`, so a resend of unchanged content is recognisable as one. */
    contentDigest: text('content_digest').notNull(),
    /**
     * The documents that went with it: `[{ evidenceId, filename, mediaType, byteSize }]`.
     * The bytes themselves stay in the evidence store, addressed by their own content.
     */
    attachments: jsonb('attachments')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * `domain.deliveryIdempotencyKey`, uniquely indexed.
     *
     * This index *is* the idempotency guarantee. Two presses of send on an unchanged pack
     * collide here and the second one returns the first one's record rather than reaching a
     * transport — which is the only place that can be enforced, since a transport may or may
     * not honour an idempotency header.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The as-of label the pack carried, so a record can be matched to what it explained. */
    packAsOf: timestamp('pack_as_of', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    /** The provider's own id for the message, and the handle a later status refers to. */
    providerMessageId: text('provider_message_id'),
    /** Which transport actually carried it, e.g. `whatsapp-cloud`. */
    transportId: text('transport_id').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('proof_pack_deliveries_idempotency_unique').on(table.idempotencyKey),
    index('proof_pack_deliveries_recipient_idx').on(table.recipientPersonId, table.createdAt),
    check('proof_pack_deliveries_channel_check', oneOf('channel', MESSAGE_CHANNELS)),
    check('proof_pack_deliveries_status_check', oneOf('status', PROOF_PACK_DELIVERY_STATUSES)),
    check('proof_pack_deliveries_attempts_check', sql`${table.attemptCount} >= 0`),
    // A status and its timestamps cannot disagree. `sent_at` records the moment a transport
    // took responsibility, and `delivered_at` the moment the provider said it arrived: a
    // `delivered` row with no `sent_at` would be a message that arrived without being sent.
    check(
      'proof_pack_deliveries_timestamps_check',
      sql`(${table.status} in ('sent', 'delivered')) = (${table.sentAt} is not null)
          and (${table.status} = 'delivered') = (${table.deliveredAt} is not null)
          and (${table.status} <> 'failed' or ${table.lastError} is not null)`,
    ),
  ],
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
    /** `'user'`, `'user:<id>'`, `'rule:<rule_id>'`, `'forwarder'`, or `'system'`. */
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

/* ============================================ Splitwise drift & ghost-debt auditing */

/**
 * One invocation of the Splitwise auditing engine (phase 19, ADR-0046).
 *
 * SYSTEM, immutable. Its whole job is provenance: which comparison produced which findings,
 * against how much of Splitwise this ledger could actually see. `external_read_status` is
 * the field that keeps a failed or unsupported read from ever reading as agreement — a run
 * that saw nothing says so on its own row, and every finding it wrote points back here.
 *
 * `reconciliation_run_id` is set when the audit ran as part of a `ReconciliationRun` and null
 * when it was invoked on its own, so a finding can always name the reconciliation it belongs
 * to when there is one, without inventing one when there is not.
 */
export const splitwiseAuditRuns = pgTable(
  'splitwise_audit_runs',
  {
    id: id(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    reconciliationRunId: uuid('reconciliation_run_id').references(() => reconciliationRuns.id),
    externalIntegrationId: uuid('external_integration_id').references(
      () => externalIntegrations.id,
    ),
    /** The worst status across every pair audited — `complete` only when all of them were. */
    externalReadStatus: text('external_read_status').notNull(),
    /** Why the read was not complete, when it was not. Never summarised into "fine". */
    externalReadDetail: text('external_read_detail'),
    pairsAudited: integer('pairs_audited').notNull().default(0),
    /** Pairs whose external side could not be read or was not reported at all. */
    pairsUnchecked: integer('pairs_unchecked').notNull().default(0),
    findingsCreated: integer('findings_created').notNull().default(0),
    findingsReobserved: integer('findings_reobserved').notNull().default(0),
    findingsSuperseded: integer('findings_superseded').notNull().default(0),
    /** `fetchBalances()`'s reply, verbatim — the same "keep what they said" rule as sync rows. */
    externalBalancesSnapshot: jsonb('external_balances_snapshot'),
    createdAt: createdAt(),
  },
  (table) => [
    index('splitwise_audit_runs_run_at_idx').on(table.runAt),
    index('splitwise_audit_runs_reconciliation_idx').on(table.reconciliationRunId),
    check(
      'splitwise_audit_runs_read_status_check',
      oneOf('external_read_status', SPLITWISE_EXTERNAL_READ_STATUSES),
    ),
    check(
      'splitwise_audit_runs_counts_check',
      sql`${table.pairsAudited} >= 0 and ${table.pairsUnchecked} >= 0
          and ${table.pairsUnchecked} <= ${table.pairsAudited}
          and ${table.findingsCreated} >= 0 and ${table.findingsReobserved} >= 0
          and ${table.findingsSuperseded} >= 0`,
    ),
  ],
);

/**
 * One durable, reviewable audit finding (phase 19, ADR-0046).
 *
 * DERIVED and user-facing, so every review writes an `AuditEvent` (`invariants.md` #21) and
 * the row itself is never rewritten by a later comparison: a materially different answer
 * **supersedes** this row and inserts a new one, which is what keeps the original evidence and
 * both compared snapshots exactly as they were recorded (#22's spirit applied to findings).
 *
 * Two columns carry the idempotency contract:
 *
 *  - `fingerprint` is the finding's identity — cause plus subject, no amounts. It is unique
 *    among rows that have not been superseded, so an unchanged rerun finds its own predecessor
 *    instead of appending a second opinion about the same record.
 *  - `comparison_digest` is its materiality — a hash over the compared snapshots and figures.
 *    Same digest, same comparison: the run only touches `last_observed_*`. Different digest:
 *    supersede and insert.
 *
 * Nothing here authorizes a write back to Splitwise. Reviewing a finding records what a person
 * concluded; re-syncing a `stale` row remains separate, explicitly approved work (ADR-0040/41).
 */
export const splitwiseAuditFindings = pgTable(
  'splitwise_audit_findings',
  {
    id: id(),
    /** The run that first produced this finding — its provenance, never rewritten. */
    auditRunId: uuid('audit_run_id')
      .notNull()
      .references(() => splitwiseAuditRuns.id),
    /** The most recent run that produced the identical comparison. Status metadata only. */
    lastObservedAuditRunId: uuid('last_observed_audit_run_id')
      .notNull()
      .references(() => splitwiseAuditRuns.id),
    reconciliationRunId: uuid('reconciliation_run_id').references(() => reconciliationRuns.id),
    kind: text('kind').notNull(),
    /** `discrepancy` | `limitation` | `incomplete` — see `SPLITWISE_AUDIT_FINDING_CLASSES`. */
    findingClass: text('finding_class').notNull(),
    /** How precisely this is attributed. `pair` is the aggregate level, with no culprit named. */
    scope: text('scope').notNull(),
    summary: text('summary').notNull(),
    /** `high | medium | low | unknown` — a deterministic evidence strength, never an AI output. */
    confidence: text('confidence').notNull(),
    /** Positive magnitude the finding is about. Null when it is not about an amount. */
    amount: paiseColumn('amount'),
    /** Signed share of `theirs − ours` this finding accounts for (`domain.auditSplitwisePair`). */
    balanceImpact: paiseColumn('balance_impact').notNull(),
    personAId: uuid('person_a_id').references(() => people.id),
    personBId: uuid('person_b_id').references(() => people.id),
    expenseId: uuid('expense_id').references(() => expenses.id),
    splitwiseExpenseRowId: uuid('splitwise_expense_row_id').references(() => splitwiseExpenses.id),
    settlementId: uuid('settlement_id').references(() => settlements.id),
    splitwiseSettlementRowId: uuid('splitwise_settlement_row_id').references(
      () => splitwiseSettlements.id,
    ),
    /** Splitwise's own id for the entry this is about, when there is one. */
    externalReference: text('external_reference'),
    /** What this ledger held at comparison time. */
    localSnapshot: jsonb('local_snapshot').notNull(),
    /** What Splitwise reported, uninterpreted. Null when the read produced nothing. */
    externalSnapshot: jsonb('external_snapshot'),
    /** Pointers to the records supporting the conclusion — never copies of them. */
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'[]'::jsonb`),
    fingerprint: text('fingerprint').notNull(),
    comparisonDigest: text('comparison_digest').notNull(),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull().defaultNow(),
    reviewStatus: text('review_status').notNull().default('open'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** `'user'` or `'user:<id>'` — a person, never a model and never `system`. */
    reviewedBy: text('reviewed_by'),
    reviewReason: text('review_reason'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededByFindingId: uuid('superseded_by_finding_id').references(
      (): AnyPgColumn => splitwiseAuditFindings.id,
    ),
    supersedeReason: text('supersede_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One current row per identity. A rerun that finds the same cause on the same record
    // updates when-last-seen; it never appends a second row saying the same thing.
    uniqueIndex('splitwise_audit_findings_current_idx')
      .on(table.fingerprint)
      .where(sql`${table.supersededAt} is null`),
    index('splitwise_audit_findings_run_idx').on(table.auditRunId),
    index('splitwise_audit_findings_review_idx').on(table.reviewStatus, table.firstObservedAt),
    index('splitwise_audit_findings_pair_idx').on(table.personAId, table.personBId),
    check('splitwise_audit_findings_kind_check', oneOf('kind', SPLITWISE_AUDIT_FINDING_KINDS)),
    check(
      'splitwise_audit_findings_class_check',
      oneOf('finding_class', SPLITWISE_AUDIT_FINDING_CLASSES),
    ),
    check('splitwise_audit_findings_scope_check', oneOf('scope', SPLITWISE_AUDIT_FINDING_SCOPES)),
    check('splitwise_audit_findings_confidence_check', oneOf('confidence', CONFIDENCE_LEVELS)),
    check(
      'splitwise_audit_findings_review_status_check',
      oneOf('review_status', SPLITWISE_AUDIT_REVIEW_STATUSES),
    ),
    check(
      'splitwise_audit_findings_supersede_reason_check',
      sql`${table.supersedeReason} is null
          or supersede_reason in ('materially_changed', 'no_longer_observed')`,
    ),
    // A magnitude is a magnitude. `balance_impact` is deliberately unconstrained in sign — it
    // is a signed share of a signed gap, and clamping it would break the residual arithmetic.
    check(
      'splitwise_audit_findings_amount_check',
      sql`${table.amount} is null or ${table.amount} >= 0`,
    ),
    // A review is attributable and explained, or it is not a review. `open` is the audit's own
    // state and carries no actor, because nobody decided it.
    check(
      'splitwise_audit_findings_review_attribution_check',
      sql`(${table.reviewStatus} <> 'open')
            = (${table.reviewedAt} is not null)
          and (${table.reviewStatus} <> 'open')
            = (${table.reviewedBy} is not null)
          and (${table.reviewStatus} in ('resolved', 'dismissed'))
            <= (${table.reviewReason} is not null)`,
    ),
    // Superseding is one decision with three parts; a row cannot be half-superseded.
    check(
      'splitwise_audit_findings_supersede_check',
      sql`(${table.supersededAt} is null) = (${table.supersedeReason} is null)
          and (${table.supersededByFindingId} is null or ${table.supersededAt} is not null)`,
    ),
    check(
      'splitwise_audit_findings_snapshot_shape_check',
      sql`jsonb_typeof(${table.localSnapshot}) = 'object'
          and (${table.externalSnapshot} is null
               or jsonb_typeof(${table.externalSnapshot}) = 'object')
          and jsonb_typeof(${table.evidence}) = 'array'`,
    ),
  ],
);
