# Domain Model

This document defines the entities of the system. It is deliberately produced _before_ any
database schema or code, per `docs/roadmap.md` phase order — schema design
(`docs/architecture/database-design.md`) translates this model, not the other way around.

> **Revision note (2026-08).** This document was revised after a pre-implementation architecture
> review found several conceptual inconsistencies — most importantly, that the original model
> implicitly assumed the user always fronts the money, and that settlement/refund handling
> contradicted the allocation-sum invariant. See ADRs 0006–0011 in `docs/decisions/` for the
> reasoning behind each change, and `docs/domain/scenario-analysis.md`'s "Part 2" scenarios for
> worked examples. Nothing below is provisional — this is the current, authoritative model.
>
> **Further revision note (2026-08, implementation-readiness pass).** Four remaining open
> questions were resolved and are finalized, not provisional: the money-rounding algorithm
> (ADR-0012), the full-refund allocation shape (ADR-0013), non-user obligation observability
> (`ObligationEvidenceStatus`, ADR-0014), and the V1 inflow-reconciliation scope boundary
> (ADR-0015). This pass also corrected several stale `scenario-analysis.md` cross-references
> (`§35`/`§36` that should have read `§33`/`§34`) found during its consistency audit.

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
"Decision/Approval" (folded into `AIInference`), and "Settlement" (its own entity as of
ADR-0007, but still not a second way of representing money movement — see that section).

## Pipeline recap

```
PAYMENT → PURPOSE → EVIDENCE → EXPENSE → BENEFICIARIES → ALLOCATION → SETTLEMENT → RECONCILIATION
```

A `Payment` is what moved money. An `Expense` is what it was for. `Evidence` supports the
interpretation. `Allocation` divides an `Expense` among beneficiaries. Settlement and
reconciliation are derived/event-based, not separately entered as new spend.

**Two categories of financial event, not one.** Everything in this model is either a **spend
event** (an `Expense` — something that was for something, requires an `Allocation`, has
beneficiaries) or an **adjustment/discharge event** (a `Settlement`, or an `ExpenseAdjustment` —
something that changes the net picture of an existing spend event or existing obligation,
without itself being new consumption). Confusing the two was the root cause of most of the
findings this revision fixes. Concretely:

| It is...                                                          | ...if it                                                                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A new `Expense` (needs `Allocation`)                              | Represents something bought/paid for, with beneficiaries who benefited                                                                         |
| A `Settlement` (references a `Payment` + a counterparty `Person`) | Discharges an **existing** obligation created by a prior `Expense`'s `Allocation`                                                              |
| An `ExpenseAdjustment` (references an existing `Expense`)         | Returns money against an **existing** `Expense`, from the same counterparty (`merchant_refund`) or a third party (`third_party_reimbursement`) |

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
`account_id` must reference an account owned by the user importing it. **This is why `Payment`
alone cannot represent money someone else spent** — see `Expense.paid_by_person_id` below and
ADR-0006 for how that case is represented instead.

**Classification.** SYSTEM (user-maintained configuration).

---

## Person

**Purpose.** An individual party in the financial graph: the user themselves, a flatmate, a
friend, a family member. Relationship labels (e.g. "flatmate") are data, not hard-coded types —
see `docs/domain/scenario-analysis.md` §23 for why.

**Key fields.** `id`, `display_name`, `linked_user_id` (nullable — set if this person also has
a `User` login), `splitwise_user_id` (nullable, for sync), `notes`.

**Relationships.** Many-to-many with `Group` via `GroupMembership`. Referenced as a beneficiary
or counterparty from `AllocationLine`, `Payment`, `Expense.paid_by_person_id`, and `Settlement`.

**Lifecycle.** Created the first time they're needed (as a beneficiary, a payer, or a payment
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
freely. **A `Group` is a data-entry convenience, never itself a debtor or creditor** — see
`AllocationLineGroupExpansion` below and ADR-0009 for how a group beneficiary line always
resolves down to individual people before it means anything financially.

**Key fields.** `id`, `name`, `type` (free text label, e.g. "flat", "trip" — advisory, not
structurally special-cased), `created_at`, `archived_at`.

**Relationships.** Many-to-many with `Person` via `GroupMembership`. Referenced as a
beneficiary from `AllocationLine`; referenced as a default participant set from
`ExpenseOccasion`.

**Lifecycle.** Created by the user. Archived (not deleted) when no longer active (e.g. a trip
group after the trip, though its historical allocations remain valid).

**Invariants.** A `Group`'s membership can and does change over time; historical allocations
must reflect membership _as of the expense date_, not current membership (see
`GroupMembership` below and `scenario-analysis.md` §23, §33).

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
currently in the flat") and to resolve a group-beneficiary line's one-time member expansion at
allocation-approval time (`AllocationLineGroupExpansion`) — never to retroactively reinterpret
history.

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
_not_ assumed to equal one `Expense` or one `Receipt` (see invariants). A `Payment` always moves
through an `Account` the user owns — it can never, by itself, represent money someone else
spent (see `Expense.paid_by_person_id` and ADR-0006 for how that case is represented).

**Key fields.** `id`, `account_id`, `amount`, `currency`, `direction` (`debit | credit`),
`occurred_at`, `raw_description` (verbatim from source), `channel`
(`upi | bank_transfer | card | cash | other`), `counterparty_type`
(`merchant | person | internal_account | investment_instrument | unknown` — `investment_instrument`
added per ADR-0011), `counterparty_id` (nullable, polymorphic per `counterparty_type`),
`external_reference` (nullable — UTR/RRN/bank reference/merchant order ID; added per ADR-0010),
`reference_type` (nullable, see ADR-0010), `source_system` (nullable, the originating
app/institution — see ADR-0010), `import_batch_id`, `state` (see `docs/domain/lifecycle.md`).

**Relationships.** Belongs to one `Account` and one `ImportBatch`. Linked to zero or more
`Expense`s via `PaymentExpenseLink`, and/or to zero or more `Settlement`s (a payment is one or
the other in the overwhelming common case, but the schema doesn't forbid a single payment being
split between the two — see `PaymentExpenseLink` invariants). May have zero or more `Evidence`
records attached directly (e.g. a UPI notification screenshot for this exact payment, before any
`Expense` exists). May be referenced by an `ExpenseAdjustment.adjustment_payment_id` if it's a
refund/reimbursement credit.

**Lifecycle.** `IMPORTED → NORMALIZED → (LINKED | IGNORED)`. See `docs/domain/lifecycle.md`.
`LINKED` now means "explained" in general — attached to at least one `Expense`
(`PaymentExpenseLink`) and/or `Settlement` — not "linked to an Expense" specifically (revised
per ADR-0007). A payment is `IGNORED` when confirmed as a duplicate or as something outside the
ledger's concern (e.g. a same-bank internal transfer already represented by its paired payment).
A payment whose `counterparty_type` is `internal_account` or `investment_instrument` is excluded
from spend by that classification alone and is not required to ever reach `LINKED` or `IGNORED` —
staying at `NORMALIZED` is a valid terminal state for both (clarified per ADR-0011; this was
ambiguous for transfers even before this revision).

**Invariants.**

- `Payment` amount is `SOURCE` data and is never edited after import; corrections happen by
  creating/adjusting `Expense`/`Allocation`/`Settlement` records, or by marking the payment
  `IGNORED` with a reason, never by mutating `amount`, `occurred_at`, or `raw_description`.
- A `Payment` classified as an internal transfer (`counterparty_type = internal_account`) or as
  an investment (`counterparty_type = investment_instrument`) must never be linked to an
  `Expense` — neither is spending (see `invariants.md`).
- A `Payment` may be linked to more than one `Expense` (e.g. a Blinkit basket with a personal
  item and a flat item); the sum of `PaymentExpenseLink.amount` **plus** `Settlement.amount` for
  a payment must not exceed the payment's amount, and any remainder is explicitly tracked as
  unexplained (see `ReconciliationRun`), never silently dropped.

**Classification.** SOURCE for the immutable fields (`amount`, `occurred_at`,
`raw_description`, `account_id`); `state`, `counterparty resolution`, `external_reference`
resolution, and `import_batch_id` are SYSTEM/DERIVED metadata layered on top.

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
exactly one `Evidence` record (the document it was extracted from) — see `Receipt` below for how
Payment/Expense linkage actually flows for receipts, since it is not a direct FK on `Receipt`
itself.

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

**Relationships.** Belongs to one `Evidence`. Has many `ReceiptItem`s. **`Receipt` has no
`payment_id` or `expense_id` column of its own** (clarified in this revision — the original text
here was ambiguous enough to read as if it did, which does not match `database-design.md`).
Its Payment/Expense linkage is always indirect:

- The single-payment / single-expense case goes through its `Evidence` row:
  `evidence.linked_payment_id` / `evidence.linked_expense_id`.
- The "one receipt, split across several expenses" case (e.g. one Blinkit basket containing a
  personal item and a flat item, scenario #1) goes through item-level linkage —
  `ReceiptItem → ExpenseItem → Expense` — not through the `Receipt` row itself. A `Receipt` is
  never directly linked to "one or more Expenses" as a first-class relationship; that plurality
  only exists at the item level.

**Lifecycle.** Created by AI extraction (`parseReceipt`/`extractReceiptItems`, see
`ai-boundary.md`) or manual entry when no receipt image exists but the user wants item-level
detail. Confirmed or corrected by the user; corrections update this record (it's DERIVED, not
SOURCE) but never touch the underlying `Evidence`.

**Invariants.** `Receipt.total` should reconcile with the `Payment.amount` reachable via its
`Evidence.linked_payment_id`, when that link exists; when it doesn't, the difference is
surfaced, not silently absorbed (see `scenario-analysis.md` §20).
A `Receipt` with no reachable `Payment` link is valid (evidence can arrive before the matching
payment is found).

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
`Receipt` (an expense can exist with no receipt at all). An `Expense` always represents a
**spend event** — something bought/paid for with beneficiaries — never a settlement or an
adjustment; see the "two categories of financial event" table at the top of this document.

**Key fields.** `id`, `description`, `amount` (gross, historical, **never changed after
`APPROVED`** — see `ExpenseAdjustment` below and ADR-0008), `currency`, `occurred_at`,
`relationship_type` (`personal | shared | paid_on_behalf | gift | household_shared_flat` — see
`invariants.md` for why this is an open enum, not a boolean; `settlement` and `reimbursement`
were removed from this enum per ADR-0007 and ADR-0008 respectively — see "Where settlement and
reimbursement went" below), `category` (DERIVED/advisory), `occasion_id` (nullable), `state`
(see `lifecycle.md`), **`paid_by_person_id`** (references `Person` — who actually fronted the
money for this expense; not necessarily the user — added per ADR-0006).

**Where settlement and reimbursement went.** `relationship_type` used to include `settlement`
and `reimbursement`. Neither survived the 2026-08 revision as a way of classifying a _new_
expense:

- A settlement isn't a new expense at all — it's the discharge of an obligation an earlier
  expense already created. It's now the `Settlement` entity (below), tied to a `Payment`, never
  an `Expense`. See ADR-0007.
- A reimbursement (like a refund) isn't a new expense either — it's money coming back against
  an expense that already exists and was already classified as whatever it actually was. It's
  now `ExpenseAdjustment.kind = third_party_reimbursement` (below). See ADR-0008.

**`paid_by_person_id`, explained.** For the common case — the user personally paid — this is the
`Person` row representing the system's own `User`, and the expense is normally linked to a
`Payment` via `PaymentExpenseLink`. For an **externally-funded expense** — someone else fronted
the money (a flatmate paid the electrician; a friend covered a restaurant bill) —
`paid_by_person_id` is that other person's `Person` row, and by construction this expense will
**never** have a `PaymentExpenseLink`, because no money moved through an `Account` the user owns.
This is not a transitional "waiting for a payment match" state — it is a permanent, valid
category. See ADR-0006 and `scenario-analysis.md` §26, §27, §34.

**Relationships.** Linked to one or more `Payment`s via `PaymentExpenseLink` (only when
`paid_by_person_id` is the user — see above). Optionally linked to a `Receipt`. Has one
`Allocation` once beneficiaries are decided. Optionally belongs to one `ExpenseOccasion`. Has
many `ExpenseItem`s when broken down at item level. May have zero or more `ExpenseAdjustment`s
referencing it (`ExpenseAdjustment.original_expense_id`).

**Lifecycle.** `PROPOSED → CLASSIFIED → REVIEW_REQUIRED → APPROVED → ALLOCATED →
READY_TO_SYNC → SYNCED → RECONCILED`, adapted from the brief's states — see
`docs/domain/lifecycle.md` for the full adapted state machine and why some states apply to
`Expense` rather than `Payment`.

**Invariants.**

- `relationship_type = personal` still requires an `Allocation` (trivially, 100% to
  `paid_by_person_id`) so downstream settlement/reconciliation code never special-cases "no
  allocation."
- An `Expense` cannot reach `APPROVED` without at least one `PaymentExpenseLink`, _unless_ it
  is either explicitly marked as awaiting a payment match (evidence-first flow for a
  self-funded expense — see `scenario-analysis.md` §4, §6, §7), _or_ it is an
  **externally-funded** expense (`paid_by_person_id != ` the user's `Person`), which by design
  never gets a `PaymentExpenseLink` at all.
- Once `APPROVED`, `Expense.amount` **never changes**, ever — not even via the audited
  "new decision" mechanism that applies to `relationship_type`/`Allocation` (revised per
  ADR-0008; the original text here allowed amount changes, which conflicted with "refund
  preserves history"). A correction to how much something actually cost is a new
  `ExpenseAdjustment`, not a mutated `amount`. `relationship_type` and `Allocation` may still
  change via a new, audited decision (`AuditEvent`), never a silent overwrite
  (`scenario-analysis.md` §24).
- `domain.netAmount(expense) = expense.amount − sum(ExpenseAdjustment.amount where
original_expense_id = expense.id)`. Always derived, never stored. See invariant #11.

**Classification.** DERIVED until `APPROVED`; APPROVED thereafter. `amount` is APPROVED and
immutable from that point on; `netAmount` is always DERIVED, recomputed on read.

---

## ExpenseAdjustment

**Purpose.** Money that came back against an **existing** `Expense`, after the fact, without
changing the historical record of what that expense originally cost. Added per ADR-0008,
replacing the original `refund_of_expense_id` self-reference (which created a second `Expense`
for every refund and left the allocation-sum arithmetic ambiguous — see the ADR for the full
reasoning). Covers both cases the review found underspecified: a merchant refund, and a
third-party reimbursement (the case `reimbursement` used to try, and fail, to represent as an
`Expense.relationship_type`).

**Key fields.** `id`, `original_expense_id` (the `Expense` being adjusted — never mutated),
`kind` (`merchant_refund | third_party_reimbursement`), `amount` (the portion of the original
expense's cost being returned), `adjustment_payment_id` (nullable — the credit `Payment`
documenting the money coming back; nullable because evidence-first is valid here too, exactly as
for a normal `Expense`), `reason` (free text), `occurred_at`.

**Relationships.** Belongs to one `Expense` (`original_expense_id`). Optionally references one
`Payment` (`adjustment_payment_id`).

**Lifecycle.** Created when a refund/reimbursement is recorded (manually, or as an `AIInference`
proposal off a credit `Payment` that looks like it matches a prior expense — still gated by the
normal approval path). Once created, it is **pending distribution** until the original expense's
`Allocation` is re-versioned (a new `Allocation`, superseding the old one per invariant #6) to
sum to the new `netAmount` — the adjustment existing and the adjustment being reflected in the
current allocation are two separate, both-visible steps, not one atomic action, so a
recorded-but-not-yet-distributed adjustment is never silently invisible.

**Invariants.** `sum(ExpenseAdjustment.amount for one original_expense_id) ≤` that expense's
gross `amount` — an expense cannot be refunded/reimbursed for more than it cost. The current
`Allocation` on the original expense sums to `netAmount(expense)`, not gross `amount` (invariant
#11, revised). `amount` is always a positive magnitude — there is no signed/negative
`ExpenseAdjustment`; see "Negative adjustments, resolved" below.

**Classification.** APPROVED once distributed into a superseding `Allocation`; DERIVED
(recorded, pending distribution) before that.

**Full refunds, resolved (finalized this revision — see invariants.md #12a for the full
mechanical rule).** When distribution reduces `netAmount(expense)` all the way to 0, the
superseding `Allocation` is **not** an empty `lines: []` set, and is **not** collapsed to a
single line for whoever happens to be the payer. It is the direct, deterministic output of
applying the same Largest Remainder Method used everywhere else in this system (invariant #12)
with a total of 0 against the existing beneficiary set: every original beneficiary keeps their
own `AllocationLine`, each at `amount = 0`. Concretely, for a personal expense with one
beneficiary, that's one line at 0; for a group dinner split three ways, that's three lines, each
at 0 — the same three people who originally benefited, still visibly present in the current,
authoritative allocation, at zero cost rather than absent. This means a full refund never makes
the system "forget" **what was purchased** (`Expense.description`/`amount`, untouched, gross,
forever), **the original amount** (`Expense.amount = <original>`, immutable), **who originally
benefited** (present in both the superseded `Allocation` version _and_ the current one, at 0),
or **how it was originally allocated** (the superseded `Allocation` version's `method` and
per-line amounts are kept, never deleted — `Allocation` versions are append-only per invariant
#6). `netAmount(expense) = 0` and "no current spend" are visible at the derived-figure level
only; nothing about the historical or current allocation structure is erased to represent it.

**Splitwise implications of a net-zero adjustment.** If the original `Expense` had already
reached `SYNCED` (a `SplitwiseExpense` exists) before the adjustment that brings `netAmount` to
0, the sync-status transition is still `stale`, exactly as any other post-sync adjustment
(`lifecycle.md`) — **but** the fresh sync proposal `stale` implies is a **deletion** of the
Splitwise expense, not a $0-amount update. Splitwise has no first-class concept of a zero-value
expense, and pushing one would misrepresent the group's ledger there; the correct action once a
human confirms the fresh proposal is `integrations/splitwise` issuing a delete against
`splitwise_expense_id`, then marking the local `SplitwiseExpense` row accordingly (its own
terminal state — implementation detail for Phase 14, but the _policy_ — delete, don't zero-out —
is decided here, not left open). A **partial** adjustment (netAmount > 0 but reduced) is the
ordinary `stale` → re-sync-with-new-amount path already described for §30.

**Analytics implications.** A net-zero expense is excluded from `ledger_explained_total`'s
_current_ contribution (its `netAmount` is 0, contributing exactly 0 — not omitted, just
correctly zero), but remains fully visible in historical/audit views: "you bought this for
`amount`, and it was fully refunded/reimbursed on `<adjustment.occurred_at>`" is answerable by
querying `Expense` + its `ExpenseAdjustment`s directly, and should be surfaced as its own
analytics category (e.g. "fully refunded purchases this period") rather than silently
disappearing once `netAmount` reaches 0 — a purchase-then-full-refund pattern (e.g. serial
returns) is itself a signal worth being able to see, not just a net-zero non-event.

**Negative adjustments, resolved.** There is no negative-amount `ExpenseAdjustment`. A merchant
clawing back a previous refund, or billing more for something already `APPROVED`, is new spend
against the same purchase and is recorded as a **new `Expense`** (optionally cross-referenced via
`Evidence`/`reason` text or the same `ExpenseOccasion`), never as a signed adjustment — see
invariants.md #12a for why this was evaluated and rejected as a design.

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

**Invariants.** Sum of `ExpenseItem.amount` for an expense must equal `Expense.amount` (gross —
`ExpenseItem`s represent the original purchase's composition and are unaffected by later
adjustments, same as `Expense.amount` itself).

**Classification.** DERIVED (if receipt-sourced) or APPROVED (if manually defined by the
user as part of an approved allocation).

---

## PaymentExpenseLink (join entity)

**Purpose.** Explicitly represents the many-to-many relationship between `Payment` and
`Expense` — the mechanism by which "a single payment may correspond to multiple expenses" and,
symmetrically, an expense funded across more than one payment (e.g. a deposit + balance) are
both representable without special-casing either direction. Only ever created for a **self-funded**
expense (`Expense.paid_by_person_id` = the user) — an externally-funded expense never has one, by
design (ADR-0006).

**Key fields.** `id`, `payment_id`, `expense_id`, `amount` (the portion of the payment
attributed to this expense).

**Invariants.** For a given `payment_id`, the sum of `amount` across its `PaymentExpenseLink`s
**plus** the sum of `amount` across any `Settlement`s on the same payment must not exceed
`Payment.amount`; any shortfall is visible as unexplained rather than assumed to be a rounding
error (revised per ADR-0007 to account for `Settlement` sharing the same payment).

**Classification.** APPROVED (created as part of approving an expense).

---

## Allocation

**Purpose.** How an `Expense` (or its `ExpenseItem`s) is divided among beneficiaries. This is
the entity that replaces a boolean `is_shared` flag — see `invariants.md`. `Allocation` only
ever exists for an `Expense` (a spend event) — `Settlement` never has one (ADR-0007).

**Key fields.** `id`, `expense_id`, `method`
(`equal | exact | percentage | item_based | quantity_based | custom`), `decided_at`,
`decided_by` (`ai_suggested_then_approved | manual`).

**Relationships.** Belongs to one `Expense`. Has one or more `AllocationLine`s.

**Lifecycle.** Created once an `Expense` reaches allocation. AI may propose an `Allocation` +
`AllocationLine`s as an `AIInference`; it becomes this authoritative record only on user
approval (or auto-approval under a matched `Rule` — still an approval, just automated). A new
`Allocation` version supersedes the previous one whenever `relationship_type` is corrected
(§24) or an `ExpenseAdjustment` is distributed (ADR-0008) — never an in-place edit.

**Invariants.** Sum of `AllocationLine.amount` must equal `domain.netAmount(Expense)` exactly —
computed by the Largest Remainder Method, `invariants.md` #12, never by floating-point division
(**revised** from "`Expense.amount`" per ADR-0008, since `Expense.amount` is now immutable gross
history and adjustments change the net figure the current allocation must sum to, not the gross
one). Every `Expense` that reaches `APPROVED` has exactly one current `Allocation`; corrections
create a new `Allocation` version rather than mutating lines in place, so history is preserved
(`AuditEvent` records the supersession). A line whose `beneficiary_id = Expense.paid_by_person_id`
represents that person's own share (no obligation created); every other line represents an
obligation owed **to `paid_by_person_id`**, not necessarily to the user (see `Allocation →
Obligation` below and ADR-0006). When `netAmount(Expense) = 0` (a fully refunded/reimbursed
expense), the current `Allocation` still has one line per original beneficiary, each at `amount =
0` — never an empty line set — see `ExpenseAdjustment`'s "Full refunds, resolved" above and
invariant #12a.

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
re-derive percentages from floating point. `amount >= 0` (not `> 0` — a zero-amount line is
valid and expected on a fully refunded/reimbursed expense's current allocation; see
`ExpenseAdjustment`'s "Full refunds, resolved" and `invariants.md` #12a). For `equal`/
`percentage` methods, `amount` is computed by the Largest Remainder Method (`invariants.md`
#12); for `item_based`/`quantity_based` methods, `amount` is copied directly from the
referenced `ExpenseItem.amount` and the Largest Remainder Method is not invoked at all — there
is no total being divided, only exact parts being assembled. **A `group`-typed line must have a
corresponding, fully-distributed `AllocationLineGroupExpansion`** before the parent `Expense`
can be considered `ALLOCATED` — see below and ADR-0009.

**Classification.** APPROVED.

### AllocationLineGroupExpansion

**Purpose.** The per-member resolution of a `group`-typed `AllocationLine`, so that a `Group`
(which cannot itself send or receive money, and which Splitwise has no concept of as a debtor)
never has to be treated as a beneficiary for obligation/settlement/sync purposes. Added per
ADR-0009.

**Key fields.** `id`, `allocation_line_id` (the group line being expanded), `person_id` (a
resolved member), `amount` (that member's individual share).

**Relationships.** Belongs to one `AllocationLine` (which must have `beneficiary_type =
group`).

**Lifecycle.** Written exactly once, at the moment the parent `AllocationLine` is approved
(`services.approveAllocation()`), by resolving `GroupMembership` rows active **as of
`Expense.occurred_at`** — not "today." Default: equal split across resolved members; the user
may override individual shares at the same approval step, still recorded as a one-time
snapshot either way. **Never recomputed.** A later change to `GroupMembership` (a flatmate
moving out) has zero effect on any row already written — see `scenario-analysis.md` §33.

**Invariants.** `sum(amount) for one allocation_line_id` equals that `AllocationLine`'s own
`amount`, computed by the same Largest Remainder Method (`invariants.md` #12; equal split unless
the user overrides, tie-broken by `person_id` ascending). `amount >= 0` per line — see
invariant #12a. `domain.computeBalance()` and `services.proposeSplitwiseSync()` always read this
table for a group-typed line, never the raw `AllocationLine.beneficiary_id` — a `Group` never
appears as a debtor/creditor in `Balance` output or in a Splitwise API call.

**Classification.** APPROVED.

---

## ExpenseOccasion

**Purpose.** An optional grouping of related expenses that happened together — "Friday
dinner" spanning a restaurant charge, dessert, and the cab home. Evaluated per the brief and
included because it removes real duplication: without it, the same participant set and
allocation defaults would need re-entering for every payment in the occasion.

**Key fields.** `id`, `name`, `occurred_start`, `occurred_end` (nullable — a trip spans a date
range, a single dinner doesn't need one; see `scenario-analysis.md` §10), `default_participants`
(list of `Person`/`Group` references used only as _defaults_ for new expenses added to the
occasion).

**Relationships.** Has many `Expense`s (via `Expense.occasion_id`).

**Lifecycle.** Created manually, or suggested by AI (`groupIntoOccasion`) grouping temporally-
and contextually-related payments, confirmed by the user.

**Invariants.** An `Occasion`'s `default_participants` never retroactively change an already-
approved `Expense.Allocation` — they are suggestion defaults for new/unallocated expenses only.

**Classification.** DERIVED until confirmed; APPROVED (as a grouping) thereafter. Individual
expenses within it retain their own classification independently.

---

## Obligation, Balance, and Settlement

**Obligation (derived concept, no table).** Created whenever an `AllocationLine` on a
debt-creating `Expense` (`relationship_type ∈ {shared, paid_on_behalf, household_shared_flat}` —
**not** `personal` or `gift`, matching the original scenario-analysis finding that gifts must
never generate a debt) names a beneficiary other than `Expense.paid_by_person_id`. That
beneficiary owes `paid_by_person_id` the line's amount. For a `group`-typed line, this is read
through `AllocationLineGroupExpansion` (ADR-0009) — each resolved member who isn't
`paid_by_person_id` owes their individual share.

This is deliberately **not** user-centric. Any two `Person`s can have an obligation between them
(e.g. Flatmate B owing Flatmate A, from an expense Flatmate A fronted — `scenario-analysis.md`
§26, §34) — generalized per ADR-0006, because the original one-directional "vs. the user"
formula couldn't represent the reverse-payer case the product's own purpose statement requires.

**Balance(X, Y) — derived, pairwise, always recomputed, never stored:**

```
GrossObligation(X owes Y) =
  Σ AllocationLine.amount (or, for group lines, AllocationLineGroupExpansion.amount)
    for lines on Expenses where
      Expense.paid_by_person_id = Y
      AND Expense.relationship_type ∈ {shared, paid_on_behalf, household_shared_flat}
      AND the line's resolved beneficiary = X

NetBalance(X, Y) =
  GrossObligation(X owes Y) − GrossObligation(Y owes X)
  − Σ Settlement.amount where the linked Payment moved from X to Y
  + Σ Settlement.amount where the linked Payment moved from Y to X
```

If `NetBalance(X, Y) > 0`, X owes Y that amount, net of everything recorded so far. `personal`
and `gift` expenses never enter `GrossObligation` at all (not merely excluded after the fact —
they were never debt-creating `relationship_type`s to begin with, which is a stronger, simpler
guarantee than the original design's after-the-fact exclusion list). Neither do `Settlement`s or
`ExpenseAdjustment`s directly contribute new obligation — a `Settlement` only ever _reduces_
`NetBalance` via the subtraction/addition terms above, never appears on the `GrossObligation`
side.

**An observability boundary, not a modeling failure (finalized this revision).** `Payment` can
only be observed when it moves through an `Account` the user owns (see `Account` invariants) —
this is a fact about what data can physically reach this system, not a gap in how the data that
does arrive is modeled. `NetBalance(X, Y)` is fully computable, correctly, for **any** two
people from `AllocationLine`/`AllocationLineGroupExpansion` data alone — the obligation itself is
never unobservable. What can be unobservable is one specific thing: the _discharge_ half of the
formula, when neither party to a settling payment is the user. A settlement between two _other_
people (e.g. Flatmate C repaying Flatmate A directly, `scenario-analysis.md` §34) can never
produce a `Settlement` row in this ledger, because there is no `Payment` — and there must never
be a fabricated one (see `CLAUDE.md`'s financial safety rules: "do not invent fake `Payment`
records for unobserved transactions"). `Balance`, reconciliation, Splitwise reconciliation, and
settlement logic all continue to work correctly under this boundary, by construction, not by
special-casing it:

- **`Balance`** — `NetBalance(X, Y)` simply keeps returning the pre-discharge amount for as long
  as no `Settlement` row exists for that pair, which is the mathematically correct answer given
  what this ledger has actually observed. There is no code path in `computeBalance()` that
  assumes every real-world settlement is observable; it only ever sums what's actually in
  `AllocationLine`/`AllocationLineGroupExpansion`/`Settlement`, so an unobservable settlement
  simply leaves the formula's inputs unchanged — it does not throw, silently zero out, or
  require a fallback branch.
- **Reconciliation (`ReconciliationRun`)** — is entirely outflow/ledger-internal (invariant #20)
  and does not reference cross-person `Settlement` observability at all; unaffected by
  construction.
- **Splitwise reconciliation** — is exactly the intended mitigation path, not a workaround: if
  all parties share a Splitwise group, Splitwise's own balance for the pair reflects the
  settlement even though this ledger's `Settlement` table cannot. The next `ReconciliationRun`
  compares this ledger's `NetBalance(X, Y)` against Splitwise's reported balance for that pair
  and surfaces the gap as an ordinary `discrepancies` entry (invariant #18) — the exact same
  mechanism used for every other kind of drift, not a special case.
- **Settlement logic** — `services.recordSettlement()` simply never gets called for this pair,
  because there is no confirmable `Payment` to call it from. Nothing about the service's
  contract changes; it's an input that never arrives, not an input it mishandles.

**`ObligationEvidenceStatus` — the UI-observable answer to "is this actually settled?" (derived,
no new table).** So that the product can show **"expected obligation exists, but no settlement
evidence is available"** rather than silently displaying a stale-looking number, `NetBalance(X,
Y) > 0` is annotated, at query time, with one of three derived statuses — computed entirely from
data already in this model, no fabricated `Payment`/`Settlement` involved:

- **`open, unconfirmed`** — `NetBalance(X, Y) > 0`, no `Settlement` row covers it (by
  definition, or it wouldn't still be positive), and no other evidence exists either. The
  default, most common state.
- **`believed_settled, unconfirmed_by_ledger`** — `NetBalance(X, Y) > 0`, but a manual `Evidence`
  row (`type = manual_note`) referencing one of the contributing `Expense`s (via
  `Evidence.linked_expense_id`) was recorded claiming the debt was cleared some other way, **or**
  the most recent `ReconciliationRun.discrepancies` for this pair shows Splitwise reporting a
  lower or zero balance than this ledger does. Either signal is purely informational — neither
  one changes `NetBalance` itself, which keeps showing the ledger-derived figure until a human
  takes an explicit action (see below).
- **`settled, confirmed`** — `NetBalance(X, Y) = 0` (or the specific obligation's contributing
  lines are covered by a `Settlement`). Only reachable via an actual `Settlement` row backed by a
  real `Payment`.

Computing and displaying this status is a **query-time, read-only** concern (`services`/`api`,
not `domain` state) — it never writes anything, never mutates `NetBalance`, and is not itself an
`AIInference` or an authoritative record. A human who trusts the "believed settled" signal enough
to want the ledger to stop surfacing it must do so via an explicit, audited action (e.g.
confirming a `ReconciliationRun` discrepancy as resolved, per invariant #18) — never by the
status computation silently suppressing the discrepancy on its own. See
`scenario-analysis.md` §34 and `docs/roadmap.md`'s open questions for the Phase 13 (expense
ledger / balance display) implementation note this resolves.

## Settlement

**Purpose.** Discharges an existing `Obligation`. Not a kind of `Expense` — added as its own
entity per ADR-0007, replacing the original `relationship_type = settlement` /
`Payment.is_settlement` design, which was self-contradictory (it required an `Allocation` per
invariant #2 while the reference example had none, and risked double-counting against `Balance`
if it ever got one). A settlement is not new consumption — it doesn't answer "what was this
for," it answers "has an existing debt been paid."

**Key fields.** `id`, `payment_id` (the `Payment` that carried the money — always required;
direction, `debit`/`credit`, is read from the linked `Payment`, not stored redundantly),
`counterparty_person_id` (the other party in the obligation being discharged), `amount` (usually
the full linked payment's amount, but may be a portion — see `PaymentExpenseLink` invariants for
the shared "sum ≤ payment amount" pattern this reuses), `reason` (nullable, free text),
`recorded_at`.

**Relationships.** Belongs to exactly one `Payment`. References one `Person`
(`counterparty_person_id`).

**Lifecycle.** Created when a `Payment` is confirmed as a settlement — either manually, or from
an `AIInference` proposal (`ai.classifyTransaction`'s output now includes an optional
`proposedKind: 'expense' | 'settlement'` alongside its `relationship_type` proposal — see
`ai-boundary.md`) — still gated by the same `services.decideInference()` approval path as any
other classification, and always writing an `AuditEvent`, exactly like `Allocation` approval.

**Invariants.** Never contributes to `ReconciliationRun.ledger_explained_total` (new spend) —
gets its own bucket, `ledger_settlements_total` (invariant #9, revised). `Evidence` is optional
for a `Settlement`'s `Payment`, exactly as for any `Payment` — "a bank-transaction-only
settlement with no receipt" is not a special case, just the normal, common case.

**Classification.** APPROVED.

### SplitwiseSettlement

**Purpose.** The mapping between a `Settlement` and the corresponding record in Splitwise
(which has its own native "record a payment" concept, distinct from "record an expense").
Structurally parallel to `SplitwiseExpense`, kept as a separate table rather than a generalized
polymorphic one — see ADR-0007's "Alternatives considered" for why.

**Key fields.** `id`, `settlement_id`, `external_integration_id`, `splitwise_transaction_id`,
`synced_at`, `our_snapshot` (JSON), `their_snapshot` (JSON), `sync_status`
(`pending | synced | drifted | sync_failed`).

**Classification.** SYSTEM (sync metadata); `our_snapshot` is effectively APPROVED data at the
time of snapshotting.

---

## Reconciliation

### ReconciliationRun

**Purpose.** A recorded snapshot of a reconciliation check — "as of this run, here's what the
ledger says, here's what Splitwise says, here's the gap, here's what was done about it." Kept
as history (not just a live query) so past discrepancies and their resolutions are auditable.

**Key fields.** `id`, `run_at`, `period_start`, `period_end`, `ledger_total_outflow`,
`ledger_transfers_total`, `ledger_investments_total` (added per ADR-0011),
`ledger_settlements_total` (added per ADR-0007), `ledger_explained_total` (now sums
`domain.netAmount(expense)` per expense, not gross `Expense.amount` — see ADR-0008),
`ledger_unexplained_total`, `splitwise_balances_snapshot` (JSON), `discrepancies` (JSON list),
`resolved_at` (nullable).

**Relationships.** References the `SplitwiseExpense`s, `SplitwiseSettlement`s, and `Balance`s
current as of the run.

**Lifecycle.** Created on demand or on a schedule (LATER phase). Immutable once created; a
later run supersedes it, it doesn't edit it.

**Invariants.** `ledger_unexplained_total` is always `ledger_total_outflow −
ledger_transfers_total − ledger_investments_total − ledger_settlements_total −
ledger_explained_total`, computed by application code, never by AI (invariant #20, revised).

**V1 scope, explicit (finalized this revision — not an oversight, a decision).** This
reconciliation covers exactly: outflow (`ledger_total_outflow`, debit payments), expenses
(`ledger_explained_total`, net of adjustments), obligations (via `Balance`, referenced but not
itself a ledger total column), settlements (`ledger_settlements_total`), refunds/reimbursements
(folded into `ledger_explained_total` via `domain.netAmount`), transfers
(`ledger_transfers_total`), and investments (`ledger_investments_total`). **A general
income/inflow accounting system — categorizing and reconciling ordinary credits that aren't a
refund, a reimbursement, or a received settlement (salary deposits, ad hoc payments received,
interest credited, etc.) — is explicitly out of scope for V1.** This is a scope decision, not a
gap discovered late: see `docs/roadmap.md`'s "Inflow-side reconciliation" boundary for the
reasoning and for what a future phase would need to add.

**Why the schema doesn't block adding it later.** `payments.direction` already supports
`credit` — nothing about `Payment`, `Account`, or `ImportBatch` assumes outflow-only. A credit
`Payment` that is a refund/reimbursement is already fully modeled (`ExpenseAdjustment`); one that
is a received settlement is already fully modeled (`Settlement`). A credit `Payment` that is
neither — ordinary, untracked income — simply has no dedicated classification or reconciliation
bucket yet; it is not required to ever reach `LINKED` (mirroring how `internal_account`/
`investment_instrument` payments are allowed to stay at `NORMALIZED` indefinitely, invariant #7)
and is excluded from every current `ledger_*` total by construction (none of them read plain,
unclassified credits at all). Adding a future inflow phase means adding new columns/tables
(e.g. an `Income`-analogous classification and a `ledger_unexplained_inflow` total) and new
`domain`/`services` functions — it does not require restructuring `Payment`, `Account`, or
anything already built, since `direction = credit` was never treated as an error case anywhere
in this model.

**Classification.** SYSTEM (derived report).

---

## AIInference

**Purpose.** A single, generic record type for every AI-produced proposal — transaction
classification (now including the `expense`-vs-`settlement` kind, see `Settlement` above),
merchant normalization, receipt/item extraction, beneficiary suggestion, allocation suggestion,
occasion grouping, anomaly explanation, and rule proposals. This is where **"Classification"**
and **"Decision/Approval"** both live, folded in rather than given separate tables:

- **Classification** is just `AIInference.inference_type = classify_transaction` — a
  standalone `Classification` entity would duplicate the confidence/audit/approval machinery
  every AI operation in `docs/architecture/ai-boundary.md` already needs.
- **Decision/Approval** is the transition of `AIInference.status` from `pending` to
  `accepted | modified | rejected`, recorded with `decided_at`/`decided_by` and a pointer to
  the authoritative record it produced (an `Expense`, `Allocation`, `Settlement`, `Merchant`,
  etc.). A fully manual entry (no AI involved) simply has no `AIInference` row at all — the
  authoritative record's own audit trail (`AuditEvent`) is what proves it was a decision either
  way.

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

**Relationships.** Has many `SplitwiseExpense` and `SplitwiseSettlement` records (for the
`splitwise` type).

**Classification.** SYSTEM.

---

## SplitwiseExpense

**Purpose.** The mapping between this system's `Expense`/`Allocation` and the corresponding
Splitwise expense object, plus a snapshot for drift detection.

**Key fields.** `id`, `expense_id`, `external_integration_id`, `splitwise_expense_id`,
`synced_at`, `our_snapshot` (JSON — our allocation as of sync time), `their_snapshot` (JSON —
Splitwise's data as last fetched), `sync_status`
(`pending | synced | drifted | stale | sync_failed` — `stale` added in this revision, see
below).

**Relationships.** Belongs to one `Expense` and one `ExternalIntegration`.

**Lifecycle.** Created when an `Expense` reaches `READY_TO_SYNC` and the user confirms the
Splitwise proposal. Updated on each reconciliation check if Splitwise-side data has changed.
When the _original_ expense receives an `ExpenseAdjustment` after having already synced, the
existing `SplitwiseExpense` moves to `sync_status = stale` — distinct from `drifted`, which means
_Splitwise's_ side changed independently. `stale` means _our_ side changed and a fresh sync
proposal is owed: for a partial adjustment (`netAmount` still > 0) that proposal is an amount
update; for an adjustment that brings `netAmount` all the way to 0, the proposal is a
**deletion** of the Splitwise expense, not a $0-amount push — Splitwise has no first-class
zero-value expense concept (see `ExpenseAdjustment`'s "Splitwise implications of a net-zero
adjustment"). See `scenario-analysis.md` §30 (partial, still-synced case).

**Invariants.** Never created from an `Expense` that hasn't reached `APPROVED` allocation
first — see `ai-boundary.md` and `invariants.md`. A `drifted` or `stale` status is surfaced,
never auto-resolved by trusting either side blindly, and never re-synced without a fresh user
confirmation.

**Classification.** SYSTEM (sync metadata); `our_snapshot` is effectively APPROVED data at the
time of snapshotting.

---

## Entity relationship summary

```
User ──1:1── Person
Account ──*── Payment ──*── PaymentExpenseLink ──*── Expense
Payment ──*── Evidence
Payment ──0:1..*── Settlement ──1── Person (counterparty)
Payment ──0:1..*── ExpenseAdjustment.adjustment_payment_id
Expense ──*── Evidence
Expense ──1── Receipt (optional, via Evidence — not a direct FK)
Receipt ──*── ReceiptItem ──0:1── ExpenseItem
Expense ──*── ExpenseItem
Expense ──0:1── Allocation ──*── AllocationLine ──(Person | Group)
AllocationLine (group) ──*── AllocationLineGroupExpansion ──1── Person
Expense ──0:1── ExpenseOccasion
Expense ──*── ExpenseAdjustment (original_expense_id)
Expense.paid_by_person_id ──1── Person
Person ──*── GroupMembership ──*── Group
Payment/Expense ──*── AIInference (proposals)
Expense/Allocation/Settlement/Merchant/... ──*── AuditEvent
Expense ──0:1── SplitwiseExpense ──*── ExternalIntegration
Settlement ──0:1── SplitwiseSettlement ──*── ExternalIntegration
ReconciliationRun (references Balance + SplitwiseExpense + SplitwiseSettlement state)
Rule ──*── AIInference (as decided_by)
```

See `docs/domain/scenario-analysis.md` for the scenarios used to pressure-test this model
(1–25 from the original design, 26–35 added in the 2026-08 revision) and what each one
confirmed or changed, and `docs/domain/invariants.md` for the full, consolidated invariant
list.
