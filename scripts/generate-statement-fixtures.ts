/**
 * Writes the binary statement fixtures — one `.xlsx` workbook and one `.pdf` statement.
 *
 * They are binary, so they cannot be reviewed as text in a diff; this script is how they are
 * reproduced and how a reader can see exactly what is in them. **Both are synthetic**, like
 * everything else in `fixtures/` (`fixtures/README.md`): the amounts, dates and merchant names
 * are illustrative, and no real bank ever produced either file.
 *
 * They are structurally real, though — a genuine ZIP of genuine SpreadsheetML, and a genuine
 * PDF with Flate-compressed content streams and real text operators. That is the point: a
 * reader tested only against bytes it also wrote would prove nothing about the container, so
 * these are written the way the specifications say, not the way the parsers happen to read.
 *
 * Run with `npx tsx scripts/generate-statement-fixtures.ts`.
 */

import { deflateRawSync, deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(process.cwd(), 'fixtures', 'statements');

/* --------------------------------------------------------------------------- xlsx */

interface SheetCell {
  readonly text: string;
}

/** An SBI-shaped statement, as a workbook — the shape a bank's "Download as Excel" produces. */
const SHEET_ROWS: readonly (readonly SheetCell[])[] = [
  [
    { text: 'Txn Date' },
    { text: 'Value Date' },
    { text: 'Description' },
    { text: 'Ref No./Cheque No.' },
    { text: 'Debit' },
    { text: 'Credit' },
    { text: 'Balance' },
  ],
  [
    { text: '01 Jul 2026' },
    { text: '01 Jul 2026' },
    { text: 'TO TRANSFER UPI/DR/2607011234/BLINKIT' },
    { text: 'UPI/2607011234/BLINKIT' },
    { text: '1240.00' },
    { text: '' },
    { text: '48120.00' },
  ],
  [
    { text: '02 Jul 2026' },
    { text: '02 Jul 2026' },
    { text: 'BY TRANSFER NEFT FROM SELF' },
    { text: 'NEFT/N072026001' },
    { text: '' },
    { text: '15000.00' },
    { text: '63120.00' },
  ],
  [
    { text: '05 Jul 2026' },
    { text: '05 Jul 2026' },
    { text: 'ACH REFUND SAMPLE ELECTRONICS STORE' },
    { text: 'ACH/REF9981' },
    { text: '' },
    { text: '450.00' },
    { text: '63570.00' },
  ],
];

function columnName(index: number): string {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - remainder) / 26);
  }
  return name;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildWorkbook(): Uint8Array {
  const shared: string[] = [];
  const indexOf = (text: string): number => {
    const found = shared.indexOf(text);
    if (found !== -1) return found;
    shared.push(text);
    return shared.length - 1;
  };

  const rowsXml = SHEET_ROWS.map((cells, rowIndex) => {
    const cellsXml = cells
      .map((cell, columnIndex) => {
        const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
        if (cell.text === '') return `<c r="${ref}"/>`;
        return `<c r="${ref}" t="s"><v>${indexOf(cell.text)}</v></c>`;
      })
      .join('');
    return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
  }).join('');

  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rowsXml}</sheetData></worksheet>`;

  const sharedXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join('') +
    '</sst>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
    '</Relationships>';

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ]);
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** A minimal but specification-shaped ZIP: local headers, a central directory, an EOCD. */
function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, centralBuffer, eocd]));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------------------- pdf */

/** The lines a generated bank statement PDF prints, in the `date narration dr cr bal` layout. */
const PDF_LINES: readonly string[] = [
  'SYNTHETIC BANK — ACCOUNT STATEMENT',
  'Account XXXXXXXX4821   Period 01/07/2026 to 31/07/2026',
  'Date Narration Withdrawal Deposit Balance',
  '01/07/2026 UPI-BLINKIT9821PAYTM UPI/2607011234/BLINKIT 1,240.00 0.00 48,120.00',
  '02/07/2026 NEFT TRANSFER TO SELF NEFT/N072026001 15,000.00 0.00 33,120.00',
  '05/07/2026 ACH REFUND SAMPLE ELECTRONICS ACH/REF9981 0.00 450.00 33,570.00',
  'Closing balance 33,570.00',
];

function buildPdf(): Uint8Array {
  const content =
    'BT /F1 10 Tf 40 780 Td 14 TL\n' +
    PDF_LINES.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
    '\nET\n';
  const stream = deflateSync(Buffer.from(content, 'latin1'));

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `__STREAM__`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0]!.length;

  objects.forEach((body, index) => {
    offsets.push(position);
    const number = index + 1;
    let buffer: Buffer;
    if (body === '__STREAM__') {
      const header = Buffer.from(
        `${number} 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1',
      );
      buffer = Buffer.concat([header, stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else {
      buffer = Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, 'latin1');
    }
    chunks.push(buffer);
    position += buffer.length;
  });

  const xrefStart = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const value of offsets) {
    xref += `${String(value).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return new Uint8Array(Buffer.concat(chunks));
}

/* -------------------------------------------------------------------------- write */

writeFileSync(join(OUT_DIR, 'sbi-bank-statement.xlsx'), buildWorkbook());
writeFileSync(join(OUT_DIR, 'bank-statement.pdf'), buildPdf());
console.log('Wrote fixtures/statements/sbi-bank-statement.xlsx and bank-statement.pdf');
