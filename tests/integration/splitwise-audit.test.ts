/**
 * The Splitwise drift & ghost-debt auditing engine, end to end (`docs/roadmap.md` phase 19,
 * ADR-0046).
 *
 * The pure attribution arithmetic is `src/domain/splitwise-audit.test.ts`. This file covers
 * what only a real database and the real services can show: that findings are durable and
 * reviewable, that a rerun is recognised as a rerun, that history survives supersession, that
 * a failed or unsupported external read is recorded as an incomplete audit rather than a clean
 * one — and that none of it touches the canonical ledger or writes anything to Splitwise.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type {
  BeneficiaryRef,
  ExpenseId,
  ExpenseItemId,
  PersonId,
  SettlementId,
  SplitwiseAuditFindingId,
} from '../../src/domain/index.js';
import { listAuditEvents, schema } from '../../src/db/index.js';
import {
  approveAllocation,
  connectSplitwiseIntegration,
  distributeAdjustment,
  getAuditFinding,
  getBalance,
  getSplitwiseAuditRun,
  listAuditFindings,
  listSplitwiseAuditRunHistory,
  recordExpenseAdjustment,
  recordSettlement,
  reviewSplitwiseAuditFinding,
  runReconciliation,
  runSplitwiseAudit,
  syncExpenseToSplitwise,
  syncSettlementToSplitwise,
  transitionExpense,
} from '../../src/services/index.js';
import type { SplitwiseLedgerEntry } from '../../src/integrations/splitwise/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import {
  addExpense,
  addExpenseItem,
  addPayment,
  linkPaymentToExpense,
  seedCast,
} from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createAggregateOnlySplitwisePort, createMockSplitwisePort } from '../support/splitwise.js';

const AS_USER = { actor: 'user', source: 'tests/integration/splitwise-audit' } as const;
const OCCURRED_AT = new Date('2026-07-10T19:20:00.000Z');
const REFUNDED_AT = new Date('2026-07-15T10:00:00.000Z');
const JULY = {
  periodStart: new Date('2026-07-01T00:00:00.000Z'),
  periodEnd: new Date('2026-08-01T00:00:00.000Z'),
};

let database: TestDatabase;
let cast: Cast;
let splitwise: ReturnType<typeof createMockSplitwisePort>;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  splitwise = createMockSplitwisePort();
});

/* ------------------------------------------------------------------ seeding helpers */

function friendA(): PersonId {
  return cast.person['person_friend_a']!;
}

async function linkSplitwiseUser(personId: PersonId, splitwiseUserId: string): Promise<void> {
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId })
    .where(eq(schema.people.id, personId));
}

async function connectAndLink(): Promise<void> {
  await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
  await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
  await linkSplitwiseUser(friendA(), 'sw-friend-a');
}

/** A ₹900 dinner split evenly with Friend A, synced to Splitwise as `sw-expense-1`. */
async function syncedDinner(): Promise<ExpenseId> {
  const expenseId = await addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(90_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
  const beneficiaries: BeneficiaryRef[] = [
    { type: 'person', id: cast.userPersonId },
    { type: 'person', id: friendA() },
  ];
  await approveAllocation(database.db, {
    expenseId,
    decision: { method: 'equal', beneficiaries },
    decidedBy: 'manual',
    audit: AS_USER,
  });
  await transitionExpense(database.db, { expenseId, to: 'ready_to_sync', audit: AS_USER });
  await syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER });
  return expenseId;
}

/** ADR-0018's worked basket: the user's ₹600 item and Friend A's ₹400 item, one ₹1,000 payment. */
async function syncedBasket(): Promise<{
  expenseId: ExpenseId;
  mine: ExpenseItemId;
  theirs: ExpenseItemId;
}> {
  const expenseId = await addExpense(database.db, {
    description: 'Blinkit basket',
    amount: paise(100_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
  const paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_upi']!,
    amount: paise(100_000n),
    direction: 'debit',
    occurredAt: OCCURRED_AT,
    rawDescription: 'UPI-BLINKIT-blinkit@axl',
    channel: 'upi',
    counterpartyType: 'merchant',
  });
  await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: paise(100_000n) });

  const mine = await addExpenseItem(database.db, {
    expenseId,
    description: 'Groceries (mine)',
    amount: paise(60_000n),
  });
  const theirs = await addExpenseItem(database.db, {
    expenseId,
    description: 'Cold brew (theirs)',
    amount: paise(40_000n),
  });

  await approveAllocation(database.db, {
    expenseId,
    decision: {
      method: 'item_based',
      lines: [
        { beneficiary: { type: 'person', id: cast.userPersonId }, expenseItemId: mine },
        { beneficiary: { type: 'person', id: friendA() }, expenseItemId: theirs },
      ],
    },
    decidedBy: 'manual',
    audit: AS_USER,
  });
  await transitionExpense(database.db, { expenseId, to: 'ready_to_sync', audit: AS_USER });
  await syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER });
  return { expenseId, mine, theirs };
}

async function recordRepayment(amount: bigint): Promise<SettlementId> {
  const paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(amount),
    direction: 'debit',
    occurredAt: OCCURRED_AT,
    rawDescription: 'UPI-FRIEND-TRANSFER',
    channel: 'upi',
    state: 'normalized',
  });
  const { settlementId } = await recordSettlement(database.db, {
    paymentId,
    counterpartyPersonId: friendA(),
    amount: paise(amount),
    audit: AS_USER,
  });
  return settlementId as SettlementId;
}

type EntryOverrides = Omit<Partial<SplitwiseLedgerEntry>, 'pairNetBalance'> & {
  readonly pairNetBalance: bigint;
};

function externalExpense(overrides: EntryOverrides): SplitwiseLedgerEntry {
  return {
    splitwiseEntryId: 'sw-expense-1',
    kind: 'expense',
    description: 'Group dinner',
    totalAmount: paise(90_000n),
    currency: 'INR',
    deleted: false,
    occurredAt: OCCURRED_AT,
    ...overrides,
    pairNetBalance: paise(overrides.pairNetBalance),
  };
}

function externalPayment(overrides: EntryOverrides): SplitwiseLedgerEntry {
  return externalExpense({
    splitwiseEntryId: 'sw-payment-1',
    kind: 'payment',
    description: 'Repayment',
    totalAmount: paise(50_000n),
    ...overrides,
  });
}

function scriptSplitwise(
  netBalance: bigint,
  entries: readonly SplitwiseLedgerEntry[],
  options: { readonly complete?: boolean; readonly incompleteReason?: string } = {},
): void {
  splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(netBalance) }]);
  splitwise.setLedgerEntries('sw-friend-a', entries, options);
}

async function audit(): Promise<Awaited<ReturnType<typeof runSplitwiseAudit>>> {
  return runSplitwiseAudit(database.db, {
    userPersonId: cast.userPersonId,
    splitwise,
    audit: AS_USER,
  });
}

function kindsOf(findings: readonly { kind: string }[]): string[] {
  return [...findings].map((finding) => finding.kind).sort();
}

/* =========================================================================== agreement */

describe('runSplitwiseAudit — agreement', () => {
  beforeEach(connectAndLink);

  it('finds nothing when both ledgers hold the same entry at the same amount', async () => {
    await syncedDinner();
    scriptSplitwise(-45_000n, [externalExpense({ pairNetBalance: -45_000n })]);

    const result = await audit();

    expect(result.externalReadStatus).toBe('complete');
    expect(result.findings).toEqual([]);
    expect(result.findingsCreated).toBe(0);
  });

  it('records the run itself even when it finds nothing, with its provenance', async () => {
    await syncedDinner();
    scriptSplitwise(-45_000n, [externalExpense({ pairNetBalance: -45_000n })]);

    const result = await audit();
    const history = await listSplitwiseAuditRunHistory(database.db, {});

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: result.splitwiseAuditRunId,
      externalReadStatus: 'complete',
      pairsAudited: 1,
      pairsUnchecked: 0,
    });
    expect(history[0]?.externalBalancesSnapshot).toEqual([
      { splitwiseUserId: 'sw-friend-a', netBalance: '-45000' },
    ]);
  });
});

/* ============================================================ attributable disagreements */

describe('runSplitwiseAudit — attributable causes', () => {
  beforeEach(connectAndLink);

  it('names a synced expense missing from Splitwise, with both snapshots', async () => {
    const expenseId = await syncedDinner();
    scriptSplitwise(0n, []);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['missing_external_expense']);
    const finding = result.findings[0]!;
    expect(finding).toMatchObject({
      scope: 'expense',
      findingClass: 'discrepancy',
      confidence: 'high',
      amount: 45_000n,
      balanceImpact: 45_000n,
      expenseId,
      externalReference: 'sw-expense-1',
      personAId: cast.userPersonId,
      personBId: friendA(),
      reviewStatus: 'open',
    });
    expect(finding.localSnapshot).toMatchObject({ friendShareNow: '45000' });
    expect(finding.externalSnapshot).toMatchObject({ present: false });
    expect(finding.evidence).toEqual(expect.arrayContaining([{ type: 'expense', id: expenseId }]));
  });

  it('names a duplicated external expense without asserting which one is real', async () => {
    await syncedDinner();
    scriptSplitwise(-90_000n, [
      externalExpense({ pairNetBalance: -45_000n }),
      externalExpense({ splitwiseEntryId: 'sw-expense-dup', pairNetBalance: -45_000n }),
    ]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['duplicate_external_expense']);
    expect(result.findings[0]).toMatchObject({
      confidence: 'medium',
      externalReference: 'sw-expense-dup',
      expenseId: null,
    });
  });

  it('names an external expense with no local support as ghost debt', async () => {
    scriptSplitwise(-30_000n, [
      externalExpense({
        splitwiseEntryId: 'sw-expense-ghost',
        description: 'Cab I never took',
        totalAmount: paise(60_000n),
        pairNetBalance: -30_000n,
      }),
    ]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['unsupported_ghost_debt']);
    expect(result.findings[0]).toMatchObject({
      scope: 'external_entry',
      externalReference: 'sw-expense-ghost',
      amount: 30_000n,
    });
  });

  it('names a genuine amount disagreement on a record both sides hold', async () => {
    await syncedDinner();
    scriptSplitwise(-50_000n, [externalExpense({ pairNetBalance: -50_000n })]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['external_amount_disagreement']);
    expect(result.findings[0]).toMatchObject({ amount: 5_000n, confidence: 'high' });
  });

  it('names a recorded settlement Splitwise never received', async () => {
    await syncedDinner();
    const settlementId = await recordRepayment(50_000n);
    scriptSplitwise(-45_000n, [externalExpense({ pairNetBalance: -45_000n })]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['missing_external_settlement']);
    expect(result.findings[0]).toMatchObject({
      scope: 'settlement',
      settlementId,
      amount: 50_000n,
      balanceImpact: 50_000n,
    });
  });

  it('names a duplicated external payment', async () => {
    await syncedDinner();
    const settlementId = await recordRepayment(50_000n);
    await syncSettlementToSplitwise(database.db, { settlementId, splitwise, audit: AS_USER });
    scriptSplitwise(-145_000n, [
      externalExpense({ pairNetBalance: -45_000n }),
      externalPayment({ pairNetBalance: -50_000n }),
      externalPayment({ splitwiseEntryId: 'sw-payment-dup', pairNetBalance: -50_000n }),
    ]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['duplicate_external_settlement']);
    expect(result.findings[0]).toMatchObject({ externalReference: 'sw-payment-dup' });
  });

  it('names an external payment the ledger has no Settlement for, and creates none', async () => {
    await syncedDinner();
    scriptSplitwise(0n, [
      externalExpense({ pairNetBalance: -45_000n }),
      externalPayment({
        splitwiseEntryId: 'sw-payment-unknown',
        totalAmount: paise(45_000n),
        pairNetBalance: 45_000n,
      }),
    ]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['unrecorded_external_settlement']);

    const settlements = await database.db.select().from(schema.settlements);
    expect(settlements).toEqual([]);
  });
});

/* ============================================================ stale versus drifted */

describe('runSplitwiseAudit — stale (our side) stays distinct from drifted (theirs)', () => {
  beforeEach(connectAndLink);

  it('names a stale partial whole-expense refund and what it leaves unsupported', async () => {
    const expenseId = await syncedDinner();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(10_000n),
      occurredAt: REFUNDED_AT,
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });
    scriptSplitwise(-45_000n, [externalExpense({ pairNetBalance: -45_000n })]);

    const [row] = await database.db
      .select({ syncStatus: schema.splitwiseExpenses.syncStatus })
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    expect(row?.syncStatus).toBe('stale');

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['stale_refund_partial']);
    expect(result.findings[0]).toMatchObject({
      amount: 5_000n,
      balanceImpact: -5_000n,
      expenseId,
      confidence: 'high',
    });
    expect(result.findings[0]?.localSnapshot).toMatchObject({
      syncStatus: 'stale',
      refundBasis: 'whole_expense',
    });
  });

  it('names a stale full refund distinctly from a partial one', async () => {
    const expenseId = await syncedDinner();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(90_000n),
      occurredAt: REFUNDED_AT,
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });
    scriptSplitwise(-45_000n, [externalExpense({ pairNetBalance: -45_000n })]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['stale_refund_full']);
    expect(result.findings[0]?.amount).toBe(45_000n);
  });

  it('names an unreflected item-attributed refund as its own cause', async () => {
    const basket = await syncedBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });
    scriptSplitwise(-40_000n, [
      externalExpense({
        description: 'Blinkit basket',
        totalAmount: paise(100_000n),
        pairNetBalance: -40_000n,
      }),
    ]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['unreflected_item_refund']);
    expect(result.findings[0]).toMatchObject({
      amount: 15_000n,
      balanceImpact: -15_000n,
      expenseId: basket.expenseId,
    });
    expect(result.findings[0]?.localSnapshot).toMatchObject({ refundBasis: 'item_attributed' });
    // The refund came off the friend's own item, so only their share moved (ADR-0045).
    expect(await shareOf(basket.expenseId, cast.userPersonId)).toBe(60_000n);
    expect(await shareOf(basket.expenseId, friendA())).toBe(25_000n);
  });

  it('surfaces a reverse balance when a settled expense is later refunded', async () => {
    const basket = await syncedBasket();
    const settlementPaymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(40_000n),
      direction: 'credit',
      occurredAt: OCCURRED_AT,
      rawDescription: 'UPI-FRIEND-A-REPAYMENT',
      channel: 'upi',
      state: 'normalized',
    });
    await recordSettlement(database.db, {
      paymentId: settlementPaymentId,
      counterpartyPersonId: friendA(),
      amount: paise(40_000n),
      audit: AS_USER,
    });
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(40_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(40_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    // The friend paid their ₹400 share and the item came back: the user now owes them.
    const reversed = await getBalance(database.db, cast.userPersonId, cast.userPersonId, friendA());
    expect(reversed.netBalance).toBe(40_000n);

    scriptSplitwise(-40_000n, [
      externalExpense({
        description: 'Blinkit basket',
        totalAmount: paise(100_000n),
        pairNetBalance: -40_000n,
      }),
    ]);
    const result = await audit();

    expect(kindsOf(result.findings)).toEqual([
      'missing_external_settlement',
      'unreflected_item_refund',
    ]);
    // The already-recorded settlement is untouched — a refund never rewrites a discharge.
    const settlements = await database.db.select().from(schema.settlements);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.amount).toBe(40_000n);
  });

  it('never reports a `drifted` row as if our side had changed', async () => {
    const expenseId = await syncedDinner();
    await database.db
      .update(schema.splitwiseExpenses)
      .set({ syncStatus: 'drifted' })
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    scriptSplitwise(-60_000n, [externalExpense({ pairNetBalance: -60_000n })]);

    const result = await audit();

    expect(kindsOf(result.findings)).toEqual(['external_amount_disagreement']);
    expect(kindsOf(result.findings)).not.toContain('stale_refund_partial');
  });
});

/* ================================================== incomplete reads are never agreement */

describe('runSplitwiseAudit — an unread Splitwise is never a clean one', () => {
  it('records a skipped run when no integration is connected, and calls nothing', async () => {
    let called = false;
    const watched = {
      ...splitwise,
      fetchBalances: () => {
        called = true;
        return splitwise.fetchBalances();
      },
    };

    const result = await runSplitwiseAudit(database.db, {
      userPersonId: cast.userPersonId,
      splitwise: watched,
      audit: AS_USER,
    });

    expect(called).toBe(false);
    expect(result.externalReadStatus).toBe('skipped');
    expect(result.findings).toEqual([]);
    expect(result.externalReadDetail).toContain('nothing is claimed to agree');
  });

  it('records a fetchBalances failure as an incomplete audit, not zero findings', async () => {
    await connectAndLink();
    await syncedDinner();
    splitwise.failNextFetchBalances('sandbox unreachable');

    const result = await audit();

    expect(result.externalReadStatus).toBe('failed');
    expect(kindsOf(result.findings)).toEqual(['external_read_failed']);
    expect(result.findings[0]).toMatchObject({ scope: 'integration', findingClass: 'incomplete' });
    expect(result.findings[0]?.summary).toContain('sandbox unreachable');
  });

  it('records an unsupported per-entry read and attributes nothing to a specific record', async () => {
    await connectAndLink();
    await syncedDinner();
    const aggregateOnly = createAggregateOnlySplitwisePort();
    aggregateOnly.setFriendBalances([
      { splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_555n) },
    ]);

    const result = await runSplitwiseAudit(database.db, {
      userPersonId: cast.userPersonId,
      splitwise: aggregateOnly,
      audit: AS_USER,
    });

    expect(result.externalReadStatus).toBe('unsupported');
    expect(kindsOf(result.findings)).toEqual([
      'external_read_unsupported',
      'unattributed_balance_mismatch',
    ]);
    const mismatch = result.findings.find(
      (finding) => finding.kind === 'unattributed_balance_mismatch',
    );
    expect(mismatch).toMatchObject({
      scope: 'pair',
      confidence: 'unknown',
      amount: 555n,
      expenseId: null,
      externalReference: null,
    });
  });

  it('records a per-entry read failure without inventing a missing expense', async () => {
    await connectAndLink();
    await syncedDinner();
    splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_000n) }]);
    splitwise.failNextFetchLedgerEntries('entry listing timed out');

    const result = await audit();

    expect(result.externalReadStatus).toBe('failed');
    expect(kindsOf(result.findings)).toEqual(['external_read_failed']);
    expect(result.findings[0]?.scope).toBe('pair');
  });

  it('never reports anything missing from a partial listing', async () => {
    await connectAndLink();
    await syncedDinner();
    scriptSplitwise(-45_000n, [], { complete: false, incompleteReason: 'page truncated' });

    const result = await audit();

    expect(result.externalReadStatus).toBe('partial');
    expect(kindsOf(result.findings)).toEqual(['external_read_partial']);
    expect(result.findings[0]?.summary).toContain('page truncated');
  });

  it('downgrades a listing that cannot account for the balance Splitwise reported', async () => {
    await connectAndLink();
    await syncedDinner();
    scriptSplitwise(-90_000n, [externalExpense({ pairNetBalance: -45_000n })]);

    const result = await audit();

    expect(result.externalReadStatus).toBe('partial');
    // Nothing is reported missing from the short listing; the gap it cannot account for is
    // reported as exactly that, with no culprit named.
    expect(kindsOf(result.findings)).toEqual([
      'external_read_partial',
      'unattributed_balance_mismatch',
    ]);
    expect(
      result.findings.find((finding) => finding.kind === 'unattributed_balance_mismatch'),
    ).toMatchObject({ confidence: 'unknown', amount: 45_000n });
  });

  it('records a friend Splitwise did not report as inaccessible, never as settled', async () => {
    await connectAndLink();
    await syncedDinner();
    splitwise.setFriendBalances([]);

    const result = await audit();

    expect(result.pairsUnchecked).toBe(1);
    expect(kindsOf(result.findings)).toEqual(['external_record_inaccessible']);
    expect(result.findings[0]?.findingClass).toBe('incomplete');
  });
});

/* ================================================================= permanent limitations */

describe('runSplitwiseAudit — limitations stay visible', () => {
  beforeEach(connectAndLink);

  it('records a non-user pair as uncheckable rather than counting it as agreed', async () => {
    const flatmateA = cast.person['person_flatmate_a']!;
    const flatmateC = cast.person['person_flatmate_c']!;
    const expenseId = await addExpense(database.db, {
      description: 'Electrician (Flatmate A paid)',
      amount: paise(300_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'household_shared_flat',
      paidByPersonId: flatmateA,
      state: 'approved',
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: flatmateA },
          { type: 'person', id: flatmateC },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    scriptSplitwise(0n, []);

    const result = await audit();

    const limitation = result.findings.find(
      (finding) => finding.kind === 'non_user_settlement_unobservable',
    );
    expect(limitation).toMatchObject({
      findingClass: 'limitation',
      confidence: 'unknown',
      balanceImpact: 0n,
      amount: 150_000n,
    });
    expect([limitation?.personAId, limitation?.personBId].sort()).toEqual(
      [flatmateA, flatmateC].sort(),
    );
  });

  it('records cross-payer expenses as unattributable rather than agreed', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Friend A fronted the tickets',
      amount: paise(80_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'shared',
      paidByPersonId: friendA(),
      state: 'approved',
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: friendA() },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    scriptSplitwise(40_000n, []);

    const result = await audit();

    expect(kindsOf(result.findings)).toContain('cross_payer_attribution_unavailable');
    const limitation = result.findings.find(
      (finding) => finding.kind === 'cross_payer_attribution_unavailable',
    );
    expect(limitation).toMatchObject({ findingClass: 'limitation', amount: 40_000n });
  });
});

/* ======================================================================= idempotency */

describe('runSplitwiseAudit — rerunning is deterministic', () => {
  beforeEach(connectAndLink);

  it('an unchanged rerun creates no second finding, and records it as seen again', async () => {
    await syncedDinner();
    scriptSplitwise(0n, []);

    const first = await audit();
    const second = await audit();

    expect(first.findingsCreated).toBe(1);
    expect(second.findingsCreated).toBe(0);
    expect(second.findingsReobserved).toBe(1);
    expect(second.findingsSuperseded).toBe(0);

    const all = await listAuditFindings(database.db, { includeSuperseded: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(first.findings[0]?.id);
    expect(all[0]?.lastObservedAuditRunId).toBe(second.splitwiseAuditRunId);
    expect(all[0]?.auditRunId).toBe(first.splitwiseAuditRunId);
  });

  it('writes no audit event for a re-observation, so a quiet rerun is quiet', async () => {
    await syncedDinner();
    scriptSplitwise(0n, []);
    const first = await audit();
    const findingId = first.findings[0]!.id;

    await audit();

    const events = await listAuditEvents(database.db, 'splitwise_audit_finding', findingId);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('create');
  });

  it('supersedes rather than rewrites when the comparison materially changes', async () => {
    scriptSplitwise(-30_000n, [
      externalExpense({ splitwiseEntryId: 'sw-expense-ghost', pairNetBalance: -30_000n }),
    ]);
    const first = await audit();
    const original = first.findings[0]!;
    expect(original.kind).toBe('unsupported_ghost_debt');

    // The same ghost entry, now for a different amount: same cause, same record, new figures.
    scriptSplitwise(-35_000n, [
      externalExpense({ splitwiseEntryId: 'sw-expense-ghost', pairNetBalance: -35_000n }),
    ]);
    const second = await audit();

    expect(second.findingsSuperseded).toBe(1);
    expect(second.findingsCreated).toBe(1);

    const history = await listAuditFindings(database.db, { includeSuperseded: true });
    const superseded = history.find((finding) => finding.id === original.id)!;
    const replacement = history.find((finding) => finding.id !== original.id)!;
    expect(superseded.supersededAt).not.toBeNull();
    expect(superseded.supersedeReason).toBe('materially_changed');
    expect(superseded.supersededByFindingId).toBe(replacement.id);
    expect(replacement.amount).toBe(35_000n);
    // The superseded row still says exactly what it said when it was written.
    expect(superseded.localSnapshot).toEqual(original.localSnapshot);
    expect(superseded.amount).toBe(30_000n);
    expect(superseded.summary).toBe(original.summary);
    expect(superseded.fingerprint).toBe(replacement.fingerprint);
  });

  it('closes a finding that no longer reproduces under a complete read', async () => {
    await syncedDinner();
    scriptSplitwise(0n, []);
    const first = await audit();

    scriptSplitwise(-45_000n, [externalExpense({ pairNetBalance: -45_000n })]);
    const second = await audit();

    expect(second.findings).toEqual([]);
    const history = await listAuditFindings(database.db, { includeSuperseded: true });
    const closed = history.find((finding) => finding.id === first.findings[0]?.id)!;
    expect(closed.supersedeReason).toBe('no_longer_observed');
  });

  it('never closes an external-evidence finding on the strength of a failed read', async () => {
    await syncedDinner();
    scriptSplitwise(0n, []);
    const first = await audit();

    splitwise.failNextFetchBalances('sandbox unreachable');
    const second = await audit();

    expect(second.externalReadStatus).toBe('failed');
    const stillOpen = await listAuditFindings(database.db, {});
    expect(stillOpen.map((finding) => finding.id)).toContain(first.findings[0]?.id);
  });
});

/* ============================================================== review and resolution */

describe('reviewSplitwiseAuditFinding', () => {
  beforeEach(connectAndLink);

  async function openFinding(): Promise<SplitwiseAuditFindingId> {
    await syncedDinner();
    scriptSplitwise(0n, []);
    const result = await audit();
    return asId<'splitwise_audit_finding'>(result.findings[0]!.id);
  }

  it('records the decision with actor, time and reason, and preserves the evidence', async () => {
    const findingId = await openFinding();
    const before = await getAuditFinding(database.db, findingId);

    const result = await reviewSplitwiseAuditFinding(database.db, {
      findingId,
      decision: 'resolved',
      reason: 'Re-created the expense on Splitwise by hand.',
      audit: { actor: 'user', source: 'tests' },
    });

    expect(result).toMatchObject({ reviewStatus: 'resolved', reviewedBy: 'user' });
    const after = await getAuditFinding(database.db, findingId);
    expect(after?.finding).toMatchObject({
      reviewStatus: 'resolved',
      reviewedBy: 'user',
      reviewReason: 'Re-created the expense on Splitwise by hand.',
    });
    // Reviewing changes what a person concluded, never what was compared.
    expect(after?.finding.localSnapshot).toEqual(before?.finding.localSnapshot);
    expect(after?.finding.externalSnapshot).toEqual(before?.finding.externalSnapshot);
    expect(after?.finding.evidence).toEqual(before?.finding.evidence);
    expect(after?.finding.amount).toBe(before?.finding.amount);
  });

  it('keeps every decision in an append-only history', async () => {
    const findingId = await openFinding();

    await reviewSplitwiseAuditFinding(database.db, {
      findingId,
      decision: 'acknowledged',
      audit: { actor: 'user', source: 'tests' },
    });
    await reviewSplitwiseAuditFinding(database.db, {
      findingId,
      decision: 'resolved',
      reason: 'Fixed on Splitwise.',
      audit: { actor: 'user:alex', source: 'tests' },
    });

    const detail = await getAuditFinding(database.db, findingId);
    const decisions = detail!.history.filter((event) => event.action === 'update');
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.newValue).toMatchObject({ reviewStatus: 'acknowledged' });
    expect(decisions[1]?.oldValue).toMatchObject({ reviewStatus: 'acknowledged' });
    expect(decisions[1]?.newValue).toMatchObject({ reviewStatus: 'resolved' });
    expect(decisions[1]?.actor).toBe('user:alex');
  });

  it('refuses to close a finding with no stated reason', async () => {
    const findingId = await openFinding();

    await expect(
      reviewSplitwiseAuditFinding(database.db, {
        findingId,
        decision: 'resolved',
        audit: { actor: 'user', source: 'tests' },
      }),
    ).rejects.toThrow(/must record why/);
  });

  it('refuses a review by anything other than a person', async () => {
    const findingId = await openFinding();

    await expect(
      reviewSplitwiseAuditFinding(database.db, {
        findingId,
        decision: 'dismissed',
        reason: 'automated',
        audit: { actor: 'system', source: 'tests' },
      }),
    ).rejects.toThrow(/never a rule, a model or the system/);
  });

  it('refuses to review a superseded finding, and keeps its record intact', async () => {
    const findingId = await openFinding();
    await reviewSplitwiseAuditFinding(database.db, {
      findingId,
      decision: 'acknowledged',
      audit: { actor: 'user', source: 'tests' },
    });

    scriptSplitwise(-45_000n, [externalExpense({ pairNetBalance: -45_000n })]);
    await audit();

    await expect(
      reviewSplitwiseAuditFinding(database.db, {
        findingId,
        decision: 'resolved',
        reason: 'too late',
        audit: { actor: 'user', source: 'tests' },
      }),
    ).rejects.toThrow(/superseded/);

    const detail = await getAuditFinding(database.db, findingId);
    expect(detail?.finding.reviewStatus).toBe('acknowledged');
    expect(detail?.finding.reviewedBy).toBe('user');
  });

  it('does not re-raise a resolved finding on an unchanged rerun', async () => {
    const findingId = await openFinding();
    await reviewSplitwiseAuditFinding(database.db, {
      findingId,
      decision: 'resolved',
      reason: 'Known Splitwise-side deletion; will re-create.',
      audit: { actor: 'user', source: 'tests' },
    });

    const rerun = await audit();

    expect(rerun.findingsCreated).toBe(0);
    expect(rerun.findingsReobserved).toBe(1);
    const all = await listAuditFindings(database.db, { includeSuperseded: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.reviewStatus).toBe('resolved');
  });

  it('supersedes a resolved finding when the comparison materially changes again', async () => {
    scriptSplitwise(-30_000n, [
      externalExpense({ splitwiseEntryId: 'sw-expense-ghost', pairNetBalance: -30_000n }),
    ]);
    const first = await audit();
    const findingId = asId<'splitwise_audit_finding'>(first.findings[0]!.id);
    await reviewSplitwiseAuditFinding(database.db, {
      findingId,
      decision: 'resolved',
      reason: 'Handled.',
      audit: { actor: 'user', source: 'tests' },
    });

    scriptSplitwise(-35_000n, [
      externalExpense({ splitwiseEntryId: 'sw-expense-ghost', pairNetBalance: -35_000n }),
    ]);
    await audit();

    const all = await listAuditFindings(database.db, { includeSuperseded: true });
    const original = all.find((finding) => finding.id === findingId)!;
    // The decision that was made is still on the record it was made about.
    expect(original.reviewStatus).toBe('resolved');
    expect(original.reviewReason).toBe('Handled.');
    expect(original.reviewedBy).toBe('user');
    expect(original.supersededAt).not.toBeNull();
    expect(original.supersedeReason).toBe('materially_changed');

    const current = await listAuditFindings(database.db, {});
    expect(current).toHaveLength(1);
    expect(current[0]?.reviewStatus).toBe('open');
    expect(current[0]?.amount).toBe(35_000n);
  });
});

/* ======================================================== the ledger stays canonical */

describe('the audit explains the ledger without changing it', () => {
  beforeEach(connectAndLink);

  it('mutates no source Payment, expense, allocation, settlement or balance', async () => {
    const expenseId = await syncedDinner();
    const settlementId = await recordRepayment(50_000n);
    scriptSplitwise(-99_999n, [
      externalExpense({ pairNetBalance: -45_000n }),
      externalExpense({ splitwiseEntryId: 'sw-expense-ghost', pairNetBalance: -54_999n }),
    ]);

    const before = await ledgerSnapshot();
    const balanceBefore = await getBalance(
      database.db,
      cast.userPersonId,
      cast.userPersonId,
      friendA(),
    );

    const result = await audit();
    await reviewSplitwiseAuditFinding(database.db, {
      findingId: asId<'splitwise_audit_finding'>(result.findings[0]!.id),
      decision: 'acknowledged',
      audit: { actor: 'user', source: 'tests' },
    });

    expect(await ledgerSnapshot()).toEqual(before);
    const balanceAfter = await getBalance(
      database.db,
      cast.userPersonId,
      cast.userPersonId,
      friendA(),
    );
    expect(balanceAfter.netBalance).toBe(balanceBefore.netBalance);
    expect(expenseId).toBeDefined();
    expect(settlementId).toBeDefined();
  });

  it('calls no Splitwise write during the audit or the review', async () => {
    await syncedDinner();
    const writesBefore = {
      expenses: splitwise.createdExpenses.length,
      payments: splitwise.recordedPayments.length,
    };
    scriptSplitwise(0n, []);

    const result = await audit();
    await reviewSplitwiseAuditFinding(database.db, {
      findingId: asId<'splitwise_audit_finding'>(result.findings[0]!.id),
      decision: 'resolved',
      reason: 'Will re-create by hand — this does not authorize a write.',
      audit: { actor: 'user', source: 'tests' },
    });

    expect(splitwise.createdExpenses).toHaveLength(writesBefore.expenses);
    expect(splitwise.recordedPayments).toHaveLength(writesBefore.payments);
  });

  it('leaves sync statuses exactly as it found them', async () => {
    const expenseId = await syncedDinner();
    scriptSplitwise(0n, []);

    await audit();

    const [row] = await database.db
      .select({ syncStatus: schema.splitwiseExpenses.syncStatus })
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    expect(row?.syncStatus).toBe('synced');
  });
});

/* ============================================================ reconciliation provenance */

describe('runReconciliation runs the audit alongside its own comparison', () => {
  it('links the audit to the reconciliation run and reads one fetchBalances', async () => {
    await connectAndLink();
    await syncedDinner();
    scriptSplitwise(0n, []);
    let balanceReads = 0;
    const counted = {
      ...splitwise,
      fetchBalances: () => {
        balanceReads += 1;
        return splitwise.fetchBalances();
      },
    };

    const run = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise: counted,
      audit: AS_USER,
    });

    expect(balanceReads).toBe(1);
    expect(run.splitwiseAuditRunId).not.toBeNull();
    const detail = await getSplitwiseAuditRun(
      database.db,
      asId<'splitwise_audit_run'>(run.splitwiseAuditRunId!),
    );
    expect(detail?.run.reconciliationRunId).toBe(run.reconciliationRunId);
    expect(kindsOf(detail!.findings)).toEqual(['missing_external_expense']);
    expect(detail?.findings[0]?.reconciliationRunId).toBe(run.reconciliationRunId);
  });

  it('runs no audit at all when no Splitwise integration is connected', async () => {
    const run = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      ...JULY,
      splitwise,
      audit: AS_USER,
    });

    expect(run.splitwiseAuditRunId).toBeNull();
    expect(await listSplitwiseAuditRunHistory(database.db, {})).toEqual([]);
  });
});

/* ------------------------------------------------------------------ reading helpers */

async function shareOf(expenseId: ExpenseId, personId: PersonId): Promise<bigint> {
  const rows = await database.db
    .select({
      beneficiaryId: schema.allocationLines.beneficiaryId,
      amount: schema.allocationLines.amount,
      supersededAt: schema.allocations.supersededAt,
    })
    .from(schema.allocationLines)
    .innerJoin(schema.allocations, eq(schema.allocationLines.allocationId, schema.allocations.id))
    .where(eq(schema.allocations.expenseId, expenseId));
  return rows
    .filter((row) => row.supersededAt === null && row.beneficiaryId === personId)
    .reduce((total, row) => total + row.amount, 0n);
}

/** Every canonical row an audit must not touch, as a comparable snapshot. */
async function ledgerSnapshot(): Promise<Record<string, unknown[]>> {
  const [payments, expenses, items, allocations, lines, adjustments, settlements] =
    await Promise.all([
      database.db.select().from(schema.payments),
      database.db.select().from(schema.expenses),
      database.db.select().from(schema.expenseItems),
      database.db.select().from(schema.allocations),
      database.db.select().from(schema.allocationLines),
      database.db.select().from(schema.expenseAdjustments),
      database.db.select().from(schema.settlements),
    ]);
  const stringify = (rows: unknown[]): unknown[] =>
    rows.map(
      (row) =>
        JSON.parse(
          JSON.stringify(row, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ) as unknown,
    );
  return {
    payments: stringify(payments),
    expenses: stringify(expenses),
    items: stringify(items),
    allocations: stringify(allocations),
    lines: stringify(lines),
    adjustments: stringify(adjustments),
    settlements: stringify(settlements),
  };
}
