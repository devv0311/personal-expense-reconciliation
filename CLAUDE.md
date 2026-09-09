# CLAUDE.md — Engineering Context for This Repository

> **Current decisions (2026-09-08).** **The numbered sequence is complete: phases 1–22 are all
> done.** [Phase 22](docs/roadmap.md) closed the 7 September capability audit's gaps
> ([ADR-0050](docs/decisions/0050-closing-the-audit-gaps-a-workflow-is-not-shipped-until-it-is-reachable.md)).
> That audit's verdict is worth keeping in mind, because it names a failure mode this repository
> is prone to: every phase closed against its own scope, no phase's scope was "a person can do
> this from a browser", and the gaps fell between them — an import service with no import
> screen, an allocation engine reachable only over HTTP, a `ReceiptFacts` component with no
> caller, six `ai-boundary.md` operations declared and never implemented. Phase 22 built the
> surface rather than re-describing the scope: `/setup`, `/payments` (workspace, import,
> normalization/classification runs, counterparty and cash-flow decisions, the exhaustive
> unexplained list), `/evidence` (library and intake), the allocation editor and item
> entry/correction, funding links, settlements, the session gate, Splitwise connection and
> single-row re-sync, `/analytics`, `/automation` (rules and jobs), occasions, the audit-trail
> screens, and ledger-wide search with real paging. **`web/` still performs no financial
> arithmetic**: `receiptId` on `GET /api/evidence/:evidenceId` is the only read the whole phase
> added. What remains unbuilt is now genuinely unbuilt rather than unreachable — a message
> transport, live bank adapters, bidirectional Splitwise sync, and the natural-language
> interface — and each needs its own ADR.
> [Phase 21](docs/roadmap.md) shipped the **`web/` UI/UX overhaul**
> ([ADR-0048](docs/decisions/0048-phase-21-ui-reads-the-ledger-and-never-recomputes-it.md),
> [ADR-0049](docs/decisions/0049-keyboard-first-navigation-never-completes-a-decision.md)),
> which makes all six pillars reachable through end-to-end flows across six sections — Review,
> Reconciliation, Expenses, Balances, Splitwise, Proof packs — plus evidence, payment-context and
> audit-finding detail screens. Two rules govern it and hold everywhere in `web/`: **the frontend
> performs no financial arithmetic** (where a figure had no HTTP surface, the _read_ was added —
> `GET /api/accounts`, `GET /api/expenses/:expenseId`,
> `GET /api/reconciliation/runs/:id/account-snapshots`,
> `GET /api/evidence/:evidenceId/observation`, and `accountBoundaries` on
> `POST /api/reconciliation/runs` — never the calculation), and **no keyboard shortcut completes
> a decision** (`Cmd+K`, `?`, `g`-pairs and `j`/`k`/`Enter` navigate and open; every
> consequential act is a button behind a dialog that states its consequence). The account
> waterfall renders ADR-0017's second identity term by term and never shows a verified ₹0 over
> incomplete evidence: a missing statement balance reads "not evidenced" and
> `verificationStatus` comes from the database `CHECK`, not the screen. Everything that remains —
> rules/learning, analytics, the natural-language interface, concrete external adapters and stale
> Splitwise re-sync — is deliberately unnumbered later work.
> Earlier phases are each recorded in their own ADR — read the ADR, not a summary here:
> **Phase 17** context re-attachment
> ([ADR-0044](docs/decisions/0044-evidence-observations-and-match-candidates.md)); **Phase 18**
> the item-refund allocation engine
> ([ADR-0045](docs/decisions/0045-item-refund-allocation-is-rebuilt-not-decremented.md));
> **Phase 19** Splitwise drift and ghost-debt auditing
> ([ADR-0046](docs/decisions/0046-splitwise-audit-findings-and-external-read-completeness.md));
> **Phase 20** derived proof packs
> ([ADR-0047](docs/decisions/0047-proof-packs-are-a-derived-read-not-a-second-ledger.md)).
> [ADR-0017 (cash balance)](docs/decisions/0017-pragmatic-cash-balance-reconciliation.md) and
> [ADR-0018 (item refunds)](docs/decisions/0018-item-level-refund-attribution.md) are
> **implemented in full at the schema, domain and service layers**.
> Read these ADRs and the current roadmap before historical implementation notes.
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

The quality bar is **Linear / Mercury / Ramp / Raycast-level craft** — a mandatory product
standard, not optional decoration. `web/Design.md` is authoritative for how it is realised and
`web/CLAUDE.md` carries the working rules; ADRs 0042/0043/0048/0049 record the decisions behind
it. A change to `web/` starts by reading both. The three rules that outrank any visual
preference are restated under **Development workflow** below, because they bind the API too.

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
   an external balance or fabricate a local settlement to clear it. Shipped in Phase 19
   (ADR-0046): `domain.auditSplitwisePair` + `services.runSplitwiseAudit`, with an unexplained
   gap reported as an unattributed mismatch rather than pinned on a record, and an unreadable
   Splitwise recorded as an incomplete audit rather than a clean one.
5. **One-Click WhatsApp Proof Packs.** Derive concise, recipient-specific summaries of original
   spend, item refunds, net shares, settlements and remaining balances, with supporting evidence
   references. Preview/redact before copying or sharing. Packs are derived artifacts, never
   ledger authority; generation does not authorize sending or change a debt. Shipped in Phase 20
   (ADR-0047): `domain.buildProofPack` + `services.buildProofPackPreview` +
   `GET /api/proof-packs/:recipientPersonId`, a pure read that quotes the canonical figures and
   recomputes none, isolates the recipient structurally, reuses Phase 17's redaction and fails
   closed on an unredacted export, keeps every uncertainty visible as a warning, and persists
   nothing. The deliberate copy/export/share step, and a recipient-facing review of exactly what
   is about to be sent, are Phase 21's UI concern.
6. **Local PII Sanitization Boundary.** Raw statements, SMS/push content, receipts, account/card
   numbers, UPI IDs, contact details and identifiers stay behind the local boundary. Sanitize
   and pseudonymize before any external AI call; keep reversible mappings local, block unsafe
   payloads, and exclude raw PII from logs, fixtures and Git. Send only minimal task-relevant
   sanitized context. Proof packs use a separate explicit recipient preview/redaction step;
   preserving local evidence is not permission to export it. Phase 21's UI holds the same line:
   the evidence inspector shows a raw notification verbatim because that surface is local, and
   the proof-pack screen redacts separately and gates copying behind an explicit review.

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

- **Dependency direction**: domain logic must not import from `api` or `integrations`;
  dependencies point inward toward `domain`. Stack rationale and the responsibility of each
  `src/*` package: `docs/architecture/system-architecture.md` and each package's `README.md`.
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
  phase order. **All twenty-two are complete.** A message transport for proof packs, live
  bank/card balance
  adapters, bidirectional Splitwise sync beyond the single-row correction, and the
  natural-language interface remain unnumbered later work; none is a prerequisite for anything
  already shipped, and each needs its own ADR before it starts.
- **A capability is not shipped until a person can reach it** (ADR-0050). A service function and
  an HTTP route are the middle of the work, not the end of it: the September 2026 audit found
  eleven capabilities complete at those two layers and absent from the browser. When a phase
  says it delivered something, check that a person can do it.
- **Do not jump ahead of the current phase.** Building later-phase features before earlier
  ones are solid re-creates the exact "messy, unreconciled" problem this system exists to
  solve, just in code form.
- Do not connect real bank accounts, real Splitwise accounts, or use real financial
  credentials during development. Build adapters/interfaces now; wire real connections later,
  deliberately, per `docs/security/security-model.md`.
- Apply the Tier-1 design standard to every shipped UI change; `web/` is a real product
  surface, not a placeholder. Three rules there are not stylistic and outrank any visual
  preference (ADR-0048/0049): **`web/` performs no financial arithmetic** — if a screen needs a
  figure that does not exist over HTTP, add the read to the API, however trivial the subtraction
  looks; **never render a verified zero over incomplete evidence**; and **no keyboard shortcut
  completes a decision**.
