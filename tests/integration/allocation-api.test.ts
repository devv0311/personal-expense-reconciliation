import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import type { ExpenseId, PaymentId } from '../../src/domain/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { addExpense, addPayment, currentGroupExpansion, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const BASE = 'http://localhost';
const OCCURRED_AT = new Date('2026-07-01T19:20:00.000Z');

let database: TestDatabase;
let store: MemoryEvidenceStore;
let api: Api;
let cast: Cast;
let expenseId: ExpenseId;

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
    splitwise: createMockSplitwisePort(),
  });
  expenseId = await addExpense(database.db, {
    description: 'Taxi to the airport',
    amount: paise(90_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
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

describe('POST /api/expenses/:expenseId/items', () => {
  it('records the whole item set', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/items`, {
        actor: 'user',
        items: [
          { description: 'Base fare', amount: '70000' },
          { description: 'Tip', amount: '20000' },
        ],
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['items']).toHaveLength(2);
  });

  it('422s a partial itemization', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/items`, {
        actor: 'user',
        items: [{ description: 'Base fare', amount: '70000' }],
      }),
    );
    expect(response.status).toBe(422);
  });

  it('reads the items back', async () => {
    await api.handle(
      post(`/api/expenses/${expenseId}/items`, {
        actor: 'user',
        items: [
          { description: 'Base fare', amount: '70000' },
          { description: 'Tip', amount: '20000' },
        ],
      }),
    );

    const response = await api.handle(new Request(`${BASE}/api/expenses/${expenseId}/items`));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['items']).toHaveLength(2);
  });
});

describe('POST /api/expenses/:expenseId/allocation', () => {
  it('approves an equal split among people', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/allocation`, {
        actor: 'user',
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_friend_a'] },
        ],
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['netAmount']).toBe('90000');
    expect(Array.isArray(body['lines'])).toBe(true);
    expect(body['lines']).toHaveLength(2);
  });

  it('approves a group line, expanded into individual shares in the database', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/allocation`, {
        actor: 'user',
        method: 'equal',
        beneficiaries: [{ type: 'group', id: cast.group['group_flat'] }],
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    const [line] = body['lines'] as Array<{ beneficiary: { type: string; id: string } }>;
    expect(line?.beneficiary).toMatchObject({ type: 'group', id: cast.group['group_flat'] });

    const expansion = await currentGroupExpansion(database.db, expenseId);
    expect(expansion.length).toBeGreaterThan(0);
  });

  it('applies a groupShareOverride, not the equal-weight default', async () => {
    // Active flat members at OCCURRED_AT: Dev, Flatmate A, Flatmate C (people-and-groups.json).
    // Weighting Flatmate A to zero should leave them with nothing, unlike the equal split.
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/allocation`, {
        actor: 'user',
        method: 'equal',
        beneficiaries: [{ type: 'group', id: cast.group['group_flat'] }],
        groupShareOverrides: [
          {
            groupId: cast.group['group_flat'],
            weights: [
              { personId: cast.userPersonId, weight: '1' },
              { personId: cast.person['person_flatmate_a'], weight: '0' },
              { personId: cast.person['person_flatmate_c'], weight: '1' },
            ],
          },
        ],
      }),
    );
    expect(response.status).toBe(201);

    const expansion = await currentGroupExpansion(database.db, expenseId);
    const flatmateAShare = expansion.find(
      (row) => row.personId === cast.person['person_flatmate_a'],
    );
    expect(flatmateAShare?.amount).toBe(0n);
    expect(expansion.reduce((sum, row) => sum + row.amount, 0n)).toBe(90_000n);
  });

  it('approves an exact split', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/allocation`, {
        actor: 'user',
        method: 'exact',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, amount: '60000' },
          { beneficiary: { type: 'person', id: cast.person['person_friend_a'] }, amount: '30000' },
        ],
      }),
    );
    expect(response.status).toBe(201);
  });

  it('approves an item-based split once items exist', async () => {
    await api.handle(
      post(`/api/expenses/${expenseId}/items`, {
        actor: 'user',
        items: [
          { description: 'Base fare', amount: '70000' },
          { description: 'Tip', amount: '20000' },
        ],
      }),
    );
    const itemsResponse = await json(
      await api.handle(new Request(`${BASE}/api/expenses/${expenseId}/items`)),
    );
    // Items tie on created_at in a fast test and the tiebreak is then a random UUID
    // (db.listExpenseItemsByExpense), so pair each item by its own amount rather than by
    // array position.
    const items = itemsResponse['items'] as Array<{ id: string; amount: string }>;
    const baseFare = items.find((item) => item.amount === '70000')!;
    const tip = items.find((item) => item.amount === '20000')!;

    const response = await api.handle(
      post(`/api/expenses/${expenseId}/allocation`, {
        actor: 'user',
        method: 'item_based',
        lines: [
          {
            beneficiary: { type: 'person', id: cast.userPersonId },
            expenseItemId: baseFare.id,
            amount: baseFare.amount,
          },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a'] },
            expenseItemId: tip.id,
            amount: tip.amount,
          },
        ],
      }),
    );
    expect(response.status).toBe(201);
  });

  it('409s a re-approval of an unapproved expense', async () => {
    const proposedExpenseId = await addExpense(database.db, {
      description: 'Not yet approved',
      amount: paise(50_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      state: 'proposed',
    });

    const response = await api.handle(
      post(`/api/expenses/${proposedExpenseId}/allocation`, {
        actor: 'user',
        method: 'equal',
        beneficiaries: [{ type: 'person', id: cast.userPersonId }],
      }),
    );
    expect(response.status).toBe(409);
  });

  it('refuses an actor that is not a person', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/allocation`, {
        actor: 'system',
        method: 'equal',
        beneficiaries: [{ type: 'person', id: cast.userPersonId }],
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/expenses/:expenseId/adjustments(/distribute)', () => {
  beforeEach(async () => {
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
  });

  it('records an adjustment without touching the current allocation', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/adjustments`, {
        actor: 'user',
        kind: 'merchant_refund',
        amount: '10000',
        occurredAt: OCCURRED_AT.toISOString(),
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['netAmountAfter']).toBe('80000');
    expect(body['pendingDistribution']).toBe(true);
  });

  it('distributes a recorded adjustment into a new allocation version', async () => {
    await api.handle(
      post(`/api/expenses/${expenseId}/adjustments`, {
        actor: 'user',
        kind: 'merchant_refund',
        amount: '10000',
        occurredAt: OCCURRED_AT.toISOString(),
      }),
    );

    const response = await api.handle(
      post(`/api/expenses/${expenseId}/adjustments/distribute`, { actor: 'user' }),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['netAmount']).toBe('80000');
    expect(body['distributedAmount']).toBe('10000');
  });

  it('409s distributing with nothing recorded', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/adjustments/distribute`, { actor: 'user' }),
    );
    expect(response.status).toBe(409);
  });
});

/**
 * The item-refund workflow over HTTP (phase 18, ADR-0018 (item refunds)): itemize, allocate
 * per item, refund one item, read what that implies, then approve it.
 */
describe('item-attributed adjustments over HTTP', () => {
  let baseFare: string;
  let tip: string;

  beforeEach(async () => {
    const items = await json(
      await api.handle(
        post(`/api/expenses/${expenseId}/items`, {
          actor: 'user',
          items: [
            { description: 'Base fare', amount: '70000' },
            { description: 'Airport surcharge (theirs)', amount: '20000' },
          ],
        }),
      ),
    );
    const rows = items['items'] as Array<{ id: string; description: string }>;
    baseFare = rows.find((row) => row.description === 'Base fare')!.id;
    tip = rows.find((row) => row.description.startsWith('Airport'))!.id;

    await api.handle(
      post(`/api/expenses/${expenseId}/allocation`, {
        actor: 'user',
        method: 'item_based',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: baseFare },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a'] },
            expenseItemId: tip,
          },
        ],
      }),
    );
  });

  it('records a refund against the item it came back for', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/adjustments`, {
        actor: 'user',
        kind: 'merchant_refund',
        amount: '5000',
        occurredAt: OCCURRED_AT.toISOString(),
        itemAttributions: [{ expenseItemId: tip, amount: '5000' }],
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['netAmountAfter']).toBe('85000');
    expect(body['itemAttributions']).toEqual([
      { expenseItemId: tip, amount: '5000', netItemAmount: '15000' },
    ]);
  });

  it('distributes it onto that item’s beneficiary alone', async () => {
    await api.handle(
      post(`/api/expenses/${expenseId}/adjustments`, {
        actor: 'user',
        kind: 'merchant_refund',
        amount: '5000',
        occurredAt: OCCURRED_AT.toISOString(),
        itemAttributions: [{ expenseItemId: tip, amount: '5000' }],
      }),
    );

    const body = await json(
      await api.handle(
        post(`/api/expenses/${expenseId}/adjustments/distribute`, { actor: 'user' }),
      ),
    );

    expect(body['basis']).toBe('item_attributed');
    expect(body['unattributedReduction']).toBe('0');
    const lines = body['lines'] as Array<{ amount: string; expenseItemId: string }>;
    expect(lines.find((line) => line.expenseItemId === baseFare)?.amount).toBe('70000');
    expect(lines.find((line) => line.expenseItemId === tip)?.amount).toBe('15000');
  });

  it('422s a weight set for a refund whose attribution already decides the distribution', async () => {
    await api.handle(
      post(`/api/expenses/${expenseId}/adjustments`, {
        actor: 'user',
        kind: 'merchant_refund',
        amount: '5000',
        occurredAt: OCCURRED_AT.toISOString(),
        itemAttributions: [{ expenseItemId: tip, amount: '5000' }],
      }),
    );

    const response = await api.handle(
      post(`/api/expenses/${expenseId}/adjustments/distribute`, {
        actor: 'user',
        customWeights: ['1', '0'],
      }),
    );
    expect(response.status).toBe(422);
  });

  it('422s an attribution set that does not sum to the adjustment', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/adjustments`, {
        actor: 'user',
        kind: 'merchant_refund',
        amount: '5000',
        occurredAt: OCCURRED_AT.toISOString(),
        itemAttributions: [{ expenseItemId: tip, amount: '4000' }],
      }),
    );
    expect(response.status).toBe(422);
  });

  it('400s an empty attribution array rather than reading it as a whole-expense refund', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/adjustments`, {
        actor: 'user',
        kind: 'merchant_refund',
        amount: '5000',
        occurredAt: OCCURRED_AT.toISOString(),
        itemAttributions: [],
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/itemAttributions/);
  });

  it('400s an attribution amount that is not integer minor units', async () => {
    const response = await api.handle(
      post(`/api/expenses/${expenseId}/adjustments`, {
        actor: 'user',
        kind: 'merchant_refund',
        amount: '5000',
        occurredAt: OCCURRED_AT.toISOString(),
        itemAttributions: [{ expenseItemId: tip, amount: 50.5 }],
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/expenses/:expenseId/refund-allocation', () => {
  it('reports gross beside net, per item, with nothing pending', async () => {
    await api.handle(
      post(`/api/expenses/${expenseId}/items`, {
        actor: 'user',
        items: [
          { description: 'Base fare', amount: '70000' },
          { description: 'Tip', amount: '20000' },
        ],
      }),
    );

    const response = await api.handle(
      new Request(`${BASE}/api/expenses/${expenseId}/refund-allocation`),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['basis']).toBe('none');
    expect(body['grossAmount']).toBe('90000');
    expect(body['netAmount']).toBe('90000');
    expect(body['pendingDistribution']).toBe(false);
    expect(body['items']).toHaveLength(2);
  });

  it('404s an expense that does not exist', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/expenses/00000000-0000-4000-8000-000000000000/refund-allocation`),
    );
    expect(response.status).toBe(404);
  });

  it('400s a malformed expense id', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/expenses/not-a-uuid/refund-allocation`),
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/payments/:paymentId/settlements', () => {
  let paymentId: PaymentId;

  beforeEach(async () => {
    paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(50_000n),
      direction: 'debit',
      occurredAt: OCCURRED_AT,
      rawDescription: 'UPI-FRIENDA-TRANSFER',
      channel: 'upi',
      state: 'normalized',
    });
  });

  it('records a manual settlement, independent of classification', async () => {
    const response = await api.handle(
      post(`/api/payments/${paymentId}/settlements`, {
        actor: 'user',
        counterpartyPersonId: cast.person['person_friend_a'],
        amount: '50000',
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['unexplainedRemainder']).toBe('0');
  });

  it('refuses an actor that is not a person', async () => {
    const response = await api.handle(
      post(`/api/payments/${paymentId}/settlements`, {
        actor: 'ai',
        counterpartyPersonId: cast.person['person_friend_a'],
        amount: '50000',
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('route table', () => {
  it('exposes the phase-12 routes', () => {
    const paths = api.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('POST /api/expenses/:expenseId/items');
    expect(paths).toContain('GET /api/expenses/:expenseId/items');
    expect(paths).toContain('POST /api/expenses/:expenseId/allocation');
    expect(paths).toContain('POST /api/expenses/:expenseId/adjustments');
    expect(paths).toContain('POST /api/expenses/:expenseId/adjustments/distribute');
    expect(paths).toContain('POST /api/payments/:paymentId/settlements');
  });

  it('exposes the phase-18 refund allocation read', () => {
    const paths = api.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('GET /api/expenses/:expenseId/refund-allocation');
  });
});
