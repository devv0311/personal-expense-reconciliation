import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { asId, paise, possibleDuplicateKey } from '../../src/domain/index.js';
import type { AccountId, PaymentId } from '../../src/domain/index.js';
import {
  insertAuditEvent,
  listAuditEvents,
  listDismissedDuplicatePairs,
  listPendingClassificationInferences,
  listPossibleDuplicateCandidates,
  listRejectedClassifications,
  recordAiInferenceDecision,
  schema,
  updateExpenseState,
} from '../../src/db/index.js';
import {
  approveExpense,
  classifyPayments,
  decideInference,
  importBankStatementCsv,
  listReviewQueue,
  confirmPossibleDuplicate,
  dismissPossibleDuplicate,
  normalizePayments,
  reclassifyPayment,
  runReconciliation,
} from '../../src/services/index.js';
import type { ProposedClassification, ReviewQueueItem } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { AS_USER, addPayment, seedCast, seedMerchants } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

/**
 * The payment description an item is about, or `null` for an item that is not about one.
 *
 * `unmatched_evidence` is the second kind — a document with no payment attached is the whole
 * reason it is in the queue — so the union no longer has `payment` on every member.
 */
const describedAs = (item: ReviewQueueItem): string | null =>
  'payment' in item ? item.payment.description : null;

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

/** Import and normalize only — the state before anything has been proposed. */
async function importedAndNormalizedOnly(): Promise<void> {
  await importBankStatementCsv(database.db, {
    accountId,
    sourceSystem: 'synthetic_bank_csv',
    fileContent: FIXTURE,
    fileReference: 'fixtures/bank-statement.csv',
    audit: AS_USER,
  });
  await normalizePayments(database.db, { audit: AS_USER });
}

async function paymentIdByDescription(rawDescription: string): Promise<PaymentId> {
  const [row] = await database.db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eq(schema.payments.rawDescription, rawDescription));
  return asId<'payment'>(row!.id);
}

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
async function addLookalikePair(): Promise<{ earlier: PaymentId; later: PaymentId }> {
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
        unmatched_evidence: 0,
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
      unmatched_evidence: 0,
    });
    expect(queue.items.every((item) => item.kind === 'classification_decision')).toBe(true);
  });

  it('orders by what is at stake, not by what the database returned first', async () => {
    await classifiedFixture();

    const queue = await listReviewQueue(database.db);

    // Flagged before routine; inside each, biggest first, then oldest, then id.
    expect(queue.items.map(describedAs)).toEqual([
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
      (item) => describedAs(item) === 'ELECTRICITY BOARD BBPS BILLPAY',
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
    expect(describedAs(queue.items[0]!)).toBe('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD');
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

/* ==================================================================== review actions */

const AS_AI = { actor: 'ai', source: 'services.reclassifyPayment' } as const;

function aiService(overrides?: Record<string, unknown>) {
  return createAiService(
    scriptedClassificationTransport({
      people: cast.person,
      ...(overrides === undefined ? {} : { overrides }),
    }),
  );
}

async function expenseState(expenseId: string): Promise<string | undefined> {
  const [row] = await database.db
    .select({ state: schema.expenses.state })
    .from(schema.expenses)
    .where(eq(schema.expenses.id, expenseId));
  return row?.state;
}

async function inferenceRow(inferenceId: string) {
  const [row] = await database.db
    .select({
      status: schema.aiInferences.status,
      decidedBy: schema.aiInferences.decidedBy,
      resultingRecordId: schema.aiInferences.resultingRecordId,
    })
    .from(schema.aiInferences)
    .where(eq(schema.aiInferences.id, inferenceId));
  return row;
}

describe('rejecting a proposal closes out the expense it created', () => {
  it('moves the DERIVED expense to rejected, in the same transaction', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });

    expect(await expenseState(target.expenseId!)).toBe('rejected');
    expect(await inferenceRow(target.inferenceId)).toMatchObject({ status: 'rejected' });
  });

  it('keeps the expense and its amount — nothing is deleted', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });

    const [expense] = await database.db
      .select({ amount: schema.expenses.amount, description: schema.expenses.description })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, target.expenseId!));
    expect(expense).toMatchObject({ amount: 124_000n });
  });

  it('audits the closure with a reason a reader can act on', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });

    const events = await listAuditEvents(database.db, 'expense', target.expenseId!);
    expect(events.at(-1)).toMatchObject({
      action: 'update',
      oldValue: { state: 'classified' },
      newValue: { state: 'rejected' },
      actor: 'user',
    });
    expect(events.at(-1)?.reason).toContain('declined');
  });

  it('leaves the rejected expense out of the queue’s pending work', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });

    const queue = await listReviewQueue(database.db);
    expect(queue.counts.classification_decision).toBe(4);
    // It reappears as an unexplained payment instead — ranked last, because nothing is at risk.
    expect(queue.counts.rejected_classification).toBe(1);
    expect(queue.items.at(-1)).toMatchObject({
      kind: 'rejected_classification',
      reasons: ['payment_unexplained'],
      expenseState: 'rejected',
    });
  });
});

describe('reclassifyPayment', () => {
  it('supersedes the pending proposal and records a new one, in one transaction', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    const result = await reclassifyPayment(database.db, {
      paymentId: target.paymentId,
      ai: aiService(),
      audit: AS_REVIEWER,
    });

    expect(result.supersededInferenceId).toBe(target.inferenceId);
    expect(result.outcome.outcome).toBe('proposed');
    expect(await inferenceRow(target.inferenceId)).toMatchObject({
      status: 'superseded',
      decidedBy: 'user',
    });
    // The old proposal's expense goes with it; the new proposal has its own.
    expect(await expenseState(target.expenseId!)).toBe('rejected');
    if (result.outcome.outcome !== 'proposed') throw new Error('expected a proposal');
    expect(result.outcome.expenseId).not.toBe(target.expenseId);
    expect(await expenseState(result.outcome.expenseId!)).toBe('classified');
  });

  it('puts exactly one pending decision back in the queue', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    await reclassifyPayment(database.db, {
      paymentId: target.paymentId,
      ai: aiService(),
      audit: AS_REVIEWER,
    });

    const queue = await listReviewQueue(database.db);
    // Still five decisions: the superseded one left, the new one arrived.
    expect(queue.counts.classification_decision).toBe(5);
    expect(queue.counts.rejected_classification).toBe(0);
    const forPayment = queue.items.filter(
      (item) =>
        item.kind === 'classification_decision' && item.payment.paymentId === target.paymentId,
    );
    expect(forPayment).toHaveLength(1);
    expect(forPayment[0]?.id).not.toBe(target.inferenceId);
  });

  it('asks again after a rejection, with nothing left to supersede', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;
    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });

    const result = await reclassifyPayment(database.db, {
      paymentId: target.paymentId,
      ai: aiService(),
      audit: AS_REVIEWER,
    });

    // A rejected proposal is a decision the trail keeps — it is not rewritten as superseded.
    expect(result.supersededInferenceId).toBeNull();
    expect(await inferenceRow(target.inferenceId)).toMatchObject({ status: 'rejected' });
    expect(result.outcome.outcome).toBe('proposed');
    const queue = await listReviewQueue(database.db);
    expect(queue.counts.rejected_classification).toBe(0);
    expect(queue.counts.classification_decision).toBe(5);
  });

  it('carries the model’s new answer, not the old one', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find(
      (proposal) => proposal.expenseId !== null && proposal.confidence === 'high',
    )!;

    const result = await reclassifyPayment(database.db, {
      paymentId: target.paymentId,
      ai: aiService({
        'UPI-BLINKIT[redacted-number]PAYTM-BLINKIT INDIA PVT LTD': {
          confidence: 'low',
          proposedOutput: {
            proposedKind: 'expense',
            relationshipType: 'household_shared_flat',
            category: 'groceries',
          },
        },
      }),
      audit: AS_REVIEWER,
    });

    if (result.outcome.outcome !== 'proposed') throw new Error('expected a proposal');
    expect(result.outcome.confidence).toBe('low');
    expect(result.outcome.expenseState).toBe('review_required');
  });

  it('refuses a payment nobody has classified', async () => {
    await importedAndNormalizedOnly();
    const paymentId = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');

    await expect(
      reclassifyPayment(database.db, { paymentId, ai: aiService(), audit: AS_REVIEWER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a payment already explained by an accepted decision', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;
    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });

    // Unwinding an approved Expense and its PaymentExpenseLink is not a review action this
    // phase offers, and pretending otherwise would leave the payment double-explained.
    await expect(
      reclassifyPayment(database.db, {
        paymentId: target.paymentId,
        ai: aiService(),
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses an actor nobody is accountable for', async () => {
    const proposals = await classifiedFixture();
    const target = proposals[0]!;

    await expect(
      reclassifyPayment(database.db, {
        paymentId: target.paymentId,
        ai: aiService(),
        audit: AS_AI,
      }),
    ).rejects.toMatchObject({ code: 'DECISION_ACTOR_INVALID' });
    expect(await inferenceRow(target.inferenceId)).toMatchObject({ status: 'pending' });
  });

  it('leaves everything as it was when the model refuses to answer', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;
    const failing = {
      modelInfo: { provider: 'synthetic', model: 'unreachable' },
      complete: () => Promise.reject(new Error('provider unavailable')),
    };

    await expect(
      reclassifyPayment(database.db, {
        paymentId: target.paymentId,
        ai: createAiService(failing),
        audit: AS_REVIEWER,
      }),
    ).rejects.toThrow('provider unavailable');

    // The old proposal is still the live one: superseding it before knowing there was a
    // replacement would have left this payment with neither.
    expect(await inferenceRow(target.inferenceId)).toMatchObject({ status: 'pending' });
    expect(await expenseState(target.expenseId!)).toBe('classified');
  });

  it('is not what a plain re-run does', async () => {
    const proposals = await classifiedFixture();

    const rerun = await classifyPayments(database.db, {
      ai: aiService(),
      audit: AS_SYSTEM,
    });

    expect(rerun.outcomes.every((outcome) => outcome.outcome === 'skipped')).toBe(true);
    const queue = await listReviewQueue(database.db);
    expect(queue.counts.classification_decision).toBe(proposals.length);
  });
});

describe('confirmPossibleDuplicate', () => {
  it('discards the copy, naming what it duplicates, and keeps the row', async () => {
    const { earlier, later } = await addLookalikePair();

    const result = await confirmPossibleDuplicate(database.db, {
      paymentId: later,
      duplicateOfPaymentId: earlier,
      audit: AS_REVIEWER,
    });

    expect(result).toMatchObject({
      paymentId: later,
      canonicalPaymentId: earlier,
      pairKey: possibleDuplicateKey(earlier, later),
    });
    const [discarded] = await database.db
      .select({
        state: schema.payments.state,
        ignoredReason: schema.payments.ignoredReason,
        amount: schema.payments.amount,
      })
      .from(schema.payments)
      .where(eq(schema.payments.id, later));
    expect(discarded).toMatchObject({ state: 'ignored', amount: 45_000n });
    expect(discarded?.ignoredReason).toBe(`duplicate_of:${earlier}`);
    // The survivor is untouched.
    const [survivor] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.id, earlier));
    expect(survivor?.state).toBe('normalized');
  });

  it('takes the pair out of the queue', async () => {
    const { earlier, later } = await addLookalikePair();
    expect((await listReviewQueue(database.db)).counts.possible_duplicate).toBe(1);

    await confirmPossibleDuplicate(database.db, {
      paymentId: later,
      duplicateOfPaymentId: earlier,
      audit: AS_REVIEWER,
    });

    expect((await listReviewQueue(database.db)).counts.possible_duplicate).toBe(0);
  });

  it('audits the decision as a decision, not as a rule firing', async () => {
    const { earlier, later } = await addLookalikePair();

    await confirmPossibleDuplicate(database.db, {
      paymentId: later,
      duplicateOfPaymentId: earlier,
      audit: AS_REVIEWER,
    });

    const events = await listAuditEvents(database.db, 'payment', later);
    expect(events.at(-1)).toMatchObject({
      action: 'update',
      newValue: {
        state: 'ignored',
        possibleDuplicateDecision: 'confirmed',
        duplicateOfPaymentId: earlier,
      },
      actor: 'user',
    });
    expect(events.at(-1)?.reason).toContain('Confirmed in review');
  });

  it('names the head of the chain, never another discarded copy', async () => {
    const occurredAt = new Date('2026-07-14T00:00:00Z');
    const canonical = await addPayment(database.db, cast, {
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
      occurredAt: new Date('2026-07-14T00:00:30Z'),
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'normalized',
    });
    const third = await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-14T00:01:00Z'),
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'normalized',
    });
    await confirmPossibleDuplicate(database.db, {
      paymentId: second,
      duplicateOfPaymentId: canonical,
      audit: AS_REVIEWER,
    });

    // The reviewer points the third copy at the second, which is itself already discarded.
    const result = await confirmPossibleDuplicate(database.db, {
      paymentId: third,
      duplicateOfPaymentId: second,
      audit: AS_REVIEWER,
    });

    // One hop from any copy reaches the row that counts (invariants.md #10).
    expect(result.canonicalPaymentId).toBe(canonical);
    const [row] = await database.db
      .select({ ignoredReason: schema.payments.ignoredReason })
      .from(schema.payments)
      .where(eq(schema.payments.id, third));
    expect(row?.ignoredReason).toBe(`duplicate_of:${canonical}`);
  });

  it('refuses two payments that are not even a candidate pair', async () => {
    await importedAndNormalizedOnly();
    const blinkit = await paymentIdByDescription('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
    const electricity = await paymentIdByDescription('ELECTRICITY BOARD BBPS BILLPAY');

    // Different amounts: "the reviewer said so" is not evidence that two unrelated payments
    // are the same money.
    await expect(
      confirmPossibleDuplicate(database.db, {
        paymentId: electricity,
        duplicateOfPaymentId: blinkit,
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a pair the deterministic path already settled', async () => {
    await importedAndNormalizedOnly();
    const transfers = await database.db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(eq(schema.payments.externalReference, 'NEFT/N072026001'));

    // Same reference and amount, opposite directions: a transfer's two legs, which ADR-0019
    // made deterministic precisely so they are never treated as one row seen twice.
    await expect(
      confirmPossibleDuplicate(database.db, {
        paymentId: asId<'payment'>(transfers[0]!.id),
        duplicateOfPaymentId: asId<'payment'>(transfers[1]!.id),
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses to discard a payment that is already explained', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;
    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });
    const other = await addPayment(database.db, cast, {
      accountId,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'upi',
      state: 'normalized',
    });

    // `linked → ignored` is not a transition the lifecycle draws: discarding an explained
    // payment would orphan the expense it funds.
    await expect(
      confirmPossibleDuplicate(database.db, {
        paymentId: target.paymentId,
        duplicateOfPaymentId: other,
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('refuses a payment as a duplicate of itself', async () => {
    const { earlier } = await addLookalikePair();

    await expect(
      confirmPossibleDuplicate(database.db, {
        paymentId: earlier,
        duplicateOfPaymentId: earlier,
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses an actor nobody is accountable for', async () => {
    const { earlier, later } = await addLookalikePair();

    await expect(
      confirmPossibleDuplicate(database.db, {
        paymentId: later,
        duplicateOfPaymentId: earlier,
        audit: { actor: 'system', source: 'cron' },
      }),
    ).rejects.toMatchObject({ code: 'DECISION_ACTOR_INVALID' });
    const [row] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.id, later));
    expect(row?.state).toBe('normalized');
  });
});

describe('dismissPossibleDuplicate', () => {
  it('changes nothing about either payment, and takes the pair out of the queue', async () => {
    const { earlier, later } = await addLookalikePair();

    const result = await dismissPossibleDuplicate(database.db, {
      paymentId: later,
      duplicateOfPaymentId: earlier,
      audit: AS_REVIEWER,
    });

    expect(result.pairKey).toBe(possibleDuplicateKey(earlier, later));
    const rows = await database.db
      .select({ id: schema.payments.id, state: schema.payments.state })
      .from(schema.payments);
    // Both are real, and both still count.
    expect(rows.every((row) => row.state === 'normalized')).toBe(true);
    expect((await listReviewQueue(database.db)).counts.possible_duplicate).toBe(0);
  });

  it('records the decision, which is the only thing that changed', async () => {
    const { earlier, later } = await addLookalikePair();

    await dismissPossibleDuplicate(database.db, {
      paymentId: later,
      duplicateOfPaymentId: earlier,
      audit: AS_REVIEWER,
    });

    const events = await listAuditEvents(database.db, 'payment', later);
    expect(events.at(-1)).toMatchObject({
      newValue: {
        state: 'normalized',
        possibleDuplicateDecision: 'dismissed',
        otherPaymentId: earlier,
      },
      actor: 'user',
    });
  });

  it('stays dismissed however the pair is rediscovered', async () => {
    const { earlier, later } = await addLookalikePair();

    // Dismissed one way round; the queue must not offer it the other way round either.
    await dismissPossibleDuplicate(database.db, {
      paymentId: earlier,
      duplicateOfPaymentId: later,
      audit: AS_REVIEWER,
    });

    expect((await listReviewQueue(database.db)).counts.possible_duplicate).toBe(0);
  });

  it('does not dismiss a different pair', async () => {
    const { earlier, later } = await addLookalikePair();
    const third = await addPayment(database.db, cast, {
      accountId,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-14T00:01:00Z'),
      rawDescription: 'UPI-COFFEE-SHOP',
      channel: 'upi',
      state: 'normalized',
    });

    await dismissPossibleDuplicate(database.db, {
      paymentId: later,
      duplicateOfPaymentId: earlier,
      audit: AS_REVIEWER,
    });

    // Three lookalikes make three pairs; dismissing one leaves the other two.
    expect((await listReviewQueue(database.db)).counts.possible_duplicate).toBe(2);
    expect(third).toBeDefined();
  });

  it('refuses an actor nobody is accountable for', async () => {
    const { earlier, later } = await addLookalikePair();

    await expect(
      dismissPossibleDuplicate(database.db, {
        paymentId: later,
        duplicateOfPaymentId: earlier,
        audit: AS_AI,
      }),
    ).rejects.toMatchObject({ code: 'DECISION_ACTOR_INVALID' });
    expect(await listDismissedDuplicatePairs(database.db)).toEqual([]);
  });
});

describe('a rejected proposal reaches no total', () => {
  it('leaves reconciliation exactly where it was before the proposal existed', async () => {
    const proposals = await classifiedFixture();
    const period = {
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
    };
    const before = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...period,
      audit: AS_USER,
    });

    for (const proposal of proposals) {
      await decideInference(database.db, {
        inferenceId: proposal.inferenceId,
        decision: 'reject',
        audit: AS_REVIEWER,
      });
    }

    const after = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...period,
      audit: AS_USER,
    });
    // Five rejected expenses now exist. None of them is spending, and none of them moved a
    // single paisa of any bucket: every ledger_* total enumerates the states it counts,
    // starting at `approved` (invariants.md #20, ADR-0028).
    expect(after.totals).toEqual(before.totals);
    expect(after.totals.ledgerExplainedTotal).toBe(0n);
    expect(await database.db.select().from(schema.expenses)).toHaveLength(4);
  });

  it('does not let a rejected expense be approved afterwards', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;
    await decideInference(database.db, {
      inferenceId: target.inferenceId,
      decision: 'reject',
      audit: AS_REVIEWER,
    });

    // The state machine draws no edge out of `rejected`, so even the service that approves
    // expenses cannot revive one.
    await expect(
      approveExpense(database.db, { expenseId: target.expenseId!, audit: AS_REVIEWER }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});
