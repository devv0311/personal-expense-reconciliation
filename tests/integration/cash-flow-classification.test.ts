/**
 * The cash-flow classification lifecycle end to end (ADR-0017 (cash balance), 17.1–17.2).
 *
 * `IMPORTED -> NORMALIZED -> CASH_FLOW_CLASSIFIED -> APPROVED`, against a real Postgres
 * engine, so the row-local `CHECK`s and the service's cross-record evidence gates are both
 * exercised by the same tests rather than only one of them.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { ExpenseId, PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import {
  approvePaymentCashFlow,
  classifyPaymentCashFlow,
  markPaymentCashFlowNormalized,
  recordExpenseAdjustment,
  rejectPaymentCashFlow,
  recordSettlement,
} from '../../src/services/index.js';
import { addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';

let database: TestDatabase;
let cast: Cast;

const audit = { actor: 'user', source: 'tests/cash-flow' } as const;

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

async function cashFlowOf(paymentId: PaymentId): Promise<{
  state: string;
  category: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
}> {
  const [row] = await database.db
    .select({
      state: schema.payments.cashFlowState,
      category: schema.payments.cashFlowCategory,
      approvedBy: schema.payments.cashFlowApprovedBy,
      approvedAt: schema.payments.cashFlowApprovedAt,
    })
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId));
  return row!;
}

async function seedCredit(overrides: Partial<Parameters<typeof addPayment>[2]> = {}) {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(100_000n),
    direction: 'credit',
    occurredAt: new Date('2026-07-10T10:00:00Z'),
    rawDescription: 'UPI CREDIT',
    channel: 'upi',
    ...overrides,
  });
}

async function attachEvidence(paymentId: PaymentId): Promise<void> {
  await database.db.insert(schema.evidence).values({
    type: 'upi_notification',
    rawText: 'Salary credited by ACME PAYROLL',
    capturedAt: new Date('2026-07-10T10:00:01Z'),
    linkedPaymentId: paymentId,
  });
}

describe('the lifecycle runs alongside Payment.state, never instead of it', () => {
  it('starts every imported payment at the beginning of the cash-flow lifecycle', async () => {
    const paymentId = await seedCredit();

    expect((await cashFlowOf(paymentId)).state).toBe('imported');
  });

  it('walks normalized → classified → approved', async () => {
    const paymentId = await seedCredit({ counterpartyType: 'merchant' });
    await attachEvidence(paymentId);

    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    expect((await cashFlowOf(paymentId)).state).toBe('normalized');

    await classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit });
    expect(await cashFlowOf(paymentId)).toMatchObject({
      state: 'cash_flow_classified',
      category: 'EXTERNAL_INFLOW',
      approvedBy: null,
    });

    await approvePaymentCashFlow(database.db, {
      paymentId,
      ownerUserId: cast.userId,
      decidedBy: 'user',
      audit,
    });
    const approved = await cashFlowOf(paymentId);
    expect(approved.state).toBe('approved');
    expect(approved.approvedBy).toBe('user');
    expect(approved.approvedAt).not.toBeNull();
  });

  it('leaves the legacy Payment.state untouched throughout', async () => {
    const paymentId = await seedCredit({ counterpartyType: 'merchant', state: 'normalized' });
    await attachEvidence(paymentId);
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit });
    await approvePaymentCashFlow(database.db, {
      paymentId,
      ownerUserId: cast.userId,
      decidedBy: 'user',
      audit,
    });

    const [row] = await database.db
      .select({ state: schema.payments.state, amount: schema.payments.amount })
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId));

    expect(row?.state).toBe('normalized');
    // SOURCE columns are untouched by an interpretation, exactly as `invariants.md` #4 requires.
    expect(row?.amount).toBe(100_000n);
  });

  it('refuses to classify a payment that has not been normalized', async () => {
    const paymentId = await seedCredit();

    await expect(
      classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('refuses to approve a role nobody proposed', async () => {
    const paymentId = await seedCredit();
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });

    await expect(
      approvePaymentCashFlow(database.db, {
        paymentId,
        ownerUserId: cast.userId,
        decidedBy: 'user',
        audit,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('records an AuditEvent for every step', async () => {
    const paymentId = await seedCredit({ counterpartyType: 'merchant' });
    await attachEvidence(paymentId);
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit });
    await approvePaymentCashFlow(database.db, {
      paymentId,
      ownerUserId: cast.userId,
      decidedBy: 'user',
      audit,
    });

    const events = await database.db
      .select({ action: schema.auditEvents.action, entityId: schema.auditEvents.entityId })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'payment'));

    expect(events).toHaveLength(3);
    expect(events.every((event) => event.entityId === paymentId)).toBe(true);
  });
});

describe('rejection and reclassification are audited decisions, never silent edits', () => {
  it('clears the category when a proposal is declined', async () => {
    const paymentId = await seedCredit();
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit });

    await rejectPaymentCashFlow(database.db, {
      paymentId,
      reason: 'no evidence this was salary',
      audit,
    });

    // A declined proposal must not leave its label behind: the whole reason an unclassified
    // credit stays unexplained is that nobody has vouched for what it is.
    expect(await cashFlowOf(paymentId)).toMatchObject({ state: 'normalized', category: null });
  });

  it('drops the approval when an approved payment is reclassified', async () => {
    const paymentId = await seedCredit({ counterpartyType: 'merchant' });
    await attachEvidence(paymentId);
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit });
    await approvePaymentCashFlow(database.db, {
      paymentId,
      ownerUserId: cast.userId,
      decidedBy: 'user',
      audit,
    });

    await classifyPaymentCashFlow(database.db, { paymentId, category: 'REFUND', audit });

    expect(await cashFlowOf(paymentId)).toMatchObject({
      state: 'cash_flow_classified',
      category: 'REFUND',
      approvedBy: null,
      approvedAt: null,
    });
  });
});

describe('approval evidence gates — 17.2', () => {
  it('refuses a debit refund at classification', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(100_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-10T10:00:00Z'),
      rawDescription: 'UPI DEBIT',
      channel: 'upi',
    });
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });

    await expect(
      classifyPaymentCashFlow(database.db, { paymentId, category: 'REFUND', audit }),
    ).rejects.toMatchObject({ code: 'CASH_FLOW_DIRECTION_INVALID' });
  });

  it('refuses to approve an external inflow with no evidence of its own', async () => {
    const paymentId = await seedCredit();
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit });

    await expect(
      approvePaymentCashFlow(database.db, {
        paymentId,
        ownerUserId: cast.userId,
        decidedBy: 'user',
        audit,
      }),
    ).rejects.toMatchObject({ code: 'CASH_FLOW_EVIDENCE_INSUFFICIENT' });
  });

  it('refuses to approve a peer settlement with no Settlement attribution', async () => {
    const paymentId = await seedCredit({
      counterpartyType: 'person',
      counterpartyId: cast.person['person_flatmate_a']!,
    });
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'PEER_SETTLEMENT', audit });

    await expect(
      approvePaymentCashFlow(database.db, {
        paymentId,
        ownerUserId: cast.userId,
        decidedBy: 'user',
        audit,
      }),
    ).rejects.toMatchObject({ code: 'CASH_FLOW_EVIDENCE_INSUFFICIENT' });
  });

  it('approves a peer settlement once a real Settlement discharges a debt', async () => {
    const paymentId = await seedCredit({
      counterpartyType: 'person',
      counterpartyId: cast.person['person_flatmate_a']!,
    });
    await recordSettlement(database.db, {
      paymentId,
      counterpartyPersonId: cast.person['person_flatmate_a']!,
      amount: paise(100_000n),
      audit,
    });
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'PEER_SETTLEMENT', audit });

    await approvePaymentCashFlow(database.db, {
      paymentId,
      ownerUserId: cast.userId,
      decidedBy: 'user',
      audit,
    });

    expect((await cashFlowOf(paymentId)).state).toBe('approved');
  });

  it('refuses to approve a refund no ExpenseAdjustment names', async () => {
    const paymentId = await seedCredit({ counterpartyType: 'merchant' });
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'REFUND', audit });

    await expect(
      approvePaymentCashFlow(database.db, {
        paymentId,
        ownerUserId: cast.userId,
        decidedBy: 'user',
        audit,
      }),
    ).rejects.toMatchObject({ code: 'CASH_FLOW_EVIDENCE_INSUFFICIENT' });
  });

  it('approves a refund backed by a real adjustment', async () => {
    const expenseId: ExpenseId = await addExpense(database.db, {
      description: 'Blinkit basket',
      amount: paise(200_000n),
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    const paymentId = await seedCredit({ counterpartyType: 'merchant' });
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(100_000n),
      adjustmentPaymentId: paymentId,
      occurredAt: new Date('2026-07-10T10:00:00Z'),
      audit,
    });
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'REFUND', audit });

    await approvePaymentCashFlow(database.db, {
      paymentId,
      ownerUserId: cast.userId,
      decidedBy: 'user',
      audit,
    });

    expect((await cashFlowOf(paymentId)).state).toBe('approved');
  });

  it('refuses to approve an internal transfer with neither counter-leg nor evidence', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(150_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T00:00:00Z'),
      rawDescription: 'NEFT TRANSFER TO SELF A/C X4821',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
    });
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, {
      paymentId,
      category: 'INTERNAL_TRANSFER',
      audit,
    });

    await expect(
      approvePaymentCashFlow(database.db, {
        paymentId,
        ownerUserId: cast.userId,
        decidedBy: 'user',
        audit,
      }),
    ).rejects.toMatchObject({ code: 'CASH_FLOW_EVIDENCE_INSUFFICIENT' });
  });

  it('approves an internal transfer proved by its counter-leg', async () => {
    const outgoing = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(150_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T00:00:00Z'),
      rawDescription: 'NEFT TRANSFER TO SELF A/C X4821',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
      externalReference: 'NEFT/N072026001',
    });
    const incoming = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(150_000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-02T00:00:10Z'),
      rawDescription: 'NEFT TRANSFER FROM SELF A/C X9013',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
      externalReference: 'NEFT/N072026001',
    });

    await markPaymentCashFlowNormalized(database.db, { paymentId: outgoing, audit });
    await classifyPaymentCashFlow(database.db, {
      paymentId: outgoing,
      category: 'INTERNAL_TRANSFER',
      audit,
    });
    await approvePaymentCashFlow(database.db, {
      paymentId: outgoing,
      ownerUserId: cast.userId,
      counterLegPaymentId: incoming,
      decidedBy: 'user',
      audit,
    });

    expect((await cashFlowOf(outgoing)).state).toBe('approved');
  });

  it('refuses to let anything but a person or a Rule approve a role', async () => {
    const paymentId = await seedCredit({ counterpartyType: 'merchant' });
    await attachEvidence(paymentId);
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit });

    await expect(
      approvePaymentCashFlow(database.db, {
        paymentId,
        ownerUserId: cast.userId,
        decidedBy: 'system',
        audit,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('accepts an applicable previously approved Rule as the decider', async () => {
    const paymentId = await seedCredit({ counterpartyType: 'merchant' });
    await attachEvidence(paymentId);
    await markPaymentCashFlowNormalized(database.db, { paymentId, audit });
    await classifyPaymentCashFlow(database.db, { paymentId, category: 'EXTERNAL_INFLOW', audit });

    await approvePaymentCashFlow(database.db, {
      paymentId,
      ownerUserId: cast.userId,
      decidedBy: `rule:${asId<'rule'>('44444444-4444-4444-8444-444444444444')}`,
      audit,
    });

    expect((await cashFlowOf(paymentId)).approvedBy).toContain('rule:');
  });

  it('reports a missing payment rather than writing anything', async () => {
    await expect(
      markPaymentCashFlowNormalized(database.db, {
        paymentId: asId<'payment'>('55555555-5555-4555-8555-555555555555'),
        audit,
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
  });
});
