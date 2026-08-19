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
  listAuditEvents,
  listPaymentsAwaitingClassification,
  listPeople,
  recordAiInferenceDecision,
  schema,
  updateExpenseClassification,
} from '../../src/db/index.js';
import { createAiService } from '../../src/ai/index.js';
import {
  classifyPayment,
  classifyPayments,
  decideInference,
  importBankStatementCsv,
  normalizePayments,
} from '../../src/services/index.js';
import type { ClassificationOutcome, ProposedClassification } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, seedCast, seedMerchants } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { scriptedClassificationTransport } from '../support/ai.js';

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

/* ==================================================================== classification */

/** Classification is a system act; deciding one is not (invariants.md #15, #17). */
const AS_SYSTEM = { actor: 'system', source: 'services.classifyPayments' } as const;

/** The state phase 8 works on, with a model scripted from the fixture. */
async function classifyFixture(
  options: { overrides?: Record<string, unknown>; materialityThreshold?: bigint } = {},
) {
  await importedAndNormalized();
  const transport = scriptedClassificationTransport({
    people: cast.person,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });
  const result = await classifyPayments(database.db, {
    ai: createAiService(transport),
    audit: AS_SYSTEM,
    ...(options.materialityThreshold === undefined
      ? {}
      : { materialityThreshold: paise(options.materialityThreshold) }),
  });
  return { transport, result };
}

function outcomesByDescription(
  outcomes: readonly ClassificationOutcome[],
  rows: Array<{ id: string; rawDescription: string }>,
): Map<string, ClassificationOutcome[]> {
  const description = new Map(rows.map((row) => [row.id, row.rawDescription]));
  const grouped = new Map<string, ClassificationOutcome[]>();
  for (const outcome of outcomes) {
    const key = description.get(outcome.paymentId) ?? 'unknown';
    grouped.set(key, [...(grouped.get(key) ?? []), outcome]);
  }
  return grouped;
}

async function paymentRows(): Promise<Array<{ id: string; rawDescription: string }>> {
  return database.db
    .select({ id: schema.payments.id, rawDescription: schema.payments.rawDescription })
    .from(schema.payments);
}

describe('classifyPayments — the whole normalized statement', () => {
  it('reaches a recorded outcome for every payment, and never two for one', async () => {
    const { result } = await classifyFixture();

    expect(result.outcomes).toHaveLength(8);
    expect(new Set(result.outcomes.map((outcome) => outcome.paymentId)).size).toBe(8);
    const counted = result.outcomes.reduce<Record<string, number>>((totals, outcome) => {
      totals[outcome.outcome] = (totals[outcome.outcome] ?? 0) + 1;
      return totals;
    }, {});
    expect(counted).toEqual({ proposed: 5, internal_transfer: 2, skipped: 1 });
  });

  it('classifies a merchant debit as an expense and stops at CLASSIFIED when confident', async () => {
    const { result } = await classifyFixture();
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    const blinkit = grouped.get('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD') ?? [];
    // Two statement rows share this description; each is its own payment and its own proposal.
    expect(blinkit).toHaveLength(2);
    for (const outcome of blinkit) {
      expect(outcome).toMatchObject({
        outcome: 'proposed',
        proposedKind: 'expense',
        confidence: 'high',
        expenseState: 'classified',
        review: { requiresReview: false, reasons: [] },
      });
    }
    expect(
      new Set(blinkit.map((outcome) => (outcome as { expenseId: string }).expenseId)).size,
    ).toBe(2);
  });

  it('routes a medium-confidence proposal to REVIEW_REQUIRED', async () => {
    const { result } = await classifyFixture();
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    expect(grouped.get('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD')?.[0]).toMatchObject({
      outcome: 'proposed',
      proposedKind: 'expense',
      confidence: 'medium',
      expenseState: 'review_required',
      review: { requiresReview: true, reasons: ['low_confidence'] },
    });
  });

  it('proposes a settlement without creating anything authoritative', async () => {
    const { result } = await classifyFixture();
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    const p2p = grouped.get('UPI-FRIENDA-TRANSFER')?.[0];
    expect(p2p).toMatchObject({
      outcome: 'proposed',
      proposedKind: 'settlement',
      // A Settlement is created directly as APPROVED, so nothing exists until it is accepted.
      expenseId: null,
      expenseState: null,
      review: { requiresReview: true },
    });
    if (p2p?.outcome !== 'proposed') throw new Error('expected a proposal');
    expect(p2p.review.reasons).toContain('settlement_kind');
    expect(await database.db.select().from(schema.settlements)).toEqual([]);
    // The payment is untouched too: its counterparty is resolved when the proposal is accepted.
    const [payment] = await database.db
      .select({ state: schema.payments.state, counterpartyType: schema.payments.counterpartyType })
      .from(schema.payments)
      .where(eq(schema.payments.rawDescription, 'UPI-FRIENDA-TRANSFER'));
    expect(payment).toMatchObject({ state: 'normalized', counterpartyType: 'unknown' });
  });

  it('recognises both legs of the self-transfer deterministically, with no inference', async () => {
    const { result, transport } = await classifyFixture();

    const transfers = result.outcomes.filter((outcome) => outcome.outcome === 'internal_transfer');
    expect(transfers).toHaveLength(2);
    // Each leg names the other as its evidence.
    const ids = transfers.map((outcome) => outcome.paymentId);
    const counterLegs = transfers.map(
      (outcome) => (outcome as { counterLegPaymentId: string }).counterLegPaymentId,
    );
    expect([...counterLegs].sort()).toEqual([...ids].sort());

    const rows = await database.db
      .select({
        counterpartyType: schema.payments.counterpartyType,
        counterpartyId: schema.payments.counterpartyId,
        state: schema.payments.state,
      })
      .from(schema.payments)
      .where(eq(schema.payments.externalReference, 'NEFT/N072026001'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        counterpartyType: 'internal_account',
        counterpartyId: null,
        // A valid terminal state: a transfer is excluded from spend by its type alone.
        state: 'normalized',
      });
    }
    // The model was never asked about either leg.
    expect(transport.asked.some((description) => description.includes('SELF A/C'))).toBe(false);
  });

  it('leaves the refund credit alone, with a reason rather than a silence', async () => {
    const { result, transport } = await classifyFixture();
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    expect(grouped.get('ACH REFUND SAMPLE ELECTRONICS STORE')?.[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'credit_out_of_scope',
    });
    // Not asked, not stored: V1 does not classify inflow (ADR-0015, ADR-0027).
    expect(transport.asked.some((description) => description.includes('ACH REFUND'))).toBe(false);
    const [payment] = await database.db
      .select({
        state: schema.payments.state,
        counterpartyType: schema.payments.counterpartyType,
        counterpartyId: schema.payments.counterpartyId,
      })
      .from(schema.payments)
      .where(eq(schema.payments.rawDescription, 'ACH REFUND SAMPLE ELECTRONICS STORE'));
    // Still exactly as normalization left it — merchant resolved, nothing classified.
    expect(payment).toMatchObject({
      state: 'normalized',
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_sample_electronics'],
    });
  });

  it('stores one pending inference per proposal, naming what produced it', async () => {
    await classifyFixture();

    const inferences = await database.db
      .select({
        inferenceType: schema.aiInferences.inferenceType,
        status: schema.aiInferences.status,
        confidence: schema.aiInferences.confidence,
        modelProvider: schema.aiInferences.modelProvider,
        modelName: schema.aiInferences.modelName,
        promptVersion: schema.aiInferences.promptVersion,
        proposedOutput: schema.aiInferences.proposedOutput,
        resultingRecordType: schema.aiInferences.resultingRecordType,
      })
      .from(schema.aiInferences);

    expect(inferences).toHaveLength(5);
    expect(inferences.every((row) => row.status === 'pending')).toBe(true);
    expect(inferences.every((row) => row.inferenceType === 'classify_transaction')).toBe(true);
    expect(inferences.every((row) => row.modelProvider === 'synthetic')).toBe(true);
    expect(inferences.every((row) => row.promptVersion === 'classify_transaction/v1')).toBe(true);
    // The expense path points at its DERIVED expense; the settlement path has nothing to point at.
    expect(inferences.filter((row) => row.resultingRecordType === 'expense')).toHaveLength(4);
    expect(inferences.filter((row) => row.resultingRecordType === null)).toHaveLength(1);
  });

  it('sends the model a redacted description and never a reference', async () => {
    const { transport } = await classifyFixture();

    expect(transport.asked).toHaveLength(5);
    expect(transport.asked).toContain('UPI-BLINKIT[redacted-number]PAYTM-BLINKIT INDIA PVT LTD');
    expect(transport.asked.join('|')).not.toContain('UPI/2607011234/BLINKIT');
    expect(transport.asked.join('|')).not.toContain('9821');
  });

  it('is a no-op on a second run', async () => {
    const { result: first } = await classifyFixture();
    const transport = scriptedClassificationTransport({ people: cast.person });

    const second = await classifyPayments(database.db, {
      ai: createAiService(transport),
      audit: AS_SYSTEM,
    });

    expect(first.outcomes.filter((outcome) => outcome.outcome === 'proposed')).toHaveLength(5);
    // Nothing to do: proposals already exist, and the transfers are already classified.
    expect(second.outcomes.every((outcome) => outcome.outcome === 'skipped')).toBe(true);
    expect(second.outcomes.map((outcome) => (outcome as { reason: string }).reason).sort()).toEqual(
      [
        'already_classified',
        'already_classified',
        'already_classified',
        'already_classified',
        'already_classified',
        'credit_out_of_scope',
        'non_spend_counterparty',
        'non_spend_counterparty',
      ],
    );
    expect(transport.asked).toEqual([]);
    expect(await database.db.select().from(schema.aiInferences)).toHaveLength(5);
    expect(await database.db.select().from(schema.expenses)).toHaveLength(4);
  });

  it('scopes to one import batch when asked', async () => {
    await importedAndNormalized();
    const second = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-20,ELECTRICITY BOARD BBPS BILLPAY,2100.00,DEBIT,BBPS/EB220720',
      ].join('\n'),
      audit: AS_USER,
    });
    if (second.outcome !== 'imported') throw new Error('expected an import');
    await normalizePayments(database.db, { audit: AS_USER });

    const result = await classifyPayments(database.db, {
      importBatchId: second.importBatchId,
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      audit: AS_SYSTEM,
    });

    expect(result.outcomes).toHaveLength(1);
    expect(await database.db.select().from(schema.aiInferences)).toHaveLength(1);
  });
});

describe('classifyPayments — routing and thresholds', () => {
  it('reviews a high-confidence proposal once it is material', async () => {
    // ₹1,000 threshold: the ₹1,240 Blinkit rows cross it, the model's confidence unchanged.
    const { result } = await classifyFixture({ materialityThreshold: 100_000n });
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    for (const outcome of grouped.get('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD') ?? []) {
      expect(outcome).toMatchObject({
        confidence: 'high',
        expenseState: 'review_required',
        review: { requiresReview: true, reasons: ['material_amount'] },
      });
    }
  });

  it('never approves anything, however confident the model is', async () => {
    await classifyFixture();

    const states = await database.db.select({ state: schema.expenses.state }).from(schema.expenses);
    expect(
      states.every((row) => row.state === 'classified' || row.state === 'review_required'),
    ).toBe(true);
    // No links, no settlements, no approved expenses: classification explains nothing yet.
    expect(await database.db.select().from(schema.paymentExpenseLinks)).toEqual([]);
    expect(await database.db.select().from(schema.settlements)).toEqual([]);
  });
});

describe('classifyPayments — what it refuses to store', () => {
  it('records a malformed response as a rejection, writing nothing, and carries on', async () => {
    const { result } = await classifyFixture({
      overrides: {
        'ELECTRICITY BOARD BBPS BILLPAY': {
          confidence: 'high',
          proposedOutput: { proposedKind: 'household_bill' },
        },
      },
    });
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    expect(grouped.get('ELECTRICITY BOARD BBPS BILLPAY')?.[0]).toMatchObject({
      outcome: 'rejected',
      code: 'FIELD_INVALID',
    });
    // Rejected before it becomes an AIInference at all (ai-boundary.md), and the other four
    // proposals are unaffected — one bad answer is not a bad run.
    expect(await database.db.select().from(schema.aiInferences)).toHaveLength(4);
    expect(await database.db.select().from(schema.expenses)).toHaveLength(3);
    expect(result.outcomes.filter((outcome) => outcome.outcome === 'proposed')).toHaveLength(4);
  });

  it('refuses a settlement naming somebody who does not exist', async () => {
    const { result } = await classifyFixture({
      overrides: {
        'UPI-FRIENDA-TRANSFER': {
          confidence: 'high',
          proposedOutput: {
            proposedKind: 'settlement',
            counterpartyPersonHint: {
              type: 'person',
              id: '00000000-0000-4000-8000-000000000000',
            },
          },
        },
      },
    });
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    expect(grouped.get('UPI-FRIENDA-TRANSFER')?.[0]).toMatchObject({
      outcome: 'rejected',
      code: 'AI_PROPOSAL_INVALID',
    });
    expect(await database.db.select().from(schema.aiInferences)).toHaveLength(4);
  });

  it('refuses an expense whose proposed payer is not the account owner', async () => {
    const { result } = await classifyFixture({
      overrides: {
        'UPI-ZOMATO[redacted-number]-SAMPLE RESTAURANT PVT LTD': {
          confidence: 'high',
          proposedOutput: {
            proposedKind: 'expense',
            relationshipType: 'shared',
            category: 'dining',
            paidByPersonHint: { type: 'person', id: cast.person['person_friend_a'] },
          },
        },
      },
    });
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    // An expense someone else paid for has no Payment in this ledger at all (ADR-0006), so a
    // payment-driven proposal saying otherwise contradicts its own evidence.
    expect(grouped.get('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD')?.[0]).toMatchObject({
      outcome: 'rejected',
      code: 'AI_PROPOSAL_INVALID',
    });
  });

  it('refuses a settlement the user proposes with themselves', async () => {
    const { result } = await classifyFixture({
      overrides: {
        'UPI-FRIENDA-TRANSFER': {
          confidence: 'high',
          proposedOutput: {
            proposedKind: 'settlement',
            counterpartyPersonHint: { type: 'person', id: cast.userPersonId },
          },
        },
      },
    });
    const grouped = outcomesByDescription(result.outcomes, await paymentRows());

    expect(grouped.get('UPI-FRIENDA-TRANSFER')?.[0]).toMatchObject({
      outcome: 'rejected',
      code: 'AI_PROPOSAL_INVALID',
    });
  });

  it('aborts the run when the provider itself fails, rather than calling it a rejection', async () => {
    await importedAndNormalized();
    const failing = {
      modelInfo: { provider: 'synthetic', model: 'unreachable' },
      complete: () => Promise.reject(new Error('provider unavailable')),
    };

    await expect(
      classifyPayments(database.db, { ai: createAiService(failing), audit: AS_SYSTEM }),
    ).rejects.toThrow('provider unavailable');
    // The run stops at the first payment it cannot get an answer for, rather than working
    // through eight of them collecting the same failure eight times.
    expect(await database.db.select().from(schema.aiInferences)).toEqual([]);
  });
});

describe('classifyPayment — one payment', () => {
  it('refuses to classify a payment normalization has not reached', async () => {
    await importFixture();
    const paymentId = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');

    const outcome = await classifyPayment(database.db, {
      paymentId,
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      audit: AS_SYSTEM,
    });

    expect(outcome).toEqual({ outcome: 'skipped', paymentId, reason: 'not_normalized' });
    expect(await database.db.select().from(schema.aiInferences)).toEqual([]);
  });

  it('audits the proposal, the expense and each transition it walked', async () => {
    await importedAndNormalized();
    const paymentId = await paymentIdByDescription('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD');

    const outcome = await classifyPayment(database.db, {
      paymentId,
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      audit: AS_SYSTEM,
    });

    if (outcome.outcome !== 'proposed') throw new Error('expected a proposal');
    const inferenceEvents = await listAuditEvents(database.db, 'ai_inference', outcome.inferenceId);
    expect(inferenceEvents.map((event) => event.action)).toEqual(['create']);
    expect(inferenceEvents[0]?.newValue).toMatchObject({
      status: 'pending',
      proposedKind: 'expense',
      confidence: 'medium',
    });
    // Never the model: an AuditEvent's actor is a person, a rule, or the system that ran the
    // job — the proposal is evidence of what a model said, not an act it performed.
    expect(inferenceEvents[0]?.actor).toBe('system');

    const expenseEvents = await listAuditEvents(database.db, 'expense', outcome.expenseId!);
    expect(expenseEvents.map((event) => event.action)).toEqual(['create', 'update', 'update']);
    expect(expenseEvents[0]?.newValue).toMatchObject({ state: 'proposed' });
    expect(expenseEvents[1]).toMatchObject({
      oldValue: { state: 'proposed' },
      newValue: { state: 'classified' },
    });
    expect(expenseEvents[2]).toMatchObject({
      oldValue: { state: 'classified' },
      newValue: { state: 'review_required' },
    });
    expect(expenseEvents[2]?.reason).toContain('low_confidence');
  });

  it('copies the payment onto the expense, and the merchant onto its description', async () => {
    await importedAndNormalized();
    const paymentId = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');

    const outcome = await classifyPayment(database.db, {
      paymentId,
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      audit: AS_SYSTEM,
    });

    if (outcome.outcome !== 'proposed' || outcome.expenseId === null) {
      throw new Error('expected an expense proposal');
    }
    const [expense] = await database.db
      .select({
        description: schema.expenses.description,
        amount: schema.expenses.amount,
        currency: schema.expenses.currency,
        occurredAt: schema.expenses.occurredAt,
        relationshipType: schema.expenses.relationshipType,
        category: schema.expenses.category,
        paidByPersonId: schema.expenses.paidByPersonId,
      })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, outcome.expenseId));
    expect(expense).toMatchObject({
      description: 'Electricity Board',
      amount: 210_000n,
      currency: 'INR',
      occurredAt: new Date('2026-07-10T00:00:00.000Z'),
      relationshipType: 'household_shared_flat',
      category: 'utilities',
      // The payer of a payment-funded expense is the account owner, always (ADR-0006).
      paidByPersonId: cast.userPersonId,
    });
  });
});

/* ================================================================= decideInference */

/** Deciding is a person's act, or a Rule's — never the system's (invariants.md #17). */
const AS_REVIEWER = { actor: 'user', source: 'services.decideInference' } as const;

/** Classifies the fixture and returns the proposal for one payment description. */
async function proposalFor(
  rawDescription: string,
  options: { overrides?: Record<string, unknown> } = {},
): Promise<ProposedClassification> {
  const { result } = await classifyFixture(options);
  const grouped = outcomesByDescription(result.outcomes, await paymentRows());
  const outcome = grouped.get(rawDescription)?.[0];
  if (outcome?.outcome !== 'proposed') {
    throw new Error(`Expected a proposal for ${rawDescription}, got ${outcome?.outcome}.`);
  }
  return outcome;
}

async function expenseRow(expenseId: string) {
  const [row] = await database.db
    .select({
      state: schema.expenses.state,
      relationshipType: schema.expenses.relationshipType,
      category: schema.expenses.category,
      amount: schema.expenses.amount,
    })
    .from(schema.expenses)
    .where(eq(schema.expenses.id, expenseId));
  return row;
}

async function paymentState(paymentId: string) {
  const [row] = await database.db
    .select({
      state: schema.payments.state,
      counterpartyType: schema.payments.counterpartyType,
      counterpartyId: schema.payments.counterpartyId,
    })
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId));
  return row;
}

describe('decideInference — accepting an expense proposal', () => {
  it('approves the expense, explains the payment, and records who decided', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    const result = await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    expect(result).toMatchObject({
      status: 'accepted',
      resultingRecordType: 'expense',
      expenseId: proposal.expenseId,
      expenseState: 'approved',
      paymentState: 'linked',
      // The whole payment is accounted for: nothing left unexplained.
      unexplainedRemainder: 0n,
    });
    expect(await expenseRow(proposal.expenseId!)).toMatchObject({ state: 'approved' });
    expect(await paymentState(proposal.paymentId)).toMatchObject({ state: 'linked' });
    expect(await listPaymentExpenseLinksByPayment(database.db, proposal.paymentId)).toEqual([
      { amount: 210_000n },
    ]);
    expect(await getAiInferenceById(database.db, proposal.inferenceId)).toMatchObject({
      status: 'accepted',
      decidedBy: 'user',
      resultingRecordType: 'expense',
      resultingRecordId: proposal.expenseId,
    });
  });

  it('accepts a proposal a Rule decided, keeping the rule id for traceability', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'accept',
      audit: { actor: 'rule:00000000-0000-4000-8000-000000000abc', source: 'rules' },
    });

    // A systematically wrong rule is fixable at its source (invariants.md #17).
    expect(await getAiInferenceById(database.db, proposal.inferenceId)).toMatchObject({
      status: 'accepted',
      decidedBy: 'rule:00000000-0000-4000-8000-000000000abc',
    });
  });

  it('approves an expense that was sitting in REVIEW_REQUIRED', async () => {
    const proposal = await proposalFor('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD');
    expect(proposal.expenseState).toBe('review_required');

    const result = await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    expect(result).toMatchObject({ status: 'accepted', expenseState: 'approved' });
  });

  it('audits the approval, the link and the payment together', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    const expenseEvents = await listAuditEvents(database.db, 'expense', proposal.expenseId!);
    const approval = expenseEvents.at(-1);
    expect(approval).toMatchObject({
      action: 'update',
      oldValue: { state: 'classified' },
      newValue: { state: 'approved' },
      actor: 'user',
    });
    expect(approval?.reason).toContain('immutable');

    const inferenceEvents = await listAuditEvents(
      database.db,
      'ai_inference',
      proposal.inferenceId,
    );
    expect(inferenceEvents.map((event) => event.action)).toEqual(['create', 'update']);
    expect(inferenceEvents[1]).toMatchObject({
      oldValue: { status: 'pending' },
      newValue: { status: 'accepted', decidedBy: 'user' },
    });

    const paymentEvents = await listAuditEvents(database.db, 'payment', proposal.paymentId);
    expect(paymentEvents.at(-1)).toMatchObject({
      oldValue: { state: 'normalized' },
      newValue: { state: 'linked' },
    });
  });

  it('refuses a second expense drawn on a payment already fully explained', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');
    await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });
    // A second proposal about the same payment, as a re-classification would produce.
    const second = await anInference(proposal.paymentId);

    await expect(
      decideInference(database.db, {
        inferenceId: second,
        decision: 'accept',
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_BUDGET_EXCEEDED' });
    // Rolled back whole: no second expense, no second link.
    expect(await listPaymentExpenseLinksByPayment(database.db, proposal.paymentId)).toHaveLength(1);
    expect(await getAiInferenceById(database.db, second)).toMatchObject({ status: 'pending' });
  });
});

describe('decideInference — accepting a settlement proposal', () => {
  it('creates the settlement, resolves the counterparty, and never an allocation', async () => {
    const proposal = await proposalFor('UPI-FRIENDA-TRANSFER');
    expect(proposal.expenseId).toBeNull();

    const result = await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    expect(result).toMatchObject({
      status: 'accepted',
      resultingRecordType: 'settlement',
      counterpartyPersonId: cast.person['person_friend_a'],
      paymentState: 'linked',
      unexplainedRemainder: 0n,
    });
    const settlements = await database.db
      .select({
        paymentId: schema.settlements.paymentId,
        counterpartyPersonId: schema.settlements.counterpartyPersonId,
        amount: schema.settlements.amount,
      })
      .from(schema.settlements);
    expect(settlements).toEqual([
      {
        paymentId: proposal.paymentId,
        counterpartyPersonId: cast.person['person_friend_a'],
        amount: 100_000n,
      },
    ]);
    // A settlement discharges a debt; it never creates one (invariants.md #9, #9a).
    expect(await database.db.select().from(schema.allocations)).toEqual([]);
    expect(await database.db.select().from(schema.paymentExpenseLinks)).toEqual([]);
    // The person-to-person payment is finally resolved to the person it went to.
    expect(await paymentState(proposal.paymentId)).toMatchObject({
      state: 'linked',
      counterpartyType: 'person',
      counterpartyId: cast.person['person_friend_a'],
    });
  });

  it('records the counterparty resolution as its own audited change', async () => {
    const proposal = await proposalFor('UPI-FRIENDA-TRANSFER');

    await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    const events = await listAuditEvents(database.db, 'payment', proposal.paymentId);
    const resolution = events.find(
      (event) => (event.newValue as { counterpartyType?: string }).counterpartyType === 'person',
    );
    expect(resolution).toMatchObject({
      oldValue: { counterpartyType: 'unknown', counterpartyId: null },
      newValue: { counterpartyType: 'person', counterpartyId: cast.person['person_friend_a'] },
    });
  });
});

describe('decideInference — rejecting', () => {
  it('produces no authoritative record and leaves the proposal’s expense unapproved', async () => {
    const proposal = await proposalFor('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD');

    const result = await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });

    expect(result).toEqual({ status: 'rejected', inferenceId: proposal.inferenceId });
    expect(await getAiInferenceById(database.db, proposal.inferenceId)).toMatchObject({
      status: 'rejected',
      decidedBy: 'user',
    });
    // The DERIVED expense stays where it was: nothing here deletes financial records, and an
    // unapproved expense reaches no total (ADR-0026).
    expect(await expenseRow(proposal.expenseId!)).toMatchObject({ state: 'review_required' });
    expect(await paymentState(proposal.paymentId)).toMatchObject({ state: 'normalized' });
    expect(await database.db.select().from(schema.paymentExpenseLinks)).toEqual([]);
  });

  it('refuses a rejection that carries a corrected proposal', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    await expect(
      decideInference(database.db, {
        inferenceId: proposal.inferenceId,
        decision: 'reject',
        modifiedOutput: { proposedKind: 'expense', relationshipType: 'personal' },
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('decideInference — modifying', () => {
  it('applies the correction, then approves what was corrected', async () => {
    const proposal = await proposalFor('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD');

    const result = await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'personal',
        category: 'dining',
      },
      audit: AS_REVIEWER,
    });

    expect(result).toMatchObject({ status: 'modified', expenseState: 'approved' });
    expect(await expenseRow(proposal.expenseId!)).toMatchObject({
      state: 'approved',
      relationshipType: 'personal',
      category: 'dining',
      // The amount is the payment's, and no correction path can touch it (invariants.md #6).
      amount: 284_000n,
    });
    expect(await getAiInferenceById(database.db, proposal.inferenceId)).toMatchObject({
      status: 'modified',
    });
  });

  it('turns a settlement proposal into an expense, creating the expense it never had', async () => {
    const proposal = await proposalFor('UPI-FRIENDA-TRANSFER');
    expect(proposal.expenseId).toBeNull();

    const result = await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'paid_on_behalf',
        category: 'lending',
      },
      audit: AS_REVIEWER,
    });

    if (result.status === 'rejected' || result.resultingRecordType !== 'expense') {
      throw new Error('expected an expense');
    }
    expect(await expenseRow(result.expenseId)).toMatchObject({
      state: 'approved',
      relationshipType: 'paid_on_behalf',
      amount: 100_000n,
    });
    expect(await database.db.select().from(schema.settlements)).toEqual([]);
    expect(await paymentState(proposal.paymentId)).toMatchObject({ state: 'linked' });
  });

  it('turns an expense proposal into a settlement, leaving the expense behind and saying so', async () => {
    const proposal = await proposalFor('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD');

    const result = await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'settlement',
        counterpartyPersonHint: { type: 'person', id: cast.person['person_friend_a'] },
      },
      audit: AS_REVIEWER,
    });

    expect(result).toMatchObject({ status: 'modified', resultingRecordType: 'settlement' });
    // The DERIVED expense is not approved and not deleted — and the audit trail says why it is
    // sitting there, rather than leaving a reader to guess (ADR-0026).
    expect(await expenseRow(proposal.expenseId!)).toMatchObject({ state: 'review_required' });
    const events = await listAuditEvents(database.db, 'expense', proposal.expenseId!);
    expect(events.at(-1)).toMatchObject({
      action: 'supersede',
      newValue: { supersededBy: 'settlement' },
    });
    expect(await database.db.select().from(schema.paymentExpenseLinks)).toEqual([]);
  });

  it('refuses a modification that is not a proposal at all', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    await expect(
      decideInference(database.db, {
        inferenceId: proposal.inferenceId,
        decision: 'modify',
        modifiedOutput: { proposedKind: 'expense', relationshipType: 'settlement' },
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ name: 'AiContractError', code: 'FIELD_INVALID' });

    // A correction gets no easier door than the model's original: still pending, still
    // unapproved (ai-boundary.md).
    expect(await getAiInferenceById(database.db, proposal.inferenceId)).toMatchObject({
      status: 'pending',
    });
    expect(await expenseRow(proposal.expenseId!)).toMatchObject({ state: 'classified' });
  });

  it('refuses a modification the ledger contradicts', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    await expect(
      decideInference(database.db, {
        inferenceId: proposal.inferenceId,
        decision: 'modify',
        modifiedOutput: {
          proposedKind: 'settlement',
          counterpartyPersonHint: {
            type: 'person',
            id: '00000000-0000-4000-8000-000000000000',
          },
        },
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'AI_PROPOSAL_INVALID' });
  });

  it('refuses a modification with nothing to modify', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    await expect(
      decideInference(database.db, {
        inferenceId: proposal.inferenceId,
        decision: 'modify',
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses an acceptance that quietly carries a different proposal', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    // The distinction between `accepted` and `modified` is what the audit trail records; an
    // accept that changed something would make that record a lie.
    await expect(
      decideInference(database.db, {
        inferenceId: proposal.inferenceId,
        decision: 'accept',
        modifiedOutput: { proposedKind: 'expense', relationshipType: 'personal' },
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('decideInference — the gate itself', () => {
  it('refuses a decision nobody is accountable for', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');

    for (const actor of ['system', 'ai', 'anthropic']) {
      await expect(
        decideInference(database.db, {
          inferenceId: proposal.inferenceId,
          decision: 'accept',
          audit: { actor, source: 'services.decideInference' },
        }),
      ).rejects.toMatchObject({ code: 'DECISION_ACTOR_INVALID' });
    }

    // Nothing moved: an AIInference leaves `pending` only through an attributable decision.
    expect(await getAiInferenceById(database.db, proposal.inferenceId)).toMatchObject({
      status: 'pending',
    });
    expect(await expenseRow(proposal.expenseId!)).toMatchObject({ state: 'classified' });
  });

  it('refuses to decide the same inference twice', async () => {
    const proposal = await proposalFor('ELECTRICITY BOARD BBPS BILLPAY');
    await decideInference(database.db, {
      inferenceId: proposal.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    await expect(
      decideInference(database.db, {
        inferenceId: proposal.inferenceId,
        decision: 'reject',
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    // A decided inference is never re-opened; a re-run supersedes it instead (lifecycle.md).
    expect(await getAiInferenceById(database.db, proposal.inferenceId)).toMatchObject({
      status: 'accepted',
    });
  });

  it('refuses an inference that does not exist', async () => {
    await expect(
      decideInference(database.db, {
        inferenceId: asId<'ai_inference'>('00000000-0000-4000-8000-000000000000'),
        decision: 'accept',
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
  });
});
