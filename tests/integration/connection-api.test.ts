/**
 * `GET /api/connections/:paymentId` and `GET /api/attention` — one event, and what it needs.
 *
 * What is worth testing here is not that the reads return fields. It is the handful of product
 * rules that, if any one of them broke, would make the whole surface lie:
 *
 *  - **Several records describing one purchase are one purchase.** Attaching a receipt and a
 *    screenshot to a payment must not make the ledger think three things were bought.
 *  - **A proposal is not a connection.** A recorded candidate stays a question until somebody
 *    answers it, and answering it goes through the existing decision path.
 *  - **A credit-card bill payment is not spending**, and a confirmed duplicate contributes
 *    nothing at all.
 *  - **The payer is not always the user**, and an expense nobody has been named on says so
 *    instead of reporting zeroes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import { asId, paise } from '../../src/domain/index.js';
import type { EvidenceId, ExpenseId, Paise, PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import type { Api } from '../../src/api/index.js';
import { approveAllocation } from '../../src/services/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { addExpense, addPayment, linkPaymentToExpense, seedCast } from '../support/ledger.js';
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

/* -------------------------------------------------------------------------- helpers */

interface ConnectionBody {
  paymentId: string;
  nature: string;
  title: { text: string; source: string };
  fullyAccountedFor: boolean;
  merchantName: string | null;
  narration: string;
  amount: string;
  accountName: string;
  countsAsSpending: boolean;
  whyNotSpending: string | null;
  spendingContribution: string;
  unaccountedFor: { known: boolean; amount: string | null; unknownReason?: string };
  duplicate: { isDuplicate: boolean; ofPaymentId: string | null };
  supportingRecords: {
    evidenceId: string;
    label: string;
    reading: { name: string | null; amount: string | null } | null;
  }[];
  proposals: {
    candidateId: string;
    label: string;
    status: string;
    whyRelated: string[];
    whyUnsure: string[];
  }[];
  expenses: {
    expenseId: string;
    whatItWas: string | null;
    netAmount: string;
    fundedByThisPayment: string;
    paidBy: { name: string; isYou: boolean };
    shares: { name: string; isYou: boolean; amount: string }[] | null;
    sharesUnknownReason: string | null;
  }[];
  settlements: { counterpartyName: string; amount: string; label: string }[];
  openQuestions: { id: string; kind: string; question: string; why: string; facts: unknown[] }[];
  details: Record<string, unknown>;
}

async function connection(paymentId: string): Promise<ConnectionBody> {
  const response = await api.handle(new Request(`${BASE}/api/connections/${paymentId}`));
  expect(response.status).toBe(200);
  return (await response.json()) as ConnectionBody;
}

interface AttentionBody {
  items: {
    id: string;
    source: string;
    kind: string;
    question: string;
    why: string;
    amount: { known: boolean; value: string | null };
    facts: { label: string; kind: string; value: unknown }[];
    subject: { kind: string; [key: string]: unknown };
    item: unknown;
  }[];
  counts: Record<string, number>;
  reviewQueueTotal: number;
  total: number;
  truncated: boolean;
}

async function attention(query = ''): Promise<AttentionBody> {
  const response = await api.handle(new Request(`${BASE}/api/attention${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as AttentionBody;
}

async function addEvidence(input: {
  type: string;
  capturedAt: Date;
  linkedPaymentId?: PaymentId;
  rawText?: string;
  storageRef?: string;
}): Promise<EvidenceId> {
  const [row] = await database.db
    .insert(schema.evidence)
    .values({
      type: input.type,
      capturedAt: input.capturedAt,
      rawText: input.rawText ?? null,
      storageRef: input.storageRef ?? null,
      mediaType: input.storageRef === undefined ? null : 'image/png',
      byteSize: input.storageRef === undefined ? null : 1024,
      linkedPaymentId: input.linkedPaymentId ?? null,
    })
    .returning({ id: schema.evidence.id });
  return asId<'evidence'>(row!.id);
}

async function addObservation(input: {
  evidenceId: EvidenceId;
  amount: Paise;
  merchantText: string;
}): Promise<void> {
  await database.db.insert(schema.evidenceObservations).values({
    evidenceId: input.evidenceId,
    observedAmount: input.amount,
    observedDirection: 'debit',
    observedMerchantText: input.merchantText,
    derivation: 'caller_supplied',
  });
}

async function addCandidate(input: {
  evidenceId: EvidenceId;
  paymentId: PaymentId;
  matched: readonly string[];
  conflicting?: readonly string[];
}): Promise<string> {
  const [row] = await database.db
    .insert(schema.evidenceMatchCandidates)
    .values({
      evidenceId: input.evidenceId,
      paymentId: input.paymentId,
      strength: 'probable',
      confidence: 'medium',
      matchedSignals: [...input.matched],
      conflictingSignals: [...(input.conflicting ?? [])],
      // The full per-signal provenance the matcher records; a `CHECK` requires an array.
      signals: [...input.matched].map((signal) => ({ signal, verdict: 'matched' })),
      reviewReasons: ['link_decision_required'],
      status: 'proposed',
      matcherVersion: 'evidence-match/1',
    })
    .returning({ id: schema.evidenceMatchCandidates.id });
  return row!.id;
}

/** A purchase somebody actually made: a statement line, an approved expense, a funding link. */
async function seedPurchase(options: {
  amount: Paise;
  description: string;
  paidByPersonId?: string;
}): Promise<{ paymentId: PaymentId; expenseId: ExpenseId }> {
  const paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: options.amount,
    direction: 'debit',
    occurredAt: new Date('2026-07-02T10:00:00.000Z'),
    rawDescription: options.description,
    channel: 'upi',
  });
  const expenseId = await addExpense(database.db, {
    description: 'Dinner',
    amount: options.amount,
    occurredAt: new Date('2026-07-02T10:00:00.000Z'),
    relationshipType: 'shared',
    paidByPersonId: asId<'person'>(options.paidByPersonId ?? cast.userPersonId),
  });
  await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: options.amount });
  return { paymentId, expenseId };
}

/* ---------------------------------------------------------------------------- tests */

describe('one event, however many records describe it', () => {
  it('shows a statement line, its receipt and its screenshot as one purchase', async () => {
    const { paymentId } = await seedPurchase({
      amount: paise(124000n),
      description: 'UPI-SAMPLE MERCHANT',
    });

    const receipt = await addEvidence({
      type: 'receipt_image',
      capturedAt: new Date('2026-07-02T10:05:00.000Z'),
      linkedPaymentId: paymentId,
      storageRef: 'sha256/aa.png',
    });
    await addObservation({
      evidenceId: receipt,
      amount: paise(124000n),
      merchantText: 'Sample Cafe',
    });
    const screenshot = await addEvidence({
      type: 'screenshot',
      capturedAt: new Date('2026-07-02T10:06:00.000Z'),
      linkedPaymentId: paymentId,
      storageRef: 'sha256/bb.png',
    });
    await addObservation({
      evidenceId: screenshot,
      amount: paise(124000n),
      merchantText: 'Sample Cafe',
    });

    const body = await connection(paymentId);

    // Three records, one event, one spending figure — the whole point of the surface.
    expect(body.supportingRecords).toHaveLength(2);
    expect(body.supportingRecords.map((record) => record.label).sort()).toEqual([
      'Bill or receipt',
      'Screenshot',
    ]);
    expect(body.expenses).toHaveLength(1);
    expect(body.countsAsSpending).toBe(true);
    expect(body.spendingContribution).toBe('124000');
    expect(body.amount).toBe('124000');
    // The name the records supply, where the bank's narration says nothing useful.
    expect(body.merchantName).toBe('Sample Cafe');
    // And the narration is still there, verbatim, for the details disclosure.
    expect(body.narration).toBe('UPI-SAMPLE MERCHANT');
  });

  it('does not let a second supporting record change what was spent', async () => {
    const { paymentId } = await seedPurchase({
      amount: paise(50000n),
      description: 'UPI-SAMPLE MERCHANT',
    });
    const before = await connection(paymentId);

    await addEvidence({
      type: 'receipt_image',
      capturedAt: new Date('2026-07-02T11:00:00.000Z'),
      linkedPaymentId: paymentId,
      storageRef: 'sha256/cc.png',
    });
    const after = await connection(paymentId);

    expect(after.spendingContribution).toBe(before.spendingContribution);
    expect(after.expenses).toHaveLength(before.expenses.length);
    expect(after.supportingRecords.length).toBe(before.supportingRecords.length + 1);
  });
});

describe('the name this event has', () => {
  it('falls back to the expense description before the bank narration', async () => {
    const { paymentId } = await seedPurchase({
      amount: paise(60000n),
      description: 'UPI-XXYYZZ-9821',
    });

    const body = await connection(paymentId);
    // Nobody recorded a counterparty and no record names one, but the expense says what it was.
    expect(body.title.source).toBe('expense');
    expect(body.title.text).toBe('Dinner');
  });

  it('says a bank narration is a bank narration when nothing better exists', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(60000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-XXYYZZ-9821',
      channel: 'upi',
    });

    const body = await connection(paymentId);
    expect(body.title.source).toBe('narration');
    expect(body.title.text).toBe('UPI-XXYYZZ-9821');
    expect(body.fullyAccountedFor).toBe(false);
  });

  it('decides "fully accounted for" itself rather than leaving a zero to be read', async () => {
    const { paymentId } = await seedPurchase({
      amount: paise(60000n),
      description: 'UPI-SAMPLE MERCHANT',
    });

    const body = await connection(paymentId);
    expect(body.unaccountedFor.amount).toBe('0');
    expect(body.fullyAccountedFor).toBe(true);
  });
});

describe('a proposal is a question, not a connection', () => {
  it('keeps an offered match unconfirmed and says why it looks related', async () => {
    const { paymentId } = await seedPurchase({
      amount: paise(80000n),
      description: 'UPI-SAMPLE MERCHANT',
    });
    const receipt = await addEvidence({
      type: 'receipt_image',
      capturedAt: new Date('2026-07-02T10:05:00.000Z'),
      storageRef: 'sha256/dd.png',
    });
    await addCandidate({
      evidenceId: receipt,
      paymentId,
      matched: ['amount', 'time'],
      conflicting: ['merchant'],
    });

    const body = await connection(paymentId);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]?.status).toBe('proposed');
    expect(body.proposals[0]?.whyRelated).toEqual([
      'The amount is the same.',
      'They happened at about the same time.',
    ]);
    // A disagreeing signal is shown, never used to hide the offer.
    expect(body.proposals[0]?.whyUnsure).toEqual(['The name on it is a different one.']);
    // The document is still attached to nothing, so it is still a question.
    expect(body.supportingRecords).toHaveLength(0);
  });

  it('asks which payment a document is about when more than one could be', async () => {
    const first = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(80000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-ONE',
      channel: 'upi',
    });
    const second = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(80000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T12:00:00.000Z'),
      rawDescription: 'UPI-TWO',
      channel: 'upi',
    });
    const receipt = await addEvidence({
      type: 'receipt_image',
      capturedAt: new Date('2026-07-02T13:00:00.000Z'),
      storageRef: 'sha256/ee.png',
    });
    await addCandidate({ evidenceId: receipt, paymentId: first, matched: ['amount'] });
    await addCandidate({ evidenceId: receipt, paymentId: second, matched: ['amount'] });

    const queue = await attention();
    const document = queue.items.find((item) => item.kind === 'unmatched_evidence');
    expect(document?.question).toBe('Which payment is this document about?');
    expect(document?.subject.kind).toBe('evidence');
    // The full queue item travels with it, so the existing inspector answers it unchanged.
    expect(document?.item).not.toBeNull();

    // And the question surfaces on each candidate payment's own event.
    const onFirst = await connection(first);
    expect(onFirst.openQuestions.some((question) => question.kind === 'unmatched_evidence')).toBe(
      true,
    );
  });

  it('becomes a connection only through the existing decision path', async () => {
    const { paymentId } = await seedPurchase({
      amount: paise(80000n),
      description: 'UPI-SAMPLE MERCHANT',
    });
    const receipt = await addEvidence({
      type: 'receipt_image',
      capturedAt: new Date('2026-07-02T10:05:00.000Z'),
      storageRef: 'sha256/ff.png',
    });
    const candidateId = await addCandidate({
      evidenceId: receipt,
      paymentId,
      matched: ['amount', 'time'],
    });

    const accepted = await api.handle(
      new Request(`${BASE}/api/evidence/matches/${candidateId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'accept', actor: 'user' }),
      }),
    );
    expect(accepted.status).toBe(200);

    const after = await connection(paymentId);
    expect(after.supportingRecords).toHaveLength(1);
    expect(after.proposals[0]?.status).toBe('accepted');
    // Confirming a connection changed nothing about the money.
    expect(after.spendingContribution).toBe('80000');
  });
});

describe('what a movement is, in plain words', () => {
  it('never presents a transfer between your own accounts as spending', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(2500000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-05T10:00:00.000Z'),
      rawDescription: 'CARD BILL PAYMENT',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
      counterpartyId: cast.account['account_icici_credit_card'] ?? null,
    });

    const body = await connection(paymentId);
    expect(body.nature).toBe('transfer');
    expect(body.countsAsSpending).toBe(false);
    expect(body.spendingContribution).toBe('0');
    expect(body.whyNotSpending).toContain('between your own accounts');
    expect(body.expenses).toHaveLength(0);
  });

  it('never reports a confirmed duplicate as spending or as money gone missing', async () => {
    const original = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-SAMPLE MERCHANT',
      channel: 'upi',
    });
    const copy = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-SAMPLE MERCHANT',
      channel: 'upi',
      state: 'ignored',
      ignoredReason: `duplicate_of:${original}`,
    });

    const body = await connection(copy);
    expect(body.nature).toBe('duplicate');
    expect(body.duplicate.isDuplicate).toBe(true);
    expect(body.duplicate.ofPaymentId).toBe(original);
    expect(body.countsAsSpending).toBe(false);
    expect(body.spendingContribution).toBe('0');
    // Not "₹0 unaccounted for", which would read as verified. There is nothing to account for.
    expect(body.unaccountedFor.known).toBe(false);
    expect(body.unaccountedFor.unknownReason).toContain('same money as another record');
  });

  it('says a payment nothing explains is not yet known, and asks what it was for', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-SAMPLE MERCHANT',
      channel: 'upi',
    });

    const body = await connection(paymentId);
    expect(body.nature).toBe('not_yet_known');
    expect(body.unaccountedFor.known).toBe(true);
    expect(body.unaccountedFor.amount).toBe('124000');
    const asked = body.openQuestions.find((question) => question.kind === 'payment_unaccounted');
    expect(asked?.question).toBe('What was this payment for?');
    expect(asked?.facts.length).toBeGreaterThan(0);
  });

  it('leaves an unclassified credit unexplained rather than calling it income', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(500000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-06T10:00:00.000Z'),
      rawDescription: 'NEFT CR',
      channel: 'bank_transfer',
    });

    const body = await connection(paymentId);
    expect(body.nature).toBe('not_yet_known');
    expect(body.countsAsSpending).toBe(false);
  });
});

describe('who paid, and who shared', () => {
  it('names somebody other than the user as the payer', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    const { paymentId, expenseId } = await seedPurchase({
      amount: paise(60000n),
      description: 'UPI-SAMPLE MERCHANT',
      paidByPersonId: flatmate,
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: flatmate },
          { type: 'person', id: cast.userPersonId },
        ],
      },
      decidedBy: 'manual',
      audit: { actor: 'user', source: 'tests/integration/connection-api' },
    });

    const body = await connection(paymentId);
    const expense = body.expenses[0]!;
    expect(expense.paidBy.isYou).toBe(false);
    expect(expense.paidBy.name.length).toBeGreaterThan(0);
    expect(expense.shares).not.toBeNull();
    expect(expense.shares).toHaveLength(2);
    expect(expense.shares?.some((share) => share.isYou)).toBe(true);
    expect(expense.shares?.map((share) => share.amount).sort()).toEqual(['30000', '30000']);
  });

  it('says nobody has been named yet instead of reporting zero shares', async () => {
    const { paymentId } = await seedPurchase({
      amount: paise(60000n),
      description: 'UPI-SAMPLE MERCHANT',
    });

    const body = await connection(paymentId);
    const expense = body.expenses[0]!;
    // `null`, not `[]` — an empty list of shares reads as "nobody owes anything".
    expect(expense.shares).toBeNull();
    expect(expense.sharesUnknownReason).toContain('Nobody has been named');
  });

  it('asks who shared an approved expense nobody is named on', async () => {
    await seedPurchase({ amount: paise(60000n), description: 'UPI-SAMPLE MERCHANT' });

    const queue = await attention();
    const asked = queue.items.find((item) => item.kind === 'allocation_missing');
    expect(asked?.question).toBe('Who shared this expense?');
    expect(asked?.source).toBe('ledger');
    expect(asked?.subject.kind).toBe('expense');
    // It is not a review-queue row, so the queue's own total is untouched.
    expect(queue.reviewQueueTotal).toBe(queue.counts['classification_decision']! + 0);
  });
});

describe('what needs a person', () => {
  it('reports the same queue totals /api/review does', async () => {
    const queue = await attention();
    const review = (await (await api.handle(new Request(`${BASE}/api/review?limit=1`))).json()) as {
      total: number;
      counts: Record<string, number>;
    };
    expect(queue.reviewQueueTotal).toBe(review.total);
    expect(queue.counts).toEqual(review.counts);
  });

  it('says an unread document has no known amount rather than showing ₹0', async () => {
    const receipt = await addEvidence({
      type: 'receipt_image',
      capturedAt: new Date('2026-07-02T13:00:00.000Z'),
      storageRef: 'sha256/gg.png',
    });
    expect(receipt).toBeTruthy();

    const queue = await attention();
    const document = queue.items.find((item) => item.kind === 'unmatched_evidence');
    expect(document?.amount.known).toBe(false);
    expect(document?.amount.value).toBeNull();
    const total = document?.facts.find((fact) => fact.label === 'Total on it');
    expect(total?.kind).toBe('unknown');
    expect(total?.value).toBeNull();
  });

  it('carries only the facts needed to decide, never the model or the stored proposal', async () => {
    const receipt = await addEvidence({
      type: 'screenshot',
      capturedAt: new Date('2026-07-02T13:00:00.000Z'),
      storageRef: 'sha256/hh.png',
    });
    expect(receipt).toBeTruthy();

    const queue = await attention();
    const document = queue.items.find((item) => item.kind === 'unmatched_evidence')!;
    expect(document.facts.map((fact) => fact.label)).toEqual([
      'Kind of record',
      'Total on it',
      'Added',
      'Payments it could be about',
    ]);
    expect(document.facts[0]?.value).toBe('Screenshot');
    expect(JSON.stringify(document.facts)).not.toMatch(/promptVersion|confidence|matcherVersion/);
  });

  it('refuses a kind it does not know rather than silently returning everything', async () => {
    const response = await api.handle(new Request(`${BASE}/api/attention?kinds=not_a_kind`));
    expect(response.status).toBe(400);
  });
});

describe('how much is waiting', () => {
  it('counts every question it can see, not only the ones it fetched', async () => {
    // More unallocated expenses than one ledger page carries. A total that stopped at the page
    // would make the nav badge and the front page quietly understate what is waiting — a
    // smaller number that looks like a finished count.
    for (let index = 0; index < 30; index += 1) {
      await addExpense(database.db, {
        description: `Something shared ${index}`,
        amount: paise(10000n),
        occurredAt: new Date('2026-07-02T10:00:00.000Z'),
        relationshipType: 'shared',
        paidByPersonId: cast.userPersonId,
      });
    }

    const body = await attention('?limit=10');

    expect(body.items).toHaveLength(10);
    expect(body.total).toBeGreaterThanOrEqual(30);
    expect(body.truncated).toBe(true);
  });

  it('finds a question about one event even past a page of them', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(10000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-01T10:00:00.000Z'),
      rawDescription: 'UPI-OLD-EXPENSE',
      channel: 'upi',
    });
    // The list is newest first, so thirty later ones push this event's question past a page.
    for (let index = 0; index < 30; index += 1) {
      await addExpense(database.db, {
        description: `Something shared ${index}`,
        amount: paise(10000n),
        occurredAt: new Date('2026-07-30T10:00:00.000Z'),
        relationshipType: 'shared',
        paidByPersonId: cast.userPersonId,
      });
    }
    const expenseId = await addExpense(database.db, {
      description: 'The one this payment funded',
      amount: paise(10000n),
      occurredAt: new Date('2026-07-01T10:00:00.000Z'),
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: paise(10000n) });

    const event = await connection(paymentId);

    expect(event.openQuestions.some((question) => question.kind === 'allocation_missing')).toBe(
      true,
    );
  });
});

describe('the details a person does not have to read', () => {
  it('keeps the stored states out of the summary and behind Details', async () => {
    const { paymentId } = await seedPurchase({
      amount: paise(60000n),
      description: 'UPI-SAMPLE MERCHANT',
    });

    const body = await connection(paymentId);
    // The technical vocabulary exists, in exactly one place, under a key named for what it is.
    expect(body.details['cashFlowState']).toBeDefined();
    expect(body.details['counterpartyType']).toBeDefined();
    expect(body.details['importBatchId']).toBeDefined();
    // And nowhere else in the plain part of the response.
    const summary = { ...body } as Record<string, unknown>;
    delete summary['details'];
    delete summary['openQuestions'];
    expect(JSON.stringify(summary)).not.toMatch(/cashFlowState|importBatchId|matcherVersion/);
  });

  it('404s for a payment that does not exist', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/connections/00000000-0000-4000-8000-000000000000`),
    );
    expect(response.status).toBe(404);
  });

  it('400s for an id that is not a payment id at all', async () => {
    const response = await api.handle(new Request(`${BASE}/api/connections/not-a-uuid`));
    expect(response.status).toBe(400);
  });
});

describe('money that came back, and debts that were settled', () => {
  it('shows a settlement as what it did, not as a purchase', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(30000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-08T10:00:00.000Z'),
      rawDescription: 'UPI-SETTLE',
      channel: 'upi',
    });
    await database.db.insert(schema.settlements).values({
      paymentId,
      counterpartyPersonId: flatmate,
      amount: paise(30000n),
      reason: 'Split from dinner',
    });

    const body = await connection(paymentId);
    expect(body.nature).toBe('settlement');
    expect(body.countsAsSpending).toBe(false);
    expect(body.settlements).toHaveLength(1);
    expect(body.settlements[0]?.label).toContain('You paid');
    expect(body.whyNotSpending).toContain('settled up');
  });

  it('reads a counterparty name back rather than an id', async () => {
    const flatmate = cast.person['person_flatmate_a']!;
    const [person] = await database.db
      .select({ displayName: schema.people.displayName })
      .from(schema.people)
      .where(eq(schema.people.id, flatmate));

    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(30000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-08T10:00:00.000Z'),
      rawDescription: 'UPI-SETTLE',
      channel: 'upi',
    });
    await database.db.insert(schema.settlements).values({
      paymentId,
      counterpartyPersonId: flatmate,
      amount: paise(30000n),
      reason: null,
    });

    const body = await connection(paymentId);
    expect(body.settlements[0]?.counterpartyName).toBe(person!.displayName);
  });
});
