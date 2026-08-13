# Fixtures

Synthetic, non-real financial data used to drive tests and to make the domain model concrete.
**Nothing in this directory is real** — no real bank statements, receipts, UPI IDs, or account
numbers, per `CLAUDE.md` and `docs/security/security-model.md`. Amounts, dates, and merchant
names are illustrative.

IDs use short readable strings (`person_dev`, `payment_blinkit_001`) rather than UUIDs, for
readability in tests and docs. The real system uses `uuid` primary keys
(`docs/architecture/database-design.md`); tests map these fixture IDs to generated UUIDs at
load time.

Field names loosely follow `docs/domain/domain-model.md`; fixtures are illustrative examples,
not a schema contract — the schema is `docs/architecture/database-design.md`.

## Reference data

- `people-and-groups.json` — the synthetic cast used across all other fixtures: Dev (the
  user), Flatmate A, Flatmate B, Friend A, Friend B, and the groups Flat, Trip, Dinner Group.

## Scenario fixtures

Each file corresponds to a scenario in `docs/domain/scenario-analysis.md` (noted in
parentheses) and to a supported source/expense type from `docs/product/overview.md`:

| File                                 | Scenario                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `bank-statement.csv`                 | A synthetic bank statement export (multiple channels, incl. a transfer and a refund) |
| `upi-transactions.json`              | A synthetic UPI transaction export                                                   |
| `restaurant-bill-unequal-split.json` | Restaurant bill, three people, unequal consumption (§2, §3)                          |
| `restaurant-no-receipt.json`         | Restaurant bill with no receipt, manual explanation only (§4)                        |
| `blinkit-order-mixed.json`           | Blinkit order with personal and flat items in one basket (§1, §21)                   |
| `swiggy-order-personal.json`         | Swiggy order, straightforward personal expense                                       |
| `zepto-order-flat.json`              | Zepto order, household/flat expense (§5)                                             |
| `local-shop-flat-purchase.json`      | Local shop purchase for the flat, no digital receipt (§5, §19)                       |
| `electronics-partly-friend.json`     | Electronics purchase split between user and a friend (§6)                            |
| `paid-on-behalf-friend.json`         | Payment made entirely on behalf of a friend (§7)                                     |
| `gift.json`                          | A gift — no settlement expected (§8)                                                 |
| `taxi-shared-equal.json`             | Taxi shared among three people, equal split (§9)                                     |
| `trip-multiple-payments.json`        | A trip occasion spanning several payments (§10, §22)                                 |
| `refund-full.json`                   | A full refund against a prior expense (§11)                                          |
| `refund-partial.json`                | A partial refund (§12)                                                               |
| `duplicate-transaction.json`         | The same charge appearing twice across two import sources (§13)                      |
| `internal-transfer.json`             | A transfer between the user's own accounts — not an expense (§14)                    |
| `splitwise-settlement.json`          | A settlement payment via Splitwise (§15)                                             |
| `utility-bill.json`                  | A recurring utility bill split across the flat (§16)                                 |
| `cash-payment.json`                  | A manually entered cash payment (§17)                                                |
| `unknown-merchant.json`              | A payment with an unresolved counterparty (§18)                                      |
| `receipt-amount-mismatch.json`       | Receipt total differs from the linked payment amount (§20)                           |

Numbers 21–25 in the scenario doc are covered by combinations of the fixtures above rather than
dedicated files (e.g. §21 is `blinkit-order-mixed.json`; §24, a correction made after the fact,
is a test-time mutation of `restaurant-bill-unequal-split.json`, not a separate static fixture).
