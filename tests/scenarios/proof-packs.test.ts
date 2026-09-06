/**
 * Derived proof packs, end to end (`docs/roadmap.md` Phase 20, ADR-0047).
 *
 * The pure rendering and warning logic is `src/domain/proof-pack.test.ts`. This file proves
 * the phase's real claims against the real schema and services:
 *
 *  - every figure a pack quotes matches what the canonical engine already derived — the
 *    balance, the recipient's share, the net expense after a refund — because the pack calls
 *    those functions rather than repeating their arithmetic;
 *  - partial, full, successive and item-attributed refunds, a prior settlement, a reverse
 *    balance and pending/uncertain state all read correctly;
 *  - an unresolved Phase 19 audit finding is surfaced, not smoothed over;
 *  - only the recipient's own position is exported — no third party is named;
 *  - account and contact identifiers are redacted, and a marker redaction would miss makes the
 *    whole pack fail closed rather than leak;
 *  - regenerating a pack for the same ledger and as-of boundary is byte-identical, a changed
 *    ledger changes it, and generating one writes nothing — no Payment, Expense, Allocation,
 *    Adjustment, Settlement, obligation, Splitwise row or audit finding moves.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { BeneficiaryRef, ExpenseId, ExpenseItemId, PersonId } from '../../src/domain/index.js';
import { listAuditEvents, schema } from '../../src/db/index.js';
import {
  approveAllocation,
  buildProofPackPreview,
  connectSplitwiseIntegration,
  distributeAdjustment,
  getBalance,
  getRefundAllocationState,
  recordExpenseAdjustment,
  recordSettlement,
  runSplitwiseAudit,
  syncExpenseToSplitwise,
  transitionExpense,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import {
  AS_USER,
  addExpense,
  addExpenseItem,
  addPayment,
  linkPaymentToExpense,
  seedCast,
} from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { eq } from 'drizzle-orm';

let database: TestDatabase;
let cast: Cast;

const PURCHASED_AT = new Date('2026-07-01T10:00:00.000Z');
const REFUNDED_AT = new Date('2026-07-05T10:00:00.000Z');
const SETTLED_AT = new Date('2026-07-08T10:00:00.000Z');
const AS_OF = new Date('2026-09-06T09:00:00.000Z');

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

/* ------------------------------------------------------------------ seeding helpers */

function friendA(): PersonId {
  return cast.person['person_friend_a']!;
}

async function seedEqualDinner(
  amount = 100_000n,
  description = 'Dinner at the pier',
): Promise<ExpenseId> {
  const expenseId = await addExpense(database.db, {
    description,
    amount: paise(amount),
    occurredAt: PURCHASED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
  });
  const paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_upi']!,
    amount: paise(amount),
    direction: 'debit',
    occurredAt: PURCHASED_AT,
    rawDescription: 'UPI-PIER-CAFE',
    channel: 'upi',
    counterpartyType: 'merchant',
  });
  await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: paise(amount) });
  await attachNotification(paymentId, 'PIER CAFE debit Rs.1000.00', amount);

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
  return expenseId;
}

interface Basket {
  readonly expenseId: ExpenseId;
  readonly paymentId: string;
  readonly mine: ExpenseItemId;
  readonly theirs: ExpenseItemId;
}

/** ADR-0018's worked basket: the user's ₹600 item and Friend A's ₹400 item, one ₹1,000 payment. */
async function seedItemBasket(): Promise<Basket> {
  const expenseId = await addExpense(database.db, {
    description: 'Blinkit basket',
    amount: paise(100_000n),
    occurredAt: PURCHASED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
  });
  const paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_upi']!,
    amount: paise(100_000n),
    direction: 'debit',
    occurredAt: PURCHASED_AT,
    rawDescription: 'UPI-BLINKIT',
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
  return { expenseId, paymentId, mine, theirs };
}

/** A settlement: `credit` = Friend A paid the user; `debit` = the user paid Friend A. */
async function settle(direction: 'credit' | 'debit', amount: bigint): Promise<void> {
  const paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(amount),
    direction,
    occurredAt: SETTLED_AT,
    rawDescription: 'UPI-FRIEND-A-SETTLE',
    channel: 'upi',
    state: 'normalized',
  });
  await recordSettlement(database.db, {
    paymentId,
    counterpartyPersonId: friendA(),
    amount: paise(amount),
    audit: AS_USER,
  });
}

async function attachNotification(
  paymentId: string,
  rawText: string,
  observedAmount?: bigint,
): Promise<void> {
  const [row] = await database.db
    .insert(schema.evidence)
    .values({
      type: 'upi_notification',
      rawText,
      capturedAt: PURCHASED_AT,
      linkedPaymentId: paymentId,
    })
    .returning({ id: schema.evidence.id });
  if (observedAmount !== undefined) {
    await database.db.insert(schema.evidenceObservations).values({
      evidenceId: row!.id,
      observedAmount: paise(observedAmount),
      observedDirection: 'debit',
      derivation: 'caller_supplied',
    });
  }
}

async function connectSplitwiseAndLink(): Promise<void> {
  await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId: 'sw-dev' })
    .where(eq(schema.people.id, cast.userPersonId));
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId: 'sw-friend-a' })
    .where(eq(schema.people.id, friendA()));
}

async function pack(recipient: PersonId = friendA(), asOf: Date = AS_OF) {
  return buildProofPackPreview(database.db, {
    userPersonId: cast.userPersonId,
    recipientPersonId: recipient,
    asOf,
  });
}

/** `JSON.stringify` cannot serialize the `bigint` figures the pack carries. */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key: string, entry: unknown): unknown =>
    typeof entry === 'bigint' ? `${entry}n` : entry,
  );
}

/* =========================================================================== scenarios */

describe('a normal shared expense', () => {
  it('quotes the balance and the recipient share, matching getBalance exactly', async () => {
    const expenseId = await seedEqualDinner();

    const balance = await getBalance(database.db, cast.userPersonId, cast.userPersonId, friendA());
    const preview = await pack();

    expect(preview.pack.netBalance).toBe(balance.netBalance);
    expect(preview.pack.netBalance).toBe(-50_000n);
    expect(preview.pack.netDirection).toBe('recipient_owes_user');
    expect(preview.pack.expenseLines).toHaveLength(1);
    expect(preview.pack.expenseLines[0]?.expenseId).toBe(expenseId);
    expect(preview.pack.expenseLines[0]?.recipientShare).toBe(50_000n);
    expect(preview.pack.expenseLines[0]?.netAmount).toBe(100_000n);
    expect(preview.generatedText).toContain('Friend A owes me ₹500.00');
    expect(preview.intendedRecipient).toEqual({ id: friendA(), displayName: 'Friend A' });
    expect(preview.evidenceReferences).toHaveLength(1);
    expect(preview.evidenceReferences[0]?.type).toBe('upi_notification');
  });
});

describe('refunds', () => {
  it('reflects an item-attributed partial refund once distributed', async () => {
    const basket = await seedItemBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const refundState = await getRefundAllocationState(database.db, basket.expenseId);
    const preview = await pack();

    const line = preview.pack.expenseLines[0]!;
    expect(line.attributedItemRefunds).toBe(15_000n);
    expect(line.netAmount).toBe(refundState.netAmount);
    expect(line.netAmount).toBe(85_000n);
    expect(line.recipientShare).toBe(25_000n); // Friend A's ₹400 item, less the ₹150 refund
    expect(line.pendingDistribution).toBe(false);
    expect(preview.generatedText).toContain('Item refund: ₹150.00  →  net ₹850.00');
    expect(preview.warnings.map((w) => w.code)).not.toContain('PENDING_REFUND_DISTRIBUTION');
  });

  it('marks a recorded-but-undistributed refund as pending, without moving the share', async () => {
    const basket = await seedItemBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });

    const preview = await pack();
    const line = preview.pack.expenseLines[0]!;

    expect(line.pendingDistribution).toBe(true);
    expect(line.recipientShare).toBe(40_000n); // still the pre-refund figure
    expect(preview.warnings.map((w) => w.code)).toContain('PENDING_REFUND_DISTRIBUTION');
    expect(preview.generatedText).toContain('not yet reflected in the share above');
  });

  it('accumulates successive partial refunds', async () => {
    const basket = await seedItemBasket();
    for (const amount of [10_000n, 5_000n]) {
      await recordExpenseAdjustment(database.db, {
        expenseId: basket.expenseId,
        kind: 'merchant_refund',
        amount: paise(amount),
        occurredAt: REFUNDED_AT,
        itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(amount) }],
        audit: AS_USER,
      });
      await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });
    }

    const preview = await pack();
    const line = preview.pack.expenseLines[0]!;
    expect(line.attributedItemRefunds).toBe(15_000n);
    expect(line.recipientShare).toBe(25_000n);
  });

  it('drops a fully-refunded expense from the pack and reports the pair as settled', async () => {
    const expenseId = await seedEqualDinner();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(100_000n),
      occurredAt: REFUNDED_AT,
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });

    const balance = await getBalance(database.db, cast.userPersonId, cast.userPersonId, friendA());
    const preview = await pack();

    expect(balance.netBalance).toBe(0n);
    expect(preview.pack.netDirection).toBe('settled');
    expect(preview.pack.expenseLines).toHaveLength(0);
    expect(preview.generatedText).toContain('settled up — nothing is owed either way');
  });

  it('names a mixed legacy + item adjustment basis', async () => {
    const basket = await seedItemBasket();
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(10_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(10_000n) }],
      audit: AS_USER,
    });
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(5_000n),
      occurredAt: REFUNDED_AT,
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const preview = await pack();
    expect(preview.pack.expenseLines[0]?.refundBasis).toBe('mixed');
    expect(preview.warnings.map((w) => w.code)).toContain('MIXED_LEGACY_AND_ITEM_ADJUSTMENTS');
    expect(preview.generatedText).toContain('Refunds (item + whole-expense)');
  });
});

describe('settlements and reverse balances', () => {
  it('shows a prior settlement and reports a cleared balance as confirmed', async () => {
    await seedEqualDinner(); // Friend A owes ₹500 of the ₹1,000 dinner
    await settle('credit', 50_000n); // Friend A repays the full ₹500

    const preview = await pack();

    expect(preview.pack.settlements).toHaveLength(1);
    expect(preview.pack.settlements[0]?.direction).toBe('recipient_paid_you');
    expect(preview.pack.netDirection).toBe('settled');
    expect(preview.pack.evidenceStatus).toBe('settled_confirmed');
    expect(preview.generatedText).toContain('Friend A paid me ₹500.00');
  });

  it('exposes a reverse balance created by a refund after a settlement', async () => {
    const basket = await seedItemBasket(); // Friend A owes ₹400 for their item
    await settle('credit', 40_000n); // Friend A repays the whole ₹400
    await recordExpenseAdjustment(database.db, {
      expenseId: basket.expenseId,
      kind: 'merchant_refund',
      amount: paise(15_000n),
      occurredAt: REFUNDED_AT,
      itemAttributions: [{ expenseItemId: basket.theirs, amount: paise(15_000n) }],
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId: basket.expenseId, audit: AS_USER });

    const balance = await getBalance(database.db, cast.userPersonId, cast.userPersonId, friendA());
    const preview = await pack();

    // Friend A's share is now ₹250 but they paid ₹400 -> the user owes them ₹150 back.
    expect(balance.netBalance).toBe(15_000n);
    expect(preview.pack.netDirection).toBe('user_owes_recipient');
    expect(preview.warnings.map((w) => w.code)).toContain('REVERSE_BALANCE_AFTER_SETTLEMENT');
    expect(preview.generatedText).toContain('money owed back the other way');
    expect(preview.pack.settlements).toHaveLength(1);
  });
});

describe('uncertainty', () => {
  it('surfaces an unresolved Phase 19 audit finding without resolving it', async () => {
    const expenseId = await seedEqualDinner(90_000n, 'Group dinner');
    await connectSplitwiseAndLink();
    await transitionExpense(database.db, { expenseId, to: 'ready_to_sync', audit: AS_USER });
    const splitwise = createMockSplitwisePort();
    await syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER });
    // Splitwise reports nothing for this friend -> a `missing_external_expense` finding, open.
    splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(0n) }]);
    splitwise.setLedgerEntries('sw-friend-a', []);
    const auditRun = await runSplitwiseAudit(database.db, {
      userPersonId: cast.userPersonId,
      splitwise,
      audit: AS_USER,
    });
    expect(auditRun.findings.length).toBeGreaterThan(0);
    const findingId = auditRun.findings[0]!.id;

    const preview = await pack();

    expect(preview.warnings.map((w) => w.code)).toContain('UNRESOLVED_AUDIT_FINDINGS');
    expect(preview.pack.openAuditFindings.length).toBeGreaterThan(0);
    expect(preview.generatedText).toContain('Splitwise audit');

    // Generating the pack authorized no review and moved no finding.
    const events = await listAuditEvents(database.db, 'splitwise_audit_finding', findingId);
    expect(events.filter((event) => event.action === 'update')).toHaveLength(0);
  });

  it('notes a contributing expense with no supporting evidence', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Cash taxi',
      amount: paise(60_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
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

    const preview = await pack();
    expect(preview.warnings.map((w) => w.code)).toContain('MISSING_SUPPORTING_EVIDENCE');
  });

  it('notes conflicting evidence on a contributing payment', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Dinner with a disputed receipt',
      amount: paise(80_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(80_000n),
      direction: 'debit',
      occurredAt: PURCHASED_AT,
      rawDescription: 'UPI-RESTAURANT',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: paise(80_000n) });
    await attachNotification(paymentId, 'RESTAURANT debit Rs.900.00', 90_000n); // disagrees: 900 vs 800
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

    const preview = await pack();
    expect(preview.pack.expenseLines[0]?.conflictingEvidence).toBe(true);
    expect(preview.warnings.map((w) => w.code)).toContain('CONFLICTING_EVIDENCE');
  });

  it('reports an empty history rather than throwing', async () => {
    const preview = await pack(cast.person['person_friend_b']);
    expect(preview.pack.expenseLines).toHaveLength(0);
    expect(preview.pack.settlements).toHaveLength(0);
    expect(preview.warnings.map((w) => w.code)).toContain('NO_SHARED_HISTORY');
    expect(preview.generatedText).toContain('no shared expenses or settlements');
  });
});

describe('recipient isolation', () => {
  it('exports only the recipient’s own share, naming no third party', async () => {
    // A three-way dinner: Dev pays, Friend A and Flatmate A each owe a third.
    const expenseId = await addExpense(database.db, {
      description: 'Three-way dinner',
      amount: paise(90_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(90_000n),
      direction: 'debit',
      occurredAt: PURCHASED_AT,
      rawDescription: 'UPI-DINNER',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: paise(90_000n) });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: friendA() },
          { type: 'person', id: cast.person['person_flatmate_a']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const preview = await pack(friendA());

    expect(preview.generatedText).not.toContain('Flatmate');
    expect(stringify(preview)).not.toContain(cast.person['person_flatmate_a']);
    expect(preview.pack.expenseLines[0]?.recipientShare).toBe(30_000n);
    // Friend A owes ₹30 of the ₹90; the pack shows that, not the ₹60 total owed to Dev.
    expect(preview.pack.netBalance).toBe(-30_000n);
  });
});

describe('privacy — redaction and fail-closed', () => {
  it('redacts an account number in an expense description', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Rent transfer A/C 1234567890123',
      amount: paise(50_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
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

    const preview = await pack();
    expect(preview.generatedText).not.toContain('1234567890123');
    expect(preview.generatedText).toContain('[redacted-number]');
  });

  it('fails closed when a marker redaction would miss survives into the export', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Dinner — reachable at 9876543210',
      amount: paise(50_000n),
      occurredAt: PURCHASED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
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

    await expect(pack()).rejects.toThrow(/still contains .*phone_number/);
  });
});

describe('determinism and immutability', () => {
  it('is byte-identical when regenerated over an unchanged ledger and as-of boundary', async () => {
    await seedEqualDinner();
    const a = await pack();
    const b = await pack();
    expect(stringify(a)).toBe(stringify(b));
  });

  it('changes when the ledger changes', async () => {
    const expenseId = await seedEqualDinner();
    const before = await pack();
    await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(20_000n),
      occurredAt: REFUNDED_AT,
      audit: AS_USER,
    });
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });
    const after = await pack();
    expect(after.generatedText).not.toBe(before.generatedText);
    expect(after.pack.netBalance).not.toBe(before.pack.netBalance);
  });

  it('writes nothing — no audit event, no row moved — when a pack is generated', async () => {
    await seedEqualDinner();

    const snapshot = async () => ({
      audit: (await database.db.select().from(schema.auditEvents)).length,
      allocations: (await database.db.select().from(schema.allocations)).length,
      allocationLines: (await database.db.select().from(schema.allocationLines)).length,
      settlements: (await database.db.select().from(schema.settlements)).length,
      adjustments: (await database.db.select().from(schema.expenseAdjustments)).length,
      payments: (await database.db.select().from(schema.payments)).length,
      evidence: (await database.db.select().from(schema.evidence)).length,
    });

    const before = await snapshot();
    await pack();
    expect(await snapshot()).toEqual(before);
  });
});

describe('input validation', () => {
  it('refuses a pack for the user themselves', async () => {
    await expect(pack(cast.userPersonId)).rejects.toThrow(/cannot be generated for the user/);
  });

  it('404s an unknown recipient', async () => {
    await expect(pack(asId<'person'>('00000000-0000-0000-0000-000000000000'))).rejects.toThrow(
      /No active person/,
    );
  });
});
