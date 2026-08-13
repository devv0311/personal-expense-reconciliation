# Database Design

Translates `docs/domain/domain-model.md` into a relational schema. **This is a design
document, not migrations** — per `docs/roadmap.md`, migrations are written only after this is
reviewed. All tables use PostgreSQL; all monetary `amount` columns are `bigint` minor units
(paise), never floating point, per `docs/domain/invariants.md` #12. All tables have `id uuid
primary key default gen_random_uuid()` and `created_at timestamptz not null default now()`
unless noted; both are omitted from the per-table lists below to reduce repetition.

## Conventions

- **Immutable (SOURCE) tables** — `payments`, `evidence`, `import_batches` — have no
  `updated_at` column and no `UPDATE` grants at the application-role level for their immutable
  columns; corrections happen in other tables, never via `UPDATE` on these. This is enforced at
  two levels: the `services` layer never issues an `UPDATE` against them, and (defense in
  depth) the application's Postgres role can be denied `UPDATE` privilege on these tables
  entirely, forcing any accidental attempt to fail loudly at the database level rather than
  silently succeed.
- **Audit** — every table holding APPROVED or user-facing DERIVED data has changes captured in
  `audit_events` (see below) at the service layer. Considered and rejected: database triggers
  for audit capture — rejected because the audit record needs application-level context
  (reason, actor, which `AIInference` triggered it) that a trigger cannot see.
- **Soft delete, not hard delete**, for anything that might be referenced by financial history
  (`people`, `groups`, `accounts`, `merchants`): an `archived_at timestamptz` column, no `DELETE`
  from these tables in normal operation.
- **Money-sum invariants** (e.g. allocation lines summing to expense amount) are validated in
  `domain`/`services` before the transaction commits, backed by a Postgres `CHECK` constraint
  only where a simple per-row check suffices (e.g. `amount > 0`); cross-row sum invariants are
  enforced in application code inside a single database transaction, not via triggers, to keep
  the validation logic in one place (`domain`) rather than split between TypeScript and SQL.

## Tables

### users

`id`, `email unique not null`, `person_id uuid not null references people(id)`,
`password_hash` (or equivalent — finalized with `docs/security/security-model.md`).

### accounts

`id`, `owner_user_id references users(id) not null`, `name not null`,
`type text not null check (type in ('bank','upi','card','cash','wallet'))`,
`institution`, `last4 text` (nullable, max 4 digits, never a full number), `currency
not null default 'INR'`, `is_active boolean not null default true`, `archived_at`.
Index: `(owner_user_id, is_active)`.

### people

`id`, `display_name not null`, `linked_user_id uuid references users(id)` (nullable),
`splitwise_user_id text` (nullable), `notes`, `archived_at`.
Unique partial index on `linked_user_id` where not null (a `User` maps to exactly one `Person`).

### groups

`id`, `name not null`, `type text`, `archived_at`.

### group_memberships

`id`, `group_id references groups(id) not null`, `person_id references people(id) not null`,
`joined_at timestamptz not null`, `left_at timestamptz` (nullable).
Index: `(group_id, person_id, joined_at)`. No unique constraint forcing one active row per
person/group — re-joining after leaving is valid and each stint is its own row.

### merchants

`id`, `canonical_name not null`, `default_category`, `archived_at`.

### merchant_aliases

`id`, `merchant_id references merchants(id) not null`, `raw_pattern not null`.
Unique on `raw_pattern` (an alias resolves to exactly one merchant).

### import_batches — SOURCE (immutable)

`id`, `source_channel not null`, `file_reference`, `content_hash` (for re-import detection,
unique when not null), `imported_at not null default now()`, `parser_version`, `row_count`.

### payments — SOURCE (immutable)

`id`, `account_id references accounts(id) not null`, `import_batch_id references
import_batches(id) not null`, `amount bigint not null check (amount > 0)`,
`currency not null default 'INR'`, `direction text not null check (direction in
('debit','credit'))`, `occurred_at timestamptz not null`,
`raw_description text not null`, `channel text not null check (channel in
('upi','bank_transfer','card','cash','other'))`,
`counterparty_type text not null default 'unknown' check (counterparty_type in
('merchant','person','internal_account','unknown'))`,
`counterparty_id uuid` (nullable, polymorphic — resolved against `merchants`/`people`/
`accounts` depending on `counterparty_type`; no DB-level FK given the polymorphism, validated
in `services`), `state text not null default 'imported' check (state in
('imported','normalized','linked','ignored'))`, `ignored_reason text` (nullable).
Indexes: `(account_id, occurred_at)`, `(amount, occurred_at, account_id)` (duplicate
detection).

### evidence — SOURCE (immutable)

`id`, `type text not null check (type in
('bank_line','upi_notification','receipt_image','screenshot','email_receipt','manual_note'))`,
`storage_ref text` (nullable), `raw_text text` (nullable), `captured_at timestamptz not null`,
`linked_payment_id references payments(id)` (nullable),
`linked_expense_id uuid` (nullable, FK added once `expenses` is defined below).

### receipts — DERIVED

`id`, `evidence_id references evidence(id) not null`, `merchant_id references merchants(id)`
(nullable), `subtotal bigint`, `tax bigint`, `total bigint`, `currency default 'INR'`,
`extraction_confidence text check (extraction_confidence in
('high','medium','low','unknown'))`, `extracted_at timestamptz`, `confirmed_by_user boolean
not null default false`, `updated_at timestamptz not null default now()`.

### receipt_items — DERIVED

`id`, `receipt_id references receipts(id) not null`, `description not null`, `quantity
numeric(10,3) not null default 1`, `unit_price bigint`, `line_total bigint not null`,
`suggested_category`.

### expenses — DERIVED until approved, then APPROVED

`id`, `description`, `amount bigint not null check (amount > 0)`, `currency default 'INR'`,
`occurred_at timestamptz not null`, `relationship_type text not null check
(relationship_type in
('personal','shared','paid_on_behalf','gift','reimbursement','settlement',
'household_shared_flat'))`,
`category`, `occasion_id uuid` (nullable, FK to `expense_occasions`),
`refund_of_expense_id uuid references expenses(id)` (nullable — self-reference, added per the
finding in `docs/domain/scenario-analysis.md` #11–#12),
`state text not null default 'proposed' check (state in
('proposed','classified','review_required','approved','allocated','ready_to_sync','synced',
'reconciled'))`,
`updated_at timestamptz not null default now()`.
Index: `(state)`, `(occasion_id)`.

### payment_expense_links — APPROVED

`id`, `payment_id references payments(id) not null`, `expense_id references expenses(id) not
null`, `amount bigint not null check (amount > 0)`.
Unique on `(payment_id, expense_id)`. Application-level check (not a simple DB constraint):
sum of `amount` per `payment_id` must not exceed that payment's `amount`.

### expense_items — DERIVED or APPROVED

`id`, `expense_id references expenses(id) not null`, `description not null`, `amount bigint
not null`, `quantity numeric(10,3) not null default 1`, `receipt_item_id references
receipt_items(id)` (nullable).

### expense_occasions — DERIVED until confirmed, then APPROVED (as a grouping)

`id`, `name not null`, `occurred_start date not null`, `occurred_end date` (nullable — see
`scenario-analysis.md` #10 for why a range, not a single date), `default_participants jsonb
not null default '[]'` (list of `{type: 'person'|'group', id}`).

### allocations — APPROVED

`id`, `expense_id references expenses(id) not null`, `method text not null check (method in
('equal','exact','percentage','item_based','quantity_based','custom'))`, `decided_at
timestamptz not null`, `decided_by text not null` (`'manual'` or `'rule:<rule_id>'`),
`superseded_at timestamptz` (nullable — set when a later `Allocation` replaces this one;
old rows are kept, never deleted, per invariant #6).
Partial unique index on `expense_id` where `superseded_at is null` (exactly one current
allocation per expense).

### allocation_lines — APPROVED

`id`, `allocation_id references allocations(id) not null`, `beneficiary_type text not null
check (beneficiary_type in ('person','group'))`, `beneficiary_id uuid not null` (validated
against `people`/`groups` per type in `services`, no single DB FK given the polymorphism),
`amount bigint not null`, `percentage numeric(5,2)` (nullable), `expense_item_id references
expense_items(id)` (nullable).
Application-level check: sum of `amount` per `allocation_id` equals the parent expense's
`amount`.

### ai_inferences — DERIVED (always)

`id`, `inference_type not null`, `input_ref_type not null`, `input_ref_id uuid not null`,
`proposed_output jsonb not null`, `confidence text not null check (confidence in
('high','medium','low','unknown'))`, `model_provider`, `model_name`, `prompt_version`,
`status text not null default 'pending' check (status in
('pending','accepted','modified','rejected','superseded'))`, `decided_at timestamptz`
(nullable), `decided_by text` (nullable), `resulting_record_type`, `resulting_record_id uuid`
(nullable).
Index: `(input_ref_type, input_ref_id, status)`.

### rules — APPROVED

`id`, `match_pattern jsonb not null`, `proposed_classification jsonb not null`, `origin text
not null check (origin in ('manual','promoted_from_repeated_ai_suggestion'))`, `active boolean
not null default true`, `times_applied integer not null default 0`.

### audit_events — SYSTEM, append-only

`id`, `entity_type not null`, `entity_id uuid not null`, `action text not null check (action
in ('create','update','supersede','delete'))`, `old_value jsonb`, `new_value jsonb not null`,
`actor text not null`, `source`, `reason`, `ai_inference_id references ai_inferences(id)`
(nullable), `occurred_at timestamptz not null default now()`.
Index: `(entity_type, entity_id, occurred_at)`. No `UPDATE`/`DELETE` grants at the
application-role level.

### external_integrations — SYSTEM

`id`, `type text not null check (type in ('splitwise'))`, `owner_user_id references
users(id) not null`, `external_account_ref`, `status text not null default 'disconnected'
check (status in ('connected','disconnected','error'))`, `connected_at timestamptz`,
`last_synced_at timestamptz`.
Credential/token storage is out of this table — see `docs/security/security-model.md`
(secrets manager or encrypted-at-rest column with access outside normal query paths, decided
when this integration is implemented).

### splitwise_expenses — SYSTEM / snapshot of APPROVED data

`id`, `expense_id references expenses(id) not null`, `external_integration_id references
external_integrations(id) not null`, `splitwise_expense_id text not null`, `synced_at
timestamptz not null`, `our_snapshot jsonb not null`, `their_snapshot jsonb`, `sync_status text
not null default 'pending' check (sync_status in
('pending','synced','drifted','sync_failed'))`.
Unique on `(external_integration_id, splitwise_expense_id)`.

### reconciliation_runs — SYSTEM

`id`, `run_at timestamptz not null default now()`, `period_start date not null`, `period_end
date not null`, `ledger_total_outflow bigint not null`, `ledger_transfers_total bigint not
null`, `ledger_explained_total bigint not null`, `ledger_unexplained_total bigint not null`,
`splitwise_balances_snapshot jsonb`, `discrepancies jsonb not null default '[]'`,
`resolved_at timestamptz` (nullable).

## Deliberately deferred

- Row-level security policies — revisit once real multi-user access is on the roadmap.
- Partitioning/archival strategy for `audit_events` and `ai_inferences` — irrelevant at
  personal-project data volume; revisit if either table grows large enough to matter.
- Full-text search indexes on `payments.raw_description` / `evidence.raw_text` — add when the
  natural-language interface phase (`docs/roadmap.md`, phase 18) needs it.
