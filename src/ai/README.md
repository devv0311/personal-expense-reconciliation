# src/ai

The AI inference boundary. See `docs/architecture/ai-boundary.md` for the full contract.

**Owns:** the nine inference operations (`classifyTransaction`, `normalizeMerchant`,
`parseReceipt`, `extractReceiptItems`, `suggestBeneficiaries`, `suggestAllocation`,
`groupIntoOccasion`, `explainAnomaly`, `proposeRule`), each returning a structured
`Inference<T>` with a confidence level. Also owns the redaction step
(`docs/security/security-model.md`) applied before any data leaves the system's boundary.

**Depends on:** `src/domain` for shared types only.

**Must never:** write to the database directly, or otherwise produce a path from a model
response to an APPROVED-classified field. Every function here returns data; `src/services`
decides what happens to it.

**Partly implemented (phases 8, 11).**

- `contract.ts` — `Inference<T>`, `TransactionClassification`, `ReceiptDraft`,
  `ReceiptItemDraft`, and the strict validator for each. A model response is untrusted input:
  unknown keys, missing keys, wrong types and out-of-range values are all rejected, naming the
  offending field. This is gate 1 of `ai-boundary.md`'s validation contract, and it fires
  **before** an `AIInference` row exists — a malformed response is not stored as a bad
  proposal, it is not stored at all. `parseTransactionClassification` is exported so
  `services.decideInference`'s `modify` path runs a human's correction through exactly the
  same gate; `parseReceiptDraft`/`parseReceiptItemDrafts` are its receipt-side counterparts.
- `redaction.ts` — the boundary, and (phase 17) the proof that it ran.
  `redactPaymentForInference` / `redactDescription` for payments;
  `redactReceiptEvidenceForInference` / `redactReceiptText` for receipt evidence, narrower on
  purpose (only a keyword-labelled digit run is masked, never a bare 4+ digit run — a receipt's
  raw text is legitimately full of non-identifying digits: prices, quantities, dates).
  `external_reference` and `account_id` have no field on the outgoing payload at all, so
  omitting them is not a step a caller can forget.

  **Phase 17 (ADR-0044) added three things.** `ClassificationContext.reattachedContext` carries
  what the evidence attached to a payment says its counterparty was — the answer to UPI
  narration decay — and only the merchant _names_ leave, as `reattachedMerchantHints`, redacted
  the same way a statement description is (a notification's merchant field routinely carries a
  VPA). `assertPayloadSanitized` runs at the end of every redaction builder and **throws instead
  of sending** when an identifier is still present; it is independent of the redactors on
  purpose, because they are pattern substitutions over bank-written free text and a payload is a
  shape somebody can extend without noticing there was a rule attached to it. It reports the
  field and the kind, never the value. `createLocalRedactionMap` is the reversible mapping
  `CLAUDE.md`'s pillar 6 keeps local: a separate object the caller holds, never a field on a
  payload, scoped per unit of work.

- `classify-transaction.ts` — `createAiService(transport)`, the typed service interface (now
  composing `classifyTransaction`, `parseReceipt` and `extractReceiptItems`), and
  `CLASSIFY_TRANSACTION_PROMPT_VERSION`. The model itself sits behind an injected
  `ModelTransport`; **no provider is wired** (ADR-0025), and the integration suite injects
  transports scripted from `fixtures/ai-classification-proposals.json` and
  `fixtures/receipt-extraction-proposals.json`.
- `receipt-extraction.ts` — `parseReceipt`/`extractReceiptItems`, phase 11's two operations,
  composed into `AiService` by `classify-transaction.ts`. The first (and, per ADR-0036, so far
  only) operations whose output is written **without** a `decideInference`-shaped gate —
  `Receipt` is DERIVED, not APPROVED-classified.

`AiContractError` (`errors.ts`) means the model breached the contract; `SanitizationError`
means this system breached its own — an identifier reached the outgoing payload and nothing was
sent. A transport that
rejects — network, timeout, rate limit — surfaces unchanged, because "the model answered
nonsense" and "the model never answered" call for different responses.

- `suggestions.ts` — the six operations phase 22 added (audit row 46): `normalizeMerchant`,
  `suggestBeneficiaries`, `suggestAllocation`, `groupIntoOccasion`, `explainAnomaly`,
  `proposeRule`. Each keeps the line that matters for it: `suggestAllocation` proposes a
  **method**, never amounts; `proposeRule` always proposes `effect: 'propose'`;
  `explainAnomaly` returns prose with no field a service could persist.
- `ask.ts` — `planLedgerQuery`, the tenth operation (ADR-0057), plus
  `describeTransportAvailability`. It turns a question into a **query plan** over reads that
  already exist. It is the only operation on this boundary that can see no figure at all —
  there is no field on its payload for a balance or a total — and the only one that writes no
  `AIInference` row, because nothing accepts a query plan.

**What is wired:** a production `ModelTransport` now exists
(`src/integrations/anthropic/transport.ts`), composed by `src/server.ts` **only when
`ANTHROPIC_API_KEY` is set**; without it the stub refuses by name and declares itself
unconfigured, so a screen can say why rather than failing on submit. ADR-0025's rule holds in
the shape it always meant — the transport is injected, and nothing is wired by default.

**Not implemented, deliberately:** natural-language _entry_. An instruction is refused by name
(`unsupported_write_request`) and pointed at the screen that owns the act; staging one as a
confirmable proposal needs an editor for stored proposals, which does not exist
(`docs/roadmap.md`).
