# Phase 8 — Transaction classification

**Status:** design + delivery plan for the phase being implemented.
**Date:** 2026-08-19
**Roadmap phase:** 8, following phase 7 (transaction normalization, PRs #10–#16).

## What this phase delivers

Phase 7 left every payment at `normalized`: a refined `channel`, and a merchant resolved where
the catalog knew the description exactly. Nothing yet says what a payment _is_.

Phase 8 answers that question — and, more importantly, **builds the machinery through which an
AI answer is allowed to become state at all**. `src/ai/` holds only a `README.md` today and
`ai_inferences` has no writer anywhere, so this phase is first construction, not extension
(ADR-0022).

Delivered:

1. **The AI service boundary** (`src/ai`): a typed service interface, the structured-proposal
   contract (`Inference<T>`), confidence handling, redaction before anything leaves the
   system, and a strict validator that rejects a malformed model response _before_ it can
   become an `AIInference`.
2. **`ai.classifyTransaction`** — proposing `proposedKind: 'expense' | 'settlement'` (ADR-0007)
   with the relationship/category/person hints the contract defines.
3. **`services.classifyPayment` / `classifyPayments`** — the orchestration: eligibility,
   the deterministic self-transfer leg, the AI leg, semantic validation, the `AIInference`
   write, confidence-based review routing, and the DERIVED `Expense`.
4. **`services.decideInference`** — the _sole_ path by which an `AIInference` leaves `pending`,
   producing either an approved `Expense` (with its `PaymentExpenseLink`) or a `Settlement` —
   never both.

## The pipeline this phase completes

```
payment (normalized)
   │
   ├─ deterministic leg ─▶ self-transfer pair? ─▶ counterparty_type = internal_account   (ADR-0023)
   │                                              stays NORMALIZED forever, no inference
   │
   └─ AI leg (debits) ───▶ ai.classifyTransaction ─▶ Inference<TransactionClassification>
                                │
                                ├─ gate 1: strict schema validation      (src/ai, no db)
                                ├─ gate 2: semantic validation           (src/services, db-aware)
                                ▼
                          AIInference (pending) ─┬─ kind=expense    ─▶ DERIVED Expense
                                                 │                     classified | review_required
                                                 └─ kind=settlement ─▶ nothing yet   (ADR-0024)
                                │
                                ▼
                    services.decideInference(accept | modify | reject)
                                ├─ expense    ─▶ APPROVED Expense + PaymentExpenseLink + payment LINKED
                                ├─ settlement ─▶ Settlement + counterparty person + payment LINKED
                                └─ reject     ─▶ no authoritative record
```

## Scope decisions

Six questions were open when this phase was scoped. Each narrows the phase deliberately and
each is recorded as an ADR.

### 1. Recognising a self-transfer is deterministic, not an AI proposal (ADR-0023)

`proposedKind` has exactly two members, `expense` and `settlement` (ADR-0007) — there is no
`transfer` member, and this phase does not add one. The two `NEFT/N072026001` legs in
`fixtures/bank-statement.csv` are one transfer between the user's own accounts, and the
evidence for that is arithmetic over two rows (same reference, same amount, opposite
directions, same instant), not semantics. `CLAUDE.md` assigns that class of evidence to
deterministic code and reserves AI for what deterministic code cannot settle.

So classification runs a deterministic leg first: a payment paired with an opposite-direction
leg is written `counterparty_type = internal_account` and stays at `NORMALIZED` — a valid
terminal state (`lifecycle.md`, `invariants.md` #7). No `AIInference` row is created for it,
because no model proposed anything.

### 2. A classification proposal creates a DERIVED `Expense`; a settlement proposal creates nothing (ADR-0024)

`data-flow.md` step 3 draws `services.evaluateForReview ─▶ Expense.state = CLASSIFIED |
REVIEW_REQUIRED`, and step 5 draws `decideInference ─▶ db.updateExpense (APPROVED)` — an
_update_ of an expense that already exists. `lifecycle.md`'s `CLASSIFIED` is literally
"`relationship_type` and `category` are set (by AI proposal or manual entry), **not yet
approved**". So the expense path writes a DERIVED `Expense` at classification time, moving it
`proposed → classified → (review_required)`, one audited transition at a time.

The settlement path cannot mirror this: `Settlement` "has no state machine of its own beyond
existing-or-not — it is created directly as an `APPROVED` record" (`lifecycle.md`). Creating
one at classification time would write an APPROVED record straight from AI output, which is
exactly what invariant #15 forbids. So a settlement proposal creates **nothing** until it is
accepted; the pending `AIInference` is its queue entry, which is why roadmap phase 9 describes
the queue as surfacing "`REVIEW_REQUIRED` expenses **and** pending `AIInference`s".

### 3. Confidence changes friction, never the requirement for approval (ADR-0026)

Routing is deterministic, computed by `domain.routeClassificationForReview` from three inputs:

| Reason            | Rule                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `low_confidence`  | `confidence !== 'high'` (`medium`/`low`/`unknown` all route to review)     |
| `material_amount` | `amount >= 500000` paise (₹5,000) — the materiality threshold, overridable |
| `settlement_kind` | `proposedKind === 'settlement'` — always reviewed, it has no DERIVED state |

**No path in this phase auto-approves anything.** `high` confidence below the threshold ends at
`CLASSIFIED` rather than `REVIEW_REQUIRED`; both still require `decideInference`. Invariant #16
allows auto-progression only via a matched `Rule` the user previously approved, and `Rule` is
phase 16 — so the mechanism that would consume "eligible for auto-progression" does not exist
yet, and manufacturing one here would be the shortcut the invariant exists to prevent.

### 4. Phase 8 classifies debits; credits are deliberately out of scope (ADR-0025)

A credit is never new spend, so it can never produce an `Expense`. The two credit meanings the
model _does_ support both belong elsewhere:

- a **merchant refund** is an `ExpenseAdjustment` against an existing expense (ADR-0008),
  recorded through `services.recordExpenseAdjustment` — it needs an original expense to net
  against, and matching a credit to one is not `classifyTransaction`'s job;
- a **received settlement** needs an open `Balance` to discharge, and balances come from
  allocations (phase 12).

And ADR-0015 already puts general inflow classification outside V1 entirely. So the fixture's
`ACH REFUND SAMPLE ELECTRONICS STORE` credit stays `normalized`, merchant-resolved, with **no
`AIInference` row** — a recorded outcome, exactly like phase 7's unresolved rows. The one thing
credits _do_ participate in is the deterministic self-transfer pairing above, which needs both
legs.

### 5. The model transport is injected; no provider is wired (ADR-0027)

`src/ai` owns the contract, the redaction, the prompt version and the validation. It does not
own an HTTP client to a provider: `createAiService(transport)` takes a `ModelTransport`, and
this phase ships no production implementation of one. `CLAUDE.md` forbids wiring real
credentials during development, and a boundary is testable without a provider — the integration
suite injects a transport scripted from `fixtures/ai-classification-proposals.json`, so the
real validator, the real service and the real database all run in the test.

### 6. What phase 8 does not build

- **`ai.normalizeMerchant()`** — still unbuilt (ADR-0022 carried it forward). Classification
  never writes a `Merchant`, so the phase-7 carry-forward about a production merchant-catalog
  write path is _not_ required here and stays carried forward.
- **The review queue** — listing/prioritising `REVIEW_REQUIRED` expenses and pending
  inferences is phase 9. Phase 8 writes the states that queue will read, and nothing more.
- **Possible-duplicate surfacing** — still phase 9's (roadmap).
- **`superseded`** — the status exists and its transition is already modelled, but nothing in
  this phase produces it: a payment that already carries a `classify_transaction` inference is
  not eligible for classification again, so a re-run is a no-op (the ADR-0021 pattern).
  Re-classification after a rejection is a review action, and belongs with the queue.
- **Investments** (`counterparty_type = investment_instrument`) — no deterministic evidence
  exists in any fixture bank statement, and inventing an instrument catalog to serve one
  hypothetical row is speculative.

## Delivery plan

Seven slices, each independently green (`typecheck`, `lint`, `format:check`, `db:check`,
`test`).

| #   | Slice                  | Delivers                                                                                                                               |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Classification rules   | `src/domain/classification.ts` (eligibility, self-transfer pairing, review routing, decision actor), enums, the `inference_type` CHECK |
| 2   | AI boundary            | `src/ai/{contract,redaction,classify-transaction,errors,index}.ts` + contract tests                                                    |
| 3   | Repository queries     | The inference/expense/link/counterparty writes and the classification-eligibility read                                                 |
| 4   | Classification service | `services.classifyPayment` / `classifyPayments`, the proposal fixture, the scripted transport                                          |
| 5   | `decideInference`      | accept / modify / reject, both kinds, `PaymentExpenseLink`, payment `→ linked`                                                         |
| 6   | End-to-end pipeline    | import → normalize → classify → decide over `fixtures/bank-statement.csv`, all four row classes                                        |
| 7   | Documentation          | Roadmap, `data-flow.md`, `ai-boundary.md`, testing strategy, module READMEs                                                            |

## Definition of done

- Every one of the bank fixture's eight rows has a recorded classification outcome: five
  merchant debits classified (one settlement-kind, four expense-kind), two transfer legs
  `internal_account`, one credit deliberately unclassified.
- No `AIInference` can leave `pending` except through `decideInference`, and no malformed or
  semantically invalid proposal can become an `AIInference` at all.
- The full gate passes, repeatedly, and CI is green on the PR.
