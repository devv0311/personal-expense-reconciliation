# Design system — `web/`

This file is authoritative for visual and frontend-architecture decisions in `web/`, the same
way the root `CLAUDE.md` is authoritative for the domain. Read it before changing a screen,
adding a component, or introducing a new color/size token. It was written during a dedicated
design pass (2026-09, after phase 15 shipped the first production UI) that treated the existing
UI's visual quality as a defect to fix, not a phase to build on top of — see ADR-0043 for the
decision record and the audit that motivated it.

## Visual direction

This is a personal financial reconciliation ledger, not a SaaS dashboard, not a consumer app,
and not a marketing site. The interface's job is to be read and trusted, the way a bank
statement or a well-kept accounting ledger is read and trusted — not to perform "modern software"
at the reader. Every decision below traces back to one of five qualities:

- **Trust / calm** — a restrained, paper-like surface; one accent color; no gradients, no
  glassmorphism, no decorative motion. Nothing on screen exists to look impressive.
- **Precision** — every number is set in tabular mono digits so columns of figures actually
  align; exactly one figure per screen is allowed to be the hero.
- **Explainability** — color is semantic and single-purpose. A color never means two different
  things on two different screens (see "Color" below).
- **Confidence** — strong typographic hierarchy and real whitespace do the work that a heavier
  visual system (cards, shadows, badges) would otherwise be reaching for.

The old UI already avoided the loudest anti-patterns (no gradients, no icon spam, no
glassmorphism) because phase 15 was built with restraint in mind. What it actually lacked was
**hierarchy**: every heading, label, and figure sat in a narrow 13–16px band with no typographic
event to organize a screen around, native form controls carried unstyled OS chrome, and the one
number each screen exists to answer (`ledgerUnexplainedTotal`, a balance headline) had no more
visual weight than the supporting arithmetic around it. This pass is a targeted-evolution
redesign, not a rebuild: the palette, the fonts, the copy, the information architecture, and the
explicit loading/empty/error states from phase 15 are preserved and extended, not replaced.

## Design tokens

All tokens live in `src/app/globals.css`, defined once as CSS custom properties (light value in
`:root`, dark value under `prefers-color-scheme: dark`) and exposed to Tailwind via `@theme
inline`. Never hardcode a hex value or a bracketed `text-[Npx]` size in a component — use the
token.

### Color

| Token          | Light     | Dark      | Meaning — the only thing it may be used for                             |
| -------------- | --------- | --------- | ------------------------------------------------------------------------- |
| `paper`        | `#fafaf7` | `#14161c` | Page background.                                                          |
| `panel`        | `#ffffff` | `#1b1e26` | A raised surface (the grouped person-picker panel).                       |
| `ink`          | `#1b2333` | `#eceef4` | Primary text.                                                             |
| `ink-muted`    | `#5b6478` | `#a2a9bb` | Secondary text, labels, table headers.                                    |
| `ink-faint`    | `#8b93a3` | `#6b7284` | Tertiary text (a subtraction sign, a "…" placeholder).                    |
| `rule`         | `#d8d9cd` | `#2c2f3a` | Hairline borders/dividers.                                                |
| `rule-strong`  | `#b7bba8` | `#3c4050` | A heavier rule (the double rule above a hero total; a hover border).      |
| `debit`/`-bg`  | `#a33b2e` | `#e08678` | A figure that is **bad news in this context** — unexplained money, a rejected expense. Never used for a system error alone (pair with `attention` for that). |
| `credit`/`-bg` | `#2f6e4f` | `#7fbb9c` | A figure that is **good news in this context** — fully explained, settled, confirmed. Never derived from a raw sign; always an explicit caller judgment (`money.tsx`'s own comment). |
| `accent`/`-bg` | `#2a3a6b` | `#8b9be0` | The one interactive/brand color — links, the primary button, the active nav tab, in-flow states moving toward completion. |
| `accent-ink`   | `#ffffff` | `#14161c` | Text set **on top of** `accent` (a filled button's label). Never `text-white`/`text-black` literally — dark mode inverts which one is readable. |
| `attention`/`-bg` | `#8a5a17` | `#d3a24e` | A finding that needs a look but is not wrong: a Splitwise mismatch, an expense sitting in `review_required`. Distinct from `debit` on purpose — see "Color carries exactly one meaning" below. |
| `focus-ring`   | `#2a3a6b` | `#8b9be0` | The universal `:focus-visible` outline. Same value as `accent`, kept as its own token because the two could diverge later. |

**Color carries exactly one meaning, and only one token owns each meaning.** Before phase 15's
design pass, a Splitwise discrepancy and an API network failure were both rendered in `debit`
red — visually identical, semantically unrelated. One is a system telling you it's broken; the
other is the ledger telling you something is worth a look. Collapsing them teaches the reader to
stop trusting red, which is exactly the figure (`ledgerUnexplainedTotal`) the whole product exists
to make trustworthy. `attention` exists to keep that distinction real. When you're about to reach
for `debit` to mean "notice this," stop and ask whether it's actually "this is wrong" (debit),
"this is a finding" (attention), or "this is progressing normally" (accent) — `expense-state-tag.tsx`
and `discrepancy-list.tsx` are the worked examples.

**Never mix warm and cool neutrals.** `ink`/`rule`/`paper` are all one cool-neutral family; don't
introduce a warm gray anywhere.

### Typography

**IBM Plex Sans** (UI/prose, weights 400/500/600 loaded — never use `font-bold`, it isn't loaded
and would synthesize) + **IBM Plex Mono** (every number, id, and state tag). The mono face is
load-bearing: money needs tabular-aligned digits to scan as a ledger, not decorative flavor.
Keep both; don't introduce a second typeface.

The type scale is seven named sizes, each a Tailwind theme token (`--text-*` in `globals.css`,
generating `text-micro` … `text-display` utilities directly — **not** `--font-size-*`, which
Tailwind v4 does not recognize as a namespace at all; see the postmortem note in
`src/lib/utils.ts` before you add an eighth). Always reach for a name; a bracketed `text-[Npx]`
in a new component is a sign the scale is missing something, not a reason to bypass it.

| Token           | Size      | Used for                                                             |
| --------------- | --------- | --------------------------------------------------------------------- |
| `text-micro`    | 12px      | A secondary annotation under a figure (`of ₹1,800.00`).               |
| `text-meta`     | 13px      | Form labels, table column headers, timestamps.                       |
| `text-body`     | 14px      | Default body and table-cell text.                                     |
| `text-emphasis` | 15px      | A section heading (`From these expenses`, `Splitwise`).               |
| `text-h1`       | 24px      | The one page-title heading per screen.                                |
| `text-figure`   | 28px      | A secondary hero — the balance headline amount.                       |
| `text-display`  | 40px      | **The** hero — `ledgerUnexplainedTotal` on a reconciliation run.       |

**One hero number per screen.** A reconciliation run detail exists to answer one question ("how
much is still unexplained?"); a balance screen exists to answer one question ("who owes whom,
how much?"). That number gets `text-display`/`text-figure`, `font-semibold`, and `leading-none`
(a large `line-height` clips visually with tight tracking; each hero usage sets `leading-none`
explicitly rather than relying on a paired theme line-height, so it's decided in exactly one
place). Every other figure on the same screen — the subtraction chain, a contributing expense
row — stays at `text-body` or smaller. Resist the urge to make more than one thing big; if two
numbers compete for attention, the hierarchy has failed.

**A custom `text-*` token must be registered in both places.** Adding a token to `globals.css`'s
`@theme inline` block makes the utility exist; it does **not** teach `tailwind-merge` which
conflict group it belongs to. `tailwind-merge` doesn't recognize custom theme values, so two
unrelated custom `text-*` classes (say, `text-display` — a size — and `text-debit` — a color) look
identical to it, and it silently drops one as a "duplicate." This is not hypothetical: it happened
during this pass and produced a hero figure with the right markup and the wrong (default,
16px, uncolored) rendering, caught only by reading `getComputedStyle` in a browser rather than by
eyeballing a screenshot. `src/lib/utils.ts`'s `extendTailwindMerge` config is the fix — every
custom color token is registered under `text-color`, every custom size token under `font-size`.
**Any new token in either family goes in both `globals.css` and that config, in the same commit.**

### Spacing, surfaces, borders, radius

- One page container everywhere: `max-w-5xl` (64rem), `px-6`. Don't widen it for a
  table — a wider column of figures is harder to scan, not easier.
- Section rhythm is `gap-8` (2rem) down a page; a form/filter row is `gap-4`.
- **Cards exist only where grouping communicates something real** — the two person-pickers on
  the balances screen are visually grouped in a `panel` box with a rule border because they are
  jointly one control ("pick a pair"), not because every block of content gets a box. Everywhere
  else, a hairline (`border-rule` on a `<tr>`, a `border-t-2 border-double` above a total) carries
  the hierarchy instead. If you're about to wrap a new section in `rounded-sm border border-rule
  p-5` purely for visual tidiness, that's the old pattern this pass moved away from — ask whether
  whitespace alone would do the job.
- One radius, `rounded-sm`, on every bordered element (buttons, inputs, panels, alerts). No
  second radius scale.
- No `box-shadow` anywhere. Elevation is communicated by type weight and whitespace, not by
  simulating physical depth — consistent with "no card exists just to exist" above.

### Icons

There is no icon library dependency, and none is needed yet: the only glyphs in the product are
a select's chevron and a history link's `←`, both inline SVG/text, plus the evidence-status
markers (`○ ~ ✓`) phase 15 already used. Adding `@phosphor-icons/react` or similar for two
functional glyphs would be a dependency for its own sake. If a future screen genuinely needs a
family of icons (not two), that's the point to make the call, not before.

### Forms: native controls, deliberately

`Select` (`src/components/ui/select.tsx`) and `Input` (`.../input.tsx`) are **styled native**
`<select>`/`<input>` elements — `appearance-none` plus a hand-drawn chevron, not a rebuilt
Radix/headless listbox. This was a considered reversal mid-pass, not the default: every control
in this app's four screens is a short, flat, single-select list or a plain text/date field —
exactly the shape a real `<select>` already handles correctly, including the platform picker UI
on a phone that a rebuilt one would have to reinvent, and including
`@testing-library/user-event`'s `selectOptions` helper, which only drives a real `<select>`. A
headless component library (Radix, and shadcn's own components are usually a thin skin over it)
earns its place when a control needs a state machine HTML doesn't give you for free — a
combobox with search, a multi-select, a dialog, a popover menu. None of those exist in this app
yet. **Reach for native-plus-styling first; reach for a headless primitive only when a specific
control genuinely needs one**, and say which behavior justified it when you do.

The one real cost of this choice: an open `<select>`'s dropdown list is still OS-rendered and
can't be restyled. That's an accepted tradeoff, not an oversight.

### Buttons, tables, alerts, skeletons

`src/components/ui/` holds a small set of hand-owned primitives, in shadcn/ui's authoring style
(a `cva` variant map, a `cn()` merge utility, the component's full source in this repo rather
than imported from a package) without taking shadcn's CLI or Radix as a dependency — see ADR-0043
for why that pattern was worth adopting without the specific tools "shadcn" usually implies.

- **`Button`** — `default` (filled `accent`, the one primary action per screen), `outline`,
  `ghost`, `link` (an inline recovery action like "Try again," styled to inherit the surrounding
  text color via an explicit `className` override rather than the variant's own `text-accent`,
  so a retry link inside a red `ErrorBlock` doesn't turn indigo).
- **`Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`/`TableCaption`** — thin
  styled wrappers around real table elements (callers still set `scope="col"`, `colSpan`, etc.).
  `Table` wraps itself in an `overflow-x-auto` container automatically, so horizontal scroll on
  a dense table is the default, not something to remember per screen.
- **`Alert`** — two variants, `destructive` (`debit` tones, used by `ErrorBlock`, `role="alert"`
  set by the caller) and `attention` (used by `DiscrepancyList`, deliberately **without**
  `role="alert"` — a list of findings rendered as normal content must not make a screen reader
  announce every item as an interruption the moment the page loads).
- **`Skeleton`** — a single shimmering primitive; `TableSkeleton`/`FieldSkeleton`/`FigureSkeleton`
  (`src/components/status.tsx`) compose it into shapes that match what's actually loading, so a
  screen never jumps from "four gray bars" to "a totally differently-sized table." Wrapped in
  `LoadingStatus`, which announces the caller's label once (`role="status"`, an `sr-only` span)
  and hides the decorative shimmer from assistive tech (`aria-hidden`).
- **No `Badge`.** Expense states and evidence statuses render as colored text with an optional
  marker glyph, never a filled pill — a deliberate holdover from phase 15, reinforced here: a
  pill communicates "status token," plain colored text communicates "read this word," and the
  latter is what a ledger's state column should feel like.

### Responsive rules

One breakpoint is used throughout: `sm` (640px). Below it:

- The three data-dense tables (expense ledger, balance contributions, reconciliation history)
  render as a stacked list (`<ul>`/`<dl>`) instead of a horizontally-scrolled table — verified
  down to 360px width. This is genuinely separate markup fed by the same data, not a CSS trick on
  the `<table>` itself, because a responsive-table CSS hack degrades badly for assistive tech.
- The two simpler two-column tables (the Splitwise balances snapshot on a run detail, and any
  future one like it) rely on the `Table` primitive's automatic horizontal-scroll wrapper instead
  of a second stacked-list markup — a deliberate scope line, not an oversight: at two columns and
  a handful of rows, horizontal scroll is not a degraded experience.
- The nav and the two-person-picker panel wrap via `flex-wrap`/`flex-col sm:flex-row` rather than
  a bespoke mobile layout.

### Accessibility expectations

- Lighthouse accessibility: 100 on all four screens, desktop and mobile, as of this pass — treat
  a regression below that as a shipped bug, not a nitpick.
- Every focusable element gets the app-wide `:focus-visible { outline: 2px solid
  var(--focus-ring) }` rule (`globals.css`) — never suppressed per-component.
- `role="alert"` is reserved for a real, singular system failure (`ErrorBlock`); a list of domain
  findings is plain content (see `Alert` above).
- Every table keeps an `sr-only` `<caption>` and correct `scope` on header cells — a convention
  phase 15 established that this pass preserved rather than reinvented.
- `prefers-reduced-motion: reduce` already collapses every animation/transition duration to
  ~0 globally (`globals.css`) — new motion never needs its own reduced-motion branch as long as
  it's a CSS `transition`/`animation`, not a JS-driven one.

### Interaction and motion

Motion is feedback, never choreography. The only transitions in the product are `transition-colors`
on hover/focus/press (nav links, buttons) — nothing animates on page load, nothing scrolls
itself, nothing loops. A reconciliation ledger should feel like reading a statement, not visiting
a landing page; if a future screen wants to add motion, ask what it's communicating (state
change, feedback) before adding it, and default to none.

## Frontend architecture

Stack is unchanged from phase 15 (ADR-0042): **Next.js 16 (App Router), React 19, Tailwind CSS
v4, TanStack Query**, `web/` a self-contained package that only ever talks to the real API over
`fetch`. This pass added exactly three things on top, all justified above and in ADR-0043:

1. `src/components/ui/` — the primitive layer (`button`, `select`, `input`, `label`, `table`,
   `alert`, `skeleton`).
2. `src/lib/utils.ts` — `cn()`, a `clsx` + `tailwind-merge` merge helper, with a custom
   `extendTailwindMerge` config registering every token this app defines (see "Typography"
   above for why that registration is load-bearing, not decoration).
3. Three new runtime dependencies: `class-variance-authority`, `clsx`, `tailwind-merge` — all
   zero-or-near-zero-transitive-dependency, no install scripts, reviewed before committing (see
   ADR-0043). No component library, animation library, or icon library was added.

## What the next phase inherits

- Reach for a token name (`text-h1`, `text-attention`, `gap-8`) before a bracketed value. If the
  scale doesn't have what a new screen needs, extend the scale in `globals.css` and register the
  new token in `src/lib/utils.ts` in the same change — not after a bug report.
- A new screen gets exactly one hero figure, sized `text-display` or `text-figure`. If a design
  wants two, that's a sign the screen is answering two questions and might be two screens.
- Default to a styled native control. Reach for a headless primitive only when a control needs
  behavior HTML doesn't provide, and record which behavior when you do.
- `review/evidence/receipts` screens (phases 9–11's own surfaces, still not built per
  `docs/roadmap.md`) and frontend CI are still open — this pass did not add them, per its own
  scope (a design-quality pass on the four existing screens, not new product surface).
