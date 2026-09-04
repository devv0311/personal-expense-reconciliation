# 0042. Frontend stack, and a real process to run the API behind it

**Status:** Accepted

## Context

`docs/roadmap.md`'s "done" criteria have carried _"No UI exists beyond what a future framework
choice mandates as a placeholder"_ since phase 1, unrevised until now. This phase's brief makes
the UI a first-class deliverable for the first time, explicitly instructing that the stack not be
prescribed in advance but chosen by inspecting the repository.

Two things are true of the repository as it stands:

1. **`src/api`'s handlers are already Next.js App Router route handlers in every way but the
   file location.** `router.ts`'s own docstring says so: _"Handlers are Web `Request → Response`
   functions, which is precisely a Next.js App Router route handler's signature... Next.js does
   this job from the filesystem when the UI phase arrives, at which point each route becomes a
   one-line re-export and this file stops being on the path (ADR-0032)."_ ADR-0032 itself,
   choosing to ship the API without a framework, was explicit that this was a *staging* decision,
   not a rejection of Next.js.
2. **There is still no way to run this API as a live process.** `createApi(deps).handle(request)`
   is called directly by tests and by nothing else — there is no `server.ts`, no `bin/`, no
   listener. `src/ai` and `src/integrations/splitwise` both ship a port with zero concrete
   adapters (ADR-0025, ADR-0040) — deliberately, since `CLAUDE.md` forbids real credentials in
   development. A UI that must "use the real API" needs a process serving it first.

## Decision

### Frontend: Next.js (App Router), TypeScript, Tailwind CSS, TanStack Query

- **Next.js** — chosen because the codebase already telegraphs it (§ above), it is the current
  industry-standard React meta-framework, and mounting the existing 28 route handlers under it
  is close to the "one-line re-export" the router's own docstring predicted (§ "Server bridge"
  below explains why it ends up as one catch-all route instead of 28 individual ones).
- **TypeScript**, matching the rest of the repository, with its own `web/tsconfig.json` (see
  "Isolation" below for why it is not the root `tsconfig.json`).
- **Tailwind CSS** for styling — utility-first, no runtime cost, fast to keep visually consistent
  across a data-dense financial UI without hand-rolling a component library.
- **TanStack Query** for server-state (loading/error/success/refetch/cache), rather than rolling
  bespoke `useEffect`+`useState` data fetching or a heavier global-state library this app's read-
  mostly, server-owned data doesn't need.
- **No AI SDK, no Splitwise SDK, no auth library.** Nothing in this phase's UI triggers an AI
  operation or a real Splitwise call — `CLAUDE.md`'s boundaries rule out both regardless.

### Server bridge: a real Node process wrapping `createApi`, no framework added to `src/`

`src/server.ts` — a ~60-line adapter using only Node's built-in `node:http` and the platform's
`Request`/`Response`/`Headers` (global since Node 18, used here on Node 20+ per the repo's
`engines` field) to translate an `IncomingMessage` into a `Request`, call
`createApi(deps).handle(request)`, and stream the `Response` back. This is **not** a second
routing layer — `API_ROUTES` in `router.ts` remains the only table of what exists; `server.ts`
exists only to give that dispatcher a socket to listen on. It composes real `ApiDependencies`:

- `db` — `openDatabase(process.env.DATABASE_URL)` (existing, unchanged — the same PGlite fallback
  the test suite uses when no `DATABASE_URL` is set, so the app runs with zero setup).
- `evidenceStore` — `createFilesystemEvidenceStore({ root: process.env.EVIDENCE_STORAGE_PATH ?? ... })`
  (existing, unchanged, ADR-0033).
- `ai`/`splitwise` — **unconfigured stubs, defined privately inside `server.ts` itself**, whose
  methods reject with a clear "not configured in this environment" `Error`. Not exported, not
  placed under `src/ai/` or `src/integrations/splitwise/`, specifically so neither of those
  modules' own "no adapter ships here" documentation (ADR-0025, ADR-0040/port.ts) becomes
  false. This phase's UI never exercises either path (no classification, no allocation
  suggestion, no real sync trigger), so the stub only needs to exist and type-check, not behave.

This keeps ADR-0032's actual point intact — *no HTTP framework is added to `src/`* — while
finally giving the dispatcher it already built a process to run in. `router.ts`'s docstring is
updated in this pass to say so, rather than continuing to describe a hypothetical.

### Why `web/` is a separate, self-contained package, not an npm workspace

`web/` gets its own `package.json`, its own `node_modules` (via its own `npm install`), and its
own `tsconfig.json`/`eslint.config.js`/test setup, rather than folding into the root
`package.json` as an npm workspace. Two reasons:

1. **The mandated backend gate must keep working exactly as specified**, unmodified:
   `npm run typecheck && npm run lint && npm run format:check && npm run db:check && npm test`.
   Root `tsconfig.json`'s `include` is `["src", "tests"]` — already excludes `web/` — so
   `npm run typecheck` is untouched by construction. `eslint.config.js`'s `ignores` gains one
   entry, `web/**`, so `npm run lint` is untouched too (Next.js projects use their own, React/
   JSX-aware ESLint config — `typescript-eslint`'s backend rule set, e.g.
   `no-floating-promises` tuned for Drizzle transactions, isn't the right rule set for React
   components either). `.prettierignore` is deliberately **not** changed — Prettier needs no
   project-specific type information, so `npm run format:check` (`prettier --check .`) checking
   `web/` too costs nothing and keeps one formatting standard across the whole repository.
2. **Avoids cross-project TypeScript resolution risk for no real benefit.** `web/` never imports
   from `src/`; it only calls the HTTP server `server.ts` exposes, over `fetch`, the same way any
   other client of this API would. That is what "the UI must use the real API" in this phase's
   brief actually means: the browser talks to the API over HTTP, not to `src/services` by direct
   import. Nothing about a shared workspace would have made the UI "more real."

### Running it locally

Two processes: `npx tsx src/server.ts` (the API, `PORT` env var, default `4000`) and
`cd web && npm run dev` (Next.js, port `3000`, `NEXT_PUBLIC_API_BASE_URL` pointing at the first).
Documented in `web/README.md` and the root `README`-equivalent (`docs/architecture/
system-architecture.md`).

## Consequences

- The API can now be exercised by something other than a test for the first time in this
  project's history — a real, if deliberately minimal, deployment shape.
- `web/` has its own lockfile and its own install step; CI (`.github/workflows/ci.yml`) is
  **not** changed in this phase to add a frontend job — the mandated gate is backend-only, and
  wiring frontend CI is a reasonable, separately-scoped follow-up (noted in `roadmap.md`), not
  silently skipped.
- Because `server.ts`'s `ai`/`splitwise` are stubs, any future phase that needs the UI to
  exercise an AI or Splitwise flow for real must first make a deliberate adapter decision
  (ADR-0025/ADR-0040 both already say this explicitly) — this phase does not quietly pre-empt
  that by making the stub "work well enough" to hide the gap.
- `router.ts`'s docstring, which predicted this exact moment, is corrected to describe what
  actually shipped rather than continuing to describe a hypothetical future.

## Alternatives considered

1. **Import `src/api`/`src/services` directly into Next.js Route Handlers**, skipping a
   standalone server process. Rejected: `src/`'s `tsconfig.json` uses `NodeNext` module
   resolution with explicit `.js`-suffixed relative imports; Next.js's own compiler uses
   `moduleResolution: "bundler"`. Mixing them is possible but fragile (two different compilers
   type-checking the same source under different settings, in-place), and it would mean the
   "real API" claim rests on the UI never actually crossing a network boundary — a weaker
   demonstration of "the real API" than an actual HTTP call, and one that silently breaks the
   "domain logic must not import from api or integrations" dependency direction the moment a
   frontend file imports something two layers too deep out of convenience.
2. **A different meta-framework (Remix, SvelteKit, plain Vite SPA).** Rejected: the codebase's
   own router already describes Next.js specifically (ADR-0032), and Next.js is the most
   widely-adopted choice for this shape of app today, with first-party TanStack Query support
   and no unusual integration work.
3. **Express/Fastify for the server bridge**, instead of raw `node:http`. Rejected: the handlers
   already speak `Request`/`Response` natively; a framework would add a dependency and a second
   routing concept purely to convert between two shapes Node's own platform APIs already convert
   between in about a dozen lines. Consistent with ADR-0032's original reasoning applied to one
   more layer.
4. **npm workspaces**, folding `web/` into the root `package.json`. Rejected for the reasons in
   "Why `web/` is a separate package" above — real risk to the mandated gate for no capability
   this app actually needs (`web/` never imports `src/` code).
