@AGENTS.md

# web/ — persistent context

**Read `Design.md` before any visual or component change.** It's authoritative for tokens,
typography, component principles, layout/responsive/accessibility rules, and two documented
pitfalls (a `tailwind-merge` custom-token gotcha, a Tailwind v4 font-size-namespace mistake) worth
not re-making. See `README.md` for how to run this package and what phase 15 built.

**Phase 22 (ADR-0050) roughly doubled this package**, closing the capability audit's finding
that phases 1–21 completed their own scopes without ever making the workflows reachable from a
browser. New here: the payment workspace and statement import, the evidence library and its
intake forms, the allocation editor, item entry/correction, funding links, settlements, the
session gate, Splitwise connection and re-sync, analytics, rules, jobs, occasions, and the
audit-trail screens. None of it widened what this package may do — the rules below held without
exception, and `receiptId` on `GET /api/evidence/:evidenceId` is the only read that was added.

**After phase 22**, four unnumbered capabilities added screens here: sending a reviewed proof
pack (ADR-0053), a live-balance panel that sits visibly *after* the waterfall and never inside
it (ADR-0054), statement import for real formats (ADR-0051), and the rebuilt Splitwise repair
(ADR-0055). Rule 1 held throughout, and the repair is a good illustration of what it costs:
the screen has to state, before a person confirms, whether a push corrects their entry, removes
it, or puts one back — so the API sends `plannedRepair` per row. Working it out here from
`currentNetAmount === "0"` would have been one comparison and a second copy of a rule that must
agree with the repair forever.

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

## The Design Standard — Tier-1 UI/UX

The quality bar is **Linear / Mercury / Ramp / Raycast-level craft**. This is a mandatory
product standard, not optional decoration. Build high-density information architecture with
clear hierarchy, exact amounts, aligned numeric columns, accessible contrast and progressive
disclosure. Preserve room to think without hiding financially important information.

`web/` must support keyboard-first navigation: `Cmd+K` (and `Ctrl+K`) command search,
discoverable triage shortcuts, predictable focus, selection and escape behavior. Consequential
approval remains explicit; a shortcut must not silently approve an ambiguous decision. Use
visual reconciliation waterfalls from evidenced opening cash through credits/debits to actual
closing cash and the signed delta, with drill-through to contributing records. Show account
completeness and unexplained amounts alongside the number. Use zero-clutter inspectors for
source evidence, interpretation, decision and audit history, plus refined micro-interactions
that communicate selection, progress and completion. Honor reduced motion, loading/error/empty
states, responsive layouts and keyboard accessibility. Test rendered flows with synthetic data.

`web/Design.md` is authoritative for how this is realised, and ADRs 0042/0043/0048/0049 record
the decisions behind it. **Phase 21 delivered this standard across all six pillars**: six
sections plus five detail screens, a `Cmd+K` command palette, `j`/`k`/`Enter` triage, the
account-level cash waterfall, the interactive item-refund splitter, the evidence inspector with
per-signal match verdicts, the Splitwise finding review, and the proof-pack export review. It
holds a hard bar — axe reports 0 violations on every screen in desktop light, desktop dark and
mobile — and closed two accessibility defects inherited from earlier phases (a contrast failure
in the `ink-faint` token, and scroll containers no keyboard could reach). A change to `web/`
starts by reading `Design.md`.
