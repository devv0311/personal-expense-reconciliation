import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { AccountId, AiInferenceId, MerchantId, PaymentId } from '../../src/domain/index.js';
import {
  applyPaymentCounterparty,
  attachAiInferenceRecord,
  findClassificationInferenceByPayment,
  getAiInferenceById,
  getExpenseById,
  getMerchantById,
  getPersonById,
  getPrimaryUserPerson,
  insertAiInference,
  insertExpense,
  insertPaymentExpenseLink,
  listPaymentExpenseLinksByPayment,
  listPaymentsAwaitingClassification,
  listPeople,
  recordAiInferenceDecision,
  schema,
  updateExpenseClassification,
} from '../../src/db/index.js';
import { importBankStatementCsv, normalizePayments } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, seedCast, seedMerchants } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

let database: TestDatabase;
let cast: Cast;
let accountId: AccountId;
let merchant: Record<string, MerchantId>;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  accountId = cast.account['account_hdfc_savings']!;
  merchant = await seedMerchants(database.db);
});

function importFixture(content: string = FIXTURE) {
  return importBankStatementCsv(database.db, {
    accountId,
    sourceSystem: 'synthetic_bank_csv',
    fileContent: content,
    fileReference: 'fixtures/bank-statement.csv',
    audit: AS_USER,
  });
}

/** The state phase 8 starts from: everything imported and normalized. */
async function importedAndNormalized(): Promise<void> {
  await importFixture();
  await normalizePayments(database.db, { audit: AS_USER });
}

async function paymentIdByDescription(rawDescription: string): Promise<PaymentId> {
  const [row] = await database.db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eq(schema.payments.rawDescription, rawDescription))
    .orderBy(asc(schema.payments.direction));
  return asId<'payment'>(row!.id);
}

async function anInference(paymentId: PaymentId): Promise<AiInferenceId> {
  return insertAiInference(database.db, {
    inferenceType: 'classify_transaction',
    inputRefType: 'payment',
    inputRefId: paymentId,
    proposedOutput: {
      proposedKind: 'expense',
      relationshipType: 'personal',
      category: 'groceries',
      paidByPersonHint: null,
    },
    confidence: 'high',
    modelProvider: 'synthetic',
    modelName: 'scripted-test-model',
    promptVersion: 'classify_transaction/v1',
  });
}

describe('listPaymentsAwaitingClassification', () => {
  it('offers nothing until normalization has run', async () => {
    await importFixture();

    // Classification reads a channel and a counterparty normalization writes. An imported row
    // has neither, so there is nothing to classify yet.
    expect(await listPaymentsAwaitingClassification(database.db)).toEqual([]);
  });

  it('offers every normalized payment, with the fields classification reads', async () => {
    await importedAndNormalized();

    const awaiting = await listPaymentsAwaitingClassification(database.db);

    expect(awaiting).toHaveLength(8);
    expect(awaiting.every((row) => row.state === 'normalized')).toBe(true);
    expect(awaiting.every((row) => row.currency === 'INR')).toBe(true);
    expect(awaiting.every((row) => row.hasClassificationInference === false)).toBe(true);
    // Both directions: the credit leg of a transfer has to be reachable (ADR-0023).
    expect(awaiting.filter((row) => row.direction === 'credit')).toHaveLength(2);
    // The merchant normalization resolved comes through, so the AI context can name it.
    const blinkit = awaiting.find(
      (row) => row.rawDescription === 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    );
    expect(blinkit?.counterpartyId).toBe(merchant['merchant_blinkit']);
  });

  it('flags a payment that already carries a classification inference', async () => {
    await importedAndNormalized();
    const blinkit = await paymentIdByDescription('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
    await anInference(blinkit);

    const awaiting = await listPaymentsAwaitingClassification(database.db);

    // Still offered — the eligibility rule lives in `domain`, and it reports *why* a payment
    // is skipped rather than the query quietly dropping it.
    expect(awaiting).toHaveLength(8);
    expect(awaiting.filter((row) => row.hasClassificationInference)).toHaveLength(1);
    expect(awaiting.find((row) => row.hasClassificationInference)?.id).toBe(blinkit);
  });

  it('scopes to one import batch when asked', async () => {
    const first = await importFixture();
    if (first.outcome !== 'imported') throw new Error('expected an import');
    const second = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-20,UPI-NEWMERCHANT-SAMPLE,300.00,DEBIT,UPI/2607201234/NEW',
      ].join('\n'),
      audit: AS_USER,
    });
    if (second.outcome !== 'imported') throw new Error('expected an import');
    await normalizePayments(database.db, { audit: AS_USER });

    expect(
      await listPaymentsAwaitingClassification(database.db, second.importBatchId),
    ).toHaveLength(1);
    expect(await listPaymentsAwaitingClassification(database.db, first.importBatchId)).toHaveLength(
      8,
    );
  });

  it('excludes a payment already explained or discarded', async () => {
    await importedAndNormalized();
    const blinkit = await paymentIdByDescription('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
    await database.db
      .update(schema.payments)
      .set({ state: 'linked' })
      .where(eq(schema.payments.id, blinkit));

    expect(await listPaymentsAwaitingClassification(database.db)).toHaveLength(7);
  });
});

describe('ai_inferences round trip', () => {
  it('stores a proposal as pending, with what produced it', async () => {
    await importedAndNormalized();
    const paymentId = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');

    const inferenceId = await anInference(paymentId);
    const row = await getAiInferenceById(database.db, inferenceId);

    expect(row).toMatchObject({
      inferenceType: 'classify_transaction',
      inputRefType: 'payment',
      inputRefId: paymentId,
      confidence: 'high',
      status: 'pending',
      modelProvider: 'synthetic',
      modelName: 'scripted-test-model',
      promptVersion: 'classify_transaction/v1',
      decidedBy: null,
      decidedAt: null,
      resultingRecordType: null,
      resultingRecordId: null,
    });
    // The validated proposal, stored verbatim — the audit trail of what was proposed.
    expect(row?.proposedOutput).toEqual({
      proposedKind: 'expense',
      relationshipType: 'personal',
      category: 'groceries',
      paidByPersonHint: null,
    });
  });

  it('finds the classification inference for a payment, and null for one without', async () => {
    await importedAndNormalized();
    const withOne = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');
    const without = await paymentIdByDescription('UPI-FRIENDA-TRANSFER');
    const inferenceId = await anInference(withOne);

    expect((await findClassificationInferenceByPayment(database.db, withOne))?.id).toBe(
      inferenceId,
    );
    expect(await findClassificationInferenceByPayment(database.db, without)).toBeNull();
  });

  it('records a decision with its actor and the moment it was made', async () => {
    await importedAndNormalized();
    const paymentId = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');
    const inferenceId = await anInference(paymentId);

    await recordAiInferenceDecision(database.db, inferenceId, {
      status: 'accepted',
      decidedBy: 'user',
    });

    const row = await getAiInferenceById(database.db, inferenceId);
    expect(row).toMatchObject({ status: 'accepted', decidedBy: 'user' });
    expect(row?.decidedAt).toBeInstanceOf(Date);
  });

  it('points an inference at the record it produced', async () => {
    await importedAndNormalized();
    const paymentId = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');
    const inferenceId = await anInference(paymentId);
    const expenseId = await insertExpense(database.db, {
      description: 'Electricity Board',
      amount: paise(210_000n),
      currency: 'INR',
      occurredAt: new Date('2026-07-10T00:00:00Z'),
      relationshipType: 'household_shared_flat',
      category: 'utilities',
      paidByPersonId: cast.userPersonId,
      state: 'proposed',
    });

    await attachAiInferenceRecord(database.db, inferenceId, 'expense', expenseId);

    expect(await getAiInferenceById(database.db, inferenceId)).toMatchObject({
      resultingRecordType: 'expense',
      resultingRecordId: expenseId,
    });
  });
});

describe('expense writes', () => {
  it('creates an expense in the state the caller asked for', async () => {
    const expenseId = await insertExpense(database.db, {
      description: 'Blinkit',
      amount: paise(124_000n),
      currency: 'INR',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      relationshipType: 'personal',
      category: 'groceries',
      paidByPersonId: cast.userPersonId,
      state: 'proposed',
    });

    expect(await getExpenseById(database.db, expenseId)).toMatchObject({
      amount: 124_000n,
      currency: 'INR',
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'proposed',
    });
  });

  it('rewrites relationship type and category, and nothing else', async () => {
    const expenseId = await insertExpense(database.db, {
      description: 'Blinkit',
      amount: paise(124_000n),
      currency: 'INR',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      relationshipType: 'personal',
      category: 'groceries',
      paidByPersonId: cast.userPersonId,
      state: 'classified',
    });

    await updateExpenseClassification(database.db, expenseId, {
      relationshipType: 'household_shared_flat',
      category: 'household',
    });

    const [row] = await database.db
      .select({
        amount: schema.expenses.amount,
        state: schema.expenses.state,
        relationshipType: schema.expenses.relationshipType,
        category: schema.expenses.category,
        paidByPersonId: schema.expenses.paidByPersonId,
      })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expenseId));
    expect(row).toMatchObject({
      // A correction to what something cost is an ExpenseAdjustment, never an edit — and
      // there is no path here that could have touched it (invariants.md #6).
      amount: 124_000n,
      state: 'classified',
      relationshipType: 'household_shared_flat',
      category: 'household',
      paidByPersonId: cast.userPersonId,
    });
  });
});

describe('payment writes classification makes', () => {
  it('links part of a payment to an expense', async () => {
    await importedAndNormalized();
    const paymentId = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');
    const expenseId = await insertExpense(database.db, {
      description: 'Electricity Board',
      amount: paise(210_000n),
      currency: 'INR',
      occurredAt: new Date('2026-07-10T00:00:00Z'),
      relationshipType: 'household_shared_flat',
      category: 'utilities',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });

    await insertPaymentExpenseLink(database.db, {
      paymentId,
      expenseId,
      amount: paise(210_000n),
    });

    expect(await listPaymentExpenseLinksByPayment(database.db, paymentId)).toEqual([
      { amount: 210_000n },
    ]);
  });

  it('writes a counterparty without moving the payment out of normalized', async () => {
    await importedAndNormalized();
    const paymentId = await paymentIdByDescription('NEFT TRANSFER TO SELF A/C X4821');
    const before = await database.db
      .select({
        amount: schema.payments.amount,
        rawDescription: schema.payments.rawDescription,
        occurredAt: schema.payments.occurredAt,
      })
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId));

    await applyPaymentCounterparty(database.db, paymentId, {
      counterpartyType: 'internal_account',
      counterpartyId: null,
    });

    const [row] = await database.db
      .select({
        counterpartyType: schema.payments.counterpartyType,
        counterpartyId: schema.payments.counterpartyId,
        state: schema.payments.state,
        amount: schema.payments.amount,
        rawDescription: schema.payments.rawDescription,
        occurredAt: schema.payments.occurredAt,
      })
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId));
    expect(row).toMatchObject({
      counterpartyType: 'internal_account',
      counterpartyId: null,
      // A transfer stays here forever, and that is a valid terminal state (lifecycle.md).
      state: 'normalized',
    });
    // No SOURCE column moved.
    expect({
      amount: row?.amount,
      rawDescription: row?.rawDescription,
      occurredAt: row?.occurredAt,
    }).toEqual(before[0]);
  });
});

describe('the references a proposal is checked against', () => {
  it('reads a catalogued merchant back by id', async () => {
    expect(await getMerchantById(database.db, merchant['merchant_blinkit']!)).toEqual({
      id: merchant['merchant_blinkit'],
      canonicalName: 'Blinkit',
      defaultCategory: 'groceries',
    });
  });

  it('resolves the single user to their Person', async () => {
    expect(await getPrimaryUserPerson(database.db)).toEqual({
      personId: cast.userPersonId,
      displayName: 'Dev',
    });
  });

  it('lists the people a proposal may name', async () => {
    const people = await listPeople(database.db);

    expect(people.map((person) => person.id)).toContain(cast.person['person_friend_a']);
    expect(people.map((person) => person.id)).toContain(cast.userPersonId);
  });

  it('omits an archived person from the roster but still resolves them by id', async () => {
    const friendA = cast.person['person_friend_a']!;
    await database.db
      .update(schema.people)
      .set({ archivedAt: new Date('2026-07-15T00:00:00Z') })
      .where(eq(schema.people.id, friendA));

    expect((await listPeople(database.db)).map((person) => person.id)).not.toContain(friendA);
    // Still readable: an archived person may be named by an already-recorded settlement.
    expect(await getPersonById(database.db, friendA)).toMatchObject({ id: friendA });
  });

  it('returns null for a person id that names nobody', async () => {
    expect(
      await getPersonById(database.db, asId<'person'>('00000000-0000-4000-8000-000000000000')),
    ).toBeNull();
  });
});
