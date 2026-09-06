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
 * `fetchLedgerEntries` (phase 19, ADR-0046) is the finer read beside it, and is **optional**:
 * an adapter that cannot list a pair's entries omits it, and the audit records `unsupported`
 * rather than treating a capability it does not have as agreement.
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
 * One entry as Splitwise currently holds it, scoped to one friend of the connected account
 * (phase 19, ADR-0046).
 *
 * Read-only, like `fetchBalances`. Splitwise's own two kinds are modelled directly: an
 * `expense` is a shared cost, a `payment` is a settlement between two people.
 */
export interface SplitwiseLedgerEntry {
  /** Splitwise's own id — the same value `splitwise_expenses.splitwise_expense_id` stores. */
  readonly splitwiseEntryId: string;
  readonly kind: 'expense' | 'payment';
  readonly description: string | null;
  /** The entry's own total cost, exact minor units. */
  readonly totalAmount: Paise;
  readonly currency: string;
  /** True when Splitwise holds the entry but has it marked deleted. */
  readonly deleted: boolean;
  readonly occurredAt: Date | null;
  /**
   * This entry's own contribution to the balance between the connected account and the friend
   * the read was scoped to, in `SplitwiseFriendBalance`'s sign convention: positive means the
   * connected account owes the friend.
   *
   * Splitwise's friends-list balance is the sum of these over the friend's non-deleted
   * entries, so comparing entry by entry and comparing the reported total are the same
   * arithmetic at two granularities — which is what lets an audit check its own completeness
   * (`domain.auditSplitwisePair`) rather than assume it.
   */
  readonly pairNetBalance: Paise;
}

export interface FetchSplitwiseLedgerEntriesInput {
  /** `people.splitwise_user_id` of the friend whose shared entries to read. */
  readonly friendSplitwiseUserId: string;
}

export interface FetchSplitwiseLedgerEntriesResult {
  readonly entries: readonly SplitwiseLedgerEntry[];
  /**
   * Whether this is every entry Splitwise holds for the pair.
   *
   * `false` — a truncated page, a window the adapter could not widen — makes the read a
   * **partial** one, under which the absence of an entry proves nothing. The audit will not
   * report anything as missing from a partial listing (ADR-0046).
   */
  readonly complete: boolean;
  /** Why the read was incomplete, when it was. Recorded verbatim on the finding. */
  readonly incompleteReason?: string;
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
  /**
   * The finer, per-entry read phase 19's auditing engine attributes drift with — **optional
   * by design** (ADR-0046).
   *
   * `fetchBalances` alone is aggregate: it can say the two ledgers disagree about a pair, and
   * never which record caused it. Naming a culprit — a missing external expense, a duplicated
   * one, a settlement Splitwise never received — needs the entries themselves. An adapter that
   * cannot provide them simply omits this method, and `services.runSplitwiseAudit` records the
   * audit as `unsupported`: findings stay at aggregate scope and say so, rather than the
   * missing capability quietly reading as agreement.
   *
   * Read-only. Nothing in phase 19 writes to Splitwise; re-sync of a `stale` row remains
   * separately scoped work (ADR-0040, ADR-0041).
   */
  fetchLedgerEntries?(
    input: FetchSplitwiseLedgerEntriesInput,
  ): Promise<FetchSplitwiseLedgerEntriesResult>;
}
