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
import type { Api } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

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
