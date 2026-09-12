/**
 * The two correction paths the audit found missing (rows 13 and 23, ADR-0052).
 *
 * Both close the same gap in the same way: an immutable record that turned out to be wrong
 * gets a **successor**, never an edit. What each test is really asserting is that the wrong
 * record survives — a ledger that quietly deleted its mistakes would pass every arithmetic
 * check and still be unable to answer "why did it once say that?".
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { listAuditEvents, schema } from '../../src/db/index.js';
import { asId, paise } from '../../src/domain/index.js';
import type { AccountId, ExpenseId, PaymentId } from '../../src/domain/index.js';
import {
  approveAllocation,
  distributeAdjustment,
  getRefundAllocationState,
  ingestEvidenceDocument,
  linkEvidence,
  listExpenseAdjustments,
  listExpenses,
  recordEvidenceObservation,
  recordExpenseAdjustment,
  reverseExpenseAdjustment,
  supersedeEvidence,
} from '../../src/services/index.js';
import { captureError, createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore, syntheticDocument } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { addExpense, addExpenseItem, addPayment, AS_USER, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

let database: TestDatabase;
let store: MemoryEvidenceStore;
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
  store = createMemoryEvidenceStore();
  cast = await seedCast(database.db);
  accountId = cast.account['account_hdfc_savings']!;
});

async function aPayment(description: string): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId,
    amount: paise(124000n),
    direction: 'debit',
    occurredAt: new Date('2026-07-01T00:00:00.000Z'),
    rawDescription: description,
    channel: 'upi',
  });
}

describe('superseding evidence whose link was wrong (audit row 13)', () => {
  async function anAttachedReceipt(paymentId: PaymentId) {
    const { evidenceId } = await ingestEvidenceDocument(database.db, {
      type: 'receipt_image',
      bytes: syntheticDocument('a-receipt'),
      mediaType: 'image/jpeg',
      capturedAt: new Date('2026-07-01T19:25:00.000Z'),
      store,
      audit: AS_USER,
    });
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_USER });
    return evidenceId;
  }

  it('writes a corrected record and leaves the original exactly as it was', async () => {
    const wrongPayment = await aPayment('WRONG PAYMENT');
    const rightPayment = await aPayment('RIGHT PAYMENT');
    const evidenceId = await anAttachedReceipt(wrongPayment);

    const result = await supersedeEvidence(database.db, {
      evidenceId,
      linkedPaymentId: rightPayment,
      reason: 'Attached to the Blinkit debit; it is the receipt for the Zomato one.',
      audit: AS_USER,
    });

    const [original] = await database.db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.id, evidenceId));
    // Untouched apart from the stamp: the wrong link is still on the record, which is what
    // makes "why did this ledger once believe that?" answerable.
    expect(original?.linkedPaymentId).toBe(wrongPayment);
    expect(original?.supersededByEvidenceId).toBe(result.evidenceId);
    expect(original?.supersedeReason).toContain('Zomato');

    const [replacement] = await database.db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.id, result.evidenceId));
    expect(replacement?.linkedPaymentId).toBe(rightPayment);
    // The same document, by content address — the bytes really are the same bytes.
    expect(replacement?.storageRef).toBe(original?.storageRef);
    expect(replacement?.capturedAt).toEqual(original?.capturedAt);
    expect(replacement?.supersededByEvidenceId).toBeNull();
  });

  it('detaches a record that belongs nowhere yet', async () => {
    const wrongPayment = await aPayment('WRONG PAYMENT');
    const evidenceId = await anAttachedReceipt(wrongPayment);

    const result = await supersedeEvidence(database.db, {
      evidenceId,
      linkedPaymentId: null,
      reason: 'This is not the receipt for that payment and I do not yet know what it is for.',
      audit: AS_USER,
    });

    const [replacement] = await database.db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.id, result.evidenceId));
    expect(replacement?.linkedPaymentId).toBeNull();
  });

  it('carries the structured reading across, so a human correction is not lost', async () => {
    const wrongPayment = await aPayment('WRONG PAYMENT');
    const rightPayment = await aPayment('RIGHT PAYMENT');
    const evidenceId = await anAttachedReceipt(wrongPayment);
    await recordEvidenceObservation(database.db, {
      evidenceId,
      observedAmount: paise(124000n),
      observedDirection: 'debit',
      observedReference: 'UPI/2607011234/BLINKIT',
      audit: AS_USER,
    });

    const result = await supersedeEvidence(database.db, {
      evidenceId,
      linkedPaymentId: rightPayment,
      reason: 'wrong payment',
      audit: AS_USER,
    });
    expect(result.observationCopied).toBe(true);

    const [observation] = await database.db
      .select()
      .from(schema.evidenceObservations)
      .where(eq(schema.evidenceObservations.evidenceId, result.evidenceId));
    expect(observation?.observedAmount).toBe(124000n);
    expect(observation?.observedReference).toBe('UPI/2607011234/BLINKIT');
  });

  it('records the supersession in the audit log, on both rows', async () => {
    const wrongPayment = await aPayment('WRONG PAYMENT');
    const rightPayment = await aPayment('RIGHT PAYMENT');
    const evidenceId = await anAttachedReceipt(wrongPayment);
    const result = await supersedeEvidence(database.db, {
      evidenceId,
      linkedPaymentId: rightPayment,
      reason: 'wrong payment',
      audit: AS_USER,
    });

    const originalEvents = await listAuditEvents(database.db, 'evidence', evidenceId);
    expect(originalEvents.some((event) => event.action === 'supersede')).toBe(true);
    const replacementEvents = await listAuditEvents(database.db, 'evidence', result.evidenceId);
    expect(replacementEvents.some((event) => event.action === 'create')).toBe(true);
  });

  it('refuses a blank reason', async () => {
    const wrongPayment = await aPayment('WRONG PAYMENT');
    const rightPayment = await aPayment('RIGHT PAYMENT');
    const evidenceId = await anAttachedReceipt(wrongPayment);
    const error = await captureError(() =>
      supersedeEvidence(database.db, {
        evidenceId,
        linkedPaymentId: rightPayment,
        reason: '   ',
        audit: AS_USER,
      }),
    );
    expect(error.message).toContain('records why the original was wrong');
  });

  it('refuses a supersession that would change nothing', async () => {
    const wrongPayment = await aPayment('WRONG PAYMENT');
    const evidenceId = await anAttachedReceipt(wrongPayment);
    const error = await captureError(() =>
      supersedeEvidence(database.db, {
        evidenceId,
        linkedPaymentId: wrongPayment,
        reason: 'no change',
        audit: AS_USER,
      }),
    );
    expect(error.message).toContain('nothing to correct');
  });

  it('refuses to supersede a record that already has a successor', async () => {
    const wrongPayment = await aPayment('WRONG PAYMENT');
    const rightPayment = await aPayment('RIGHT PAYMENT');
    const evidenceId = await anAttachedReceipt(wrongPayment);
    await supersedeEvidence(database.db, {
      evidenceId,
      linkedPaymentId: rightPayment,
      reason: 'first correction',
      audit: AS_USER,
    });

    const error = await captureError(() =>
      supersedeEvidence(database.db, {
        evidenceId,
        linkedPaymentId: null,
        reason: 'second correction',
        audit: AS_USER,
      }),
    );
    expect(error.message).toContain('already been superseded');
  });
});

describe('reversing an adjustment recorded in error (audit row 23)', () => {
  const OCCURRED = new Date('2026-07-10T00:00:00.000Z');

  async function anExpenseWithRefund(refundAmount: bigint): Promise<{
    expenseId: ExpenseId;
    adjustmentId: string;
  }> {
    const expenseId = await addExpense(database.db, {
      description: 'Electronics',
      amount: paise(1000000n),
      occurredAt: new Date('2026-07-05T00:00:00.000Z'),
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_friend_a']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    const adjustment = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(refundAmount),
      occurredAt: OCCURRED,
      audit: AS_USER,
    });
    return { expenseId, adjustmentId: adjustment.adjustmentId };
  }

  it('stops the adjustment counting without editing or deleting it', async () => {
    const { expenseId, adjustmentId } = await anExpenseWithRefund(200000n);
    const before = await getRefundAllocationState(database.db, expenseId);
    expect(before.netAmount).toBe(800000n);

    const result = await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustmentId),
      reason: 'Recorded against the wrong expense — the refund was for the phone case.',
      audit: AS_USER,
    });
    expect(result.reversedAmount).toBe(200000n);
    expect(result.netAmountAfter).toBe(1000000n);

    const after = await getRefundAllocationState(database.db, expenseId);
    expect(after.netAmount).toBe(1000000n);

    // The row is still there, with everything it said.
    const [row] = await database.db
      .select()
      .from(schema.expenseAdjustments)
      .where(eq(schema.expenseAdjustments.id, adjustmentId));
    expect(row?.amount).toBe(200000n);
    expect(row?.kind).toBe('merchant_refund');
    expect(row?.reversedAt).not.toBeNull();
    expect(row?.reversalReason).toContain('phone case');
    expect(row?.reversedBy).toBe('user');
  });

  it('keeps it visible in the expense adjustment history, marked as not counting', async () => {
    const { expenseId, adjustmentId } = await anExpenseWithRefund(200000n);
    await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustmentId),
      reason: 'wrong expense',
      audit: AS_USER,
    });

    const history = await listExpenseAdjustments(database.db, expenseId);
    expect(history).toHaveLength(1);
    expect(history[0]?.counts).toBe(false);
    expect(history[0]?.amount).toBe(200000n);
    expect(history[0]?.reversalReason).toBe('wrong expense');
  });

  it('does not silently rewrite an allocation somebody approved', async () => {
    const { expenseId, adjustmentId } = await anExpenseWithRefund(200000n);
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });

    const distributed = await getRefundAllocationState(database.db, expenseId);
    expect(distributed.pendingDistribution).toBe(false);

    const result = await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustmentId),
      reason: 'wrong expense',
      audit: AS_USER,
    });
    // The shares still sum to the post-refund figure, and the caller is told so rather than
    // having them changed underneath a decision somebody made (`invariants.md` #6).
    expect(result.pendingRedistribution).toBe(true);
    const after = await getRefundAllocationState(database.db, expenseId);
    expect(after.pendingDistribution).toBe(true);
    expect(after.netAmount).toBe(1000000n);
  });

  it('frees the credit payment it was recorded against', async () => {
    // Item-attributed, because that is the path on which the credit's explanation budget is
    // checked: a refund may not claim more of a credit than the credit actually carried.
    const creditId = await addPayment(database.db, cast, {
      accountId,
      amount: paise(200000n),
      direction: 'credit',
      occurredAt: OCCURRED,
      rawDescription: 'REFUND',
      channel: 'bank_transfer',
    });
    const expenseId = await addExpense(database.db, {
      description: 'Electronics',
      amount: paise(1000000n),
      occurredAt: new Date('2026-07-05T00:00:00.000Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    const laptop = await addExpenseItem(database.db, {
      expenseId,
      description: 'Laptop',
      amount: paise(600000n),
    });
    const monitor = await addExpenseItem(database.db, {
      expenseId,
      description: 'Monitor',
      amount: paise(400000n),
    });

    const first = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(200000n),
      adjustmentPaymentId: creditId,
      occurredAt: OCCURRED,
      itemAttributions: [{ expenseItemId: laptop, amount: paise(200000n) }],
      audit: AS_USER,
    });

    // The credit is fully claimed, so a second refund against it is refused...
    const blocked = await captureError(() =>
      recordExpenseAdjustment(database.db, {
        expenseId,
        kind: 'merchant_refund',
        amount: paise(100000n),
        adjustmentPaymentId: creditId,
        occurredAt: OCCURRED,
        itemAttributions: [{ expenseItemId: monitor, amount: paise(100000n) }],
        audit: AS_USER,
      }),
    );
    expect(blocked).toBeDefined();

    // ...and reversing the first one gives the credit its budget back.
    await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(first.adjustmentId),
      reason: 'wrong amount',
      audit: AS_USER,
    });
    const second = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(100000n),
      adjustmentPaymentId: creditId,
      occurredAt: OCCURRED,
      itemAttributions: [{ expenseItemId: monitor, amount: paise(100000n) }],
      audit: AS_USER,
    });
    expect(second.netAmountAfter).toBe(900000n);
  });

  it('is excluded from the expense ledger listing s net figure', async () => {
    const { expenseId, adjustmentId } = await anExpenseWithRefund(200000n);
    await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustmentId),
      reason: 'wrong expense',
      audit: AS_USER,
    });
    const rows = await listExpenses(database.db, {});
    const row = rows.find((entry) => entry.id === expenseId);
    expect(row?.netAmount).toBe(1000000n);
    expect(row?.grossAmount).toBe(1000000n);
  });

  it('records the reversal in the audit log with its reason', async () => {
    const { adjustmentId } = await anExpenseWithRefund(200000n);
    await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustmentId),
      reason: 'wrong expense',
      audit: AS_USER,
    });
    const events = await listAuditEvents(database.db, 'expense_adjustment', adjustmentId);
    const reversal = events.find((event) => event.action === 'supersede');
    expect(reversal?.reason).toBe('wrong expense');
  });

  it('refuses a blank reason, and refuses to reverse twice', async () => {
    const { adjustmentId } = await anExpenseWithRefund(200000n);
    const blank = await captureError(() =>
      reverseExpenseAdjustment(database.db, {
        adjustmentId: asId<'expense_adjustment'>(adjustmentId),
        reason: '  ',
        audit: AS_USER,
      }),
    );
    expect(blank.message).toContain('records why it was wrong');

    await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustmentId),
      reason: 'wrong expense',
      audit: AS_USER,
    });
    const again = await captureError(() =>
      reverseExpenseAdjustment(database.db, {
        adjustmentId: asId<'expense_adjustment'>(adjustmentId),
        reason: 'again',
        audit: AS_USER,
      }),
    );
    expect(again.message).toContain('already reversed');
  });
});

describe('re-distributing after a reversal', () => {
  it('rebuilds the shares to the risen net amount, by their current proportions', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Dinner',
      amount: paise(300000n),
      occurredAt: new Date('2026-07-05T00:00:00.000Z'),
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'exact',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, amount: paise(200000n) },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            amount: paise(100000n),
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const adjustment = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(60000n),
      occurredAt: new Date('2026-07-10T00:00:00.000Z'),
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });

    const distributed = await getRefundAllocationState(database.db, expenseId);
    // Lines come back in beneficiary-sort order, not the order they were written.
    const stateAmountFor = (personId: string) =>
      distributed.currentAllocation?.lines.find((line) => line.beneficiaryId === personId)?.amount;
    expect(stateAmountFor(cast.userPersonId)).toBe(160000n);
    expect(stateAmountFor(cast.person['person_friend_a']!)).toBe(80000n);

    await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustment.adjustmentId),
      reason: 'The merchant reversed the refund; it never arrived.',
      audit: AS_USER,
    });

    const result = await distributeAdjustment(database.db, { expenseId, audit: AS_USER });
    // Back to the 2:1 split of ₹3,000 the reversal restored — computed by the domain, under
    // the one Largest Remainder Method, not by adding the refund back line by line.
    const rebuiltAmountFor = (personId: string) =>
      result.lines.find((line) => line.beneficiary.id === personId)?.amount;
    expect(rebuiltAmountFor(cast.userPersonId)).toBe(200000n);
    expect(rebuiltAmountFor(cast.person['person_friend_a']!)).toBe(100000n);

    const after = await getRefundAllocationState(database.db, expenseId);
    expect(after.pendingDistribution).toBe(false);
    expect(after.netAmount).toBe(300000n);
  });

  it('refuses to guess proportions when every current line is zero', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Fully refunded order',
      amount: paise(100000n),
      occurredAt: new Date('2026-07-05T00:00:00.000Z'),
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'exact',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, amount: paise(70000n) },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            amount: paise(30000n),
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    const adjustment = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(100000n),
      occurredAt: new Date('2026-07-10T00:00:00.000Z'),
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });

    await reverseExpenseAdjustment(database.db, {
      adjustmentId: asId<'expense_adjustment'>(adjustment.adjustmentId),
      reason: 'Recorded against the wrong order.',
      audit: AS_USER,
    });

    // ADR-0013 keeps one zero-amount line per beneficiary, so there is nothing left to
    // rebuild the 70:30 split from. Refusing is the honest answer; guessing is not.
    const error = await captureError(() =>
      distributeAdjustment(database.db, { expenseId, audit: AS_USER }),
    );
    expect(error.message).toContain('no proportion to rebuild by');

    // ...and explicit weights are the way through.
    const rebuilt = await distributeAdjustment(database.db, {
      expenseId,
      customWeights: [70n, 30n],
      audit: AS_USER,
    });
    expect([...rebuilt.lines.map((line) => line.amount)].sort((a, b) => Number(a - b))).toEqual([
      30000n,
      70000n,
    ]);
  });
});
