/**
 * The WhatsApp Cloud adapter, against a scripted `fetch`.
 *
 * No network: every test hands the adapter its own `fetchImpl` and asserts what it put on the
 * wire and what it made of the answer. The properties under test are the ones that would be
 * invisible until a real send went wrong — that a refusal comes back as a *recorded outcome*
 * rather than an exception, that attachments go up before the text, and that a token never
 * appears anywhere except the one header.
 */

import { describe, expect, it } from 'vitest';

import { createUnconfiguredMessageTransport } from './unconfigured.js';
import { createWhatsAppCloudTransport } from './whatsapp-cloud.js';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * The request body as a string, for the assertions that care what went on the wire.
 *
 * `RequestInit['body']` is a union that includes `FormData`, whose default stringification is
 * `[object FormData]` — useless in an assertion and, worse, one that would quietly pass a
 * `not.toContain('secret')` check. This narrows to the string case and fails loudly otherwise.
 */
function bodyText(call: Call): string {
  const body = call.init.body;
  if (typeof body !== 'string') {
    throw new Error('This call did not send a string body.');
  }
  return body;
}

function scriptedFetch(responses: readonly (Response | (() => Response))[]): {
  readonly impl: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(typeof next === 'function' ? next() : next!);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function transport(responses: readonly (Response | (() => Response))[]) {
  const { impl, calls } = scriptedFetch(responses);
  return {
    calls,
    port: createWhatsAppCloudTransport({
      accessToken: 'secret-token-value',
      phoneNumberId: '10203040',
      baseUrl: 'https://graph.example.test/v21.0',
      fetchImpl: impl,
    }),
  };
}

const TEXT_ONLY = {
  address: '+919876543210',
  body: 'You owe ₹900.',
  attachments: [],
  idempotencyKey: 'v1:whatsapp:p1:+919876543210:abc:def',
} as const;

describe('createWhatsAppCloudTransport', () => {
  it('sends the text and reports the provider id it came back with', async () => {
    const { port, calls } = transport([ok({ messages: [{ id: 'wamid.HBg' }] })]);

    const result = await port.send(TEXT_ONLY);

    expect(result).toEqual({
      accepted: true,
      providerMessageId: 'wamid.HBg',
      attachmentsSent: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://graph.example.test/v21.0/10203040/messages');
    const payload = JSON.parse(bodyText(calls[0]!)) as Record<string, unknown>;
    // The `+` is this ledger's canonical form; the Cloud API wants it without.
    expect(payload['to']).toBe('919876543210');
    expect(payload['text']).toEqual({ preview_url: false, body: 'You owe ₹900.' });
  });

  it('puts the access token in the Authorization header and nowhere else', async () => {
    const { port, calls } = transport([ok({ messages: [{ id: 'wamid.1' }] })]);
    await port.send(TEXT_ONLY);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer secret-token-value');
    expect(calls[0]!.url).not.toContain('secret-token-value');
    expect(bodyText(calls[0]!)).not.toContain('secret-token-value');
    expect(JSON.stringify(port.describe())).not.toContain('secret-token-value');
  });

  it('uploads each attachment before the text, and sends a document message for each', async () => {
    const { port, calls } = transport([
      ok({ id: 'media-1' }),
      ok({ messages: [{ id: 'wamid.2' }] }),
      ok({ messages: [{ id: 'wamid.3' }] }),
    ]);

    const result = await port.send({
      ...TEXT_ONLY,
      attachments: [
        {
          filename: 'receipt-ab12cd34.pdf',
          mediaType: 'application/pdf',
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    });

    expect(result.accepted).toBe(true);
    expect(result.attachmentsSent).toBe(1);
    expect(calls.map((call) => call.url)).toEqual([
      'https://graph.example.test/v21.0/10203040/media',
      'https://graph.example.test/v21.0/10203040/messages',
      'https://graph.example.test/v21.0/10203040/messages',
    ]);
    const document = JSON.parse(bodyText(calls[2]!)) as {
      document: { id: string; filename: string };
    };
    expect(document.document).toEqual({ id: 'media-1', filename: 'receipt-ab12cd34.pdf' });
  });

  it('sends nothing at all when an attachment upload fails', async () => {
    const { port, calls } = transport([
      new Response('{"error":{"message":"unsupported type"}}', { status: 400 }),
    ]);

    const result = await port.send({
      ...TEXT_ONLY,
      attachments: [
        { filename: 'r.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1]) },
      ],
    });

    // A bare message arriving without the proof it refers to is worse than no message.
    expect(result.accepted).toBe(false);
    expect(result.failureReason).toContain('400');
    expect(calls).toHaveLength(1);
  });

  it('turns a provider refusal into an outcome rather than an exception', async () => {
    const { port } = transport([new Response('not a valid number', { status: 401 })]);
    const result = await port.send(TEXT_ONLY);
    expect(result.accepted).toBe(false);
    expect(result.failureReason).toContain('401');
  });

  it('turns an unreachable host into an outcome too', async () => {
    const impl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const port = createWhatsAppCloudTransport({
      accessToken: 'k',
      phoneNumberId: '1',
      baseUrl: 'https://graph.example.test/v21.0',
      fetchImpl: impl,
    });
    const result = await port.send(TEXT_ONLY);
    expect(result.accepted).toBe(false);
    expect(result.failureReason).toContain('could not be reached');
  });

  it('refuses an accepted message that came back with no id, rather than recording an untraceable send', async () => {
    const { port } = transport([ok({ messages: [] })]);
    const result = await port.send(TEXT_ONLY);
    expect(result.accepted).toBe(false);
    expect(result.failureReason).toContain('no id');
  });

  it('refuses an oversized attachment before contacting the provider', async () => {
    const { port, calls } = transport([ok({ id: 'media-1' })]);
    const result = await port.send({
      ...TEXT_ONLY,
      attachments: [
        {
          filename: 'huge.pdf',
          mediaType: 'application/pdf',
          bytes: new Uint8Array(101 * 1024 * 1024),
        },
      ],
    });
    expect(result.accepted).toBe(false);
    expect(result.failureReason).toContain('limit');
    expect(calls).toHaveLength(0);
  });

  it('bounds a provider error body before it is recorded', async () => {
    const { port } = transport([new Response('x'.repeat(5_000), { status: 500 })]);
    const result = await port.send(TEXT_ONLY);
    expect(result.failureReason!.length).toBeLessThan(400);
  });

  it('describes itself without naming a credential', () => {
    const { port } = transport([ok({})]);
    expect(port.describe()).toEqual({
      transportId: 'whatsapp-cloud',
      channel: 'whatsapp',
      label: 'WhatsApp Cloud API',
      configured: true,
      supportsAttachments: true,
      endpointHost: 'graph.example.test',
      maxAttachmentBytes: 100 * 1024 * 1024,
    });
  });
});

describe('createUnconfiguredMessageTransport', () => {
  it('refuses by name rather than resolving as a success', async () => {
    const port = createUnconfiguredMessageTransport();
    const result = await port.send(TEXT_ONLY);
    expect(result.accepted).toBe(false);
    expect(result.failureReason).toContain('WHATSAPP_ACCESS_TOKEN');
    expect(result.failureReason).toContain('WHATSAPP_PHONE_NUMBER_ID');
  });

  it('reports itself unconfigured, so a screen can say so before anything is typed', () => {
    const capabilities = createUnconfiguredMessageTransport().describe();
    expect(capabilities.configured).toBe(false);
    expect(capabilities.supportsAttachments).toBe(false);
    expect(capabilities.unavailableReason).toContain('previewed, reviewed and copied');
  });
});
