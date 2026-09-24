/**
 * A pattern a person could approve, read out of the categories they have already confirmed.
 *
 * [ADR-0064](../../docs/decisions/0064-a-pattern-is-a-proposal-a-person-approves-before-it-ever-matches.md).
 *
 * The product already learns: `inferPurpose` lets a category confirmed on a sibling payment
 * outrank every lexicon word ([ADR-0060](../../docs/decisions/0060-a-statement-line-says-what-it-was-for-and-what-it-is-not.md)).
 * That works and is invisible — a person cannot see the pattern, read what wording it keys on,
 * narrow it, or switch it off. This module makes the same knowledge reviewable.
 *
 * **Nothing here is a rule.** Every value returned is a *proposal*: a derived read that matches
 * nothing, is stored nowhere, and disappears when the confirmations behind it change. Only
 * `services.approveRuleProposal` turns one into a row, and only a person calls that.
 *
 * Two refusals matter more than the rest and are enforced before any grouping happens:
 *
 *  - **Only an approved expense teaches.** A pending proposal, a rejected one or another rule's
 *    suggestion can never contribute. Without that line the system bootstraps: a guess becomes
 *    evidence, the evidence hardens, and a wrong reading becomes a standing rule nobody agreed to.
 *  - **Only a purchase teaches.** Tax, interest, principal, fees and card bills are excluded by
 *    nature. A standing rule firing on every `CGST` row is a machine for wrong totals.
 */

import { descriptionMatches } from './rules.js';
import type { RuleMatchPattern, RuleTextOperator } from './rules.js';
import { readStatementRow } from './purpose.js';

/* ------------------------------------------------------------------------------- inputs */

/**
 * One payment whose category a person has already approved.
 *
 * `category` comes from an expense in state `approved`; the caller is responsible for that, and
 * the service that feeds this reads nothing else.
 */
export interface ConfirmedPayment {
  readonly paymentId: string;
  readonly rawDescription: string;
  readonly direction: 'debit' | 'credit';
  readonly occurredAt: Date;
  /** The category on the approved expense behind this payment. */
  readonly category: string;
}

/** Any payment on file, as the reach preview needs to see it. */
export interface MatchablePaymentRow {
  readonly paymentId: string;
  readonly rawDescription: string;
  readonly occurredAt: Date;
}

export interface LearningInput {
  readonly confirmations: readonly ConfirmedPayment[];
  /**
   * Every payment on file, so a proposal can say what it would actually reach (ADR-0065).
   *
   * Omitted means the preview is empty rather than absent — a caller that has not loaded the
   * ledger gets zero counts, never a claim that the rule matches nothing.
   */
  readonly allPayments?: readonly MatchablePaymentRow[];
  /**
   * Proposal keys a person has declined and not restored. Filtered out entirely: a pattern
   * declined once is not offered again, however much evidence accumulates behind it.
   */
  readonly dismissedKeys?: readonly string[];
  /**
   * Wording that active rules already match on, upper-cased.
   *
   * A second rule for the same text is a conflict `applyRules` would then have to report, so the
   * proposal is not offered at all.
   */
  readonly alreadyCoveredWording: readonly string[];
}

/* ------------------------------------------------------------------------------ outputs */

/** One payment a proposal was derived from, so the reader can check it. */
export interface LearningExample {
  readonly paymentId: string;
  readonly occurredAt: Date;
  /** The issuer's own wording, verbatim. Immutable source, quoted rather than interpreted. */
  readonly narration: string;
}

export interface LearnedRuleProposal {
  /** Stable for one read, from the wording and category. Not an identifier of anything stored. */
  readonly id: string;
  /** What the rule would be called in the list. A person may change it before approving. */
  readonly suggestedName: string;
  /** The exact text a payment's wording must contain. Shown before approval, always. */
  readonly wording: string;
  readonly operator: RuleTextOperator;
  readonly category: string;
  /** Ready for `createRule`; built here so a caller cannot widen it on the way through. */
  readonly match: RuleMatchPattern;
  /** One plain sentence. Never a score, never a count of tokens. */
  readonly reason: string;
  /** Every confirmation behind it. Never empty — a proposal with no basis is an opinion. */
  readonly examples: readonly LearningExample[];
  /**
   * What this wording would actually reach, if approved (ADR-0065).
   *
   * The wording alone does not tell anybody whether a pattern is too wide. `contains "CAFE"` and
   * `contains "HARBOUR CAFE BANDRA"` read the same in a sentence and behave nothing alike; the
   * difference is visible only as a list of what each one hits.
   */
  readonly reach: ProposalReach;
}

export interface ProposalReach {
  /** Payments already filed this way — the confirmations. Reassuring, not the warning. */
  readonly alreadyFiled: number;
  /**
   * Payments the rule would newly start suggesting for.
   *
   * **The number that says the wording is too wide.** A few is normal and usually the point; a
   * lot, or one that obviously does not belong, is what a person needs to see before approving.
   */
  readonly wouldAlsoMatch: number;
  /** A sample of those, so "would also match 9" is checkable rather than a number to trust. */
  readonly examplesOfNewMatches: readonly LearningExample[];
}

/** How many new matches to quote. Enough to spot a wrong one; short enough to read at a glance. */
const NEW_MATCH_SAMPLE = 5;

/* -------------------------------------------------------------------------- thresholds */

/**
 * How many confirmations of one category it takes before a pattern is worth offering.
 *
 * Two. One confirmation is a decision about one payment; calling it a pattern would put a
 * standing rule in front of somebody who has answered a single question. Two is the smallest
 * number that is a repetition, and because the result only ever *suggests*, the cost of offering
 * one too eagerly is a proposal somebody declines rather than a figure that is wrong.
 */
const MINIMUM_CONFIRMATIONS = 2;

/**
 * The shortest wording a rule may match on.
 *
 * Four characters. `CAF` matches things nobody meant, and a short rule is a wide rule that will
 * quietly start suggesting a category for unrelated merchants. The wording is on screen before
 * approval precisely so a person can judge this for themselves, but the obviously-too-wide case
 * is refused rather than shown.
 */
const MINIMUM_WORDING_LENGTH = 4;

/* ---------------------------------------------------------------------------- the reading */

/**
 * Every pattern worth offering, newest basis first.
 *
 * Deterministic: the same confirmations give the same proposals in the same order, so a screen
 * that re-reads does not reshuffle under the reader.
 */
export function proposeRulesFromConfirmations(
  input: LearningInput,
): readonly LearnedRuleProposal[] {
  const covered = new Set(input.alreadyCoveredWording.map((text) => text.toUpperCase()));
  const dismissed = new Set(input.dismissedKeys ?? []);
  const allPayments = input.allPayments ?? [];

  // Only purchases, and only ones whose wording names a merchant at all. The nature check runs
  // first so no amount of repetition can promote a tax or interest row into a pattern.
  const purchases = input.confirmations.flatMap((confirmation) => {
    const reading = readStatementRow(confirmation);
    if (reading.nature !== 'merchant_purchase') return [];
    if (reading.merchantText === null) return [];
    const wording = reading.merchantText.trim().toUpperCase();
    if (wording.length < MINIMUM_WORDING_LENGTH) return [];
    return [{ confirmation, wording }];
  });

  const byWording = new Map<string, { confirmation: ConfirmedPayment }[]>();
  for (const entry of purchases) {
    const group = byWording.get(entry.wording) ?? [];
    group.push({ confirmation: entry.confirmation });
    byWording.set(entry.wording, group);
  }

  const proposals: LearnedRuleProposal[] = [];
  for (const [wording, group] of byWording) {
    if (group.length < MINIMUM_CONFIRMATIONS) continue;
    if (covered.has(wording)) continue;

    // The same wording confirmed as two different categories is the person disagreeing with
    // themselves. A rule would have to pick one silently, so none is offered.
    const categories = new Set(group.map((entry) => entry.confirmation.category));
    if (categories.size !== 1) continue;
    const category = [...categories][0];
    if (category === undefined || category.trim().length === 0) continue;

    const id = `learned:${wording}:${category}`;
    // A pattern somebody declined is not offered again, however much evidence accumulates behind
    // it. The evidence growing is not new information about their decision (ADR-0065).
    if (dismissed.has(id)) continue;

    const examples = group
      .map((entry) => ({
        paymentId: entry.confirmation.paymentId,
        occurredAt: entry.confirmation.occurredAt,
        narration: entry.confirmation.rawDescription,
      }))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    proposals.push({
      id,
      suggestedName: `${wording} is ${category}`,
      wording,
      operator: 'contains',
      category,
      match: { description: wording, descriptionOperator: 'contains' },
      reason: `You have filed ${String(group.length)} payments worded like this as ${category}.`,
      examples,
      reach: reachOf(wording, allPayments, new Set(examples.map((example) => example.paymentId))),
    });
  }

  return proposals.sort((a, b) => latestOf(b) - latestOf(a));
}

/**
 * What this wording would hit across everything on file.
 *
 * Uses `descriptionMatches` — the same predicate `ruleMatches` runs — so the preview cannot
 * disagree with what the rule will do once approved. A second implementation here would be a
 * second definition of what a rule matches, and the two would drift the first time either moved.
 */
function reachOf(
  wording: string,
  allPayments: readonly MatchablePaymentRow[],
  confirmedIds: ReadonlySet<string>,
): ProposalReach {
  const newMatches = allPayments
    .filter(
      (row) =>
        !confirmedIds.has(row.paymentId) &&
        descriptionMatches(row.rawDescription, wording, 'contains'),
    )
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  return {
    alreadyFiled: confirmedIds.size,
    wouldAlsoMatch: newMatches.length,
    examplesOfNewMatches: newMatches.slice(0, NEW_MATCH_SAMPLE).map((row) => ({
      paymentId: row.paymentId,
      occurredAt: row.occurredAt,
      narration: row.rawDescription,
    })),
  };
}

function latestOf(proposal: LearnedRuleProposal): number {
  return Math.max(...proposal.examples.map((example) => example.occurredAt.getTime()));
}

/* ------------------------------------------------------- what an approved pattern then does */

/** An approved category rule, narrowed to what a purpose reading needs to consult. */
export interface ApprovedCategoryRule {
  readonly id: string;
  readonly name: string;
  readonly wording: string;
  readonly operator: RuleTextOperator;
  readonly category: string;
}

/** Which approved pattern leads a payment's reading, and why — for the screen to quote. */
export interface AppliedRule {
  readonly ruleId: string;
  readonly ruleName: string;
  /** The text that matched. Shown so a person can see exactly what fired and narrow it. */
  readonly wording: string;
  readonly category: string;
  /** One plain sentence naming the rule. Never a score. */
  readonly why: string;
}

/**
 * The first approved pattern whose wording this payment carries, or `null`.
 *
 * First-match-wins in the order given, which is `listRules`' order — the same first-match rule
 * `firstMatchingRule` uses, for the same reason: two patterns claiming one payment is a
 * disagreement between two things the same person approved, and silently scoring between them
 * would hide it.
 *
 * **Matching is not deciding.** A hit means the suggestion leads with this category and says
 * which rule said so; the payment still becomes a proposal somebody confirms (ADR-0064).
 */
export function applyLearnedRule(
  rules: readonly ApprovedCategoryRule[],
  rawDescription: string,
): AppliedRule | null {
  for (const rule of rules) {
    if (!descriptionMatches(rawDescription, rule.wording, rule.operator)) continue;
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      wording: rule.wording,
      category: rule.category,
      why: `Your rule "${rule.name}" matches this wording: "${rule.wording}".`,
    };
  }
  return null;
}
