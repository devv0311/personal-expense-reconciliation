/**
 * Rules, analytics, occasions, jobs and Splitwise re-sync (audit rows 40, 43, 44, 47, 51).
 *
 * Each of these was schema-only or entirely absent. The tests that matter here are the ones
 * about restraint: that a rule cannot decide who benefited, that an analytics total says what
 * it excluded, that grouping expenses moves no money, that a failed job stays visible, and
 * that a re-sync refuses a row the two ledgers already agree about.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import type { Paise } from '../../src/domain/index.js';
import { runNextJob } from '../../src/services/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { schema } from '../../src/db/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';

let database: TestDatabase;
let api: Api;
let cast: Cast;
let splitwise: ReturnType<typeof createMockSplitwisePort>;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  splitwise = createMockSplitwisePort();
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise,
  });
});

async function post(path: string, body: unknown): Promise<Response> {
  return api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await api.handle(new Request(`${BASE}${path}`));
  return (await response.json()) as T;
}

async function seedDebit(
  amount: bigint,
  description: string,
  at = '2026-07-10T10:00:00.000Z',
): Promise<string> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: amount as Paise,
    direction: 'debit',
    occurredAt: new Date(at),
    rawDescription: description,
    channel: 'upi',
    state: 'normalized',
  });
}

async function seedExpense(options: {
  description: string;
  amount: string;
  occurredAt?: string;
  category?: string;
  beneficiaries?: string[];
}): Promise<string> {
  const at = options.occurredAt ?? '2026-07-10T10:00:00.000Z';
  const paymentId = await seedDebit(BigInt(options.amount), options.description, at);
  const created = await post('/api/expenses', {
    actor: 'user',
    description: options.description,
    amount: options.amount,
    occurredAt: at,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    funding: [{ paymentId, amount: options.amount }],
    state: 'approved',
    ...(options.category === undefined ? {} : { category: options.category }),
  });
  const { expenseId } = (await created.json()) as { expenseId: string };

  if (options.beneficiaries !== undefined) {
    await post(`/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: options.beneficiaries.map((id) => ({ type: 'person', id })),
    });
  }
  return expenseId;
}

describe('standing rules (audit row 43)', () => {
  it('writes a rule and lists it', async () => {
    const response = await post('/api/rules', {
      actor: 'user',
      name: 'Zerodha is an investment',
      match: { description: 'ZERODHA', descriptionOperator: 'contains', direction: 'debit' },
      assertion: { action: 'set_counterparty_type', counterpartyType: 'investment_instrument' },
      effect: 'apply',
    });
    expect(response.status).toBe(201);

    const body = await getJson<{ rules: Array<{ name: string; effect: string }> }>('/api/rules');
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]).toMatchObject({ name: 'Zerodha is an investment', effect: 'apply' });
  });

  it('refuses a rule with no condition, which would match every payment ever imported', async () => {
    const response = await post('/api/rules', {
      actor: 'user',
      name: 'Everything',
      match: {},
      assertion: { action: 'set_counterparty_type', counterpartyType: 'merchant' },
    });
    expect(response.status).toBe(422);
  });

  it('refuses an assertion its own pattern makes impossible', async () => {
    const response = await post('/api/rules', {
      actor: 'user',
      name: 'Debit refunds',
      match: { direction: 'debit', description: 'REFUND' },
      assertion: { action: 'set_cash_flow_category', cashFlowCategory: 'REFUND' },
    });
    expect(response.status).toBe(422);
  });

  it('previews without writing when asked to', async () => {
    await seedDebit(500000n, 'ZERODHA BROKING SIP');
    await post('/api/rules', {
      actor: 'user',
      name: 'Zerodha',
      match: { description: 'ZERODHA' },
      assertion: { action: 'set_counterparty_type', counterpartyType: 'investment_instrument' },
      effect: 'apply',
    });

    const preview = await post('/api/rules/apply', { actor: 'user', dryRun: true });
    const body = (await preview.json()) as { outcomes: Array<{ outcome: string }> };
    expect(body.outcomes).toHaveLength(1);
    expect(body.outcomes[0]?.outcome).toBe('proposed');

    const payments = await getJson<{ payments: Array<{ counterpartyType: string }> }>(
      '/api/payments?search=ZERODHA',
    );
    expect(payments.payments[0]?.counterpartyType).toBe('unknown');
  });

  it('applies an "apply" rule, attributed to the rule rather than to a person', async () => {
    const paymentId = await seedDebit(500000n, 'ZERODHA BROKING SIP');
    const created = await post('/api/rules', {
      actor: 'user',
      name: 'Zerodha',
      match: { description: 'ZERODHA' },
      assertion: { action: 'set_counterparty_type', counterpartyType: 'investment_instrument' },
      effect: 'apply',
    });
    const { ruleId } = (await created.json()) as { ruleId: string };

    const applied = await post('/api/rules/apply', { actor: 'user' });
    const body = (await applied.json()) as { outcomes: Array<{ outcome: string }> };
    expect(body.outcomes[0]?.outcome).toBe('applied');

    const payment = await getJson<Record<string, unknown>>(`/api/payments/${paymentId}`);
    expect(payment['counterpartyType']).toBe('investment_instrument');

    const history = await getJson<{ events: Array<{ actor: string }> }>(
      `/api/payments/${paymentId}/history`,
    );
    // `rule:<id>`, never `user` — a rule-written fact stays distinguishable from a click.
    expect(history.events[0]?.actor).toBe(`rule:${ruleId}`);
  });

  it('leaves a payment alone when two rules disagree about it', async () => {
    await seedDebit(500000n, 'ZERODHA BROKING SIP');
    await post('/api/rules', {
      actor: 'user',
      name: 'First',
      match: { description: 'ZERODHA' },
      assertion: { action: 'set_counterparty_type', counterpartyType: 'investment_instrument' },
      effect: 'apply',
    });
    await post('/api/rules', {
      actor: 'user',
      name: 'Second',
      match: { description: 'BROKING' },
      assertion: { action: 'set_counterparty_type', counterpartyType: 'merchant' },
      effect: 'apply',
    });

    const applied = await post('/api/rules/apply', { actor: 'user' });
    const body = (await applied.json()) as {
      outcomes: unknown[];
      conflicts: Array<{ ruleIds: string[] }>;
    };
    expect(body.outcomes).toHaveLength(0);
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]?.ruleIds).toHaveLength(2);
  });

  it('stops applying a rule once it is deactivated', async () => {
    await seedDebit(500000n, 'ZERODHA BROKING SIP');
    const created = await post('/api/rules', {
      actor: 'user',
      name: 'Zerodha',
      match: { description: 'ZERODHA' },
      assertion: { action: 'set_counterparty_type', counterpartyType: 'investment_instrument' },
      effect: 'apply',
    });
    const { ruleId } = (await created.json()) as { ruleId: string };
    await post(`/api/rules/${ruleId}`, { actor: 'user', active: false });

    const applied = await post('/api/rules/apply', { actor: 'user' });
    const body = (await applied.json()) as { outcomes: unknown[] };
    expect(body.outcomes).toHaveLength(0);
  });
});

describe('analytics (audit rows 30 and 44)', () => {
  beforeEach(async () => {
    await seedExpense({
      description: 'Blinkit groceries',
      amount: '120000',
      category: 'groceries',
      occurredAt: '2026-07-02T10:00:00.000Z',
      beneficiaries: [cast.userPersonId, cast.person['person_friend_a']!],
    });
    await seedExpense({
      description: 'Zomato dinner',
      amount: '280000',
      category: 'food',
      occurredAt: '2026-07-20T10:00:00.000Z',
      beneficiaries: [cast.userPersonId],
    });
    await seedExpense({
      description: 'June electricity',
      amount: '200000',
      category: 'utilities',
      occurredAt: '2026-06-10T10:00:00.000Z',
      beneficiaries: [cast.userPersonId],
    });
  });

  it('totals spending by category for a period, and says what it excludes', async () => {
    const body = await getJson<{
      categories: Array<{ category: string | null; netTotal: string }>;
      netTotal: string;
      caveats: { excludes: string[] };
    }>('/api/analytics/spending?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z');

    expect(body.netTotal).toBe('400000');
    expect(body.categories.map((entry) => entry.category).sort()).toEqual(['food', 'groceries']);
    expect(body.caveats.excludes.join(' ')).toContain('transfers');
  });

  it('reports the trend month by month', async () => {
    const body = await getJson<{ months: Array<{ month: string; netTotal: string }> }>(
      '/api/analytics/monthly?from=2026-06-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z',
    );
    expect(body.months.map((entry) => entry.month)).toEqual(['2026-06', '2026-07']);
    expect(body.months.find((entry) => entry.month === '2026-06')?.netTotal).toBe('200000');
  });

  it("separates what passed through the account from the user's own share", async () => {
    const body = await getJson<{
      paidByUser: string;
      ownShare: string;
      frontedForOthers: string;
    }>('/api/analytics/own-spend?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z');

    // ₹4,000 left the account; ₹600 of the groceries was the friend's share.
    expect(body.paidByUser).toBe('400000');
    expect(body.frontedForOthers).toBe('60000');
    expect(body.ownShare).toBe('340000');
  });

  it('refuses a period that runs backwards rather than returning nothing', async () => {
    const response = await api.handle(
      new Request(
        `${BASE}/api/analytics/spending?from=2026-08-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z`,
      ),
    );
    expect(response.status).toBe(400);
  });

  it('lists every open balance at once, and omits the settled ones', async () => {
    const body = await getJson<{
      counterparties: Array<{ personId: string; netBalance: string }>;
      totalOwedToUser: string;
    }>('/api/analytics/outstanding');

    expect(body.counterparties).toHaveLength(1);
    expect(body.counterparties[0]).toMatchObject({
      personId: cast.person['person_friend_a'],
      netBalance: '60000',
    });
    expect(body.totalOwedToUser).toBe('60000');
  });

  it('lists what the user paid for that others still owe on', async () => {
    const body = await getJson<{
      expenses: Array<{ description: string; owedToUser: string }>;
      totalOwedToUser: string;
    }>('/api/analytics/unsettled');

    expect(body.expenses).toHaveLength(1);
    expect(body.expenses[0]).toMatchObject({
      description: 'Blinkit groceries',
      owedToUser: '60000',
    });
  });

  it('flags an expense whose refund no allocation reflects yet', async () => {
    const expenseId = await seedExpense({
      description: 'Refunded thing',
      amount: '100000',
      occurredAt: '2026-07-25T10:00:00.000Z',
      beneficiaries: [cast.userPersonId],
    });
    await post(`/api/expenses/${expenseId}/adjustments`, {
      actor: 'user',
      kind: 'merchant_refund',
      amount: '30000',
      occurredAt: '2026-07-26T10:00:00.000Z',
    });

    const body = await getJson<{ caveats: { pendingRefundExpenseIds: string[] } }>(
      '/api/analytics/spending?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z',
    );
    expect(body.caveats.pendingRefundExpenseIds).toContain(expenseId);
  });
});

describe('expense occasions (audit row 47)', () => {
  it('groups expenses under an occasion without moving any money', async () => {
    const dinner = await seedExpense({
      description: 'Dinner',
      amount: '280000',
      beneficiaries: [cast.userPersonId],
    });
    const cab = await seedExpense({
      description: 'Cab home',
      amount: '40000',
      beneficiaries: [cast.userPersonId],
    });

    const created = await post('/api/occasions', {
      actor: 'user',
      name: 'Saturday out',
      occurredStart: '2026-07-10T00:00:00.000Z',
      occurredEnd: '2026-07-11T00:00:00.000Z',
    });
    expect(created.status).toBe(201);
    const { occasionId } = (await created.json()) as { occasionId: string };

    const before = await getJson<Record<string, unknown>>(`/api/expenses/${dinner}`);
    for (const expenseId of [dinner, cab]) {
      const attached = await post(`/api/expenses/${expenseId}/occasion`, {
        actor: 'user',
        occasionId,
      });
      expect(attached.status).toBe(200);
    }

    const occasions = await getJson<{ occasions: Array<{ id: string; expenseCount: number }> }>(
      '/api/occasions',
    );
    expect(occasions.occasions.find((entry) => entry.id === occasionId)?.expenseCount).toBe(2);

    // Grouping is a label: not one figure on the expense moved.
    const after = await getJson<Record<string, unknown>>(`/api/expenses/${dinner}`);
    expect(after['netAmount']).toBe(before['netAmount']);
    expect(after['grossAmount']).toBe(before['grossAmount']);
  });

  it('detaches an expense from its occasion', async () => {
    const expenseId = await seedExpense({ description: 'Dinner', amount: '100000' });
    const created = await post('/api/occasions', {
      actor: 'user',
      name: 'An evening',
      occurredStart: '2026-07-10T00:00:00.000Z',
    });
    const { occasionId } = (await created.json()) as { occasionId: string };
    await post(`/api/expenses/${expenseId}/occasion`, { actor: 'user', occasionId });

    const detached = await post(`/api/expenses/${expenseId}/occasion`, {
      actor: 'user',
      occasionId: null,
    });
    expect(detached.status).toBe(200);

    const occasions = await getJson<{ occasions: Array<{ id: string; expenseCount: number }> }>(
      '/api/occasions',
    );
    expect(occasions.occasions.find((entry) => entry.id === occasionId)?.expenseCount).toBe(0);
  });

  it('refuses an occasion that ends before it starts', async () => {
    const response = await post('/api/occasions', {
      actor: 'user',
      name: 'Backwards',
      occurredStart: '2026-07-10T00:00:00.000Z',
      occurredEnd: '2026-07-01T00:00:00.000Z',
    });
    expect(response.status).toBe(409);
  });
});

describe('the job queue (audit row 51)', () => {
  it('queues a job and lists it', async () => {
    const response = await post('/api/jobs', {
      actor: 'user',
      kind: 'normalize_payments',
      payload: { importBatchId: cast.importBatchId },
    });
    expect(response.status).toBe(201);

    const body = await getJson<{ jobs: Array<{ kind: string; status: string }>; total: number }>(
      '/api/jobs',
    );
    expect(body.total).toBe(1);
    expect(body.jobs[0]).toMatchObject({ kind: 'normalize_payments', status: 'queued' });
  });

  it('runs one job and records what it produced', async () => {
    await post('/api/jobs', { actor: 'user', kind: 'normalize_payments' });
    const result = await runNextJob(database.db, {
      normalize_payments: () => Promise.resolve({ normalized: 3 }),
    });
    expect(result).toMatchObject({ ran: true, outcome: 'succeeded' });

    const body = await getJson<{ jobs: Array<{ status: string; result: unknown }> }>('/api/jobs');
    expect(body.jobs[0]).toMatchObject({ status: 'succeeded', result: { normalized: 3 } });
  });

  it('keeps a failed job visible, with its error, and lets it be retried', async () => {
    const created = await post('/api/jobs', { actor: 'user', kind: 'classify_payments' });
    const { jobId } = (await created.json()) as { jobId: string };

    await runNextJob(database.db, {
      classify_payments: () => Promise.reject(new Error('No AI provider is configured.')),
    });

    const failed = await getJson<{ status: string; lastError: string; attempts: number }>(
      `/api/jobs/${jobId}`,
    );
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('No AI provider');
    expect(failed.attempts).toBe(1);

    const retried = await post(`/api/jobs/${jobId}/retry`, { actor: 'user' });
    expect(retried.status).toBe(200);
    const requeued = (await retried.json()) as { status: string; attempts: number };
    expect(requeued.status).toBe('queued');
    // The attempt count survives a retry: a job failing repeatedly is exactly what to see.
    expect(requeued.attempts).toBe(1);
  });

  it('fails a job whose kind nothing handles, rather than losing it', async () => {
    await post('/api/jobs', { actor: 'user', kind: 'extract_receipt' });
    const result = await runNextJob(database.db, {});
    expect(result).toMatchObject({ ran: true, outcome: 'failed' });
    expect(result.error).toContain('extract_receipt');
  });

  it('schedules a new job on the clock the worker reads, not the database server’s', async () => {
    // `claimNextJob` asks whether `scheduled_for <= now`, and `now` is a `Date` the caller made.
    // While `scheduled_for` came from the column's `now()` default, the two sides of that
    // comparison came from two different clocks — and a database server a few milliseconds
    // ahead of the application made a job queued "now" invisible to the very next `runNextJob`.
    // Invisible, not lost: the failure was a queue that silently did nothing.
    //
    // This holds structurally rather than by tolerance — both ends are one process's clock —
    // so the window below is the assertion this test can make, and the existing
    // enqueue-then-run tests above are what actually exercise it.
    const before = Date.now();
    const created = await post('/api/jobs', { actor: 'user', kind: 'normalize_payments' });
    const after = Date.now();
    const { jobId } = (await created.json()) as { jobId: string };

    const [row] = await database.db
      .select({ scheduledFor: schema.jobs.scheduledFor })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId));
    const scheduledFor = row!.scheduledFor.getTime();
    expect(scheduledFor).toBeGreaterThanOrEqual(before);
    expect(scheduledFor).toBeLessThanOrEqual(after);
  });

  it('reports that there was nothing to run', async () => {
    expect(await runNextJob(database.db, {})).toEqual({ ran: false });
  });

  it('refuses to cancel a job that already finished', async () => {
    const created = await post('/api/jobs', { actor: 'user', kind: 'normalize_payments' });
    const { jobId } = (await created.json()) as { jobId: string };
    await runNextJob(database.db, { normalize_payments: () => Promise.resolve(undefined) });

    const response = await post(`/api/jobs/${jobId}/cancel`, {
      actor: 'user',
      reason: 'Changed my mind',
    });
    expect(response.status).toBe(409);
  });

  it('cancels a queued job', async () => {
    const created = await post('/api/jobs', { actor: 'user', kind: 'normalize_payments' });
    const { jobId } = (await created.json()) as { jobId: string };

    const response = await post(`/api/jobs/${jobId}/cancel`, {
      actor: 'user',
      reason: 'Queued by mistake',
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      status: 'cancelled',
      lastError: 'Queued by mistake',
    });

    expect(await runNextJob(database.db, {})).toEqual({ ran: false });
  });
});

describe('Splitwise stale re-sync (audit row 40)', () => {
  it('lists nothing to repair when nothing has drifted', async () => {
    const body = await getJson<{ candidates: unknown[]; settlements: unknown[] }>(
      '/api/splitwise/resync-candidates',
    );
    expect(body.candidates).toEqual([]);
    expect(body.settlements).toEqual([]);
  });

  it('says what the connected adapter can actually repair (ADR-0055)', async () => {
    // Travels with the list so a screen can say "this cannot be done here" rather than offer a
    // button that fails. The mock port implements all three; a first-sync-only adapter would
    // report every one of them false.
    const body = await getJson<{ capability: Record<string, boolean> }>(
      '/api/splitwise/resync-candidates',
    );
    expect(body.capability).toEqual({
      canCorrect: true,
      canWithdraw: true,
      canCorrectSettlement: true,
    });
  });

  it('refuses to re-sync a settlement that was never synced', async () => {
    const response = await post(
      `/api/settlements/${'00000000-0000-4000-8000-000000000000'}/splitwise-resync`,
      { actor: 'user', reason: 'Trying anyway' },
    );
    expect(response.status).toBe(404);
  });

  it('refuses to re-sync an expense that was never synced', async () => {
    const expenseId = await seedExpense({ description: 'Never synced', amount: '100000' });
    const response = await post(`/api/expenses/${expenseId}/splitwise-resync`, {
      actor: 'user',
      reason: 'Trying anyway',
    });
    expect(response.status).toBe(409);
  });

  it('requires a reason, because it changes a figure in somebody else’s ledger', async () => {
    const expenseId = await seedExpense({ description: 'Something', amount: '100000' });
    const response = await post(`/api/expenses/${expenseId}/splitwise-resync`, { actor: 'user' });
    expect(response.status).toBe(400);
  });
});
