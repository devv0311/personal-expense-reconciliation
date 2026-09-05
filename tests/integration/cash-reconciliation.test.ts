/**
 * Account-level cash reconciliation through `services.runReconciliation`
 * (ADR-0017 (cash balance), 17.3–17.7).
 *
 * The point of every test here is that the two identities stay **independent**. ADR-0016's
 * outflow totals must come out exactly as they did before phase 16, on the same runs that now
 * also carry a per-account cash snapshot, and neither number may be derived from the other.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { AccountId, EvidenceId, Paise, ReconciliationRunId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import { getReconciliationAccountSnapshots, runReconciliation } from '../../src/services/index.js';
import type { AccountBoundaryInput } from '../../src/services/index.js';
import { addExpense, addPayment, linkPaymentToExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';

let database: TestDatabase;
let cast: Cast;

const audit = { actor: 'user', source: 'tests/cash-reconciliation' } as const;
const PERIOD_START = new Date('2026-07-01T00:00:00Z');
const PERIOD_END = new Date('2026-08-01T00:00:00Z');

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

/** A statement page, so a boundary balance can cite immutable evidence (17.5). */
async function statementEvidence(text: string): Promise<EvidenceId> {
  const [row] = await database.db
    .insert(schema.evidence)
    .values({ type: 'bank_line', rawText: text, capturedAt: PERIOD_END })
    .returning({ id: schema.evidence.id });
  return asId<'evidence'>(row!.id);
}

async function boundaries(
  accountId: AccountId,
  opening: Paise,
  closing: Paise,
): Promise<AccountBoundaryInput> {
  const evidenceId = await statementEvidence(`Statement for ${accountId}`);
  return {
    accountId,
    openingBalance: opening,
    openingBalanceEvidenceId: evidenceId,
    closingBalance: closing,
    closingBalanceEvidenceId: evidenceId,
  };
}

async function run(accountBoundaries: readonly AccountBoundaryInput[] = []) {
  return runReconciliation(database.db, {
    userPersonId: cast.userPersonId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    splitwise: createMockSplitwisePort(),
    accountBoundaries,
    audit,
  });
}

function snapshotFor(
  snapshots: Awaited<ReturnType<typeof run>>['accountSnapshots'],
  accountId: AccountId,
) {
  const found = snapshots.find((snapshot) => snapshot.accountId === accountId);
  if (found === undefined) throw new Error(`No snapshot for account ${accountId}`);
  return found;
}

const savings = () => cast.account['account_hdfc_savings']!;
const upi = () => cast.account['account_hdfc_upi']!;

describe('one snapshot per account, per run (17.6)', () => {
  it('writes a snapshot for every account, even one with no movements', async () => {
    const result = await run();

    expect(result.accountSnapshots).toHaveLength(Object.keys(cast.account).length);
    const persisted = await getReconciliationAccountSnapshots(
      database.db,
      result.reconciliationRunId as ReconciliationRunId,
    );
    expect(persisted).toHaveLength(result.accountSnapshots.length);
  });

  it('reports an account with no boundary evidence as incomplete, never as verified zero', async () => {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT',
      channel: 'upi',
    });

    const result = await run();
    const snapshot = snapshotFor(result.accountSnapshots, savings());

    expect(snapshot.verificationStatus).toBe('incomplete');
    expect(snapshot.expectedEndingBalance).toBeNull();
    expect(snapshot.cashBalanceDelta).toBeNull();
    expect(snapshot.totalDebits).toBe(124_000n);
    expect(snapshot.discrepancies.map((entry) => entry.kind)).toContain('missing_opening_balance');
  });

  it('verifies an account whose statement closes and whose movements are all explained', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT',
      channel: 'upi',
      counterpartyType: 'merchant',
      state: 'linked',
    });
    const expenseId = await addExpense(database.db, {
      description: 'Groceries',
      amount: paise(124_000n),
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await linkPaymentToExpense(database.db, {
      paymentId,
      expenseId,
      amount: paise(124_000n),
    });

    const result = await run([await boundaries(savings(), paise(500_000n), paise(376_000n))]);
    const snapshot = snapshotFor(result.accountSnapshots, savings());

    expect(snapshot.expectedEndingBalance).toBe(376_000n);
    expect(snapshot.cashBalanceDelta).toBe(0n);
    expect(snapshot.unexplainedDebits).toBe(0n);
    expect(snapshot.verificationStatus).toBe('verified');
  });

  it('reports a signed delta when the statement disagrees, without clamping (17.4)', async () => {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT',
      channel: 'upi',
    });

    const result = await run([await boundaries(savings(), paise(500_000n), paise(300_000n))]);
    const snapshot = snapshotFor(result.accountSnapshots, savings());

    expect(snapshot.expectedEndingBalance).toBe(376_000n);
    expect(snapshot.cashBalanceDelta).toBe(-76_000n);
    expect(snapshot.verificationStatus).toBe('unreconciled');
  });

  it('refuses to verify a closing statement over an unexplained credit (17.2, 17.6)', async () => {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(100_000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'NEFT CR MYSTERY',
      channel: 'bank_transfer',
    });

    const result = await run([await boundaries(savings(), paise(500_000n), paise(600_000n))]);
    const snapshot = snapshotFor(result.accountSnapshots, savings());

    // The arithmetic closes exactly, and the credit is still a mystery. A numeric zero over an
    // unidentified transaction is not a verified ₹0 Unaccounted Delta.
    expect(snapshot.cashBalanceDelta).toBe(0n);
    expect(snapshot.unexplainedCredits).toBe(100_000n);
    expect(snapshot.verificationStatus).toBe('unreconciled');
  });

  it('verifies each account independently — one account cannot cancel another (17.6)', async () => {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(100_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UNRECORDED WITHDRAWAL',
      channel: 'bank_transfer',
    });

    const result = await run([
      // Savings is short by ₹1,000; the UPI account is over by ₹1,000. Consolidated they
      // cancel; per account they are two real errors.
      await boundaries(savings(), paise(500_000n), paise(300_000n)),
      await boundaries(upi(), paise(0n), paise(100_000n)),
    ]);

    expect(snapshotFor(result.accountSnapshots, savings()).cashBalanceDelta).toBe(-100_000n);
    expect(snapshotFor(result.accountSnapshots, upi()).cashBalanceDelta).toBe(100_000n);
    expect(
      result.accountSnapshots.every((snapshot) => snapshot.verificationStatus !== 'verified'),
    ).toBe(true);
  });
});

describe('completeness — every distinct movement participates (17.6)', () => {
  it('drops a confirmed duplicate but keeps an out-of-scope movement', async () => {
    const canonical = await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT',
      channel: 'upi',
    });
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT (second capture)',
      channel: 'upi',
      state: 'ignored',
      ignoredReason: `duplicate_of:${canonical}`,
    });
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(50_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-04T10:00:00Z'),
      rawDescription: 'SOMETHING OUT OF LEDGER SCOPE',
      channel: 'bank_transfer',
      state: 'ignored',
      ignoredReason: 'out_of_scope',
    });

    const result = await run();
    const snapshot = snapshotFor(result.accountSnapshots, savings());

    // 124,000 counted once, plus the out-of-scope 50,000: excluded from *spend*, not from the
    // statement it genuinely appeared on.
    expect(snapshot.totalDebits).toBe(174_000n);
  });

  it('counts a purchase and its refund once each, never netted (17.4)', async () => {
    const purchaseId = await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(100_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    const expenseId = await addExpense(database.db, {
      description: 'Groceries',
      amount: paise(100_000n),
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await linkPaymentToExpense(database.db, {
      paymentId: purchaseId,
      expenseId,
      amount: paise(100_000n),
    });

    const refundId = await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(20_000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-06T10:00:00Z'),
      rawDescription: 'BLINKIT REFUND',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    await database.db.insert(schema.expenseAdjustments).values({
      originalExpenseId: expenseId,
      kind: 'merchant_refund',
      amount: 20_000n,
      adjustmentPaymentId: refundId,
      occurredAt: new Date('2026-07-06T10:00:00Z'),
    });

    const result = await run([await boundaries(savings(), paise(500_000n), paise(420_000n))]);
    const snapshot = snapshotFor(result.accountSnapshots, savings());

    expect(snapshot.totalDebits).toBe(100_000n);
    expect(snapshot.totalCredits).toBe(20_000n);
    expect(snapshot.explainedDebits).toBe(100_000n);
    expect(snapshot.explainedCredits).toBe(20_000n);
    expect(snapshot.verificationStatus).toBe('verified');
    // ADR-0016's own figure is unchanged by any of this: it sums the expense's *net* amount.
    expect(result.totals.ledgerExplainedTotal).toBe(80_000n);
    expect(result.totals.ledgerUnexplainedTotal).toBe(20_000n);
  });

  it('excludes movements outside the period, on both boundaries', async () => {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(10_000n),
      direction: 'debit',
      occurredAt: new Date('2026-06-30T23:59:59Z'),
      rawDescription: 'LAST MONTH',
      channel: 'upi',
    });
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(20_000n),
      direction: 'debit',
      occurredAt: PERIOD_END,
      rawDescription: 'NEXT MONTH — the interval is half-open',
      channel: 'upi',
    });
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(30_000n),
      direction: 'debit',
      occurredAt: PERIOD_START,
      rawDescription: 'THE FIRST MOMENT OF THIS MONTH',
      channel: 'upi',
    });

    const result = await run();

    expect(snapshotFor(result.accountSnapshots, savings()).totalDebits).toBe(30_000n);
  });
});

describe('internal transfers are cash-neutral across matched accounts (17.3)', () => {
  async function seedTransferLegs(reference: string | null): Promise<void> {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(150_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00Z'),
      rawDescription: 'NEFT TRANSFER TO SELF A/C X4821',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
      externalReference: reference,
    });
    await addPayment(database.db, cast, {
      accountId: upi(),
      amount: paise(150_000n),
      direction: 'credit',
      occurredAt: new Date('2026-07-02T10:00:10Z'),
      rawDescription: 'NEFT TRANSFER FROM SELF A/C X9013',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
      externalReference: reference,
    });
  }

  it('affects each account once and cancels on consolidation', async () => {
    await seedTransferLegs('NEFT/N072026001');

    const result = await run([
      await boundaries(savings(), paise(500_000n), paise(350_000n)),
      await boundaries(upi(), paise(0n), paise(150_000n)),
    ]);

    const out = snapshotFor(result.accountSnapshots, savings());
    const back = snapshotFor(result.accountSnapshots, upi());
    expect(out.internalTransferDebits).toBe(150_000n);
    expect(back.internalTransferCredits).toBe(150_000n);
    expect(out.internalTransferCredits + back.internalTransferDebits).toBe(0n);
    // Both accounts close, and no discrepancy: the money never left the user's own accounts.
    expect(out.verificationStatus).toBe('verified');
    expect(back.verificationStatus).toBe('verified');
  });

  it('creates no expense, income or peer debt for either leg', async () => {
    await seedTransferLegs('NEFT/N072026001');

    const result = await run();

    // The legacy identity puts both in `ledger_transfers_total`, and the cash identity counts
    // each leg once in its own account. Neither treats it as spending.
    expect(result.totals.ledgerTransfersTotal).toBe(150_000n);
    expect(result.totals.ledgerExplainedTotal).toBe(0n);
    expect(result.totals.ledgerUnexplainedTotal).toBe(0n);
  });

  it('surfaces a leg whose partner posts in another period as unpaired', async () => {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(150_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-31T23:00:00Z'),
      rawDescription: 'NEFT TRANSFER TO SELF A/C X4821',
      channel: 'bank_transfer',
      counterpartyType: 'internal_account',
      externalReference: 'NEFT/N072026099',
    });

    const result = await run([await boundaries(savings(), paise(500_000n), paise(350_000n))]);
    const snapshot = snapshotFor(result.accountSnapshots, savings());

    expect(snapshot.cashBalanceDelta).toBe(0n);
    expect(snapshot.discrepancies.map((entry) => entry.kind)).toContain(
      'unpaired_internal_transfer',
    );
    // The arithmetic closes; the transfer is still only half-observed, so it is not verified
    // and no balancing leg is invented to make it so.
    expect(snapshot.verificationStatus).toBe('unreconciled');
  });

  it('leaves both legs unpaired when neither carries a reference', async () => {
    await seedTransferLegs(null);

    const result = await run();

    const kinds = result.accountSnapshots.flatMap((snapshot) =>
      snapshot.discrepancies.map((entry) => entry.kind),
    );
    expect(kinds.filter((kind) => kind === 'unpaired_internal_transfer')).toHaveLength(2);
  });
});

describe('the two identities stay independent (17.4)', () => {
  it('leaves every ADR-0016 total exactly as it was before phase 16', async () => {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT',
      channel: 'upi',
    });

    const result = await run([await boundaries(savings(), paise(500_000n), paise(376_000n))]);

    expect(result.totals).toEqual({
      ledgerTotalOutflow: 124_000n,
      ledgerTransfersTotal: 0n,
      ledgerInvestmentsTotal: 0n,
      ledgerSettlementsTotal: 0n,
      ledgerExplainedTotal: 0n,
      ledgerUnexplainedTotal: 124_000n,
    });
    // Meanwhile the bank arithmetic closes perfectly. Two questions, two answers.
    expect(snapshotFor(result.accountSnapshots, savings()).cashBalanceDelta).toBe(0n);
  });

  it('persists the snapshots so a later run cannot reinterpret them (17.7)', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    const expenseId = await addExpense(database.db, {
      description: 'Groceries',
      amount: paise(124_000n),
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: paise(124_000n) });
    const first = await run();

    // A later run over the same period is a new report, not an edit of the old one.
    const second = await run([await boundaries(savings(), paise(500_000n), paise(376_000n))]);

    const firstSnapshots = await getReconciliationAccountSnapshots(
      database.db,
      first.reconciliationRunId as ReconciliationRunId,
    );
    const secondSnapshots = await getReconciliationAccountSnapshots(
      database.db,
      second.reconciliationRunId as ReconciliationRunId,
    );

    expect(
      firstSnapshots.find((snapshot) => snapshot.accountId === savings())?.verificationStatus,
    ).toBe('incomplete');
    expect(
      secondSnapshots.find((snapshot) => snapshot.accountId === savings())?.verificationStatus,
    ).toBe('verified');
  });

  it('retains the payment ids the run actually counted, as provenance (17.7)', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'UPI-BLINKIT',
      channel: 'upi',
    });

    const result = await run();
    const snapshot = snapshotFor(result.accountSnapshots, savings());

    expect(snapshot.provenance).toMatchObject({ countedPaymentIds: [paymentId] });
  });

  it('audits every snapshot it writes', async () => {
    const result = await run();

    const events = await database.db
      .select({ entityId: schema.auditEvents.entityId })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'reconciliation_account_snapshot'));

    expect(events).toHaveLength(result.accountSnapshots.length);
  });

  it('revives a discrepancy amount as an exact bigint, never a float', async () => {
    await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(9_007_199_254_740_993n), // 2^53 + 1
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00Z'),
      rawDescription: 'A VERY LARGE WITHDRAWAL',
      channel: 'bank_transfer',
    });

    const result = await run();
    const persisted = await getReconciliationAccountSnapshots(
      database.db,
      result.reconciliationRunId as ReconciliationRunId,
    );
    const snapshot = persisted.find((entry) => entry.accountId === savings());
    const unexplained = snapshot?.discrepancies.find(
      (entry) => entry.kind === 'unexplained_debits',
    );

    expect(unexplained?.amount).toBe(9_007_199_254_740_993n);
  });
});
