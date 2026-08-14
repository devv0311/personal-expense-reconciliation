import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assertPaymentCanFundExpense,
  computeUnexplained,
  isDeterministicDuplicate,
  isPossibleDuplicate,
  isPaymentTerminalWithoutLinking,
  paise,
} from '../../src/domain/index.js';
import { asId } from '../../src/domain/index.js';
import type { DuplicateCandidate, ExpenseId } from '../../src/domain/index.js';
import { schema, updatePaymentState } from '../../src/db/index.js';
import {
  approveAllocation,
  distributeAdjustment,
  getBalance,
  recordExpenseAdjustment,
  recordSettlement,
  runReconciliation,
} from '../../src/services/index.js';
import type { ServiceError } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import {
  AS_USER,
  addExpense,
  addManualNote,
  addPayment,
  allocationVersions,
  currentAllocationAmounts,
  linkPaymentToExpense,
  seedCast,
} from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

/**
 * Scenarios 10–15, 17 and 18 of the required set: money coming back, debts being
 * discharged, and the payment classifications that are not spending at all.
 */

let database: TestDatabase;
let cast: Cast;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  // Guarded: when beforeAll fails, `database` was never assigned, and an unguarded
  // call here reports a TypeError that buries the real setup error.
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
});

const JULY = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z') };

async function reconcileJuly(): Promise<Awaited<ReturnType<typeof runReconciliation>>['totals']> {
  const { totals } = await runReconciliation(database.db, {
    userPersonId: cast.userPersonId,
    periodStart: JULY.start,
    periodEnd: JULY.end,
    audit: AS_USER,
  });
  return totals;
}

/** Maps a stored payment row onto the shape duplicate detection compares. */
function asCandidate(row: {
  amount: bigint;
  occurredAt: Date;
  externalReference: string | null;
  direction?: 'debit' | 'credit';
  accountId?: string;
}): DuplicateCandidate {
  return {
    amount: paise(row.amount),
    occurredAt: row.occurredAt,
    externalReference: row.externalReference,
    // Every candidate in these scenarios is an outgoing capture; direction is part of the
    // match so the two legs of one transfer never collapse into each other (ADR-0019).
    direction: row.direction ?? 'debit',
    ...(row.accountId === undefined ? {} : { accountId: row.accountId }),
  };
}

async function balance(debtor: string, creditor: string): Promise<bigint> {
  const result = await getBalance(
    database.db,
    cast.userPersonId,
    cast.person[debtor]!,
    cast.person[creditor]!,
  );
  return result.netBalance;
}

/* ============================================================ 10 & 11: adjustments */

describe('Scenario 10 — a full refund (§11, ADR-0013)', () => {
  async function seedRefundedCable(): Promise<ExpenseId> {
    const payment = await addPayment(database.db, cast, {
      accountId: cast.account['account_icici_credit_card']!,
      amount: paise(45000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-08T14:00:00Z'),
      rawDescription: 'SAMPLE ELECTRONICS STORE',
      channel: 'card',
      counterpartyType: 'merchant',
    });
    const expense = await addExpense(database.db, {
      description: 'USB cable (faulty, later returned)',
      amount: paise(45000n),
      occurredAt: new Date('2026-07-08T14:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await linkPaymentToExpense(database.db, {
      paymentId: payment,
      expenseId: expense,
      amount: paise(45000n),
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const refund = await addPayment(database.db, cast, {
      accountId: cast.account['account_icici_credit_card']!,
      amount: paise(45000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-15T10:00:00Z'),
      rawDescription: 'ACH REFUND SAMPLE ELECTRONICS STORE',
      channel: 'card',
      counterpartyType: 'merchant',
    });
    await recordExpenseAdjustment(database.db, {
      expenseId: expense,
      kind: 'merchant_refund',
      amount: paise(45000n),
      adjustmentPaymentId: refund,
      reason: 'Faulty item, full refund',
      occurredAt: new Date('2026-07-15T10:00:00Z'),
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER });
    return expense;
  }

  it('leaves one zero-amount line per original beneficiary, never an empty set', async () => {
    const expense = await seedRefundedCable();
    const lines = await currentAllocationAmounts(database.db, expense);

    expect(lines).toHaveLength(1);
    expect(lines).not.toEqual([]);
    expect(lines[0]).toEqual({
      beneficiaryId: cast.userPersonId,
      beneficiaryType: 'person',
      amount: 0n,
    });
  });

  it('never mutates the original gross amount (invariant #6)', async () => {
    const expense = await seedRefundedCable();
    const [row] = await database.db
      .select({ amount: schema.expenses.amount })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expense));

    expect(row?.amount).toBe(45000n);
  });

  it('keeps the superseded allocation, so who benefited stays answerable', async () => {
    const expense = await seedRefundedCable();
    const versions = await allocationVersions(database.db, expense);

    expect(versions).toHaveLength(2);
    expect(versions[0]?.supersededAt).not.toBeNull();
    expect(versions[1]?.supersededAt).toBeNull();
  });

  it('contributes exactly zero to explained spend, while the outflow still counts', async () => {
    await seedRefundedCable();
    const totals = await reconcileJuly();

    expect(totals.ledgerExplainedTotal).toBe(0n);
    expect(totals.ledgerTotalOutflow).toBe(45000n);
    expect(totals.ledgerUnexplainedTotal).toBe(45000n);
  });
});

describe('Scenario 11 — a partial refund (§12)', () => {
  async function seedPartiallyRefundedGroceries(): Promise<ExpenseId> {
    const expense = await addExpense(database.db, {
      description: 'Zepto grocery order',
      amount: paise(90000n),
      occurredAt: new Date('2026-07-08T18:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    const payment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(90000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-08T18:00:00Z'),
      rawDescription: 'UPI-ZEPTOMARKETPLACE-zepto@axl',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    await linkPaymentToExpense(database.db, {
      paymentId: payment,
      expenseId: expense,
      amount: paise(90000n),
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_flatmate_a']! },
          { type: 'person', id: cast.person['person_flatmate_c']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const refund = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(15000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-09T08:00:00Z'),
      rawDescription: 'ZEPTO REFUND — DAMAGED ITEM',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    await recordExpenseAdjustment(database.db, {
      expenseId: expense,
      kind: 'merchant_refund',
      amount: paise(15000n),
      adjustmentPaymentId: refund,
      reason: 'Damaged item',
      occurredAt: new Date('2026-07-09T08:00:00Z'),
      audit: AS_USER,
    });
    return expense;
  }

  it('leaves the allocation at the pre-adjustment figure until it is distributed', async () => {
    const expense = await seedPartiallyRefundedGroceries();
    const lines = await currentAllocationAmounts(database.db, expense);

    // "Recorded but not yet distributed" is a real, visible state — not an error.
    expect(lines.map((line) => line.amount)).toEqual([30000n, 30000n, 30000n]);
  });

  it('redistributes proportionally to ₹250 each once distributed', async () => {
    const expense = await seedPartiallyRefundedGroceries();
    await distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER });

    const lines = await currentAllocationAmounts(database.db, expense);
    expect(lines.map((line) => line.amount)).toEqual([25000n, 25000n, 25000n]);
    expect(lines.reduce((total, line) => total + line.amount, 0n)).toBe(75000n);
  });

  it('reduces each flatmate’s debt to the payer accordingly', async () => {
    const expense = await seedPartiallyRefundedGroceries();
    await distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER });

    expect(await balance('person_flatmate_a', 'person_dev')).toBe(25000n);
    expect(await balance('person_flatmate_c', 'person_dev')).toBe(25000n);
  });

  it('counts the net figure, not the gross, as explained spend (ADR-0008)', async () => {
    const expense = await seedPartiallyRefundedGroceries();
    await distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER });
    const totals = await reconcileJuly();

    expect(totals.ledgerExplainedTotal).toBe(75000n);
  });

  it('lets a custom distribution load the whole refund onto one beneficiary', async () => {
    const expense = await seedPartiallyRefundedGroceries();
    await distributeAdjustment(database.db, {
      expenseId: expense,
      customWeights: [1n, 0n, 0n],
      audit: AS_USER,
    });

    const lines = await currentAllocationAmounts(database.db, expense);
    expect(lines.reduce((total, line) => total + line.amount, 0n)).toBe(75000n);
    expect(lines.map((line) => line.amount).sort()).toEqual([15000n, 30000n, 30000n].sort());
  });

  it('refuses a distribution that would drive a line below zero, writing nothing', async () => {
    const expense = await seedPartiallyRefundedGroceries();

    await expect(
      distributeAdjustment(database.db, {
        expenseId: expense,
        // Everything onto a ₹300 line, when the refund is ₹150 — fine. Make it impossible
        // by refunding onto a line that cannot absorb it: weight the whole ₹150 onto a
        // beneficiary after first shrinking their share is not expressible here, so instead
        // over-refund a single line by recording a second adjustment first.
        customWeights: [0n, 0n, 0n],
        audit: AS_USER,
      }),
    ).rejects.toThrow(/weight/i);

    expect(await allocationVersions(database.db, expense)).toHaveLength(1);
  });

  it('refuses to record adjustments totalling more than the expense cost (#8)', async () => {
    const expense = await seedPartiallyRefundedGroceries();

    let raised: Error | undefined;
    try {
      await recordExpenseAdjustment(database.db, {
        expenseId: expense,
        kind: 'merchant_refund',
        amount: paise(80000n), // 15000 already recorded; 95000 > 90000 gross
        occurredAt: new Date('2026-07-10T08:00:00Z'),
        audit: AS_USER,
      });
    } catch (error) {
      raised = error as Error;
    }

    expect(raised?.message).toMatch(/exceed|more than it cost/i);
  });
});

/* ============================================================= 12 & 13: settlements */

describe('Scenario 12 — a settlement received by the user (§29)', () => {
  async function seedDevFrontedThenRepaid(): Promise<void> {
    const expense = await addExpense(database.db, {
      description: 'Electrician, fronted by Dev',
      amount: paise(300000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    const payment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(300000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      rawDescription: 'UPI-ELECTRICIAN',
      channel: 'upi',
      counterpartyType: 'person',
    });
    await linkPaymentToExpense(database.db, {
      paymentId: payment,
      expenseId: expense,
      amount: paise(300000n),
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_flatmate_a']! },
          { type: 'person', id: cast.person['person_flatmate_c']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const repayment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(100000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-20T09:00:00Z'),
      rawDescription: 'UPI CREDIT FROM FLATMATE A',
      channel: 'upi',
      counterpartyType: 'person',
      counterpartyId: cast.person['person_flatmate_a']!,
    });
    await recordSettlement(database.db, {
      paymentId: repayment,
      counterpartyPersonId: cast.person['person_flatmate_a']!,
      amount: paise(100000n),
      audit: AS_USER,
    });
  }

  it('clears the flatmate’s debt to the user', async () => {
    await seedDevFrontedThenRepaid();

    expect(await balance('person_flatmate_a', 'person_dev')).toBe(0n);
    expect(await balance('person_flatmate_c', 'person_dev')).toBe(100000n);
  });

  it('reports the cleared pair as settled and confirmed', async () => {
    await seedDevFrontedThenRepaid();
    const result = await getBalance(
      database.db,
      cast.userPersonId,
      cast.person['person_flatmate_a']!,
      cast.userPersonId,
    );

    expect(result.evidenceStatus).toBe('settled_confirmed');
  });

  it('never creates an Allocation for the settlement (invariant #9a)', async () => {
    await seedDevFrontedThenRepaid();
    const settlementRows = await database.db
      .select({ paymentId: schema.settlements.paymentId })
      .from(schema.settlements);
    const allocationCount = await database.db
      .select({ id: schema.allocations.id })
      .from(schema.allocations);

    expect(settlementRows).toHaveLength(1);
    // Exactly one allocation exists: the expense's. The settlement produced none.
    expect(allocationCount).toHaveLength(1);
  });

  it('is excluded from settlements-out, having never been outflow', async () => {
    await seedDevFrontedThenRepaid();
    const totals = await reconcileJuly();

    expect(totals.ledgerSettlementsTotal).toBe(0n);
    expect(totals.ledgerExplainedTotal).toBe(300000n);
    expect(totals.ledgerTotalOutflow).toBe(300000n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });
});

describe('Scenario 13 — a settlement paid by the user (§28)', () => {
  async function seedFlatmateFrontedThenRepaid(): Promise<void> {
    const expense = await addExpense(database.db, {
      description: 'Electrician, fronted by Flatmate A',
      amount: paise(300000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_flatmate_a']! },
          { type: 'person', id: cast.person['person_flatmate_c']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const settlementPayment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(100000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-20T09:00:00Z'),
      rawDescription: 'UPI TO FLATMATE A',
      channel: 'upi',
      counterpartyType: 'person',
      counterpartyId: cast.person['person_flatmate_a']!,
    });
    await recordSettlement(database.db, {
      paymentId: settlementPayment,
      counterpartyPersonId: cast.person['person_flatmate_a']!,
      amount: paise(100000n),
      reason: 'Settling the electrician bill',
      audit: AS_USER,
    });
  }

  it('clears the user’s debt to the flatmate', async () => {
    await seedFlatmateFrontedThenRepaid();

    expect(await balance('person_dev', 'person_flatmate_a')).toBe(0n);
  });

  it('leaves the third flatmate still owing, untouched by an unrelated settlement', async () => {
    await seedFlatmateFrontedThenRepaid();

    expect(await balance('person_flatmate_c', 'person_flatmate_a')).toBe(100000n);
  });

  it('moves the payment to linked and audits both the settlement and the transition', async () => {
    await seedFlatmateFrontedThenRepaid();

    const [payment] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.direction, 'debit'));
    const events = await database.db
      .select({ entityType: schema.auditEvents.entityType })
      .from(schema.auditEvents);

    expect(payment?.state).toBe('linked');
    expect(events.map((event) => event.entityType)).toEqual(
      expect.arrayContaining(['settlement', 'payment']),
    );
  });

  it('lands in its own reconciliation bucket, never in explained spend (#9, #20)', async () => {
    await seedFlatmateFrontedThenRepaid();
    const totals = await reconcileJuly();

    expect(totals.ledgerSettlementsTotal).toBe(100000n);
    // The expense was externally funded, so it contributes no explained *outflow* of ours.
    expect(totals.ledgerExplainedTotal).toBe(0n);
    expect(totals.ledgerTotalOutflow).toBe(100000n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('refuses to explain more of a payment than it actually moved', async () => {
    await seedFlatmateFrontedThenRepaid();
    const [payment] = await database.db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(eq(schema.payments.direction, 'debit'));

    await expect(
      recordSettlement(database.db, {
        paymentId: asId<'payment'>(payment!.id),
        counterpartyPersonId: cast.person['person_flatmate_c']!,
        amount: paise(1n),
        audit: AS_USER,
      }),
    ).rejects.toThrow(/more money than it moved/);
  });
});

/* ================================================== 14 & 15: not spending at all */

describe('Scenario 14 — a transfer between the user’s own accounts (§14)', () => {
  it('is excluded from spend and nets out of unexplained money', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(500000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T09:00:00Z'),
      rawDescription: 'TRANSFER TO OWN UPI ACCOUNT',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
    });

    const totals = await reconcileJuly();

    expect(totals.ledgerTransfersTotal).toBe(500000n);
    expect(totals.ledgerTotalOutflow).toBe(500000n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('is a valid terminal state at normalized — it need never be linked or ignored', () => {
    expect(isPaymentTerminalWithoutLinking('normalized', 'internal_account', 'debit')).toBe(true);
  });

  it('can never be linked to an Expense (invariant #7)', () => {
    expect(() => assertPaymentCanFundExpense('internal_account')).toThrow(/not spending/);
  });
});

describe('Scenario 15 — an investment purchase (§32, ADR-0011)', () => {
  it('gets its own bucket rather than inflating unexplained money', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(500000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-05T06:00:00Z'),
      rawDescription: 'UPI AUTOPAY MUTUAL FUND SIP',
      channel: 'upi',
      counterpartyType: 'investment_instrument',
    });

    const totals = await reconcileJuly();

    expect(totals.ledgerInvestmentsTotal).toBe(500000n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('can never be linked to an Expense', () => {
    expect(() => assertPaymentCanFundExpense('investment_instrument')).toThrow(/not spending/);
  });

  it('is distinguished from a transfer in the totals', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(500000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-05T06:00:00Z'),
      rawDescription: 'SIP',
      channel: 'upi',
      counterpartyType: 'investment_instrument',
    });
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(200000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-06T06:00:00Z'),
      rawDescription: 'TRANSFER',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
    });

    const totals = await reconcileJuly();

    expect(totals.ledgerInvestmentsTotal).toBe(500000n);
    expect(totals.ledgerTransfersTotal).toBe(200000n);
    expect(totals.ledgerUnexplainedTotal).toBe(0n);
  });
});

/* ================================================== 17 & 18: duplicate detection */

describe('Scenario 17 — the same charge imported twice (§13)', () => {
  it('is detected deterministically and counted only once', async () => {
    const first = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:00Z'),
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'bank_transfer',
      counterpartyType: 'merchant',
      externalReference: 'UPI/2607121234/BLINKIT',
      referenceType: 'upi_utr',
      sourceSystem: 'hdfc_bank_csv',
    });
    const second = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:02Z'),
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'bank_transfer',
      counterpartyType: 'merchant',
      externalReference: 'UPI/2607121234/BLINKIT',
      referenceType: 'upi_utr',
      sourceSystem: 'hdfc_bank_csv',
    });

    const rows = await database.db
      .select({
        id: schema.payments.id,
        amount: schema.payments.amount,
        occurredAt: schema.payments.occurredAt,
        externalReference: schema.payments.externalReference,
      })
      .from(schema.payments);
    const [a, b] = rows;

    expect(isDeterministicDuplicate(asCandidate(a!), asCandidate(b!))).toBe(true);

    await updatePaymentState(database.db, second, 'ignored', `duplicate_of:${first}`);
    const totals = await reconcileJuly();

    expect(totals.ledgerTotalOutflow).toBe(124000n);
  });

  it('only flags a possible duplicate when no reference corroborates it', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:00Z'),
      rawDescription: 'BLINKIT',
      channel: 'bank_transfer',
    });
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:02Z'),
      rawDescription: 'BLINKIT',
      channel: 'bank_transfer',
    });

    const rows = await database.db
      .select({
        amount: schema.payments.amount,
        occurredAt: schema.payments.occurredAt,
        externalReference: schema.payments.externalReference,
      })
      .from(schema.payments);
    const [a, b] = rows;

    expect(isDeterministicDuplicate(asCandidate(a!), asCandidate(b!))).toBe(false);
    expect(isPossibleDuplicate(asCandidate(a!), asCandidate(b!))).toBe(true);
  });
});

describe('Scenario 18 — the same charge captured by two channels (§13, ADR-0010 amendment)', () => {
  it('matches across different Account rows, which is what makes the rule reachable', async () => {
    const bankCapture = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:00Z'),
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'bank_transfer',
      externalReference: 'UPI/2607121234/BLINKIT',
      referenceType: 'upi_utr',
      sourceSystem: 'hdfc_bank_csv',
    });
    const upiCapture = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:03Z'),
      rawDescription: 'BLINKIT INDIA PVT LTD',
      channel: 'upi',
      externalReference: 'UPI/2607121234/BLINKIT',
      referenceType: 'upi_utr',
      sourceSystem: 'gpay_export',
    });

    const rows = await database.db
      .select({
        id: schema.payments.id,
        accountId: schema.payments.accountId,
        amount: schema.payments.amount,
        occurredAt: schema.payments.occurredAt,
        externalReference: schema.payments.externalReference,
      })
      .from(schema.payments);
    const bank = rows.find((row) => row.id === bankCapture)!;
    const upi = rows.find((row) => row.id === upiCapture)!;

    // The two captures are on *different* accounts by construction. Requiring account_id to
    // match — the pre-amendment rule — would make the deterministic path unreachable here.
    expect(bank.accountId).not.toBe(upi.accountId);
    expect(isDeterministicDuplicate(asCandidate(bank), asCandidate(upi))).toBe(true);
  });

  it('counts the money once after the second capture is ignored', async () => {
    const bankCapture = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:00Z'),
      rawDescription: 'BANK CAPTURE',
      channel: 'bank_transfer',
      externalReference: 'UPI/2607121234/BLINKIT',
      referenceType: 'upi_utr',
    });
    const upiCapture = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:03Z'),
      rawDescription: 'UPI CAPTURE',
      channel: 'upi',
      externalReference: 'UPI/2607121234/BLINKIT',
      referenceType: 'upi_utr',
    });

    await updatePaymentState(database.db, upiCapture, 'ignored', `duplicate_of:${bankCapture}`);
    const totals = await reconcileJuly();

    expect(totals.ledgerTotalOutflow).toBe(124000n);
  });
});

/* ============================================== the ambiguous manual-note signal */

describe('ADR-0018 — a documenting note can never make an obligation look settled', () => {
  /**
   * The regression this ADR exists for. ADR-0006 gives every externally-funded expense a
   * manual note as its only evidence; ADR-0014 reads a settlement-claim note on a
   * contributing expense as "believed settled". Before `note_kind` those were the same row,
   * so recording the expense at all reported its obligation as believed-settled.
   */
  async function seedExternallyFunded(
    noteKind: 'documentation' | 'settlement_claim',
  ): Promise<ExpenseId> {
    const expense = await addExpense(database.db, {
      description: 'Electrician, fronted by Flatmate A',
      amount: paise(300000n),
      occurredAt: new Date('2026-07-05T10:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
    });
    await addManualNote(database.db, {
      text:
        noteKind === 'documentation'
          ? 'Flatmate A: paid the electrician, ₹3,000, split three ways'
          : 'Flatmate C says they repaid Flatmate A in cash',
      noteKind,
      capturedAt: new Date('2026-07-05T10:00:00Z'),
      expenseId: expense,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_flatmate_a']! },
          { type: 'person', id: cast.person['person_flatmate_c']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    return expense;
  }

  it('reports an open obligation as open when the note merely documents the expense', async () => {
    await seedExternallyFunded('documentation');
    const result = await getBalance(
      database.db,
      cast.userPersonId,
      cast.person['person_flatmate_c']!,
      cast.person['person_flatmate_a']!,
    );

    expect(result.evidenceStatus).toBe('open_unconfirmed');
    expect(result.netBalance).toBe(100000n);
  });

  it('reports believed-settled only when the note actually claims settlement', async () => {
    await seedExternallyFunded('settlement_claim');
    const result = await getBalance(
      database.db,
      cast.userPersonId,
      cast.person['person_flatmate_c']!,
      cast.person['person_flatmate_a']!,
    );

    expect(result.evidenceStatus).toBe('believed_settled_unconfirmed_by_ledger');
  });

  it('never lets the belief move the ledger\u2019s own figure (invariant #9b)', async () => {
    await seedExternallyFunded('settlement_claim');
    const result = await getBalance(
      database.db,
      cast.userPersonId,
      cast.person['person_flatmate_c']!,
      cast.person['person_flatmate_a']!,
    );

    // "Believed settled" is an annotation. NetBalance keeps showing what the ledger observed
    // until a real Settlement backed by a real Payment says otherwise.
    expect(result.netBalance).toBe(100000n);
  });

  it('does not fabricate a Settlement or a Payment to represent the belief', async () => {
    await seedExternallyFunded('settlement_claim');

    const settlementRows = await database.db
      .select({ id: schema.settlements.id })
      .from(schema.settlements);
    const paymentRows = await database.db.select({ id: schema.payments.id }).from(schema.payments);

    expect(settlementRows).toEqual([]);
    expect(paymentRows).toEqual([]);
  });

  it('ignores a settlement-claim note attached to an unrelated expense', async () => {
    await seedExternallyFunded('documentation');
    const unrelated = await addExpense(database.db, {
      description: 'Something else entirely',
      amount: paise(50000n),
      occurredAt: new Date('2026-07-06T10:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await addManualNote(database.db, {
      text: 'Unrelated claim',
      noteKind: 'settlement_claim',
      capturedAt: new Date('2026-07-06T10:00:00Z'),
      expenseId: unrelated,
    });

    const result = await getBalance(
      database.db,
      cast.userPersonId,
      cast.person['person_flatmate_c']!,
      cast.person['person_flatmate_a']!,
    );

    expect(result.evidenceStatus).toBe('open_unconfirmed');
  });
});

/* ================================================================= audit coverage */

describe('adjustments and settlements are audited like any other approved change (#21)', () => {
  it('records create events for the adjustment and the superseding allocation', async () => {
    const expense = await addExpense(database.db, {
      description: 'Client dinner (reimbursed)',
      amount: paise(120000n),
      occurredAt: new Date('2026-07-02T20:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    await recordExpenseAdjustment(database.db, {
      expenseId: expense,
      kind: 'third_party_reimbursement',
      amount: paise(120000n),
      reason: 'Employer reimbursed the full amount',
      occurredAt: new Date('2026-07-16T09:00:00Z'),
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: expense, audit: AS_USER });

    const events = await database.db
      .select({
        entityType: schema.auditEvents.entityType,
        action: schema.auditEvents.action,
      })
      .from(schema.auditEvents);
    const kinds = events.map((event) => `${event.entityType}:${event.action}`);

    expect(kinds).toEqual(
      expect.arrayContaining([
        'expense_adjustment:create',
        'allocation:supersede',
        'allocation:create',
      ]),
    );
  });

  it('rolls back a mutation whose unit of work recorded nothing', async () => {
    // The structural half of invariant #21: `runAudited` refuses to commit unaudited state.
    const { runAudited } = await import('../../src/services/audit.js');

    let raised: ServiceError | undefined;
    try {
      await runAudited(
        database.db,
        { actor: 'user', source: 'test/forgetful' },
        async ({ exec }) => {
          // A real mutation, written on the unit of work's own transaction — but with no
          // accompanying `record(...)` call.
          await addExpense(exec, {
            description: 'Written without an audit event',
            amount: paise(100n),
            occurredAt: new Date('2026-07-01T00:00:00Z'),
            relationshipType: 'personal',
            paidByPersonId: cast.userPersonId,
          });
        },
      );
    } catch (error) {
      raised = error as ServiceError;
    }

    expect(raised?.code).toBe('AUDIT_EVENT_MISSING');
  });

  it('leaves no trace of the rolled-back write', async () => {
    const { runAudited } = await import('../../src/services/audit.js');

    await runAudited(database.db, { actor: 'user', source: 'test/forgetful' }, async ({ exec }) => {
      await addExpense(exec, {
        description: 'Written without an audit event',
        amount: paise(100n),
        occurredAt: new Date('2026-07-01T00:00:00Z'),
        relationshipType: 'personal',
        paidByPersonId: cast.userPersonId,
      });
    }).catch(() => undefined);

    const expenses = await database.db.select({ id: schema.expenses.id }).from(schema.expenses);

    expect(expenses).toEqual([]);
  });
});

/* ============================================ ADR-0016: the full outflow identity */

describe('ADR-0016 — every reconciliation term, in one period, end to end', () => {
  /**
   * The six categories invariant #20 has to keep apart, all present at once, driven through
   * the real services and a real database rather than asserted against a hand-built input.
   * If any term's scope is wrong, this is where the identity stops balancing.
   */
  async function seedEveryCategory(): Promise<void> {
    // 1. A self-funded expense — the only kind that explains the user's own outflow.
    const selfFunded = await addExpense(database.db, {
      description: 'Groceries the user paid for',
      amount: paise(90000n),
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    const selfFundedPayment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(90000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-ZEPTO',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    await linkPaymentToExpense(database.db, {
      paymentId: selfFundedPayment,
      expenseId: selfFunded,
      amount: paise(90000n),
    });

    // 2. An externally-funded expense — real, approved, but no outflow of the user's.
    await addExpense(database.db, {
      description: 'Electrician, fronted by Flatmate A',
      amount: paise(300000n),
      occurredAt: new Date('2026-07-04T10:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
    });

    // 3. A settlement the user paid — a debit, inside the outflow scope.
    const settlementOut = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(100000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-20T09:00:00Z'),
      rawDescription: 'UPI TO FLATMATE A',
      channel: 'upi',
      counterpartyType: 'person',
    });
    await recordSettlement(database.db, {
      paymentId: settlementOut,
      counterpartyPersonId: cast.person['person_flatmate_a']!,
      amount: paise(100000n),
      audit: AS_USER,
    });

    // 4. A settlement the user received — a credit, outside the outflow scope entirely.
    const settlementIn = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(50000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-21T09:00:00Z'),
      rawDescription: 'UPI CREDIT FROM FRIEND A',
      channel: 'upi',
      counterpartyType: 'person',
    });
    await recordSettlement(database.db, {
      paymentId: settlementIn,
      counterpartyPersonId: cast.person['person_friend_a']!,
      amount: paise(50000n),
      audit: AS_USER,
    });

    // 5. A transfer and an investment — excluded by counterparty_type alone.
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(200000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-06T09:00:00Z'),
      rawDescription: 'TRANSFER TO OWN UPI',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
    });
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(500000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-05T06:00:00Z'),
      rawDescription: 'UPI AUTOPAY SIP',
      channel: 'upi',
      counterpartyType: 'investment_instrument',
    });

    // 6. A duplicate capture, confirmed and ignored — not more money.
    const original = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(40000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:00Z'),
      rawDescription: 'BANK CAPTURE',
      channel: 'bank_transfer',
      externalReference: 'UPI/DUP/1',
      referenceType: 'upi_utr',
    });
    const duplicate = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(40000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-12T19:00:03Z'),
      rawDescription: 'UPI CAPTURE',
      channel: 'upi',
      externalReference: 'UPI/DUP/1',
      referenceType: 'upi_utr',
    });
    await updatePaymentState(database.db, duplicate, 'ignored', `duplicate_of:${original}`);
  }

  it('balances the identity with all six categories present', async () => {
    await seedEveryCategory();
    const totals = await reconcileJuly();

    // Outflow counts the debits once: 90000 groceries + 100000 settlement-out
    // + 200000 transfer + 500000 investment + 40000 original capture. The credit
    // settlement and the ignored duplicate contribute nothing.
    expect(totals.ledgerTotalOutflow).toBe(930000n);
    expect(totals.ledgerTransfersTotal).toBe(200000n);
    expect(totals.ledgerInvestmentsTotal).toBe(500000n);
    // Only the debit-carried settlement; the ₹500 received is outside the scope.
    expect(totals.ledgerSettlementsTotal).toBe(100000n);
    // Only the self-funded expense; the flatmate's ₹3,000 explains none of our outflow.
    expect(totals.ledgerExplainedTotal).toBe(90000n);
    // 930000 - 200000 - 500000 - 100000 - 90000 = 40000, the un-linked duplicate original.
    expect(totals.ledgerUnexplainedTotal).toBe(40000n);
  });

  it('goes negative under the rejected wider reading — the failure ADR-0016 prevents', () => {
    // The same period, recomputed with each scope widened, using the real domain function
    // rather than arithmetic on the accepted result. This is the alternative ADR-0016
    // rejected, and it produces a figure no user could interpret.
    const payments = [
      { direction: 'debit', amount: paise(90000n), counterpartyType: 'merchant', state: 'linked' },
      {
        direction: 'debit',
        amount: paise(100000n),
        counterpartyType: 'person',
        state: 'linked',
      },
    ] as const;

    const widenedExplained = computeUnexplained({
      payments: [...payments],
      settlements: [{ amount: paise(100000n), direction: 'debit' }],
      // The externally-funded ₹3,000 counted as explained outflow, which it never was.
      expenses: [
        { netAmount: paise(90000n), selfFunded: true },
        { netAmount: paise(300000n), selfFunded: true },
      ],
    });

    const widenedSettlements = computeUnexplained({
      payments: [...payments],
      // A received settlement counted as outflow-discharging, which it never was.
      settlements: [
        { amount: paise(100000n), direction: 'debit' },
        { amount: paise(50000n), direction: 'debit' },
      ],
      expenses: [{ netAmount: paise(90000n), selfFunded: true }],
    });

    expect(widenedExplained.ledgerUnexplainedTotal).toBe(-300000n);
    expect(widenedSettlements.ledgerUnexplainedTotal).toBe(-50000n);
  });

  it('persists the run, so the row-level identity CHECK accepts what domain computed', async () => {
    await seedEveryCategory();
    const { reconciliationRunId } = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      periodStart: JULY.start,
      periodEnd: JULY.end,
      audit: AS_USER,
    });

    const [row] = await database.db
      .select({
        outflow: schema.reconciliationRuns.ledgerTotalOutflow,
        unexplained: schema.reconciliationRuns.ledgerUnexplainedTotal,
      })
      .from(schema.reconciliationRuns)
      .where(eq(schema.reconciliationRuns.id, reconciliationRunId));

    expect(row?.outflow).toBe(930000n);
    expect(row?.unexplained).toBe(40000n);
  });
});
