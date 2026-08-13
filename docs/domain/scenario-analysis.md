# Scenario Analysis — Stress-Testing the Domain Model

Twenty-five realistic scenarios, worked through against the model in `domain-model.md`, per
the brief's instruction to actively attack the design before considering it complete. For each:
what happens, and whether it required a model change. A "Findings summary" closes the doc with
what actually changed as a result of this exercise (so the effect of this exercise is visible,
not just the exercise itself).

---

**1. Blinkit order containing personal and shared items.**
One `Payment` (₹1,240 to Blinkit). One `Receipt` with `ReceiptItem`s: milk, chicken, shampoo.
Two `Expense`s are created: "flat groceries" (milk, ₹80) and "personal" (chicken + shampoo,
₹1,160), each linked back to the same `Payment` via `PaymentExpenseLink` with its own `amount`,
summing to ₹1,240. Handled cleanly — this is exactly the case `PaymentExpenseLink` exists for.

**2. Restaurant bill for three people.**
One `Payment`, one `Expense` (`relationship_type = shared`), one `Allocation`
(`method = equal`), three `AllocationLine`s. Clean.

**3. Restaurant bill with unequal consumption.**
Same as #2 but `method = exact` (or `item_based` if itemized), with different `amount` per
line. Clean — this is why `exact` and `item_based` exist as distinct methods from `equal`.

**4. Restaurant bill with no receipt.**
No `Receipt`/`ReceiptItem` records at all. `Expense` is created directly from the `Payment` (or
manually, evidence-first), `Allocation` uses `method = exact` or `equal` based on the user's
manual input. Confirms `Receipt` must be optional on `Expense` — already modeled that way.

**5. Local shop purchase for flat.**
One `Payment`, one `Expense` (`relationship_type = household_shared_flat`), `Allocation` with
one line to the `Group` "Flat" for the full amount (or split among flat members individually —
both are valid depending on whether "the flat" is treated as its own beneficiary or dissolved
into its members immediately; the model supports either since `Group` is a valid
`beneficiary_type`). No change needed.

**6. Electronics purchase partly for user and partly for friend.**
One `Payment`, one `Expense`, `Allocation` with `method = exact`, two `AllocationLine`s (user,
friend). Straightforward — flagged initially as possibly needing item-level split, but a whole-
expense `exact` split is sufficient when there's no meaningful "item" boundary (one shared
gadget), confirming `item_based` should remain optional, not mandatory whenever multiple
beneficiaries exist.

**7. Payment made entirely on behalf of friend.**
`Expense.relationship_type = paid_on_behalf`, `Allocation` with one `AllocationLine` at 100% to
the friend, 0% to the user. This is why `paid_on_behalf` is distinct from `shared`: a shared
expense implies the user also benefits; `paid_on_behalf` implies they don't, they're only
fronting the money. The model already distinguishes these — confirms the enum was designed
correctly, not merely two labels for the same thing.

**8. Gift.**
`Expense.relationship_type = gift`. Deliberately **no settlement follows** — a gift is not
expected to be paid back. This surfaced a real gap: nothing in the original allocation model
stopped a `gift` expense from being incorrectly included in `Balance` calculations. **Resolved**
by making `Balance` computation explicitly exclude `relationship_type = gift` (and
`relationship_type = personal`) — only `shared`, `paid_on_behalf`, and
`household_shared_flat` allocations to non-self beneficiaries contribute to a balance. Recorded
as invariant-adjacent guidance in `domain-model.md`'s `Settlement` section.

**9. Taxi shared among three people.**
Same shape as #2. Clean.

**10. Trip with multiple transactions.**
Multiple `Expense`s (flights already paid personally, hotel shared, meals shared, local
transport shared) grouped under one `ExpenseOccasion` ("Goa trip"). Confirms `Occasion` needs
to group `Expense`s spanning days, not just one evening — no change needed, `occurred_on` was
already a single date though; **adjusted** `ExpenseOccasion` conceptually to represent a date
_or range_ — noted for schema design (`database-design.md`) to use a start/end rather than a
single `occurred_on` where trips are involved.

**11. Refund.**
A `Payment` with `direction = credit` from the same merchant shortly after the original debit.
Modeled as a new `Payment`, linked to the _original_ `Expense` (not a new one) via a
`refund_of_expense_id`-style relationship, reducing that expense's effective amount for
allocation/settlement purposes while leaving the original `Payment`/`Expense` records
untouched (invariant #4, #8). **Gap found:** the initial model had no explicit link from a
refund `Payment` back to the `Expense` it refunds. **Resolved**: `Expense` needs a nullable
`refund_of_expense_id` self-reference (documented as a follow-up for `database-design.md`);
the refunding `Payment` still goes through normal `PaymentExpenseLink`, just to an `Expense`
whose `relationship_type` marks it as a refund.

**12. Partial refund.**
Same as #11, but the refund `Payment` amount is less than the original `Expense.amount`. The
original `Allocation` must be re-derived (not mutated in place, per invariant #6) to reflect
the reduced net amount, with the reduction itself allocated (does the refund benefit everyone
proportionally, or just the person who returned the item?). **Confirmed this needs a decision,
not a default** — the model requires a new `Allocation` version with an explicit method, same
as any other allocation change; no silent proportional assumption.

**13. Duplicate transaction.**
Two `Payment`s, same account/amount/timestamp, from two overlapping imports (e.g. a bank CSV
and a UPI export both capturing the same charge). Deterministic dedup (same account + amount +
timestamp + reference number) marks the second `IGNORED` with `reason = duplicate_of:
<payment_id>` (invariant #10). Where the reference number doesn't match cleanly, it's flagged
as a _possible_ duplicate `AIInference` for human confirmation rather than auto-merged. No
model change — this is what `Payment.state = IGNORED` and `ImportBatch` lineage exist for.

**14. Bank transfer that is not an expense.**
`Payment.counterparty_type = internal_account`, never linked to an `Expense` (invariant #7).
Clean.

**15. Splitwise settlement payment.**
A UPI transfer to a friend, recorded in Splitwise as "you paid ₹1,000 to settle up." Modeled as
a `Payment` with `relationship_type = settlement` (via a minimal `Expense` shell, so it still
flows through the same `Allocation`/`AuditEvent` machinery) or a direct `is_settlement` flag on
`Payment` if no `Expense` framing is needed at all. **This scenario is what forced the decision
documented in `domain-model.md`'s `Settlement` section** — an early draft had a dedicated
`SettlementTransaction` entity duplicating `Payment`; removed in favor of classifying an
existing `Payment`/`Expense` as a settlement instead.

**16. Utility bill.**
`Expense.relationship_type = household_shared_flat`, `Allocation` split among flat members
(often equal, sometimes by usage). No change — same shape as #5.

**17. Cash payment.**
`Payment.channel = cash`, `account_id` referencing a "Cash" `Account`, no `ImportBatch` file
reference (manual entry), `Evidence.type = manual_note` if any explanation was recorded.
Confirms `ImportBatch.file_reference` and `Evidence.storage_ref` must both be nullable — they
already were.

**18. Transaction with unknown merchant.**
`Payment.counterparty_type = unknown`, no `Merchant` resolved. The `Expense` can still be
created and classified (e.g. by amount pattern or manual entry) without merchant resolution
ever completing. Confirms `Merchant` resolution must not be a hard prerequisite for
classification — it wasn't modeled as one, but this scenario made that explicit rather than
assumed.

**19. Transaction with no receipt.**
Same as #4, generalized beyond restaurants. No change.

**20. Receipt amount differing from bank amount.**
`Receipt.total` (e.g. ₹2,850, including a tip added at the table) vs. linked `Payment.amount`
(₹2,850 charged, or possibly ₹2,700 if the receipt was pre-tip). The model does not auto-
reconcile these — the difference is surfaced (invariant #20's spirit applied at the expense
level, not just system-wide) and the user resolves it, typically by adjusting `Expense.amount`
to the payment (source of truth for money actually moved) while keeping the `Receipt` as
evidence of the itemization. Confirms `Receipt.total` and `Payment.amount` must remain
independently stored, never one derived by overwriting the other.

**21. One payment containing multiple conceptual expenses.**
Same as #1, generalized. No change.

**22. Multiple payments belonging to one occasion.**
Same as #10 at smaller scale (dinner + dessert + cab). No change — this is the scenario
`ExpenseOccasion` was designed for.

**23. A person changing their relationship to a group.**
A flatmate moves out mid-month; a new flatmate moves in. `GroupMembership.left_at` /
`joined_at` capture this. Expenses from before the move retain their original
`AllocationLine`s (which reference `Person`/`Group` directly, not `GroupMembership` — see
`domain-model.md`), so a departed flatmate's historical share is untouched. New expenses use
current membership as a _default suggestion_ only. **This is the scenario that justified**
`GroupMembership` being a distinct, time-ranged entity rather than a plain join table — an
earlier draft had a plain many-to-many, which would have made "who was in the flat when this
was allocated" unanswerable after a membership change.

**24. An expense initially attributed incorrectly, later corrected.**
An `Expense` approved as `personal`, later recognized as actually `shared` with a flatmate.
Per invariant #6, this is not an in-place edit: a new `Allocation` (and, if `relationship_type`
itself changes, a new state entry) is created, the old one is superseded, and an `AuditEvent`
records old value, new value, reason, and actor. Confirms the `Allocation` versioning design
(rather than mutable `AllocationLine`s) is necessary, not just nice-to-have — a straight
`UPDATE` would have destroyed the fact that the expense was ever believed personal.

**25. A Splitwise expense that differs from the application's ledger.**
A `SplitwiseExpense.their_snapshot` (fetched on reconciliation) no longer matches
`our_snapshot` — e.g. someone edited the Splitwise expense directly in the Splitwise app.
`sync_status` moves to `drifted`, surfaced in the next `ReconciliationRun.discrepancies`
(invariant #18). The model does not attempt automatic resolution in either direction; this is
by design, since either side could be the one that's wrong, and guessing risks silently
corrupting the canonical ledger.

---

## Findings summary — what this exercise actually changed

1. **`Balance` calculation must exclude `gift` and `personal` expenses explicitly** (from #8) —
   otherwise a gift would incorrectly generate a debt.
2. **`Expense` needs a `refund_of_expense_id` self-reference** (from #11, #12) — the original
   model linked refunds only implicitly through payment timing, which isn't reliable enough to
   build settlement math on.
3. **`ExpenseOccasion` should support a date range, not a single date** (from #10) — trips span
   multiple days.
4. **`GroupMembership` must be a time-ranged entity, not a plain join table** (from #23) —
   required for historical allocations to stay meaningful after membership changes.
5. **Confirmed (no change needed, but explicitly load-bearing):** `PaymentExpenseLink`'s
   many-to-many shape (#1, #21), `Receipt`/`Payment` amount independence (#20), `Allocation`
   versioning instead of in-place mutation (#24), and the decision not to give `Settlement` its
   own money-movement table (#15).

Items 1–3 are carried forward as explicit requirements into
`docs/architecture/database-design.md`; item 4 was already reflected in `domain-model.md`
before this document was finalized (the two were developed together, iteratively).
