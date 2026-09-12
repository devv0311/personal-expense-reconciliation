/**
 * What discovery may and may not conclude from an external listing (ADR-0056).
 *
 * The tests that matter most here are the ones about **absence**: an entry missing from a page
 * is an entry nobody looked for, and the difference between reporting that as a deletion and
 * not reporting it is the difference between this capability being safe and being a machine
 * that invents other people's acts.
 */

import { describe, expect, it } from 'vitest';

import { paise } from './money.js';
import {
  discoverRemoteChanges,
  discoverUnmappedPeople,
  remoteChangeComparisonSource,
  remoteChangeEffect,
  remoteChangeFingerprint,
  remoteChangeNeedsTarget,
  remoteChangeRequiresCompleteRead,
} from './splitwise-remote-change.js';
import type {
  DiscoverRemoteChangesInput,
  LinkedExpenseView,
  LinkedSettlementView,
  RemoteEntryView,
} from './splitwise-remote-change.js';
import type { ExpenseId, PersonId, SettlementId, SplitwiseExpenseId } from './ids.js';
import type { SplitwiseSettlementId } from './ids.js';

const USER = 'person-user' as PersonId;
const FRIEND = 'person-friend' as PersonId;

function linkedExpense(overrides: Partial<LinkedExpenseView> = {}): LinkedExpenseView {
  return {
    splitwiseExpenseRowId: 'sw-row-1' as SplitwiseExpenseId,
    expenseId: 'expense-1' as ExpenseId,
    externalId: 'sw-expense-1',
    syncStatus: 'synced',
    description: 'Dinner',
    expenseNetAmount: paise(90000n),
    syncedAmount: paise(90000n),
    ...overrides,
  };
}

function linkedSettlement(overrides: Partial<LinkedSettlementView> = {}): LinkedSettlementView {
  return {
    splitwiseSettlementRowId: 'sw-settle-1' as SplitwiseSettlementId,
    settlementId: 'settlement-1' as SettlementId,
    externalId: 'sw-payment-1',
    syncStatus: 'synced',
    amount: paise(45000n),
    direction: 'debit',
    ...overrides,
  };
}

function remoteEntry(overrides: Partial<RemoteEntryView> = {}): RemoteEntryView {
  return {
    externalId: 'sw-expense-1',
    kind: 'expense',
    description: 'Dinner',
    totalAmount: paise(90000n),
    deleted: false,
    occurredAt: new Date('2026-08-01T00:00:00.000Z'),
    pairNetBalance: paise(-45000n),
    ...overrides,
  };
}

function input(overrides: Partial<DiscoverRemoteChangesInput> = {}): DiscoverRemoteChangesInput {
  return {
    userPersonId: USER,
    friendPersonId: FRIEND,
    friendSplitwiseUserId: 'sw-friend',
    friendDisplayName: 'Priya',
    linkedExpenses: [],
    linkedSettlements: [],
    external: { status: 'complete', detail: null, entries: [] },
    ...overrides,
  };
}

describe('discoverRemoteChanges', () => {
  it('says nothing when both ledgers agree', () => {
    const changes = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: { status: 'complete', detail: null, entries: [remoteEntry()] },
      }),
    );
    expect(changes).toEqual([]);
  });

  it('reports an entry they edited, with both figures recorded', () => {
    const [change, ...rest] = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: {
          status: 'complete',
          detail: null,
          entries: [remoteEntry({ totalAmount: paise(120000n) })],
        },
      }),
    );
    expect(rest).toEqual([]);
    expect(change?.kind).toBe('remote_expense_amount_changed');
    expect(change?.effect).toBe('record_drift');
    expect(change?.amount).toBe(30000n);
    expect(change?.localSnapshot['syncedAmount']).toBe('90000');
    expect(change?.remoteSnapshot?.['totalAmount']).toBe('120000');
    // The consequence is stated by the engine, not by whoever renders it (ADR-0048).
    expect(change?.consequence).toMatch(/stay exactly as they are/);
  });

  it('reports an entry Splitwise marks deleted, whatever the read status', () => {
    const changes = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: {
          status: 'partial',
          detail: 'page cap',
          entries: [remoteEntry({ deleted: true })],
        },
      }),
    );
    expect(changes.map((change) => change.kind)).toEqual(['remote_expense_deleted']);
    expect(changes[0]?.readStatus).toBe('partial');
  });

  it('never infers a deletion from an incomplete listing', () => {
    const changes = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: { status: 'partial', detail: 'read stopped at the page cap', entries: [] },
      }),
    );
    expect(changes).toEqual([]);
  });

  it('infers a deletion from a complete listing that does not hold the entry', () => {
    const changes = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: { status: 'complete', detail: null, entries: [] },
      }),
    );
    expect(changes.map((change) => change.kind)).toEqual(['remote_expense_deleted']);
    expect(changes[0]?.remoteSnapshot).toEqual({ present: false });
  });

  it('leaves a row alone when nothing is standing in Splitwise for it', () => {
    for (const syncStatus of [
      'withdrawn',
      'externally_deleted',
      'pending',
      'sync_failed',
    ] as const) {
      const changes = discoverRemoteChanges(
        input({
          linkedExpenses: [linkedExpense({ syncStatus })],
          external: { status: 'complete', detail: null, entries: [] },
        }),
      );
      expect(changes, `status ${syncStatus}`).toEqual([]);
    }
  });

  it('offers an unlinked entry for adoption, and says it cannot create an expense', () => {
    const [change] = discoverRemoteChanges(
      input({
        external: {
          status: 'complete',
          detail: null,
          entries: [remoteEntry({ externalId: 'sw-expense-9' })],
        },
      }),
    );
    expect(change?.kind).toBe('remote_expense_unlinked');
    expect(change?.effect).toBe('adopt_expense_link');
    expect(change?.consequence).toMatch(/cannot create an expense/);
  });

  it('treats an unlinked payment as a settlement adoption, which cannot create one either', () => {
    const [change] = discoverRemoteChanges(
      input({
        external: {
          status: 'complete',
          detail: null,
          entries: [remoteEntry({ externalId: 'sw-payment-9', kind: 'payment' })],
        },
      }),
    );
    expect(change?.kind).toBe('remote_settlement_unlinked');
    expect(change?.consequence).toMatch(/cannot create a settlement/);
  });

  it('flags indistinguishable unlinked entries, with nothing to accept', () => {
    const changes = discoverRemoteChanges(
      input({
        external: {
          status: 'complete',
          detail: null,
          entries: [
            remoteEntry({ externalId: 'sw-expense-a' }),
            remoteEntry({ externalId: 'sw-expense-b' }),
          ],
        },
      }),
    );
    const duplicate = changes.find((change) => change.kind === 'remote_duplicate_candidate');
    expect(duplicate?.effect).toBe('none');
    expect(duplicate?.subjects.map((subject) => subject.id)).toEqual([
      'sw-expense-a',
      'sw-expense-b',
    ]);
    // Adoption of each individual entry stays available: the guard belongs at the adoption,
    // where a local expense can hold only one link.
    expect(changes.filter((change) => change.kind === 'remote_expense_unlinked')).toHaveLength(2);
  });

  it('reports a settlement they edited, and never a second settlement to fix it', () => {
    const [change] = discoverRemoteChanges(
      input({
        linkedSettlements: [linkedSettlement()],
        external: {
          status: 'complete',
          detail: null,
          entries: [
            remoteEntry({
              externalId: 'sw-payment-1',
              kind: 'payment',
              totalAmount: paise(50000n),
            }),
          ],
        },
      }),
    );
    expect(change?.kind).toBe('remote_settlement_amount_changed');
    expect(change?.effect).toBe('record_drift');
    expect(change?.consequence).toMatch(/settlement and the payment behind it are unchanged/);
  });

  it('falls back to the expense net when the snapshot recorded no pushed total', () => {
    const changes = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense({ syncedAmount: null, expenseNetAmount: paise(60000n) })],
        external: { status: 'complete', detail: null, entries: [remoteEntry()] },
      }),
    );
    expect(changes.map((change) => change.kind)).toEqual(['remote_expense_amount_changed']);
  });
});

describe('discoverUnmappedPeople', () => {
  it('names an unmapped Splitwise account without creating anybody', () => {
    const [change] = discoverUnmappedPeople(
      [{ splitwiseUserId: 'sw-stranger', reportedNetBalance: paise(25000n) }],
      'complete',
      null,
    );
    expect(change?.kind).toBe('remote_person_unmapped');
    expect(change?.effect).toBe('map_person');
    expect(change?.externalUserReference).toBe('sw-stranger');
    expect(change?.consequence).toMatch(/does not create/i);
  });
});

describe('the effect table', () => {
  it('never writes money for any kind', () => {
    const effects = [
      'remote_expense_amount_changed',
      'remote_settlement_amount_changed',
      'remote_expense_deleted',
      'remote_settlement_deleted',
      'remote_expense_unlinked',
      'remote_settlement_unlinked',
      'remote_person_unmapped',
      'remote_duplicate_candidate',
    ] as const;
    expect(effects.map(remoteChangeEffect)).toEqual([
      'record_drift',
      'record_drift',
      'record_external_deletion',
      'record_external_deletion',
      'adopt_expense_link',
      'adopt_settlement_link',
      'map_person',
      'none',
    ]);
  });

  it('knows which acceptances need a local record named', () => {
    expect(remoteChangeNeedsTarget('remote_expense_unlinked')).toBe(true);
    expect(remoteChangeNeedsTarget('remote_settlement_unlinked')).toBe(true);
    expect(remoteChangeNeedsTarget('remote_person_unmapped')).toBe(true);
    expect(remoteChangeNeedsTarget('remote_expense_amount_changed')).toBe(false);
  });

  it('marks exactly the absence-based kinds as needing a complete read', () => {
    expect(remoteChangeRequiresCompleteRead('remote_expense_deleted')).toBe(true);
    expect(remoteChangeRequiresCompleteRead('remote_settlement_deleted')).toBe(true);
    expect(remoteChangeRequiresCompleteRead('remote_expense_amount_changed')).toBe(false);
  });
});

describe('identity and materiality', () => {
  it('keeps its identity across a moved figure, so a re-run supersedes rather than duplicates', () => {
    const first = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: {
          status: 'complete',
          detail: null,
          entries: [remoteEntry({ totalAmount: paise(120000n) })],
        },
      }),
    )[0]!;
    const second = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: {
          status: 'complete',
          detail: null,
          entries: [remoteEntry({ totalAmount: paise(150000n) })],
        },
      }),
    )[0]!;

    expect(remoteChangeFingerprint(first)).toBe(remoteChangeFingerprint(second));
    expect(remoteChangeComparisonSource(first)).not.toBe(remoteChangeComparisonSource(second));
  });

  it('ignores the read status in the digest, so a degraded read does not churn a decision', () => {
    const complete = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: {
          status: 'complete',
          detail: null,
          entries: [remoteEntry({ totalAmount: paise(120000n) })],
        },
      }),
    )[0]!;
    const partial = discoverRemoteChanges(
      input({
        linkedExpenses: [linkedExpense()],
        external: {
          status: 'partial',
          detail: 'page cap',
          entries: [remoteEntry({ totalAmount: paise(120000n) })],
        },
      }),
    )[0]!;

    expect(remoteChangeComparisonSource(complete)).toBe(remoteChangeComparisonSource(partial));
  });
});
