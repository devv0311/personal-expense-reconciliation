# AI Boundary

The rule this document exists to enforce: **an LLM never directly writes authoritative
financial state.** Everything below is in service of making that true structurally, not just
by convention. See `CLAUDE.md` for the one-paragraph version and
`docs/domain/invariants.md` #15–17 for the invariants.

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

Calling one of these functions creates an `AIInference` row (`status = pending`) in `src/db`
via `src/services` — the `src/ai` module itself has no database access. It returns data; it
does not persist authoritative state.

## Validation contract

Before any `proposedOutput` can influence an `Expense`, `Allocation`, `Merchant`, or any other
APPROVED-classified record, it passes through two gates, both in `src/services`:

1. **Schema validation.** `proposedOutput` is validated against a strict schema (e.g. Zod) at
   the boundary where the AI response is parsed — malformed or out-of-range output (negative
   amounts, allocation lines that don't sum, unknown beneficiary IDs) is rejected before it
   becomes an `AIInference` at all, not caught later.
2. **Explicit decision transition.** `AIInference.status` moves from `pending` to `accepted`
   or `modified` only via a `services.decideInference()` call triggered by either a user action
   (through `api`) or a previously-approved `Rule` match. This function is the _only_ code path
   allowed to copy proposal data into an APPROVED-classified field, and it always also writes
   an `AuditEvent` (invariant #21) referencing the `AIInference` it came from.

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
| `unknown`  | Treated as `low`; typically means the model declined to guess (e.g. genuinely ambiguous merchant).                                                                                                |

## Data sent to the AI provider

- Redact or omit full account numbers, card numbers, and UPI IDs before any evidence or payment
  data is sent to an external AI provider — see `docs/security/security-model.md`.
- Prompts and responses are not logged with full financial detail by default (see security
  model for the exact logging policy).
- The AI provider is called synchronously from `services`-triggered flows, not given standing
  access to the database.

## What AI is explicitly not allowed to do

- Compute or adjust totals, allocation amounts, balances, or settlement figures. Those are
  `domain` functions over already-APPROVED data.
- Create or modify a `SplitwiseExpense` (invariant #19 — only APPROVED, `ALLOCATED` expenses
  can reach a sync proposal, and the sync call itself carries no AI involvement, per
  `data-flow.md` step 8).
- Mark an `AuditEvent`'s actor as anything other than a rule or a person — an `AIInference`
  being `accepted` always has a human or a human-approved `Rule` behind the transition.
