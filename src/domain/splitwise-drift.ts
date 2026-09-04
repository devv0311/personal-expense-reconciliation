/**
 * Splitwise drift detection — comparing this ledger's own `NetBalance(user, friend)` against
 * what Splitwise reports for the same pair (`docs/roadmap.md` phase 15, ADR-0041).
 *
 * Deliberately the smallest possible pure function: an exact `bigint` equality check, no
 * tolerance. Both sides are exact integer minor units — this ledger's own arithmetic never
 * rounds via anything but the Largest Remainder Method (`invariants.md` #12) — so any
 * disagreement, however small, is a real, structural gap worth surfacing rather than a rounding
 * artifact to absorb.
 */

import type { ReconciliationDiscrepancy } from './entities.js';
import type { PersonId } from './ids.js';
import type { Paise } from './money.js';

export interface CompareSplitwiseBalanceInput {
  /** `domain.computeNetBalance(userPersonId, friendPersonId)` — positive means the user owes. */
  readonly ourNetBalance: Paise;
  /** `SplitwisePort.fetchBalances()`'s entry for this friend, same sign convention. */
  readonly theirNetBalance: Paise;
  readonly userPersonId: PersonId;
  readonly friendPersonId: PersonId;
}

/**
 * `null` when the two ledgers agree exactly; otherwise a `ReconciliationDiscrepancy` naming the
 * pair and what Splitwise reported.
 */
export function compareSplitwiseBalance(
  input: CompareSplitwiseBalanceInput,
): ReconciliationDiscrepancy | null {
  if (input.ourNetBalance === input.theirNetBalance) return null;

  return {
    kind: 'splitwise_balance_mismatch',
    detail:
      `This ledger computes NetBalance(user, friend) = ${input.ourNetBalance} paise, but ` +
      `Splitwise reports ${input.theirNetBalance} paise for the same pair.`,
    personAId: input.userPersonId,
    personBId: input.friendPersonId,
    externalNetBalance: input.theirNetBalance,
  };
}
