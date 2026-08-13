# Domain Model

This document defines the entities of the system. It is deliberately produced _before_ any
database schema or code, per `docs/roadmap.md` phase order — schema design
(`docs/architecture/database-design.md`) translates this model, not the other way around.

Every entity is documented with: purpose, key fields, relationships, lifecycle, invariants,
and **data classification** — one of:

- **SOURCE** — raw imported evidence. Immutable once created. Never overwritten by inference.
- **DERIVED** — computed or AI-inferred. Mutable/re-derivable, but a new derivation does not
  silently overwrite a value the user has approved (see `docs/domain/invariants.md`).
- **APPROVED** — authoritative, user-approved financial fact. Changes are audited, never
  silently overwritten.
- **SYSTEM** — configuration, integration state, or audit/log data.

Some entities requested for consideration were deliberately **not** given their own table.
Each of those is called out explicitly, with the reasoning, in the section it would have
belonged to — see "Beneficiary" (folded into `Allocation`), "Classification" and
"Decision/Approval" (folded into `AIInference`), and "Settlement" (a derived view plus a
`Payment` classification, not a new ledger of money movement).

## Pipeline recap

```
PAYMENT → PURPOSE → EVIDENCE → EXPENSE → BENEFICIARIES → ALLOCATION → SETTLEMENT → RECONCILIATION
```

A `Payment` is what moved money. An `Expense` is what it was for. `Evidence` supports the
interpretation. `Allocation` divides an `Expense` among beneficiaries. Settlement and
reconciliation are derived, not separately entered.

---

## User

**Purpose.** The authenticated owner/operator of the system. Kept distinct from `Person`
because a `User` has credentials and settings, while a `Person` is a party in the financial
graph who may never log in (a flatmate, a friend). The system's own owner has both — one `User`
row and one `Person` row, linked — so that "money the user spent on themselves" and "money
someone who happens to also have a login spent" are never conflated by construction.

**Key fields.** `id`, `email`, `person_id` (the `Person` representing this user in the ledger),
`created_at`, auth/session fields (deferred to `docs/security/security-model.md`).

**Relationships.** 1:1 with a `Person`. Owns `Account`s, `ExternalIntegration`s.

**Lifecycle.** Created once at setup. Not versioned beyond normal profile edits.

**Invariants.** Exactly one `User` per deployment in the current single-user phase (see
`docs/architecture/system-architecture.md`); the schema does not hard-code this, so
multi-user is not precluded later.

**Classification.** SYSTEM.

---

## Account

**Purpose.** A financial account money moves through: a bank account, a UPI-linked account, a
credit/debit card, or a cash "wallet." Needed so payments can be grouped by source, balances
reconciled, and internal transfers between the user's own accounts recognized as non-expense.

**Key fields.** `id`, `owner_user_id`, `name`, `type` (`bank | upi | card | cash | wallet`),
`institution` (free text, e.g. "HDFC"), `last4` (optional, redacted identifier — never a full
account/card number), `currency`, `is_active`.

**Relationships.** Has many `Payment`s (as the account the payment moved through). Referenced
by `Payment.account_id`.

**Lifecycle.** Created manually by the user when they start importing evidence for it.
Deactivated, not deleted, when closed — historical payments must remain attached.

**Invariants.** No full account/card number is ever stored (`security-model.md`). A payment's
`account_id` must reference an account owned by the user importing it.

**Classification.** SYSTEM (user-maintained configuration).

---

## Person

**Purpose.** An individual party in the financial graph: the user themselves, a flatmate, a
friend, a family member. Relationship labels (e.g. "flatmate") are data, not hard-coded types —
see `docs/domain/scenario-analysis.md` §23 for why.

**Key fields.** `id`, `display_name`, `linked_user_id` (nullable — set if this person also has
a `User` login), `splitwise_user_id` (nullable, for sync), `notes`.

**Relationships.** Many-to-many with `Group` via `GroupMembership`. Referenced as a beneficiary
or counterparty from `AllocationLine` and `Payment`.

**Lifecycle.** Created the first time they're needed (as a beneficiary, or a payment
counterparty). Never hard-deleted if referenced by financial history — see
`docs/domain/invariants.md`.

**Invariants.** Exactly one `Person` represents the system's own `User`. A `Person` can be
referenced by historical allocations even after they stop being relevant (e.g. an ex-flatmate).

**Classification.** SYSTEM, with `linked_user_id`/`splitwise_user_id` as SYSTEM/integration
metadata.

---

## Group

**Purpose.** A named collection of people who share expenses together: a flat, a trip, a
recurring dinner group, an ad hoc friend group. Not a fixed taxonomy — the user creates groups
freely.

**Key fields.** `id`, `name`, `type` (free text label, e.g. "flat", "trip" — advisory, not
structurally special-cased), `created_at`, `archived_at`.

**Relationships.** Many-to-many with `Person` via `GroupMembership`. Referenced as a
beneficiary from `AllocationLine`; referenced as a default participant set from
`ExpenseOccasion`.

**Lifecycle.** Created by the user. Archived (not deleted) when no longer active (e.g. a trip
group after the trip, though its historical allocations remain valid).

**Invariants.** A `Group`'s membership can and does change over time; historical allocations
must reflect membership _as of the expense date_, not current membership (see
`GroupMembership` below and `scenario-analysis.md` §23).

**Classification.** SYSTEM.

### GroupMembership (join entity)

**Purpose.** Models group membership as a fact with a time range, not a static link — required
because a person's relationship to a group changes (moves in, moves out) and historical
allocations must not silently change meaning when it does.

**Key fields.** `id`, `group_id`, `person_id`, `joined_at`, `left_at` (nullable — null means
currently active).

**Invariants.** `AllocationLine`s reference `Person`/`Group` directly (not
`GroupMembership`), so a past allocation is never invalidated by a later membership change;
`GroupMembership` is used only to drive _defaults and suggestions_ (e.g. "split with everyone
currently in the flat"), never to retroactively reinterpret history.

**Classification.** SYSTEM.

---

## Merchant

**Purpose.** A normalized counterparty for payments that go to a business rather than a
person: "Blinkit", "Zepto", "a specific restaurant." Bank/UPI descriptions are messy
(`BLINKIT9821PAYTM`); `Merchant` is the resolved, canonical form, with aliases tracked so
normalization improves over time without re-processing history.

**Key fields.** `id`, `canonical_name`, `default_category` (advisory, DERIVED), `aliases`
(list of raw strings/patterns seen in source evidence).

**Relationships.** Referenced from `Payment.counterparty` (see below) and `Receipt`.

**Lifecycle.** Created/matched during normalization, typically AI-assisted
(`normalizeMerchant`, see `docs/architecture/ai-boundary.md`), confirmed or corrected by the
user on review.

**Invariants.** Merchant resolution is a `DERIVED` proposal until a payment referencing it has
been through review at least once; it never blocks import (an unresolved raw string is a valid
temporary state).

**Classification.** DERIVED (resolution), SYSTEM (the canonical registry itself once
established).

---

## Payment

**Purpose.** What actually caused money to leave or enter an `Account`. This is the
"transaction" in the everyday sense — the thing the bank or UPI app recorded. A `Payment` is
_not_ assumed to equal one `Expense` or one `Receipt` (see invariants).

**Key fields.** `id`, `account_id`, `amount`, `currency`, `direction` (`debit | credit`),
`occurred_at`, `raw_description` (verbatim from source), `channel`
(`upi | bank_transfer | card | cash | other`), `counterparty_type`
(`merchant | person | internal_account | unknown`), `counterparty_id` (nullable, polymorphic
per `counterparty_type`), `import_batch_id`, `state` (see `docs/domain/lifecycle.md`).

**Relationships.** Belongs to one `Account` and one `ImportBatch`. Linked to zero or more
`Expense`s via `PaymentExpenseLink`. May have zero or more `Evidence` records attached directly
(e.g. a UPI notification screenshot for this exact payment, before any `Expense` exists).

**Lifecycle.** `IMPORTED → NORMALIZED → (LINKED | IGNORED)`. See `docs/domain/lifecycle.md`.
A payment is `IGNORED` when confirmed as a duplicate or as something outside the ledger's
concern (e.g. a same-bank internal transfer already represented by its paired payment).

**Invariants.**

- `Payment` amount is `SOURCE` data and is never edited after import; corrections happen by
  creating/adjusting `Expense`/`Allocation` records, or by marking the payment `IGNORED` with a
  reason, never by mutating `amount`, `occurred_at`, or `raw_description`.
- A `Payment` classified as an internal transfer (`counterparty_type = internal_account`) must
  never be linked to an `Expense` — transfers are not expenses (see `invariants.md`).
- A `Payment` may be linked to more than one `Expense` (e.g. a Blinkit basket with a personal
  item and a flat item); the sum of `PaymentExpenseLink.amount` for a payment must equal the
  payment's amount, or the remainder is explicitly tracked as unexplained (see
  `ReconciliationRun`), never silently dropped.

**Classification.** SOURCE for the immutable fields (`amount`, `occurred_at`,
`raw_description`, `account_id`); `state`, `counterparty resolution`, and `import_batch_id`
are SYSTEM/DERIVED metadata layered on top.

---

## ImportBatch

**Purpose.** Groups the payments produced by a single import operation (one statement file,
one UPI export, one manual-entry session) for lineage, deduplication, and the ability to
answer "where did this row come from."

Absorbs what the brief calls "Transaction Source" — rather than a separate `TransactionSource`
entity, the _channel_ (UPI, bank, card, cash) lives as an attribute on `Payment`, and the
_specific import event_ (which file, when, by what parser version) lives here. This avoids two
overlapping entities for one concept.

**Key fields.** `id`, `source_channel`, `file_reference` (evidence storage key, nullable for
manual entry), `imported_at`, `parser_version`, `row_count`.

**Relationships.** Has many `Payment`s.

**Lifecycle.** Created once per import; immutable thereafter.

**Invariants.** Re-importing the same file must be detectable (e.g. content hash) so the same
payments are not duplicated across batches.

**Classification.** SOURCE (the file reference), SYSTEM (parser metadata).

---

## Evidence

**Purpose.** Any document or piece of information supporting the interpretation of a payment
or expense: a bank statement line (may itself be the primary evidence), a UPI notification, a
receipt image, a screenshot, an email receipt, or a manually typed explanation. Evidence is
support for a claim, not the claim itself — see `Receipt` for the structured interpretation of
receipt-type evidence.

**Key fields.** `id`, `type`
(`bank_line | upi_notification | receipt_image | screenshot | email_receipt | manual_note`),
`storage_ref` (nullable — manual notes have no file), `raw_text` (OCR/extracted text if
applicable), `captured_at`, `linked_payment_id` (nullable), `linked_expense_id` (nullable).

**Relationships.** Optionally linked to a `Payment` and/or `Expense`. A `Receipt` references
exactly one `Evidence` record (the document it was extracted from).

**Lifecycle.** Created on ingestion. Immutable. Superseding evidence (e.g. a clearer photo of
the same receipt) is a new `Evidence` row, not an edit.

**Invariants.** Never overwritten. Never deleted while referenced by an `Expense` or
`Allocation`, to preserve traceability. Files are stored outside the primary database (see
`docs/security/security-model.md`) with only a reference stored here.

**Classification.** SOURCE.

---

## Receipt

**Purpose.** The _structured interpretation_ of a piece of receipt-type `Evidence`: subtotal,
tax, total, line items. This is explicitly `DERIVED`, not `SOURCE` — even though a receipt
"is evidence" colloquially, the structured fields are typically produced by OCR/AI extraction
from the underlying image, and must carry confidence and be correctable without touching the
original `Evidence` file.

**Key fields.** `id`, `evidence_id`, `merchant_id` (nullable, DERIVED), `subtotal`, `tax`,
`total`, `currency`, `extraction_confidence`, `extracted_at`, `confirmed_by_user` (bool).

**Relationships.** Belongs to one `Evidence`. Has many `ReceiptItem`s. Optionally linked to a
`Payment` (the payment it substantiates) and to one or more `Expense`s.

**Lifecycle.** Created by AI extraction (`parseReceipt`/`extractReceiptItems`, see
`ai-boundary.md`) or manual entry when no receipt image exists but the user wants item-level
detail. Confirmed or corrected by the user; corrections update this record (it's DERIVED, not
SOURCE) but never touch the underlying `Evidence`.

**Invariants.** `Receipt.total` should reconcile with the linked `Payment.amount`; when it
doesn't, the difference is surfaced, not silently absorbed (see `scenario-analysis.md` §20).
A `Receipt` with no `Payment` link is valid (evidence can arrive before the matching payment is
found).

**Classification.** DERIVED.

---

## ReceiptItem

**Purpose.** A single line item on a receipt, enabling item-based allocation ("Milk → Flat,
Chicken → Dev, Shampoo → Person A").

**Key fields.** `id`, `receipt_id`, `description`, `quantity`, `unit_price`, `line_total`,
`suggested_category` (DERIVED, optional).

**Relationships.** Belongs to one `Receipt`. Optionally linked to an `ExpenseItem` when the
expense is broken down for item-based allocation.

**Lifecycle.** Created alongside `Receipt` extraction. Corrected by the user like any other
DERIVED field.

**Invariants.** Sum of `line_total` across a receipt's items should reconcile with
`Receipt.subtotal`; discrepancies are surfaced, not hidden.

**Classification.** DERIVED.

---

## Expense

**Purpose.** What the money was actually spent on — the central object beneficiaries and
allocations attach to. Deliberately decoupled from `Payment` (see invariants) and from
`Receipt` (an expense can exist with no receipt at all).

**Key fields.** `id`, `description`, `amount`, `currency`, `occurred_at`, `relationship_type`
(`personal | shared | paid_on_behalf | gift | reimbursement | settlement |
household_shared_flat` — see `invariants.md` for why this is an open enum, not a boolean),
`category` (DERIVED/advisory), `occasion_id` (nullable), `state` (see `lifecycle.md`).

**Relationships.** Linked to one or more `Payment`s via `PaymentExpenseLink`. Optionally linked
to a `Receipt`. Has one `Allocation` once beneficiaries are decided. Optionally belongs to one
`ExpenseOccasion`. Has many `ExpenseItem`s when broken down at item level.

**Lifecycle.** `PROPOSED → CLASSIFIED → REVIEW_REQUIRED → APPROVED → ALLOCATED →
READY_TO_SYNC → SYNCED → RECONCILED`, adapted from the brief's states — see
`docs/domain/lifecycle.md` for the full adapted state machine and why some states apply to
`Expense` rather than `Payment`.

**Invariants.**

- `relationship_type = personal` still requires an `Allocation` (trivially, 100% to the user)
  so downstream settlement/reconciliation code never special-cases "no allocation."
- An `Expense` cannot reach `APPROVED` without at least one `PaymentExpenseLink`, _unless_ it
  is explicitly marked as awaiting a payment match (evidence-first flow) — see
  `scenario-analysis.md` §4, §6, §7.
- Once `APPROVED`, changing `relationship_type`, `amount`, or allocation requires a new,
  audited decision (`AuditEvent`), never a silent overwrite (`scenario-analysis.md` §24).

**Classification.** DERIVED until `APPROVED`; APPROVED thereafter.

---

## ExpenseItem

**Purpose.** The allocateable unit within an `Expense` used for item-based or quantity-based
allocation. Distinct from `ReceiptItem`: a `ReceiptItem` is what the evidence says was bought;
an `ExpenseItem` is what allocation actually runs against, and the two are not always 1:1 (the
user may merge/split items, or define items manually when no receipt exists at all).

**Key fields.** `id`, `expense_id`, `description`, `amount`, `quantity`, `receipt_item_id`
(nullable — set when derived from a receipt line).

**Relationships.** Belongs to one `Expense`. Optionally sourced from one `ReceiptItem`.
Referenced by `AllocationLine` when the allocation method is item-based.

**Lifecycle.** Created when an expense is broken down below the whole-expense level. Not
required for `equal`/`exact`/`percentage` allocation of a whole expense.

**Invariants.** Sum of `ExpenseItem.amount` for an expense must equal `Expense.amount`.

**Classification.** DERIVED (if receipt-sourced) or APPROVED (if manually defined by the
user as part of an approved allocation).

---

## PaymentExpenseLink (join entity)

**Purpose.** Explicitly represents the many-to-many relationship between `Payment` and
`Expense` — the mechanism by which "a single payment may correspond to multiple expenses" and,
symmetrically, an expense funded across more than one payment (e.g. a deposit + balance) are
both representable without special-casing either direction.

**Key fields.** `id`, `payment_id`, `expense_id`, `amount` (the portion of the payment
attributed to this expense).

**Invariants.** For a given `payment_id`, the sum of `amount` across its links must not exceed
`Payment.amount`; any shortfall is visible as unexplained rather than assumed to be a rounding
error.

**Classification.** APPROVED (created as part of approving an expense).

---

## Allocation

**Purpose.** How an `Expense` (or its `ExpenseItem`s) is divided among beneficiaries. This is
the entity that replaces a boolean `is_shared` flag — see `invariants.md`.

**Key fields.** `id`, `expense_id`, `method`
(`equal | exact | percentage | item_based | quantity_based | custom`), `decided_at`,
`decided_by` (`ai_suggested_then_approved | manual`).

**Relationships.** Belongs to one `Expense`. Has one or more `AllocationLine`s.

**Lifecycle.** Created once an `Expense` reaches allocation. AI may propose an `Allocation` +
`AllocationLine`s as an `AIInference`; it becomes this authoritative record only on user
approval (or auto-approval under a matched `Rule` — still an approval, just automated).

**Invariants.** Sum of `AllocationLine.amount` must equal `Expense.amount` exactly (after
deterministic rounding — see `invariants.md`). Every `Expense` that reaches `APPROVED` has
exactly one current `Allocation`; corrections create a new `Allocation` version rather than
mutating lines in place, so history is preserved (`AuditEvent` records the supersession).

**Classification.** APPROVED.

### AllocationLine

**Purpose.** One beneficiary's share within an `Allocation`. This is where **"Beneficiary"**
lives: rather than a standalone `Beneficiary` table, each line carries a polymorphic
`beneficiary_type` (`person | group`) and `beneficiary_id`. A separate table would have added
an indirection with no behavior of its own — "beneficiary" is a role a `Person` or `Group`
plays on a given line, not a distinct thing with its own lifecycle.

**Key fields.** `id`, `allocation_id`, `beneficiary_type` (`person | group`),
`beneficiary_id`, `amount`, `percentage` (nullable, informational when method is `percentage`),
`expense_item_id` (nullable, set for item/quantity-based methods).

**Invariants.** `amount` is always populated and authoritative regardless of `method` — even a
`percentage`-method line stores the resolved amount, so settlement math never has to
re-derive percentages from floating point.

**Classification.** APPROVED.

---

## ExpenseOccasion

**Purpose.** An optional grouping of related expenses that happened together — "Friday
dinner" spanning a restaurant charge, dessert, and the cab home. Evaluated per the brief and
included because it removes real duplication: without it, the same participant set and
allocation defaults would need re-entering for every payment in the occasion.

**Key fields.** `id`, `name`, `occurred_on`, `default_participants` (list of `Person`/`Group`
references used only as _defaults_ for new expenses added to the occasion).

**Relationships.** Has many `Expense`s (via `Expense.occasion_id`).

**Lifecycle.** Created manually, or suggested by AI (`groupIntoOccasion`) grouping temporally-
and contextually-related payments, confirmed by the user.

**Invariants.** An `Occasion`'s `default_participants` never retroactively change an already-
approved `Expense.Allocation` — they are suggestion defaults for new/unallocated expenses only.

**Classification.** DERIVED until confirmed; APPROVED (as a grouping) thereafter. Individual
expenses within it retain their own classification independently.

---

## Settlement (derived, not a ledger of its own)

**Purpose.** "Who owes whom and how much." Deliberately **not** implemented as a table that
records money movement — that would duplicate `Payment`. Two things instead:

1. **Balance** (a read model / view, recomputed on demand): for each `Person`/`Group`, the net
   amount owed to or by the user, derived as
   `sum(AllocationLine.amount where beneficiary != user) − sum(SettlementPayments already made
to/from that beneficiary)`. Always re-derivable from `Allocation` + `Payment` history; never
   stored as an independently-editable number.
2. **A settlement is a `Payment`** classified with `Expense.relationship_type = settlement`
   (or, for a pure transfer with no expense involved, a `Payment` flagged
   `counterparty_type = person` and `is_settlement = true` directly) — an actual transfer of
   money that reduces a `Balance`. It is not a new kind of money movement; it is an existing
   `Payment`/`Expense` viewed through this lens. See `scenario-analysis.md` §15.

**Invariants.** A settlement payment must never simultaneously count as new spend in
reconciliation's "explained expense" bucket — it discharges a balance, it doesn't create one
(`invariants.md`).

**Classification.** DERIVED (`Balance` is always computed, never stored as fact).

---

## Reconciliation

### ReconciliationRun

**Purpose.** A recorded snapshot of a reconciliation check — "as of this run, here's what the
ledger says, here's what Splitwise says, here's the gap, here's what was done about it." Kept
as history (not just a live query) so past discrepancies and their resolutions are auditable.

**Key fields.** `id`, `run_at`, `period_start`, `period_end`, `ledger_total_outflow`,
`ledger_transfers_total`, `ledger_explained_total`, `ledger_unexplained_total`,
`splitwise_balances_snapshot` (JSON), `discrepancies` (JSON list), `resolved_at` (nullable).

**Relationships.** References the `SplitwiseExpense`s and `Balance`s current as of the run.

**Lifecycle.** Created on demand or on a schedule (LATER phase). Immutable once created; a
later run supersedes it, it doesn't edit it.

**Invariants.** `ledger_unexplained_total` is always
`ledger_total_outflow − ledger_transfers_total − ledger_explained_total`, computed by
application code, never by AI.

**Classification.** SYSTEM (derived report).

---

## AIInference

**Purpose.** A single, generic record type for every AI-produced proposal — transaction
classification, merchant normalization, receipt/item extraction, beneficiary suggestion,
allocation suggestion, occasion grouping, anomaly explanation, and rule proposals. This is
where **"Classification"** and **"Decision/Approval"** both live, folded in rather than given
separate tables:

- **Classification** is just `AIInference.inference_type = classify_transaction` — a
  standalone `Classification` entity would duplicate the confidence/audit/approval machinery
  every one of the eight AI operations in `docs/architecture/ai-boundary.md` already needs.
- **Decision/Approval** is the transition of `AIInference.status` from `pending` to
  `accepted | modified | rejected`, recorded with `decided_at`/`decided_by` and a pointer to
  the authoritative record it produced (an `Expense`, `Allocation`, `Merchant`, etc.). A fully
  manual entry (no AI involved) simply has no `AIInference` row at all — the authoritative
  record's own audit trail (`AuditEvent`) is what proves it was a decision either way.

**Key fields.** `id`, `inference_type`, `input_ref` (what it was run on — a `Payment`,
`Evidence`, etc.), `proposed_output` (JSON), `confidence` (`high | medium | low | unknown`),
`model_info` (model name/version), `created_at`, `status`
(`pending | accepted | modified | rejected | superseded`), `decided_at`, `decided_by`,
`resulting_record_type`, `resulting_record_id`.

**Relationships.** Polymorphically references whatever it was computed from and whatever
authoritative record (if any) it produced.

**Lifecycle.** `pending → (accepted | modified | rejected)`; a later re-run producing a new
proposal for the same input marks the old one `superseded`, it doesn't delete it.

**Invariants.** No authoritative (APPROVED) record's field is ever set from
`AIInference.proposed_output` without a corresponding `status` transition away from `pending`
performed by the user (or by a matched, previously-approved `Rule` — still an explicit,
attributable act). This is the single most load-bearing invariant in the system; see
`docs/architecture/ai-boundary.md`.

**Classification.** DERIVED (always — even once "accepted," the `AIInference` row itself
remains a record of a proposal; the authoritative state lives in the record it produced).

---

## Rule

**Purpose.** A user- or system-defined pattern that pre-empts repetitive review — "payments to
merchant X are always personal, high confidence" or "Blinkit orders on weekend evenings default
to a flat/me split." LATER-phase for implementation (`docs/roadmap.md` phase 16) but included
in the model now since it changes how `AIInference`/`Expense.state` transitions can be
triggered.

**Key fields.** `id`, `match_pattern` (structured matcher, e.g. merchant + amount range +
day-of-week), `proposed_classification` (template: relationship_type, category, default
allocation), `origin` (`manual | promoted_from_repeated_ai_suggestion`), `active`,
`created_at`, `times_applied`.

**Relationships.** Referenced by `AIInference.decided_by` when a rule, rather than a person,
produced the acceptance.

**Lifecycle.** Created manually, or proposed by AI (`proposeRule`) after observing a repeated
pattern and confirmed by the user before it can auto-apply.

**Invariants.** A `Rule` can raise an `AIInference`'s effective confidence or trigger
auto-acceptance, but never bypasses the requirement that _some_ explicit approval — the rule's
own creation — authorized the behavior. A rule applying incorrectly must be traceable back to
itself via `AIInference.decided_by`, so it can be fixed once rather than per transaction.

**Classification.** APPROVED (a rule is itself something the user has approved).

---

## AuditEvent

**Purpose.** A generic, append-only log of changes to important financial data — the mechanism
behind "approved financial decisions must not silently change" and "every important change
must be auditable."

**Key fields.** `id`, `entity_type`, `entity_id`, `action`
(`create | update | supersede | delete`), `old_value` (JSON, nullable), `new_value` (JSON),
`actor` (`user | rule:<rule_id> | system`), `source` (what triggered it), `reason`,
`ai_inference_id` (nullable — set when the change originated from an accepted inference),
`occurred_at`.

**Relationships.** Polymorphically references any APPROVED/DERIVED entity.

**Lifecycle.** Append-only. Never edited or deleted.

**Invariants.** Every mutation to an `APPROVED`-classified field, anywhere in the system,
writes exactly one `AuditEvent`. This is enforced at the service layer
(`docs/architecture/system-architecture.md`), not left to callers to remember.

**Classification.** SYSTEM.

---

## ExternalIntegration

**Purpose.** A configured connection to an external system. Generalized beyond Splitwise so a
future bank-aggregator or a different debt-tracking tool reuses the same shape.

**Key fields.** `id`, `type` (`splitwise | ...`), `owner_user_id`, `external_account_ref`,
`status` (`connected | disconnected | error`), `connected_at`, `last_synced_at`.
Credentials/tokens are never stored in this table in plaintext — see
`docs/security/security-model.md`.

**Relationships.** Has many `SplitwiseExpense` records (for the `splitwise` type).

**Classification.** SYSTEM.

---

## SplitwiseExpense

**Purpose.** The mapping between this system's `Expense`/`Allocation` and the corresponding
Splitwise expense object, plus a snapshot for drift detection.

**Key fields.** `id`, `expense_id`, `external_integration_id`, `splitwise_expense_id`,
`synced_at`, `our_snapshot` (JSON — our allocation as of sync time), `their_snapshot` (JSON —
Splitwise's data as last fetched), `sync_status`
(`pending | synced | drifted | sync_failed`).

**Relationships.** Belongs to one `Expense` and one `ExternalIntegration`.

**Lifecycle.** Created when an `Expense` reaches `READY_TO_SYNC` and the user confirms the
Splitwise proposal. Updated on each reconciliation check if Splitwise-side data has changed.

**Invariants.** Never created from an `Expense` that hasn't reached `APPROVED` allocation
first — see `ai-boundary.md` and `invariants.md`. A `drifted` status is surfaced, never
auto-resolved by trusting either side blindly.

**Classification.** SYSTEM (sync metadata); `our_snapshot` is effectively APPROVED data at the
time of snapshotting.

---

## Entity relationship summary

```
User ──1:1── Person
Account ──*── Payment ──*── PaymentExpenseLink ──*── Expense
Payment ──*── Evidence
Expense ──*── Evidence
Expense ──1── Receipt (optional)
Receipt ──*── ReceiptItem ──0:1── ExpenseItem
Expense ──*── ExpenseItem
Expense ──0:1── Allocation ──*── AllocationLine ──(Person | Group)
Expense ──0:1── ExpenseOccasion
Person ──*── GroupMembership ──*── Group
Payment/Expense ──*── AIInference (proposals)
Expense/Allocation/Merchant/... ──*── AuditEvent
Expense ──0:1── SplitwiseExpense ──*── ExternalIntegration
ReconciliationRun (references Balance + SplitwiseExpense state)
Rule ──*── AIInference (as decided_by)
```

See `docs/domain/scenario-analysis.md` for the 25 scenarios used to pressure-test this model
and what each one confirmed or changed, and `docs/domain/invariants.md` for the full,
consolidated invariant list.
