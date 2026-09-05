# CLAUDE.md — Engineering Context for This Repository

> **Current decisions (2026-09-06).** Phases 16 and 17 are complete. Next is Phase 18, the
> item-level refund **allocation engine**.
> [Phase 17](docs/roadmap.md) shipped context re-attachment
> ([ADR-0044](docs/decisions/0044-evidence-observations-and-match-candidates.md)):
> `EvidenceObservation` records the structured reading of a bank SMS or UPI push notification
> beside the immutable source, `EvidenceMatchCandidate` records each explained
> evidence↔payment offer with every signal's verdict, and **nothing auto-links** — ADR-0034's
> write-once linkage and ADR-0037's candidates-only rule are reused, not relaxed. The
> sanitization boundary is now fail-closed (`ai.assertPayloadSanitized`) with a local-only
> reversible mapping. [ADR-0017 (cash balance)](docs/decisions/0017-pragmatic-cash-balance-reconciliation.md)
> and [ADR-0018 (item refunds)](docs/decisions/0018-item-level-refund-attribution.md) are now
> **implemented at the schema, domain and service layers**: `Payment.cash_flow_category` with
> its own classification lifecycle, `ReconciliationAccountSnapshot`, and
> `ExpenseAdjustmentItem` all exist and are enforced. What remains scheduled is ADR-0018's
> **allocation engine** — turning net item costs into a superseding allocation and new
> obligations — which is Phase 18, as that ADR always specified. These decisions supersede
> older outflow-only scope restrictions and refine whole-expense refund distribution for
> item-attributed refunds; the existing engine is preserved alongside them, not replaced.
> Read these two ADRs and the current roadmap before historical implementation notes.
>
> **ADR numbering:** older ADR-0017 (integration tests) and ADR-0018 (manual-note semantics)
> remain in place. Always qualify the new decisions by title/full filename. Historical bare
> references to 0017/0018 in code and older docs refer to those older decisions; see the ADR index.

This file is persistent context for any Claude Code / Claude session working in this
repository. Read it before making changes. It summarizes and points to the fuller docs in
`docs/`; when this file and a doc in `docs/` disagree, the doc is more likely to be current —
fix this file to match and say so.

> **Revision note (2026-08).** This file was updated following a pre-implementation architecture
> review that corrected the settlement, refund/reimbursement, bidirectional-payer, and
> group-allocation models. See `docs/domain/domain-model.md`'s revision note and ADRs 0006–0011
> in `docs/decisions/` for the full reasoning.
>
> **Further revision note (2026-08, implementation-readiness pass).** Money/rounding, the
> full-refund allocation shape, non-user obligation observability, and inflow-reconciliation
> scope are now all finalized (ADRs 0012–0015) — none of these remain open questions. The domain
> model is implementation-ready; see the implementation-readiness report delivered alongside
> this pass for the full verdict.

## What this project is

A personal financial reconciliation system. It is **not** an expense tracker, budgeting app,
receipt scanner, or Splitwise replacement — see `docs/product/overview.md` for the full
problem statement. The one-line version: turn messy financial evidence into a verified,
explainable ledger that says who benefited from every payment and who owes whom — **in either
direction**, not only "who owes the user."

The conceptual pipeline, always in this order and never collapsed:

```
PAYMENT → PURPOSE → EVIDENCE → EXPENSE → BENEFICIARIES → ALLOCATION → SETTLEMENT → RECONCILIATION
```

Two expense-related event categories must never be conflated: a **spend event**
(`Expense` — requires an `Allocation`, has beneficiaries) and an **adjustment/discharge event**
(`Settlement`, `ExpenseAdjustment` — references an existing spend event or obligation, never has
its own `Allocation`). Settlement and reimbursement are _not_ expense purposes; see
`docs/domain/domain-model.md`'s event table. Cash-only transfers, investments and ordinary
external inflows are Payment classifications, with no fabricated Expense or Allocation.

Full entity definitions: `docs/domain/domain-model.md`. Glossary: `docs/domain/terminology.md`.

## The Design Standard — Tier-1 UI/UX

The quality bar is **Linear / Mercury / Ramp / Raycast-level craft**. This is a mandatory
product standard, not optional decoration. Build high-density information architecture with
clear hierarchy, exact amounts, aligned numeric columns, accessible contrast and progressive
disclosure. Preserve room to think without hiding financially important information.

`web/` must support keyboard-first navigation: `Cmd+K` (and `Ctrl+K`) command search,
discoverable triage shortcuts, predictable focus, selection and escape behavior. Consequential
approval remains explicit; a shortcut must not silently approve an ambiguous decision. Use
visual reconciliation waterfalls from evidenced opening cash through credits/debits to actual
closing cash and the signed delta, with drill-through to contributing records. Show account
completeness and unexplained amounts alongside the number. Use zero-clutter inspectors for
source evidence, interpretation, decision and audit history, plus refined micro-interactions
that communicate selection, progress and completion. Honor reduced motion, loading/error/empty
states, responsive layouts and keyboard accessibility. Test rendered flows with synthetic data.

The existing frontend and ADRs 0042/0043 are the starting point. Phase 21 carries the complete
UI overhaul after the domain phases; a prior design pass is not evidence that all six pillars
or their interactions have shipped.

## The 6 Core Pillars

1. **Context Re-attachment.** Resolve UPI narration decay by matching bank statements to
   SMS, push notifications and receipts using amount, direction, time, reference and merchant
   evidence. Keep original narration immutable. Surface match provenance, ambiguity and
   confidence; multiple evidence sources enrich one Payment, not several cash movements.
2. **Item-Level Partial Refund Attribution.** Record the actual refund against the purchased
   items, then derive net expense, new allocation and obligations. Preserve purchase history,
   tax/discount evidence, cumulative ceilings and prior settlements. See ADR-0018 (item refunds).
3. **Visual Reconciliation Waterfall.** Reconcile every in-scope account from bank opening
   balance through all credits/debits to evidenced closing balance. A verified **₹0 Unaccounted
   Delta** requires complete evidence, zero cash delta and zero unexplained credits/debits;
   arithmetic closure alone is insufficient. Retain ADR-0016's independent outflow identity.
4. **Splitwise Drift & Ghost-Debt Auditing.** Compare the canonical local ledger and its
   item/refund/settlement evidence to Splitwise. Expose stale refund shares, missing or duplicate
   records and debt unsupported by the current ledger as auditable discrepancies. A pair-level
   mismatch is a signal, not proof that one particular expense is wrong. Never silently trust
   an external balance or fabricate a local settlement to clear it.
5. **One-Click WhatsApp Proof Packs.** Derive concise, recipient-specific summaries of original
   spend, item refunds, net shares, settlements and remaining balances, with supporting evidence
   references. Preview/redact before copying or sharing. Packs are derived artifacts, never
   ledger authority; generation does not authorize sending or change a debt.
6. **Local PII Sanitization Boundary.** Raw statements, SMS/push content, receipts, account/card
   numbers, UPI IDs, contact details and identifiers stay behind the local boundary. Sanitize
   and pseudonymize before any external AI call; keep reversible mappings local, block unsafe
   payloads, and exclude raw PII from logs, fixtures and Git. Send only minimal task-relevant
   sanitized context. Proof packs use a separate explicit recipient preview/redaction step;
   preserving local evidence is not permission to export it.

## Non-negotiable domain principles

1. **Payment ≠ Expense ≠ Receipt.** A single payment may fund multiple expenses. A single
   expense may have multiple beneficiaries. A single occasion may span multiple payments.
   Never model these as the same object or assume a 1:1 relationship.
2. **Evidence is immutable.** Raw imported financial data (a bank statement line, a UPI
   notification, a receipt image) is never overwritten by an interpretation of it. Corrections
   produce new derived records; they do not mutate the source. **`Expense.amount` joins this
   immutability guarantee once `APPROVED`** — a correction to what something actually cost is a
   new `ExpenseAdjustment`, never a mutated `amount` (`invariants.md` #6).
3. **Evidence → Inference → Decision are distinct and traceable.** What the source says
   (evidence) is not what the system believes it means (inference) is not what the user has
   approved (decision). Every financially consequential record should be able to answer which
   of the three it is.
4. **AI is an inference engine, not a source of truth.** See "AI boundary" below — this is the
   single most important rule in the codebase.
5. **Shared expenses are not a boolean.** `is_shared = true` is not an acceptable
   representation. Model explicit allocations with a method (equal, exact, percentage,
   item-based, quantity-based, custom) and explicit beneficiaries.
6. **The payer is not always the user.** `Expense.paid_by_person_id` names who actually fronted
   the money; obligations run from every other beneficiary to _that_ person, not automatically
   to the user. A flatmate or friend paying and the user owing their share must never be
   represented by fabricating a payment the user never made (`domain-model.md`, ADR-0006).
7. **A settlement discharges a debt; it does not create one.** Never model a settlement as an
   `Expense` with its own `Allocation` — that risks double-counting the very debt it's supposed
   to be paying down. `Settlement` is its own entity, always tied to a `Payment` (ADR-0007).
8. **A `Group` is never a debtor.** A `group`-typed `AllocationLine` must be resolved into
   individual people's shares (`AllocationLineGroupExpansion`, snapshotted as of the expense
   date) before it can be settled or synced to Splitwise. Real money moves between people, not
   groups, and a later membership change must never retroactively alter a past allocation
   (ADR-0009).
9. **Splitwise is an external sync target.** This application's own ledger is the canonical
   source of truth. Splitwise identifiers are stored for traceability; Splitwise's numbers are
   reconciled against, never trusted blindly. Splitwise's "expense" and "settlement" concepts are
   synced separately (`SplitwiseExpense` / `SplitwiseSettlement`), matching this system's own
   `Expense`/`Settlement` split.
10. **Unexplained money is a first-class concept**, not a bug to hide. The system should always
    be able to show `total outflow − transfers − investments − settlements − explained expenses
(net of adjustments) = unexplained`, and surface that number rather than making it disappear
    through silent assumptions.

11. **Classify cash independently of counterparties.** `Payment.cash_flow_category` has
    `PEER_SETTLEMENT`, `REFUND`, `INTERNAL_TRANSFER`, `EXTERNAL_INFLOW`; validate directions
    and evidence per ADR-0017 (cash balance), 17.1–17.2. Ordinary purchase/investment debits
    retain their existing meaning. Unknown credits remain unexplained, not automatic income.
12. **Cash reconciliation is evidence-backed and dual.** Preserve ADR-0016 and add
    `expected_ending_balance = opening_balance + credits - debits` and
    `cash_balance_delta = actual_ending_balance - expected_ending_balance`. Count gross cash
    movements once, including refund credits. Missing statement balances are unknown, not zero.
    Immutable `ReconciliationAccountSnapshot`s preserve inputs, totals and signed residuals;
    verify each account independently (ADR-0017, 17.4–17.7).
13. **Internal transfers are cash-neutral across matched owned accounts.** Each real leg
    affects its own account; paired legs in the same scope cancel on consolidation. Missing or
    cross-period legs remain visible. Transfers create no expense, income or peer debt, and
    cannot be ignored merely to make cash close (ADR-0017, 17.3).
14. **Refund the item before allocating its net cost.** `ExpenseAdjustmentItem` must reference
    the same expense as its parent adjustment; attribution sums equal the adjustment amount,
    amounts are positive paise, and cumulative refunds cannot exceed gross item or expense
    cost. Never mutate original `ExpenseItem.amount` or Payment facts. Create a new allocation
    only after net costs are known; then derive obligations (ADR-0018, 19.1–19.6).
15. **Refund history and evidence survive.** Full refunds preserve zero-valued beneficiary
    lines. Taxes/discounts retain their evidenced purchase basis. Already-paid settlements stay
    recorded even when a later refund creates a reverse balance. Pending attribution or
    distribution is visible and blocks claims of current, verified obligations.

Full invariant list (with the "why" for each): `docs/domain/invariants.md`.

## AI boundary — read this before touching anything AI-related

- Deterministic application code owns: arithmetic, totals, rounding, percentages,
  allocations, balances, obligations, settlement discharge, net-amount computation after an
  adjustment, group-allocation expansion, reconciliation, state transitions, validation, and
  deduplication wherever the evidence is deterministic.
- AI owns: semantic transaction classification (including proposing whether a payment is a new
  expense or a settlement — `proposedKind`, ADR-0007), merchant interpretation, receipt/item
  extraction, beneficiary suggestions, allocation suggestions, grouping into occasions, anomaly
  explanation, rule proposals, and natural-language interaction.
- AI output is always a **structured proposal** with a **confidence level**
  (`high | medium | low | unknown`). The application validates proposals before they can
  become state. An LLM must never directly write an authoritative balance, total, allocation,
  settlement, or adjustment.
- Ambiguous, financially consequential decisions require explicit human approval — high
  confidence does not waive this when the amount, the beneficiary set, or the expense-vs-
  settlement classification is uncertain.
- AI never resolves a `group`-typed `AllocationLine` into individual shares — that's a
  deterministic `GroupMembership` lookup in `services`, not an inference (ADR-0009).
- See `docs/architecture/ai-boundary.md` for the concrete service interface
  (`classifyTransaction`, `suggestAllocation`, etc.) and validation contract.

## Financial safety rules

- All authoritative financial arithmetic lives in `src/domain` (or `src/services` calling into
  it) as plain, deterministic, unit-tested TypeScript. Never in a UI component, never behind an
  LLM call, never computed twice in two places.
- All monetary values are integer minor-unit `bigint` (paise for INR — the only currency V1
  supports arithmetically) — never a float, never `numeric`/`decimal`, anywhere. Every split
  (equal, percentage, group expansion, adjustment distribution) uses the **Largest Remainder
  Method**, one algorithm, finalized and specified in full in `docs/domain/invariants.md` #12 —
  not "to be decided at implementation." Item/quantity-based lines are the one exception: their
  amount comes from the already-exact derived net item cost after item attribution, no
  division unless that item is itself shared. Gross `ExpenseItem.amount` remains immutable.
  `AllocationLine.amount` may be zero (never negative) — a fully refunded/reimbursed expense's
  current allocation keeps one zero-amount line per original beneficiary, never an empty line
  set (invariants.md #12a).
- Transfers between the user's own accounts, and investment purchases, are not expenses and
  must never be counted as spending (`invariants.md` #7).
- Refunds and reimbursements (full or partial) must net against the original expense's **net**
  amount without ever mutating the original expense's recorded **gross** amount — a correction
  is always a new `ExpenseAdjustment`, never an edit (`invariants.md` #6, #8, #11).
- A settlement must never be counted as new spend, and must never itself require or produce an
  `Allocation` (`invariants.md` #9, #9a).
- Duplicate transactions must not double-count money; deduplication logic must be deterministic
  wherever a matching external reference (`payments.external_reference`) is available, with AI
  assistance only for ambiguous cases requiring human confirmation.
- Every financial amount must be traceable back to its source evidence record — for an
  externally-funded expense (someone else paid), that source is `Evidence` alone; there is
  deliberately no fabricated `Payment`.
- Every change to important financial data must be auditable: timestamp, actor, old value, new
  value, source, reason, and (if AI-assisted) model/confidence information. This includes
  `Settlement` creation and `ExpenseAdjustment` distribution.
- Approved financial decisions do not silently change. Re-deriving a suggestion never
  overwrites a user's prior approval without a new, visible decision. `Expense.amount`
  specifically never changes at all once approved, by any mechanism.

## Repository conventions

- **Language/stack**: TypeScript (strict mode), Node.js 20+. See
  `docs/architecture/system-architecture.md` for the full stack decision and rationale.
- **Structure**: `src/domain`, `src/services`, `src/ai`, `src/db`, `src/integrations`,
  `src/api` — each has its own `README.md` describing its responsibility. Domain logic must
  not import from `api` or `integrations`; dependencies point inward toward `domain`.
- **No secrets in Git.** Real bank statements, receipts, UPI identifiers, account numbers,
  card numbers, API keys, tokens, and production credentials must never be committed. Use
  `.env` (gitignored) locally; `.env.example` documents required variables with empty values.
- **No real financial data in fixtures.** Everything in `fixtures/` is synthetic. See
  `fixtures/README.md`.
- **Small, composable modules.** Avoid speculative abstraction, premature optimization, giant
  files, hidden business logic, and tight coupling to any one bank, merchant, or to Splitwise.
- **Explicit state transitions.** Transaction/expense lifecycle states are modeled explicitly
  (see `docs/domain/lifecycle.md`), not inferred from a combination of flags.
- **Architecture decisions are recorded.** Non-trivial technical or domain decisions get an ADR
  in `docs/decisions/`. See `docs/decisions/README.md` for the process.

## Testing requirements

- Financial calculations (allocation, balance/settlement, rounding, refunds/reimbursements,
  group-allocation expansion, deduplication, reconciliation) require deterministic automated
  tests before they ship — no exceptions, and no "trust the AI output" shortcut.
- Tests use synthetic fixtures from `fixtures/`, never real user data.
- Full strategy, including what test types apply to which layer and the coverage bar for
  financial code: `docs/testing/testing-strategy.md`.
- Before committing: `npm run typecheck && npm run lint && npm run format:check && npm test`
  must all pass. CI enforces the same on every push/PR.

## Development workflow

- This project moves in **incremental vertical slices** — see `docs/roadmap.md` for the
  phase order (repository foundation → domain model → architecture → database model →
  fixtures → import → normalization → classification → human review → receipt ingestion →
  item extraction → beneficiary allocation → expense ledger → Splitwise integration →
  reconciliation → schema/domain extensions → context re-attachment → item refund allocation
  → Splitwise auditing → proof packs → UI overhaul). Rules/learning, analytics and the
  natural-language interface remain unnumbered later work after Phase 21.
- **Do not jump ahead of the current phase.** Building later-phase features before earlier
  ones are solid re-creates the exact "messy, unreconciled" problem this system exists to
  solve, just in code form.
- Do not connect real bank accounts, real Splitwise accounts, or use real financial
  credentials during development. Build adapters/interfaces now; wire real connections later,
  deliberately, per `docs/security/security-model.md`.
- Deliver Phase 16–20 domain capabilities before the Phase 21 UI overhaul. Apply the Tier-1
  design standard to every shipped UI change; the existing `web/` application is a real
  product surface, not a placeholder.

## Where things live

| Topic                         | Doc                                        |
| ----------------------------- | ------------------------------------------ |
| Product problem & vision      | `docs/product/overview.md`                 |
| Detailed requirements         | `docs/product/requirements.md`             |
| Domain entities               | `docs/domain/domain-model.md`              |
| Glossary                      | `docs/domain/terminology.md`               |
| Invariants                    | `docs/domain/invariants.md`                |
| State lifecycle               | `docs/domain/lifecycle.md`                 |
| Scenario stress-tests         | `docs/domain/scenario-analysis.md`         |
| System architecture           | `docs/architecture/system-architecture.md` |
| Data flow                     | `docs/architecture/data-flow.md`           |
| AI service boundary           | `docs/architecture/ai-boundary.md`         |
| Database design               | `docs/architecture/database-design.md`     |
| Architecture Decision Records | `docs/decisions/`                          |
| Testing strategy              | `docs/testing/testing-strategy.md`         |
| Security model                | `docs/security/security-model.md`          |
| Roadmap / current phase       | `docs/roadmap.md`                          |
