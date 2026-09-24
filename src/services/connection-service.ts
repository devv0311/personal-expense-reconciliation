/**
 * One real-world financial event, and everything the ledger has connected to it.
 *
 * ```
 * services.getPaymentConnection ─▶ services.getPaymentWorkspaceItem   the movement + what explains it
 *                               ─▶ services.getPaymentContext         the records attached to it
 *                               ─▶ db.listEvidenceMatchCandidatesByPayment   what is proposed about it
 *                               ─▶ db.listPaymentExpenseLinksByPayment + services.getExpenseLedgerRow
 *                               ─▶ db.getCurrentAllocation + listAllocationLines + listGroupExpansions
 *                               ─▶ db.listSettlementRegister + db.listAdjustmentsByAdjustmentPayment
 *                               ─▶ services.listAttentionQuestions    what still needs a person
 *                               ─▶ domain.paymentNature               what kind of event it is
 * ```
 *
 * **This composes; it computes nothing.** Every figure below is one an existing domain function
 * or repository already produced: `explainedAmount` through the workspace item, `netAmount`
 * through the expense ledger row, allocation line amounts as the approval wrote them. There is
 * no arithmetic in this file and no second definition of anything.
 *
 * Three properties are the point of it existing at all:
 *
 *  - **One event, however many records.** A statement line, the bill for it and the screenshot
 *    of it are one `ConnectionResult` with three `supportingRecords`. The spending figure is
 *    `spendingContribution`, singular, taken from the payment's own expense links — adding a
 *    record can never add a total.
 *  - **A proposal stays a proposal.** `proposals` carries what the matcher recorded, with the
 *    plain reasons it looks related and the plain reasons it might not. Nothing in this read
 *    turns one into a link; `services.decideEvidenceMatch` is still the only thing that can.
 *  - **Absence is absence.** An expense nobody has been named on returns `shares: null` with a
 *    sentence, never an empty list that reads as "nobody owes anything", and never zeroes.
 */

import {
  asId,
  attentionQuestion,
  documentWords,
  matchSignalWords,
  natureCountsAsSpending,
  paymentNature,
  shareObligationWords,
  whyNotSpending,
} from '../domain/index.js';
import type { ApprovedCategoryRule } from '../domain/index.js';
import type {
  EvidenceId,
  ExpenseId,
  ExpenseState,
  Paise,
  PaymentDirection,
  PaymentId,
  PaymentNature,
  PersonId,
  RelatedPayment,
} from '../domain/index.js';
import {
  getCurrentAllocation,
  getGroupById,
  listAdjustmentsByAdjustmentPayment,
  listAllocationLines,
  listEvidenceMatchCandidatesByPayment,
  listExpenseAdjustmentSummaries,
  listGroupExpansions,
  listPaymentExpenseLinksByPayment,
  listPeople,
  listSettlementRegister,
} from '../db/index.js';
import type { Executor } from '../db/index.js';

import { listAttentionQuestions, readSuggestion } from './attention-service.js';
import { loadApprovedCategoryRules } from './learning-service.js';
import { loadPurposeContext } from './purpose-proposal-service.js';
import type { AttentionItem } from './attention-service.js';
import { getPaymentContext } from './evidence-enrichment-service.js';
import { getExpenseLedgerRow } from './expense-ledger-service.js';
import { getPaymentWorkspaceItem } from './payment-workspace-service.js';

/* ----------------------------------------------------------------------------- shapes */

/** A figure, and whether the ledger can stand behind it. Same contract as the overview's. */
export interface ConnectionFigure {
  readonly known: boolean;
  readonly amount: Paise | null;
  readonly unknownReason?: string;
}

/** What one supporting record says, in the terms the record itself uses. */
export interface ConnectionRecordReading {
  readonly name: string | null;
  readonly amount: Paise | null;
  readonly reference: string | null;
  readonly occurredAt: Date | null;
}

export interface ConnectionSupportingRecord {
  readonly evidenceId: EvidenceId;
  /** 'Bill or receipt', 'Screenshot', 'Payment message', 'Note you wrote'. */
  readonly label: string;
  /** The stored type. For the Details disclosure only. */
  readonly evidenceType: string;
  readonly capturedAt: Date;
  /** `null` when the record is attached but nothing has read it into structured form. */
  readonly reading: ConnectionRecordReading | null;
}

/** A connection the system is offering, never one it has made. */
export interface ConnectionProposal {
  readonly candidateId: string;
  readonly evidenceId: EvidenceId;
  readonly label: string;
  readonly evidenceType: string;
  readonly capturedAt: Date;
  /** `proposed` is the only one a person can still answer; the rest are history. */
  readonly status: string;
  /** Plain sentences. 'The amount is the same.' Never a signal name or a score. */
  readonly whyRelated: readonly string[];
  /** Plain sentences for whatever disagrees. Shown, never used to hide the offer. */
  readonly whyUnsure: readonly string[];
  readonly decidedAt: Date | null;
}

/** One person's or group's share of an expense. */
export interface ConnectionShare {
  readonly name: string;
  /** True for the person this ledger belongs to, so a screen can say 'You'. */
  readonly isYou: boolean;
  readonly amount: Paise;
  readonly beneficiaryKind: 'person' | 'group';
  /** For a group line, the people it expands to, with their own shares (ADR-0009). */
  readonly members: readonly { readonly name: string; readonly amount: Paise }[] | null;
}

/** Money that came back against this expense. */
export interface ConnectionRefund {
  readonly adjustmentId: string;
  /** 'Money back from the seller' or 'Paid back by somebody else'. */
  readonly label: string;
  readonly amount: Paise;
  readonly occurredAt: Date;
}

export interface ConnectionExpense {
  readonly expenseId: ExpenseId;
  readonly whatItWas: string | null;
  readonly category: string | null;
  /** Immutable, historical. Shown beside the net figure, never replaced by it. */
  readonly grossAmount: Paise;
  readonly netAmount: Paise;
  /** How much of *this* payment funds it. */
  readonly fundedByThisPayment: Paise;
  readonly paidBy: { readonly personId: PersonId; readonly name: string; readonly isYou: boolean };
  /** `null` when nobody has been named — never an empty list, which reads as 'nobody'. */
  readonly shares: readonly ConnectionShare[] | null;
  readonly sharesUnknownReason: string | null;
  /**
   * What these shares mean for who owes whom, in one sentence — `null` when nobody is named.
   *
   * Decided here rather than on the screen, because "everybody else owes the payer" is false
   * for a `personal` or `gift` expense: those divide without creating any debt at all
   * (`invariants.md` #2a). A screen that assumed otherwise would assert an obligation the
   * ledger's own balances refuse to carry.
   */
  readonly obligationNote: string | null;
  readonly refunds: readonly ConnectionRefund[];
  readonly state: ExpenseState;
}

export interface ConnectionSettlement {
  readonly settlementId: string;
  readonly counterpartyName: string;
  readonly amount: Paise;
  /** What the movement did, in the reader's terms. */
  readonly label: string;
}

/** This credit *is* money coming back against something already bought. */
export interface ConnectionRefundOf {
  readonly adjustmentId: string;
  readonly expenseId: ExpenseId;
  readonly whatItWas: string | null;
  readonly label: string;
  readonly amount: Paise;
}

/** Where two records disagree. Reported, never resolved (ADR-0044). */
export interface ConnectionDisagreement {
  readonly about: string;
  readonly detail: string;
  readonly values: readonly string[];
}

/**
 * The best name this event has, and where it came from.
 *
 * Four sources, in descending order of how much somebody has actually established: who the
 * counterparty was recorded as, what the attached records call it, what the expense it funded
 * was described as, and — last — the bank's own narration. The source travels with the text so
 * a screen can say "this is what your bank wrote" rather than presenting `UPI-AMZN9821PYTM` as
 * though somebody had chosen it.
 */
export interface ConnectionTitle {
  readonly text: string;
  readonly source: 'counterparty' | 'record' | 'expense' | 'narration';
}

export interface ConnectionResult {
  readonly paymentId: PaymentId;
  readonly nature: PaymentNature;
  readonly title: ConnectionTitle;
  /** The best human name for the other side, or `null` when nothing has established one. */
  readonly merchantName: string | null;
  /** `Payment.raw_description`, verbatim. Immutable source — Details, not the headline. */
  readonly narration: string;
  readonly occurredAt: Date;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly accountName: string;

  /** True only for `spending`. The one flag that keeps a transfer out of a spending total. */
  readonly countsAsSpending: boolean;
  readonly whyNotSpending: string | null;
  /**
   * What this one movement contributes to spending — the payment's own expense links, and
   * nothing else. Several supporting records cannot make it larger.
   */
  readonly spendingContribution: Paise;
  /** What nothing accounts for. `domain.explainedAmount`'s answer, never recomputed. */
  readonly unaccountedFor: ConnectionFigure;
  /**
   * True when nothing at all is left unaccounted for.
   *
   * Decided here rather than by a screen comparing the figure to zero, for the same reason
   * every other judgement is: a zero is good news or bad news depending on whether anybody
   * finished looking, and only this layer knows which.
   */
  readonly fullyAccountedFor: boolean;

  readonly duplicate: {
    readonly isDuplicate: boolean;
    /** The record that keeps the money, when this one is a restatement of it. */
    readonly ofPaymentId: string | null;
  };

  readonly supportingRecords: readonly ConnectionSupportingRecord[];
  readonly proposals: readonly ConnectionProposal[];
  readonly disagreements: readonly ConnectionDisagreement[];
  readonly expenses: readonly ConnectionExpense[];
  readonly settlements: readonly ConnectionSettlement[];
  readonly refundOf: readonly ConnectionRefundOf[];
  /** Everything about this event that still needs a person, as questions. */
  readonly openQuestions: readonly AttentionItem[];

  /** The immutable/audit fields, for the Details disclosure. Never the primary surface. */
  readonly details: {
    readonly channel: string;
    readonly reference: string | null;
    readonly referenceType: string | null;
    readonly counterpartyType: string;
    readonly paymentState: string;
    readonly cashFlowCategory: string | null;
    readonly cashFlowState: string;
    readonly importBatchId: string;
    readonly currency: string;
  };
}

export interface PaymentConnectionInput {
  readonly paymentId: PaymentId;
  /** Whose ledger this is, so a share can be labelled 'You' rather than by name. */
  readonly userPersonId: PersonId | null;
}

/* ---------------------------------------------------------------------------- service */

export async function getPaymentConnection(
  db: Executor,
  input: PaymentConnectionInput,
): Promise<ConnectionResult> {
  const movement = await getPaymentWorkspaceItem(db, input.paymentId);

  const [context, candidates, links, settlementRows, refundRows, people] = await Promise.all([
    getPaymentContext(db, input.paymentId),
    listEvidenceMatchCandidatesByPayment(db, input.paymentId),
    listPaymentExpenseLinksByPayment(db, input.paymentId),
    listSettlementRegister(db, { paymentId: input.paymentId, limit: 50 }),
    listAdjustmentsByAdjustmentPayment(db, input.paymentId),
    listPeople(db),
  ]);

  const names = new Map<string, string>();
  for (const person of people) names.set(person.id, person.displayName);

  const expenses = await Promise.all(
    links.map((link) => toConnectionExpense(db, link, names, input.userPersonId)),
  );
  const present = expenses.filter((expense): expense is ConnectionExpense => expense !== null);

  const nature = paymentNature({
    direction: movement.direction,
    counterpartyType: movement.counterpartyType,
    cashFlowCategory: movement.cashFlowCategory,
    isDuplicateRepresentation: movement.isDuplicateRepresentation,
    expenseLinkCount: movement.expenseLinkCount,
    settlementCount: movement.settlementCount,
    adjustmentCount: refundRows.length,
  });

  // Every question, not a page of them: this read is *finding* the ones about this event, and
  // a page that stopped short would report "nothing needs you" about a movement that does. The
  // cost is the queue's own size, which is the price of there being one definition of what
  // needs a person rather than a second one here.
  const questions = await listAttentionQuestions(db, { limit: 'all' });
  // Only when this event may need a reading of its own — an explained payment already has its
  // answer, and loading the ledger's wording to say so would be work for nothing.
  const [purposeContext, approvedRules] = await Promise.all([
    loadPurposeContext(db),
    loadApprovedCategoryRules(db),
  ]);
  const expenseIds = new Set(present.map((expense) => expense.expenseId as string));

  const merchantName = movement.counterpartyName ?? topMerchantCandidate(context.context);
  const unaccountedFor = unaccountedFigure(movement.unexplainedTotal, nature);

  return {
    paymentId: movement.id,
    nature,
    title: titleFor({
      counterpartyName: movement.counterpartyName,
      recordName: topMerchantCandidate(context.context),
      expenseName: present.length === 1 ? (present[0]?.whatItWas ?? null) : null,
      narration: movement.rawDescription,
    }),
    merchantName,
    narration: movement.rawDescription,
    occurredAt: movement.occurredAt,
    amount: movement.amount,
    direction: movement.direction,
    accountName: movement.accountName,

    countsAsSpending: natureCountsAsSpending(nature),
    whyNotSpending: whyNotSpending(nature),
    // The payment's own links, straight from the workspace item. A screen showing three
    // supporting records still shows one contribution, because this is not derived from them.
    spendingContribution: natureCountsAsSpending(nature)
      ? movement.expenseLinkTotal
      : (0n as Paise),
    unaccountedFor,
    fullyAccountedFor: unaccountedFor.known && unaccountedFor.amount === 0n,

    duplicate: {
      isDuplicate: movement.isDuplicateRepresentation,
      ofPaymentId: duplicateOf(movement.ignoredReason),
    },

    supportingRecords: context.context.sources.map((source) => ({
      evidenceId: source.evidenceId as EvidenceId,
      label: documentWords(source.evidenceType),
      evidenceType: source.evidenceType,
      capturedAt: source.capturedAt,
      reading:
        source.observation === null
          ? null
          : {
              name: source.observation.observedMerchantText,
              amount: source.observation.observedAmount,
              reference: source.observation.observedReference,
              occurredAt: source.observation.observedOccurredAt,
            },
    })),

    proposals: candidates.map(({ candidate, evidence }) => ({
      candidateId: candidate.id,
      evidenceId: candidate.evidenceId,
      label: documentWords(evidence.type),
      evidenceType: evidence.type,
      capturedAt: evidence.capturedAt,
      status: candidate.status,
      whyRelated: candidate.matchedSignals.map((signal) => matchSignalWords(signal, 'agreed')),
      whyUnsure: candidate.conflictingSignals.map((signal) =>
        matchSignalWords(signal, 'disagreed'),
      ),
      decidedAt: candidate.decidedAt,
    })),

    disagreements: context.context.conflicts.map((conflict) => ({
      about: conflict.field,
      detail: conflict.detail,
      values: conflict.values.map((value) => value.value),
    })),

    expenses: present,

    settlements: settlementRows.map((row) => ({
      settlementId: row.id,
      counterpartyName: row.counterpartyName,
      amount: row.amount,
      label:
        row.direction === 'debit'
          ? `You paid ${row.counterpartyName} back`
          : `${row.counterpartyName} paid you back`,
    })),

    refundOf: refundRows.map((row) => ({
      adjustmentId: row.id,
      expenseId: row.originalExpenseId,
      whatItWas:
        present.find((expense) => expense.expenseId === row.originalExpenseId)?.whatItWas ?? null,
      label: refundWords(row.kind),
      amount: row.amount,
    })),

    openQuestions: openQuestionsFor(
      questions.items.filter((question) =>
        questionIsAboutThisEvent(question, movement.id, expenseIds),
      ),
      movement,
      nature,
      purposeContext,
      approvedRules,
    ),

    details: {
      channel: movement.channel,
      reference: movement.externalReference,
      referenceType: movement.referenceType,
      counterpartyType: movement.counterpartyType,
      paymentState: movement.state,
      cashFlowCategory: movement.cashFlowCategory,
      cashFlowState: movement.cashFlowState,
      importBatchId: movement.importBatchId,
      currency: movement.currency,
    },
  };
}

/* ------------------------------------------------------------------------- internals */

/**
 * The questions this event raises, including the one the review queue never asks.
 *
 * A payment nothing explains only reaches the queue if a model proposed something about it and
 * somebody declined — `rejected_classification`. A payment nobody ever asked a model about is
 * just as unexplained and just as much a question, and until now the only place that showed
 * was as a number in an "unaccounted for" total. It is asked here, on the one screen about
 * that payment, rather than added to the queue: with a ledger of imported statements, most
 * rows are unexplained on arrival, and a queue that listed every one of them would be a queue
 * nobody could work through.
 */
function openQuestionsFor(
  fromQueue: readonly AttentionItem[],
  movement: {
    id: PaymentId;
    amount: Paise;
    unexplainedTotal: Paise;
    occurredAt: Date;
    rawDescription: string;
    direction: PaymentDirection;
  },
  nature: PaymentNature,
  purposeContext: readonly RelatedPayment[],
  approvedRules: readonly ApprovedCategoryRule[],
): readonly AttentionItem[] {
  const alreadyAsked = fromQueue.some(
    (question) => question.subject.kind === 'payment' || question.subject.kind === 'payment_pair',
  );
  if (nature !== 'not_yet_known' || movement.unexplainedTotal <= 0n || alreadyAsked) {
    return fromQueue;
  }

  const asked = attentionQuestion({ kind: 'payment_unaccounted', reasons: [] });
  const question: AttentionItem = {
    id: `payment:${movement.id}`,
    source: 'ledger',
    kind: 'payment_unaccounted',
    question: asked.question,
    why: asked.why,
    reasons: [],
    amount: { known: true, value: movement.unexplainedTotal },
    occurredAt: movement.occurredAt,
    facts: [
      { label: 'Payment', kind: 'money', value: movement.amount },
      { label: 'When', kind: 'date', value: movement.occurredAt },
      { label: 'What the record says', kind: 'text', value: movement.rawDescription },
    ],
    subject: { kind: 'payment', paymentId: movement.id },
    item: null,
    // The same reading the queue's questions carry. There is no proposal to confirm yet —
    // `inferenceId` is null — so the screen shows what the line looks like and what would be
    // suggested, rather than offering an agreement with something that does not exist.
    suggestion: readSuggestion({
      payment: {
        paymentId: movement.id,
        description: movement.rawDescription,
        direction: movement.direction,
      },
      context: purposeContext,
      approvedRules,
      inferenceId: null,
      confidence: 'unknown',
      proposed: null,
    }),
  };
  return [question, ...fromQueue];
}

/**
 * What nothing accounts for, and whether that phrase means anything for this movement.
 *
 * A confirmed duplicate has no gap — the money was counted once already, and reporting one
 * would invent a hole in the account (`invariants.md` #10). The workspace item already returns
 * zero there; this states the reason rather than leaving a bare zero to be read as "verified".
 */
function unaccountedFigure(unexplained: Paise, nature: PaymentNature): ConnectionFigure {
  if (nature === 'duplicate') {
    return {
      known: false,
      amount: null,
      unknownReason:
        'This is the same money as another record, so there is nothing separate to account for.',
    };
  }
  return { known: true, amount: unexplained };
}

/** The best established name, and which of the four it is. */
function titleFor(input: {
  counterpartyName: string | null;
  recordName: string | null;
  expenseName: string | null;
  narration: string;
}): ConnectionTitle {
  if (input.counterpartyName !== null) {
    return { text: input.counterpartyName, source: 'counterparty' };
  }
  if (input.recordName !== null) return { text: input.recordName, source: 'record' };
  if (input.expenseName !== null) return { text: input.expenseName, source: 'expense' };
  return { text: input.narration, source: 'narration' };
}

/** `duplicate_of:<id>` → `<id>`. Parsed here rather than shown as a stored reason string. */
function duplicateOf(ignoredReason: string | null): string | null {
  if (ignoredReason === null) return null;
  const prefix = 'duplicate_of:';
  return ignoredReason.startsWith(prefix) ? ignoredReason.slice(prefix.length) : null;
}

function refundWords(kind: 'merchant_refund' | 'third_party_reimbursement'): string {
  return kind === 'merchant_refund' ? 'Money back from the seller' : 'Paid back by somebody else';
}

/** The best-corroborated name the attached records supply, when the payment names nobody. */
function topMerchantCandidate(context: {
  merchantCandidates: readonly { value: string }[];
}): string | null {
  return context.merchantCandidates[0]?.value ?? null;
}

async function toConnectionExpense(
  db: Executor,
  link: { expenseId: ExpenseId; amount: Paise },
  names: Map<string, string>,
  userPersonId: PersonId | null,
): Promise<ConnectionExpense | null> {
  const row = await getExpenseLedgerRow(db, link.expenseId);
  if (row === null) return null;

  const allocation = await getCurrentAllocation(db, link.expenseId);
  const shares =
    allocation === null ? null : await toShares(db, allocation.id, names, userPersonId);

  const adjustments = await listAdjustmentsForExpense(db, link.expenseId);

  return {
    expenseId: row.id,
    whatItWas: row.description,
    category: row.category,
    grossAmount: row.grossAmount,
    netAmount: row.netAmount,
    fundedByThisPayment: link.amount,
    paidBy: {
      personId: row.paidByPersonId,
      name: names.get(row.paidByPersonId) ?? 'Somebody not on the roster',
      isYou: userPersonId !== null && row.paidByPersonId === userPersonId,
    },
    shares,
    sharesUnknownReason:
      shares === null
        ? 'Nobody has been named as having benefited from this yet, so it cannot say who owes ' +
          'whom.'
        : null,
    obligationNote:
      shares === null
        ? null
        : shareObligationWords({
            relationshipType: row.relationshipType,
            payerIsUser: userPersonId !== null && row.paidByPersonId === userPersonId,
            payerName: names.get(row.paidByPersonId) ?? 'Somebody not on the roster',
          }),
    refunds: adjustments,
    state: row.state,
  };
}

async function toShares(
  db: Executor,
  allocationId: Parameters<typeof listAllocationLines>[1],
  names: Map<string, string>,
  userPersonId: PersonId | null,
): Promise<readonly ConnectionShare[]> {
  const lines = await listAllocationLines(db, allocationId);
  const groupLines = lines.filter((line) => line.beneficiaryType === 'group');
  const expansions =
    groupLines.length === 0
      ? []
      : await listGroupExpansions(
          db,
          groupLines.map((line) => line.id),
        );

  const groupNames = new Map<string, string>();
  for (const line of groupLines) {
    const group = await getGroupById(db, asId<'group'>(line.beneficiaryId));
    if (group !== null) groupNames.set(line.beneficiaryId, group.name);
  }

  return lines.map((line) => {
    if (line.beneficiaryType === 'group') {
      return {
        name: groupNames.get(line.beneficiaryId) ?? 'A group',
        isYou: false,
        amount: line.amount,
        beneficiaryKind: 'group' as const,
        // Snapshotted as of the expense date by the approval that wrote them (ADR-0009). Read
        // back exactly as stored; a group is never a debtor, its members are.
        members: expansions
          .filter((expansion) => expansion.allocationLineId === line.id)
          .map((expansion) => ({
            name: names.get(expansion.personId) ?? 'Somebody not on the roster',
            amount: expansion.amount,
          })),
      };
    }
    return {
      name: names.get(line.beneficiaryId) ?? 'Somebody not on the roster',
      isYou: userPersonId !== null && line.beneficiaryId === userPersonId,
      amount: line.amount,
      beneficiaryKind: 'person' as const,
      members: null,
    };
  });
}

async function listAdjustmentsForExpense(
  db: Executor,
  expenseId: ExpenseId,
): Promise<readonly ConnectionRefund[]> {
  const rows = await listExpenseAdjustmentSummaries(db, expenseId);
  return rows.map((row) => ({
    adjustmentId: row.id,
    label: refundWords(row.kind),
    amount: row.amount,
    occurredAt: row.occurredAt,
  }));
}

/**
 * Whether a waiting question belongs to this event.
 *
 * Deliberately generous about documents: an unattached document whose proposals name this
 * payment is a question *about this event*, even though the document itself is not attached to
 * anything yet — that is precisely the question the connection view exists to put in front of
 * somebody.
 */
function questionIsAboutThisEvent(
  question: AttentionItem,
  paymentId: PaymentId,
  expenseIds: ReadonlySet<string>,
): boolean {
  const subject = question.subject;
  if (subject.kind === 'payment') return subject.paymentId === paymentId;
  if (subject.kind === 'payment_pair') {
    return subject.paymentId === paymentId || subject.otherPaymentId === paymentId;
  }
  if (subject.kind === 'expense') return expenseIds.has(subject.expenseId);

  const item = question.item;
  if (item === null || item.kind !== 'unmatched_evidence') return false;
  return (
    item.matchCandidates.some(
      (candidate) => candidate.paymentId === paymentId && candidate.status === 'proposed',
    ) || item.candidateMatches.some((candidate) => candidate.paymentId === paymentId)
  );
}
