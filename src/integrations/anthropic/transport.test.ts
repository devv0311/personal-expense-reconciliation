/**
 * The Anthropic transport, against a stub `fetch`.
 *
 * No network call and no key: what is under test is the wire contract and the failure
 * behaviour, both of which are exactly what a live run would depend on. Whether a real model
 * *guesses correctly* is not something a test can assert (`testing-strategy.md`), and is not
 * what this file claims to check.
 */

import { describe, expect, it, vi } from 'vitest';

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

  it('refuses an operation it has no prompt for, by name', async () => {
    const fetchImpl = vi.fn(respondWith(textResponse('{}')));
    const transport = createAnthropicTransport({ apiKey: 'k', fetchImpl });
    await expect(
      transport.complete({
        operation: 'suggest_allocation',
        promptVersion: 'x',
        input: {},
      }),
    ).rejects.toThrow(/suggest_allocation/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
