# Outcome-first product surface — plan

## The failure this fixes

The ledger underneath is sound. The website in front of it is a map of the implementation.

`/` redirects to `/reconciliation`. The nav is eight workflow tabs plus four utilities, named
after the machinery: Review, Payments, Evidence, Reconciliation, Expenses, Balances, Splitwise,
Proof packs, Ask, Analytics, Automation, Setup. Primary screens carry `normalization`,
`classification`, `cash-flow state`, `import batch`, `parser statement-formats@2:…`,
`unmatched_evidence`, and paragraphs explaining what those mean.

Every one of those is a true and useful thing for the person who built it. None of them is what
somebody opening this wants to know, which is: **what did I spend, who owes whom, what needs me,
and what do I do next.**

This is an information-architecture problem. The fix is to recompose what exists into journeys —
not to rename tabs, and not to rebuild the ledger.

## What already exists and is reused unchanged

The audit found the end results are nearly all computed already, just not composed:

| Outcome the user wants    | Already served by                                              |
| ------------------------- | -------------------------------------------------------------- |
| What I spent, by category | `getCategorySpend` → `GET /api/analytics/spending`             |
| Spending over time        | `getMonthlySpend` → `GET /api/analytics/monthly`               |
| My own share              | `getOwnSpend` → `GET /api/analytics/own-spend`                 |
| Who owes whom             | `getOutstandingBalances` → `GET /api/analytics/outstanding`    |
| Paid on behalf, unpaid    | `getUnsettledPaidOnBehalf` → `GET /api/analytics/unsettled`    |
| What needs a decision     | `listReviewQueue` → `GET /api/review`, with per-kind counts    |
| Records for one event     | `GET /api/payments/:id/context`, `/evidence/:id/matches`       |
| Unexplained money         | `PaymentWorkspaceItem.unexplainedTotal` — **per payment only** |

**One genuine gap.** There is no ledger-wide unexplained figure. It exists per payment and
nowhere in aggregate, so an Overview cannot show it without the frontend summing a page of
payments — which is financial arithmetic in React, and forbidden (ADR-0048). That is the read to
add, and the only one.

## Backend: one new read model

`src/services/overview-service.ts` — `getOverview(db, { userPersonId, period })`, composing the
reads above and adding the missing aggregate. One route: `GET /api/overview`.

It computes the unexplained aggregate through the **same** `explainedAmount` domain call
`toWorkspaceItem` uses, so there is one definition of "explained", not a second one that drifts.

Every figure is returned as `{ known: boolean, … }`. A figure the ledger cannot stand behind
comes back `known: false` and the screen says **"Needs review"** — never `₹0`. Rule 2 of
`web/CLAUDE.md` applied to a dashboard: a confident zero over incomplete evidence is the one
number this product must never print.

## Frontend: the journey, not the machinery

Primary nav becomes five, with everything else still reachable:

- **Overview** (`/`) — the end results and one clear next action.
- **Add records** (`/add`) — statement, bill/receipt, payment screenshot, manual entry.
- **Needs attention** (`/needs-attention`) — only what needs human judgment, as questions.
- **Spending** (`/spending`) — categories, trend, unexplained.
- **People** (`/people`) — collect, pay, settled.
- **More** (`/more`) — every specialist screen, unchanged.

**Every existing route keeps working.** `/review`, `/payments`, `/reconciliation`, `/evidence`,
`/expenses`, `/balances`, `/splitwise`, `/proof-packs`, `/analytics`, `/automation`, `/setup`,
`/ask` and all detail routes stay exactly where they are, reachable from More and from deep
links. This slice adds a front door; it removes nothing.

## Language rules for primary screens

Visible vocabulary is: **record, payment, expense, connection, share, balance.**

Not visible on a primary screen: normalization, classification, cash-flow state, evidence,
reconciliation, import batch, parser version, enum values, ids, confidence scores, or a paragraph
explaining any of them. Those move behind **Details** and **History**, which keep the full audit
trail exactly as it is.

## Slice order

1. `overview-service.ts` + `GET /api/overview` + tests.
2. `/` becomes Overview; root redirect deleted.
3. Nav recomposed; `/more` index added.
4. `/add` landing routing into existing intake.
5. `/needs-attention` reframing the review queue as questions.
6. `/spending`, `/people` composed from existing analytics reads.
7. Root and web checks; synthetic-only visual QA.

## What this slice does not do

No change to domain logic, invariants, the audit trail, or any write path. No new dependency, no
network or AI call. No re-import of the five statements already loaded — the 120 movements
already in the ledger are what the new screens read.

---

# Phase C — the connection, as one event

## The failure this fixes

Phases A and B gave the product a front door and four questions to arrive with. What they did
not do is answer the question the product exists for. A statement line, the restaurant bill for
it and the UPI screenshot of it are **one purchase**, and the ledger already knows that — but
nowhere can a person see it. The three records surface in three different places (`/payments`,
`/evidence`, the review queue), each one named after the mechanism that holds it, and the only
screen that puts a payment beside its evidence (`/payments/[id]` → `PaymentContext`) opens with
the words "Payment context", shows "observation", "derivation" and "evidence match candidate",
and never once says what was bought or who owes what because of it.

Meanwhile the review queue asks four questions in the ledger's vocabulary — _classification
decision_, _possible duplicate_, _rejected classification_, _unmatched evidence_ — which is an
accurate description of its contents and an unusable way to arrive at them. Somebody has to
classify their own problem before the screen will help.

## The audit: what already connects records, and what does not

Everything below already exists and is reused unchanged. **No new matching engine is written.**

| Fact about one real-world event    | Already served by                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| The money movement itself          | `getPaymentWorkspaceItem` → `PaymentWorkspaceItem`                             |
| Explained / unexplained, duplicate | `domain.explainedAmount`, `domain.isDuplicateRepresentation` (via the above)   |
| Supporting records attached to it  | `db.listEvidenceContextSourcesForPayment`, via `getPaymentContext`             |
| What those records say             | `domain.deriveReattachedContext` → merchant candidates, references, conflicts  |
| Proposed (unconfirmed) connections | `evidence_match_candidates` rows + `EvidenceMatchCandidateView`                |
| Why a proposal looks related       | `candidate.matchedSignals` / `conflictingSignals` / `reviewReasons` (ADR-0044) |
| Confirming a proposal              | `services.decideEvidenceMatch` — the **only** path from an offer to a link     |
| The expense(s) it funded           | `db.listPaymentExpenseLinksByPayment` + `services.getExpenseLedgerRow`         |
| Payer                              | `ExpenseLedgerRow.paidByPersonId` (ADR-0006 — not always the user)             |
| Beneficiaries and shares           | `db.getCurrentAllocation` + `listAllocationLines` + `listGroupExpansions`      |
| Refunds against it                 | `db.listExpenseAdjustmentSummaries`, `db.sumAdjustmentsAgainstPayment`         |
| Settlements it discharges          | `db.listSettlementRegister({ ... })`, `db.listSettlementsByPayment`            |
| Duplicate state                    | `payments.state = 'ignored'` + `ignoredReason = duplicate_of:<id>`             |
| What still needs a human           | `services.listReviewQueue` — the one definition, reused, never re-derived      |

**Three gaps, all of them reads.** None is a calculation, so all three are added to the API
exactly as `web/CLAUDE.md` rule 1 requires:

1. **No read composes one event.** Every fact above exists; nothing puts them in one place, so a
   screen could only do it by joining financial facts in the browser. → `getPaymentConnection`.
2. **No read returns match candidates for a payment.** `listEvidenceMatchCandidatesByEvidence`
   exists; the inverse does not, so a payment cannot show what is being proposed about it.
   → `db.listEvidenceMatchCandidatesByPayment`.
3. **No read returns allocation shares with the beneficiaries' names.** `refund-allocation`
   returns ids only. → composed inside the connection read.

## Backend

**`src/domain/connection.ts`** — pure. `paymentNature()` maps stored decisions (counterparty
type, cash-flow category, whether settlements or expense links exist) onto the eight plain
words a person reads: `spending`, `transfer`, `investment`, `settlement`, `refund`,
`money_in`, `duplicate`, `not_yet_known`. It is a **mapping over decisions already recorded**,
not a second classifier: it infers nothing, and `not_yet_known` is what it returns when the
ledger has not been told. A credit-card bill payment is `transfer`, so it is never presented as
spending.

**`src/domain/attention.ts`** — pure. `attentionQuestion(kind, reasons)` turns a review kind
into the question it actually represents, plus the plain reason it is being asked. An
unrecognised kind returns a **safe generic question** rather than nothing, so a kind this file
has not been taught still reaches the screen (the `labels.ts` precedent, enforced here in the
domain instead).

**`src/services/attention-service.ts`** — `listAttentionQuestions()`. Composition over
`listReviewQueue`: same items, same order, same counts, re-expressed as questions with only the
facts needed to decide (`AttentionFact[]`, each typed `text | money | date | unknown` so `web/`
formats but never computes). Every item still carries its original `ReviewQueueItem`, so the
existing inspectors and their `DecisionDialog`s answer it — no new write path, no one-click
approval. An amount nobody has established is `known: false`, never `₹0`.

**`src/services/connection-service.ts`** — `getPaymentConnection()`. One real-world event:
the movement, its supporting records, proposed connections with their reasons, the resulting
expenses with payer and shares, refunds, settlements, duplicate state, what it contributes to
spending, and the open questions. Pure orchestration: every figure comes from an existing
domain call or service read. Absence is `known: false` with a sentence; it is never zero.

**`countsOnceInSpending`** is the field that makes the one-event/many-records rule checkable:
several supporting records never produce several totals, and a confirmed duplicate contributes
nothing.

Routes: `GET /api/connections/:paymentId`, `GET /api/attention`. Both reads.

`GET /api/overview` gains `unexplainedMovements` — the recent movements carrying the
unexplained total — so Spending can link to the event rather than to the payment workspace.

## Frontend

- **`/connections/[paymentId]`** — the connection view. Opens with what happened, what records
  support it, what has been connected, and what still needs a person. Labels are _Payment_,
  _Bill or receipt_, _Screenshot_, _Shared with_, _You paid_, _Paid by …_, _You should collect_,
  _You need to pay_, _Possible match_, _Why this looks related_. No enum, no id, no confidence
  score, no parser name, no "observation" — all of that stays reachable under **Details** and
  **History**, which link to `/payments/[id]` and `/evidence/[id]` unchanged.
- **`/needs-attention`** — rebuilt on `/api/attention`. One row per question, the facts needed
  to answer it, the plain reason it is asked, and _Answer this_, which reveals the existing
  inspector. Unknown kinds render under the generic question rather than disappearing.
- **`/payments/[id]`, `/review` and every other route stay exactly where they are.** The
  payment screen gains one link up to the connection view; nothing is removed.

## What Phase C does not do

No change to domain arithmetic, invariants, the audit trail or any write path. No new
dependency, no network or AI call. No matching engine — local deterministic proposals already
exist and remain proposals until a person accepts them.

## What implementation added to this scope

Four things the audit did not anticipate, each found by looking at a rendered screen rather than
at the code:

1. **`ConnectionTitle`.** "What happened?" had no answer for most movements: a merchant is only
   named once somebody resolves one, so the headline fell back to `UPI-AMZN9821PYTM`. The read
   now returns the best established name with **where it came from** — counterparty, attached
   record, the expense it funded, or last the bank's own words — and the screen says so when it
   is the last of those. It never invents a name; it ranks the ones that exist.
2. **`fullyAccountedFor`.** A fully-explained payment rendered `₹0.00` in `debit` red, which is
   the right colour for an unexplained gap and exactly the wrong one for the absence of a gap.
   Deciding it in the browser would have meant comparing a figure to zero there — the judgement
   `web/CLAUDE.md` rule 2 exists to keep out of the screen — so the API decides it.
3. **`payment_unaccounted`.** The queue only asks "what was this for?" about a payment somebody
   already declined a proposal for. A payment nobody ever asked about is just as unexplained,
   and on a ledger of imported statements that is most of them — so the question is asked on the
   event's own screen and deliberately **not** added to the queue, which would otherwise list a
   hundred and forty rows nobody could work through.
4. **`attention.total` on the overview.** The front page counted the review queue while the nav
   badge and Needs attention counted the questions; the two disagreed by exactly the
   ledger-derived ones. `getOverview` now composes `listAttentionQuestions` and reports both
   numbers, so no two screens can quote a count the other denies.

## Known gaps after phase C

- `getPaymentConnection` reads the whole question list to find the ones about its own event.
  Correct, and it keeps one definition of "what needs me", but it is O(queue) per detail page.
- `/people` rows still open the pair balance rather than an event, because a person is not one
  event. The connection view links the other way — a share names the balance behind it.
- "Who shared this expense?" is answered on the allocation editor, which is still the phase 22
  screen. It is reached from the question; it has not been re-written in this vocabulary.

---

# Phases D and E — the journey end to end

## The failure these fix

Phase C made one event readable. What is still missing is everything either side of it.

**Before an event can be read, somebody has to press two buttons named after the machinery.**
A statement lands at `/payments/import`, and nothing happens to it until a person finds
`/payments`, presses **Run normalization**, reads a dialog about `imported → normalized`,
presses **Run classification**, and reads a second dialog about a model contract. Both are
accurate. Neither is a thing anybody came to do, and a person who does not do them sees an
Overview reporting ₹0 spent over a statement it has read but not understood.

**After an event is read, the obligations it creates have no plain surface.** `/people` lists
two totals and a row per person, and every row goes to `/balances?with=…`, which opens on a
pair picker and explains a figure in contributions and supersessions. "Who shared this expense?"
— the question Phase C added — lands on the phase-22 allocation editor, which opens by asking
the reader to choose between `equal`, `exact`, `percentage`, `custom`, `item_based` and
`quantity_based` before it will tell them anything.

**And `/spending` sends anybody who wants a trend to `/analytics`.**

## The audit: what already does this work

| What the journey needs            | Already served by                                                              |
| --------------------------------- | ------------------------------------------------------------------------------ |
| Read a statement's rows           | `normalizePayments` — deterministic, idempotent, `imported → normalized`       |
| Pair both legs of a self-transfer | `classifyPayment`'s **deterministic leg**, before any model call               |
| Suggest what a payment was        | `classifyPayments` — needs a model; records proposals, approves nothing        |
| Propose which records go together | `matchEvidenceContext` — local, deterministic, returns `unchanged` on a re-run |
| Whether a model exists at all     | `ai.describeAvailability()` (ADR-0057), already declared, not inferred         |
| Who owes whom, and why            | `getBalance` → contributions, settlements, evidence status, pending refunds    |
| Category / trend / own share      | `getCategorySpend`, `getMonthlySpend`, `getOwnSpend`                           |
| Divide an expense                 | `approveAllocation` + `domain.buildAllocationLines` (Largest Remainder)        |

**Four gaps, all of them composition.**

1. **No read or write composes the analysis.** Three services exist; nothing sequences them,
   nothing reports what each one did, and nothing says which stage did not run. → `analyzeRecords`.
2. **`classifyPayments` is all-or-nothing on a model.** Its deterministic leg — self-transfer
   pairing, which is what keeps a credit-card bill payment out of spending — is unreachable
   without a configured provider, because the AI leg runs in the same loop and its failure
   aborts the run. → a `deterministicOnly` mode on the _existing_ service, and one new
   `ClassificationSkipReason`. Not a second classifier.
3. **No read explains one person's balance in events.** `getBalance` returns expense **ids**;
   nothing joins the descriptions, dates and payers a sentence needs. → `getPersonSummary`.
4. **No read previews a split.** `approveAllocation` computes the lines and writes them in one
   transaction, so a screen can only show a split by doing the arithmetic itself — which
   `web/CLAUDE.md` rule 1 forbids. → `previewAllocation`, the same build-and-validate path with
   the write removed, exactly as `getRefundAllocationState` already previews a distribution.

## D — "Analyze records" is one thing a person does

`src/services/analysis-service.ts` → `analyzeRecords(db, { ai, audit, importBatchId? })`, and
`POST /api/analysis`. Three stages, each reported by name and by outcome:

| Stage              | Does                                         | When it cannot run                       |
| ------------------ | -------------------------------------------- | ---------------------------------------- |
| `read_records`     | `normalizePayments`                          | never — deterministic and local          |
| `work_out_purpose` | `classifyPayments`, deterministic leg always | `skipped` with the provider's own reason |
| `connect_records`  | `matchEvidenceContext` per unattached record | never — deterministic and local          |

**It approves nothing.** Every stage calls a service that already refuses to write an
authoritative category, match, duplicate, beneficiary, share, transfer, refund or debt without
a person. The most an analysis can do unattended is fill the question list.

**A stage that could not run says so.** With no `ANTHROPIC_API_KEY`, `work_out_purpose` returns
`skipped` carrying the transport's declared `unavailableReason`, and the _deterministic_ half
still runs: `classifyPayments({ deterministicOnly: true })` pairs self-transfers and reports
every other payment as skipped for `no_model_configured`. A run that partly failed reports
`partial` and names what is still undone. Nothing reads as success that was not.

**Idempotent, because each service already is.** `normalizePayments` acts on `imported` only;
`classifyPayment` skips `already_classified`; `matchEvidenceContext` returns `unchanged` having
written nothing. Running twice over an unchanged ledger changes nothing and says so.

**One action, synchronously.** `enqueueJob` exists but nothing claims a job — there is no
worker loop in this process — so enqueueing would report queued work that never runs. The
analysis therefore runs in the request that asks for it, and the button is offered where a
person already is: on Overview when records are waiting, on `/add`, and on the import screen
the moment an import succeeds. The specialist `/payments` pipeline keeps both its buttons,
under More, for audit and debugging.

`GET /api/overview` gains `readiness: { recordsAwaitingAnalysis, documentsAwaitingAnalysis }`
so Overview can offer the analysis only when there is something to analyse, and so a movement
that has been imported but not analysed is never reported as categorised spending.

## D — people, shares and obligations

- **`/people`** answers three questions and nothing else: _Who should pay me_, _Whom should I
  pay_, _Settled_. From `getOutstandingBalances`, plus a settled list the same read supplies.
- **`/people/[personId]`** is new: `getPersonSummary` composes `getBalance` with the expense
  rows behind it, so every contribution is a sentence — what it was, when, who paid, what this
  person's share is — plus the repayments already netted, and a caveat when a recorded refund
  has not reached the allocation. Direction is `getBalance`'s, so a flatmate who paid is a
  creditor and the user is the debtor, with no assumption either way.
- **`/expenses/[id]/share`** is the destination of _Who shared this expense?_: choose who
  benefited, see the split **the ledger computed**, read the consequence, confirm. Equal is the
  default and the only method on the surface; exact, percentage and item-based sit behind
  _Divide it a different way_. The preview comes from `previewAllocation` — the same
  `domain.buildAllocationLines` the approval runs — and the existing editor stays on
  `/expenses/[id]` untouched.

## D — result screens

- **`GET /api/spending`** composes category, month-by-month, own share, what came back, and the
  unaccounted figure into the one read `/spending` makes. `/analytics` stays where it is.
- **Overview's next step** is chosen from real state: nothing on record → add; records awaiting
  analysis → analyse; questions waiting → answer; otherwise → see what it adds up to.
- **Needs attention** keeps grouping by question with a count, each row independently
  answerable and independently audited. Unknown money stays discoverable from Spending's
  _Payments with no story yet_ and from each connection, and is deliberately not listed as a
  queue row per statement line.

## What D and E do not do

No change to domain arithmetic, invariants, the audit trail or any approval path. No new
dependency, no network call, no model requirement: with no provider configured the whole
journey still works, minus one stage that says so by name.

## What implementation added to phases D and E

Three decisions the audit did not anticipate, each found by looking at a rendered screen:

1. **`deterministicOnly` on `classifyPayments`.** Its self-transfer leg — the rule that keeps a
   credit-card bill payment out of spending — sat behind a model call whose failure aborted the
   whole run. One flag on the existing service, and one new `ClassificationSkipReason`
   (`no_model_configured`), make the deterministic half reachable on the installation this
   product actually ships as. Not a second classifier: the same function, with the leg after it
   turned off.
2. **`noObligationsBecause` on the split preview.** An empty obligation list has two completely
   different causes and one appearance — the payer is the only beneficiary, or the expense is
   recorded `personal`/`gift`, which create no debt by construction. Naming a flatmate on a
   personal expense and watching nothing happen is a screen that looks broken; the API now says
   which of the two it is.
3. **The analysis prompt keys off records, not documents.** A document attached to nothing stays
   that way until a person accepts a match, so a prompt driven by that count would be permanent
   and its button would do nothing new. `documentsAwaitingAnalysis` is still reported; what it
   describes is questions, and Needs attention is where a question belongs.

## Known gaps after D and E

- **Analysis runs in the request.** `enqueueJob` exists and nothing claims a job, so a queued
  run would never happen. The bound is a document limit per pass, and a truncated pass says so
  and asks to be run again. A worker loop is the real fix and is its own piece of work.
- **The share flow cannot change what an expense _is_.** An expense recorded `personal` divides
  without creating a debt, and the screen explains that and links to the expense — it does not
  offer to make it `shared`, which is a different decision about what happened.
- **Groups are advanced-only on the share flow.** Picking a group, and overriding how a group
  line divides among its members, stays on `/expenses/[id]`.
- **`payment_unaccounted` is still connection-only**, deliberately: on a ledger of imported
  statements most rows are unexplained on arrival, and listing each as a queue row would be a
  queue nobody could work through. Spending's _Payments with no story yet_ is the way in.

---

# Phase F — the two halves that were still missing

Recorded as [ADR-0059](../../decisions/0059-a-review-surface-shows-both-halves-of-a-decision.md).
Driving phases A–E on the real ledger found two places where the composition stopped short of
the journey it claimed, and one visual defect that had been there since phase 15.

## What was wrong

1. **`/add` was a menu of links out to the machinery.** Four cards, each leaving for the screen
   that ingests that kind of record — `/payments/import` ("Import a statement", back-link
   _Payments_, a section on "the deterministic step and the model step"), the `Evidence` library
   with its three storage-shaped buttons, the manual form behind a query string on `/payments`.
   Every destination correct; not one of them a place somebody holding a receipt would look.
2. **The review surface could only count down.** `/needs-attention` reported what was open and
   nothing reported what was closed, so a person could answer every question the ledger had and
   never see a decision they had made — which is the only way a wrong one is found.
3. **Reading why, and saying whether, were on different screens.** The connection view explained
   a suggestion in sentences and offered no answer; the answer lived in an inspector built
   around a signal-by-signal table beside a payment named by eight hex digits.

## What phase F built

- **`/add` is the flow.** Five kinds in the reader's words; the form opens in place; each one
  states what adding it does _and does not do_ first. No new write path — every form is the
  existing component behind its existing `DecisionDialog`.
- **`GET /api/links`** (`services.listConfirmedLinks`) — the settled half. `origin` tells an
  accepted offer from a record that arrived attached; `nameSource` says when the only name a
  payment has is the bank's wording. Rendered as **Already connected** under the questions.
- **Approve/decline on the connection view** — `services.decideEvidenceMatch`, the same write,
  behind a dialog in plain words, beside the reasons that argue for it.
- **The inspector leads with what matches and what does not**, with the comparison table one
  disclosure away. Nothing was removed.
- **`Select`'s `className` sizes its wrapper.** Every caller passes a width; the chevron is
  positioned against the wrapper, so a narrowed control left its arrow floating at the far right
  of the row.

## What phase F did not do

No change to domain arithmetic, invariants, the audit trail or any approval path. No new
dependency, no network or AI call, no new route removed or renamed. The specialist screens are
untouched and still reachable from More.
