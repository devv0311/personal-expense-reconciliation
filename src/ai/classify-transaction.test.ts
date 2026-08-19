import { describe, expect, it } from 'vitest';

import { asId, paise } from '../domain/index.js';

import { CLASSIFY_TRANSACTION_PROMPT_VERSION, createAiService } from './classify-transaction.js';
import type { ModelRequest, ModelTransport } from './classify-transaction.js';
import { isAiContractError } from './errors.js';
import type { ClassifiablePayment, ClassificationContext } from './redaction.js';

const PAYMENT: ClassifiablePayment = {
  amount: paise(284_000n),
  currency: 'INR',
  direction: 'debit',
  occurredAt: new Date('2026-07-03T00:00:00.000Z'),
  rawDescription: 'UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD',
  channel: 'upi',
  externalReference: 'UPI/2607031122/ZOMATO',
};

const CONTEXT: ClassificationContext = {
  merchant: {
    id: asId<'merchant'>('merchant-restaurant'),
    canonicalName: 'Sample Restaurant',
    defaultCategory: 'dining',
  },
  knownPeople: [],
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

describe('createAiService().classifyTransaction', () => {
  it('returns an Inference envelope, never a bare proposal', async () => {
    const transport = scripted({
      confidence: 'medium',
      proposedOutput: {
        proposedKind: 'expense',
        relationshipType: 'shared',
        category: 'dining',
      },
    });

    const inference = await createAiService(transport).classifyTransaction(PAYMENT, CONTEXT);

    expect(inference).toEqual({
      inferenceType: 'classify_transaction',
      confidence: 'medium',
      proposedOutput: {
        proposedKind: 'expense',
        relationshipType: 'shared',
        category: 'dining',
        paidByPersonHint: null,
      },
      modelInfo: {
        provider: 'synthetic',
        model: 'scripted-test-model',
        promptVersion: CLASSIFY_TRANSACTION_PROMPT_VERSION,
      },
    });
  });

  it('sends the operation, the prompt version and a redacted payload', async () => {
    const transport = scripted({
      confidence: 'high',
      proposedOutput: { proposedKind: 'expense', relationshipType: 'personal' },
    });

    await createAiService(transport).classifyTransaction(PAYMENT, CONTEXT);

    const [request] = transport.seen;
    expect(request?.operation).toBe('classify_transaction');
    expect(request?.promptVersion).toBe(CLASSIFY_TRANSACTION_PROMPT_VERSION);
    expect(request?.input.merchantName).toBe('Sample Restaurant');
    // Redaction is not optional and not the caller's job: the reference never reaches here.
    expect(JSON.stringify(request?.input)).not.toContain('UPI/2607031122/ZOMATO');
    expect(request?.input.description).not.toContain('0091');
  });

  it('rejects a malformed response instead of returning it', async () => {
    const transport = scripted({ confidence: 'high', proposedOutput: { proposedKind: 'refund' } });

    await expect(
      createAiService(transport).classifyTransaction(PAYMENT, CONTEXT),
    ).rejects.toSatisfy(isAiContractError);
  });

  it('rejects a response that is not JSON at all', async () => {
    const transport = scripted('I think this is a restaurant bill.');

    await expect(
      createAiService(transport).classifyTransaction(PAYMENT, CONTEXT),
    ).rejects.toSatisfy(isAiContractError);
  });

  it('lets a transport failure surface unchanged', async () => {
    const failing: ModelTransport = {
      modelInfo: { provider: 'synthetic', model: 'scripted-test-model' },
      complete: () => Promise.reject(new Error('provider unavailable')),
    };

    // Not wrapped in an AiContractError: the model did not breach the contract, it never
    // answered. The caller's retry/skip decision depends on telling those apart.
    await expect(createAiService(failing).classifyTransaction(PAYMENT, CONTEXT)).rejects.toThrow(
      'provider unavailable',
    );
  });
});
