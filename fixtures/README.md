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

> **Revision note (2026-08).** Several fixtures were rewritten and nine new ones added following
> a pre-implementation architecture review (ADRs 0006–0011 in `docs/decisions/`). `people-and-groups.json`
> gained Flatmate D and an August/September membership transition to support the new
> group-expansion fixture. See `docs/domain/scenario-analysis.md`'s revision note and Part 2.

## Reference data

- `people-and-groups.json` — the synthetic cast used across all other fixtures: Dev (the
  user), Flatmate A, Flatmate B, Flatmate C, Flatmate D, Friend A, Friend B, and the groups
  Flat, Trip, Dinner Group. Includes the group-membership timeline (who was in the Flat, and
  when) that several fixtures below depend on.

## Scenario fixtures — Part 1 (original 25 scenarios)

Each file corresponds to a scenario in `docs/domain/scenario-analysis.md` (noted in
parentheses) and to a supported source/expense type from `docs/product/overview.md`:

| File                                 | Scenario                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `bank-statement.csv`                 | A synthetic bank statement export (multiple channels, incl. a transfer and a refund)                                   |
| `upi-transactions.json`              | A synthetic UPI transaction export                                                                                     |
| `restaurant-bill-unequal-split.json` | Restaurant bill, three people, unequal consumption (§2, §3)                                                            |
| `restaurant-no-receipt.json`         | Restaurant bill with no receipt, manual explanation only (§4)                                                          |
| `blinkit-order-mixed.json`           | Blinkit order with personal and flat items in one basket (§1, §21)                                                     |
| `swiggy-order-personal.json`         | Swiggy order, straightforward personal expense — also the reference fixture for the trivial-allocation base case (§35) |
| `zepto-order-flat.json`              | Zepto order, household/flat expense (§5)                                                                               |
| `local-shop-flat-purchase.json`      | Local shop purchase for the flat, no digital receipt (§5, §19)                                                         |
| `electronics-partly-friend.json`     | Electronics purchase split between user and a friend (§6)                                                              |
| `paid-on-behalf-friend.json`         | Payment made entirely on behalf of a friend (§7)                                                                       |
| `gift.json`                          | A gift — no settlement expected, never reaches `READY_TO_SYNC` (§8)                                                    |
| `taxi-shared-equal.json`             | Taxi shared among three people, equal split (§9)                                                                       |
| `trip-multiple-payments.json`        | A trip occasion spanning several payments (§10, §22)                                                                   |
| `refund-full.json`                   | **Rewritten 2026-08.** A full refund against a prior expense, modeled as an `ExpenseAdjustment` (§11)                  |
| `refund-partial.json`                | **Rewritten 2026-08.** A partial refund, `ExpenseAdjustment` + superseding `Allocation` (§12)                          |
| `duplicate-transaction.json`         | **Rewritten 2026-08.** Same charge twice, now using the real `external_reference`/`reference_type` fields (§13)        |
| `internal-transfer.json`             | A transfer between the user's own accounts — not an expense (§14)                                                      |
| `splitwise-settlement.json`          | **Rewritten 2026-08.** A settlement payment via Splitwise, now a `Settlement` entity, never an `Expense` (§15)         |
| `utility-bill.json`                  | A recurring utility bill split across the flat, direct person beneficiaries (§16)                                      |
| `cash-payment.json`                  | A manually entered cash payment (§17)                                                                                  |
| `unknown-merchant.json`              | A payment with an unresolved counterparty (§18)                                                                        |
| `receipt-amount-mismatch.json`       | Receipt total differs from the linked payment amount (§20)                                                             |

Numbers 21–25 in the scenario doc are covered by combinations of the fixtures above rather than
dedicated files (e.g. §21 is `blinkit-order-mixed.json`; §24, a correction made after the fact,
is a test-time mutation of `restaurant-bill-unequal-split.json`, not a separate static fixture).

## Scenario fixtures — Part 2 (added 2026-08)

| File                                  | Scenario                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `flatmate-pays-flat-expense.json`     | A flatmate pays a flat expense; the user and another flatmate owe their shares — bidirectional payer (§26)               |
| `friend-pays-restaurant-reverse.json` | A friend pays a restaurant bill; the user owes their share — bilateral, no Group (§27)                                   |
| `settlement-user-to-flatmate.json`    | The user settles a debt with a flatmate (§28)                                                                            |
| `settlement-flatmate-to-user.json`    | A flatmate settles a debt with the user — reverse direction (§29)                                                        |
| `refund-after-splitwise-sync.json`    | A refund arrives after the original expense already synced — `stale` vs. `drifted` (§30)                                 |
| `reimbursement-third-party.json`      | A third-party (employer) reimbursement against a personal expense (§31)                                                  |
| `investment-sip.json`                 | An investment payment (SIP), excluded from spend via `counterparty_type` (§32)                                           |
| `group-allocation-expansion.json`     | A group-beneficiary line expanded to individual shares, unaffected by a later membership change (§33)                    |
| `non-user-obligation.json`            | An obligation between two people, neither of whom is the user — the documented settlement-observability limitation (§34) |

`§35` (a purely personal expense, trivial allocation) has no dedicated fixture — see
`swiggy-order-personal.json` above.

See `docs/domain/scenario-analysis.md`'s stress-test coverage matrix for how every fixture maps
to payer / obligation / settlement / spend-classification / Splitwise / reconciliation facts.
