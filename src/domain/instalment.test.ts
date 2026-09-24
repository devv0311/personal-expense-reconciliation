/**
 * Reading an instalment plan out of statement rows, and refusing to invent the rest.
 *
 * Every row below is written for this test. The merchant names are invented, the amounts are
 * round numbers chosen to be obviously not a real ledger's, and the wording follows the *shapes*
 * a card statement uses without quoting any real statement.
 *
 * The tests that matter most are the refusals: no tenure without a printed marker, no expected
 * position beyond what was printed, no due date, and tax that never becomes a purchase.
 */

import { describe, expect, it } from 'vitest';

import { buildInstalmentPlans, paymentsExplainedByPlans, planForPayment } from './instalment.js';
import type { InstalmentSourceRow } from './instalment.js';
import { paise } from './money.js';

let sequence = 0;

function row(
  rawDescription: string,
  amountRupees: number,
  day: number,
  direction: 'debit' | 'credit' = 'debit',
): InstalmentSourceRow {
  sequence += 1;
  return {
    paymentId: `pay-${String(sequence)}`,
    rawDescription,
    direction,
    occurredAt: new Date(Date.UTC(2026, 0, day)),
    amount: paise(BigInt(amountRupees) * 100n),
  };
}

describe('finding a plan at all', () => {
  it('needs a repayment, not just interest, before it calls anything a plan', () => {
    // Interest is a cost *of* a plan, never evidence that one exists. Founding a plan on it would
    // quietly disable the most useful finding the product has — interest with nothing on file
    // explaining it (ADR-0063).
    const plans = buildInstalmentPlans([row('SEAGRASS FURNITURE - INTEREST 4', 900, 5)]);

    expect(plans).toEqual([]);
  });

  it('reads one from the instalment markers the statement printed', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/4>', 2500, 5),
      row('NORTHWIND APPLIANCES - INTEREST 1 - <1/4>', 180, 5),
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <2/4>', 2500, 35),
    ]);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.merchantName).toContain('NORTHWIND');
    expect(plans[0]?.tenure).toEqual({ known: true, of: 4 });
  });

  it('never makes a plan out of a merchant that merely repeats', () => {
    // The whole reason this module groups on nature and not on recurrence. A gym, a rent standing
    // order and a subscription all look like this, and calling one an instalment plan would tell
    // somebody they owe four more payments nobody ever committed to.
    const plans = buildInstalmentPlans([
      row('CITYFIELD GYM', 1200, 1),
      row('CITYFIELD GYM', 1200, 31),
      row('CITYFIELD GYM', 1200, 61),
      row('CITYFIELD GYM', 1200, 91),
    ]);

    expect(plans).toEqual([]);
  });

  it('keeps two merchants’ plans apart', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 5),
      row('SEAGRASS FURNITURE - Principal Amount Amortization - <1/6>', 4000, 6),
    ]);

    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.tenure.of).sort()).toEqual([3, 6]);
  });
});

describe('what the timeline may and may not say', () => {
  it('marks a seen position observed and an unseen one expected, with no figure', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 5),
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <2/3>', 2500, 35),
    ]);
    const positions = plans[0]?.positions ?? [];

    expect(positions.map((position) => position.certainty)).toEqual([
      'observed',
      'observed',
      'expected',
    ]);
    const future = positions[2];
    // The crux: the statement said three, so a third exists. It did not say when or how much.
    expect(future?.principal).toBeNull();
    expect(future?.interest).toBeNull();
    expect(future?.charges).toEqual([]);
  });

  it('emits no expected position at all when no line stated a tenure', () => {
    // Recurrence is not tenure. With nothing printed, the timeline is only what was seen.
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - EMI Principal Amount', 2500, 5),
      row('NORTHWIND APPLIANCES - EMI Principal Amount', 2500, 35),
    ]);

    expect(plans[0]?.tenure).toEqual({ known: false, of: null });
    expect(plans[0]?.positions.every((position) => position.certainty === 'observed')).toBe(true);
    expect(plans[0]?.progress.of).toBeNull();
  });

  it('never emits a position beyond the tenure the statement printed', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 5),
    ]);

    expect(plans[0]?.positions.map((position) => position.number)).toEqual([1, 2, 3]);
  });

  it('refuses a tenure its own lines disagree about, rather than picking one', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 5),
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <2/6>', 2500, 35),
    ]);

    expect(plans[0]?.tenure.known).toBe(false);
    expect(plans[0]?.progress.of).toBeNull();
    expect(plans[0]?.unknowns.join(' ')).toMatch(/disagree/);
  });

  it('says it does not know a due date, on every plan', () => {
    // Unconditional on purpose: it is true of every plan this product will read, and a reader who
    // does not see it stated will assume the absence is an oversight rather than a fact.
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 5),
    ]);

    expect(plans[0]?.unknowns.join(' ')).toMatch(/When the next one is due/);
  });

  it('reports the original purchase as not known, rather than guessing at one', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <2/3>', 2500, 5),
    ]);

    expect(plans[0]?.purchase.known).toBe(false);
    expect(plans[0]?.purchase.amount).toBeNull();
    expect(plans[0]?.unknowns.join(' ')).toMatch(/What was originally bought/);
  });
});

describe('components', () => {
  it('separates principal, interest, tax and fee, and totals only what was observed', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/2>', 2500, 5),
      row('NORTHWIND APPLIANCES - INTEREST 1 - <1/2>', 180, 5),
      row('CGST', 16, 5),
      row('NORTHWIND APPLIANCES - EMI PROCESSING FEE', 500, 5),
    ]);
    const observed = plans[0]?.observed;

    expect(observed?.principal).toBe(250_000n);
    expect(observed?.interest).toBe(18_000n);
    expect(observed?.tax).toBe(1_600n);
    expect(observed?.fee).toBe(50_000n);
  });

  it('attaches a bare tax line to the plan whose interest it was charged on, never to a purchase', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/2>', 2500, 5),
      row('NORTHWIND APPLIANCES - INTEREST 1 - <1/2>', 180, 5),
      row('SGST', 16, 6),
      row('HARBOUR CAFE', 400, 6),
    ]);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.observed.tax).toBe(1_600n);
    // The café is a purchase and stays one; it is nobody's instalment.
    const explained = paymentsExplainedByPlans(plans);
    const cafeRow = 'pay-' + String(sequence);
    expect(explained.has(cafeRow)).toBe(false);
  });

  it('leaves a fee unattached when its wording does not separate the merchant', () => {
    // A known and deliberate limit. `NORTHWIND APPLIANCES EMI PROCESSING FEE`, with no separator,
    // yields a different merchant key than the plan's rows do, so it is not attached. An
    // unattached fee stays visible on its own row; a misattached one is money moved onto the
    // wrong purchase, which is the worse of the two.
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/2>', 2500, 5),
      row('NORTHWIND APPLIANCES EMI PROCESSING FEE', 500, 5),
    ]);

    expect(plans[0]?.observed.fee).toBe(0n);
  });

  it('attaches tax to the interest it was charged on, not to a principal repayment', () => {
    // Card tax is levied on the cost of credit. A plan with only principal rows has nothing for
    // tax to attach to, and the row stays on its own.
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/2>', 2500, 5),
      row('CGST', 16, 5),
    ]);

    expect(plans[0]?.observed.tax).toBe(0n);
  });

  it('leaves a tax line alone when it is too far from any charge', () => {
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/2>', 2500, 5),
      row('NORTHWIND APPLIANCES - INTEREST 1 - <1/2>', 180, 5),
      row('CGST', 16, 25),
    ]);

    expect(plans[0]?.observed.tax).toBe(0n);
  });

  it('leaves a tax line alone when two plans could equally claim it', () => {
    // Guessing would attach somebody's money to the wrong purchase. Two candidates means the
    // ledger cannot say, so it does not.
    const plans = buildInstalmentPlans([
      row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/2>', 2500, 5),
      row('NORTHWIND APPLIANCES - INTEREST 1 - <1/2>', 180, 5),
      row('SEAGRASS FURNITURE - Principal Amount Amortization - <1/2>', 4000, 5),
      row('SEAGRASS FURNITURE - INTEREST 1 - <1/2>', 300, 5),
      row('CGST', 16, 6),
    ]);

    expect(plans).toHaveLength(2);

    for (const plan of plans) expect(plan.observed.tax).toBe(0n);
  });
});

describe('what the anomaly reader must leave alone', () => {
  it('reports every payment a plan accounts for', () => {
    const principal = row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/2>', 2500, 5);
    const interest = row('NORTHWIND APPLIANCES - INTEREST 1 - <1/2>', 180, 5);
    const purchase = row('HARBOUR CAFE', 400, 9);
    const plans = buildInstalmentPlans([principal, interest, purchase]);

    const explained = paymentsExplainedByPlans(plans);
    expect(explained.has(principal.paymentId)).toBe(true);
    expect(explained.has(interest.paymentId)).toBe(true);
    expect(explained.has(purchase.paymentId)).toBe(false);
  });

  it('finds the plan a given payment belongs to', () => {
    const principal = row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/2>', 2500, 5);
    const other = row('HARBOUR CAFE', 400, 9);
    const plans = buildInstalmentPlans([principal, other]);

    expect(planForPayment(plans, principal.paymentId)?.merchantName).toContain('NORTHWIND');
    expect(planForPayment(plans, other.paymentId)).toBeNull();
  });
});
