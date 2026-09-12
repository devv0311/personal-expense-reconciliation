/**
 * The local half of document text extraction: a generated PDF's own text layer, and nothing
 * else.
 *
 * This adapter never makes a network call and never sends a byte anywhere. It is always
 * available, needs no configuration, and is always tried first — a receipt emailed as a PDF is
 * read here, exactly, for free, with the document staying on the machine.
 *
 * It **refuses images by name.** There is no offline OCR engine in this repository's
 * dependency surface, and pretending otherwise — returning empty text for a photograph — would
 * make an unreadable receipt indistinguishable from a receipt with nothing on it. The refusal
 * names the configuration that would make it readable, which is `AI_DOCUMENT_VISION`
 * (ADR-0051).
 */

import { extractPdfText } from '../statement-formats/index.js';

import type {
  DocumentTextCapabilities,
  DocumentTextExtractor,
  DocumentTextResult,
  ExtractDocumentTextInput,
} from './port.js';

export const LOCAL_DOCUMENT_TEXT_ID = 'local-pdf-text-layer';

export function createLocalDocumentTextExtractor(): DocumentTextExtractor {
  return {
    describe(): DocumentTextCapabilities {
      return {
        id: LOCAL_DOCUMENT_TEXT_ID,
        readsPdfTextLayer: true,
        readsImages: false,
        imagesUnavailableReason:
          'This build has no local OCR engine, so a photographed or scanned receipt cannot be ' +
          'read on this machine. Set AI_DOCUMENT_VISION=true (with ANTHROPIC_API_KEY) to let a ' +
          'multimodal model read it instead — a deliberate widening of the local boundary, ' +
          'recorded in ADR-0051 — or type the receipt total and items by hand.',
      };
    },

    extract(input: ExtractDocumentTextInput): Promise<DocumentTextResult> {
      if (input.mediaType !== 'application/pdf') {
        return Promise.resolve({
          text: null,
          source: null,
          model: null,
          reason:
            `A ${input.mediaType} document is a picture, not text. This build reads a PDF's own ` +
            'text layer locally and has no offline OCR for images; nothing was read, and ' +
            'nothing was invented from the absence.',
        });
      }

      const extracted = extractPdfText(input.bytes);
      if (!extracted.hasTextLayer) {
        return Promise.resolve({
          text: null,
          source: null,
          model: null,
          reason:
            extracted.reason ??
            'This PDF has no extractable text layer — the normal shape of a scanned document.',
        });
      }
      return Promise.resolve({
        text: extracted.lines.join('\n'),
        source: 'pdf_text_layer',
        model: null,
      });
    },
  };
}
