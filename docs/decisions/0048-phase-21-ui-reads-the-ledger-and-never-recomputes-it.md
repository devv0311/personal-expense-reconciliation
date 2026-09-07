# 0048. The Phase 21 UI reads the ledger; it never recomputes it

**Status:** Accepted

## Context

Phase 21 is the last numbered phase: it makes all six of `CLAUDE.md`'s pillars reachable through
end-to-end flows. Five of the six already had a complete domain and service surface — context
re-attachment (ADR-0044), item-refund allocation (ADR-0045), Splitwise auditing (ADR-0046),
proof packs (ADR-0047), and the pairwise balance (ADR-0006/0014). One did not, and the gap was
deliberate.

**Phase 16 shipped ADR-0017 (cash balance)'s `ReconciliationAccountSnapshot` with no API surface
at all.** Its own implementation note says why: _"No API surface was added: collecting evidenced
statement balances and displaying the account waterfall are Phase 21's, so a run given no
boundaries produces honestly `incomplete` snapshots rather than a cosmetic zero."_ So the third
pillar's screen could not be built without first deciding **where** the missing pieces live: in
the browser, or behind the same API every other figure comes through.

Two smaller gaps had the same shape. An expense-detail screen needs one expense; only a bounded
listing existed. An evidence inspector needs the structured reading recorded beside a document;
the only way to obtain one was to re-run the matcher (a `POST`), which is the wrong verb for
opening a screen.

The tempting answer to all three is the frontend: it already receives `totalDebits`,
`totalCredits` and an `openingBalance`, so `opening + credits − debits` is one line of
JavaScript; the ledger listing is already fetched, so finding one row in it is a `.find()`; and
the enrichment `POST` is idempotent, so calling it on mount "works".

## Decision

### Every financial figure the UI renders is one the backend already computed

`web/` performs no financial arithmetic. Not the cash identity, not a net amount, not a share,
not a delta — not even the ones that are a single subtraction. Where a figure did not exist over
HTTP, **the read was added to the API**, not the arithmetic to the browser.

Phase 21 therefore adds exactly four reads and one request field, and nothing else:

| Surface                                                | What it is                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `GET /api/accounts`                                    | The account roster a waterfall names. `services.listAccounts`. |
| `GET /api/expenses/:expenseId`                         | One row of the existing ledger listing, by id filter.          |
| `GET /api/reconciliation/runs/:id/account-snapshots`   | ADR-0017's second identity, exactly as the run stored it.      |
| `GET /api/evidence/:evidenceId/observation`            | The recorded reading of one document, or `null`.               |
| `accountBoundaries` on `POST /api/reconciliation/runs` | Evidenced statement balances, per account (17.5).              |

Each is a read or a pass-through. None computes anything: `getReconciliationAccountSnapshots`,
`listAccounts` and `getEvidenceObservation` return stored rows, `getExpenseLedgerRow` is
`listExpenses` with an id filter (so a detail screen and the row that linked to it cannot quote
two different `netAmount`s), and `accountBoundaries` is handed to `runReconciliation`'s existing
input untouched.

Three consequences are load-bearing:

- **`incomplete` stays `incomplete`.** `verificationStatus` is a database `CHECK` over evidenced
  boundaries, a zero delta and nothing unexplained in either direction. The UI renders that
  word; it never derives it. A numeric zero over unidentified movements cannot become "verified"
  by any path, including a frontend one — and the screen renders a missing balance as _"not
  evidenced"_, never as `₹0.00`.
- **Two identities stay two identities.** ADR-0016's outflow totals and ADR-0017's cash identity
  get separate sections rather than one blended score, because neither is derived from the other
  and a run can explain every rupee of outflow while failing to close a statement.
- **A balance still cannot be submitted without its evidence.** The route refuses a balance with
  no `Evidence` id, matching 17.5 — _"a balance with no evidence is a number somebody typed, and
  this system does not have a field for that."_ Balances are parsed as **signed** minor units,
  because an overdraft is a real balance and ADR-0017 clamps nothing.

### The two places `web/` does compute, and why neither is a ledger figure

1. **Parsing what a person typed.** A refund amount arrives as `"1,234.5"` and has to leave as
   `"123450"`. `parseRupeeInput` does that in pure string handling with no `Number` anywhere, and
   refuses a third decimal place rather than rounding it away.
2. **Echoing a form's own total.** The item-refund splitter shows the sum of the amounts _you
   have typed into it_, so a set that does not add up is caught before the request. It is
   labelled as an entry check ("You have entered … of the … refund"), never rendered with
   ledger semantics, and the service validates the same rule again and refuses a mismatched set
   (19.2). The **authoritative** preview is the server's: `getRefundAllocationState`'s
   `projectedLines` are what a distribution would actually write, and they are what the screen
   offers for approval.

Bar widths in the waterfall are geometry over figures the API sent, are `aria-hidden`, and
render no number of their own.

### No UI action bypasses a domain or service boundary

Every consequential act — accepting a proposal, confirming a duplicate, attaching evidence,
recording a refund, distributing one, reviewing an audit finding — goes through the same route,
the same service and the same validation a script would. The UI adds friction on top (a dialog
that states the consequence, a required reason where the service requires one) and removes none.
Where the service would refuse, the screen does not offer: an expense with nothing pending shows
no "Approve this distribution" button, and a refund the ledger cannot allocate shows
`REFUND_ITEM_OWNERSHIP_REQUIRED` instead of an action.

## Consequences

- The five reads are the whole backend footprint of the last numbered phase. Every screen is a
  rendering of something that already existed, which is what makes "the frontend and the backend
  agree" checkable rather than aspirational — and it is checked: 42 rendered figures were
  compared against live API responses in a driven browser, and the frontend suite asserts the
  same agreement against fixtures.
- A frontend that cannot compute cannot drift. The failure mode this rules out is the expensive
  one: a screen that quietly disagrees with the ledger and looks authoritative doing it.
- `web/` grew no dependency. The stack is unchanged from ADR-0042/0043.
- CI gained a `web` job (typecheck, lint, format, test, build) — the frontend gap phase 15 left
  open deliberately and this phase closes.

## Alternatives considered

1. **Compute the cash identity in the browser** from the totals the snapshot already carries.
   Rejected: it puts a second implementation of ADR-0017's arithmetic somewhere that cannot be
   unit-tested against the domain, and — worse — it makes `verified` a frontend judgment. The
   whole point of 17.6's `CHECK` is that no code path can store a verified ₹0 over unidentified
   movements; a screen that decided for itself would be exactly that path, wearing a different
   hat.
2. **Return the account snapshots inside `GET /api/reconciliation/runs/:id`.** Rejected as a
   quieter breaking change: that route's response shape is asserted by existing tests and read by
   the phase-15 UI, and a run's snapshots are a list a screen fetches when it renders the
   waterfall, not part of the run's own identity. A separate route also lets the read 404 an
   unknown run rather than returning an empty list, which is a different fact.
3. **Add a "preview this refund" endpoint** so the splitter's per-item net costs could be
   server-computed while typing. Rejected for this phase: it would be a new derived read whose
   only caller is a form, and the honest shape already exists — recording a refund and
   distributing it are two acts (ADR-0008), and the read between them already shows every item's
   net cost and the lines a distribution would write, before anyone approves.
4. **Widen `GET /api/expenses` and let the browser find the row.** Rejected: an unbounded listing
   to render one expense, and a detail screen whose figures depend on whether its row happened to
   fall inside a limit.
