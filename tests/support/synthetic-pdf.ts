/**
 * Writes a real PDF around lines of text, so a PDF reader can be tested against a document it
 * did not write itself.
 *
 * **Everything built here is synthetic** — `fixtures/README.md`'s rule, restated because this
 * helper exists to exercise *statement* parsing and would be the obvious place to paste a real
 * one. No real statement, account number, card number, merchant, person or amount may be
 * passed to it, in a fixture or in a test.
 *
 * The output is a genuine PDF: a Flate-compressed content stream placing text with `Tj` and
 * advancing lines with `T*`, an object table and a cross-reference table, written the way the
 * specification says rather than the way either reader happens to parse. A reader tested only
 * against bytes it also wrote proves nothing about the container.
 *
 * It is shared by `scripts/generate-statement-fixtures.ts`, which writes the committed
 * statement fixtures, and by the tests that need a one-off shape (a document with no text
 * layer, an oversized one, a malformed one) that is not worth committing as a file.
 */

import { deflateSync } from 'node:zlib';

export interface SyntheticPdfOptions {
  /**
   * Draw the lines across this many pages, splitting them evenly.
   *
   * A page count is what proves the reader's page bound and its per-page cleanup, and a
   * multi-page statement is the ordinary case rather than an edge one.
   */
  readonly pages?: number;
  /**
   * Write the page objects but no content stream at all.
   *
   * The shape of a scanned statement as far as a text reader is concerned: a real PDF that
   * contains an image of the page rather than its characters. `hasTextLayer: false` is the
   * only honest answer to it, and it must never be confused with "no transactions".
   */
  readonly withoutTextLayer?: boolean;
  /**
   * Encode the content stream through a filter *chain*: `/Filter [/ASCII85Decode /FlateDecode]`.
   *
   * A legal, ordinary PDF construction, and the smallest honest way to build a document the
   * dependency-free reader cannot decode while a standards-complete one can. That reader
   * inflates a stream whose dictionary names `/FlateDecode` and gives up when the bytes are
   * not raw Flate — which is exactly what a real issuer's PDF looks like to it when the text
   * sits behind an encoding it does not implement.
   *
   * It exists so the local-first privacy rule can be tested against a real document rather
   * than a stubbed reader: this is a PDF that *must* be read locally by the second reader and
   * must never reach a vision provider.
   */
  readonly filterChain?: boolean;
}

/** A PDF whose visible text is exactly `lines`, in order. */
export function buildTextPdf(
  lines: readonly string[],
  options: SyntheticPdfOptions = {},
): Uint8Array {
  const pageCount = Math.max(1, options.pages ?? 1);
  const perPage = Math.ceil(lines.length / pageCount) || 1;
  const pageLines: string[][] = [];
  for (let page = 0; page < pageCount; page += 1) {
    pageLines.push([...lines.slice(page * perPage, (page + 1) * perPage)]);
  }

  const withText = options.withoutTextLayer !== true;
  const chained = options.filterChain === true;
  const streams = pageLines.map((page) => {
    const deflated = deflateSync(Buffer.from(contentFor(page), 'latin1'));
    return chained ? Buffer.from(ascii85Encode(deflated), 'latin1') : deflated;
  });
  const filter = chained ? '/Filter [/ASCII85Decode /FlateDecode]' : '/Filter /FlateDecode';

  // Object numbering: 1 catalog, 2 pages, then each page object, then each content stream,
  // then the font. Written out explicitly because a wrong offset is the one mistake a PDF
  // reader cannot recover from, and a generated table hides it.
  const firstPageObject = 3;
  const firstStreamObject = firstPageObject + pageCount;
  const fontObject = firstStreamObject + (withText ? pageCount : 0);

  const bodies: (string | { readonly stream: Buffer })[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageLines
      .map((_, index) => `${firstPageObject + index} 0 R`)
      .join(' ')}] /Count ${pageCount} >>`,
  ];
  pageLines.forEach((_, index) => {
    const contents = withText ? ` /Contents ${firstStreamObject + index} 0 R` : '';
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObject} 0 R >> >>${contents} >>`,
    );
  });
  if (withText) for (const stream of streams) bodies.push({ stream });
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  return serialise(bodies, filter);
}

/** One piece of text placed on a line of {@link buildPlacedTextPdf}. */
export interface PlacedText {
  readonly text: string;
  /** Where the text starts — or, with `align: 'right'`, where it ends. */
  readonly x: number;
  readonly align?: 'left' | 'right';
}

/** The font size {@link buildPlacedTextPdf} sets, so a test can compute a placement. */
export const PLACED_FONT_SIZE = 9;

/**
 * How wide `text` is when {@link buildPlacedTextPdf} draws it.
 *
 * The builder draws in Courier, whose every glyph is 600/1000 of an em wide, so a width is a
 * multiplication rather than a font-metrics table — which is what lets a test right-align an
 * amount under a column header the way a bank's statement does.
 */
export function placedTextWidth(text: string): number {
  return text.length * PLACED_FONT_SIZE * 0.6;
}

/**
 * A PDF whose pages are tables: every line is text drawn at explicit horizontal positions.
 *
 * `buildTextPdf` writes each line as one string starting at the margin, which is all a
 * line-pattern layout needs. A columnar statement is read by **where** each value sits — the
 * amount printed under "Withdrawal" rather than "Deposit" is the direction — so its tests need
 * a document whose positions they chose. Lines are drawn top to bottom, 14 units apart.
 *
 * Synthetic only, like everything in this file: no real statement's text, amounts or layout
 * measurements are to be passed to it.
 */
export function buildPlacedTextPdf(
  pages: readonly (readonly (readonly PlacedText[])[])[],
): Uint8Array {
  const pageCount = Math.max(1, pages.length);
  const firstPageObject = 3;
  const firstStreamObject = firstPageObject + pageCount;
  const fontObject = firstStreamObject + pageCount;

  const bodies: (string | { readonly stream: Buffer })[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${firstPageObject + index} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ];
  for (let index = 0; index < pageCount; index += 1) {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstStreamObject + index} 0 R >>`,
    );
  }
  for (let index = 0; index < pageCount; index += 1) {
    const lines = pages[index] ?? [];
    const content = lines
      .map((line, lineIndex) =>
        line
          .map((placed) => {
            const x = placed.align === 'right' ? placed.x - placedTextWidth(placed.text) : placed.x;
            const y = 560 - lineIndex * 14;
            return `BT /F1 ${PLACED_FONT_SIZE} Tf 1 0 0 1 ${x.toFixed(2)} ${y} Tm (${escapePdfText(placed.text)}) Tj ET`;
          })
          .join('\n'),
      )
      .join('\n');
    bodies.push({ stream: deflateSync(Buffer.from(content, 'latin1')) });
  }
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

  return serialise(bodies, '/Filter /FlateDecode');
}

function escapePdfText(text: string): string {
  return text.replace(/([()\\])/g, '\\$1');
}

/** Writes numbered objects, a cross-reference table and a trailer around `bodies`. */
function serialise(
  bodies: readonly (string | { readonly stream: Buffer })[],
  filter: string,
): Uint8Array {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0]!.length;

  bodies.forEach((body, index) => {
    offsets.push(position);
    const number = index + 1;
    const buffer =
      typeof body === 'string'
        ? Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, 'latin1')
        : Buffer.concat([
            Buffer.from(
              `${number} 0 obj\n<< /Length ${body.stream.length} ${filter} >>\nstream\n`,
              'latin1',
            ),
            body.stream,
            Buffer.from('\nendstream\nendobj\n', 'latin1'),
          ]);
    chunks.push(buffer);
    position += buffer.length;
  });

  const xrefStart = position;
  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const value of offsets) xref += `${String(value).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return new Uint8Array(Buffer.concat(chunks));
}

/** PDF's ASCII85 variant: `z` for four zero bytes, `~>` as the end-of-data marker. */
function ascii85Encode(bytes: Buffer): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 4) {
    const chunk = bytes.subarray(index, index + 4);
    const padding = 4 - chunk.length;
    let value = 0;
    for (let byte = 0; byte < 4; byte += 1) {
      value = value * 256 + (chunk[byte] ?? 0);
    }
    if (value === 0 && padding === 0) {
      out += 'z';
      continue;
    }
    const digits: string[] = [];
    for (let digit = 0; digit < 5; digit += 1) {
      digits.unshift(String.fromCharCode(33 + (value % 85)));
      value = Math.floor(value / 85);
    }
    out += digits.slice(0, 5 - padding).join('');
  }
  return `${out}~>`;
}

function contentFor(lines: readonly string[]): string {
  return (
    'BT /F1 10 Tf 40 780 Td 14 TL\n' +
    lines.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
    '\nET\n'
  );
}
