/**
 * Browsing what was recorded (audit rows 10, 26, 32, 33).
 *
 * The evidence library, the whole-ledger expense search with a real total, one expense's
 * allocation-version history, and the audit trail over a record. Each existed in the database
 * and had no way to be looked at.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import type { Paise } from '../../src/domain/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
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

async function note(text: string, capturedAt: string): Promise<string> {
  const response = await post('/api/evidence/notes', {
    actor: 'user',
    noteKind: 'documentation',
    text,
    capturedAt,
  });
  const { evidenceId } = (await response.json()) as { evidenceId: string };
  return evidenceId;
}

async function seedDebit(amount: bigint, description: string, at: string): Promise<string> {
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
  occurredAt: string;
  category?: string;
}): Promise<string> {
  const paymentId = await seedDebit(
    BigInt(options.amount),
    options.description,
    options.occurredAt,
  );
  const created = await post('/api/expenses', {
    actor: 'user',
    description: options.description,
    amount: options.amount,
    occurredAt: options.occurredAt,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    funding: [{ paymentId, amount: options.amount }],
    state: 'approved',
    ...(options.category === undefined ? {} : { category: options.category }),
  });
  return ((await created.json()) as { expenseId: string }).expenseId;
}

describe('the evidence library (audit row 10)', () => {
  it('lists every stored document and note, newest capture first', async () => {
    await note('Older note', '2026-06-01T10:00:00.000Z');
    await note('Newer note', '2026-07-01T10:00:00.000Z');

    const body = await getJson<{
      evidence: Array<{ rawText: string | null }>;
      total: number;
    }>('/api/evidence');
    expect(body.total).toBe(2);
    expect(body.evidence[0]?.rawText).toBe('Newer note');
  });

  it('narrows to documents nothing has been attached to yet', async () => {
    const paymentId = await seedDebit(100000n, 'ANYTHING', '2026-07-01T10:00:00.000Z');
    const attached = await post('/api/evidence/notes', {
      actor: 'user',
      noteKind: 'documentation',
      text: 'Attached to a payment',
      capturedAt: '2026-07-01T10:00:00.000Z',
      linkedPaymentId: paymentId,
    });
    expect(attached.status).toBe(201);
    await note('Attached to nothing', '2026-07-02T10:00:00.000Z');

    const unlinked = await getJson<{ evidence: Array<{ rawText: string | null }>; total: number }>(
      '/api/evidence?linkage=unlinked',
    );
    expect(unlinked.total).toBe(1);
    expect(unlinked.evidence[0]?.rawText).toBe('Attached to nothing');

    const linked = await getJson<{ total: number }>('/api/evidence?linkage=linked');
    expect(linked.total).toBe(1);
  });

  it('searches the raw text server-side', async () => {
    await note('Flatmate A paid the electrician', '2026-07-01T10:00:00.000Z');
    await note('Receipt for groceries', '2026-07-02T10:00:00.000Z');

    const body = await getJson<{ total: number }>('/api/evidence?search=electrician');
    expect(body.total).toBe(1);
  });

  it('pages, with the full-store total beside the page', async () => {
    for (let index = 0; index < 5; index += 1) {
      await note(`Note ${index}`, `2026-07-0${index + 1}T10:00:00.000Z`);
    }
    const body = await getJson<{ evidence: unknown[]; total: number; offset: number }>(
      '/api/evidence?limit=2&offset=2',
    );
    expect(body.evidence).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.offset).toBe(2);
  });
});

describe('the expense ledger, searched across the whole ledger (audit row 32)', () => {
  beforeEach(async () => {
    await seedExpense({
      description: 'Blinkit groceries',
      amount: '124000',
      occurredAt: '2026-07-01T10:00:00.000Z',
      category: 'groceries',
    });
    await seedExpense({
      description: 'Zomato dinner',
      amount: '284000',
      occurredAt: '2026-07-05T10:00:00.000Z',
      category: 'food',
    });
    await seedExpense({
      description: 'Electricity bill',
      amount: '210000',
      occurredAt: '2026-06-10T10:00:00.000Z',
      category: 'utilities',
    });
  });

  it('reports the full-ledger total, not the size of the page', async () => {
    const body = await getJson<{ expenses: unknown[]; total: number }>('/api/expenses?limit=1');
    expect(body.expenses).toHaveLength(1);
    expect(body.total).toBe(3);
  });

  it('finds an expense outside the loaded page by searching the server', async () => {
    const body = await getJson<{ expenses: Array<{ description: string }>; total: number }>(
      '/api/expenses?search=electricity',
    );
    expect(body.total).toBe(1);
    expect(body.expenses[0]?.description).toBe('Electricity bill');
  });

  it('filters by category and by period', async () => {
    const byCategory = await getJson<{ total: number }>('/api/expenses?category=food');
    expect(byCategory.total).toBe(1);

    const byPeriod = await getJson<{ total: number }>(
      '/api/expenses?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z',
    );
    expect(byPeriod.total).toBe(2);
  });

  it('lists the expenses nobody has allocated yet — the "who benefited?" backlog', async () => {
    const backlog = await getJson<{ total: number }>('/api/expenses?withoutAllocation=true');
    expect(backlog.total).toBe(3);

    const [first] = (await getJson<{ expenses: Array<{ id: string }> }>('/api/expenses?limit=1'))
      .expenses;
    await post(`/api/expenses/${first!.id}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: [{ type: 'person', id: cast.userPersonId }],
    });

    const after = await getJson<{ total: number }>('/api/expenses?withoutAllocation=true');
    expect(after.total).toBe(2);
  });

  it('finds the expenses one person is a beneficiary of', async () => {
    const [first] = (await getJson<{ expenses: Array<{ id: string }> }>('/api/expenses?limit=1'))
      .expenses;
    await post(`/api/expenses/${first!.id}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_friend_a']! },
      ],
    });

    const theirs = await getJson<{ total: number }>(
      `/api/expenses?beneficiary=${cast.person['person_friend_a']!}`,
    );
    expect(theirs.total).toBe(1);

    const nobodys = await getJson<{ total: number }>(
      `/api/expenses?beneficiary=${cast.person['person_friend_b']!}`,
    );
    expect(nobodys.total).toBe(0);
  });
});

describe("one expense's whole story (audit rows 26 and 33)", () => {
  it('keeps every allocation version, including the one a refund superseded', async () => {
    const expenseId = await seedExpense({
      description: 'Shared basket',
      amount: '100000',
      occurredAt: '2026-07-01T10:00:00.000Z',
    });

    await post(`/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_friend_a']! },
      ],
    });
    await post(`/api/expenses/${expenseId}/adjustments`, {
      actor: 'user',
      kind: 'merchant_refund',
      amount: '20000',
      occurredAt: '2026-07-03T10:00:00.000Z',
    });
    await post(`/api/expenses/${expenseId}/adjustments/distribute`, {
      actor: 'user',
      reason: 'Refund confirmed on the statement',
    });

    const history = await getJson<{
      allocationVersions: Array<{
        supersededAt: string | null;
        lines: Array<{ amount: string }>;
      }>;
      events: Array<{ entityType: string; action: string }>;
    }>(`/api/expenses/${expenseId}/history`);

    expect(history.allocationVersions).toHaveLength(2);
    // The original split is preserved exactly as approved: ₹500 each.
    expect(history.allocationVersions[0]?.supersededAt).not.toBeNull();
    expect(history.allocationVersions[0]?.lines.map((line) => line.amount).sort()).toEqual([
      '50000',
      '50000',
    ]);
    // The current one is the ₹800 net, split the same way.
    expect(history.allocationVersions[1]?.supersededAt).toBeNull();
    expect(history.allocationVersions[1]?.lines.map((line) => line.amount).sort()).toEqual([
      '40000',
      '40000',
    ]);

    expect(history.events.some((event) => event.action === 'supersede')).toBe(true);
    expect(history.events.some((event) => event.entityType === 'expense_adjustment')).toBe(true);
  });

  it('404s for an expense that does not exist', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/expenses/00000000-0000-4000-8000-000000000000/history`),
    );
    expect(response.status).toBe(404);
  });
});

describe('the audit trail (audit row 33)', () => {
  it('returns every event recorded against one payment, oldest first', async () => {
    const paymentId = await seedDebit(100000n, 'SOMETHING', '2026-07-01T10:00:00.000Z');
    await post(`/api/payments/${paymentId}/counterparty`, {
      actor: 'user',
      counterpartyType: 'investment_instrument',
      reason: 'Monthly SIP',
    });

    const history = await getJson<{
      events: Array<{ action: string; actor: string; reason: string | null }>;
    }>(`/api/payments/${paymentId}/history`);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({ action: 'update', actor: 'user' });
    expect(history.events[0]?.reason).toBe('Monthly SIP');
  });

  it('serves the trail over any auditable record through the general route', async () => {
    const created = await post('/api/people', { actor: 'user', displayName: 'Audited Person' });
    const { person } = (await created.json()) as { person: { id: string } };

    const history = await getJson<{ events: unknown[] }>(`/api/audit/person/${person.id}`);
    expect(history.events).toHaveLength(1);
  });

  it('refuses an entity type that is not auditable, rather than answering "nothing happened"', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/audit/not_a_thing/00000000-0000-4000-8000-000000000000`),
    );
    expect(response.status).toBe(400);
  });

  it('answers with an empty trail for a record nothing has happened to', async () => {
    const history = await getJson<{ events: unknown[] }>(
      '/api/audit/expense/00000000-0000-4000-8000-000000000000',
    );
    expect(history.events).toEqual([]);
  });
});
