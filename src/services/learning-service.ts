/**
 * ```
 * services.listRuleProposals  ─▶ db.listPaymentPurposeContext      what has been confirmed
 *                             ├─▶ db.listRules                     what is already covered
 *                             └─▶ domain.proposeRulesFromConfirmations
 *
 * services.approveRuleProposal ─▶ services.createRule               the one path to a rule
 * ```
 *
 * [ADR-0064](../../docs/decisions/0064-a-pattern-is-a-proposal-a-person-approves-before-it-ever-matches.md).
 *
 * Listing proposals writes nothing at all. Approving one creates exactly one row through the
 * existing `createRule`, which validates it, audits it, and is the only way a pattern ever starts
 * matching anything.
 *
 * **A learned rule always proposes and never applies.** The effect is not a parameter here: there
 * is no argument a caller could pass that would make an approved pattern write a category into
 * the ledger unattended. What it does is put the category in front of a person, attributed to the
 * rule that suggested it, and they still confirm the payment.
 */

import {
  insertRuleProposalDismissal,
  listPaymentPurposeContext,
  listRuleProposalDismissals,
  restoreRuleProposalDismissal,
} from '../db/index.js';
import type { Database, Executor } from '../db/index.js';
import { proposeRulesFromConfirmations } from '../domain/index.js';
import type {
  ApprovedCategoryRule,
  ConfirmedPayment,
  LearnedRuleProposal,
  RuleId,
} from '../domain/index.js';

import type { AuditMeta } from './audit.js';
import { runAudited } from './audit.js';
import { ServiceError } from './errors.js';
import { createRule, listRules } from './rule-service.js';

export interface RuleProposalsResult {
  readonly proposals: readonly LearnedRuleProposal[];
  /** How many confirmed payments were read, so a screen can say what it looked at. */
  readonly confirmationsRead: number;
  /**
   * Patterns declined and not restored, so the screen can show what was turned down and offer it
   * back (ADR-0065). A dismissal that vanished from every surface would be a decision nobody can
   * revisit.
   */
  readonly dismissed: readonly DismissedPattern[];
}

export interface DismissedPattern {
  readonly proposalKey: string;
  readonly wording: string;
  readonly category: string;
  readonly dismissedAt: Date;
  readonly dismissedBy: string;
  /** Their own words, quoted back. Required at the database, so never absent. */
  readonly reason: string;
}

/**
 * Patterns a person could approve, read from the categories they have already confirmed.
 *
 * `listPaymentPurposeContext` supplies `confirmedCategory` from expenses in state **approved**
 * only — which is the line ADR-0060 drew and ADR-0064 keeps: a pending proposal, a rejected one,
 * or another rule's suggestion can never teach, or the system bootstraps a guess into a standing
 * rule.
 */
export async function listRuleProposals(db: Executor): Promise<RuleProposalsResult> {
  const [rows, rules, dismissals] = await Promise.all([
    listPaymentPurposeContext(db),
    listRules(db),
    listRuleProposalDismissals(db),
  ]);

  const inForce = dismissals.filter((dismissal) => dismissal.restoredAt === null);

  const confirmations: ConfirmedPayment[] = [];
  for (const row of rows) {
    const category = row.confirmedCategory;
    if (category === null || category.trim().length === 0) continue;
    confirmations.push({
      paymentId: row.paymentId,
      rawDescription: row.rawDescription,
      direction: row.direction,
      occurredAt: row.occurredAt,
      category,
    });
  }

  // Wording an active category rule already matches on. A second rule for the same text is a
  // conflict `applyRules` would then have to report, so the proposal is withheld instead.
  const alreadyCoveredWording = rules
    .filter((rule) => rule.active && rule.assertion.action === 'set_expense_category')
    .map((rule) => rule.match.description)
    .filter((description): description is string => description !== undefined);

  return {
    proposals: proposeRulesFromConfirmations({
      confirmations,
      alreadyCoveredWording,
      // Every payment on file, so each proposal can report what it would actually reach. The
      // same one query already loaded above — the preview must see the ledger the confirmations
      // came from, or it could report a reach that disagrees with what the rule then does.
      allPayments: rows.map((row) => ({
        paymentId: row.paymentId,
        rawDescription: row.rawDescription,
        occurredAt: row.occurredAt,
      })),
      dismissedKeys: inForce.map((dismissal) => dismissal.proposalKey),
    }),
    confirmationsRead: confirmations.length,
    dismissed: inForce.map((dismissal) => ({
      proposalKey: dismissal.proposalKey,
      wording: dismissal.wording,
      category: dismissal.category,
      dismissedAt: dismissal.dismissedAt,
      dismissedBy: dismissal.dismissedBy,
      reason: dismissal.reason,
    })),
  };
}

export interface ApproveRuleProposalInput {
  /** The proposal's `id`, re-derived on the server rather than trusted from the caller. */
  readonly proposalId: string;
  /** A person may rename it before approving; blank keeps the suggested name. */
  readonly name?: string;
  readonly audit: AuditMeta;
}

/**
 * Turns one proposal into a standing rule, after a person has read what it matches.
 *
 * The proposal is **re-derived here** and matched by id rather than accepted from the request
 * body. A caller cannot therefore approve a pattern that the confirmations no longer support, nor
 * widen the wording between seeing it and confirming it — the text that gets stored is the text
 * that was on screen, because both come from the same pure function over the same rows.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` when no current proposal has that id, which is also what a
 *   stale screen gets: the confirmations changed, so the pattern it was showing no longer holds.
 */
export async function approveRuleProposal(
  db: Database,
  input: ApproveRuleProposalInput,
): Promise<{ readonly ruleId: RuleId }> {
  const { proposals } = await listRuleProposals(db);
  const proposal = proposals.find((candidate) => candidate.id === input.proposalId);
  if (proposal === undefined) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      'That pattern is no longer being suggested. The confirmations behind it have changed, so ' +
        'it was re-read and is not offered any more.',
      { proposalId: input.proposalId },
    );
  }

  const name = input.name?.trim();
  return createRule(db, {
    name: name === undefined || name.length === 0 ? proposal.suggestedName : name,
    match: proposal.match,
    assertion: { action: 'set_expense_category', category: proposal.category },
    // Not a parameter, deliberately. A learned pattern suggests; a person decides. There is no
    // argument that would make this `apply` (ADR-0064).
    effect: 'propose',
    origin: 'promoted_from_repeated_ai_suggestion',
    audit: {
      ...input.audit,
      reason:
        input.audit.reason ??
        `Approved the suggested pattern: wording containing "${proposal.wording}" is ${proposal.category}.`,
    },
  });
}

/**
 * The approved patterns a purpose reading consults, in evaluation order.
 *
 * Only `active`, only `set_expense_category`, and only those carrying wording — a rule with no
 * text condition cannot make a statement about what a payment was for. Loaded once per run by
 * the caller, for the same reason `loadPurposeContext` is: recurrence and rules are both
 * properties of the ledger rather than of the row.
 */
export async function loadApprovedCategoryRules(
  db: Executor,
): Promise<readonly ApprovedCategoryRule[]> {
  const rules = await listRules(db);
  return rules.flatMap((rule) => {
    if (!rule.active) return [];
    if (rule.assertion.action !== 'set_expense_category') return [];
    const wording = rule.match.description;
    if (wording === undefined || wording.trim().length === 0) return [];
    return [
      {
        id: rule.id,
        name: rule.name,
        wording,
        operator: rule.match.descriptionOperator ?? ('contains' as const),
        category: rule.assertion.category,
      },
    ];
  });
}

export interface DismissRuleProposalInput {
  readonly proposalId: string;
  /** Why, in the person's own words. Required — the database refuses a blank one. */
  readonly reason: string;
  readonly audit: AuditMeta;
}

/**
 * Records that somebody declined a pattern, so it stops being offered (ADR-0065).
 *
 * The proposal is re-derived and matched by id, exactly as approving does: a caller cannot
 * dismiss a pattern the confirmations no longer support, and the wording that gets recorded is
 * the wording that was on screen.
 *
 * **Nothing about the ledger changes.** The approved expenses behind the pattern keep teaching
 * `inferPurpose` as they always did; this silences an offer, not a reading.
 *
 * @throws ServiceError `PRECONDITION_FAILED` when no reason was given.
 * @throws ServiceError `ENTITY_NOT_FOUND` when the pattern is no longer being suggested.
 */
export async function dismissRuleProposal(
  db: Database,
  input: DismissRuleProposalInput,
): Promise<{ readonly proposalKey: string }> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'Declining a pattern is a decision, so it needs a reason. A future reader — including you ' +
        '— has to be able to tell why this stopped being offered.',
    );
  }

  const { proposals } = await listRuleProposals(db);
  const proposal = proposals.find((candidate) => candidate.id === input.proposalId);
  if (proposal === undefined) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      'That pattern is no longer being suggested, so there is nothing to decline.',
      { proposalId: input.proposalId },
    );
  }

  return runAudited(db, { ...input.audit, reason }, async ({ exec, record }) => {
    const id = await insertRuleProposalDismissal(exec, {
      proposalKey: proposal.id,
      wording: proposal.wording,
      category: proposal.category,
      dismissedBy: input.audit.actor,
      reason,
    });
    await record({
      entityType: 'rule_proposal_dismissal',
      entityId: id,
      action: 'create',
      newValue: {
        proposalKey: proposal.id,
        wording: proposal.wording,
        category: proposal.category,
      },
    });
    return { proposalKey: proposal.id };
  });
}

export interface RestoreRuleProposalInput {
  readonly proposalKey: string;
  readonly audit: AuditMeta;
}

/**
 * Offers a declined pattern again.
 *
 * Closes the dismissal rather than deleting it, so "declined this, then changed my mind" survives
 * in the table and in the audit trail. Whether the pattern actually reappears is then up to the
 * confirmations, exactly as it was the first time — restoring un-silences the offer, it does not
 * assert that the pattern is still supported.
 */
export async function restoreRuleProposal(
  db: Database,
  input: RestoreRuleProposalInput,
): Promise<{ readonly restored: number }> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const restoredIds = await restoreRuleProposalDismissal(
      exec,
      input.proposalKey,
      input.audit.actor,
      new Date(),
    );
    if (restoredIds.length === 0) {
      throw new ServiceError(
        'ENTITY_NOT_FOUND',
        'That pattern is not currently declined, so there is nothing to bring back.',
        { proposalKey: input.proposalKey },
      );
    }
    for (const id of restoredIds) {
      await record({
        entityType: 'rule_proposal_dismissal',
        entityId: id,
        action: 'update',
        newValue: { restored: true, proposalKey: input.proposalKey },
      });
    }
    return { restored: restoredIds.length };
  });
}
