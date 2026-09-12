/**
 * Repairing a `stale`, `drifted` or `withdrawn` Splitwise row (audit row 40, ADR-0055).
 *
 * The audit's finding was exact: *"`stale` and `drifted` are meaningful states/findings, not
 * implemented repair actions."* An expense whose refund lowered its net still sat in Splitwise
 * at the old figure, and the only paths out were to leave it wrong or to fix it by hand in
 * their app.
 *
 * The first version of this repair corrected an entry by **creating a second one**. That closed
 * the gap on paper and left the other person holding two records for one dinner — the older
 * still asserting the pre-refund share — with nothing on their screen saying which was current.
 * Splitwise's own balance would then count both. A correction that makes the counterparty's
 * ledger worse is not a correction; this module now edits the entry they are looking at.
 *
 * What makes it safe to write to somebody else's ledger at all:
 *
 *  - **A person asks for it, every time.** There is no automatic re-sync. `stale` is a state a
 *    person reads and decides about; this service is what their decision calls.
 *  - **It pushes what this ledger already approved.** The figure sent is the current
 *    allocation's — the one a person approved here — never a merge of theirs and ours. This
 *    ledger is canonical (`CLAUDE.md`, principle 9); re-sync makes Splitwise agree with it.
 *  - **The id does not move.** A correction keeps `splitwise_expense_id` exactly as it was, and
 *    the port is asked to prove it. The one exception is a row this ledger previously withdrew,
 *    where nothing is standing to correct and a create is the honest repair.
 *  - **A failure changes nothing.** The remote call happens before the transaction that
 *    records it, exactly as `syncExpenseToSplitwise` does, so a refusal leaves both ledgers as
 *    they were and the row still repairable.
 *  - **A port that cannot do it says so.** `updateExpense` is optional. An adapter without it
 *    makes the repair refuse **by name** rather than fall back to `createExpense` — the
 *    fallback is the defect, not the safety net.
 *  - **It deletes for exactly one reason.** An expense whose net has reached zero cannot be
 *    represented in Splitwise at all, and leaving the old figure standing asserts a debt this
 *    ledger no longer says exists. An external row this ledger merely cannot *explain* is a
 *    finding for a person to resolve (ADR-0046) — never something to delete out of the way.
 */

import {
  getConnectedExternalIntegration,
  getPersonById,
  getPrimaryUserPerson,
  getSettlementById,
  getSplitwiseExpenseByExpenseId,
  getSplitwiseExpenseRow,
  getSplitwiseSettlementBySettlementId,
  getSplitwiseSettlementRow,
  listResyncableSplitwiseExpenses,
  listResyncableSplitwiseSettlements,
  updateSplitwiseExpenseSync,
  updateSplitwiseSettlementSync,
} from '../db/index.js';
import type { Database, Executor } from '../db/index.js';
import { assertSplitwiseExpenseSyncTransition, settlementParties } from '../domain/index.js';
import type {
  ExpenseId,
  PersonId,
  SettlementId,
  SplitwiseExpenseSyncStatus,
  SplitwiseExpenseId,
  SplitwiseSettlementId,
} from '../domain/index.js';
import type { SplitwiseExpenseShare, SplitwisePort } from '../integrations/splitwise/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import {
  requireCurrentAllocation,
  requireExpenseSnapshot,
  requirePayment,
  resolveAllocationShares,
} from './loaders.js';

/* ------------------------------------------------------------------ what the port can do */

/**
 * Whether the injected port can repair at all, and in plain words why not when it cannot.
 *
 * A read, exposed so a surface can say "this cannot be done here" instead of offering a button
 * that fails (ADR-0050). It describes the port's declared capability, not whether Splitwise is
 * currently reachable — an unconfigured port still declares the methods and still rejects when
 * called, exactly as it does for a first sync.
 */
export interface SplitwiseRepairCapability {
  /** An entry already in Splitwise can be corrected in place. */
  readonly canCorrect: boolean;
  /** An entry can be removed — needed only for an expense whose net has reached zero. */
  readonly canWithdraw: boolean;
  /** A settlement already in Splitwise can be corrected in place. */
  readonly canCorrectSettlement: boolean;
}

export function describeSplitwiseRepairCapability(
  splitwise: SplitwisePort,
): SplitwiseRepairCapability {
  return {
    canCorrect: typeof splitwise.updateExpense === 'function',
    canWithdraw: typeof splitwise.deleteEntry === 'function',
    canCorrectSettlement: typeof splitwise.updatePayment === 'function',
  };
}

/* ------------------------------------------------------------------------- the candidates */

/**
 * Which of the three repairs actually happened, named rather than inferred from the figures.
 *
 * `corrected` — the entry they were already looking at now holds our figure.
 * `withdrawn` — the net reached zero, so the entry was removed rather than left standing.
 * `recreated` — nothing was standing (this ledger had withdrawn it), so a new entry was made.
 */
export type SplitwiseRepairKind = 'corrected' | 'withdrawn' | 'recreated';

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
  /**
   * What repairing this row would actually do to Splitwise, decided here rather than by
   * whoever renders it.
   *
   * A surface has to state the consequence before a person confirms it, and "the net is zero,
   * so this deletes the entry" is a conclusion drawn from the figures. Drawing it in the
   * browser would put a second copy of this rule somewhere it could drift from the one the
   * repair actually follows (ADR-0048).
   */
  readonly plannedRepair: SplitwiseRepairKind;
}

/**
 * Every synced row whose local expense has moved on, or that a drift comparison flagged.
 *
 * A read. Nothing here decides that any of them *should* be re-synced — that is a person's
 * call, one row at a time, and this is the list they make it from.
 */
export async function listResyncCandidates(db: Executor): Promise<readonly ResyncCandidate[]> {
  const rows = await listResyncableSplitwiseExpenses(db);
  return rows.map((row) => ({
    ...row,
    plannedRepair:
      row.syncStatus === 'withdrawn'
        ? 'recreated'
        : row.currentNetAmount === '0'
          ? 'withdrawn'
          : 'corrected',
  }));
}

/** The settlement half of the same list: rows a drift comparison flagged. */
export interface SettlementResyncCandidate {
  readonly splitwiseSettlementId: SplitwiseSettlementId;
  readonly settlementId: SettlementId;
  readonly externalId: string;
  readonly syncStatus: string;
  readonly syncedAt: Date;
  readonly syncedSnapshot: unknown;
  readonly currentAmount: string;
  readonly counterpartyPersonId: PersonId;
  readonly counterpartyName: string;
}

export async function listSettlementResyncCandidates(
  db: Executor,
): Promise<readonly SettlementResyncCandidate[]> {
  return listResyncableSplitwiseSettlements(db);
}

/* ----------------------------------------------------------------- repairing an expense */

export interface ResyncExpenseInput {
  readonly expenseId: ExpenseId;
  readonly splitwise: SplitwisePort;
  /** Why this row is being corrected in somebody else's ledger. Required. */
  readonly reason: string;
  readonly audit: AuditMeta;
}

export interface ResyncExpenseResult {
  readonly splitwiseExpenseId: string;
  readonly syncStatus: Extract<SplitwiseExpenseSyncStatus, 'synced' | 'withdrawn'>;
  readonly repair: SplitwiseRepairKind;
  /** The id Splitwise held before. Equal to `splitwiseExpenseId` unless the repair recreated. */
  readonly previousExternalId: string;
  /** The figure Splitwise held before, and the one it holds now. */
  readonly previousSnapshot: unknown;
  readonly pushedNetAmount: string;
}

/**
 * Corrects, withdraws or recreates this expense's entry in Splitwise, to match what this ledger
 * currently says.
 *
 * @throws ServiceError `PRECONDITION_FAILED` when the expense was never synced, when the row is
 *   not repairable (a `synced` row the ledgers already agree about, or a `withdrawn` one still
 *   at a net of zero), or when the injected port cannot perform the repair the row needs.
 * @throws ServiceError `SPLITWISE_SYNC_FAILED` when Splitwise refuses. Nothing is written.
 */
export async function resyncExpenseToSplitwise(
  db: Database,
  input: ResyncExpenseInput,
): Promise<ResyncExpenseResult> {
  requireReason(input.reason);

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
  if (
    link.syncStatus !== 'stale' &&
    link.syncStatus !== 'drifted' &&
    link.syncStatus !== 'withdrawn'
  ) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `This row is "${link.syncStatus}". Pushing over one the ledgers already agree about ` +
        "would rewrite somebody else's record for no reason.",
      { expenseId: expense.id, syncStatus: link.syncStatus },
    );
  }

  await requireConnectedSplitwise(db);

  const before = await getSplitwiseExpenseRow(db, link.id);
  if (before === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'The Splitwise link row disappeared.', {
      expenseId: expense.id,
    });
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

  const netIsZero = expense.netAmount === 0n;
  const nothingStanding = before.syncStatus === 'withdrawn';

  if (nothingStanding && netIsZero) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This expense nets to zero and its Splitwise entry has already been withdrawn. There is ' +
        'nothing left to assert and nothing standing to correct.',
      { expenseId: expense.id },
    );
  }

  const repair: SplitwiseRepairKind = nothingStanding
    ? 'recreated'
    : netIsZero
      ? 'withdrawn'
      : 'corrected';
  const nextStatus = repair === 'withdrawn' ? ('withdrawn' as const) : ('synced' as const);
  assertSplitwiseExpenseSyncTransition(before.syncStatus, nextStatus);

  // Every remote call happens here, before the transaction that records it: a refusal must
  // leave both ledgers exactly as they were, with the row still repairable.
  let externalId: string;
  let theirSnapshot: unknown;
  try {
    if (repair === 'corrected') {
      const update = requirePortMethod(
        input.splitwise.updateExpense?.bind(input.splitwise),
        'updateExpense',
        'correct an entry Splitwise already holds. Correcting it by creating a second entry is ' +
          'what this repair replaced — it leaves the other person holding two records for one ' +
          'expense, and Splitwise counting both.',
      );
      const updated = await update({
        splitwiseExpenseId: before.splitwiseExpenseId,
        description: expense.description,
        amount: expense.netAmount,
        currency: expense.currency,
        paidBySplitwiseUserId: payer,
        shares,
      });
      if (updated.splitwiseExpenseId !== before.splitwiseExpenseId) {
        throw new Error(
          `the entry id moved from ${before.splitwiseExpenseId} to ` +
            `${updated.splitwiseExpenseId}, which is a duplicate rather than a correction`,
        );
      }
      externalId = before.splitwiseExpenseId;
      theirSnapshot = updated.theirSnapshot;
    } else if (repair === 'withdrawn') {
      const remove = requirePortMethod(
        input.splitwise.deleteEntry?.bind(input.splitwise),
        'deleteEntry',
        'remove an entry Splitwise already holds. This expense now nets to zero, which ' +
          'Splitwise cannot represent, so leaving the entry in place would assert a debt this ' +
          'ledger no longer says exists.',
      );
      const removed = await remove({ splitwiseEntryId: before.splitwiseExpenseId });
      externalId = removed.splitwiseEntryId;
      theirSnapshot = removed.theirSnapshot;
    } else {
      const created = await input.splitwise.createExpense({
        description: expense.description,
        amount: expense.netAmount,
        currency: expense.currency,
        paidBySplitwiseUserId: payer,
        shares,
      });
      externalId = created.splitwiseExpenseId;
      theirSnapshot = created.theirSnapshot;
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      'SPLITWISE_SYNC_FAILED',
      `Splitwise refused the correction for ${expense.id}: ` +
        (error instanceof Error ? error.message : String(error)),
      { expenseId: expense.id, repair },
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
      repair,
      // The id Splitwise held before this push. Equal to the one it holds now for a correction;
      // kept for every kind so a later audit can still explain findings raised against it.
      previousExternalId: before.splitwiseExpenseId,
      correctionReason: input.reason,
    };

    await updateSplitwiseExpenseSync(exec, link.id, {
      splitwiseExpenseId: externalId,
      syncedAt,
      ourSnapshot,
      theirSnapshot,
      syncStatus: nextStatus,
    });

    await record({
      entityType: 'splitwise_expense',
      entityId: link.id,
      action: 'update',
      oldValue: {
        syncStatus: before.syncStatus,
        splitwiseExpenseId: before.splitwiseExpenseId,
        ourSnapshot: before.ourSnapshot,
      },
      newValue: { syncStatus: nextStatus, splitwiseExpenseId: externalId, ourSnapshot },
      reason: input.reason,
    });

    return {
      splitwiseExpenseId: externalId,
      syncStatus: nextStatus,
      repair,
      previousExternalId: before.splitwiseExpenseId,
      previousSnapshot: before.ourSnapshot,
      pushedNetAmount: expense.netAmount.toString(),
    };
  });
}

/* --------------------------------------------------------------- repairing a settlement */

export interface ResyncSettlementInput {
  readonly settlementId: SettlementId;
  readonly splitwise: SplitwisePort;
  readonly reason: string;
  readonly audit: AuditMeta;
}

export interface ResyncSettlementResult {
  readonly splitwiseTransactionId: string;
  readonly syncStatus: 'synced';
  readonly previousSnapshot: unknown;
  readonly pushedAmount: string;
}

/**
 * Corrects a settlement Splitwise already holds, in place.
 *
 * Simpler than the expense repair, and deliberately narrower: a settlement has no allocation to
 * re-derive and no adjustment to net off, so `drifted` is the only way the two ledgers come
 * apart about one, and there is no zero case to withdraw. `fromPersonId`/`toPersonId` come from
 * `domain.settlementParties` reading the linked `Payment`'s direction — never re-derived here.
 *
 * @throws ServiceError `PRECONDITION_FAILED` when the settlement was never synced, is not
 *   `drifted`, or the port cannot correct a settlement in place.
 * @throws ServiceError `SPLITWISE_SYNC_FAILED` when Splitwise refuses. Nothing is written.
 */
export async function resyncSettlementToSplitwise(
  db: Database,
  input: ResyncSettlementInput,
): Promise<ResyncSettlementResult> {
  requireReason(input.reason);

  const settlement = await getSettlementById(db, input.settlementId);
  if (settlement === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No settlement with id ${input.settlementId}.`, {
      settlementId: input.settlementId,
    });
  }

  const link = await getSplitwiseSettlementBySettlementId(db, settlement.id);
  if (link === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This settlement has never been synced to Splitwise, so there is nothing to re-sync.',
      { settlementId: settlement.id },
    );
  }
  if (link.syncStatus !== 'drifted') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `This settlement row is "${link.syncStatus}". Pushing over one the ledgers already agree ` +
        "about would rewrite somebody else's record for no reason.",
      { settlementId: settlement.id, syncStatus: link.syncStatus },
    );
  }

  const userPerson = await requireConnectedSplitwise(db);
  const before = await getSplitwiseSettlementRow(db, link.id);
  if (before === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'The Splitwise link row disappeared.', {
      settlementId: settlement.id,
    });
  }

  const payment = await requirePayment(db, settlement.paymentId);
  const { fromPersonId, toPersonId } = settlementParties(
    {
      counterpartyPersonId: settlement.counterpartyPersonId,
      direction: payment.direction,
      amount: settlement.amount,
    },
    userPerson.personId,
  );
  const from = await requireSplitwiseUserId(db, fromPersonId);
  const to = await requireSplitwiseUserId(db, toPersonId);

  const update = requirePortMethod(
    input.splitwise.updatePayment?.bind(input.splitwise),
    'updatePayment',
    'correct a settlement Splitwise already holds. Recording a second settlement instead would ' +
      'discharge the debt twice.',
  );

  let updated;
  try {
    updated = await update({
      splitwiseTransactionId: before.splitwiseTransactionId,
      amount: settlement.amount,
      fromSplitwiseUserId: from,
      toSplitwiseUserId: to,
    });
    if (updated.splitwiseTransactionId !== before.splitwiseTransactionId) {
      throw new Error(
        `the entry id moved from ${before.splitwiseTransactionId} to ` +
          `${updated.splitwiseTransactionId}, which is a duplicate rather than a correction`,
      );
    }
  } catch (error) {
    throw new ServiceError(
      'SPLITWISE_SYNC_FAILED',
      `Splitwise refused the correction for settlement ${settlement.id}: ` +
        (error instanceof Error ? error.message : String(error)),
      { settlementId: settlement.id },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const syncedAt = new Date();
    const ourSnapshot = {
      amount: settlement.amount.toString(),
      from,
      to,
      repair: 'corrected',
      correctionReason: input.reason,
    };

    await updateSplitwiseSettlementSync(exec, link.id, {
      splitwiseTransactionId: before.splitwiseTransactionId,
      syncedAt,
      ourSnapshot,
      theirSnapshot: updated.theirSnapshot,
      syncStatus: 'synced',
    });

    await record({
      entityType: 'splitwise_settlement',
      entityId: link.id,
      action: 'update',
      oldValue: { syncStatus: link.syncStatus, ourSnapshot: before.ourSnapshot },
      newValue: { syncStatus: 'synced', ourSnapshot },
      reason: input.reason,
    });

    return {
      splitwiseTransactionId: before.splitwiseTransactionId,
      syncStatus: 'synced' as const,
      previousSnapshot: before.ourSnapshot,
      pushedAmount: settlement.amount.toString(),
    };
  });
}

/* --------------------------------------------------------------------------- internals */

function requireReason(reason: string): void {
  if (reason.trim().length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      "Correcting a row in somebody else's ledger records why. Without a reason, the other " +
        'person sees a changed figure and no account of it.',
      { field: 'reason' },
    );
  }
}

/**
 * A port method that may not exist, resolved to one that does — or a refusal that names it.
 *
 * The whole point of the optional methods (ADR-0055, and ADR-0046 before it for the read side):
 * "this adapter cannot do that" has to be representable and has to surface, rather than
 * quietly becoming a different, worse write.
 */
function requirePortMethod<T>(method: T | undefined, name: string, purpose: string): T {
  if (method === undefined) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `The connected Splitwise adapter cannot ${purpose} It does not implement ` +
        `\`${name}\`, and this repair will not substitute a different write for the one it ` +
        'cannot make.',
      { capability: name },
    );
  }
  return method;
}

async function requireConnectedSplitwise(
  db: Executor,
): Promise<{ readonly personId: PersonId; readonly userId: string }> {
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
  return { personId: userPerson.personId, userId: userPerson.userId };
}

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
