# 0026. A classification proposal writes a DERIVED Expense; a settlement proposal writes nothing

**Status:** Accepted

## Context

Accepting a `classify_transaction` inference "produces **either** an `Expense` **or** a
`Settlement` — never both" (`ai-boundary.md`). What the documents do not say in one place is
_when_ that record first exists — at classification, or at the decision. They say it in two
places, and the two are only reconcilable one way:

- `data-flow.md` step 3 draws `services.evaluateForReview ─▶ Expense.state = CLASSIFIED |
REVIEW_REQUIRED`, which is classification-time.
- `data-flow.md` step 5 draws `services.decideInference ─▶ db.updateExpense (APPROVED)` — an
  **update**, which requires the row to already exist.
- `lifecycle.md`'s `CLASSIFIED` is "`relationship_type` and `category` are set (by AI proposal or
  manual entry), **not yet approved**", and `REVIEW_REQUIRED` is a state an `Expense` sits in
  while waiting for a human.
- Roadmap phase 9 describes the queue as surfacing "`REVIEW_REQUIRED` expenses **and** pending
  `AIInference`s" — two sources, not one.

For a `Settlement`, no such reading exists. `lifecycle.md`: it "has no state machine of its own
beyond existing-or-not — it is created directly as an `APPROVED` record". There is no DERIVED
settlement state to park a proposal in.

## Decision

**The expense path writes a DERIVED `Expense` at classification time. The settlement path writes
nothing until the proposal is accepted.**

On the expense path, `classifyPayment` inserts the expense at `proposed` and walks it
`proposed → classified → (review_required)`, each step an asserted transition with its own
`AuditEvent`. It is DERIVED throughout (`domain-model.md`: "DERIVED until `APPROVED`; APPROVED
thereafter"), and no code path in classification can move it further — `decideInference` is the
only route to `approved`, and it requires a human or a `Rule` (`invariants.md` #15, #16).

The states are walked rather than skipped to. Inserting the row directly at `review_required`
would be one statement instead of three, and would make `lifecycle.md`'s central claim —
"nothing skips a state silently" — false on the very first entity to use the machinery.

On the settlement path, the **pending `AIInference` is the queue entry**. Nothing is written to
`settlements`, the payment's `counterparty_type` is left as normalization set it, and the
payment stays at `normalized`. All of that happens at acceptance instead.

`ai_inferences.resulting_record_id` is written **twice** on the expense path: once when the
DERIVED expense is created, so the proposal and the row it produced are findable from each
other, and once at the decision, which is when that row becomes authoritative. The column's
documented meaning ("a pointer to the authoritative record it produced") is satisfied at the
moment it matters, and the earlier write is what makes the decision able to find its expense at
all without a new column.

## Consequences

**The asymmetry between the two paths is real and visible in the return type.**
`ProposedClassification.expenseId` is `null` for a settlement proposal. That is not a gap to be
filled later — it is the difference between a record that has a pre-approval state and one that
does not.

**A rejected classification leaves its DERIVED expense unapproved, and nothing deletes it.**
`decideInference(reject)` marks the inference `rejected` and stops. The expense stays at
`classified`/`review_required` forever, referenced by the rejected proposal that produced it.
Nothing in this ledger deletes financial records, and `Expense` has no "dismissed" state to move
it to. **Deciding what the review queue does with such a row is phase 9's**, and it is recorded
here as a known, deliberate loose end rather than discovered later as a leak. Note the blast
radius is small: an unapproved expense is invisible to every total the system computes —
`domain.computeUnexplained` counts only `approved` and later (`invariants.md` #20), and `Balance`
reads allocations, which an unapproved expense has none of.

**A payment that already carries a classification inference is not classified again.** That is
what makes a re-run a no-op (the ADR-0021 pattern) and what stops a second expense appearing
beside the first. It also means `superseded` — which `lifecycle.md` defines for exactly the
re-run case — is unused in this phase; re-classification is a review action and arrives with the
queue.

## Alternatives considered

- **Write nothing until `decideInference`, for both kinds.** Attractive for symmetry, and it
  eliminates the orphan above. Rejected because it contradicts `data-flow.md` step 5's
  `db.updateExpense (APPROVED)`, and because it makes `REVIEW_REQUIRED` — an `Expense` state the
  lifecycle document draws and the roadmap's phase 9 promises to surface — permanently
  unreachable. A state no code can produce is a state the model does not really have.
- **Write the `Settlement` at classification time too, in some pre-approved form.** Rejected:
  there is no such form. `Settlement` has no `state` column and no lifecycle beyond existing, so
  "a settlement that is not yet approved" would have to be invented — a schema change, to make
  the AI path symmetrical with itself, against ADR-0007's deliberate design.
- **Insert the expense straight into its final state.** Rejected as above: it is shorter and it
  silently skips `proposed` and (for a reviewed proposal) `classified`, which is the one thing
  the lifecycle exists to prevent. Three audit events per classified expense is the cost of that
  claim being true, and an audit reader gets a legible story instead of a fait accompli.
- **Delete or archive the DERIVED expense when its inference is rejected.** Rejected for this
  phase: `expenses` has no `archived_at`, there is no delete path in the repository by design,
  and adding either to serve a review flow that does not exist yet would be phase 9's decision
  taken early, with less information.
