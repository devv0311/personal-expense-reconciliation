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

Not yet implemented — see `docs/roadmap.md` phases 7–8 (classification), 11 (receipt
extraction), 12 (allocation suggestions), 16 (rule proposals).
