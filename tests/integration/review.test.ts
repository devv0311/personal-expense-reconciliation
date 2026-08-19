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
  listReviewQueue,
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

/* ======================================================================= listReviewQueue */

/** Two live payments a day apart, alike enough to be offered as a possible duplicate. */
async function addLookalikePair(): Promise<{ earlier: string; later: string }> {
  const earlier = await addPayment(database.db, cast, {
    accountId,
    amount: paise(45_000n),
    direction: 'debit',
    occurredAt: new Date('2026-07-14T00:00:00Z'),
    rawDescription: 'UPI-COFFEE-SHOP',
    channel: 'upi',
    state: 'normalized',
  });
  const later = await addPayment(database.db, cast, {
    accountId,
    amount: paise(45_000n),
    direction: 'debit',
    occurredAt: new Date('2026-07-14T00:00:30Z'),
    rawDescription: 'UPI-COFFEE-SHOP',
    channel: 'upi',
    state: 'normalized',
  });
  return { earlier, later };
}

describe('listReviewQueue — what is waiting', () => {
  it('is empty on an empty ledger', async () => {
    const queue = await listReviewQueue(database.db);

    expect(queue).toEqual({
      items: [],
      counts: {
        classification_decision: 0,
        possible_duplicate: 0,
        rejected_classification: 0,
      },
      total: 0,
      truncated: false,
    });
  });

  it('surfaces every pending decision the classifier produced', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db);

    expect(queue.total).toBe(5);
    expect(queue.counts).toEqual({
      classification_decision: 5,
      possible_duplicate: 0,
      rejected_classification: 0,
    });
    expect(queue.items.every((item) => item.kind === 'classification_decision')).toBe(true);
  });

  it('orders by what is at stake, not by what the database returned first', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db);

    // Flagged before routine; inside each, biggest first, then oldest, then id.
    expect(queue.items.map((item) => item.payment.description)).toEqual([
      'UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD', // medium confidence, ₹2,840
      'UPI-FRIENDA-TRANSFER', // settlement, always flagged, ₹1,000
      'ELECTRICITY BOARD BBPS BILLPAY', // routine, ₹2,100
      'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD', // routine, ₹1,240, 1 July
      'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD', // routine, ₹1,240, 12 July
    ]);
    const [zomato, settlement] = queue.items;
    expect(zomato?.reasons).toEqual(['low_confidence']);
    expect(settlement?.reasons).toEqual(['low_confidence', 'settlement_kind']);
  });

  it('tells a surface why a routine proposal is still here', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db);

    const blinkit = queue.items.find(
      (item) => item.kind === 'classification_decision' && item.confidence === 'high',
    );
    // Nothing auto-approves: a high-confidence, immaterial proposal is still a decision
    // nobody has made (invariants.md #16).
    expect(blinkit?.reasons).toEqual(['decision_required']);
  });

  it('carries the proposal itself, so a reviewer can see what they are agreeing to', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db);

    const electricity = queue.items.find(
      (item) => item.payment.description === 'ELECTRICITY BOARD BBPS BILLPAY',
    );
    if (electricity?.kind !== 'classification_decision') throw new Error('expected a decision');
    expect(electricity.proposal).toEqual({
      proposedKind: 'expense',
      relationshipType: 'household_shared_flat',
      category: 'utilities',
      paidByPersonHint: null,
    });
    expect(electricity.model).toEqual({
      provider: 'synthetic',
      name: 'scripted-classifier-v1',
      promptVersion: 'classify_transaction/v1',
    });
    expect(electricity.expense).toMatchObject({
      state: 'classified',
      relationshipType: 'household_shared_flat',
    });
  });

  it('makes a settlement proposal reviewable with no expense behind it', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db);

    const settlement = queue.items.find(
      (item) => item.kind === 'classification_decision' && item.proposedKind === 'settlement',
    );
    if (settlement?.kind !== 'classification_decision') throw new Error('expected a decision');
    expect(settlement.expense).toBeNull();
    expect(settlement.proposal).toMatchObject({
      proposedKind: 'settlement',
      counterpartyPersonHint: { type: 'person', id: cast.person['person_friend_a'] },
    });
    // The reviewer has everything needed to resolve the ambiguity: the payment, the proposed
    // counterparty, and the inference id that decideInference takes.
    expect(settlement.payment).toMatchObject({ amount: 100_000n, direction: 'debit' });
    expect(settlement.inferenceId).toBe(settlement.id);
  });

  it('returns the same answer twice, including the order', async () => {
    await classifiedFixture();
    await addLookalikePair();

    const first = await listReviewQueue(database.db);
    const second = await listReviewQueue(database.db);

    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(second.counts).toEqual(first.counts);
  });

  it('limits after ordering, and says so, without lying about the counts', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db, { limit: 2 });

    expect(queue.items).toHaveLength(2);
    expect(queue.truncated).toBe(true);
    expect(queue.total).toBe(5);
    // The badge count is the whole queue, not the page.
    expect(queue.counts.classification_decision).toBe(5);
    expect(queue.items[0]?.payment.description).toBe('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD');
  });

  it('filters to the kinds a caller asked for', async () => {
    await classifiedFixture();
    await addLookalikePair();

    const duplicatesOnly = await listReviewQueue(database.db, { kinds: ['possible_duplicate'] });

    expect(duplicatesOnly.items.every((item) => item.kind === 'possible_duplicate')).toBe(true);
    expect(duplicatesOnly.counts.classification_decision).toBe(0);
  });

  it('honours a caller-supplied materiality threshold when explaining an item', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db, { materialityThreshold: paise(100_000n) });

    // Everything is material now, so nothing is routine any more.
    expect(queue.items.every((item) => item.reasons.includes('material_amount'))).toBe(true);
  });
});

describe('listReviewQueue — possible duplicates', () => {
  it('offers a lookalike pair once, ranked ahead of every proposal', async () => {
    await classifiedFixture();
    const { earlier, later } = await addLookalikePair();

    const queue = await listReviewQueue(database.db);

    expect(queue.counts.possible_duplicate).toBe(1);
    const [first] = queue.items;
    if (first?.kind !== 'possible_duplicate') throw new Error('expected a duplicate first');
    // Ranked first even at ₹450 against a ₹2,840 proposal: the ledger may be counting one
    // transaction twice, and every downstream number derives from those rows.
    expect(first.payment.paymentId).toBe(later);
    expect(first.candidate.paymentId).toBe(earlier);
    expect(first.reasons).toEqual(['possible_duplicate']);
    expect(first.id).toBe(possibleDuplicateKey(earlier, later));
  });

  it('never offers the deterministic duplicate the importer already discarded', async () => {
    await classifiedFixture();
    const repeat = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-10,ELECTRICITY BOARD BBPS BILLPAY,2100.00,DEBIT,BBPS/EB220711',
      ].join('\n'),
      audit: AS_USER,
    });
    if (repeat.outcome !== 'imported') throw new Error('expected an import');

    const queue = await listReviewQueue(database.db);

    // A confirmed duplicate is `ignored`, and an ignored payment is not a candidate: the
    // deterministic path already answered this question (ADR-0019).
    expect(queue.counts.possible_duplicate).toBe(0);
  });

  it('does not pair two payments a fortnight apart', async () => {
    await classifiedFixture();

    // The fixture's two Blinkit rows share an amount and a direction but sit 11 days apart.
    const queue = await listReviewQueue(database.db);
    expect(queue.counts.possible_duplicate).toBe(0);
  });

  it('pairs them once the window is widened, which is a caller’s choice', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db, {
      duplicateWindowSeconds: 30 * 24 * 60 * 60,
    });

    expect(queue.counts.possible_duplicate).toBe(1);
  });
});

describe('listReviewQueue — a proposal that no longer parses', () => {
  it('surfaces it for a human instead of taking the queue down', async () => {
    await classifiedFixture();
    // Only a manual edit or a future bug can produce this — gate 1 validates before an
    // AIInference exists. The queue still has to survive it.
    await database.db
      .update(schema.aiInferences)
      .set({ proposedOutput: { proposedKind: 'something_else' } })
      .where(eq(schema.aiInferences.confidence, 'high'));

    const queue = await listReviewQueue(database.db);

    const malformed = queue.items.filter((item) => item.reasons.includes('malformed_proposal'));
    expect(malformed).toHaveLength(3);
    expect(queue.total).toBe(5);
    for (const item of malformed) {
      if (item.kind !== 'classification_decision') throw new Error('expected a decision');
      expect(item.proposal).toBeNull();
      expect(item.proposedKind).toBeNull();
      // Flagged, not routine: an unreadable proposal is exactly what a human should see.
      expect(queue.items.indexOf(item)).toBeLessThan(4);
    }
  });
});
