# 0043. A frontend design system, and hand-owned component primitives without Radix

**Status:** Accepted

## Context

Phase 15 shipped the first production UI (ADR-0042) with real financial-safety discipline —
exact `BigInt` money formatting, explicit loading/error/empty states per screen, a caller-decided
(never sign-derived) debit/credit tone — but no dedicated design pass. Requested directly, ahead
of phase 16: bring that UI to a production-quality visual standard before adding any new
capability, treating it as a design-foundation defect to fix, not a phase to build on top of.

Auditing the four existing screens (reconciliation list/detail, balances, expenses) against
`redesign-existing-projects`, `web-design-guidelines` (Vercel's Web Interface Guidelines), and
`vercel:shadcn`'s composition guidance found the UI already avoided the loud anti-patterns —
no gradients, no glassmorphism, no icon spam, a genuinely restrained palette. What it lacked was
**hierarchy**: every heading, label, and money figure sat in a narrow 13–16px band with no
typographic event to organize a screen around; native `<select>` elements carried unstyled OS
chrome; and `ledgerUnexplainedTotal` — the one figure `docs/domain/invariants.md` #20 and the
whole reconciliation feature exist to compute — had no more visual weight than the subtraction
arithmetic feeding it. Separately, a Splitwise discrepancy (a data finding) and a network failure
(a system error) were both rendered in the same `debit` red, conflating "something needs a look"
with "something is wrong."

## Decision

### Extend the existing token system; don't replace it

`globals.css`'s `paper`/`ink`/`rule`/`debit`/`credit`/`accent` tokens (light + dark, already
desaturated, already off-black/off-white) are correct and stay. Two additions:

- **A seven-step named type scale** (`text-micro` 12px → `text-display` 40px), replacing ad hoc
  `text-[Npx]` values, with one governing rule: **exactly one figure per screen renders at
  `text-display`/`text-figure`** — the hero the screen exists to answer (an unexplained total, a
  balance headline). Everything else, including the arithmetic feeding that figure, stays small
  and quiet.
- **One new semantic color, `attention`** (amber, not a rebrand of `debit`), for a finding that
  needs a look but isn't wrong — a Splitwise mismatch, an expense in `review_required`. `debit`
  keeps its narrower, more serious meaning: a figure that is bad news in this specific context.

### A hand-owned `src/components/ui/` primitive layer, in shadcn's *style*, without its stack

`Button`, `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`/`TableCaption`,
`Alert` (`destructive` | `attention`), `Skeleton`, `Label`, and styled-native `Select`/`Input`
were added — each a `cva` variant map (where variants exist) plus a `cn()`-merged className,
following shadcn/ui's authoring convention (own the source, don't import a component) closely
enough that `vercel:shadcn`'s guidance applied directly. Three dependencies were added to support
it: `class-variance-authority`, `clsx`, `tailwind-merge` — reviewed for vulnerabilities, install
scripts, and license before committing (all clean: MIT/Apache-2.0, zero-to-one transitive
dependencies each, no lifecycle scripts).

**`Select` and `Input` are styled native elements, not a rebuilt Radix listbox — a reversal made
mid-pass.** `radix-ui` (the current unified package) was installed and a full Radix `Select` was
built first, following the `vercel:shadcn` skill's default recommendation. It was removed before
this ADR was written, for two concrete reasons: (1) every select in this app's four screens is a
short, flat, single-choice list — a person, an expense state — exactly what a native `<select>`
already does correctly, including the platform picker UI on a phone; (2) `@testing-library/user-
event`'s `selectOptions` helper only drives a real `<select>` element, and switching would have
required rewriting `balances/page.test.tsx`'s interaction tests to gain nothing a styled native
control doesn't already provide. `appearance-none` plus a hand-drawn chevron gets most of the
visual win (the closed control's cross-browser look, which is what actually reads as "cheap")
without the dependency, the test rewrite, or reinventing mobile picker behavior. The one accepted
cost: an open `<select>`'s dropdown list stays OS-rendered.

### No `Badge` component

Expense states and evidence statuses keep phase 15's colored-text-plus-marker-glyph treatment
rather than gaining a filled pill. A pill reads as "status token to scan visually"; plain colored
text reads as "read this word" — closer to how a ledger's own state column should feel, and
consistent with the redesign brief's explicit instruction to avoid "meaningless badges/pills."

### The `tailwind-merge` custom-token pitfall, and its fix

`tailwind-merge` only knows Tailwind's own built-in theme scale. Two unrelated custom `text-*`
tokens — `text-display` (a size, from the new type scale) and `text-debit` (a color, pre-existing)
— look identical to it, and it silently drops one as a conflicting duplicate. This was not
theoretical: it shipped once during this pass. The hero total's `<span>` had `text-debit
text-display` in its className, rendered as **inherited body size and inherited (non-debit)
color, at font-weight 600 only** — every checkbox on a screenshot review would have passed,
because the layout still looked plausible at a glance; only reading `getComputedStyle` in a real
browser caught it. The `--font-size-*` CSS variable namespace used for the first version of the
type scale compounded this: Tailwind v4's actual font-size namespace is `--text-*`, so the
mis-named tokens generated no utility at all, independent of the merge bug. Fixed by (1) renaming
every size token to `--text-*`, and (2) `src/lib/utils.ts` now calls `extendTailwindMerge` with
every custom color token registered under the `text-color` class group and every custom size
token under `font-size`, so the two scales merge independently the way Tailwind's own `text-sm`
and `text-red-500` do. **Documented as a standing rule** (`web/Design.md` "Typography"): any new
custom `text-*` token is added to `globals.css` and this config in the same change.

## Consequences

- `web/Design.md` is now the authoritative, living design-system document for this package —
  tokens, component principles, layout/responsive/accessibility rules, and the two pitfalls
  above, so a future phase extends the system instead of re-deriving or silently drifting from it.
- Lighthouse accessibility scores 100 on all four screens, desktop and mobile, after this pass
  (was not measured before it).
- Three data-dense tables (expense ledger, balance contributions, reconciliation history) now
  render a genuinely separate stacked-list markup below `640px` instead of relying on horizontal
  scroll — verified down to 360px viewport width. The Splitwise-snapshot table (two columns, a
  handful of rows) was deliberately left on horizontal-scroll-only, a scope line rather than an
  oversight.
- No change to `src/` (the backend) or to any financial computation — every number rendered is
  still exactly what the API already computed (`web/README.md`'s own invariant, unchanged).
- All 37 existing frontend tests pass unmodified; no test needed to change because component
  *behavior* (props, DOM roles, `selectOptions` compatibility) was preserved even where internal
  markup was rewritten.

## Alternatives considered

- **Run `npx shadcn@latest init` and accept its generated `globals.css`/`components.json`.**
  Rejected: the CLI rewrites `globals.css` toward a generic zinc/oklch token set and is
  documented (in the `vercel:shadcn` skill itself) to sometimes break `next/font` integration by
  emitting a circular `--font-sans: var(--font-sans)`. This app's existing paper/ink/debit/credit
  tokens are the actual distinctive part of the design; hand-authoring the primitives against
  them, in the CLI's *style*, preserved that and avoided the rewrite risk entirely.
- **Keep the Radix-based `Select`.** Rejected per "Decision" above — no control in this app's
  current scope needs a headless state machine, and the concrete cost (rewriting passing
  interaction tests) bought no real capability.
- **A full component library (Fluent, Carbon, Radix Themes).** Rejected as disproportionate to a
  four-screen, single-user app with an already-distinctive palette; `design-taste-frontend`'s own
  design-system map reserves these for enterprise-scale or multi-team surfaces this app isn't.
- **Leave `debit` covering both "system error" and "domain finding needing a look."** Rejected —
  the whole point of a reconciliation product is that a red figure means something specific and
  trustworthy; overloading it undermines `ledgerUnexplainedTotal`'s own credibility.
