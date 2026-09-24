# 0062. An instalment plan is a timeline of what the statement said, and an explicit list of what it did not

**Status:** Accepted

## Context

[ADR-0060](0060-a-statement-line-says-what-it-was-for-and-what-it-is-not.md) taught the reader to
tell an instalment repayment from a purchase, and to refuse to file either the repayment or the
tax beside it as spending. That stopped a wrong total. It did not tell anybody what is going on.

On the owner's ledger a single financed purchase is scattered across a card statement as:

| Row shape                                          | What it is                     |
| -------------------------------------------------- | ------------------------------ |
| `<MERCHANT> - Principal Amount Amortization <2/6>` | one repayment of the principal |
| `<MERCHANT> - INTEREST 2 - <2/6>`                  | the cost of paying over time   |
| `CGST` / `SGST`                                    | tax charged on that interest   |
| `EMI … FEE`                                        | a one-off processing fee       |

Four rows, four dates, one purchase. Each renders correctly and separately, and nowhere does the
product say _these belong together, this is instalment 2 of 6, and here is what has happened so
far_. A person looking at any one of them has to hold the other three in their head.

The obvious way to build this is the wrong one. A recurring debit of a similar amount to the same
merchant **looks** exactly like an instalment plan, and a reader that grouped on recurrence would
invent a tenure, invent a schedule, and start telling somebody they owe four more payments that no
bank ever committed to. Gyms, subscriptions and rent all produce that pattern. The product would
be asserting a financial obligation from a coincidence.

## Decision

### The statement is the only source, and the marker is the only tenure

`domain/instalment.ts` is pure, local and deterministic. It reads plans out of rows that
`readStatementRow` has already classified, and it groups by `merchantKey` — but **only rows whose
nature is already instalment-shaped** (`instalment_principal`, `instalment_interest`) or a fee or
tax row that sits within such a group's span.

**Tenure comes from the `<n/of>` marker the issuer printed, and from nothing else.** No row states
it, there is no tenure: `tenure: { known: false }`, and the timeline contains only what has been
observed. Recurrence is never evidence of a plan's length, because it is not.

### Four certainties, and they are not interchangeable

Every position in a timeline is exactly one of:

- **`observed`** — a real statement row exists. It carries its own amount, date and payment id.
- **`expected`** — the issuer printed `of`, and this position is within `1..of` but has not been
  seen. It carries **no amount and no date**. It means "the statement says there are six of
  these", not "₹X is due on the 5th".
- **`inferred`** — reserved, and currently never produced. The type exists so that a future
  reading which genuinely derives a position (for example, from a stated plan total the issuer
  also printed) has somewhere honest to go. Nothing may emit it without its own ADR.
- **`unknown`** — the tenure was never stated, so how many positions exist is not a fact this
  product holds.

A screen renders the word. It never has to work out which of the four it is looking at.

### What is deliberately never produced

No due date. No interest rate. No amortisation schedule. No "you have ₹X remaining". No statement
about whether the issuer applied its own policy correctly. Each of those is either a bank's
internal fact or arithmetic over an assumption, and the product holds neither. An instalment plan
with a known tenure and three observed repayments reports exactly that.

### Tax joins the plan and is never a purchase

A bare `CGST`/`SGST` row inside a plan's span attaches to the plan as a tax component. This is the
same rule ADR-0060 set, carried one level up: the tax is part of the cost of the plan, it is not a
thing anybody bought, and it can never appear as a second purchase or a duplicate of one.

### A recognised plan is quiet

Principal, interest, tax and the card-bill payment, once they belong to a recognised plan, raise
no question. They are explained by the plan, the plan is on the event's own screen, and asking
"what was this for?" about instalment four of six is asking somebody to answer the same question
six times. This is the same judgement phase C made when it kept a hundred and forty unexplained
imported rows out of the review queue.

## Consequences

- **It works with no provider configured**, like every other reading in this product. There is no
  model in this path and no network call.
- **It writes nothing.** No table, no migration, no link, no proposal. The timeline is a derived
  read over immutable rows, so a re-read after a correction reflects the correction, and nothing
  it produces can be wrong in a way that outlives the rows it read.
- **A plan is only as good as the issuer's wording.** A statement that prints no `<n/of>` marker
  yields a plan with an unknown tenure and an observed-only timeline — which is the honest answer,
  and visibly different from a confident wrong one.
- `web/` performs no arithmetic here: the grouping, the totals per component, the certainty of
  each position and the sentences are all the API's.
- **`inferred` is a promise, not a feature.** It is in the type so that the day somebody wants a
  derived position, the absence of one today is visible in the diff rather than invented quietly.
