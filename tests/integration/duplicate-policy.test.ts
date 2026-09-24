/**
 * The duplicate policy over HTTP (ADR-0070): what the review queue asks about a bank account, a
 * credit card and a UPI app over the same weeks, each imported through the website's own route.
 *
 * Two movements are asked about as one when they fall on the same calendar day, move the same
 * amount the same way, and name the same payee — or, naming nobody, are the same kind of line —
 * whichever accounts they came from. A reference settles it where there is one. Nothing is ever
 * merged: a match is a question, and confirming it is a person's decision, re-checked by the
 * same rule.
 *
 * Every statement here is synthetic (`tests/support/synthetic-duplicate-scenario.ts`).
 */

import { and, eq, ne } from 'drizzle-orm';
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
import {
  BANK_A,
  BANK_A_OPENING,
  BANK_D,
  BANK_D_OPENING,
  BANK_G,
  BANK_G_OPENING,
  BANK_H,
  BANK_H_OPENING,
  BANK_S,
  BANK_S_OPENING,
  CARD_B,
  CARD_E,
  CARD_F,
  CARD_S,
  UPI_C,
  bankExportCsv,
  bankStatement,
  cardExportXlsx,
  cardStatement,
  caseForAmount,
  ordinaryMonth,
  shopOf,
  signedAmountCsv,
  upiAppExport,
} from '../support/synthetic-duplicate-scenario.js';

const BASE = 'http://localhost';

let database: TestDatabase;
let api: Api;
let cast: Cast;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

async function freshLedger(): Promise<void> {
  await database.truncateAll();
  cast = await seedCast(database.db);
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
}

beforeEach(freshLedger);

async function post(path: string, body: unknown): Promise<Response> {
  return api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

interface Imported {
  readonly status: number;
  readonly outcome: string;
  readonly importBatchId: string;
  /** Rows the importer itself settled as copies, on a shared reference (ADR-0019). */
  readonly duplicates: number;
}

async function importInto(
  accountKey: string,
  bytes: Uint8Array,
  extra: Record<string, unknown> = {},
): Promise<Imported> {
  const response = await post('/api/imports/statement', {
    actor: 'user',
    accountId: cast.account[accountKey],
    sourceSystem: 'synthetic',
    formatId: 'auto',
    contentBase64: Buffer.from(bytes).toString('base64'),
    filename: 'statement.pdf',
    fileReference: 'statement.pdf',
    ...extra,
  });
  const body = (await response.json()) as {
    outcome: string;
    importBatchId: string;
    duplicates?: unknown[];
  };
  return {
    status: response.status,
    outcome: body.outcome,
    importBatchId: body.importBatchId,
    duplicates: body.duplicates?.length ?? 0,
  };
}

/** What a person adds to import a table: its kind of account, which a table never names. */
function tableOf(kind: 'bank' | 'card', filename: string): Record<string, unknown> {
  return { statementKind: kind, filename, fileReference: filename };
}

/** The bank's two statements, the card's two and the UPI app's history, in the order they arrive. */
async function importScenario(): Promise<void> {
  const outcomes = [
    await importInto('account_hdfc_savings', bankStatement(BANK_A, BANK_A_OPENING)),
    await importInto('account_icici_credit_card', cardStatement(CARD_B)),
    await importInto('account_hdfc_upi', upiAppExport(UPI_C), {
      formatId: 'upi_app_export_csv',
      statementKind: 'upi',
      filename: 'history.csv',
      fileReference: 'history.csv',
    }),
    await importInto('account_hdfc_savings', bankStatement(BANK_D, BANK_D_OPENING)),
    await importInto('account_icici_credit_card', cardStatement(CARD_E)),
  ];
  expect(outcomes.map(({ status, outcome }) => ({ status, outcome }))).toEqual(
    Array(5).fill({ status: 201, outcome: 'imported' }),
  );
}

async function duplicateQuestions() {
  const queue = await listReviewQueue(database.db, { kinds: ['possible_duplicate'] });
  return queue.items.flatMap((item) => (item.kind === 'possible_duplicate' ? [item] : []));
}

/** Which scenario cases the queue is asking about, by the amount each question moves. */
async function casesAsked(): Promise<string[]> {
  return (await duplicateQuestions()).map((item) => caseForAmount(item.amount)?.id ?? '?').sort();
}

/** The one live payment printing these words for this amount. */
async function paymentId(amount: number, rawDescription: string): Promise<string> {
  const rows = await database.db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.amount, BigInt(amount)),
        eq(schema.payments.rawDescription, rawDescription),
        ne(schema.payments.state, 'ignored'),
      ),
    );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

async function stateOf(id: string) {
  const [row] = await database.db
    .select({ state: schema.payments.state, ignoredReason: schema.payments.ignoredReason })
    .from(schema.payments)
    .where(eq(schema.payments.id, id));
  return row;
}

async function ledgerSize(): Promise<{ batches: number; payments: number }> {
  const batches = await database.db
    .select({ id: schema.importBatches.id })
    .from(schema.importBatches);
  const payments = await database.db.select({ id: schema.payments.id }).from(schema.payments);
  return { batches: batches.length, payments: payments.length };
}

describe('which lookalikes are asked about', () => {
  it('asks about every movement captured twice, and about nothing that merely looks alike', async () => {
    await importScenario();

    // G1–G4 are one movement captured twice — a UPI app's copies, an overlapping bank statement,
    // an overlapping card statement. P1 is a card line and a bank line of one shop, one day and one
    // amount, with nothing to tell them apart: the owner's policy asks. Every N-case is two
    // movements that only look alike, and the rule this replaces asked about all seven.
    expect(await casesAsked()).toEqual(['G1', 'G2', 'G3', 'G4', 'P1']);
  });

  it('raises no question between two different shops in an ordinary month', async () => {
    // Three seeded months of a bank account and a card with nothing captured twice. What may
    // still be asked is the policy's own case: one shop, one day, one amount, and no transaction
    // number on the card's line to tell the two apart.
    for (const seed of [1, 2, 3]) {
      await freshLedger();
      const month = ordinaryMonth(seed);
      // The month really is full of lookalikes: a card line and a bank line of one amount on the
      // same or the next day, every one of which the 24-hour rule asked about.
      const day = (date: string): number => Number(date.slice(0, 2));
      const lookalikes = month.bank.flatMap((bankLine) =>
        month.card.filter(
          (cardLine) =>
            cardLine.amount === bankLine.debit &&
            Math.abs(day(cardLine.date) - day(bankLine.date)) <= 1,
        ),
      );
      expect(lookalikes.length).toBeGreaterThan(10);

      await importInto('account_hdfc_savings', bankStatement(month.bank, 100_000_000));
      await importInto('account_icici_credit_card', cardStatement(month.card));

      for (const question of await duplicateQuestions()) {
        const [bankSide, cardSide] = question.candidate.description.startsWith('UPI/')
          ? [question.candidate, question.payment]
          : [question.payment, question.candidate];
        expect(shopOf(cardSide.description)).toBe(shopOf(bankSide.description));
        expect(cardSide.occurredAt.toISOString().slice(0, 10)).toBe(
          bankSide.occurredAt.toISOString().slice(0, 10),
        );
        // A card-rail UPI line carries its own UTR, which tells it from the bank's every time.
        expect(cardSide.description.startsWith('UPICC/')).toBe(false);
      }
    }
  });
});

describe('the same statement sent again', () => {
  it('writes nothing and asks nothing new', async () => {
    await importScenario();
    const before = { ledger: await ledgerSize(), asked: await casesAsked() };

    const again = await importInto('account_hdfc_savings', bankStatement(BANK_A, BANK_A_OPENING));

    expect(again.outcome).toBe('already_imported');
    expect({ ledger: await ledgerSize(), asked: await casesAsked() }).toEqual(before);
  });
});

describe('confirming a pair', () => {
  async function confirm(copy: string, original: string): Promise<Response> {
    return post(`/api/review/payments/${copy}/duplicate`, {
      decision: 'confirm',
      actor: 'user',
      duplicateOfPaymentId: original,
    });
  }

  it('confirms a card line as a copy of the bank line the policy pairs it with', async () => {
    await importScenario();
    const bankLine = await paymentId(99_900, 'POS SYNTH SHOE STORE');
    const cardLine = await paymentId(99_900, 'SYNTH SHOE STORE BANGALORE');

    const response = await confirm(cardLine, bankLine);

    expect(response.status).toBe(200);
    expect(await stateOf(cardLine)).toEqual({
      state: 'ignored',
      ignoredReason: `duplicate_of:${bankLine}`,
    });
    expect((await stateOf(bankLine))?.state).not.toBe('ignored');
    expect(await casesAsked()).toEqual(['G1', 'G2', 'G3', 'G4']);
  });

  it('confirms a UPI app’s copy of a bank line', async () => {
    await importScenario();
    const bankLine = await paymentId(34_600, 'UPI/SYNTH GROCER/000000000105');
    const appLine = await paymentId(34_600, 'Paid to SYNTH GROCER');

    expect((await confirm(appLine, bankLine)).status).toBe(200);
    expect((await stateOf(appLine))?.ignoredReason).toBe(`duplicate_of:${bankLine}`);
  });

  it.each([
    [
      'unrelated names on one day',
      2_100,
      'SYNTH BOOK DEPOT MUMBAI',
      'UPI/SYNTH TEA STALL/000000000101',
    ],
    ['consecutive days', 6_200, 'SYNTH CINEMA HALL PUNE', 'UPI/SYNTH METRO/000000000102'],
    [
      'two UPI numbers',
      25_300,
      'UPICC/300000000201/SYNTH PHARMACY',
      'UPI/SYNTH PHARMACY/000000000103',
    ],
    [
      'a transfer beside an unrelated card purchase',
      150_400,
      'SYNTH FUEL STATION DELHI',
      'IMPS/P2A/000000000104/SYNTH LANDLORD',
    ],
    [
      'names sharing only a word',
      3_300,
      'SYNTH AUTO STAND PUNE',
      'UPI/SYNTH TEA STALL/000000000112',
    ],
    [
      'a principal and its interest',
      50_500,
      'SYNTH GADGET HUB - INTEREST 2/6',
      'SYNTH GADGET HUB - PRINCIPAL 2/6',
    ],
    [
      'a second juice with its own number',
      8_400,
      'UPI/SYNTH JUICE BAR/000000000110',
      'UPI/SYNTH JUICE BAR/000000000109',
    ],
  ])(
    'refuses to confirm %s as one movement, and changes nothing',
    async (_what, amount, copyWords, originalWords) => {
      await importScenario();
      const copy = await paymentId(amount, copyWords);
      const original = await paymentId(amount, originalWords);
      const before = [await stateOf(copy), await stateOf(original)];

      const response = await confirm(copy, original);

      expect(response.status).toBe(409);
      expect([await stateOf(copy), await stateOf(original)]).toEqual(before);
    },
  );
});

/* ------------------------------------------------- the owner's decision, 22 September 2026 */

/** The one live payment of this amount on this account. */
async function paymentOn(accountKey: string, amount: number): Promise<string> {
  const rows = await database.db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.accountId, cast.account[accountKey]!),
        eq(schema.payments.amount, BigInt(amount)),
        ne(schema.payments.state, 'ignored'),
      ),
    );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/** The one payment this import wrote printing these words for this amount. */
async function paymentIn(importBatchId: string, amount: number, words: string): Promise<string> {
  const rows = await database.db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.importBatchId, importBatchId),
        eq(schema.payments.amount, BigInt(amount)),
        eq(schema.payments.rawDescription, words),
      ),
    );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

async function confirmCopy(copy: string, original: string): Promise<Response> {
  return post(`/api/review/payments/${copy}/duplicate`, {
    decision: 'confirm',
    actor: 'user',
    duplicateOfPaymentId: original,
  });
}

describe('the same or a sufficiently similar name, whichever account', () => {
  /** A bank statement whose UPI lines carry a note, and a card whose lines carry a city. */
  async function importSimilarNames(): Promise<void> {
    const outcomes = [
      await importInto('account_hdfc_savings', bankStatement(BANK_S, BANK_S_OPENING)),
      await importInto('account_icici_credit_card', cardStatement(CARD_S)),
    ];
    expect(outcomes.map((imported) => imported.outcome)).toEqual(['imported', 'imported']);
  }

  it('asks about one payee named beside a note, a city or a cut, and not about a note’s word', async () => {
    await importSimilarNames();

    // S1–S3 each fail the every-word rule — the bank's note and the card's city are words the
    // other lacks, and the card cut one name short — and each is one payee on one day for one
    // amount. S4's only link is the word PHONE, which is the note's, not a name.
    expect(await casesAsked()).toEqual(['S1', 'S2', 'S3']);
  });

  it('confirms the card line as a copy of the bank line, and keeps both rows', async () => {
    await importSimilarNames();
    const bankLine = await paymentOn('account_hdfc_savings', 64_000);
    const cardLine = await paymentOn('account_icici_credit_card', 64_000);
    const before = await ledgerSize();

    expect((await confirmCopy(cardLine, bankLine)).status).toBe(200);

    expect(await stateOf(cardLine)).toEqual({
      state: 'ignored',
      ignoredReason: `duplicate_of:${bankLine}`,
    });
    expect((await stateOf(bankLine))?.state).not.toBe('ignored');
    // Nothing deleted and nothing merged: the copy is kept, with the reason it does not count.
    expect(await ledgerSize()).toEqual(before);
    expect(await casesAsked()).toEqual(['S2', 'S3']);
  });

  it('refuses to confirm a shop that shares only the note’s word, and changes nothing', async () => {
    await importSimilarNames();
    const bankLine = await paymentOn('account_hdfc_savings', 33_300);
    const cardLine = await paymentOn('account_icici_credit_card', 33_300);
    const before = [await stateOf(cardLine), await stateOf(bankLine)];

    expect((await confirmCopy(cardLine, bankLine)).status).toBe(409);

    expect([await stateOf(cardLine), await stateOf(bankLine)]).toEqual(before);
  });
});

describe('a card statement downloaded again', () => {
  /**
   * The same statement, downloaded on two days. The bytes differ, so it is not recognised as
   * the same file; its lines carry no reference, so no row is recognised either. Every line
   * arrives twice, and every one must be asked about — the tax lines included, each beside the
   * same tax and never beside the other half of it.
   */
  async function importTwice(): Promise<{ first: string; again: string }> {
    const first = await importInto(
      'account_icici_credit_card',
      cardStatement(CARD_F, { generatedOn: '07/02/2026' }),
    );
    const again = await importInto(
      'account_icici_credit_card',
      cardStatement(CARD_F, { generatedOn: '09/02/2026' }),
    );
    expect([first.outcome, again.outcome]).toEqual(['imported', 'imported']);
    return { first: first.importBatchId, again: again.importBatchId };
  }

  it('asks about every line again, and pairs each tax only with the same tax', async () => {
    await importTwice();

    expect(await casesAsked()).toEqual(['T1', 'T2', 'T2', 'T3']);
    const taxPairs = (await duplicateQuestions())
      .filter((question) => caseForAmount(question.amount)?.id === 'T2')
      .map((question) =>
        [question.payment.description, question.candidate.description].sort().join(' + '),
      )
      .sort();
    expect(taxPairs).toEqual(['CGST + CGST', 'SGST + SGST']);
  });

  it('confirms a tax line as a copy of the same tax, and refuses the other half', async () => {
    const batches = await importTwice();
    const firstCgst = await paymentIn(batches.first, 8_910, 'CGST');
    const firstSgst = await paymentIn(batches.first, 8_910, 'SGST');
    const againCgst = await paymentIn(batches.again, 8_910, 'CGST');
    const before = await ledgerSize();
    const states = [await stateOf(againCgst), await stateOf(firstSgst)];

    expect((await confirmCopy(againCgst, firstSgst)).status).toBe(409);
    expect([await stateOf(againCgst), await stateOf(firstSgst)]).toEqual(states);

    expect((await confirmCopy(againCgst, firstCgst)).status).toBe(200);
    expect((await stateOf(againCgst))?.ignoredReason).toBe(`duplicate_of:${firstCgst}`);
    expect((await stateOf(firstCgst))?.state).not.toBe('ignored');
    expect(await ledgerSize()).toEqual(before);
    expect(await casesAsked()).toEqual(['T1', 'T2', 'T3']);
  });

  it('never pairs the two halves of one tax on one statement', async () => {
    await importInto('account_icici_credit_card', cardStatement(CARD_F));

    expect(await casesAsked()).toEqual([]);
  });
});

describe('tables beside PDFs', () => {
  const bankPdf = (): Uint8Array => bankStatement(BANK_G, BANK_G_OPENING);

  it('settles a referenced row at import, asks about the rest, and a file sent again changes nothing', async () => {
    const pdf = await importInto('account_hdfc_savings', bankPdf());
    const csv = await importInto(
      'account_hdfc_savings',
      bankExportCsv(),
      tableOf('bank', 'export.csv'),
    );
    const xlsx = await importInto(
      'account_icici_credit_card',
      cardExportXlsx(),
      tableOf('card', 'export.xlsx'),
    );
    expect([pdf.outcome, csv.outcome, xlsx.outcome]).toEqual(['imported', 'imported', 'imported']);

    // The chemist's UPI number is printed by the PDF and the table alike, so the table's row is
    // settled as a copy at import (ADR-0019) and never becomes a question. The withdrawal has no
    // number and is asked about; so is the card's chemist, the same payee on the same day.
    expect(csv.duplicates).toBe(1);
    expect(await casesAsked()).toEqual(['X1', 'X2']);

    const before = { ledger: await ledgerSize(), asked: await casesAsked() };
    const sentAgain = [
      await importInto('account_hdfc_savings', bankExportCsv(), tableOf('bank', 'export.csv')),
      await importInto(
        'account_icici_credit_card',
        cardExportXlsx(),
        tableOf('card', 'export.xlsx'),
      ),
      await importInto('account_hdfc_savings', bankPdf()),
    ];
    expect(sentAgain.map((imported) => imported.outcome)).toEqual([
      'already_imported',
      'already_imported',
      'already_imported',
    ]);
    expect({ ledger: await ledgerSize(), asked: await casesAsked() }).toEqual(before);
  });

  it('asks about a table saved again as new bytes, and settles its referenced row at import', async () => {
    await importInto('account_hdfc_savings', bankPdf());
    await importInto('account_hdfc_savings', bankExportCsv(), tableOf('bank', 'export.csv'));

    const resaved = await importInto(
      'account_hdfc_savings',
      bankExportCsv('\r\n'),
      tableOf('bank', 'export.csv'),
    );

    expect(resaved.outcome).toBe('imported');
    expect(resaved.duplicates).toBe(1);
    // Three copies of one withdrawal with nothing to tell them apart: every pair is a question.
    expect(await casesAsked()).toEqual(['X2', 'X2', 'X2']);
  });

  it('compares a line only a chosen generic layout can read, like any other', async () => {
    await importInto('account_hdfc_savings', bankPdf());

    const generic = await importInto('account_hdfc_savings', signedAmountCsv(), {
      formatId: 'signed_amount_csv',
      ...tableOf('bank', 'download.csv'),
    });

    expect(generic.outcome).toBe('imported');
    // The line names nobody and neither import printed a number for it: a person is asked.
    expect(await casesAsked()).toEqual(['X3']);
  });
});

describe('a payment typed by hand', () => {
  /** Records a movement by hand, as the Add records screen does. */
  async function typeByHand(externalReference: string): Promise<string> {
    const response = await post('/api/payments', {
      actor: 'user',
      accountId: cast.account['account_hdfc_upi'],
      amount: '7700',
      direction: 'debit',
      occurredAt: '2026-02-03T00:00:00.000Z',
      description: 'Newspaper bill',
      externalReference,
      referenceType: 'upi_utr',
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { paymentId: string }).paymentId;
  }

  it('asks about a hand entry carrying the exact number of a payment already imported', async () => {
    await importInto('account_hdfc_savings', bankStatement(BANK_H, BANK_H_OPENING));

    await typeByHand('UPI-000000000501');

    // Nothing on the hand-entry path settles a shared number the way the importer does, so the
    // queue must ask — otherwise the payment is counted twice and nobody is told.
    expect(await casesAsked()).toEqual(['H1']);
  });

  it('confirms the hand entry as the copy, keeping both rows', async () => {
    await importInto('account_hdfc_savings', bankStatement(BANK_H, BANK_H_OPENING));
    const imported = await paymentOn('account_hdfc_savings', 7_700);
    const typed = await typeByHand('UPI-000000000501');
    const before = await ledgerSize();

    expect((await confirmCopy(typed, imported)).status).toBe(200);

    expect((await stateOf(typed))?.ignoredReason).toBe(`duplicate_of:${imported}`);
    expect(await ledgerSize()).toEqual(before);
    expect(await casesAsked()).toEqual([]);
  });

  it('asks nothing about a hand entry whose own number the statement never printed', async () => {
    await importInto('account_hdfc_savings', bankStatement(BANK_H, BANK_H_OPENING));

    await typeByHand('UPI-000000000599');

    expect(await casesAsked()).toEqual([]);
  });
});
