# 0065. Declining a pattern is a decision too, and approving one shows its reach first

**Status:** Accepted

## Context

[ADR-0064](0064-a-pattern-is-a-proposal-a-person-approves-before-it-ever-matches.md) made learning
reviewable: a confirmation produces a proposal, a person approves it, and an approved rule
suggests rather than files. Driving it revealed three gaps, and the ADR named two of them itself
as accepted costs. On a real ledger they stop being acceptable.

**Declining did nothing.** ADR-0064 said so deliberately: _"Rejecting one is not even a write — a
rejected proposal is simply one nobody approved, and it will be offered again if the
confirmations still support it."_ The reasoning was that a stored dismissal is a second kind of
decision with its own lifecycle. That is true, and it is the wrong trade. The confirmations
behind a pattern do not go away — they are approved expenses — so a pattern declined once is
offered again on the next page load, forever. A surface that re-asks a question already answered
is not calm, and it teaches its reader to stop looking at it. That is the same alert-fatigue
failure [ADR-0063](0063-an-anomaly-is-a-comparison-with-its-evidence-attached.md) was written to
avoid, arriving through a different door.

**The reach of a pattern was invisible.** The dialog quoted the wording, which is necessary and
not sufficient. `contains "CAFE"` and `contains "HARBOUR CAFE BANDRA"` look equally reasonable in
a sentence; what distinguishes them is how many payments on file each one actually hits. ADR-0064
recorded this as the residual risk — _"Approving `contains CAFE` will suggest Dining for a café
nobody meant"_ — and left it to the reader's judgement without giving them the one fact that
judgement needs.

**Deactivation was never stated.** `updateRule({ active: false })` has existed since phase 22 and
does the right thing, but the control is a bare button in a list. What it does to the payments a
rule already touched — nothing — is exactly the question somebody hesitates over, and the screen
did not answer it.

## Decision

### A dismissal is a recorded decision, and it is reversible

`rule_proposal_dismissals` stores one row per pattern a person has declined: the wording, the
category, who declined it, when, and **why, in their own words**. The reason is required by a
database `CHECK`, for the same reason `evidence_match_candidates` requires an actor and an instant
before reaching `dismissed` — a decision nobody can account for is not one.

A dismissed pattern stops being offered. `listRuleProposals` filters on the dismissal, not on
anything about the confirmations, so the approved expenses behind it keep teaching
`inferPurpose` exactly as they did; only the _offer_ goes away.

**Nothing is deleted, and restoring is a decision of the same shape.** A dismissal is closed by
setting `restored_at`/`restored_by`, never by removing the row, so the sequence "declined this,
changed my mind, approved it later" is legible in the audit trail afterwards. Dismissed patterns
remain listed, collapsed, with what was said about them.

This is the second decision lifecycle ADR-0064 did not want. It is worth it because the
alternative is a surface that asks the same question forever, and because the lifecycle is two
states rather than a workflow.

### A proposal shows what it would match, before the button

`listRuleProposals` now reports, for each proposal, the payments on file whose wording the rule
would match — split in two, because the two halves mean different things:

- **Already filed this way** — the confirmations the pattern was derived from. Reassuring.
- **Would also match** — payments the rule would newly start suggesting for. **This is the number
  that tells somebody their wording is too wide**, and it is the one the dialog leads with when it
  is not zero.

A payment appearing under "would also match" is not a problem; it is usually the point. What the
reader needs is to see _which_ ones, so that `CAFE` catching a hardware shop is visible before
approval rather than after.

The match is computed with `domain.descriptionMatches` — the same predicate `ruleMatches` uses,
so the preview cannot disagree with what the rule will actually do.

### Deactivating stops suggestions and touches nothing else

The existing `updateRule({ active: false })` path is kept as-is; what changes is that the screen
now states its consequence before it runs, through `DecisionDialog` like every other consequential
act. The sentence it has to earn:

> Payments it already matched keep the categories you confirmed, and the rule stays on file with
> what it did.

That is true by construction and is now asserted rather than assumed. Deactivating:

- writes only `rules.active`;
- leaves every `payment` row, every approved expense and every recorded decision untouched;
- leaves `times_applied` and `last_applied_at` as they are, because they are a record of what
  happened rather than a counter of what is switched on;
- leaves the `rule:<id>` attribution on proposals it already produced, because that attribution is
  a historical fact and rewriting it would be forging the audit trail.

Reactivating is the same act in reverse and equally unremarkable.

## Consequences

- **The offer list empties.** A person who declines every pattern sees "no patterns to suggest"
  and keeps seeing it, which is the correct end state and was previously unreachable.
- **One new table, no new arithmetic.** The dismissal stores strings and instants. Nothing in this
  ADR computes, stores or compares a monetary amount; the preview counts payments and quotes their
  wording.
- **Learned rules stay proposal-only.** Unchanged from ADR-0064 and re-asserted by test: no
  auto-approval, no effect parameter, no model confidence reaching a write.
- **The preview is O(payments) per proposal.** Acceptable at personal-ledger scale and the same
  trade `getPaymentConnection` and the instalment reader already make; a proposal list that was
  fast and wrong about its own reach would be worse.
- **A dismissal keyed on wording, not on a payment.** Re-confirming the same merchant does not
  resurrect a declined pattern, which is intended: the person declined the _pattern_, and the
  evidence for it growing is not new information about their decision. The cost is that somebody
  who dismissed too hastily has to restore it deliberately — which is why restoring is one click
  from the same screen rather than buried.
