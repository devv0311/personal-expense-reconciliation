# 0010. Add `external_reference` / `reference_type` / `source_system` to Payment

**Status:** Accepted

## Context

Invariant #10 requires deterministic duplicate detection when "a matching external reference" is
available (same account, amount, timestamp, and reference). `payments` had no column to store
such a reference — only `raw_description` (unstructured). The "deterministic" half of invariant
#10 was, as written, unbuildable; every case would have fallen into the "possible duplicate, flag
for confirmation" branch regardless of how conclusive the evidence actually was (review finding
#6). Notably, `fixtures/duplicate-transaction.json` already included an informal `reference`
field on its payments — the fixture author had already anticipated this gap before the review
surfaced it.

## Decision

Add to `payments`:

- `external_reference text` (nullable) — the UPI UTR/RRN, bank reference number, card reference,
  merchant order ID, or cheque number, as applicable. Extracted during normalization
  (`services.normalizePayments()`), from structured import fields where the source format
  provides them, or parsed out of `raw_description` where it doesn't.
- `reference_type text` (nullable), `check (reference_type in ('upi_utr', 'upi_rrn',
'bank_reference', 'card_reference', 'merchant_order_id', 'cheque_number', 'other'))`.
- `source_system text` (nullable) — the originating app/institution (e.g. `'hdfc_bank_csv'`,
  `'gpay_export'`, `'phonepe_export'`, `'manual'`), distinct from `channel` (the transport: UPI vs
  bank vs card vs cash) and from `import_batches.source_channel` (the same transport concept at
  the batch level). `source_system` matters because reference-number _format_ and reliability
  differ by originating app even within one channel — two UPI apps format UTRs differently.

Index: `(external_reference)` (partial, where `external_reference is not null`) — **global, not
scoped by `account_id`, amended this revision; see below** — alongside the existing `(amount,
occurred_at, account_id)` index.

**Revised dedup rule (invariant #10):** deterministic duplicate = same `direction`
(**amended again in Phase 6 — see the second amendment below**) + same `amount` +
`external_reference` matches (non-null on both sides) + timestamps within a small window (source
clock skew, not a meaningfully different transaction). Everything else — no reference available,
or references present but not matching — falls back to the existing amount/timestamp-proximity
heuristic and is surfaced as a _possible_ duplicate for confirmation, never auto-merged.

> **Amendment (2026-08, implementation-readiness pass).** The rule above originally also
> required matching `account_id`, and the index was `(account_id, external_reference)`. Building
> `fixtures/duplicate-transaction.json` against the scenario this ADR itself cites — "a bank CSV
> and a UPI export both capturing the same charge" (`scenario-analysis.md` §13) — surfaced a
> direct contradiction: a bank-channel import and a UPI-channel import of the _same real-world
> transaction_ land under two different `Account` rows in this schema (`account_hdfc_savings`
> vs. `account_hdfc_upi`), so an `account_id` match would never actually fire for the scenario
> the rule was written to handle. `account_id` is removed from the matching criteria; the index
> is now a global lookup on `external_reference` alone. `amount` + `external_reference` +
> timestamp proximity is sufficient corroboration — a UTR/RRN/bank reference already uniquely
> identifies the real-world transaction independent of which local `Account` row observed it.

This is **not** a hard database `UNIQUE` constraint on `external_reference`: some
sources reuse reference numbers legitimately (a recurring cheque number format, a bank that
truncates references), and a hard constraint would risk rejecting two genuinely distinct
payments. Matching stays an application-level decision inside `services`, consistent with how
every other cross-row invariant in this system is enforced (`database-design.md`, Conventions).

> **Second amendment (2026-08-15, Phase 6 — see ADR-0019).** `direction` was missing from the
> matching criteria, and implementing the bank-statement importer against
> `fixtures/bank-statement.csv` proved it was load-bearing rather than pedantic. That fixture's
> rows 2 and 3 are the two legs of one internal transfer: identical `external_reference`
> (`NEFT/N072026001`), identical `amount` (₹15,000), identical date — opposite directions. The
> rule as written matched them, marking the credit leg a duplicate of the debit leg and
> discarding it. A rule whose stated purpose is "must not double-count money" was, in this case,
> under-counting it. `direction` now gates both the deterministic and the possible-duplicate
> paths.

## Consequences

Three new nullable columns and one new index on `payments`; no migration exists yet, so this is a
design-doc-only change at this stage. `services.normalizePayments()` gains a concrete
responsibility (reference extraction) that wasn't previously specified. `scenario-analysis.md`
#13 is revised to show the fields populated and used.

## Alternatives considered

- **Store the reference only inside `raw_description` and parse it ad hoc at dedup time.**
  Rejected: re-parsing unstructured text on every dedup check is slower, harder to test in
  isolation, and — critically — throws away the parsed value instead of persisting it, so every
  future query needing the reference (not just dedup) would re-implement the same parsing.
- **A hard `UNIQUE(external_reference)` (or, originally, `UNIQUE(account_id,
external_reference)`) constraint.** Rejected above — real bank data isn't clean enough to make
  this safe without risking silently rejected legitimate imports.
- **Fold `source_system` into `import_batches` only, not `payments`.** Considered, since
  `import_batches.source_channel` already exists at the batch level. Rejected because a single
  import batch can, in principle, mix payments normalized from different underlying apps (e.g. a
  combined "UPI transactions" export covering multiple UPI apps); keeping `source_system` on the
  `Payment` itself is more precise and doesn't assume batch-level homogeneity.
