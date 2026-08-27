import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { ExpenseId } from '../../src/domain/index.js';
import { listAuditEvents, schema } from '../../src/db/index.js';
import { getExpenseItems, recordExpenseItems } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const AS_USER = { actor: 'user', source: 'tests/integration/expense-items' } as const;
const OCCURRED_AT = new Date('2026-07-01T19:20:00.000Z');

let database: TestDatabase;
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
  cast = await seedCast(database.db);
  expenseId = await addExpense(database.db, {
    description: 'Blinkit order',
    amount: paise(124_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'personal',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
});

const ITEMS = [
  { description: 'Amul Milk 1L (x2)', amount: paise(8_000n), quantity: '2' },
  { description: 'Chicken Breast 500g', amount: paise(31_000n) },
  { description: 'Shampoo 340ml', amount: paise(26_000n) },
  { description: 'Dish Soap', amount: paise(14_000n) },
  { description: 'Snacks (assorted)', amount: paise(45_000n) },
] as const;

describe('recordExpenseItems', () => {
  it('writes the whole item set, summing to the gross amount', async () => {
    const result = await recordExpenseItems(database.db, {
      expenseId,
      items: ITEMS,
      audit: AS_USER,
    });

    expect(result.items).toHaveLength(5);
    expect(result.items.map((item) => item.description)).toContain('Amul Milk 1L (x2)');
    expect(result.items.find((item) => item.description.includes('Milk'))?.quantity).toBe('2');
  });

  it('audits each item individually', async () => {
    const result = await recordExpenseItems(database.db, {
      expenseId,
      items: ITEMS,
      audit: AS_USER,
    });

    for (const item of result.items) {
      const events = await listAuditEvents(database.db, 'expense_item', item.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'create', actor: 'user' });
    }
  });

  it('links an item back to the ReceiptItem it came from', async () => {
    const [receiptRow] = await database.db
      .insert(schema.evidence)
      .values({
        type: 'receipt_image',
        storageRef: 'sha256/deadbeef.jpg',
        mediaType: 'image/jpeg',
        byteSize: 100,
        capturedAt: OCCURRED_AT,
      })
      .returning({ id: schema.evidence.id });
    const [receipt] = await database.db
      .insert(schema.receipts)
      .values({ evidenceId: receiptRow!.id, total: paise(124_000n), confirmedByUser: true })
      .returning({ id: schema.receipts.id });
    const [receiptItem] = await database.db
      .insert(schema.receiptItems)
      .values({ receiptId: receipt!.id, description: 'Amul Milk 1L (x2)', lineTotal: 8_000n })
      .returning({ id: schema.receiptItems.id });

    const result = await recordExpenseItems(database.db, {
      expenseId,
      items: [
        { ...ITEMS[0], receiptItemId: asId<'receipt_item'>(receiptItem!.id) },
        ITEMS[1],
        ITEMS[2],
        ITEMS[3],
        ITEMS[4],
      ],
      audit: AS_USER,
    });

    expect(result.items[0]?.receiptItemId).toBe(receiptItem!.id);
  });

  it('refuses a partial itemization — items must sum to the gross amount', async () => {
    await expect(
      recordExpenseItems(database.db, {
        expenseId,
        items: [{ description: 'Only one item', amount: paise(8_000n) }],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'EXPENSE_ITEMS_SUM_MISMATCH' });
  });

  it('refuses a second call — an expense is itemized once', async () => {
    await recordExpenseItems(database.db, { expenseId, items: ITEMS, audit: AS_USER });

    await expect(
      recordExpenseItems(database.db, { expenseId, items: ITEMS, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a ReceiptItem id that does not exist', async () => {
    await expect(
      recordExpenseItems(database.db, {
        expenseId,
        items: [
          {
            ...ITEMS[0],
            receiptItemId: asId<'receipt_item'>('00000000-0000-4000-8000-000000000000'),
          },
          ITEMS[1],
          ITEMS[2],
          ITEMS[3],
          ITEMS[4],
        ],
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
  });

  it('refuses an expense that does not exist', async () => {
    const absent = asId<'expense'>('00000000-0000-4000-8000-000000000000');
    await expect(
      recordExpenseItems(database.db, { expenseId: absent, items: ITEMS, audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
  });
});

describe('getExpenseItems', () => {
  it('reads back what was recorded', async () => {
    await recordExpenseItems(database.db, { expenseId, items: ITEMS, audit: AS_USER });

    const items = await getExpenseItems(database.db, expenseId);
    expect(items).toHaveLength(5);
  });

  it('returns an empty list for an un-itemized expense', async () => {
    expect(await getExpenseItems(database.db, expenseId)).toEqual([]);
  });
});
