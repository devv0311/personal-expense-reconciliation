/**
 * Multi-format statement import and the forwarding endpoint, over HTTP (audit rows 02, 12).
 *
 * The intake tests are as much about the **door** as the ingestion: an endpoint that appends
 * evidence without a session has to be closed when no token is configured, and closed to a
 * wrong token when one is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import { MAX_STATEMENT_BYTES } from '../../src/services/index.js';
import type { Api } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { buildTextPdf } from '../support/synthetic-pdf.js';

const BASE = 'http://localhost';
const STATEMENTS = join(process.cwd(), 'fixtures', 'statements');
const TOKEN = 'test-forwarding-token-0123456789';

let database: TestDatabase;
let api: Api;
let cast: Cast;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

function buildApi(intakeForwardingToken?: string): Api {
  return createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
    ...(intakeForwardingToken === undefined ? {} : { intakeForwardingToken }),
  });
}

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  api = buildApi(TOKEN);
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string) {
  return api.handle(new Request(`${BASE}${path}`));
}

describe('GET /api/imports/formats', () => {
  it('names every format this build reads', async () => {
    const response = await get('/api/imports/formats');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { formats: { id: string; container: string }[] };
    const ids = body.formats.map((format) => format.id);
    expect(ids).toContain('hdfc_bank_csv');
    expect(ids).toContain('pdf_debit_credit_balance');
    expect(body.formats.some((format) => format.container === 'xlsx')).toBe(false);
    // XLSX is read through the delimited column map once the sheet is a table, so the
    // *container* recorded on a format is how its columns are declared, not what it accepts.
    expect(body.formats.some((format) => format.container === 'pdf_text')).toBe(true);
  });
});

describe('POST /api/imports/statement', () => {
  it('imports a base64 XLSX workbook', async () => {
    const bytes = readFileSync(join(STATEMENTS, 'sbi-bank-statement.xlsx'));
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'synthetic_bank',
      formatId: 'auto',
      contentBase64: bytes.toString('base64'),
      filename: 'sbi-bank-statement.xlsx',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { formatId: string; paymentIds: string[] };
    expect(body.formatId).toBe('sbi_bank_csv');
    expect(body.paymentIds).toHaveLength(3);
  });

  it('imports a text CSV sent as fileContent', async () => {
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'synthetic_bank',
      formatId: 'auto',
      fileContent: readFileSync(join(STATEMENTS, 'axis-bank-statement.csv'), 'utf8'),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { formatId: string };
    expect(body.formatId).toBe('axis_bank_csv');
  });

  it('imports a base64 IDFC FIRST credit-card PDF, exactly as the browser sends it', async () => {
    // What the website posts: the original file's bytes, base64-encoded, never text-decoded.
    // Decoding a PDF as UTF-8 first would corrupt it before any parser saw it, so the test
    // asserts the *bytes* survived by asserting what the parser made of them.
    const bytes = readFileSync(join(STATEMENTS, 'idfc-first-credit-card-statement.pdf'));
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'idfc_first_card',
      formatId: 'auto',
      contentBase64: bytes.toString('base64'),
      filename: 'idfc-first-credit-card-statement.pdf',
      fileReference: 'idfc-first-credit-card-statement.pdf',
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      formatId: string;
      paymentIds: string[];
      warnings: { message: string }[];
      closingBalanceCandidate: string | null;
    };
    expect(body.formatId).toBe('idfc_first_credit_card_pdf');
    expect(body.paymentIds).toHaveLength(4);
    // An import never writes a cash boundary, and this layout prints no running balance.
    expect(body.closingBalanceCandidate).toBeNull();
    // The container's own caveat still travels: a PDF count is what matched.
    expect(body.warnings.some((warning) => warning.message.includes('check the count'))).toBe(true);
  });

  it('refuses a PDF with an unreadable transaction and writes nothing', async () => {
    // All-or-nothing over HTTP, exactly as `POST /api/imports/bank-csv` promises it.
    const bytes = buildTextPdf([
      'IDFC FIRST Bank',
      'Credit Card Statement',
      'FIRST WOW! Credit Card',
      'YOUR TRANSACTIONS',
      '02/07/2026 A COMPLETE PURCHASE 1,240.00 DR',
      '09/07/2026 EMI CONVERSION SAMPLE APPLIANCE',
      '12/07/2026 ANOTHER COMPLETE PURCHASE 1,000.00 DR',
      'Pay via our Mobile App',
    ]);
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'idfc_first_card',
      formatId: 'auto',
      contentBase64: Buffer.from(bytes).toString('base64'),
      filename: 'incomplete.pdf',
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('never reaches an amount and a direction');
    // The line's own text is the statement's content; only its number is reported.
    expect(text).not.toContain('EMI CONVERSION');
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('recognises the same PDF sent twice rather than importing the month again', async () => {
    const bytes = readFileSync(join(STATEMENTS, 'idfc-first-credit-card-statement.pdf'));
    const send = () =>
      post('/api/imports/statement', {
        actor: 'user',
        accountId: cast.account['account_hdfc_savings'],
        sourceSystem: 'idfc_first_card',
        formatId: 'auto',
        contentBase64: bytes.toString('base64'),
        filename: 'idfc-first-credit-card-statement.pdf',
      });

    const first = await send();
    expect(first.status).toBe(201);
    const second = await send();
    expect(second.status).toBe(200);
    const body = (await second.json()) as { outcome: string; importBatchId: string };
    expect(body.outcome).toBe('already_imported');
    expect(await database.db.select().from(schema.payments)).toHaveLength(4);
  });

  it('refuses a PDF it cannot read and writes nothing', async () => {
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'idfc_first_card',
      formatId: 'auto',
      contentBase64: Buffer.from('%PDF-1.4\nnot a real document\n', 'latin1').toString('base64'),
      filename: 'broken.pdf',
    });
    expect(response.status).toBe(400);
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('never answers a failed PDF read with the document’s own text', async () => {
    // A decode failure travels as a fixed sentence. Whatever the file contained, the response
    // is not a place for it (`security-model.md`, the sixth pillar).
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'idfc_first_card',
      formatId: 'auto',
      contentBase64: Buffer.from('%PDF-1.4\nMERCHANT SECRET 4821\n', 'latin1').toString('base64'),
      filename: 'broken.pdf',
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('MERCHANT');
    expect(text).not.toContain('4821');
  });

  it('refuses a PDF whose matched record will not convert, and writes nothing', async () => {
    const bytes = buildTextPdf([
      'IDFC FIRST Bank',
      'Credit Card Statement',
      'FIRST WOW! Credit Card',
      'YOUR TRANSACTIONS',
      '02/07/2026 A GOOD PURCHASE 100.00 DR',
      '99/99/2026 BAD DATE PURCHASE 200.00 DR',
      'Pay via our Mobile App',
    ]);
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'idfc_first_card',
      formatId: 'auto',
      contentBase64: Buffer.from(bytes).toString('base64'),
      filename: 'bad-date.pdf',
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('not a real calendar date');
    expect(text).not.toContain('BAD DATE PURCHASE');
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('names the unreadable record over HTTP when it is the file’s only transaction', async () => {
    const bytes = buildTextPdf([
      'IDFC FIRST Bank',
      'Credit Card Statement',
      'FIRST WOW! Credit Card',
      'YOUR TRANSACTIONS',
      '99/99/2026 BAD DATE PURCHASE 200.00 DR',
      'Pay via our Mobile App',
    ]);
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'idfc_first_card',
      formatId: 'auto',
      contentBase64: Buffer.from(bytes).toString('base64'),
      filename: 'only-bad.pdf',
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('not a real calendar date');
    expect(text).not.toContain('none of its lines matched');
    expect(text).not.toContain('BAD DATE PURCHASE');
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('refuses an oversized statement and writes nothing', async () => {
    // The authoritative check is in the service, on the decoded bytes.
    const oversized = new Uint8Array(MAX_STATEMENT_BYTES + 1);
    oversized.set(new TextEncoder().encode('%PDF-1.4\n'), 0);
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'idfc_first_card',
      formatId: 'auto',
      contentBase64: Buffer.from(oversized).toString('base64'),
      filename: 'huge.pdf',
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STATEMENT_FILE_TOO_LARGE');
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('refuses an obviously oversized body before reading it, on the declared length alone', async () => {
    // A cheap precheck: the body here is tiny, but the client claims a size that could not
    // hold a statement within the limit even after base64 expansion. It answers with the same
    // status and code the authoritative check does, so a caller learns one fact one way.
    const response = await api.handle(
      new Request(`${BASE}/api/imports/statement`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(500 * 1024 * 1024),
        },
        body: JSON.stringify({ actor: 'user', formatId: 'auto', contentBase64: 'JVBERi0=' }),
      }),
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('STATEMENT_FILE_TOO_LARGE');
    expect(body.error.message).toContain('cannot hold a statement');
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('answers both oversize paths with one code, whichever check noticed', async () => {
    // Which of the two refused is an implementation detail of this server. A client that had
    // to branch on 400-versus-413 to learn "too large" is a client we made guess.
    const oversized = new Uint8Array(MAX_STATEMENT_BYTES + 1);
    oversized.set(new TextEncoder().encode('%PDF-1.4\n'), 0);
    const honest = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'idfc_first_card',
      formatId: 'auto',
      contentBase64: Buffer.from(oversized).toString('base64'),
      filename: 'huge.pdf',
    });
    const declared = await api.handle(
      new Request(`${BASE}/api/imports/statement`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(500 * 1024 * 1024),
        },
        body: JSON.stringify({ actor: 'user', formatId: 'auto', contentBase64: 'JVBERi0=' }),
      }),
    );

    expect(honest.status).toBe(declared.status);
    const honestBody = (await honest.json()) as { error: { code: string } };
    const declaredBody = (await declared.json()) as { error: { code: string } };
    expect(honestBody.error.code).toBe(declaredBody.error.code);
    expect(honestBody.error.code).toBe('STATEMENT_FILE_TOO_LARGE');
  });

  it('still refuses an oversized statement when the declared length lies about it', async () => {
    // `Content-Length` is the client's claim, so the precheck can be skipped by anybody who
    // wants to. The service limit is what actually holds, and this proves it does.
    const oversized = new Uint8Array(MAX_STATEMENT_BYTES + 1);
    oversized.set(new TextEncoder().encode('%PDF-1.4\n'), 0);
    const response = await api.handle(
      new Request(`${BASE}/api/imports/statement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '10' },
        body: JSON.stringify({
          actor: 'user',
          accountId: cast.account['account_hdfc_savings'],
          sourceSystem: 'idfc_first_card',
          formatId: 'auto',
          contentBase64: Buffer.from(oversized).toString('base64'),
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('applies the same ceiling to the CSV-only route', async () => {
    const response = await post('/api/imports/bank-csv', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'synthetic_bank',
      fileContent: 'x'.repeat(MAX_STATEMENT_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('refuses a body that sends both or neither content field', async () => {
    const both = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'x',
      formatId: 'auto',
      fileContent: 'a',
      contentBase64: 'YQ==',
    });
    expect(both.status).toBe(400);
    const neither = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'x',
      formatId: 'auto',
    });
    expect(neither.status).toBe(400);
  });

  it('reports every bad row and imports nothing', async () => {
    const response = await post('/api/imports/statement', {
      actor: 'user',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'synthetic_bank',
      formatId: 'hdfc_bank_csv',
      fileContent:
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n' +
        '99/99/9999,BAD,REF,01/07/26,1.00,0.00,1.00\n',
    });
    expect(response.status).toBe(400);
    expect(await database.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('will not accept an actor that is not a person', async () => {
    const response = await post('/api/imports/statement', {
      actor: 'ai',
      accountId: cast.account['account_hdfc_savings'],
      sourceSystem: 'x',
      formatId: 'auto',
      fileContent: 'a',
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/intake/messages', () => {
  const delivery = {
    messages: [
      {
        channel: 'sms',
        receivedAt: '2026-07-01T10:15:00.000Z',
        sender: 'AD-HDFCBK',
        body: 'Rs.1240.00 debited from a/c XX4821 to BLINKIT. UPI Ref 260701123456.',
      },
    ],
  };

  it('accepts a delivery carrying the configured token', async () => {
    const response = await post('/api/intake/messages', delivery, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { recorded: number };
    expect(body.recorded).toBe(1);
    expect(await database.db.select().from(schema.evidence)).toHaveLength(1);
  });

  it('refuses a delivery with no token', async () => {
    const response = await post('/api/intake/messages', delivery);
    expect(response.status).toBe(401);
    expect(await database.db.select().from(schema.evidence)).toHaveLength(0);
  });

  it('refuses a delivery with the wrong token', async () => {
    const response = await post('/api/intake/messages', delivery, {
      authorization: `Bearer ${TOKEN}x`,
    });
    expect(response.status).toBe(401);
    expect(await database.db.select().from(schema.evidence)).toHaveLength(0);
  });

  it('is closed, not open, when no token is configured', async () => {
    api = buildApi();
    const response = await post('/api/intake/messages', delivery, {
      authorization: 'Bearer anything',
    });
    expect(response.status).toBe(401);
    const withoutHeader = await post('/api/intake/messages', delivery);
    expect(withoutHeader.status).toBe(401);
    expect(await database.db.select().from(schema.evidence)).toHaveLength(0);
  });

  it('refuses a malformed message rather than storing a partial record', async () => {
    const response = await post(
      '/api/intake/messages',
      { messages: [{ channel: 'carrier-pigeon', receivedAt: 'now', body: '' }] },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(response.status).toBe(400);
  });

  it('reports a configuration state honestly', async () => {
    const configured = (await (await get('/api/intake/status')).json()) as {
      configured: boolean;
      authentication: string;
    };
    expect(configured.configured).toBe(true);
    expect(configured.authentication).not.toContain(TOKEN);

    api = buildApi();
    const unconfigured = (await (await get('/api/intake/status')).json()) as {
      configured: boolean;
      authentication: string;
    };
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.authentication).toContain('refuses every request');
  });
});
