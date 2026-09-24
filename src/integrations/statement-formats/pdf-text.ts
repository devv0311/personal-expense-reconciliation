/**
 * Lifts the text layer out of a PDF, and says so honestly when there is not one.
 *
 * The audit's row 02 named PDF transaction extraction as unbuilt, and row 14 named the related
 * failure: storing a PDF as evidence is not the same as reading it. This module is the reading
 * half for the ordinary case — a statement a bank *generated*, which carries real text drawn
 * with `Tj`/`TJ` operators inside Flate-compressed content streams.
 *
 * **What it cannot do, and reports rather than guesses:** a scanned PDF — a photograph of
 * paper wrapped in a PDF container — has no text layer at all. This returns
 * `{ hasTextLayer: false }` for one, and every caller treats that as "this document needs
 * optical extraction" rather than "this statement had no transactions". The two answers look
 * identical if you only count rows, which is precisely why they are different return values.
 *
 * **The bounded reader below has no dependency**, for the same reason as `xlsx.ts`:
 * `node:zlib` inflates the streams and the operators that place text are a small grammar. A
 * PDF parser is a large attack surface, and this reader is deliberately partial, total, and
 * bounded — it never executes anything it reads, never follows an external reference, and
 * gives up rather than guessing. The standards-complete reader later in this module uses
 * `pdfjs-dist`; ADR-0058 records that separate tradeoff.
 */

import { inflateSync } from 'node:zlib';

import type { PDFDocumentLoadingTask } from 'pdfjs-dist';

/** Bounds the work a single document can cause. A bank statement is not 64 MB of text. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_LENGTH = 8 * 1024 * 1024;

/**
 * What the PDF.js reader will not do for a document, whatever the document asks for.
 *
 * Every one of these is a refusal with a stated reason rather than a truncation, because a
 * statement read halfway is the one outcome worse than a statement not read at all: it looks
 * like a complete import of a shorter month. A hostile or simply broken PDF can ask for
 * unbounded work in four different ways, and each gets its own bound:
 *
 *  - `MAX_PDF_BYTES` — the file itself, checked before PDF.js is handed anything.
 *  - `MAX_PDF_PAGES` — a page count no personal statement reaches.
 *  - `MAX_PDF_LINES` — a line count no personal statement reaches, since a page may draw
 *    text items without ever ending a line.
 *  - `MAX_PDF_LINE_LENGTH` — one line's own buffer, since `hasEOL` is the document's claim
 *    rather than ours and a document that never makes it would otherwise grow one string
 *    without limit.
 */
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_PDF_PAGES = 250;
const MAX_PDF_LINES = 200_000;
const MAX_PDF_LINE_LENGTH = 64 * 1024;

export interface PdfTextResult {
  /**
   * `false` when the document contains no extractable text — an image-only scan, or an
   * encoding this reader does not implement. Never conflated with "no transactions".
   */
  readonly hasTextLayer: boolean;
  /** The extracted lines, in document order, with runs of whitespace collapsed. */
  readonly lines: readonly string[];
  /**
   * Where each line's words sat on the page, one entry per entry in `lines`.
   *
   * Only the standards-complete reader knows positions, so only it fills this in. A layout that
   * reads a statement by column — an amount printed under "Withdrawal" is a debit, one under
   * "Deposit" a credit — needs it, because a PDF's text alone does not say which of two empty
   * cells a number was printed in (ADR-0066).
   */
  readonly layout?: readonly PdfLineLayout[];
  /** Why extraction produced nothing, when it did. */
  readonly reason?: string;
}

/** One line of extracted text, as positioned words. */
export interface PdfLineLayout {
  /** 1-based page the line was drawn on. */
  readonly page: number;
  /** The line's non-blank text items, in document order. */
  readonly items: readonly PdfTextItem[];
}

/** One text item as PDF.js placed it, in PDF user-space units from the page's left edge. */
export interface PdfTextItem {
  readonly text: string;
  readonly left: number;
  /** `left` plus the width PDF.js measured for the item. */
  readonly right: number;
}

/**
 * Extracts the visible text of a PDF as lines.
 *
 * Never throws for a malformed document: a file this cannot read is reported as
 * `hasTextLayer: false` with a reason, because the caller's next step (offer optical
 * extraction, or ask for a CSV) is the same either way and a stack trace helps nobody.
 */
export function extractPdfText(bytes: Uint8Array): PdfTextResult {
  if (!startsWithPdfHeader(bytes)) {
    return {
      hasTextLayer: false,
      lines: [],
      reason: 'These bytes do not begin with a %PDF- header, so this is not a PDF.',
    };
  }

  let text = '';
  try {
    for (const stream of contentStreams(bytes)) {
      text += extractTextOperators(stream);
      if (text.length > MAX_TEXT_LENGTH) break;
    }
  } catch (error) {
    return {
      hasTextLayer: false,
      lines: [],
      reason: `This PDF could not be decoded: ${error instanceof Error ? error.message : 'unknown failure'}.`,
    };
  }

  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      hasTextLayer: false,
      lines: [],
      reason:
        'This PDF has no extractable text layer. That is the normal shape of a scanned or ' +
        'photographed document: it contains an image of the page, not its characters. Nothing ' +
        'was read from it, and no transaction was invented from the absence.',
    };
  }
  return { hasTextLayer: true, lines };
}

/**
 * Extracts a PDF's text with PDF.js.
 *
 * The bounded reader above deliberately implements only simple PDF text operators. Real bank
 * PDFs often use embedded font maps and object streams, so visible text can be present while
 * that reader honestly reports an encoding it cannot decode. Statement import uses this
 * standards-complete local reader.
 *
 * **It stays behind the local boundary, and the options say so rather than relying on it.**
 * `isEvalSupported: false` stops PDF.js compiling anything the document contains;
 * `useWorkerFetch: false`, `useSystemFonts: false` and an unset `cMapUrl`/`standardFontDataUrl`
 * leave it with nothing to fetch. No document byte leaves this process, on any path through
 * this function, and none is written to a log — a failure is reported as a *reason*, never as
 * the text that failed (`security-model.md`, the sixth pillar).
 *
 * **Never throws, and never returns half a statement.** Every bound below refuses the whole
 * document with a stated cause instead of returning the pages it managed, because a truncated
 * statement is indistinguishable from a complete one downstream — and would import as a real
 * month that quietly stops in the middle.
 */
export async function extractPdfTextWithPdfJs(bytes: Uint8Array): Promise<PdfTextResult> {
  if (!startsWithPdfHeader(bytes)) {
    return {
      hasTextLayer: false,
      lines: [],
      reason: 'These bytes do not begin with a %PDF- header, so this is not a PDF.',
    };
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return {
      hasTextLayer: false,
      lines: [],
      reason:
        `This PDF is ${Math.round(bytes.byteLength / (1024 * 1024))} MB; the local statement ` +
        `reader is limited to ${MAX_PDF_BYTES / (1024 * 1024)} MB.`,
    };
  }

  let loadingTask: PDFDocumentLoadingTask | undefined;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    loadingTask = getDocument({
      // PDF.js may transfer the buffer to its worker. Keep the caller's evidence bytes intact.
      data: bytes.slice(),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0,
    });
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      return {
        hasTextLayer: false,
        lines: [],
        reason: `This PDF has ${document.numPages} pages; the local statement reader is limited to ${MAX_PDF_PAGES}.`,
      };
    }

    const lines: string[] = [];
    const layout: PdfLineLayout[] = [];
    let textLength = 0;
    /** Refuses the document rather than keeping the part that fit. */
    const tooMuchText = (): PdfTextResult => ({
      hasTextLayer: false,
      lines: [],
      reason: 'This PDF contains more text than the local statement reader permits.',
    });

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent({ includeMarkedContent: false });
        let current = '';
        // The positioned words of `current`, kept in step with it so `layout[i]` always
        // describes `lines[i]`. Bounded by the same line-length check, since every item added
        // here also adds its text to `current`.
        let currentItems: PdfTextItem[] = [];
        for (const item of content.items) {
          if (!('str' in item)) continue;
          // `hasEOL` is the document's claim about where a line ends, so a document that never
          // makes it must not be able to grow one unbounded string.
          if (current.length + item.str.length > MAX_PDF_LINE_LENGTH) return tooMuchText();
          current += item.str;
          if (item.str.trim() !== '') {
            // PDF.js types the transform loosely; it is a 6-number matrix whose fifth entry is
            // the item's x position, in the same units as its width.
            const left = (item.transform as readonly number[])[4] ?? 0;
            currentItems.push({ text: item.str, left, right: left + item.width });
          }
          if (!item.hasEOL) continue;
          const line = normaliseExtractedLine(current);
          const items = currentItems;
          current = '';
          currentItems = [];
          if (line === '') continue;
          if (lines.length >= MAX_PDF_LINES || textLength + line.length > MAX_TEXT_LENGTH) {
            return tooMuchText();
          }
          lines.push(line);
          layout.push({ page: pageNumber, items });
          textLength += line.length;
        }
        const trailing = normaliseExtractedLine(current);
        if (trailing !== '') {
          if (lines.length >= MAX_PDF_LINES || textLength + trailing.length > MAX_TEXT_LENGTH) {
            return tooMuchText();
          }
          lines.push(trailing);
          layout.push({ page: pageNumber, items: currentItems });
          textLength += trailing.length;
        }
      } finally {
        // Runs even when `getTextContent` threw, so one unreadable page cannot leak the
        // rendering buffers of every page before it.
        page.cleanup();
      }
    }

    if (lines.length === 0) {
      return {
        hasTextLayer: false,
        lines: [],
        reason:
          'This PDF has no extractable text layer. It may be a scan or photograph rather ' +
          'than a generated statement. Nothing was read and no transaction was invented.',
      };
    }
    return { hasTextLayer: true, lines, layout };
  } catch (error) {
    return { hasTextLayer: false, lines: [], reason: describePdfFailure(error) };
  } finally {
    // Releases the worker and the document's buffers on every path, including the refusals
    // above, which return from inside the `try`.
    await loadingTask?.destroy();
  }
}

/**
 * Why a PDF could not be read, in terms of what the person holding it can do next.
 *
 * A password-protected document gets its own sentence because it is the common case for a card
 * statement, and the generic "could not be decoded" would send somebody looking for a corrupt
 * file. **The document's own text is never quoted into the reason** — a decode failure can
 * carry a fragment of the content it failed on, and that fragment is somebody's statement or
 * receipt (`security-model.md`, the sixth pillar).
 *
 * The wording stays neutral about *what* was being read, because this reader has two callers
 * with different next steps: statement import, and the receipt evidence path's local
 * extractor. Neither may claim the other's outcome.
 */
function describePdfFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') {
    return (
      'This PDF is password-protected, so nothing could be read from it. Save an unlocked copy ' +
      'from your bank or PDF viewer and use that instead, or supply the statement as CSV or XLSX.'
    );
  }
  if (name === 'InvalidPDFException') {
    return (
      'This file claims to be a PDF but its structure could not be read, so nothing was read ' +
      'from it and nothing was inferred from the absence.'
    );
  }
  return (
    'This PDF could not be decoded locally, so nothing was read from it and nothing was ' +
    'inferred from the absence.'
  );
}

function normaliseExtractedLine(value: string): string {
  return value.replace(/[ \t]+/g, ' ').trim();
}

/* ------------------------------------------------------------------------- internals */

function startsWithPdfHeader(bytes: Uint8Array): boolean {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  return header.startsWith('%PDF-');
}

/**
 * Every `stream … endstream` body in the file, inflated where it is Flate-encoded.
 *
 * Deliberately a linear scan rather than a cross-reference-table walk: statements are single
 * linear documents, an xref walk needs object resolution this module has no reason to
 * implement, and a scan cannot be led anywhere by a malformed offset. Streams that are not
 * text content (fonts, images, metadata) simply yield no text operators.
 */
function* contentStreams(bytes: Uint8Array): Generator<string> {
  const latin1 = new TextDecoder('latin1');
  const haystack = latin1.decode(bytes);
  const streamToken = 'stream';
  let cursor = 0;

  while (cursor < haystack.length) {
    const start = haystack.indexOf(streamToken, cursor);
    if (start === -1) return;
    const end = haystack.indexOf('endstream', start);
    if (end === -1) return;

    // The dictionary preceding `stream` says how the bytes are encoded.
    const dictionaryStart = haystack.lastIndexOf('<<', start);
    const dictionary = dictionaryStart === -1 ? '' : haystack.slice(dictionaryStart, start);

    // `stream` is followed by CRLF or LF before the data begins.
    let dataStart = start + streamToken.length;
    if (haystack[dataStart] === '\r') dataStart += 1;
    if (haystack[dataStart] === '\n') dataStart += 1;

    const raw = bytes.subarray(dataStart, end);
    cursor = end + 'endstream'.length;

    if (raw.length === 0 || raw.length > MAX_STREAM_BYTES) continue;

    if (/\/Filter\s*(?:\[[^\]]*)?\/FlateDecode/.test(dictionary)) {
      try {
        yield latin1.decode(inflateSync(raw, { maxOutputLength: MAX_STREAM_BYTES }));
      } catch {
        // A stream that will not inflate is skipped rather than failing the document: an
        // object stream or a corrupt font should not stop the pages that did decode.
        continue;
      }
      continue;
    }
    if (!/\/Filter/.test(dictionary)) {
      yield latin1.decode(raw);
    }
    // Any other filter (DCTDecode, CCITTFaxDecode, …) is image data by definition; skipped.
  }
}

/**
 * Reads the text-placing operators out of one content stream.
 *
 * `Tj` draws a string; `TJ` draws an array of strings with kerning numbers between them;
 * `'` and `"` draw a string on a new line. `Td`/`TD`/`T*`/`ET` move to a new line, which is
 * how a line break is recovered from a format that has no line breaks.
 */
function extractTextOperators(stream: string): string {
  let output = '';
  let index = 0;

  while (index < stream.length) {
    const char = stream[index]!;

    if (char === '(') {
      const { value, next } = readLiteralString(stream, index);
      const operator = peekOperator(stream, next);
      output += value;
      if (operator === "'" || operator === '"') output += '\n';
      index = next;
      continue;
    }
    if (char === '<' && stream[index + 1] !== '<') {
      const close = stream.indexOf('>', index);
      if (close === -1) break;
      output += readHexString(stream.slice(index + 1, close));
      index = close + 1;
      continue;
    }
    // Line-positioning operators, matched on a word boundary so `Td` inside a name is ignored.
    if (
      (char === 'T' &&
        (stream[index + 1] === 'd' || stream[index + 1] === 'D' || stream[index + 1] === '*')) ||
      (char === 'E' && stream[index + 1] === 'T')
    ) {
      output += '\n';
      index += 2;
      continue;
    }
    index += 1;
  }
  return output;
}

/** Reads a `( … )` literal, honouring escapes and nested parentheses. */
function readLiteralString(stream: string, openIndex: number): { value: string; next: number } {
  let value = '';
  let depth = 1;
  let index = openIndex + 1;

  while (index < stream.length && depth > 0) {
    const char = stream[index]!;
    if (char === '\\') {
      const escaped = stream[index + 1];
      index += 2;
      switch (escaped) {
        case 'n':
          value += '\n';
          break;
        case 'r':
          value += '\r';
          break;
        case 't':
          value += '\t';
          break;
        case 'b':
        case 'f':
          break;
        case '\n':
          break;
        default:
          if (escaped !== undefined && escaped >= '0' && escaped <= '7') {
            let octal = escaped;
            while (octal.length < 3) {
              const digit = stream[index];
              if (digit === undefined || digit < '0' || digit > '7') break;
              octal += digit;
              index += 1;
            }
            value += String.fromCharCode(Number.parseInt(octal, 8));
            break;
          }
          value += escaped ?? '';
      }
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      index += 1;
      if (depth === 0) break;
      value += char;
      continue;
    }
    value += char;
    index += 1;
  }
  return { value, next: index };
}

/** The operator immediately after a string, so `'` and `"` can end the line they drew. */
function peekOperator(stream: string, from: number): string | null {
  let index = from;
  while (index < stream.length && /\s/.test(stream[index]!)) index += 1;
  const char = stream[index];
  return char === "'" || char === '"' ? char : null;
}

/** A `<…>` hex string. Two hex digits per character; an odd trailing digit pads with `0`. */
function readHexString(body: string): string {
  const digits = body.replace(/[^0-9a-fA-F]/g, '');
  const padded = digits.length % 2 === 0 ? digits : `${digits}0`;
  let value = '';
  for (let index = 0; index < padded.length; index += 2) {
    const code = Number.parseInt(padded.slice(index, index + 2), 16);
    // PDF hex strings in a statement are Latin-1 or a simple font encoding; a control byte is
    // decoration rather than text and is dropped instead of corrupting the line.
    if (code >= 32) value += String.fromCharCode(code);
  }
  return value;
}
