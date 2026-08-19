# Phase 9 — Human review

**Status:** design + delivery plan for the phase being implemented.
**Date:** 2026-08-19
**Roadmap phase:** 9, following phase 8 (transaction classification, PR #17, merged as `88e32c0`).

## What this phase delivers

Phase 8 produces states nothing reads. `REVIEW_REQUIRED` expenses exist, pending `AIInference`s
exist, `services.decideInference` exists — and there is no way to ask **"what is waiting for
me?"**, no way to act on a proposal that turned out wrong, and no way to resolve the two things
phase 8 deliberately left open (the rejected proposal's orphaned expense, and possible
duplicates).

Delivered:

1. **A review queue** — `services.listReviewQueue`, ordered deterministically by a pure domain
   function, carrying enough structure for a UI to explain _why_ each item is there.
2. **The settlement-vs-expense decision**, reviewable even though a settlement proposal has no
   `Expense` row — through the existing `services.decideInference`, which stays the only
   authoritative decision path.
3. **Re-classification** — an explicit review action that supersedes an unresolved proposal and
   asks again. A normal `classifyPayments` re-run stays a no-op.
4. **A policy for the rejected proposal's `Expense`** (ADR-0026 left this to phase 9).
5. **Possible-duplicate surfacing and confirmation**, wiring `domain.isPossibleDuplicate` — which
   has had no caller since the foundation pass — into the queue and the payment lifecycle.
6. **A thin API surface**: five route handlers, written as Web `Request → Response` functions.

## The shape of the queue

```
services.listReviewQueue
  ├─ pending classify_transaction inferences ─┬─ expense-kind    ─▶ + its DERIVED Expense
  │                                           └─ settlement-kind ─▶ no Expense exists (ADR-0026)
  ├─ payments whose proposal was rejected     ─▶ unexplained, awaiting re-classification
  └─ possible-duplicate payment pairs         ─▶ same amount/direction/window, no shared reference
                    │
                    ▼
        domain.prioritiseReviewQueue   (pure, total order, every reason reported)
                    │
                    ▼
     api  GET /api/review          POST …/decision   …/reclassify   …/duplicate
```

## Scope decisions

Five questions were open. Each is recorded as an ADR.

### 1. A rejected proposal's `Expense` becomes `rejected` — a terminal state (ADR-0028)

ADR-0026 left a DERIVED `Expense` behind when a proposal is rejected: unapproved, uncounted, and
with nothing to say what it is. The smallest safe resolution is a **new terminal `Expense`
state**, `rejected`, reachable only from `classified` and `review_required`.

Why a state rather than a derived query: an unapproved expense that can only be recognised by
joining to its inference is a row every future query has to remember to exclude. `expenses.state`
is the field every other lifecycle question in this system is already answered by, and the
reconciliation totals already enumerate the states they count (`approved` and later), so
`rejected` is excluded from every total by construction rather than by vigilance.

Nothing is deleted, nothing is mutated that was ever approved, and the transition is audited like
any other. The same disposition covers a proposal **superseded** by re-classification — the
distinction between "declined" and "asked again" lives in the audit event's `reason`, exactly as
`ignored_reason` distinguishes `duplicate_of:` from `out_of_scope` on a payment.

### 2. Re-classification is an explicit review action (ADR-0029)

`classifyPayments` skips a payment that already carries a classification inference
(`already_classified`), which is what makes a re-run a no-op (the ADR-0021 pattern). Phase 9 adds
`services.reclassifyPayment`, which is the _only_ thing that lifts that: it marks a **pending**
inference `superseded` (its DERIVED expense going to `rejected` with it), then runs the ordinary
classification path again for that one payment.

A `rejected` inference is not superseded — it was resolved, and rejecting is a decision the trail
keeps. An `accepted`/`modified` one is refused outright: the payment is already explained by an
approved `Expense` or a `Settlement`, and unwinding that is not a phase-9 capability.

### 3. A possible duplicate stays a human decision, and dismissal is recorded (ADR-0030)

`domain.isPossibleDuplicate` — same direction, same amount, close in time, **no** conclusive
reference match — has existed unused since the foundation pass. Phase 9 surfaces those pairs and
adds two review actions:

- **confirm** → the payment moves `imported|normalized → ignored` with
  `ignored_reason = duplicate_of:<canonical>`, resolving the chain head first (`invariants.md`
  #10). This is the existing lifecycle and the existing reason format; nothing new is invented.
- **dismiss** → "these two are genuinely different", recorded as an `AuditEvent` on the payment.
  No schema change: the queue filters out pairs that carry a dismissal, so a queue can actually be
  emptied.

Import-time deterministic dedup (ADR-0019) is untouched. The three categories stay distinct in
the model: a **confirmed** duplicate is `ignored` with a `duplicate_of:` reason, a **possible**
duplicate is two live payments plus a queue item, and a normal payment is neither.

### 4. Ordering is a pure function, and every reason travels with the item (ADR-0031)

`domain.prioritiseReviewQueue` sorts by rank, then amount descending, then `occurred_at`
ascending, then id — a total order over stable fields, so two reads of an unchanged ledger return
byte-identical results. Ranks: possible duplicates first (money may be double-counted, and
everything downstream derives from those rows), then proposals routing to `REVIEW_REQUIRED`, then
proposals that do not (they still need a decision — nothing auto-approves), then payments left
unexplained by a rejection.

`domain.routeClassificationForReview` — already pure, already returning _every_ reason — is
reused rather than re-derived, so the queue's "why" and phase 8's routing cannot disagree.

### 5. The API is Next.js route handlers, without Next.js (ADR-0032)

`system-architecture.md` names Next.js App Router. A Next.js route handler **is** a function
`(request: Request) => Promise<Response>` over Web standards, and Node 20's globals plus the
existing `@types/node` type-check those with **no new dependency**. So `src/api` ships exactly
that signature, plus a ~40-line path dispatcher for tests and a future server. Mounting them in
`app/api/**/route.ts` when the UI phase arrives is a re-export, not a rewrite.

Installing Next.js now would add a framework, a build step and a React tree to serve five
handlers, in a repository whose roadmap explicitly defers UI. This is the thinnest surface that is
genuinely usable, and it is honest about what it is.

## What phase 9 does not build

- **No UI.** A usable service + API surface is the phase's bar; `CLAUDE.md` defers UI polish
  until the financial engine is solid, and nothing here needs a screen to be exercised.
- **No auth.** Single-user, deferred by `system-architecture.md`. The actor arrives in the request
  body and is validated by `domain.parseDecisionActor` (which rejects `ai` and `system`); when a
  session exists, the actor comes from it instead. Recorded in ADR-0032.
- **No `ai.normalizeMerchant()` and no merchant-catalog seeding path.** Deferred again, with a
  reason: review acts on proposals that already exist, and re-classification calls
  `classifyTransaction`. Neither needs a merchant to be _created_, so building the write path here
  would be infrastructure without a caller — the thing ADR-0022 declined to do twice already.
- **Nothing from phases 10+**: no receipts, allocation, Splitwise, analytics, rules, or NLI.

## Delivery plan

Seven slices, each independently green (`typecheck`, `lint`, `format:check`, `db:check`, `test`).

| #   | Slice                 | Delivers                                                                                       |
| --- | --------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Domain review model   | `rejected` expense state + transitions, `domain/review.ts`, the `duplicate_of:` reason helpers |
| 2   | Repository queries    | Pending inferences, declined classifications, duplicate candidates, dismissals                 |
| 3   | `listReviewQueue`     | Assembly + prioritisation + the structured "why"                                               |
| 4   | Decline & re-classify | `decideInference(reject)` disposition, `services.reclassifyPayment`                            |
| 5   | Duplicate review      | `confirmPossibleDuplicate`, `dismissPossibleDuplicate`                                         |
| 6   | API surface           | Five handlers, a dispatcher, error mapping, serialization                                      |
| 7   | Documentation         | Roadmap, lifecycle, data-flow, database-design, module READMEs, ADR index                      |

## Definition of done

- The queue answers "what is waiting for me?" for every state phase 8 can produce, in a
  deterministic order, with a machine-readable reason per item.
- A settlement proposal is reviewable and resolvable without an `Expense`.
- Re-classification supersedes rather than overwrites; a plain re-run is still a no-op.
- No rejected proposal contributes to any total, and no financial record is deleted.
- A possible duplicate cannot become a confirmed one without a human act.
- `services.decideInference` remains the only path from an `AIInference` to authoritative state,
  and `src/api` contains no business logic, no database access and no AI call.
- The full gate passes repeatedly, and CI is green on the PR.
