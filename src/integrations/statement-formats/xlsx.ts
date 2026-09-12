/**
 * Reads the first worksheet of an `.xlsx` file into a table of strings.
 *
 * Banks that do not offer CSV offer XLSX, so "download your statement" routinely produces one.
 * The audit's row 02 named XLSX transaction extraction as unbuilt; this is it.
 *
 * **No dependency.** An `.xlsx` is a ZIP of XML, and Node ships both halves: `node:zlib`
 * inflates a deflated entry, and the two XML documents that matter (`xl/worksheets/sheet1.xml`
 * and `xl/sharedStrings.xml`) are simple enough to read with a scanner. Adding a spreadsheet
 * library to a personal financial ledger's dependency surface — to read two files out of a
 * ZIP — would be a worse trade than this module, and every byte it parses is a file a person
 * downloaded from their bank.
 *
 * What it deliberately does **not** do: formulas, styles, number formats, multiple sheets,
 * merged cells, or dates as serial numbers rendered through a locale. A cell is read as the
 * text the sheet stores; a date serial is converted through the one epoch rule below, stated
 * explicitly, because a date silently off by one is worse than a refused import.
 */

import { inflateRawSync } from 'node:zlib';

/** Guards against a zip bomb: a personal bank statement is not 200 MB of XML. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export class XlsxReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxReadError';
  }
}

/** One worksheet, as rows of already-stringified cells, blank cells included. */
export interface XlsxSheet {
  readonly rows: readonly (readonly string[])[];
}

/**
 * Reads the workbook's first worksheet.
 *
 * @throws XlsxReadError when the bytes are not a readable ZIP, when the workbook has no
 *   worksheet, or when an entry uses a compression method this reader does not implement.
 *   Every one of those is reported rather than degraded into an empty sheet — an import that
 *   silently reads zero rows out of a statement is the exact failure `importStatement`'s
 *   all-or-nothing rule exists to prevent.
 */
export function readXlsxFirstSheet(bytes: Uint8Array): XlsxSheet {
  const entries = readZipEntries(bytes);

  const sharedStrings = entries.has('xl/sharedStrings.xml')
    ? parseSharedStrings(decodeUtf8(entries.get('xl/sharedStrings.xml')!))
    : [];

  const sheetName =
    [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0] ??
    null;
  if (sheetName === null) {
    throw new XlsxReadError(
      'This workbook contains no worksheet (no xl/worksheets/sheet*.xml entry). Nothing was ' +
        'imported.',
    );
  }

  return { rows: parseSheet(decodeUtf8(entries.get(sheetName)!), sharedStrings) };
}

/* --------------------------------------------------------------------------- the ZIP */

/**
 * Reads a ZIP's entries by walking the local file headers.
 *
 * The central directory would be the more correct place to read from, but a statement export
 * is a small, freshly-written archive with no appended data and no spanning, and walking the
 * local headers keeps this to one forward pass. Anything the walk cannot make sense of stops
 * it with an error rather than being skipped.
 */
function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    // 0x04034b50 "PK\3\4" — a local file header. Anything else means the entries are done
    // (the central directory, or the end-of-central-directory record, follows them).
    if (signature !== 0x04034b50) break;

    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);

    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (dataStart + compressedSize > bytes.length) {
      throw new XlsxReadError('This file is truncated: a ZIP entry runs past the end of it.');
    }
    const name = decodeUtf8(bytes.subarray(nameStart, nameStart + nameLength));

    // Bit 3 says the sizes live in a trailing data descriptor rather than the header. A
    // statement export written by a spreadsheet application does not use it, and guessing
    // where the entry ends is exactly the kind of guess that silently loses rows.
    if ((flags & 0x08) !== 0) {
      throw new XlsxReadError(
        `The entry "${name}" uses a streamed data descriptor, which this reader does not ` +
          'implement. Export the statement as CSV instead.',
      );
    }
    if (uncompressedSize > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES) {
      throw new XlsxReadError(`The entry "${name}" is larger than this reader will decompress.`);
    }

    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.set(name, data);
    } else if (method === 8) {
      entries.set(name, new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES })));
    } else {
      throw new XlsxReadError(
        `The entry "${name}" uses compression method ${method}, which this reader does not ` +
          'implement (only stored and deflate).',
      );
    }

    offset = dataStart + compressedSize;
  }

  if (entries.size === 0) {
    throw new XlsxReadError(
      'These bytes are not a readable .xlsx workbook — no ZIP entry was found at the start ' +
        'of the file.',
    );
  }
  return entries;
}

/* --------------------------------------------------------------------------- the XML */

/**
 * The shared-string table, in index order.
 *
 * XLSX stores most cell text once here and refers to it by index; a cell whose type is `s`
 * holds an index into this array rather than its own text. Rich text splits one string across
 * several `<t>` runs, so the runs of one `<si>` are concatenated.
 */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const item of xml.split('<si>').slice(1)) {
    const end = item.indexOf('</si>');
    const body = end === -1 ? item : item.slice(0, end);
    let text = '';
    for (const run of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      text += decodeXmlEntities(run[1] ?? '');
    }
    strings.push(text);
  }
  return strings;
}

function parseSheet(xml: string, sharedStrings: readonly string[]): string[][] {
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    // `[^>]*?` is lazy, and the `\s*` before the alternation lets the self-closing `/` be
    // consumed by `\/>` rather than by the attribute run. Greedy matching here read
    // `<c r="E3"/>` — an empty cell — as an opening tag and then swallowed the *next* cell
    // looking for a `</c>`, which silently shifted every value one column left on any row
    // with a blank in it. On a bank statement that is the debit column landing under credit.
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(
      /<c\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attributes = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const columnIndex = columnIndexFromRef(/r="([A-Z]+)\d+"/.exec(attributes)?.[1] ?? null);
      const value = readCellValue(attributes, body, sharedStrings);
      if (columnIndex === null) {
        cells.push(value);
        continue;
      }
      while (cells.length < columnIndex) cells.push('');
      cells[columnIndex] = value;
    }
    rows.push(cells);
  }

  // A sheet whose last columns are blank on every row pads unevenly; the table reader indexes
  // by position, so rows are squared off to the widest one.
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return rows.map((row) => {
    const padded = [...row];
    while (padded.length < width) padded.push('');
    return padded;
  });
}

function readCellValue(attributes: string, body: string, sharedStrings: readonly string[]): string {
  const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? 'n';

  if (type === 'inlineStr') {
    let text = '';
    for (const run of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      text += decodeXmlEntities(run[1] ?? '');
    }
    return text;
  }

  const raw = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
  if (type === 's') {
    const index = Number(raw);
    return Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
  }
  if (type === 'str' || type === 'e' || type === 'b') return raw;

  // A numeric cell that is really a date: the sheet stores a serial and the *style* says it is
  // a date, and this reader deliberately does not read styles. A serial in the plausible range
  // for a statement (1900-01-01 through 2199) is converted; anything else stays the number the
  // sheet stored. Stated rather than inferred, because a date read as `45231` and a date read
  // one day early are both wrong and only one of them is obvious.
  if (raw !== '' && /^\d{5}(?:\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial >= 1 && serial <= 110000) return excelSerialToIsoDate(serial);
  }
  return raw;
}

/**
 * Excel's 1900 date system, including the leap-year bug it ships with.
 *
 * Excel believes 1900 was a leap year, so serials from 61 (1900-03-01) onward are one greater
 * than a true day count from 1899-12-31. Subtracting the extra day is what makes a statement
 * dated 2026-07-01 read as 2026-07-01 rather than 2026-07-02.
 */
function excelSerialToIsoDate(serial: number): string {
  const days = Math.floor(serial) - (serial >= 61 ? 1 : 0);
  const epoch = Date.UTC(1899, 11, 31);
  const date = new Date(epoch + days * 24 * 60 * 60 * 1000);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** `A` → 0, `B` → 1, … `AA` → 26. Returns `null` when the cell carries no reference. */
function columnIndexFromRef(ref: string | null): number | null {
  if (ref === null || ref === '') return null;
  let index = 0;
  for (const char of ref) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}
