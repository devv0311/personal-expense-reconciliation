import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paise } from '../../src/domain/index.js';
import { listExpenses, recordExpenseAdjustment } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const AS_USER = { actor: 'user', source: 'tests/integration/expense-ledger' } as const;
const OCCURRED_AT = new Date('2026-07-01T19:20:00.000Z');
const EARLIER = new Date('2026-06-15T09:00:00.000Z');
const LATER = new Date('2026-07-10T12:00:00.000Z');

let database: TestDatabase;
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
});

describe('listExpenses', () => {
  it('returns an empty ledger when nothing has been recorded', async () => {
    expect(await listExpenses(database.db, {})).toEqual([]);
  });

  it('lists expenses newest-occurred first', async () => {
    const older = await addExpense(database.db, {
      description: 'Groceries',
      amount: paise(50_000n),
      occurredAt: EARLIER,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    const newer = await addExpense(database.db, {
      description: 'Taxi',
      amount: paise(90_000n),
      occurredAt: LATER,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });

    const rows = await listExpenses(database.db, {});
    expect(rows.map((row) => row.id)).toEqual([newer, older]);
  });

  it('computes netAmount from recorded adjustments, never touching the gross amount', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Flight ticket',
      amount: paise(300_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(50_000n),
      occurredAt: OCCURRED_AT,
      audit: AS_USER,
    });

    const [row] = await listExpenses(database.db, {});
    expect(row?.grossAmount).toBe(300_000n);
    expect(row?.netAmount).toBe(250_000n);
  });

  it('filters by state', async () => {
    await addExpense(database.db, {
      description: 'Approved one',
      amount: paise(10_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    const proposedId = await addExpense(database.db, {
      description: 'Still proposed',
      amount: paise(20_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'proposed',
    });

    const proposedOnly = await listExpenses(database.db, { state: 'proposed' });
    expect(proposedOnly.map((row) => row.id)).toEqual([proposedId]);
  });

  it('filters by paidByPersonId', async () => {
    const friendId = cast.person['person_friend_a']!;
    await addExpense(database.db, {
      description: 'Paid by Dev',
      amount: paise(10_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    const friendExpenseId = await addExpense(database.db, {
      description: 'Paid by Friend A',
      amount: paise(20_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'shared',
      paidByPersonId: friendId,
      state: 'approved',
    });

    const friendOnly = await listExpenses(database.db, { paidByPersonId: friendId });
    expect(friendOnly.map((row) => row.id)).toEqual([friendExpenseId]);
  });

  it('applies the default bounded limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await addExpense(database.db, {
        description: `Expense ${i}`,
        amount: paise(1_000n),
        occurredAt: OCCURRED_AT,
        relationshipType: 'personal',
        paidByPersonId: cast.userPersonId,
        state: 'approved',
      });
    }

    const limited = await listExpenses(database.db, { limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
