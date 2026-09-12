# Product Overview

## The problem

The user makes many payments through UPI, cards, and cash. Some are purely personal. Some are
for the flat they share. Some are made on the flatmates' or friends' behalf, to be paid back.
Some are shared expenses (a group dinner, a trip, a cab). **Some go the other way — a flatmate
or friend fronts money and the user owes their share.** Weeks later, reconstructing where the
money actually went — and who owes whom, in either direction — is difficult, because:

- Bank/UPI records show _that_ money moved, not _why_, and only ever show money that moved
  through the user's own accounts — never money someone else spent on the user's behalf.
- A single payment often funds several unrelated things (a Blinkit order with both a personal
  snack and flat groceries in the same basket).
- Shared costs are rarely split evenly by amount paid; someone fronts the bill and everyone
  else owes their share — and that "someone" isn't always the user.
- Evidence is scattered: some purchases have a digital receipt, some only a bank line, some
  only the user's memory or a flatmate's text message.
- Splitwise (or a similar tool) may hold a partial, manually-maintained record that drifts out
  of sync with what actually happened.

The result is that "how much do I actually spend on myself," "who owes me money right now,"
"who do I owe money to," and "is this ₹4,000 gap in my account explained" are all hard
questions to answer confidently.

## Product vision

Build a system that ingests financial evidence from wherever it exists (bank statements, UPI
transaction lists, card statements, receipts, screenshots, manual notes) and produces a
verified, explainable ledger answering, for every payment:

- What was it actually for?
- Who benefited, and in what proportion?
- Who actually fronted the money — the user, or someone else?
- What portion is the user's own spending?
- What portion belongs to someone else, and has it been settled — in either direction?
- Does this agree with Splitwise (or whatever external tool tracks shared debts)?

The system is explicitly **not** optimized for auto-categorization accuracy as an end in
itself. It is optimized for **financial correctness, traceability, explainability, and fast
human review** — a wrong auto-categorization that a five-second review catches and fixes is
fine; a wrong balance that goes unnoticed is not.

## Target workflow

1. **Import.** Evidence lands in the system: a bank/card statement export, a set of UPI
   transactions, a forwarded receipt, a screenshot, or a manual note (including a note about
   money someone else spent, for expenses the user didn't personally pay for).
2. **Normalize.** Raw evidence is parsed into a consistent transaction shape without losing the
   original.
3. **Classify.** The system proposes whether each transaction is a new expense or a settlement
   of an existing debt, and — for a new expense — what it's for (personal, shared,
   paid-on-behalf, gift, transfer, investment, household), who fronted the money, and a
   confidence level.
4. **Review (exception-driven).** High-confidence, low-stakes transactions require no
   interaction. Ambiguous or financially significant ones enter a review queue where the user
   confirms or corrects in seconds, not by re-entering data from scratch.
5. **Allocate.** For shared/paid-on-behalf expenses, the user (with AI-suggested defaults)
   decides beneficiaries and how the cost is divided.
6. **Settle & sync.** The system computes who owes whom — in whichever direction — proposes a
   Splitwise expense or settlement where relevant, and only syncs after the user confirms.
7. **Reconcile.** Periodically, the system checks its own ledger against Splitwise and against
   the source accounts, and surfaces any drift or unexplained amount.

## Core use cases

- "How much did I actually spend on myself last month?"
- "Who owes me money right now, and for what?"
- "Who do I owe money to right now, and for what?"
- "I paid for the flat's groceries again — remind me to log it as shared."
- "Flatmate A covered the electrician bill — log my share as something I owe them."
- "This ₹2,840 restaurant charge — was that the dinner with A and B?"
- "Does my Splitwise balance with Friend A match what I think I'm owed (or owe)?"
- "What portion of this month's spending is still unexplained?"
- "Show me every expense I paid for on someone else's behalf that hasn't been reimbursed."
- "Show me every expense someone else paid for on my behalf that I haven't settled yet."

## Supported transaction sources

UPI transactions, bank statements, credit/debit card transactions, cash/manual entries,
screenshots, PDFs, CSV/XLSX exports, receipts (restaurant, retail, online order). See
`docs/domain/domain-model.md` (`ImportBatch`, `Evidence`) for how each is represented.

## Supported expense relationships

`personal`, `shared`, `paid_on_behalf`, `gift`, `household/shared-flat` — see
`docs/domain/domain-model.md` (`Expense`) for why this is an open, explicit set rather than a
boolean flag, and `docs/domain/scenario-analysis.md` for the cases that forced this design.
**Settlement and reimbursement are not expense relationships** — a settlement discharges an
existing debt and a reimbursement nets against an existing expense; neither is a new thing the
money was "for." See `docs/domain/terminology.md`'s **Settlement**, **Refund**, and
**Reimbursement** entries, and ADRs 0007–0008 in `docs/decisions/`.

## Who paid, and who benefited, are two separate questions

Every expense has both a **payer** (`Expense.paid_by_person_id` — who actually fronted the
money) and one or more **beneficiaries** (the `Allocation`). Usually the payer is the user, but
not always: a flatmate paying the electrician while the user and another flatmate owe their
shares is exactly as representable as the user paying and everyone else owing them. See
`docs/domain/domain-model.md`'s Obligation/Balance section and `docs/domain/scenario-analysis.md`
§26–§29, §34.

## People and beneficiaries

People and groups are both first-class and not hard-coded to any particular relationship
("flatmate", "friend" are labels, not types the system special-cases). A person can belong to
multiple groups (the flat, a trip, a dinner group) simultaneously. A group is always a
convenience for entering a beneficiary line, never itself a debtor — settlement and Splitwise
sync always resolve down to individual people. See `domain-model.md`
(`Person`, `Group`, `AllocationLineGroupExpansion`).

## Receipts and evidence

Receipts are evidence supporting an expense — not the central object the system is built
around. The system must function with a full itemized receipt, a receipt with partial detail,
only a bank/UPI line, only the user's manual explanation, or a screenshot — and, for an expense
someone else paid for, evidence is the _only_ thing that will ever exist, since there is no
bank/UPI line in the user's own accounts to fall back on. Online orders (Blinkit, Swiggy,
Zepto, and similar) are treated as one example of a merchant that happens to provide good
itemized evidence, not as an architectural special case.

## Splitwise

Splitwise is an external synchronization target used to track and settle debts with other
people, in either direction. It is not this system's database. The flow is always
`expense → allocation → user approval → Splitwise proposal → user confirmation → sync →
reconciliation` for a new expense, and `settlement → user approval → Splitwise proposal → user
confirmation → sync → reconciliation` for discharging an existing debt — Splitwise itself
distinguishes these two kinds of record, and this system's `SplitwiseExpense`/
`SplitwiseSettlement` split mirrors that. See `docs/architecture/ai-boundary.md` and
`docs/product/requirements.md` for constraints on when a Splitwise write is allowed to happen.

## Reconciliation

The system should be able to state, for any period: total outflow, how much is transfers or
investments (not spending), how much is settlement of existing debts (also not new spending),
how much is explained expense, and how much remains unexplained. It should also be able to
state whether its own ledger and Splitwise agree, and where they don't. "Unexplained money" is
a first-class, visible concept — not something the system hides by making optimistic
assumptions. [ADR-0017 (cash balance)](../decisions/0017-pragmatic-cash-balance-reconciliation.md)
now extends the original outflow-only release with full statement cash reconciliation:
opening balance + all credits − all debits must equal evidenced closing balance per account.
A verified **₹0 Unaccounted Delta** also requires zero unexplained movements and complete
statement evidence, not merely a balanced equation. Preserve the existing outflow identity;
general budgeting/tax logic remains outside the core. See `docs/roadmap.md` for Phases 16–21
and `CLAUDE.md` for the six pillars and mandatory Tier-1 UI/UX standard.

## Analytics and the natural-language interface — both now built

Both of these were "once the ledger is trustworthy, later" for most of this project's life, and
both are now shipped. Analytics arrived with phase 22: spending by category, by month, the
user's own share, every open balance at once, and everything paid on behalf and still owed
(`/analytics`).

The natural-language interface arrived with
[ADR-0057](../decisions/0057-a-question-is-a-plan-over-reads-the-ledger-already-answers.md), and
it is narrower than the phrase suggests, deliberately. It is **ask-only**, and **the model
plans while the ledger answers**: a question becomes one of a closed set of query plans over
reads that already exist, and every figure in the answer is the one the matching screen shows,
produced by the same function. The model never sees a figure, never computes one and never
phrases the answer. An instruction — "mark this settled" — is refused by name and pointed at the
screen that owns the act.

That restraint is the point rather than a limitation of the current version. A chat box that
stated figures it had computed itself would undo the property this whole system exists to
provide: that every number can be traced to the evidence and the decision behind it.
