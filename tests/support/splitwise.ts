/**
 * An in-memory `SplitwisePort`, deterministic and synchronous underneath its `Promise`s.
 *
 * The same shape as `tests/support/evidence-store.ts`: no real adapter exists yet (ADR-0025's
 * precedent — no provider wired), so everything above the port is exercised without a network
 * call. Ids are assigned in call order (`sw-expense-1`, `sw-expense-2`, …) so a test can assert
 * exactly which one a row recorded rather than pattern-matching a random value.
 */

import type {
  CreateSplitwiseExpenseInput,
  CreateSplitwiseExpenseResult,
  DeleteSplitwiseEntryInput,
  DeleteSplitwiseEntryResult,
  FetchSplitwiseLedgerEntriesInput,
  FetchSplitwiseLedgerEntriesResult,
  RecordSplitwisePaymentInput,
  RecordSplitwisePaymentResult,
  SplitwiseFriendBalance,
  SplitwiseLedgerEntry,
  SplitwisePort,
  UpdateSplitwiseExpenseInput,
  UpdateSplitwiseExpenseResult,
  UpdateSplitwisePaymentInput,
  UpdateSplitwisePaymentResult,
} from '../../src/integrations/splitwise/index.js';

export interface MockSplitwisePort extends SplitwisePort {
  /** Every `createExpense` call this port received, in order. */
  readonly createdExpenses: readonly CreateSplitwiseExpenseInput[];
  /** Every `recordPayment` call this port received, in order. */
  readonly recordedPayments: readonly RecordSplitwisePaymentInput[];
  /** Every `fetchLedgerEntries` call, so a test can prove a read happened — or did not. */
  readonly ledgerReads: readonly FetchSplitwiseLedgerEntriesInput[];
  /** Every in-place correction (ADR-0055), so a test can prove the id did not move. */
  readonly updatedExpenses: readonly UpdateSplitwiseExpenseInput[];
  /** Every deletion — which must only ever happen for an expense whose net reached zero. */
  readonly deletedEntries: readonly DeleteSplitwiseEntryInput[];
  /** Every settlement correction. */
  readonly updatedPayments: readonly UpdateSplitwisePaymentInput[];
}

/**
 * A port that always succeeds, echoing the input back as `theirSnapshot`.
 *
 * `failNextCreateExpense`/`failNextRecordPayment` make exactly the next call reject, for the
 * "the port fails and no row is left behind" test — after which the port returns to succeeding.
 * `setFriendBalances` scripts what `fetchBalances()` returns (empty until set, matching a
 * connected account with a not-yet-fetched or empty friends list — phase 15, ADR-0041).
 */
export function createMockSplitwisePort(): MockSplitwisePort & {
  failNextCreateExpense: (message: string) => void;
  failNextRecordPayment: (message: string) => void;
  failNextFetchBalances: (message: string) => void;
  failNextFetchLedgerEntries: (message: string) => void;
  failNextUpdateExpense: (message: string) => void;
  failNextDeleteEntry: (message: string) => void;
  failNextUpdatePayment: (message: string) => void;
  /**
   * Makes the next `updateExpense` answer with a *different* id — a Splitwise that duplicated
   * rather than corrected. The one remote misbehaviour the repair must refuse to record.
   */
  answerNextUpdateWithDifferentId: (id: string) => void;
  setFriendBalances: (balances: readonly SplitwiseFriendBalance[]) => void;
  setLedgerEntries: (
    friendSplitwiseUserId: string,
    entries: readonly SplitwiseLedgerEntry[],
    options?: { readonly complete?: boolean; readonly incompleteReason?: string },
  ) => void;
} {
  const createdExpenses: CreateSplitwiseExpenseInput[] = [];
  const recordedPayments: RecordSplitwisePaymentInput[] = [];
  const ledgerReads: FetchSplitwiseLedgerEntriesInput[] = [];
  const updatedExpenses: UpdateSplitwiseExpenseInput[] = [];
  const deletedEntries: DeleteSplitwiseEntryInput[] = [];
  const updatedPayments: UpdateSplitwisePaymentInput[] = [];
  let expenseCounter = 0;
  let paymentCounter = 0;
  let nextCreateExpenseFailure: string | null = null;
  let nextRecordPaymentFailure: string | null = null;
  let nextFetchBalancesFailure: string | null = null;
  let nextFetchLedgerEntriesFailure: string | null = null;
  let nextUpdateExpenseFailure: string | null = null;
  let nextDeleteEntryFailure: string | null = null;
  let nextUpdatePaymentFailure: string | null = null;
  let nextUpdateExpenseId: string | null = null;
  let friendBalances: readonly SplitwiseFriendBalance[] = [];
  const ledgerEntries = new Map<
    string,
    { entries: readonly SplitwiseLedgerEntry[]; complete: boolean; incompleteReason?: string }
  >();

  return {
    createdExpenses,
    recordedPayments,
    ledgerReads,
    updatedExpenses,
    deletedEntries,
    updatedPayments,

    failNextCreateExpense: (message: string) => {
      nextCreateExpenseFailure = message;
    },
    failNextUpdateExpense: (message: string) => {
      nextUpdateExpenseFailure = message;
    },
    failNextDeleteEntry: (message: string) => {
      nextDeleteEntryFailure = message;
    },
    failNextUpdatePayment: (message: string) => {
      nextUpdatePaymentFailure = message;
    },
    answerNextUpdateWithDifferentId: (id: string) => {
      nextUpdateExpenseId = id;
    },
    failNextRecordPayment: (message: string) => {
      nextRecordPaymentFailure = message;
    },
    failNextFetchBalances: (message: string) => {
      nextFetchBalancesFailure = message;
    },
    failNextFetchLedgerEntries: (message: string) => {
      nextFetchLedgerEntriesFailure = message;
    },
    setFriendBalances: (balances: readonly SplitwiseFriendBalance[]) => {
      friendBalances = balances;
    },
    setLedgerEntries: (
      friendSplitwiseUserId: string,
      entries: readonly SplitwiseLedgerEntry[],
      options: { complete?: boolean; incompleteReason?: string } = {},
    ) => {
      ledgerEntries.set(friendSplitwiseUserId, {
        entries,
        complete: options.complete ?? true,
        ...(options.incompleteReason === undefined
          ? {}
          : { incompleteReason: options.incompleteReason }),
      });
    },

    fetchLedgerEntries(
      input: FetchSplitwiseLedgerEntriesInput,
    ): Promise<FetchSplitwiseLedgerEntriesResult> {
      ledgerReads.push(input);
      if (nextFetchLedgerEntriesFailure !== null) {
        const message = nextFetchLedgerEntriesFailure;
        nextFetchLedgerEntriesFailure = null;
        return Promise.reject(new Error(message));
      }
      const scripted = ledgerEntries.get(input.friendSplitwiseUserId);
      return Promise.resolve(
        scripted === undefined
          ? { entries: [], complete: true }
          : {
              entries: scripted.entries,
              complete: scripted.complete,
              ...(scripted.incompleteReason === undefined
                ? {}
                : { incompleteReason: scripted.incompleteReason }),
            },
      );
    },

    fetchBalances(): Promise<readonly SplitwiseFriendBalance[]> {
      if (nextFetchBalancesFailure !== null) {
        const message = nextFetchBalancesFailure;
        nextFetchBalancesFailure = null;
        return Promise.reject(new Error(message));
      }
      return Promise.resolve(friendBalances);
    },

    createExpense(input: CreateSplitwiseExpenseInput): Promise<CreateSplitwiseExpenseResult> {
      createdExpenses.push(input);
      if (nextCreateExpenseFailure !== null) {
        const message = nextCreateExpenseFailure;
        nextCreateExpenseFailure = null;
        return Promise.reject(new Error(message));
      }
      expenseCounter += 1;
      return Promise.resolve({
        splitwiseExpenseId: `sw-expense-${expenseCounter}`,
        theirSnapshot: { echoedInput: toJsonSafe(input) },
      });
    },

    updateExpense(input: UpdateSplitwiseExpenseInput): Promise<UpdateSplitwiseExpenseResult> {
      updatedExpenses.push(input);
      if (nextUpdateExpenseFailure !== null) {
        const message = nextUpdateExpenseFailure;
        nextUpdateExpenseFailure = null;
        return Promise.reject(new Error(message));
      }
      // The id comes back unchanged unless a test has scripted the misbehaviour: a correction
      // that answers with a new id is a duplicate, and the service must refuse to record it.
      const answeredId = nextUpdateExpenseId ?? input.splitwiseExpenseId;
      nextUpdateExpenseId = null;
      return Promise.resolve({
        splitwiseExpenseId: answeredId,
        theirSnapshot: { echoedInput: toJsonSafe(input) },
      });
    },

    deleteEntry(input: DeleteSplitwiseEntryInput): Promise<DeleteSplitwiseEntryResult> {
      deletedEntries.push(input);
      if (nextDeleteEntryFailure !== null) {
        const message = nextDeleteEntryFailure;
        nextDeleteEntryFailure = null;
        return Promise.reject(new Error(message));
      }
      return Promise.resolve({
        splitwiseEntryId: input.splitwiseEntryId,
        theirSnapshot: { deleted: true },
      });
    },

    recordPayment(input: RecordSplitwisePaymentInput): Promise<RecordSplitwisePaymentResult> {
      recordedPayments.push(input);
      if (nextRecordPaymentFailure !== null) {
        const message = nextRecordPaymentFailure;
        nextRecordPaymentFailure = null;
        return Promise.reject(new Error(message));
      }
      paymentCounter += 1;
      return Promise.resolve({
        splitwiseTransactionId: `sw-payment-${paymentCounter}`,
        theirSnapshot: { echoedInput: toJsonSafe(input) },
      });
    },

    updatePayment(input: UpdateSplitwisePaymentInput): Promise<UpdateSplitwisePaymentResult> {
      updatedPayments.push(input);
      if (nextUpdatePaymentFailure !== null) {
        const message = nextUpdatePaymentFailure;
        nextUpdatePaymentFailure = null;
        return Promise.reject(new Error(message));
      }
      return Promise.resolve({
        splitwiseTransactionId: input.splitwiseTransactionId,
        theirSnapshot: { echoedInput: toJsonSafe(input) },
      });
    },
  };
}

/**
 * A port that can create but **not** correct — an adapter with first-sync writes only.
 *
 * The mirror of `createAggregateOnlySplitwisePort` on the write side (ADR-0055): "this adapter
 * cannot edit an entry in place" has to be representable, so the repair can refuse by name
 * instead of quietly falling back to creating a second entry.
 */
export function createFirstSyncOnlySplitwisePort(): SplitwisePort & {
  readonly createdExpenses: readonly CreateSplitwiseExpenseInput[];
} {
  const full = createMockSplitwisePort();
  return {
    createdExpenses: full.createdExpenses,
    createExpense: full.createExpense.bind(full),
    recordPayment: full.recordPayment.bind(full),
    fetchBalances: full.fetchBalances.bind(full),
  };
}

/**
 * A real Splitwise response is plain JSON — never a `bigint` — so `theirSnapshot` never needs
 * to carry one either. Converts every `bigint` in the echoed input to its decimal string, the
 * same discipline every other boundary in this codebase uses for money (`invariants.md` #12).
 */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry)]),
    );
  }
  return value;
}

/**
 * A port with **no** `fetchLedgerEntries` at all — an adapter that cannot list a pair's
 * entries.
 *
 * The point of the optional method (ADR-0046): "the capability does not exist" has to be
 * representable, so the audit can record `unsupported` instead of reading a silent adapter as
 * a Splitwise holding nothing.
 */
export function createAggregateOnlySplitwisePort(): SplitwisePort & {
  setFriendBalances: (balances: readonly SplitwiseFriendBalance[]) => void;
} {
  const full = createMockSplitwisePort();
  return {
    createExpense: full.createExpense.bind(full),
    recordPayment: full.recordPayment.bind(full),
    fetchBalances: full.fetchBalances.bind(full),
    setFriendBalances: full.setFriendBalances,
  };
}
