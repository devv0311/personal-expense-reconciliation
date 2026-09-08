/**
 * Repairing a `stale` or `drifted` Splitwise row (audit row 40).
 *
 * The audit's finding was exact: *"`stale` and `drifted` are meaningful states/findings, not
 * implemented repair actions."* An expense whose refund lowered its net still sat in Splitwise
 * at the old figure, and the only paths out were to leave it wrong or to fix it by hand in
 * their app. This is the repair.
 *
 * What makes it safe to write to somebody else's ledger at all:
 *
 *  - **A person asks for it, every time.** There is no automatic re-sync. `stale` is a state a
 *    person reads and decides about; this service is what their decision calls.
 *  - **It pushes what this ledger already approved.** The figure sent is the current
 *    allocation's — the one a person approved here — never a merge of theirs and ours. This
 *    ledger is canonical (`CLAUDE.md`, principle 9); re-sync makes Splitwise agree with it.
 *  - **A failure changes nothing.** The remote call happens before the transaction that
 *    records it, exactly as `syncExpenseToSplitwise` does, so a refusal leaves both ledgers as
 *    they were and the row still `stale` — visible, and still repairable.
 *  - **It never deletes.** Splitwise's own delete is deliberately not wired: an external row
 *    this ledger no longer explains is a *finding* for a person to resolve, and deleting
 *    somebody else's record to make an audit clean is the opposite of auditing it.
 */

import {
  getConnectedExternalIntegration,
  getPersonById,
  getPrimaryUserPerson,
  getSplitwiseExpenseByExpenseId,
  getSplitwiseExpenseRow,
  listResyncableSplitwiseExpenses,
  updateSplitwiseExpenseSync,
} from '../db/index.js';
import type { Database, Executor } from '../db/index.js';
import type { ExpenseId, PersonId, SplitwiseExpenseId } from '../domain/index.js';
import type { SplitwiseExpenseShare, SplitwisePort } from '../integrations/splitwise/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import {
  requireCurrentAllocation,
  requireExpenseSnapshot,
  resolveAllocationShares,
} from './loaders.js';

/** One row Splitwise and this ledger disagree about, with what each currently says. */
export interface ResyncCandidate {
  readonly splitwiseExpenseId: SplitwiseExpenseId;
  readonly expenseId: ExpenseId;
  readonly externalId: string;
  readonly syncStatus: string;
  readonly syncedAt: Date;
  /** What was pushed when it was last synced — the figure Splitwise still holds. */
  readonly syncedSnapshot: unknown;
  /** The expense's current net, which is what a re-sync would push. */
  readonly currentNetAmount: string;
  readonly description: string | null;
}

/**
 * Every synced row whose local expense has moved on, or that a drift comparison flagged.
 *
 * A read. Nothing here decides that any of them *should* be re-synced — that is a person's
 * call, one row at a time, and this is the list they make it from.
 */
export async function listResyncCandidates(db: Executor): Promise<readonly ResyncCandidate[]> {
  return listResyncableSplitwiseExpenses(db);
}

export interface ResyncExpenseInput {
  readonly expenseId: ExpenseId;
  readonly splitwise: SplitwisePort;
  /** Why this row is being corrected in somebody else's ledger. Required. */
  readonly reason: string;
  readonly audit: AuditMeta;
}

export interface ResyncExpenseResult {
  readonly splitwiseExpenseId: string;
  readonly syncStatus: 'synced';
  /** The figure Splitwise held before, and the one it holds now. */
  readonly previousSnapshot: unknown;
  readonly pushedNetAmount: string;
}

/**
 * Pushes an expense's current split to Splitwise, replacing what was synced before.
 *
 * Splitwise's API has no update-in-place for an expense's shares that this system can rely on,
 * so a re-sync creates a corrected entry and records it against the same local expense. The
 * old external id stays on the row's history: an audit that could no longer see the entry it
 * once matched could not explain its own past findings.
 *
 * @throws ServiceError `PRECONDITION_FAILED` when the expense was never synced, or is not
 *   `stale`/`drifted` — re-syncing a row that already agrees would write a duplicate into
 *   somebody else's ledger for no reason.
 * @throws ServiceError `SPLITWISE_SYNC_FAILED` when Splitwise refuses. Nothing is written.
 */
export async function resyncExpenseToSplitwise(
  db: Database,
  input: ResyncExpenseInput,
): Promise<ResyncExpenseResult> {
  if (input.reason.trim().length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      "Correcting a row in somebody else's ledger records why. Without a reason, the other " +
        'person sees a changed figure and no account of it.',
      { field: 'reason' },
    );
  }

  const expense = await requireExpenseSnapshot(db, input.expenseId);
  const link = await getSplitwiseExpenseByExpenseId(db, expense.id);
  if (link === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This expense has never been synced to Splitwise, so there is nothing to re-sync. Sync ' +
        'it first.',
      { expenseId: expense.id },
    );
  }
  if (link.syncStatus !== 'stale' && link.syncStatus !== 'drifted') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `This row is "${link.syncStatus}". Re-syncing one the ledgers already agree about would ` +
        "write a duplicate into somebody else's ledger for no reason.",
      { expenseId: expense.id, syncStatus: link.syncStatus },
    );
  }

  const userPerson = await getPrimaryUserPerson(db);
  if (userPerson === null) {
    throw new ServiceError('PRECONDITION_FAILED', 'This ledger has no user.');
  }
  const integration = await getConnectedExternalIntegration(db, userPerson.userId, 'splitwise');
  if (integration === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'No Splitwise integration is connected, so there is nothing to push to.',
    );
  }

  const current = await requireCurrentAllocation(db, expense.id);
  const resolved = resolveAllocationShares(current);
  const payer = await requireSplitwiseUserId(db, expense.paidByPersonId);
  const shares: SplitwiseExpenseShare[] = [];
  for (const share of resolved) {
    shares.push({
      splitwiseUserId: await requireSplitwiseUserId(db, share.beneficiaryId),
      owedAmount: share.amount,
    });
  }

  const before = await getSplitwiseExpenseRow(db, link.id);

  // The remote call first, outside any transaction: a refusal must leave both ledgers exactly
  // as they were, with the row still `stale` and still repairable.
  let created;
  try {
    created = await input.splitwise.createExpense({
      description:
        expense.description === null ? 'Corrected expense' : `${expense.description} (corrected)`,
      amount: expense.netAmount,
      currency: expense.currency,
      paidBySplitwiseUserId: payer,
      shares,
    });
  } catch (error) {
    throw new ServiceError(
      'SPLITWISE_SYNC_FAILED',
      `Splitwise refused the correction for ${expense.id}: ` +
        (error instanceof Error ? error.message : String(error)),
      { expenseId: expense.id },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const syncedAt = new Date();
    const ourSnapshot = {
      netAmount: expense.netAmount.toString(),
      payer,
      shares: shares.map((share) => ({
        splitwiseUserId: share.splitwiseUserId,
        owedAmount: share.owedAmount.toString(),
      })),
      // The entry this one corrects. Kept so a later audit can still explain why Splitwise
      // holds two entries for one expense, rather than reporting the older one as a duplicate.
      supersedesExternalId: before?.splitwiseExpenseId ?? null,
      correctionReason: input.reason,
    };

    await updateSplitwiseExpenseSync(exec, link.id, {
      splitwiseExpenseId: created.splitwiseExpenseId,
      syncedAt,
      ourSnapshot,
      theirSnapshot: created.theirSnapshot,
      syncStatus: 'synced',
    });

    await record({
      entityType: 'splitwise_expense',
      entityId: link.id,
      action: 'update',
      oldValue: {
        syncStatus: link.syncStatus,
        splitwiseExpenseId: before?.splitwiseExpenseId ?? null,
        ourSnapshot: before?.ourSnapshot ?? null,
      },
      newValue: {
        syncStatus: 'synced',
        splitwiseExpenseId: created.splitwiseExpenseId,
        ourSnapshot,
      },
      reason: input.reason,
    });

    return {
      splitwiseExpenseId: created.splitwiseExpenseId,
      syncStatus: 'synced' as const,
      previousSnapshot: before?.ourSnapshot ?? null,
      pushedNetAmount: expense.netAmount.toString(),
    };
  });
}

/* --------------------------------------------------------------------------- internals */

async function requireSplitwiseUserId(db: Executor, personId: PersonId): Promise<string> {
  const person = await getPersonById(db, personId);
  if (person === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such person.', { personId });
  }
  if (person.splitwiseUserId === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `${person.displayName} is not mapped to a Splitwise account, so their share cannot be ` +
        'pushed. Map them first (Settings → People).',
      { personId },
    );
  }
  return person.splitwiseUserId;
}
