/**
 * `src/ai` — the AI inference boundary.
 *
 * Every operation returns an `Inference<T>`: a structured proposal, a confidence level, and
 * what produced it. Nothing here writes anything. There is no import of `src/db` in this
 * module, by design — `src/services` decides what happens to a proposal, and
 * `services.decideInference()` is the only path from one to authoritative state
 * (`docs/architecture/ai-boundary.md`).
 *
 * This barrel is the layer's public surface, matching how `src/domain` exposes itself.
 */

export * from './classify-transaction.js';
export * from './contract.js';
export * from './errors.js';
export * from './redaction.js';
