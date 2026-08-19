import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { paise, possibleDuplicateKey } from '../../src/domain/index.js';
import type { AccountId } from '../../src/domain/index.js';
import {
  insertAuditEvent,
  listDismissedDuplicatePairs,
  listPendingClassificationInferences,
  listPossibleDuplicateCandidates,
  listRejectedClassifications,
  recordAiInferenceDecision,
  schema,
  updateExpenseState,
} from '../../src/db/index.js';
import {
  classifyPayments,
  decideInference,
  importBankStatementCsv,
  normalizePayments,
} from '../../src/services/index.js';
import type { ProposedClassification } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { AS_USER, addPayment, seedCast, seedMerchants } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

const AS_SYSTEM = { actor: 'system', source: 'services.classifyPayments' } as const;
const AS_REVIEWER = { actor: 'user', source: 'services.decideInference' } as const;

let database: TestDatabase;
let cast: Cast;
let accountId: AccountId;

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
  await seedMerchants(database.db);
});

/** Import → normalize → classify: the state phase 9 reviews. */
async function classifiedFixture(): Promise<readonly ProposedClassification[]> {
  await importBankStatementCsv(database.db, {
    accountId,
    sourceSystem: 'synthetic_bank_csv',
    fileContent: FIXTURE,
    fileReference: 'fixtures/bank-statement.csv',
    audit: AS_USER,
  });
  await normalizePayments(database.db, { audit: AS_USER });
  const { outcomes } = await classifyPayments(database.db, {
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    audit: AS_SYSTEM,
  });
  return outcomes.filter(
    (outcome): outcome is ProposedClassification => outcome.outcome === 'proposed',
  );
}

describe('listPendingClassificationInferences', () => {
  it('returns nothing before anything has been classified', async () => {
    expect(await listPendingClassificationInferences(database.db)).toEqual([]);
  });

  it('returns every pending proposal with the payment it is about', async () => {
    const proposals = await classifiedFixture();

    const pending = await listPendingClassificationInferences(database.db);

    expect(pending).toHaveLength(proposals.length);
    expect(pending).toHaveLength(5);
    const electricity = pending.find(
      (row) => row.paymentDescription === 'ELECTRICITY BOARD BBPS BILLPAY',
    );
    expect(electricity).toMatchObject({
      confidence: 'high',
      modelProvider: 'synthetic',
      promptVersion: 'classify_transaction/v1',
      paymentAmount: 210_000n,
      paymentCurrency: 'INR',
      paymentDirection: 'debit',
      paymentState: 'normalized',
      paymentCounterpartyType: 'merchant',
      expenseState: 'classified',
      expenseDescription: 'Electricity Board',
      expenseRelationshipType: 'household_shared_flat',
      expenseCategory: 'utilities',
    });
    expect(electricity?.proposedOutput).toMatchObject({ proposedKind: 'expense' });
  });

  it('keeps a settlement proposal, which has no expense to join to', async () => {
    await classifiedFixture();

    const pending = await listPendingClassificationInferences(database.db);

    // The left join is the point: an inner one would drop exactly the proposals phase 9
    // exists to make reviewable (ADR-0026).
    const settlement = pending.find((row) => row.paymentDescription === 'UPI-FRIENDA-TRANSFER');
    expect(settlement).toMatchObject({
      expenseId: null,
      expenseState: null,
      expenseRelationshipType: null,
      paymentAmount: 100_000n,
    });
    expect(settlement?.proposedOutput).toMatchObject({ proposedKind: 'settlement' });
  });

  it('drops a proposal as soon as it is decided', async () => {
    const proposals = await classifiedFixture();
    const first = proposals[0]!;

    await decideInference(database.db, {
      inferenceId: first.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    const pending = await listPendingClassificationInferences(database.db);
    expect(pending).toHaveLength(4);
    expect(pending.map((row) => row.inferenceId)).not.toContain(first.inferenceId);
  });
});

describe('listRejectedClassifications', () => {
  it('returns nothing while every proposal is still pending', async () => {
    await classifiedFixture();

    expect(await listRejectedClassifications(database.db)).toEqual([]);
  });

  it('returns a payment left unexplained by a rejection, with its rejected expense', async () => {
    const proposals = await classifiedFixture();
    const zomato = proposals.find((proposal) => proposal.expenseState === 'review_required')!;

    await decideInference(database.db, {
      inferenceId: zomato.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });

    const rejected = await listRejectedClassifications(database.db);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      paymentId: zomato.paymentId,
      amount: 284_000n,
      inferenceId: zomato.inferenceId,
      decidedBy: 'user',
      expenseId: zomato.expenseId,
    });
  });

  it('says nothing about a payment that was explained', async () => {
    const proposals = await classifiedFixture();
    const accepted = proposals.find((proposal) => proposal.proposedKind === 'expense')!;

    await decideInference(database.db, {
      inferenceId: accepted.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    expect(await listRejectedClassifications(database.db)).toEqual([]);
  });

  it('says nothing about a payment that already has a newer pending proposal', async () => {
    const proposals = await classifiedFixture();
    const target = proposals[0]!;
    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });
    expect(await listRejectedClassifications(database.db)).toHaveLength(1);

    // A re-classification puts the payment back in the queue as a pending decision; it must
    // not also appear as an unexplained one.
    await database.db.insert(schema.aiInferences).values({
      inferenceType: 'classify_transaction',
      inputRefType: 'payment',
      inputRefId: target.paymentId,
      proposedOutput: { proposedKind: 'expense', relationshipType: 'personal' },
      confidence: 'high',
    });

    expect(await listRejectedClassifications(database.db)).toEqual([]);
  });
});

describe('listPossibleDuplicateCandidates', () => {
  it('returns nothing when no two live payments share an amount and a direction', async () => {
    await classifiedFixture();

    // The fixture's two Blinkit rows do share both — everything else is unique.
    const candidates = await listPossibleDuplicateCandidates(database.db);
    expect(candidates.every((row) => row.amount === 124_000n)).toBe(true);
  });

  it('pairs two live payments sharing an amount and a direction', async () => {
    const occurredAt = new Date('2026-07-14T00:00:00Z');
    const first = await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt,
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'normalized',
    });
    const second = await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt,
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'normalized',
    });

    const candidates = await listPossibleDuplicateCandidates(database.db);

    expect(candidates.map((row) => row.id).sort()).toEqual([first, second].sort());
  });

  it('excludes an opposite-direction twin — money in is never a duplicate of money out', async () => {
    const occurredAt = new Date('2026-07-14T00:00:00Z');
    await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt,
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'normalized',
    });
    await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'credit',
      occurredAt,
      rawDescription: 'REFUND',
      channel: 'upi',
      state: 'normalized',
    });

    expect(await listPossibleDuplicateCandidates(database.db)).toEqual([]);
  });

  it('excludes a payment already explained or already discarded', async () => {
    const occurredAt = new Date('2026-07-14T00:00:00Z');
    const linked = await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt,
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'linked',
    });
    await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt,
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'normalized',
    });

    // A linked payment is explained by an expense or a settlement, and the lifecycle has no
    // `linked → ignored` edge to confirm a duplicate with.
    const candidates = await listPossibleDuplicateCandidates(database.db);
    expect(candidates.map((row) => row.id)).not.toContain(linked);
    // …and with its twin gone, the survivor has nothing to pair with either.
    expect(candidates).toEqual([]);
  });
});

describe('listDismissedDuplicatePairs', () => {
  it('is empty until somebody dismisses a pair', async () => {
    expect(await listDismissedDuplicatePairs(database.db)).toEqual([]);
  });

  it('returns the pair keys a reviewer has ruled out', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-14T00:00:00Z'),
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'normalized',
    });
    const pairKey = possibleDuplicateKey(paymentId, 'other-payment');
    await insertAuditEvent(database.db, {
      entityType: 'payment',
      entityId: paymentId,
      action: 'update',
      oldValue: null,
      newValue: { possibleDuplicateDecision: 'dismissed', possibleDuplicatePairKey: pairKey },
      actor: 'user',
      source: 'tests',
      reason: null,
    });

    expect(await listDismissedDuplicatePairs(database.db)).toEqual([pairKey]);
  });

  it('ignores audit events that are not duplicate dismissals', async () => {
    const proposals = await classifiedFixture();
    await decideInference(database.db, {
      inferenceId: proposals[0]!.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    // Accepting writes payment and expense events; none of them is a dismissal.
    expect(await listDismissedDuplicatePairs(database.db)).toEqual([]);
  });
});

describe('the rejected expense state, through the repository', () => {
  it('records a declined proposal’s expense as rejected', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    await updateExpenseState(database.db, target.expenseId!, 'rejected');
    await recordAiInferenceDecision(database.db, target.inferenceId, {
      status: 'rejected',
      decidedBy: 'user',
    });

    const [expense] = await database.db
      .select({ state: schema.expenses.state, amount: schema.expenses.amount })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, target.expenseId!));
    expect(expense?.state).toBe('rejected');
    // Still there, still exactly what it was: nothing deletes financial records.
    expect(expense?.amount).toBe(124_000n);
  });
});
