/**
 * Turning confirmations into a reviewable pattern, and — mostly — refusing to.
 *
 * Every row here is invented for this test. The refusals carry the weight: a pattern that fires
 * on a tax line, on one confirmation, or on wording a person disagreed with themselves about is
 * worse than no pattern at all, because a standing rule outlives the moment somebody approved it.
 */

import { describe, expect, it } from 'vitest';

import { proposeRulesFromConfirmations } from './learning.js';
import type { ConfirmedPayment } from './learning.js';

let sequence = 0;

function confirmed(rawDescription: string, category: string, day = 5): ConfirmedPayment {
  sequence += 1;
  return {
    paymentId: `pay-${String(sequence)}`,
    rawDescription,
    direction: 'debit',
    occurredAt: new Date(Date.UTC(2026, 0, day)),
    category,
  };
}

function propose(
  confirmations: readonly ConfirmedPayment[],
  covered: readonly string[] = [],
  extra: { allPayments?: readonly ConfirmedPayment[]; dismissedKeys?: readonly string[] } = {},
) {
  return proposeRulesFromConfirmations({
    confirmations,
    alreadyCoveredWording: covered,
    allPayments: (extra.allPayments ?? confirmations).map((row) => ({
      paymentId: row.paymentId,
      rawDescription: row.rawDescription,
      occurredAt: row.occurredAt,
    })),
    ...(extra.dismissedKeys === undefined ? {} : { dismissedKeys: extra.dismissedKeys }),
  });
}

describe('offering a pattern', () => {
  it('reads one from two confirmations of the same wording and category', () => {
    const proposals = propose([
      confirmed('HARBOUR CAFE', 'Dining', 5),
      confirmed('HARBOUR CAFE', 'Dining', 9),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.wording).toBe('HARBOUR CAFE');
    expect(proposals[0]?.category).toBe('Dining');
    expect(proposals[0]?.operator).toBe('contains');
  });

  it('carries the exact match a rule would be created with, so nothing can widen it later', () => {
    const proposals = propose([
      confirmed('HARBOUR CAFE', 'Dining'),
      confirmed('HARBOUR CAFE', 'Dining'),
    ]);

    expect(proposals[0]?.match).toEqual({
      description: 'HARBOUR CAFE',
      descriptionOperator: 'contains',
    });
  });

  it('cites every confirmation it was built from, newest first', () => {
    const proposals = propose([
      confirmed('HARBOUR CAFE', 'Dining', 5),
      confirmed('HARBOUR CAFE', 'Dining', 20),
      confirmed('HARBOUR CAFE', 'Dining', 12),
    ]);

    const days = proposals[0]?.examples.map((example) => example.occurredAt.getUTCDate());
    expect(days).toEqual([20, 12, 5]);
    // A proposal with nothing to point at is an opinion, not a pattern.
    expect(proposals[0]?.examples.length).toBe(3);
  });

  it('says why in a plain sentence, with no score and no token list', () => {
    const proposals = propose([
      confirmed('HARBOUR CAFE', 'Dining'),
      confirmed('HARBOUR CAFE', 'Dining'),
    ]);

    expect(proposals[0]?.reason).toBe('You have filed 2 payments worded like this as Dining.');
    expect(proposals[0]?.reason).not.toMatch(/\d+%|confidence|score/i);
  });

  it('keeps two merchants apart', () => {
    const proposals = propose([
      confirmed('HARBOUR CAFE', 'Dining'),
      confirmed('HARBOUR CAFE', 'Dining'),
      confirmed('CITYFIELD GYM', 'Gym & fitness'),
      confirmed('CITYFIELD GYM', 'Gym & fitness'),
    ]);

    expect(proposals).toHaveLength(2);
    expect(proposals.map((proposal) => proposal.category).sort()).toEqual([
      'Dining',
      'Gym & fitness',
    ]);
  });
});

describe('what may never become a pattern', () => {
  it('refuses a single confirmation', () => {
    // One confirmation is a decision about one payment. Offering a standing rule after it would
    // put a pattern in front of somebody who has answered one question.
    expect(propose([confirmed('HARBOUR CAFE', 'Dining')])).toEqual([]);
  });

  it('refuses wording confirmed as two different categories', () => {
    // The person disagreed with themselves; a rule would have to pick one silently.
    expect(
      propose([confirmed('HARBOUR CAFE', 'Dining'), confirmed('HARBOUR CAFE', 'Groceries')]),
    ).toEqual([]);
  });

  it('refuses wording an active rule already covers', () => {
    expect(
      propose(
        [confirmed('HARBOUR CAFE', 'Dining'), confirmed('HARBOUR CAFE', 'Dining')],
        ['harbour cafe'],
      ),
    ).toEqual([]);
  });

  it('refuses a tax line however many times it is confirmed', () => {
    // The rule that matters most. A standing rule firing on every CGST row is a machine for
    // wrong totals, and repetition is exactly what a tax row has most of.
    expect(
      propose([
        confirmed('CGST', 'Bills & subscriptions'),
        confirmed('CGST', 'Bills & subscriptions'),
        confirmed('CGST', 'Bills & subscriptions'),
        confirmed('SGST', 'Bills & subscriptions'),
        confirmed('SGST', 'Bills & subscriptions'),
      ]),
    ).toEqual([]);
  });

  it('refuses instalment and interest rows', () => {
    expect(
      propose([
        confirmed('NORTHWIND APPLIANCES - INTEREST 1 - <1/3>', 'Bills & subscriptions'),
        confirmed('NORTHWIND APPLIANCES - INTEREST 2 - <2/3>', 'Bills & subscriptions'),
        confirmed('NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>', 'Shopping'),
        confirmed('NORTHWIND APPLIANCES - Principal Amount Amortization - <2/3>', 'Shopping'),
      ]),
    ).toEqual([]);
  });

  it('refuses the card bill being paid', () => {
    expect(
      propose([
        { ...confirmed('PAYMENT RECEIVED - THANK YOU', 'Transfer'), direction: 'credit' },
        { ...confirmed('PAYMENT RECEIVED - THANK YOU', 'Transfer'), direction: 'credit' },
      ]),
    ).toEqual([]);
  });

  it('refuses wording too short to be anything but wide', () => {
    expect(propose([confirmed('AB', 'Dining'), confirmed('AB', 'Dining')])).toEqual([]);
  });

  it('refuses an empty category', () => {
    expect(propose([confirmed('HARBOUR CAFE', '   '), confirmed('HARBOUR CAFE', '   ')])).toEqual(
      [],
    );
  });
});

describe('properties that hold for every proposal', () => {
  const many = [
    confirmed('HARBOUR CAFE', 'Dining', 5),
    confirmed('HARBOUR CAFE', 'Dining', 9),
    confirmed('CITYFIELD GYM', 'Gym & fitness', 6),
    confirmed('CITYFIELD GYM', 'Gym & fitness', 14),
    confirmed('CGST', 'Bills & subscriptions', 7),
    confirmed('CGST', 'Bills & subscriptions', 8),
  ];

  it('never proposes without at least two examples', () => {
    for (const proposal of propose(many)) {
      expect(proposal.examples.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('never proposes a match with no condition', () => {
    // `validateRuleDefinition` would refuse one, but a proposal that could not become a rule is
    // a dead end offered to a person.
    for (const proposal of propose(many)) {
      expect(proposal.match.description?.trim()).toBeTruthy();
    }
  });

  it('gives every proposal a stable id across identical reads', () => {
    const once = propose(many).map((proposal) => proposal.id);
    const twice = propose(many).map((proposal) => proposal.id);

    expect(twice).toEqual(once);
    expect(new Set(once).size).toBe(once.length);
  });

  it('shows the wording it would match on, on every proposal', () => {
    // The thing being approved. "Learn from my Dining confirmations" is not judgeable;
    // "match wording containing HARBOUR CAFE" is.
    for (const proposal of propose(many)) {
      expect(proposal.wording.length).toBeGreaterThanOrEqual(4);
      expect(proposal.suggestedName).toContain(proposal.wording);
    }
  });
});

describe('what a pattern would actually reach (ADR-0065)', () => {
  it('counts the confirmations separately from what it would newly match', () => {
    const confirmations = [
      confirmed('HARBOUR CAFE', 'Dining', 5),
      confirmed('HARBOUR CAFE', 'Dining', 9),
    ];
    // Two more on file, never filed, that the same wording would start suggesting for.
    const others = [
      confirmed('HARBOUR CAFE KIOSK', 'Dining', 12),
      confirmed('HARBOUR CAFE ANNEXE', 'Dining', 14),
    ];
    const proposals = propose(confirmations, [], { allPayments: [...confirmations, ...others] });

    expect(proposals[0]?.reach.alreadyFiled).toBe(2);
    expect(proposals[0]?.reach.wouldAlsoMatch).toBe(2);
  });

  it('shows which ones, so a too-wide wording is visible rather than a number to trust', () => {
    const confirmations = [confirmed('CAFE', 'Dining', 5), confirmed('CAFE', 'Dining', 9)];
    const unrelated = [confirmed('CAFE HARDWARE SUPPLY', 'Shopping', 12)];
    const proposals = propose(confirmations, [], {
      allPayments: [...confirmations, ...unrelated],
    });

    const narrations = proposals[0]?.reach.examplesOfNewMatches.map((e) => e.narration);
    expect(narrations).toContain('CAFE HARDWARE SUPPLY');
  });

  it('reports no new matches when the wording only hits what was already filed', () => {
    const proposals = propose([
      confirmed('HARBOUR CAFE', 'Dining', 5),
      confirmed('HARBOUR CAFE', 'Dining', 9),
    ]);

    expect(proposals[0]?.reach.wouldAlsoMatch).toBe(0);
    expect(proposals[0]?.reach.examplesOfNewMatches).toEqual([]);
  });

  it('caps the sample while still reporting the true count', () => {
    const confirmations = [
      confirmed('HARBOUR CAFE', 'Dining', 1),
      confirmed('HARBOUR CAFE', 'Dining', 2),
    ];
    const many = Array.from({ length: 9 }, (_, index) =>
      confirmed(`HARBOUR CAFE ${String(index)}`, 'Dining', 3 + index),
    );
    const proposals = propose(confirmations, [], { allPayments: [...confirmations, ...many] });

    expect(proposals[0]?.reach.wouldAlsoMatch).toBe(9);
    expect(proposals[0]?.reach.examplesOfNewMatches).toHaveLength(5);
  });

  it('reports zero rather than claiming nothing matches when the ledger was not loaded', () => {
    // A caller that did not pass the payments gets an empty preview, never "this matches nothing".
    const proposals = proposeRulesFromConfirmations({
      confirmations: [confirmed('HARBOUR CAFE', 'Dining'), confirmed('HARBOUR CAFE', 'Dining')],
      alreadyCoveredWording: [],
    });

    expect(proposals[0]?.reach.alreadyFiled).toBe(2);
    expect(proposals[0]?.reach.wouldAlsoMatch).toBe(0);
  });
});

describe('a pattern somebody declined', () => {
  it('is not offered again', () => {
    const confirmations = [
      confirmed('HARBOUR CAFE', 'Dining', 5),
      confirmed('HARBOUR CAFE', 'Dining', 9),
    ];
    const [offered] = propose(confirmations);
    expect(offered).toBeDefined();

    expect(propose(confirmations, [], { dismissedKeys: [offered!.id] })).toEqual([]);
  });

  it('stays declined as more confirmations accumulate behind it', () => {
    // The evidence growing is not new information about the decision to decline (ADR-0065).
    const confirmations = [
      confirmed('HARBOUR CAFE', 'Dining', 5),
      confirmed('HARBOUR CAFE', 'Dining', 9),
    ];
    const key = propose(confirmations)[0]!.id;
    const more = [...confirmations, confirmed('HARBOUR CAFE', 'Dining', 20)];

    expect(propose(more, [], { dismissedKeys: [key] })).toEqual([]);
  });

  it('does not silence a different pattern', () => {
    const confirmations = [
      confirmed('HARBOUR CAFE', 'Dining', 5),
      confirmed('HARBOUR CAFE', 'Dining', 9),
      confirmed('CITYFIELD GYM', 'Gym & fitness', 6),
      confirmed('CITYFIELD GYM', 'Gym & fitness', 10),
    ];
    const cafe = propose(confirmations).find((p) => p.category === 'Dining')!.id;

    const left = propose(confirmations, [], { dismissedKeys: [cafe] });
    expect(left).toHaveLength(1);
    expect(left[0]?.category).toBe('Gym & fitness');
  });
});
