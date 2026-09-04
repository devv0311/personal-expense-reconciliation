import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { addExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const BASE = 'http://localhost';
const OCCURRED_AT = new Date('2026-07-01T19:20:00.000Z');

let database: TestDatabase;
let store: MemoryEvidenceStore;
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
  store = createMemoryEvidenceStore();
  cast = await seedCast(database.db);
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: store,
  });
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function get(path: string): Request {
  return new Request(`${BASE}${path}`);
}

describe('GET /api/expenses', () => {
  it('lists approved expenses newest first', async () => {
    await addExpense(database.db, {
      description: 'Groceries',
      amount: paise(50_000n),
      occurredAt: new Date('2026-06-01T00:00:00.000Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    await addExpense(database.db, {
      description: 'Taxi',
      amount: paise(90_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });

    const response = await api.handle(get('/api/expenses'));
    const body = await json(response);

    expect(response.status).toBe(200);
    const rows = body['expenses'] as Array<{ description: string; netAmount: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.description).toBe('Taxi');
    expect(rows[0]?.netAmount).toBe('90000');
  });

  it('filters by state', async () => {
    await addExpense(database.db, {
      description: 'Still proposed',
      amount: paise(10_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'proposed',
    });
    await addExpense(database.db, {
      description: 'Approved one',
      amount: paise(20_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });

    const response = await api.handle(get('/api/expenses?state=proposed'));
    const body = await json(response);
    const rows = body['expenses'] as Array<{ description: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Still proposed');
  });

  it('filters by paidBy', async () => {
    const friendId = cast.person['person_friend_a']!;
    await addExpense(database.db, {
      description: 'Paid by Dev',
      amount: paise(10_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    await addExpense(database.db, {
      description: 'Paid by Friend A',
      amount: paise(20_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'shared',
      paidByPersonId: friendId,
      state: 'approved',
    });

    const response = await api.handle(get(`/api/expenses?paidBy=${friendId}`));
    const body = await json(response);
    const rows = body['expenses'] as Array<{ description: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Paid by Friend A');
  });

  it('respects an explicit limit', async () => {
    for (let i = 0; i < 3; i += 1) {
      await addExpense(database.db, {
        description: `Expense ${i}`,
        amount: paise(1_000n),
        occurredAt: OCCURRED_AT,
        relationshipType: 'personal',
        paidByPersonId: cast.userPersonId,
        state: 'approved',
      });
    }

    const response = await api.handle(get('/api/expenses?limit=1'));
    const body = await json(response);
    expect((body['expenses'] as unknown[]).length).toBe(1);
  });

  it('400s an invalid state', async () => {
    const response = await api.handle(get('/api/expenses?state=not_a_state'));
    expect(response.status).toBe(400);
  });

  it('400s a malformed paidBy id', async () => {
    const response = await api.handle(get('/api/expenses?paidBy=not-a-uuid'));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/balances/:personAId/:personBId', () => {
  it('computes the pairwise balance from an approved allocation', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Taxi to the airport',
      amount: paise(90_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    await api.handle(
      new Request(`${BASE}/api/expenses/${expenseId}/allocation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'user',
          method: 'equal',
          beneficiaries: [
            { type: 'person', id: cast.userPersonId },
            { type: 'person', id: cast.person['person_friend_a'] },
          ],
        }),
      }),
    );

    const response = await api.handle(
      get(`/api/balances/${cast.userPersonId}/${cast.person['person_friend_a']}`),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['netBalance']).toBe('-45000');

    const reversed = await api.handle(
      get(`/api/balances/${cast.person['person_friend_a']}/${cast.userPersonId}`),
    );
    const reversedBody = await json(reversed);
    expect(reversedBody['netBalance']).toBe('45000');
  });

  it('400s a malformed person id', async () => {
    const response = await api.handle(
      get(`/api/balances/not-a-uuid/${cast.person['person_friend_a']}`),
    );
    expect(response.status).toBe(400);
  });
});

describe('route table', () => {
  it('exposes the phase-13 routes', () => {
    const paths = api.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('GET /api/expenses');
    expect(paths).toContain('GET /api/balances/:personAId/:personBId');
  });
});
