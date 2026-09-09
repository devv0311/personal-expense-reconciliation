/**
 * A scripted {@link DocumentTextExtractor}, for the same reason `tests/support/ai.ts` exists:
 * the real adapters have their own unit tests
 * (`src/integrations/document-text/document-text.test.ts`), and everything above them should
 * be exercised without a network call.
 *
 * The default answers as an optical read would — `model_vision`, with a model named — because
 * that is the interesting case: a photographed receipt whose text exists nowhere until
 * something reads it, and whose provenance a person confirming the extraction must be able to
 * see (`receipts.text_source`).
 */

import type {
  DocumentTextCapabilities,
  DocumentTextExtractor,
  DocumentTextResult,
  DocumentTextSource,
} from '../../src/integrations/document-text/index.js';

export interface StubDocumentTextExtractor extends DocumentTextExtractor {
  /** Every document this extractor was asked to read, in order. */
  readonly asked: readonly { readonly mediaType: string; readonly byteSize: number }[];
}

export interface StubDocumentTextOptions {
  /** What to return. `null` makes the extractor refuse, which is the case worth testing. */
  readonly text?: string | null;
  readonly source?: DocumentTextSource;
  readonly model?: string | null;
  readonly reason?: string;
}

export function createStubDocumentTextExtractor(
  options: StubDocumentTextOptions = {},
): StubDocumentTextExtractor {
  const asked: { mediaType: string; byteSize: number }[] = [];
  const text = options.text === undefined ? 'SAMPLE MERCHANT\nTOTAL 1240.00' : options.text;
  const source = options.source ?? 'model_vision';
  const model = options.model === undefined ? 'stub-vision-model' : options.model;

  return {
    asked,
    describe(): DocumentTextCapabilities {
      return { id: 'stub-document-text', readsPdfTextLayer: true, readsImages: true };
    },
    extract(input): Promise<DocumentTextResult> {
      asked.push({ mediaType: input.mediaType, byteSize: input.bytes.byteLength });
      if (text === null) {
        return Promise.resolve({
          text: null,
          source: null,
          model: null,
          reason: options.reason ?? 'This stub was configured to refuse.',
        });
      }
      return Promise.resolve({ text, source, model: source === 'model_vision' ? model : null });
    },
  };
}
