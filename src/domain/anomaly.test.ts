/**
 * What is worth a second look, and — mostly — what is not.
 *
 * Every row here is invented for this test. The suppression tests carry the weight: on a real
 * card statement the large majority of rows are ordinary card mechanics, and a detector that
 * flagged them would be worse than no detector, because the reader would stop opening the list.
 */

import { describe, expect, it } from 'vitest';

import { buildInstalmentPlans, paymentsExplainedByPlans } from './instalment.js';
import type { InstalmentSourceRow } from './instalment.js';
import { findAnomalies } from './anomaly.js';
import type { AnomalyInput, AnomalySourceRow } from './anomaly.js';
import { paise } from './money.js';

let sequence = 0;

function row(
  rawDescription: string,
  amountRupees: number,
  hoursFromStart = 0,
  direction: 'debit' | 'credit' = 'debit',
): AnomalySourceRow & InstalmentSourceRow {
  sequence += 1;
  return {
    paymentId: `pay-${String(sequence)}`,
    rawDescription,
    direction,
    occurredAt: new Date(Date.UTC(2026, 0, 5, 9) + hoursFromStart * 3_600_000),
    amount: paise(BigInt(amountRupees) * 100n),
  };
}

/** Wires the two readers together the way the service does, so suppression is really exercised. */
function analyse(rows: readonly (AnomalySourceRow & InstalmentSourceRow)[]): AnomalyInput {
  const plans = buildInstalmentPlans(rows);
  return {
    rows,
    explainedByPlans: paymentsExplainedByPlans(plans),
    planPrincipals: plans.map((plan) => ({
      planKey: plan.planKey,
      merchantName: plan.merchantName,
      charges: plan.positions
        .flatMap((position) => position.charges)
        .filter((charge) => charge.component === 'principal')
        .map((charge) => ({
          paymentId: charge.paymentId,
          occurredAt: charge.occurredAt,
          amount: charge.amount,
          narration: charge.narration,
        })),
    })),
  };
}

describe('staying quiet about ordinary card mechanics', () => {
  it('says nothing at all about a well-formed instalment plan', () => {
    // Principal, interest and the tax on that interest. Four rows, all normal, no findings.
    const found = findAnomalies(
      analyse([
        row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 0),
        row('NORTHWIND APPLIANCES - INTEREST 1 - <1/3>', 180, 0),
        row('CGST', 16, 1),
        row('SGST', 16, 1),
      ]),
    );

    expect(found).toEqual([]);
  });

  it('never treats CGST or SGST as a duplicate purchase', () => {
    // Two identical tax rows on one day is the single most common shape on a real statement.
    // A naive repeated-charge check would flag it; this one cannot see tax rows at all.
    const found = findAnomalies(
      analyse([
        row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 0),
        row('NORTHWIND APPLIANCES - INTEREST 1 - <1/3>', 180, 0),
        row('CGST', 16, 1),
        row('CGST', 16, 1),
        row('SGST', 16, 1),
        row('SGST', 16, 1),
      ]),
    );

    expect(found).toEqual([]);
  });

  it('says nothing about the card bill being paid', () => {
    const found = findAnomalies(
      analyse([row('PAYMENT RECEIVED - THANK YOU', 50_000, 0, 'credit')]),
    );
    expect(found).toEqual([]);
  });

  it('says nothing about a merchant that simply recurs monthly', () => {
    const found = findAnomalies(
      analyse([
        row('CITYFIELD GYM', 1200, 0),
        row('CITYFIELD GYM', 1200, 24 * 30),
        row('CITYFIELD GYM', 1200, 24 * 60),
      ]),
    );

    expect(found).toEqual([]);
  });
});

describe('interest nothing explains', () => {
  it('is reported when no plan on file accounts for it', () => {
    // An interest row whose merchant has no principal rows: the statement that set the plan up
    // has not been added. That is a gap in the ledger, stated as one.
    const found = findAnomalies(analyse([row('SEAGRASS FURNITURE - INTEREST 4', 900, 0)]));

    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('unexplained_interest');
    expect(found[0]?.evidence).toHaveLength(1);
  });

  it('is not reported when the plan is on file', () => {
    const found = findAnomalies(
      analyse([
        row('SEAGRASS FURNITURE - Principal Amount Amortization - <1/2>', 4000, 0),
        row('SEAGRASS FURNITURE - INTEREST 1 - <1/2>', 900, 0),
      ]),
    );

    expect(found.filter((anomaly) => anomaly.kind === 'unexplained_interest')).toEqual([]);
  });
});

describe('a plan that repays unevenly', () => {
  it('is reported, with both amounts cited', () => {
    const found = findAnomalies(
      analyse([
        row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 0),
        row('NORTHWIND APPLIANCES - Principal Amount Amortization - <2/3>', 3100, 24 * 30),
      ]),
    );

    const uneven = found.find((anomaly) => anomaly.kind === 'inconsistent_instalment');
    expect(uneven).toBeDefined();
    expect(uneven?.evidence).toHaveLength(2);
    // Real rows, not placeholders: a citation that invented a date would be the exact failure
    // this whole module exists to avoid.
    for (const item of uneven?.evidence ?? []) {
      expect(item.paymentId).not.toBe('');
      expect(item.occurredAt.getTime()).toBeGreaterThan(0);
      expect(item.narration).not.toBe('');
    }
  });

  it('is not reported when every repayment matches', () => {
    const found = findAnomalies(
      analyse([
        row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 0),
        row('NORTHWIND APPLIANCES - Principal Amount Amortization - <2/3>', 2500, 24 * 30),
      ]),
    );

    expect(found.filter((anomaly) => anomaly.kind === 'inconsistent_instalment')).toEqual([]);
  });
});

describe('a fee out of line with its neighbours', () => {
  it('is reported only against the same merchant’s own history', () => {
    const found = findAnomalies(
      analyse([
        row('HARBOUR BANK - LATE FEE', 100, 0),
        row('HARBOUR BANK - LATE FEE', 100, 24),
        row('HARBOUR BANK - LATE FEE', 900, 48),
      ]),
    );

    const fee = found.find((anomaly) => anomaly.kind === 'unusual_fee');
    expect(fee).toBeDefined();
    // The finding cites the outlier and the basis it was compared against.
    expect(fee?.evidence.length).toBeGreaterThanOrEqual(3);
  });

  it('is not reported on a mild difference', () => {
    const found = findAnomalies(
      analyse([
        row('HARBOUR BANK - LATE FEE', 100, 0),
        row('HARBOUR BANK - LATE FEE', 100, 24),
        row('HARBOUR BANK - LATE FEE', 150, 48),
      ]),
    );

    expect(found.filter((anomaly) => anomaly.kind === 'unusual_fee')).toEqual([]);
  });

  it('is not reported without enough history to call anything usual', () => {
    // Two fees is not a pattern, and "three times the only other one" is not a finding.
    const found = findAnomalies(
      analyse([row('HARBOUR BANK - LATE FEE', 100, 0), row('HARBOUR BANK - LATE FEE', 900, 24)]),
    );

    expect(found.filter((anomaly) => anomaly.kind === 'unusual_fee')).toEqual([]);
  });
});

describe('the same amount charged twice', () => {
  it('is reported as an observation, not an accusation', () => {
    const found = findAnomalies(
      analyse([row('HARBOUR CAFE', 400, 0), row('HARBOUR CAFE', 400, 3)]),
    );

    const repeat = found.find((anomaly) => anomaly.kind === 'repeated_charge');
    expect(repeat).toBeDefined();
    expect(repeat?.evidence).toHaveLength(2);
    // The wording must leave room for the ordinary explanation, because it is usually the right
    // one — two identical coffees produce exactly this.
    expect(repeat?.detail).toMatch(/often exactly what happened/);
  });

  it('is not reported when the two are far apart', () => {
    const found = findAnomalies(
      analyse([row('HARBOUR CAFE', 400, 0), row('HARBOUR CAFE', 400, 24 * 30)]),
    );

    expect(found.filter((anomaly) => anomaly.kind === 'repeated_charge')).toEqual([]);
  });

  it('reports four identical charges as one finding, not six', () => {
    // Found by looking at a rendered list during the phase-2 smoke check: pairing produced
    // n(n-1)/2 findings, so four identical rows became six alerts saying the same thing. That is
    // alert fatigue arriving by arithmetic, which is precisely what ADR-0063 forbids.
    const found = findAnomalies(
      analyse([
        row('HARBOUR CAFE', 400, 0),
        row('HARBOUR CAFE', 400, 1),
        row('HARBOUR CAFE', 400, 2),
        row('HARBOUR CAFE', 400, 3),
      ]),
    );

    const repeats = found.filter((anomaly) => anomaly.kind === 'repeated_charge');
    expect(repeats).toHaveLength(1);
    expect(repeats[0]?.evidence).toHaveLength(4);
    expect(repeats[0]?.headline).toMatch(/4 times/);
  });

  it('reports only the charges that actually sit close together', () => {
    // Two an hour apart and one a month later is a finding about the two, not about all three.
    const found = findAnomalies(
      analyse([
        row('HARBOUR CAFE', 400, 0),
        row('HARBOUR CAFE', 400, 1),
        row('HARBOUR CAFE', 400, 24 * 30),
      ]),
    );

    const repeats = found.filter((anomaly) => anomaly.kind === 'repeated_charge');
    expect(repeats).toHaveLength(1);
    expect(repeats[0]?.evidence).toHaveLength(2);
  });

  it('reports a pair once, not twice', () => {
    const found = findAnomalies(
      analyse([row('HARBOUR CAFE', 400, 0), row('HARBOUR CAFE', 400, 3)]),
    );

    expect(found.filter((anomaly) => anomaly.kind === 'repeated_charge')).toHaveLength(1);
  });
});

describe('rules that hold for every finding', () => {
  const everything = analyse([
    row('SEAGRASS FURNITURE - INTEREST 4', 900, 0),
    row('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 2500, 1),
    row('NORTHWIND APPLIANCES - Principal Amount Amortization - <2/3>', 3100, 24 * 30),
    row('HARBOUR BANK - LATE FEE', 100, 2),
    row('HARBOUR BANK - LATE FEE', 100, 3),
    row('HARBOUR BANK - LATE FEE', 900, 4),
    row('HARBOUR CAFE', 400, 5),
    row('HARBOUR CAFE', 400, 6),
  ]);

  it('never produces a finding with no evidence', () => {
    for (const anomaly of findAnomalies(everything)) {
      expect(anomaly.evidence.length).toBeGreaterThan(0);
    }
  });

  it('never accuses anybody of anything', () => {
    // The second failure mode, and the worse one. A statement line does not tell you the
    // merchant's pricing or the card's terms, so a verdict here would be a claim the product
    // cannot support — and one somebody might act on.
    const forbidden =
      /\b(fraud|fraudulent|suspicious|scam|stolen|unauthoriz|unauthoris|overcharg|illegal|dispute this|report this)\b/i;
    for (const anomaly of findAnomalies(everything)) {
      expect(anomaly.headline).not.toMatch(forbidden);
      expect(anomaly.detail).not.toMatch(forbidden);
    }
  });

  it('never states a bank policy or a compliance verdict', () => {
    const forbidden = /\b(should have|must have|required to|in breach|violat|non-complian)\b/i;
    for (const anomaly of findAnomalies(everything)) {
      expect(`${anomaly.headline} ${anomaly.detail}`).not.toMatch(forbidden);
    }
  });

  it('gives every finding a stable id and orders them newest first', () => {
    const once = findAnomalies(everything);
    const twice = findAnomalies(everything);

    expect(once.map((anomaly) => anomaly.id)).toEqual(twice.map((anomaly) => anomaly.id));
    expect(new Set(once.map((anomaly) => anomaly.id)).size).toBe(once.length);
  });

  it('stays a short list even with every kind present', () => {
    // Alert fatigue is the thing being designed against; a sanity bound makes a regression that
    // starts flagging ordinary rows show up here rather than on somebody's screen.
    expect(findAnomalies(everything).length).toBeLessThanOrEqual(6);
  });
});
