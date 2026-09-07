/**
 * Authoring an expense by hand — creating one, funding it from payments, and correcting an
 * item breakdown that was recorded wrong.
 *
 * Closes audit rows 17, 18 and 19. Each was modelled and tested at the domain layer and had no
 * way in:
 *
 *  - **18** — *"The flatmate-paid electrician use case is modeled and tested but cannot be
 *    entered on the website."* An externally-funded expense has no `Payment` at all, by design
 *    (ADR-0006), so classification — which starts from a payment — structurally could not
 *    create one.
 *  - **19** — one payment funding several expenses, and several payments funding one, both
 *    persisted and validated, with no authoring path to either shape.
 *  - **17** — *"A wrong initial item breakdown has no supported correction workflow, which
 *    also blocks reliable item ownership/refund repair."*
 *
 * Every rule these paths must respect already exists in `src/domain`; nothing here re-decides
 * one. `Expense.amount` still never changes once approved (`invariants.md` #6): a manual
 * expense sets it at creation, and a correction to what something cost is still an
 * `ExpenseAdjustment`, never an edit.
 */

import {
  DEBT_CREATING_RELATIONSHIP_TYPES,
  SUPPORTED_CURRENCY,
  assertEvidenceLinkOnce,
  assertExpenseAmountImmutable,
  assertPaymentCanFundExpense,
  validateExpenseItemsSum,
  validatePaymentExplanationBudget,
} from '../domain/index.js';
import type {
  EvidenceId,
  ExpenseId,
  ExpenseItemId,
  ExpenseRelationshipType,
  ExpenseState,
  Paise,
  PaymentId,
  PersonId,
} from '../domain/index.js';
import {
  countAdjustmentItemsForExpenseItems,
  getExpenseById,
  getPaymentById,
  getPersonById,
  insertExpense,
  insertExpenseItems,
  insertPaymentExpenseLink,
  listExpenseFundingLinks,
  listExpenseItemsByExpense,
  listPaymentExpenseLinksByPayment,
  listSettlementsByPayment,
  supersedeExpenseItems,
} from '../db/index.js';
import type { Database, ExpenseItemRow } from '../db/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { applyEvidenceLink, requireEvidenceRow } from './evidence-service.js';
import { requireExpenseSnapshot } from './loaders.js';

/* =================================================================== creating one */

export interface CreateExpenseInput {
  readonly description: string;
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly relationshipType: ExpenseRelationshipType;
  readonly category?: string | null;
  /** Who actually fronted the money — not automatically the ledger's user (ADR-0006). */
  readonly paidByPersonId: PersonId;
  /**
   * Payments that funded this expense, with the portion of each.
   *
   * Omitted for an externally-funded expense: when somebody else paid, this ledger has no
   * `Payment` for it and must never fabricate one (ADR-0006). Evidence, not a payment, is
   * what makes such an expense traceable — which is why `evidenceId` exists below.
   */
  readonly funding?: readonly { readonly paymentId: PaymentId; readonly amount: Paise }[];
  /**
   * Existing evidence to attach. **Required** when nobody's payment funds this expense: an
   * externally-funded expense with no evidence is an assertion, and `invariants.md`'s
   * traceability rule names `Evidence` as its source of truth.
   */
  readonly evidenceId?: EvidenceId | null;
  /**
   * The state to create it in. `proposed` (the default) keeps it out of every total until
   * somebody approves it; `approved` records a decision made at the same moment.
   */
  readonly state?: Extract<ExpenseState, 'proposed' | 'approved'>;
  readonly audit: AuditMeta;
}

export interface CreateExpenseResult {
  readonly expenseId: ExpenseId;
  readonly state: ExpenseState;
  readonly fundedByPaymentIds: readonly PaymentId[];
  readonly externallyFunded: boolean;
}

/**
 * Records an expense a person entered, in either funding shape.
 *
 * Self-funded: one or more of the user's own payments fund it, and each link is validated
 * against the payment's remaining budget so a payment can never fund more than it moved.
 *
 * Externally funded (a flatmate paid the electrician): **no** payment, and therefore no
 * `PaymentExpenseLink`. The user's share still becomes an obligation to the payer once the
 * expense is allocated. `paidByPersonId` names who fronted it; nothing here creates money the
 * user never spent.
 */
export async function createExpense(
  db: Database,
  input: CreateExpenseInput,
): Promise<CreateExpenseResult> {
  if (input.amount <= 0n) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'An expense costs something. A zero-amount expense has nothing to divide.',
      { field: 'amount' },
    );
  }
  const description = input.description.trim();
  if (description.length === 0) {
    throw new ServiceError('PRECONDITION_FAILED', 'An expense needs a description.', {
      field: 'description',
    });
  }

  const funding = input.funding ?? [];
  const externallyFunded = funding.length === 0;

  return runAudited(db, input.audit, async (ctx) => {
    const { exec, record } = ctx;
    const payer = await getPersonById(exec, input.paidByPersonId);
    if (payer === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such person to have paid this.', {
        paidByPersonId: input.paidByPersonId,
      });
    }

    if (externallyFunded && (input.evidenceId === undefined || input.evidenceId === null)) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'An expense nobody paid for from this ledger needs evidence: with no `Payment` behind ' +
          'it (ADR-0006 forbids fabricating one), the evidence record *is* the trail back to ' +
          'what happened. Record a manual note or attach a receipt first.',
        { field: 'evidenceId' },
      );
    }

    const expenseId = await insertExpense(exec, {
      description,
      amount: input.amount,
      currency: SUPPORTED_CURRENCY,
      occurredAt: input.occurredAt,
      relationshipType: input.relationshipType,
      category: emptyToNull(input.category),
      paidByPersonId: input.paidByPersonId,
      state: input.state ?? 'proposed',
    });
    await record({
      entityType: 'expense',
      entityId: expenseId,
      action: 'create',
      newValue: {
        description,
        amount: input.amount.toString(),
        occurredAt: input.occurredAt.toISOString(),
        relationshipType: input.relationshipType,
        paidByPersonId: input.paidByPersonId,
        state: input.state ?? 'proposed',
        externallyFunded,
      },
    });

    for (const link of funding) {
      await linkOnePaymentWithin(exec, record, expenseId, link.paymentId, link.amount);
    }

    if (input.evidenceId !== undefined && input.evidenceId !== null) {
      const evidenceRow = await requireEvidenceRow(exec, input.evidenceId);
      // Write-once, exactly as every other linkage is: a document that already describes a
      // different expense is a different document, and re-pointing one rewrites what the
      // evidence said (ADR-0034).
      const proposed = {
        linkedPaymentId: evidenceRow.linkedPaymentId,
        linkedExpenseId: expenseId,
      };
      assertEvidenceLinkOnce(
        {
          linkedPaymentId: evidenceRow.linkedPaymentId,
          linkedExpenseId: evidenceRow.linkedExpenseId,
        },
        proposed,
      );
      await applyEvidenceLink(ctx, evidenceRow, proposed);
    }

    return {
      expenseId,
      state: input.state ?? 'proposed',
      fundedByPaymentIds: funding.map((link) => link.paymentId),
      externallyFunded,
    };
  });
}

/* ============================================================== funding links */

export interface LinkPaymentToExpenseInput {
  readonly expenseId: ExpenseId;
  readonly paymentId: PaymentId;
  /** The portion of the payment that funded this expense — often, but not always, all of it. */
  readonly amount: Paise;
  readonly audit: AuditMeta;
}

/**
 * Records that some of one payment funded one expense (audit row 19).
 *
 * Both shapes fall out of the same primitive: one payment linked to several expenses (a split
 * order), and several payments linked to one expense (a deposit plus a balance). Neither is a
 * special case here, and neither is item allocation — dividing one expense among people is a
 * different question from saying which movements paid for it.
 *
 * `domain.validatePaymentExpenseLinks` is the authority on the budget: the links against one
 * payment may never exceed what that payment moved.
 */
export async function linkPaymentToExpense(
  db: Database,
  input: LinkPaymentToExpenseInput,
): Promise<{ readonly linkId: string }> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    await requireExpenseSnapshot(exec, input.expenseId);
    return {
      linkId: await linkOnePaymentWithin(
        exec,
        record,
        input.expenseId,
        input.paymentId,
        input.amount,
      ),
    };
  });
}

async function linkOnePaymentWithin(
  exec: AuditContext['exec'],
  record: AuditContext['record'],
  expenseId: ExpenseId,
  paymentId: PaymentId,
  amount: Paise,
): Promise<string> {
  if (amount <= 0n) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'A funding link attributes a positive portion of a payment.',
      { field: 'amount' },
    );
  }
  const payment = await getPaymentById(exec, paymentId);
  if (payment === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such payment.', { paymentId });
  }
  if (payment.direction !== 'debit') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'A credit did not fund an expense — money arriving is a refund, a settlement or an ' +
        'inflow, and each of those has its own record (ADR-0017, 17.1).',
      { paymentId, direction: payment.direction },
    );
  }
  // `invariants.md` #7 / ADR-0011, enforced by the domain rather than restated here.
  assertPaymentCanFundExpense(
    payment.counterpartyType as Parameters<typeof assertPaymentCanFundExpense>[0],
  );

  const existing = await listPaymentExpenseLinksByPayment(exec, paymentId);
  if (existing.some((link) => link.expenseId === expenseId)) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This payment already funds this expense. One link per payment/expense pair — a second ' +
        'would double-count the same money against the same purchase.',
      { paymentId, expenseId },
    );
  }

  // Links and settlements draw on **one** budget: the payment's own amount (ADR-0007). The
  // whole set is validated, including the new link, because a budget is a fact about all of
  // them rather than about the one being added.
  const settlements = await listSettlementsByPayment(exec, paymentId);
  validatePaymentExplanationBudget({
    paymentAmount: payment.amount,
    linkAmounts: [...existing.map((link) => link.amount), amount],
    settlementAmounts: settlements.map((settlement) => settlement.amount),
  });

  const linkId = await insertPaymentExpenseLink(exec, { paymentId, expenseId, amount });
  await record({
    entityType: 'payment_expense_link',
    entityId: linkId,
    action: 'create',
    newValue: { paymentId, expenseId, amount: amount.toString() },
  });
  return linkId;
}

/** Which payments fund one expense, and for how much. A read. */
export async function listExpenseFunding(
  db: Database,
  expenseId: ExpenseId,
): Promise<
  readonly { readonly paymentId: PaymentId; readonly amount: Paise; readonly linkId: string }[]
> {
  await requireExpenseSnapshot(db, expenseId);
  return listExpenseFundingLinks(db, expenseId);
}

/* ====================================================== correcting an item breakdown */

export interface CorrectExpenseItemsInput {
  readonly expenseId: ExpenseId;
  /** The complete replacement set — items still sum to the expense's immutable gross amount. */
  readonly items: readonly {
    readonly description: string;
    readonly amount: Paise;
    readonly quantity?: string;
  }[];
  /** Why the first breakdown was wrong. Required: a correction with no reason is an edit. */
  readonly reason: string;
  readonly audit: AuditMeta;
}

export interface CorrectExpenseItemsResult {
  readonly items: readonly ExpenseItemRow[];
  readonly supersededItemIds: readonly ExpenseItemId[];
}

/**
 * Replaces a wrong item breakdown with a corrected one (audit row 17).
 *
 * Three rules, none of them negotiable:
 *
 *  1. **The gross total does not move.** `Expense.amount` is immutable once approved
 *     (`invariants.md` #6), so a corrected basket still sums to exactly the same figure. A
 *     correction that changes what the purchase cost is an `ExpenseAdjustment`, not this.
 *  2. **Nothing is deleted.** The old rows are stamped `superseded_at`; a superseded
 *     allocation still points at them and has to stay explicable.
 *  3. **An item refund freezes the basket.** If any `ExpenseAdjustmentItem` attributes a
 *     refund to one of these items, the correction is refused. Rebuilding the basket
 *     underneath a recorded refund would silently restate what was refunded, and ADR-0045 is
 *     explicit that item allocation rebuilds from recorded facts — facts that would no longer
 *     exist.
 *
 * Any current allocation is left alone deliberately. An item-based allocation whose lines
 * point at superseded items is stale, and re-approving it is a separate decision a person
 * makes with the corrected items in front of them — not something a correction does silently.
 */
export async function correctExpenseItems(
  db: Database,
  input: CorrectExpenseItemsInput,
): Promise<CorrectExpenseItemsResult> {
  if (input.reason.trim().length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'A correction records why the first reading was wrong. Without that, the audit trail ' +
        'shows a changed breakdown and no account of it.',
      { field: 'reason' },
    );
  }
  if (input.items.length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'A corrected breakdown is still a complete breakdown. An expense with no items is not ' +
        'itemized; it is not an empty basket.',
      { field: 'items' },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const expense = await requireExpenseSnapshot(exec, input.expenseId);
    if (expense.state === 'rejected') {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'This expense was rejected; correcting its breakdown describes a purchase the ledger ' +
          'has already decided did not happen.',
        { expenseId: expense.id },
      );
    }

    const existing = await listExpenseItemsByExpense(exec, expense.id);
    if (existing.length === 0) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'There is no breakdown to correct yet — record one first.',
        { expenseId: expense.id },
      );
    }

    const attributed = await countAdjustmentItemsForExpenseItems(
      exec,
      existing.map((item) => item.id),
    );
    if (attributed > 0) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `${attributed} recorded item refund(s) already attribute money to these items. ` +
          'Rebuilding the basket underneath them would restate what was refunded without ' +
          'saying so (ADR-0045). Reverse or re-record the refund first.',
        { expenseId: expense.id },
      );
    }

    // The immutability guard runs even though nothing here writes `amount`: it is the one
    // place that states the rule this correction is bounded by, and calling it makes the
    // boundary explicit rather than implied by the sum check below.
    assertExpenseAmountImmutable(expense.state, expense.grossAmount, expense.grossAmount);
    validateExpenseItemsSum(
      input.items.map((item) => item.amount),
      expense.grossAmount,
    );

    const supersededAt = new Date();
    await supersedeExpenseItems(
      exec,
      existing.map((item) => item.id),
      supersededAt,
    );
    for (const item of existing) {
      await record({
        entityType: 'expense_item',
        entityId: item.id,
        action: 'supersede',
        oldValue: { description: item.description, amount: item.amount.toString() },
        newValue: { supersededAt: supersededAt.toISOString() },
        reason: input.reason,
      });
    }

    const ids = await insertExpenseItems(
      exec,
      input.items.map((item) => ({
        expenseId: expense.id,
        description: item.description,
        amount: item.amount,
        quantity: item.quantity ?? '1',
        // A corrected item is a person's reading, not a receipt line's — a receipt link is
        // re-established by re-extracting, never carried across from a row it did not describe.
        receiptItemId: null,
      })),
    );
    const items: ExpenseItemRow[] = ids.map((id, index) => ({
      id,
      expenseId: expense.id,
      description: input.items[index]!.description,
      amount: input.items[index]!.amount,
      quantity: input.items[index]!.quantity ?? '1',
      receiptItemId: null,
      supersededAt: null,
    }));
    for (const item of items) {
      await record({
        entityType: 'expense_item',
        entityId: item.id,
        action: 'create',
        newValue: {
          expenseId: expense.id,
          description: item.description,
          amount: item.amount.toString(),
          quantity: item.quantity,
          correctsBreakdown: true,
        },
        reason: input.reason,
      });
    }

    return { items, supersededItemIds: existing.map((item) => item.id) };
  });
}

/* ============================================================ reading it back */

/** Whether this relationship can create an obligation at all (`domain/enums.ts`). */
export function isDebtCreating(relationshipType: ExpenseRelationshipType): boolean {
  return (DEBT_CREATING_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType);
}

/** The expense as the authoring surface reads it back after a write. */
export async function getAuthoredExpense(
  db: Database,
  expenseId: ExpenseId,
): Promise<NonNullable<Awaited<ReturnType<typeof getExpenseById>>>> {
  const expense = await getExpenseById(db, expenseId);
  if (expense === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', 'No such expense.', { expenseId });
  }
  return expense;
}

/* --------------------------------------------------------------------------- internals */

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
