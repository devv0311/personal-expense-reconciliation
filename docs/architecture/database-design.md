# Database Design

Translates `docs/domain/domain-model.md` into a relational schema. **This is a design
document, not migrations** — per `docs/roadmap.md`, migrations are written only after this is
reviewed. All tables use PostgreSQL; all monetary `amount` columns are `bigint` minor units
(paise), never floating point, per `docs/domain/invariants.md` #12. All tables have `id uuid
primary key default gen_random_uuid()` and `created_at timestamptz not null default now()`
unless noted; both are omitted from the per-table lists below to reduce repetition.

> **Revision note (2026-08).** This schema was revised alongside `domain-model.md` and
> `invariants.md` following a pre-implementation architecture review. New tables:
> `settlements`, `splitwise_settlements`, `expense_adjustments`,
> `allocation_line_group_expansions`. Changed tables: `expenses` (added `paid_by_person_id`,
> removed `refund_of_expense_id`, shrank `relationship_type`), `payments` (added
> `external_reference`/`reference_type`/`source_system`, extended `counterparty_type`),
> `payment_expense_links` (sum invariant now shared with `settlements`),
> `splitwise_expenses` (added `stale` sync status), `reconciliation_runs` (added
> `ledger_settlements_total`, `ledger_investments_total`). See ADRs 0006–0011 in
> `docs/decisions/` for the reasoning behind each change. No migrations exist yet, so all of this
> remains a design-doc-only change at this stage.
>
> **Further revision note (2026-08, implementation-readiness pass).** `allocation_lines.amount`
> and `allocation_line_group_expansions.amount` checks weakened from `> 0` to `>= 0` (a
> net-zero-refund line is now a defined, valid shape, not disallowed — `invariants.md` #12a).
> The rounding algorithm referenced generically as "documented at the point it happens" is now
> fully specified (`domain.splitByLargestRemainder()`, `invariants.md` #12) — no schema change,
> but every application-level sum-check above that mentions rounding now points at one concrete
> algorithm, not a placeholder.

## Conventions

- **Immutable (SOURCE) tables** — `payments`, `evidence`, `import_batches` — have no
  `updated_at` column and no `UPDATE` grants at the application-role level for their immutable
  columns; corrections happen in other tables, never via `UPDATE` on these. This is enforced at
  two levels: the `services` layer never issues an `UPDATE` against them, and (defense in
  depth) the application's Postgres role can be denied `UPDATE` privilege on these tables
  entirely, forcing any accidental attempt to fail loudly at the database level rather than
  silently succeed. **`expenses.amount` joins this immutability class as of this revision** — see
  below.
- **Audit** — every table holding APPROVED or user-facing DERIVED data has changes captured in
  `audit_events` (see below) at the service layer. Considered and rejected: database triggers
  for audit capture — rejected because the audit record needs application-level context
  (reason, actor, which `AIInference` triggered it) that a trigger cannot see.
- **Soft delete, not hard delete**, for anything that might be referenced by financial history
  (`people`, `groups`, `accounts`, `merchants`): an `archived_at timestamptz` column, no `DELETE`
  from these tables in normal operation.
- **Money-sum invariants** (e.g. allocation lines summing to the expense's net amount) are
  validated in `domain`/`services` before the transaction commits, backed by a Postgres `CHECK`
  constraint only where a simple per-row check suffices (e.g. `amount > 0`); cross-row sum
  invariants are enforced in application code inside a single database transaction, not via
  triggers, to keep the validation logic in one place (`domain`) rather than split between
  TypeScript and SQL.

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
('merchant','person','internal_account','investment_instrument','unknown'))` —
`investment_instrument` **added, ADR-0011**,
`counterparty_id uuid` (nullable, polymorphic — resolved against `merchants`/`people`/
`accounts`/an investment-instrument reference depending on `counterparty_type`; no DB-level FK
given the polymorphism, validated in `services`),
`external_reference text` (nullable — UPI UTR/RRN, bank reference, card reference, merchant
order ID, cheque number — **added, ADR-0010**),
`reference_type text` (nullable, check (`reference_type in ('upi_utr','upi_rrn',
'bank_reference','card_reference','merchant_order_id','cheque_number','other')`) —
**added, ADR-0010**),
`source_system text` (nullable — originating app/institution, e.g. `'hdfc_bank_csv'`,
`'gpay_export'`, distinct from `channel` and from `import_batches.source_channel` —
**added, ADR-0010**),
`state text not null default 'imported' check (state in
('imported','normalized','linked','ignored'))` — `linked` now means "explained by
`payment_expense_links` and/or `settlements`," see `lifecycle.md` — `ignored_reason text`
(nullable).
Indexes: `(account_id, occurred_at)`, `(amount, occurred_at, account_id)` (duplicate
detection), `(external_reference)` partial where `external_reference is not null` — **global,
not scoped by `account_id`, amended this revision** (deterministic duplicate detection, ADR-0010:
the same real-world transaction can land under two different `Account` rows when captured by two
different import channels, e.g. a bank CSV vs. a UPI export of the same UPI payment — requiring
`account_id` to match would make the deterministic path unreachable for exactly that case).

### evidence — SOURCE (immutable)

`id`, `type text not null check (type in
('bank_line','upi_notification','receipt_image','screenshot','email_receipt','manual_note'))`,
`storage_ref text` (nullable), `raw_text text` (nullable), `captured_at timestamptz not null`,
`linked_payment_id references payments(id)` (nullable),
`linked_expense_id uuid` (nullable, FK added once `expenses` is defined below). This is the
**only** place Payment/Expense linkage lives for `Evidence` and, transitively, for `Receipt` —
see `receipts` below.
`note_kind text` (nullable, check (`note_kind in ('documentation','settlement_claim')`) —
**added, ADR-0018**): what a manual note asserts. A second check,
`(type = 'manual_note') = (note_kind is not null)`, requires it on manual notes and forbids it
everywhere else. Without it, documenting an externally-funded expense (ADR-0006) and claiming a
debt was cleared (ADR-0014) are the same row, and the second reading fires on every instance of
the first.
Index: `(linked_expense_id)` partial where `note_kind = 'settlement_claim'` — the balance query
reads only those.

### receipts — DERIVED

`id`, `evidence_id references evidence(id) not null`, `merchant_id references merchants(id)`
(nullable), `subtotal bigint`, `tax bigint`, `total bigint`, `currency default 'INR'`,
`extraction_confidence text check (extraction_confidence in
('high','medium','low','unknown'))`, `extracted_at timestamptz`, `confirmed_by_user boolean
not null default false`, `updated_at timestamptz not null default now()`.
**No `payment_id` or `expense_id` column** — deliberate, not an oversight (clarified this
revision; `domain-model.md`'s `Receipt` section previously read ambiguously enough to suggest
otherwise). Payment/expense linkage for a receipt is always reached via its `evidence_id` →
`evidence.linked_payment_id`/`linked_expense_id`, or, for the "one receipt split across several
expenses" case, via `receipt_items → expense_items → expenses`.

### receipt_items — DERIVED

`id`, `receipt_id references receipts(id) not null`, `description not null`, `quantity
numeric(10,3) not null default 1`, `unit_price bigint`, `line_total bigint not null`,
`suggested_category`.

### expenses — gross `amount` is SOURCE-immutable once APPROVED; rest DERIVED until approved, then APPROVED

`id`, `description`, `amount bigint not null check (amount > 0)` — **gross, historical, never
updated once the expense reaches `approved`, by any mechanism (revised, ADR-0008)** —
`currency default 'INR'`, `occurred_at timestamptz not null`,
`relationship_type text not null check (relationship_type in
('personal','shared','paid_on_behalf','gift','household_shared_flat'))` — **shrunk from the
original 7-value enum; `settlement` removed (ADR-0007, now the `settlements` table) and
`reimbursement` removed (ADR-0008, now `expense_adjustments.kind = 'third_party_reimbursement'`)**,
`category`, `occasion_id uuid` (nullable, FK to `expense_occasions`),
`paid_by_person_id uuid not null references people(id)` — **added, ADR-0006** — who actually
fronted the money; not necessarily the user,
`state text not null default 'proposed' check (state in
('proposed','classified','review_required','approved','allocated','ready_to_sync','synced',
'reconciled'))`,
`updated_at timestamptz not null default now()`.
**`refund_of_expense_id` removed** (was a nullable self-reference; superseded by
`expense_adjustments`, ADR-0008).
Indexes: `(state)`, `(occasion_id)`, `(paid_by_person_id)`.
Application-level check: `paid_by_person_id` must be a `Person` who is either the system's own
`User` (in which case at least one `payment_expense_links` row is expected, subject to the
evidence-pending exception) or someone else entirely (in which case **no**
`payment_expense_links` row will ever exist for this expense — that is the expected shape, not
an error state).

### payment_expense_links — APPROVED

`id`, `payment_id references payments(id) not null`, `expense_id references expenses(id) not
null`, `amount bigint not null check (amount > 0)`.
Unique on `(payment_id, expense_id)`. Application-level check (not a simple DB constraint):
**for a given `payment_id`, the sum of `amount` here plus the sum of `amount` in `settlements`
for the same `payment_id` must not exceed that payment's `amount`** (revised, ADR-0007, to
account for `settlements` sharing the same payment-explanation budget).

### expense_items — DERIVED or APPROVED

`id`, `expense_id references expenses(id) not null`, `description not null`, `amount bigint
not null`, `quantity numeric(10,3) not null default 1`, `receipt_item_id references
receipt_items(id)` (nullable).
Application-level check: sum of `amount` per `expense_id` equals `expenses.amount` (gross —
unaffected by later `expense_adjustments`).

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
Application-level check: sum of the current allocation's `allocation_lines.amount` equals
`domain.netAmount(expense)` — **`expenses.amount` minus the sum of any `expense_adjustments`
for that expense** (revised, ADR-0008) — not gross `expenses.amount` directly.

### allocation_lines — APPROVED

`id`, `allocation_id references allocations(id) not null`, `beneficiary_type text not null
check (beneficiary_type in ('person','group'))`, `beneficiary_id uuid not null` (validated
against `people`/`groups` per type in `services`, no single DB FK given the polymorphism),
`amount bigint not null check (amount >= 0)` — **weakened from `> 0`, this revision**: a
zero-amount line is the valid, expected shape for an original beneficiary on a fully
refunded/reimbursed expense's current allocation, not an error (`invariants.md` #12a) —
`percentage numeric(5,2)` (nullable), `expense_item_id references expense_items(id)`
(nullable).
Application-level checks: sum of `amount` per `allocation_id` equals the parent allocation's
target (see `allocations` above), computed by `domain.splitByLargestRemainder()`
(`invariants.md` #12) for `equal`/`percentage` methods — never by floating-point division; sum
of `amount` per `expense_item_id` (for item-based lines) equals that item's own `amount`,
checked per item, not just in aggregate across the expense (invariant #14, tightened this
revision).

### allocation_line_group_expansions — APPROVED — **new table, ADR-0009**

`id`, `allocation_line_id references allocation_lines(id) not null` (must reference a line with
`beneficiary_type = 'group'`), `person_id references people(id) not null`, `amount bigint not
null check (amount >= 0)` (same reasoning as `allocation_lines.amount` above — a net-zero
expense's group expansion rows can legitimately be 0).
Unique on `(allocation_line_id, person_id)`.
Application-level check: sum of `amount` per `allocation_line_id` equals that line's own
`amount`.
Written exactly once, when the parent `allocation_line` is approved, by resolving
`group_memberships` active as of the expense's `occurred_at`. **Never updated or recomputed**
after write, including when group membership later changes (`scenario-analysis.md` §35) — no
`updated_at` column, by design, matching the other immutable-once-written tables.

### settlements — APPROVED — **new table, ADR-0007**

`id`, `payment_id references payments(id) not null`, `counterparty_person_id references
people(id) not null`, `amount bigint not null check (amount > 0)`, `reason text` (nullable),
`recorded_at timestamptz not null default now()`.
Index: `(payment_id)`, `(counterparty_person_id)`.
Application-level check: shares the payment-explanation budget with `payment_expense_links` —
see that table's revised invariant above. Direction (did the user pay the counterparty, or
receive from them) is read from the linked `payments.direction`, not stored redundantly here.
**No `allocation_id` column** — a `Settlement` never has an `Allocation` (invariant #9a).

### splitwise_settlements — SYSTEM / snapshot of APPROVED data — **new table, ADR-0007**

`id`, `settlement_id references settlements(id) not null`, `external_integration_id references
external_integrations(id) not null`, `splitwise_transaction_id text not null`, `synced_at
timestamptz not null`, `our_snapshot jsonb not null`, `their_snapshot jsonb`, `sync_status text
not null default 'pending' check (sync_status in
('pending','synced','drifted','sync_failed'))`.
Unique on `(external_integration_id, splitwise_transaction_id)`.
Structurally parallel to `splitwise_expenses` by design, kept as a separate table rather than a
generalized polymorphic one — see ADR-0007's "Alternatives considered."

### expense_adjustments — DERIVED (recorded) then APPROVED (distributed) — **new table, ADR-0008**

`id`, `original_expense_id references expenses(id) not null`, `kind text not null check (kind
in ('merchant_refund','third_party_reimbursement'))`, `amount bigint not null check (amount >
0)`, `adjustment_payment_id references payments(id)` (nullable — evidence-first is valid, same
as any other payment-matching flow), `reason text` (nullable), `occurred_at timestamptz not
null`.
Index: `(original_expense_id)`.
Application-level check: `sum(amount) for one original_expense_id` must not exceed that
expense's gross `amount`. This table **replaces** `expenses.refund_of_expense_id` from the
original design; `reimbursement` no longer exists as an `expenses.relationship_type` value — see
`expenses` above.

### ai_inferences — DERIVED (always)

`id`, `inference_type not null`, `input_ref_type not null`, `input_ref_id uuid not null`,
`proposed_output jsonb not null` — for `inference_type = 'classify_transaction'`, includes a
`proposedKind: 'expense' | 'settlement'` field alongside the usual `relationship_type` proposal
(**added, ADR-0007**) — `confidence text not null check (confidence in
('high','medium','low','unknown'))`, `model_provider`, `model_name`, `prompt_version`,
`status text not null default 'pending' check (status in
('pending','accepted','modified','rejected','superseded'))`, `decided_at timestamptz`
(nullable), `decided_by text` (nullable), `resulting_record_type` (now includes `'settlement'`
as a possible value alongside `'expense'`, `'merchant'`, etc.), `resulting_record_id uuid`
(nullable).
Index: `(input_ref_type, input_ref_id, status)`.

### rules — APPROVED

`id`, `match_pattern jsonb not null`, `proposed_classification jsonb not null`, `origin text
not null check (origin in ('manual','promoted_from_repeated_ai_suggestion'))`, `active boolean
not null default true`, `times_applied integer not null default 0`.

### audit_events — SYSTEM, append-only

`id`, `sequence bigserial not null` (**added during Phase 6** — monotonic insertion order; see
below), `entity_type not null` (now includes `'settlement'` and `'expense_adjustment'` as valid
values alongside `'expense'`, `'allocation'`, etc.), `entity_id uuid not null`, `action text not
null check (action in ('create','update','supersede','delete'))`, `old_value jsonb`, `new_value
jsonb not null`, `actor text not null`, `source`, `reason`, `ai_inference_id references
ai_inferences(id)` (nullable), `occurred_at timestamptz not null default clock_timestamp()`.

**Reading order is `sequence`, not `occurred_at`.** `occurred_at` resolves to milliseconds, so
two events written back-to-back inside one audited unit of work — a `create` and the `update`
that immediately follows it, the common shape — routinely share a timestamp, leaving a random
UUID to break the tie. An append-only log whose order is arbitrary cannot answer "what
happened, and then what happened next". `occurred_at` is the human-facing _when_; `sequence` is
the _order_. (`clock_timestamp()` rather than `now()` because `now()` is the _transaction_ start
time, which is not when the event happened.)
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
('pending','synced','drifted','stale','sync_failed'))` — **`stale` added, ADR-0008**: our own
side changed (an `expense_adjustments` row was distributed) since the last sync, distinct from
`drifted` (Splitwise's side changed independently). **When the adjustment that caused `stale`
brought `domain.netAmount(expense)` to exactly 0** (finalized this revision — see
`domain-model.md`'s "Splitwise implications of a net-zero adjustment"), the fresh proposal owed
is a **deletion** of the Splitwise expense via the integration's delete endpoint, not a
$0-amount update — `integrations/splitwise` must branch on this at the point it builds the
re-sync proposal, checking `netAmount = 0` rather than assuming every `stale` row implies an
amount-update payload.
Unique on `(external_integration_id, splitwise_expense_id)`.

### reconciliation_runs — SYSTEM

`id`, `run_at timestamptz not null default now()`, `period_start date not null`, `period_end
date not null`, `ledger_total_outflow bigint not null`, `ledger_transfers_total bigint not
null`, `ledger_investments_total bigint not null` (**added, ADR-0011**),
`ledger_settlements_total bigint not null` (**added, ADR-0007**),
`ledger_explained_total bigint not null` (**now sums `domain.netAmount(expense)` per expense,
ADR-0008 — not gross `expenses.amount`**), `ledger_unexplained_total bigint not null`,
`splitwise_balances_snapshot jsonb`, `discrepancies jsonb not null default '[]'`,
`resolved_at timestamptz` (nullable).
Invariant (revised, `invariants.md` #20): `ledger_unexplained_total = ledger_total_outflow −
ledger_transfers_total − ledger_investments_total − ledger_settlements_total −
ledger_explained_total`.

## Deliberately deferred

- Row-level security policies — revisit once real multi-user access is on the roadmap.
- Partitioning/archival strategy for `audit_events` and `ai_inferences` — irrelevant at
  personal-project data volume; revisit if either table grows large enough to matter.
- Full-text search indexes on `payments.raw_description` / `evidence.raw_text` — add when the
  natural-language interface phase (`docs/roadmap.md`, phase 18) needs it.
- **Inflow-side reconciliation** (a symmetric `ledger_unexplained_inflow` covering credits that
  aren't refunds, reimbursements, or settlements received) — an explicit **V1 scope boundary**,
  finalized this revision, not an open question: `payments.direction = credit` is already fully
  supported by this schema, so nothing here blocks adding an income classification + inflow
  reconciliation total later; V1 simply doesn't build it. See `domain-model.md`'s
  `ReconciliationRun` "V1 scope, explicit" and `docs/roadmap.md`.
- **A `settlements` row for a debt between two people neither of whom is the current `User`** —
  structurally impossible to back with a `Payment` this ledger can observe (see
  `domain-model.md`'s Obligation/Balance section, "a known, documented limitation"); such debts
  remain representable in the derived `Balance` formula from `AllocationLine` data alone, just
  never settleable via a `settlements` row in this schema. Splitwise or manual `Evidence` is the
  only record of their resolution.
