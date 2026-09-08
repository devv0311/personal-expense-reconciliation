/**
 * Financial authoring end to end (audit rows 16–21, 29).
 *
 * Create an expense by hand — including the one somebody else paid for — fund it from one or
 * more payments, itemize it, correct a wrong breakdown, allocate it by units, and record a
 * repayment that shows up in the register.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import type { Paise } from '../../src/domain/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
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

async function seedDebit(amount: bigint, description = 'RESTAURANT BILL'): Promise<string> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: amount as Paise,
    direction: 'debit',
    occurredAt: new Date('2026-07-20T12:00:00.000Z'),
    rawDescription: description,
    channel: 'upi',
    state: 'normalized',
  });
}

async function seedCredit(amount: bigint, description: string, at: string): Promise<string> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: amount as Paise,
    direction: 'credit',
    occurredAt: new Date(at),
    rawDescription: description,
    channel: 'upi',
    state: 'normalized',
  });
}

async function noteEvidence(text: string): Promise<string> {
  const response = await post('/api/evidence/notes', {
    actor: 'user',
    noteKind: 'documentation',
    text,
    capturedAt: '2026-07-20T12:05:00.000Z',
  });
  const { evidenceId } = (await response.json()) as { evidenceId: string };
  return evidenceId;
}

describe('creating an expense by hand', () => {
  it('records a self-funded expense and links the payment that funded it', async () => {
    const paymentId = await seedDebit(284000n);
    const response = await post('/api/expenses', {
      actor: 'user',
      description: 'Dinner at the new place',
      amount: '284000',
      occurredAt: '2026-07-20T12:00:00.000Z',
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId, amount: '284000' }],
      state: 'approved',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { expenseId: string; externallyFunded: boolean };
    expect(body.externallyFunded).toBe(false);

    const links = await getJson<{ links: Array<{ paymentId: string; amount: string }> }>(
      `/api/expenses/${body.expenseId}/payment-links`,
    );
    expect(links.links).toEqual([expect.objectContaining({ paymentId, amount: '284000' })]);
  });

  it('records an expense somebody else paid for, with evidence and no fabricated payment', async () => {
    const evidenceId = await noteEvidence('Flatmate A paid the electrician in cash; ₹3,000.');
    const response = await post('/api/expenses', {
      actor: 'user',
      description: 'Electrician',
      amount: '300000',
      occurredAt: '2026-07-18T09:00:00.000Z',
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
      evidenceId,
      state: 'approved',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { expenseId: string; externallyFunded: boolean };
    expect(body.externallyFunded).toBe(true);

    const links = await getJson<{ links: unknown[] }>(
      `/api/expenses/${body.expenseId}/payment-links`,
    );
    // ADR-0006: no Payment exists, so no PaymentExpenseLink does either.
    expect(links.links).toEqual([]);

    const expense = await getJson<Record<string, unknown>>(`/api/expenses/${body.expenseId}`);
    expect(expense['paidByPersonId']).toBe(cast.person['person_flatmate_a']);
  });

  it('refuses an externally-funded expense with no evidence behind it', async () => {
    const response = await post('/api/expenses', {
      actor: 'user',
      description: 'Something a flatmate paid for',
      amount: '100000',
      occurredAt: '2026-07-18T09:00:00.000Z',
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
    });
    expect(response.status).toBe(409);
  });

  it('refuses a zero-amount expense', async () => {
    const response = await post('/api/expenses', {
      actor: 'user',
      description: 'Nothing',
      amount: '0',
      occurredAt: '2026-07-18T09:00:00.000Z',
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    expect(response.status).toBe(409);
  });
});

describe('funding links, both many-to-many shapes', () => {
  it('splits one payment across two expenses', async () => {
    const paymentId = await seedDebit(500000n, 'ONE ORDER, TWO PURPOSES');
    const first = await post('/api/expenses', {
      actor: 'user',
      description: 'Groceries',
      amount: '300000',
      occurredAt: '2026-07-20T12:00:00.000Z',
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId, amount: '300000' }],
    });
    expect(first.status).toBe(201);

    const second = await post('/api/expenses', {
      actor: 'user',
      description: 'A personal book',
      amount: '200000',
      occurredAt: '2026-07-20T12:00:00.000Z',
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId, amount: '200000' }],
    });
    expect(second.status).toBe(201);

    const payment = await getJson<Record<string, unknown>>(`/api/payments/${paymentId}`);
    expect(payment['expenseLinkCount']).toBe(2);
    expect(payment['unexplainedTotal']).toBe('0');
  });

  it('funds one expense from two payments', async () => {
    const deposit = await seedDebit(100000n, 'DEPOSIT');
    const balance = await seedDebit(400000n, 'BALANCE');
    const created = await post('/api/expenses', {
      actor: 'user',
      description: 'Trip package',
      amount: '500000',
      occurredAt: '2026-07-20T12:00:00.000Z',
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId: deposit, amount: '100000' }],
    });
    const { expenseId } = (await created.json()) as { expenseId: string };

    const added = await post(`/api/expenses/${expenseId}/payment-links`, {
      actor: 'user',
      paymentId: balance,
      amount: '400000',
    });
    expect(added.status).toBe(201);

    const links = await getJson<{ links: unknown[] }>(`/api/expenses/${expenseId}/payment-links`);
    expect(links.links).toHaveLength(2);
  });

  it('refuses links that explain more money than the payment moved', async () => {
    const paymentId = await seedDebit(100000n);
    const created = await post('/api/expenses', {
      actor: 'user',
      description: 'First',
      amount: '80000',
      occurredAt: '2026-07-20T12:00:00.000Z',
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId, amount: '80000' }],
    });
    const { expenseId } = (await created.json()) as { expenseId: string };
    expect(expenseId).toBeTruthy();

    const second = await post('/api/expenses', {
      actor: 'user',
      description: 'Second',
      amount: '50000',
      occurredAt: '2026-07-20T12:00:00.000Z',
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId, amount: '50000' }],
    });
    expect(second.status).toBe(422);
  });

  it('refuses funding an expense from a credit', async () => {
    const creditId = await seedCredit(50000n, 'REFUND CREDIT', '2026-07-21T12:00:00.000Z');
    const response = await post('/api/expenses', {
      actor: 'user',
      description: 'Funded by a credit?',
      amount: '50000',
      occurredAt: '2026-07-21T12:00:00.000Z',
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId: creditId, amount: '50000' }],
    });
    expect(response.status).toBe(409);
  });
});

describe('itemizing and correcting a breakdown', () => {
  let expenseId: string;

  beforeEach(async () => {
    const paymentId = await seedDebit(100000n);
    const created = await post('/api/expenses', {
      actor: 'user',
      description: 'Shared basket',
      amount: '100000',
      occurredAt: '2026-07-20T12:00:00.000Z',
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId, amount: '100000' }],
      state: 'approved',
    });
    expenseId = ((await created.json()) as { expenseId: string }).expenseId;

    await post(`/api/expenses/${expenseId}/items`, {
      actor: 'user',
      items: [
        { description: 'Thali', amount: '60000' },
        { description: 'Dessert', amount: '40000' },
      ],
    });
  });

  it('replaces a wrong breakdown, superseding the old rows rather than deleting them', async () => {
    const response = await post(`/api/expenses/${expenseId}/items/correct`, {
      actor: 'user',
      reason: 'The dessert was actually two items on the bill',
      items: [
        { description: 'Thali', amount: '60000' },
        { description: 'Gulab jamun', amount: '25000' },
        { description: 'Coffee', amount: '15000' },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ description: string }>;
      supersededItemIds: string[];
    };
    expect(body.items.map((item) => item.description)).toEqual(['Thali', 'Gulab jamun', 'Coffee']);
    expect(body.supersededItemIds).toHaveLength(2);

    const current = await getJson<{ items: Array<{ description: string }> }>(
      `/api/expenses/${expenseId}/items`,
    );
    expect(current.items).toHaveLength(3);
  });

  it('refuses a correction that changes what the purchase cost', async () => {
    const response = await post(`/api/expenses/${expenseId}/items/correct`, {
      actor: 'user',
      reason: 'Trying to change the total',
      items: [{ description: 'Everything', amount: '90000' }],
    });
    expect(response.status).toBe(422);
  });

  it('refuses a correction with no reason', async () => {
    const response = await post(`/api/expenses/${expenseId}/items/correct`, {
      actor: 'user',
      items: [{ description: 'Everything', amount: '100000' }],
    });
    expect(response.status).toBe(400);
  });

  it('refuses correcting a basket an item refund has already been attributed to', async () => {
    const items = await getJson<{ items: Array<{ id: string; amount: string }> }>(
      `/api/expenses/${expenseId}/items`,
    );
    const dessert = items.items.find((item) => item.amount === '40000')!;
    const recorded = await post(`/api/expenses/${expenseId}/adjustments`, {
      actor: 'user',
      kind: 'merchant_refund',
      amount: '10000',
      occurredAt: '2026-07-22T12:00:00.000Z',
      itemAttributions: [{ expenseItemId: dessert.id, amount: '10000' }],
    });
    expect(recorded.status).toBe(201);

    const response = await post(`/api/expenses/${expenseId}/items/correct`, {
      actor: 'user',
      reason: 'Too late',
      items: [
        { description: 'Thali', amount: '60000' },
        { description: 'Dessert', amount: '40000' },
      ],
    });
    expect(response.status).toBe(409);
  });
});

describe('quantity-based allocation over HTTP (audit row 21)', () => {
  it('divides a shared item by the units each person took', async () => {
    const paymentId = await seedDebit(100000n);
    const created = await post('/api/expenses', {
      actor: 'user',
      description: 'Three thalis',
      amount: '100000',
      occurredAt: '2026-07-20T12:00:00.000Z',
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId, amount: '100000' }],
      state: 'approved',
    });
    const { expenseId } = (await created.json()) as { expenseId: string };

    await post(`/api/expenses/${expenseId}/items`, {
      actor: 'user',
      items: [{ description: 'Thalis x3', amount: '100000', quantity: '3' }],
    });
    const items = await getJson<{ items: Array<{ id: string }> }>(
      `/api/expenses/${expenseId}/items`,
    );
    const itemId = items.items[0]!.id;

    const response = await post(`/api/expenses/${expenseId}/allocation`, {
      actor: 'user',
      method: 'quantity_based',
      lines: [
        {
          beneficiary: { type: 'person', id: cast.userPersonId },
          expenseItemId: itemId,
          units: '2',
        },
        {
          beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
          expenseItemId: itemId,
          units: '1',
        },
      ],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { lines: Array<{ amount: string }> };
    const amounts = body.lines.map((line) => BigInt(line.amount));
    expect(amounts.reduce((sum, amount) => sum + amount, 0n)).toBe(100000n);
    expect(amounts.sort()).toEqual([33333n, 66667n].sort());
  });
});

describe('the settlement register (audit row 29)', () => {
  it('records a repayment and lists it, with the direction the payment says', async () => {
    const repayment = await seedCredit(
      90000n,
      'UPI FRIEND A REPAYMENT',
      '2026-07-25T09:00:00.000Z',
    );

    const recorded = await post(`/api/payments/${repayment}/settlements`, {
      actor: 'user',
      counterpartyPersonId: cast.person['person_friend_a']!,
      amount: '90000',
    });
    expect(recorded.status).toBe(201);

    const register = await getJson<{
      settlements: Array<{ counterpartyName: string; direction: string; amount: string }>;
      total: number;
    }>('/api/settlements');
    expect(register.total).toBe(1);
    expect(register.settlements[0]).toMatchObject({ direction: 'credit', amount: '90000' });
    expect(register.settlements[0]?.counterpartyName).toBeTruthy();
  });

  it('narrows the register to one counterparty', async () => {
    const repayment = await seedCredit(
      50000n,
      'UPI FRIEND B REPAYMENT',
      '2026-07-26T09:00:00.000Z',
    );
    await post(`/api/payments/${repayment}/settlements`, {
      actor: 'user',
      counterpartyPersonId: cast.person['person_friend_b']!,
      amount: '50000',
    });

    const mine = await getJson<{ total: number }>(
      `/api/settlements?counterpartyPersonId=${cast.person['person_friend_a']!}`,
    );
    expect(mine.total).toBe(0);
    const theirs = await getJson<{ total: number }>(
      `/api/settlements?counterpartyPersonId=${cast.person['person_friend_b']!}`,
    );
    expect(theirs.total).toBe(1);
  });
});
