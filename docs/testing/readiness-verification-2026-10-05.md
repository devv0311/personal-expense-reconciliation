# Readiness verification — 5 October 2026

A record of what was exercised end to end, with what figures, what it found and fixed, and what
was **not** exercised. Written so a claim elsewhere in the repository can be checked against it.

**Scope in one sentence:** a synthetic ledger, driven through the rendered website, against a
scratch database and non-real ports. No real record was opened, copied, logged, seeded or
migrated; nothing on ports 3000/4000 was touched; no live provider was connected.

## How it was run

- A scratch PGlite database and evidence directory under `/tmp`, outside `local-data/`; API on
  `127.0.0.1:4001` started with `PGLITE_DATA_DIR` named explicitly and every provider variable
  unset, website `next dev` on `127.0.0.1:3001` with `NEXT_PUBLIC_API_BASE_URL` pointed at 4001.
  Every browser request went to 4001; none went to 4000.
- Processes were stopped only by the exact pid holding the scratch port
  (`docs/testing/process-isolation.md`) — never by name or pattern.
- Identity (three people, one user) was created by a scratch script through
  `resolveSyntheticTarget`; accounts, imports, decisions, expenses and shares were made in the
  browser.
- The machine rebooted part-way through (the scratch directory lived in `/tmp` and was lost), so
  the journey was replayed from the start on a fresh scratch ledger. The figures below are from
  that replay.

## The journey and its figures

All amounts are synthetic. "Expected" was calculated by hand before the run.

| Step                                          | Expected                                                                               | Actual                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Preview of bank CSV (HDFC-style layout)       | out ₹4,625.75, in ₹50,000.00, closing ₹1,45,374.25                                     | same                                                          |
| Preview of IDFC FIRST card PDF (synthetic)    | out ₹3,739.50, in ₹1,450.00, 4 movements                                               | same, plus the "check the count against the statement" caveat |
| Same CSV imported again                       | nothing written                                                                        | "already imported", payments stayed at 4                      |
| Overlapping second capture (2 lines, no refs) | 11 payments; 2 duplicate questions                                                     | 11 payments; 2 duplicate questions (₹3,000.00, ₹1,250.50)     |
| Duplicates answered, categories confirmed     | queue empty                                                                            | queue empty; each duplicate was asked before its category     |
| Spending, last 12 months — spent              | ₹11,005.25                                                                             | ₹11,005.25                                                    |
| — own share                                   | ₹10,005.25                                                                             | ₹10,005.25                                                    |
| — by month                                    | Jul ₹3,739.50, Aug ₹7,265.75                                                           | same                                                          |
| — by category                                 | Dining 4,240.00; Groceries 3,750.00; Transport 1,175.25; Bills 1,200.00; Health 640.00 | same                                                          |
| — not yet accounted for                       | ₹51,450.00 over 3 payments (salary and two card credits)                               | same                                                          |
| People — Alex                                 | owes you ₹400.00 (cash cab, you paid, split equally)                                   | You should collect ₹400.00, itemised                          |
| People — Sam                                  | you owe ₹600.00 (internet, Sam paid, split equally)                                    | You need to pay ₹600.00                                       |

Other things confirmed in the browser: choosing "A card" disables the savings account; a CSV or
spreadsheet is never assumed to be a bank or a card (the person says which); an evidence record
already tied to one expense cannot be pointed at another (`EVIDENCE_LINK_IMMUTABLE`, shown
plainly); opening Home, Spending, People, Ask and Needs attention issued only `GET`s and left a
hash over spending, people, attention, payments and expenses unchanged; and restarting only the
scratch API left the same hash and the same screens.

Phone width (375 px): no horizontal overflow on Home, Spending, People, a person, Needs
attention, Records, Add records, Expenses, an expense, Payments and Setup, and the import dialog
fits the screen. Empty states (Home, Needs attention) and the "Couldn't reach the API … Try again"
state (API stopped, then restarted and retried) read correctly. With no model configured, `/ask`
says so by name and disables every control; Setup says no balance provider is configured.

## Defects found and fixed

Each has a regression test that fails on the old code.

1. **The same dinner counted twice.** The queue stops offering a possible duplicate once either
   copy is approved (ADR-0031: a counted payment is never a candidate), and the Needs-attention
   page asked every category question before any duplicate question. Approving the first copy's
   category removed the question; approving the second copy then showed Dining ₹6,000.00 for one
   ₹3,000.00 dinner. _Fix (web, ordering only):_ a payment's duplicate question is now asked
   immediately before its category question. `web/src/app/needs-attention/page.tsx`.
2. **A confirmed duplicate could still be approved.** The discarded copy's category question
   stayed in the queue, and approving it produced an approved expense funded by a payment the
   ledger had marked `ignored`. _Fix:_ such proposals are no longer queued, and accepting or
   modifying one is refused (`PRECONDITION_FAILED`); rejecting it is still allowed.
   `src/db/repositories.ts`, `src/services/inference-decision-service.ts`.
3. **The month-by-month trend was one month short.** It was counted back from the exclusive end
   of the period, so "This month" was always an empty window and "Last 3 months" lost its first
   month. `src/services/spending-service.ts`.
4. **A false "a refund has been recorded" warning** on every expense with no shares yet, which
   has no refund at all. _Fix (web):_ the warning needs a refund or a pending distribution to
   exist. `web/src/components/expenses/expense-detail.tsx`.
5. **An expense somebody else paid could never be counted or shared from the browser.** The form
   could only create it as a proposal, nothing in the browser approved it and no route exists to,
   though the API already accepted `state: "approved"` at creation. _Fix (web):_ an opt-in
   "Count it as spending now" choice, off by default, whose dialog states that it approves the
   expense and that its amount can never be edited. `web/src/components/expenses/expense-form.tsx`.

## Second round (hardening the two gaps)

A follow-up task closed the two gaps the first round left. Everything is still uncommitted.

### Path A — an imported statement line approved as a shared expense: **fully fixed**

The category card on Needs attention used to approve every statement line as `personal`, and
nothing could change that afterwards. Now:

- The dialog asks **"Who was this for?"** _before_ approval — _Just me_ (the default, so the
  one-tap answer is unchanged), _Me and other people_, _The flat_, _I paid for somebody else_ —
  the expense vocabulary's own kinds. It says in the dialog that the kind is part of what
  approving fixes and cannot be changed afterwards.
- For a shared kind it shows **the ledger's own split** before anything is written. The preview is
  the existing allocation preview, taught to answer "as if this not-yet-approved expense were
  approved as shared" (`ifApprovedAs`); it is refused for an expense already approved, because
  its kind was part of what was approved. Nothing in `web/` divides anything.
- Confirming makes **two recorded steps, in order**: the existing `modify` decision (which has
  always carried a kind and records "corrected in review before approval") and then the existing
  allocation route. If the split fails to save after the approval did, the dialog stays open, says
  so, and links to the share screen; the queue refreshes only when it is closed.
- One expense is made for one payment: nothing is duplicated, the gross amount is the statement's
  and untouched, and the evidence is untouched.
- The sentence that sent people to "change what it was on the expense itself" — where no such
  control exists — is gone, replaced by what is true.

Rendered figures (synthetic, hand-calculated beforehand): a ₹3,000.00 imported dinner approved as
_Shared_ with Alex gave You ₹1,500.00 / Alex ₹1,500.00, **Alex owes ₹1,500.00**, own share
₹1,500.00 of ₹3,000.00 (kind `shared`, state `allocated`, gross `300000`). On a 375 px screen, by
keyboard only: Enter opened the dialog, Tab reached the select, ArrowDown chose _shared_, three
Tabs reached the _Alex_ chip, Space pressed it (₹800.00 → ₹400.00 each, "You should collect from
Alex"), and Escape closed it having written nothing.

### Path B — counting one movement twice after "Decide later": **fully fixed in code; one sentence of ADR-0031 narrowed — ratified by the owner on 6 October 2026**

Audit: the claim in the first report that closing this "necessarily needs an owner policy change"
was **too strong**. The matching policy (ADR-0070: day, amount, name, references, nothing merged)
is untouched and stays the owner's. What changed is the _lifecycle of the question_ — ADR-0031's
sentence "a `linked` payment is never a candidate" — whose stated reason (never discard an
explained payment) is fully preserved. Full reasoning, the before/after table, rule citations and
the alternatives are in
[ADR-0071](../decisions/0071-a-possible-duplicate-stays-asked-while-either-copy-can-still-count.md).

- A counted copy stays in the pair as the **survivor**; the uncounted one is the only one that can
  be discarded. The pair is asked while at least one copy is uncounted.
- One check runs inside the transaction of **every** act that counts a payment — accepting or
  modifying a classification, recording a settlement, creating a funding link, adding one later —
  and refuses an uncounted copy until a person has confirmed it as a duplicate or recorded two real
  movements. A payment discarded as a duplicate cannot be counted at all.
- "Counted" is wider than `linked`: a hand-entered funding link or a settlement counts a payment
  without moving it, and a confirm can no longer discard such a payment.
- Concurrency: **corrected in the third round** — see "Third round" below. The second round
  claimed the rows were locked in id order and that a two-approval race was refused 3 of 3 times;
  that race was real, but the locking design behind the claim was unsafe (it could deadlock), and
  the test offered as proof did not exercise the interleaving that breaks it.

Rendered result: with the groceries pair set aside by "Decide later", approving the first copy
worked and approving the second was **refused in the dialog** ("looks like the same movement as
another one that already counts…"). The question came back, worded for a pair with one counted
copy ("One of them already counts…", dates labelled _Already counted_ / _Not counted yet_);
confirming it set the uncounted copy aside. Spending counted the groceries **once**. Legitimate
separate payments were never blocked: two same-day coffees on one statement with two references,
a cab and a pharmacy all approved.

| Figure (last 12 months)     | Expected  | Actual    |
| --------------------------- | --------- | --------- |
| Spent                       | ₹5,665.75 | ₹5,665.75 |
| Your own share              | ₹4,165.75 | ₹4,165.75 |
| Dining (dinner + 2 coffees) | ₹3,400.00 | ₹3,400.00 |
| Groceries                   | ₹1,250.50 | ₹1,250.50 |
| Alex owes you               | ₹1,500.00 | ₹1,500.00 |
| Not yet accounted for       | ₹0.00     | ₹0.00     |

Restarting only the scratch API left a hash over spending, people, attention, payments and
expenses identical.

### Other things re-audited and fixed

- **"Worth a look" kept resolved duplicates.** A payment confirmed as a duplicate no longer feeds
  the instalment and repeated-charge readings, so the pair a person resolved stops being
  reported; two payments dismissed as real movements are still observed. The "within 24 hours"
  wording was **not** obsolete: it is that observation's own window (ADR-0063), not the duplicate
  rule's, so it was left.
- **"Count it as spending now" and the server.** The form could create an approved expense that
  the domain model forbids, and the API accepted it: an expense the user paid, approved with no
  movement behind it (spending no statement shows), and an expense naming somebody else as payer of
  a payment from the user's own account (the classification path already refuses this, ADR-0006).
  Both are now refused at creation and on a later funding link, with tests, and the form says so
  before the button.
- **Ignored-payment guard.** The first round only guarded the classification path; a hand-entered
  funding link or a settlement could still count a discarded duplicate. All paths now share one
  check.

## Owner decisions (open when written; resolved 6 October 2026)

**Resolved 6 October 2026 — the owner approved all three recommended decisions:** (1) ADR-0071 is
**ratified as built**; (2) the ADR-0068 explicit ambiguous-layout selection is **ratified as built**;
(3) correcting the kind of an expense already approved as Personal is **deferred from this release**
(the design proposal below stays on file; **it was later built, as amended, by [ADR-0073](../decisions/0073-an-expense-approved-as-personal-is-corrected-by-a-new-decision.md)**). This is a decision record only: it is not
permission to commit, push or deploy, and no real data was accessed. The text below is kept as it
was written, so the options and reasoning stay on record.

1. **Correcting the kind of an expense that is already approved as Personal — unchanged,
   proposal only.** The domain documents the possibility (`invariants.md` #6 and
   `domain-model.md` §24, lines 471–474 and 670: `relationship_type` and `Allocation` "may still
   change via a new, audited decision … never a silent overwrite", with a new `Allocation`
   version superseding the old), but **no mechanism exists**: there is no route, no service and no
   screen, and the database has no trigger or grant on the column, so today's immutability is
   application-level only. The documented wording does not say whether the correction is an update
   of the column with an audit event or a successor expense in the pattern of ADR-0052, so
   building one would mean choosing. Left unchanged, and the screens no longer imply it exists.
   _Proposal for the owner:_ a successor, not an edit —
   - **Before:** an approved `personal` expense has no allocation that creates a debt; its kind is
     fixed and nothing changes it.
   - **After:** a new audited decision, `POST /api/expenses/:id/relationship` with a required
     reason, which writes an `AuditEvent` carrying old and new kind, supersedes the current
     `Allocation` with a new version (never edits it), and only for a kind change from
     `personal` to a debt-creating kind. The amount, the evidence and the funding links are
     untouched; an expense already `synced` or `ready_to_sync` would be refused.
   - **Rules this touches:** `invariants.md` #2a (obligations), #6 (approved decisions change only
     by a new audited decision), #11/#12 (allocation sum and Largest Remainder); `lifecycle.md`
     APPROVED/ALLOCATED/READY_TO_SYNC; `domain-model.md` §24 and the Allocation lifecycle; the
     Splitwise sync rows (a kind change after sync would need a repair, ADR-0055); ADR-0052's
     successor pattern; and what "personal" means (a kind that has been counted in an own-share
     figure would move that figure).
   - **Decision needed:** whether a kind may change after approval at all, and if so by what
     mechanism.
2. **Ratify ADR-0071** (Path B above). Options: ratify as written; keep only the queue change
   (the pair stays visible, nothing is refused); or keep only the refusal. The ADR sets out each
   alternative's cost. Nothing else about the duplicate policy is open.

## Not exercised

- Any live Splitwise, bank, balance, model, message or forwarding provider.
- The declared statement layouts other than the generic and HDFC-style CSV/XLSX ones, through the
  browser (unit and integration tests only); any PDF other than the one synthetic IDFC FIRST card
  layout. _(Superseded text: an XLSX through the browser, including choosing a layout for a file whose
  header ties, was exercised in the fifth, twelfth and fourteenth rounds.)_
- Reconciliation waterfalls, settlements, refunds and item adjustments, proof packs, evidence
  matching of a receipt, and the Splitwise screens.
- Light/dark themes and axe on the new states. Keyboard operation (Enter to open, Tab trap, Escape, focus
  return) was exercised for the category and import dialogs at 375 px on the production build in the
  fourteenth round, but not across the rest of the product.
- Opening the same ledger from a second browser (the tenth round stands in for "another tab" with direct API calls to the same ledger, not a second browser), and a real (hidden/unfocused) tab: the preview
  pane counts as hidden, which pauses the data library's retries, so the error state was reached
  by emulating a focused page.

## Security verification

**Not performed — a concrete limitation, not a pass.** No HawkScan skill is installed in this
session (a skill search returned nothing), there is no Hawk runtime or `hawk`/`hawkscan` binary,
no `HAWK_API_KEY`, and no Docker. Nothing was scanned and nothing was uploaded, so no claim of
security verification is made. What stands in its place is only ordinary engineering evidence:
new input is validated at the HTTP boundary (`ifApprovedAs` is checked against the closed set of
five expense kinds), every new refusal is a typed `PRECONDITION_FAILED`, no new endpoint writes,
no secret or real record is involved, and the full test suites pass. A DAST scan of the isolated
synthetic app remains to be run where the tool is available.

## Smaller observations

- "This month" is the default period, so a ledger whose records are from earlier months opens on
  ₹0.00 until another period is chosen.
- A pasted note and a hand-recorded expense each need their evidence id copied by hand between
  two dialogs.

## The background worker

`services.runNextJob` claims and runs a queued job, but nothing starts it — `src/server.ts` never
calls it, and no handler is registered anywhere. **User impact today: none in the journeys
above.** No screen can queue a job (`/automation` lists, retries and cancels), and imports and
analysis run inside the request that asked for them (ADR-0061). The only way to create a queued
job is `POST /api/jobs`, and such a job would stay `queued` indefinitely while the panel describes
it as "queued to run out of band". A worker was therefore not built. It becomes necessary the
moment anything enqueues work a person is waiting for.

## Checks (first round)

Baseline before any change: 2,786 root tests and 477 web tests, all passing. After the changes
above, all of these exit 0:

| Command                             | Result                                     |
| ----------------------------------- | ------------------------------------------ |
| `npm run typecheck`                 | clean                                      |
| `npm run lint`                      | clean (`--max-warnings=0`)                 |
| `npm run format:check`              | all files formatted                        |
| `npm run db:check`                  | no schema or migration problems            |
| `npm test`                          | 125 files, **2,790** tests passed (+4 new) |
| `npm run build`                     | built                                      |
| `npm --prefix web run typecheck`    | clean                                      |
| `npm --prefix web run lint`         | clean                                      |
| `npm --prefix web run format:check` | all files formatted                        |
| `npm --prefix web test`             | 43 files, **483** tests passed (+6 new)    |
| `npm --prefix web run build`        | built                                      |

No migration was added, so schema checks are unchanged. For the trend, the discarded-copy and the
false-warning fixes and for the page ordering, the guarding tests were run against the previous
code and failed; the tests that pin behaviour that was already right (a rejection is still allowed, unrelated
duplicate checks stay behind) pass on both, and one assertion (a default recording approves
nothing) sits inside an existing test. The "count it" form test was not run against the old code, which has no such control.

## Checks (second round)

Baseline for this round was the first round's end state: 2,790 root and 483 web tests. After the
changes, all of these exit 0:

| Command                             | Result                                      |
| ----------------------------------- | ------------------------------------------- |
| `npm run typecheck`                 | clean                                       |
| `npm run lint`                      | clean (`--max-warnings=0`)                  |
| `npm run format:check`              | all files formatted                         |
| `npm run db:check`                  | no schema or migration problems             |
| `npm test`                          | 128 files, **2,823** tests passed (+33 new) |
| `npm run build`                     | built                                       |
| `npm --prefix web run typecheck`    | clean                                       |
| `npm --prefix web run lint`         | clean                                       |
| `npm --prefix web run format:check` | all files formatted                         |
| `npm --prefix web test`             | 43 files, **494** tests passed (+11 new)    |
| `npm --prefix web run build`        | built                                       |

Two things to know about those runs. A lint finding (an unnecessary assertion) was fixed between
runs. One earlier root run reported a single failing test while another test run was using the
machine; the same suite passed on three later runs, including the final one, and the failing
test's name was not captured, so it is reported as a transient failure of unknown identity, not as
a pass. The new integration tests (guard, payer invariants, imported-shared) and the affected
older ones were also run against a scratch **PostgreSQL** server: 6 files, 149 tests, all passed,
and a two-promise concurrency test was shown to fail without a lock (superseded: see the third
round, which found that design could deadlock).

## Third round (review-driven correctness hardening)

A supervisory review found a defect in the second round's own fix, and asked for the two-request
approval flow and the rest of the patch to be audited. Findings, in order of seriousness.

### Finding 1 — the count guard could deadlock (reproduced, fixed)

`assertPaymentMayBeCounted` locked the payment being decided (`SELECT … FOR UPDATE`), _then_
discovered its twins and locked those. Sorting ids inside the second statement did not order the
two acquisitions: two approvals of the two halves of one pair each held their own row and then
asked for the other's.

**Reproduction.** `tests/integration/duplicate-lock-order.test.ts` forces the interleaving rather
than racing it: a gate holds each transaction after its first lock, the second transaction is
started, and the gate opens only once the second has reached the same point or is seen queued in
`pg_stat_activity`. It needs a real server (PGlite has one connection) and skips otherwise. On the
unfixed code, against an isolated PostgreSQL 18.6 (scratch cluster, port 54329):

| Scenario (all forced)                               | Before (second-round locking) | After (class lock, sorted)                                                                                                        |
| --------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Opposite-side approvals of one pair                 | one aborted `40P01`           | one counts; other `PRECONDITION_FAILED` `unresolved_possible_duplicate`                                                           |
| Three same-amount copies, approve first and third   | `40P01`                       | one counts, other refused as above                                                                                                |
| Confirm vs approve of the same copy                 | `40P01`                       | one stands: approve wins → confirm `INVALID_STATE_TRANSITION`; confirm wins → approve `PRECONDITION_FAILED` `discarded_duplicate` |
| Confirm vs approve of the other copy                | `40P01`                       | both stand (survivor counted, twin set aside)                                                                                     |
| Settlement on one copy vs approval of the other     | `40P01`                       | one counts, other refused                                                                                                         |
| Fund two payments in opposite orders (two expenses) | `40P01`                       | one expense wins both; other `PAYMENT_BUDGET_EXCEEDED`, nothing left behind (1 expense, 2 links, 1 expense audit event)           |
| A payment imported while a decision is in flight    | passed                        | passed — never blocked, never counts                                                                                              |

Six of seven aborted with `40P01` before the change (the server log shows six `deadlock
detected` entries), and none after. Every test asserts the _kind_ of failure — a database abort
fails it — and the business outcome: exactly one counted, the loser's payment untouched, no audit
event for the loser, no orphan expense or link. Nothing retries.

**Fix.** One transaction-scoped advisory lock per payment _class_ (direction + amount, which is all
`isPossibleDuplicate` can pair), taken **before anything else is read or locked**, and for a
multi-payment funding call, every class up front in sorted key order (`db.lockPaymentClasses`,
called at the start of `createExpense`, and by the guard and `confirmPossibleDuplicate`). The row
locks were dropped: with the class lock held by every counting act they added a second ordering
problem and no safety. Removing the funding pre-lock makes the reversed-order test fail with
`40P01` again, so the test is not vacuous.

**Audited callers:** `decideInference` (guard is the first statement of its transaction; the
settlement path and the expense path touch only that payment), `recordSettlement`,
`createExpense`, `linkPaymentToExpense`, `confirmPossibleDuplicate`. Import inserts new payments
only and marks only the new row ignored. Dismissal is an audit record and takes no lock.
`approveExpense` (no HTTP route) stays unguarded, as before. The accepted duplicate-matching rules
are unchanged. The ADR-0071 concurrency section states the guarantee and its limits.

### Finding 2 — a partial success of approve-then-allocate could not be completed (fixed)

Approving as Shared and saving the split are two requests. When the second failed, the dialog
stayed open — but pressing the confirm button again sent the **already-committed approval** again.
The ledger refuses to decide a proposal twice, so the split could never be saved from there.
Reproduced by three failing component tests before the change.

Now, after an approval that committed, the dialog says what is left (_already approved as … only
the split is left_), shows no kind choice, and its button is **Save the split**, which sends the
allocation only. Closing and reopening the dialog finds the same state. Before saving, a retry
reads the expense: if it is already `allocated` (the first attempt landed but its answer was
lost), nothing is written. A `409` on the decision (decided elsewhere) refreshes the queue so the
stale card goes away. The approved amount and kind are never re-sent. Server side, on the existing
services: a refused split leaves the expense `approved`, kind `shared`, gross unchanged, no
allocation and no audit event; re-sending the decision is `409` and writes nothing; the completing
split gives one current allocation and the ₹1,500.00 debt; a repeated save (its answer lost)
supersedes with the same split, leaves exactly one current allocation and does not double the debt;
and the unfinished split is listed by the existing `allocation_missing` question on Needs
attention, linking to the share screen. **Not rendered in the browser:** the failure injection is
proven by component tests (mocked `fetch`) and API tests, not by a live-browser run.

### Finding 3 — the server accepted a split naming somebody who is not on the ledger (fixed)

`allocation_lines.beneficiary_id` is polymorphic and so has no foreign key; the schema comment
says "validated in services", and nothing did. A stale dialog or direct call could save a split —
and so a debt — for an id belonging to nobody (the request returned `201`). Now `buildLines`
refuses an unknown person (`ENTITY_NOT_FOUND`, `404`) for the approval **and** the preview (as a
refusal value), and an unknown group is refused at expansion. The server was also shown to
recompute, not trust: extra `shares`/`amount`/`obligations` fields on an `equal` split are ignored
(₹1,500.00 each); naming different people than a preview did saves _that_ split; an `exact` split
that does not add up is refused.

### Re-audited, no change needed

- **Ignored-payment guard:** every path that counts a payment (decision, settlement, funding link,
  hand-entered expense) passes `assertPaymentMayBeCounted`; import ignores only the row it has
  just inserted. Pending-proposal listing excludes ignored payments.
- **Payer/funding consistency:** a payment-funded expense must be paid by the user, an approved
  expense the user paid must have funding, and a link added later is held to the same rule; none
  of the audited entry points bypasses it.
- **Hypothetical preview:** closed vocabulary (the five expense kinds, the same set the `modify`
  decision accepts), refused for approved/allocated and rejected expenses, a read that writes
  nothing.

### Checks (third round)

Serial run on a scratch PostgreSQL: **65 files, 1,287 tests passed** (`tests/integration`,
file parallelism off). Final root and web checks are recorded in the evidence folder:
root typecheck, lint, format, `db:check`, build clean; `npm test` **129 files, 2,830 passed, 7
skipped** (the seven real-server-only lock tests skip on PGlite); web typecheck, lint, format,
build clean; `npm --prefix web test` **43 files, 497 passed**. A first pass failed lint on the new
test file (three type-assertion findings); fixed and re-run — both logs are kept.

### Security gate: still not run

Unchanged and not cleared. No HawkScan skill (searched twice), no Hawk runtime or binary, no
`HAWK_API_KEY`, no Docker; an empty `~/.claude/plugins/data/hawkscan-inline` folder from
September holds nothing. No external service was installed, configured or sent anything. No claim
of security verification is made.

## Fourth round (a file whose columns fit two layouts)

**The blocker, restated.** `date,description,amount_inr,type,reference` fits two supported layouts
equally well, and they read some rows differently (a one-letter `D` is a deposit to one and a
debit to the other). Detection refuses to choose — correctly — but the website could not name a
layout, so such a file could not be imported from the browser at all.

**What was already there** (nothing was rebuilt): the layout catalog and detection
(`statement-formats`), `GET /api/imports/formats`, an explicit `formatId` on both
`POST /api/imports/preview` (writes nothing) and `POST /api/imports/statement`, and the
bank/card kind checks (`STATEMENT_KIND_REQUIRED`, `STATEMENT_KIND_CONFLICT`,
`STATEMENT_ACCOUNT_MISMATCH`). **What was missing:** the tie came back as prose only, so a screen
could not offer exactly the valid choices. **The minimal contract added:** a tie now also carries
`ambiguousFormatIds` from the parser, and the preview returns `ambiguousLayouts: [{ id, label,
headerHint }]` for it — the same catalog entries, nothing new, present only for a tie.

**What now works** (all synthetic):

- Choose a file whose header ties: the dialog asks _How should this file be read?_ with exactly
  the two layouts that fit, in plain words with their header lines, **nothing selected and nothing
  recommended**, and says they read some rows differently and that a layout is not a kind of
  account. A file detection can read on its own sees no question and is imported with automatic
  detection, as before.
- Choosing one re-reads the **same original bytes** with that layout through the preview route and
  shows the API's counts and totals, then asks (unanswered) what kind of account the file is
  from; a summary — _Read as / A statement of (said by you) / Goes into_ — says what importing
  will do before the explicit confirmation. Changing the layout clears the earlier reading first;
  changing the file clears the choice, the reading and the kind answer; closing writes nothing and
  reopening starts fresh.
- Import sends exactly the chosen `formatId` and the person's `statementKind`. The batch records
  `statement:<layout>` and the original bytes' hash. A repeat — whichever layout is named — is the
  recognised no-op, and the preview says so first.
- A layout that cannot read the file (e.g. a `Refund` row under the generic layout) is explained
  in the layout's own words, the choice stays on offer and import stays disabled; the other layout
  then reads it.
- The account-kind rule is untouched and separate: choosing the "debit/credit marker" layout still
  asks the kind question, a card is shown as not a bank account, and the server refuses a
  mismatch either way round.

**Expected against actual** (hand-calculated beforehand from the five rows of
`ambiguous-layout.csv`):

| Reading of the same four rows                | Expected out / in              | Preview showed         | Imported (ledger)                                                                          |
| -------------------------------------------- | ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------ |
| Generic layout (`D` = deposit)               | 2 → ₹1,650.50 / 2 → ₹50,325.25 | ₹1,650.50 / ₹50,325.25 | debit 165050 paise, credit 5032525 paise, 4 payments, 1 batch `statement:generic_bank_csv` |
| Debit/credit-marker layout (`D` = debit)     | 3 → ₹1,975.75 / 1 → ₹50,000.00 | ₹1,975.75 / ₹50,000.00 | not imported (previewed only)                                                              |
| `ambiguous-layout-refund.csv`, marker layout | 1 → ₹800.00 / 1 → ₹300.00      | ₹800.00 / ₹300.00      | not imported                                                                               |

Previews and every refused attempt left the ledger at 0 rows; after the single confirmed import
it was 4 payments and 1 batch, and the repeated import (and every direct-API refusal listed in
`round4/logs/10-direct-api-refusals.log`: auto on a tie, unknown layout, a PDF layout for a CSV, a
layout the header does not fit, a layout that cannot read a row, no kind, kind/account mismatch
both ways) left it at 4 and 1. Browser traffic all went to `127.0.0.1:4001`.

**Defect found while rendering and fixed:** at 375 px the dialog scrolled sideways (content 436 px
in a 341 px dialog) because a `fieldset` is as wide as its widest content and a layout's header
line is one long string. Fixed with `min-w-0` and `break-all`; remeasured at 341/341, page 375/375.
Also changed after the first render: the choices are named by their on-screen words
(`aria-labelledby`), not by the layout's internal id.

**Keyboard and phone:** Space on a focused radio chooses a layout; Enter on **Import it** confirms
(the only thing that writes); Escape writes nothing. At 375 px each option is 267 px wide and
≥127 px tall, there is no horizontal overflow, and the choice, reading and summary were checked.

**Not done / limits:** a layout is an explicit person's choice, so the dialog cannot say which
layout is "right" — the totals are the check, and for the example above the two readings differ by
one row's direction. XLSX tie-resolution in the browser, a `.csv` with a different tied pair, and
the per-row direction words of every layout were not rendered. The dialog's source-system and
account fields keep their values between two dialogs (pre-existing behaviour).

### Checks (fourth round)

Targeted first (root: the new `statement-layout-choice` file plus every statement-import and
format file, 10 files / 244 tests; web: `payments`, 2 files / 57 tests — all passed), then one
serial final suite, every command exit 0: root typecheck, lint, format, `db:check`, build;
`npm test` **130 files, 2,848 passed, 7 skipped** (the seven real-server-only lock tests); web
typecheck, lint, format, build; `npm --prefix web test` **43 files, 508 passed**. Before the UI
change the ten new component tests failed (red) and after it all passed; two of my own test
mistakes were fixed along the way (a seeded import batch in the "nothing written" baseline, and a
`200` standing in for a refusal) — neither was a product defect. No failure was retried to make it
pass. Real-PostgreSQL integration was not re-run for this round (nothing here touches locking);
the previous round's 65 files / 1,287 tests stand for that.

## Fifth round (two browser evidence gaps; no code changed)

Synthetic ledger, scratch API 4001 / web 3001, real browser pane. Controlled failure injection
was a `fetch` wrapper installed in the page for the allocation request only; the server was the
real scratch API throughout. No code was changed, so the fourth round's suite results stand and
were not re-run.

**A. Approve-then-allocate failure recovery — browser-verified.** Ledger counts come from the
API (`round5/logs/10–18`).

| Step                                                                                    | What the browser did                                                                                                                                                     | Ledger afterwards (dinner expense)                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Open Needs attention, open the dialog                                                   | nothing sent but reads and previews                                                                                                                                      | `review_required`, personal, 0 allocations, 3 audit events                  |
| Approve as Shared with Alex; allocation request answered 503 (never reached the ledger) | decision ×1, allocation ×1; dialog stays: _"It was approved as shared, but the split did not save"_, button **Save the split**, no kind choice                           | `approved`, shared, ₹3,000.00, 0 allocations, 5 audit events                |
| **Save the split**, still failing                                                       | one read of the expense, allocation ×1 (503); **no second decision**                                                                                                     | unchanged (5 events)                                                        |
| Escape, then page refresh                                                               | dialog closed; the question is gone from the card but visible under _Still to come → Who shared this expense? ₹3,000.00_ (the ledger-wide `allocation_missing` question) | unchanged (5 events)                                                        |
| Complete on `/expenses/:id/share` (preview ₹1,500.00 / ₹1,500.00)                       | allocation saved                                                                                                                                                         | `allocated`, shared, ₹3,000.00, 1 allocation, 6 events; Alex owes ₹1,500.00 |
| Groceries, **response lost**: allocation committed, browser got a network error         | dialog shows the same partial-success message                                                                                                                            | already `allocated`, 1 allocation, 6 events                                 |
| **Save the split**                                                                      | **GET expense only — no allocation or decision request**                                                                                                                 | unchanged: 1 allocation, 6 events                                           |

Findings: the dialog state does **not** survive a refresh; the documented route is the Needs
attention "Who shared this expense?" question and the share screen, and both worked. After close
the card disappears from the current page until refresh (the queue is re-read), which is the
designed behaviour. One wording gap: after a lost response the message says "Couldn't reach the API.
Check that src/server.ts is running" (the generic network error); it is true of the request but
does not say the split may have saved — the retry's read of the expense settles that. Left as is.
Totals: expected total ₹4,250.50, own share ₹2,125.25, Alex ₹1,500.00, Sam ₹625.25 — actual
425050 / 212525 / 150000 / 62525 paise. Opening or cancelling approved nothing; each approved
amount and kind was unchanged at every step. Not exercised: failure of the _decision_ request,
and an allocation failing a second time after a successful first retry.

**B. Ambiguous synthetic XLSX through the real dialog — browser-verified.** Same four rows as the
CSV, as `ambiguous-layout.xlsx`. Two candidates shown, none selected, Import disabled, kind not yet
asked; generic reading ₹1,650.50 out (2) / ₹50,325.25 in (2), marker reading ₹1,975.75 (3) /
₹50,000.00 (1) — as expected; replacing the file with `other-shop.xlsx` (and back) cleared choice
and reading each time (other file, generic: 1 movement ₹99.00); kind (bank, said by the person)
and account chosen separately; one explicit import by keyboard: 4 rows, debit 165050 / credit
5032525 paise, batch `statement:generic_bank_csv`; a repeat (the preview said "already on record")
left payments at 6 and batches at 2. All traffic went to 4001. At 375 px: no horizontal overflow,
options 267 px wide and ≥127 px tall, Space chooses a layout, Enter confirms. Not exercised in this
round: an XLSX refusal state and an account-kind mismatch for XLSX (both are container-independent
and were rendered for CSV in the fourth round).

**What is browser-verified overall, and what is not.** Verified in a rendered browser on
synthetic data: the journeys in the first and second rounds, the kind choice with server-computed
preview, partial-success recovery (above), the duplicate deferral refusal, CSV and XLSX layout
choice. **Not** browser-verified: the real-PostgreSQL concurrency fixes (API/test evidence
only), any live provider, other statement layouts, light/dark themes and axe on the new states,
and anything run against a real ledger (none was). No security scan has been run.

## Sixth round (an approval whose answer is uncertain)

Closes the gap the fifth round named: failure of the classification **decision** request itself.
Rendered browser, synthetic ledger, scratch API 4001, response loss injected in the page against
the real scratch API (`round6/synthetic-inputs/injector.js`; counts from the API in `round6/logs`).

**Reproduced before the fix** (`01-BEFORE…`): the decision committed (expense `approved`, shared,
audit 3 → 5) but its answer was lost. The dialog said only _"Couldn't reach the API. Check that
src/server.ts is running"_ and kept the button **Record it and save the split**. Pressing it sent
the decision **again blindly**; the ledger refused it (409), the dialog vanished, the person's
split was silently dropped and the expense sat approved with no split (recoverable only through
the "Who shared this expense?" question). No second expense or audit event resulted, but the
retry was blind and the wording gave no hint the approval might exist.

**Fix** (`web/src/lib/queries.ts`, `api.ts`, `purpose-choice.tsx`): after a request that ended
**without an answer** (connection dropped, or a 502/504) the ledger is **read** — never guessed
from the error text or a timer — and: recorded → carry on with the split without resending;
read says not recorded → _"we checked, and nothing was approved"_ (superseded by the seventh round: not safe to say); cannot be read → _"can't yet
tell whether the approval was recorded… nothing will be sent again until the ledger has been
checked"_. A retry after any unanswered attempt reads first (flag kept across close/reopen). A
lost split response is read back the same way; if unreadable the dialog says the split _"may or
may not have saved"_ and no longer says "Nobody owes anything yet". A confirmed server refusal
(any other status) keeps its own message and is not treated as uncertain.

**After the fix, rendered:**

| Case                                                        | Request sequence                                                                                                        | Ledger                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **A** request fails before the server (groceries ₹1,250.50) | decision `[fail]` → read → message "nothing was approved"; Escape, reopen, confirm: read → decision → read → allocation | before retry: `review_required`, personal, 3 audit events, 0 allocations; after: `allocated`, shared, ₹1,250.50, 1 allocation, 6 events |
| **B** decision recorded, answer lost (brunch ₹800.00)       | decision `[lost]` → read (approved) → allocation; **no second decision**, no error shown                                | `allocated`, shared, ₹800.00, 1 allocation, 6 events — one expense                                                                      |
| Stranded split after the pre-fix run (dinner ₹3,000.00)     | refresh → `allocation_missing` "Who shared this expense?" listed                                                        | completed through the share endpoint: ₹1,500.00 each                                                                                    |

Totals expected vs actual: total ₹5,050.50 (505050), own share ₹2,525.25 (252525), Alex ₹2,125.25
(212525), Sam ₹400.00 (40000) — all matched. Approved gross and kind were identical at every read.

**Tests:** five new component tests with a stateful fake ledger (drop before commit, lost
decision answer, unreadable ledger → no resend, lost split answer read back, "may or may not have
saved" wording). Web: typecheck, lint, format, build exit 0; `npm --prefix web test` 43 files,
**513 passed**. Root code did not change, so the round-4 root result (130 files, 2,848 passed, 7
skipped) stands and was not re-run.

**Residual limits:** the _unreadable-ledger_ states are covered by component tests, not injected in
the browser; a request that is merely slow can still commit after the check read "not recorded"
(the retry's read-first catches it, and the ledger refuses a second decision); an allocation
refused with 5xx other than 502/504 is treated as a refusal. No security scan was run.

## Seventh round (the delayed-commit race in round six's recovery)

Round six's message after a dropped decision read _"we checked, and nothing was approved"_. That
is not safe to say: the original request can still commit after the check. **Corrected; browser evidence for this round is in the eighth round below.**

**Changes** (`web/src/lib/queries.ts`, `api.ts`): the ledger is read and compared with what the
dialog asked — `committed` (approved as asked), `pending`, `different` (decided another way, e.g. in
another tab) or `unreadable`. An `INVALID_STATE_TRANSITION` 409 is **settled from that read**, not
treated as success or as failure: committed → continue with the split; different → a
`DecidedDifferently` message ("it is approved as just me… nothing from this dialog was applied, and
the split you chose was not saved. Look at it again"), no allocation sent, queue refreshed;
pending-but-"already decided" → uncertain. "Not recorded" wording is now _"when we checked, the
ledger had not recorded the approval. The original request could still arrive… checked again before
anything is sent"_ (same for the split). Uncertainty is decided by the API contract: the ledger
always answers a refusal with a structured `{ error: { code, message } }` body, so only a dropped
connection or an **unstructured** body (a proxy 502/503/504 page, `UNKNOWN_ERROR`) is unanswered;
a structured 503 is a known refusal.

**Deterministic tests** (fake ledger, no sleeps): a late original commit found on retry (one decision
ever sent, then the split); a stale 409 met on send and settled by reading (second send, split saved
once, after it); another tab's different outcome on retry and on a direct 409 (not applied, no
allocation, shows "approved as personal"); an unstructured gateway 503 after commit (read back as
committed, decision once, split once). Web: typecheck, lint, format, build exit 0; `npm --prefix web
test` 43 files, **518 passed**. Root untouched since round four.

**Pending / limits:** no browser run of these sequences this round; a different tab's outcome
that is only visible after refresh is handled by the dialog's own read, not by live updates; HawkScan
remains unavailable (no scan, no clearance).

## Eighth round (browser verification of decision recovery)

Rendered synthetic website against the **real scratch API** (database under `round8/scratch`, ports
4001/3001). Network control was a page-side wrapper with **explicit barriers, no timers**: a
decision can be _held_ (the app is told it failed while the real request waits) and released by an
explicit call, committed-then-lost, answered by a proxy-style 503 page after commit, or the
expense read can be made unavailable. Ledger counts are read from the scratch API after each step
(`round8/logs/*.txt`, request order in `20-request-traces.txt`). "Other tab" = a direct API call to
the same scratch ledger.

| #   | Scenario                                                                                    | Request order (abridged)                                                                                                                                      | Ledger result                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Original still in flight when the recovery read sees **pending**, then commits before retry | decision (held) → read (pending) → _original released: commits_ → retry: read (approved) → read → allocation                                                  | decision sent **once**; approved shared/5 audit → allocated/6 audit, 1 allocation                                                                                                                                                                                 |
| 2   | Retry reads **pending**, original lands, retry's send meets a real **409**                  | decision (held) → read → retry: read (pending) → _original released_ → decision → **409 `application/json`** → read (committed as asked) → allocation         | 1 allocation, 6 audit; the 409 was settled from the ledger, not assumed success                                                                                                                                                                                   |
| 3   | Another tab approves **personal** instead of shared                                         | decision (held) → read; other tab accepts → retry: read only                                                                                                  | approved **personal**, 0 allocations, 4 audit; the dialog says _"already decided another way — it is approved as personal… the split you chose was not saved"_, no allocation request; later release of the held original was refused (**409**), ledger unchanged |
| 4   | Unstructured gateway **503** (HTML) after upstream commit                                   | decision → proxy 503 page → read (approved) → allocation                                                                                                      | decision once, 1 allocation, 6 audit                                                                                                                                                                                                                              |
| 5   | Ledger read **unavailable**, then readable                                                  | decision (committed, answer lost) → read fails → "can't yet tell…"; retry: read fails again, **no second decision**; reads restored: read → read → allocation | decision once; approved/5 audit while unreadable → allocated/6 audit, 1 allocation                                                                                                                                                                                |

Structured vs unstructured: case 2's 409 is the API's own `{ error: { code: INVALID_STATE_TRANSITION } }`
body (a known refusal); case 4's 503 is a proxy page (unanswered). A _structured_ 503 is covered only
by a unit test of the contract (`api-unanswered.test.ts`), not rendered.

Totals, hand-calculated beforehand: approved total ₹6,850.50, own share ₹4,025.25, Alex ₹1,625.00,
Sam ₹1,200.25 (three personal outcomes create no debt) — actual 685050 / 402525 / 162500 / 120025 paise.
Approved gross and kind were identical at every read; no second expense, no duplicate audit event.

**Defect found and fixed:** in case 3 the first run showed no message at all — on
`DecidedDifferently` the queue was refreshed at once, so the card and dialog unmounted before the
explanation could be read (`round8/logs/case3-BEFORE-fix-defect.txt`). Fix (`queries.ts`,
`purpose-choice.tsx`): refresh the queue when the dialog closes instead; the re-run above shows the
message (screenshot `round8/screenshots/01…`). Regression test: a harness whose queue drops the card
asserts the message stays and the queue refreshes on close; plus the contract unit test. Web:
typecheck, lint, format, build exit 0; `npm --prefix web test` 44 files, **521 passed**. Root untouched.

**Still unverified (as of round 8; the structured 503 is addressed in the tenth round):** a structured 503 in the browser; lines whose proposal never arrives (one
imported line, `CAFE COFFEE`, produced no expense and was left alone); the real-PostgreSQL
behaviour (no change); HawkScan (unavailable — no scan, no clearance). The regression test for the
vanishing message was not mutation-checked against the old code; the rendered before/after is its evidence.

## Ninth round (final review of the whole patch)

A source-and-diff review, not another feature round; the full report is `round9/final-review-report.md`
(outside the repo). One further defect was found and fixed: recovery treated an approval already on
record as "ours" when only its state and kind matched. It now also compares the **category**, and a
split already saved is compared **by people and method** with the one sent — an approval under
another category, or a split another tab saved between other people, is shown as a different
outcome and nothing is overwritten (`web/src/lib/queries.ts`, two component tests). The round-8
regression test for the vanishing message was **mutation-checked** (restoring the old refresh
fails it; source restored). The round-8 `CAFE COFFEE` line is **expected**: it has a pending
classification proposal in the review queue and a derived `classified` expense; it is simply not
approved yet, so it is outside Spending and its payment is unexplained (an earlier filter on
`review_required` hid it). Web: 44 files, **523 passed**; typecheck, lint, format, build exit 0.

## Tenth round (browser verification of the round-9 recovery comparison)

Rendered synthetic website against the **real scratch API** (database under `round10/scratch`, ports
4001/3001, started with `env -i` and explicit `PGLITE_DATA_DIR`/`EVIDENCE_STORAGE_PATH`; no provider
variable present; web pointed at 4001 by shell variable, every API request went to 4001). Same
barrier harness as round 8 (explicit holds and releases, no timers); "another caller" is a direct
API call to the same ledger. **No code changed.** The hand-calculated expectations were written
before the first browser step (`round10/logs/01-expected-before-run.txt`).

| #   | Scenario                                                                                                  | Request order (abridged)                                                                                                                                          | Ledger result                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unanswered approval (shared/Dining, held); another caller approves **shared under Groceries**             | decision [held] → read ("not recorded") → _other caller approves_ → retry: **read only** → message "approved under “Groceries”"; held original released → **409** | approved, shared, **Groceries**, ₹1,000.00, **0 allocations**, audit 3→5, unchanged after the release; the dialog's split was never sent           |
| 2   | Same, but another caller approves shared/Dining **and saves a split between Dev and Sam**                 | decision [held] → read → _other caller approves and splits_ → retry: reads + history → message "split a different way — between Dev, Sam"; release → **409**      | allocated, shared, Dining, ₹600.00, **1 allocation (Dev ₹300.00 / Sam ₹300.00, Alex not on it)**, audit 6; nothing overwritten, no allocation POST |
| 3a  | Matching category; decision committed, answer lost                                                        | decision [lost] → read (approved = ours) → allocation → dialog closes                                                                                             | allocated, shared, Dining, ₹800.00, 1 allocation (Dev ₹400.00 / Alex ₹400.00), audit 6; one decision POST, one allocation POST                     |
| 3b  | Matching category **and the same equal split already saved** by another caller while the original is held | decision [held] → read → _other caller approves and splits Dev+Alex_ → retry: reads + history → recognised as the same split → dialog closes; release → **409**   | allocated, shared, Dining, ₹400.00, 1 allocation (Dev ₹200.00 / Alex ₹200.00), audit 6; **zero** allocation POSTs from the browser                 |

In cases 1 and 2 the explanation stayed on screen from the retry until the dialog was closed
(checked after the held original was released and refused), and the queue was refreshed only on
close. Screenshots: `round10/screenshots/01…`, `02…`. In case 1 the card then stays in the queue as
"Who shared this expense?" (`allocation_missing`), which is the correct state for an approved,
unsplit shared expense.

Hand-calculated against actual (six lines in all, see the structured-503 cases below):

| Figure (Aug 2026) | Expected                                                                       | Actual (paise) |
| ----------------- | ------------------------------------------------------------------------------ | -------------- |
| Spent             | 1,000 + 600 + 800 + 400 + 300 + 250 = ₹3,350.00                                | 335000         |
| By category       | Dining 2,350.00; Groceries 1,000.00                                            | 235000; 100000 |
| Own share         | 1,000 (ALPHA, unsplit, counts whole) + 300 + 400 + 200 + 150 + 125 = ₹2,175.00 | 217500         |
| Alex owes you     | 400 + 200 + 150 + 125 = ₹875.00                                                | 87500          |
| Sam owes you      | ₹300.00                                                                        | 30000          |
| Not yet accounted | ₹0.00                                                                          | 0              |

One expectation was wrong and is kept as written: the pre-run note counted ALPHA's own share as
zero until split (own share ₹900.00); the ledger counts an approved shared expense with no split
as wholly the user's, so ₹1,900.00 for the first four lines (₹2,175.00 for all six). The product
behaved consistently; the prediction did not. No expense was duplicated (6 expenses for 6 lines),
no approved gross changed, and no audit event was duplicated (3→5 approved-unsplit, 6
allocated).

### Structured 503: what was injected and what was real

- **Injected (page-side, request not sent):** a `503` with an `application/json`
  `{ error: { code, message } }` body, on the decision and on the allocation. The code is
  `INJECTED_STRUCTURED_503` so it cannot be mistaken for the API. On the decision (the
  EPSILON line) the client treated it as a **known refusal**: the body's message was shown, **no
  recovery read and no resend** happened, and a normal retry then sent exactly one decision and one
  allocation (ledger: allocated, 1 allocation, audit 6). On the allocation (the ZETA line) the dialog said "approved
  as shared, but the split did not save" with the body's message, and **Save the split** read the
  expense once and sent one allocation. This proves the client contract for a structured 503; it
  is **not** evidence that the API ever answers 503 on these routes.
- **No real API path was found that answers a structured 503 on the approval or split routes**
  (`src/api/http.ts` maps only `EVIDENCE_STORE_UNAVAILABLE` and `LEDGER_QUESTION_UNAVAILABLE` to 503).
  Nothing was invented to claim otherwise.
- **Real, unmodified API refusal rendered in the browser:** with the scratch evidence directory made
  read-only (my own scratch folder, restored afterwards), uploading a synthetic 1×1 PNG on `/evidence`
  returned the API's own `503 EVIDENCE_STORE_UNAVAILABLE` (headers and body in
  `round10/logs/60-real-api-structured-503.txt`; screenshot `04…`). No evidence row or file was
  written. This is a different route from the decision flow, so it shows how a real structured 503
  reaches the dialog, not that recovery handles it.

### Mutation check of the round-9 comparison

A reversible change to `web/src/lib/queries.ts` — the category comparison disabled (`false && …`) and
the saved-split comparison replaced by `true` (the old behaviour: any approved/allocated expense of
the same kind is "ours") — failed exactly the two round-9 tests ("an approval of the same kind under
another category is a different outcome, not ours", "a split another tab saved between other people
is never taken for ours"; 2 failed, 33 passed). The correct source was restored from a byte copy
immediately: sha256 `6d611ddd…c39aac` before and after, `git diff` hash identical, no `MUTANT` marker
left, `cmp` identical, and the file's tests pass 35/35 afterwards (`round10/mutation/`). The
mutant was **not** rendered in the browser; that would only repeat the component-test failure.

### Current checks

| Suite                                            | Result                                      | When                                                         |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------ |
| Web typecheck, lint, format                      | exit 0                                      | round 10 (no code changed)                                   |
| Web tests                                        | **44 files, 523 passed**                    | round 10                                                     |
| Root typecheck, lint, format, `db:check`, build  | exit 0                                      | round 4 (root unchanged since)                               |
| Root tests (PGlite)                              | **130 files, 2,848 passed, 7 skipped**      | round 4 (skips = `duplicate-lock-order`, need a real server) |
| Real PostgreSQL 18.6, serial `tests/integration` | **65 files, 1,287 passed** (lock tests 7/7) | round 3, before `statement-layout-choice`                    |
| Browser (rendered, synthetic)                    | rounds 1, 2, 4, 5, 6, 8, 10                 | see each round                                               |

Web history: round 6 513 → round 7 518 → round 8 521 → round 9 523 (unchanged in round 10).

### Still open after round 10

HawkScan: no skill, no `hawk`/`hawkscan` binary, no Docker, `HAWK_API_KEY` unset — **no scan, fix or
rescan was possible and no security clearance is claimed.** The fingerprint check against the real
ledger and source PDFs was not run (forbidden here). The three owner decisions listed in
`round10/owner-decisions.md` were **resolved on 6 October 2026** (ADR-0071 and ADR-0068 ratified as
built; the approved-Personal correction deferred). Not rendered: PostgreSQL concurrency, themes/axe on the new states,
a second real browser, an unreadable-ledger case with two callers.

## Eleventh round (security readiness review; code changed)

Static review, `npm audit` and manual probing of a synthetic scratch API; full report
`round11/security-readiness-report.md` (outside the repo). Three demonstrated defects were fixed:
a **cross-site write** to every write route (a `text/plain` "simple" `POST` from a page on another
origin needs no preflight and the JSON parser ignored the declared type) and the missing `Host` check
behind DNS rebinding — both closed by `src/request-guard.ts`, wired in `src/server.ts`
([ADR-0072](../decisions/0072-a-write-is-accepted-only-from-the-web-origin-this-ledger-serves.md),
not yet reviewed by the owner); and **XLSX memory amplification** (a 1.5 MB upload inflated ~1.4 GB),
closed by a workbook-wide budget in `xlsx.ts`. The cross-site write was reproduced before and after in a
real browser; the XLSX regression test fails on the old code. `next@16.3.4` carries an advisory
(GHSA-vcvr-r3jv-pc5j, `next/og`) that this app does not reach; the upgrade was left as an owner action and done in the twelfth round.
**HawkScan remains unavailable (no binary, Docker, skill or key), so the scan/fix/rescan loop is owed and no
clearance is claimed**; `round11/dast/` holds the scan configuration and run instructions. Root:
typecheck, lint, format, `db:check`, build exit 0; `npm test` 131 files, **2,864 passed, 7 skipped**. Web
and real-PostgreSQL results are carried forward (`web/` and the locking code did not change). The
owner approved the three release decisions on 6 October 2026 (recorded above).

## Twelfth round (dependency advisories, verified with the round-11 fixes)

Versions and advisories refreshed from the npm registry (`npm audit`, 6 October 2026, npm 11.19.1) and
the GitHub Advisory Database. `web/`: `next` and `eslint-config-next` 16.3.4 → **16.3.8** (the registry's
`latest`; patched in 16.3.6 for GHSA-vcvr-r3jv-pc5j, and no newer advisory against 16.3.8), with the
`@next/*` binaries, `@next/env` and `@next/eslint-plugin-next` aligned to 16.3.8, plus in-range
`source-map-js` 1.2.1 → **1.2.2** (GHSA-68fv-2mgg-jv7q) and `brace-expansion`. Root: in-range
`vitest`/`@vitest/mocker` 4.1.10 → **4.1.11**, `brace-expansion` 1.1.21/5.0.12, `js-yaml` 4.3.2,
`source-map-js` 1.2.2 and the dependencies vitest 4.1.11 pulls in (`vite` 8.3.3, `rolldown` 1.2.12, …).
No `--force`, no major upgrade, no `package.json` change in the root (only `web/package.json`'s two pins).

| Audit (production / full) | Before                                                       | After                                      |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| Root                      | 0 / 9 (6 moderate, 3 high)                                   | **0 / 4** (4 moderate)                     |
| `web/`                    | 2 (1 critical, 1 high) / 11 (3 critical, 7 high, 1 moderate) | **0 / 8** (2 critical, 5 high, 1 moderate) |

Every production advisory is closed. What remains is development tooling only and needs a breaking
change: root `esbuild ≤0.24.2` under `drizzle-kit` (the offered "fix" is a downgrade to 0.18.1);
`web/` `vitest` 3.2.7 → `@vitest/mocker`/`tinypool` (fix was vitest ≥ 4 — done in the thirteenth round; the root already
runs 4.1.11) and the `eslint-config-next` → `fast-glob` → `micromatch` → `braces` chain (16.3.8 still pins
`fast-glob` 3.3.1; the offered "fix" is a downgrade to 14.2.35). None is reachable from the running app.
Checks after the bumps: web typecheck, lint, format, **build** and tests (44 files, **523** passed); root
typecheck, lint, format, `db:check`, build and tests (131 files, **2,864** passed, 7 skipped), all exit 0.

On the updated stack and a guarded scratch API, in a real browser at the allowed origin: a CSV import, a
shared approval with the ledger's split (₹600.00 each), a personal approval and an XLSX import with an
explicit layout choice all worked (spent ₹1,700.00, own share ₹1,100.00, Alex owes ₹600.00); a text/plain
write and a rebinding `Host` from another origin were refused with the ledger unchanged; an
aggregate-oversize workbook (128 MiB declared, 131 KB sent) was refused on preview and import with no
memory spike. HawkScan is still unavailable — **DAST not run, no clearance**. ADR-0072 still awaited the
owner's review at that point (ratified on 6 October 2026, round 15). Details: `round12/dependency-and-security-verification.md`.

## Thirteenth round (web test tooling: Vitest 3 → 4)

`web/` `vitest` `^3.2.7` → **`^4.1.11`** (resolved 4.1.11, the same as the root; `@vitest/{expect,mocker,pretty-format,runner,
snapshot,spy,utils}` 4.1.11, `tinyrainbow` 3.2.0, `chai` 6.3.0). Chosen from the registry (`V4` tag = 4.1.11, `latest` = 5.0.3, which was
not needed: 4.1.11 is the first release outside the `@vitest/mocker` advisory range and brings a `tinypool`-free runner) and Vitest's v4
migration guide. No config, test or source change was needed: `vitest.config.ts` uses none of the removed options, and the suite passed
first time — **44 files, 523 passed**, unchanged — as did typecheck, lint, format and `next build`. Lockfile: 85 entries changed, mostly
removals (`tinypool`, `vite-node`, `cac`, `loupe`, the nested vite 7 / rollup / esbuild 0.28 and their platform binaries). The one new
message is Vite 8's notice that `vitest.config.ts` uses ESM syntax in a CommonJS-typed package (a future-default `configLoader` warning,
not an error); it was left alone.

`web/` audit (6 Oct 2026): production **0 → 0**; full **8 → 5** (2 critical, 1 moderate closed: `vitest`, `@vitest/mocker`, `tinypool`).
Remaining five are high and all one lint-time chain: `eslint-config-next` 16.3.8 → `@next/eslint-plugin-next` → `fast-glob` 3.3.1 →
`micromatch` 4.0.8 → `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm, "deeply nested patterns" stack exhaustion). **No patched `braces` exists** (every
published version ≤ 3.0.3 is in range; 3.0.3 is the latest), so no lockfile or override can close it, and npm's offered "fix" is a downgrade to
`eslint-config-next@14.2.35`. Reachability: ESLint's own glob handling of this repository's fixed patterns at lint time; not in the build,
bundle or running app. A dependency audit is not a security clearance; **HawkScan/DAST is still unavailable and not run.** Details:
`round13/web-test-tooling-upgrade.md`.

## Fourteenth round (release-candidate closure run; no application code changed)

- **Privacy tooling.** No fingerprint checker existed. A local-only, opt-in checker with tests on invented fixtures now exists **outside the repository**
  (`round14/privacy/`: 19 tests, plus a mutation check). It reads only paths the owner names, matches in memory, prints counts and a verdict only, and fails
  closed (exit 3) on any unsupported, unreadable or unprocessed input. **It has not been run on real data and does not complete privacy clearance.**
- **Security review of the round-11 guards.** Origin, null/missing `Origin`, scheme and trailing-slash variants, multipart, `Host` spellings (case, ports, IPv6,
  trailing dot, look-alikes), duplicate `Host`, hostile `fetch` and a hostile `<form>` POST were exercised on the production build; no bypass was found and no code
  changed. Observable behaviour is now written into ADR-0072, which **was then awaiting the owner's review** (ratified as built on 6 October 2026, round 15).
- **DAST preparation.** An accurate hand-written OpenAPI subset (ten write operations from the route handlers), a seed/generator that pins live synthetic ids,
  and a self-check that replays every example body against the target (8/8 accepted) replace the GET-only plan. HawkScan is **still not run**: no binary, Docker,
  skill or key (checked once). Covered and excluded routes are tabulated in `round14/dast/README-dast.md`.
- **Release acceptance on the production build** (`next build` + `next start`, guarded API, scratch ledger): import preview, choice of layout for a workbook whose
  columns tie, approval personal and shared with ledger-computed splits, a lost decision answer recovered with one decision and one allocation, a duplicate whose
  second copy is refused and then resolved ("same payment"), two real payments resolved ("keep both") and both counted, a valid and a rejected workbook, an
  aggregate-oversize workbook refused, hostile writes and a rebinding `Host` refused with the ledger unchanged, 375 px dialogs and six pages without horizontal
  overflow, focus entering and returning, Escape and the Tab trap. Hand-calculated totals matched: spent ₹6,000.00, own share ₹5,000.00, Alex ₹600.00, Sam ₹400.00,
  unaccounted ₹0.00, then ₹325.00 after the workbook (7 → 9 payments, 2 → 3 batches).
- **Audit at the end of the run** (6 Oct): production **0 / 0** (root / web); full 4 moderate (root: `drizzle-kit` → `esbuild`, only fix is a downgrade) and 5 high (web: the
  `eslint-config-next` → `fast-glob` → `micromatch` → `braces` lint chain; no patched `braces` exists). Neither is in the running application.
- Suites were not re-run: no application code or test changed in this round (carried forward: root 131 files / 2,864 passed / 7 skipped and web 44 / 523, both 6 Oct;
  real PostgreSQL 1,287, round 3). Details: `round14/release-candidate-report.md`.

## Fifteenth round (gates: ADR-0072, scanner, DAST, privacy check — publish NOT performed)

- **ADR-0072 ratified by the owner on 6 October 2026, as built** (the owner's answer to the round-14 checklist, "1. Approved"), recorded in the ADR, the index, `README.md`, `CLAUDE.md`, this report
  and the handoff; the earlier "awaiting review" wording is kept as history.
- **Scanner:** the official Hawk CLI **6.5.0**, installed from the vendor's Homebrew tap (Docker not needed). After the owner approved the device login, the stored credential was used without being
  read or printed; the scan application was created with the CLI as scan metadata only (no plan, terms or access change). A checked search found the credential nowhere in the evidence files.
- **DAST, on the production-mode synthetic target (127.0.0.1:4001, scratch ledger, no real data):** the OpenAPI subset describes **12 operations** (3 reads, 9 writes: people, people/{id}, accounts,
  imports/preview, imports/statement, evidence/notes, review decision, allocation, allocation/preview). Final configuration: the crawl plan ran **12/12** operations with live synthetic ids (the first
  configuration managed 8/13; causes found in the scanner log and fixed in the _scan inputs_, not the product: duplicate example names, ids not honoured as body examples, an unapproved seed expense,
  and the multipart upload, which HawkScan sends as JSON — that route is excluded and was probed by hand instead). The active and passive rules then ran with real volume (hundreds of people, accounts
  and evidence rows were created by the scanner's own writes).
  - **Confirmed finding, fixed:** Low — `X-Content-Type-Options` missing on every JSON route (13–15 paths). Fix: `applyBaselineHeaders` in `src/request-guard.ts`, applied in `src/server.ts`, with a unit test.
    **Rescan evidence:** with the fix temporarily removed the scan reproduced the finding (15 paths); the file was restored (sha-256 verified); `hawk rescan` of that scan reported no findings, and a
    final full scan reported no findings (`round15/logs/60…62`). The very first scan's own record was overwritten before it could be rescanned, which is why the temporary-mutation round-trip was run.
  - **Not a vulnerability:** Low "Private IP Disclosure" on three list endpoints, intermittent. The literals are the scanner's own injected payload text, stored by its writes and echoed back as data
    (counts in `round15/logs/50…`); no change. One related clean-up: the origin-refusal message no longer repeats the configured origin (test added).
  - **Result:** every scan finished `COMPLETED`, threshold `PASS`, zero errors or warnings; the last full scan and the rescan report **no findings**. This covers the described operations on a synthetic ledger
    with authentication off. It does **not** cover the website, session/auth routes, provider/intake routes, the multipart upload, or any route outside the subset, and a clean scan is bounded evidence, not a guarantee.
- **Privacy check, run read-only on the owner's local statement exports** (counts only; nothing private printed or logged). Seven keyword-named statement PDFs exported as text to a 0700 folder outside
  any repository (6,317 lines, then deleted; originals untouched); 15 other PDFs were not opened. Against the exact 60-file candidate set: **0 matches among 4,903 identifiers, 0 name-like phrases**; the
  first-run phrase flags were all bank/card brand vocabulary and the word flags ordinary public vocabulary. The checker was improved for this (`--dictionary`, `--allow-words`, `--known-public`, `--explain`; 23
  tests, mutation-checked). **Bounded PASS on statement sources only.** Still **not covered**: ledger-only content (people, notes, merchant resolutions, evidence text — needs a GET export from the running
  real API, not authorised) and any statement PDF whose name carries no keyword. Full privacy clearance is **not** claimed and the privacy gate is therefore **not fully met**.
- **Checks after the code change** (`src/request-guard.ts`, `src/server.ts` and tests): root typecheck, lint, format, `db:check`, build exit 0; **131 files, 2,866 passed, 7 skipped** (+2). Web and real PostgreSQL
  unchanged (carried forward). **Not committed, not pushed:** publish needs both gates; the privacy gate is incomplete. Details: `round15/dast-and-privacy-gates.md`.

## Sixteenth round (privacy coverage: remaining PDFs and a ledger-only export; publish NOT performed)

- **No application code changed.** Every candidate file is byte-identical to round 15's (compared per file against the round-15 patch); the DAST evidence above therefore still describes this exact product. Root checks re-run: typecheck, lint,
  format exit 0; **131 files, 2,866 passed, 7 skipped**.
- **Statement sources, completed as far as the files allow** (counts only; originals untouched, digest of every candidate source file equal before and after). With `--all-pdfs` the 15 PDFs whose names carry no statement keyword
  were opened locally: **0 are statements by content, 11 are other documents (discarded unwritten), 1 is password-protected and 3 are image-only scans.** Those **4 could not be read, so they are a named coverage gap, not a skipped
  file**: no password was guessed and no OCR or heuristic was substituted. (One extra CSV and two XLSX files were also found and are not statements by content.)
- **Ledger-only content, covered without opening the ledger.** The real ledger directory was proven cold — no `postmaster.pid`, PostgreSQL's own `pg_control` state `SHUTDOWNED` (the last shutdown checkpoint completed; the state reads
  `IN_PRODUCTION` while a database is open and stays so after `kill -9`, verified on synthetic databases), no process holding a file open there, ports 3000/4000 quiet. A free port alone was not accepted. Two byte-identical cold
  copies were then made without opening anything (a restore point that is never opened, and one verification copy) and the original was proven unchanged by one-way content and metadata digests before and after. **Only the verification
  copy was opened**, with PGlite directly (no server, migration, seed or job code), `BEGIN READ ONLY … ROLLBACK`, SELECT-only (a statement gate plus the engine's own read-only enforcement; both tested), closed with an awaited
  `close()`, after which the copy was cold again and the restore point's digest unchanged. Export: **all 43 tables in 2 schemas, 158 text + 28 JSON columns, 10,040 rows, 12,361 distinct strings**, no binary column with data, no unclassified
  column; the evidence, people-adjacent, merchant and group tables hold no rows beyond one person and one user. The exporter was validated on a synthetic ledger first (13 tests: a marker planted in every free-text column that accepts one is
  found; every stored string appears; table and column counts equal the drizzle schema's; refusals for a running or `kill -9` database, the original, the restore point, tampering; mutation-checked).
- **Result on the exact 60-file candidate set, the patch additions and the commit message, against 16 source files (7 statements + 9 ledger tables):** 0 identifier matches, 0 matches in statements, raw payments, people or users.
  Strict mode reports **FAIL on 54 line-hits that are 4 distinct two-word phrases**, all of which occur in the already-published production source and come only from application-written tables (audit events, expenses, inferences).
  The checker gained an **opt-in** `--public-phrase-overlap` tier for exactly this (identifiers are never excused; verdict word `PASS_WITH_PUBLIC_VOCABULARY_OVERLAP`, not `PASS`; 29 tests; 3 of 4 mutants killed, the 4th equivalent); with it the verdict is that word.
- **Verdict: INCONCLUSIVE for publication.** The check is clean on everything that could be read, but 4 statement-candidate PDFs could not be, so full source coverage is not achieved and nothing was committed or pushed.
  Exact remaining input is in `round16/final-privacy-and-publication.md`.

## Seventeenth round (OCR for the image-only scans; owner accepted the overlap tier; publish NOT performed)

- **Owner approvals recorded (6 October 2026):** offline local OCR for the three image-only scans, and the opt-in `--public-phrase-overlap` tier. The tier's verdict word is `PASS_WITH_PUBLIC_VOCABULARY_OVERLAP` (not a strict PASS); identifiers are never excused; the approval did not
  establish that any file is a non-statement and gave no password.
- **OCR, validated on synthetic scans first** (Apple's on-device Vision framework through a small Swift tool run under the OS sandbox with network denied; 7 synthetic tests: every planted string — name, 12-digit reference, date, amount — recovered from an image-only PDF with no text layer;
  blank, short, low-confidence and financial-looking-but-unclassifiable scans stay explicit gaps; OCR text never reaches a report). On the owner's three scans: **none could be classified as a statement or as clearly not one.** Two long scans (30 and 24 pages) read at only 58–63% mean confidence,
  with no statement vocabulary and no way to raise the confidence (scale, language correction and Hindi/Marathi models tried); one 2-page scan read at 95% confidence, prose-like, with one long digit run. Per the approval's terms, low confidence and financial-looking-but-unclassified results
  are **gaps, not clean results**. Their OCR text was still fed to the check as extra source material (it can only make the check stricter): **0 additional matches**.
- **The password-protected PDF:** no password was tried. A readable equivalent was looked for in two demonstrable ways — a readable PDF carrying the same document `/ID`, and the ledger having imported the file's exact bytes (the importer records each file's sha-256; all **7** readable statement PDFs match
  an import batch) — and **neither finds one**. It remains unreadable.
- **Re-run of the whole gate** (`round17/release/rerun-final-check.sh`): the real ledger was re-proved unchanged (content and metadata digests equal the manifest, still `SHUTDOWNED`, restore point never opened, verification copy closed and cold); 7 statements + 9 ledger tables + 3 OCR texts vs the exact 60-file candidate,
  the patch additions and the commit message: **0 identifier matches**; strict mode fails only on the same 4 two-word phrases already in the published source (54 line-hits); with the approved tier the verdict is `PASS_WITH_PUBLIC_VOCABULARY_OVERLAP`.
- **Verdict: INCONCLUSIVE for publication — 4 source files remain unread** (3 OCR-uncertain scans, 1 password-protected PDF). Nothing was committed or pushed. No application code changed, so the round-15 HawkScan result stands. Exact owner input: `round17/final-privacy-and-publication.md`.

## Eighteenth round (owner attestation for the four unreadable files; publication)

- **Owner statement, 6 October 2026, 13:38 IST:** "None of them are statements", about the four files the extractor could not read (one password-protected PDF, three image-only scans). It is recorded as a **narrow owner attestation** — "these exact files are not
  bank/card statements" — bound to the **sha-256 of each file's bytes** (`attest-from-list.mjs`; a 0600 file outside the repository holding hashes only, no path or name). It is **not** OCR or content coverage and is counted separately.
- **Behaviour, validated on synthetic cases (6 tests; 3 mutants of the guards killed):** an attested unreadable file leaves the gap count into its own counter and the status word `COVERED_WITH_OWNER_ATTESTED_EXCLUSIONS` while exporting nothing; a **changed** file no longer matches
  its hash and fails; a **new or unattested** unreadable file fails; a file of a kind that was not attested fails; a malformed, wrong-statement or group/world-readable attestation file attests nothing; an attestation never excuses a file the extractor can read.
- **Gate re-run on the exact candidate** (60 files, patch additions, commit message) against 19 source files (7 statements, 9 ledger tables, 3 OCR texts; ledger read from a verified cold copy, original re-proved unchanged): 0 identifier matches; strict mode fails only on the same 4 phrases
  already in the published source; the combined verdict is **`PASS_WITH_OWNER_ATTESTED_EXCLUSIONS_AND_PUBLIC_VOCABULARY_OVERLAP`** — covered statement/ledger checks, 4 owner-attested non-statement exclusions, and the owner-approved public-vocabulary overlap tier. It is not a strict PASS.
- **Limitations, stated plainly:** the four files' content was **not** verified by the system (OCR was too uncertain on three; the fourth cannot be opened), so a statement hiding in them would not have been fingerprinted — the exclusion rests on the owner's word and on exact bytes only (a changed file is re-flagged).
  Numeric columns and the evidence store (empty) are not text-fingerprinted. The check compares what is supplied; it is not a guarantee. No application code changed, so the round-15 HawkScan result (12 described operations, bounded exclusions) stands.

## Evidence

Synthetic inputs, screenshots and logs were kept outside the repository in
`PES QA Evidence/2026-10-05-readiness/` beside the project folder. None of it is real data.

Per round: `round2/` (the first hardening), `round3/` (concurrency and recovery: before/after logs,
the PostgreSQL server log with the six deadlock reports, the serial 65-file integration log, the
checkpoint patch) and `round4/` (this round: `synthetic-inputs/` — the ambiguous, refund and
malformed CSVs and the identity seed script; `screenshots/` 01–05; `logs/` — red/green, targeted
and final-suite logs, `10-direct-api-refusals.log`; and `combined-readiness-patch.diff`).
`round5/` holds this round: `screenshots/` 01–04, `logs/` (ledger snapshots 10–18, 20–21, `snap.sh`) and `synthetic-inputs/` (the two XLSX files, the dinner CSV, the XLSX generator and the identity seed).
`round6/`: `logs/` (00, 01-BEFORE, 10–13, 30 web final checks, `snap6.sh`), `synthetic-inputs/` (statements, injector, seed) and the patch.
`round7/`: web-only checks and patch. `round8/`: scratch ledger (`scratch/`), `logs/` (ledger snapshots per case, `20-request-traces.txt`, `90-totals.txt`, `30-web-final-checks.log`), `screenshots/`, `synthetic-inputs/` (statements, injector, seed) and the latest combined patch.
`round9/`: final review report, proposed commit description, patch, privacy-scan counts, scratch-ledger inspection of the COFFEE line, final web checks.
`round17/` (also round 18's attestation tooling and final gate): OCR tool + synthetic tests, extractor v3, provenance-by-hash, rerun script, final report, checkpoint, aggregate logs, patch.
`round16/`: final privacy report, checkpoint, cold-copy exporter + tests, PDF extractor v2 + tests, checker with the opt-in overlap tier + tests, aggregate-only logs, patch (same files as round 15).
`round15/`: gates report, checkpoint, Hawk install/validate logs, DAST run script and target, privacy checker v2 + tests, aggregate-only privacy logs, patch.
`round14/`: release-candidate report, ADR-0072 review sheet, `privacy/` (fingerprint checker, tests, owner workflow), `dast/` (OpenAPI subset, generator, scratch-target script, README), `release/` (repeatable production launch/stop), logs, screenshots, refreshed patch.
`round13/`: web test-tooling upgrade report, before/after manifests and lockfiles, audit JSON and summary, check logs, refreshed patch.
`round12/`: dependency and security verification report, before/after audit JSON and summary, lockfile copies, check logs, browser traces and screenshot, ledger snapshots, refreshed patch.
`round11/`: security readiness report, `logs/` (before/after reproductions, `npm audit`, checks), `dast/` (HawkScan configuration, scratch-target script, run instructions), the fingerprint-check checklist, candidate publish paths, the refreshed patch.
`round10/`: `logs/` (expectations written before the run, ledger snapshots per case, `20-request-traces.txt`, `60-real-api-structured-503.txt`, `90-`/`91-` final totals, web checks, services-stopped record), `screenshots/` 01–04, `synthetic-inputs/` (statements, `ledger.py`, `injector-round10.js`, seed, probe PNG), `mutation/` (byte copy of the correct file, hashes, mutant test log), the refreshed combined patch, report, handoff and owner decisions.
