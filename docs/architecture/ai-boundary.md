# AI Boundary

The rule this document exists to enforce: **an LLM never directly writes authoritative
financial state.** Everything below is in service of making that true structurally, not just
by convention. See `CLAUDE.md` for the one-paragraph version and
`docs/domain/invariants.md` #15–17 for the invariants.

> **Revision note (2026-08).** `classifyTransaction`'s output shape gained a `proposedKind`
> field (settlement detection, ADR-0007). No other operation signature changed. See
> `docs/domain/domain-model.md`'s revision note for full context.

## Service interface

All AI access goes through `src/ai`, exposing exactly these operations (matching the brief):

```ts
classifyTransaction(payment: Payment): Promise<Inference<TransactionClassification>>
normalizeMerchant(rawDescription: string): Promise<Inference<MerchantMatch>>
parseReceipt(evidence: Evidence): Promise<Inference<ReceiptDraft>>
extractReceiptItems(evidence: Evidence): Promise<Inference<ReceiptItemDraft[]>>
suggestBeneficiaries(expense: Expense): Promise<Inference<BeneficiaryProposal>>
suggestAllocation(expense: Expense, beneficiaries: BeneficiaryRef[]): Promise<Inference<AllocationProposal>>
groupIntoOccasion(expenses: Expense[]): Promise<Inference<OccasionProposal>>
explainAnomaly(context: AnomalyContext): Promise<Inference<AnomalyExplanation>>
proposeRule(pattern: ObservedPattern): Promise<Inference<RuleProposal>>
```

`Inference<T>` is the return shape for all nine — never a bare `T`:

```ts
type Inference<T> = {
  inferenceType: string;
  proposedOutput: T;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  modelInfo: { provider: string; model: string; promptVersion: string };
};
```

**`TransactionClassification`, revised (ADR-0007):**

```ts
type TransactionClassification = {
  proposedKind: 'expense' | 'settlement';
  // populated when proposedKind === 'expense':
  relationshipType?: 'personal' | 'shared' | 'paid_on_behalf' | 'gift' | 'household_shared_flat';
  paidByPersonHint?: PersonRef; // usually the user; may propose someone else when evidence suggests it (§26/§27)
  category?: string;
  // populated when proposedKind === 'settlement':
  counterpartyPersonHint?: PersonRef;
};
```

A `Payment` to/from a known `Person` counterparty (e.g. a round-number UPI transfer to someone
with an open `Balance`) can be classified as a likely settlement this way. This is still only a
proposal — see the validation contract below. Settlement detection does not get a dedicated
tenth AI operation; it's a discriminator on the existing `classifyTransaction` output, since the
underlying input (a `Payment`) and confidence/audit handling are identical either way.

Calling one of these functions creates an `AIInference` row (`status = pending`) in `src/db`
via `src/services` — the `src/ai` module itself has no database access. It returns data; it
does not persist authoritative state.

## Validation contract

Before any `proposedOutput` can influence an `Expense`, `Allocation`, `Settlement`,
`ExpenseAdjustment`, `Merchant`, or any other APPROVED-classified record, it passes through two
gates, both in `src/services`:

1. **Schema validation.** `proposedOutput` is validated against a strict schema (e.g. Zod) at
   the boundary where the AI response is parsed — malformed or out-of-range output (negative
   amounts, allocation lines that don't sum, unknown beneficiary IDs, a `proposedKind` that
   isn't `expense`/`settlement`) is rejected before it becomes an `AIInference` at all, not
   caught later.
2. **Explicit decision transition.** `AIInference.status` moves from `pending` to `accepted`
   or `modified` only via a `services.decideInference()` call triggered by either a user action
   (through `api`) or a previously-approved `Rule` match. This function is the _only_ code path
   allowed to copy proposal data into an APPROVED-classified field, and it always also writes
   an `AuditEvent` (invariant #21) referencing the `AIInference` it came from. For a
   `classify_transaction` inference, accepting it produces **either** an `Expense` **or** a
   `Settlement` — never both — determined by `proposedKind`, itself part of what the accept/
   modify decision confirms.

There is no code path from `ai/*` to `db` that skips `services.decideInference()`. This is
enforced by module boundaries (`src/ai` has no import of `src/db`'s write functions) and
checked in review, not just documented.

## Confidence

`high | medium | low | unknown`. Confidence changes **friction**, never the requirement for
approval:

| Confidence | Effect                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `high`     | Eligible for auto-progression through review if amount/ambiguity thresholds also pass — but still requires an `accepted` transition, typically via a matched `Rule` the user previously approved. |
| `medium`   | Enters `REVIEW_REQUIRED`; shown with the proposal pre-filled for fast confirmation.                                                                                                               |
| `low`      | Enters `REVIEW_REQUIRED`; shown with a stronger visual flag and no pre-selected default beneficiary/allocation where ambiguity is highest.                                                        |
| `unknown`  | Treated as `low`; typically means the model declined to guess (e.g. genuinely ambiguous merchant, or genuinely ambiguous expense-vs-settlement kind).                                              |

## Data sent to the AI provider

- Redact or omit full account numbers, card numbers, and UPI IDs before any evidence or payment
  data is sent to an external AI provider — see `docs/security/security-model.md`.
- Prompts and responses are not logged with full financial detail by default (see security
  model for the exact logging policy).
- The AI provider is called synchronously from `services`-triggered flows, not given standing
  access to the database.

## What AI is explicitly not allowed to do

- Compute or adjust totals, allocation amounts, balances, obligations, settlement figures, or
  net amounts after an adjustment. Those are `domain` functions over already-APPROVED data.
- Create or modify a `SplitwiseExpense` or `SplitwiseSettlement` (invariant #19 — only
  APPROVED, `ALLOCATED` expenses or APPROVED settlements can reach a sync proposal, and the sync
  call itself carries no AI involvement, per `data-flow.md` step 8).
- Resolve a `group`-typed `AllocationLine` into individual `AllocationLineGroupExpansion` rows.
  That resolution reads `GroupMembership` deterministically as of the expense date
  (`services.approveAllocation()`) — there is nothing for AI to infer here, and no path exists
  for an AI proposal to write these rows directly (ADR-0009).
- Mark an `AuditEvent`'s actor as anything other than a rule or a person — an `AIInference`
  being `accepted` always has a human or a human-approved `Rule` behind the transition.
- Compute or influence `domain.obligationEvidenceStatus(X, Y)` (added this revision —
  `domain-model.md`'s `ObligationEvidenceStatus`). It is a deterministic, read-only query over
  existing `Settlement`/`Evidence`/`ReconciliationRun` rows, not an inference — there is no
  `ai/*` operation for it, and no path for an AI proposal to mark a non-user obligation as
  believed-settled on its own initiative.
