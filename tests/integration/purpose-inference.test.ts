/**
 * Reading a statement line's purpose, on an installation with no model configured.
 *
 * This is how the product actually ships, and before the local reader existed every row on an
 * imported statement came back `no_model_configured`: nothing to confirm, and an Overview
 * reporting nothing spent over a statement it had read.
 *
 * The rows below are shaped like the ones a real Indian credit-card statement carries, because
 * that is where the damage would be done: a bare `CGST`, an `INTEREST` line naming the shop
 * beside it, a `PRINCIPAL` repayment of a purchase already recorded. A reader that categorised
 * those would inflate what somebody spent and attribute it to a merchant they did not pay.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { asId, paise } from '../../src/domain/index.js';
import type { PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import {
  analyzeRecords,
  classifyPayments,
  decideInference,
  listAttentionQuestions,
  listReviewQueue,
  normalizePayments,
} from '../../src/services/index.js';
import { unconfiguredTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const AS_USER = { actor: 'user:dev', source: 'test' } as const;
/** The installation this product ships as: every adapter present, no provider configured. */
const NO_MODEL = createAiService(unconfiguredTransport());

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

/** A statement row, exactly as the importer would have written it. */
async function statementRow(
  rawDescription: string,
  options: { amount?: bigint; direction?: 'debit' | 'credit'; day?: number } = {},
): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(options.amount ?? 250_000n),
    direction: options.direction ?? 'debit',
    occurredAt: new Date(Date.UTC(2026, 7, options.day ?? 8)),
    rawDescription,
    channel: 'card',
    state: 'imported',
  });
}

/** What a person pressing **Analyze records** does, on a ledger with no model. */
async function analyse() {
  await normalizePayments(database.db, { audit: AS_USER });
  return analyzeRecords(database.db, { ai: NO_MODEL, audit: AS_USER });
}

async function questionAbout(paymentId: PaymentId) {
  const result = await listAttentionQuestions(database.db, { limit: 'all' });
  return result.items.find(
    (item) => item.subject.kind === 'payment' && item.subject.paymentId === paymentId,
  );
}

/* ================================================== it suggests something useful */

describe('a statement line with nothing but its own description', () => {
  it('is proposed a category a person can confirm, with a plain reason', async () => {
    const paymentId = await statementRow('Q SYN FITNESS');
    await analyse();

    const question = await questionAbout(paymentId);
    expect(question?.question).toBe('What was this payment for?');
    expect(question?.suggestion?.category).toBe('Gym & fitness');
    expect(question?.suggestion?.confidence).toBe('medium');
    expect(question?.suggestion?.why.join(' ')).toMatch(/usually means a gym/i);
    // Never the words the machinery uses.
    const wording = `${question?.question} ${question?.why} ${question?.suggestion?.why.join(' ')}`;
    expect(wording).not.toMatch(/classif|inference|model|lexicon|token|confidence score/i);
  });

  it('offers alternatives and the full list, so "something else" is always reachable', async () => {
    const paymentId = await statementRow('FARM FRESH KITCHEN');
    await analyse();

    const suggestion = (await questionAbout(paymentId))?.suggestion;
    expect(suggestion?.alternatives.length).toBeGreaterThan(0);
    expect(suggestion?.everyCategory).toContain('Other');
    expect(suggestion?.everyCategory).toContain('Gym & fitness');
    for (const alternative of suggestion?.alternatives ?? []) {
      expect(alternative.why.length).toBeGreaterThan(0);
    }
  });

  it('grows more confident as the same place recurs', async () => {
    await statementRow('Q SYN FITNESS', { day: 8 });
    await statementRow('Q SYN FITNESS', { day: 9 });
    const third = await statementRow('Q SYN FITNESS', { day: 10 });
    await analyse();

    expect((await questionAbout(third))?.suggestion?.confidence).toBe('high');
  });

  it('says it has nothing to go on rather than guessing', async () => {
    const paymentId = await statementRow('QX7719 ZZ 4410');
    await analyse();

    const queue = await listReviewQueue(database.db, {});
    expect(
      queue.items.some(
        (item) => item.kind === 'classification_decision' && item.payment.paymentId === paymentId,
      ),
    ).toBe(false);
  });
});

/* ================================================== it refuses to inflate spending */

describe('the rows a card statement is mostly made of', () => {
  it('proposes nothing at all for a bare tax line, and says why', async () => {
    const paymentId = await statementRow('CGST', { amount: 4_500n });
    await normalizePayments(database.db, { audit: AS_USER });
    const result = await classifyPayments(database.db, {
      ai: NO_MODEL,
      deterministicOnly: true,
      audit: AS_USER,
    });

    const outcome = result.outcomes.find((entry) => entry.paymentId === paymentId);
    expect(outcome).toMatchObject({ outcome: 'skipped', reason: 'not_a_purchase_of_its_own' });
    expect(await questionAbout(paymentId)).toBeUndefined();
  });

  it('proposes nothing for an instalment repayment of a purchase already on record', async () => {
    const paymentId = await statementRow('Q SYN FITNESS - PRINCIPAL 2 - <2/6>');
    await analyse();

    expect(await questionAbout(paymentId)).toBeUndefined();
  });

  it('never files instalment interest under the shop named beside it', async () => {
    const paymentId = await statementRow('Q SYN FITNESS - INTEREST 2 - <2/6>', { amount: 31_200n });
    await analyse();

    const suggestion = (await questionAbout(paymentId))?.suggestion;
    expect(suggestion?.category).toBe('Bills & subscriptions');
    expect(suggestion?.category).not.toBe('Gym & fitness');
    expect(suggestion?.countsAsPurchase).toBe(false);
    expect(suggestion?.why.join(' ')).toMatch(/interest is what the card charged you/i);
  });

  it('never proposes an expense for a credit', async () => {
    const paymentId = await statementRow('4821 CARD PAYMENT RECEIVED', {
      direction: 'credit',
      amount: 1_200_000n,
    });
    await analyse();

    expect(await questionAbout(paymentId)).toBeUndefined();
  });
});

/* ================================================== confirming, correcting, repeating */

describe('confirming a suggestion', () => {
  it('writes the category onto an approved expense in the ledger', async () => {
    const paymentId = await statementRow('Q SYN FITNESS');
    await analyse();
    const question = await questionAbout(paymentId);
    const inferenceId = question!.suggestion!.inferenceId!;

    await decideInference(database.db, {
      inferenceId: asId<'ai_inference'>(inferenceId),
      decision: 'accept',
      audit: AS_USER,
    });

    const [expense] = await database.db.select().from(schema.expenses);
    expect(expense?.category).toBe('Gym & fitness');
    expect(expense?.state).toBe('approved');
    // The question is answered, not merely hidden.
    expect(await questionAbout(paymentId)).toBeUndefined();
  });

  it('records the category a person chose instead, when they choose one', async () => {
    const paymentId = await statementRow('Q SYN FITNESS');
    await analyse();
    const inferenceId = (await questionAbout(paymentId))!.suggestion!.inferenceId!;

    await decideInference(database.db, {
      inferenceId: asId<'ai_inference'>(inferenceId),
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'personal',
        category: 'Health',
        paidByPersonHint: null,
      },
      audit: AS_USER,
    });

    const [expense] = await database.db.select().from(schema.expenses);
    expect(expense?.category).toBe('Health');
  });

  it('recognises the next payment to the same place by what was confirmed, not by a word', async () => {
    const first = await statementRow('Q SYN FITNESS', { day: 8 });
    await analyse();
    await decideInference(database.db, {
      inferenceId: asId<'ai_inference'>((await questionAbout(first))!.suggestion!.inferenceId!),
      decision: 'modify',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'personal',
        category: 'Health',
        paidByPersonHint: null,
      },
      audit: AS_USER,
    });

    const second = await statementRow('Q SYN FITNESS', { day: 40 });
    await analyse();

    const suggestion = (await questionAbout(second))?.suggestion;
    expect(suggestion?.category).toBe('Health');
    expect(suggestion?.why.join(' ')).toMatch(/you filed an earlier payment to the same place/i);
  });

  it('does not replace the answered question with a new one about who shared it', async () => {
    const paymentId = await statementRow('Q SYN FITNESS');
    await analyse();
    const before = await listAttentionQuestions(database.db, { limit: 'all' });

    await decideInference(database.db, {
      inferenceId: asId<'ai_inference'>((await questionAbout(paymentId))!.suggestion!.inferenceId!),
      decision: 'accept',
      audit: AS_USER,
    });

    // A statement line says what left an account and nothing about who else benefited, so the
    // expense is `personal` — which creates no obligation, and therefore raises no question
    // about who shared it. Answering one question must not silently produce another.
    const after = await listAttentionQuestions(database.db, { limit: 'all' });
    expect(after.total).toBe(before.total - 1);
    expect(after.items.some((item) => item.kind === 'allocation_missing')).toBe(false);
  });

  it('adds nothing on a second run over an unchanged ledger', async () => {
    await statementRow('Q SYN FITNESS');
    await analyse();
    const first = await listReviewQueue(database.db, {});

    await analyse();
    const second = await listReviewQueue(database.db, {});

    expect(second.total).toBe(first.total);
    const inferences = await database.db.select().from(schema.aiInferences);
    expect(inferences).toHaveLength(1);
  });

  it('records that no model was involved, rather than implying one was', async () => {
    await statementRow('Q SYN FITNESS');
    await analyse();

    const [inference] = await database.db.select().from(schema.aiInferences);
    expect(inference?.modelProvider).toBe('local');
    expect(inference?.status).toBe('pending');
  });
});
