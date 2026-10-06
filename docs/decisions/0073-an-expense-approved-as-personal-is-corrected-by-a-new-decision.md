# 0073. An expense approved as personal is corrected by a new decision, with its split

**Status:** Accepted. Built on 6 October 2026 on the owner's instruction to build the correction
that the readiness round had deferred ("Implement the deferred correction of already-approved
Personal expense kind through explicit owner-driven UI/API action"). The design follows the
proposal on file in `docs/testing/readiness-verification-2026-10-05.md` ("Owner decisions", item 1).
That instruction approved building and testing the capability. It is not a decision about how any
real expense should be corrected, and nothing was corrected on the real ledger.

## Context

`invariants.md` #6 and `domain-model.md` §24 have always said that an approved expense's
`relationship_type` "may still change via a new, audited decision … never a silent overwrite",
while `amount` never changes at all. Nothing implemented the first half. An expense approved as
`personal` that was really a shared dinner could therefore never produce the debt it should. The
only way out was to leave it wrong.

Since the 2026-10-05 readiness work, the kind is chosen _before_ approval ("Who was this for?").
That choice still goes wrong, and many expenses were approved as `personal` before the choice
existed.

The proposal on file named the question this ADR answers: is a correction an update of the column
with an audit event, or a successor expense in the pattern of ADR-0052?

## Decision

**It is a new decision about the same expense.** The relationship type is not source evidence:
it is an approved _interpretation_ that the domain documents as changeable by a visible, audited
decision. A successor expense would duplicate the evidence, the funding link and the amount just to
change who benefited. That is the double-counting risk ADR-0007 and invariant #10 exist to prevent.

`services.correctExpenseKind`, behind `POST /api/expenses/:expenseId/relationship`, runs as one
transaction:

1. **Lock the expense row** (`lockExpenseForAdjustment`, the same lock a refund takes). Two
   corrections of one expense, or a correction and a refund, run one after the other.
2. **Check the rule** (`domain.checkKindCorrection`). The checks run in this order:
   - The request names the kind the person saw (`expectedRelationshipType`). If the ledger holds
     anything else, nothing changes and the answer says what the ledger holds. A retry after a lost
     response, or a second tab, gets this answer.
   - The correction is only **from `personal`**.
   - The expense is only **`approved` or `allocated`**. A not-yet-approved expense is sent back to
     its question. A synced, reconciled or rejected expense is closed history.
   - The correction is only **to a kind that creates a debt**: `shared`, `paid_on_behalf` or
     `household_shared_flat`.
3. **Refuse** if a Splitwise row exists for the expense, or if any funding payment was discarded as
   a duplicate (`ignored`). Neither should occur for a personal expense; if one does, building a
   debt on top of it would be wrong.
4. **Change the kind** with a compare-and-set (`… where relationship_type = 'personal'`), and write
   an `AuditEvent` with the old and new kind, the state, the actor and the person's **required**
   reason.
5. **Save the split** through `approveAllocationWithin`. This is the same code, rules and audit
   events as `POST /allocation`. Any current allocation is superseded, never edited, and an
   `approved` expense moves to `allocated`.
6. **Refuse a split that names nobody but the payer** with a share. Such a split would say
   "shared" and create nothing.

Everything commits together or nothing does. A correction can therefore never leave an expense
shared with nobody named, which is the partial state the approve-then-split pair has to recover
from.

**What it never touches:** `amount`, which has no write path here. Also unchanged: the evidence,
the payment and its funding links, the category, the payer, and every settlement already recorded.

**It is not a counting act (ADR-0071).** The payment behind the expense already counts, and keeps
counting exactly once. Only who benefited from it changes. The correction therefore takes no
payment-class lock and cannot take part in that lock order.

**The preview** is the correction with the write removed: `ifCorrectedTo: { relationshipType }` on
`POST /api/expenses/:id/allocation/preview`. It is refused with the same message wherever the
correction would be. `ifApprovedAs` is unchanged and still refused for an approved expense. The
two cannot be combined.

**The read** `GET /api/expenses/:id` carries `kindCorrection.targets`, the kinds this expense could
be corrected to now (empty when none). A screen offers the action only where the ledger listed
it, and does not re-decide the rule. The list is advice; the correction checks again under the lock.

**The screen.** "Who shared this?" (`/expenses/:id/share`) shows "Recorded as just yours" with the
offered kinds whenever the read lists them, and the expense page links there. Choosing a kind
switches the preview to `ifCorrectedTo`. Saving opens a `DecisionDialog` that:

- states the consequence first ("from just yours to shared … together, or not at all");
- requires a reason;
- sends the kind it showed.

After a dropped connection or an "already changed" refusal, the dialog reads the expense and its
current split before sending anything again. It reports one of three outcomes:

- **Done** — the kind and split asked for are on record.
- **Not recorded** — the expense is still personal, and the person may try again; the ledger is
  re-read first.
- **Changed another way** — nothing from the dialog was applied, and the ledger's state is quoted.

## Not offered, deliberately

- **The reverse** (shared → personal), or any change between two debt-creating kinds. Unwinding a
  debt that may have been settled or synced changes other people's balances and needs a repair
  design of its own (compare ADR-0055). Changing who shares a shared expense is already possible:
  save a new split.
- **Gift.** A correction to `gift` creates no debt and is not what a correction is needed for.
- **Bulk or automatic correction.** Each correction is one person's decision about one expense,
  with a reason. Nothing proposes one, and nothing in the review queue resolves one.

## Consequences

- The deferred item in the 2026-10-05 readiness record is built. The design proposal there is
  superseded by this ADR.
- Spending figures move when a correction is made: the user's own share falls by what others now
  owe. That is the purpose of the correction, and it is recorded where the figures come from.
- An expense corrected this way is an ordinary allocated, debt-creating expense. It can be synced
  to Splitwise, refunded and settled through the existing paths.
- Tests: `src/domain/kind-correction.test.ts` covers the rule exhaustively over every kind × state.
  `tests/integration/expense-kind-correction.test.ts` covers, over HTTP on synthetic data:
  - the preview with nothing written;
  - the commit with the expected debt and unchanged amount, funding, category and payer;
  - the audit event with its reason;
  - a lost-response repeat refused with nothing written;
  - two racing corrections with exactly one winner;
  - supersession of an existing split, and the net amount after a refund;
  - the atomic rollback when the split is refused, the payer-only refusal, the input refusals, a
    not-yet-approved expense, and a discarded funding payment.

  `web/src/components/people/share-expense-correction.test.tsx` covers the screen and the three
  recovery outcomes.
