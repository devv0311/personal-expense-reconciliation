/**
 * Optical extraction by a multimodal model — the **opt-in** half of document text extraction
 * (ADR-0051).
 *
 * This is the only place in the repository where a document's bytes leave the local boundary,
 * and everything about it is arranged so that fact stays visible:
 *
 *  - It exists only when `AI_DOCUMENT_VISION=true` is set alongside `ANTHROPIC_API_KEY`.
 *    `src/server.ts` composes the refusing extractor otherwise, and the refusal names the
 *    configuration rather than returning empty text.
 *  - It transcribes and **only** transcribes. The prompt asks for the visible characters and
 *    nothing else — no totals, no items, no interpretation. Reading what the receipt *means*
 *    stays with `ai.parseReceipt`/`ai.extractReceiptItems` over the returned text, which are
 *    already redacted, already validated, and already produce proposals a person decides on.
 *  - What comes back is text, and it is treated as untrusted text: it is redacted by
 *    `redactReceiptEvidenceForInference` before the extraction operations see it, exactly as a
 *    hand-typed `rawText` would be.
 *  - The model that read the document is returned and recorded on the `Receipt`, so a person
 *    confirming extracted items can see that a photograph was read by a model, and which one.
 *
 * What it deliberately does not do: send anything but the document, keep a copy, or make the
 * result authoritative. A `Receipt` extracted this way is `confirmed_by_user = false` like any
 * other, and every amount on it is still a proposal.
 */

import type { EvidenceMediaType } from '../../domain/index.js';

import type {
  DocumentTextCapabilities,
  DocumentTextExtractor,
  DocumentTextResult,
  ExtractDocumentTextInput,
} from './port.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
/** A receipt's text is short. This bounds a runaway response, not the document. */
const MAX_OUTPUT_TOKENS = 4096;
/** Bytes past this are refused rather than uploaded: a receipt photo is not 12 MB. */
export const MAX_VISION_DOCUMENT_BYTES = 12 * 1024 * 1024;

const TRANSCRIPTION_PROMPT = [
  'You transcribe one document image for a personal expense ledger.',
  '',
  'Return the visible text of the document, verbatim, preserving line order. Return plain',
  'text and nothing else — no JSON, no markdown, no commentary, no summary.',
  '',
  'Rules:',
  '- Transcribe only what is printed. Do not compute a total, do not correct an arithmetic',
  '  error, and do not add a line the document does not have. Something you infer and',
  '  something the receipt says are different claims, and only one of them is evidence.',
  '- If a character is unreadable, write it as "?" rather than guessing at it.',
  '- If the image contains no text at all, return exactly: NO_TEXT_FOUND',
].join('\n');

export interface VisionDocumentTextOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export const VISION_DOCUMENT_TEXT_ID = 'anthropic-vision-transcription';

export function createVisionDocumentTextExtractor(
  options: VisionDocumentTextOptions,
): DocumentTextExtractor {
  const baseUrl = options.baseUrl ?? ANTHROPIC_API_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 90_000;

  return {
    describe(): DocumentTextCapabilities {
      return { id: VISION_DOCUMENT_TEXT_ID, readsPdfTextLayer: false, readsImages: true };
    },

    async extract(input: ExtractDocumentTextInput): Promise<DocumentTextResult> {
      if (input.bytes.byteLength > MAX_VISION_DOCUMENT_BYTES) {
        return {
          text: null,
          source: null,
          model: null,
          reason:
            `This document is ${input.bytes.byteLength} bytes, past the ` +
            `${MAX_VISION_DOCUMENT_BYTES}-byte bound on what is sent for transcription. It was ` +
            'not uploaded.',
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await doFetch(baseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: options.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: TRANSCRIPTION_PROMPT,
            messages: [
              {
                role: 'user',
                content: [documentBlock(input.mediaType, toBase64(input.bytes))],
              },
            ],
          }),
        });
      } catch (error) {
        const reason = controller.signal.aborted
          ? `no response within ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'unknown network failure';
        return {
          text: null,
          source: null,
          model: null,
          reason: `The transcription provider could not be reached: ${reason}.`,
        };
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        return {
          text: null,
          source: null,
          model: null,
          reason: `The transcription provider returned ${response.status}. ${detail}`,
        };
      }

      const body: unknown = await response.json().catch(() => null);
      const text = firstTextBlock(body);
      if (text === null || text.trim() === '' || text.trim() === 'NO_TEXT_FOUND') {
        return {
          text: null,
          source: null,
          model: options.model,
          reason:
            'The model found no text in this document. Nothing was recorded: an unreadable ' +
            'receipt and an empty one are different facts.',
        };
      }
      return { text: text.trim(), source: 'model_vision', model: options.model };
    },
  };
}

/* ------------------------------------------------------------------------- internals */

/**
 * The content block for one document.
 *
 * A PDF and an image are different block types on the Messages API, and `image/heic` is not a
 * type the API accepts — it is refused here rather than uploaded and rejected remotely, so the
 * bytes of a document this build cannot get read never leave the machine at all.
 */
function documentBlock(mediaType: EvidenceMediaType, data: string): unknown {
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: mediaType, data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

export function isVisionReadableMediaType(mediaType: EvidenceMediaType): boolean {
  return mediaType !== 'image/heic';
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function firstTextBlock(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}
