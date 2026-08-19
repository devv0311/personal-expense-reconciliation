# 0032. The API ships as Web-standard route handlers, without installing Next.js yet

**Status:** Accepted

## Context

`system-architecture.md` names Next.js (App Router) as the application framework, chosen so that
"API routes now and UI later" live in one deployable. Phase 9 is the first phase that needs an
API at all: a review queue nobody can call is a service, not a capability.

Two facts shaped the decision.

First, **there is no Next.js in this repository.** `package.json` has `drizzle-orm` and `pg` as
its only runtime dependencies. Installing Next.js means React, a build step, a `next.config`, JSX
in `tsconfig`, new lint configuration, and a CI step to build it — to serve four routes, in a
repository whose roadmap explicitly defers UI ("Do not invest in UI polish until the domain and
financial engine are solid").

Second, **a Next.js App Router route handler is not a framework object.** It is a function
`(request: Request) => Promise<Response>` over Web standards. Node 20 has `Request`/`Response` as
globals and the existing `@types/node` types them — verified before this was decided, not
assumed.

## Decision

**`src/api` ships exactly that signature, and no framework.**

```ts
export async function getReviewQueue(deps, request: Request): Promise<Response>;
```

Plus `createReviewApi({ db, ai })`, which exposes the route table and a ~40-line exact-segment
dispatcher (`:name` captures, no wildcards, no precedence rules) so tests — and later a server —
can send a real `Request` and get a real `Response`.

When the UI phase arrives, mounting these is mechanical: `app/api/review/route.ts` becomes

```ts
export const GET = (request: Request) => api.handle(request);
```

and the dispatcher stops being on the path. Nothing about the handlers changes, because they were
never Next.js-specific in the first place.

**The layer stays thin, structurally.** Handlers validate (UUID shape, required fields, enum
membership), call exactly one service, and serialize. No ordering, no state transitions, no
database access, no AI call — `src/api` imports `src/services`, `src/domain`'s types and
`src/ai`'s validator error, and nothing else. Status mapping is a translation of typed error
codes the lower layers already raise, which is why it can live here without becoming logic:
`DECISION_ACTOR_INVALID → 403`, `INVALID_STATE_TRANSITION → 409`, `PRECONDITION_FAILED → 409`,
`ENTITY_NOT_FOUND → 404`, an `AiContractError` → 422, anything unrecognised → a bare 500 with no
detail (`security-model.md`).

**Money crosses the wire as an exact decimal string of minor units.** `JSON.stringify` cannot
represent a `bigint` at all, and the one thing it must never do is represent money as a
`number` (`invariants.md` #12).

**The actor arrives in the request body**, because this system has no session yet
(`system-architecture.md`: "minimal, single-user session auth (deferred implementation)"). It is
not trusted: `domain.parseDecisionActor` rejects `ai` and `system` inside the service, so the
transport cannot manufacture an unattributable decision. When auth lands, the actor comes from
the session and the field goes away — a change to four handlers, not to the review model.

## Consequences

**No new dependency, no build step, no framework config**, and the surface is fully testable:
`tests/integration/review-api.test.ts` sends real `Request`s through the real router into the
real services against a real database.

**Deferring Next.js stays cheap**, and choosing something else later stays cheap too — a Fastify
or Hono adapter is the same one-line-per-route mount. That is precisely the swappability
`system-architecture.md` claimed for the framework choice, now demonstrated rather than asserted.

**There is no server process.** Nothing listens on a port in this repository yet; the API is a
library of handlers plus a dispatcher. Starting a server is a deployment decision the roadmap has
not reached.

**Two routes that could exist do not.** There is no per-item detail endpoint, because the list
already carries the full proposal, the payment and the expense — a detail route would return a
subset of what the caller has. And there is no `PATCH`/`PUT` on any entity, because every
financially consequential change goes through a named review action.

## Alternatives considered

- **Install Next.js now and write real `app/api/<route>/route.ts` files.** The literal reading of the
  architecture doc. Rejected as infrastructure ahead of need: a framework, a React tree and a
  build step to serve four handlers, in the phase before any UI exists. The code written here is
  what those files would contain anyway.
- **Install a small HTTP framework (Fastify, Hono) instead.** Rejected: it contradicts the
  documented framework choice for no gain, and its routing is the only thing this needs — which
  is forty lines.
- **Expose the services directly and skip the API entirely.** Rejected: the phase's own bar is
  that the review capability is usable by a future UI, and "call these TypeScript functions from
  your React server component" is not a surface a client can be written against.
- **Put the actor in a header (`X-Actor`) rather than the body.** Rejected as a distinction
  without a difference while there is no auth: both are client-supplied, and the body keeps the
  whole decision in one validated object. The real fix is a session, which is a separate phase.
