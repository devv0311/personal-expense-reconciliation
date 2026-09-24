/**
 * A bank-account statement through the website's import path, over HTTP (ADR-0066).
 *
 * Three promises are tested here, in the order a person meets them:
 *
 *  1. **Reading a statement writes nothing.** `POST /api/imports/preview` recognises the file,
 *     says what is on it and whether it is already on record — and leaves the ledger exactly as
 *     it found it, whether the file was readable or not.
 *  2. **A bank statement cannot land on a card.** The document says what kind of account it is a
 *     statement of; an import into a different kind is refused before a single row is written.
 *  3. **An import is complete or it is nothing**, and it is only ever written once: a file already
 *     on record is a no-op, and a movement another statement already printed is kept for
 *     provenance and marked ignored.
 *
 * Every statement here is synthetic (`tests/support/synthetic-bank-statement.ts`).
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import { listReviewQueue } from '../../src/services/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { SYNTHETIC_BANK_MOVEMENTS, bankStatementPdf } from '../support/synthetic-bank-statement.js';
import type { BankMovement } from '../support/synthetic-bank-statement.js';

const BASE = 'http://localhost';
const FORMAT_ID = 'idfc_first_bank_account_pdf';

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

/** How many import batches and payments exist — the two things an import writes. */
async function ledgerSize(): Promise<{ batches: number; payments: number }> {
  const batches = await database.db
    .select({ id: schema.importBatches.id })
    .from(schema.importBatches);
  const payments = await database.db.select({ id: schema.payments.id }).from(schema.payments);
  return { batches: batches.length, payments: payments.length };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function preview(bytes: Uint8Array) {
  return post('/api/imports/preview', {
    formatId: 'auto',
    contentBase64: base64(bytes),
    filename: 'statement.pdf',
  });
}

async function importInto(accountKey: string, bytes: Uint8Array) {
  return post('/api/imports/statement', {
    actor: 'user',
    accountId: cast.account[accountKey],
    sourceSystem: 'synthetic_bank',
    formatId: 'auto',
    contentBase64: base64(bytes),
    filename: 'statement.pdf',
    fileReference: 'statement.pdf',
  });
}

/** The standard synthetic statement with one printed balance a paisa off, so a day cannot close. */
function unreconciledStatement(): Uint8Array {
  return bankStatementPdf({
    movements: SYNTHETIC_BANK_MOVEMENTS.map((movement, index) =>
      index === 2 ? { ...movement, balance: '10,762.35' } : movement,
    ),
  });
}

describe('POST /api/imports/preview', () => {
  it('reads a bank statement and says what is on it, writing nothing', async () => {
    const before = await ledgerSize();

    const response = await preview(bankStatementPdf());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      readable: true,
      formatId: FORMAT_ID,
      formatLabel: 'IDFC FIRST Bank — savings or current account statement (PDF)',
      accountKind: 'bank',
      checksPrintedBalances: true,
      movementCount: 5,
      debitCount: 2,
      creditCount: 3,
      totalDebits: '148456',
      totalCredits: '5101234',
      firstDate: '2026-01-02',
      lastDate: '2026-01-05',
      closingBalance: '5952778',
      warnings: [],
      alreadyImported: null,
    });
    expect(await ledgerSize()).toEqual(before);
  });

  it('says a file that cannot be read cannot be read, and still writes nothing', async () => {
    const before = await ledgerSize();

    const response = await preview(unreconciledStatement());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readable: boolean;
      formatId: string;
      problems: { lineNumber: number; message: string }[];
    };
    expect(body.readable).toBe(false);
    expect(body.formatId).toBe(FORMAT_ID);
    expect(body.problems[0]?.message).toMatch(/balance/i);
    expect(await ledgerSize()).toEqual(before);
  });

  it('recognises a file that is already on record', async () => {
    const imported = (await (
      await importInto('account_hdfc_savings', bankStatementPdf())
    ).json()) as {
      importBatchId: string;
    };

    const body = (await (await preview(bankStatementPdf())).json()) as {
      alreadyImported: { importBatchId: string; importedAt: string } | null;
    };
    expect(body.alreadyImported?.importBatchId).toBe(imported.importBatchId);
  });

  it('refuses an oversized upload before reading it', async () => {
    const response = await post('/api/imports/preview', {
      formatId: 'auto',
      contentBase64: 'A'.repeat(40 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
  });
});

describe('POST /api/imports/statement with a bank statement', () => {
  it('refuses to write a bank statement onto a card account, before anything is written', async () => {
    const before = await ledgerSize();

    const response = await importInto('account_icici_credit_card', bankStatementPdf());

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('STATEMENT_ACCOUNT_MISMATCH');
    expect(body.error.message).toMatch(/bank/i);
    expect(await ledgerSize()).toEqual(before);
  });

  it('imports it into a bank account, each direction read from its column', async () => {
    const response = await importInto('account_hdfc_savings', bankStatementPdf());

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      formatId: string;
      paymentIds: string[];
      duplicates: unknown[];
      closingBalanceCandidate: string | null;
      warnings: unknown[];
      prepared: { ran: boolean };
    };
    expect(body.formatId).toBe(FORMAT_ID);
    expect(body.paymentIds).toHaveLength(5);
    expect(body.duplicates).toEqual([]);
    expect(body.closingBalanceCandidate).toBe('5952778');
    expect(body.warnings).toEqual([]);
    // The import reads what it just wrote, in the same request (ADR-0061).
    expect(body.prepared.ran).toBe(true);

    const rows = await database.db
      .select({
        direction: schema.payments.direction,
        amount: schema.payments.amount,
        externalReference: schema.payments.externalReference,
        accountId: schema.payments.accountId,
      })
      .from(schema.payments);
    expect(rows.map((row) => row.direction).sort()).toEqual([
      'credit',
      'credit',
      'credit',
      'debit',
      'debit',
    ]);
    expect(new Set(rows.map((row) => row.accountId))).toEqual(
      new Set([cast.account['account_hdfc_savings']]),
    );
    expect(rows.filter((row) => row.externalReference === null)).toHaveLength(1);
  });

  it('writes the same file only once', async () => {
    await importInto('account_hdfc_savings', bankStatementPdf());
    const after = await ledgerSize();

    const again = await importInto('account_hdfc_savings', bankStatementPdf());

    expect(again.status).toBe(200);
    expect(((await again.json()) as { outcome: string }).outcome).toBe('already_imported');
    expect(await ledgerSize()).toEqual(after);
  });

  it('keeps a movement an overlapping statement already printed, marked ignored', async () => {
    await importInto('account_hdfc_savings', bankStatementPdf());

    // The next statement opens where the third row closed, reprints rows four and five, and adds
    // one new movement. Only the new one may count.
    const overlap: BankMovement[] = [
      SYNTHETIC_BANK_MOVEMENTS[3]!,
      SYNTHETIC_BANK_MOVEMENTS[4]!,
      {
        date: '07 Jan 2026',
        description: ['UPI/SYNTH PHARMACY/000000000007'],
        reference: 'UPI-000000000007',
        debit: '100.00',
        balance: '59,427.78',
      },
    ];
    const response = await importInto(
      'account_hdfc_savings',
      bankStatementPdf({ movements: overlap, opening: '10,762.34' }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { paymentIds: string[]; duplicates: unknown[] };
    expect(body.paymentIds).toHaveLength(3);
    expect(body.duplicates).toHaveLength(2);
  });

  it('refuses a statement that does not reconcile, writing nothing', async () => {
    const before = await ledgerSize();

    const response = await importInto('account_hdfc_savings', unreconciledStatement());

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'IMPORT_SOURCE_INVALID',
    );
    expect(await ledgerSize()).toEqual(before);
  });
});

describe('an ordinary statement is not a list of its own duplicates', () => {
  /**
   * Same-day, same-amount movements are ordinary on a bank account: the tea, the auto and the
   * metro are all ₹20, and two withdrawals can leave one ATM on one day. Every line here is a
   * different movement by the statement's own account — a different payee, a different
   * reference, different words or a different date — and none of them was captured twice. Each
   * of those resemblances used to be a "possible duplicate" question: seven, for seven lines.
   */
  const ORDINARY: BankMovement[] = [
    {
      date: '02 Jan 2026',
      description: ['UPI/SYNTH TEA STALL/000000000011'],
      reference: 'UPI-000000000011',
      debit: '20.00',
      balance: '9,980.00',
    },
    {
      date: '02 Jan 2026',
      description: ['UPI/SYNTH AUTO RIDE/000000000012'],
      reference: 'UPI-000000000012',
      debit: '20.00',
      balance: '9,960.00',
    },
    {
      date: '02 Jan 2026',
      description: ['UPI/SYNTH TEA STALL/000000000013'],
      reference: 'UPI-000000000013',
      debit: '20.00',
      balance: '9,940.00',
    },
    {
      date: '02 Jan 2026',
      description: ['ATM WDL SYNTH ATM 0001'],
      debit: '500.00',
      balance: '9,440.00',
    },
    {
      date: '02 Jan 2026',
      description: ['ATM WDL SYNTH ATM 0002'],
      debit: '500.00',
      balance: '8,940.00',
    },
    {
      date: '03 Jan 2026',
      description: ['UPI/SYNTH METRO/000000000014'],
      reference: 'UPI-000000000014',
      debit: '20.00',
      balance: '8,920.00',
    },
    {
      date: '03 Jan 2026',
      description: ['Int.Pd:SYNTHETIC'],
      credit: '12.34',
      balance: '8,932.34',
    },
  ];

  async function importOrdinary(): Promise<string[]> {
    const response = await importInto(
      'account_hdfc_savings',
      bankStatementPdf({ movements: ORDINARY }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { paymentIds: string[] }).paymentIds;
  }

  async function duplicateQuestions() {
    const queue = await listReviewQueue(database.db, { kinds: ['possible_duplicate'] });
    return queue.items.flatMap((item) =>
      item.kind === 'possible_duplicate'
        ? [[item.candidate.paymentId, item.payment.paymentId].sort()]
        : [],
    );
  }

  it('asks nothing about the ordinary movements on one statement', async () => {
    await importOrdinary();

    expect(await duplicateQuestions()).toEqual([]);
  });

  it('still asks about a movement a second statement prints again without a reference', async () => {
    const first = await importOrdinary();

    // The next statement opens after the ATM withdrawals and reprints the last two lines: the
    // metro fare, whose reference settles it at import, and the interest credit, which prints
    // none — so only a person can say it is the same money.
    const overlap: BankMovement[] = [
      ORDINARY[5]!,
      ORDINARY[6]!,
      {
        date: '04 Jan 2026',
        description: ['UPI/SYNTH GROCER/000000000015'],
        reference: 'UPI-000000000015',
        debit: '250.00',
        balance: '8,682.34',
      },
    ];
    const response = await importInto(
      'account_hdfc_savings',
      bankStatementPdf({ movements: overlap, opening: '8,940.00' }),
    );
    expect(response.status).toBe(201);
    const second = (await response.json()) as { paymentIds: string[]; duplicates: unknown[] };
    expect(second.duplicates).toHaveLength(1);

    expect(await duplicateQuestions()).toEqual([[first[6]!, second.paymentIds[1]!].sort()]);
  });

  it('asks nothing new when the same statement is sent again', async () => {
    await importOrdinary();
    const before = { ledger: await ledgerSize(), questions: await duplicateQuestions() };

    const again = await importInto(
      'account_hdfc_savings',
      bankStatementPdf({ movements: ORDINARY }),
    );

    expect(((await again.json()) as { outcome: string }).outcome).toBe('already_imported');
    expect({ ledger: await ledgerSize(), questions: await duplicateQuestions() }).toEqual(before);
  });

  it('refuses to confirm two different lines of one statement as one movement', async () => {
    const ids = await importOrdinary();

    // Same shop, same amount, same day — the pair a person is most tempted to call a duplicate.
    // The statement printed them with different references, so confirming would delete ₹20 of
    // real spending from every total.
    const response = await post(`/api/review/payments/${ids[2]}/duplicate`, {
      decision: 'confirm',
      actor: 'user',
      duplicateOfPaymentId: ids[0],
    });

    expect(response.status).toBe(409);
    const [row] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.id, ids[2]!));
    expect(row?.state).not.toBe('ignored');
  });
});

describe('GET /api/imports/formats', () => {
  it('names the layout as a bank-account statement whose balances are checked', async () => {
    const response = await api.handle(new Request(`${BASE}/api/imports/formats`));
    const body = (await response.json()) as {
      formats: { id: string; accountKind: string | null; checksPrintedBalances: boolean }[];
    };
    expect(body.formats.find((format) => format.id === FORMAT_ID)).toMatchObject({
      accountKind: 'bank',
      checksPrintedBalances: true,
    });
    expect(body.formats.find((format) => format.id === 'hdfc_bank_csv')).toMatchObject({
      accountKind: null,
      checksPrintedBalances: false,
    });
  });
});
