# 0071. A possible duplicate stays asked while either copy can still count

**Status:** Accepted — **ratified by the owner on 6 October 2026, as built** (implemented 5 October
2026, when it was recorded as awaiting ratification; that history is kept). The alternatives below —
keep only the queue change, or only the refusal — were considered and **not chosen**. It changes no
matching rule and no accepted decision's reasoning, but it narrows one literal sentence of
ADR-0031 (see [Before and after](#before-and-after-the-exact-semantics)), so it is written down
for review rather than assumed (it has since been ratified). Every item below is reversible
independently.

**Amends:** [ADR-0031](0031-possible-duplicate-review.md) — one sentence of the lifecycle ("a
`linked` payment is never a candidate"). **Leaves unchanged:**
[ADR-0069](0069-two-lines-of-one-statement-are-two-movements.md) and
[ADR-0070](0070-one-movement-recorded-twice-is-one-day-one-amount-one-name.md) — what makes two
payments a possible duplicate — and ADR-0019's deterministic path.

## Context

On 5 October 2026 a readiness run on a synthetic ledger counted one ₹3,000 dinner as ₹6,000.
Both captures of the dinner were asked about as a possible duplicate. A person who approved the
first copy's category saw the question disappear; approving the second copy then succeeded. The
same happened with the website's "Decide later", and a direct API call needs no screen at all.

Two things were true at once, and the first report of this defect conflated them:

1. **The matching policy is the owner's and is settled** (ADR-0070): the same calendar day, the
   same amount, the same or a sufficiently similar name or kind, the reference rules, nothing
   merged. Nothing here touches it.
2. **The lifecycle of the question is a separate matter.** ADR-0031 says _"A `linked` payment is
   never a candidate: the lifecycle draws no `linked → ignored` edge, because discarding an
   explained payment would orphan the expense it funds."_ The stated **reason** is about which copy
   may be **discarded**. The **sentence** also removes the counted copy from the pair altogether,
   which is what lets the other copy be counted unasked.

ADR-0070 step 3 already says a pair is asked about while both copies are live. It is silent about
a pair with one counted copy, because the importer never produces one: it is produced by
approving one copy of a pair that was asked about.

A second gap sat underneath. A payment is counted by more than a decision: a hand-entered funding
link, or a settlement, counts it too, **without** moving it to `linked`. So "linked" never meant
"counted", and a confirmed duplicate (`ignored`) could still be explained by any of them.

## Decision

Four changes, none of which alters what the matching rule asks.

1. **A counted payment stays in the pair — as the survivor, never as the copy discarded.**
   `listPossibleDuplicateCandidates` keeps `linked` payments; the review queue pairs them, offers
   the pair while at least one copy does not count, orients it so the **uncounted** copy is the
   one a reviewer can discard, and does not offer a pair of two counted copies (nothing in it
   could be answered "yes"). _Counted_ means `linked`, **or** a funding link to a non-rejected
   expense, **or** a settlement (`listClaimedPaymentIds`).
2. **The uncounted copy cannot be counted until the question is answered.** One check,
   `assertPaymentMayBeCounted`, runs inside the transaction of every act that counts a payment —
   accepting or modifying a classification (expense or settlement), recording a settlement, and
   creating or adding a funding link. It refuses (`PRECONDITION_FAILED`, reason
   `unresolved_possible_duplicate`) while a counted copy that the duplicate rule pairs with it
   stands undismissed. **Either answer lifts it:** confirming discards the uncounted copy;
   dismissing records two real movements, after which both count.
3. **A payment already discarded as a duplicate cannot be counted at all** (reason
   `discarded_duplicate`), whichever path tries.
4. **Confirming never discards a copy that counts**, however it counts. It already refused a
   `linked` copy; it now refuses one a hand-entered link or a settlement counts.

**Concurrency.** Every act that counts a payment first takes one transaction-scoped PostgreSQL
advisory lock for the payment's _class_ — its direction and amount, which is all
`isPossibleDuplicate` can pair — and takes it **before it reads or locks anything else**
(`db.lockPaymentClasses`). A transaction that counts several payments (a funded expense) names
them all in one call at its start; the distinct classes are sorted by key and locked one at a time
in that order. Two acts on one class therefore run one after the other, and the second reads what
the first committed.

_What the first version got wrong._ It locked the payment being decided (`SELECT … FOR UPDATE`),
_then_ discovered its twins and locked those. Two approvals of the two halves of one pair each held
their own row and asked for the other's, so the order was only sorted _within_ the second
statement, never across the two. PostgreSQL aborted one with `40P01 deadlock_detected` instead of
the intended `PRECONDITION_FAILED`. The earlier test (two promises started together) rarely
interleaved that way, so it did not show it; the replacement test holds each transaction at its
first lock with a gate and starts the other, which is deterministic (see the readiness report). No
retry was added: a retry would hide the abort, not remove it.

_What is guaranteed._ Any two guarded acts on one class are serialised, whatever order they list
their payments in. A hash collision between two classes only makes them wait for each other.
Counting acts are: accepting or modifying a classification, recording a settlement, creating a
funding link, adding one later, and confirming a duplicate. _What is not:_ an import inserting a
new payment mid-way is neither blocked nor serialised — it counts nothing, and the act that later
counts it takes the lock; dismissing a pair is an audit record, not a count, so it takes no lock
(a decision racing it is either refused, and can be repeated, or lets the second copy count after
the dismissal committed — both are correct outcomes); and the lock is advisory, so a writer
that bypasses `assertPaymentMayBeCounted` would bypass it — every such path in `src` was audited
and goes through it (the bare `approveExpense` transition has no route and is unguarded, as noted
below). PGlite has one connection and serialises everything, so only a real server shows any of
this: `tests/integration/duplicate-lock-order.test.ts` skips there.

## Before and after: the exact semantics

| Situation                                                           | Before                                             | After                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Two uncounted copies, same day/amount/name                          | Asked (ADR-0070)                                   | Asked — **unchanged**                                                           |
| One copy approved (`linked`), the other uncounted                   | **Not asked.** The other could be approved unasked | **Asked**, counted copy as survivor; the other cannot be counted until answered |
| Two counted copies (legacy data)                                    | Not asked                                          | Not asked (nothing to discard) — unchanged                                      |
| Copy counted by a hand-entered link (state still `normalized`)      | Treated as live; confirm could discard it          | Counted: survivor only; confirm refuses to discard it                           |
| Confirm duplicate on the uncounted copy                             | Allowed                                            | Allowed — **unchanged**                                                         |
| Dismiss ("two real movements")                                      | Allowed; both count                                | Allowed; both count — **unchanged**                                             |
| Accept/modify/settle/link a copy already `ignored`                  | Accepted silently (payment stayed `ignored`)       | Refused                                                                         |
| Two different statement lines, or two different UTRs, or two payees | Not a pair (ADR-0069/0070)                         | Not a pair — **never blocked**                                                  |

Rules cited: `invariants.md` #10 (one movement must not be counted twice; never "silently kept as
two"); ADR-0031 (the one sentence narrowed, and its rationale preserved: no `linked → ignored`
edge is added, a counted payment is never discarded); ADR-0070 step 3 and its Rollout; ADR-0069
(rows of one statement) and ADR-0070 step 7 (two numbers of one kind) for what stays unblocked;
`lifecycle.md` (the payment lifecycle gains no edge).

## Consequences

- **Nothing is merged, deleted or edited.** A refusal changes no row; the answer is a person's,
  recorded as before. No approved amount, no evidence and no stored decision is touched, and no
  migration is needed — the queue and the check are derived on read.
- **A second legitimate payment is never blocked by lookalikeness the rule does not find.** The
  guard asks the rule; it adds no resemblance of its own. Two coffees on one statement with two
  references are two movements and both approve.
- **An unanswered pair stays visible** and the Needs-attention page asks it before either copy's
  category question, so the ordinary path never reaches the refusal.
- **`approveExpense` (the bare state transition, with no HTTP route) is not guarded.** An expense
  is counted when its payment is linked, which the check covers; a proposed expense that already
  carries a funding link marks its payment as spoken for.
- **Legacy double-counts are not repaired.** If two copies already count, no question is asked
  and nothing is changed; the Spending screen's advisory list is where such a pair is seen.

## Alternatives, and what each costs

- **Revert the queue change, keep only the refusal.** The refusal would then name a question that
  is not in the queue and offer no way to dismiss it, so a genuine second payment of the same
  amount would be blocked for good. Rejected: it fails the rule that a legitimate pair stays
  approvable.
- **Revert the refusal, keep only the queue change.** The pair stays visible, but a person (or a
  stale dialog, or a direct call) can still count both copies. This is the narrowest change and
  leaves the demonstrated bypass open; it is what to choose if the owner wants no refusal at all.
- **Auto-discard the second copy.** Rejected, as ADR-0031 rejected it: invariant #10 forbids
  silently merging.
- **Allow a `linked → ignored` edge** so a counted copy could be the one discarded. Rejected: it
  orphans the expense or settlement the payment explains (ADR-0031's own reason).

## What was deliberately not done

Reading `approveExpense` as a counting act; repairing already-doubled data; changing the
possible-duplicate wording of the anomaly list beyond leaving out confirmed duplicates (its
"within 24 hours" is that observation's own window, ADR-0063, not the duplicate rule's).
