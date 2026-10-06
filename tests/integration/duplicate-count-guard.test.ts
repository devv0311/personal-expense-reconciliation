/**
 * One movement must not be counted twice, even when its question is deferred (ADR-0071).
 *
 * The review queue asks whether two payments are one movement. Before this guard, approving
 * either copy removed the question (a counted payment was never a candidate), so a person who
 * chose "Decide later" and approved both copies — or any caller that approved both directly —
 * counted one dinner twice with nothing left to ask. These tests pin the whole behaviour:
 * the question stays while either copy is uncounted, the uncounted copy cannot be counted
 * until it is answered, either answer is honoured, and nothing the matching rule treats as two
 * movements is ever blocked.
 *
 * Every payment is synthetic. The matching rule itself (ADR-0070) is exercised, not changed.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { asId, paise } from '../../src/domain/index.js';
import type { AccountId, PaymentId } from '../../src/domain/index.js';
import { listPendingClassificationInferences, schema } from '../../src/db/index.js';
import {
  classifyPayments,
  confirmPossibleDuplicate,
  createExpense,
  decideInference,
  dismissPossibleDuplicate,
  linkPaymentToExpense,
  listReviewQueue,
  readInstalmentsAndAnomalies,
  recordSettlement,
} from '../../src/services/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, addImportBatch, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const AS_REVIEWER = { actor: 'user', source: 'tests/duplicate-count-guard' } as const;
const AS_SYSTEM = { actor: 'system', source: 'services.classifyPayments' } as const;

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
});

/** One movement as two captures: a bank export and a second file, two batches of their own. */
async function twoCopies(options?: {
  readonly description?: string;
  readonly secondDescription?: string;
  readonly firstReference?: string;
  readonly secondReference?: string;
  readonly referenceType?: string;
}) {
  const description = options?.description ?? 'UPI-QA CAFE DINNER';
  const spec = (batch: Awaited<ReturnType<typeof addImportBatch>>, which: 'first' | 'second') => ({
    accountId,
    amount: paise(300_000n),
    direction: 'debit' as const,
    occurredAt: new Date('2026-08-03T00:00:00Z'),
    rawDescription: which === 'first' ? description : (options?.secondDescription ?? description),
    channel: 'upi' as const,
    state: 'normalized' as const,
    importBatchId: batch,
    ...((which === 'first' ? options?.firstReference : options?.secondReference) === undefined
      ? {}
      : {
          externalReference: (which === 'first'
            ? options?.firstReference
            : options?.secondReference)!,
          referenceType: options?.referenceType ?? 'upi_utr',
        }),
  });
  const first = await addPayment(
    database.db,
    cast,
    spec(await addImportBatch(database.db), 'first'),
  );
  const second = await addPayment(
    database.db,
    cast,
    spec(await addImportBatch(database.db), 'second'),
  );
  return { first, second };
}

/** The pending proposals for every payment, read by the local reader as the real server does. */
async function propose(): Promise<Map<string, string>> {
  await classifyPayments(database.db, {
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    deterministicOnly: true,
    audit: AS_SYSTEM,
  });
  const pending = await listPendingClassificationInferences(database.db);
  return new Map(pending.map((row) => [row.paymentId as string, row.inferenceId as string]));
}

async function approve(inferenceId: string, decision: 'accept' | 'modify' = 'accept') {
  return decideInference(database.db, {
    inferenceId: inferenceId as never,
    decision,
    ...(decision === 'modify'
      ? { modifiedOutput: { proposedKind: 'expense', relationshipType: 'personal' } }
      : {}),
    audit: AS_REVIEWER,
  });
}

async function approvedCount(): Promise<number> {
  const rows = await database.db
    .select({ id: schema.expenses.id })
    .from(schema.expenses)
    .where(eq(schema.expenses.state, 'approved'));
  return rows.length;
}

async function duplicateItems() {
  const queue = await listReviewQueue(database.db);
  return queue.items.filter((item) => item.kind === 'possible_duplicate');
}

describe('a possible duplicate is still asked about once one copy counts', () => {
  it('keeps the pair, with the counted copy as the survivor and the other as the one to discard', async () => {
    const { first, second } = await twoCopies();
    const proposals = await propose();
    await approve(proposals.get(second)!);

    const items = await duplicateItems();
    expect(items).toHaveLength(1);
    const item = items[0]!;
    if (item.kind !== 'possible_duplicate') throw new Error('unreachable');
    // The discardable half is the one that does not count — here the *earlier* copy, which a
    // plain "later one is discarded" reading would have got the wrong way round.
    expect(item.payment.paymentId).toBe(first);
    expect(item.candidate.paymentId).toBe(second);
    expect(item.candidate.counted).toBe(true);
    expect(item.payment.counted).toBe(false);
  });

  it('stops asking when both copies already count, because nothing could be answered yes', async () => {
    // Reachable only from data written before the guard existed; built by hand.
    const { first, second } = await twoCopies();
    for (const id of [first, second]) {
      await database.db
        .update(schema.payments)
        .set({ state: 'linked' })
        .where(eq(schema.payments.id, id));
    }
    expect(await duplicateItems()).toHaveLength(0);
  });
});

describe('the second copy cannot be counted until the question is answered', () => {
  it('refuses to approve it, whatever the screen did — a deferred question, a stale dialog or a direct call', async () => {
    const { first, second } = await twoCopies();
    const proposals = await propose();

    await approve(proposals.get(first)!);
    expect(await approvedCount()).toBe(1);

    for (const decision of ['accept', 'modify'] as const) {
      await expect(approve(proposals.get(second)!, decision)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        details: { reason: 'unresolved_possible_duplicate', resemblesPaymentId: first },
      });
    }
    // Nothing was written: one approved expense, the second payment untouched.
    expect(await approvedCount()).toBe(1);
    const [row] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.id, second));
    expect(row?.state).toBe('normalized');
  });

  it('is order-independent: it does not matter which copy is approved first', async () => {
    const { first, second } = await twoCopies();
    const proposals = await propose();
    await approve(proposals.get(second)!);
    await expect(approve(proposals.get(first)!)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(await approvedCount()).toBe(1);
  });

  it('lets the second copy be counted once a person says they are two real movements', async () => {
    const { first, second } = await twoCopies();
    const proposals = await propose();
    await approve(proposals.get(first)!);

    await dismissPossibleDuplicate(database.db, {
      paymentId: second,
      duplicateOfPaymentId: first,
      audit: AS_REVIEWER,
    });
    expect(await duplicateItems()).toHaveLength(0);

    await approve(proposals.get(second)!);
    expect(await approvedCount()).toBe(2);
  });

  it('lets the person discard the uncounted copy instead, and then nothing can count it', async () => {
    const { first, second } = await twoCopies();
    const proposals = await propose();
    await approve(proposals.get(first)!);

    await confirmPossibleDuplicate(database.db, {
      paymentId: second,
      duplicateOfPaymentId: first,
      audit: AS_REVIEWER,
    });
    const [row] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.id, second));
    expect(row?.state).toBe('ignored');

    await expect(approve(proposals.get(second)!)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      details: { reason: 'discarded_duplicate' },
    });
    expect(await approvedCount()).toBe(1);
  });

  it('never discards the copy that counts', async () => {
    const { first, second } = await twoCopies();
    const proposals = await propose();
    await approve(proposals.get(first)!);

    await expect(
      confirmPossibleDuplicate(database.db, {
        paymentId: first,
        duplicateOfPaymentId: second,
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});

describe('every way of counting a payment is guarded, not only the review decision', () => {
  async function countedByHandEntry(paymentId: PaymentId) {
    return createExpense(database.db, {
      description: 'Dinner',
      amount: paise(300_000n),
      occurredAt: new Date('2026-08-03T00:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
      funding: [{ paymentId, amount: paise(300_000n) }],
      audit: AS_USER,
    });
  }

  it('refuses a hand-entered approved expense funded by the second copy', async () => {
    const { first, second } = await twoCopies();
    await countedByHandEntry(first);

    await expect(countedByHandEntry(second)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      details: { reason: 'unresolved_possible_duplicate' },
    });
  });

  it('treats a payment funding even a proposed expense as already spoken for, in either order', async () => {
    // A hand link leaves the payment's state alone and a proposed expense is not counted yet, but
    // it will be the moment it is approved — so the other copy must wait, not race it.
    const { first, second } = await twoCopies();
    const proposals = await propose();
    await createExpense(database.db, {
      description: 'Dinner (proposed)',
      amount: paise(300_000n),
      occurredAt: new Date('2026-08-03T00:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      funding: [{ paymentId: first, amount: paise(300_000n) }],
      audit: AS_USER,
    });

    await expect(approve(proposals.get(second)!)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    const items = await duplicateItems();
    expect(items).toHaveLength(1);
  });

  it('refuses a funding link added later to an existing expense', async () => {
    const { first, second } = await twoCopies();
    const { expenseId } = await countedByHandEntry(first);

    await expect(
      linkPaymentToExpense(database.db, {
        expenseId,
        paymentId: second,
        amount: paise(300_000n),
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a funding link to a payment that was discarded as a duplicate', async () => {
    const { first, second } = await twoCopies();
    const { expenseId } = await countedByHandEntry(first);
    await confirmPossibleDuplicate(database.db, {
      paymentId: second,
      duplicateOfPaymentId: first,
      audit: AS_REVIEWER,
    });

    await expect(
      linkPaymentToExpense(database.db, {
        expenseId,
        paymentId: second,
        amount: paise(300_000n),
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      details: { reason: 'discarded_duplicate' },
    });
  });

  it('refuses to discard a copy a hand-entered link already counts', async () => {
    const { first, second } = await twoCopies();
    await countedByHandEntry(first);

    // `first` is still `normalized` — the hand link never changed its state — yet it counts.
    await expect(
      confirmPossibleDuplicate(database.db, {
        paymentId: first,
        duplicateOfPaymentId: second,
        audit: AS_REVIEWER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a settlement against the second copy of a repayment', async () => {
    const batchA = await addImportBatch(database.db);
    const batchB = await addImportBatch(database.db);
    const spec = {
      accountId,
      amount: paise(50_000n),
      direction: 'credit' as const,
      occurredAt: new Date('2026-08-06T00:00:00Z'),
      rawDescription: 'UPI-ALEX-REPAYMENT',
      channel: 'upi' as const,
      state: 'normalized' as const,
    };
    const one = await addPayment(database.db, cast, { ...spec, importBatchId: batchA });
    const two = await addPayment(database.db, cast, { ...spec, importBatchId: batchB });
    const alex = cast.person['person_flatmate_a']!;

    await recordSettlement(database.db, {
      paymentId: one,
      counterpartyPersonId: alex,
      amount: paise(50_000n),
      audit: AS_USER,
    });
    await expect(
      recordSettlement(database.db, {
        paymentId: two,
        counterpartyPersonId: alex,
        amount: paise(50_000n),
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('what the matching rule treats as two movements is never blocked', () => {
  it('lets two different lines of one statement both be counted', async () => {
    // Two cafe bills, one statement, one day: ADR-0069. Different lines are two movements.
    const batch = await addImportBatch(database.db);
    const make = (reference: string) =>
      addPayment(database.db, cast, {
        accountId,
        amount: paise(20_000n),
        direction: 'debit',
        occurredAt: new Date('2026-08-04T00:00:00Z'),
        rawDescription: 'UPI-QA CAFE DINNER',
        channel: 'upi' as const,
        state: 'normalized',
        importBatchId: batch,
        externalReference: reference,
        referenceType: 'upi_utr',
      });
    await make('UTR-AAA-1');
    await make('UTR-AAA-2');
    const proposals = await propose();

    for (const inferenceId of proposals.values()) await approve(inferenceId);
    expect(await approvedCount()).toBe(2);
    expect(await duplicateItems()).toHaveLength(0);
  });

  it('lets two captures carrying two different transaction numbers both be counted', async () => {
    // Two UTRs of one kind are two UPI payments by the rule's own account (ADR-0070 step 7).
    const { first, second } = await twoCopies({
      firstReference: '260803000001',
      secondReference: '260803000002',
    });
    expect(first).not.toBe(second);
    const proposals = await propose();

    for (const inferenceId of proposals.values()) await approve(inferenceId);
    expect(await approvedCount()).toBe(2);
  });

  it('lets two payees that are not the same name both be counted', async () => {
    await twoCopies({ description: 'UPI-QA CAFE DINNER', secondDescription: 'UPI-QA TAXI RIDE' });
    const proposals = await propose();

    for (const inferenceId of proposals.values()) await approve(inferenceId);
    expect(await approvedCount()).toBe(2);
  });

  it('lets two payments on two different days both be counted', async () => {
    const batchA = await addImportBatch(database.db);
    const batchB = await addImportBatch(database.db);
    for (const [batch, day] of [
      [batchA, '2026-08-03'],
      [batchB, '2026-08-04'],
    ] as const) {
      await addPayment(database.db, cast, {
        accountId,
        amount: paise(300_000n),
        direction: 'debit',
        occurredAt: new Date(`${day}T00:00:00Z`),
        rawDescription: 'UPI-QA CAFE DINNER',
        channel: 'upi' as const,
        state: 'normalized',
        importBatchId: batch,
      });
    }
    const proposals = await propose();
    for (const inferenceId of proposals.values()) await approve(inferenceId);
    expect(await approvedCount()).toBe(2);
  });
});

describe('the advisory list does not keep a pair a person has resolved', () => {
  it('stops reporting "the same amount, twice" once the copy is confirmed as a duplicate', async () => {
    const { first, second } = await twoCopies();
    const before = await readInstalmentsAndAnomalies(database.db);
    expect(before.anomalies.filter((found) => found.kind === 'repeated_charge')).toHaveLength(1);

    await confirmPossibleDuplicate(database.db, {
      paymentId: second,
      duplicateOfPaymentId: first,
      audit: AS_REVIEWER,
    });

    const after = await readInstalmentsAndAnomalies(database.db);
    expect(after.anomalies.filter((found) => found.kind === 'repeated_charge')).toHaveLength(0);
  });

  it('still reports two real movements a person has said are separate', async () => {
    // Dismissing records two real payments; observing that they look alike stays honest.
    const { first, second } = await twoCopies();
    await dismissPossibleDuplicate(database.db, {
      paymentId: second,
      duplicateOfPaymentId: first,
      audit: AS_REVIEWER,
    });
    const after = await readInstalmentsAndAnomalies(database.db);
    expect(after.anomalies.filter((found) => found.kind === 'repeated_charge')).toHaveLength(1);
  });
});

describe('two decisions at once', () => {
  it('lets exactly one of two simultaneous approvals through', async () => {
    // The guard locks the pair and reads after the lock, so the second approval sees what the
    // first committed. Both are started together; the loser is refused, never both counted.
    const { first, second } = await twoCopies();
    const proposals = await propose();

    const results = await Promise.allSettled([
      approve(proposals.get(first)!),
      approve(proposals.get(second)!),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused).toMatchObject({ reason: { code: 'PRECONDITION_FAILED' } });
    expect(await approvedCount()).toBe(1);
  });
});

// The payment ids in these tests are generated, not named; this keeps the unused import honest.
void asId;
