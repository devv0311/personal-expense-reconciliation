import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { computeObligations, paise } from '../../src/domain/index.js';
import type { ExpenseId } from '../../src/domain/index.js';
import { loadBalanceInput, schema } from '../../src/db/index.js';
import { approveAllocation, getBalance, transitionExpense } from '../../src/services/index.js';
import type { ServiceError } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import {
  AS_USER,
  addExpense,
  addManualNote,
  addOccasion,
  addPayment,
  allocationVersions,
  currentAllocationAmounts,
  currentGroupExpansion,
  linkPaymentToExpense,
  seedCast,
} from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

/**
 * Scenarios 1–9 and 16, 19–22 of the required set, each asserting the resulting **financial
 * state** — who owes whom, what is counted as spend — not merely that rows could be inserted.
 *
 * Adjustments, settlements and the non-spend classifications are in
 * `adjustments-settlements-and-exclusions.test.ts`.
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

/** Balance shorthand: positive means `debtor` owes `creditor`. */
async function balance(debtor: string, creditor: string): Promise<bigint> {
  const result = await getBalance(
    database.db,
    cast.userPersonId,
    cast.person[debtor]!,
    cast.person[creditor]!,
  );
  return result.netBalance;
}

async function obligations(): Promise<ReturnType<typeof computeObligations>> {
  return computeObligations(await loadBalanceInput(database.db, cast.userPersonId));
}

const JULY_10 = new Date('2026-07-10T08:00:00Z');

describe('Scenario 1 — a purely personal expense (§35)', () => {
  it('gets a trivial 100%-to-payer allocation and creates no obligation', async () => {
    const payment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(65000n),
      direction: 'debit',
      occurredAt: JULY_10,
      rawDescription: 'UPI-SWIGGY-swiggy@axl',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    const expense = await addExpense(database.db, {
      description: 'Dinner alone',
      amount: paise(65000n),
      occurredAt: JULY_10,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await linkPaymentToExpense(database.db, {
      paymentId: payment,
      expenseId: expense,
      amount: paise(65000n),
    });

    await approveAllocation(database.db, {
      expenseId: expense,
      decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    // Invariant #2: even a personal expense carries an explicit allocation, so downstream
    // code never special-cases "no allocation".
    expect(await currentAllocationAmounts(database.db, expense)).toEqual([
      { beneficiaryId: cast.userPersonId, beneficiaryType: 'person', amount: 65000n },
    ]);
    expect(await obligations()).toEqual([]);
    expect(await balance('person_friend_a', 'person_dev')).toBe(0n);
  });

  it('moves the expense to allocated', async () => {
    const expense = await addExpense(database.db, {
      description: 'Dinner alone',
      amount: paise(65000n),
      occurredAt: JULY_10,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const [row] = await database.db
      .select({ state: schema.expenses.state })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expense));

    expect(row?.state).toBe('allocated');
  });

  it('never reaches READY_TO_SYNC, having no obligation-creating line', async () => {
    const expense = await addExpense(database.db, {
      description: 'Dinner alone',
      amount: paise(65000n),
      occurredAt: JULY_10,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    await expect(
      transitionExpense(database.db, { expenseId: expense, to: 'ready_to_sync', audit: AS_USER }),
    ).rejects.toThrow(/never reaches READY_TO_SYNC/);
  });
});

describe('Scenario 2 — an equally shared expense (§2)', () => {
  it('splits a ₹2,400 dinner three ways and makes both friends owe the payer', async () => {
    const expense = await addExpense(database.db, {
      description: 'Group dinner',
      amount: paise(240000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });

    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_friend_a']! },
          { type: 'person', id: cast.person['person_friend_b']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const lines = await currentAllocationAmounts(database.db, expense);
    expect(lines.map((line) => line.amount)).toEqual([80000n, 80000n, 80000n]);
    expect(await balance('person_friend_a', 'person_dev')).toBe(80000n);
    expect(await balance('person_friend_b', 'person_dev')).toBe(80000n);
  });

  it("creates no obligation from the payer's own share (invariant #2a)", async () => {
    const expense = await addExpense(database.db, {
      description: 'Group dinner',
      amount: paise(240000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_friend_a']! },
          { type: 'person', id: cast.person['person_friend_b']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    expect(await obligations()).toHaveLength(2);
    expect(await balance('person_friend_a', 'person_friend_b')).toBe(0n);
  });

  it('is eligible for Splitwise sync, unlike a personal expense', async () => {
    const expense = await addExpense(database.db, {
      description: 'Group dinner',
      amount: paise(240000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
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

    const moved = await transitionExpense(database.db, {
      expenseId: expense,
      to: 'ready_to_sync',
      audit: AS_USER,
    });

    expect(moved).toEqual({ from: 'allocated', to: 'ready_to_sync' });
  });
});

describe('Scenario 3 — an unequally shared expense (§3)', () => {
  it('keeps the exact amounts the user decided', async () => {
    const expense = await addExpense(database.db, {
      description: 'Restaurant, unequal consumption',
      amount: paise(284000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });

    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'exact',
        lines: [
          { beneficiary: { type: 'person', id: cast.userPersonId }, amount: paise(120000n) },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            amount: paise(96000n),
          },
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_b']! },
            amount: paise(68000n),
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    expect(await balance('person_friend_a', 'person_dev')).toBe(96000n);
    expect(await balance('person_friend_b', 'person_dev')).toBe(68000n);
  });

  it('refuses amounts that do not sum to the expense', async () => {
    const expense = await addExpense(database.db, {
      description: 'Restaurant, unequal consumption',
      amount: paise(284000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });

    await expect(
      approveAllocation(database.db, {
        expenseId: expense,
        decision: {
          method: 'exact',
          lines: [
            { beneficiary: { type: 'person', id: cast.userPersonId }, amount: paise(120000n) },
            {
              beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
              amount: paise(96000n),
            },
          ],
        },
        decidedBy: 'manual',
        audit: AS_USER,
      }),
    ).rejects.toThrow(/sum/i);

    // ...and nothing was written: a rejected allocation leaves no partial state.
    expect(await allocationVersions(database.db, expense)).toEqual([]);
  });
});

describe('Scenario 4 — the user pays entirely for a friend (§7)', () => {
  it('allocates 100% to the friend, who owes the whole amount', async () => {
    const expense = await addExpense(database.db, {
      description: 'Concert ticket for Friend A',
      amount: paise(150000n),
      occurredAt: JULY_10,
      relationshipType: 'paid_on_behalf',
      paidByPersonId: cast.userPersonId,
    });

    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'exact',
        lines: [
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            amount: paise(150000n),
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    expect(await currentAllocationAmounts(database.db, expense)).toHaveLength(1);
    expect(await balance('person_friend_a', 'person_dev')).toBe(150000n);
  });
});

describe('Scenario 5 — the user pays a flat expense (§16)', () => {
  it('splits across flatmates individually and makes each owe the payer', async () => {
    const expense = await addExpense(database.db, {
      description: 'Electricity bill — July',
      amount: paise(210000n),
      occurredAt: JULY_10,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
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

    expect(await balance('person_flatmate_a', 'person_dev')).toBe(70000n);
    expect(await balance('person_flatmate_c', 'person_dev')).toBe(70000n);
  });
});

describe('Scenario 6 — a flatmate pays and the user owes them (§26, ADR-0006)', () => {
  async function seedElectrician(): Promise<ExpenseId> {
    const expense = await addExpense(database.db, {
      description: 'Electrician, fronted by Flatmate A',
      amount: paise(300000n),
      occurredAt: JULY_10,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
    });
    await addManualNote(database.db, {
      text: 'Flatmate A: paid the electrician, ₹3,000, split three ways',
      capturedAt: JULY_10,
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

  it('makes the user owe the flatmate, not the reverse', async () => {
    await seedElectrician();

    expect(await balance('person_dev', 'person_flatmate_a')).toBe(100000n);
    expect(await balance('person_flatmate_a', 'person_dev')).toBe(-100000n);
  });

  it('creates an obligation between two people, neither of whom is the user (§34)', async () => {
    await seedElectrician();

    expect(await balance('person_flatmate_c', 'person_flatmate_a')).toBe(100000n);
    expect(await balance('person_flatmate_c', 'person_dev')).toBe(0n);
  });

  it('never gets a PaymentExpenseLink — that is the expected shape, not a gap', async () => {
    const expense = await seedElectrician();
    const links = await database.db
      .select({ id: schema.paymentExpenseLinks.id })
      .from(schema.paymentExpenseLinks)
      .where(eq(schema.paymentExpenseLinks.expenseId, expense));

    expect(links).toEqual([]);
  });

  it('reports the obligation as open and unconfirmed while no settlement exists', async () => {
    await seedElectrician();
    const result = await getBalance(
      database.db,
      cast.userPersonId,
      cast.person['person_flatmate_c']!,
      cast.person['person_flatmate_a']!,
    );

    expect(result.evidenceStatus).toBe('open_unconfirmed');
  });
});

describe('Scenario 7 — a friend pays and the user owes them (§27)', () => {
  it('works bilaterally, with no Group involved at all', async () => {
    const expense = await addExpense(database.db, {
      description: 'Dinner, fronted by Friend A',
      amount: paise(180000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.person['person_friend_a']!,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
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

    expect(await balance('person_dev', 'person_friend_a')).toBe(90000n);
    expect(await currentGroupExpansion(database.db, expense)).toEqual([]);
  });
});

describe('Scenario 8 — a group beneficiary (§33, ADR-0009)', () => {
  async function seedJulyElectricity(): Promise<ExpenseId> {
    const expense = await addExpense(database.db, {
      description: 'Electricity bill — July',
      amount: paise(210000n),
      occurredAt: JULY_10,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [{ type: 'group', id: cast.group['group_flat']! }],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    return expense;
  }

  it('keeps a single group line, and expands it to the members of that date', async () => {
    const expense = await seedJulyElectricity();

    expect(await currentAllocationAmounts(database.db, expense)).toEqual([
      { beneficiaryId: cast.group['group_flat']!, beneficiaryType: 'group', amount: 210000n },
    ]);

    const expansion = await currentGroupExpansion(database.db, expense);
    expect(expansion.map((row) => row.amount)).toEqual([70000n, 70000n, 70000n]);
    expect(expansion.map((row) => row.personId).sort()).toEqual(
      [
        cast.userPersonId,
        cast.person['person_flatmate_a']!,
        cast.person['person_flatmate_c']!,
      ].sort(),
    );
  });

  it('makes each resolved member owe the payer individually', async () => {
    await seedJulyElectricity();

    expect(await balance('person_flatmate_a', 'person_dev')).toBe(70000n);
    expect(await balance('person_flatmate_c', 'person_dev')).toBe(70000n);
  });

  it('never treats the group itself as a debtor', async () => {
    await seedJulyElectricity();
    const debtors = (await obligations()).map((obligation) => obligation.debtorId);

    expect(debtors).not.toContain(cast.group['group_flat']!);
    expect(debtors).toHaveLength(2);
  });

  it('excludes a flatmate who had already moved out (Flatmate B, left 2026-06-30)', async () => {
    const expense = await seedJulyElectricity();
    const expansion = await currentGroupExpansion(database.db, expense);

    expect(expansion.map((row) => row.personId)).not.toContain(cast.person['person_flatmate_b']);
    expect(await balance('person_flatmate_b', 'person_dev')).toBe(0n);
  });
});

describe('Scenario 9 — a group membership snapshot survives a later change (§33)', () => {
  it('leaves July untouched and resolves September against the new membership', async () => {
    const july = await addExpense(database.db, {
      description: 'Electricity — July',
      amount: paise(210000n),
      occurredAt: JULY_10,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: july,
      decision: {
        method: 'equal',
        beneficiaries: [{ type: 'group', id: cast.group['group_flat']! }],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    // Flatmate C moved out 2026-08-31; Flatmate D moved in 2026-09-01. The membership rows
    // already carry this — no mutation is needed to make the change "happen".
    const september = await addExpense(database.db, {
      description: 'Electricity — September',
      amount: paise(240000n),
      occurredAt: new Date('2026-09-10T08:00:00Z'),
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: september,
      decision: {
        method: 'equal',
        beneficiaries: [{ type: 'group', id: cast.group['group_flat']! }],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const julyExpansion = await currentGroupExpansion(database.db, july);
    const septemberExpansion = await currentGroupExpansion(database.db, september);

    expect(julyExpansion.map((row) => row.personId).sort()).toEqual(
      [
        cast.userPersonId,
        cast.person['person_flatmate_a']!,
        cast.person['person_flatmate_c']!,
      ].sort(),
    );
    expect(septemberExpansion.map((row) => row.personId).sort()).toEqual(
      [
        cast.userPersonId,
        cast.person['person_flatmate_a']!,
        cast.person['person_flatmate_d']!,
      ].sort(),
    );
    expect(julyExpansion.every((row) => row.amount === 70000n)).toBe(true);
    expect(septemberExpansion.every((row) => row.amount === 80000n)).toBe(true);
  });

  it('keeps the departed flatmate owing their historical July share', async () => {
    const july = await addExpense(database.db, {
      description: 'Electricity — July',
      amount: paise(210000n),
      occurredAt: JULY_10,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: july,
      decision: {
        method: 'equal',
        beneficiaries: [{ type: 'group', id: cast.group['group_flat']! }],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    expect(await balance('person_flatmate_c', 'person_dev')).toBe(70000n);
    expect(await balance('person_flatmate_d', 'person_dev')).toBe(0n);
  });
});

describe('Scenario 16 — a gift (§8)', () => {
  it('creates no obligation despite having a non-payer beneficiary', async () => {
    const expense = await addExpense(database.db, {
      description: 'Birthday present for Friend A',
      amount: paise(250000n),
      occurredAt: JULY_10,
      relationshipType: 'gift',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'exact',
        lines: [
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            amount: paise(250000n),
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    expect(await currentAllocationAmounts(database.db, expense)).toHaveLength(1);
    expect(await obligations()).toEqual([]);
    expect(await balance('person_friend_a', 'person_dev')).toBe(0n);
  });

  it('is refused entry to READY_TO_SYNC — the corrected gate (§8, lifecycle.md)', async () => {
    const expense = await addExpense(database.db, {
      description: 'Birthday present for Friend A',
      amount: paise(250000n),
      occurredAt: JULY_10,
      relationshipType: 'gift',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'exact',
        lines: [
          {
            beneficiary: { type: 'person', id: cast.person['person_friend_a']! },
            amount: paise(250000n),
          },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    let raised: ServiceError | undefined;
    try {
      await transitionExpense(database.db, {
        expenseId: expense,
        to: 'ready_to_sync',
        audit: AS_USER,
      });
    } catch (error) {
      raised = error as ServiceError;
    }

    expect(raised?.code).toBe('PRECONDITION_FAILED');
    expect(raised?.message).toMatch(/own gift/);
  });
});

describe('Scenario 19 — an expense with no receipt (§4, §19)', () => {
  it('is fully allocatable with no Receipt or Evidence row at all', async () => {
    const payment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(120000n),
      direction: 'debit',
      occurredAt: JULY_10,
      rawDescription: 'UPI-SAMPLE RESTAURANT',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    const expense = await addExpense(database.db, {
      description: 'Restaurant, no receipt',
      amount: paise(120000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await linkPaymentToExpense(database.db, {
      paymentId: payment,
      expenseId: expense,
      amount: paise(120000n),
    });
    await approveAllocation(database.db, {
      expenseId: expense,
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

    const receipts = await database.db.select({ id: schema.receipts.id }).from(schema.receipts);
    const evidenceRows = await database.db
      .select({ id: schema.evidence.id })
      .from(schema.evidence)
      .where(eq(schema.evidence.linkedExpenseId, expense));

    expect(receipts).toEqual([]);
    expect(evidenceRows).toEqual([]);
    expect(await balance('person_friend_a', 'person_dev')).toBe(60000n);
  });
});

describe('Scenario 20 — an externally funded expense is traceable through Evidence alone (§26)', () => {
  it('has an Evidence trail and no Payment, which is the documented shape (invariant #5)', async () => {
    const expense = await addExpense(database.db, {
      description: 'Electrician, fronted by Flatmate A',
      amount: paise(300000n),
      occurredAt: JULY_10,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
    });
    await addManualNote(database.db, {
      text: 'Flatmate A: paid the electrician, ₹3,000, split three ways',
      capturedAt: JULY_10,
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

    const evidenceRows = await database.db
      .select({ type: schema.evidence.type, rawText: schema.evidence.rawText })
      .from(schema.evidence)
      .where(eq(schema.evidence.linkedExpenseId, expense));
    const links = await database.db
      .select({ id: schema.paymentExpenseLinks.id })
      .from(schema.paymentExpenseLinks)
      .where(eq(schema.paymentExpenseLinks.expenseId, expense));

    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]?.type).toBe('manual_note');
    expect(links).toEqual([]);
  });

  it('does not fabricate a Payment to make the money movement observable (#9b)', async () => {
    await addExpense(database.db, {
      description: 'Electrician, fronted by Flatmate A',
      amount: paise(300000n),
      occurredAt: JULY_10,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.person['person_flatmate_a']!,
    });

    const payments = await database.db.select({ id: schema.payments.id }).from(schema.payments);

    expect(payments).toEqual([]);
  });
});

describe('Scenario 21 — one payment funding several expenses (§1, §21)', () => {
  it('splits a Blinkit basket into a flat expense and a personal one', async () => {
    const payment = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_upi']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: JULY_10,
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'upi',
      counterpartyType: 'merchant',
    });

    const flatGroceries = await addExpense(database.db, {
      description: 'Flat groceries (milk)',
      amount: paise(8000n),
      occurredAt: JULY_10,
      relationshipType: 'household_shared_flat',
      paidByPersonId: cast.userPersonId,
    });
    const personal = await addExpense(database.db, {
      description: 'Personal items (chicken, shampoo)',
      amount: paise(116000n),
      occurredAt: JULY_10,
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
    });

    await linkPaymentToExpense(database.db, {
      paymentId: payment,
      expenseId: flatGroceries,
      amount: paise(8000n),
    });
    await linkPaymentToExpense(database.db, {
      paymentId: payment,
      expenseId: personal,
      amount: paise(116000n),
    });

    await approveAllocation(database.db, {
      expenseId: flatGroceries,
      decision: {
        method: 'equal',
        beneficiaries: [{ type: 'group', id: cast.group['group_flat']! }],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    await approveAllocation(database.db, {
      expenseId: personal,
      decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const links = await database.db
      .select({ amount: schema.paymentExpenseLinks.amount })
      .from(schema.paymentExpenseLinks)
      .where(eq(schema.paymentExpenseLinks.paymentId, payment));

    // The two links exactly explain the payment — no remainder, nothing double-counted.
    expect(links.reduce((total, link) => total + link.amount, 0n)).toBe(124000n);

    // Only the flat expense creates obligations; the personal one creates none.
    const expansion = await currentGroupExpansion(database.db, flatGroceries);
    expect(expansion.map((row) => row.amount)).toEqual([2667n, 2667n, 2666n]);
    expect(expansion.reduce((total, row) => total + row.amount, 0n)).toBe(8000n);
  });
});

describe('Scenario 22 — several payments belonging to one occasion (§10, §22)', () => {
  it('groups a trip’s expenses under one ExpenseOccasion without merging their allocations', async () => {
    const occasion = await addOccasion(database.db, {
      name: 'Goa trip',
      start: new Date('2026-05-10T00:00:00Z'),
      end: new Date('2026-05-14T00:00:00Z'),
    });

    const legs = [
      { description: 'Hotel', amount: paise(900000n), day: '2026-05-10T09:00:00Z' },
      { description: 'Dinner', amount: paise(240000n), day: '2026-05-11T20:00:00Z' },
      { description: 'Local transport', amount: paise(60000n), day: '2026-05-12T11:00:00Z' },
    ];

    const expenseIds: ExpenseId[] = [];
    for (const leg of legs) {
      const payment = await addPayment(database.db, cast, {
        accountId: cast.account['account_icici_credit_card']!,
        amount: leg.amount,
        direction: 'debit',
        occurredAt: new Date(leg.day),
        rawDescription: `SYNTHETIC ${leg.description.toUpperCase()}`,
        channel: 'card',
        counterpartyType: 'merchant',
      });
      const expense = await addExpense(database.db, {
        description: leg.description,
        amount: leg.amount,
        occurredAt: new Date(leg.day),
        relationshipType: 'shared',
        paidByPersonId: cast.userPersonId,
        occasionId: occasion,
      });
      await linkPaymentToExpense(database.db, {
        paymentId: payment,
        expenseId: expense,
        amount: leg.amount,
      });
      await approveAllocation(database.db, {
        expenseId: expense,
        decision: {
          method: 'equal',
          beneficiaries: [
            { type: 'person', id: cast.userPersonId },
            { type: 'person', id: cast.person['person_friend_a']! },
            { type: 'person', id: cast.person['person_friend_b']! },
          ],
        },
        decidedBy: 'manual',
        audit: AS_USER,
      });
      expenseIds.push(expense);
    }

    const grouped = await database.db
      .select({ id: schema.expenses.id, amount: schema.expenses.amount })
      .from(schema.expenses)
      .where(eq(schema.expenses.occasionId, occasion));

    expect(grouped).toHaveLength(3);
    expect(grouped.reduce((total, row) => total + row.amount, 0n)).toBe(1200000n);

    // Each expense keeps its own allocation; the occasion is a grouping, not a merge.
    for (const expenseId of expenseIds) {
      expect(await currentAllocationAmounts(database.db, expenseId)).toHaveLength(3);
    }
    // ₹12,000 across three people: each friend owes a third of the trip.
    expect(await balance('person_friend_a', 'person_dev')).toBe(400000n);
    expect(await balance('person_friend_b', 'person_dev')).toBe(400000n);
  });
});

describe('every allocation approval is audited (invariant #21)', () => {
  it('records a create event naming the expense, method and lines', async () => {
    const expense = await addExpense(database.db, {
      description: 'Group dinner',
      amount: paise(240000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    const { allocationId } = await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_friend_a']! },
        ],
      },
      decidedBy: 'manual',
      audit: { actor: 'user', source: 'tests/scenarios', reason: 'confirmed at the table' },
    });

    const events = await database.db
      .select({
        action: schema.auditEvents.action,
        actor: schema.auditEvents.actor,
        reason: schema.auditEvents.reason,
        newValue: schema.auditEvents.newValue,
      })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityType, 'allocation'),
          eq(schema.auditEvents.entityId, allocationId),
        ),
      );

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('create');
    expect(events[0]?.actor).toBe('user');
    expect(events[0]?.reason).toBe('confirmed at the table');
    expect(events[0]?.newValue).toMatchObject({ method: 'equal', netAmount: '240000' });
  });

  it('also audits the expense state change that accompanies it', async () => {
    const expense = await addExpense(database.db, {
      description: 'Group dinner',
      amount: paise(240000n),
      occurredAt: JULY_10,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId: expense,
      decision: {
        method: 'equal',
        beneficiaries: [{ type: 'person', id: cast.userPersonId }],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });

    const events = await database.db
      .select({ oldValue: schema.auditEvents.oldValue, newValue: schema.auditEvents.newValue })
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.entityType, 'expense'), eq(schema.auditEvents.entityId, expense)),
      );

    expect(events).toHaveLength(1);
    expect(events[0]?.oldValue).toMatchObject({ state: 'approved' });
    expect(events[0]?.newValue).toMatchObject({ state: 'allocated' });
  });
});
