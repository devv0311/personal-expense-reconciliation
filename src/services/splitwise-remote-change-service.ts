/**
 * Reading changes made *in* Splitwise back into this ledger — as proposals, never as figures
 * (audit row 40, ADR-0056).
 *
 * The half ADR-0055 left open, and the half that needed the most care, because it is the only
 * direction in which somebody else's edit can reach this ledger at all. Three properties hold
 * for everything in this module:
 *
 *  - **Discovery writes no financial state.** It inserts a read row and change rows. There is
 *    no import of an `Expense`, `Allocation`, `Settlement` or `Payment` writer anywhere in this
 *    file, so "a discovery run cannot move money" is a property of the module graph.
 *  - **Accepting writes exactly what the change declared.** `effect` is computed by
 *    `domain.remoteChangeEffect` when the change is discovered, checked again when the decision
 *    arrives, and the applied effect is recorded beside the decision. Every one of them changes
 *    what this ledger knows about Splitwise; none changes an amount, an allocation or a balance.
 *  - **An incomplete read is never agreement.** A pair that could not be listed is counted as
 *    unchecked, absence-based changes are not produced from it, and a standing change is never
 *    retired by a read that did not have the standing to re-derive it.
 */

import { createHash } from 'node:crypto';

import {
  findPersonBySplitwiseUserId,
  getConnectedExternalIntegration,
  getExpenseById,
  getPersonById,
  getPrimaryUserPerson,
  getSettlementById,
  getSplitwiseExpenseByExpenseId,
  getSplitwiseRemoteChangeById,
  getSplitwiseRemoteReadById,
  getSplitwiseSettlementBySettlementId,
  findSplitwiseExpenseByExternalId,
  findSplitwiseSettlementByExternalId,
  insertSplitwiseExpense,
  insertSplitwiseRemoteChange,
  insertSplitwiseRemoteRead,
  insertSplitwiseSettlement,
  linkSplitwiseRemoteChangeSuccessor,
  listCurrentSplitwiseRemoteChanges,
  listLinkedSplitwiseSettlementsForPair,
  listPersonsWithSplitwiseUserId,
  listSplitwiseExpensesPaidByForAudit,
  listSplitwiseRemoteChanges,
  listSplitwiseRemoteReads,
  markSplitwiseRemoteChangeObserved,
  recordSplitwiseExpenseRemoteState,
  recordSplitwiseSettlementRemoteState,
  supersedeSplitwiseRemoteChange,
  updatePerson,
  updateSplitwiseRemoteChangeDecision,
  updateSplitwiseRemoteReadCounts,
} from '../db/index.js';
import type {
  Database,
  Executor,
  ExternalIntegrationRow,
  ListSplitwiseRemoteChangesFilter,
  SplitwiseRemoteChangeRow,
  SplitwiseRemoteReadRow,
} from '../db/index.js';
import {
  assertSplitwiseExpenseSyncTransition,
  assertSplitwiseSettlementSyncTransition,
  discoverRemoteChanges,
  discoverUnmappedPeople,
  remoteChangeComparisonSource,
  remoteChangeEffect,
  remoteChangeFingerprint,
  remoteChangeNeedsTarget,
  remoteChangeRequiresCompleteRead,
} from '../domain/index.js';
import type {
  ExpenseId,
  LinkedExpenseView,
  LinkedSettlementView,
  Paise,
  PersonId,
  RemoteEntryView,
  RemotePairObservation,
  SettlementId,
  SplitwiseExternalReadStatus,
  SplitwiseRemoteChangeDecision,
  SplitwiseRemoteChangeDraft,
  SplitwiseRemoteChangeId,
  SplitwiseRemoteChangeKind,
  SplitwiseRemoteReadId,
  UnmappedSplitwiseUser,
} from '../domain/index.js';
import type { SplitwiseFriendBalance, SplitwisePort } from '../integrations/splitwise/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { loadCurrentAllocation, resolveAllocationShares } from './loaders.js';

/* ============================================================================= running */

export interface DiscoverRemoteChangesServiceInput {
  readonly userPersonId: PersonId;
  readonly splitwise: SplitwisePort;
  readonly audit: AuditMeta;
}

export interface DiscoverRemoteChangesResult {
  readonly remoteReadId: SplitwiseRemoteReadId;
  readonly externalReadStatus: SplitwiseExternalReadStatus;
  readonly externalReadDetail: string | null;
  readonly pairsRead: number;
  readonly pairsUnchecked: number;
  readonly changesCreated: number;
  readonly changesReobserved: number;
  readonly changesSuperseded: number;
  /** Every change current after this run, newest comparison first. */
  readonly changes: readonly SplitwiseRemoteChangeRow[];
}

/**
 * Reads every mapped friend's Splitwise entries and records what differs, as proposals.
 *
 * Safe to re-run, and re-running is the only retry: identity is a fingerprint rather than a row
 * position, so a run after a transient failure converges on the same set of changes instead of
 * duplicating the ones that succeeded before.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` when this ledger has no `User`.
 */
export async function discoverSplitwiseRemoteChanges(
  db: Database,
  input: DiscoverRemoteChangesServiceInput,
): Promise<DiscoverRemoteChangesResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const integration = await loadConnectedIntegration(exec);

    if (integration === null) {
      return finishRun(exec, record, {
        integration: null,
        readStatus: 'skipped',
        readDetail:
          'No Splitwise ExternalIntegration is connected, so nothing external was read. ' +
          'Nothing was compared and nothing is claimed to agree.',
        drafts: [],
        pairsRead: 0,
        pairsUnchecked: 0,
        readPairKeys: new Set<string>(),
        completePairKeys: new Set<string>(),
        balancesRead: false,
      });
    }

    let balances: readonly SplitwiseFriendBalance[];
    try {
      balances = await input.splitwise.fetchBalances();
    } catch (error) {
      // No friends list means no pairs to walk. Recorded as a failed read rather than an empty
      // one: "we could not look" and "there is nothing to see" are different answers, and only
      // one of them is true here (ADR-0046).
      return finishRun(exec, record, {
        integration,
        readStatus: 'failed',
        readDetail: `Splitwise could not be read: ${errorText(error)}`,
        drafts: [],
        pairsRead: 0,
        pairsUnchecked: 0,
        readPairKeys: new Set<string>(),
        completePairKeys: new Set<string>(),
        balancesRead: false,
      });
    }

    const friends = await listPersonsWithSplitwiseUserId(exec, input.userPersonId);
    const mappedIds = new Set(friends.map((friend) => friend.splitwiseUserId));
    const localExpenses = await listSplitwiseExpensesPaidByForAudit(exec, input.userPersonId);

    const drafts: SplitwiseRemoteChangeDraft[] = [];
    const readPairKeys = new Set<string>();
    const completePairKeys = new Set<string>();
    const statuses: SplitwiseExternalReadStatus[] = [];
    let pairsUnchecked = 0;

    for (const friend of friends) {
      const pairKey = toPairKey(input.userPersonId, friend.id);
      readPairKeys.add(pairKey);

      const external = await readPairEntries(input.splitwise, friend.splitwiseUserId);
      statuses.push(external.status);
      if (external.status === 'complete') completePairKeys.add(pairKey);
      if (external.status === 'failed' || external.status === 'unsupported') pairsUnchecked += 1;

      const linkedExpenses = await buildLinkedExpenseViews(exec, {
        friendPersonId: friend.id,
        friendSplitwiseUserId: friend.splitwiseUserId,
        rows: localExpenses,
      });
      const linkedSettlements = await buildLinkedSettlementViews(exec, friend.id);

      drafts.push(
        ...discoverRemoteChanges({
          userPersonId: input.userPersonId,
          friendPersonId: friend.id,
          friendSplitwiseUserId: friend.splitwiseUserId,
          friendDisplayName: friend.displayName,
          linkedExpenses,
          linkedSettlements,
          external,
        }),
      );
    }

    const unmapped: UnmappedSplitwiseUser[] = balances
      .filter((balance) => !mappedIds.has(balance.splitwiseUserId))
      .map((balance) => ({
        splitwiseUserId: balance.splitwiseUserId,
        reportedNetBalance: balance.netBalance,
      }));
    const readStatus = worstReadStatus(statuses);
    drafts.push(...discoverUnmappedPeople(unmapped, readStatus, null));

    return finishRun(exec, record, {
      integration,
      readStatus,
      readDetail: firstIncompleteDetail(drafts),
      drafts,
      pairsRead: friends.length,
      pairsUnchecked,
      readPairKeys,
      completePairKeys,
      balancesRead: true,
    });
  });
}

/* ============================================================================= reading */

/** Discovery history, newest first. */
export async function listSplitwiseRemoteReadHistory(
  db: Executor,
  options: { readonly limit?: number } = {},
): Promise<readonly SplitwiseRemoteReadRow[]> {
  return listSplitwiseRemoteReads(db, options);
}

export async function listRemoteChanges(
  db: Executor,
  filter: ListSplitwiseRemoteChangesFilter = {},
): Promise<readonly SplitwiseRemoteChangeRow[]> {
  return listSplitwiseRemoteChanges(db, filter);
}

export interface SplitwiseRemoteChangeDetail {
  readonly change: SplitwiseRemoteChangeRow;
  readonly discoveredBy: SplitwiseRemoteReadRow | null;
  readonly lastObservedBy: SplitwiseRemoteReadRow | null;
  /** True when accepting needs the caller to name the local record to join to. */
  readonly needsTarget: boolean;
  /** False when this kind has no effect to apply — accepting is refused by name. */
  readonly acceptable: boolean;
}

export async function getRemoteChange(
  db: Executor,
  changeId: SplitwiseRemoteChangeId,
): Promise<SplitwiseRemoteChangeDetail | null> {
  const change = await getSplitwiseRemoteChangeById(db, changeId);
  if (change === null) return null;
  const [discoveredBy, lastObservedBy] = await Promise.all([
    getSplitwiseRemoteReadById(db, change.remoteReadId),
    getSplitwiseRemoteReadById(db, change.lastObservedReadId),
  ]);
  return {
    change,
    discoveredBy,
    lastObservedBy,
    needsTarget: remoteChangeNeedsTarget(change.kind),
    acceptable: change.effect !== 'none',
  };
}

/* ============================================================================ deciding */

export interface DecideRemoteChangeInput {
  readonly changeId: SplitwiseRemoteChangeId;
  readonly decision: SplitwiseRemoteChangeDecision;
  /** Why. Required for both decisions — accepting and rejecting are equally consequential. */
  readonly reason: string;
  /**
   * The local record an adoption or a mapping joins to.
   *
   * Required for `adopt_expense_link`, `adopt_settlement_link` and `map_person`, and refused
   * for every other effect: which local expense a Splitwise entry belongs to is a judgement no
   * comparison can make, and one no service should guess at.
   */
  readonly targetId?: string;
  readonly audit: AuditMeta;
}

export interface DecideRemoteChangeResult {
  readonly changeId: SplitwiseRemoteChangeId;
  readonly status: 'accepted' | 'rejected';
  /** What was actually applied. `null` for a rejection, which applies nothing. */
  readonly appliedEffect: string | null;
  readonly appliedTargetId: string | null;
  /** Stated back to the caller so a confirmation can quote what happened, not what was asked. */
  readonly appliedDescription: string;
}

/**
 * Records a person's decision about one discovered change, and applies its declared effect.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` when no such change exists.
 * @throws ServiceError `PRECONDITION_FAILED` when the change is already decided or superseded,
 *   when its effect cannot be accepted, when a target is required and missing (or supplied and
 *   not required), or when the named local record cannot take the link.
 */
export async function decideSplitwiseRemoteChange(
  db: Database,
  input: DecideRemoteChangeInput,
): Promise<DecideRemoteChangeResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'A decision about somebody else’s edit needs a reason. It is recorded on the change and ' +
        'on an audit event.',
      { field: 'reason' },
    );
  }

  return runAudited(db, { ...input.audit, reason }, async ({ exec, record }) => {
    const change = await getSplitwiseRemoteChangeById(exec, input.changeId);
    if (change === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', `No remote change with id ${input.changeId}.`, {
        changeId: input.changeId,
      });
    }
    if (change.supersededAt !== null) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'This change has been superseded by a later observation. Decide about the current one ' +
          'instead — what stands in Splitwise now is not what this row describes.',
        { changeId: change.id },
      );
    }
    if (change.status !== 'proposed') {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `This change was already ${change.status}. Deciding twice would apply its effect twice.`,
        { changeId: change.id, status: change.status },
      );
    }

    if (input.decision === 'reject') {
      if (input.targetId !== undefined) {
        throw new ServiceError(
          'PRECONDITION_FAILED',
          'A rejection names no local record: it applies nothing.',
          { field: 'targetId' },
        );
      }
      await updateSplitwiseRemoteChangeDecision(exec, change.id, {
        status: 'rejected',
        decidedAt: new Date(),
        decidedBy: input.audit.actor,
        decisionReason: reason,
        appliedEffect: null,
        appliedTargetId: null,
      });
      await record({
        entityType: 'splitwise_remote_change',
        entityId: change.id,
        action: 'update',
        oldValue: { status: change.status },
        newValue: { status: 'rejected', appliedEffect: null },
        reason,
      });
      return {
        changeId: change.id,
        status: 'rejected' as const,
        appliedEffect: null,
        appliedTargetId: null,
        appliedDescription:
          'Nothing was applied. The change stays on file with your reason, and a later ' +
          'discovery run that sees the same thing will not raise it again.',
      };
    }

    if (change.effect === 'none') {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'This change has nothing to accept — it is a warning about somebody else’s ledger, ' +
          'and this system does not change their records to tidy a comparison. Reject it once ' +
          'you have looked, or resolve it in Splitwise.',
        { changeId: change.id, kind: change.kind },
      );
    }

    const needsTarget = remoteChangeNeedsTarget(change.kind);
    if (needsTarget && (input.targetId === undefined || input.targetId.trim().length === 0)) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'Accepting this change has to name the local record it joins to. Which one it is is a ' +
          'judgement no comparison can make.',
        { field: 'targetId', kind: change.kind },
      );
    }
    if (!needsTarget && input.targetId !== undefined) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'This change applies to the sync row it already names; it takes no local target.',
        { field: 'targetId', kind: change.kind },
      );
    }

    const applied = await applyEffect(exec, record, change, input.targetId?.trim() ?? null, reason);

    await updateSplitwiseRemoteChangeDecision(exec, change.id, {
      status: 'accepted',
      decidedAt: new Date(),
      decidedBy: input.audit.actor,
      decisionReason: reason,
      appliedEffect: change.effect,
      appliedTargetId: applied.targetId,
    });
    await record({
      entityType: 'splitwise_remote_change',
      entityId: change.id,
      action: 'update',
      oldValue: { status: change.status },
      newValue: {
        status: 'accepted',
        appliedEffect: change.effect,
        appliedTargetId: applied.targetId,
      },
      reason,
    });

    return {
      changeId: change.id,
      status: 'accepted' as const,
      appliedEffect: change.effect,
      appliedTargetId: applied.targetId,
      appliedDescription: applied.description,
    };
  });
}

/* ------------------------------------------------------------------ applying an effect */

interface AppliedEffect {
  readonly targetId: string | null;
  readonly description: string;
}

async function applyEffect(
  exec: Executor,
  record: AuditContext['record'],
  change: SplitwiseRemoteChangeRow,
  targetId: string | null,
  reason: string,
): Promise<AppliedEffect> {
  switch (change.effect) {
    case 'record_drift':
      return recordDrift(exec, record, change, reason);
    case 'record_external_deletion':
      return recordExternalDeletion(exec, record, change, reason);
    case 'adopt_expense_link':
      return adoptExpenseLink(exec, record, change, targetId as ExpenseId | null, reason);
    case 'adopt_settlement_link':
      return adoptSettlementLink(exec, record, change, targetId as SettlementId | null, reason);
    case 'map_person':
      return mapPerson(exec, record, change, targetId as PersonId | null, reason);
    case 'none':
      throw new ServiceError('PRECONDITION_FAILED', 'This change has nothing to apply.', {
        changeId: change.id,
      });
  }
}

/**
 * Records what Splitwise now holds, and marks the sync row `drifted`.
 *
 * Note what is not written: the expense, its allocation, the settlement, the payment. The
 * remote figure lands in `their_snapshot`, which is a record of *what they say*, beside the
 * `our_snapshot` that stays exactly as it was — the figure this ledger actually sent, which is
 * what every later comparison is made against.
 */
async function recordDrift(
  exec: Executor,
  record: AuditContext['record'],
  change: SplitwiseRemoteChangeRow,
  reason: string,
): Promise<AppliedEffect> {
  if (change.splitwiseExpenseRowId !== null) {
    await recordSplitwiseExpenseRemoteState(exec, change.splitwiseExpenseRowId, {
      syncStatus: 'drifted',
      theirSnapshot: change.remoteSnapshot,
    });
    await record({
      entityType: 'splitwise_expense',
      entityId: change.splitwiseExpenseRowId,
      action: 'update',
      oldValue: { syncStatus: 'synced' },
      newValue: { syncStatus: 'drifted', theirSnapshot: change.remoteSnapshot },
      reason,
    });
    return {
      targetId: change.splitwiseExpenseRowId,
      description:
        'Splitwise’s current figure is recorded on the sync row and the row is marked drifted. ' +
        'Your expense, its allocation and every balance are unchanged.',
    };
  }
  if (change.splitwiseSettlementRowId !== null) {
    await recordSplitwiseSettlementRemoteState(exec, change.splitwiseSettlementRowId, {
      syncStatus: 'drifted',
      theirSnapshot: change.remoteSnapshot,
    });
    await record({
      entityType: 'splitwise_settlement',
      entityId: change.splitwiseSettlementRowId,
      action: 'update',
      oldValue: { syncStatus: 'synced' },
      newValue: { syncStatus: 'drifted', theirSnapshot: change.remoteSnapshot },
      reason,
    });
    return {
      targetId: change.splitwiseSettlementRowId,
      description:
        'Splitwise’s current figure is recorded on the sync row and the row is marked drifted. ' +
        'The settlement and the payment behind it are unchanged.',
    };
  }
  throw new ServiceError(
    'PRECONDITION_FAILED',
    'This change names no sync row to record against.',
    { changeId: change.id },
  );
}

async function recordExternalDeletion(
  exec: Executor,
  record: AuditContext['record'],
  change: SplitwiseRemoteChangeRow,
  reason: string,
): Promise<AppliedEffect> {
  if (change.splitwiseExpenseRowId !== null) {
    const existing = await getSplitwiseExpenseRowStatus(exec, change);
    assertSplitwiseExpenseSyncTransition(existing, 'externally_deleted');
    await recordSplitwiseExpenseRemoteState(exec, change.splitwiseExpenseRowId, {
      syncStatus: 'externally_deleted',
      theirSnapshot: change.remoteSnapshot,
    });
    await record({
      entityType: 'splitwise_expense',
      entityId: change.splitwiseExpenseRowId,
      action: 'update',
      oldValue: { syncStatus: existing },
      newValue: { syncStatus: 'externally_deleted' },
      reason,
    });
    return {
      targetId: change.splitwiseExpenseRowId,
      description:
        'The sync row is marked externally deleted and keeps the external id it held, so past ' +
        'findings can still be explained. Your expense is untouched, and the repair will offer ' +
        'to put an entry back.',
    };
  }
  if (change.splitwiseSettlementRowId !== null) {
    const existing = await getSplitwiseSettlementRowStatus(exec, change);
    assertSplitwiseSettlementSyncTransition(existing, 'externally_deleted');
    await recordSplitwiseSettlementRemoteState(exec, change.splitwiseSettlementRowId, {
      syncStatus: 'externally_deleted',
      theirSnapshot: change.remoteSnapshot,
    });
    await record({
      entityType: 'splitwise_settlement',
      entityId: change.splitwiseSettlementRowId,
      action: 'update',
      oldValue: { syncStatus: existing },
      newValue: { syncStatus: 'externally_deleted' },
      reason,
    });
    return {
      targetId: change.splitwiseSettlementRowId,
      description:
        'The sync row is marked externally deleted. The settlement stays recorded here: a ' +
        'repayment that happened does not un-happen because its Splitwise entry was removed.',
    };
  }
  throw new ServiceError('PRECONDITION_FAILED', 'This change names no sync row to close.', {
    changeId: change.id,
  });
}

/**
 * Joins an external entry to a local expense the caller named.
 *
 * Creates a `SplitwiseExpense` link row and nothing else. It refuses rather than repointing
 * when either side is already claimed, because an adoption that silently moved an existing
 * link would lose the record of what was synced where — and because two entries answering to
 * one expense is precisely the ambiguity this must not resolve by guessing.
 */
async function adoptExpenseLink(
  exec: Executor,
  record: AuditContext['record'],
  change: SplitwiseRemoteChangeRow,
  expenseId: ExpenseId | null,
  reason: string,
): Promise<AppliedEffect> {
  if (expenseId === null || change.externalReference === null) {
    throw new ServiceError('PRECONDITION_FAILED', 'Adopting an entry needs both ids.', {
      changeId: change.id,
    });
  }

  const expense = await getExpenseById(exec, expenseId);
  if (expense === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No expense with id ${expenseId}.`, { expenseId });
  }
  if (
    expense.state === 'proposed' ||
    expense.state === 'classified' ||
    expense.state === 'rejected' ||
    expense.state === 'review_required'
  ) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `This expense is "${expense.state}". Only an approved expense can be joined to a ` +
        'Splitwise entry — an unapproved one has no figure anybody has agreed to.',
      { expenseId, state: expense.state },
    );
  }

  const alreadyLinked = await getSplitwiseExpenseByExpenseId(exec, expenseId);
  if (alreadyLinked !== null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This expense is already linked to a Splitwise entry. Adopting a second one would give ' +
        'it two external records, which is the duplicate this system exists to avoid.',
      { expenseId, splitwiseExpenseId: alreadyLinked.id },
    );
  }
  const claimed = await findSplitwiseExpenseByExternalId(
    exec,
    change.externalIntegrationId,
    change.externalReference,
  );
  if (claimed !== null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Splitwise entry ${change.externalReference} is already linked to expense ` +
        `${claimed.expenseId}.`,
      { externalReference: change.externalReference, expenseId: claimed.expenseId },
    );
  }

  // `drifted`, not `synced`: this ledger never pushed this entry, so the two sides agreeing is
  // something a comparison has to establish rather than something adoption may assert.
  const splitwiseExpenseId = await insertSplitwiseExpense(exec, {
    expenseId,
    externalIntegrationId: change.externalIntegrationId,
    splitwiseExpenseId: change.externalReference,
    syncedAt: new Date(),
    ourSnapshot: {
      adoptedFromRemoteChangeId: change.id,
      adoptionReason: reason,
      // Deliberately not a `shares` payload: nothing was sent, and a snapshot claiming a
      // payload would make a later drift comparison measure against a push that never happened.
      pushed: false,
    },
    theirSnapshot: change.remoteSnapshot,
    syncStatus: 'drifted',
  });
  await record({
    entityType: 'splitwise_expense',
    entityId: splitwiseExpenseId,
    action: 'create',
    newValue: {
      expenseId,
      splitwiseExpenseId: change.externalReference,
      syncStatus: 'drifted',
      adopted: true,
    },
    reason,
  });

  return {
    targetId: expenseId,
    description:
      'The Splitwise entry and this expense now share a link, recorded as drifted because ' +
      'nothing was pushed and the two figures have not been reconciled. No money moved.',
  };
}

async function adoptSettlementLink(
  exec: Executor,
  record: AuditContext['record'],
  change: SplitwiseRemoteChangeRow,
  settlementId: SettlementId | null,
  reason: string,
): Promise<AppliedEffect> {
  if (settlementId === null || change.externalReference === null) {
    throw new ServiceError('PRECONDITION_FAILED', 'Adopting a payment needs both ids.', {
      changeId: change.id,
    });
  }

  const settlement = await getSettlementById(exec, settlementId);
  if (settlement === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No settlement with id ${settlementId}.`, {
      settlementId,
    });
  }
  const alreadyLinked = await getSplitwiseSettlementBySettlementId(exec, settlementId);
  if (alreadyLinked !== null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This settlement is already linked to a Splitwise payment.',
      { settlementId, splitwiseSettlementId: alreadyLinked.id },
    );
  }
  const claimed = await findSplitwiseSettlementByExternalId(
    exec,
    change.externalIntegrationId,
    change.externalReference,
  );
  if (claimed !== null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Splitwise payment ${change.externalReference} is already linked to settlement ` +
        `${claimed.settlementId}.`,
      { externalReference: change.externalReference, settlementId: claimed.settlementId },
    );
  }

  const splitwiseSettlementId = await insertSplitwiseSettlement(exec, {
    settlementId,
    externalIntegrationId: change.externalIntegrationId,
    splitwiseTransactionId: change.externalReference,
    syncedAt: new Date(),
    ourSnapshot: {
      adoptedFromRemoteChangeId: change.id,
      adoptionReason: reason,
      pushed: false,
    },
    theirSnapshot: change.remoteSnapshot,
    syncStatus: 'drifted',
  });
  await record({
    entityType: 'splitwise_settlement',
    entityId: splitwiseSettlementId,
    action: 'create',
    newValue: {
      settlementId,
      splitwiseTransactionId: change.externalReference,
      syncStatus: 'drifted',
      adopted: true,
    },
    reason,
  });

  return {
    targetId: settlementId,
    description:
      'The Splitwise payment and this settlement now share a link, recorded as drifted. The ' +
      'settlement’s own amount and the payment behind it are unchanged.',
  };
}

/**
 * Maps a Splitwise account onto a `Person` the caller named.
 *
 * The one change kind whose effect touches a row outside the sync tables — and it writes one
 * column, on a person who already exists. It never creates a `Person`: who somebody is, is
 * master data a person enters, not something a friends list decides.
 */
async function mapPerson(
  exec: Executor,
  record: AuditContext['record'],
  change: SplitwiseRemoteChangeRow,
  personId: PersonId | null,
  reason: string,
): Promise<AppliedEffect> {
  if (personId === null || change.externalUserReference === null) {
    throw new ServiceError('PRECONDITION_FAILED', 'Mapping needs both a person and an account.', {
      changeId: change.id,
    });
  }

  const person = await getPersonById(exec, personId);
  if (person === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No person with id ${personId}.`, { personId });
  }
  if (person.splitwiseUserId !== null && person.splitwiseUserId !== change.externalUserReference) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `${person.displayName} is already mapped to Splitwise account ${person.splitwiseUserId}. ` +
        'Change it from the people screen if that mapping is wrong — doing it here would ' +
        'silently repoint every comparison that has ever used it.',
      { personId, existing: person.splitwiseUserId },
    );
  }
  const claimed = await findPersonBySplitwiseUserId(exec, change.externalUserReference);
  if (claimed !== null && claimed !== personId) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Splitwise account ${change.externalUserReference} is already mapped to another person.`,
      { splitwiseUserId: change.externalUserReference, personId: claimed },
    );
  }

  await updatePerson(exec, personId, { splitwiseUserId: change.externalUserReference });
  await record({
    entityType: 'person',
    entityId: personId,
    action: 'update',
    oldValue: { splitwiseUserId: person.splitwiseUserId },
    newValue: { splitwiseUserId: change.externalUserReference },
    reason,
  });

  return {
    targetId: personId,
    description:
      `${person.displayName} is now mapped to Splitwise account ` +
      `${change.externalUserReference}. The next audit and the next discovery run can read ` +
      'their pair; nothing about any existing figure changed.',
  };
}

/* ---------------------------------------------------------------------- run internals */

interface FinishRunInput {
  readonly integration: ExternalIntegrationRow | null;
  readonly readStatus: SplitwiseExternalReadStatus;
  readonly readDetail: string | null;
  readonly drafts: readonly SplitwiseRemoteChangeDraft[];
  readonly pairsRead: number;
  readonly pairsUnchecked: number;
  readonly readPairKeys: ReadonlySet<string>;
  readonly completePairKeys: ReadonlySet<string>;
  /** Whether the friends list itself was read — what a person-mapping change depends on. */
  readonly balancesRead: boolean;
}

async function finishRun(
  exec: Executor,
  record: AuditContext['record'],
  input: FinishRunInput,
): Promise<DiscoverRemoteChangesResult> {
  const remoteReadId = await insertSplitwiseRemoteRead(exec, {
    externalIntegrationId: input.integration?.id ?? null,
    externalReadStatus: input.readStatus,
    externalReadDetail: input.readDetail,
    pairsRead: input.pairsRead,
    pairsUnchecked: input.pairsUnchecked,
  });

  const tallies =
    input.integration === null
      ? { changesCreated: 0, changesReobserved: 0, changesSuperseded: 0 }
      : await reconcileChanges(exec, record, {
          remoteReadId,
          externalIntegrationId: input.integration.id,
          drafts: input.drafts,
          readPairKeys: input.readPairKeys,
          completePairKeys: input.completePairKeys,
          balancesRead: input.balancesRead,
        });

  await updateSplitwiseRemoteReadCounts(exec, remoteReadId, tallies);
  await record({
    entityType: 'splitwise_remote_read',
    entityId: remoteReadId,
    action: 'create',
    newValue: {
      externalReadStatus: input.readStatus,
      externalReadDetail: input.readDetail,
      pairsRead: input.pairsRead,
      pairsUnchecked: input.pairsUnchecked,
      ...tallies,
    },
  });

  return {
    remoteReadId,
    externalReadStatus: input.readStatus,
    externalReadDetail: input.readDetail,
    pairsRead: input.pairsRead,
    pairsUnchecked: input.pairsUnchecked,
    ...tallies,
    changes: await listSplitwiseRemoteChanges(exec, { limit: 500 }),
  };
}

interface ReconcileTallies {
  readonly changesCreated: number;
  readonly changesReobserved: number;
  readonly changesSuperseded: number;
}

/**
 * Matches this run's changes against the ones already on record.
 *
 * Three outcomes, and they are the idempotency contract:
 *
 *  - **The same comparison again** — only "seen again" is written. No new row, no audit event,
 *    and crucially **no change to a decision somebody already made**: they decided about this
 *    exact remote state, and re-reading it does not unmake that.
 *  - **A materially different comparison** — the standing row is superseded and a fresh
 *    `proposed` one inserted. The old row keeps its snapshots and its decision, because what
 *    they decided about is not what stands now.
 *  - **A change this run did not reproduce** — closed as history, but only when this run
 *    actually had the standing to re-derive it: the pair was read, and, for an absence-based
 *    kind, read completely. A change is never retired by a read that failed.
 */
async function reconcileChanges(
  exec: Executor,
  record: AuditContext['record'],
  input: {
    readonly remoteReadId: SplitwiseRemoteReadId;
    readonly externalIntegrationId: ExternalIntegrationRow['id'];
    readonly drafts: readonly SplitwiseRemoteChangeDraft[];
    readonly readPairKeys: ReadonlySet<string>;
    readonly completePairKeys: ReadonlySet<string>;
    readonly balancesRead: boolean;
  },
): Promise<ReconcileTallies> {
  const existing = await listCurrentSplitwiseRemoteChanges(exec);
  const existingByFingerprint = new Map(existing.map((row) => [row.fingerprint, row]));
  const seen = new Set<string>();

  let changesCreated = 0;
  let changesReobserved = 0;
  let changesSuperseded = 0;

  for (const draft of input.drafts) {
    const fingerprint = remoteChangeFingerprint(draft);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const comparisonDigest = digestOf(draft);
    const standing = existingByFingerprint.get(fingerprint);

    if (standing !== undefined && standing.comparisonDigest === comparisonDigest) {
      await markSplitwiseRemoteChangeObserved(exec, standing.id, input.remoteReadId);
      changesReobserved += 1;
      continue;
    }

    if (standing !== undefined) {
      await supersedeSplitwiseRemoteChange(exec, standing.id);
      changesSuperseded += 1;
    }

    const changeId = await insertSplitwiseRemoteChange(exec, {
      remoteReadId: input.remoteReadId,
      externalIntegrationId: input.externalIntegrationId,
      kind: draft.kind,
      effect: draft.effect,
      summary: draft.summary,
      consequence: draft.consequence,
      readStatus: draft.readStatus,
      readDetail: draft.readDetail,
      personAId: draft.personAId,
      personBId: draft.personBId,
      expenseId: draft.expenseId,
      splitwiseExpenseRowId: draft.splitwiseExpenseRowId,
      settlementId: draft.settlementId,
      splitwiseSettlementRowId: draft.splitwiseSettlementRowId,
      externalReference: draft.externalReference,
      externalUserReference: draft.externalUserReference,
      amount: draft.amount,
      localSnapshot: draft.localSnapshot,
      remoteSnapshot: draft.remoteSnapshot,
      subjects: draft.subjects,
      fingerprint,
      comparisonDigest,
    });
    changesCreated += 1;

    if (standing !== undefined) {
      await linkSplitwiseRemoteChangeSuccessor(exec, standing.id, changeId);
      await record({
        entityType: 'splitwise_remote_change',
        entityId: standing.id,
        action: 'supersede',
        oldValue: { comparisonDigest: standing.comparisonDigest, status: standing.status },
        newValue: { supersededByChangeId: changeId, statusPreserved: standing.status },
      });
    }

    await record({
      entityType: 'splitwise_remote_change',
      entityId: changeId,
      action: 'create',
      newValue: {
        kind: draft.kind,
        effect: draft.effect,
        readStatus: draft.readStatus,
        amount: draft.amount === null ? null : draft.amount.toString(),
        externalReference: draft.externalReference,
        supersedes: standing?.id ?? null,
      },
    });
  }

  for (const row of existing) {
    if (seen.has(row.fingerprint)) continue;
    if (!canRetire(row, input)) continue;

    await supersedeSplitwiseRemoteChange(exec, row.id);
    changesSuperseded += 1;
    await record({
      entityType: 'splitwise_remote_change',
      entityId: row.id,
      action: 'supersede',
      oldValue: { kind: row.kind, summary: row.summary, status: row.status },
      newValue: { supersedeReason: 'no_longer_observed', remoteReadId: input.remoteReadId },
    });
  }

  return { changesCreated, changesReobserved, changesSuperseded };
}

/** Whether this run saw enough to say a standing change no longer holds. */
function canRetire(
  row: SplitwiseRemoteChangeRow,
  input: {
    readonly readPairKeys: ReadonlySet<string>;
    readonly completePairKeys: ReadonlySet<string>;
    readonly balancesRead: boolean;
  },
): boolean {
  if (row.kind === 'remote_person_unmapped') return input.balancesRead;
  if (row.personAId === null || row.personBId === null) return false;

  const pairKey = toPairKey(row.personAId, row.personBId);
  if (!input.readPairKeys.has(pairKey)) return false;
  // Everything but an absence-based kind was derived from entries that were actually read, so
  // not seeing it again is a real observation. An absence-based one needs the whole pair.
  if (!remoteChangeRequiresCompleteRead(row.kind)) return input.completePairKeys.has(pairKey);
  return input.completePairKeys.has(pairKey);
}

/* ------------------------------------------------------------------- loading the local */

async function buildLinkedExpenseViews(
  exec: Executor,
  input: {
    readonly friendPersonId: PersonId;
    readonly friendSplitwiseUserId: string;
    readonly rows: Awaited<ReturnType<typeof listSplitwiseExpensesPaidByForAudit>>;
  },
): Promise<readonly LinkedExpenseView[]> {
  const views: LinkedExpenseView[] = [];

  for (const row of input.rows) {
    const current = await loadCurrentAllocation(exec, row.expenseId);
    const shares = current === null ? [] : resolveAllocationShares(current);
    const participates =
      shares.some((share) => share.beneficiaryId === input.friendPersonId) ||
      snapshotShareFor(row.ourSnapshot, input.friendSplitwiseUserId) !== null;
    if (!participates) continue;

    views.push({
      splitwiseExpenseRowId: row.id,
      expenseId: row.expenseId,
      externalId: row.splitwiseExpenseId,
      syncStatus: row.syncStatus,
      description: row.description,
      expenseNetAmount: row.netAmount,
      syncedAmount: snapshotTotalFor(row.ourSnapshot),
    });
  }
  return views;
}

async function buildLinkedSettlementViews(
  exec: Executor,
  friendPersonId: PersonId,
): Promise<readonly LinkedSettlementView[]> {
  const rows = await listLinkedSplitwiseSettlementsForPair(exec, friendPersonId);
  return rows.map((row) => ({
    splitwiseSettlementRowId: row.splitwiseSettlementRowId,
    settlementId: row.settlementId,
    externalId: row.externalId,
    syncStatus: row.syncStatus,
    amount: row.amount,
    direction: row.direction,
  }));
}

/**
 * The total this ledger pushed, out of the payload it recorded pushing.
 *
 * `null` — not zero — when the snapshot has no such figure, which is the case for an adopted
 * link that was never pushed. The comparison then falls back to the expense's current net,
 * which is the only figure this ledger has an opinion about for that entry.
 */
function snapshotTotalFor(snapshot: unknown): Paise | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const value = (snapshot as { netAmount?: unknown }).netAmount;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  return BigInt(value) as Paise;
}

function snapshotShareFor(snapshot: unknown, splitwiseUserId: string): Paise | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const shares = (snapshot as { shares?: unknown }).shares;
  if (!Array.isArray(shares)) return null;

  let total: bigint | null = null;
  for (const entry of shares) {
    if (typeof entry !== 'object' || entry === null) continue;
    const share = entry as { splitwiseUserId?: unknown; owedAmount?: unknown };
    if (share.splitwiseUserId !== splitwiseUserId) continue;
    if (typeof share.owedAmount !== 'string' || !/^-?\d+$/.test(share.owedAmount)) continue;
    total = (total ?? 0n) + BigInt(share.owedAmount);
  }
  return total === null ? null : (total as Paise);
}

async function getSplitwiseExpenseRowStatus(
  exec: Executor,
  change: SplitwiseRemoteChangeRow,
): Promise<'synced' | 'drifted' | 'stale'> {
  if (change.expenseId === null) {
    throw new ServiceError('PRECONDITION_FAILED', 'This change names no expense.', {
      changeId: change.id,
    });
  }
  const link = await getSplitwiseExpenseByExpenseId(exec, change.expenseId);
  if (link === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'The Splitwise link row has disappeared.', {
      changeId: change.id,
    });
  }
  if (
    link.syncStatus !== 'synced' &&
    link.syncStatus !== 'drifted' &&
    link.syncStatus !== 'stale'
  ) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `The sync row is now "${link.syncStatus}", which no longer asserts an entry in Splitwise. ` +
        'Re-run discovery to see what currently differs.',
      { changeId: change.id, syncStatus: link.syncStatus },
    );
  }
  return link.syncStatus;
}

async function getSplitwiseSettlementRowStatus(
  exec: Executor,
  change: SplitwiseRemoteChangeRow,
): Promise<'synced' | 'drifted'> {
  if (change.settlementId === null) {
    throw new ServiceError('PRECONDITION_FAILED', 'This change names no settlement.', {
      changeId: change.id,
    });
  }
  const link = await getSplitwiseSettlementBySettlementId(exec, change.settlementId);
  if (link === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'The Splitwise link row has disappeared.', {
      changeId: change.id,
    });
  }
  if (link.syncStatus !== 'synced' && link.syncStatus !== 'drifted') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `The sync row is now "${link.syncStatus}". Re-run discovery to see what currently differs.`,
      { changeId: change.id, syncStatus: link.syncStatus },
    );
  }
  return link.syncStatus;
}

async function loadConnectedIntegration(exec: Executor): Promise<ExternalIntegrationRow | null> {
  const ownerUser = await getPrimaryUserPerson(exec);
  if (ownerUser === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      'No User exists, so there is no Splitwise integration to read changes from.',
    );
  }
  return getConnectedExternalIntegration(exec, ownerUser.userId, 'splitwise');
}

async function readPairEntries(
  splitwise: SplitwisePort,
  friendSplitwiseUserId: string,
): Promise<RemotePairObservation> {
  if (typeof splitwise.fetchLedgerEntries !== 'function') {
    return {
      status: 'unsupported',
      detail:
        'the configured SplitwisePort cannot list a pair’s entries, so nothing about their ' +
        'side could be read — which is not the same as nothing having changed',
      entries: [],
    };
  }

  let result;
  try {
    result = await splitwise.fetchLedgerEntries({ friendSplitwiseUserId });
  } catch (error) {
    return { status: 'failed', detail: errorText(error), entries: [] };
  }

  const entries: RemoteEntryView[] = result.entries.map((entry) => ({
    externalId: entry.splitwiseEntryId,
    kind: entry.kind,
    description: entry.description,
    totalAmount: entry.totalAmount,
    deleted: entry.deleted,
    occurredAt: entry.occurredAt,
    pairNetBalance: entry.pairNetBalance,
  }));

  return {
    status: result.complete ? 'complete' : 'partial',
    detail: result.incompleteReason ?? null,
    entries,
  };
}

function digestOf(draft: SplitwiseRemoteChangeDraft): string {
  return createHash('sha256').update(remoteChangeComparisonSource(draft)).digest('hex');
}

function toPairKey(a: PersonId, b: PersonId): string {
  return `${a}|${b}`;
}

/** The worst status across every pair — one clean pair never speaks for an unread one. */
function worstReadStatus(
  statuses: readonly SplitwiseExternalReadStatus[],
): SplitwiseExternalReadStatus {
  const ranking: readonly SplitwiseExternalReadStatus[] = [
    'failed',
    'unsupported',
    'partial',
    'skipped',
    'complete',
  ];
  for (const candidate of ranking) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'complete';
}

function firstIncompleteDetail(drafts: readonly SplitwiseRemoteChangeDraft[]): string | null {
  const incomplete = drafts.find((draft) => draft.readStatus !== 'complete');
  return incomplete?.readDetail ?? null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported so `src/api` never has to know which module a kind came from. */
export type { SplitwiseRemoteChangeKind };
export { remoteChangeEffect };
