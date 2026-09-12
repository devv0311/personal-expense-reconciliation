/**
 * Answering a typed question about the ledger — by running a validated plan over reads that
 * already exist, and quoting what they return (audit row 45, ADR-0057).
 *
 * **The model plans; the ledger answers.** `ai.planLedgerQuery` picks one member of
 * `domain.LEDGER_QUERY_KINDS` and its parameters. Everything after that is this module calling
 * `getCategorySpend`, `getBalance`, `listExpensePage` and their neighbours — the same functions
 * the matching screens call — and rendering what comes back. No figure in an answer was
 * computed here, and none was written by a model.
 *
 * Three properties, each structural rather than conventional:
 *
 *  - **It cannot write.** There is no `runAudited` in this file, no `AuditMeta` parameter, and
 *    no import of a mutating repository. "Asking changes nothing" is a property of the module
 *    graph, the same way "`src/ai` cannot reach `src/db`" is.
 *  - **It cannot run an arbitrary query.** The executor is a `switch` over a closed set. The
 *    only free text that reaches a database is `searchTerm`, into `listExpensePage`'s existing
 *    parameterised `search` filter.
 *  - **It says how it read the question.** Every answer leads with its interpretation and its
 *    period, so the worst failure available on this path — answering a different question than
 *    the one asked — is one the reader can see.
 *
 * Nothing is persisted. An answer is derived on demand from approved state, exactly as a proof
 * pack is (ADR-0047) — which also keeps raw questions off disk.
 */

import {
  listExpenseAdjustmentsInPeriod,
  listExpenseCategories,
  listPeople as dbListPeople,
} from '../db/index.js';
import type { Database, Executor } from '../db/index.js';
import {
  assertQueryPlanAnswerable,
  describeQueryInterpretation,
  formatMajorUnits,
  isNonAnsweringQueryKind,
  LEDGER_QUERY_CAPABILITIES,
  queryRequiresPerson,
  resolveQueryPeriod,
} from '../domain/index.js';
import type {
  ConfidenceLevel,
  LedgerAnswer,
  LedgerAnswerFigure,
  LedgerAnswerLink,
  LedgerAnswerRecord,
  LedgerQueryCapability,
  LedgerQueryPeriod,
  LedgerQueryPlan,
  Paise,
  PersonId,
} from '../domain/index.js';
import type { AiService, ModelAvailability, ModelInfo } from '../ai/index.js';

import {
  getCategorySpend,
  getMonthlySpend,
  getOutstandingBalances,
  getOwnSpend,
  getUnsettledPaidOnBehalf,
} from './analytics-service.js';
import { getBalance, listReconciliationRunHistory } from './balance-service.js';
import { ServiceError } from './errors.js';
import { listExpensePage } from './expense-ledger-service.js';
import { listPaymentsWorkspace } from './payment-workspace-service.js';
import { listSettlementRegisterEntries } from './settlement-service.js';
import { listAuditFindings } from './splitwise-audit-service.js';

/** A question is a sentence, not a document. */
const MAX_QUESTION_LENGTH = 500;

/* ========================================================================= capabilities */

export interface AskCapabilities {
  /** Whether a model is configured, and why not when it is not. */
  readonly model: ModelAvailability;
  readonly queries: readonly LedgerQueryCapability[];
  /** Display names a question can use. Names only — no ids, no figures. */
  readonly knownPeople: readonly string[];
  readonly knownCategories: readonly string[];
  /** Stated plainly on the surface, because it is the property that makes it safe. */
  readonly writes: false;
}

/**
 * What can be asked, and whether asking works at all.
 *
 * Read by the screen before it renders a question box: offering one over an unconfigured
 * provider is ADR-0050's rule read backwards, and every figure a question would report is
 * reachable from the screen that owns it regardless.
 */
export async function describeAskCapabilities(
  db: Executor,
  ai: AiService,
): Promise<AskCapabilities> {
  const [people, categories] = await Promise.all([dbListPeople(db), listExpenseCategories(db)]);
  return {
    model: ai.describeAvailability(),
    queries: LEDGER_QUERY_CAPABILITIES,
    knownPeople: people.map((person) => person.displayName),
    knownCategories: categories,
    writes: false,
  };
}

/* =============================================================================== asking */

export interface AskLedgerQuestionInput {
  readonly question: string;
  readonly userPersonId: PersonId;
  readonly ai: AiService;
  /** Injected so a test can ask "last month" and mean a fixed month. Defaults to now. */
  readonly now?: Date;
}

export interface AskLedgerQuestionResult {
  /** The question as asked, echoed so an answer is readable on its own. Never stored. */
  readonly question: string;
  /** The plan that ran, so the answer is checkable against what was actually asked for. */
  readonly plan: {
    readonly kind: string;
    readonly period: { readonly start: string; readonly end: string } | null;
    readonly personName: string | null;
    readonly category: string | null;
    readonly searchTerm: string | null;
    readonly limit: number;
    readonly clarification: string | null;
  };
  /**
   * How sure the model was of its *reading*, not of the figures.
   *
   * Nothing here is approved, so confidence lowers no bar (`invariants.md` #16 is about
   * consequential acts, and a read is not one). What it changes is what the answer says about
   * itself: a `low` or `unknown` reading is stated more prominently, with the clarification
   * path beside it.
   */
  readonly confidence: ConfidenceLevel;
  /** Provider, model and prompt version — returned with the answer, filed nowhere. */
  readonly modelInfo: ModelInfo;
  readonly answer: LedgerAnswer;
}

/**
 * Plans a question and answers it from the ledger's own reads.
 *
 * @throws ServiceError `LEDGER_QUESTION_UNAVAILABLE` when no model is configured or the
 *   provider could not be reached. Distinct from a question the ledger has no read for, which
 *   is an ordinary answer.
 * @throws AiContractError when the model's reply is not a query plan (gate 1).
 * @throws DomainError `LEDGER_QUERY_PLAN_INVALID` when it parses but cannot be answered.
 */
export async function answerLedgerQuestion(
  db: Database,
  input: AskLedgerQuestionInput,
): Promise<AskLedgerQuestionResult> {
  const question = input.question.trim();
  if (question.length === 0) {
    throw new ServiceError('PRECONDITION_FAILED', 'Ask something.', { field: 'question' });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `A question is at most ${MAX_QUESTION_LENGTH} characters. Longer than that is a document, ` +
        'and this surface answers questions.',
      { field: 'question' },
    );
  }

  const availability = input.ai.describeAvailability();
  if (!availability.configured) {
    throw new ServiceError(
      'LEDGER_QUESTION_UNAVAILABLE',
      availability.unavailableReason ??
        'No model is configured, so a question cannot be turned into a plan.',
    );
  }

  const now = input.now ?? new Date();
  const [people, categories] = await Promise.all([dbListPeople(db), listExpenseCategories(db)]);

  let inference;
  try {
    inference = await input.ai.planLedgerQuery({
      question,
      today: now,
      capabilities: LEDGER_QUERY_CAPABILITIES.map((entry) => ({
        kind: entry.kind,
        answers: entry.answers,
        example: entry.example,
        needsPeriod: entry.needsPeriod,
        needsPerson: entry.needsPerson,
      })),
      knownPeople: people.map((person) => person.displayName),
      knownCategories: categories,
    });
  } catch (error) {
    // A contract breach and a sanitization refusal are both the boundary working, and both
    // belong to their own error types — they propagate. Anything else is the provider being
    // unreachable, which is a fact about the environment rather than about the question.
    if (error instanceof Error && error.name !== 'Error') throw error;
    throw new ServiceError(
      'LEDGER_QUESTION_UNAVAILABLE',
      `The question could not be planned: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const proposal = inference.proposedOutput;
  const plan: LedgerQueryPlan = {
    kind: proposal.kind,
    period: proposal.period,
    personName: proposal.personName,
    category: proposal.category,
    searchTerm: proposal.searchTerm,
    limit: proposal.limit,
    clarification: proposal.clarification,
  };
  // Gate 2: what the contract parser cannot see.
  assertQueryPlanAnswerable(plan);

  const answer = await executePlan(db, {
    plan,
    userPersonId: input.userPersonId,
    people,
    now,
    confidence: inference.confidence,
  });

  return {
    question,
    plan: {
      kind: plan.kind,
      period:
        plan.period === null
          ? null
          : { start: plan.period.start.toISOString(), end: plan.period.end.toISOString() },
      personName: plan.personName,
      category: plan.category,
      searchTerm: plan.searchTerm,
      limit: plan.limit,
      clarification: plan.clarification,
    },
    confidence: inference.confidence,
    modelInfo: inference.modelInfo,
    answer,
  };
}

/* ============================================================================ execution */

interface ExecutionContext {
  readonly plan: LedgerQueryPlan;
  readonly userPersonId: PersonId;
  readonly people: Awaited<ReturnType<typeof dbListPeople>>;
  readonly now: Date;
  readonly confidence: ConfidenceLevel;
}

/**
 * The one place that decides which read answers which question.
 *
 * A `switch` on purpose, and exhaustive on purpose: adding a query means adding a branch here,
 * which is a diff somebody reviews. There is no registry a model contributes to and no dynamic
 * dispatch — the set of things a question can reach is the set of cases below.
 */
async function executePlan(db: Database, context: ExecutionContext): Promise<LedgerAnswer> {
  const { plan } = context;

  // Narrowed here so the switch below covers exactly the answering kinds, and adding one is a
  // compile error rather than a silent fall-through.
  if (isNonAnsweringQueryKind(plan.kind)) return declineAnswer(context);

  const { period, assumed } = resolveQueryPeriod(plan, context.now);
  const person = queryRequiresPerson(plan.kind) ? resolvePerson(context) : null;
  if (person !== null && person.resolved === null) {
    return ambiguousPersonAnswer(context, person.candidates);
  }
  const resolvedPersonLabel = person?.resolved?.displayName ?? null;
  const interpretation = describeQueryInterpretation({
    plan,
    period,
    periodAssumed: assumed,
    resolvedPersonLabel,
  });
  const base = {
    kind: plan.kind,
    answered: true as const,
    interpretation,
    period: periodStrings(period),
  };

  switch (plan.kind) {
    case 'spend_by_category': {
      const result = await getCategorySpend(db, requirePeriod(period));
      const named =
        plan.category === null
          ? null
          : (result.categories.find(
              (entry) => (entry.category ?? '').toLowerCase() === plan.category?.toLowerCase(),
            ) ?? null);
      return {
        ...base,
        headline:
          named === null
            ? `${rupees(result.netTotal)} across ${result.categories.length} categories.`
            : `${rupees(named.netTotal)} on ${named.category ?? 'uncategorised'}.`,
        scope: 'every approved expense in the period, whoever ultimately benefited',
        source: 'services.getCategorySpend',
        figures: [
          amountFigure('Total (net of refunds)', result.netTotal),
          ...result.categories
            .slice(0, plan.limit)
            .map((entry) =>
              amountFigure(entry.category ?? 'Uncategorised', entry.netTotal, entry.expenseCount),
            ),
        ],
        records: [],
        caveats: [...result.caveats.excludes],
        uncertainties: pendingRefundUncertainties(result.caveats.pendingRefundExpenseIds),
        links: [{ label: 'Analytics', href: '/analytics' }],
      };
    }

    case 'spend_by_month': {
      const result = await getMonthlySpend(db, requirePeriod(period));
      return {
        ...base,
        headline: `Spending across ${result.months.length} months, month by month.`,
        scope: 'every approved expense in the period, by calendar month in UTC',
        source: 'services.getMonthlySpend',
        figures: [
          ...result.months
            .slice(0, plan.limit)
            .map((month) => amountFigure(month.month, month.netTotal, month.expenseCount)),
        ],
        records: [],
        caveats: [...result.caveats.excludes],
        uncertainties: pendingRefundUncertainties(result.caveats.pendingRefundExpenseIds),
        links: [{ label: 'Analytics', href: '/analytics' }],
      };
    }

    case 'own_spend': {
      const result = await getOwnSpend(db, context.userPersonId, requirePeriod(period));
      return {
        ...base,
        headline: `Your own share came to ${rupees(result.ownShare)}.`,
        scope: 'your share of every approved expense in the period, after every recorded refund',
        source: 'services.getOwnSpend',
        figures: [
          amountFigure('Your own share', result.ownShare),
          amountFigure('What you paid out', result.paidByUser),
          amountFigure('Fronted for other people, before repayments', result.frontedForOthers),
        ],
        records: [],
        caveats: [...result.caveats.excludes],
        uncertainties: pendingRefundUncertainties(result.caveats.pendingRefundExpenseIds),
        links: [{ label: 'Analytics', href: '/analytics' }],
      };
    }

    case 'outstanding_balances': {
      const result = await getOutstandingBalances(db, context.userPersonId);
      return {
        ...base,
        headline:
          result.counterparties.length === 0
            ? 'No open balances: every counterparty nets to exactly zero.'
            : `${result.counterparties.length} people have an open balance with you.`,
        scope: 'every person with a non-zero balance, in both directions',
        source: 'services.getOutstandingBalances',
        figures: [
          amountFigure('Owed to you', result.totalOwedToUser),
          amountFigure('You owe', result.totalOwedByUser),
        ],
        records: result.counterparties.slice(0, plan.limit).map((entry) => ({
          type: 'person' as const,
          id: entry.personId,
          label: entry.displayName,
          amount: entry.netBalance.toString(),
          occurredAt: null,
        })),
        caveats: [...result.caveats.excludes],
        uncertainties: [],
        links: [{ label: 'Balances', href: '/balances' }],
      };
    }

    case 'unsettled_paid_on_behalf': {
      const result = await getUnsettledPaidOnBehalf(db, context.userPersonId);
      return {
        ...base,
        headline: `${rupees(result.totalOwedToUser)} is outstanding across ${result.expenses.length} expenses.`,
        scope: 'expenses you paid for that somebody else still has a share of, per expense',
        source: 'services.getUnsettledPaidOnBehalf',
        figures: [amountFigure('Still owed to you', result.totalOwedToUser)],
        records: result.expenses.slice(0, plan.limit).map((entry) => ({
          type: 'expense' as const,
          id: entry.expenseId,
          label: entry.description ?? 'No description',
          amount: entry.owedToUser.toString(),
          occurredAt: entry.occurredAt.toISOString(),
        })),
        caveats: [
          ...result.caveats.excludes,
          'A settlement discharges a balance, not one particular expense (ADR-0007), so this ' +
            'says what each expense contributed rather than which ones were repaid.',
        ],
        uncertainties: pendingRefundUncertainties(result.caveats.pendingRefundExpenseIds),
        links: [{ label: 'Balances', href: '/balances' }],
      };
    }

    case 'pair_balance': {
      const other = person?.resolved;
      if (other === undefined || other === null) return ambiguousPersonAnswer(context, []);
      const result = await getBalance(db, context.userPersonId, context.userPersonId, other.id);
      const direction =
        result.netBalance > 0n
          ? `You owe ${other.displayName}`
          : result.netBalance < 0n
            ? `${other.displayName} owes you`
            : `You and ${other.displayName} are square`;
      return {
        ...base,
        headline: `${direction}: ${rupees(absolute(result.netBalance))}.`,
        scope: `every obligation between you and ${other.displayName}, net of recorded repayments`,
        source: 'services.getBalance',
        figures: [
          amountFigure('Net balance (positive: you owe them)', result.netBalance),
          countFigure('Contributing obligations', result.contributions.length),
          countFigure('Repayments netted in', result.settlements.length),
          {
            label: 'Evidence of discharge',
            amount: null,
            count: null,
            note: result.evidenceStatus,
          },
        ],
        records: result.contributions.slice(0, plan.limit).map((entry) => ({
          type: 'expense' as const,
          id: entry.expenseId,
          label:
            entry.debtorId === context.userPersonId
              ? `You owe ${other.displayName} a share of this expense`
              : `${other.displayName} owes you a share of this expense`,
          amount: entry.amount.toString(),
          occurredAt: null,
        })),
        caveats: [],
        uncertainties: pendingRefundUncertainties(result.pendingRefundExpenseIds),
        links: [{ label: 'Balance detail', href: `/balances?with=${other.id}` }],
      };
    }

    case 'expense_search': {
      const resolvedFilterPerson = resolvePerson(context).resolved;
      const result = await listExpensePage(db, {
        ...(plan.searchTerm === null ? {} : { search: plan.searchTerm }),
        ...(plan.category === null ? {} : { category: plan.category }),
        ...(period === null ? {} : { occurredFrom: period.start, occurredTo: period.end }),
        ...(resolvedFilterPerson === null ? {} : { beneficiaryPersonId: resolvedFilterPerson.id }),
        limit: plan.limit,
      });
      return {
        ...base,
        interpretation:
          resolvedFilterPerson === null
            ? base.interpretation
            : describeQueryInterpretation({
                plan,
                period,
                periodAssumed: assumed,
                resolvedPersonLabel: resolvedFilterPerson.displayName,
              }),
        headline:
          result.total === 0
            ? 'No expenses match that.'
            : `${result.total} expenses match; showing ${result.expenses.length}.`,
        scope: 'the expense ledger, filtered server-side across every row rather than a page',
        source: 'services.listExpensePage',
        figures: [countFigure('Matching expenses in the whole ledger', result.total)],
        records: result.expenses.map((expense) => ({
          type: 'expense' as const,
          id: expense.id,
          label: expense.description ?? 'No description',
          amount: expense.netAmount.toString(),
          occurredAt: expense.occurredAt.toISOString(),
        })),
        caveats: ['Amounts are net of every recorded adjustment, never the gross figure.'],
        uncertainties:
          result.total > result.expenses.length
            ? [`${result.total - result.expenses.length} further matches were not listed.`]
            : [],
        links: [{ label: 'Expenses', href: '/expenses' }],
      };
    }

    case 'refunds_in_period': {
      const rows = await listExpenseAdjustmentsInPeriod(db, requirePeriod(period), {
        limit: plan.limit,
      });
      const pending = rows.filter((row) => row.reversedAt === null && !row.distributed);
      return {
        ...base,
        headline:
          rows.length === 0
            ? 'No refunds or reimbursements were recorded in that period.'
            : `${rows.length} adjustments were recorded.`,
        scope: 'refunds and third-party reimbursements recorded against expenses in the period',
        source: 'services.listExpenseAdjustmentsInPeriod',
        figures: [countFigure('Adjustments recorded', rows.length)],
        records: rows.map((row) => ({
          type: 'adjustment' as const,
          id: row.adjustmentId,
          label:
            `${row.kind === 'merchant_refund' ? 'Refund' : 'Reimbursement'} on ` +
            `${row.expenseDescription ?? 'an expense'}` +
            (row.reversedAt === null ? '' : ' (reversed)'),
          amount: row.amount.toString(),
          occurredAt: row.occurredAt.toISOString(),
        })),
        caveats: [
          'Reversed adjustments are listed and marked rather than hidden — a ledger that hid ' +
            'its corrections would be rewriting its past (invariants.md #22).',
        ],
        uncertainties:
          pending.length === 0
            ? []
            : [
                `${pending.length} of these have no allocation reflecting them yet, so the ` +
                  'affected balances are about to move.',
              ],
        links: [{ label: 'Expenses', href: '/expenses' }],
      };
    }

    case 'settlements': {
      const counterparty = resolvePerson(context).resolved;
      const result = await listSettlementRegisterEntries(db, {
        ...(counterparty === null ? {} : { counterpartyPersonId: counterparty.id }),
        limit: plan.limit,
      });
      return {
        ...base,
        headline:
          result.total === 0
            ? 'No repayments are on record.'
            : `${result.total} repayments are on record; showing ${result.settlements.length}.`,
        scope:
          counterparty === null
            ? 'every recorded repayment, newest first'
            : `every recorded repayment with ${counterparty.displayName}`,
        source: 'services.listSettlementRegisterEntries',
        figures: [countFigure('Repayments on record', result.total)],
        records: result.settlements.map((entry) => ({
          type: 'settlement' as const,
          id: entry.id,
          label: `${entry.counterpartyName}${entry.reason === null ? '' : ` — ${entry.reason}`}`,
          amount: entry.amount.toString(),
          occurredAt: entry.occurredAt.toISOString(),
        })),
        caveats: [
          'A settlement discharges a debt; it is never spending, and never carries its own ' +
            'allocation (invariants.md #9).',
        ],
        uncertainties: [],
        links: [{ label: 'Balances', href: '/balances' }],
      };
    }

    case 'reconciliation_status': {
      const runs = await listReconciliationRunHistory(db, { limit: 1 });
      const latest = runs[0];
      if (latest === undefined) {
        return {
          ...base,
          headline: 'No reconciliation has been run yet.',
          scope: 'reconciliation history',
          source: 'services.listReconciliationRunHistory',
          figures: [],
          records: [],
          caveats: [],
          uncertainties: [
            'Nothing has been reconciled, so no period has been verified — which is not the ' +
              'same as a period coming out clean.',
          ],
          links: [{ label: 'Reconciliation', href: '/reconciliation' }],
        };
      }
      return {
        ...base,
        headline:
          `The last run covered ${latest.periodStart.toISOString().slice(0, 10)} to ` +
          `${latest.periodEnd.toISOString().slice(0, 10)} and left ` +
          `${rupees(latest.totals.ledgerUnexplainedTotal)} unexplained.`,
        scope: 'the most recent reconciliation run',
        source: 'services.listReconciliationRunHistory',
        figures: [
          amountFigure('Total outflow', latest.totals.ledgerTotalOutflow),
          amountFigure('Explained', latest.totals.ledgerExplainedTotal),
          amountFigure('Transfers', latest.totals.ledgerTransfersTotal),
          amountFigure('Investments', latest.totals.ledgerInvestmentsTotal),
          amountFigure('Settlements', latest.totals.ledgerSettlementsTotal),
          amountFigure('Unexplained', latest.totals.ledgerUnexplainedTotal),
        ],
        records: [
          {
            type: 'run' as const,
            id: latest.id,
            label: 'Reconciliation run',
            amount: latest.totals.ledgerUnexplainedTotal.toString(),
            occurredAt: latest.runAt.toISOString(),
          },
        ],
        caveats: [
          'Arithmetic closure alone is not a verified zero: a verified ₹0 needs complete ' +
            'evidence and zero unexplained movements as well (CLAUDE.md, pillar 3).',
        ],
        uncertainties:
          latest.totals.ledgerUnexplainedTotal === 0n
            ? []
            : ['This period has money the ledger cannot yet account for.'],
        links: [{ label: 'Reconciliation', href: `/reconciliation/${latest.id}` }],
      };
    }

    case 'unexplained_money': {
      const result = await listPaymentsWorkspace(db, { onlyUnexplained: true, limit: plan.limit });
      return {
        ...base,
        headline:
          result.payments.length === 0
            ? 'Every movement on this page is accounted for.'
            : `${result.filteredTotalIsExact ? '' : 'at least '}${result.total} movements are not yet explained.`,
        scope: 'posted movements the ledger cannot yet account for',
        source: 'services.listPaymentsWorkspace',
        figures: [countFigure('Unexplained movements', result.total)],
        records: result.payments.map((payment) => ({
          type: 'payment' as const,
          id: payment.id,
          label: payment.rawDescription,
          amount: payment.unexplainedTotal.toString(),
          occurredAt: payment.occurredAt.toISOString(),
        })),
        caveats: [
          'Unexplained money is a first-class figure here, not a rounding error to hide ' +
            '(CLAUDE.md, principle 10).',
        ],
        uncertainties: result.filteredTotalIsExact
          ? []
          : ['The count is a lower bound: filtering narrowed the page after it was taken.'],
        links: [{ label: 'Unexplained payments', href: '/payments?onlyUnexplained=true' }],
      };
    }

    case 'splitwise_state': {
      const findings = await listAuditFindings(db, { reviewStatus: 'open', limit: plan.limit });
      const incomplete = findings.filter((finding) => finding.findingClass === 'incomplete');
      return {
        ...base,
        headline:
          findings.length === 0
            ? 'No open Splitwise audit findings.'
            : `${findings.length} open findings between this ledger and Splitwise.`,
        scope: 'open findings from the most recent Splitwise audits',
        source: 'services.listAuditFindings',
        figures: [
          countFigure('Open findings', findings.length),
          countFigure('Of those, incomplete checks rather than disagreements', incomplete.length),
        ],
        records: findings.map((finding) => ({
          type: 'finding' as const,
          id: finding.id,
          label: finding.summary,
          amount: finding.amount === null ? null : finding.amount.toString(),
          occurredAt: finding.firstObservedAt.toISOString(),
        })),
        caveats: [
          'A pair-level mismatch is a signal, never proof that one particular expense is wrong ' +
            '(ADR-0046).',
        ],
        uncertainties:
          incomplete.length === 0
            ? []
            : [
                'Some of these are checks that could not be completed. An incomplete check is ' +
                  'not agreement.',
              ],
        links: [{ label: 'Splitwise audit', href: '/splitwise' }],
      };
    }
  }
}

/* --------------------------------------------------------------------- the non-answers */

/**
 * The three honest ways to decline, each stating no figure.
 *
 * A refusal is an answer this surface gives happily. What it must never do is produce a
 * confident sentence about a question it could not read.
 */
function declineAnswer(context: ExecutionContext): LedgerAnswer {
  const { plan } = context;
  const menu = LEDGER_QUERY_CAPABILITIES.map((entry) => `• ${entry.example}`);

  if (plan.kind === 'unsupported_write_request') {
    return {
      kind: plan.kind,
      answered: false,
      interpretation: 'read as: an instruction to change something',
      headline: 'This surface only reads. It cannot record, approve, settle or delete anything.',
      period: null,
      scope: 'nothing was read and nothing was changed',
      source: null,
      figures: [],
      records: [],
      caveats: [],
      uncertainties: [
        plan.clarification ??
          'Every consequential act in this product happens on the screen that owns it, behind ' +
            'a dialog that states its consequence.',
      ],
      links: [
        { label: 'Payments', href: '/payments' },
        { label: 'Expenses', href: '/expenses' },
        { label: 'Balances', href: '/balances' },
      ],
    };
  }

  const ambiguous = plan.kind === 'ambiguous_question';
  return {
    kind: plan.kind,
    answered: false,
    interpretation: ambiguous
      ? 'read as: a question this ledger could answer, once it is narrowed'
      : 'read as: a question no read here answers',
    headline: ambiguous
      ? (plan.clarification ?? 'That could mean more than one thing.')
      : 'The ledger has no read that answers that.',
    period: null,
    scope: 'nothing was read',
    source: null,
    figures: [],
    records: [],
    caveats: [],
    uncertainties: [
      ...(plan.clarification === null || !ambiguous ? [] : [plan.clarification]),
      'What can be asked:',
      ...menu,
    ],
    links: [{ label: 'Analytics', href: '/analytics' }],
  };
}

function ambiguousPersonAnswer(
  context: ExecutionContext,
  candidates: readonly { readonly id: PersonId; readonly displayName: string }[],
): LedgerAnswer {
  const named = context.plan.personName ?? 'that person';
  return {
    kind: 'ambiguous_question',
    answered: false,
    interpretation: `read as: a question about ${named}, whom this ledger could not pin down`,
    headline:
      candidates.length === 0
        ? `Nobody in this ledger is called “${named}”.`
        : `More than one person matches “${named}”.`,
    period: null,
    scope: 'nothing was read — naming the wrong person would answer about the wrong debt',
    source: null,
    figures: [],
    records: candidates.map((candidate) => ({
      type: 'person' as const,
      id: candidate.id,
      label: candidate.displayName,
      amount: null,
      occurredAt: null,
    })),
    caveats: [],
    uncertainties: [
      candidates.length === 0
        ? 'Add them under Setup, or ask again using the name as it appears in your roster.'
        : 'Ask again using the exact name.',
    ],
    links: [{ label: 'People', href: '/setup' }],
  };
}

/* ------------------------------------------------------------------------- internals */

/**
 * Matches the name the question used against the roster.
 *
 * In `src/services` rather than in the model, deliberately: a model choosing a `PersonId` is a
 * model deciding whose balance to show. An exact case-insensitive match wins; otherwise a
 * unique prefix match; otherwise the candidates come back and the answer asks.
 */
function resolvePerson(context: ExecutionContext): {
  readonly resolved: { readonly id: PersonId; readonly displayName: string } | null;
  readonly candidates: readonly { readonly id: PersonId; readonly displayName: string }[];
} {
  const name = context.plan.personName?.trim().toLowerCase();
  if (name === undefined || name.length === 0) return { resolved: null, candidates: [] };

  const others = context.people.filter((person) => person.id !== context.userPersonId);
  const exact = others.filter((person) => person.displayName.toLowerCase() === name);
  if (exact.length === 1) {
    return { resolved: { id: exact[0]!.id, displayName: exact[0]!.displayName }, candidates: [] };
  }

  const partial = others.filter((person) => person.displayName.toLowerCase().includes(name));
  if (partial.length === 1) {
    return {
      resolved: { id: partial[0]!.id, displayName: partial[0]!.displayName },
      candidates: [],
    };
  }
  return {
    resolved: null,
    candidates: partial.map((person) => ({ id: person.id, displayName: person.displayName })),
  };
}

function requirePeriod(period: LedgerQueryPeriod | null): LedgerQueryPeriod {
  if (period === null) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'This question needs a period and none could be resolved.',
    );
  }
  return period;
}

function periodStrings(
  period: LedgerQueryPeriod | null,
): { readonly start: string; readonly end: string } | null {
  return period === null
    ? null
    : { start: period.start.toISOString(), end: period.end.toISOString() };
}

/** Money crosses this boundary as exact minor units, never a number and never formatted. */
function amountFigure(label: string, amount: bigint, count?: number): LedgerAnswerFigure {
  return {
    label,
    amount: amount.toString(),
    count: count ?? null,
    note: null,
  };
}

function countFigure(label: string, count: number): LedgerAnswerFigure {
  return { label, amount: null, count, note: null };
}

/**
 * An exact major-unit rendering for the one sentence a person reads first.
 *
 * `domain.formatMajorUnits` rather than anything local: this is the same exact `bigint`
 * rendering every other display of money in the system goes through, and a second one here
 * would be a second place for a rounding question to be answered (`invariants.md` #12).
 */
function rupees(value: bigint): string {
  return `₹${formatMajorUnits(value as Paise)}`;
}

function absolute(value: bigint): Paise {
  return (value < 0n ? -value : value) as Paise;
}

function pendingRefundUncertainties(expenseIds: readonly string[]): readonly string[] {
  return expenseIds.length === 0
    ? []
    : [
        `${expenseIds.length} contributing expenses have a recorded refund that no allocation ` +
          'reflects yet, so these figures are about to move.',
      ];
}

/** Re-exported so `src/api` depends on this layer alone for the answer's shape. */
export type { LedgerAnswer, LedgerAnswerFigure, LedgerAnswerLink, LedgerAnswerRecord };
