# 0014. Non-user settlement observability is a documented boundary, mitigated by a derived, read-only `ObligationEvidenceStatus`

**Status:** Accepted

## Context

ADR-0006 generalized `Balance`/`Obligation` to a pairwise function between any two people, which
correctly makes an obligation between, say, two flatmates (neither of whom is the user)
representable and computable. But its _discharge_ — a `Settlement` — can only ever be backed by
a real `Payment`, and a `Payment` can only exist for money that moved through an `Account` the
user owns (`Account` invariants). A settlement between two people who are both someone other than
the user can never produce a `Settlement` row here. This was documented as "a known, documented
limitation" in the prior revision, with a note that the product should distinguish "confirmed by
a Settlement-backed Payment" from "believed settled per manual note/Splitwise, unconfirmed by our
own ledger" — left as an unspecified UI-level idea for a later phase.

Before this can be called implementation-ready, that idea needs an actual, concrete design: what
data it's computed from, whether it's authoritative or advisory, and confirmation that it doesn't
require fabricating a `Payment` (which `CLAUDE.md`'s financial safety rules already forbid) or
otherwise weakening any of `Balance`, reconciliation, Splitwise reconciliation, or settlement
recording.

## Decision

Reframe the limitation explicitly as an **observability boundary** — a fact about what data can
physically reach this system, not a defect in how the data that does arrive is modeled — and
confirm, by construction, that `Balance`, `ReconciliationRun`, Splitwise reconciliation, and
`services.recordSettlement()` all continue to work correctly under it (`invariants.md` #9b spells
out each of the four).

Add `domain.obligationEvidenceStatus(X, Y)`, a **derived, read-only** three-value status computed
whenever `NetBalance(X, Y) > 0`, from data already in the model — no new table, no fabricated
`Payment`/`Settlement`:

- `open, unconfirmed` — no `Settlement` and no other evidence either. The default.
- `believed_settled, unconfirmed_by_ledger` — a manual `Evidence` row (`type = manual_note`,
  `note_kind = 'settlement_claim'`) referencing a contributing `Expense` claims it was cleared
  some other way, **or** the latest `ReconciliationRun` shows a Splitwise-side discrepancy
  suggesting a lower/zero balance.

  > **Amendment (2026-08-15, ADR-0018).** As originally written this bullet said only
  > "a manual `Evidence` row (`type = manual_note`)". That is the _same shape_ ADR-0006 gives
  > every externally-funded expense as its only evidence, so implementing the rule literally
  > reported every such obligation as believed-settled the moment it was recorded — the exact
  > opposite of what this status exists to show. `evidence.note_kind` discriminates the two;
  > see ADR-0018.

- `settled, confirmed` — `NetBalance` is 0, or reachable via an actual `Settlement`.

This is purely a display-time annotation. It never mutates `NetBalance`, is never itself an
`AIInference`, and requires a human's explicit, audited action (e.g. resolving the matching
`ReconciliationRun` discrepancy) before the underlying `Balance` figure stops surfacing the
open obligation — the status can _say_ "believed settled" without the ledger's own numbers
silently agreeing.

## Consequences

`domain-model.md`'s Obligation/Balance/Settlement section carries the full design.
`invariants.md` gained #9b. `ai-boundary.md` gained an explicit "AI may not compute or influence
this" line, since it's new enough to otherwise be an ambiguous case. `fixtures/non-user-
obligation.json` updated to exercise both status-producing signals (a `manual_note` `Evidence`
row, and a `ReconciliationRun` discrepancy) and assert `NetBalance` is unaffected by either.
`roadmap.md`'s open question is downgraded from "a UI-level mitigation noted for a later phase"
to "the design exists; wiring it into the balance-display UI is the remaining Phase 13 work" —
a smaller, better-scoped remainder.

## Alternatives considered

- **Do nothing further; leave it as prose in the "known limitation" paragraph.** Rejected — the
  user explicitly asked for the system to be able to _show_ "expected obligation exists, but no
  settlement evidence is available," which prose in a design doc does not satisfy; it needed a
  computable, named concept.
- **A new `believed_settlements` table a human explicitly writes to.** Considered — would let a
  human directly assert "I believe this is settled" as its own record. Rejected as unnecessary
  for now: the two signals already available (`Evidence` + `ReconciliationRun` discrepancies)
  cover the realistic cases, and adding a table whose only purpose is to store an unconfirmed
  belief risks that belief being mistaken for confirmation elsewhere in the codebase — the
  read-only, computed-from-existing-data approach keeps the "only a `Settlement` confirms
  anything" invariant simple and impossible to accidentally violate.
- **Fabricate a `Payment`/`Settlement` from Splitwise's record when Splitwise shows it settled.**
  Explicitly rejected per the task's own instruction and `CLAUDE.md`'s existing rule against
  inventing `Payment` records for transactions this ledger never observed — Splitwise is
  reconciled against, never trusted as a silent source of truth (invariant #18).
