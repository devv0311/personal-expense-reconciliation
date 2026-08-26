# Phase 11 — Receipt item extraction

**Status:** design + delivery plan for the phase being implemented.
**Date:** 2026-08-27
**Roadmap phase:** 11, following phase 10 (receipt ingestion, PR #19, merged as `c346447`).

## What this phase delivers

Phase 10 stores documents; nothing reads one. A `receipt_image` is bytes at a content address
plus whatever a human said about it at ingestion. This phase turns one into a `Receipt` with
`ReceiptItem`s — the operation that makes item-based allocation (phase 12) possible at all, and
the operation that gives an `unmatched_evidence` review item an amount for the first time
(ADR-0035 left it carrying none, deliberately, because matching needs one).

Delivered:

1. **`ai.parseReceipt` / `ai.extractReceiptItems`** — the next two operations on phase 8's
   `Inference<T>` boundary, still behind an injected `ModelTransport` with no provider wired
   (ADR-0025 continues to hold).
2. **`services.extractReceipt`** — redact, ask (twice), validate, write. Writes a `Receipt` and
   its `ReceiptItem`s directly, unconfirmed — there is no `decideInference`-style gate, and
   ADR-0036 is why.
3. **`services.confirmReceipt` / `correctReceipt`** — the human side of "Confirmed or corrected
   by the user" (`domain-model.md`, `Receipt`). A boolean flip, or an overwrite; never a second
   `Allocation`-style versioned row, because `Receipt` carries no such invariant.
4. **Two surfaced discrepancies**, computed and returned, never enforced: `ReceiptItem` sum vs
   `Receipt.subtotal`, and `Receipt.total` vs a linked `Payment.amount` (`invariants.md`,
   `scenario-analysis.md` §20).
5. **Deterministic candidate-match surfacing** on the existing `unmatched_evidence` review item
   — an amount now exists to match on, so it is offered to a human. Nothing auto-links;
   ADR-0037 is why, and it leans on ADR-0034's write-once linkage to explain the caution.
6. **Six route handlers**, extending the existing evidence and receipt surfaces, still no
   framework (ADR-0032 continues to hold).

Two things this phase deliberately does **not** build, scoped in before implementation started
(see "Scope decisions"): `ai.normalizeMerchant()` and the merchant catalog's write path, and
manual (no-AI) receipt/item entry. Both stay carried forward.

## The pipeline this phase completes

```
evidence (receipt_image | email_receipt | screenshot, stored, no Receipt yet)
   │
   ├─ gate 0: services.extractReceipt requires the evidence type is receipt-eligible
   │          and that no Receipt already exists for it (PRECONDITION_FAILED otherwise)
   │
   ├─ ai.parseReceipt(evidence)        ─▶ Inference<ReceiptDraft>
   ├─ ai.extractReceiptItems(evidence) ─▶ Inference<ReceiptItemDraft[]>
   │          │
   │          ├─ gate 1: strict schema validation      (src/ai, no db)
   │          ├─ gate 2: semantic validation            (src/services, db-aware —
   │          │          "is this draft informative at all")
   │          ▼
   │   Receipt (confirmed_by_user = false) + ReceiptItem rows, written directly
   │   two AIInference rows (parse_receipt, extract_receipt_items), status = pending
   │
   ▼
services.confirmReceipt              services.correctReceipt
   confirmed_by_user → true             overwrite fields / replace items
   pending inferences → accepted        confirmed_by_user → true
                                         pending inferences → modified
```

Discrepancies and candidate matches are never written to a column. They are computed on read
(`services.extractReceipt`'s return value, `services.getReceipt`, and the enriched
`unmatched_evidence` review item) — "surfaced, not hidden" means visible, not persisted as a
second copy of a fact the source rows already establish.

## Scope decisions

Two questions were put to Dev before implementation started, because each changes the size of
"the entire phase" materially and neither has a single correct answer the roadmap already
settles.

### 1. `ai.normalizeMerchant()` and the Merchant write path: deferred

The roadmap's phase 11 handoff flags this as "carried forward, still paired" with extraction,
since a receipt header gives the operation a real merchant name to resolve for the first time.
But `Merchant` is explicitly named in `ai-boundary.md`'s gated list ("before it can influence an
Expense, Allocation, Settlement, ExpenseAdjustment, **Merchant**, or any other APPROVED-classified
record") — unlike `Receipt`, a new catalogued merchant needs its own accept/reject decision path
before it can be written, mirroring `classify_transaction`'s `decideInference` gate rather than
`Receipt`'s direct-write treatment (see decision 2 below). Building that is a second gated AI
operation with its own decision service, not an extension of this phase's shape.

**Decision: defer.** `services.extractReceipt` resolves a receipt's merchant only through the
existing, already-built, phase-7 deterministic path (`domain.merchantAliasKey` +
`db.findMerchantByAliasKey`). A merchant hint that does not match an existing alias leaves
`receipts.merchant_id = null` — the same shape phase 7 already leaves an unresolved payment
counterparty in. `ai.normalizeMerchant()` stays carried forward, unchanged, exactly as ADR-0022
left it.

### 2. Manual (no-AI) receipt/item entry: deferred

`domain-model.md`'s `Receipt` lifecycle names two ways a `Receipt` is created: "AI extraction
… or manual entry when no receipt image exists but the user wants item-level detail." Only the
first is this phase's driver (`ai.parseReceipt`/`extractReceiptItems`, named in the roadmap
heading itself).

**Decision: defer.** Manual entry with no receipt image at all is closer to phase 12's
`ExpenseItem` work — a human typing "Milk ₹80, Chicken ₹310" with no receipt to extract from is
indistinguishable in shape from defining `ExpenseItem`s directly, which phase 12 already owns.
Building a parallel manual `ReceiptItem` entry path here would duplicate that shape a phase
early. `services.recordManualNote` remains the only manual-evidence path this system offers.

### 3. Receipt extraction writes DERIVED rows directly; confirmation is a boolean (ADR-0036)

`ai-boundary.md`'s validation contract requires `services.decideInference` as "the _only_ code
path allowed to copy proposal data into an APPROVED-classified field" — but its own list of
what that means is `Expense`, `Allocation`, `Settlement`, `ExpenseAdjustment`, `Merchant`, "or
any other **APPROVED-classified** record." `Receipt` carries no such classification anywhere in
`domain-model.md`; it is tagged `DERIVED` — the same tag `Evidence`-adjacent DERIVED fields
(normalization's resolved `channel`/`counterparty_type`) already carry without a decision gate.
Its lifecycle text is explicit about the shape: "Created by AI extraction … **Confirmed or
corrected by the user**; corrections update this record … but never touch the underlying
`Evidence`." That is a record that exists provisionally and is corrected in place, not a
proposal that does not yet exist until accepted (`Settlement`'s shape) or a DERIVED row walking
a state machine toward `approved` (`Expense`'s shape).

So `services.extractReceipt` writes the `Receipt` and its `ReceiptItem`s in the same audited
unit of work that records the two `AIInference` rows — mirroring classification's "the DERIVED
row exists immediately, unapproved" precedent (ADR-0026) rather than settlement's "nothing
exists until acceptance" one. `confirmed_by_user` is the correction/confirmation surface;
`services.confirmReceipt` flips it and moves both inferences `pending → accepted`,
`services.correctReceipt` overwrites the disputed fields, flips it too, and moves both
inferences `pending → modified` (only when they are still `pending` — a correction made after
an earlier confirmation leaves that earlier decision's audit trail alone rather than trying to
re-decide an already-terminal `AIInference`, since `lifecycle.md`'s transition table has no edge
out of `accepted`/`modified`).

### 4. Receipt-to-payment matching surfaces candidates only (ADR-0037)

ADR-0035 left `unmatched_evidence` carrying no proposal because "matching needs an amount."
This phase gives it one. The temptation is to auto-link when exactly one payment matches a
receipt's total within a plausible date window — but ADR-0034 makes `evidence` linkage
**write-once**: `null → id` is permitted, re-pointing or clearing a recorded link is not. An
auto-link that turns out wrong (two purchases of the same round amount on the same day is not a
rare shape) is not a mistake this system can undo; it can only be worked around by ingesting
superseding evidence, which does nothing to un-misattach the original document.

**Decision:** `domain.findCandidatePaymentMatches` is a pure, deterministic function (exact
`Payment.amount = Receipt.total`, captured/occurred dates within a bounded window, live
unlinked debit payments only) that returns candidates, never a decision. The existing
`unmatched_evidence` review item is enriched to carry them. Attaching evidence to a payment
still goes through phase 10's `services.linkEvidence` — unchanged, and still a human's act.

## Delivery plan

Seven slices, each independently green (`typecheck`, `lint`, `format:check`, `db:check`,
`test`). No new migration: `receipts`/`receipt_items` and the `parse_receipt`/
`extract_receipt_items` inference-type values were already carried by the 2026-08-14 foundation
pass (`migration 0000`, `0004`) — this phase is the first real caller of tables that have
existed, unused, since then.

| #   | Slice                   | Delivers                                                                                                                                                                                           |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Receipt domain rules    | `src/domain/receipt.ts` — eligibility, discrepancy computation, confidence ordering, candidate-match matching; a new `RECEIPT_DRAFT_INVALID` error code                                            |
| 2   | AI boundary             | `src/ai/contract.ts` (`ReceiptDraft`/`ReceiptItemDraft` + parsers), `src/ai/redaction.ts` (receipt-evidence redaction), `src/ai/receipt-extraction.ts` (the two operations, extending `AiService`) |
| 3   | Repository queries      | Receipt/ReceiptItem read+write, `attachAiInferenceRecord`'s type union widened, an inferences-by-resulting-record read, an unlinked-candidate-payments read                                        |
| 4   | Receipt service         | `services.extractReceipt` / `confirmReceipt` / `correctReceipt` / `getReceipt`, the proposal fixture, the scripted transport helper                                                                |
| 5   | Review queue enrichment | `unmatched_evidence` items carry a receipt's total and its candidate matches when one exists                                                                                                       |
| 6   | API surface             | `src/api/receipt-routes.ts`, router registration, two body-JSON money helpers on `http.ts`                                                                                                         |
| 7   | Documentation           | Roadmap, `ai-boundary.md`'s "what exists", ADR-0036/0037, module READMEs where they name what a layer holds                                                                                        |

## Definition of done

- `ai.parseReceipt` and `ai.extractReceiptItems` exist behind the injected transport, validated
  by a strict gate 1 exactly as `classifyTransaction`'s is, with no production transport wired.
- `services.extractReceipt` over a receipt-eligible, undocumented evidence row writes a
  `Receipt` + `ReceiptItem`s, unconfirmed, with both `AIInference` rows traceable back to it.
- `services.confirmReceipt` and `correctReceipt` both move `confirmed_by_user` and leave a
  correct, non-`pending` audit trail on every inference still eligible to carry one.
- The two discrepancies (`item sum vs subtotal`, `receipt total vs linked payment amount`) are
  computed and returned wherever a `Receipt` is read, never silently reconciled
  (`fixtures/receipt-amount-mismatch.json`, `scenario-analysis.md` §20).
- An `unmatched_evidence` review item with an extracted `Receipt` shows its total and any
  deterministic candidate payments; nothing links itself.
- `npm run typecheck && npm run lint && npm run format:check && npm run db:check && npm test`
  all green on every slice.
