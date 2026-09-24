/**
 * Approving an allocation — deciding, authoritatively, who benefited and by how much.
 *
 * This is the only write path to `allocations`/`allocation_lines`/
 * `allocation_line_group_expansions`. Every rule it enforces lives in `src/domain`; this
 * module's job is ordering, persistence, and the audit trail (`data-flow.md`, step 6).
 */

import {
  DEBT_CREATING_RELATIONSHIP_TYPES,
  assertExpenseTransition,
  buildAllocationLines,
  isDomainError,
  expandGroupAllocationLine,
  isItemSourcedMethod,
  netItemAmount,
  nonDebtRelationshipWords,
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
  getGroupById,
  insertAllocationWithLines,
  listExpenseItems,
  listGroupMemberships,
  listItemAttributionTotals,
  listPeople,
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

/* ========================================================================== the preview */

/** One person's share of an expense, as a screen must show it before anything is approved. */
export interface AllocationPreviewShare {
  readonly beneficiaryType: 'person' | 'group';
  readonly beneficiaryId: string;
  readonly name: string;
  readonly isYou: boolean;
  readonly amount: Paise;
  /** Only set for the `percentage` method (`invariants.md` #13). */
  readonly percentage: string | null;
  /** The people a group line resolves to, snapshotted as of the expense date (ADR-0009). */
  readonly members: readonly { readonly name: string; readonly amount: Paise }[] | null;
}

/** What this split would mean for one person: a debt, or their own share and no debt. */
export interface AllocationPreviewObligation {
  readonly personId: PersonId;
  readonly name: string;
  readonly amount: Paise;
  /** `collect` when they would owe the payer, `pay` when the user would owe them. */
  readonly direction: 'collect' | 'pay';
}

export interface AllocationPreviewResult {
  readonly expenseId: ExpenseId;
  /** Immutable and historical; the split sums to `netAmount`, never to this (ADR-0008). */
  readonly grossAmount: Paise;
  readonly netAmount: Paise;
  readonly method: AllocationDecision['method'];
  readonly paidBy: { readonly personId: PersonId; readonly name: string; readonly isYou: boolean };
  readonly shares: readonly AllocationPreviewShare[];
  /** What would be owed once this is approved, in the reader's own terms. */
  readonly obligations: readonly AllocationPreviewObligation[];
  /**
   * Why nobody would owe anything, when nobody would — or `null` when somebody would.
   *
   * An empty obligation list has two completely different causes and one appearance. Either
   * the payer is the only beneficiary, or the expense is recorded as something nobody owes for
   * — `personal` or `gift`, which create no debt by construction (`invariants.md` #2a,
   * `domain-model.md`'s Obligation section). A screen that showed the same sentence for both
   * would leave somebody naming person after person and wondering why nothing happened.
   */
  readonly noObligationsBecause: string | null;
  /** True when a current allocation exists, so approving supersedes rather than creates. */
  readonly replacesExistingAllocation: boolean;
  /**
   * Why this split cannot be approved as stated, or `null`.
   *
   * Reported rather than thrown, because the whole purpose of a preview is to show a person
   * what is wrong with what they typed *before* they press the button. `approveAllocation`
   * still refuses independently — this is not a gate, it is a mirror of one.
   */
  readonly refusal: { readonly code: string; readonly message: string } | null;
}

export interface PreviewAllocationInput {
  readonly expenseId: ExpenseId;
  readonly decision: AllocationDecision;
  readonly groupShareOverrides?: readonly GroupShareOverride[];
  /** Whose ledger this is, so a share can be labelled "You" and a direction can be stated. */
  readonly userPersonId: PersonId | null;
}

/**
 * What approving this split would do, computed without writing anything.
 *
 * The same `buildLines` and the same validators `approveAllocation` runs, with the write
 * removed — so this is not an approximation of the split, it **is** the split. A screen that
 * divided an amount itself to show a preview would be performing financial arithmetic in the
 * browser (`web/CLAUDE.md` rule 1) and, worse, would be free to disagree with the thing it was
 * previewing. `getRefundAllocationState` already previews a distribution this way.
 *
 * A refusal comes back as a value. Every reason `approveAllocation` would throw — a line that
 * does not sum to the net amount, a negative share, an item nobody claimed — is exactly what a
 * person needs to read before pressing a button, not after.
 */
export async function previewAllocation(
  db: Executor,
  input: PreviewAllocationInput,
): Promise<AllocationPreviewResult> {
  const expense = await requireExpenseSnapshot(db, input.expenseId);
  const people = await listPeople(db);
  const names = new Map<string, string>(
    people.map((person): [string, string] => [person.id, person.displayName]),
  );
  const current = await loadCurrentAllocation(db, expense.id);

  const nameFor = (id: string): string => names.get(id) ?? 'Somebody not on the roster';
  const base = {
    expenseId: expense.id,
    grossAmount: expense.grossAmount,
    netAmount: expense.netAmount,
    method: input.decision.method,
    paidBy: {
      personId: expense.paidByPersonId,
      name: nameFor(expense.paidByPersonId),
      isYou: input.userPersonId !== null && expense.paidByPersonId === input.userPersonId,
    },
    replacesExistingAllocation: current !== null,
  };

  let lines: readonly DraftAllocationLine[];
  try {
    assertAllocatable(expense);
    lines = await buildLines(db, expense, input.decision);
    validateAllocationLineAmounts(lines);
    validateAllocationSum(lines, expense.netAmount);
    if (isItemSourcedMethod(input.decision.method)) {
      validateItemBasedLineSums(lines, await loadAllocatableItems(db, expense.id));
    }
  } catch (error) {
    const refusal = asRefusal(error);
    if (refusal === null) throw error;
    return {
      ...base,
      shares: [],
      obligations: [],
      noObligationsBecause: null,
      refusal,
    };
  }

  const shares: AllocationPreviewShare[] = [];
  const obligations: AllocationPreviewObligation[] = [];

  for (const line of lines) {
    if (line.beneficiary.type === 'group') {
      const group = await getGroupById(db, line.beneficiary.id);
      // The same expansion `toDraft` writes — `resolveGroupMembersAsOf` as of the expense
      // date, then `expandGroupAllocationLine` under the Largest Remainder Method. A preview
      // that expanded a group any other way would be previewing a different allocation.
      const draft = await toDraft(db, expense, line, input.groupShareOverrides ?? []);
      const expansion = draft.groupExpansion ?? [];
      shares.push({
        beneficiaryType: 'group',
        beneficiaryId: line.beneficiary.id,
        name: group?.name ?? 'A group',
        isYou: false,
        amount: line.amount,
        percentage: line.percentage,
        members: expansion.map((member: { personId: PersonId; amount: Paise }) => ({
          name: nameFor(member.personId),
          amount: member.amount,
        })),
      });
      // A group is never a debtor: its members are, individually (`invariants.md` #8).
      for (const member of expansion as readonly { personId: PersonId; amount: Paise }[]) {
        addObligation(obligations, member.personId, member.amount, expense, input, nameFor);
      }
      continue;
    }

    const personId = line.beneficiary.id;
    shares.push({
      beneficiaryType: 'person',
      beneficiaryId: personId,
      name: nameFor(personId),
      isYou: input.userPersonId !== null && personId === input.userPersonId,
      amount: line.amount,
      percentage: line.percentage,
      members: null,
    });
    addObligation(obligations, personId, line.amount, expense, input, nameFor);
  }

  return {
    ...base,
    shares,
    obligations,
    noObligationsBecause:
      obligations.length > 0
        ? null
        : whyNobodyOwes(expense.relationshipType, base.paidBy.isYou, base.paidBy.name),
    refusal: null,
  };
}

/**
 * The reason an empty obligation list is empty, in the reader's own words.
 *
 * The "nothing is owed for this kind of expense" half is `domain.nonDebtRelationshipWords`, so
 * the preview and the event screen afterwards cannot word the same rule two different ways.
 */
function whyNobodyOwes(relationshipType: string, payerIsUser: boolean, payerName: string): string {
  const nothingOwed = nonDebtRelationshipWords(relationshipType);
  if (nothingOwed !== null) return nothingOwed;
  return payerIsUser
    ? 'Nobody would owe anything: you paid, and nobody else is named.'
    : `Nobody would owe anything: ${payerName} paid, and nobody else is named.`;
}

/**
 * Adds what one beneficiary would owe, and to whom — or nothing at all.
 *
 * The payer's own beneficiary line creates no obligation (`invariants.md` #2a), and the
 * direction is read from who actually fronted the money rather than assumed to run towards the
 * user (ADR-0006). A `personal` or `gift` expense never reaches here with a debt to state,
 * because `computeObligations` excludes those relationship types by construction; this mirrors
 * that rather than re-deciding it.
 */
function addObligation(
  into: AllocationPreviewObligation[],
  personId: PersonId,
  amount: Paise,
  expense: ExpenseSnapshot,
  input: PreviewAllocationInput,
  nameFor: (id: string) => string,
): void {
  if (personId === expense.paidByPersonId) return;
  if (!(DEBT_CREATING_RELATIONSHIP_TYPES as readonly string[]).includes(expense.relationshipType)) {
    return;
  }
  const payerIsUser = input.userPersonId !== null && expense.paidByPersonId === input.userPersonId;
  const debtorIsUser = input.userPersonId !== null && personId === input.userPersonId;
  if (!payerIsUser && !debtorIsUser) return;

  into.push({
    personId,
    name: debtorIsUser ? nameFor(expense.paidByPersonId) : nameFor(personId),
    amount,
    direction: payerIsUser ? 'collect' : 'pay',
  });
}

/** A refusal a person can read, or `null` when the failure is not about what they typed. */
function asRefusal(error: unknown): { code: string; message: string } | null {
  if (isDomainError(error)) return { code: error.code, message: error.message };
  if (error instanceof ServiceError) return { code: error.code, message: error.message };
  return null;
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
