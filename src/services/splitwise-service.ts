/**
 * Syncing an already-`APPROVED` `Expense`/`Settlement` to Splitwise, for the first time
 * (`docs/roadmap.md` phase 14, `data-flow.md` step 8).
 *
 * No AI call is on this path at all — by the time an expense reaches `READY_TO_SYNC`, or a
 * settlement is recorded, every field involved is already APPROVED data. Building the payload
 * and calling the port happen in one call, matching every other consequential write this
 * codebase ships (`approveAllocation`, `recordExpenseAdjustment`, `recordSettlement`), not a
 * stored-proposal-then-confirm pair (ADR-0040).
 *
 * A `SplitwiseExpense`/`SplitwiseSettlement` row can only exist once the port already returned
 * an external id — `splitwise_expense_id`/`splitwise_transaction_id`/`synced_at` are `NOT NULL`
 * — so a failing port call writes nothing, leaving the expense at `ready_to_sync` and the
 * settlement unsynced, and a retry is simply calling this again (ADR-0040).
 */

import { assertExpenseTransition, settlementParties } from '../domain/index.js';
import type { ExpenseId, PersonId, SettlementId } from '../domain/index.js';
import {
  getConnectedExternalIntegration,
  getPersonById,
  getPrimaryUserPerson,
  getSettlementById,
  getSplitwiseExpenseByExpenseId,
  getSplitwiseSettlementBySettlementId,
  insertExternalIntegration,
  insertSplitwiseExpense,
  insertSplitwiseSettlement,
  updateExpenseState,
} from '../db/index.js';
import type { Database, Executor, ExternalIntegrationRow } from '../db/index.js';
import type { SplitwiseExpenseShare, SplitwisePort } from '../integrations/splitwise/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { requireUserPersonId } from './classification-service.js';
import { ServiceError } from './errors.js';
import {
  requireCurrentAllocation,
  requireExpenseSnapshot,
  requirePayment,
  resolveAllocationShares,
} from './loaders.js';

/* ------------------------------------------------------------------------- connecting */

export interface ConnectSplitwiseIntegrationInput {
  /** An identifier for the sandbox/test account — never a credential or token. */
  readonly externalAccountRef: string | null;
}

export interface ConnectSplitwiseIntegrationResult {
  readonly externalIntegrationId: string;
  readonly status: 'connected';
}

/**
 * Records a connected `ExternalIntegration`.
 *
 * Not run through `runAudited`: `ExternalIntegration` is SYSTEM-classified
 * (`domain-model.md`), not APPROVED or user-facing DERIVED data, so invariant #21's audit
 * requirement does not reach it — the same reason `people`/`accounts`/`users` have no
 * `AuditEvent` entity type of their own either (`audit_events_entity_type_check`).
 *
 * No credential ever crosses this function — `security-model.md` forbids storing one in this
 * table in plaintext, and this phase does not wire a real account in the first place
 * (`CLAUDE.md`, "do not connect real Splitwise accounts during development").
 */
export async function connectSplitwiseIntegration(
  db: Database,
  input: ConnectSplitwiseIntegrationInput,
): Promise<ConnectSplitwiseIntegrationResult> {
  const ownerUserId = await requireOwnerUserId(db);
  const externalIntegrationId = await insertExternalIntegration(db, {
    type: 'splitwise',
    ownerUserId,
    externalAccountRef: input.externalAccountRef,
    status: 'connected',
    connectedAt: new Date(),
  });

  return { externalIntegrationId, status: 'connected' };
}

/* --------------------------------------------------------------------- syncing an expense */

export interface SyncExpenseToSplitwiseInput {
  readonly expenseId: ExpenseId;
  readonly splitwise: SplitwisePort;
  readonly audit: AuditMeta;
}

export interface SyncExpenseToSplitwiseResult {
  readonly splitwiseExpenseId: string;
  readonly syncStatus: 'synced';
}

/**
 * Syncs an `Expense` to Splitwise for the first time.
 *
 * @throws ServiceError `PRECONDITION_FAILED` when the expense is not `ready_to_sync`, already
 *   has a `SplitwiseExpense`, no `ExternalIntegration` is connected, or a payer/beneficiary has
 *   no `splitwise_user_id`.
 * @throws ServiceError `SPLITWISE_SYNC_FAILED` when the port rejects — no row is written.
 */
export async function syncExpenseToSplitwise(
  db: Database,
  input: SyncExpenseToSplitwiseInput,
): Promise<SyncExpenseToSplitwiseResult> {
  const expense = await requireExpenseSnapshot(db, input.expenseId);
  if (expense.state !== 'ready_to_sync') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Expense ${expense.id} is "${expense.state}", not "ready_to_sync" ` +
        '(domain-model.md, SplitwiseExpense Lifecycle) — it cannot be synced yet.',
      { expenseId: expense.id, state: expense.state },
    );
  }

  const existing = await getSplitwiseExpenseByExpenseId(db, expense.id);
  if (existing !== null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Expense ${expense.id} already has a SplitwiseExpense (sync_status "${existing.syncStatus}"). ` +
        'There is no re-sync path in this phase; syncing an expense happens once.',
      { expenseId: expense.id, syncStatus: existing.syncStatus },
    );
  }

  const integration = await requireConnectedIntegration(db);
  const current = await requireCurrentAllocation(db, expense.id);
  const resolvedShares = resolveAllocationShares(current);

  const payer = await requireSplitwiseLinkedPerson(db, expense.paidByPersonId);
  const shares: SplitwiseExpenseShare[] = [];
  for (const share of resolvedShares) {
    const person = await requireSplitwiseLinkedPerson(db, share.beneficiaryId);
    shares.push({ splitwiseUserId: person.splitwiseUserId, owedAmount: share.amount });
  }

  let created;
  try {
    created = await input.splitwise.createExpense({
      description: expense.description ?? null,
      amount: expense.netAmount,
      currency: expense.currency,
      paidBySplitwiseUserId: payer.splitwiseUserId,
      shares,
    });
  } catch (error) {
    throw new ServiceError(
      'SPLITWISE_SYNC_FAILED',
      `Splitwise refused to create the expense for ${expense.id}: ` +
        (error instanceof Error ? error.message : String(error)),
      { expenseId: expense.id },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    assertExpenseTransition(expense.state, 'synced');
    const syncedAt = new Date();

    const splitwiseExpenseId = await insertSplitwiseExpense(exec, {
      expenseId: expense.id,
      externalIntegrationId: integration.id,
      splitwiseExpenseId: created.splitwiseExpenseId,
      syncedAt,
      ourSnapshot: {
        netAmount: expense.netAmount.toString(),
        payer: payer.splitwiseUserId,
        shares: shares.map((share) => ({
          splitwiseUserId: share.splitwiseUserId,
          owedAmount: share.owedAmount.toString(),
        })),
      },
      theirSnapshot: created.theirSnapshot,
      syncStatus: 'synced',
    });

    await updateExpenseState(exec, expense.id, 'synced');

    await record({
      entityType: 'splitwise_expense',
      entityId: splitwiseExpenseId,
      action: 'create',
      newValue: { expenseId: expense.id, splitwiseExpenseId: created.splitwiseExpenseId },
    });
    await record({
      entityType: 'expense',
      entityId: expense.id,
      action: 'update',
      oldValue: { state: 'ready_to_sync' },
      newValue: { state: 'synced' },
    });

    return { splitwiseExpenseId: created.splitwiseExpenseId, syncStatus: 'synced' as const };
  });
}

/* ------------------------------------------------------------------- syncing a settlement */

export interface SyncSettlementToSplitwiseInput {
  readonly settlementId: SettlementId;
  readonly splitwise: SplitwisePort;
  readonly audit: AuditMeta;
}

export interface SyncSettlementToSplitwiseResult {
  readonly splitwiseTransactionId: string;
  readonly syncStatus: 'synced';
}

/**
 * Syncs a `Settlement` to Splitwise for the first time.
 *
 * `fromPersonId`/`toPersonId` come from `domain.settlementParties`, resolved from the
 * settlement's linked `Payment` direction — never re-derived here.
 */
export async function syncSettlementToSplitwise(
  db: Database,
  input: SyncSettlementToSplitwiseInput,
): Promise<SyncSettlementToSplitwiseResult> {
  const settlement = await requireSettlement(db, input.settlementId);

  const existing = await getSplitwiseSettlementBySettlementId(db, settlement.id);
  if (existing !== null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Settlement ${settlement.id} already has a SplitwiseSettlement (sync_status ` +
        `"${existing.syncStatus}"). There is no re-sync path in this phase.`,
      { settlementId: settlement.id, syncStatus: existing.syncStatus },
    );
  }

  const integration = await requireConnectedIntegration(db);
  const payment = await requirePayment(db, settlement.paymentId);
  const userPersonId = await requireUserPersonId(db);
  const { fromPersonId, toPersonId } = settlementParties(
    {
      counterpartyPersonId: settlement.counterpartyPersonId,
      direction: payment.direction,
      amount: settlement.amount,
    },
    userPersonId,
  );

  const fromPerson = await requireSplitwiseLinkedPerson(db, fromPersonId);
  const toPerson = await requireSplitwiseLinkedPerson(db, toPersonId);

  let recorded;
  try {
    recorded = await input.splitwise.recordPayment({
      amount: settlement.amount,
      fromSplitwiseUserId: fromPerson.splitwiseUserId,
      toSplitwiseUserId: toPerson.splitwiseUserId,
    });
  } catch (error) {
    throw new ServiceError(
      'SPLITWISE_SYNC_FAILED',
      `Splitwise refused to record the payment for settlement ${settlement.id}: ` +
        (error instanceof Error ? error.message : String(error)),
      { settlementId: settlement.id },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const syncedAt = new Date();
    const splitwiseSettlementId = await insertSplitwiseSettlement(exec, {
      settlementId: settlement.id,
      externalIntegrationId: integration.id,
      splitwiseTransactionId: recorded.splitwiseTransactionId,
      syncedAt,
      ourSnapshot: {
        amount: settlement.amount.toString(),
        from: fromPerson.splitwiseUserId,
        to: toPerson.splitwiseUserId,
      },
      theirSnapshot: recorded.theirSnapshot,
      syncStatus: 'synced',
    });

    await record({
      entityType: 'splitwise_settlement',
      entityId: splitwiseSettlementId,
      action: 'create',
      newValue: {
        settlementId: settlement.id,
        splitwiseTransactionId: recorded.splitwiseTransactionId,
      },
    });

    return {
      splitwiseTransactionId: recorded.splitwiseTransactionId,
      syncStatus: 'synced' as const,
    };
  });
}

/* ------------------------------------------------------------------------- internals */

async function requireOwnerUserId(exec: Executor) {
  const userPerson = await getPrimaryUserPerson(exec);
  if (userPerson === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      'No User exists, so there is nobody to own a Splitwise ExternalIntegration ' +
        '(domain-model.md: a User maps to exactly one Person).',
    );
  }
  return userPerson.userId;
}

async function requireConnectedIntegration(exec: Executor): Promise<ExternalIntegrationRow> {
  const userId = await requireOwnerUserId(exec);
  const integration = await getConnectedExternalIntegration(exec, userId, 'splitwise');
  if (integration === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'No connected Splitwise ExternalIntegration exists. Connect one before syncing ' +
        '(POST /api/integrations/splitwise/connect).',
    );
  }
  return integration;
}

async function requireSplitwiseLinkedPerson(
  exec: Executor,
  personId: PersonId,
): Promise<{ readonly splitwiseUserId: string }> {
  const person = await getPersonById(exec, personId);
  if (person === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No person with id ${personId}.`, { personId });
  }
  if (person.splitwiseUserId === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `${person.displayName} (${personId}) has no linked Splitwise user ` +
        '(people.splitwise_user_id), so a payload naming them cannot be built.',
      { personId },
    );
  }
  return { splitwiseUserId: person.splitwiseUserId };
}

async function requireSettlement(exec: Executor, settlementId: SettlementId) {
  const settlement = await getSettlementById(exec, settlementId);
  if (settlement === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No settlement with id ${settlementId}.`, {
      settlementId,
    });
  }
  return settlement;
}
