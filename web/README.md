# web/ — the reconciliation UI

A standalone Next.js (App Router) application: the first production frontend for this project
(`docs/roadmap.md` phase 15). It is its own package — own `package.json`, own lockfile, own
`tsconfig.json`/`eslint.config.mjs`/`.prettierrc.json` — deliberately isolated from the root
repository's own gate. See `docs/decisions/0042-frontend-stack-and-server-bridge.md` for why.

**This app never imports anything from `../src`.** It talks to the real API over `fetch`, the
same way any other client would — see `src/lib/api.ts`, the one place a request leaves this
package. There is no financial arithmetic anywhere in `web/`: every number rendered is exactly
what the API already computed, and `src/lib/money.ts` formats it (in exact `BigInt` arithmetic,
never a `Number`) without ever recomputing it.

## Stack

- **Next.js 16** (App Router), chosen because `src/api/router.ts`'s own handlers already speak
  the Web `Request`/`Response` signature a Next.js route handler uses.
- **Tailwind CSS 4** for styling.
- **TanStack Query** for all server state — loading/error/empty/success are handled explicitly
  per screen (`src/components/status.tsx`), never assumed away.
- **IBM Plex Sans** (UI/prose) + **IBM Plex Mono** (every number, id, state tag) — the mono face
  is load-bearing, not decorative: money needs tabular-aligned digits to scan as a ledger.

## Running it

Two processes, from the repository root:

```bash
# 1. Seed a believable synthetic scenario (once, or after wiping local-data/)
npx tsx scripts/seed-dev-data.ts

# 2. The API
npx tsx src/server.ts          # http://localhost:4000 by default; PORT to change it

# 3. The UI, in a second terminal
cd web && npm install && npm run dev   # http://localhost:3000
```

Set `web/.env.local` (copy `.env.local.example`) if the API isn't on the default port —
`NEXT_PUBLIC_API_BASE_URL`. `src/server.ts`'s CORS origin defaults to `http://localhost:3000`;
set `CORS_ORIGIN` if the UI runs somewhere else.

Neither process connects to a real bank, card, AI provider, or Splitwise account —
`src/server.ts`'s `ai`/`splitwise` dependencies are unconfigured stubs (`CLAUDE.md`).

## Verifying

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format:check
npm test            # vitest run
npm run build       # next build — also type-checks and generates route types
```

## Structure

```
src/app/            App Router pages: reconciliation, balances, expenses
src/components/     Presentational + a few page-adjacent components
src/lib/api.ts       The only fetch boundary — typed, no business logic
src/lib/queries.ts   TanStack Query hooks over api.ts
src/lib/money.ts     Paise (string) → display string, exact BigInt arithmetic
src/lib/types.ts     DTOs matching the API's JSON responses exactly
src/test-support/    Test-only helpers (a QueryClient-wrapped render)
```

## What this phase's UI covers, and what it doesn't

Covers: reconciliation (run a period, see the outflow/transfers/investments/settlements/
explained/unexplained breakdown, Splitwise discrepancies, history), balances (pairwise
`NetBalance` + evidence status + contributing obligations), the expense ledger (filterable
list). Deliberately out of scope for this phase, per the design spec
(`docs/superpowers/specs/2026-09-04-phase-15-reconciliation-design.md`): review/evidence/receipts
screens (phases 9–11's own surfaces), re-syncing a `stale` Splitwise expense, resolving a
discrepancy, and frontend CI.
