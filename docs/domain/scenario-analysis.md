# Scenario Analysis — Stress-Testing the Domain Model

Originally twenty-five realistic scenarios, worked through against the model in
`domain-model.md`, per the brief's instruction to actively attack the design before considering
it complete. **Extended in a 2026-08 revision** (Part 2, scenarios 26–35) after a
pre-implementation architecture review found the original set never exercised the reverse-payer
direction, the new `Settlement`/`ExpenseAdjustment` entities, or group-allocation expansion —
see `domain-model.md`'s revision note and ADRs 0006–0011. A stress-test coverage matrix at the
end maps every scenario (old and new) against payer / payment / expense / beneficiaries /
allocation / obligation / settlement / spend classification / Splitwise / reconciliation, per the
review's explicit request.

For each scenario: what happens, and whether it required a model change. A "Findings summary"
closes each part with what actually changed as a result of the exercise.

---

## Part 1 — Original 25 scenarios

**1. Blinkit order containing personal and shared items.**
One `Payment` (₹1,240 to Blinkit). One `Receipt` with `ReceiptItem`s: milk, chicken, shampoo.
Two `Expense`s are created: "flat groceries" (milk, ₹80) and "personal" (chicken + shampoo,
₹1,160), each linked back to the same `Payment` via `PaymentExpenseLink` with its own `amount`,
summing to ₹1,240. Both expenses have `paid_by_person_id = Dev`. Handled cleanly — this is
exactly the case `PaymentExpenseLink` exists for.

**2. Restaurant bill for three people.**
One `Payment`, one `Expense` (`relationship_type = shared`, `paid_by_person_id = Dev`), one
`Allocation` (`method = equal`), three `AllocationLine`s. Clean.

**3. Restaurant bill with unequal consumption.**
Same as #2 but `method = exact` (or `item_based` if itemized), with different `amount` per
line. Clean — this is why `exact` and `item_based` exist as distinct methods from `equal`.

**4. Restaurant bill with no receipt.**
No `Receipt`/`ReceiptItem` records at all. `Expense` is created directly from the `Payment` (or
manually, evidence-first), `Allocation` uses `method = exact` or `equal` based on the user's
manual input. Confirms `Receipt` must be optional on `Expense` — already modeled that way.

**5. Local shop purchase for flat.**
One `Payment`, one `Expense` (`relationship_type = household_shared_flat`,
`paid_by_person_id = Dev`), `Allocation` with one line to the `Group` "Flat" for the full
amount (or split among flat members individually — both are valid depending on whether "the
flat" is treated as its own beneficiary or dissolved into its members immediately; the model
supports either since `Group` is a valid `beneficiary_type`, and a group line is always expanded
into individual obligations via `AllocationLineGroupExpansion` regardless — ADR-0009). No change
needed.

**6. Electronics purchase partly for user and partly for friend.**
One `Payment`, one `Expense`, `Allocation` with `method = exact`, two `AllocationLine`s (user,
friend). Straightforward — flagged initially as possibly needing item-level split, but a whole-
expense `exact` split is sufficient when there's no meaningful "item" boundary (one shared
gadget), confirming `item_based` should remain optional, not mandatory whenever multiple
beneficiaries exist.

**7. Payment made entirely on behalf of friend.**
`Expense.relationship_type = paid_on_behalf`, `paid_by_person_id = Dev`, `Allocation` with one
`AllocationLine` at 100% to the friend, 0% to Dev. This is why `paid_on_behalf` is distinct from
`shared`: a shared expense implies the payer also benefits; `paid_on_behalf` implies they don't,
they're only fronting the money. The model already distinguishes these — confirms the enum was
designed correctly, not merely two labels for the same thing.

**8. Gift.**
`Expense.relationship_type = gift`, `paid_by_person_id = Dev`. Deliberately **no settlement
follows** — a gift is not expected to be paid back. This surfaced a real gap: nothing in the
original allocation model stopped a `gift` expense from being incorrectly included in `Balance`
calculations, or (found again in the 2026-08 revision) from incorrectly reaching
`READY_TO_SYNC`/Splitwise sync just because it has a non-payer beneficiary line. **Resolved**
twice: first by excluding `gift` (and `personal`) from `Balance`, and — since `Obligation` is now
generalized and defined only over a fixed debt-creating `relationship_type` set
(`{shared, paid_on_behalf, household_shared_flat}`) — `gift` was never eligible to create an
obligation in the first place, which is a stronger guarantee than an after-the-fact exclusion
list. Second, `lifecycle.md`'s `READY_TO_SYNC` gate now checks `relationship_type` against that
same set, not "has a non-self beneficiary" — see `lifecycle.md`'s revision note and the Part 2
findings below.

**9. Taxi shared among three people.**
Same shape as #2. Clean.

**10. Trip with multiple transactions.**
Multiple `Expense`s (flights already paid personally, hotel shared, meals shared, local
transport shared) grouped under one `ExpenseOccasion` ("Goa trip"). Confirms `Occasion` needs
to group `Expense`s spanning days, not just one evening — no change needed, `occurred_on` was
already a single date though; **adjusted** `ExpenseOccasion` conceptually to represent a date
_or range_ — noted for schema design (`database-design.md`) to use a start/end rather than a
single `occurred_on` where trips are involved.

**11. Refund.** *(revised 2026-08 — see ADR-0008)*
A `Payment` with `direction = credit` from the same merchant shortly after the original debit.
Modeled as an `ExpenseAdjustment` (`kind = merchant_refund`) referencing the **original**
`Expense` — not a second `Expense`, which is what the original design did via
`refund_of_expense_id` and which left it ambiguous whether invariant #11 (allocation sums equal
expense amount) was actually satisfied. The original `Payment`/`Expense.amount` are left
completely untouched (invariants #4, #6); the refund `Payment` is linked via
`ExpenseAdjustment.adjustment_payment_id`; `domain.netAmount(expense)` becomes `expense.amount −
refund.amount`; a new `Allocation` version is created on the original expense, summing to the
new net amount. See #12 for the partial case, where the reduction actually has to be
distributed by an explicit decision.

**12. Partial refund.** *(revised 2026-08 — see ADR-0008)*
Same as #11, but the refund `ExpenseAdjustment.amount` is less than the original
`Expense.amount`. The current `Allocation` must be superseded (per invariant #6, a new version,
never mutated in place) to sum to the new `netAmount`, with the reduction itself allocated
across beneficiaries by an **explicit decision** (does the refund benefit everyone
proportionally, or just the person who returned the item?) — **confirmed this needs a decision,
not a default**, same conclusion as the original analysis, now expressed against the corrected
mechanism (`ExpenseAdjustment` + `Allocation` supersession) instead of a second `Expense`.

**13. Duplicate transaction.** *(revised 2026-08 — see ADR-0010; amended in the
implementation-readiness pass — see below)*
Two `Payment`s, same amount/timestamp, from two overlapping imports (e.g. a bank CSV and a UPI
export both capturing the same charge) — note these two payments land under **different**
`Account` rows (`account_hdfc_savings` vs. `account_hdfc_upi`), since this schema models "bank"
and "UPI" as distinct `Account` types even for the same underlying institution. **Now that
`payments.external_reference` and `reference_type` exist**, deterministic dedup checks `amount` +
matching non-null `external_reference` + timestamps within a small window (invariant #10,
revised; **`account_id` was removed from the match criteria in the implementation-readiness pass
— building this exact fixture against the original account-scoped rule showed it could never
fire for the cross-channel case this scenario describes, since the two captures are on different
`Account` rows by construction**) and marks the second `IGNORED` with `reason =
duplicate_of: <payment_id>`. Where the reference number doesn't match cleanly (or is absent on
one/both sides), it's flagged as a _possible_ duplicate `AIInference` for human confirmation
rather than auto-merged. `ImportBatch` lineage still identifies where each row came from.
`fixtures/duplicate-transaction.json` already anticipated this field informally (as `reference`)
before the schema formally supported it; the fixture is updated to use the real field names.

**14. Bank transfer that is not an expense.**
`Payment.counterparty_type = internal_account`, never linked to an `Expense` (invariant #7).
Clean. Confirmed (2026-08) that this payment is not required to ever reach `LINKED` or
`IGNORED` — staying at `NORMALIZED` is valid, since exclusion is driven by `counterparty_type`
directly (`lifecycle.md`).

**15. Splitwise settlement payment.** *(revised 2026-08 — see ADR-0007)*
A UPI transfer to a friend, recorded in Splitwise as "you paid ₹1,000 to settle up." Modeled as
a `Settlement` (its own entity, not an `Expense` or `Expense`-shell) referencing the `Payment`
and `counterparty_person_id = Friend A`. **This scenario is what originally forced the
Expense-shell decision in the pre-revision design, and is also what exposed that decision as
wrong**: requiring a trivial `Expense`+`Allocation` for every settlement (to satisfy invariant
#2's unscoped wording) created a live double-counting risk against `Balance`, and the reference
fixture never actually carried the `Allocation` the invariant demanded of it. `Settlement` is
now scoped out of invariant #2 entirely (`invariants.md` #2, #9a) — see Part 2 §28/§29 for full
worked examples in both directions.

**16. Utility bill.**
`Expense.relationship_type = household_shared_flat`, `paid_by_person_id = Dev`, `Allocation`
split among flat members (often equal, sometimes by usage). No change — same shape as #5.

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
level, not just system-wide) and the user resolves it, typically by adjusting which figure
`Expense.amount` was set to at creation time (before it becomes immutable at `APPROVED` — after
approval, a discovered discrepancy would itself need to become an `ExpenseAdjustment`, not a
mutation), while keeping the `Receipt` as evidence of the itemization. Confirms `Receipt.total`
and `Payment.amount` must remain independently stored, never one derived by overwriting the
other.

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
was allocated" unanswerable after a membership change. **See §33 (Part 2)** for the concrete
mechanism this same requirement forced one level down, at the `AllocationLine` → individual-
obligation boundary (`AllocationLineGroupExpansion`, ADR-0009) — this scenario is about
`GroupMembership` itself; §33 is about what actually reads it at allocation time.

**24. An expense initially attributed incorrectly, later corrected.**
An `Expense` approved as `personal`, later recognized as actually `shared` with a flatmate.
Per invariant #6, this is not an in-place edit: a new `Allocation` (and, if `relationship_type`
itself changes, a new state entry) is created, the old one is superseded, and an `AuditEvent`
records old value, new value, reason, and actor. Confirms the `Allocation` versioning design
(rather than mutable `AllocationLine`s) is necessary, not just nice-to-have — a straight
`UPDATE` would have destroyed the fact that the expense was ever believed personal. Note:
`Expense.amount` was never in question in this scenario (only `relationship_type`/`Allocation`
changed) — had the *amount* itself been wrong, the correction path since the 2026-08 revision
would be an `ExpenseAdjustment`, not a corrected `amount` field (`invariants.md` #6).

**25. A Splitwise expense that differs from the application's ledger.**
A `SplitwiseExpense.their_snapshot` (fetched on reconciliation) no longer matches
`our_snapshot` — e.g. someone edited the Splitwise expense directly in the Splitwise app.
`sync_status` moves to `drifted`, surfaced in the next `ReconciliationRun.discrepancies`
(invariant #18). The model does not attempt automatic resolution in either direction; this is
by design, since either side could be the one that's wrong, and guessing risks silently
corrupting the canonical ledger. Distinguished (2026-08) from the new `stale` status — see §30 —
which means *our* side changed, not Splitwise's.

---

## Findings summary — Part 1 (original)

1. **`Balance` calculation must exclude `gift` and `personal` expenses explicitly** (from #8) —
   otherwise a gift would incorrectly generate a debt. *(Superseded by a stronger guarantee in
   the 2026-08 revision — see Part 2 findings below: `Obligation` is now only ever created by a
   fixed debt-creating `relationship_type` set, so `gift`/`personal` were never eligible, not
   merely excluded afterward.)*
2. **`Expense` needs a `refund_of_expense_id` self-reference** (from #11, #12) — the original
   model linked refunds only implicitly through payment timing, which isn't reliable enough to
   build settlement math on. *(Superseded — see ADR-0008. Replaced by `ExpenseAdjustment`,
   which also resolved the arithmetic ambiguity `refund_of_expense_id` left open.)*
3. **`ExpenseOccasion` should support a date range, not a single date** (from #10) — trips span
   multiple days. *(Still current — implemented in `database-design.md`.)*
4. **`GroupMembership` must be a time-ranged entity, not a plain join table** (from #23) —
   required for historical allocations to stay meaningful after membership changes. *(Still
   current.)*
5. **Confirmed (no change needed, but explicitly load-bearing):** `PaymentExpenseLink`'s
   many-to-many shape (#1, #21), `Receipt`/`Payment` amount independence (#20), `Allocation`
   versioning instead of in-place mutation (#24). *(The decision not to give `Settlement` its
   own money-movement table, from #15, is still correct — see ADR-0007 — but the mechanism
   `Settlement` uses to avoid duplicating `Payment` changed; it's no longer routed through
   `Expense`.)*

---

## Part 2 — Post-review scenarios (2026-08)

Added after a pre-implementation architecture review found the original 25 never exercised the
reverse-payer direction (every scenario above is framed as "I paid"), never worked a concrete
`Settlement` example under the corrected model, and never showed the group-allocation expansion
mechanism concretely. See `domain-model.md`'s revision note and ADRs 0006–0011.

**26. Flatmate pays a flat expense; the user and another flatmate owe their shares.**
Flatmate A pays the electrician ₹3,000 from their own account — a `Payment` this ledger can
never observe, because it never moved through an `Account` the user owns (`Account` invariants).
Dev records the expense from `Evidence` alone (a message from Flatmate A: "paid the electrician,
₹3,000, split three ways"). `Expense`: `amount = 3000`, `relationship_type =
household_shared_flat`, **`paid_by_person_id = Flatmate A`**, no `PaymentExpenseLink` (none will
ever exist for this expense — that's expected, not a gap, per ADR-0006). `Allocation`
(`method = equal`): Dev ₹1,000, Flatmate A ₹1,000, Flatmate C ₹1,000. Per invariant #2a,
Flatmate A's own line creates no obligation (they benefited from their own money); Dev's and
Flatmate C's lines each create an obligation **owed to Flatmate A**, not to Dev. `Balance(Dev,
Flatmate A) = Dev owes Flatmate A ₹1,000`; `Balance(Flatmate C, Flatmate A) = Flatmate C owes
Flatmate A ₹1,000`. This is the scenario that originally justified ADR-0006 — the pre-revision
model had no field to represent "Flatmate A," only ever "Dev," as a payer.

**27. Friend pays a restaurant bill; the user owes their share.**
Simpler bilateral case, no `Group` involved. Friend A pays a ₹1,800 dinner bill; Dev and Friend
A split it equally. `Expense`: `amount = 1800`, `relationship_type = shared`,
`paid_by_person_id = Friend A`, evidence-only (a text message or the user's manual note), no
`PaymentExpenseLink`. `Allocation` (`equal`): Dev ₹900, Friend A ₹900. `Balance(Dev, Friend A) =
Dev owes Friend A ₹900`. Confirms the reverse-payer mechanism works without a `Group` in the
picture at all — it's a property of `Expense.paid_by_person_id` and `AllocationLine`, not of
groups.

**28. The user sends a settlement to a flatmate.**
Continuing §26: Dev pays Flatmate A ₹1,000 via UPI to clear the debt. `Payment`:
`account_id = Dev's UPI account`, `direction = debit`, `amount = 1000`,
`counterparty_type = person`, `counterparty_id = Flatmate A`. `Settlement`:
`payment_id` → the above, `counterparty_person_id = Flatmate A`, `amount = 1000`. No `Expense`,
no `Allocation` (invariant #9a). `Balance(Dev, Flatmate A)` moves from "Dev owes ₹1,000" to
"settled." `ledger_settlements_total` for the period includes this ₹1,000;
`ledger_explained_total` does **not** — it was never new spend. **No receipt or other Evidence
is attached to this Payment** — valid and unremarkable, exactly as for any other `Payment`
(`Evidence` has always been optional); "a settlement with no receipt" is not a distinct scenario
requiring special handling, just the ordinary case.

**29. A flatmate sends a settlement to the user.**
Reverse of §28. Suppose instead Dev had fronted the electrician bill (`paid_by_person_id = Dev`,
Flatmate A owes Dev ₹1,000), and Flatmate A now UPIs Dev ₹1,000 to clear it. `Payment`:
`account_id = Dev's UPI account`, **`direction = credit`**, `amount = 1000`,
`counterparty_type = person`, `counterparty_id = Flatmate A`. `Settlement`:
`payment_id` → the above, `counterparty_person_id = Flatmate A`, `amount = 1000`. Direction is
read from `payment.direction = credit`, not stored again on `Settlement`. `Balance(Flatmate A,
Dev)` moves to "settled." Confirms `Settlement` is symmetric with respect to who initiated the
transfer — only `Payment.direction` differs between §28 and §29, nothing else about the
`Settlement` record's shape does.

**30. A refund arrives after the original expense has already synced to Splitwise.**
Dev's ₹2,400 group-dinner expense (shared with Friend A, Friend B) already reached `SYNCED` —
a `SplitwiseExpense` exists. A week later, the restaurant refunds ₹300 for an item that was
never delivered. `ExpenseAdjustment` (`kind = merchant_refund`, `amount = 300`) is recorded
against the original expense; a new `Allocation` version is created, redistributing the ₹300
reduction (by explicit decision, per §12); `netAmount` drops from 2400 to 2100. Because the
expense had already synced, its existing `SplitwiseExpense.sync_status` moves to **`stale`**
(not `drifted` — Splitwise's own data didn't change, ours did) the moment the new `Allocation`
is distributed. A fresh sync proposal is owed and requires a new user confirmation before
Splitwise is updated — never auto-pushed. Confirms `stale` needed to be a distinct status from
`drifted` (ADR-0008): the two call for different next actions ("tell Splitwise about our
change" vs. "figure out who's right").

**31. A third-party reimbursement against a personal expense.**
Dev pays ₹1,200 for a client dinner while traveling for work (`relationship_type = personal`,
`paid_by_person_id = Dev`, ordinary `PaymentExpenseLink`). Two weeks later, Dev's employer
reimburses the full ₹1,200 via NEFT — a `Payment` with `counterparty_type = person` (or
`unknown`, if the employer isn't modeled as a `Person`), `direction = credit`.
`ExpenseAdjustment` (`kind = third_party_reimbursement`, `amount = 1200`,
`adjustment_payment_id` → the NEFT credit) is recorded against the original expense; `netAmount`
drops to 0; the `Allocation` is superseded to a single zero-amount line to Dev — **resolved this
revision** (`invariants.md` #12a, `domain-model.md`'s "Full refunds, resolved"): applying the
Largest Remainder Method with a total of 0 against the existing one-line beneficiary set
deterministically yields exactly one line, at `amount = 0`, never zero lines. No `Obligation`
and no `Settlement` are involved anywhere in this scenario — the employer was never a
beneficiary in the ledger's graph, so there was never a debt to discharge, only a cost to net
out. This is the worked example `reimbursement` never had before this revision (review finding
#10).

**32. An investment payment.**
Dev's monthly mutual fund SIP debits ₹5,000 via UPI autopay. `Payment`:
`counterparty_type = investment_instrument` (ADR-0011), never linked to an `Expense` (extended
invariant #7). Stays at `Payment.state = normalized` indefinitely — never needs to reach
`LINKED` or `IGNORED`, exclusion is driven by `counterparty_type` alone. Counted in
`ledger_investments_total` for the period, not in `ledger_total_outflow`'s spend interpretation
and not in `ledger_unexplained_total`. Confirms the category needed its own reconciliation
bucket rather than silently inflating "unexplained" (the state before ADR-0011).

**33. Group beneficiary allocation, expanded and later membership change.**
The Flat group's July electricity bill (₹2,100, `household_shared_flat`, `paid_by_person_id =
Dev`) is allocated with a single `group`-typed `AllocationLine`: `beneficiary_type = group`,
`beneficiary_id = Flat`, `amount = 2100`. At approval time, `services.approveAllocation()`
resolves `GroupMembership` rows active as of the expense's `occurred_at` (2026-07-10): Dev,
Flatmate A, Flatmate C (Flatmate B had already left; Flatmate C had already joined — matching
the membership history in `fixtures/people-and-groups.json`). It writes three
`AllocationLineGroupExpansion` rows, ₹700 each, summing to the line's ₹2,100. `domain.
computeBalance()` and any Splitwise sync for this expense read these three rows, never the raw
group line — Flatmate A and Flatmate C each individually owe Dev ₹700; "the Flat" owes no one
anything, because a `Group` is never itself a debtor. **In September, Flatmate C moves out and
Flatmate D moves in.** This has **zero effect** on the three `AllocationLineGroupExpansion` rows
already written for the July bill — they are never recomputed. A *new* August bill allocated
after the membership change would resolve against the membership active at *its* `occurred_at`
and correctly include Flatmate D instead. This is the concrete mechanism §23 required but never
specified (ADR-0009).

**34. An obligation between two people, neither of whom is the user.**
Continuing §26 (Flatmate A fronted the electrician bill; Dev and Flatmate C each owe Flatmate A
₹1,000): suppose Flatmate C pays Flatmate A back directly, by UPI, without that money ever
passing through an `Account` Dev owns. **This ledger cannot produce a `Settlement` row for it —
there is no `Payment` to anchor one to; the transaction never touched Dev's own accounts.** The
only ways this system can ever know the debt was cleared are (a) Flatmate A or Flatmate C tells
Dev, who records it as `Evidence` (a manual note) with no accompanying `Payment`, leaving
`Balance(Flatmate C, Flatmate A)` still showing the debt as open until a human explicitly
overrides it, or (b) Splitwise's own record shows the settlement (if all three use Splitwise) and
a `ReconciliationRun` surfaces the discrepancy between what this ledger still thinks is owed and
what Splitwise says. **This is a documented, permanent limitation, not a bug** — see
`domain-model.md`'s Obligation/Balance section, "a known, documented limitation," and ADR-0006.
The product's `Balance` view should visibly distinguish "confirmed by a `Settlement`-backed
`Payment`" from "believed settled per Splitwise/manual note, unconfirmed by our own ledger" —
noted here as a UI/Phase-13 requirement, not solved by the data model alone.

**35. A purely personal expense with a trivial allocation.**
Dev eats alone at a restaurant, ₹650, paid by personal UPI. `Expense`: `relationship_type =
personal`, `paid_by_person_id = Dev`, ordinary `PaymentExpenseLink`. `Allocation`
(`method = equal` or `exact` — either is correct for a single line): one `AllocationLine`,
`beneficiary_id = Dev`, `amount = 650`. Creates no obligation (invariant #2a — the sole
beneficiary is the payer) and never reaches `READY_TO_SYNC` (`relationship_type` isn't in the
debt-creating set). This is the base case invariant #2's "trivial 100%-to-payer allocation"
language refers to; included explicitly since, surprisingly, none of the original 25 scenarios
worked it standalone (§4/§19 are personal-adjacent but focus on missing-receipt handling, not the
trivial-allocation case itself).

---

## Findings summary — Part 2 (2026-08 revision)

1. **`Expense.paid_by_person_id` was required** (from §26, §27) — the model could not represent
   money someone other than the user fronted, despite the product's own purpose statement being
   explicitly bidirectional ("who ultimately owes whom"). See ADR-0006.
2. **`Obligation`/`Balance` needed to become a general pairwise function**, not "vs. the user" —
   required by the same scenarios, and confirmed necessary (not just theoretically cleaner) by
   §34, where an obligation exists between two people neither of whom is the user.
3. **`Settlement` needed to be its own entity, never an `Expense`** (from §28, §29, and the
   re-examination of §15) — see ADR-0007. Confirmed this closes the invariant #2 contradiction
   the original design had.
4. **`READY_TO_SYNC`'s gate needed to check `relationship_type`, not "has a non-self
   beneficiary"** (re-examination of §8) — a `gift` has a non-self beneficiary but must never
   sync as if it were a debt.
5. **Refunds and reimbursements needed to be one mechanism (`ExpenseAdjustment`), not a second
   `Expense`** (from §11, §12, §30, §31) — resolves both the invariant #11 ambiguity the original
   refund design left open and the previously-undefined `reimbursement` relationship_type.
6. **Group-beneficiary lines needed a per-member expansion, snapshotted at allocation time** (from
   §33, extending §23) — required for both real settlement and Splitwise sync, neither of which
   can treat a `Group` as a debtor.
7. **Deterministic dedup needed a real field to match on** (from the §13 re-examination) — added
   `external_reference`/`reference_type`, ADR-0010.
8. **Investments needed a real, modeled classification** (from §32) — previously mentioned in
   product docs with no schema backing at all; added per ADR-0011.
9. **A structural limitation is now explicit rather than silently absent**: third-party-to-
   third-party settlements (§34) can never be backed by a `Payment` this ledger observes. Not
   fixed — documented, with a UI-level mitigation noted for a later phase.

---

## Stress-test coverage matrix

Every item below was explicitly requested to be re-verified after the 2026-08 revision. "Scenario"
points to the worked example; the remaining columns are the specific facts that scenario
establishes, not a re-derivation.

| # | Requested scenario | Scenario(s) | Payer | Obligation created | Settlement mechanism | Spend classification | Splitwise |
|---|---|---|---|---|---|---|---|
| 1 | User pays restaurant bill for self | §35 | Dev | None (payer = sole beneficiary) | n/a | Counted in `ledger_explained_total` | Never syncs (`personal`) |
| 2 | User pays restaurant bill for self + 2 friends, equal | §2 | Dev | Both friends owe Dev | n/a until settled | Explained spend | Syncs (`shared`) |
| 3 | User pays restaurant bill, unequal shares | §3 | Dev | Per-line amounts owed to Dev | n/a until settled | Explained spend | Syncs |
| 4 | User pays entirely on friend's behalf | §7 | Dev | Friend owes Dev 100% | n/a until settled | Explained spend | Syncs (`paid_on_behalf`) |
| 5 | User pays flat expense | §5, §16 | Dev | Flatmates owe Dev (direct or via group expansion) | n/a until settled | Explained spend | Syncs |
| 6 | User pays flat expense, items for different people | §1 | Dev | Per-expense, per invariant #2a | n/a until settled | Explained spend (both expenses) | Syncs (non-personal expense only) |
| 7 | Flatmate pays flat expense, user owes share | §26 | Flatmate A | Dev, Flatmate C owe Flatmate A | Would be a `Settlement` on whichever side has a `Payment`; see §34 for the side that can't | Explained spend, no `PaymentExpenseLink` (evidence-only) | Syncs, debtor = Flatmate A's view |
| 8 | Friend pays restaurant, user owes share | §27 | Friend A | Dev owes Friend A | Same as above | Explained spend, evidence-only | Syncs |
| 9 | User sends settlement to flatmate | §28 | n/a (Settlement, not Expense) | Discharges §26's obligation | `Settlement`, `payment.direction = debit` | Excluded — `ledger_settlements_total` | `SplitwiseSettlement` |
| 10 | Flatmate sends settlement to user | §29 | n/a | Discharges the reverse obligation | `Settlement`, `payment.direction = credit` | Excluded — `ledger_settlements_total` | `SplitwiseSettlement` |
| 11 | Full refund | §11 | Dev | None | n/a | `netAmount` = 0, excluded from spend | `stale` if already synced |
| 12 | Partial refund | §12 | Dev | None | n/a | `netAmount` reduced, explicit redistribution | `stale` if already synced |
| 13 | Refund after Splitwise expense exists | §30 | Dev | Unaffected (already existed) | n/a | `netAmount` reduced | `sync_status = stale`, re-sync required |
| 14 | Duplicate bank transaction, same external reference | §13 | n/a | n/a | n/a | Second payment `IGNORED` | n/a |
| 15 | Multiple payments, one occasion | §10, §22 | Dev (each expense) | Per-expense | n/a | Explained spend, grouped by `ExpenseOccasion` | Syncs per-expense |
| 16 | One payment, multiple expenses | §1, §21 | Dev | Per-expense | n/a | Explained spend, split via `PaymentExpenseLink` | Syncs non-personal expenses only |
| 17 | Group beneficiary, membership changes later | §23, §33 | Dev | Per resolved member, snapshotted | n/a until settled | Explained spend | Syncs individual members only |
| 18 | Settlement with no receipt | §28 (note) | n/a | Discharges existing | `Settlement`, zero `Evidence` rows | Excluded | `SplitwiseSettlement` |
| 19 | Expense with no bank payment, someone else paid | §26, §27 | Flatmate/Friend | Owed to that payer | n/a until settled | Explained spend, no `PaymentExpenseLink` | Syncs |
| 20 | Transfer between own accounts | §14 | n/a | None | n/a | Excluded — `ledger_transfers_total` | Never syncs |
| 21 | Investment | §32 | n/a | None | n/a | Excluded — `ledger_investments_total` | Never syncs |
| 22 | Gift | §8 | Dev | **None** (not a debt-creating type) | n/a | Explained spend | Never syncs |
| 23 | Reimbursement | §31 | Dev | None | n/a (`ExpenseAdjustment`, not `Settlement`) | `netAmount` reduced | `stale` if already synced |
