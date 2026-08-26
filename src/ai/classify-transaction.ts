/**
 * `ai.classifyTransaction`, plus `AiService`/`createAiService` — the composition root for
 * every operation on `ai-boundary.md`'s boundary, not only this one.
 *
 * `classifyTransaction` was the first of the nine to exist (phase 8) and this file has stayed
 * where `AiService` is assembled since — phase 11 composes `parseReceipt`/`extractReceiptItems`
 * in here too (`receipt-extraction.ts`) rather than duplicating a second `createAiService`.
 *
 * What every operation does: redact, ask, validate, return a proposal. What none of them can
 * do: reach a database. There is no import of `src/db` anywhere in `src/ai`, so "no code path
 * from `ai/*` to `db` that skips `services.decideInference()`" is a property of the module
 * graph rather than a rule someone has to remember (`ai-boundary.md`).
 *
 * The model itself sits behind {@link ModelTransport}, which this module does not implement —
 * see ADR-0025 for why no provider is wired and what that buys.
 */

import type { AiInferenceType } from '../domain/index.js';

import { parseClassificationResponse } from './contract.js';
import type {
  Inference,
  ModelInfo,
  ReceiptDraft,
  ReceiptItemDraft,
  TransactionClassification,
} from './contract.js';
import {
  extractReceiptItems as extractReceiptItemsOperation,
  parseReceipt as parseReceiptOperation,
} from './receipt-extraction.js';
import { redactPaymentForInference } from './redaction.js';
import type {
  ClassifiablePayment,
  ClassificationContext,
  ClassifiableReceiptEvidence,
} from './redaction.js';

/** `ai_inferences.inference_type` for everything this operation produces. */
export const CLASSIFY_TRANSACTION: AiInferenceType = 'classify_transaction';

/**
 * The prompt this operation was written against.
 *
 * Stored on every `AIInference` it produces, so a proposal accepted last month can be traced
 * to the wording that produced it after the prompt has moved on. Bump it whenever the prompt
 * or the expected response shape changes.
 */
export const CLASSIFY_TRANSACTION_PROMPT_VERSION = 'classify_transaction/v1';

/**
 * One call to a model, already redacted.
 *
 * `input` is `unknown` rather than `RedactedPayment` specifically: this shape is shared by
 * every operation on the boundary, and each one redacts into its own type
 * (`RedactedPayment`, `RedactedReceiptEvidence`, …). A transport reads `operation` to know
 * which it received; nothing here asserts a shape a general-purpose transport cannot know.
 */
export interface ModelRequest {
  readonly operation: AiInferenceType;
  readonly promptVersion: string;
  readonly input: unknown;
}

/**
 * The seam between this boundary and an actual model.
 *
 * `complete` returns `unknown` on purpose: whatever comes back is untrusted until
 * `parseClassificationResponse` has had it. A transport that returned a typed object would be
 * asserting a shape it cannot know.
 */
export interface ModelTransport {
  /** Recorded on the `AIInference` so a proposal names what produced it. */
  readonly modelInfo: { readonly provider: string; readonly model: string };
  complete(request: ModelRequest): Promise<unknown>;
}

/**
 * The typed AI interface `src/services` depends on.
 *
 * Three operations now (phase 8's `classifyTransaction`, phase 11's `parseReceipt` and
 * `extractReceiptItems`). The other six arrive with the phases that need them (allocation
 * suggestions in 12, rules in 16) — declaring them now as unimplemented members would be a
 * promise the module cannot keep, and `ai-boundary.md` is where the full interface is
 * specified.
 */
export interface AiService {
  classifyTransaction(
    payment: ClassifiablePayment,
    context: ClassificationContext,
  ): Promise<Inference<TransactionClassification>>;
  parseReceipt(evidence: ClassifiableReceiptEvidence): Promise<Inference<ReceiptDraft>>;
  extractReceiptItems(
    evidence: ClassifiableReceiptEvidence,
  ): Promise<Inference<readonly ReceiptItemDraft[]>>;
}

/**
 * Builds the AI service over a transport.
 *
 * The transport is a required argument, so there is no "unconfigured" service that could fail
 * halfway through a classification run — a caller either has a model or does not have a
 * service.
 */
export function createAiService(transport: ModelTransport): AiService {
  const modelInfo: ModelInfo = {
    provider: transport.modelInfo.provider,
    model: transport.modelInfo.model,
    promptVersion: CLASSIFY_TRANSACTION_PROMPT_VERSION,
  };

  return {
    async classifyTransaction(payment, context) {
      const raw: unknown = await transport.complete({
        operation: CLASSIFY_TRANSACTION,
        promptVersion: CLASSIFY_TRANSACTION_PROMPT_VERSION,
        input: redactPaymentForInference(payment, context),
      });

      // Gate 1 of ai-boundary.md's validation contract. Anything short of the exact contract
      // throws here, and `src/services` is never handed a proposal to persist.
      const { proposedOutput, confidence } = parseClassificationResponse(raw);

      return { inferenceType: CLASSIFY_TRANSACTION, proposedOutput, confidence, modelInfo };
    },
    parseReceipt: (evidence) => parseReceiptOperation(transport, evidence),
    extractReceiptItems: (evidence) => extractReceiptItemsOperation(transport, evidence),
  };
}
