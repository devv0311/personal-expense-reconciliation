/**
 * The vocabulary a natural-language question is allowed to become (ADR-0057).
 *
 * This module is the reason an "ask your ledger" box is safe to have at all. A question does
 * not become a database query, a tool call, or a sentence a model wrote — it becomes one member
 * of {@link LEDGER_QUERY_KINDS} with typed parameters, and the service answers it by calling a
 * read that already exists and quoting what comes back.
 *
 * Three properties are structural rather than conventional:
 *
 *  - **There is no free-text query field.** No SQL, no table name, no column, no filter
 *    expression. `searchTerm` reaches `listExpensePage`'s existing parameterised `search` and
 *    nothing else, so the widest thing a model can ask for is a substring of a description.
 *  - **The kind set is closed.** Adding a query means writing a branch in the executor,
 *    reviewing it, and testing it. A model naming a kind that is not here is rejected by the
 *    contract parser before `src/services` is handed anything.
 *  - **Nothing here computes money.** Not one function in this file adds, divides or nets. It
 *    decides *which* already-derived figure answers the question; the figure itself is the
 *    ledger's own, produced by the same call the matching screen makes (ADR-0048's rule,
 *    applied to a surface that is not the browser).
 */

import { DomainError } from './errors.js';

/* ======================================================================== the vocabulary */

/**
 * Every question this ledger can answer, and the three ways it can honestly decline.
 *
 * Each answering kind names exactly one authoritative read. The mapping is in
 * `services.answerLedgerQuestion` and is a `switch`, so "which read answers this" is one
 * readable table rather than a dispatch a model participates in.
 */
export const LEDGER_QUERY_KINDS = [
  /* --- analytics (services/analytics-service.ts) --- */
  /** Spending by category for a period — `getCategorySpend`. */
  'spend_by_category',
  /** The month-by-month trend — `getMonthlySpend`. */
  'spend_by_month',
  /** What the user's own share came to — `getOwnSpend`. */
  'own_spend',
  /** Every open balance at once — `getOutstandingBalances`. */
  'outstanding_balances',
  /** Everything paid on behalf and still owed — `getUnsettledPaidOnBehalf`. */
  'unsettled_paid_on_behalf',
  /* --- balances and the ledger --- */
  /** One pair's balance, in either direction — `getBalance`. */
  'pair_balance',
  /** Expenses matching a filter — `listExpensePage`. */
  'expense_search',
  /** Refunds and reimbursements recorded in a period — `listExpenseAdjustmentsInPeriod`. */
  'refunds_in_period',
  /** Repayments on record — `listSettlementRegisterEntries`. */
  'settlements',
  /* --- reconciliation --- */
  /** The latest reconciliation run and its residuals — `listReconciliationRunHistory`. */
  'reconciliation_status',
  /** Movements the ledger cannot yet account for — `listPaymentsWorkspace`. */
  'unexplained_money',
  /* --- Splitwise --- */
  /** Open audit findings and the last read's completeness — `listAuditFindings`. */
  'splitwise_state',
  /* --- the three honest non-answers --- */
  /** No read answers this. The response lists what can be asked. */
  'unsupported_question',
  /** Answerable but underdetermined — a name matching nobody or several people, say. */
  'ambiguous_question',
  /** An instruction, not a question. This surface never writes (ADR-0057). */
  'unsupported_write_request',
] as const;
export type LedgerQueryKind = (typeof LEDGER_QUERY_KINDS)[number];

/** The three kinds that state no figure, because they are declining rather than answering. */
export const NON_ANSWERING_QUERY_KINDS = [
  'unsupported_question',
  'ambiguous_question',
  'unsupported_write_request',
] as const;
export type NonAnsweringQueryKind = (typeof NON_ANSWERING_QUERY_KINDS)[number];

export function isNonAnsweringQueryKind(kind: LedgerQueryKind): kind is NonAnsweringQueryKind {
  return (NON_ANSWERING_QUERY_KINDS as readonly string[]).includes(kind);
}

/** The largest page any question may ask for. A question is not a bulk export. */
export const MAX_LEDGER_QUERY_LIMIT = 50;
export const DEFAULT_LEDGER_QUERY_LIMIT = 20;

/* ============================================================================== the plan */

/** A period, in this system's usual convention: inclusive start, exclusive end. */
export interface LedgerQueryPeriod {
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
}

/**
 * One validated query plan.
 *
 * Flat rather than a discriminated union, because the parameters are genuinely optional per
 * kind and a union of thirteen shapes would be harder to read than the four guards below. What
 * keeps it honest is that every field is typed, bounded and inert: there is nothing here a
 * model could put a query into.
 */
export interface LedgerQueryPlan {
  readonly kind: LedgerQueryKind;
  /** `null` when the question is not period-scoped, or when the model named no period. */
  readonly period: LedgerQueryPeriod | null;
  /**
   * A person as the question named them — a display name, never an id.
   *
   * Resolution against the roster happens in `src/services`. A model choosing a `PersonId`
   * would be a model deciding whose balance to show, which is exactly the decision this
   * surface must not delegate.
   */
  readonly personName: string | null;
  readonly category: string | null;
  /** Handed to `listExpensePage`'s existing parameterised `search`. Nothing else reads it. */
  readonly searchTerm: string | null;
  readonly limit: number;
  /** What the model could not settle, for the three non-answering kinds. */
  readonly clarification: string | null;
}

/** Kinds whose answer is meaningless without a period, so one is resolved before answering. */
export function queryRequiresPeriod(kind: LedgerQueryKind): boolean {
  return (
    kind === 'spend_by_category' ||
    kind === 'spend_by_month' ||
    kind === 'own_spend' ||
    kind === 'refunds_in_period'
  );
}

/** Kinds that cannot be answered without knowing who the other person is. */
export function queryRequiresPerson(kind: LedgerQueryKind): boolean {
  return kind === 'pair_balance';
}

/**
 * Gate 2 for a query plan: what a schema cannot see.
 *
 * The contract parser (`ai/contract.ts`) has already refused anything that is not the shape.
 * This refuses a well-formed plan that cannot be answered — a period that ends before it
 * starts, a limit outside the bound, a declining kind carrying parameters it has no business
 * carrying.
 *
 * @throws DomainError `LEDGER_QUERY_PLAN_INVALID`
 */
export function assertQueryPlanAnswerable(plan: LedgerQueryPlan): void {
  if (plan.limit < 1 || plan.limit > MAX_LEDGER_QUERY_LIMIT) {
    throw new DomainError(
      'LEDGER_QUERY_PLAN_INVALID',
      `A question may ask for between 1 and ${MAX_LEDGER_QUERY_LIMIT} rows; this plan asked ` +
        `for ${plan.limit}.`,
      { field: 'limit' },
    );
  }
  if (plan.period !== null && plan.period.end.getTime() <= plan.period.start.getTime()) {
    throw new DomainError(
      'LEDGER_QUERY_PLAN_INVALID',
      'A period ends after it starts. This plan named one that does not.',
      { field: 'period' },
    );
  }
  if (isNonAnsweringQueryKind(plan.kind)) {
    if (plan.period !== null || plan.personName !== null || plan.searchTerm !== null) {
      throw new DomainError(
        'LEDGER_QUERY_PLAN_INVALID',
        'A plan that declines to answer carries no query parameters — it is a refusal, not a ' +
          'half-formed read.',
        { field: 'kind' },
      );
    }
    return;
  }
  if (plan.clarification !== null) {
    throw new DomainError(
      'LEDGER_QUERY_PLAN_INVALID',
      'Only a declining plan carries a clarification. An answering one states its ' +
        'interpretation instead.',
      { field: 'clarification' },
    );
  }
}

/**
 * The period an answer will actually be scoped to, and whether it was assumed.
 *
 * A question like "what did I spend on food" names no period. Silently picking one and stating
 * nothing would be the failure this whole surface exists to avoid, so the default is picked
 * here, returned with `assumed: true`, and said out loud in the interpretation line.
 */
export function resolveQueryPeriod(
  plan: LedgerQueryPlan,
  now: Date,
): { readonly period: LedgerQueryPeriod | null; readonly assumed: boolean } {
  if (plan.period !== null) return { period: plan.period, assumed: false };
  if (!queryRequiresPeriod(plan.kind)) return { period: null, assumed: false };

  // The current calendar month in UTC — the same instant boundary every period in this system
  // uses, so an answer and the analytics screen beside it scope identically.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { period: { start, end }, assumed: true };
}

/* ========================================================================= the catalogue */

/** One thing a person can ask, as both the model's menu and the screen's. */
export interface LedgerQueryCapability {
  readonly kind: LedgerQueryKind;
  /** What it answers, in one line. */
  readonly answers: string;
  /** A question that lands on it, for a screen to offer and a prompt to illustrate. */
  readonly example: string;
  readonly needsPeriod: boolean;
  readonly needsPerson: boolean;
  /** The authoritative read that produces every figure in the answer. */
  readonly source: string;
}

/**
 * Everything this surface can answer.
 *
 * Sent to the model as its menu, and rendered by the screen so a dead end is also a list of
 * what would have worked. It carries no figures, no ids and no names — the questions, not the
 * answers.
 */
export const LEDGER_QUERY_CAPABILITIES: readonly LedgerQueryCapability[] = [
  {
    kind: 'spend_by_category',
    answers: 'approved spending in a period, broken down by category',
    example: 'What did I spend on groceries last month?',
    needsPeriod: true,
    needsPerson: false,
    source: 'services.getCategorySpend',
  },
  {
    kind: 'spend_by_month',
    answers: 'the month-by-month spending trend across a period',
    example: 'How has my spending moved over the last six months?',
    needsPeriod: true,
    needsPerson: false,
    source: 'services.getMonthlySpend',
  },
  {
    kind: 'own_spend',
    answers: 'the user’s own share of a period’s spending, as distinct from what they fronted',
    example: 'What did I actually spend in August?',
    needsPeriod: true,
    needsPerson: false,
    source: 'services.getOwnSpend',
  },
  {
    kind: 'outstanding_balances',
    answers: 'every open balance at once, in both directions',
    example: 'Who owes me money?',
    needsPeriod: false,
    needsPerson: false,
    source: 'services.getOutstandingBalances',
  },
  {
    kind: 'unsettled_paid_on_behalf',
    answers: 'expenses the user paid for that somebody else still has a share of',
    example: 'What have I paid for that nobody has paid me back for?',
    needsPeriod: false,
    needsPerson: false,
    source: 'services.getUnsettledPaidOnBehalf',
  },
  {
    kind: 'pair_balance',
    answers: 'the balance with one person, its contributions and the repayments netted into it',
    example: 'How much does Priya owe me?',
    needsPeriod: false,
    needsPerson: true,
    source: 'services.getBalance',
  },
  {
    kind: 'expense_search',
    answers: 'expenses matching a description, category, person or period',
    example: 'Show me the dinners in July.',
    needsPeriod: false,
    needsPerson: false,
    source: 'services.listExpensePage',
  },
  {
    kind: 'refunds_in_period',
    answers: 'refunds and reimbursements recorded in a period, and whether each is distributed',
    example: 'What refunds came through last month?',
    needsPeriod: true,
    needsPerson: false,
    source: 'services.listExpenseAdjustmentsInPeriod',
  },
  {
    kind: 'settlements',
    answers: 'repayments on record, optionally with one person',
    example: 'When did Arjun last pay me back?',
    needsPeriod: false,
    needsPerson: false,
    source: 'services.listSettlementRegisterEntries',
  },
  {
    kind: 'reconciliation_status',
    answers: 'the most recent reconciliation run, its residuals and what it could not verify',
    example: 'Did last month’s reconciliation come out clean?',
    needsPeriod: false,
    needsPerson: false,
    source: 'services.listReconciliationRunHistory',
  },
  {
    kind: 'unexplained_money',
    answers: 'movements the ledger cannot yet account for',
    example: 'What money is still unexplained?',
    needsPeriod: false,
    needsPerson: false,
    source: 'services.listPaymentsWorkspace',
  },
  {
    kind: 'splitwise_state',
    answers: 'open Splitwise audit findings, and how complete the last external read was',
    example: 'Is anything wrong between my ledger and Splitwise?',
    needsPeriod: false,
    needsPerson: false,
    source: 'services.listAuditFindings',
  },
];

/* ========================================================================== the answer */

/** One figure in an answer, quoted from a read. Money is exact minor units as a string. */
export interface LedgerAnswerFigure {
  readonly label: string;
  /** Exact paise as a decimal string, or `null` when this figure is not an amount. */
  readonly amount: string | null;
  readonly count: number | null;
  /** What this figure means, when the label alone would be ambiguous. */
  readonly note: string | null;
}

/** A record that contributed to the answer — a pointer, never a copy. */
export interface LedgerAnswerRecord {
  readonly type: 'expense' | 'payment' | 'settlement' | 'adjustment' | 'person' | 'finding' | 'run';
  readonly id: string;
  readonly label: string;
  /** Exact paise as a decimal string, when this record carries an amount. */
  readonly amount: string | null;
  readonly occurredAt: string | null;
}

/** Where to go to act on what the answer says. An answer never acts (ADR-0057). */
export interface LedgerAnswerLink {
  readonly label: string;
  readonly href: string;
}

/**
 * One answer, assembled entirely from authoritative reads.
 *
 * `interpretation` is the sentence that makes a wrong reading visible: every answer states how
 * the question was understood, so the worst failure available on this path — answering a
 * different question — is one the reader can see.
 */
export interface LedgerAnswer {
  readonly kind: LedgerQueryKind;
  readonly answered: boolean;
  readonly interpretation: string;
  readonly headline: string;
  readonly period: { readonly start: string; readonly end: string } | null;
  /** Whose figures these are, and over what — stated, never assumed by the reader. */
  readonly scope: string;
  /** The service read every figure came from, named so the answer is checkable. */
  readonly source: string | null;
  readonly figures: readonly LedgerAnswerFigure[];
  readonly records: readonly LedgerAnswerRecord[];
  /** What the underlying read says it deliberately excludes. Carried through verbatim. */
  readonly caveats: readonly string[];
  /** What this answer does not know, including anything the read reported as incomplete. */
  readonly uncertainties: readonly string[];
  readonly links: readonly LedgerAnswerLink[];
}

/**
 * The sentence an answer leads with about itself.
 *
 * Pure, and deliberately dull: it restates the plan in words, so a reader can see at a glance
 * that "last month" was read as August and "Priya" as the Priya in their roster.
 */
export function describeQueryInterpretation(input: {
  readonly plan: LedgerQueryPlan;
  readonly period: LedgerQueryPeriod | null;
  readonly periodAssumed: boolean;
  /** The person the service resolved, when the plan named one. */
  readonly resolvedPersonLabel: string | null;
}): string {
  const capability = LEDGER_QUERY_CAPABILITIES.find((entry) => entry.kind === input.plan.kind);
  const parts: string[] = [];

  parts.push(
    capability === undefined ? `read as: ${input.plan.kind}` : `read as: ${capability.answers}`,
  );
  if (input.resolvedPersonLabel !== null) parts.push(`with ${input.resolvedPersonLabel}`);
  if (input.plan.category !== null) parts.push(`in category “${input.plan.category}”`);
  if (input.plan.searchTerm !== null) parts.push(`matching “${input.plan.searchTerm}”`);
  if (input.period !== null) {
    parts.push(
      `${formatDay(input.period.start)} to ${formatDay(dayBefore(input.period.end))}` +
        (input.periodAssumed ? ' (assumed — no period was named)' : ''),
    );
  }
  return parts.join(', ');
}

/* ------------------------------------------------------------------------- internals */

function formatDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The last day a period covers, since `end` is exclusive everywhere in this system. */
function dayBefore(end: Date): Date {
  return new Date(end.getTime() - 86_400_000);
}
