/**
 * Whether a statement's own printed balances prove every movement on it was read, and read the
 * right way round (ADR-0066).
 *
 * A statement that prints a running balance beside each movement carries its own answer key.
 * Each day opens at the balance printed at the end of the day before, and must close at the
 * balance printed beside its last movement once every credit is added and every debit taken
 * away. A movement the reader skipped, read at the wrong size, or read in the wrong direction
 * breaks that for the day it sits on — so a file that reconciles day by day was read completely,
 * and one that does not is refused rather than imported short.
 *
 * **Why a day and not a row.** Banks print a day's movements in one order and apply them in
 * another: a payment and its same-day reversal may be printed debit-first while the balance
 * column was computed credit-first. Row by row that looks like a movement read backwards; the
 * day still closes to the paisa. Checking rows would refuse a correctly read statement for the
 * bank's bookkeeping, so rows that disagree with their neighbour are *counted* — the caller can
 * say so — and only a day that fails to close is a refusal.
 *
 * A "day" is a run of consecutive rows printed with the same date. A back-dated movement printed
 * out of date order is therefore checked as a run of its own, against the balances around it,
 * rather than being folded into a day it was not printed in.
 */

import type { PaymentDirection } from './enums.js';
import { addPaise, subtractPaise } from './money.js';
import type { Paise } from './money.js';

/** One movement as the statement printed it, with the balance it printed beside it. */
export interface PrintedBalanceRow {
  /** The printed date, at UTC midnight. */
  readonly occurredAt: Date;
  /** Always positive; `direction` carries the sign. */
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  /** Signed: an overdrawn account prints a negative balance, and that is still a balance. */
  readonly printedBalance: Paise;
}

export type PrintedBalanceVerdict =
  | {
      readonly ok: true;
      /** Runs of same-dated rows that closed exactly. */
      readonly daysReconciled: number;
      /**
       * Rows whose printed balance does not follow from the row before by this row's own amount.
       * Not an error — see the module note — but worth saying out loud.
       */
      readonly rowsOutOfBankOrder: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'day_does_not_reconcile';
      /** The first run that failed to close, by row index into the input. */
      readonly failingRun: { readonly firstRowIndex: number; readonly lastRowIndex: number };
    };

/**
 * Checks every run of same-dated rows against the balances the statement printed.
 *
 * Stops at the first run that does not close: each run opens from what the statement printed,
 * not from this function's own arithmetic, so a single misread is named once rather than
 * cascading into every day after it.
 */
export function reconcilePrintedBalancesByDay(
  openingBalance: Paise,
  rows: readonly PrintedBalanceRow[],
): PrintedBalanceVerdict {
  let dayOpening = openingBalance;
  let previousPrinted = openingBalance;
  let daysReconciled = 0;
  let rowsOutOfBankOrder = 0;

  let index = 0;
  while (index < rows.length) {
    const firstRowIndex = index;
    const day = calendarDay(rows[index]!.occurredAt);
    let expected = dayOpening;

    while (index < rows.length && calendarDay(rows[index]!.occurredAt) === day) {
      const current = rows[index]!;
      expected = applyMovement(expected, current);
      if (current.printedBalance !== applyMovement(previousPrinted, current)) {
        rowsOutOfBankOrder += 1;
      }
      previousPrinted = current.printedBalance;
      index += 1;
    }

    const lastRowIndex = index - 1;
    if (expected !== rows[lastRowIndex]!.printedBalance) {
      return {
        ok: false,
        reason: 'day_does_not_reconcile',
        failingRun: { firstRowIndex, lastRowIndex },
      };
    }
    dayOpening = rows[lastRowIndex]!.printedBalance;
    daysReconciled += 1;
  }

  return { ok: true, daysReconciled, rowsOutOfBankOrder };
}

function applyMovement(balance: Paise, row: PrintedBalanceRow): Paise {
  return row.direction === 'credit'
    ? addPaise(balance, row.amount)
    : subtractPaise(balance, row.amount);
}

function calendarDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
