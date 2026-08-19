/**
 * Transaction classification — the third step of the pipeline (`data-flow.md`, step 3).
 *
 * ```
 * services.classifyPayment ─▶ domain.classificationEligibility / isSelfTransferPair
 *                          ─▶ ai.classifyTransaction ─▶ AIInference (pending)
 *                          ─▶ domain.routeClassificationForReview
 *                          ─▶ db (DERIVED Expense: classified | review_required)
 * ```
 *
 * Two legs, and the deterministic one runs first (ADR-0023): a payment paired with an
 * opposite-direction leg is a transfer between the user's own accounts, which is evidence
 * rather than inference and never becomes a proposal. Everything else goes to the model, and
 * whatever comes back is a **proposal** — validated twice before it is stored, and never
 * authoritative until `services.decideInference` says so (ADR-0026).
 *
 * What this module cannot do, structurally: approve anything. It writes an `Expense` in a
 * DERIVED state and an `AIInference` in `pending`, and there is no call here that could move
 * either further (`invariants.md` #15, #16).
 */

import {
  assertExpenseTransition,
  classificationEligibility,
  findSelfTransferCounterLeg,
  routeClassificationForReview,
} from '../domain/index.js';
import type {
  AiInferenceId,
  ClassificationSkipReason,
  ConfidenceLevel,
  ExpenseId,
  ExpenseRelationshipType,
  ExpenseState,
  ImportBatchId,
  MerchantId,
  Paise,
  PaymentChannel,
  PaymentId,
  PersonId,
  ProposedKind,
  ReviewRoute,
  TransferLeg,
} from '../domain/index.js';
import { CLASSIFY_TRANSACTION, isAiContractError } from '../ai/index.js';
import type { AiService, ClassificationContext, TransactionClassification } from '../ai/index.js';
import {
  applyPaymentCounterparty,
  attachAiInferenceRecord,
  findClassificationInferenceByPayment,
  findPaymentsByExternalReference,
  getMerchantById,
  getPersonById,
  getPrimaryUserPerson,
  insertAiInference,
  insertExpense,
  listPaymentsAwaitingClassification,
  listPeople,
  updateExpenseState,
} from '../db/index.js';
import type { Database, Executor, PaymentRow } from '../db/index.js';

import { runAudited, type AuditContext, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { requirePayment } from './loaders.js';

/* --------------------------------------------------------------------------- inputs */

export interface ClassifyPaymentInput {
  readonly paymentId: PaymentId;
  /** The AI boundary. Injected, so a caller always knows which model answered (ADR-0025). */
  readonly ai: AiService;
  /** Overrides `domain.DEFAULT_MATERIALITY_THRESHOLD_PAISE` for this run. */
  readonly materialityThreshold?: Paise;
  readonly audit: AuditMeta;
}

export interface ClassifyPaymentsInput {
  /** Scope to one import batch. Omitted means every payment awaiting classification. */
  readonly importBatchId?: ImportBatchId;
  readonly ai: AiService;
  readonly materialityThreshold?: Paise;
  readonly audit: AuditMeta;
}

/* -------------------------------------------------------------------------- outcomes */

/** Nothing was written, and the reason is reported rather than swallowed. */
export interface SkippedClassification {
  readonly outcome: 'skipped';
  readonly paymentId: PaymentId;
  readonly reason: ClassificationSkipReason;
}

/** The deterministic leg: both sides of one transfer between the user's own accounts. */
export interface InternalTransferClassification {
  readonly outcome: 'internal_transfer';
  readonly paymentId: PaymentId;
  readonly counterLegPaymentId: PaymentId;
}

/** A validated proposal was stored. Nothing is approved; that is `decideInference`'s. */
export interface ProposedClassification {
  readonly outcome: 'proposed';
  readonly paymentId: PaymentId;
  readonly inferenceId: AiInferenceId;
  readonly proposedKind: ProposedKind;
  readonly confidence: ConfidenceLevel;
  readonly review: ReviewRoute;
  /** The DERIVED expense, on the expense path. `null` for a settlement proposal (ADR-0026). */
  readonly expenseId: ExpenseId | null;
  readonly expenseState: ExpenseState | null;
}

/** The model answered, and its answer was not a proposal. Nothing was written. */
export interface RejectedClassification {
  readonly outcome: 'rejected';
  readonly paymentId: PaymentId;
  readonly reason: string;
  /** `AiContractError.code` (gate 1) or `ServiceError.code` (gate 2). */
  readonly code: string;
}

export type ClassificationOutcome =
  | SkippedClassification
  | InternalTransferClassification
  | ProposedClassification
  | RejectedClassification;

export interface ClassifyPaymentsResult {
  /** One entry per payment offered, in the order processed. Nothing is silently dropped. */
  readonly outcomes: readonly ClassificationOutcome[];
}

/* --------------------------------------------------------------------------- service */

/**
 * Classifies every payment awaiting classification.
 *
 * Each payment is its own audited unit of work, unlike normalization's single transaction.
 * That is deliberate: a classification involves a call to an external model, and one
 * payment's answer arriving late, failing, or being nonsense must not roll back the payments
 * already classified beside it.
 *
 * A model response that breaches the contract, or a proposal that names something that does
 * not exist, is recorded as a `rejected` outcome and the run continues — those are facts about
 * one payment. Anything else (the provider being unreachable, the database failing) aborts the
 * run, because those are facts about the run.
 */
export async function classifyPayments(
  db: Database,
  input: ClassifyPaymentsInput,
): Promise<ClassifyPaymentsResult> {
  const awaiting = await listPaymentsAwaitingClassification(db, input.importBatchId);
  const outcomes: ClassificationOutcome[] = [];

  for (const payment of awaiting) {
    try {
      outcomes.push(
        await classifyPayment(db, {
          paymentId: payment.id,
          ai: input.ai,
          audit: input.audit,
          ...(input.materialityThreshold === undefined
            ? {}
            : { materialityThreshold: input.materialityThreshold }),
        }),
      );
    } catch (error) {
      const rejection = asProposalRejection(payment.id, error);
      if (rejection === null) throw error;
      outcomes.push(rejection);
    }
  }

  return { outcomes };
}

/**
 * Classifies one payment.
 *
 * Reads eligibility and calls the model **before** opening a transaction, so the audited unit
 * of work contains only writes — a payment that turns out to be ineligible, or whose proposal
 * is rejected, never opens one (and so never trips `runAudited`'s "committed nothing" guard,
 * the same shape phase 7 hit in `normalizePayments`).
 */
export async function classifyPayment(
  db: Database,
  input: ClassifyPaymentInput,
): Promise<ClassificationOutcome> {
  const payment = await requirePayment(db, input.paymentId);
  const existing = await findClassificationInferenceByPayment(db, payment.id);
  const eligibility = classificationEligibility({
    state: payment.state,
    counterpartyType: payment.counterpartyType as Parameters<
      typeof classificationEligibility
    >[0]['counterpartyType'],
    direction: payment.direction,
    hasClassificationInference: existing !== null,
  });

  if (eligibility.outcome === 'skipped') {
    return { outcome: 'skipped', paymentId: payment.id, reason: eligibility.reason };
  }

  // Leg 1, deterministic: is this one side of a transfer between the user's own accounts?
  const counterLeg = await findSelfTransferLeg(db, payment);
  if (counterLeg !== null) {
    return recordInternalTransfer(db, input.audit, payment, counterLeg);
  }

  if (eligibility.outcome === 'deterministic_only') {
    return { outcome: 'skipped', paymentId: payment.id, reason: eligibility.reason };
  }

  // Leg 2, inference. Gate 1 (the response is a proposal at all) lives in `src/ai` and throws
  // before anything is returned here.
  const context = await buildClassificationContext(db, payment);
  const inference = await input.ai.classifyTransaction(
    {
      amount: payment.amount,
      currency: payment.currency,
      direction: payment.direction,
      occurredAt: payment.occurredAt,
      rawDescription: payment.rawDescription,
      channel: payment.channel as PaymentChannel,
      externalReference: payment.externalReference,
    },
    context,
  );

  // Gate 2: the proposal is well-formed, but does it name things that exist and agree with
  // what the payment itself already proves?
  const userPersonId = await requireUserPersonId(db);
  await validateClassificationProposal(db, {
    payment,
    proposal: inference.proposedOutput,
    userPersonId,
  });

  const review = routeClassificationForReview({
    confidence: inference.confidence,
    amount: payment.amount,
    proposedKind: inference.proposedOutput.proposedKind,
    ...(input.materialityThreshold === undefined
      ? {}
      : { materialityThreshold: input.materialityThreshold }),
  });

  return runAudited(db, input.audit, async (ctx) => {
    const inferenceId = await storeInference(ctx, payment, inference);

    if (inference.proposedOutput.proposedKind === 'settlement') {
      // Nothing else is written. A Settlement is created directly as APPROVED
      // (`lifecycle.md`), so creating one now would write authoritative state straight from
      // a model's output — the pending inference is the queue entry instead (ADR-0026).
      return {
        outcome: 'proposed',
        paymentId: payment.id,
        inferenceId,
        proposedKind: 'settlement',
        confidence: inference.confidence,
        review,
        expenseId: null,
        expenseState: null,
      };
    }

    const expense = await createDerivedExpenseFromProposal(ctx, {
      payment,
      proposal: inference.proposedOutput,
      paidByPersonId: userPersonId,
      inferenceId,
      review,
    });
    await attachAiInferenceRecord(ctx.exec, inferenceId, 'expense', expense.expenseId);

    return {
      outcome: 'proposed',
      paymentId: payment.id,
      inferenceId,
      proposedKind: 'expense',
      confidence: inference.confidence,
      review,
      expenseId: expense.expenseId,
      expenseState: expense.state,
    };
  });
}

/* ------------------------------------------------------------------------- gate two */

export interface ProposalValidationInput {
  readonly payment: PaymentRow;
  readonly proposal: TransactionClassification;
  readonly userPersonId: PersonId;
}

/**
 * The second validation gate: a well-formed proposal, checked against the ledger.
 *
 * Gate 1 (`src/ai`) can only see the response. This one knows what the payment is and who
 * exists, and rejects three things a schema cannot:
 *
 *  - an **expense proposed against a credit** — a credit is not spend, and an `Expense` is a
 *    spend event by definition (ADR-0027, `invariants.md` #7's neighbourhood);
 *  - a **payer who is not the user** — the money moved through an account the user owns, so
 *    the payer is the account owner. An externally-funded expense has no `Payment` at all
 *    (ADR-0006), so a proposal naming someone else contradicts its own evidence;
 *  - a **person who does not exist**, is archived, or is the user themselves (nobody settles
 *    with themselves).
 *
 * Exported because `decideInference`'s `modify` path runs a human's correction through exactly
 * the same checks — a corrected proposal must not enter by a laxer door.
 */
export async function validateClassificationProposal(
  exec: Executor,
  input: ProposalValidationInput,
): Promise<void> {
  const { payment, proposal, userPersonId } = input;

  if (proposal.proposedKind === 'expense') {
    if (payment.direction === 'credit') {
      throw invalidProposal(
        'An expense cannot be funded by a credit: money arriving is not spending. A credit ' +
          'that nets against an earlier expense is an ExpenseAdjustment (ADR-0008), not a ' +
          'new Expense.',
        { paymentId: payment.id, direction: payment.direction },
      );
    }
    const hint = proposal.paidByPersonHint;
    if (hint !== null && hint.id !== userPersonId) {
      throw invalidProposal(
        `The payer of a payment-funded expense is the owner of the account the money left, ` +
          `not ${hint.id}. An expense someone else paid for has no Payment in this ledger at ` +
          'all (ADR-0006), so it can never arrive through classification.',
        { paymentId: payment.id, proposedPayer: hint.id },
      );
    }
    return;
  }

  const counterparty = proposal.counterpartyPersonHint;
  if (counterparty.id === userPersonId) {
    throw invalidProposal(
      'A settlement discharges an obligation between two people. The user cannot be their ' +
        'own counterparty.',
      { paymentId: payment.id, counterpartyPersonId: counterparty.id },
    );
  }
  const person = await getPersonById(exec, counterparty.id);
  if (person === null) {
    throw invalidProposal(
      `The proposal names person ${counterparty.id}, who does not exist. A proposal may only ` +
        'refer to people it was given (ai-boundary.md: unknown ids are rejected).',
      { paymentId: payment.id, counterpartyPersonId: counterparty.id },
    );
  }
  if (person.archivedAt !== null) {
    throw invalidProposal(
      `The proposal names ${person.displayName}, who is archived and was not offered as a ` +
        'counterparty candidate.',
      { paymentId: payment.id, counterpartyPersonId: counterparty.id },
    );
  }
}

/* ------------------------------------------------------------------------- internals */

function invalidProposal(message: string, details: Record<string, string>): ServiceError {
  return new ServiceError('AI_PROPOSAL_INVALID', message, details);
}

/**
 * Turns the two "this proposal is not usable" failures into a recorded outcome.
 *
 * Everything else — a transport that never answered, a database error — returns `null` and is
 * re-thrown by the caller. "The model said something invalid" is a fact about one payment;
 * "the model is unreachable" is a fact about the run, and treating them alike would let a
 * dead provider look like eight individually-nonsensical answers.
 */
function asProposalRejection(paymentId: PaymentId, error: unknown): RejectedClassification | null {
  if (isAiContractError(error)) {
    return { outcome: 'rejected', paymentId, reason: error.message, code: error.code };
  }
  if (error instanceof ServiceError && error.code === 'AI_PROPOSAL_INVALID') {
    return { outcome: 'rejected', paymentId, reason: error.message, code: error.code };
  }
  return null;
}

/** The counter-leg proving this payment is a self-transfer, if the ledger holds one. */
async function findSelfTransferLeg(
  exec: Executor,
  payment: PaymentRow,
): Promise<PaymentRow | null> {
  if (payment.externalReference === null) return null;
  const candidates = await findPaymentsByExternalReference(exec, payment.externalReference);
  const counterLeg = findSelfTransferCounterLeg(
    asTransferLeg(payment),
    candidates.map(asTransferLeg),
  );
  if (counterLeg === null) return null;
  return candidates.find((candidate) => candidate.id === counterLeg.paymentId) ?? null;
}

function asTransferLeg(payment: PaymentRow): TransferLeg {
  return {
    paymentId: payment.id,
    amount: payment.amount,
    direction: payment.direction,
    occurredAt: payment.occurredAt,
    externalReference: payment.externalReference,
    state: payment.state,
  };
}

/**
 * Records that a payment is one leg of a transfer between the user's own accounts.
 *
 * Only this leg is written. The counter-leg is classified by its own call, from the same
 * symmetric evidence — a decision about that payment is that payment's own audited event, not
 * a side effect of this one.
 *
 * `counterparty_id` stays null: the far side is named only as free text on the statement line,
 * and exclusion from spend comes from `counterparty_type` alone (`invariants.md` #7).
 */
async function recordInternalTransfer(
  db: Database,
  audit: AuditMeta,
  payment: PaymentRow,
  counterLeg: PaymentRow,
): Promise<InternalTransferClassification> {
  return runAudited(db, audit, async ({ exec, record }) => {
    await applyPaymentCounterparty(exec, payment.id, {
      counterpartyType: 'internal_account',
      counterpartyId: null,
    });
    await record({
      entityType: 'payment',
      entityId: payment.id,
      action: 'update',
      oldValue: {
        counterpartyType: payment.counterpartyType,
        counterpartyId: payment.counterpartyId,
      },
      newValue: {
        counterpartyType: 'internal_account',
        counterpartyId: null,
        // The evidence, named: this is reproducible from the two rows, with no model involved.
        pairedWithPaymentId: counterLeg.id,
        externalReference: payment.externalReference,
      },
      reason:
        'Paired with an opposite-direction leg sharing one reference, amount and instant — a ' +
        'transfer between the user’s own accounts (ADR-0023). Not spending; stays at ' +
        'normalized (invariants.md #7).',
    });
    return {
      outcome: 'internal_transfer' as const,
      paymentId: payment.id,
      counterLegPaymentId: counterLeg.id,
    };
  });
}

/** The merchant normalization resolved for this payment, if it resolved one. */
async function loadPaymentMerchant(
  exec: Executor,
  payment: PaymentRow,
): Promise<{ canonicalName: string; defaultCategory: string | null } | null> {
  if (payment.counterpartyType !== 'merchant' || payment.counterpartyId === null) return null;
  return getMerchantById(exec, payment.counterpartyId as MerchantId);
}

/** The already-resolved references a proposal may refer to, rather than raw statement text. */
async function buildClassificationContext(
  exec: Executor,
  payment: PaymentRow,
): Promise<ClassificationContext> {
  const merchant =
    payment.counterpartyType === 'merchant' && payment.counterpartyId !== null
      ? await getMerchantById(exec, payment.counterpartyId as MerchantId)
      : null;
  const userPerson = await getPrimaryUserPerson(exec);
  const people = await listPeople(exec);
  return {
    merchant,
    // The user is not a candidate counterparty: a settlement is with someone else.
    knownPeople: people.filter((person) => person.id !== userPerson?.personId),
  };
}

export async function requireUserPersonId(exec: Executor): Promise<PersonId> {
  const userPerson = await getPrimaryUserPerson(exec);
  if (userPerson === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      'No User exists, so there is nobody for a payment-funded expense to have been paid by ' +
        '(domain-model.md: a User maps to exactly one Person).',
    );
  }
  return userPerson.personId;
}

/** Writes the pending proposal, and the audit event saying a model produced it. */
async function storeInference(
  ctx: AuditContext,
  payment: PaymentRow,
  inference: {
    readonly proposedOutput: TransactionClassification;
    readonly confidence: ConfidenceLevel;
    readonly modelInfo: {
      readonly provider: string;
      readonly model: string;
      readonly promptVersion: string;
    };
  },
): Promise<AiInferenceId> {
  const inferenceId = await insertAiInference(ctx.exec, {
    inferenceType: CLASSIFY_TRANSACTION,
    inputRefType: 'payment',
    inputRefId: payment.id,
    // The validated proposal, not the raw response: what was agreed to, byte for byte.
    proposedOutput: inference.proposedOutput,
    confidence: inference.confidence,
    modelProvider: inference.modelInfo.provider,
    modelName: inference.modelInfo.model,
    promptVersion: inference.modelInfo.promptVersion,
  });

  await ctx.record({
    entityType: 'ai_inference',
    entityId: inferenceId,
    action: 'create',
    newValue: {
      inferenceType: CLASSIFY_TRANSACTION,
      status: 'pending',
      inputRefType: 'payment',
      inputRefId: payment.id,
      confidence: inference.confidence,
      proposedKind: inference.proposedOutput.proposedKind,
      modelProvider: inference.modelInfo.provider,
      modelName: inference.modelInfo.model,
      promptVersion: inference.modelInfo.promptVersion,
    },
  });

  return inferenceId;
}

export interface DerivedExpenseInput {
  readonly payment: PaymentRow;
  readonly proposal: Extract<TransactionClassification, { proposedKind: 'expense' }>;
  readonly paidByPersonId: PersonId;
  readonly inferenceId: AiInferenceId;
  /** Where routing says this proposal stops. `requiresReview: false` lands at `classified`. */
  readonly review: ReviewRoute;
}

/**
 * Creates the expense a classification proposes, and walks it to where routing says it stops.
 *
 * `proposed → classified → (review_required)`, one asserted transition and one audit event at
 * a time. Inserting it directly at its final state would be shorter and would skip states the
 * lifecycle draws — and "nothing skips a state silently" is the whole claim `lifecycle.md`
 * makes. The expense is DERIVED throughout: `decideInference` is the only path to `approved`.
 */
export async function createDerivedExpenseFromProposal(
  ctx: AuditContext,
  input: DerivedExpenseInput,
): Promise<{ readonly expenseId: ExpenseId; readonly state: ExpenseState }> {
  const { payment, proposal, review } = input;
  const relationshipType: ExpenseRelationshipType = proposal.relationshipType;
  const merchant = await loadPaymentMerchant(ctx.exec, payment);
  // The catalog's category is a deterministic fallback, never an override of the proposal.
  const category = proposal.category ?? merchant?.defaultCategory ?? null;
  const description = merchant?.canonicalName ?? payment.rawDescription;

  const expenseId = await insertExpense(ctx.exec, {
    description,
    amount: payment.amount,
    currency: payment.currency,
    occurredAt: payment.occurredAt,
    relationshipType,
    category,
    paidByPersonId: input.paidByPersonId,
    state: 'proposed',
  });
  await ctx.record({
    entityType: 'expense',
    entityId: expenseId,
    action: 'create',
    newValue: {
      state: 'proposed',
      description,
      amount: payment.amount.toString(),
      currency: payment.currency,
      relationshipType,
      category,
      paidByPersonId: input.paidByPersonId,
      fromInferenceId: input.inferenceId,
      fromPaymentId: payment.id,
    },
    reason: `Proposed by AIInference ${input.inferenceId} (classify_transaction).`,
  });

  await transitionDerivedExpense(ctx, expenseId, 'proposed', 'classified', null);
  if (!review.requiresReview) return { expenseId, state: 'classified' };

  await transitionDerivedExpense(
    ctx,
    expenseId,
    'classified',
    'review_required',
    `Review required: ${review.reasons.join(', ')} (ADR-0024).`,
  );
  return { expenseId, state: 'review_required' };
}

async function transitionDerivedExpense(
  ctx: AuditContext,
  expenseId: ExpenseId,
  from: ExpenseState,
  to: ExpenseState,
  reason: string | null,
): Promise<void> {
  assertExpenseTransition(from, to);
  await updateExpenseState(ctx.exec, expenseId, to);
  await ctx.record({
    entityType: 'expense',
    entityId: expenseId,
    action: 'update',
    oldValue: { state: from },
    newValue: { state: to },
    reason,
  });
}
