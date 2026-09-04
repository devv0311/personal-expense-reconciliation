import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import type { ExpenseId, PersonId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';
const OCCURRED_AT = new Date('2026-07-10T19:20:00.000Z');

let database: TestDatabase;
let store: MemoryEvidenceStore;
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
  store = createMemoryEvidenceStore();
  cast = await seedCast(database.db);
  splitwise = createMockSplitwisePort();
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: store,
    splitwise,
  });
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function linkSplitwiseUser(personId: PersonId, splitwiseUserId: string): Promise<void> {
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId })
    .where(eq(schema.people.id, personId));
}

async function allocatedExpense(): Promise<ExpenseId> {
  const expenseId = await addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(90_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
  await api.handle(
    post(`/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: cast.person['person_friend_a'] },
      ],
    }),
  );
  return expenseId;
}

describe('POST /api/integrations/splitwise/connect', () => {
  it('connects an integration', async () => {
    const response = await api.handle(
      post('/api/integrations/splitwise/connect', { externalAccountRef: 'sandbox-account-1' }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['status']).toBe('connected');
  });
});

describe('POST /api/expenses/:expenseId/ready-to-sync', () => {
  it('moves an allocated expense to ready_to_sync', async () => {
    const expenseId = await allocatedExpense();

    const response = await api.handle(
      post(`/api/expenses/${expenseId}/ready-to-sync`, { actor: 'user' }),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({ from: 'allocated', to: 'ready_to_sync' });
  });

  it('409s an expense with no obligation-creating allocation', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Personal coffee',
      amount: paise(5_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    await api.handle(
      post(`/api/expenses/${expenseId}/allocation`, {
        actor: 'user',
        method: 'equal',
        beneficiaries: [{ type: 'person', id: cast.userPersonId }],
      }),
    );

    const response = await api.handle(
      post(`/api/expenses/${expenseId}/ready-to-sync`, { actor: 'user' }),
    );
    expect(response.status).toBe(409);
  });
});

describe('POST /api/expenses/:expenseId/splitwise-sync', () => {
  beforeEach(async () => {
    await api.handle(
      post('/api/integrations/splitwise/connect', { externalAccountRef: 'sandbox-account-1' }),
    );
    await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
    await linkSplitwiseUser(cast.person['person_friend_a']!, 'sw-friend-a');
  });

  it('syncs a ready_to_sync expense', async () => {
    const expenseId = await allocatedExpense();
    await api.handle(post(`/api/expenses/${expenseId}/ready-to-sync`, { actor: 'user' }));

    const response = await api.handle(
      post(`/api/expenses/${expenseId}/splitwise-sync`, { actor: 'user' }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['syncStatus']).toBe('synced');
    expect(splitwise.createdExpenses).toHaveLength(1);
  });

  it('409s an expense that is not ready_to_sync', async () => {
    const expenseId = await allocatedExpense();

    const response = await api.handle(
      post(`/api/expenses/${expenseId}/splitwise-sync`, { actor: 'user' }),
    );
    expect(response.status).toBe(409);
  });

  it('502s when the port fails', async () => {
    const expenseId = await allocatedExpense();
    await api.handle(post(`/api/expenses/${expenseId}/ready-to-sync`, { actor: 'user' }));
    splitwise.failNextCreateExpense('sandbox unavailable');

    const response = await api.handle(
      post(`/api/expenses/${expenseId}/splitwise-sync`, { actor: 'user' }),
    );
    expect(response.status).toBe(502);
  });

  it('400s a malformed expense id', async () => {
    const response = await api.handle(
      post('/api/expenses/not-a-uuid/splitwise-sync', { actor: 'user' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/settlements/:settlementId/splitwise-sync', () => {
  beforeEach(async () => {
    await api.handle(
      post('/api/integrations/splitwise/connect', { externalAccountRef: 'sandbox-account-1' }),
    );
    await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
    await linkSplitwiseUser(cast.person['person_friend_a']!, 'sw-friend-a');
  });

  it('syncs a recorded settlement', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(50_000n),
      direction: 'debit',
      occurredAt: OCCURRED_AT,
      rawDescription: 'UPI-FRIENDA-TRANSFER',
      channel: 'upi',
      state: 'normalized',
    });
    const settlementResponse = await api.handle(
      post(`/api/payments/${paymentId}/settlements`, {
        actor: 'user',
        counterpartyPersonId: cast.person['person_friend_a'],
        amount: '50000',
      }),
    );
    const { settlementId } = (await json(settlementResponse)) as { settlementId: string };

    const response = await api.handle(
      post(`/api/settlements/${settlementId}/splitwise-sync`, { actor: 'user' }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['syncStatus']).toBe('synced');
  });

  it('400s a malformed settlement id', async () => {
    const response = await api.handle(
      post('/api/settlements/not-a-uuid/splitwise-sync', { actor: 'user' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('route table', () => {
  it('exposes the phase-14 routes', () => {
    const paths = api.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('POST /api/integrations/splitwise/connect');
    expect(paths).toContain('POST /api/expenses/:expenseId/ready-to-sync');
    expect(paths).toContain('POST /api/expenses/:expenseId/splitwise-sync');
    expect(paths).toContain('POST /api/settlements/:settlementId/splitwise-sync');
  });
});
