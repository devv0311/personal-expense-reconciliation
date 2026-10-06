/**
 * Who paid must agree with what funded an expense, whatever the screen sent.
 *
 * The browser can now record an expense and count it at once ("Count it as spending now"), which
 * made two gaps in `createExpense` reachable in one step. Both are stated by the domain model
 * and neither was enforced here:
 *
 *  - An expense **approved** with no movement behind it is legitimate only when somebody else
 *    paid. One the user paid would be spending no statement shows ("An `Expense` cannot reach
 *    `APPROVED` without at least one `PaymentExpenseLink`, unless … externally-funded").
 *  - A payment in this ledger left one of the **user's** accounts, so an expense it funds was
 *    paid by the user (ADR-0006). Naming somebody else would invert every balance derived from
 *    it; the classification path already refuses exactly that.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paise } from '../../src/domain/index.js';
import type { EvidenceId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import { createExpense, linkPaymentToExpense } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

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

async function note(): Promise<EvidenceId> {
  const [row] = await database.db
    .insert(schema.evidence)
    .values({
      type: 'manual_note',
      noteKind: 'documentation',
      rawText: 'Synthetic note: somebody paid.',
      capturedAt: new Date('2026-08-10T00:00:00Z'),
    } as never)
    .returning({ id: schema.evidence.id });
  return row!.id as EvidenceId;
}

const base = {
  description: 'Flat internet',
  amount: paise(120_000n),
  occurredAt: new Date('2026-08-10T00:00:00Z'),
  relationshipType: 'household_shared_flat' as const,
  audit: AS_USER,
};

describe('approving an expense the user paid, with no movement behind it', () => {
  it('is refused, because it would count as spending no statement shows', async () => {
    await expect(
      createExpense(database.db, {
        ...base,
        paidByPersonId: cast.userPersonId,
        state: 'approved',
        evidenceId: await note(),
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', details: { field: 'funding' } });
  });

  it('is allowed as a proposal, which may still be waiting for its payment', async () => {
    const created = await createExpense(database.db, {
      ...base,
      paidByPersonId: cast.userPersonId,
      evidenceId: await note(),
    });
    expect(created.state).toBe('proposed');
  });

  it('is allowed when somebody else paid, which is what an external expense is', async () => {
    const created = await createExpense(database.db, {
      ...base,
      paidByPersonId: cast.person['person_flatmate_a']!,
      state: 'approved',
      evidenceId: await note(),
    });
    expect(created.state).toBe('approved');
    expect(created.externallyFunded).toBe(true);
  });

  it('is allowed when a payment in the ledger funds it', async () => {
    const payment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(120_000n),
      direction: 'debit',
      occurredAt: new Date('2026-08-10T00:00:00Z'),
      rawDescription: 'UPI-QA FLAT INTERNET',
      channel: 'upi',
    });
    const created = await createExpense(database.db, {
      ...base,
      paidByPersonId: cast.userPersonId,
      state: 'approved',
      funding: [{ paymentId: payment, amount: paise(120_000n) }],
    });
    expect(created.state).toBe('approved');
  });
});

describe('naming a payer other than the user for an expense one of the user’s payments funds', () => {
  async function userPayment() {
    return addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(120_000n),
      direction: 'debit',
      occurredAt: new Date('2026-08-10T00:00:00Z'),
      rawDescription: 'UPI-QA FLAT INTERNET',
      channel: 'upi',
    });
  }

  it('is refused at creation, as a proposal or approved', async () => {
    const payment = await userPayment();
    for (const state of ['proposed', 'approved'] as const) {
      await expect(
        createExpense(database.db, {
          ...base,
          paidByPersonId: cast.person['person_flatmate_a']!,
          state,
          funding: [{ paymentId: payment, amount: paise(120_000n) }],
        }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        details: { field: 'paidByPersonId' },
      });
    }
  });

  it('is refused when the link is added later to an expense somebody else paid', async () => {
    const payment = await userPayment();
    const expenseId = await addExpense(database.db, {
      description: 'Flat internet',
      amount: paise(120_000n),
      occurredAt: new Date('2026-08-10T00:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
    });

    await expect(
      linkPaymentToExpense(database.db, {
        expenseId,
        paymentId: payment,
        amount: paise(120_000n),
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', details: { field: 'paidByPersonId' } });
  });
});
