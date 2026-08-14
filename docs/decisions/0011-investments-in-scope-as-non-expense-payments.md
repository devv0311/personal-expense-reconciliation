# 0011. Investments are in scope, modeled as a non-expense payment classification

**Status:** Accepted

## Context

"Investments" appeared in `docs/product/overview.md` and `docs/domain/terminology.md`
("transfers or investments... not spending") but nowhere in the actual schema or in
`invariants.md` #20's reconciliation formula — no column, no `relationship_type` value, no
`counterparty_type` value. An investment payment (a mutual fund SIP, a stock purchase) had no
representable classification at all; it would have fallen into "unexplained" by default, which
is exactly backwards for a category the product docs explicitly say is *not* spending (review
finding #11).

## Decision

Investments stay in scope — the modeling cost is low and the alternative (stripping every mention
from the product docs) would remove a real, common personal-finance category for no benefit.

Investments are modeled the same way internal transfers already are: as a `Payment`
classification that excludes the payment from spend, not as an `Expense`.

- Add `investment_instrument` to `payments.counterparty_type`'s check constraint:
  `('merchant', 'person', 'internal_account', 'investment_instrument', 'unknown')`.
- A `Payment` with `counterparty_type = investment_instrument` must never be linked to an
  `Expense` (same rule as `internal_account`, invariant #7, extended) and is excluded from spend
  totals the same way.
- `ReconciliationRun` gains `ledger_investments_total`, parallel to `ledger_transfers_total`.
- Revised formula (invariant #20): `ledger_unexplained_total = ledger_total_outflow −
  ledger_transfers_total − ledger_investments_total − ledger_settlements_total (ADR-0007) −
  ledger_explained_total`.
- A `Payment` classified this way is a valid terminal state at `NORMALIZED` — like
  `internal_account` payments, it is not required to reach `LINKED` or `IGNORED`; it's excluded
  by its `counterparty_type` directly. `lifecycle.md` states this explicitly for both categories
  (it was ambiguous for transfers before this ADR too).

## Consequences

One new `counterparty_type` value, one new `reconciliation_runs` column, one formula edit. No new
tables. `product/overview.md` and `terminology.md` now have a real mechanism backing the term they
already used, instead of an aspirational one.

Explicitly **out of scope** for the foundation phase, and noted as an open question: this ADR
only classifies investment *outflows* (money leaving to buy an investment). It does not address
investment *performance* (gains/losses, valuation) or the *inflow* side (a matured investment or a
dividend coming back in) — those are portfolio-tracking concerns, not expense-reconciliation
concerns, and remain genuinely out of scope, not just deferred by oversight.

## Alternatives considered

- **Remove "investments" from the product docs instead of modeling it.** Rejected: modeling it
  correctly costs one enum value and one reconciliation column — cheaper than rewriting the
  product narrative, and it preserves a capability real users of this system will want.
- **Model investments as a `relationship_type` on `Expense` (e.g. `'investment'`).** Rejected for
  the same reason `settlement` was removed from that enum (ADR-0007): an investment purchase is
  not "spending" in the sense the rest of `relationship_type` describes (something consumed, with
  beneficiaries) — it doesn't need `Allocation` any more than a transfer does, so it belongs on
  the `Payment`-classification axis, not the `Expense`-classification axis.
