/**
 * The Splitwise port: what a caller in `src/services` needs, and nothing about how a real
 * Splitwise account provides it.
 *
 * No concrete adapter is shipped alongside this interface — the same shape ADR-0025 chose for
 * `ModelTransport` ("the model transport is injected; phase 8 wires no provider"). Nothing in
 * this repository has real Splitwise credentials, and `CLAUDE.md` forbids connecting one during
 * development; a real adapter is a later, deliberate decision, not a side effect of this phase.
 *
 * `fetchBalances` is deliberately not part of this interface. `data-flow.md` step 9 assigns
 * drift detection to `services.runReconciliation` (phase 15) — adding the method here now would
 * be surface nothing in this phase calls.
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

/**
 * Injected into the services that need it rather than imported, so a test runs against a
 * scripted mock and a real adapter — once one is deliberately wired — is a different injection,
 * not a different code path.
 */
export interface SplitwisePort {
  createExpense(input: CreateSplitwiseExpenseInput): Promise<CreateSplitwiseExpenseResult>;
  recordPayment(input: RecordSplitwisePaymentInput): Promise<RecordSplitwisePaymentResult>;
}
