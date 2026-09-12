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
 * **No dependency**, for the same reason as `xlsx.ts`: `node:zlib` inflates the streams and
 * the operators that place text are a small grammar. A PDF parser is a large attack surface,
 * and this one is deliberately partial, total, and bounded — it never executes anything it
 * reads, never follows an external reference, and gives up rather than guessing.
 */

import { inflateSync } from 'node:zlib';

/** Bounds the work a single document can cause. A bank statement is not 64 MB of text. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_LENGTH = 8 * 1024 * 1024;

export interface PdfTextResult {
  /**
   * `false` when the document contains no extractable text — an image-only scan, or an
   * encoding this reader does not implement. Never conflated with "no transactions".
   */
  readonly hasTextLayer: boolean;
  /** The extracted lines, in document order, with runs of whitespace collapsed. */
  readonly lines: readonly string[];
  /** Why extraction produced nothing, when it did. */
  readonly reason?: string;
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
