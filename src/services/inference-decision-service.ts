/**
 * `services.decideInference` — the only path by which an `AIInference` leaves `pending`.
 *
 * ```
 * api (review) ─▶ services.decideInference(accept | modify | reject)
 *                   ├─ expense    ─▶ Expense APPROVED + PaymentExpenseLink + payment LINKED
 *                   ├─ settlement ─▶ Settlement + counterparty person + payment LINKED
 *                   └─ reject     ─▶ no authoritative record at all
 * ```
 *
 * This is the function `ai-boundary.md` describes as "the _only_ code path allowed to copy
 * proposal data into an APPROVED-classified field", and everything about its shape follows
 * from that:
 *
 *  - **The actor is checked first.** A decision is attributable to a person or to a `Rule` the
 *    person previously approved, never to the model and never to "the system"
 *    (`domain.parseDecisionActor`, `invariants.md` #15, #17).
 *  - **The proposal is re-validated, every time.** The stored `proposed_output` goes back
 *    through `ai.parseTransactionClassification` before it can produce anything, and a
 *    `modify`'s replacement goes through the identical parser and the identical semantic gate.
 *    A human's correction does not get an easier door than the model's original.
 *  - **One transaction, one decision.** The record, the payment's new state, the inference's
 *    status and every audit event commit together or not at all.
 */

import {
  assertAiInferenceTransition,
  assertPaymentCanFundExpense,
  assertPaymentTransition,
  assertExpenseTransition,
  parseDecisionActor,
  validatePaymentExplanationBudget,
} from '../domain/index.js';
import type {
  AiInferenceId,
  AiInferenceStatus,
  ExpenseId,
  ExpenseState,
  Paise,
  PaymentState,
  PersonId,
  SettlementId,
} from '../domain/index.js';
import { parseTransactionClassification } from '../ai/index.js';
import type { TransactionClassification } from '../ai/index.js';
import {
  applyPaymentCounterparty,
  attachAiInferenceRecord,
  getAiInferenceById,
  getExpenseById,
  insertPaymentExpenseLink,
  listPaymentExpenseLinksByPayment,
  listSettlementsByPayment,
  recordAiInferenceDecision,
  updateExpenseClassification,
  updateExpenseState,
  updatePaymentState,
} from '../db/index.js';
import type { AiInferenceRow, Database, PaymentRow } from '../db/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import {
  createDerivedExpenseFromProposal,
  requireUserPersonId,
  validateClassificationProposal,
} from './classification-service.js';
import { ServiceError } from './errors.js';
import { requirePayment } from './loaders.js';
import { recordSettlementWithin } from './settlement-service.js';

/* ---------------------------------------------------------------------------- input */

/** What a reviewer did with a proposal (`lifecycle.md`, AIInference lifecycle). */
export type InferenceDecision = 'accept' | 'modify' | 'reject';

export interface DecideInferenceInput {
  readonly inferenceId: AiInferenceId;
  readonly decision: InferenceDecision;
  /**
   * Required for `modify`, forbidden otherwise: the corrected proposal, in exactly the shape
   * the model's had to be in. It may change the `proposedKind` — choosing between an expense
   * and a settlement is part of what the decision confirms (`ai-boundary.md`, ADR-0007).
   */
  readonly modifiedOutput?: unknown;
  /** `actor` must be a person (`user`, `user:<id>`) or a `Rule` (`rule:<id>`). */
  readonly audit: AuditMeta;
}

/* --------------------------------------------------------------------------- result */

export interface RejectedInferenceResult {
  readonly status: 'rejected';
  readonly inferenceId: AiInferenceId;
}

export interface AcceptedExpenseResult {
  readonly status: Exclude<AiInferenceStatus, 'pending' | 'rejected' | 'superseded'>;
  readonly inferenceId: AiInferenceId;
  readonly resultingRecordType: 'expense';
  readonly expenseId: ExpenseId;
  readonly expenseState: ExpenseState;
  readonly paymentState: PaymentState;
  /** What is left of the payment after every link and settlement drawn on it. */
  readonly unexplainedRemainder: Paise;
}

export interface AcceptedSettlementResult {
  readonly status: Exclude<AiInferenceStatus, 'pending' | 'rejected' | 'superseded'>;
  readonly inferenceId: AiInferenceId;
  readonly resultingRecordType: 'settlement';
  readonly settlementId: SettlementId;
  readonly counterpartyPersonId: PersonId;
  readonly paymentState: PaymentState;
  readonly unexplainedRemainder: Paise;
}

export type DecideInferenceResult =
  RejectedInferenceResult | AcceptedExpenseResult | AcceptedSettlementResult;

/* -------------------------------------------------------------------------- service */

/**
 * Decides one pending inference.
 *
 * @throws DomainError `DECISION_ACTOR_INVALID` when nobody accountable is named.
 * @throws DomainError `INVALID_STATE_TRANSITION` when the inference is already decided.
 * @throws AiContractError when the proposal — stored or modified — is not a proposal.
 * @throws ServiceError `AI_PROPOSAL_INVALID` when it is well-formed but the ledger says no.
 */
export async function decideInference(
  db: Database,
  input: DecideInferenceInput,
): Promise<DecideInferenceResult> {
  // Before anything else: an unattributable decision is not a decision (invariants.md #17).
  parseDecisionActor(input.audit.actor);

  const inference = await requireInference(db, input.inferenceId);
  const target = TARGET_STATUS[input.decision];
  assertAiInferenceTransition(inference.status, target);

  if (input.decision === 'reject') {
    if (input.modifiedOutput !== undefined) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'A rejection carries no corrected proposal — nothing is produced from it. Use ' +
          '"modify" to accept a changed proposal.',
        { inferenceId: input.inferenceId },
      );
    }
    return rejectInference(db, input, inference);
  }

  const proposal = proposalFor(input, inference);
  const payment = await requirePayment(db, inference.inputRefId);
  const userPersonId = await requireUserPersonId(db);
  // The same gate classification used. A modified proposal has changed since then, and an
  // unmodified one is re-checked because the ledger may have moved on underneath it.
  await validateClassificationProposal(db, { payment, proposal, userPersonId });

  return runAudited(db, input.audit, async (ctx) => {
    const result =
      proposal.proposedKind === 'expense'
        ? await acceptAsExpense(ctx, { input, inference, payment, proposal, userPersonId, target })
        : await acceptAsSettlement(ctx, { input, inference, payment, proposal, target });

    await recordAiInferenceDecision(ctx.exec, inference.id, {
      status: target,
      decidedBy: input.audit.actor,
    });
    await ctx.record({
      entityType: 'ai_inference',
      entityId: inference.id,
      action: 'update',
      oldValue: { status: inference.status },
      newValue: {
        status: target,
        decidedBy: input.audit.actor,
        resultingRecordType: result.resultingRecordType,
        resultingRecordId:
          result.resultingRecordType === 'expense' ? result.expenseId : result.settlementId,
        proposedKind: proposal.proposedKind,
      },
    });
    return result;
  });
}

/* ------------------------------------------------------------------------ decisions */

const TARGET_STATUS: Record<InferenceDecision, AiInferenceStatus> = {
  accept: 'accepted',
  modify: 'modified',
  reject: 'rejected',
};

/**
 * Rejecting produces nothing.
 *
 * A DERIVED `Expense` the proposal created at classification time is deliberately left where
 * it is — unapproved, referenced by the rejected inference, invisible to every total the
 * ledger computes. Nothing here deletes financial records, and what the review queue does with
 * such a row is phase 9's decision (ADR-0026).
 */
async function rejectInference(
  db: Database,
  input: DecideInferenceInput,
  inference: AiInferenceRow,
): Promise<RejectedInferenceResult> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    await recordAiInferenceDecision(exec, inference.id, {
      status: 'rejected',
      decidedBy: input.audit.actor,
    });
    await record({
      entityType: 'ai_inference',
      entityId: inference.id,
      action: 'update',
      oldValue: { status: inference.status },
      newValue: { status: 'rejected', decidedBy: input.audit.actor, resultingRecordType: null },
      reason: 'Rejected in review; no authoritative record produced (ai-boundary.md).',
    });
    return { status: 'rejected' as const, inferenceId: inference.id };
  });
}

interface AcceptContext {
  readonly input: DecideInferenceInput;
  readonly inference: AiInferenceRow;
  readonly payment: PaymentRow;
  readonly target: AiInferenceStatus;
}

/**
 * Approves the expense this proposal stands for, and explains the payment with it.
 *
 * The expense usually already exists — classification created it as DERIVED (ADR-0026). It
 * does not when the decision *changed* the kind from settlement to expense, and then it is
 * created here, in this same transaction, before being approved.
 */
async function acceptAsExpense(
  ctx: AuditContext,
  args: AcceptContext & {
    readonly proposal: Extract<TransactionClassification, { proposedKind: 'expense' }>;
    readonly userPersonId: PersonId;
  },
): Promise<AcceptedExpenseResult> {
  const { input, inference, payment, proposal, target } = args;

  // Invariant #7: a transfer or an investment is not spending and can never fund an expense.
  assertPaymentCanFundExpense(
    payment.counterpartyType as Parameters<typeof assertPaymentCanFundExpense>[0],
  );

  const expenseId = await resolveExpenseForDecision(ctx, args);
  const expense = await getExpenseById(ctx.exec, expenseId);
  if (expense === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `AIInference ${inference.id} points at expense ${expenseId}, which does not exist.`,
      { inferenceId: inference.id, expenseId },
    );
  }

  if (input.decision === 'modify') {
    await updateExpenseClassification(ctx.exec, expenseId, {
      relationshipType: proposal.relationshipType,
      category: proposal.category,
    });
    await ctx.record({
      entityType: 'expense',
      entityId: expenseId,
      action: 'update',
      oldValue: { relationshipType: expense.relationshipType },
      newValue: { relationshipType: proposal.relationshipType, category: proposal.category },
      reason: `Corrected in review before approval (AIInference ${inference.id}).`,
    });
  }

  assertExpenseTransition(expense.state, 'approved');
  await updateExpenseState(ctx.exec, expenseId, 'approved');
  await ctx.record({
    entityType: 'expense',
    entityId: expenseId,
    action: 'update',
    oldValue: { state: expense.state },
    newValue: { state: 'approved' },
    reason:
      `Approved by ${input.audit.actor} from AIInference ${inference.id}. amount is now ` +
      'permanently immutable (invariants.md #6).',
  });

  const unexplainedRemainder = await linkPaymentToExpense(ctx, payment, expenseId, expense.amount);
  const paymentState = await explainPayment(ctx, payment);
  await attachAiInferenceRecord(ctx.exec, inference.id, 'expense', expenseId);

  return {
    status: target as AcceptedExpenseResult['status'],
    inferenceId: inference.id,
    resultingRecordType: 'expense',
    expenseId,
    expenseState: 'approved',
    paymentState,
    unexplainedRemainder,
  };
}

/** The expense this decision approves: the one classification made, or a new one. */
async function resolveExpenseForDecision(
  ctx: AuditContext,
  args: AcceptContext & {
    readonly proposal: Extract<TransactionClassification, { proposedKind: 'expense' }>;
    readonly userPersonId: PersonId;
  },
): Promise<ExpenseId> {
  const { inference, payment, proposal, userPersonId } = args;
  if (inference.resultingRecordType === 'expense' && inference.resultingRecordId !== null) {
    return inference.resultingRecordId as ExpenseId;
  }

  // The kind changed in review: a settlement proposal has no expense behind it, so the
  // decision creates one now. It still walks proposed → classified rather than appearing
  // approved out of nowhere; `requiresReview: false` because the review is happening.
  const created = await createDerivedExpenseFromProposal(ctx, {
    payment,
    proposal,
    paidByPersonId: userPersonId,
    inferenceId: inference.id,
    review: { requiresReview: false, reasons: [] },
  });
  return created.expenseId;
}

/**
 * Creates the `Settlement` this proposal stands for, and resolves the payment's counterparty
 * to the person it discharges an obligation with.
 *
 * The counterparty write is classification's, not `recordSettlement`'s: a manually-recorded
 * settlement already knows who the payment was to, whereas this is the moment that fact is
 * established for a payment normalization could only leave as `unknown`.
 */
async function acceptAsSettlement(
  ctx: AuditContext,
  args: AcceptContext & {
    readonly proposal: Extract<TransactionClassification, { proposedKind: 'settlement' }>;
  },
): Promise<AcceptedSettlementResult> {
  const { inference, payment, proposal, target } = args;
  const counterpartyPersonId = proposal.counterpartyPersonHint.id;

  await supersedeDerivedExpense(ctx, inference);

  const settlement = await recordSettlementWithin(ctx, {
    paymentId: payment.id,
    counterpartyPersonId,
    // A settlement proposed from a payment discharges what that payment moved. A partial
    // settlement is a manual act — the model is given no field to propose one with.
    amount: payment.amount,
    reason: null,
  });

  if (payment.counterpartyType !== 'person' || payment.counterpartyId !== counterpartyPersonId) {
    await applyPaymentCounterparty(ctx.exec, payment.id, {
      counterpartyType: 'person',
      counterpartyId: counterpartyPersonId,
    });
    await ctx.record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: {
        counterpartyType: payment.counterpartyType,
        counterpartyId: payment.counterpartyId,
      },
      newValue: { counterpartyType: 'person', counterpartyId: counterpartyPersonId },
      reason: `Resolved by accepting AIInference ${inference.id} as a settlement.`,
    });
  }

  await attachAiInferenceRecord(ctx.exec, inference.id, 'settlement', settlement.settlementId);

  return {
    status: target as AcceptedSettlementResult['status'],
    inferenceId: inference.id,
    resultingRecordType: 'settlement',
    settlementId: settlement.settlementId as SettlementId,
    counterpartyPersonId,
    paymentState: 'linked',
    unexplainedRemainder: settlement.unexplainedRemainder,
  };
}

/**
 * Records that a DERIVED expense was left behind when the decision came out a settlement.
 *
 * The expense is not deleted and not approved. Without this event the inference's pointer
 * moves to the settlement and nothing explains why an unapproved expense is sitting there
 * (ADR-0026).
 */
async function supersedeDerivedExpense(
  ctx: AuditContext,
  inference: AiInferenceRow,
): Promise<void> {
  if (inference.resultingRecordType !== 'expense' || inference.resultingRecordId === null) return;
  await ctx.record({
    entityType: 'expense',
    entityId: inference.resultingRecordId,
    action: 'supersede',
    newValue: { supersededBy: 'settlement', inferenceId: inference.id },
    reason:
      'The proposal this expense came from was decided as a settlement instead, so the ' +
      'expense stays unapproved and creates no obligation (ADR-0026).',
  });
}

/* ------------------------------------------------------------------------ internals */

/**
 * Attributes the whole payment to the expense it funded.
 *
 * The link amount is the expense's own amount, which classification copied from the payment.
 * One payment funding several expenses is real (`invariants.md` #1) but needs item-level
 * evidence to split — that is phase 11/12's, and the budget check here is what will refuse a
 * second link that does not fit.
 */
async function linkPaymentToExpense(
  ctx: AuditContext,
  payment: PaymentRow,
  expenseId: ExpenseId,
  amount: Paise,
): Promise<Paise> {
  const existingLinks = await listPaymentExpenseLinksByPayment(ctx.exec, payment.id);
  const existingSettlements = await listSettlementsByPayment(ctx.exec, payment.id);
  const explanation = validatePaymentExplanationBudget({
    paymentAmount: payment.amount,
    linkAmounts: [...existingLinks.map((link) => link.amount), amount],
    settlementAmounts: existingSettlements.map((row) => row.amount),
  });

  await insertPaymentExpenseLink(ctx.exec, { paymentId: payment.id, expenseId, amount });
  await ctx.record({
    entityType: 'payment_expense_link',
    entityId: expenseId,
    action: 'create',
    newValue: {
      paymentId: payment.id,
      expenseId,
      amount: amount.toString(),
      unexplainedRemainder: explanation.unexplained.toString(),
    },
  });
  return explanation.unexplained;
}

/** `normalized → linked`: the payment is now explained (`lifecycle.md`, revised by ADR-0007). */
async function explainPayment(ctx: AuditContext, payment: PaymentRow): Promise<PaymentState> {
  if (payment.state !== 'normalized') return payment.state;
  assertPaymentTransition('normalized', 'linked');
  await updatePaymentState(ctx.exec, payment.id, 'linked');
  await ctx.record({
    entityType: 'payment',
    entityId: payment.id,
    action: 'update',
    oldValue: { state: 'normalized' },
    newValue: { state: 'linked' },
  });
  return 'linked';
}

async function requireInference(db: Database, inferenceId: AiInferenceId): Promise<AiInferenceRow> {
  const inference = await getAiInferenceById(db, inferenceId);
  if (inference === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No AIInference with id ${inferenceId}.`, {
      inferenceId,
    });
  }
  if (inference.inferenceType !== 'classify_transaction') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `AIInference ${inferenceId} is a "${inference.inferenceType}" proposal, and deciding one ` +
        'produces a different record. Only classify_transaction is implemented (phase 8).',
      { inferenceId, inferenceType: inference.inferenceType },
    );
  }
  if (inference.inputRefType !== 'payment') {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `AIInference ${inferenceId} was run on a "${inference.inputRefType}", not a payment.`,
      { inferenceId, inputRefType: inference.inputRefType },
    );
  }
  return inference;
}

/**
 * The proposal this decision acts on, validated.
 *
 * `accept` re-parses what was stored: it has been through a JSONB round trip since anyone
 * looked at it, and the cost of checking again is nothing next to approving something nobody
 * validated. `modify` parses the replacement with the same function.
 */
function proposalFor(
  input: DecideInferenceInput,
  inference: AiInferenceRow,
): TransactionClassification {
  if (input.decision === 'modify') {
    if (input.modifiedOutput === undefined) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'A "modify" decision must carry the corrected proposal. To approve the proposal ' +
          'unchanged, use "accept".',
        { inferenceId: input.inferenceId },
      );
    }
    return parseTransactionClassification(input.modifiedOutput);
  }
  if (input.modifiedOutput !== undefined) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'An "accept" decision approves the stored proposal as it is. A changed proposal is a ' +
        '"modify" — the distinction is what the audit trail records.',
      { inferenceId: input.inferenceId },
    );
  }
  return parseTransactionClassification(inference.proposedOutput);
}
