/**
 * The journey end to end: add records, analyse them, answer the questions, see the result.
 *
 * These are not tests that the endpoints return fields. They are the handful of product
 * promises that, if any one broke, would make the whole surface untrustworthy:
 *
 *  - Analysis **never approves anything**, and running it twice changes nothing.
 *  - A stage that could not run is reported by name, and the run does not read as finished.
 *  - A record that has been imported and not read is never reported as categorised spending.
 *  - The direction of a debt follows who actually paid, never who is looking at the screen.
 *  - Every share a screen shows was computed by the ledger, and the preview is the thing that
 *    gets written.
 *  - A repayment reduces a balance and is never spending.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import { asId, paise } from '../../src/domain/index.js';
import type { ExpenseId, Paise, PaymentId, PersonId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import type { Api } from '../../src/api/index.js';
import { scriptedClassificationTransport, unconfiguredTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { addExpense, addPayment, linkPaymentToExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';

let database: TestDatabase;
let api: Api;
let unconfiguredApi: Api;
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
  const shared = {
    db: database.db,
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  };
  api = createApi({
    ...shared,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
  });
  // The default installation: no key, so nothing can suggest what a payment was for.
  unconfiguredApi = createApi({ ...shared, ai: createAiService(unconfiguredTransport()) });
});

/* -------------------------------------------------------------------------- helpers */

interface AnalysisBody {
  recordsChecked: number;
  connectionsFound: number;
  suggestionsReady: number;
  questionsForYou: number;
  notUnderstood: number;
  complete: boolean;
  stages: {
    name: string;
    status: string;
    summary: string;
    unfinishedReason?: string;
    recordsTouched: number;
  }[];
}

async function analyze(which: Api = unconfiguredApi): Promise<AnalysisBody> {
  const response = await which.handle(
    new Request(`${BASE}/api/analysis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'user' }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as AnalysisBody;
}

async function json<T>(path: string): Promise<T> {
  const response = await api.handle(new Request(`${BASE}${path}`));
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as T };
}

async function importedPayment(options: {
  amount: Paise;
  description: string;
}): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: options.amount,
    direction: 'debit',
    occurredAt: new Date('2026-07-02T10:00:00.000Z'),
    rawDescription: options.description,
    channel: 'upi',
    // As the importer leaves it: nothing has read it yet.
    state: 'imported',
  });
}

async function sharedExpense(options: {
  amount: Paise;
  paidByPersonId: PersonId;
}): Promise<{ paymentId: PaymentId; expenseId: ExpenseId }> {
  const paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: options.amount,
    direction: 'debit',
    occurredAt: new Date('2026-07-02T10:00:00.000Z'),
    rawDescription: 'UPI-SAMPLE MERCHANT',
    channel: 'upi',
  });
  const expenseId = await addExpense(database.db, {
    description: 'Dinner',
    amount: options.amount,
    occurredAt: new Date('2026-07-02T10:00:00.000Z'),
    relationshipType: 'shared',
    paidByPersonId: options.paidByPersonId,
  });
  await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: options.amount });
  return { paymentId, expenseId };
}

/* -------------------------------------------------------------------- analysing */

describe('analyzing records is one thing a person does', () => {
  it('reads imported records without asking for two technical actions first', async () => {
    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });

    const result = await analyze();

    // One call. No normalize-then-classify ordering for anybody to know about.
    expect(result.stages.map((stage) => stage.name)).toEqual([
      'read_records',
      'work_out_purpose',
      'connect_records',
    ]);
    expect(result.stages[0]?.status).toBe('done');
    expect(result.recordsChecked).toBeGreaterThan(0);
  });

  it('is idempotent: a second run over an unchanged ledger changes nothing', async () => {
    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });

    const first = await analyze();
    const second = await analyze();

    expect(first.stages[0]?.recordsTouched).toBeGreaterThan(0);
    expect(second.stages[0]?.recordsTouched).toBe(0);
    expect(second.stages[0]?.summary).toContain('already been read');
    expect(second.questionsForYou).toBe(first.questionsForYou);
  });

  it('approves nothing — every proposal is still waiting afterwards', async () => {
    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });
    await analyze();

    const expenses = await json<{ expenses: { state: string }[] }>('/api/expenses');
    // Nothing became an approved expense, and no allocation was written.
    expect(expenses.expenses.filter((expense) => expense.state === 'approved')).toHaveLength(0);
    expect(expenses.expenses.filter((expense) => expense.state === 'allocated')).toHaveLength(0);

    const outstanding = await json<{ totalOwedToUser: string; totalOwedByUser: string }>(
      '/api/analytics/outstanding',
    );
    // And no debt was invented.
    expect(outstanding.totalOwedToUser).toBe('0');
    expect(outstanding.totalOwedByUser).toBe('0');
  });

  it('names the stage that could not run, and does not call the run finished', async () => {
    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });

    const result = await analyze();
    const purpose = result.stages.find((stage) => stage.name === 'work_out_purpose');

    expect(purpose?.status).toBe('skipped');
    expect(purpose?.unfinishedReason).toMatch(/nothing was guessed/i);
    expect(result.complete).toBe(false);
    // The deterministic stages still ran to completion.
    expect(result.stages.find((stage) => stage.name === 'read_records')?.status).toBe('done');
    expect(result.stages.find((stage) => stage.name === 'connect_records')?.status).toBe('done');
  });

  it('says nothing technical on the surface it reports back', async () => {
    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });
    const result = await analyze();

    const words = JSON.stringify(
      result.stages.map((stage) => [stage.summary, stage.unfinishedReason]),
    );
    expect(words).not.toMatch(/normaliz|classif|ANTHROPIC|inference|evidence_match|cash.flow/i);
  });

  it('pairs both legs of a transfer between your own accounts with no model at all', async () => {
    const reference = 'TRF-9821';
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(2500000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-05T10:00:00.000Z'),
      rawDescription: 'CARD BILL PAYMENT',
      channel: 'bank_transfer',
      externalReference: reference,
      state: 'imported',
    });
    await addPayment(database.db, cast, {
      accountId: cast.account['account_icici_credit_card']!,
      amount: paise(2500000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-05T10:00:00.000Z'),
      rawDescription: 'PAYMENT RECEIVED',
      channel: 'bank_transfer',
      externalReference: reference,
      state: 'imported',
    });

    const result = await analyze();
    const purpose = result.stages.find((stage) => stage.name === 'work_out_purpose');

    // The rule that keeps a credit-card bill payment out of spending is arithmetic over two
    // rows, and it does not need a provider.
    expect(purpose?.summary).toContain('between your own accounts');
    expect(purpose?.recordsTouched).toBeGreaterThan(0);
  });
});

describe('what has not been read is not reported as spending', () => {
  it('counts an unanalysed movement as waiting, never as categorised spending', async () => {
    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });

    const before = await json<{
      readiness: { recordsAwaitingAnalysis: number };
      spending: { total: { known: boolean; amount: string } };
    }>('/api/overview');

    expect(before.readiness.recordsAwaitingAnalysis).toBe(1);
    // ₹0 spent — and the readiness figure is what stops a screen presenting that as the answer.
    expect(before.spending.total.amount).toBe('0');

    await analyze();
    const after = await json<{ readiness: { recordsAwaitingAnalysis: number } }>('/api/overview');
    expect(after.readiness.recordsAwaitingAnalysis).toBe(0);
  });

  it('stops prompting once every record has been read, whatever documents remain', async () => {
    const [row] = await database.db
      .insert(schema.evidence)
      .values({
        type: 'receipt_image',
        capturedAt: new Date('2026-07-02T10:05:00.000Z'),
        storageRef: 'sha256/aa.png',
        mediaType: 'image/png',
        byteSize: 1024,
      })
      .returning({ id: schema.evidence.id });
    expect(row).toBeDefined();

    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });

    const before = await json<{
      readiness: { recordsAwaitingAnalysis: number; documentsAwaitingAnalysis: number };
    }>('/api/overview');
    expect(before.readiness.recordsAwaitingAnalysis).toBe(1);
    expect(before.readiness.documentsAwaitingAnalysis).toBe(1);

    await analyze();

    // The payment has been read, so the prompt is done. The document is still attached to
    // nothing — that is a question now, not an unanalysed record, and re-running would not
    // change it.
    const after = await json<{
      readiness: { recordsAwaitingAnalysis: number; documentsAwaitingAnalysis: number };
    }>('/api/overview');
    expect(after.readiness.recordsAwaitingAnalysis).toBe(0);
    expect(after.readiness.documentsAwaitingAnalysis).toBe(1);
  });

  it('keeps unread money discoverable from spending rather than only from a queue', async () => {
    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });
    await analyze();

    const spending = await json<{
      unaccountedFor: { total: { amount: string }; movementCount: number; movements: unknown[] };
    }>('/api/spending');

    expect(spending.unaccountedFor.total.amount).toBe('124000');
    expect(spending.unaccountedFor.movementCount).toBe(1);
    expect(spending.unaccountedFor.movements).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------- the split */

describe('saying who shared an expense', () => {
  it('previews an equal split with the ledger doing the dividing', async () => {
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });

    const { status, body } = await post<{
      shares: { name: string; isYou: boolean; amount: string }[];
      obligations: { name: string; amount: string; direction: string }[];
      refusal: unknown;
    }>(`/api/expenses/${expenseId}/allocation/preview`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_flatmate_a'] },
      ],
    });

    expect(status).toBe(200);
    expect(body.refusal).toBeNull();
    expect(body.shares.map((share) => share.amount).sort()).toEqual(['30000', '30000']);
    expect(body.obligations).toHaveLength(1);
    expect(body.obligations[0]?.direction).toBe('collect');
    expect(body.obligations[0]?.amount).toBe('30000');
  });

  it('writes exactly what it previewed', async () => {
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });
    const decision = {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_flatmate_a'] },
      ],
    };

    const preview = await post<{ shares: { beneficiaryId: string; amount: string }[] }>(
      `/api/expenses/${expenseId}/allocation/preview`,
      decision,
    );
    const approved = await post<{ lines: { amount: string }[] }>(
      `/api/expenses/${expenseId}/allocation`,
      { ...decision, decidedBy: 'manual', actor: 'user', reason: 'split evenly' },
    );

    expect(approved.status).toBe(201);
    expect(approved.body.lines.map((line) => line.amount).sort()).toEqual(
      preview.body.shares.map((share) => share.amount).sort(),
    );
  });

  it('previews exact shares, and refuses one that does not add up — as a value, not a throw', async () => {
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });

    const good = await post<{ shares: { amount: string }[]; refusal: unknown }>(
      `/api/expenses/${expenseId}/allocation/preview`,
      {
        method: 'exact',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, amount: '20000' },
          {
            beneficiary: { type: 'person', id: cast.person['person_flatmate_a'] },
            amount: '40000',
          },
        ],
      },
    );
    expect(good.body.refusal).toBeNull();
    expect(good.body.shares.map((share) => share.amount).sort()).toEqual(['20000', '40000']);

    const bad = await post<{ refusal: { message: string } | null; shares: unknown[] }>(
      `/api/expenses/${expenseId}/allocation/preview`,
      {
        method: 'exact',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, amount: '20000' },
          {
            beneficiary: { type: 'person', id: cast.person['person_flatmate_a'] },
            amount: '10000',
          },
        ],
      },
    );
    // A person has to read this before pressing a button, not after.
    expect(bad.status).toBe(200);
    expect(bad.body.refusal).not.toBeNull();
    expect(bad.body.shares).toHaveLength(0);
  });

  it('says why nobody would owe anything, rather than leaving an empty list', async () => {
    const personal = await addExpense(database.db, {
      description: 'A book for myself',
      amount: paise(40000n),
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });

    const { body } = await post<{
      obligations: unknown[];
      noObligationsBecause: string | null;
    }>(`/api/expenses/${personal}/allocation/preview`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_flatmate_a'] },
      ],
    });

    // Naming a second person on a personal expense divides it and creates no debt. Saying so
    // is the difference between a rule and a screen that appears not to work.
    expect(body.obligations).toHaveLength(0);
    expect(body.noObligationsBecause).toContain('bought for one person');
  });

  it('states the debt in the direction the payer sets, not towards whoever is looking', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: flatmate,
    });

    const { body } = await post<{
      paidBy: { isYou: boolean };
      obligations: { direction: string; amount: string }[];
    }>(`/api/expenses/${expenseId}/allocation/preview`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: flatmate },
      ],
    });

    expect(body.paidBy.isYou).toBe(false);
    expect(body.obligations).toHaveLength(1);
    expect(body.obligations[0]?.direction).toBe('pay');
  });
});

/* ------------------------------------------- a debt nobody owes must exist nowhere */

describe('an expense nobody owes for', () => {
  /**
   * Dividing a `personal` or `gift` expense records who benefited and creates no debt at all
   * (`invariants.md` #2a). The screens read that through two different paths — the person
   * detail runs `domain.computeObligations`, while the summary totals traverse the allocation
   * lines in SQL — and if only one of them applies the rule, the front page invents money
   * somebody owes and the screen it links to denies it.
   */
  async function dividePersonal(kind: 'personal' | 'gift'): Promise<ExpenseId> {
    const flatmate = cast.person['person_flatmate_a']!;
    const expenseId = await addExpense(database.db, {
      description: kind === 'gift' ? 'A present for Flatmate A' : 'A book for myself',
      amount: paise(40000n),
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      relationshipType: kind,
      paidByPersonId: cast.userPersonId,
    });
    const approved = await post(`/api/expenses/${expenseId}/allocation`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: flatmate },
      ],
      decidedBy: 'manual',
      actor: 'user',
      reason: 'who benefited from it',
    });
    expect(approved.status).toBe(201);
    return expenseId;
  }

  it('creates no debt in the outstanding totals, however it is divided', async () => {
    await dividePersonal('personal');

    const outstanding = await json<{
      counterparties: { displayName: string; netBalance: string }[];
      totalOwedToUser: string;
      totalOwedByUser: string;
    }>('/api/analytics/outstanding');

    expect(outstanding.counterparties).toHaveLength(0);
    expect(outstanding.totalOwedToUser).toBe('0');
    expect(outstanding.totalOwedByUser).toBe('0');
  });

  it('is the same answer for a gift', async () => {
    await dividePersonal('gift');
    const outstanding = await json<{ totalOwedToUser: string }>('/api/analytics/outstanding');
    expect(outstanding.totalOwedToUser).toBe('0');
  });

  it('is never reported as fronted for somebody else', async () => {
    await dividePersonal('personal');
    const unsettled = await json<{ expenses: unknown[]; totalOwedToUser: string }>(
      '/api/analytics/unsettled',
    );
    expect(unsettled.expenses).toHaveLength(0);
    expect(unsettled.totalOwedToUser).toBe('0');
  });

  it('makes the summary and the person screen agree, beside a real shared expense', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    // One genuine shared expense, which does create a debt...
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });
    await post(`/api/expenses/${expenseId}/allocation`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: flatmate },
      ],
      decidedBy: 'manual',
      actor: 'user',
    });
    // ...and one personal one divided the same way, which does not.
    await dividePersonal('personal');

    const overview = await json<{
      people: { toCollect: { amount: string }; counterparties: { netBalance: string }[] };
    }>('/api/overview');
    const person = await json<{ amount: string; direction: string; contributions: unknown[] }>(
      `/api/people/${flatmate}/balance`,
    );

    // The front page and the screen its row opens quote the same figure, and it is the
    // shared expense's half — not that plus a share of something nobody owes for.
    expect(person.amount).toBe('30000');
    expect(person.direction).toBe('collect');
    expect(person.contributions).toHaveLength(1);
    expect(overview.people.toCollect.amount).toBe('30000');
    expect(overview.people.counterparties.map((row) => row.netBalance)).toEqual(['30000']);
  });

  it("says on the event's own screen that nothing is owed for it", async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(40000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-BOOKSHOP',
      channel: 'upi',
    });
    const expenseId = await dividePersonal('personal');
    await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: paise(40000n) });

    const connection = await json<{
      expenses: { shares: unknown[] | null; obligationNote: string | null }[];
    }>(`/api/connections/${paymentId}`);

    const expense = connection.expenses[0];
    expect(expense?.shares).toHaveLength(2);
    // Two people are named, and the sentence beside them does not promise a debt.
    expect(expense?.obligationNote).toContain('without creating a debt');
    expect(expense?.obligationNote).not.toContain('owes you');
  });
});

/* ------------------------------------------------------------------- the balance */

describe("one person's balance, explained", () => {
  it('explains a balance in the events behind it', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });
    await post(`/api/expenses/${expenseId}/allocation`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: flatmate },
      ],
      decidedBy: 'manual',
      actor: 'user',
    });

    const person = await json<{
      direction: string;
      amount: string;
      contributions: { whatItWas: string | null; direction: string; paidByIsYou: boolean }[];
    }>(`/api/people/${flatmate}/balance`);

    expect(person.direction).toBe('collect');
    expect(person.amount).toBe('30000');
    expect(person.contributions).toHaveLength(1);
    expect(person.contributions[0]?.whatItWas).toBe('Dinner');
    expect(person.contributions[0]?.paidByIsYou).toBe(true);
  });

  it('runs the other way when somebody else paid', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    const { expenseId } = await sharedExpense({ amount: paise(60000n), paidByPersonId: flatmate });
    await post(`/api/expenses/${expenseId}/allocation`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: flatmate },
      ],
      decidedBy: 'manual',
      actor: 'user',
    });

    const person = await json<{ direction: string; amount: string }>(
      `/api/people/${flatmate}/balance`,
    );
    expect(person.direction).toBe('pay');
    expect(person.amount).toBe('30000');
  });

  it('reports a repayment as reducing the balance, and never as spending', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });
    await post(`/api/expenses/${expenseId}/allocation`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: flatmate },
      ],
      decidedBy: 'manual',
      actor: 'user',
    });

    const before = await json<{ amount: string }>(`/api/people/${flatmate}/balance`);
    const spendingBefore = await json<{ total: { amount: string } }>(
      '/api/spending?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z',
    );

    const repayment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(30000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-10T10:00:00.000Z'),
      rawDescription: 'UPI-REPAYMENT',
      channel: 'upi',
    });
    const settled = await post(`/api/payments/${repayment}/settlements`, {
      counterpartyPersonId: flatmate,
      amount: '30000',
      actor: 'user',
      reason: 'paid me back for dinner',
    });
    expect(settled.status).toBe(201);

    const after = await json<{ amount: string; direction: string; settlements: unknown[] }>(
      `/api/people/${flatmate}/balance`,
    );
    const spendingAfter = await json<{ total: { amount: string } }>(
      '/api/spending?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z',
    );

    expect(before.amount).toBe('30000');
    expect(after.amount).toBe('0');
    expect(after.direction).toBe('settled');
    expect(after.settlements).toHaveLength(1);
    // A settlement discharges a debt; it is never new spend (`invariants.md` #9).
    expect(spendingAfter.total.amount).toBe(spendingBefore.total.amount);
  });

  it('moves the shares when money comes back, rather than leaving a stale figure unmarked', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });
    await post(`/api/expenses/${expenseId}/allocation`, {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: flatmate },
      ],
      decidedBy: 'manual',
      actor: 'user',
    });

    const refundPayment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(20000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-09T10:00:00.000Z'),
      rawDescription: 'UPI-REFUND',
      channel: 'upi',
    });
    const adjustment = await post(`/api/expenses/${expenseId}/adjustments`, {
      kind: 'merchant_refund',
      amount: '20000',
      occurredAt: '2026-07-09T10:00:00.000Z',
      adjustmentPaymentId: refundPayment,
      actor: 'user',
      reason: 'one dish returned',
    });
    expect(adjustment.status).toBe(201);

    // Recorded but not yet distributed: the balance is still what the allocation says, and the
    // read says so rather than presenting a stale figure as current (audit row 25).
    const pending = await json<{ pendingRefundExpenseIds: string[]; amount: string }>(
      `/api/people/${flatmate}/balance`,
    );
    expect(pending.pendingRefundExpenseIds).toContain(expenseId);
    expect(pending.amount).toBe('30000');

    await post(`/api/expenses/${expenseId}/adjustments/distribute`, {
      decidedBy: 'manual',
      actor: 'user',
      reason: 'share the refund evenly',
    });

    const after = await json<{ pendingRefundExpenseIds: string[]; amount: string }>(
      `/api/people/${flatmate}/balance`,
    );
    expect(after.pendingRefundExpenseIds).toHaveLength(0);
    expect(after.amount).toBe('20000');
  });
});

/* ------------------------------------------------------------------- what you spent */

describe('what you spent', () => {
  it('reports figures that agree with the specialist reads', async () => {
    const { expenseId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });
    expect(expenseId).toBeTruthy();

    const period = '?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z';
    const spending = await json<{
      total: { amount: string };
      own: { share: string; paidByYou: string };
      cameBack: { total: string };
    }>(`/api/spending${period}`);
    const category = await json<{ netTotal: string }>(`/api/analytics/spending${period}`);
    const own = await json<{ ownShare: string; paidByUser: string }>(
      `/api/analytics/own-spend${period}`,
    );

    expect(spending.total.amount).toBe(category.netTotal);
    expect(spending.own.share).toBe(own.ownShare);
    expect(spending.own.paidByYou).toBe(own.paidByUser);
    expect(spending.cameBack.total).toBe('0');
  });

  it('counts one payment with several supporting records once', async () => {
    const { paymentId } = await sharedExpense({
      amount: paise(60000n),
      paidByPersonId: cast.userPersonId,
    });
    for (const type of ['receipt_image', 'screenshot']) {
      await database.db.insert(schema.evidence).values({
        type,
        capturedAt: new Date('2026-07-02T10:05:00.000Z'),
        storageRef: `sha256/${type}.png`,
        mediaType: 'image/png',
        byteSize: 1024,
        linkedPaymentId: paymentId,
      });
    }

    const period = '?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z';
    const spending = await json<{ total: { amount: string } }>(`/api/spending${period}`);
    const connection = await json<{
      supportingRecords: unknown[];
      spendingContribution: string;
      expenses: unknown[];
    }>(`/api/connections/${paymentId}`);

    expect(connection.supportingRecords).toHaveLength(2);
    expect(connection.expenses).toHaveLength(1);
    expect(connection.spendingContribution).toBe('60000');
    expect(spending.total.amount).toBe('60000');
  });

  it('says the ledger has no user rather than reporting zero for nobody', async () => {
    // A ledger with nothing seeded at all: no user, so nobody whose spending to report.
    await database.truncateAll();
    const response = await api.handle(new Request(`${BASE}/api/spending`));
    // Not a confident ₹0 over a ledger that has nobody to report about.
    expect(response.status).toBe(400);
  });
});

/* ------------------------------------------------------------------------- scoping */

describe('scoping a run', () => {
  it('refuses an actor that is not a person', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/analysis`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'system' }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('scopes to one imported statement when asked', async () => {
    await importedPayment({ amount: paise(124000n), description: 'UPI-SAMPLE MERCHANT' });
    const response = await unconfiguredApi.handle(
      new Request(`${BASE}/api/analysis`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'user',
          importBatchId: asId<'import_batch'>(cast.importBatchId),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AnalysisBody;
    expect(body.stages[0]?.recordsTouched).toBe(1);
  });
});
