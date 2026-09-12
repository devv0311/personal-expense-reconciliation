# src/api

Thin HTTP/API layer (Next.js route handlers / server actions, per
`docs/architecture/system-architecture.md`).

**Owns:** request validation, calling the appropriate `src/services` function, response
serialization. Nothing else.

**Depends on:** `src/services` — including the `Database`, `AiService`, `EvidenceStore` and
`SplitwisePort` handles it merely passes through, which are re-exported there so this layer
never reaches past it into `src/db`, `src/ai`, or `src/integrations`.
The one exception is `isAiContractError`, imported from `src/ai` because mapping an error to a
status code means recognising which family it came from.

**Rule:** no business logic, no direct database access, no direct AI calls. If a route handler
needs an `if` statement more complex than routing/validation, that logic belongs in
`src/services` instead.

**Implemented (phase 9): the review surface.**

| Route                                               | Service                                                 |
| --------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/review`                                   | `listReviewQueue`                                       |
| `POST /api/review/inferences/:inferenceId/decision` | `decideInference` (accept / modify / reject)            |
| `POST /api/review/payments/:paymentId/reclassify`   | `reclassifyPayment`                                     |
| `POST /api/review/payments/:paymentId/duplicate`    | `confirmPossibleDuplicate` / `dismissPossibleDuplicate` |

**Implemented (phase 10): evidence ingestion.**

| Route                                   | Service                  |
| --------------------------------------- | ------------------------ |
| `POST /api/evidence/files`              | `ingestEvidenceDocument` |
| `POST /api/evidence/notes`              | `recordManualNote`       |
| `POST /api/evidence/:evidenceId/link`   | `linkEvidence`           |
| `GET /api/evidence/:evidenceId`         | `getEvidence`            |
| `GET /api/evidence/:evidenceId/content` | `readEvidenceDocument`   |

The upload is `multipart/form-data` read through `Request.formData()`, which is a web standard
— so it stays a plain handler and still no framework is installed (ADR-0032). The content route
is the one response here that is not JSON; it sets `nosniff`, because the body is a file
somebody uploaded.

**Implemented (phase 11): receipt extraction.**

| Route                                    | Service          |
| ---------------------------------------- | ---------------- |
| `POST /api/evidence/:evidenceId/receipt` | `extractReceipt` |
| `POST /api/receipts/:receiptId/confirm`  | `confirmReceipt` |
| `POST /api/receipts/:receiptId/correct`  | `correctReceipt` |
| `GET /api/receipts/:receiptId`           | `getReceipt`     |

A rejected extraction (the model's answer was not usable) is a 422 naming its `code`; an
ineligible or already-extracted evidence row is a `ServiceError`, mapped the same way every
other precondition failure is. `optionalMinorUnitsField` (`http.ts`) distinguishes a
correction field left out of the body (unchanged) from one sent as `null` (cleared).

**Implemented (phase 12): allocation, adjustments, settlement.**

| Route                                                  | Service                    |
| ------------------------------------------------------ | -------------------------- |
| `POST /api/expenses/:expenseId/items`                  | `recordExpenseItems`       |
| `GET /api/expenses/:expenseId/items`                   | `getExpenseItems`          |
| `POST /api/expenses/:expenseId/allocation`             | `approveAllocation`        |
| `POST /api/expenses/:expenseId/adjustments`            | `recordExpenseAdjustment`  |
| `POST /api/expenses/:expenseId/adjustments/distribute` | `distributeAdjustment`     |
| `POST /api/payments/:paymentId/settlements`            | `recordSettlement`         |
| `GET /api/expenses/:expenseId/refund-allocation`       | `getRefundAllocationState` |

These service functions predate this phase (the 2026-08-14 foundation pass) — phase 12 is
their first caller from this layer, the same gap phases 9–11 each closed for their own service.
The settlement route is a **second**, independent path alongside `decideInference`'s existing
one: a human explicitly settling a payment classification never flagged as one. `getBalance`/
`runReconciliation` stay unexposed — `roadmap.md` assigns those to phases 13 and 15.

**Implemented (phase 13): the expense ledger.**

| Route                                     | Service        |
| ----------------------------------------- | -------------- |
| `GET /api/expenses`                       | `listExpenses` |
| `GET /api/balances/:personAId/:personBId` | `getBalance`   |

`listExpenses` is the one genuinely new service this phase adds; `getBalance` predates it (the
2026-08-14 foundation pass, ADR-0038) and this is its first `src/api` caller. Query parameters
on `GET /api/expenses` (`state`, `paidBy`, `limit`) are all optional — omitting `state` returns
every state, not only `approved`, since "querying/reporting over approved expenses" describes
the typical read, not a hidden filter a caller cannot override. `GET /api/balances/…` resolves
`userPersonId` through `requireUserPersonId` rather than accepting it from the request; neither
path person needs to be the user. `runReconciliation` still stays unexposed — `roadmap.md`
assigns it to phase 15 (ADR-0039).

**Implemented (phase 14): connecting to, and syncing with, Splitwise.**

| Route                                                | Service                       |
| ---------------------------------------------------- | ----------------------------- |
| `POST /api/integrations/splitwise/connect`           | `connectSplitwiseIntegration` |
| `POST /api/expenses/:expenseId/ready-to-sync`        | `transitionExpense`           |
| `POST /api/expenses/:expenseId/splitwise-sync`       | `syncExpenseToSplitwise`      |
| `POST /api/settlements/:settlementId/splitwise-sync` | `syncSettlementToSplitwise`   |

The `ready-to-sync` route is the first `src/api` caller for `transitionExpense`, unchanged
since it was built (phase 9 era) — reused, not new lifecycle logic. The two sync routes build
the payload and call the injected `SplitwisePort` in one request; there is no separate preview
route, since `data-flow.md` says no AI proposal sits on this path to review the way
`decideInference` reviews one (ADR-0040). `createApi` takes a `splitwise: SplitwisePort`
dependency alongside `db`/`ai`/`evidenceStore`; no concrete adapter is wired (ADR-0025's
precedent), so a test injects an in-memory mock.

Handlers are Web `Request → Response` functions — precisely a Next.js App Router route
handler's signature. `../server.ts` (phase 15, ADR-0042) is what actually runs this dispatcher
now: a plain `node:http` + `Request`/`Response` bridge over `createApi(deps).handle`, no
framework added here — `web/` (also phase 15) calls it over `fetch`, the same way any other
client of this API would, rather than importing anything from `src/`.
`createApi({ db, ai, evidenceStore, splitwise })` builds the surface over its dependencies and
exposes both the route table and a small exact-segment dispatcher, which is what the
integration tests drive. The first pattern that matches a path owns it, so a wrong verb on a
known path is a 405 rather than a 400 from whichever capture route swallowed it.

Three things this layer does that look like rules but are translations:

- **Status mapping.** `DECISION_ACTOR_INVALID → 403`, `INVALID_STATE_TRANSITION → 409`,
  `PRECONDITION_FAILED → 409`, `ENTITY_NOT_FOUND → 404`, `EVIDENCE_DOCUMENT_TOO_LARGE → 413`,
  `EVIDENCE_STORE_UNAVAILABLE → 503`, `SPLITWISE_SYNC_FAILED → 502`, an `AiContractError → 422`,
  anything unrecognised → a bare 500 with no detail (`security-model.md`). The codes are raised
  by `src/domain` and `src/services`; this only chooses the number.
- **Money serialization.** Every amount crosses as an exact decimal **string** of minor units.
  `JSON.stringify` cannot represent a `bigint`, and must never represent money as a `number`
  (`invariants.md` #12).
- **UUID validation.** `domain/ids.ts` says "persistence and API boundaries are where UUID
  shape is checked" — so a malformed path segment is a 400 here, not a failed cast deeper down.

`actor` arrives in the request body because there is no session yet
(`system-architecture.md`). It is not trusted: `domain.parseDecisionActor` rejects `ai` and
`system` inside the service, so this layer cannot manufacture an unattributable decision. The
evidence routes check the same thing at the edge instead — ingestion is not an `AIInference`
decision, so `parseDecisionActor` does not apply to it, but an upload arriving over HTTP is
still a person's act and `system` would be an answer nobody can check.

**Implemented (phase 17): context re-attachment.**

| Route                                              | Service                      |
| -------------------------------------------------- | ---------------------------- |
| `POST /api/evidence/notifications`                 | `recordEvidenceNotification` |
| `POST /api/evidence/:evidenceId/observation`       | `recordEvidenceObservation`  |
| `POST /api/evidence/:evidenceId/enrich`            | `matchEvidenceContext`       |
| `GET /api/evidence/:evidenceId/matches`            | `listEvidenceMatches`        |
| `POST /api/evidence/matches/:candidateId/decision` | `decideEvidenceMatch`        |
| `GET /api/payments/:paymentId/context`             | `getPaymentContext`          |

`POST .../enrich` never produces a link, however strong the match: the only route that reaches
`evidence.linked_payment_id` besides `POST /api/evidence/:evidenceId/link` is the match decision
with `accept`, and it fails with the same `EVIDENCE_LINK_IMMUTABLE` (422) when the evidence
already has a home (ADR-0034/0044). Enrichment is idempotent over HTTP as well — a second call
answers `outcome: "unchanged"` having written nothing.

`/api/evidence/notifications` and `/api/evidence/matches/:candidateId/decision` are listed before
`/api/evidence/:evidenceId` in the route table, so the literal segments are not read as ids —
the same one ordering rule `files` and `notes` already carried.

**Phase 15 (ADR-0041, ADR-0042) added:** `POST`/`GET /api/reconciliation/runs`,
`GET /api/reconciliation/runs/:id` — `services.runReconciliation`'s first `src/api` caller,
deferred here since phase 13 — and `GET /api/people` (`services.listPeople`), the roster
`web/` needed and no earlier phase had a caller for. `../server.ts` is the first real process
serving this dispatcher; `web/` is the first UI calling it.

**Phase 18 (ADR-0018 (item refunds), ADR-0045) added:** `GET
/api/expenses/:expenseId/refund-allocation` (`services.getRefundAllocationState`) and an
`itemAttributions` body field on `POST /api/expenses/:expenseId/adjustments` — the complete
`{ expenseItemId, amount }` set for a refund whose items are known, which Phase 16's service
had accepted since it shipped but no route had yet passed through. Omitting the field records
ADR-0008's whole-expense refund; sending an **empty array** is a 400, because "this refund
covers these items" with none named is a malformed proposal rather than a shorter way of saying
"no items". Amounts are decimal-string minor units like every other money field. The `GET` is a
pure read that runs the same engine a distribution would, so its `projectedLines` are what
approval will write, and its `reviewRequired` is why it could not be — a pending decision
reported rather than an error thrown.

**Phase 19 (ADR-0046) added** six routes under `/api/splitwise`:
`POST`/`GET /api/splitwise/audits`, `GET /api/splitwise/audits/:id`,
`GET /api/splitwise/audit-findings`, `GET /api/splitwise/audit-findings/:id` and
`POST /api/splitwise/audit-findings/:id/review`. Every one is a read or a recorded decision —
**none writes to Splitwise, and the review route in particular does not**: accepting a finding
records what a person concluded, never an instruction to correct either ledger. `POST
/api/splitwise/audits` is safe to call repeatedly, because an unchanged rerun re-observes the
findings already on record instead of duplicating them. The list route excludes superseded
findings unless `?includeSuperseded=true` asks for them — they are preserved, not hidden, and
reading them back is how what an earlier comparison said stays available after a later one
replaced it. `decision` is `acknowledged | resolved | dismissed`; the last two require a
`reason` (a 409, from the service, not a 400 — the request is well-formed, the state it asks
for is not), and the actor must be a person, never `system` or a rule (`invariants.md` #17).

**Phase 20 (ADR-0047) added** one route: `GET /api/proof-packs/:recipientPersonId`. It derives a
recipient-specific proof pack from approved ledger state and returns the preview — the intended
recipient, the WhatsApp-ready text, the selected evidence references, an explicit `asOf` label
(`?asOf=<ISO-8601>`, defaulting to now) and every uncertainty as a warning. A **GET**, because
it is a pure read with no side effect: nothing is sent, no settlement is recorded, no row is
written. `userPersonId` is resolved from the single `User` row, never from the request; a pack
for the user themselves is a 409, an unknown or archived recipient a 404. If redaction leaves an
identifier the boundary refuses to export, the whole pack fails closed with a `500
PAYLOAD_NOT_SANITIZED` rather than returning a partially-redacted body.

**Phase 21 (ADR-0048) added** four reads and one request field, and deliberately nothing else.
The UI needed figures that had no HTTP surface, and the decision was that the _read_ comes here
rather than the arithmetic going into the browser:

- `GET /api/accounts` — the account roster a per-account waterfall names, so a screen shows
  "HDFC Savings · ends 4821" rather than a UUID. `last4` is the only identifying fragment the
  schema stores at all.
- `GET /api/expenses/:expenseId` — one row of the existing ledger listing, implemented as that
  listing with an id filter, so a detail screen and the row that linked to it can never quote two
  different `netAmount`s. 404 for an unknown id, 400 for a non-UUID.
- `GET /api/reconciliation/runs/:id/account-snapshots` — ADR-0017 (cash balance)'s second
  identity per account, exactly as `runReconciliation` stored it: evidenced boundaries, gross
  debit/credit totals, the internal-transfer and explained/unexplained subsets, the expected
  closing balance, the signed delta, the verification status and the discrepancies. A run with
  no snapshots returns an empty list, which is **not** the same fact as a zero delta; an unknown
  run is a 404.
- `GET /api/evidence/:evidenceId/observation` — the recorded structured reading of one document,
  or `null`. Added because the only way to obtain one was to re-run the matcher (a `POST`),
  which is the wrong verb for opening an inspector.
- `accountBoundaries` on `POST /api/reconciliation/runs` — `[{ accountId, openingBalance?,
openingBalanceEvidenceId?, closingBalance?, closingBalanceEvidenceId? }]`. Balances are
  **signed** minor-unit decimal strings, because an overdraft is a real balance and ADR-0017
  clamps nothing. Three refusals are the point: an **empty array** is a 400 (it reads like a
  claim about accounts it does not name, where omitting the field says nothing has been
  confirmed), a **balance with no evidence id** is a 400 (17.5 — "a balance with no evidence is
  a number somebody typed"), and **two entries for one account** is a 400. Omit an account and
  its snapshot comes back honestly `incomplete` rather than closing at a cosmetic zero.

**Phase 22 (ADR-0050) added the routes an audit found missing**, and one read: `receiptId` on
`GET /api/evidence/:evidenceId`, a pointer to the extraction a document produced, so an
inspector reached from the evidence library can open the receipt at all. Everything else added
in that phase — master data, statement import, the payment workspace, expense authoring and
funding links, history, sessions, rules, analytics, occasions and jobs — is documented in its
own route file's header comment, and all of it is a caller of services that already existed.

**Reading a Splitwise-side change (ADR-0056)** is now five routes — discover, list, read one,
decide, and the read history. They write no figure: accepting a change records what Splitwise
holds on a sync row, closes it as `externally_deleted`, joins two ids, or maps a Splitwise
account to an existing `Person`. Making a remote figure true in this ledger is still an
`ExpenseAdjustment` a person records with evidence.

**Asking the ledger a question (ADR-0057)** is two: `GET /api/ask/capabilities` and
`POST /api/ask`. The POST carries a question in a body and takes **no `actor`**, because nothing
happened to attribute — the service it calls imports no writer.

**Still not implemented:** resolving a `ReconciliationDiscrepancy` on a `ReconciliationRun`
(phase 19's reviewable record is the audit finding). Authentication, the single-row Splitwise
re-sync, a proof-pack send route (ADR-0053), the repair writes against Splitwise (ADR-0055) and
reading their side back (ADR-0056) were all listed here as missing through phase 21 and now
exist.

There is no general delete route against Splitwise. `POST
/api/expenses/:expenseId/splitwise-resync` withdraws an entry in exactly one case — an expense
whose net has reached zero, which Splitwise cannot represent — and never to tidy an audit.
