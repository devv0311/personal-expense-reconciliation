/**
 * Correcting the kind of an expense that was approved as `personal` (ADR-0073).
 *
 * `invariants.md` #6 and `domain-model.md` §24 have always said an approved expense's
 * `relationship_type` "may still change via a new, audited decision — never a silent overwrite",
 * while `amount` never changes at all. Until ADR-0073 nothing implemented the first half, so an
 * expense approved as "just mine" that was really a shared dinner could never produce the debt it
 * should. This module is the rule for when that decision may be taken; `services.correctExpenseKind`
 * is the one place that takes it.
 *
 * The correction is deliberately narrow:
 *
 *  - **From `personal` only, to a kind that creates a debt** (`shared`, `paid_on_behalf`,
 *    `household_shared_flat`). Those are the corrections a person actually needs ("this was not
 *    only mine"), and each is completed by naming who shared it, in the same transaction.
 *    The reverse — unwinding a debt that may already have been settled or synced — is a repair
 *    with consequences for other people's balances, and is not offered.
 *  - **Only while the expense is `approved` or `allocated`.** Before approval the kind is chosen
 *    by approving it ("Who was this for?"); a `personal` expense never reaches `ready_to_sync` or
 *    `synced`; and a `reconciled` or `rejected` one is closed history.
 *  - **Against the kind the person saw.** The request names the kind it is correcting; if the
 *    ledger holds anything else by the time it arrives — another tab, a lost answer to an earlier
 *    attempt — nothing is changed and the person is told what the ledger holds.
 *
 * Pure: no I/O, no arithmetic. The split that completes the correction is computed by the same
 * allocation code every other split uses.
 */

import { DEBT_CREATING_RELATIONSHIP_TYPES } from './enums.js';
import type { DebtCreatingRelationshipType, ExpenseState } from './enums.js';

/** The only kind an approved expense may be corrected *from*. */
export const KIND_CORRECTABLE_FROM = 'personal' as const;

/** The states in which the correction is allowed. */
export const KIND_CORRECTABLE_STATES: readonly ExpenseState[] = ['approved', 'allocated'];

/** Machine-readable reason a correction is refused; the message is for the person. */
export type KindCorrectionRefusalReason =
  | 'kind_changed_since_read'
  | 'not_personal'
  | 'not_yet_approved'
  | 'closed'
  | 'target_not_debt_creating';

export interface KindCorrectionRefusal {
  readonly reason: KindCorrectionRefusalReason;
  readonly message: string;
}

export interface KindCorrectionRequest {
  /** What the ledger holds now. */
  readonly currentRelationshipType: string;
  readonly state: ExpenseState;
  /** What the person saw when they chose to correct it. */
  readonly expectedRelationshipType: string;
  /** What they are correcting it to. */
  readonly targetRelationshipType: string;
}

/** Words for a kind, as the screens use them. */
export function relationshipTypeWords(kind: string): string {
  switch (kind) {
    case 'personal':
      return 'just yours';
    case 'shared':
      return 'shared';
    case 'paid_on_behalf':
      return 'paid on somebody else’s behalf';
    case 'household_shared_flat':
      return 'a shared household cost';
    case 'gift':
      return 'a gift';
    default:
      return kind.replace(/_/g, ' ');
  }
}

export function isDebtCreatingRelationshipType(kind: string): kind is DebtCreatingRelationshipType {
  return (DEBT_CREATING_RELATIONSHIP_TYPES as readonly string[]).includes(kind);
}

/**
 * The kinds this expense could be corrected to right now — empty when no correction is open.
 *
 * What a read surface sends so a screen offers the action only where the ledger would accept it,
 * rather than re-deciding the rule in the browser. It is advice, not a gate: the service checks
 * again, under a lock, when the correction is actually asked for.
 */
export function kindCorrectionTargets(expense: {
  readonly relationshipType: string;
  readonly state: ExpenseState;
}): readonly DebtCreatingRelationshipType[] {
  if (expense.relationshipType !== KIND_CORRECTABLE_FROM) return [];
  if (!KIND_CORRECTABLE_STATES.includes(expense.state)) return [];
  return DEBT_CREATING_RELATIONSHIP_TYPES;
}

/**
 * Why this correction cannot be made, or `null` when it can.
 *
 * Checked in a fixed order so the most useful answer wins: a request against a kind the ledger no
 * longer holds is told that first, because everything else it might be told is about a state it
 * did not see.
 */
export function checkKindCorrection(request: KindCorrectionRequest): KindCorrectionRefusal | null {
  const { currentRelationshipType: current, state } = request;

  if (request.expectedRelationshipType !== current) {
    return {
      reason: 'kind_changed_since_read',
      message:
        `This expense is now recorded as ${relationshipTypeWords(current)}, not ` +
        `${relationshipTypeWords(request.expectedRelationshipType)} as when you looked, so nothing ` +
        'was changed. Look at it again before deciding.',
    };
  }

  if (current !== KIND_CORRECTABLE_FROM) {
    return {
      reason: 'not_personal',
      message:
        `This expense is recorded as ${relationshipTypeWords(current)}. Only an expense approved as ` +
        'just yours can be corrected to one other people shared; to change who shares it, change ' +
        'its split instead.',
    };
  }

  if (state === 'proposed' || state === 'classified' || state === 'review_required') {
    return {
      reason: 'not_yet_approved',
      message:
        'This expense has not been approved yet, so who it was for is still being chosen: answer ' +
        'its question in Needs attention instead.',
    };
  }

  if (!KIND_CORRECTABLE_STATES.includes(state)) {
    return {
      reason: 'closed',
      message:
        state === 'rejected'
          ? 'This expense was declined, so it counts for nothing and there is nothing to correct.'
          : `This expense is "${state.replace(/_/g, ' ')}", so it is closed history and its kind ` +
            'can no longer be corrected here.',
    };
  }

  if (!isDebtCreatingRelationshipType(request.targetRelationshipType)) {
    return {
      reason: 'target_not_debt_creating',
      message:
        `"${relationshipTypeWords(request.targetRelationshipType)}" is not a kind other people ` +
        'share. A correction from just yours is to shared, paid on somebody else’s behalf, or a ' +
        'shared household cost.',
    };
  }

  return null;
}
