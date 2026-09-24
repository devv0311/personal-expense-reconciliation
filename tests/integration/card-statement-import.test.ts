/**
 * A credit-card statement through the website's import path, over HTTP (ADR-0067).
 *
 * The mirror of `bank-statement-import.test.ts`. A card statement says what it is a statement
 * of, and that decides where it may go: onto a card, and never onto a bank account — refused
 * before a batch, a payment or an audit event is written, whichever layout a caller asked to
 * read it with, and whether or not the same file is already on record.
 *
 * Every statement here is synthetic (`fixtures/statements/idfc-first-credit-card-statement.pdf`,
 * written by `scripts/generate-statement-fixtures.ts`).
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
const FORMAT_ID = 'idfc_first_credit_card_pdf';
const CARD_STATEMENT = new Uint8Array(
  readFileSync(
    join(process.cwd(), 'fixtures', 'statements', 'idfc-first-credit-card-statement.pdf'),
  ),
);

let database: TestDatabase;
let api: Api;
let cast: Cast;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
});

async function post(path: string, body: unknown) {
  return api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Everything an import writes: the batch, its payments, and the audit trail of both. */
async function ledgerSize(): Promise<{ batches: number; payments: number; auditEvents: number }> {
  const batches = await database.db
    .select({ id: schema.importBatches.id })
    .from(schema.importBatches);
  const payments = await database.db.select({ id: schema.payments.id }).from(schema.payments);
  const auditEvents = await database.db
    .select({ id: schema.auditEvents.id })
    .from(schema.auditEvents);
  return {
    batches: batches.length,
    payments: payments.length,
    auditEvents: auditEvents.length,
  };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function preview(formatId = 'auto') {
  return post('/api/imports/preview', {
    formatId,
    contentBase64: base64(CARD_STATEMENT),
    filename: 'statement.pdf',
  });
}

async function importInto(accountKey: string, formatId = 'auto') {
  return post('/api/imports/statement', {
    actor: 'user',
    accountId: cast.account[accountKey],
    sourceSystem: 'synthetic_card',
    formatId,
    contentBase64: base64(CARD_STATEMENT),
    filename: 'statement.pdf',
    fileReference: 'statement.pdf',
  });
}

async function refusal(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

describe('POST /api/imports/preview with a card statement', () => {
  it('says it is a card’s statement, writing nothing', async () => {
    const before = await ledgerSize();

    const response = await preview();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readable: true,
      formatId: FORMAT_ID,
      accountKind: 'card',
      movementCount: 4,
      alreadyImported: null,
    });
    expect(await ledgerSize()).toEqual(before);
  });

  it('still says so when the caller names a layout that cannot tell', async () => {
    const body = (await (await preview('pdf_amount_with_marker')).json()) as {
      readable: boolean;
      accountKind: string | null;
    };
    expect(body.readable).toBe(true);
    expect(body.accountKind).toBe('card');
  });
});

describe('POST /api/imports/statement with a card statement', () => {
  it('refuses to write a card statement onto a bank account, before anything is written', async () => {
    const before = await ledgerSize();

    const response = await importInto('account_hdfc_savings');

    expect(response.status).toBe(409);
    const error = await refusal(response);
    expect(error.code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    expect(error.message).toContain('This statement belongs to a card');
    expect(error.message).toContain('the account chosen is a bank account');
    expect(error.message).toContain('Setup');
    expect(await ledgerSize()).toEqual(before);
  });

  it('refuses it the same way when the caller names a layout that cannot tell', async () => {
    // The generic marker layout reads this file's lines, and declares no kind of account. Naming
    // it is not a way round the statement saying what it is.
    const before = await ledgerSize();

    const response = await importInto('account_hdfc_savings', 'pdf_amount_with_marker');

    expect(response.status).toBe(409);
    expect((await refusal(response)).code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    expect(await ledgerSize()).toEqual(before);
  });

  it('refuses it on every account that is not a card', async () => {
    const before = await ledgerSize();

    for (const accountKey of ['account_hdfc_upi', 'account_cash_wallet']) {
      const response = await importInto(accountKey);
      expect(response.status).toBe(409);
      expect((await refusal(response)).code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    }
    expect(await ledgerSize()).toEqual(before);
  });

  it('imports it into a card', async () => {
    const response = await importInto('account_icici_credit_card');

    expect(response.status).toBe(201);
    const body = (await response.json()) as { formatId: string; paymentIds: string[] };
    expect(body.formatId).toBe(FORMAT_ID);
    expect(body.paymentIds).toHaveLength(4);

    const rows = await database.db
      .select({ accountId: schema.payments.accountId })
      .from(schema.payments);
    expect(new Set(rows.map((row) => row.accountId))).toEqual(
      new Set([cast.account['account_icici_credit_card']]),
    );
  });

  it('refuses a card statement already on record for a bank account too, writing nothing', async () => {
    // Already on record means importing it *onto the card* again changes nothing. Pointing the
    // same file at a bank account is a different mistake, and is named as that one.
    await importInto('account_icici_credit_card');
    const after = await ledgerSize();

    const again = await importInto('account_hdfc_savings');

    expect(again.status).toBe(409);
    expect((await refusal(again)).code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    expect(await ledgerSize()).toEqual(after);
  });
});

describe('GET /api/imports/formats', () => {
  it('names the card layout as a card’s statement', async () => {
    const response = await api.handle(new Request(`${BASE}/api/imports/formats`));
    const body = (await response.json()) as {
      formats: { id: string; accountKind: string | null; checksPrintedBalances: boolean }[];
    };
    expect(body.formats.find((format) => format.id === FORMAT_ID)).toMatchObject({
      accountKind: 'card',
      checksPrintedBalances: false,
    });
  });
});
