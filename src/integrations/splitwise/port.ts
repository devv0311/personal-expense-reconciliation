/**
 * The Splitwise port: what a caller in `src/services` needs, and nothing about how a real
 * Splitwise account provides it.
 *
 * No concrete adapter is shipped alongside this interface — the same shape ADR-0025 chose for
 * `ModelTransport` ("the model transport is injected; phase 8 wires no provider"). Nothing in
 * this repository has real Splitwise credentials, and `CLAUDE.md` forbids connecting one during
 * development; a real adapter is a later, deliberate decision, not a side effect of this phase.
 *
 * `fetchBalances` (phase 15, ADR-0041) is scoped to the connected account's own friends list —
 * what Splitwise's real "get friends" call actually returns, one reported balance per friend,
 * relative to the authenticated account. `services.runReconciliation` is its only caller: it
 * compares each entry against `domain.computeNetBalance(userPersonId, friendId)` and surfaces
 * any disagreement as a `ReconciliationDiscrepancy` — never a write back to Splitwise.
 *
 * Every id crossing this port is `people.splitwise_user_id` — the mapping already stored on
 * `Person`, never looked up a second way.
 */

import type { Paise } from '../../domain/index.js';

/** One beneficiary's resolved share, already expanded past any `group`-typed line. */
export interface SplitwiseExpenseShare {
  readonly splitwiseUserId: string;
  readonly owedAmount: Paise;
}

export interface CreateSplitwiseExpenseInput {
  readonly description: string | null;
  /** The expense's current `netAmount`, never the gross figure. */
  readonly amount: Paise;
  readonly currency: string;
  readonly paidBySplitwiseUserId: string;
  /** Every resolved beneficiary — a `group`-typed line's members, never the group itself. */
  readonly shares: readonly SplitwiseExpenseShare[];
}

export interface CreateSplitwiseExpenseResult {
  readonly splitwiseExpenseId: string;
  /** Whatever Splitwise's response contained, kept as `splitwise_expenses.their_snapshot`. */
  readonly theirSnapshot: unknown;
}

export interface RecordSplitwisePaymentInput {
  readonly amount: Paise;
  readonly fromSplitwiseUserId: string;
  readonly toSplitwiseUserId: string;
}

export interface RecordSplitwisePaymentResult {
  readonly splitwiseTransactionId: string;
  readonly theirSnapshot: unknown;
}

/** One friend's balance with the connected account, as Splitwise currently reports it. */
export interface SplitwiseFriendBalance {
  readonly splitwiseUserId: string;
  /**
   * Positive: the connected account owes this friend. Negative: this friend owes the connected
   * account. The same sign convention `domain.computeNetBalance(userPersonId, friendId)` uses,
   * so a caller can compare the two directly with no sign-flip.
   */
  readonly netBalance: Paise;
}

/**
 * Injected into the services that need it rather than imported, so a test runs against a
 * scripted mock and a real adapter — once one is deliberately wired — is a different injection,
 * not a different code path.
 */
export interface SplitwisePort {
  createExpense(input: CreateSplitwiseExpenseInput): Promise<CreateSplitwiseExpenseResult>;
  recordPayment(input: RecordSplitwisePaymentInput): Promise<RecordSplitwisePaymentResult>;
  /** Every friend of the connected account, and what Splitwise currently reports owing each. */
  fetchBalances(): Promise<readonly SplitwiseFriendBalance[]>;
}
