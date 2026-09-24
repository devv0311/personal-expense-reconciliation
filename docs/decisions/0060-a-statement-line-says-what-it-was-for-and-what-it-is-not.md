# 0060. A statement line says what it was likely for — and, first, what it is not

**Status:** Accepted

## Context

`classifyPayments` has had two legs since ADR-0023: a deterministic one that pairs both sides of
a transfer between the user's own accounts, and a model one for everything else. On the
installation this product actually ships as — no `ANTHROPIC_API_KEY`, no provider — the second
leg cannot run, and ADR-0059's predecessor made its absence honest rather than fatal:
`classifyPayments({ deterministicOnly: true })` paired what it could and reported
`no_model_configured` for the rest.

On a ledger of imported statements, "the rest" is everything. The owner's ledger holds 120
payments from five credit-card statements; the deterministic leg had an opinion about none of
them. So every row arrived unexplained, nothing was ever proposed, **Needs attention** carried
no question about what anything was for, and Overview reported nothing spent over statements it
had read in full. The product could not answer its own first question without a model it does
not ship with.

Meanwhile the answer was sitting in the rows. `Q SYN FITNESS` is not a hard inference problem.

**But a credit-card statement is mostly not purchases**, and that is the part a naive reader
gets wrong. Counted on the owner's own ledger:

| Rows | What they are                                                        |
| ---- | -------------------------------------------------------------------- |
| 40   | a bare `CGST` or `SGST` — tax charged on another line, naming nobody |
| 13   | `… - INTEREST …` — the cost of paying over time                      |
| 8    | `… - Principal Amount Amortization - <2/3>` — repaying a purchase    |
| 7    | an `EMI … FEE`                                                       |
| 3    | the card bill being paid                                             |
| 40   | actual merchant purchases                                            |

A reader that matched merchant words first would file six interest rows under **Gym & fitness**
because the gym's name is printed beside them, and would invent purchases out of tax lines. It
would overstate what somebody spent, and attribute it to a shop they did not pay.

## Decision

### The nature of the row is decided before any category is considered

`domain/purpose.ts` is pure, local and deterministic — no network, no merchant directory, no
model. It reads a line into a {@link RowNature} first: `merchant_purchase`,
`instalment_principal`, `instalment_interest`, `card_fee`, `tax_on_another_line`,
`card_bill_paid`, `refund_or_reversal`, `money_in`, `unreadable`.

**Only `merchant_purchase` is offered a merchant-derived category.** Every other nature is
explained in words instead — what the line actually is, and what it belongs to. The lexicon
never overrides the nature: a row carrying `INTEREST` is interest even when the merchant's own
name sits next to it on the same line. `countsAsPurchase` travels with the reading so no caller
has to re-derive that rule and disagree about it.

### It proposes through the path that already exists

The reading becomes exactly the `TransactionClassification` a model would have produced,
recorded by the same `recordClassificationProposal`, checked by the same
`validateClassificationProposal`, routed by the same `routeClassificationForReview`, and
confirmed by the same `decideInference`. There is no second approval path and no second
definition of a category. `modelInfo` says `provider: 'local'`, which is true; the
`ai_inferences` provenance columns are nullable and have never claimed a model ran.

`relationshipType` is always `personal`. A statement line says what left an account and nothing
about who else benefited, and `personal` is the one relationship that creates no obligation by
construction — so confirming a category can never fabricate a debt.

### Three kinds of row are deliberately never proposed

A tax line, an instalment repayment, and any credit. Each would be a suggestion somebody might
agree with, and agreeing would put the same money in a total twice. They keep their plain
explanation on their own screen; what they do not get is something to say yes to. **Interest and
card fees are proposed** — they are real costs — as `Bills & subscriptions`, never as the
merchant beside them.

### Confidence is a phrase, not a number

`This looks like` / `This is probably` / `This might be`. One matching word is a hint and
reaches `medium`; corroboration — a second word, or the same merchant seen twice before — is
what reaches `high`; two categories fitting equally well drops to `low`. A category the person
has already confirmed for that merchant outranks every word, because it is a decision rather
than a guess. No percentage appears anywhere: a number invites somebody to trust the arithmetic
behind it instead of reading the sentence.

### Alternatives are re-derived, never stored

The stored proposal holds the category a confirmation agrees with. The alternatives beside it
are re-read from the payment's own words on every request. `inferPurpose` is deterministic, so
re-reading gives the same answer, and a stored second copy is how a screen ends up offering
choices that no longer match the reading.

## Consequences

- **The product works with no provider configured**, which is how it ships. A model, when one is
  configured, still runs in its place — the local leg is the fallback, never a competitor, so a
  payment never collects two proposals.
- **A confirmation teaches the ledger locally.** The next payment worded the same way leads with
  the category the person chose, sourced from the **approved** expense — never from another
  suggestion, so a guess cannot bootstrap itself into a pattern.
- **Confirming no longer raises a new question.** `personal` and `gift` are excluded from the
  "who benefited from this?" backlog: neither can create an obligation, so their own record
  already answers it. Without this, answering one question produced another every time.
- `web/` performs no financial arithmetic here either: the reading, the ranking, the confidence
  and the wording are all the API's, and the screen renders them.
- The lexicon is small, local and deliberately not a merchant directory. A miss costs one tap on
  **Something else**; a confident wrong answer costs a wrong total, so every entry is a word
  whose meaning is unambiguous alone. `run` was removed during implementation for exactly that
  reason — it is a word about motion long before it is a word about gyms.
