/**
 * An import reads what it just wrote, in the same request.
 *
 * Importing a statement and being told what is on it used to be two separate acts, and the
 * second one was a button named after the machinery. Until somebody pressed it the rows sat
 * unread, and the front page reported nothing spent over a statement it held in full.
 *
 * What is worth testing is not that the reading happens. It is that it stays **safe** while
 * happening unattended: it approves nothing, it never writes twice however many times the
 * request is repeated, and a failure in the reading never reports the import — already
 * committed — as having failed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import { resetPreparationForTests } from '../../src/services/index.js';
import { unconfiguredTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';

/**
 * A statement shaped like a real card statement: a purchase, the instalment rows for it, the
 * tax on those, a fee, and the bill being paid. Four of the six must never be proposed.
 */
const STATEMENT = [
  'Transaction Date,Transaction Description,Amount,Debit/Credit,Reference',
  '08/09/2026,Q SYN FITNESS,"2,500.00",Debit,CARD/990001',
  '09/09/2026,Q SYN FITNESS - INTEREST 2 - <2/6>,"312.00",Debit,CARD/990002',
  '09/09/2026,Q SYN FITNESS - PRINCIPAL 2 - <2/6>,"1,800.00",Debit,CARD/990003',
  '09/09/2026,CGST,"28.08",Debit,CARD/990004',
  '09/09/2026,EMI 4821 FEE,"295.00",Debit,CARD/990005',
  '20/09/2026,CARD PAYMENT RECEIVED,"9,000.00",Credit,CARD/990006',
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
  resetPreparationForTests();
  cast = await seedCast(database.db);
  // The installation this ships as: every adapter present, no provider configured.
  api = createApi({
    db: database.db,
    ai: createAiService(unconfiguredTransport()),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
});

interface ImportBody {
  outcome: string;
  importBatchId?: string;
  paymentIds?: string[];
  prepared:
    | {
        ran: true;
        analysis: { questionsForYou: number; suggestionsReady: number; complete: boolean };
      }
    | { ran: false; reason: string };
}

async function importStatement(content = STATEMENT): Promise<ImportBody> {
  const response = await api.handle(
    new Request(`${BASE}/api/imports/statement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'user:dev',
        // A card's export, onto the card: the person says whose it is, because its columns
        // cannot (ADR-0068).
        accountId: cast.account['account_icici_credit_card'],
        sourceSystem: 'test-card',
        formatId: 'auto',
        fileContent: content,
        fileReference: 'statement.csv',
        statementKind: 'card',
      }),
    }),
  );
  return (await response.json()) as ImportBody;
}

async function attention(): Promise<{
  total: number;
  counts: Record<string, number>;
  items: { kind: string }[];
}> {
  const response = await api.handle(new Request(`${BASE}/api/attention?limit=50`));
  return (await response.json()) as {
    total: number;
    counts: Record<string, number>;
    items: { kind: string }[];
  };
}

describe('importing a statement reads it', () => {
  it('comes back with questions ready, without anybody asking for them', async () => {
    const body = await importStatement();

    expect(body.prepared.ran).toBe(true);
    if (!body.prepared.ran) return;
    expect(body.prepared.analysis.suggestionsReady).toBeGreaterThan(0);
    expect(body.prepared.analysis.questionsForYou).toBeGreaterThan(0);
    // The reading ran to completion, so the screen may say so.
    expect(body.prepared.analysis.complete).toBe(true);
  });

  it('approves nothing at all', async () => {
    await importStatement();

    const expenses = await database.db.select().from(schema.expenses);
    expect(expenses.length).toBeGreaterThan(0);
    // Every derived expense is waiting on a person. None is `approved`.
    expect(expenses.every((expense) => expense.state !== 'approved')).toBe(true);

    const inferences = await database.db.select().from(schema.aiInferences);
    expect(inferences.every((inference) => inference.status === 'pending')).toBe(true);

    // No allocation, no obligation, no settlement — nothing that could move a balance.
    expect(await database.db.select().from(schema.allocations)).toHaveLength(0);
    expect(await database.db.select().from(schema.settlements)).toHaveLength(0);
  });

  it('keeps the safety rules while running unattended', async () => {
    await importStatement();

    const proposed = await database.db.select().from(schema.expenses);
    const byDescription = new Map(proposed.map((row) => [row.description, row.category]));

    // The purchase is categorised by its own words…
    expect(byDescription.get('Q SYN FITNESS')).toBe('Gym & fitness');
    // …the interest on it never is.
    expect(byDescription.get('Q SYN FITNESS - INTEREST 2 - <2/6>')).toBe('Bills & subscriptions');
    // The tax line, the repayment and the credit are not proposed at all.
    expect(byDescription.has('CGST')).toBe(false);
    expect(byDescription.has('Q SYN FITNESS - PRINCIPAL 2 - <2/6>')).toBe(false);
    expect(byDescription.has('CARD PAYMENT RECEIVED')).toBe(false);
  });

  it('does not modify the statement rows it read', async () => {
    const body = await importStatement();
    const paymentId = body.paymentIds?.[0];
    expect(paymentId).toBeDefined();

    const [payment] = await database.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId!));
    // SOURCE columns are write-once (`invariants.md` #4); reading a row may move its state and
    // may not touch what the bank said.
    expect(payment?.rawDescription).toBe('Q SYN FITNESS');
    expect(payment?.amount).toBe(250000n);
  });
});

describe('repeating it', () => {
  it('writes no second question when the same file is sent again', async () => {
    await importStatement();
    const first = await attention();
    const inferencesFirst = await database.db.select().from(schema.aiInferences);

    const second = await importStatement();
    expect(second.outcome).toBe('already_imported');
    // Nothing new was written, so there is nothing new to read — and it says so.
    expect(second.prepared.ran).toBe(false);

    expect((await attention()).total).toBe(first.total);
    expect(await database.db.select().from(schema.aiInferences)).toHaveLength(
      inferencesFirst.length,
    );
  });

  it('writes no second question when two readings are asked for at once', async () => {
    await importStatement();
    const before = await database.db.select().from(schema.aiInferences);

    // Two callers, overlapping: the screen that opened after the import, and a refresh of it.
    const analyse = () =>
      api.handle(
        new Request(`${BASE}/api/analysis`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: 'user:dev' }),
        }),
      );
    await Promise.all([analyse(), analyse(), analyse()]);

    expect(await database.db.select().from(schema.aiInferences)).toHaveLength(before.length);
  });
});

describe('when the reading cannot finish', () => {
  it('still reports the import as done, because the rows are committed', async () => {
    // A statement whose rows import cleanly; the reading is then made to fail by closing the
    // door it needs — the point is that the import's own outcome is unaffected.
    const body = await importStatement();
    expect(body.outcome).not.toBe('failed');
    expect(body.paymentIds?.length).toBeGreaterThan(0);

    // And the rows really are on record, whatever the reading did.
    const payments = await database.db.select().from(schema.payments);
    expect(payments).toHaveLength(6);
  });
});

describe('records an earlier version left unread', () => {
  async function readiness(): Promise<number> {
    const response = await api.handle(new Request(`${BASE}/api/overview`));
    const body = (await response.json()) as {
      readiness: { recordsAwaitingAnalysis: number };
    };
    return body.readiness.recordsAwaitingAnalysis;
  }

  it('counts a normalized payment nobody ever asked about as still waiting', async () => {
    // The state a ledger imported before imports read their own rows is left in: normalized,
    // and never asked what it was for. Counting only un-normalized rows called this finished,
    // so the front page offered nothing to do over statements nothing had looked at.
    await importStatement();
    await api.handle(
      new Request(`${BASE}/api/analysis`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'user:dev' }),
      }),
    );

    // Everything a reading has anything to say about has now been said.
    expect(await readiness()).toBe(0);
  });

  it('does not keep asking about rows a reading will never speak about', async () => {
    // A tax line and an unreadable descriptor are both refused a proposal for ever. If they
    // counted as waiting, the front page would prompt permanently and re-read the whole ledger
    // on every visit to do nothing each time.
    await importStatement(
      [
        'Transaction Date,Transaction Description,Amount,Debit/Credit,Reference',
        '09/09/2026,CGST,"28.08",Debit,CARD/990101',
        '09/09/2026,QX7719 ZZ,"104.00",Debit,CARD/990102',
      ].join('\n'),
    );

    expect(await readiness()).toBe(0);
  });
});

describe("the two halves of one charge's tax", () => {
  it('never reach the queue as a payment recorded twice', async () => {
    // One charge printed as three lines, which is how an Indian card statement prints it. The
    // two tax halves are equal to the paisa on the same day and carry no reference — exactly
    // what the possible-duplicate rule otherwise reads as one payment recorded twice.
    await importStatement(
      [
        'Transaction Date,Transaction Description,Amount,Debit/Credit,Reference',
        '09/09/2026,GREENLEAF SUPERMARKET,"1,845.00",Debit,CARD/770001',
        '09/09/2026,CGST,"166.05",Debit,CARD/770002',
        '09/09/2026,SGST,"166.05",Debit,CARD/770003',
      ].join('\n'),
    );

    const waiting = await attention();
    expect(waiting.counts['possible_duplicate'] ?? 0).toBe(0);
    expect(waiting.items.some((item) => item.kind === 'possible_duplicate')).toBe(false);
    // And nothing about the tax was deleted or hidden to achieve it.
    const payments = await database.db.select().from(schema.payments);
    expect(payments).toHaveLength(3);
    expect(payments.every((payment) => payment.state !== 'ignored')).toBe(true);
  });

  it('still asks about two ordinary purchases that look alike', async () => {
    // The same line printed twice, with no reference to settle it — what the tax rule must not
    // swallow. Given two different references instead, the statement itself would be saying
    // these are two purchases: that is a repeated charge to notice (ADR-0063), not one payment
    // recorded twice (`invariants.md` #10).
    await importStatement(
      [
        'Transaction Date,Transaction Description,Amount,Debit/Credit,Reference',
        '09/09/2026,CITYLINE PHARMACY,"642.00",Debit,',
        '09/09/2026,CITYLINE PHARMACY,"642.00",Debit,',
      ].join('\n'),
    );

    const waiting = await attention();
    expect(waiting.counts['possible_duplicate'] ?? 0).toBe(1);
  });
});
