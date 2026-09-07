# Design system — `web/`

This file is authoritative for visual and frontend-architecture decisions in `web/`, the same
way the root `CLAUDE.md` is authoritative for the domain. Read it before changing a screen,
adding a component, or introducing a new color/size token. It was written during a dedicated
design pass (2026-09, after phase 15 shipped the first production UI) that treated the existing
UI's visual quality as a defect to fix, not a phase to build on top of — see ADR-0043 for the
decision record and the audit that motivated it.

> **Phase 21 update (2026-09-07).** The product grew from four screens to eleven, covering all
> six of `CLAUDE.md`'s pillars ([ADR-0048](../docs/decisions/0048-phase-21-ui-reads-the-ledger-and-never-recomputes-it.md),
> [ADR-0049](../docs/decisions/0049-keyboard-first-navigation-never-completes-a-decision.md)).
> This pass **extended** the system below rather than replacing any of it: same palette, same
> seven-size type scale, same one-hero-figure rule, same native-controls-first stance, no icon
> library, no animation library, no component library. What it added is recorded inline under
> each heading, and four things are worth knowing before you read further:
>
> - **`--ink-faint` was darkened** in both themes to meet AA. It was below 4.5:1 on `paper` and
>   `panel` and had been since phase 15 — a real defect, found by an axe sweep and fixed at the
>   token so every screen inherits it. See "Color".
> - **One primitive was added**: `Dialog`, hand-built, ~60 lines, no dependency. See "Dialogs".
> - **`Table` now makes an overflowing scroll container keyboard-reachable**, named by its own
>   caption, and only when it actually scrolls. See "Responsive rules".
> - **A keyboard layer exists**, and it is navigational only. See "Keyboard".
>
> The bar these are held to: axe reports **0 violations** on every screen in desktop light,
> desktop dark and mobile, and that is a gate, not an aspiration.

## Post-Phase-21 refinement (2026-09-07)

The product keeps its existing palette, IBM Plex faces, 64rem container, exact figures and
six workflows. This refinement makes the active workflow, selected item and next step easier
to distinguish. It adds no runtime dependency and changes no backend code.

- Navigation has a brand/search row and a workflow row. The six links form a three-column
  grid below `sm`, keeping every destination visible with 44px touch targets. Shortcut help
  is a visible desktop button as well as `?`.
- The page title is now 30px, semibold with tight tracking; the existing seven token names
  remain. Header descriptions have a relaxed line height and a separating rule. Main gutters
  are 16px on phones and 24px from `sm`; the content width remains 64rem.
- Shared table headers use a restrained tinted band, with consistent cell padding. Empty
  states use rules and readable, left-aligned text rather than dashed placeholder boxes.
- The default border color belongs to Tailwind's **base layer**. An unlayered universal rule
  was overriding `border-accent` and `border-transparent`, making inactive navigation appear
  underlined and removing selected-state contrast. Keep utilities able to override defaults.
- Native inputs/selects use 44px height on phones and 40px from `sm`. Form text is 16px on
  phones to avoid focus zoom. Buttons have 44px mobile touch targets; compact desktop buttons
  remain available. Native pickers and reduced-motion behavior are preserved.
- Review is a 22rem queue beside an inspector on desktop. Below `lg`, opening an item replaces
  the list with its inspector; Back to queue restores focus to the originating row. `j`/`k`
  select, Enter opens, and native links/buttons retain their own Enter behavior. No decision
  is preselected. Model provenance is available through a native disclosure; the stored
  proposal and its confidence remain visible before approval.
- Review kind filters become a native select below `sm`. Whole-ledger counts stay separate
  from the filtered list. The list shows its visible/total count and loads another 50 through
  the existing API limit when `truncated` is true, preserving domain priority order. A new
  kind resets both the limit and the selection. A filtered empty result explicitly offers
  Everything; an empty queue does not claim that accounts reconcile.
- An unmatched document with neither a receipt total nor an observed amount says **Not
  evidenced**. The backend's zero materiality fallback is a sorting value, not evidence of a
  zero payment. An actual recorded zero still renders exactly as zero.
- Expense search filters descriptions in the returned ledger without sorting or computing
  figures. Clear filters resets description, state and payer together. Balances starts with
  the owner in Person A; both people remain editable. An identical-person selection shows
  guidance, never an endless loading state. The proof-pack shortcut is offered only when the
  selected pair is the owner and the recipient.
- Dialogs render in a body portal, make the background inert, lock background scrolling and
  restore both on close. Global shortcuts and queue triage suspend while a modal is present.
  The panel still receives initial focus, and a visible close control supports touch. Pending
  decisions cannot be dismissed by Escape, backdrop or close button. See
  [ADR-0050](../docs/decisions/0050-modal-isolation-and-review-workspace.md).

The concept established the navigation, spacing, selection rail, restrained panels and type
hierarchy. Intentional departures preserve the authoritative system: 64rem content width rather
than the concept's full-width rendering, no gradient on buttons, complete source/proposal data
instead of the concept's shortened examples, and a choice prompt until the user selects an item.

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

| Token             | Light     | Dark      | Meaning — the only thing it may be used for                                                                                                                                                                                                                                                                                                                              |
| ----------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paper`           | `#fafaf7` | `#14161c` | Page background.                                                                                                                                                                                                                                                                                                                                                         |
| `panel`           | `#ffffff` | `#1b1e26` | A raised surface (the grouped person-picker panel).                                                                                                                                                                                                                                                                                                                      |
| `ink`             | `#1b2333` | `#eceef4` | Primary text.                                                                                                                                                                                                                                                                                                                                                            |
| `ink-muted`       | `#5b6478` | `#a2a9bb` | Secondary text, labels, table headers.                                                                                                                                                                                                                                                                                                                                   |
| `ink-faint`       | `#6b7387` | `#828a9e` | Tertiary text (a subtraction sign, an annotation under a figure). **Darkened in phase 21**: the old `#8b93a3`/`#6b7284` pair was ~2.95:1 on `paper` and ~3.76:1 in dark, below AA for the 12px text it is used for. Both values now clear 4.5:1 on `paper` **and** on `panel`, in both themes, and `src/design-system.test.tsx` recomputes that rather than trusting it. |
| `rule`            | `#d8d9cd` | `#2c2f3a` | Hairline borders/dividers.                                                                                                                                                                                                                                                                                                                                               |
| `rule-strong`     | `#b7bba8` | `#3c4050` | A heavier rule (the double rule above a hero total; a hover border).                                                                                                                                                                                                                                                                                                     |
| `debit`/`-bg`     | `#a33b2e` | `#e08678` | A figure that is **bad news in this context** — unexplained money, a rejected expense. Never used for a system error alone (pair with `attention` for that).                                                                                                                                                                                                             |
| `credit`/`-bg`    | `#2f6e4f` | `#7fbb9c` | A figure that is **good news in this context** — fully explained, settled, confirmed. Never derived from a raw sign; always an explicit caller judgment (`money.tsx`'s own comment).                                                                                                                                                                                     |
| `accent`/`-bg`    | `#2a3a6b` | `#8b9be0` | The one interactive/brand color — links, the primary button, the active nav tab, in-flow states moving toward completion.                                                                                                                                                                                                                                                |
| `accent-ink`      | `#ffffff` | `#14161c` | Text set **on top of** `accent` (a filled button's label). Never `text-white`/`text-black` literally — dark mode inverts which one is readable.                                                                                                                                                                                                                          |
| `attention`/`-bg` | `#8a5a17` | `#d3a24e` | A finding that needs a look but is not wrong: a Splitwise mismatch, an expense sitting in `review_required`. Distinct from `debit` on purpose — see "Color carries exactly one meaning" below.                                                                                                                                                                           |
| `focus-ring`      | `#2a3a6b` | `#8b9be0` | The universal `:focus-visible` outline. Same value as `accent`, kept as its own token because the two could diverge later.                                                                                                                                                                                                                                               |

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

| Token           | Size | Used for                                                         |
| --------------- | ---- | ---------------------------------------------------------------- |
| `text-micro`    | 12px | A secondary annotation under a figure (`of ₹1,800.00`).          |
| `text-meta`     | 13px | Form labels, table column headers, timestamps.                   |
| `text-body`     | 14px | Default body and table-cell text.                                |
| `text-emphasis` | 15px | A section heading (`From these expenses`, `Splitwise`).          |
| `text-h1`       | 30px | The one page-title heading per screen.                           |
| `text-figure`   | 28px | A secondary hero — the balance headline amount.                  |
| `text-display`  | 40px | **The** hero — `ledgerUnexplainedTotal` on a reconciliation run. |

**One hero number per screen.** A reconciliation run detail exists to answer one question ("how
much is still unexplained?"); a balance screen exists to answer one question ("who owes whom,
how much?"). That number gets `text-display`/`text-figure`, `font-semibold`, and `leading-none`
(a large `line-height` clips visually with tight tracking; each hero usage sets `leading-none`
explicitly rather than relying on a paired theme line-height, so it's decided in exactly one
place). Every other figure on the same screen — the subtraction chain, a contributing expense
row — stays at `text-body` or smaller. Resist the urge to make more than one thing big; if two
numbers compete for attention, the hierarchy has failed.

**The run detail is the one screen with two, and phase 21 made that deliberate rather than
accidental.** ADR-0016's `ledgerUnexplainedTotal` (`text-display`) and ADR-0017's per-account
`cashBalanceDelta` (`text-figure`) are two **independent identities**: neither is derived from
the other, and a period can explain every rupee of outflow while a statement still fails to
close. They live in separate `<section>`s under their own headings, at different sizes, so they
read as two questions answered in sequence rather than two answers to one question. Blending
them into a single score would be the actual design failure. Do not take this as licence for a
second hero elsewhere: if a new screen wants one, it is probably two screens.

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

- One page container everywhere: `max-w-5xl` (64rem), `px-4 sm:px-6`. Don't widen it for a
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

**Phase 21 found the first two controls that genuinely needed more, and says which behavior
justified each** (ADR-0049):

- **`Dialog`** (`src/components/ui/dialog.tsx`) — focus containment while open, focus
  restoration on close, and Escape-to-close (except while recording a decision). `<dialog>`'s own `showModal()` is not usable here
  (jsdom, where every test in this package runs, does not implement it). Hand-built in about
  sixty lines rather than pulling in a headless library, which is the same trade ADR-0043 made
  when it took shadcn's authoring style without its CLI or Radix.
- **The command palette's search field** — a `role="combobox"` over a `role="listbox"` driven by
  `aria-activedescendant`, so the input keeps focus while the arrow keys move the highlight. A
  real `<select>` cannot be that.

Two `Dialog` details are decisions rather than defaults, and a new caller should not "fix" them:
focus lands on the **panel**, never on the first button (a dialog focused on its confirm button
is one Enter away from an act nobody read), and `DecisionDialog` is **mounted only while open**,
so its reason field starts empty every time.

### Dialogs: `DecisionDialog` is the only shape a recorded decision takes

Every consequential act in the product — accepting a proposal, confirming a duplicate, attaching
evidence, recording a refund, distributing one, reviewing an audit finding — goes through
`src/components/review/decision-dialog.tsx`. It forces three things on its caller, so no screen
can quietly skip one:

1. **A `consequence`, in words**, stating what the button will actually do ("this discards the
   later payment"; "this authorizes no write to Splitwise"). It is a required prop.
2. **A required reason where the service requires one.** The confirm button stays disabled until
   one is typed — the service would refuse anyway, and refusing here means the person finds out
   before the request rather than after.
3. **No keystroke submits.** Enter inside the reason field types a newline; the only path to the
   mutation is the button.

When you add an action, add it here. A bare `<Button onClick={mutate}>` on a financially
consequential path is the pattern this component exists to prevent.

### Keyboard

`src/components/app-shell/` holds the keyboard layer, and its one rule is worth restating
because it shapes everything: **a shortcut moves you somewhere or opens something; it never
completes a decision** (ADR-0049).

- `Cmd K` / `Ctrl K` opens the command palette; `?` lists every shortcut that currently applies,
  including the ones the open screen registered through `useShortcutSection`; `g` then a letter
  goes to one of the six sections; `j`/`k`/`Enter`/`Esc` triage the review queue.
- Every global listener ignores events from an `input`, `textarea`, `select` or
  `contenteditable`, so typing "go" into a reason box does not navigate away mid-sentence.
- There is deliberately **no** `a`-to-accept. If a future screen wants bulk action, design it as
  an explicit multi-select with one confirmation over the set, not as a per-item key.
- A skip link is the first tab stop, and `<main>` is its target (`tabIndex={-1}`).

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
- **A scroll container a mouse can pan and a keyboard cannot reach is a WCAG failure**
  (axe's `scrollable-region-focusable`), and phase 21's denser tables started tripping it at
  360px. `Table` now measures itself and, **only when it actually overflows**, becomes
  `tabIndex={0}` with `role="group"` named by its own `sr-only` caption. Measuring rather than
  always setting `tabIndex` avoids putting a useless tab stop in front of every small table;
  `group` rather than `region` avoids the landmark-uniqueness rule two scrollable tables on one
  screen would otherwise break.
- Phase 21's two-pane screens (the review queue's list + inspector) collapse at `lg`, not `sm` —
  an inspector needs more room than a table row does, and one column is the right answer for the
  whole tablet range.
- The nav uses a three-column mobile grid; person pickers use full-width native controls on
  mobile. The review kind filter uses a native select rather than a wrapped row of buttons.

### Accessibility expectations

- **axe-core: 0 violations on every screen**, in desktop light, desktop dark and mobile —
  re-verified across all eleven screens in phase 21, and a regression is a shipped bug, not a
  nitpick. That sweep is what caught the `ink-faint` contrast defect and the unreachable scroll
  containers, both of which had been shipping since earlier phases and neither of which a
  screenshot review would ever have surfaced. Run it against a live app; the frontend suite
  covers roles, labels, focus and the token contrast, but only a browser catches the rest.
- Every focusable element gets the app-wide `:focus-visible { outline: 2px solid
var(--focus-ring) }` rule (`globals.css`) — never suppressed per-component.
- `role="alert"` is reserved for a real, singular system failure (`ErrorBlock`); a list of domain
  findings is plain content (see `Alert` above).
- Every table keeps an `sr-only` `<caption>` and correct `scope` on header cells — a convention
  phase 15 established that this pass preserved rather than reinvented.
- `prefers-reduced-motion: reduce` already collapses every animation/transition duration to
  ~0 globally (`globals.css`) — new motion never needs its own reduced-motion branch as long as
  it's a CSS `transition`/`animation`, not a JS-driven one. Phase 21 added no JS-driven motion,
  and verified in a browser that a reduced-motion context reports **zero** non-trivial durations
  while a normal one still has them (so the rule is doing work, not vacuously passing).
- A figure a screen does not have is rendered as **absent**, never as `₹0.00`. `UnknownValue`
  (`src/components/facts.tsx`) is the component for it. This is an accessibility rule as much as
  a financial one: "not evidenced" and "zero" are different facts, and a reader using a screen
  reader has even less context to tell them apart from a bare number.

### Interaction and motion

Motion is feedback, never choreography. The only transitions in the product are `transition-colors`
on hover/focus/press (nav links, buttons) — nothing animates on page load, nothing scrolls
itself, nothing loops. A reconciliation ledger should feel like reading a statement, not visiting
a landing page; if a future screen wants to add motion, ask what it's communicating (state
change, feedback) before adding it, and default to none.

## Frontend architecture

Stack is unchanged from phase 15 (ADR-0042): **Next.js 16 (App Router), React 19, Tailwind CSS
v4, TanStack Query**, `web/` a self-contained package that only ever talks to the real API over
`fetch`. The design pass added exactly three things on top, all justified above and in ADR-0043:

1. `src/components/ui/` — the primitive layer (`button`, `select`, `input`, `label`, `table`,
   `alert`, `skeleton`).
2. `src/lib/utils.ts` — `cn()`, a `clsx` + `tailwind-merge` merge helper, with a custom
   `extendTailwindMerge` config registering every token this app defines (see "Typography"
   above for why that registration is load-bearing, not decoration).
3. Three new runtime dependencies: `class-variance-authority`, `clsx`, `tailwind-merge` — all
   zero-or-near-zero-transitive-dependency, no install scripts, reviewed before committing (see
   ADR-0043). No component library, animation library, or icon library was added.

**Phase 21 added no dependency at all.** What it did add:

- `src/components/ui/dialog.tsx` and `textarea.tsx` — two more hand-owned primitives.
- `src/components/app-shell/` — the shell: `ShortcutProvider` (the keyboard layer),
  `CommandPalette`, `ShortcutHelp` and `AppShell`, which composes them with the nav and the skip
  link. `app/layout.tsx` renders `AppShell` and nothing else.
- `src/components/{review,evidence,expenses,reconciliation,splitwise,proof-packs}/` — one
  directory per pillar, plus `facts.tsx` (the label/value inspector layout), `annotations.tsx`
  (confidence, signal verdicts, notes, state words), `page-header.tsx` (`PageHeader`/`Section`)
  and `payment-summary.tsx`, all shared.
- `src/lib/labels.ts` — human wording for every closed enum the API sends. Two rules hold
  throughout: every map **falls back to the raw value**, never to "Unknown", so a value this file
  has not been taught still renders; and a label never softens a state ("Incomplete" is not
  "Pending").
- `src/test-support/` grew `api-mock.ts` (a route map in front of `fetch`, where an unrouted
  request is a loud failure and every call keeps its body), `fixtures.ts` (API-shaped synthetic
  responses) and `next-navigation.ts` (the App Router hooks, replaced once in `vitest.setup.ts`).

### Data flow

Every screen reads through `src/lib/queries.ts` (TanStack Query hooks) over `src/lib/api.ts`,
which is still the one place a request leaves this package. Two conventions are worth keeping:

- **A mutation invalidates everything it can change, not just what it wrote.** A refund moves the
  net amount, the allocation, the pairwise balance and what a proof pack would say — see
  `invalidateExpense`.
- **A proof pack is fetched with `staleTime: 0`**, unlike every other read. It is what you are
  about to show another person, so it is re-derived when the preview opens rather than served
  from a cache that predates the last refund.

## What the next phase inherits

- Reach for a token name (`text-h1`, `text-attention`, `gap-8`) before a bracketed value. If the
  scale doesn't have what a new screen needs, extend the scale in `globals.css` and register the
  new token in `src/lib/utils.ts` in the same change — not after a bug report.
- A new screen gets exactly one hero figure, sized `text-display` or `text-figure`. If a design
  wants two, that's a sign the screen is answering two questions and might be two screens.
- Default to a styled native control. Reach for a headless primitive only when a control needs
  behavior HTML doesn't provide, and record which behavior when you do.
- ~~`review/evidence/receipts` screens and frontend CI~~ — **both shipped in phase 21.** The
  review queue, the evidence inspector, the payment-context screen and the receipt view all
  exist, and CI has a `web` job running typecheck, lint, format, test and build.
- **`web/` performs no financial arithmetic, and that is not negotiable** (ADR-0048). If a screen
  needs a number that does not exist over HTTP, add the _read_ to the API — do not compute it
  here, however trivial the subtraction looks. The two exceptions are parsing what a person typed
  into exact paise (`parseRupeeInput`, pure string handling, no `Number`) and echoing a form's own
  entry total, which is labelled as an entry check and never rendered with ledger semantics.
- **Never render a verified zero over incomplete evidence.** `verificationStatus` comes from a
  database `CHECK`; a screen renders that word and never derives it. The same instinct applies
  everywhere: an empty findings list under a failed external read is not agreement, and an empty
  review queue is not the same as a filter hiding something. Say which.
