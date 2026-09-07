/**
 * The Anthropic transport, against a stub `fetch`.
 *
 * No network call and no key: what is under test is the wire contract and the failure
 * behaviour, both of which are exactly what a live run would depend on. Whether a real model
 * *guesses correctly* is not something a test can assert (`testing-strategy.md`), and is not
 * what this file claims to check.
 */

import { describe, expect, it, vi } from 'vitest';

import { AI_INFERENCE_TYPES } from '../../domain/index.js';
import {
  parseClassificationResponse,
  parseExtractReceiptItemsResponse,
  parseParseReceiptResponse,
} from '../../ai/index.js';
import type { ModelRequest } from '../../ai/index.js';

import { createAnthropicTransport, ModelTransportError } from './transport.js';

function stubResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(text: string): Response {
  return stubResponse({ content: [{ type: 'text', text }] });
}

/** A `fetch` stub answering with one response — the transport's only outside dependency. */
function respondWith(response: Response): typeof fetch {
  return () => Promise.resolve(response);
}

/** The JSON body of the one request a stubbed `fetch` received. */
function requestBody(fetchImpl: { mock: { calls: unknown[][] } }): string {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== 'string') {
    throw new Error('The transport made no request, or sent no body.');
  }
  return init.body;
}

const CLASSIFY: ModelRequest = {
  operation: 'classify_transaction',
  promptVersion: 'classify_transaction/v1',
  input: { description: 'UPI-MERCHANT', amountMinorUnits: '124000' },
};

describe('createAnthropicTransport', () => {
  it('returns the parsed JSON object the model produced', async () => {
    const fetchImpl = vi.fn(
      respondWith(textResponse('{"proposedKind":"expense","confidence":"high"}')),
    );
    const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });

    const result = await transport.complete(CLASSIFY);
    expect(result).toEqual({ proposedKind: 'expense', confidence: 'high' });
  });

  it('sends the redacted payload and the prompt version, and nothing else', async () => {
    const fetchImpl = vi.fn(respondWith(textResponse('{}')));
    const transport = createAnthropicTransport({ apiKey: 'secret-key', fetchImpl });
    await transport.complete(CLASSIFY);

    const body = JSON.parse(requestBody(fetchImpl)) as {
      messages: Array<{ content: string }>;
      system: string;
    };
    const sent = JSON.parse(body.messages[0]!.content) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['input', 'promptVersion']);
    expect(sent['input']).toEqual(CLASSIFY.input);
    // The system prompt states the contract; it never carries ledger data.
    expect(body.system).not.toContain('124000');
  });

  it('records which model produced a proposal', () => {
    const transport = createAnthropicTransport({ apiKey: 'k', model: 'claude-test-1' });
    expect(transport.modelInfo).toEqual({ provider: 'anthropic', model: 'claude-test-1' });
  });

  it('tolerates a fenced JSON block, because that is a formatting habit and not a different answer', async () => {
    const fetchImpl = vi.fn(
      respondWith(textResponse('```json\n{"proposedKind":"settlement"}\n```')),
    );
    const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });
    expect(await transport.complete(CLASSIFY)).toEqual({ proposedKind: 'settlement' });
  });

  it('discards an answer that is not JSON rather than guessing at it', async () => {
    const fetchImpl = vi.fn(respondWith(textResponse('It looks like a grocery purchase.')));
    const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });
    await expect(transport.complete(CLASSIFY)).rejects.toThrow(ModelTransportError);
  });

  it('reports a provider error as a transport failure, with its status', async () => {
    const fetchImpl = vi.fn(respondWith(stubResponse({ error: 'overloaded' }, 529)));
    const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });
    await expect(transport.complete(CLASSIFY)).rejects.toMatchObject({
      name: 'ModelTransportError',
      status: 529,
    });
  });

  it('reports an unreachable provider rather than resolving with nothing', async () => {
    const fetchImpl = vi.fn((): Promise<Response> => Promise.reject(new Error('ECONNREFUSED')));
    const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });
    await expect(transport.complete(CLASSIFY)).rejects.toThrow(/could not be reached/);
  });

  it('reports an empty response rather than proposing nothing as if it were an answer', async () => {
    const fetchImpl = vi.fn(respondWith(stubResponse({ content: [] })));
    const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });
    await expect(transport.complete(CLASSIFY)).rejects.toThrow(/no text content/);
  });

  it('has a prompt for every operation the boundary declares', async () => {
    // Nine now (audit row 46 added the last six). A missing prompt would make the operation
    // refuse by name rather than silently ask for nothing, which is the behaviour worth
    // keeping — but the point of this test is that none of them is missing.
    for (const operation of AI_INFERENCE_TYPES) {
      const fetchImpl = vi.fn(respondWith(textResponse('{}')));
      const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });
      await transport.complete({ operation, promptVersion: 'v1', input: {} });
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });
});

/**
 * The prompts have to describe the shape `src/ai/contract.ts` accepts — including the
 * `{confidence, proposedOutput}` envelope, which is easy to describe flat by mistake.
 *
 * This ran red once: the prompts asked for a flat object, so every live classification would
 * have come back a well-formed answer that the contract validator rejected as a breach, and the
 * failure would have looked like "the model is bad at this" rather than "we asked wrong".
 */
describe('the prompts describe the shape the contract actually accepts', () => {
  async function promptFor(operation: ModelRequest['operation']): Promise<string> {
    const fetchImpl = vi.fn(respondWith(textResponse('{}')));
    const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });
    await transport.complete({ operation, promptVersion: 'v1', input: {} });
    const body = JSON.parse(requestBody(fetchImpl)) as { system: string };
    return body.system;
  }

  it('asks for the classification envelope, not a flat proposal', async () => {
    const prompt = await promptFor('classify_transaction');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"proposedOutput"');

    // The example the prompt shows must itself survive the validator.
    expect(() =>
      parseClassificationResponse({
        confidence: 'high',
        proposedOutput: {
          proposedKind: 'expense',
          relationshipType: 'shared',
          category: 'food',
          paidByPersonHint: null,
        },
      }),
    ).not.toThrow();
  });

  it('asks for the receipt fields by their contract names', async () => {
    const prompt = await promptFor('parse_receipt');
    for (const field of [
      'merchantHint',
      'subtotalMinorUnits',
      'taxMinorUnits',
      'totalMinorUnits',
    ]) {
      expect(prompt).toContain(field);
    }
    expect(() =>
      parseParseReceiptResponse({
        confidence: 'medium',
        proposedOutput: {
          merchantHint: 'A Shop',
          subtotalMinorUnits: '1000',
          taxMinorUnits: '180',
          totalMinorUnits: '1180',
          currency: 'INR',
        },
      }),
    ).not.toThrow();
  });

  it('asks for the item fields by their contract names', async () => {
    const prompt = await promptFor('extract_receipt_items');
    for (const field of ['lineTotalMinorUnits', 'unitPriceMinorUnits', 'quantity']) {
      expect(prompt).toContain(field);
    }
    expect(() =>
      parseExtractReceiptItemsResponse({
        confidence: 'low',
        proposedOutput: [
          {
            description: 'Milk',
            quantity: '2',
            unitPriceMinorUnits: '4000',
            lineTotalMinorUnits: '8000',
            suggestedCategory: null,
          },
        ],
      }),
    ).not.toThrow();
  });
});
