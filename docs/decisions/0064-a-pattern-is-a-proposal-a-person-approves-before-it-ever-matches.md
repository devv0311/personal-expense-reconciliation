# 0064. A pattern is a proposal a person approves, before it ever matches anything

**Status:** Accepted

## Context

The product already learns, and that is the problem.

[ADR-0060](0060-a-statement-line-says-what-it-was-for-and-what-it-is-not.md) ends with: _"A
confirmation teaches the ledger locally. The next payment worded the same way leads with the
category the person chose, sourced from the **approved** expense."_ That is implemented and it
works — `inferPurpose` reads sibling payments carrying a `confirmedCategory` and lets a confirmed
category outrank every lexicon word.

But it happens **inside a function**. A person who confirmed `Dining` for a café three months ago
cannot see that a pattern now exists, cannot read what wording it keys on, cannot correct it when
the wording is too broad, and cannot switch it off. The learning is real, invisible and
unreviewable — which is the combination `ai-boundary.md` exists to prevent. `CLAUDE.md` has listed
"rules that learn" under **deliberately unbuilt** for exactly this reason.

Meanwhile the machinery for the reviewable version has been sitting complete and unused:

- `rules.origin` already has the value `promoted_from_repeated_ai_suggestion`, and **nothing has
  ever written it**.
- `domain/rules.ts` already has `ruleMatches` — pure, total, exact — and `ruleActor(id)`, which
  yields the `rule:<id>` actor string `invariants.md` #17 permits.
- `rules.effect` already distinguishes `propose` (the default, the safe one) from `apply`.

So the decision is not whether to build a rule engine. One exists. It is what a confirmation is
allowed to do with it.

## Decision

### A confirmation produces a proposal, and a proposal is not a rule

`domain/learning.ts` reads a person's **approved** expenses and the payments behind them, and
where several of them share merchant wording and one category, it produces a
`LearnedRuleProposal`. A proposal is a derived read. It is not stored, it matches nothing, it
changes nothing, and it disappears the moment the confirmations behind it change.

**Only a person turns one into a rule.** `approveRuleProposal` is the single path, it goes through
the existing `createRule`, and until somebody calls it the pattern has no effect on anything.

### A learned rule proposes; it never writes

Every rule created this way is `effect: 'propose'`. Not by convention — the service refuses any
other value, so there is no argument to pass that would make a learned pattern write a category
into the ledger unattended.

What an approved rule does is make the local reader lead with that category and **say which rule
said so**. The payment still becomes a proposal, that proposal still goes through
`recordClassificationProposal` → `decideInference`, and a person still confirms it. "The rule
applied" means "the rule wrote the suggestion", never "the rule decided the money".

This is the distinction `ai-boundary.md` draws between an inference engine and a source of truth,
applied to a deterministic matcher rather than to a model. A rule is more trustworthy than a model
— its match is exact and re-runnable against immutable columns — and it still does not get to
approve a transaction.

### Only an approved expense may teach

The confirmations a proposal is built from come from expenses in state `approved`. A pending
proposal, a rejected one, or another rule's suggestion can never contribute.

Without this the system bootstraps itself: a guess proposes a category, the guess is counted as
evidence, the pattern hardens, and a wrong reading becomes a standing rule nobody ever agreed to.
ADR-0060 drew this line for the implicit learning; it holds identically here, and it is the single
most important sentence in this ADR.

### Only a purchase may form a pattern

A proposal is built only from rows whose nature is `merchant_purchase`. Tax components, interest,
principal repayments, card fees and bill payments are excluded in the domain, before any grouping
— the same suppression
[ADR-0063](0063-an-anomaly-is-a-comparison-with-its-evidence-attached.md) applies to anomalies,
for the same reason. A standing rule that fired on every `CGST` row would be a machine for
producing wrong totals.

### The wording is shown, because that is the thing being approved

A proposal carries the exact text it would match on, the operator (`contains`), the category, and
**the payments it was derived from**. The dialog quotes all of it before the button.

That is the difference between approving a pattern and approving a feeling about one. A person
cannot judge "learn from my Dining confirmations"; they can judge "match any payment whose wording
contains `HARBOUR CAFE`, and suggest Dining". The second is correctable, and correcting it — by
rejecting and confirming a narrower wording — is the intended workflow rather than a failure of it.

### What is refused, and why each one

| Refused                                      | Because                                                               |
| -------------------------------------------- | --------------------------------------------------------------------- |
| Fewer than two confirmations                 | One confirmation is a decision about one payment, not a pattern       |
| The same wording confirmed as two categories | The person disagreed with themselves; a rule would silently pick one  |
| Wording shorter than four characters         | `CAF` matches things nobody meant; a short rule is a wide rule        |
| Wording an active rule already covers        | A second rule for the same text is a conflict waiting to be reported  |
| Anything but `merchant_purchase`             | Card mechanics are not purchases and must never become standing rules |

## Consequences

- **Learning becomes visible without becoming more powerful.** ADR-0060's implicit confidence
  boost is unchanged and still runs; this adds a surface where the same knowledge can be read,
  approved, corrected and switched off. A person who approves nothing is exactly as well served as
  they are today.
- **`rule:<id>` attribution reaches the proposal.** A reader who asks why a payment leads with a
  category gets the rule's name and its matched wording, not "the system thought so".
- **Nothing is deleted or superseded.** Proposals are derived; approving one creates a row and
  changes no existing one. Rejecting one is not even a write — a rejected proposal is simply one
  nobody approved, and it will be offered again if the confirmations still support it. That is
  deliberate: a dismissal that persisted would be a second kind of stored decision with its own
  lifecycle, and this slice does not need one.
- **`set_expense_category` rules remain inert at apply time.** `applyRules` still reports
  `Category rules apply when an expense exists` and writes nothing, because creating an expense to
  hang a category on would be the rule deciding that a payment _is_ a purchase. This ADR does not
  change that; it routes the category through the proposal path instead, where a person is already
  waiting.
- **A wide rule is the residual risk.** Approving `contains CAFE` will suggest Dining for a café
  nobody meant. The mitigations are that it only ever suggests, that the matched wording is on
  screen before approval, and that the rule can be deactivated. There is no automatic narrowing,
  and adding one would be a change to this ADR.
