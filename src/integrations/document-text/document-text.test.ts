/**
 * The document-text extractors (audit row 14, ADR-0051).
 *
 * The assertions that matter here are the refusals. An unreadable receipt must never come back
 * looking like an empty one, and a document that can be read locally must never be uploaded.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createDocumentTextExtractor } from './composite.js';
import { createLocalDocumentTextExtractor } from './local.js';
import { createVisionDocumentTextExtractor } from './vision.js';

const PDF = new Uint8Array(
  readFileSync(join(process.cwd(), 'fixtures', 'statements', 'bank-statement.pdf')),
);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function visionStub(text: string) {
  const calls: unknown[] = [];
  const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '{}';
    calls.push(JSON.parse(body));
    return Promise.resolve(
      new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 }),
    );
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('local extractor', () => {
  it('reads a generated PDF text layer without leaving the machine', async () => {
    const result = await createLocalDocumentTextExtractor().extract({
      bytes: PDF,
      mediaType: 'application/pdf',
    });
    expect(result.source).toBe('pdf_text_layer');
    expect(result.model).toBeNull();
    expect(result.text).toContain('SYNTHETIC BANK');
  });

  it('refuses an image by name rather than returning empty text', async () => {
    const result = await createLocalDocumentTextExtractor().extract({
      bytes: PNG,
      mediaType: 'image/png',
    });
    expect(result.text).toBeNull();
    expect(result.reason).toContain('picture, not text');
  });

  it('says a scanned PDF has no text layer', async () => {
    const scanned = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
    const result = await createLocalDocumentTextExtractor().extract({
      bytes: scanned,
      mediaType: 'application/pdf',
    });
    expect(result.text).toBeNull();
    expect(result.reason).toContain('no extractable text layer');
  });

  it('declares that it cannot read images, and names the configuration that would', () => {
    const capabilities = createLocalDocumentTextExtractor().describe();
    expect(capabilities.readsPdfTextLayer).toBe(true);
    expect(capabilities.readsImages).toBe(false);
    expect(capabilities.imagesUnavailableReason).toContain('AI_DOCUMENT_VISION');
  });
});

describe('vision extractor', () => {
  it('sends the document and returns the transcription with its model named', async () => {
    const stub = visionStub('SAMPLE CAFE\nTotal 860.50');
    const result = await createVisionDocumentTextExtractor({
      apiKey: 'k',
      model: 'test-model',
      fetchImpl: stub.fetchImpl,
    }).extract({ bytes: PNG, mediaType: 'image/png' });

    expect(result.source).toBe('model_vision');
    expect(result.model).toBe('test-model');
    expect(result.text).toContain('SAMPLE CAFE');

    const body = stub.calls[0] as { messages: { content: { type: string }[] }[] };
    expect(body.messages[0]?.content[0]?.type).toBe('image');
  });

  it('reports NO_TEXT_FOUND as unreadable, never as an empty receipt', async () => {
    const stub = visionStub('NO_TEXT_FOUND');
    const result = await createVisionDocumentTextExtractor({
      apiKey: 'k',
      model: 'test-model',
      fetchImpl: stub.fetchImpl,
    }).extract({ bytes: PNG, mediaType: 'image/png' });
    expect(result.text).toBeNull();
    expect(result.reason).toContain('different facts');
  });

  it('reports a provider failure as a reason rather than throwing', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('nope', { status: 500 })),
    ) as unknown as typeof fetch;
    const result = await createVisionDocumentTextExtractor({
      apiKey: 'k',
      model: 'test-model',
      fetchImpl,
    }).extract({ bytes: PNG, mediaType: 'image/png' });
    expect(result.text).toBeNull();
    expect(result.reason).toContain('500');
  });
});

describe('composite extractor', () => {
  it('reads a PDF locally even when vision is configured — the bytes never leave', async () => {
    const stub = visionStub('should not be called');
    const extractor = createDocumentTextExtractor({
      vision: createVisionDocumentTextExtractor({
        apiKey: 'k',
        model: 'test-model',
        fetchImpl: stub.fetchImpl,
      }),
    });
    const result = await extractor.extract({ bytes: PDF, mediaType: 'application/pdf' });
    expect(result.source).toBe('pdf_text_layer');
    expect(stub.calls).toHaveLength(0);
  });

  it('falls back to vision only for a document with no text of its own', async () => {
    const stub = visionStub('SAMPLE CAFE');
    const extractor = createDocumentTextExtractor({
      vision: createVisionDocumentTextExtractor({
        apiKey: 'k',
        model: 'test-model',
        fetchImpl: stub.fetchImpl,
      }),
    });
    const result = await extractor.extract({ bytes: PNG, mediaType: 'image/png' });
    expect(result.source).toBe('model_vision');
    expect(stub.calls).toHaveLength(1);
  });

  it('refuses an image with a reason naming the configuration when vision is off', async () => {
    const extractor = createDocumentTextExtractor({
      visionUnavailableReason: 'Optical extraction is off. Set AI_DOCUMENT_VISION=true.',
    });
    const result = await extractor.extract({ bytes: PNG, mediaType: 'image/png' });
    expect(result.text).toBeNull();
    expect(result.reason).toContain('AI_DOCUMENT_VISION');
    expect(extractor.describe().readsImages).toBe(false);
  });

  it('does not upload a format the provider cannot read', async () => {
    const stub = visionStub('x');
    const extractor = createDocumentTextExtractor({
      vision: createVisionDocumentTextExtractor({
        apiKey: 'k',
        model: 'test-model',
        fetchImpl: stub.fetchImpl,
      }),
    });
    const result = await extractor.extract({
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: 'image/heic',
    });
    expect(result.text).toBeNull();
    expect(result.reason).toContain('not a format the transcription provider accepts');
    expect(stub.calls).toHaveLength(0);
  });
});
