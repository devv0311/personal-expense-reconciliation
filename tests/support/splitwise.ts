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
  RecordSplitwisePaymentInput,
  RecordSplitwisePaymentResult,
  SplitwisePort,
} from '../../src/integrations/splitwise/index.js';

export interface MockSplitwisePort extends SplitwisePort {
  /** Every `createExpense` call this port received, in order. */
  readonly createdExpenses: readonly CreateSplitwiseExpenseInput[];
  /** Every `recordPayment` call this port received, in order. */
  readonly recordedPayments: readonly RecordSplitwisePaymentInput[];
}

/**
 * A port that always succeeds, echoing the input back as `theirSnapshot`.
 *
 * `failNextCreateExpense`/`failNextRecordPayment` make exactly the next call reject, for the
 * "the port fails and no row is left behind" test — after which the port returns to succeeding.
 */
export function createMockSplitwisePort(): MockSplitwisePort & {
  failNextCreateExpense: (message: string) => void;
  failNextRecordPayment: (message: string) => void;
} {
  const createdExpenses: CreateSplitwiseExpenseInput[] = [];
  const recordedPayments: RecordSplitwisePaymentInput[] = [];
  let expenseCounter = 0;
  let paymentCounter = 0;
  let nextCreateExpenseFailure: string | null = null;
  let nextRecordPaymentFailure: string | null = null;

  return {
    createdExpenses,
    recordedPayments,

    failNextCreateExpense: (message: string) => {
      nextCreateExpenseFailure = message;
    },
    failNextRecordPayment: (message: string) => {
      nextRecordPaymentFailure = message;
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
