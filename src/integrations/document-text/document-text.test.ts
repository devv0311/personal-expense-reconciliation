/**
 * The document-text extractors (audit row 14, ADR-0051).
 *
 * The assertions that matter here are the refusals. An unreadable receipt must never come back
 * looking like an empty one, and a document that can be read locally must never be uploaded.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildTextPdf } from '../../../tests/support/synthetic-pdf.js';

import { createDocumentTextExtractor } from './composite.js';
import { createLocalDocumentTextExtractor } from './local.js';
import { createVisionDocumentTextExtractor } from './vision.js';

const PDF = new Uint8Array(
  readFileSync(join(process.cwd(), 'fixtures', 'statements', 'bank-statement.pdf')),
);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * A PDF the dependency-free reader cannot decode and a standards-complete one can.
 *
 * Its content stream sits behind `/Filter [/ASCII85Decode /FlateDecode]` — an ordinary, legal
 * construction, and the shape a real issuer's generated statement has as far as the partial
 * reader is concerned. This is the document ADR-0051's ordering is really about: it is
 * readable locally, so it must never reach a provider.
 */
const LOCALLY_READABLE_ONLY_BY_PDFJS = buildTextPdf(
  ['SAMPLE CAFE', 'Item one 300.00', 'Total 860.50'],
  { filterChain: true },
);

/** A real PDF with no content stream at all — the shape of a scan. */
const SCANNED_PDF = buildTextPdf(['drawn as an image'], { withoutTextLayer: true });

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
    // A real PDF whose pages carry no content stream — the shape of a scan. The earlier stub
    // here (`%PDF-1.4\n%%EOF`) was a malformed file rather than a scan, which stopped being an
    // honest test of this case once a second local reader began decoding the structure.
    const result = await createLocalDocumentTextExtractor().extract({
      bytes: SCANNED_PDF,
      mediaType: 'application/pdf',
    });
    expect(result.text).toBeNull();
    expect(result.reason).toContain('no extractable text layer');
  });

  it('tells a malformed file apart from a scan, because the fixes differ', async () => {
    const result = await createLocalDocumentTextExtractor().extract({
      bytes: new TextEncoder().encode('%PDF-1.4\n%%EOF\n'),
      mediaType: 'application/pdf',
    });
    expect(result.text).toBeNull();
    expect(result.reason).toContain('structure could not be read');
  });

  it('declares that it cannot read images, and names the configuration that would', () => {
    const capabilities = createLocalDocumentTextExtractor().describe();
    expect(capabilities.readsPdfTextLayer).toBe(true);
    expect(capabilities.readsImages).toBe(false);
    expect(capabilities.imagesUnavailableReason).toContain('AI_DOCUMENT_VISION');
  });
});

describe('the local-first rule (ADR-0051)', () => {
  it('reads a PDF the partial reader rejects, rather than giving up on it locally', async () => {
    // The defect this covers: the local extractor used only the dependency-free reader, so a
    // perfectly readable bank PDF came back as "no text layer" — and on a vision-enabled
    // installation that answer is what sends the document to a provider.
    const result = await createLocalDocumentTextExtractor().extract({
      bytes: LOCALLY_READABLE_ONLY_BY_PDFJS,
      mediaType: 'application/pdf',
    });
    expect(result.source).toBe('pdf_text_layer');
    expect(result.model).toBeNull();
    expect(result.text).toContain('Total 860.50');
  });

  it('never uploads a PDF that is locally readable, even with vision configured', async () => {
    const stub = visionStub('should not be called');
    const extractor = createDocumentTextExtractor({
      vision: createVisionDocumentTextExtractor({
        apiKey: 'k',
        model: 'test-model',
        fetchImpl: stub.fetchImpl,
      }),
    });
    const result = await extractor.extract({
      bytes: LOCALLY_READABLE_ONLY_BY_PDFJS,
      mediaType: 'application/pdf',
    });
    expect(result.source).toBe('pdf_text_layer');
    expect(result.text).toContain('SAMPLE CAFE');
    // The assertion the whole ordering exists for.
    expect(stub.calls).toHaveLength(0);
  });

  it('still refuses a genuine scan by name when the opt-in is absent', async () => {
    // OCR policy is unchanged by the second local reader: an image-only PDF has no text layer
    // for either reader, and without AI_DOCUMENT_VISION it is a stated dead end.
    const extractor = createDocumentTextExtractor({
      visionUnavailableReason: 'Optical extraction is off. Set AI_DOCUMENT_VISION=true.',
    });
    const result = await extractor.extract({
      bytes: SCANNED_PDF,
      mediaType: 'application/pdf',
    });
    expect(result.text).toBeNull();
    expect(result.source).toBeNull();
    expect(result.reason).toContain('AI_DOCUMENT_VISION');
  });

  it('still lets a genuine scan reach vision when the opt-in is present', async () => {
    const stub = visionStub('SAMPLE CAFE\nTotal 860.50');
    const extractor = createDocumentTextExtractor({
      vision: createVisionDocumentTextExtractor({
        apiKey: 'k',
        model: 'test-model',
        fetchImpl: stub.fetchImpl,
      }),
    });
    const result = await extractor.extract({
      bytes: SCANNED_PDF,
      mediaType: 'application/pdf',
    });
    expect(result.source).toBe('model_vision');
    expect(result.model).toBe('test-model');
    expect(stub.calls).toHaveLength(1);
  });

  it('never quotes the document into the reason when neither local reader could read it', async () => {
    // A decode failure can carry a fragment of what it failed on, and that fragment is
    // somebody's receipt (`security-model.md`, the sixth pillar).
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('%PDF-1.4\n'),
      ...new TextEncoder().encode('MERCHANT SECRET 4821 CARDHOLDER NAME'),
    ]);
    const result = await createLocalDocumentTextExtractor().extract({
      bytes,
      mediaType: 'application/pdf',
    });
    expect(result.text).toBeNull();
    expect(result.reason).not.toContain('MERCHANT');
    expect(result.reason).not.toContain('4821');
    expect(result.reason).not.toContain('CARDHOLDER');
  });

  it('makes no network call while reading a document locally', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await createLocalDocumentTextExtractor().extract({
      bytes: LOCALLY_READABLE_ONLY_BY_PDFJS,
      mediaType: 'application/pdf',
    });
    expect(result.text).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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
