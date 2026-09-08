# 0050. A capability is not shipped until a person can reach it

**Status:** Accepted

## Context

A capability audit dated 7 September 2026 (`audit-results/`) inspected the repository against
its own documentation and reached a verdict worth quoting exactly:

> the financial engine and several substantial review/reporting screens are implemented, but the
> website is not a complete end-to-end expense-reconciliation application. Completing phases
> 1–21 means completing their narrowed implementation scopes. It does not mean every product
> requirement, original AI operation or authoring workflow is available in the website.

It was right, and the failure it names is specific rather than general. Every phase closed
against its own scope. No phase's scope was "a person can do this from a browser", so the gaps
fell between them: an import service with no import screen, a merchant catalog with no way to
add an alias, an allocation engine reachable only over HTTP, a `ReceiptFacts` component with no
caller, six AI operations declared in `ai-boundary.md` and never implemented, an
`ExternalIntegration` nothing could connect.

The audit listed 54 rows and eight concrete dead ends. The sharpest was the first: **approve an
expense in the review queue, and there is nowhere to allocate it.** The expense detail said
"Nobody has been named a beneficiary yet" and offered no form. The workflow the whole product
exists to support stopped, in the middle, in the UI.

Two temptations were available and both were refused. The first was to treat the audit as a
scope dispute — the phases _were_ complete as written — which changes nothing about the person
who cannot allocate an expense. The second was to close the rows quickly by widening what the
frontend does: compute the missing figure, add the missing form field, let a screen decide.

## Decision

### The audit's rows are treated as defects, not as a wish list

Every row where a capability existed at the service or API layer and could not be reached from
the browser was closed by building the surface, not by re-describing the scope. Where the row
recorded something genuinely unbuilt — a message transport, a live bank adapter, a
natural-language interface — it stays unbuilt and stays named as unbuilt.

### Closing a gap never widens the frontend's remit

ADR-0048's rule held without exception through this work: **`web/` performs no financial
arithmetic.** Where a screen needed a figure that did not exist over HTTP, the _read_ was added
to the API. The reads added here are `receiptId` on `GET /api/evidence/:evidenceId` (a pointer
to an extraction, so an inspector reached from the library can open it) and nothing else — every
other screen in this work consumes a read that already existed, unchanged.

The two exceptions ADR-0048 already carved out are the same two: parsing what a person typed
into exact paise, and echoing a form's own entry total, labelled on screen as an entry check.
The allocation editor is the sharpest case. It names beneficiaries, states a method, and passes
through exactly what was typed; every amount that comes _out_ of a division — an equal split's
shares, a percentage of the gross, a group expanded into its members, a shared item split by
units — is the domain's, under the one Largest Remainder Method (`invariants.md` #12).

### A consequential act reaches the API only through `DecisionDialog`

Every write this work added — an import, a manual movement, a counterparty, a cash-flow
approval, an allocation, an item correction, a settlement, a rule, a Splitwise push — states its
consequence in words before the button that performs it, and the ones the service requires a
reason for cannot be confirmed without one (ADR-0049). `DecisionDialog` gained exactly one prop,
`confirmDisabled`, so a form inside a dialog can block its own confirm without weakening the
required-reason rule.

Three consequences are stated in the caller's own words because they are the ones a person is
most likely to get wrong:

- **Importing is all-or-nothing**, and a re-imported file is a recognised no-op rather than a
  second copy.
- **Approving a cash-flow role** names that category's own ADR-0017 evidence gate _before_ the
  request, so a person can go and record the missing evidence rather than discovering the
  refusal afterwards.
- **A re-sync writes into somebody else's ledger.** It is the only outward write in the product,
  it is one row at a time, and the reason is required because they are entitled to an account of
  why their number changed.

### Where a capability is deliberately absent, the screen says so

The audit's eighth dead end was a wording failure, not a missing feature: an unconnected
Splitwise produced an empty discrepancy list that rendered as _"No discrepancies — the ledger
matches"_. The rule this work applies everywhere is ADR-0046's, generalised: **an absence of
findings under an incomplete check is not agreement.** The Splitwise screen leads with whether
Splitwise was read at all; the payment workspace says when a total is a floor rather than a
count; an empty unlinked-evidence list says it is a statement about what is stored, not about
what is missing; and an expense with no funding link says that is the externally-paid shape
rather than a gap.

### Automation asserts labels, never amounts

Standing rules and the job queue are the two things the product now does without being asked
each time, and both are bounded the same way. A rule asserts one label and never an amount, and
`propose` is the default with `apply` opt-in per rule and marked as such on screen; an applied
write is attributed to `rule:<id>`, never to a person (`invariants.md` #17). A job orchestrates
service calls that already refuse to write approved state on their own, so what a job produces
is a queue item, never an approval. A dry run invalidates no cached read — a preview that
refreshed the workspace would look like it had acted.

## Consequences

- **The `web/` nav has more than six tabs, and that is deliberate.** Payments and Evidence join
  the six pillars because the pillars all begin at a cash movement or a document, and neither
  had a screen. Analytics, Automation and Setup sit in a quieter second group: none is a place
  you return to daily, and Setup in particular changes what the ledger can _say_ rather than
  what it says.
- **A browser sweep is part of shipping a screen, not a nicety.** Re-running axe across every
  route in light, dark, desktop and mobile found two real defects that the component tests could
  not: an `sr-only` caption escaping a table's scroll container and making the whole page pan
  sideways at 360px (an absolutely positioned element is not clipped by an ancestor's overflow
  unless that ancestor is its containing block — fixed once, in the `Table` primitive), and text
  links distinguished from surrounding prose by colour alone (WCAG 1.4.1). Both are now unit
  tests in `src/design-system.test.tsx` as well as fixed.
- **What remains unbuilt is now a shorter and more honest list**: a message transport for proof
  packs, live bank/card balance adapters, a natural-language interface, and bidirectional
  Splitwise sync beyond the single-row correction. Each still needs its own decision record.
- **The audit report stays in the repository.** It is the clearest statement of what "complete"
  did and did not mean at the end of phase 21, and a later reader is better served by the
  original verdict than by a summary of it.
