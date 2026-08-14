/**
 * Group-beneficiary allocation expansion (ADR-0009).
 *
 * A `Group` is a data-entry convenience and never a debtor or a creditor: real money
 * moves between people, and Splitwise's API has no concept of a group debtor. So a
 * `group`-typed `AllocationLine` is resolved, once, into one row per individual member —
 * `AllocationLineGroupExpansion` — at the moment the allocation is approved.
 *
 * Two properties matter and are enforced here:
 *
 *  1. Membership is resolved **as of `Expense.occurredAt`**, never "today", so a later
 *     move-in/move-out cannot retroactively change who owed what.
 *  2. The result is a snapshot: this function is called once, at approval, and its output
 *     is never recomputed (`scenario-analysis.md` §33). The "never recomputed" half is a
 *     property of the caller — `services` writes these rows once and `src/db` gives the
 *     table no `updated_at` — but the determinism that makes it safe lives here.
 */

import type { GroupMembership } from './entities.js';
import { DomainError } from './errors.js';
import type { GroupId, PersonId } from './ids.js';
import type { Paise } from './money.js';
import { sumPaise } from './money.js';
import { splitByLargestRemainder } from './rounding.js';
import type { SplitWeight } from './rounding.js';

/** One resolved member's individual share of a group line. */
export interface GroupExpansionRow {
  readonly personId: PersonId;
  readonly amount: Paise;
}

/** Input to a group-line expansion. */
export interface GroupExpansionInput {
  /** The parent `AllocationLine.amount` being divided. */
  readonly lineAmount: Paise;
  /** Members resolved as of the expense date — see {@link resolveGroupMembersAsOf}. */
  readonly members: readonly PersonId[];
  /**
   * Optional per-member weights. Absent means an equal split; present means the user made
   * an explicit, one-time distribution decision at the same approval step (ADR-0009).
   * Must cover exactly the resolved member set.
   */
  readonly shareWeights?: ReadonlyArray<{ readonly personId: PersonId; readonly weight: bigint }>;
}

/**
 * Whether a membership stint covers an instant.
 *
 * The interval is half-open, `[joinedAt, leftAt)`: someone is a member on the instant they
 * join and is not on the instant they leave. That makes the two stints of a person who
 * leaves and re-joins non-overlapping by construction, so no instant can ever resolve one
 * person twice.
 */
export function isGroupMembershipActiveAt(membership: GroupMembership, at: Date): boolean {
  if (membership.joinedAt.getTime() > at.getTime()) return false;
  if (membership.leftAt === null) return true;
  return membership.leftAt.getTime() > at.getTime();
}

/**
 * Resolves a group's members as of a given instant, ascending by `person_id`.
 *
 * The ordering is deliberate: it makes the resolved set — and therefore the expansion
 * built from it — independent of the order rows came back from the database.
 */
export function resolveGroupMembersAsOf(
  memberships: readonly GroupMembership[],
  groupId: GroupId,
  asOf: Date,
): readonly PersonId[] {
  const active = new Set<PersonId>();
  for (const membership of memberships) {
    if (membership.groupId !== groupId) continue;
    if (!isGroupMembershipActiveAt(membership, asOf)) continue;
    active.add(membership.personId);
  }
  return [...active].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Divides a `group`-typed line's amount across its resolved members.
 *
 * Uses the same Largest Remainder Method as every other split (`invariants.md` #12), with
 * `person_id` as the tie-break key.
 */
export function expandGroupAllocationLine(
  input: GroupExpansionInput,
): readonly GroupExpansionRow[] {
  if (input.members.length === 0) {
    throw new DomainError(
      'GROUP_EXPANSION_NO_MEMBERS',
      'A group-typed allocation line resolved to no members as of the expense date. A group ' +
        'line cannot be expanded into individual obligations without at least one member ' +
        '(ADR-0009); allocate to individual beneficiaries instead.',
    );
  }

  const seen = new Set<PersonId>();
  for (const personId of input.members) {
    if (seen.has(personId)) {
      throw new DomainError(
        'ALLOCATION_SHAPE_INVALID',
        `Person ${personId} appears twice in the resolved member set.`,
        { personId },
      );
    }
    seen.add(personId);
  }

  const weights: SplitWeight[] = input.members.map((personId) => ({
    key: personId,
    weight: resolveWeight(personId, input.members, input.shareWeights),
  }));

  const shares = splitByLargestRemainder(input.lineAmount, weights);
  return input.members.map((personId, index) => {
    const share = shares[index];
    /* c8 ignore next 3 -- unreachable: one share is returned per member, in order. */
    if (share === undefined) {
      throw new DomainError('SPLIT_INVALID_INPUT', `No share computed for member ${personId}.`);
    }
    return { personId, amount: share.amount };
  });
}

/**
 * Invariant #2b: a `group`-typed line's expansion rows must exist and must sum to that
 * line's own amount before the expense can be considered `ALLOCATED`.
 */
export function validateGroupExpansionSum(
  lineAmount: Paise,
  rows: readonly GroupExpansionRow[],
): void {
  if (rows.length === 0) {
    throw new DomainError(
      'GROUP_EXPANSION_MISSING',
      'A group-typed allocation line has no AllocationLineGroupExpansion rows. Balance and ' +
        'Splitwise sync read only the expansion, never the raw group line, so an unexpanded ' +
        'group line would silently contribute no obligation at all (invariants.md #2b).',
    );
  }
  const rowSum = sumPaise(rows.map((row) => row.amount));
  if (rowSum !== lineAmount) {
    throw new DomainError(
      'ALLOCATION_SUM_MISMATCH',
      `Group expansion rows sum to ${rowSum} paise but the group line is ${lineAmount} paise ` +
        '(invariants.md #2b).',
      { rowSum: rowSum.toString(), lineAmount: lineAmount.toString() },
    );
  }
}

/* ------------------------------------------------------------------------- internals */

function resolveWeight(
  personId: PersonId,
  members: readonly PersonId[],
  shareWeights: GroupExpansionInput['shareWeights'],
): bigint {
  if (shareWeights === undefined) return 1n;

  if (shareWeights.length !== members.length) {
    throw new DomainError(
      'ALLOCATION_SHAPE_INVALID',
      `Group expansion overrides cover ${shareWeights.length} people but the group resolved ` +
        `to ${members.length} members as of the expense date. An override must name every ` +
        'resolved member, so no member is silently dropped.',
      { overrides: String(shareWeights.length), members: String(members.length) },
    );
  }
  const memberSet = new Set(members);
  for (const override of shareWeights) {
    if (!memberSet.has(override.personId)) {
      throw new DomainError(
        'ALLOCATION_SHAPE_INVALID',
        `Group expansion override names ${override.personId}, who was not a member as of the ` +
          'expense date.',
        { personId: override.personId },
      );
    }
  }
  const found = shareWeights.find((override) => override.personId === personId);
  /* c8 ignore next 3 -- unreachable: counts match and every override is a member. */
  if (found === undefined) {
    throw new DomainError('ALLOCATION_SHAPE_INVALID', `No override weight for ${personId}.`);
  }
  return found.weight;
}
