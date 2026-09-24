/**
 * A CSV or XLSX statement through the website's import path, over HTTP (ADR-0068).
 *
 * A PDF names the kind of account it is a statement of, and ADR-0066/0067 check that. A table
 * does not: a card's export and a bank account's can carry the same columns, so the columns are
 * never read as a kind — not by the parser, and not in the words the reading uses to describe
 * the file. The person importing it says what it is a statement of, and the import holds them to
 * it: nothing is written without that statement, onto an account of a different kind, or over a
 * document that says otherwise. Every refusal here leaves the ledger exactly as it found it — no
 * batch, no payment, no audit event.
 *
 * Every statement here is synthetic: short tables written inline, and workbooks built in memory
 * by `tests/support/synthetic-workbook.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
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
import { buildWorkbook } from '../support/synthetic-workbook.js';

const BASE = 'http://localhost';

/** A card's export: one amount column and a Debit/Credit marker. */
const CARD_CSV = [
  'Transaction Date,Transaction Description,Amount,Debit/Credit,Reference',
  '03/08/2026,SYNTHETIC BOOKSHOP,"1,250.00",Debit,CARD/610001',
  '05/08/2026,SYNTHETIC BOOKSHOP REFUND,250.00,Credit,CARD/610002',
].join('\n');

/** A bank account's export: withdrawal and deposit columns and a running balance. */
const BANK_CSV = [
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '03/08/26,SYNTHETIC GROCER,UPI/2608031111/GROCER,03/08/26,640.00,0.00,"9,360.00"',
  '06/08/26,SYNTHETIC EMPLOYER SALARY,NEFT/N080626001,06/08/26,0.00,"5,000.00","14,360.00"',
].join('\n');

/** The same card shape, as a workbook. */
const CARD_XLSX = buildWorkbook([
  ['Transaction Date', 'Transaction Description', 'Amount', 'Debit/Credit', 'Reference'],
  ['11/08/2026', 'SYNTHETIC CINEMA', '480.00', 'Debit', 'CARD/620001'],
  ['12/08/2026', 'SYNTHETIC PHARMACY', '215.50', 'Debit', 'CARD/620002'],
  ['14/08/2026', 'PAYMENT RECEIVED THANK YOU', '695.50', 'Credit', 'CARD/620003'],
]);

/** An SBI-shaped bank account's workbook, with its blank cells where a column is not used. */
const BANK_XLSX = buildWorkbook([
  ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
  [
    '11 Aug 2026',
    '11 Aug 2026',
    'TO TRANSFER SYNTHETIC RENT',
    'NEFT/N081126001',
    '9000.00',
    '',
    '5360.00',
  ],
  [
    '13 Aug 2026',
    '13 Aug 2026',
    'BY TRANSFER SYNTHETIC REFUND',
    'IMPS/260813999',
    '',
    '120.00',
    '5480.00',
  ],
]);

/** The synthetic IDFC FIRST credit-card PDF, which names its own kind of account. */
const CARD_PDF = new Uint8Array(
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

function bytesOf(statement: string | Uint8Array): Uint8Array {
  return typeof statement === 'string' ? new TextEncoder().encode(statement) : statement;
}

function base64(statement: string | Uint8Array): string {
  return Buffer.from(bytesOf(statement)).toString('base64');
}

async function preview(statement: string | Uint8Array, filename = 'statement.csv') {
  return post('/api/imports/preview', {
    formatId: 'auto',
    contentBase64: base64(statement),
    filename,
  });
}

interface ImportRequest {
  readonly statement: string | Uint8Array;
  readonly accountId: string;
  readonly statementKind?: string;
  readonly filename?: string;
}

async function importStatement(request: ImportRequest) {
  return post('/api/imports/statement', {
    actor: 'user',
    accountId: request.accountId,
    sourceSystem: 'synthetic_export',
    formatId: 'auto',
    contentBase64: base64(request.statement),
    filename: request.filename ?? 'statement.csv',
    fileReference: request.filename ?? 'statement.csv',
    ...(request.statementKind === undefined ? {} : { statementKind: request.statementKind }),
  });
}

async function refusal(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

function account(key: string): string {
  const id = cast.account[key];
  if (id === undefined) throw new Error(`No synthetic account "${key}".`);
  return id;
}

async function paymentAccounts(): Promise<Set<string>> {
  const rows = await database.db
    .select({ accountId: schema.payments.accountId })
    .from(schema.payments);
  return new Set(rows.map((row) => row.accountId));
}

/** A second account of a kind the cast already has one of, as a person would add in Setup. */
async function addAccount(name: string, type: 'bank' | 'card'): Promise<string> {
  const [row] = await database.db
    .insert(schema.accounts)
    .values({ ownerUserId: cast.userId, name, type })
    .returning({ id: schema.accounts.id });
  return row!.id;
}

describe('POST /api/imports/preview with a CSV or XLSX', () => {
  it('reads a card-shaped CSV without claiming what account it is from, writing nothing', async () => {
    const before = await ledgerSize();

    const response = await preview(CARD_CSV);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      readable: true,
      formatId: 'card_statement_csv',
      accountKind: null,
      movementCount: 2,
      alreadyImported: null,
    });
    expect(await ledgerSize()).toEqual(before);
  });

  it('claims no kind for a bank-shaped CSV, or for either workbook', async () => {
    for (const [statement, filename] of [
      [BANK_CSV, 'statement.csv'],
      [CARD_XLSX, 'statement.xlsx'],
      [BANK_XLSX, 'statement.xlsx'],
    ] as const) {
      const body = (await (await preview(statement, filename)).json()) as {
        readable: boolean;
        accountKind: string | null;
      };
      expect(body.readable).toBe(true);
      expect(body.accountKind).toBeNull();
    }
  });

  it('describes the layout it read without naming a kind of account', async () => {
    // The reading's headline is the first thing a person holding the file sees. A layout matched
    // by its columns alone is not evidence of whose account the file is from, so its name says
    // how the columns are arranged and nothing about a card, a bank account, or its type.
    for (const [statement, filename] of [
      [CARD_CSV, 'statement.csv'],
      [BANK_CSV, 'statement.csv'],
      [CARD_XLSX, 'statement.xlsx'],
      [BANK_XLSX, 'statement.xlsx'],
    ] as const) {
      const body = (await (await preview(statement, filename)).json()) as { formatLabel: string };
      expect(body.formatLabel).not.toMatch(/\b(card|account|savings|current)\b/i);
    }
  });
});

describe('POST /api/imports/statement with a CSV or XLSX', () => {
  it('refuses a statement nobody said the kind of, before anything is written', async () => {
    const before = await ledgerSize();

    const response = await importStatement({
      statement: CARD_CSV,
      accountId: account('account_icici_credit_card'),
    });

    expect(response.status).toBe(400);
    const error = await refusal(response);
    expect(error.code).toBe('STATEMENT_KIND_REQUIRED');
    expect(error.message).toContain('does not say what kind of account');
    expect(error.message).toContain('Nothing was imported');
    expect(await ledgerSize()).toEqual(before);
  });

  it('refuses a bank export stated as a bank account’s onto a card, before anything is written', async () => {
    const before = await ledgerSize();

    const response = await importStatement({
      statement: BANK_CSV,
      accountId: account('account_icici_credit_card'),
      statementKind: 'bank',
    });

    expect(response.status).toBe(409);
    const error = await refusal(response);
    expect(error.code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    expect(error.message).toContain('the statement of a bank account');
    expect(error.message).toContain('the account chosen is a card');
    expect(error.message).toContain('Setup');
    expect(await ledgerSize()).toEqual(before);
  });

  it('refuses a card export stated as a card’s onto every account that is not a card', async () => {
    const before = await ledgerSize();

    for (const accountKey of ['account_hdfc_savings', 'account_hdfc_upi', 'account_cash_wallet']) {
      const response = await importStatement({
        statement: CARD_XLSX,
        accountId: account(accountKey),
        statementKind: 'card',
        filename: 'statement.xlsx',
      });
      expect(response.status).toBe(409);
      expect((await refusal(response)).code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    }
    expect(await ledgerSize()).toEqual(before);
  });

  it('imports a card export stated as a card’s onto the card', async () => {
    const response = await importStatement({
      statement: CARD_CSV,
      accountId: account('account_icici_credit_card'),
      statementKind: 'card',
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { formatId: string; paymentIds: string[] };
    expect(body.formatId).toBe('card_statement_csv');
    expect(body.paymentIds).toHaveLength(2);
    expect(await paymentAccounts()).toEqual(new Set([account('account_icici_credit_card')]));
  });

  it('imports a bank workbook stated as a bank account’s, each direction read from its column', async () => {
    const response = await importStatement({
      statement: BANK_XLSX,
      accountId: account('account_hdfc_savings'),
      statementKind: 'bank',
      filename: 'statement.xlsx',
    });

    expect(response.status).toBe(201);
    const rows = await database.db
      .select({
        accountId: schema.payments.accountId,
        amount: schema.payments.amount,
        direction: schema.payments.direction,
      })
      .from(schema.payments);
    expect(rows.map((row) => [row.direction, row.amount]).sort()).toEqual([
      ['credit', 12000n],
      ['debit', 900000n],
    ]);
    expect(new Set(rows.map((row) => row.accountId))).toEqual(
      new Set([account('account_hdfc_savings')]),
    );
  });

  it('takes the person’s word over the columns: a bank-laid-out export stated as a card’s goes onto the card', async () => {
    // Some issuers export a card's movements under withdrawal/deposit headings. The columns are
    // not evidence of the account, so they neither choose it nor overrule the person naming it.
    const response = await importStatement({
      statement: BANK_CSV,
      accountId: account('account_icici_credit_card'),
      statementKind: 'card',
    });

    expect(response.status).toBe(201);
    expect(await paymentAccounts()).toEqual(new Set([account('account_icici_credit_card')]));
  });

  it('refuses a stated kind the document itself contradicts, before anything is written', async () => {
    const before = await ledgerSize();

    const response = await importStatement({
      statement: CARD_PDF,
      accountId: account('account_hdfc_savings'),
      statementKind: 'bank',
      filename: 'statement.pdf',
    });

    expect(response.status).toBe(409);
    const error = await refusal(response);
    expect(error.code).toBe('STATEMENT_KIND_CONFLICT');
    expect(error.message).toContain('says it is the statement of a card');
    expect(error.message).toContain('Nothing was imported');
    expect(await ledgerSize()).toEqual(before);
  });

  it('accepts a stated kind the document agrees with', async () => {
    const response = await importStatement({
      statement: CARD_PDF,
      accountId: account('account_icici_credit_card'),
      statementKind: 'card',
      filename: 'statement.pdf',
    });

    expect(response.status).toBe(201);
  });

  it('refuses a stated kind that is not a kind of account', async () => {
    const before = await ledgerSize();

    const response = await importStatement({
      statement: BANK_CSV,
      accountId: account('account_hdfc_savings'),
      statementKind: 'savings',
    });

    expect(response.status).toBe(400);
    expect((await refusal(response)).code).toBe('INVALID_REQUEST');
    expect(await ledgerSize()).toEqual(before);
  });
});

describe('a CSV or XLSX imported more than once', () => {
  it('writes the same file only once', async () => {
    const first = await importStatement({
      statement: CARD_CSV,
      accountId: account('account_icici_credit_card'),
      statementKind: 'card',
    });
    expect(first.status).toBe(201);
    const after = await ledgerSize();

    const again = await importStatement({
      statement: CARD_CSV,
      accountId: account('account_icici_credit_card'),
      statementKind: 'card',
    });

    expect(again.status).toBe(200);
    expect(((await again.json()) as { outcome: string }).outcome).toBe('already_imported');
    expect(await ledgerSize()).toEqual(after);
  });

  it('does not copy a file already on record onto a second account of the same kind', async () => {
    const second = await addAccount('Synthetic Second Savings', 'bank');
    await importStatement({
      statement: BANK_CSV,
      accountId: account('account_hdfc_savings'),
      statementKind: 'bank',
    });
    const after = await ledgerSize();

    const again = await importStatement({
      statement: BANK_CSV,
      accountId: second,
      statementKind: 'bank',
    });

    expect(again.status).toBe(200);
    expect(((await again.json()) as { outcome: string }).outcome).toBe('already_imported');
    expect(await ledgerSize()).toEqual(after);
    expect(await paymentAccounts()).toEqual(new Set([account('account_hdfc_savings')]));
  });

  it('still asks what kind of account it is from before answering “already imported”', async () => {
    await importStatement({
      statement: BANK_CSV,
      accountId: account('account_hdfc_savings'),
      statementKind: 'bank',
    });
    const after = await ledgerSize();

    const again = await importStatement({
      statement: BANK_CSV,
      accountId: account('account_hdfc_savings'),
    });

    expect(again.status).toBe(400);
    expect((await refusal(again)).code).toBe('STATEMENT_KIND_REQUIRED');
    expect(await ledgerSize()).toEqual(after);
  });

  it('refuses a file on record for a card when it is pointed at a bank account', async () => {
    await importStatement({
      statement: CARD_CSV,
      accountId: account('account_icici_credit_card'),
      statementKind: 'card',
    });
    const after = await ledgerSize();

    const again = await importStatement({
      statement: CARD_CSV,
      accountId: account('account_hdfc_savings'),
      statementKind: 'card',
    });

    expect(again.status).toBe(409);
    expect((await refusal(again)).code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    expect(await ledgerSize()).toEqual(after);
  });

  it('keeps a movement an overlapping export already printed, marked ignored', async () => {
    await importStatement({
      statement: BANK_CSV,
      accountId: account('account_hdfc_savings'),
      statementKind: 'bank',
    });
    // A later export restating the grocer's movement under its same reference, plus a new one.
    const overlapping = [
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '03/08/26,SYNTHETIC GROCER,UPI/2608031111/GROCER,03/08/26,640.00,0.00,"9,360.00"',
      '09/08/26,SYNTHETIC CAFE,UPI/2608092222/CAFE,09/08/26,180.00,0.00,"14,180.00"',
    ].join('\n');

    const response = await importStatement({
      statement: overlapping,
      accountId: account('account_hdfc_savings'),
      statementKind: 'bank',
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { duplicates: { externalReference: string }[] };
    expect(body.duplicates.map((duplicate) => duplicate.externalReference)).toEqual([
      'UPI/2608031111/GROCER',
    ]);
    const grocer = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.externalReference, 'UPI/2608031111/GROCER'));
    // Both copies are kept — the ledger did receive the evidence twice — and exactly one counts.
    expect(grocer).toHaveLength(2);
    expect(grocer.filter((row) => row.state === 'ignored')).toHaveLength(1);
  });
});

describe('a malformed or ambiguous CSV or XLSX', () => {
  async function refusedWhole(statement: string | Uint8Array, filename = 'statement.csv') {
    const before = await ledgerSize();
    const response = await importStatement({
      statement,
      accountId: account('account_hdfc_savings'),
      statementKind: 'bank',
      filename,
    });
    expect(await ledgerSize()).toEqual(before);
    return response;
  }

  it('imports nothing when one row’s date cannot be read, whatever kind is stated', async () => {
    const response = await refusedWhole(
      [
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '03/08/26,SYNTHETIC GOOD ROW,REF1,03/08/26,100.00,0.00,900.00',
        '31/02/26,SYNTHETIC BAD DATE,REF2,31/02/26,200.00,0.00,700.00',
      ].join('\n'),
    );
    expect(response.status).toBe(400);
    expect((await refusal(response)).message).toContain('Could not read a date');
  });

  it('imports nothing when a row fills both money columns', async () => {
    const response = await refusedWhole(
      [
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '03/08/26,SYNTHETIC BOTH,REF1,03/08/26,100.00,50.00,900.00',
      ].join('\n'),
    );
    expect(response.status).toBe(400);
    expect((await refusal(response)).message).toContain('fills both the debit and the credit');
  });

  it('imports nothing when a direction word is one the layout does not know', async () => {
    const response = await refusedWhole(
      buildWorkbook([
        ['Transaction Date', 'Transaction Description', 'Amount', 'Debit/Credit', 'Reference'],
        ['11/08/2026', 'SYNTHETIC SHOP', '480.00', 'Reversal', 'CARD/630001'],
      ]),
      'statement.xlsx',
    );
    expect(response.status).toBe(400);
    expect((await refusal(response)).message).toContain('not a direction this format recognises');
  });

  it('says a file whose columns fit two layouts fits two, and imports nothing', async () => {
    // Under one of these layouts a "D" is a deposit, and under the other a debit. The columns
    // cannot say which, so neither is chosen — and the refusal says that rather than claiming
    // that nothing matched.
    const ambiguous = ['Date,Description,Amount,Type', '01/08/2026,SYNTHETIC ENTRY,100.00,D'].join(
      '\n',
    );

    const reading = (await (await preview(ambiguous)).json()) as {
      readable: boolean;
      problems: { message: string }[];
    };
    expect(reading.readable).toBe(false);
    expect(reading.problems[0]?.message).toContain('more than one layout');
    expect(reading.problems[0]?.message).not.toContain('No supported format matched');

    const response = await refusedWhole(ambiguous);
    expect(response.status).toBe(400);
    expect((await refusal(response)).message).toContain('more than one layout');
  });

  it('imports nothing from a file whose columns fit no layout', async () => {
    const response = await refusedWhole('alpha,beta,gamma\n1,2,3\n');
    expect(response.status).toBe(400);
    expect((await refusal(response)).message).toContain('No supported format matched');
  });

  it('imports nothing from bytes that claim to be a workbook and are not one', async () => {
    const response = await refusedWhole(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
      'statement.xlsx',
    );
    expect(response.status).toBe(400);
  });
});

describe('the audit trail of an import', () => {
  async function createEvents(): Promise<Record<string, unknown>[]> {
    const events = await database.db
      .select({ newValue: schema.auditEvents.newValue, action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'payment'));
    return events
      .filter((event) => event.action === 'create')
      .map((event) => event.newValue as Record<string, unknown>);
  }

  it('records the kind of account a table was said to be from, and that the importer said it', async () => {
    await importStatement({
      statement: CARD_CSV,
      accountId: account('account_icici_credit_card'),
      statementKind: 'card',
    });

    const events = await createEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({ statementKind: 'card', statementKindNamedBy: 'importer' });
    }
  });

  it('records that a PDF named its own kind', async () => {
    await importStatement({
      statement: CARD_PDF,
      accountId: account('account_icici_credit_card'),
      filename: 'statement.pdf',
    });

    const events = await createEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event).toMatchObject({ statementKind: 'card', statementKindNamedBy: 'document' });
    }
  });
});

describe('POST /api/imports/bank-csv', () => {
  it('reads a bank statement by its own contract, so it refuses a card before anything is written', async () => {
    const before = await ledgerSize();

    const response = await post('/api/imports/bank-csv', {
      actor: 'user',
      accountId: account('account_icici_credit_card'),
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-08-03,SYNTHETIC GROCER,640.00,DEBIT,UPI/2608031111/GROCER',
      ].join('\n'),
    });

    expect(response.status).toBe(409);
    expect((await refusal(response)).code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    expect(await ledgerSize()).toEqual(before);
  });
});
