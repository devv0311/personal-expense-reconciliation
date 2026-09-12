# 0054. A live balance is a second opinion, never a boundary

**Status:** Accepted

## Context

The audit's row 37 was short:

> Absent external account/balance adapters … the waterfall compares user-supplied evidenced
> statement boundaries; it does not fetch current bank balances. Live connections remain
> deferred.

ADR-0050 kept it on the unbuilt list and said it would need its own record. This is that
record, and the interesting half of it is not the fetching.

Fetching a balance is an HTTPS call. What to do with the answer is the decision, and there is
an obvious wrong one sitting right there: use it to fill in the closing balance the waterfall
is missing. That would be catastrophic in a specific way. ADR-0017 (cash balance) 17.6 makes a
`verified` ₹0 unaccounted delta mean something precise — complete evidence, zero cash delta,
zero unexplained movements — and the whole third pillar rests on it. A number fetched from an
API at an unstated instant is not evidence of what a statement said at a period boundary: the
instant is usually wrong, the read may have half-failed, the account has probably moved since,
and nobody looked at it. Letting one fill a boundary manufactures verified closures out of HTTP
calls.

There is a second problem underneath. No Indian retail bank offers a balance API to an
individual directly. The real paths are an Account Aggregator consent flow or a self-hosted
bridge, and pretending otherwise would mean shipping an adapter for a bank nobody can actually
connect to.

## Decision

### A reading is compared against the ledger and never written into it

`compareBalanceReading` returns `agrees`, `differs` or `not_comparable` with a signed
difference, and that is the entire output. Nothing in this work writes a
`reconciliation_account_snapshot`; `POST /api/reconciliation/runs` remains the only route that
sets a boundary, and `domain.assertBoundaryIsNotAProviderReading` is the guard that says so at
the write with no parameter that turns it off.

The panel sits **after** the waterfall on the run screen and is deliberately not part of it.
The two figures are next to each other so they can be compared, and separated so one cannot be
mistaken for the other.

### Three ways a comparison refuses to claim agreement

- **An unknown ledger figure is `not_comparable`**, never `agrees`. This is the audit's eighth
  dead end in another costume: an absence of disagreement is not agreement. A screen that
  rendered "✓" over an account with no evidenced closing balance would be asserting exactly the
  thing nobody checked.
- **A reading with no balance, or with no `asOf`, is `unusable`.** Null is not zero (17.5), and
  a figure with no instant attached says "this account held ₹X at some point", which is not a
  statement about a period end. The adapter deliberately does **not** stamp a missing `asOf`
  with the fetch time: "the provider did not say when" and "the provider said now" are
  different claims and only one of them is true.
- **A stale match is reported as a match against an older reading**, with a caveat, rather than
  as confirmation. Two numbers agreeing across a five-day gap is a fact about a quiet account.

### Silence is recorded as silence

Every linked account gets a row from every refresh. An account the provider did not answer for
gets an `unavailable` reading saying _silence is not a balance_ — not no row. The difference is
what the next screen shows: a missing row reads as "we have not looked recently", an
`unavailable` one reads as "we looked and could not see it", and only one of them is true.

Read-level completeness is carried onto **every row** the read produced, not kept on a run
record. Agreement on one account, under a read that could not see the others, is not agreement
about the account set, and a reading quoted without its read's completeness could not say so.

### Credentials never reach the database

`account_provider_links` maps a ledger account to the provider's own reference for it and has
no column that could hold a secret. The token lives in the adapter's closure, built from the
environment in `src/server.ts`. `describe()` names the endpoint host and never the credential,
and a database backup is therefore not a credential leak (`security-model.md`).

### The adapter integrates with a configured endpoint, and says so

`BALANCE_PROVIDER_URL` + `BALANCE_PROVIDER_TOKEN` wire a real HTTPS JSON adapter: POST
`{accountRefs}`, receive a balance per account as an **exact minor-unit string**. A JSON
`number` is a float and this system has no field for "nearly ₹12,345" (ADR-0012), so a balance
that is not an exact integer string is refused as `unavailable` rather than rounded.

This is honest about what it is: an integration with whatever endpoint an Account Aggregator
consent flow or a self-hosted bridge terminates in, rather than a claim to have integrated a
particular bank. Absent either variable, the provider reports **every read as incomplete** —
never `{ readings: [], complete: true }`, which would say "we checked every account and there
was nothing to report" and which a screen would be entitled to render as agreement.

## Consequences

- **`account_balance_readings` is append-only at the role level**, like `payments` and
  `evidence`. What a provider said at a moment does not change afterwards; a later read is a
  new row, which is also what makes a history of readings meaningful. A link is archived rather
  than deleted, because past readings name it.
- **The staleness window is 26 hours, not 24.** An overnight batch and a timezone offset should
  not between them turn yesterday evening's balance into a warning.
- **Implementation is verified without a live bank.** The adapter is tested against a scripted
  `fetch` and everything above it against an in-memory provider. What is _not_ verified here is
  a real institution answering: that needs live consent and real credentials, and it is stated
  as a dependency rather than implied by a green suite.
- **The obvious follow-on stays unbuilt on purpose.** "Offer to fill the boundary from the
  reading, with one click" is a small feature and a large mistake; if it is ever built it needs
  its own decision, and a different word than `verified` for what it produces.
