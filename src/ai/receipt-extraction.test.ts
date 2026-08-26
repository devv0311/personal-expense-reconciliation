import { describe, expect, it } from 'vitest';

import { isAiContractError } from './errors.js';
import {
  EXTRACT_RECEIPT_ITEMS_PROMPT_VERSION,
  PARSE_RECEIPT_PROMPT_VERSION,
  extractReceiptItems,
  parseReceipt,
} from './receipt-extraction.js';
import type { RedactedReceiptEvidence } from './redaction.js';
import type { ClassifiableReceiptEvidence } from './redaction.js';
import type { ModelRequest, ModelTransport } from './classify-transaction.js';

const EVIDENCE: ClassifiableReceiptEvidence = {
  evidenceType: 'receipt_image',
  mediaType: 'image/jpeg',
  rawText: null,
  capturedAt: new Date('2026-07-16T20:05:00.000Z'),
};

/** A transport that answers with one canned response and records what it was asked. */
function scripted(response: unknown): ModelTransport & { readonly seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  return {
    seen,
    modelInfo: { provider: 'synthetic', model: 'scripted-test-model' },
    complete: (request) => {
      seen.push(request);
      return Promise.resolve(response);
    },
  };
}

describe('parseReceipt', () => {
  it('sends the operation, the prompt version and the redacted evidence', async () => {
    const transport = scripted({
      confidence: 'high',
      proposedOutput: {
        merchantHint: 'Sample Restaurant',
        subtotalMinorUnits: '250000',
        taxMinorUnits: '20000',
        totalMinorUnits: '270000',
        currency: 'INR',
      },
    });

    await parseReceipt(transport, EVIDENCE);

    const [request] = transport.seen;
    const input = request?.input as RedactedReceiptEvidence | undefined;
    expect(request?.operation).toBe('parse_receipt');
    expect(request?.promptVersion).toBe(PARSE_RECEIPT_PROMPT_VERSION);
    expect(input?.evidenceType).toBe('receipt_image');
  });

  it('returns the validated proposal in the Inference envelope, naming what produced it', async () => {
    const transport = scripted({
      confidence: 'high',
      proposedOutput: {
        merchantHint: 'Sample Restaurant',
        subtotalMinorUnits: '250000',
        taxMinorUnits: '20000',
        totalMinorUnits: '270000',
        currency: 'INR',
      },
    });

    const inference = await parseReceipt(transport, EVIDENCE);

    expect(inference).toMatchObject({
      inferenceType: 'parse_receipt',
      confidence: 'high',
      proposedOutput: { total: 270_000n },
      modelInfo: {
        provider: 'synthetic',
        model: 'scripted-test-model',
        promptVersion: PARSE_RECEIPT_PROMPT_VERSION,
      },
    });
  });

  it('rejects a malformed response instead of returning it', async () => {
    const transport = scripted({ confidence: 'high', proposedOutput: { currency: 'USD' } });

    await expect(parseReceipt(transport, EVIDENCE)).rejects.toSatisfy(isAiContractError);
  });
});

describe('extractReceiptItems', () => {
  const RESPONSE = {
    confidence: 'medium',
    proposedOutput: [
      {
        description: 'Chicken Breast 500g',
        quantity: '1',
        unitPriceMinorUnits: null,
        lineTotalMinorUnits: '31000',
        suggestedCategory: null,
      },
    ],
  };

  it('sends the operation and its own prompt version, independent of parseReceipt', async () => {
    const transport = scripted(RESPONSE);

    await extractReceiptItems(transport, EVIDENCE);

    const [request] = transport.seen;
    expect(request?.operation).toBe('extract_receipt_items');
    expect(request?.promptVersion).toBe(EXTRACT_RECEIPT_ITEMS_PROMPT_VERSION);
    expect(request?.promptVersion).not.toBe(PARSE_RECEIPT_PROMPT_VERSION);
  });

  it('returns the validated item list in the Inference envelope', async () => {
    const transport = scripted(RESPONSE);

    const inference = await extractReceiptItems(transport, EVIDENCE);

    expect(inference.inferenceType).toBe('extract_receipt_items');
    expect(inference.confidence).toBe('medium');
    expect(inference.proposedOutput).toEqual([
      {
        description: 'Chicken Breast 500g',
        quantity: '1',
        unitPrice: null,
        lineTotal: 31_000n,
        suggestedCategory: null,
      },
    ]);
  });

  it('rejects a response that is not an array', async () => {
    const transport = scripted({ confidence: 'high', proposedOutput: {} });

    await expect(extractReceiptItems(transport, EVIDENCE)).rejects.toSatisfy(isAiContractError);
  });
});
