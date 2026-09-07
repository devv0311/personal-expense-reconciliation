# web/ — the reconciliation UI

A standalone Next.js (App Router) application: the production frontend for this project
(`docs/roadmap.md` phases 15 and 21). It is its own package — own `package.json`, own lockfile,
own `tsconfig.json`/`eslint.config.mjs`/`.prettierrc.json` — deliberately isolated from the root
repository's own gate. See `docs/decisions/0042-frontend-stack-and-server-bridge.md` for why.

**Since phase 21 this covers all six of `CLAUDE.md`'s pillars**, across six sections and five
detail screens. The one rule that shapes all of it: `web/` renders financial figures and never
derives them — see `docs/decisions/0048-phase-21-ui-reads-the-ledger-and-never-recomputes-it.md`.

**See `Design.md` before making a visual or component change** — it's the authoritative design
system (tokens, typography, component principles, accessibility/responsive rules), written during
a dedicated design pass after phase 15 shipped functional-but-unpolished screens
(`docs/decisions/0043-frontend-design-system-and-component-primitives.md`).

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
- **`src/components/ui/`** — a small, hand-owned primitive layer (button, table, alert, skeleton,
  styled-native select/input/label) in shadcn/ui's authoring style, without shadcn's CLI or Radix
  as a dependency. `class-variance-authority` + `clsx` + `tailwind-merge` are the only
  dependencies it added. See `Design.md` and ADR-0043.

Requires Node.js 22.22.2+ for the web test toolchain (the backend remains Node 20+).

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
npm run typecheck   # next typegen && tsc --noEmit
npm run lint        # eslint
npm run format:check
npm test            # vitest run
npm run build       # next build — also type-checks and generates route types
```

## Structure

```
src/app/                      App Router pages — the six sections plus five detail routes:
                              /review  /reconciliation  /reconciliation/[id]  /expenses
                              /expenses/[id]  /balances  /splitwise
                              /splitwise/findings/[id]  /proof-packs
                              /evidence/[id]  /payments/[id]
src/components/app-shell/     The shell: keyboard layer, command palette, shortcut help, nav
src/components/review/        The triage queue, its inspectors, and DecisionDialog
src/components/evidence/      Evidence inspector, observation, match candidates, payment context
src/components/expenses/      Expense detail, the item-refund splitter, the distribution panel
src/components/reconciliation/  The account cash waterfall
src/components/splitwise/     Audit findings list, external-read banner, finding detail
src/components/proof-packs/   The preview and its export review
src/components/ui/            Hand-owned primitives (button, table, alert, skeleton, select,
                              input, label, textarea, dialog)
src/lib/api.ts       The only fetch boundary — typed, no business logic
src/lib/queries.ts   TanStack Query hooks over api.ts
src/lib/money.ts     Paise (string) → display string, and typed rupees → exact paise. All BigInt
src/lib/labels.ts    Human wording for the API's closed enums; falls back to the raw value
src/lib/types.ts     DTOs matching the API's JSON responses exactly
src/lib/utils.ts     cn() — the tailwind-merge config every custom token must be registered in
src/test-support/    Test-only helpers: a QueryClient-wrapped render, a fetch route map,
                     API-shaped fixtures, and the next/navigation stand-in
```

## What this UI covers, and what it doesn't

Phase 15 shipped reconciliation, balances and the expense ledger; a design-quality pass (2026-09,
`Design.md` and ADR-0043) then rebuilt their visual quality without adding scope. **Phase 21
added the rest of the product**, one section per pillar:

| Pillar                   | Where it lives                                                     |
| ------------------------ | ------------------------------------------------------------------ |
| Context re-attachment    | `/review` (unmatched evidence), `/evidence/[id]`, `/payments/[id]` |
| Item-level refunds       | `/expenses/[id]` — items, allocation, splitter, distribution       |
| Cash reconciliation      | `/reconciliation`, `/reconciliation/[id]` — the account waterfall  |
| Balances and obligations | `/balances`, drilling into each contributing expense               |
| Splitwise drift          | `/splitwise`, `/splitwise/findings/[id]`                           |
| Proof packs              | `/proof-packs` — preview, review, copy                             |

Three rules the screens hold to, and which a change here must keep:

1. **No financial arithmetic.** Every figure is one the API computed. Where a number did not
   exist over HTTP, phase 21 added the _read_ (ADR-0048).
2. **Never a verified zero over incomplete evidence.** A missing statement balance renders as
   "not evidenced"; `verificationStatus` comes from the database, not the screen.
3. **No shortcut completes a decision** (ADR-0049). Every consequential act is a button behind a
   dialog that states its consequence.

Still deliberately out of scope: sending a proof pack (there is no message transport),
re-syncing or repairing a `stale` Splitwise row, rule learning or auto-approval, and an editor
for a model's stored proposal (`modify` exists on the API and is not reachable from here — a
half-built editor for it would be a way to approve something nobody read).

## Verifying more than the unit suite

`npm test` covers roles, labels, focus, keyboard behaviour, states and the design tokens. Two
things it cannot cover, both of which found real defects in phase 21 and both of which are worth
re-running against a live app after a visual change:

- **An axe sweep** over every route in desktop light, desktop dark and mobile. The bar is 0
  violations. This is what caught a contrast defect in `--ink-faint` that had been shipping since
  phase 15, and scroll containers no keyboard could reach.
- **A figure-by-figure comparison** of what a screen renders against what the API returned. 42
  figures were checked this way; the point is that "the frontend agrees with the backend" should
  be a measurement, not a claim.
