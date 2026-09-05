# 0027. Phase 8 classifies debits; a credit is deliberately left unclassified

> **Scope extension (2026-09-05).** This records Phase 8's shipped classifier.
> [ADR-0017 (cash balance)](0017-pragmatic-cash-balance-reconciliation.md) accepts a new
> cash-flow interpretation path for credits as well as debits. Preserve the legacy behavior
> until that path is implemented; do not treat this ADR as a ban on Phase 16's credit support.

**Status:** Accepted

## Context

`fixtures/bank-statement.csv` has two credits: the incoming leg of the self-transfer, and

```
2026-07-05,ACH REFUND SAMPLE ELECTRONICS STORE,450.00,CREDIT,ACH/REF9981
```

Phase 7 resolved the refund's merchant and left it at `normalized`, noting that "whether it is
a refund is classification, not normalization". So phase 8 has to say what it does with it.

`ai.classifyTransaction` proposes `expense` or `settlement` (ADR-0007). Neither fits:

- An **`Expense` is a spend event** (`domain-model.md`'s two-categories table). Money arriving
  is not spending, and `expenses.amount > 0` with debit semantics throughout.
- A **merchant refund is an `ExpenseAdjustment`** (ADR-0008), which nets against an _existing_
  expense. It needs an original to net against — and this fixture has none, because nothing in
  the statement is a Sample Electronics purchase. Matching a credit to its original is
  `services.recordExpenseAdjustment`'s question (`data-flow.md` step 6a), not
  `classifyTransaction`'s; the proposal type for it is not one of `ai-boundary.md`'s nine
  operations.
- A **received settlement** is expressible — `Settlement` reads direction from its `Payment`, so
  a credit settlement is perfectly well-formed. But a settlement discharges an obligation, and
  obligations come from allocations, which are phase 12.

Above all of that sits ADR-0015: V1 "deliberately does not build a general income/inflow
accounting system", and `lifecycle.md` already states that an ordinary credit "is not required
to ever reach `LINKED` or `IGNORED`" — staying at `NORMALIZED` indefinitely is valid.

## Decision

**A credit is not offered to the AI leg.** `domain.classificationEligibility` returns
`deterministic_only` for it, with the reason `credit_out_of_scope`, and the run records that
outcome rather than silently passing over the row.

A credit still goes through the **deterministic** leg, because the self-transfer rule needs both
legs to classify either (ADR-0023). That is the entire reason eligibility has three outcomes
rather than two.

As defence in depth, the semantic gate (`validateClassificationProposal`) also rejects an
`expense`-kind proposal against a credit payment, whatever direction the eligibility rule took.
That path is reachable from `decideInference`'s `modify`, where a human may change the proposed
kind after the fact.

## Consequences

**The fixture's refund credit ends the phase exactly as phase 7 left it**: `state = normalized`,
`counterparty_type = merchant`, no `AIInference`, no `Expense`. The run reports
`skipped: credit_out_of_scope` for it — a recorded outcome, the same stance phase 7 took toward
an unresolved counterparty.

**No model call is made for it**, so no proposal exists for anyone to review, and the ledger does
not accumulate pending inferences about money it has decided not to account for yet.

**Recording a refund remains possible today, manually.** `services.recordExpenseAdjustment` and
`services.distributeAdjustment` already exist and take the credit `Payment` as
`adjustment_payment_id`. What is missing is only the _proposal_ that matches a credit to its
original expense — which needs allocated expenses to match against.

**When inflow classification arrives, this is the seam.** The eligibility rule is one function
with one branch, and the reason code (`credit_out_of_scope`) is already the name of what has to
change. A future phase adds the credit-side proposal type and flips that branch.

## Alternatives considered

- **Offer credits to the AI leg with `settlement` as the only permitted kind.** Tempting — it
  would complete the settlement path in both directions. Rejected because it means asking the
  model about every income credit the ledger ever imports, which is precisely the general-inflow
  classification ADR-0015 put out of V1; and with no balances to discharge yet, every answer
  would be an unreviewable guess sitting in the queue. A received settlement can still be
  recorded manually through `services.recordSettlement`, which has existed since the foundation
  pass.
- **Add a `refund` member to `proposedKind`.** Rejected: it would make `classifyTransaction`
  able to propose something that is not an `Expense` or a `Settlement`, breaking ADR-0007's
  discriminator, and an `ExpenseAdjustment` proposal genuinely needs a different input (which
  expense is this against?) and a different shape. If refund matching becomes an inference, it
  deserves its own operation, not a third member of this one's enum.
- **Classify the refund credit as an expense with a negative amount.** Rejected outright:
  `expenses_amount_check` forbids it, ADR-0008 exists specifically so a refund never mutates or
  mirrors the expense it offsets, and a negative expense would corrupt every total that sums
  `netAmount`.
