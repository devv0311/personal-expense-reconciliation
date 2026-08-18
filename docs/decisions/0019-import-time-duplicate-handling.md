# 0019. Duplicate detection matches on direction, and a confirmed duplicate may be ignored straight from `imported`

**Status:** Accepted

## Context

Phase 6 built the first real ingestion path — a synthetic bank-statement CSV into
`ImportBatch` + `Payment` rows — against `fixtures/bank-statement.csv`. Two rules that read
as complete on paper turned out to be under-specified the moment a real file went through
them. Both are recorded here because both change reviewed documents, and neither is an
ordinary implementation choice.

### 1. `invariant #10`'s matching criteria omitted `direction`

The rule made a deterministic duplicate out of two payments sharing `amount`, a non-null
matching `external_reference`, and timestamps within a small window. Rows 2 and 3 of the
fixture are:

```
2026-07-02,NEFT TRANSFER TO SELF A/C X4821,15000.00,DEBIT,NEFT/N072026001
2026-07-02,NEFT TRANSFER FROM SELF A/C X9013,15000.00,CREDIT,NEFT/N072026001
```

These are the two legs of one transfer between the user's own accounts. They share a
reference (banks reference both legs of a transfer identically), share an amount, share a
date — and differ only in direction. Under the rule as written they matched, so the credit
leg was marked a duplicate of the debit leg and dropped out of every total.

An invariant whose stated purpose is _"duplicate transactions must not double-count money"_
was, for this input, **under**-counting it: half a real transfer disappeared. That is worse
than the failure it was written to prevent, because a missing row is invisible whereas a
doubled one shows up as an inflated total.

### 2. The payment lifecycle had no way to discard a duplicate found at import

`lifecycle.md` draws `IMPORTED → NORMALIZED → (LINKED | IGNORED)`. `IGNORED` is reachable
only through `NORMALIZED`. But `invariants.md` #10 and `scenario-analysis.md` §13 both say a
confirmed duplicate ends up `ignored` with `duplicate_of:<id>` — and the importer confirms
duplicates deterministically, at import, before anything is normalized.

Leaving the row at `imported` was not an option: `domain.computeUnexplained` excludes only
`ignored` payments, so an un-ignored duplicate inflates `ledger_total_outflow` — the exact
double-count invariant #10 exists to prevent.

## Decision

**1. `direction` joins the matching criteria**, for both the deterministic and the
possible-duplicate paths. Money leaving is never a duplicate of money arriving, however alike
the two rows otherwise look. Implemented in `domain.isDeterministicDuplicate` /
`domain.isPossibleDuplicate`; `invariants.md` #10 and ADR-0010 amended to state it.

**2. `imported → ignored` becomes a valid payment transition**, used only for a duplicate
confirmed deterministically against an existing payment.

The asymmetry with `linked` is the point, not an inconsistency: being **explained** requires
knowing what a payment _is_, so `linked` still demands normalization first. Being
**discarded** does not. Routing a row through `normalized` on the way to the bin would mean
recording that a counterparty was resolved for a row nobody will ever look at again — a
false entry in the audit trail, to satisfy a diagram.

The duplicate row is still **written**, then ignored — never skipped at insert time.
`invariants.md` #10 forbids silently merging duplicates _or_ silently keeping two
indistinguishable ones; the ledger did receive that evidence twice, and the second copy
carries the reason it does not count.

> **Amendment (2026-08-19).** The decision above said a confirmed duplicate is marked
> `duplicate_of:<id>` without ever saying _which_ id, and the importer took the first candidate
> the query returned. That is under-specified in a way that bites on the **third** capture of
> one transaction: every copy carries the same `external_reference`, so the third row matches
> the original _and_ the copy already ignored against it. The copies also tie on `occurred_at`
> — this format carries a date, not a timestamp — so the `(occurred_at, id)` ordering was
> decided by a random UUID. Observed: over twelve runs of a three-import scenario, seven
> recorded the third copy as a duplicate of an already-ignored row and five named the original.
>
> No money was ever double-counted — the row is `ignored` either way, and
> `domain.computeUnexplained` skips it — so this was an **explainability** defect
> (`requirements.md`), not an arithmetic one. It is worth recording because of its shape: order
> by a tuple whose members tie, tie broken by a random UUID, is precisely the defect that
> reached `main` once already in `listAuditEvents`.
>
> **`duplicate_of` now names the canonical payment**, resolved by walking the matched
> candidate's chain to its head. The chain is always within the candidate set already fetched
> (every member shares the reference), so this costs no extra query, and — the point — the
> result no longer depends on candidate order at all. Fixing the `ORDER BY` instead would have
> made the answer stable without making it _correct_: a stable pointer to an ignored row is
> still a pointer to an ignored row.
>
> A candidate that is itself `ignored` deliberately remains a match. Excluding ignored rows
> from the candidate set is the obvious alternative and is wrong: a payment ignored as
> `out_of_scope` is still the first copy the ledger saw, and skipping it would leave the
> restatement at `imported`, where it counts as fresh spend. Both cases are covered by
> deterministic tests in `tests/integration/import.test.ts` — the first pins the candidates'
> UUIDs, since a test whose subject is ordering cannot be left to a coin toss.

## Consequences

`invariants.md` #10 and `lifecycle.md`'s payment section both gain a clause. ADR-0010 gains a
second amendment. `DuplicateCandidate` gains a required `direction` field, so every existing
call site had to state it — deliberately not optional, since a defaulted direction is exactly
the silent assumption that caused the bug.

Deduplication now has two independent layers, catching different things:

- **Whole file** — `import_batches.content_hash` makes a byte-identical re-import a
  recognised no-op.
- **Individual rows** — an _overlapping_ statement re-states some transactions and not
  others, so each row is checked against what is already stored.

Only the deterministic path acts automatically. A row that merely resembles another (same
amount and date, no matching reference) is left alone for a human, per invariant #10.

## Alternatives considered

- **Leave `direction` out and special-case transfers in the importer.** Rejected: the
  importer would have to recognise a self-transfer to do it, which is classification, and
  classification is Phase 8's. The fix belongs in the matching rule, where the omission was.
- **Compare `account_id` instead of `direction`.** Would also separate the two NEFT legs _if_
  they landed on different accounts — but ADR-0010's amendment removed `account_id` from the
  criteria for good reason, and both legs of a transfer can appear on one statement anyway.
- **Skip inserting a duplicate row entirely.** Simpler, and wrong: it discards evidence the
  ledger actually received and leaves no record of why a transaction the user can see in
  their statement is absent here.
- **Allow `imported → ignored` for any reason, not just a confirmed duplicate.** Rejected as
  too broad for what was actually needed. The transition exists for a specific, deterministic
  case; anything else still earns its `normalized` step.
