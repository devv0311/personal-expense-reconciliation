/**
 * The local half of document text extraction: a generated PDF's own text layer, and nothing
 * else.
 *
 * This adapter never makes a network call and never sends a byte anywhere. It is always
 * available, needs no configuration, and is always tried first — a receipt emailed as a PDF is
 * read here, exactly, for free, with the document staying on the machine.
 *
 * **Two local readers, tried in order, and the order is a privacy decision.** ADR-0051's rule
 * is that a document which *can* be read locally never reaches a provider. Honouring that
 * means trying every local reader before giving up, not just the cheapest one:
 *
 *  - `extractPdfText` is dependency-free and implements a deliberately partial grammar. It is
 *    tried first because it costs nothing and answers the ordinary case.
 *  - `extractPdfTextWithPdfJs` is standards-complete, and reads the embedded font maps and
 *    object streams a real issuer's generated PDF uses. It is tried second.
 *
 * Trying only the first was a live privacy defect rather than a missing feature: a bank or
 * card PDF the partial reader cannot decode still has a perfectly good text layer, so an
 * installation with `AI_DOCUMENT_VISION=true` would have uploaded a readable statement to a
 * multimodal provider — the exact thing ADR-0051's ordering exists to prevent.
 *
 * It **refuses images by name.** There is no offline OCR engine in this repository's
 * dependency surface, and pretending otherwise — returning empty text for a photograph — would
 * make an unreadable receipt indistinguishable from a receipt with nothing on it. The refusal
 * names the configuration that would make it readable, which is `AI_DOCUMENT_VISION`
 * (ADR-0051). **OCR policy is unchanged by the second reader**: a genuine image-only PDF still
 * has no text layer, still reaches vision only under the existing opt-in, and is still refused
 * by name without it.
 */

// Imported from the modules themselves rather than the package barrel: `local.ts` needs two
// readers, not the statement parser, and a barrel import is how a cycle starts.
import { extractPdfText, extractPdfTextWithPdfJs } from '../statement-formats/pdf-text.js';

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

    async extract(input: ExtractDocumentTextInput): Promise<DocumentTextResult> {
      if (input.mediaType !== 'application/pdf') {
        return {
          text: null,
          source: null,
          model: null,
          reason:
            `A ${input.mediaType} document is a picture, not text. This build reads a PDF's own ` +
            'text layer locally and has no offline OCR for images; nothing was read, and ' +
            'nothing was invented from the absence.',
        };
      }

      const bounded = extractPdfText(input.bytes);
      if (bounded.hasTextLayer) {
        return { text: bounded.lines.join('\n'), source: 'pdf_text_layer', model: null };
      }

      // The partial reader found nothing. Before this document is allowed anywhere near a
      // provider, the standards-complete local reader gets its turn.
      const complete = await extractPdfTextWithPdfJs(input.bytes);
      if (complete.hasTextLayer) {
        return { text: complete.lines.join('\n'), source: 'pdf_text_layer', model: null };
      }

      return {
        text: null,
        source: null,
        model: null,
        // The second reader's reason is the more informed one — it is the one that decoded the
        // document's structure — and, like the first, it is a fixed sentence that never quotes
        // the document back (`security-model.md`, the sixth pillar).
        reason:
          complete.reason ??
          bounded.reason ??
          'This PDF has no extractable text layer — the normal shape of a scanned document.',
      };
    },
  };
}
