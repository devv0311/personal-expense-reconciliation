# 0063. An anomaly is a comparison with its evidence attached, and never an accusation

**Status:** Accepted

## Context

A card statement contains a small number of rows that are genuinely worth a second look: a fee
that is much larger than the same merchant's other fees, interest with no instalment plan to
belong to, the same amount charged twice in a day, an instalment whose principal does not match
the others in its own plan.

It also contains a great many rows that look irregular and are not. On the owner's ledger, of 120
rows, 40 are a bare `CGST`/`SGST`, 13 carry `INTEREST`, 8 are principal amortisation, 7 are an EMI
fee and 3 are the card bill being paid. **Seventy-one of 120 rows are things a naive irregularity
detector would flag**, every one of them normal. A product that surfaced them would train its
reader to dismiss the list within a day, and the one real finding would go with them.

There is a second failure available here and it is worse than noise. A financial tool that says
"this charge is suspicious", "the bank has overcharged you" or "this may be fraud" is making a
claim it cannot support from a statement line. It does not know the merchant's pricing, the card's
terms, or what the person agreed to. Saying so anyway is both wrong and alarming, and it invites
somebody to act — call a bank, dispute a charge — on the product's confidence rather than on
their own reading.

## Decision

### An anomaly is a comparison between rows, stated as a comparison

`domain/anomaly.ts` is pure and deterministic. Every finding it produces names **the rows it
compared** and says what differs between them. The reader is told what was noticed, not what it
means:

> Two payments to the same place, for the same amount, three hours apart.

not

> Possible duplicate charge — you may have been billed twice.

The first is a fact about two rows and is always true. The second is a guess about the world, and
on a statement where somebody legitimately bought two identical coffees it is simply wrong.

### Every finding carries its evidence, or it does not exist

A finding must reference the payments it is about — at minimum the row in question plus the basis
it was compared against. A finding with nothing to point at is an opinion, and this product does
not hold opinions about money. The screen renders those references as links to the events
themselves, so the answer to "why are you telling me this?" is always one tap away.

### Suppression is the feature, not a filter over it

A row that a recognised instalment plan already explains
([ADR-0062](0062-an-instalment-plan-is-a-timeline-of-what-the-statement-said.md)) **cannot** be an
anomaly. Neither can a tax component, a card-bill payment, or a principal repayment whose plan is
known. This is enforced in the domain, before any finding is built — not by a UI that hides rows
after the fact, because a list that is filtered can be unfiltered by the next person who touches
it, and a rule that lives in the domain cannot.

### The kinds are few, and adding one is a decision

This slice ships four, each chosen because it is checkable from statement rows alone:

| Kind                      | The comparison                                                 |
| ------------------------- | -------------------------------------------------------------- |
| `unexplained_interest`    | interest with no instalment plan it belongs to                 |
| `inconsistent_instalment` | principal amounts that differ within one plan                  |
| `unusual_fee`             | a fee much larger than the same merchant's other fees          |
| `repeated_charge`         | the same merchant and amount, close together, outside any plan |

A fifth kind is a change to this ADR. The bar is that it must be decidable from evidence the
ledger already holds, and that its false-positive rate on a real statement must be low enough that
the list stays worth opening.

### Nothing here enters the review queue

Anomalies are a read, surfaced on **Spending** and on the event's own screen. They are not
questions, they do not block the decision flow, and they carry no accept/reject. There is nothing
to approve because nothing has been proposed — the product noticed a comparison and said so.

This is the same judgement phase C made in keeping a hundred and forty unexplained rows out of the
queue: a queue is a place where work gets finished, and a queue that fills with things nobody can
finish stops being one.

## Consequences

- **The list is short or empty, and empty is a good outcome.** An anomaly surface that reports
  nothing on a clean statement is working. The screen says so in words rather than showing zero.
- **Nothing is written.** No table, no migration, no state, no audit entry — there is no decision
  to audit, because the reader is not asked to make one. The findings are recomputed from
  immutable rows on every request, so a correction to a row changes what is reported without
  anything needing to be retracted.
- **No model, no network.** Like every other reading in this product, this one runs on the
  installation as it ships. `ai-boundary.md` lists "anomaly explanation" as something AI may
  eventually propose; this is not that, and a model proposing an explanation later would still go
  through `recordClassificationProposal` and a human decision, not through this read.
- **A false positive costs a glance; a false negative costs nothing the ledger did not already
  hide.** The thresholds are deliberately conservative in that direction. They are stated in the
  domain as named constants with the reasoning beside them, so tightening one is a visible change.
- `web/` performs no arithmetic and writes no copy: the comparison, the figures and the sentence
  are all the API's.
