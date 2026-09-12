/**
 * Reading changes made *in* Splitwise back into this ledger, as proposals (ADR-0056).
 *
 * The sentence under test: **their edit is a thing this ledger can show, explain and decide
 * about — and never a figure it copies.** Everything below holds that to account. Accepting a
 * change must leave the expense, the allocation and the balance exactly as they were; an
 * incomplete read must never propose a deletion; a decided change must survive a re-run
 * unchanged; and an adoption must refuse rather than repoint a link that already exists.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { BeneficiaryRef, ExpenseId, PersonId, SettlementId } from '../../src/domain/index.js';
import {
  getSplitwiseExpenseByExpenseId,
  getSplitwiseSettlementBySettlementId,
  listSplitwiseRemoteChanges,
  schema,
} from '../../src/db/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import {
  approveAllocation,
  connectSplitwiseIntegration,
  decideSplitwiseRemoteChange,
  discoverSplitwiseRemoteChanges,
  getBalance,
  listResyncCandidates,
  listSettlementResyncCandidates,
  recordSettlement,
  resyncSettlementToSplitwise,
  syncExpenseToSplitwise,
  syncSettlementToSplitwise,
  transitionExpense,
} from '../../src/services/index.js';
import { ServiceError } from '../../src/services/errors.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createAggregateOnlySplitwisePort, createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';
const AS_USER = { actor: 'user', source: 'tests/integration/splitwise-remote-changes' } as const;
const OCCURRED_AT = new Date('2026-07-10T19:20:00.000Z');
const REASON = 'They edited the dinner on their phone; recording what their side now says.';

let database: TestDatabase;
let api: Api;
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
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise,
  });
  await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
  await linkSplitwiseUser(cast.userPersonId, 'sw-dev');
  await linkSplitwiseUser(friendId(), 'sw-friend-a');
  splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_000n) }]);
});

function friendId(): PersonId {
  return cast.person['person_friend_a']!;
}

async function linkSplitwiseUser(personId: PersonId, splitwiseUserId: string): Promise<void> {
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId })
    .where(eq(schema.people.id, personId));
}

/** A ₹900 dinner split two ways and already pushed to Splitwise as `sw-expense-1`. */
async function syncedDinner(): Promise<ExpenseId> {
  const beneficiaries: BeneficiaryRef[] = [
    { type: 'person', id: cast.userPersonId },
    { type: 'person', id: friendId() },
  ];
  const expenseId = await addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(90_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
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

/** An unallocated, approved expense — a candidate for adopting an external entry against. */
async function unsyncedLunch(): Promise<ExpenseId> {
  return addExpense(database.db, {
    description: 'Lunch somebody entered in Splitwise',
    amount: paise(40_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
}

function entry(overrides: Partial<Parameters<typeof splitwise.setLedgerEntries>[1][number]> = {}) {
  return {
    splitwiseEntryId: 'sw-expense-1',
    kind: 'expense' as const,
    description: 'Group dinner',
    totalAmount: paise(90_000n),
    currency: 'INR',
    deleted: false,
    occurredAt: OCCURRED_AT,
    pairNetBalance: paise(-45_000n),
    ...overrides,
  };
}

async function discover() {
  return discoverSplitwiseRemoteChanges(database.db, {
    userPersonId: cast.userPersonId,
    splitwise,
    audit: AS_USER,
  });
}

describe('discoverSplitwiseRemoteChanges', () => {
  it('records agreement as no changes at all', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry()]);

    const result = await discover();
    expect(result.externalReadStatus).toBe('complete');
    expect(result.changesCreated).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it('proposes their edit without moving a single local figure', async () => {
    const expenseId = await syncedDinner();
    const before = await getBalance(database.db, cast.userPersonId, cast.userPersonId, friendId());
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);

    const result = await discover();
    const [change] = result.changes;
    expect(change?.kind).toBe('remote_expense_amount_changed');
    expect(change?.effect).toBe('record_drift');
    expect(change?.status).toBe('proposed');
    expect(change?.expenseId).toBe(expenseId);

    // Discovery itself writes nothing financial.
    const after = await getBalance(database.db, cast.userPersonId, cast.userPersonId, friendId());
    expect(after.netBalance).toBe(before.netBalance);
    const [expense] = await database.db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expenseId));
    expect(expense?.amount).toBe(90_000n);
  });

  it('accepting records what they hold and still moves no money', async () => {
    const expenseId = await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    const { changes } = await discover();
    const before = await getBalance(database.db, cast.userPersonId, cast.userPersonId, friendId());

    const decision = await decideSplitwiseRemoteChange(database.db, {
      changeId: changes[0]!.id,
      decision: 'accept',
      reason: REASON,
      audit: AS_USER,
    });
    expect(decision.appliedEffect).toBe('record_drift');

    const link = await getSplitwiseExpenseByExpenseId(database.db, expenseId);
    expect(link?.syncStatus).toBe('drifted');
    const [row] = await database.db
      .select()
      .from(schema.splitwiseExpenses)
      .where(eq(schema.splitwiseExpenses.expenseId, expenseId));
    // What they say is recorded; what we pushed is untouched, because it is the figure every
    // later comparison is made against.
    expect((row?.theirSnapshot as { totalAmount: string }).totalAmount).toBe('120000');
    expect((row?.ourSnapshot as { netAmount: string }).netAmount).toBe('90000');

    const after = await getBalance(database.db, cast.userPersonId, cast.userPersonId, friendId());
    expect(after.netBalance).toBe(before.netBalance);
  });

  it('never proposes a deletion from a partial listing', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [], {
      complete: false,
      incompleteReason: 'read stopped at the page cap',
    });

    const result = await discover();
    expect(result.externalReadStatus).toBe('partial');
    expect(result.changes.map((change) => change.kind)).not.toContain('remote_expense_deleted');
  });

  it('proposes a deletion from a complete listing, and accepting sets up the recreate', async () => {
    const expenseId = await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', []);

    const { changes } = await discover();
    const deletion = changes.find((change) => change.kind === 'remote_expense_deleted');
    expect(deletion?.effect).toBe('record_external_deletion');

    await decideSplitwiseRemoteChange(database.db, {
      changeId: deletion!.id,
      decision: 'accept',
      reason: 'They deleted it; our ledger still says they owe a share.',
      audit: AS_USER,
    });

    const link = await getSplitwiseExpenseByExpenseId(database.db, expenseId);
    expect(link?.syncStatus).toBe('externally_deleted');
    // The expense itself is untouched, and the repair now plans a create rather than an update.
    const candidates = await listResyncCandidates(database.db);
    expect(candidates.find((row) => row.expenseId === expenseId)?.plannedRepair).toBe('recreated');
  });

  it('records an unsupported read as unchecked rather than as agreement', async () => {
    await syncedDinner();
    const aggregateOnly = createAggregateOnlySplitwisePort();
    aggregateOnly.setFriendBalances([
      { splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_000n) },
    ]);

    const result = await discoverSplitwiseRemoteChanges(database.db, {
      userPersonId: cast.userPersonId,
      splitwise: aggregateOnly,
      audit: AS_USER,
    });
    expect(result.externalReadStatus).toBe('unsupported');
    expect(result.pairsUnchecked).toBe(1);
    expect(result.changes.filter((change) => change.kind === 'remote_expense_deleted')).toEqual([]);
  });

  it('records a failed friends read as failed, and proposes nothing', async () => {
    await syncedDinner();
    splitwise.failNextFetchBalances('Splitwise is unreachable');

    const result = await discover();
    expect(result.externalReadStatus).toBe('failed');
    expect(result.externalReadDetail).toContain('unreachable');
    expect(result.changes).toEqual([]);
  });

  it('names a Splitwise friend nobody here is mapped to', async () => {
    splitwise.setFriendBalances([
      { splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_000n) },
      { splitwiseUserId: 'sw-stranger', netBalance: paise(20_000n) },
    ]);
    splitwise.setLedgerEntries('sw-friend-a', []);

    const { changes } = await discover();
    const mapping = changes.find((change) => change.kind === 'remote_person_unmapped');
    expect(mapping?.externalUserReference).toBe('sw-stranger');
    expect(mapping?.effect).toBe('map_person');
  });
});

describe('re-running discovery', () => {
  it('re-observes an unchanged change rather than duplicating it', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);

    const first = await discover();
    const second = await discover();

    expect(first.changesCreated).toBe(1);
    expect(second.changesCreated).toBe(0);
    expect(second.changesReobserved).toBe(1);
    const current = await listSplitwiseRemoteChanges(database.db, {});
    expect(current).toHaveLength(1);
  });

  it('does not reopen a decision when the same remote state comes back', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    const { changes } = await discover();
    await decideSplitwiseRemoteChange(database.db, {
      changeId: changes[0]!.id,
      decision: 'reject',
      reason: 'Their edit is wrong; ours is the figure we agreed.',
      audit: AS_USER,
    });

    await discover();
    const [current] = await listSplitwiseRemoteChanges(database.db, { includeSuperseded: false });
    expect(current?.status).toBe('rejected');
    expect(current?.decisionReason).toContain('Their edit is wrong');
  });

  it('supersedes a decided change when their side moves again, preserving the old one', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    const { changes } = await discover();
    await decideSplitwiseRemoteChange(database.db, {
      changeId: changes[0]!.id,
      decision: 'accept',
      reason: REASON,
      audit: AS_USER,
    });

    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(150_000n) })]);
    const second = await discover();
    expect(second.changesSuperseded).toBe(1);
    expect(second.changesCreated).toBe(1);

    const history = await listSplitwiseRemoteChanges(database.db, { includeSuperseded: true });
    const old = history.find((row) => row.id === changes[0]!.id);
    expect(old?.status).toBe('accepted');
    expect(old?.supersededAt).not.toBeNull();
    expect(old?.supersededByChangeId).not.toBeNull();
  });

  it('retires a change the pair no longer produces, once the pair was read completely', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    await discover();

    splitwise.setLedgerEntries('sw-friend-a', [entry()]);
    const second = await discover();
    expect(second.changesSuperseded).toBe(1);
    expect(await listSplitwiseRemoteChanges(database.db, {})).toEqual([]);
  });

  it('never retires a change on a read that failed', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    await discover();

    splitwise.failNextFetchBalances('Splitwise is unreachable');
    const second = await discover();
    expect(second.changesSuperseded).toBe(0);
    expect(await listSplitwiseRemoteChanges(database.db, {})).toHaveLength(1);
  });
});

describe('deciding about a change', () => {
  async function proposedDrift() {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    const { changes } = await discover();
    return changes[0]!;
  }

  it('requires a reason', async () => {
    const change = await proposedDrift();
    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: change.id,
        decision: 'accept',
        reason: '   ',
        audit: AS_USER,
      }),
    ).rejects.toThrow(/needs a reason/);
  });

  it('refuses a second decision on the same change', async () => {
    const change = await proposedDrift();
    await decideSplitwiseRemoteChange(database.db, {
      changeId: change.id,
      decision: 'accept',
      reason: REASON,
      audit: AS_USER,
    });
    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: change.id,
        decision: 'accept',
        reason: REASON,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/already accepted/);
  });

  it('refuses a target on a change that applies to its own sync row', async () => {
    const change = await proposedDrift();
    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: change.id,
        decision: 'accept',
        reason: REASON,
        targetId: cast.userPersonId,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/takes no local target/);
  });

  it('writes an audit event carrying the reason', async () => {
    const change = await proposedDrift();
    await decideSplitwiseRemoteChange(database.db, {
      changeId: change.id,
      decision: 'accept',
      reason: REASON,
      audit: AS_USER,
    });
    const events = await database.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'splitwise_remote_change'));
    expect(events.some((event) => event.reason === REASON)).toBe(true);
  });
});

describe('adopting an entry somebody created in Splitwise', () => {
  async function proposedAdoption() {
    splitwise.setLedgerEntries('sw-friend-a', [
      entry({
        splitwiseEntryId: 'sw-expense-99',
        description: 'Lunch',
        totalAmount: paise(40_000n),
      }),
    ]);
    const { changes } = await discover();
    return changes.find((change) => change.kind === 'remote_expense_unlinked')!;
  }

  it('joins the external entry to an expense the caller names, and creates nothing', async () => {
    const expenseId = await unsyncedLunch();
    const change = await proposedAdoption();

    const result = await decideSplitwiseRemoteChange(database.db, {
      changeId: change.id,
      decision: 'accept',
      reason: 'This is the lunch I already recorded here.',
      targetId: expenseId,
      audit: AS_USER,
    });
    expect(result.appliedEffect).toBe('adopt_expense_link');

    const link = await getSplitwiseExpenseByExpenseId(database.db, expenseId);
    // `drifted`, not `synced`: nothing was pushed, so agreement is something a comparison has
    // to establish rather than something adoption may assert.
    expect(link?.syncStatus).toBe('drifted');

    const expenses = await database.db.select().from(schema.expenses);
    expect(expenses).toHaveLength(1);
  });

  it('refuses to adopt without naming a local expense', async () => {
    await unsyncedLunch();
    const change = await proposedAdoption();
    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: change.id,
        decision: 'accept',
        reason: 'yes',
        audit: AS_USER,
      }),
    ).rejects.toThrow(/name the local record/);
  });

  it('refuses to give one expense a second external entry', async () => {
    const expenseId = await syncedDinner();
    const change = await proposedAdoption();
    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: change.id,
        decision: 'accept',
        reason: 'trying to repoint',
        targetId: expenseId,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/already linked/);
  });

  it('refuses to adopt against an expense nobody has approved', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Proposed lunch',
      amount: paise(40_000n),
      occurredAt: OCCURRED_AT,
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      state: 'review_required',
    });
    const change = await proposedAdoption();
    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: change.id,
        decision: 'accept',
        reason: 'not approved yet',
        targetId: expenseId,
        audit: AS_USER,
      }),
    ).rejects.toThrow(/Only an approved expense/);
  });

  it('has nothing to accept on a duplicate warning', async () => {
    splitwise.setLedgerEntries('sw-friend-a', [
      entry({ splitwiseEntryId: 'sw-a', description: 'Lunch', totalAmount: paise(40_000n) }),
      entry({ splitwiseEntryId: 'sw-b', description: 'Lunch', totalAmount: paise(40_000n) }),
    ]);
    const { changes } = await discover();
    const duplicate = changes.find((change) => change.kind === 'remote_duplicate_candidate')!;

    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: duplicate.id,
        decision: 'accept',
        reason: 'tidy it',
        audit: AS_USER,
      }),
    ).rejects.toThrow(/nothing to accept/);
  });
});

describe('mapping a person', () => {
  it('writes only the mapping, on a person who already exists', async () => {
    splitwise.setFriendBalances([
      { splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_000n) },
      { splitwiseUserId: 'sw-stranger', netBalance: paise(20_000n) },
    ]);
    splitwise.setLedgerEntries('sw-friend-a', []);
    const { changes } = await discover();
    const mapping = changes.find((change) => change.kind === 'remote_person_unmapped')!;
    const target = cast.person['person_friend_b']!;

    await decideSplitwiseRemoteChange(database.db, {
      changeId: mapping.id,
      decision: 'accept',
      reason: 'That account is my flatmate.',
      targetId: target,
      audit: AS_USER,
    });

    const [person] = await database.db
      .select()
      .from(schema.people)
      .where(eq(schema.people.id, target));
    expect(person?.splitwiseUserId).toBe('sw-stranger');
    expect(await database.db.select().from(schema.people)).toHaveLength(
      (await database.db.select().from(schema.people)).length,
    );
  });

  it('refuses to repoint a person who is already mapped', async () => {
    splitwise.setFriendBalances([
      { splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_000n) },
      { splitwiseUserId: 'sw-stranger', netBalance: paise(20_000n) },
    ]);
    splitwise.setLedgerEntries('sw-friend-a', []);
    const { changes } = await discover();
    const mapping = changes.find((change) => change.kind === 'remote_person_unmapped')!;

    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: mapping.id,
        decision: 'accept',
        reason: 'wrong person',
        targetId: friendId(),
        audit: AS_USER,
      }),
    ).rejects.toThrow(/already mapped/);
  });
});

describe('a settlement somebody deleted on their side', () => {
  async function syncedSettlement(): Promise<SettlementId> {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(45_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-20T10:00:00.000Z'),
      rawDescription: 'UPI-FRIENDA-REPAYMENT',
      channel: 'upi',
      counterpartyType: 'person',
      counterpartyId: friendId(),
    });
    const recorded = await recordSettlement(database.db, {
      paymentId,
      counterpartyPersonId: friendId(),
      amount: paise(45_000n),
      audit: AS_USER,
    });
    const settlementId = asId<'settlement'>(recorded.settlementId);
    await syncSettlementToSplitwise(database.db, { settlementId, splitwise, audit: AS_USER });
    return settlementId;
  }

  it('proposes the deletion, and accepting leaves the settlement recorded here', async () => {
    const settlementId = await syncedSettlement();
    splitwise.setLedgerEntries('sw-friend-a', []);

    const { changes } = await discover();
    const deletion = changes.find((change) => change.kind === 'remote_settlement_deleted')!;
    await decideSplitwiseRemoteChange(database.db, {
      changeId: deletion.id,
      decision: 'accept',
      reason: 'They removed the repayment entry; it still happened.',
      audit: AS_USER,
    });

    const link = await getSplitwiseSettlementBySettlementId(database.db, settlementId);
    expect(link?.syncStatus).toBe('externally_deleted');
    const settlements = await database.db.select().from(schema.settlements);
    expect(settlements).toHaveLength(1);
  });

  it('repairs it by creating the entry again, never by recording a second settlement', async () => {
    const settlementId = await syncedSettlement();
    splitwise.setLedgerEntries('sw-friend-a', []);
    const { changes } = await discover();
    const deletion = changes.find((change) => change.kind === 'remote_settlement_deleted')!;
    await decideSplitwiseRemoteChange(database.db, {
      changeId: deletion.id,
      decision: 'accept',
      reason: 'They removed the repayment entry.',
      audit: AS_USER,
    });

    // The candidate list says what the push will do, so a screen quotes it rather than
    // inferring "corrected" for a row with nothing standing (ADR-0055's rule, ADR-0056's case).
    const candidates = await listSettlementResyncCandidates(database.db);
    expect(candidates.find((row) => row.settlementId === settlementId)?.plannedRepair).toBe(
      'recreated',
    );

    const result = await resyncSettlementToSplitwise(database.db, {
      settlementId,
      splitwise,
      reason: 'Putting the repayment back after they deleted it.',
      audit: AS_USER,
    });
    expect(result.repair).toBe('recreated');
    // A create, not an update — and, critically, exactly one settlement here still.
    expect(splitwise.recordedPayments).toHaveLength(2);
    expect(splitwise.updatedPayments).toHaveLength(0);
    expect(await database.db.select().from(schema.settlements)).toHaveLength(1);

    const link = await getSplitwiseSettlementBySettlementId(database.db, settlementId);
    expect(link?.syncStatus).toBe('synced');
  });
});

describe('the HTTP surface', () => {
  it('discovers, lists, reads and decides', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);

    const discovered = await api.handle(
      new Request(`${BASE}/api/splitwise/remote-changes/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'user' }),
      }),
    );
    expect(discovered.status).toBe(201);

    const listed = await api.handle(new Request(`${BASE}/api/splitwise/remote-changes`));
    const body = (await listed.json()) as { changes: Array<{ id: string; consequence: string }> };
    expect(body.changes).toHaveLength(1);
    // The screen quotes the consequence; it never derives it (ADR-0048).
    expect(body.changes[0]?.consequence).toContain('stay exactly as they are');

    const detail = await api.handle(
      new Request(`${BASE}/api/splitwise/remote-changes/${body.changes[0]!.id}`),
    );
    const detailBody = (await detail.json()) as { needsTarget: boolean; acceptable: boolean };
    expect(detailBody).toMatchObject({ needsTarget: false, acceptable: true });

    const decided = await api.handle(
      new Request(`${BASE}/api/splitwise/remote-changes/${body.changes[0]!.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'accept', actor: 'user', reason: REASON }),
      }),
    );
    expect(decided.status).toBe(200);
    expect((await decided.json()) as { appliedEffect: string }).toMatchObject({
      appliedEffect: 'record_drift',
    });

    const reads = await api.handle(new Request(`${BASE}/api/splitwise/remote-reads`));
    expect(((await reads.json()) as { reads: unknown[] }).reads).toHaveLength(1);
  });

  it('refuses a decision with no reason', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    const { changes } = await discover();

    const response = await api.handle(
      new Request(`${BASE}/api/splitwise/remote-changes/${changes[0]!.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'accept', actor: 'user' }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses an actor that is not a person', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/splitwise/remote-changes/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'system' }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('has no route that writes a figure from a remote change', () => {
    const paths = api.routes
      .filter((route) => route.path.includes('remote-change'))
      .map((route) => `${route.method} ${route.path}`);
    expect(paths).toEqual([
      'POST /api/splitwise/remote-changes/discover',
      'GET /api/splitwise/remote-changes',
      'POST /api/splitwise/remote-changes/:id/decision',
      'GET /api/splitwise/remote-changes/:id',
    ]);
  });
});

describe('with no integration connected', () => {
  it('records the run as skipped and claims no agreement', async () => {
    await database.db.delete(schema.externalIntegrations);
    const result = await discover();
    expect(result.externalReadStatus).toBe('skipped');
    expect(result.externalReadDetail).toContain('nothing is claimed to agree');
    expect(result.changes).toEqual([]);
  });

  it('refuses a decision about a change that no longer stands', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    const { changes } = await discover();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(150_000n) })]);
    await discover();

    await expect(
      decideSplitwiseRemoteChange(database.db, {
        changeId: changes[0]!.id,
        decision: 'accept',
        reason: REASON,
        audit: AS_USER,
      }),
    ).rejects.toThrow(ServiceError);
  });
});

describe('retiring a change is itself an absence-based conclusion', () => {
  it('keeps a standing change when the pair could only be read partially', async () => {
    await syncedDinner();
    splitwise.setLedgerEntries('sw-friend-a', [entry({ totalAmount: paise(120_000n) })]);
    await discover();

    // Their side now reads as it always did — but only a page of it was read, so "the change
    // is gone" is not something this run saw. It is the same rule that stops a partial read
    // proposing a deletion, applied to closing one.
    splitwise.setLedgerEntries('sw-friend-a', [entry()], {
      complete: false,
      incompleteReason: 'read stopped at the page cap',
    });
    const second = await discover();

    expect(second.changesSuperseded).toBe(0);
    expect(await listSplitwiseRemoteChanges(database.db, {})).toHaveLength(1);
  });
});
