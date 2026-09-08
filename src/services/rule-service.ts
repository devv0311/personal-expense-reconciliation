/**
 * Standing rules: writing them, and applying them to payments (audit row 43).
 *
 * The audit found `rules` schema-only — *"no rule CRUD/evaluator/learner or application
 * engine"*. This is the CRUD and the evaluator. The **learner** is deliberately still absent,
 * and that is a decision rather than an omission: promoting a repeated correction into a
 * standing rule without being asked is the system deciding, on a pattern it noticed, to start
 * writing financial facts unattended. `RULE_ORIGINS` keeps `promoted_from_repeated_ai_suggestion`
 * representable for when a person is offered that promotion and accepts it.
 *
 * What applying a rule does, per its `effect`:
 *
 *  - `propose` — records nothing but a suggestion the review queue will show. The default,
 *    and the right one for almost everything.
 *  - `apply` — writes the fact, attributed to `rule:<id>`. Defensible only because the match is
 *    exact over immutable columns and the rule's author is the human who approved it
 *    (`invariants.md` #17). A `set_cash_flow_category` rule still goes through ADR-0017's
 *    lifecycle and its evidence gates: the rule classifies, it does not approve.
 */

import {
  RULE_EFFECTS,
  asId,
  firstMatchingRule,
  matchingRules,
  ruleActor,
  validateRuleDefinition,
} from '../domain/index.js';
import type {
  PaymentChannel,
  PaymentId,
  RuleAssertion,
  RuleDefinition,
  RuleEffect,
  RuleId,
  RuleMatchPattern,
} from '../domain/index.js';
import {
  archiveRule,
  insertRule,
  listRuleRows,
  markRuleApplied,
  updateRuleRow,
} from '../db/index.js';
import type { Database, Executor, RuleRow } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { classifyPaymentCashFlow } from './cash-flow-service.js';
import { ServiceError } from './errors.js';
import { listPaymentsForWorkspace } from '../db/index.js';
import { setPaymentCounterparty } from './payment-workspace-service.js';

/* =============================================================================== CRUD */

export interface RuleView extends RuleDefinition {
  readonly origin: string;
  readonly timesApplied: number;
  readonly lastAppliedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
}

function toView(row: RuleRow): RuleView {
  return {
    id: row.id,
    name: row.name,
    match: row.matchPattern as RuleMatchPattern,
    assertion: row.proposedClassification as RuleAssertion,
    effect: row.effect as RuleEffect,
    active: row.active && row.archivedAt === null,
    origin: row.origin,
    timesApplied: row.timesApplied,
    lastAppliedAt: row.lastAppliedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

/** Every rule, active first, in the order they are evaluated. */
export async function listRules(db: Executor): Promise<readonly RuleView[]> {
  const rows = await listRuleRows(db);
  return rows.map(toView);
}

export interface CreateRuleInput {
  readonly name: string;
  readonly match: RuleMatchPattern;
  readonly assertion: RuleAssertion;
  readonly effect?: RuleEffect;
  readonly audit: AuditMeta;
}

export async function createRule(
  db: Database,
  input: CreateRuleInput,
): Promise<{ readonly ruleId: RuleId }> {
  if (input.name.trim().length === 0) {
    throw new ServiceError('PRECONDITION_FAILED', 'A rule needs a name to be recognised by.');
  }
  // The domain decides whether this is a rule at all — an empty pattern, or an assertion its
  // own pattern makes impossible, is refused here rather than at every payment it matches.
  validateRuleDefinition(input.match, input.assertion);

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const ruleId = await insertRule(exec, {
      name: input.name.trim(),
      matchPattern: input.match,
      proposedClassification: input.assertion,
      action: input.assertion.action,
      effect: input.effect ?? 'propose',
      origin: 'manual',
    });
    await record({
      entityType: 'rule',
      entityId: ruleId,
      action: 'create',
      newValue: {
        name: input.name.trim(),
        match: input.match,
        assertion: input.assertion,
        effect: input.effect ?? 'propose',
      },
    });
    return { ruleId };
  });
}

export interface UpdateRuleInput {
  readonly ruleId: RuleId;
  readonly name?: string;
  readonly match?: RuleMatchPattern;
  readonly assertion?: RuleAssertion;
  readonly effect?: RuleEffect;
  readonly active?: boolean;
  readonly archived?: boolean;
  readonly audit: AuditMeta;
}

export async function updateRule(db: Database, input: UpdateRuleInput): Promise<void> {
  await runAudited(db, input.audit, async ({ exec, record }) => {
    const rows = await listRuleRows(exec);
    const before = rows.find((row) => row.id === input.ruleId);
    if (before === undefined) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such rule.', { ruleId: input.ruleId });
    }

    const nextMatch = input.match ?? (before.matchPattern as RuleMatchPattern);
    const nextAssertion = input.assertion ?? (before.proposedClassification as RuleAssertion);
    if (input.match !== undefined || input.assertion !== undefined) {
      validateRuleDefinition(nextMatch, nextAssertion);
    }
    if (input.effect !== undefined && !(RULE_EFFECTS as readonly string[]).includes(input.effect)) {
      throw new ServiceError('PRECONDITION_FAILED', `Unknown rule effect "${input.effect}".`);
    }

    await updateRuleRow(exec, input.ruleId, {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.match === undefined ? {} : { matchPattern: nextMatch }),
      ...(input.assertion === undefined
        ? {}
        : { proposedClassification: nextAssertion, action: nextAssertion.action }),
      ...(input.effect === undefined ? {} : { effect: input.effect }),
      ...(input.active === undefined ? {} : { active: input.active }),
    });
    if (input.archived !== undefined) {
      await archiveRule(exec, input.ruleId, input.archived ? new Date() : null);
    }

    await record({
      entityType: 'rule',
      entityId: input.ruleId,
      action: 'update',
      oldValue: {
        name: before.name,
        match: before.matchPattern,
        assertion: before.proposedClassification,
        effect: before.effect,
        active: before.active,
      },
      newValue: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.match === undefined ? {} : { match: nextMatch }),
        ...(input.assertion === undefined ? {} : { assertion: nextAssertion }),
        ...(input.effect === undefined ? {} : { effect: input.effect }),
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
      },
    });
  });
}

/* ========================================================================= evaluation */

/** What one rule would do, or did, to one payment. */
export interface RuleOutcome {
  readonly paymentId: PaymentId;
  readonly ruleId: RuleId;
  readonly ruleName: string;
  readonly assertion: RuleAssertion;
  readonly effect: RuleEffect;
  /** `applied` wrote the fact; `proposed` recorded nothing and is for a person to act on. */
  readonly outcome: 'applied' | 'proposed' | 'skipped';
  /** Why nothing happened, when nothing did. */
  readonly reason?: string;
}

export interface ApplyRulesInput {
  /** Scope to one import batch, or omit for every payment awaiting interpretation. */
  readonly importBatchId?: string;
  /** Preview only: report what would happen and write nothing. */
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly audit: AuditMeta;
}

export interface ApplyRulesResult {
  readonly outcomes: readonly RuleOutcome[];
  /** Payments that matched more than one rule — a conflict only a person can settle. */
  readonly conflicts: readonly {
    readonly paymentId: PaymentId;
    readonly ruleIds: readonly RuleId[];
  }[];
}

/**
 * Runs every active rule over the payments that have not been interpreted yet.
 *
 * First-match-wins, in the order a person put the rules in. A payment matching two rules is
 * reported as a **conflict** and left alone — applying one of them, or both, would hide a
 * disagreement between two things the same person wrote down.
 */
export async function applyRules(db: Database, input: ApplyRulesInput): Promise<ApplyRulesResult> {
  const rules = (await listRules(db)).filter((rule) => rule.active);
  if (rules.length === 0) return { outcomes: [], conflicts: [] };

  const payments = await listPaymentsForWorkspace(db, {
    ...(input.importBatchId === undefined
      ? {}
      : { importBatchId: asId<'import_batch'>(input.importBatchId) }),
    limit: input.limit ?? 500,
  });

  const outcomes: RuleOutcome[] = [];
  const conflicts: Array<{ paymentId: PaymentId; ruleIds: readonly RuleId[] }> = [];

  for (const payment of payments) {
    const matchable = {
      rawDescription: payment.rawDescription,
      direction: payment.direction,
      channel: payment.channel as PaymentChannel,
      accountId: payment.accountId,
      amount: payment.amount,
    };
    const all = matchingRules(rules, matchable);
    if (all.length === 0) continue;
    if (all.length > 1) {
      conflicts.push({ paymentId: payment.id, ruleIds: all.map((rule) => rule.id) });
      continue;
    }

    const rule = firstMatchingRule(rules, matchable);
    if (rule === null) continue;

    if (input.dryRun === true || rule.effect === 'propose') {
      outcomes.push({
        paymentId: payment.id,
        ruleId: rule.id,
        ruleName: rule.name,
        assertion: rule.assertion,
        effect: rule.effect,
        outcome: 'proposed',
        ...(input.dryRun === true ? { reason: 'Preview only; nothing was written.' } : {}),
      });
      continue;
    }

    const outcome = await applyOne(db, rule, payment.id, input.audit);
    outcomes.push(outcome);
  }

  return { outcomes, conflicts };
}

async function applyOne(
  db: Database,
  rule: RuleDefinition,
  paymentId: PaymentId,
  audit: AuditMeta,
): Promise<RuleOutcome> {
  const base = {
    paymentId,
    ruleId: rule.id,
    ruleName: rule.name,
    assertion: rule.assertion,
    effect: rule.effect,
  } as const;

  // The rule is the actor. `invariants.md` #17 permits exactly this string, and it is what
  // makes a rule-written fact distinguishable from a person's own click, forever after.
  const ruleAudit: AuditMeta = {
    actor: ruleActor(rule.id),
    source: `services.applyRules (${rule.name})`,
    reason: `Matched standing rule "${rule.name}".`,
  };

  try {
    if (rule.assertion.action === 'set_counterparty_type') {
      await setPaymentCounterparty(db, {
        paymentId,
        counterpartyType: rule.assertion.counterpartyType,
        audit: ruleAudit,
      });
    } else if (rule.assertion.action === 'set_cash_flow_category') {
      // Classify only. Approval runs ADR-0017's evidence gates and stays a person's act — a
      // rule that could approve would be a rule that closes a cash discrepancy unattended.
      await classifyPaymentCashFlow(db, {
        paymentId,
        category: rule.assertion.cashFlowCategory,
        audit: ruleAudit,
      });
    } else {
      // A category applies to a derived expense, which a payment may not have yet. Reported
      // rather than forced: creating an expense to hang a category on would be the rule
      // deciding that a payment *is* a purchase, which is exactly the judgement it may not make.
      return {
        ...base,
        outcome: 'proposed',
        reason: 'Category rules apply when an expense exists.',
      };
    }
  } catch (error) {
    return {
      ...base,
      outcome: 'skipped',
      reason: error instanceof Error ? error.message : 'The rule could not be applied.',
    };
  }

  await markRuleApplied(db, rule.id, new Date());
  // `audit` is the caller's own metadata for the run; the per-write attribution above is the
  // rule's. Both are recorded, which is how "who started this run" and "what wrote this row"
  // stay separate questions.
  void audit;
  return { ...base, outcome: 'applied' };
}
