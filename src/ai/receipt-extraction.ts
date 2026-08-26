/**
 * `ai.parseReceipt` / `ai.extractReceiptItems` — the second and third operations built on
 * phase 8's boundary (`ai-boundary.md`, ADR-0036).
 *
 * Same shape as `classify-transaction.ts`: redact, ask, validate (gate 1), return a proposal.
 * Same thing it cannot do — there is no import of `src/db` here either, so nothing in this
 * file can turn a proposal into a `Receipt` row. That is `services.extractReceipt`'s, and it is
 * also where gate 2 (semantic validation) and the write happen.
 *
 * Two operations, not one, because `ai-boundary.md` specifies them that way — `parseReceipt`
 * proposes the totals, `extractReceiptItems` proposes the line items, and each produces its own
 * `AIInference` row, traceable back to its own prompt version independently of the other.
 */

import type { AiInferenceType } from '../domain/index.js';

import { parseExtractReceiptItemsResponse, parseParseReceiptResponse } from './contract.js';
import type { Inference, ModelInfo, ReceiptDraft, ReceiptItemDraft } from './contract.js';
import type { ModelRequest, ModelTransport } from './classify-transaction.js';
import { redactReceiptEvidenceForInference } from './redaction.js';
import type { ClassifiableReceiptEvidence } from './redaction.js';

/** `ai_inferences.inference_type` for `ai.parseReceipt`. */
export const PARSE_RECEIPT: AiInferenceType = 'parse_receipt';
/** `ai_inferences.inference_type` for `ai.extractReceiptItems`. */
export const EXTRACT_RECEIPT_ITEMS: AiInferenceType = 'extract_receipt_items';

/** Stored on every `AIInference` `ai.parseReceipt` produces (see `classify-transaction.ts`). */
export const PARSE_RECEIPT_PROMPT_VERSION = 'parse_receipt/v1';
/** Stored on every `AIInference` `ai.extractReceiptItems` produces. */
export const EXTRACT_RECEIPT_ITEMS_PROMPT_VERSION = 'extract_receipt_items/v1';

/**
 * `ai.parseReceipt`, over an already-built transport.
 *
 * A standalone function rather than a method on some receipt-specific service object, because
 * the composed `AiService` a caller actually depends on lives in `classify-transaction.ts`
 * alongside `createAiService` — this is what it composes in.
 */
export async function parseReceipt(
  transport: ModelTransport,
  evidence: ClassifiableReceiptEvidence,
): Promise<Inference<ReceiptDraft>> {
  const modelInfo: ModelInfo = {
    provider: transport.modelInfo.provider,
    model: transport.modelInfo.model,
    promptVersion: PARSE_RECEIPT_PROMPT_VERSION,
  };

  const raw: unknown = await transport.complete({
    operation: PARSE_RECEIPT,
    promptVersion: PARSE_RECEIPT_PROMPT_VERSION,
    input: redactReceiptEvidenceForInference(evidence),
  } satisfies ModelRequest);

  // Gate 1 of ai-boundary.md's validation contract. A malformed response throws here, before
  // src/services is handed anything to persist.
  const { proposedOutput, confidence } = parseParseReceiptResponse(raw);

  return { inferenceType: PARSE_RECEIPT, proposedOutput, confidence, modelInfo };
}

/** `ai.extractReceiptItems`, over an already-built transport. */
export async function extractReceiptItems(
  transport: ModelTransport,
  evidence: ClassifiableReceiptEvidence,
): Promise<Inference<readonly ReceiptItemDraft[]>> {
  const modelInfo: ModelInfo = {
    provider: transport.modelInfo.provider,
    model: transport.modelInfo.model,
    promptVersion: EXTRACT_RECEIPT_ITEMS_PROMPT_VERSION,
  };

  const raw: unknown = await transport.complete({
    operation: EXTRACT_RECEIPT_ITEMS,
    promptVersion: EXTRACT_RECEIPT_ITEMS_PROMPT_VERSION,
    input: redactReceiptEvidenceForInference(evidence),
  } satisfies ModelRequest);

  const { proposedOutput, confidence } = parseExtractReceiptItemsResponse(raw);

  return { inferenceType: EXTRACT_RECEIPT_ITEMS, proposedOutput, confidence, modelInfo };
}
