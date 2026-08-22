# 0034. Evidence linkage may be filled in once, and never rewritten

**Status:** Accepted

## Context

`Evidence` is SOURCE data and immutable: "superseding evidence (e.g. a clearer photo of the same
receipt) is a new `Evidence` row, not an edit" (`domain-model.md`, `invariants.md` #4). But
`evidence.linked_payment_id` and `evidence.linked_expense_id` are columns on that same immutable
row, and a receipt routinely arrives **before** the bank statement line it belongs to. If linkage
were as frozen as the rest of the row, a document photographed at the till could never be
attached to anything.

The repository had already answered half of this, in
`drizzle/security/immutable-table-grants.sql`:

```sql
REVOKE UPDATE, DELETE ON TABLE evidence FROM :"app_role";
-- `payments.state`/`ignored_reason` and `evidence` linkage are DERIVED metadata layered on
-- immutable SOURCE columns, so those specific columns are granted back explicitly.
GRANT UPDATE (linked_payment_id, linked_expense_id) ON TABLE evidence TO :"app_role";
```

So linkage is writable by design. What nothing said was **how many times**, and phase 10 is the
first phase with a code path that writes it.

## Decision

**`null → id` is allowed. `id → a different id` and `id → null` are refused.**
`domain.assertEvidenceLinkOnce` states it; `services.linkEvidence` calls it before the update;
`EvidenceSourceFields` deliberately does not include linkage, so the two rules do not overlap.

The reasoning is a distinction the grant does not make on its own: **the grant permits the write
because the link is derived, not because a recorded link may be changed.** A `null` link asserts
nothing, so filling it in overwrites nothing. A set link is an assertion a human made, and:

- **A `Receipt` reaches its payment and expense through exactly these two columns.** `receipts`
  has no `payment_id` or `expense_id` of its own (`database-design.md`, ADR clarified in the
  2026-08 revision). Re-pointing the link silently relocates every interpretation extracted from
  that document onto a different transaction; clearing it orphans them.
- **A correction to a decision is a new decision** (`invariants.md`, "approved financial
  decisions do not silently change"). Where the correction is to what a document _is_ evidence
  _of_, the mechanism already exists and is the same one used everywhere else: record superseding
  evidence.

Each side is independent — attaching a receipt to its expense later does not disturb the payment
it was already attached to — and re-stating the same link is a no-op rather than an error, so a
retried request is not a failure.

**The no-op returns before the transaction opens.** `runAudited` rolls back a mutating unit of
work that recorded nothing (`audit.ts`), and an unchanged link is not a failure.

**Every link is audited** with its old and new value, actor and source. That is what makes "who
decided this document belongs to that payment" answerable later, which matters precisely because
everything extracted from the document inherits the answer.

## Consequences

A receipt can arrive before its payment, which is the common case, and be attached by a human
from the review queue (ADR-0035). Ingestion never has to guess a link in order to make one
possible.

A mistaken link cannot be edited. The remedy is to record superseding evidence — the same remedy
the rest of the row already has, and a heavier one than an `UPDATE`. That weight is the point:
the alternative is a receipt that can be moved onto a different transaction with no trace.

The database still permits both writes at the role level, because PostgreSQL column grants cannot
express "only from null". The domain is where the rule lives, and it is enforced before every
call to `db.updateEvidenceLinks`, which is the single function that issues the statement.

## Alternatives considered

1. **Freeze linkage entirely; a link is set at ingestion or never.** Structurally simplest, and
   wrong: a receipt photographed before the statement import would be permanently homeless, which
   is the ordinary case, not the edge one.
2. **Allow linkage to be rewritten freely, since the grant permits it.** Cheapest, and it makes
   the audit trail the only record that a document used to be evidence of something else — while
   `Receipt` rows extracted from it keep pointing through the moved link, now at a different
   transaction, with nothing marking that they were derived under a different one.
3. **A separate `evidence_links` join table**, with links appended rather than updated. Honest
   about history and it would model one document supporting several claims. Rejected as a schema
   change to reviewed tables in service of a plurality the domain says lives at the item level
   (`ReceiptItem → ExpenseItem → Expense`), not at the evidence level. Worth revisiting only if a
   real case appears for one document legitimately linking to several payments.
4. **A new `Evidence` row per link, reusing the same `storage_ref`.** Fits immutability with no
   new rule at all, and it is what the "same bytes, different linkage" case already does. Rejected
   as the general mechanism because attaching a document you already have would produce two rows
   for one act, and the review queue would then show the un-attached one forever.
