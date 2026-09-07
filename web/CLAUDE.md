@AGENTS.md

# web/ — persistent context

**Read `Design.md` before any visual or component change.** It's authoritative for tokens,
typography, component principles, layout/responsive/accessibility rules, and two documented
pitfalls (a `tailwind-merge` custom-token gotcha, a Tailwind v4 font-size-namespace mistake) worth
not re-making. See `README.md` for how to run this package and what phase 15 built.

The short version, if you only read one paragraph: this is a ledger, not a dashboard. One hero
figure per screen, sized `text-display`/`text-figure`; every other number stays quiet. Color is
semantic and single-purpose (`debit`/`credit`/`accent`/`attention` each mean exactly one thing —
`Design.md` "Color"). Reach for a styled native `<select>`/`<input>` before a headless component;
the two that needed more (a modal dialog, a combobox) are hand-built and documented. No icon
library, no animation library, no component library, no card around every section.

Three rules that outrank any visual preference (phase 21 — ADR-0048, ADR-0049):

1. **This package performs no financial arithmetic.** Every figure is one the API computed. If a
   screen needs a number that does not exist over HTTP, add the _read_ to the API — not the
   calculation here, however trivial. The only exceptions are parsing a typed amount into exact
   paise (`parseRupeeInput`, pure string handling) and echoing a form's own entry total, labelled
   as such.
2. **Never render a verified zero over incomplete evidence.** A statement balance nobody has
   confirmed is "not evidenced", never `₹0.00`; `verificationStatus` comes from a database
   `CHECK`. The same instinct everywhere: an empty findings list under a failed external read is
   not agreement, and an empty queue is not a filter hiding something. Say which.
3. **No keyboard shortcut completes a decision.** Shortcuts navigate and open. Every
   consequential act goes through `DecisionDialog`, which requires the caller to state what the
   button will do.
