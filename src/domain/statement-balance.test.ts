/**
 * Whether a statement's own printed balances prove every movement on it was read, and read the
 * right way round.
 *
 * Every row here is invented: round amounts on made-up days, chosen to be obviously not a real
 * ledger's. The tests that matter most are the refusals — a movement that was never read, one
 * read backwards, one read at the wrong size — because each of those would otherwise import as a
 * statement that looks complete.
 */

import { describe, expect, it } from 'vitest';

import { paise } from './money.js';
import type { Paise } from './money.js';
import { reconcilePrintedBalancesByDay } from './statement-balance.js';
import type { PrintedBalanceRow } from './statement-balance.js';

const rupees = (value: number): Paise => paise(BigInt(Math.round(value * 100)));

function row(
  day: number,
  amount: number,
  direction: 'debit' | 'credit',
  printedBalance: number,
): PrintedBalanceRow {
  return {
    occurredAt: new Date(Date.UTC(2026, 0, day)),
    amount: rupees(amount),
    direction,
    printedBalance: rupees(printedBalance),
  };
}

describe('reconcilePrintedBalancesByDay', () => {
  it('accepts a statement whose balance follows every row', () => {
    const verdict = reconcilePrintedBalancesByDay(rupees(1000), [
      row(1, 200, 'debit', 800),
      row(1, 50, 'credit', 850),
      row(2, 100, 'debit', 750),
    ]);
    expect(verdict).toEqual({ ok: true, daysReconciled: 2, rowsOutOfBankOrder: 0 });
  });

  it('accepts a day the bank balanced in a different order from the one it printed', () => {
    // Printed: a debit, then a credit of the same size. The bank applied the credit first, so
    // the first row's printed balance went *up*. Row by row that looks backwards; the day still
    // closes exactly, which is what proves nothing was misread.
    const verdict = reconcilePrintedBalancesByDay(rupees(1000), [
      row(1, 300, 'debit', 1300),
      row(1, 300, 'credit', 1000),
      row(2, 100, 'debit', 900),
    ]);
    expect(verdict).toEqual({ ok: true, daysReconciled: 2, rowsOutOfBankOrder: 2 });
  });

  it('refuses a day that is missing a movement', () => {
    // The day printed a closing balance of 700, but only 200 of the 300 that left was read.
    const verdict = reconcilePrintedBalancesByDay(rupees(1000), [
      row(1, 100, 'debit', 900),
      row(2, 200, 'debit', 700),
      row(3, 50, 'credit', 750),
    ]);
    expect(verdict.ok).toBe(true);

    const short = reconcilePrintedBalancesByDay(rupees(1000), [
      row(1, 100, 'debit', 900),
      // A 100 debit on day 2 was never read; the printed balance still says 700.
      row(2, 100, 'debit', 700),
      row(3, 50, 'credit', 750),
    ]);
    expect(short).toEqual({
      ok: false,
      reason: 'day_does_not_reconcile',
      failingRun: { firstRowIndex: 1, lastRowIndex: 1 },
    });
  });

  it('refuses a movement read the wrong way round', () => {
    const verdict = reconcilePrintedBalancesByDay(rupees(1000), [
      row(1, 200, 'credit', 800),
      row(2, 100, 'debit', 700),
    ]);
    expect(verdict).toMatchObject({ ok: false, failingRun: { firstRowIndex: 0, lastRowIndex: 0 } });
  });

  it('refuses an amount read at the wrong size, down to a single paisa', () => {
    const verdict = reconcilePrintedBalancesByDay(rupees(1000), [row(1, 199.99, 'debit', 800)]);
    expect(verdict.ok).toBe(false);
  });

  it('carries each day from the balance the statement printed, not from its own running sum', () => {
    // A failure on day 1 must not be reported again on day 2: day 2 opens from what day 1
    // printed, so exactly one run is named.
    const verdict = reconcilePrintedBalancesByDay(rupees(1000), [
      row(1, 100, 'debit', 800),
      row(2, 100, 'debit', 700),
    ]);
    expect(verdict).toMatchObject({ ok: false, failingRun: { firstRowIndex: 0, lastRowIndex: 0 } });
  });

  it('reads an overdrawn account without treating a negative balance as unreadable', () => {
    const verdict = reconcilePrintedBalancesByDay(rupees(100), [
      row(1, 250, 'debit', -150),
      row(2, 400, 'credit', 250),
    ]);
    expect(verdict).toEqual({ ok: true, daysReconciled: 2, rowsOutOfBankOrder: 0 });
  });

  it('checks a back-dated row printed out of date order as a day of its own', () => {
    const verdict = reconcilePrintedBalancesByDay(rupees(1000), [
      row(2, 100, 'debit', 900),
      row(1, 50, 'credit', 950),
      row(2, 25, 'debit', 925),
    ]);
    expect(verdict).toEqual({ ok: true, daysReconciled: 3, rowsOutOfBankOrder: 0 });
  });

  it('has nothing to disprove on a statement with no movements', () => {
    expect(reconcilePrintedBalancesByDay(rupees(1000), [])).toEqual({
      ok: true,
      daysReconciled: 0,
      rowsOutOfBankOrder: 0,
    });
  });
});
