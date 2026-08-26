# 0036. Receipt extraction writes DERIVED rows directly; confirmation is a boolean, not a decideInference gate

**Status:** Accepted

## Context

`ai-boundary.md`'s validation contract requires `services.decideInference` as "the _only_ code
path allowed to copy proposal data into an APPROVED-classified field" — and names what that
means: `Expense`, `Allocation`, `Settlement`, `ExpenseAdjustment`, `Merchant`, "or any other
APPROVED-classified record." Phase 8 built that gate for `classify_transaction`: a proposal
produces a `pending` `AIInference` and, on the expense path, a DERIVED `Expense` that cannot
become `approved` without an explicit accept/modify/reject decision.

Phase 11's `ai.parseReceipt`/`ai.extractReceiptItems` produce a `ReceiptDraft` and a
`ReceiptItemDraft[]`. The question: does turning those into a `Receipt`/`ReceiptItem` row need
the same gate?

`domain-model.md` answers the classification question for `Receipt` directly. It is tagged
`DERIVED`, not `APPROVED`-anything — the tag `Expense.state` only reaches once a human has
decided. Its lifecycle text: "Created by AI extraction … **Confirmed or corrected by the user**;
corrections update this record … but never touch the underlying `Evidence`." That is a record
that exists provisionally and is corrected in place — not a proposal withheld until accepted
(`Settlement`'s shape, ADR-0026) and not a DERIVED row walking a state machine toward `approved`
(`Expense`'s shape). The schema agrees: `receipts.confirmed_by_user` is a boolean, and there is
no `receipt_states` enum anywhere in `database-design.md`.

## Decision

**`services.extractReceipt` writes the `Receipt` and its `ReceiptItem`s in the same audited unit
of work that records the two `AIInference` rows.** No `decideInference`-shaped gate exists for
receipts, because `Receipt` is not in `ai-boundary.md`'s APPROVED-classified list and its own
lifecycle text describes direct creation, not withheld creation.

**`confirmed_by_user` is the human-facing surface**, not a second lifecycle:

- `services.confirmReceipt` flips it to `true` and moves both `AIInference`s `pending →
accepted`.
- `services.correctReceipt` overwrites the disputed fields (and/or replaces the item set), flips
  `confirmed_by_user` to `true` in the same act — a human who just fixed a figure has, by
  construction, looked at the row — and moves both inferences `pending → modified`.
- Either action only touches an inference that is **still `pending`**. `lifecycle.md`'s
  `AIInference` transition table has no edge out of `accepted`/`modified`
  (`assertAiInferenceTransition`), so a correction made after an earlier confirmation leaves
  that confirmation's decided inferences alone rather than trying to re-decide something already
  terminal. The `Receipt` row's own audit trail (a second `update` event) is what records the
  later correction; nothing is lost.

The write path resolves a receipt's merchant only through the existing, already-built, phase-7
deterministic alias match — `ai.normalizeMerchant()` and the Merchant catalog's write path stay
carried forward (this phase's own scope decisions, `docs/superpowers/specs/2026-08-27-phase-11-…`).
`Merchant` **is** in `ai-boundary.md`'s gated list, so a future phase that builds
`normalizeMerchant` will need its own decision path — this ADR does not extend to it.

## Consequences

- Extraction is a single round trip: ask both operations, validate, write, done. There is no
  intermediate "proposed but not yet a `Receipt`" state for a caller to poll, unlike a
  `classify_transaction` settlement proposal.
- A `Receipt`/`ReceiptItem` row can exist and be read (`services.getReceipt`) before any human
  has looked at it — `confirmed_by_user = false` is the honest signal, not an absence of the row.
- The two `AIInference` rows a `Receipt` produces are always traceable back to it
  (`db.listAiInferencesByResultingRecord`), and their `proposed_output` is stored with every
  `Paise` field turned into an exact minor-units string (`jsonb` cannot hold a `bigint`) —
  nothing reads that column back into a typed proposal, so the string round-trip costs nothing.
- Re-extraction is refused (`PRECONDITION_FAILED`) rather than offered: a second `extractReceipt`
  call over evidence that already has one would either duplicate the row or need its own merge
  rule. Correcting the existing `Receipt` is the one path, matching how a human is expected to
  fix a wrong figure.

## Alternatives considered

1. **Gate every operation through `decideInference`, generalized to a `receipt` record type.**
   Rejected: it would contradict `domain-model.md`'s own description of `Receipt` as
   directly-created-and-corrected, and it would mean a `Receipt` cannot exist (and so cannot be
   shown to a reviewer for correction) until someone has already decided it — backwards from
   "review the extraction, fix a wrong price, then confirm."
2. **No `AIInference` rows at all for receipt extraction**, since there is no decision to gate.
   Rejected: `invariants.md` #21 requires model/confidence information be traceable for every
   AI-touched record, and `ai-boundary.md` describes every one of the nine operations as
   producing an `AIInference` on the way in, independent of whether a decision gate follows.
3. **A `receipt_states` enum mirroring `Expense`'s**, so confirmation is a transition rather than
   a flag. Rejected as unsupported by the schema (`confirmed_by_user boolean`) and unmotivated: a
   `Receipt` has exactly one meaningful fact to track (has a human looked at it), which a boolean
   states more plainly than a two-state machine would.
