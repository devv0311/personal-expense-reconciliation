/**
 * Approving an allocation — deciding, authoritatively, who benefited and by how much.
 *
 * This is the only write path to `allocations`/`allocation_lines`/
 * `allocation_line_group_expansions`. Every rule it enforces lives in `src/domain`; this
 * module's job is ordering, persistence, and the audit trail (`data-flow.md`, step 6).
 */

import {
  assertExpenseTransition,
  buildAllocationLines,
  expandGroupAllocationLine,
  isItemSourcedMethod,
  netItemAmount,
  resolveGroupMembersAsOf,
  validateAllocationLineAmounts,
  validateAllocationSum,
  validateGroupExpansionSum,
  validateItemBasedLineSums,
} from '../domain/index.js';
import type {
  BeneficiaryRef,
  DraftAllocationLine,
  ExpenseId,
  ExpenseItemId,
  GroupId,
  Paise,
  PersonId,
} from '../domain/index.js';
import {
  insertAllocationWithLines,
  listExpenseItems,
  listGroupMemberships,
  listItemAttributionTotals,
  supersedeAllocation,
  updateExpenseState,
} from '../db/index.js';
import type { AllocationLineDraft, Database, Executor } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { loadCurrentAllocation, requireExpenseSnapshot, type ExpenseSnapshot } from './loaders.js';

/** The user's decision about how to divide an expense. */
export type AllocationDecision =
  | { readonly method: 'equal'; readonly beneficiaries: readonly BeneficiaryRef[] }
  | {
      readonly method: 'exact' | 'custom';
      readonly lines: ReadonlyArray<{
        readonly beneficiary: BeneficiaryRef;
        readonly amount: Paise;
      }>;
    }
  | {
      readonly method: 'percentage';
      readonly lines: ReadonlyArray<{
        readonly beneficiary: BeneficiaryRef;
        readonly percentage: string;
      }>;
    }
  | {
      readonly method: 'item_based' | 'quantity_based';
      readonly lines: ReadonlyArray<{
        readonly beneficiary: BeneficiaryRef;
        readonly expenseItemId: ExpenseItemId;
        readonly amount?: Paise;
        /**
         * How many of a shared item's units this beneficiary took — `quantity_based` only.
         *
         * `domain.buildAllocationLines` splits the item's cost across its unit-stated lines
         * by the Largest Remainder Method; nothing multiplies out a per-unit price.
         */
        readonly units?: bigint;
      }>;
    };

/** An explicit, one-time override of how a group line divides among its members. */
export interface GroupShareOverride {
  readonly groupId: GroupId;
  readonly weights: ReadonlyArray<{ readonly personId: PersonId; readonly weight: bigint }>;
}

export interface ApproveAllocationInput {
  readonly expenseId: ExpenseId;
  readonly decision: AllocationDecision;
  /** `'manual'` or `'rule:<rule_id>'` — never an AI proposal directly (`invariants.md` #15). */
  readonly decidedBy: string;
  readonly groupShareOverrides?: readonly GroupShareOverride[];
  readonly audit: AuditMeta;
  /** Overridable for deterministic tests; defaults to now. */
  readonly decidedAt?: Date;
}

export interface ApproveAllocationResult {
  readonly allocationId: string;
  readonly supersededAllocationId: string | null;
  readonly lines: readonly DraftAllocationLine[];
  readonly netAmount: Paise;
}

/** Expense states from which an allocation may be approved. */
const ALLOCATABLE_STATES = new Set([
  'approved',
  'allocated',
  'ready_to_sync',
  'synced',
  'reconciled',
]);

/**
 * Approves an allocation for an expense, superseding any previous version.
 *
 * Refuses to write anything unless every relevant invariant holds first: lines sum to the
 * expense's **net** amount (#11), no line is negative (#12a), item-based lines reconcile
 * per item (#14), and every `group`-typed line has a fully-distributed expansion resolved
 * as of the expense date (#2b, ADR-0009).
 */
export async function approveAllocation(
  db: Database,
  input: ApproveAllocationInput,
): Promise<ApproveAllocationResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const expense = await requireExpenseSnapshot(exec, input.expenseId);
    assertAllocatable(expense);

    const lines = await buildLines(exec, expense, input.decision);
    validateAllocationLineAmounts(lines);
    validateAllocationSum(lines, expense.netAmount);
    if (isItemSourcedMethod(input.decision.method)) {
      validateItemBasedLineSums(lines, await loadAllocatableItems(exec, expense.id));
    }

    const drafts = await Promise.all(
      lines.map((line) => toDraft(exec, expense, line, input.groupShareOverrides ?? [])),
    );

    const previous = await loadCurrentAllocation(exec, expense.id);
    const decidedAt = input.decidedAt ?? new Date();
    if (previous !== null) {
      await supersedeAllocation(exec, previous.allocation.id, decidedAt);
      await record({
        entityType: 'allocation',
        entityId: previous.allocation.id,
        action: 'supersede',
        oldValue: { method: previous.allocation.method, lines: serialise(previous.lines) },
        newValue: { supersededAt: decidedAt.toISOString() },
      });
    }

    const inserted = await insertAllocationWithLines(exec, {
      expenseId: expense.id,
      method: input.decision.method,
      decidedBy: input.decidedBy,
      decidedAt,
      lines: drafts,
    });

    await record({
      entityType: 'allocation',
      entityId: inserted.allocationId,
      action: 'create',
      newValue: {
        expenseId: expense.id,
        method: input.decision.method,
        decidedBy: input.decidedBy,
        netAmount: expense.netAmount.toString(),
        lines: serialise(lines),
      },
    });

    // "I agree this was the group dinner" and "I agree it was split exactly this way" are
    // different decisions; only the second one moves an approved expense to allocated.
    if (expense.state === 'approved') {
      assertExpenseTransition('approved', 'allocated');
      await updateExpenseState(exec, expense.id, 'allocated');
      await record({
        entityType: 'expense',
        entityId: expense.id,
        action: 'update',
        oldValue: { state: 'approved' },
        newValue: { state: 'allocated' },
      });
    }

    return {
      allocationId: inserted.allocationId,
      supersededAllocationId: previous?.allocation.id ?? null,
      lines,
      netAmount: expense.netAmount,
    };
  });
}

/* ------------------------------------------------------------------------- internals */

function assertAllocatable(expense: ExpenseSnapshot): void {
  if (!ALLOCATABLE_STATES.has(expense.state)) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Expense ${expense.id} is "${expense.state}". An Allocation is approved only once the ` +
        'expense itself is approved — an unapproved expense cannot have an authoritative ' +
        'split (lifecycle.md, invariants.md #2).',
      { expenseId: expense.id, state: expense.state },
    );
  }
}

/**
 * The items an item-based allocation may draw on, at their **currently allocatable** cost.
 *
 * Gross `ExpenseItem.amount` less every refund already attributed to that item: after a
 * partial refund the item is worth less to allocate even though what it cost has not changed
 * by a paisa (ADR-0018 (item refunds), 19.5, invariants.md #14). With no attributions the
 * subtraction is of zero, so an expense that has never been refunded behaves exactly as it
 * did before Phase 18.
 */
async function loadAllocatableItems(
  exec: Executor,
  expenseId: ExpenseId,
): Promise<ReadonlyArray<{ id: ExpenseItemId; amount: Paise }>> {
  const items = await listExpenseItems(exec, expenseId);
  const refunded = await listItemAttributionTotals(exec, expenseId);
  return items.map((item) => {
    const id = item.id as ExpenseItemId;
    return {
      id,
      amount: netItemAmount(item.amount, [refunded.get(id) ?? (0n as Paise)]),
    };
  });
}

async function buildLines(
  exec: Executor,
  expense: ExpenseSnapshot,
  decision: AllocationDecision,
): Promise<readonly DraftAllocationLine[]> {
  switch (decision.method) {
    case 'equal':
      return buildAllocationLines({
        method: 'equal',
        total: expense.netAmount,
        beneficiaries: decision.beneficiaries,
      });
    case 'exact':
    case 'custom':
      return buildAllocationLines({
        method: decision.method,
        total: expense.netAmount,
        lines: decision.lines,
      });
    case 'percentage':
      return buildAllocationLines({
        method: 'percentage',
        total: expense.netAmount,
        lines: decision.lines,
      });
    case 'item_based':
    case 'quantity_based':
      return buildAllocationLines({
        method: decision.method,
        lines: decision.lines,
        items: await loadAllocatableItems(exec, expense.id),
      });
  }
}

/**
 * Turns a domain line into a persistable draft, resolving a `group` line into its member
 * expansion along the way.
 *
 * The resolution reads `GroupMembership` as of `Expense.occurredAt` — never "today" — and
 * is written once. A later membership change has no effect on rows already stored
 * (ADR-0009, `scenario-analysis.md` §33).
 */
async function toDraft(
  exec: Executor,
  expense: ExpenseSnapshot,
  line: DraftAllocationLine,
  overrides: readonly GroupShareOverride[],
): Promise<AllocationLineDraft> {
  const base = {
    beneficiaryType: line.beneficiary.type,
    beneficiaryId: line.beneficiary.id,
    amount: line.amount,
    percentage: line.percentage,
    expenseItemId: line.expenseItemId,
  } satisfies Omit<AllocationLineDraft, 'groupExpansion'>;

  if (line.beneficiary.type !== 'group') return base;

  const groupId = line.beneficiary.id;
  const memberships = await listGroupMemberships(exec, groupId);
  const members = resolveGroupMembersAsOf(memberships, groupId, expense.occurredAt);
  const override = overrides.find((candidate) => candidate.groupId === groupId);

  const expansion = expandGroupAllocationLine({
    lineAmount: line.amount,
    members,
    ...(override === undefined ? {} : { shareWeights: override.weights }),
  });
  validateGroupExpansionSum(line.amount, expansion);

  return { ...base, groupExpansion: expansion };
}

function serialise(lines: readonly DraftAllocationLine[]): unknown {
  return lines.map((line) => ({
    beneficiaryType: line.beneficiary.type,
    beneficiaryId: line.beneficiary.id,
    amount: line.amount.toString(),
    percentage: line.percentage,
    expenseItemId: line.expenseItemId,
  }));
}
