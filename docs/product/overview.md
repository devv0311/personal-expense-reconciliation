# Product Overview

## The problem

The user makes many payments through UPI, cards, and cash. Some are purely personal. Some are
for the flat they share. Some are made on the flatmates' or friends' behalf, to be paid back.
Some are shared expenses (a group dinner, a trip, a cab). Weeks later, reconstructing where the
money actually went — and who owes whom — is difficult, because:

- Bank/UPI records show _that_ money moved, not _why_.
- A single payment often funds several unrelated things (a Blinkit order with both a personal
  snack and flat groceries in the same basket).
- Shared costs are rarely split evenly by amount paid; someone fronts the bill and everyone
  else owes their share.
- Evidence is scattered: some purchases have a digital receipt, some only a bank line, some
  only the user's memory.
- Splitwise (or a similar tool) may hold a partial, manually-maintained record that drifts out
  of sync with what actually happened.

The result is that "how much do I actually spend on myself," "who owes me money right now,"
and "is this ₹4,000 gap in my account explained" are all hard questions to answer confidently.

## Product vision

Build a system that ingests financial evidence from wherever it exists (bank statements, UPI
transaction lists, card statements, receipts, screenshots, manual notes) and produces a
verified, explainable ledger answering, for every payment:

- What was it actually for?
- Who benefited, and in what proportion?
- What portion is the user's own spending?
- What portion belongs to someone else, and has it been settled?
- Does this agree with Splitwise (or whatever external tool tracks shared debts)?

The system is explicitly **not** optimized for auto-categorization accuracy as an end in
itself. It is optimized for **financial correctness, traceability, explainability, and fast
human review** — a wrong auto-categorization that a five-second review catches and fixes is
fine; a wrong balance that goes unnoticed is not.

## Target workflow

1. **Import.** Evidence lands in the system: a bank/card statement export, a set of UPI
   transactions, a forwarded receipt, a screenshot, or a manual note.
2. **Normalize.** Raw evidence is parsed into a consistent transaction shape without losing the
   original.
3. **Classify.** The system proposes what each transaction is for for (personal, shared,
   paid-on-behalf, gift, transfer, refund, ...) with a confidence level.
4. **Review (exception-driven).** High-confidence, low-stakes transactions require no
   interaction. Ambiguous or financially significant ones enter a review queue where the user
   confirms or corrects in seconds, not by re-entering data from scratch.
5. **Allocate.** For shared/paid-on-behalf expenses, the user (with AI-suggested defaults)
   decides beneficiaries and how the cost is divided.
6. **Settle & sync.** The system computes who owes whom, proposes a Splitwise expense where
   relevant, and only syncs after the user confirms.
7. **Reconcile.** Periodically, the system checks its own ledger against Splitwise and against
   the source accounts, and surfaces any drift or unexplained amount.

## Core use cases

- "How much did I actually spend on myself last month?"
- "Who owes me money right now, and for what?"
- "I paid for the flat's groceries again — remind me to log it as shared."
- "This ₹2,840 restaurant charge — was that the dinner with A and B?"
- "Does my Splitwise balance with Friend A match what I think I'm owed?"
- "What portion of this month's spending is still unexplained?"
- "Show me every expense I paid for on someone else's behalf that hasn't been reimbursed."

## Supported transaction sources

UPI transactions, bank statements, credit/debit card transactions, cash/manual entries,
screenshots, PDFs, CSV/XLSX exports, receipts (restaurant, retail, online order). See
`docs/domain/domain-model.md` (`TransactionSource`, `Evidence`) for how each is represented.

## Supported expense relationships

`personal`, `shared`, `paid_on_behalf`, `gift`, `reimbursement`, `settlement`,
`household/shared-flat` — see `docs/domain/domain-model.md` (`Expense`) for why this is an
open, explicit set rather than a boolean flag, and `docs/domain/scenario-analysis.md` for the
cases that forced this design.

## People and beneficiaries

People and groups are both first-class and not hard-coded to any particular relationship
("flatmate", "friend" are labels, not types the system special-cases). A person can belong to
multiple groups (the flat, a trip, a dinner group) simultaneously. See `domain-model.md`
(`Person`, `Group`, `Beneficiary`).

## Receipts and evidence

Receipts are evidence supporting an expense — not the central object the system is built
around. The system must function with a full itemized receipt, a receipt with partial detail,
only a bank/UPI line, only the user's manual explanation, or a screenshot. Online orders
(Blinkit, Swiggy, Zepto, and similar) are treated as one example of a merchant that happens to
provide good itemized evidence, not as an architectural special case.

## Splitwise

Splitwise is an external synchronization target used to track and settle debts with other
people. It is not this system's database. The flow is always
`expense → allocation → user approval → Splitwise proposal → user confirmation → sync →
reconciliation`. See `docs/architecture/ai-boundary.md` and `docs/product/requirements.md`
for constraints on when a Splitwise write is allowed to happen.

## Reconciliation

The system should be able to state, for any period: total outflow, how much is transfers or
investments (not spending), how much is explained expense, and how much remains unexplained.
It should also be able to state whether its own ledger and Splitwise agree, and where they
don't. "Unexplained money" is a first-class, visible concept — not something the system hides
by making optimistic assumptions.

## Future: analytics and natural-language interface

Once the ledger is trustworthy, later phases add analytics (spending by category/person/time)
and a natural-language interface for questions like the ones above. Neither is in scope for
the current foundation phase — see `docs/roadmap.md`.
