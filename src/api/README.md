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

| Route                                                  | Service                   |
| ------------------------------------------------------ | ------------------------- |
| `POST /api/expenses/:expenseId/items`                  | `recordExpenseItems`      |
| `GET /api/expenses/:expenseId/items`                   | `getExpenseItems`         |
| `POST /api/expenses/:expenseId/allocation`             | `approveAllocation`       |
| `POST /api/expenses/:expenseId/adjustments`            | `recordExpenseAdjustment` |
| `POST /api/expenses/:expenseId/adjustments/distribute` | `distributeAdjustment`    |
| `POST /api/payments/:paymentId/settlements`            | `recordSettlement`        |

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
handler's signature — so mounting them under `app/api/<route>/route.ts` later is a re-export, not a
rewrite. **No framework is installed** to serve these routes before any UI exists (ADR-0032).
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

**Not implemented:** any UI, any server process (nothing listens on a port yet), auth, and any
route outside the review, evidence, receipt, allocation, ledger and Splitwise surfaces —
including `runReconciliation` and `fetchBalances`-driven drift/stale-resync routes, deliberately
deferred to phase 15 (see phase 13 and phase 14 above).
