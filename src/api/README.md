# src/api

Thin HTTP/API layer (Next.js route handlers / server actions, per
`docs/architecture/system-architecture.md`).

**Owns:** request validation, calling the appropriate `src/services` function, response
serialization. Nothing else.

**Depends on:** `src/services`.

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

Handlers are Web `Request → Response` functions — precisely a Next.js App Router route
handler's signature — so mounting them under `app/api/<route>/route.ts` later is a re-export, not a
rewrite. **No framework is installed** to serve four routes before any UI exists (ADR-0032).
`createReviewApi({ db, ai })` builds the surface over its dependencies and exposes both the
route table and a small exact-segment dispatcher, which is what the integration tests drive.

Three things this layer does that look like rules but are translations:

- **Status mapping.** `DECISION_ACTOR_INVALID → 403`, `INVALID_STATE_TRANSITION → 409`,
  `PRECONDITION_FAILED → 409`, `ENTITY_NOT_FOUND → 404`, an `AiContractError → 422`, anything
  unrecognised → a bare 500 with no detail (`security-model.md`). The codes are raised by
  `src/domain` and `src/services`; this only chooses the number.
- **Money serialization.** Every amount crosses as an exact decimal **string** of minor units.
  `JSON.stringify` cannot represent a `bigint`, and must never represent money as a `number`
  (`invariants.md` #12).
- **UUID validation.** `domain/ids.ts` says "persistence and API boundaries are where UUID
  shape is checked" — so a malformed path segment is a 400 here, not a failed cast deeper down.

`actor` arrives in the request body because there is no session yet
(`system-architecture.md`). It is not trusted: `domain.parseDecisionActor` rejects `ai` and
`system` inside the service, so this layer cannot manufacture an unattributable decision.

**Not implemented:** any UI, any server process (nothing listens on a port yet), auth, and any
route outside the review surface.
