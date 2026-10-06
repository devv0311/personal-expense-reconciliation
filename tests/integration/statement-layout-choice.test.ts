/**
 * Choosing the layout of a file whose columns fit more than one, over HTTP.
 *
 * `date,description,amount_inr,type,reference` fits two supported layouts equally well, and the
 * two read some rows differently — here a one-letter `D`, a deposit to one and a debit to the
 * other. Detection therefore refuses to pick (it has always done so), and until now the website
 * could not name a layout, so such a file could not be imported from the browser at all.
 *
 * What this pins is the API side of letting a person choose:
 *
 *  - the refusal now carries the **valid** choices as data, so a screen can offer exactly those;
 *  - a preview with a chosen layout reads the original bytes with that layout and **writes
 *    nothing** — no batch, payment, evidence or audit row;
 *  - an import with that layout uses exactly it, checks the account kind from the person's word
 *    (a layout label is never evidence of a kind), and a repeat is a recognised no-op;
 *  - nothing a caller sends can get around any of that.
 *
 * Every figure is synthetic and worked out by hand beside the assertions.
 */

import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase, query } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { sql } from 'drizzle-orm';

const BASE = 'http://localhost';

/**
 * Four movements. Read as the generic layout, `D` is a deposit (money in); read as the card
 * layout it is a debit.
 *
 *   generic: out 1,200.00 + 450.50 = 1,650.50 (2) · in 50,000.00 + 325.25 = 50,325.25 (2)
 *   card:    out 1,200.00 + 450.50 + 325.25 = 1,975.75 (3) · in 50,000.00 (1)
 */
const AMBIGUOUS_CSV = [
  'date,description,amount_inr,type,reference',
  '2026-09-01,UPI-QA GROCER,1200.00,Debit,UPI/QA7001',
  '2026-09-02,UPI-QA CAFE,450.50,Debit,UPI/QA7002',
  '2026-09-03,NEFT SALARY QA,50000.00,Credit,NEFT/QA7003',
  '2026-09-04,QA PHARMACY,325.25,D,UPI/QA7004',
  '',
].join('\n');

/** The card layout reads `Refund` as money in; the generic layout has no such word. */
const REFUND_CSV = [
  'date,description,amount_inr,type,reference',
  '2026-09-01,UPI-QA GROCER,800.00,Debit,UPI/QA8001',
  '2026-09-02,QA SHOP RETURN,300.00,Refund,UPI/QA8002',
  '',
].join('\n');

const HDFC_CSV = [
  'Account Statement (synthetic)',
  'Account No: XXXXXXXX0001',
  '',
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '03/08/26,UPI-QA CAFE DINNER,UPI/QA0001,03/08/26,"3,000.00",0.00,"97,000.00"',
  '',
].join('\n');

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
  NOTHING = await rowCounts();
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
});

async function post<T = Record<string, unknown>>(path: string, body: unknown) {
  const response = await api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as T };
}

const b64 = (text: string) => Buffer.from(text).toString('base64');

interface Preview {
  readable: boolean;
  formatId: string;
  formatLabel?: string;
  accountKind?: string | null;
  movementCount?: number;
  debitCount?: number;
  creditCount?: number;
  totalDebits?: string;
  totalCredits?: string;
  alreadyImported?: unknown;
  problems?: { lineNumber: number; message: string }[];
  ambiguousLayouts?: { id: string; label: string; headerHint: string }[];
}

const preview = (text: string, formatId?: string) =>
  post<Preview>('/api/imports/preview', {
    contentBase64: b64(text),
    filename: 'statement.csv',
    ...(formatId === undefined ? {} : { formatId }),
  });

const importIt = (
  text: string,
  overrides: Record<string, unknown> = {},
  accountKey = 'account_hdfc_savings',
) =>
  post<Record<string, unknown>>('/api/imports/statement', {
    actor: 'user',
    accountId: cast.account[accountKey],
    sourceSystem: 'synthetic_export',
    formatId: 'auto',
    contentBase64: b64(text),
    filename: 'statement.csv',
    fileReference: 'statement.csv',
    statementKind: 'bank',
    ...overrides,
  });

/** The batch the import under test wrote — found by the hash of the bytes sent. */
async function importedBatch(text = AMBIGUOUS_CSV) {
  const [row] = await database.db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.contentHash, createHash('sha256').update(text).digest('hex')));
  return row;
}

async function rowCounts() {
  const rows = await query<Record<string, string>>(
    database.db,
    sql`select
      (select count(*) from import_batches)::text as batches,
      (select count(*) from payments)::text as payments,
      (select count(*) from evidence)::text as evidence,
      (select count(*) from audit_events)::text as audit`,
  );
  return rows[0];
}

/** The ledger as seeded — the cast arrives with one import batch of its own. */
let NOTHING: Awaited<ReturnType<typeof rowCounts>>;

describe('a file whose columns fit two layouts', () => {
  it('is refused by detection with the valid choices as data, none of them a kind of account', async () => {
    const result = await preview(AMBIGUOUS_CSV);

    expect(result.status).toBe(200);
    expect(result.body.readable).toBe(false);
    expect(result.body.formatId).toBe('auto');
    expect(result.body.ambiguousLayouts?.map((choice) => choice.id)).toEqual([
      'generic_bank_csv',
      'card_statement_csv',
    ]);
    for (const choice of result.body.ambiguousLayouts ?? []) {
      expect(choice.label.length).toBeGreaterThan(10);
      expect(choice.headerHint.length).toBeGreaterThan(5);
      // A layout label describes columns; it never says whose statement a file is (ADR-0068).
      expect(choice.label).not.toMatch(/\bcard\b|bank account|savings|credit card/i);
    }
    expect(await rowCounts()).toEqual(NOTHING);
  });

  it('is still refused by an import that asks for automatic detection, writing nothing', async () => {
    const result = await importIt(AMBIGUOUS_CSV);

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toMatch(/more than one layout/);
    expect(await rowCounts()).toEqual(NOTHING);
  });

  it('leaves a header that matches exactly one layout detected, with no choice offered', async () => {
    const result = await preview(HDFC_CSV);

    expect(result.body).toMatchObject({ readable: true, formatId: 'hdfc_bank_csv' });
    expect(result.body.ambiguousLayouts).toBeUndefined();
  });

  it('offers no choice for a file no layout reads', async () => {
    const result = await preview('colour,shape\nred,round\n');

    expect(result.body.readable).toBe(false);
    expect(result.body.ambiguousLayouts).toBeUndefined();
    expect(result.body.problems?.[0]?.message).toMatch(/No supported format matched/);
  });
});

describe('previewing with a chosen layout', () => {
  it('reads the original file with exactly that layout and reports its own figures', async () => {
    const generic = await preview(AMBIGUOUS_CSV, 'generic_bank_csv');
    expect(generic.body).toMatchObject({
      readable: true,
      formatId: 'generic_bank_csv',
      movementCount: 4,
      debitCount: 2,
      creditCount: 2,
      totalDebits: '165050',
      totalCredits: '5032525',
      accountKind: null,
      alreadyImported: null,
    });

    // The same bytes, the other layout: some rows read the other way round.
    const card = await preview(AMBIGUOUS_CSV, 'card_statement_csv');
    expect(card.body).toMatchObject({
      readable: true,
      formatId: 'card_statement_csv',
      movementCount: 4,
      debitCount: 3,
      creditCount: 1,
      totalDebits: '197575',
      totalCredits: '5000000',
      accountKind: null,
    });
  });

  it('writes no batch, payment, evidence or audit row, however many times it is asked', async () => {
    for (const formatId of ['generic_bank_csv', 'card_statement_csv', 'generic_bank_csv']) {
      expect((await preview(AMBIGUOUS_CSV, formatId)).status).toBe(200);
    }
    expect(await rowCounts()).toEqual(NOTHING);
  });

  it('says plainly when the chosen layout cannot read the file, and still writes nothing', async () => {
    const generic = await preview(REFUND_CSV, 'generic_bank_csv');
    expect(generic.body.readable).toBe(false);
    expect(generic.body.problems?.[0]?.message).toMatch(/not a direction this format recognises/);

    const card = await preview(REFUND_CSV, 'card_statement_csv');
    expect(card.body).toMatchObject({
      readable: true,
      movementCount: 2,
      debitCount: 1,
      creditCount: 1,
      totalDebits: '80000',
      totalCredits: '30000',
    });
    expect(await rowCounts()).toEqual(NOTHING);
  });

  it('refuses a layout that does not exist, one for another container, and one the header does not fit', async () => {
    for (const formatId of ['not_a_layout', 'idfc_first_bank_account_pdf', 'hdfc_bank_csv']) {
      const result = await preview(AMBIGUOUS_CSV, formatId);
      expect(result.body.readable).toBe(false);
      expect(result.body.ambiguousLayouts).toBeUndefined();
    }
    expect(await rowCounts()).toEqual(NOTHING);
  });

  it('reports a malformed file as unreadable', async () => {
    const result = await preview(
      'date,description,amount_inr,type,reference\n2026-09-01,ONLY,TWO\n',
      'generic_bank_csv',
    );
    expect(result.body.readable).toBe(false);
    expect(await rowCounts()).toEqual(NOTHING);
  });
});

describe('importing with a chosen layout', () => {
  it('uses exactly that layout, records the original bytes untouched, and writes the figures the preview showed', async () => {
    const result = await importIt(AMBIGUOUS_CSV, { formatId: 'generic_bank_csv' });

    expect(result.status).toBe(201);
    expect(result.body['formatId']).toBe('generic_bank_csv');

    const batch = await importedBatch();
    expect(batch?.sourceChannel).toBe('statement:generic_bank_csv');
    expect(batch?.parserVersion).toContain('generic_bank_csv');
    // The immutable original: the batch is addressed by the hash of the bytes as chosen.
    expect(batch?.contentHash).toBe(createHash('sha256').update(AMBIGUOUS_CSV).digest('hex'));

    const payments = await database.db.select().from(schema.payments);
    const total = (direction: string) =>
      payments
        .filter((payment) => payment.direction === direction)
        .reduce((sum, payment) => sum + payment.amount, 0n);
    expect(payments).toHaveLength(4);
    expect(total('debit')).toBe(165050n);
    expect(total('credit')).toBe(5032525n);
    // The pharmacy `D`, read by the layout the person chose.
    expect(payments.find((payment) => payment.rawDescription === 'QA PHARMACY')?.direction).toBe(
      'credit',
    );
  });

  it("imports the other layout's reading when that is the one chosen — never the one detection preferred", async () => {
    const result = await importIt(AMBIGUOUS_CSV, { formatId: 'card_statement_csv' });

    expect(result.status).toBe(201);
    const payments = await database.db.select().from(schema.payments);
    expect(payments.find((payment) => payment.rawDescription === 'QA PHARMACY')?.direction).toBe(
      'debit',
    );
    const batch = await importedBatch();
    expect(batch?.sourceChannel).toBe('statement:card_statement_csv');
  });

  it('is a recognised no-op the second time, whichever layout is named', async () => {
    expect((await importIt(AMBIGUOUS_CSV, { formatId: 'generic_bank_csv' })).status).toBe(201);
    const before = await rowCounts();

    for (const formatId of ['generic_bank_csv', 'card_statement_csv']) {
      const again = await importIt(AMBIGUOUS_CSV, { formatId });
      expect(again.status).toBe(200);
      expect(again.body['outcome']).toBe('already_imported');
    }
    expect(await rowCounts()).toEqual(before);

    // And the preview says so before anybody presses anything.
    const seen = await preview(AMBIGUOUS_CSV, 'generic_bank_csv');
    expect(seen.body.alreadyImported).not.toBeNull();
  });

  it('still needs the person to say what kind of account it is — the layout is never evidence of one', async () => {
    const without = await importIt(AMBIGUOUS_CSV, {
      formatId: 'card_statement_csv',
      statementKind: undefined,
    });
    expect(without.status).toBe(400);
    expect((without.body as { error: { code: string } }).error.code).toBe(
      'STATEMENT_KIND_REQUIRED',
    );
    expect(await rowCounts()).toEqual(NOTHING);
  });

  it('refuses an account of another kind than the person said, for either layout', async () => {
    for (const formatId of ['generic_bank_csv', 'card_statement_csv']) {
      const result = await importIt(
        AMBIGUOUS_CSV,
        { formatId, statementKind: 'bank' },
        'account_icici_credit_card',
      );
      expect(result.status).toBe(409);
      expect((result.body as { error: { code: string } }).error.code).toBe(
        'STATEMENT_ACCOUNT_MISMATCH',
      );
    }
    const wayRound = await importIt(
      AMBIGUOUS_CSV,
      { formatId: 'generic_bank_csv', statementKind: 'card' },
      'account_hdfc_savings',
    );
    expect(wayRound.status).toBe(409);
    expect(await rowCounts()).toEqual(NOTHING);
  });

  it("treats the layout and the kind as independent: the card-shaped layout can carry a bank account's file", async () => {
    const result = await importIt(AMBIGUOUS_CSV, {
      formatId: 'card_statement_csv',
      statementKind: 'bank',
    });
    expect(result.status).toBe(201);
    const [account] = await database.db
      .select({ type: schema.accounts.type })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, cast.account['account_hdfc_savings']!));
    expect(account?.type).toBe('bank');
  });

  it('refuses a layout that does not exist, one for another container, and one the header does not fit — writing nothing', async () => {
    for (const formatId of ['not_a_layout', 'idfc_first_bank_account_pdf', 'hdfc_bank_csv']) {
      const result = await importIt(AMBIGUOUS_CSV, { formatId });
      expect(result.status).toBe(400);
    }
    expect(await rowCounts()).toEqual(NOTHING);
  });

  it('refuses a malformed file and a layout that cannot read one of its rows, all or nothing', async () => {
    const malformed = await importIt(
      'date,description,amount_inr,type,reference\n2026-09-01,ONLY,TWO\n',
      { formatId: 'generic_bank_csv' },
    );
    expect(malformed.status).toBe(400);

    const wrongWord = await importIt(REFUND_CSV, { formatId: 'generic_bank_csv' });
    expect(wrongWord.status).toBe(400);
    expect(await rowCounts()).toEqual(NOTHING);

    // The retry that works: the same file, the other layout, and only then does anything land.
    const retry = await importIt(REFUND_CSV, { formatId: 'card_statement_csv' });
    expect(retry.status).toBe(201);
    expect((await rowCounts())?.payments).toBe('2');
  });
});
