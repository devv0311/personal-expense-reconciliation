/**
 * Standing rules — a deterministic restatement of a decision a person already made
 * (audit row 43).
 *
 * The reason this is in `src/domain` rather than `src/ai` is the whole design. A rule is not
 * a model and not a similarity score: it is a **pattern a person wrote down**, matched exactly,
 * producing exactly the fact they said it should produce. That is why `actor = 'rule:<id>'` is
 * an acceptable author for a write at all — the human is the author, the rule is the
 * restatement, and the match is not a judgement (`ai-boundary.md`, `invariants.md` #17).
 *
 * Three things this deliberately cannot do:
 *
 *  - **It cannot decide who benefited.** No rule action touches an `Allocation`. Dividing a
 *    cost among people is the judgement this system exists to make explicit, and a standing
 *    pattern is exactly the wrong instrument for it.
 *  - **It cannot decide an amount.** Every action sets a *label*; none sets money.
 *  - **It cannot fuzzy-match.** `contains`/`equals`/`startsWith` over the immutable narration,
 *    plus optional direction/channel/account/amount equality. No regex, no similarity, no
 *    "close enough". A pattern that would need one is a proposal for a person to read.
 */

import type {
  CashFlowCategory,
  PaymentChannel,
  PaymentCounterpartyType,
  PaymentDirection,
  RuleAction,
  RuleEffect,
} from './enums.js';
import { DomainError } from './errors.js';
import type { AccountId, RuleId } from './ids.js';
import type { Paise } from './money.js';

/** How a rule's text condition is compared against a payment's immutable narration. */
export const RULE_TEXT_OPERATORS = ['contains', 'equals', 'startsWith'] as const;
export type RuleTextOperator = (typeof RULE_TEXT_OPERATORS)[number];

/**
 * What a rule matches on.
 *
 * Every field is optional and every present field must hold — an `AND`, never an `OR`. A rule
 * with no condition at all matches everything, which is refused: a standing rule that fires on
 * every payment is not a rule, it is a default, and defaults belong in code where they can be
 * read.
 */
export interface RuleMatchPattern {
  readonly descriptionOperator?: RuleTextOperator;
  /** Compared case-insensitively — a statement's capitalisation is not a distinction. */
  readonly description?: string;
  readonly direction?: PaymentDirection;
  readonly channel?: PaymentChannel;
  readonly accountId?: AccountId;
  /** Exact minor units. A rule about "roughly ₹500" is a proposal, not a rule. */
  readonly amount?: Paise;
}

/** What a matched rule asserts. One action per rule; a second fact is a second rule. */
export type RuleAssertion =
  | { readonly action: 'set_counterparty_type'; readonly counterpartyType: PaymentCounterpartyType }
  | { readonly action: 'set_cash_flow_category'; readonly cashFlowCategory: CashFlowCategory }
  | { readonly action: 'set_expense_category'; readonly category: string };

export interface RuleDefinition {
  readonly id: RuleId;
  readonly name: string;
  readonly match: RuleMatchPattern;
  readonly assertion: RuleAssertion;
  readonly effect: RuleEffect;
  readonly active: boolean;
}

/** The payment facts a rule is allowed to look at — all of them immutable SOURCE columns. */
export interface RuleMatchablePayment {
  readonly rawDescription: string;
  readonly direction: PaymentDirection;
  readonly channel: PaymentChannel;
  readonly accountId: AccountId;
  readonly amount: Paise;
}

/**
 * Whether one rule matches one payment.
 *
 * Pure and total: same rule, same payment, same answer, forever. That property is what makes
 * `actor = 'rule:<id>'` auditable — a reader can re-run the match against the immutable
 * columns and see for themselves why it fired.
 */
export function ruleMatches(rule: RuleDefinition, payment: RuleMatchablePayment): boolean {
  if (!rule.active) return false;
  const { match } = rule;

  if (match.description !== undefined) {
    const haystack = payment.rawDescription.toUpperCase();
    const needle = match.description.toUpperCase();
    const operator = match.descriptionOperator ?? 'contains';
    const hit =
      operator === 'equals'
        ? haystack === needle
        : operator === 'startsWith'
          ? haystack.startsWith(needle)
          : haystack.includes(needle);
    if (!hit) return false;
  }
  if (match.direction !== undefined && match.direction !== payment.direction) return false;
  if (match.channel !== undefined && match.channel !== payment.channel) return false;
  if (match.accountId !== undefined && match.accountId !== payment.accountId) return false;
  if (match.amount !== undefined && match.amount !== payment.amount) return false;
  return true;
}

/**
 * Refuses a rule that cannot honestly be one.
 *
 * @throws DomainError `RULE_PATTERN_EMPTY` for a rule with no condition — it would fire on
 *   every payment ever imported, which is a default masquerading as a decision.
 * @throws DomainError `RULE_ASSERTION_INVALID` when the asserted fact contradicts the pattern:
 *   a `REFUND` category on a rule that only matches debits can never be true (17.2), so the
 *   rule is refused when it is written rather than failing silently on every match.
 */
export function validateRuleDefinition(match: RuleMatchPattern, assertion: RuleAssertion): void {
  const hasCondition =
    (match.description !== undefined && match.description.trim().length > 0) ||
    match.direction !== undefined ||
    match.channel !== undefined ||
    match.accountId !== undefined ||
    match.amount !== undefined;
  if (!hasCondition) {
    throw new DomainError(
      'RULE_PATTERN_EMPTY',
      'A rule with no condition matches every payment ever imported. That is a default, not a ' +
        'rule — say what it should match on.',
    );
  }

  if (
    assertion.action === 'set_cash_flow_category' &&
    match.direction === 'debit' &&
    (assertion.cashFlowCategory === 'REFUND' || assertion.cashFlowCategory === 'EXTERNAL_INFLOW')
  ) {
    throw new DomainError(
      'RULE_ASSERTION_INVALID',
      `This rule matches only debits but asserts ${assertion.cashFlowCategory}, which ` +
        'describes money arriving (ADR-0017 (cash balance), 17.2). It could never hold, so it ' +
        'is refused here rather than failing on every payment it matches.',
      { direction: 'debit', cashFlowCategory: assertion.cashFlowCategory },
    );
  }

  if (assertion.action === 'set_expense_category' && assertion.category.trim().length === 0) {
    throw new DomainError('RULE_ASSERTION_INVALID', 'A category rule needs a category to set.');
  }
}

/**
 * The first rule that matches, in the order given, or `null`.
 *
 * First-match-wins, and the order is the order a person put them in. Two rules asserting
 * different things about one payment is a conflict only a person can resolve, and quietly
 * applying both — or picking by some scoring heuristic — would hide it.
 */
export function firstMatchingRule(
  rules: readonly RuleDefinition[],
  payment: RuleMatchablePayment,
): RuleDefinition | null {
  return rules.find((rule) => ruleMatches(rule, payment)) ?? null;
}

/** Every rule that matches, so a surface can show a person the conflict rather than hide it. */
export function matchingRules(
  rules: readonly RuleDefinition[],
  payment: RuleMatchablePayment,
): readonly RuleDefinition[] {
  return rules.filter((rule) => ruleMatches(rule, payment));
}

/** The actor string a rule's own write is attributed to (`invariants.md` #17). */
export function ruleActor(ruleId: RuleId): string {
  return `rule:${ruleId}`;
}

/** Which of {@link RULE_ACTIONS} a stored assertion carries, validated on the way in. */
export function assertionAction(assertion: RuleAssertion): RuleAction {
  return assertion.action;
}
