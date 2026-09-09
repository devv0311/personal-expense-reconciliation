/**
 * The extractor the ledger actually uses: local first, model second, honest refusal last.
 *
 * The order is a privacy decision rather than a performance one. A generated PDF's own text
 * layer is read on this machine, so a document that can be read locally **never** reaches a
 * provider — even on an installation that has opted into vision. Only a document with no text
 * layer of its own (a photograph, a scan) is considered for transcription, and only when
 * ADR-0051's opt-in is configured.
 *
 * The refusing case is a first-class result, not an error: an installation that has not opted
 * in gets a reason naming the configuration, so a person reads "this build cannot read a
 * photographed receipt; here is how to change that, or type it in" rather than "extraction
 * produced nothing".
 */

import type {
  DocumentTextCapabilities,
  DocumentTextExtractor,
  DocumentTextResult,
  ExtractDocumentTextInput,
} from './port.js';
import { createLocalDocumentTextExtractor } from './local.js';
import { isVisionReadableMediaType } from './vision.js';

export interface CompositeDocumentTextOptions {
  /** Present only when ADR-0051's opt-in is configured. */
  readonly vision?: DocumentTextExtractor;
  /** Why vision is unavailable, when it is. Shown to a person, so it names the fix. */
  readonly visionUnavailableReason?: string;
}

export const COMPOSITE_DOCUMENT_TEXT_ID = 'local-then-vision';

export function createDocumentTextExtractor(
  options: CompositeDocumentTextOptions = {},
): DocumentTextExtractor {
  const local = createLocalDocumentTextExtractor();

  return {
    describe(): DocumentTextCapabilities {
      const reason =
        options.visionUnavailableReason ??
        local.describe().imagesUnavailableReason ??
        'Image extraction is not configured.';
      return {
        id: COMPOSITE_DOCUMENT_TEXT_ID,
        readsPdfTextLayer: true,
        readsImages: options.vision !== undefined,
        ...(options.vision === undefined ? { imagesUnavailableReason: reason } : {}),
      };
    },

    async extract(input: ExtractDocumentTextInput): Promise<DocumentTextResult> {
      const localResult = await local.extract(input);
      if (localResult.text !== null) return localResult;

      if (options.vision === undefined) {
        return {
          text: null,
          source: null,
          model: null,
          reason:
            options.visionUnavailableReason ??
            localResult.reason ??
            'No text could be read from this document, and optical extraction is not configured.',
        };
      }
      if (!isVisionReadableMediaType(input.mediaType)) {
        return {
          text: null,
          source: null,
          model: null,
          reason:
            `A ${input.mediaType} document is not a format the transcription provider accepts, ` +
            'so its bytes were not uploaded. Re-save the receipt as JPEG, PNG, WebP or PDF.',
        };
      }
      return options.vision.extract(input);
    },
  };
}
