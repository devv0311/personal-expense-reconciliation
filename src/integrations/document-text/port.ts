/**
 * The document-text port: turning a stored receipt's **bytes** into text the ledger can read.
 *
 * The audit's row 14 named this precisely: *"`extractReceipt` passes evidence type, media
 * type, `rawText` and `capturedAt`; it does not read document bytes from `EvidenceStore`.
 * Uploading an image alone is not a working receipt-extraction pipeline."* This port is the
 * missing step, and it is a port rather than a function because the two ways to take text off
 * a document have completely different privacy properties:
 *
 *  - **A generated PDF carries its own text.** Reading it is local, deterministic, free, and
 *    nothing leaves the machine. This is always tried first.
 *  - **A photograph does not.** Reading one needs optical character recognition, and the only
 *    OCR available to this build is a multimodal model — which means the document's bytes
 *    leaving the local boundary. `security-model.md` forbids that by default and
 *    ADR-0051 makes it an explicit, configured, opt-in decision. An installation that has not
 *    opted in gets a refusal naming the missing configuration, never a silent empty result.
 *
 * The distinction is carried in the result, not lost in it: everything downstream can tell
 * whether the words in front of it came off the document's own text layer or out of a model
 * reading a picture, and a `Receipt` records which (`receipts.text_source`).
 */

import type { DocumentTextSource, EvidenceMediaType } from '../../domain/index.js';

// `DocumentTextSource` lives in `src/domain/enums.ts` with every other closed value set, so
// the `receipts.text_source` CHECK and this port cannot drift apart. Re-exported here because
// this is the module a reader arrives at when following the extraction path.
export type { DocumentTextSource };

export interface DocumentTextResult {
  /** The extracted text, or `null` when nothing could be read. */
  readonly text: string | null;
  readonly source: DocumentTextSource | null;
  /**
   * Which model produced it, when a model did.
   *
   * Recorded on the `Receipt` so a person confirming extracted items can see that a model
   * read the photograph, and which one — the same provenance requirement every other
   * proposal carries (`ai-boundary.md`).
   */
  readonly model: string | null;
  /**
   * Why nothing was read, when nothing was.
   *
   * Always populated on a `null` text, and always distinguishes "this build cannot read this
   * kind of document" from "this document had no text in it". Conflating them is how a
   * scanned receipt comes to look like an empty one.
   */
  readonly reason?: string;
}

/** What an extractor can do, so a screen can say so before a person uploads anything. */
export interface DocumentTextCapabilities {
  readonly id: string;
  /** Reading a generated PDF's text layer. Always available: it needs nothing configured. */
  readonly readsPdfTextLayer: boolean;
  /** Optical extraction from a photograph. Off unless explicitly configured (ADR-0051). */
  readonly readsImages: boolean;
  /** Why image extraction is unavailable, when it is. */
  readonly imagesUnavailableReason?: string;
}

export interface ExtractDocumentTextInput {
  readonly bytes: Uint8Array;
  readonly mediaType: EvidenceMediaType;
}

export interface DocumentTextExtractor {
  describe(): DocumentTextCapabilities;
  extract(input: ExtractDocumentTextInput): Promise<DocumentTextResult>;
}
