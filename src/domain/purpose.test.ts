/**
 * What a statement line is for — and, far more importantly, what it is *not*.
 *
 * The cases below are shaped like the rows a real Indian credit-card statement actually
 * carries, because that is where the dangerous ones live: on the ledger this was written
 * against, 40 of 120 rows are a bare `CGST`/`SGST`, 13 carry `INTEREST`, 15 carry an
 * instalment marker and 3 are the bill being paid. A reader that matched merchant words first
 * would report all of those as spending at the merchant named beside them.
 *
 * So the first block is the safety block, and it is the one that must never go green by
 * accident.
 */

import { describe, expect, it } from 'vitest';

import { inferPurpose, readStatementRow, SPENDING_CATEGORIES } from './purpose.js';
import type { RelatedPayment } from './purpose.js';

const AUG = (day: number): Date => new Date(Date.UTC(2026, 7, day));

function debit(rawDescription: string) {
  return { rawDescription, direction: 'debit' as const };
}
function credit(rawDescription: string) {
  return { rawDescription, direction: 'credit' as const };
}

function related(rows: readonly [string, Date, ...(readonly [string])[]][]): RelatedPayment[] {
  return rows.map(([rawDescription, occurredAt], index) => ({
    paymentId: `pay-${index}`,
    rawDescription,
    direction: 'debit' as const,
    occurredAt,
  }));
}

/* ============================================================ the safety block */

describe('a statement line is not a purchase just because a merchant is named on it', () => {
  it('reads a bare tax line as tax on another line, and suggests nothing', () => {
    const reading = inferPurpose({ row: debit('CGST') });

    expect(reading.nature).toBe('tax_on_another_line');
    expect(reading.countsAsPurchase).toBe(false);
    expect(reading.candidates).toEqual([]);
    expect(reading.why.join(' ')).toMatch(/tax charged on another line/i);
  });

  it.each(['SGST', 'IGST', 'GST @18%', ' cgst ', 'GST'])(
    'reads %s the same way, whatever the spacing',
    (text) => {
      expect(readStatementRow(debit(text)).nature).toBe('tax_on_another_line');
    },
  );

  it('never calls interest a purchase, even when the shop is named on the same line', () => {
    const reading = inferPurpose({ row: debit('Q SYN FITNESS - INTEREST 3/6 - <3/6>') });

    expect(reading.nature).toBe('instalment_interest');
    expect(reading.countsAsPurchase).toBe(false);
    // The merchant is still read, so the row can be explained — it is just not categorised as gym.
    expect(reading.merchantText).toMatch(/SYN FITNESS/i);
    expect(reading.candidates.map((candidate) => candidate.category)).not.toContain(
      'Gym & fitness',
    );
    expect(reading.why.join(' ')).toMatch(/instalment 3 of 6/i);
    expect(reading.why.join(' ')).toMatch(/interest is what the card charged you/i);
  });

  it('treats an instalment repayment as a repayment, not a second purchase', () => {
    const reading = inferPurpose({ row: debit('Q SYN FITNESS - PRINCIPAL 2 - <2/6>') });

    expect(reading.nature).toBe('instalment_principal');
    expect(reading.countsAsPurchase).toBe(false);
    expect(reading.why.join(' ')).toMatch(/counting it again would count the same money twice/i);
    // The merchant's category is still reachable, but never confidently and never first-class.
    for (const candidate of reading.candidates) expect(candidate.confidence).toBe('low');
  });

  it('reads an EMI fee as a charge from the card, not a purchase', () => {
    const reading = inferPurpose({ row: debit('EMI 4821 FEE') });

    expect(reading.nature).toBe('card_fee');
    expect(reading.countsAsPurchase).toBe(false);
    expect(reading.candidates[0]?.category).toBe('Bills & subscriptions');
  });

  it('reads the card bill being paid as a transfer, never as income or spending', () => {
    const reading = inferPurpose({ row: credit('4821 CARD PAYMENT RECEIVED') });

    expect(reading.nature).toBe('card_bill_paid');
    expect(reading.countsAsPurchase).toBe(false);
    expect(reading.candidates[0]).toMatchObject({ category: 'Transfer', confidence: 'high' });
    expect(reading.why.join(' ')).toMatch(/not spending/i);
  });

  it('sends a refund back to its original purchase rather than categorising it', () => {
    const reading = inferPurpose({ row: credit('REFUND Q SYN FITNESS') });

    expect(reading.nature).toBe('refund_or_reversal');
    expect(reading.candidates).toEqual([]);
    expect(reading.why.join(' ')).toMatch(/belongs against the original purchase/i);
  });

  it('says a credit it cannot place is unexplained rather than calling it income', () => {
    const reading = inferPurpose({ row: credit('NEFT 88213') });

    expect(reading.nature).toBe('money_in');
    expect(reading.candidates).toEqual([]);
  });
});

/* ============================================================ the useful block */

describe('what a purchase is likely for', () => {
  it('recognises a fitness merchant from its own description alone', () => {
    const reading = inferPurpose({ row: debit('Q SYN FITNESS') });

    expect(reading.nature).toBe('merchant_purchase');
    expect(reading.countsAsPurchase).toBe(true);
    expect(reading.candidates[0]?.category).toBe('Gym & fitness');
    expect(reading.why[0]).toMatch(/the description says/i);
    expect(reading.candidates[0]?.why).toMatch(/usually means a gym/i);
  });

  it('is more confident about a merchant it has seen several times', () => {
    const once = inferPurpose({ row: debit('Q SYN FITNESS') });
    const often = inferPurpose({
      row: debit('Q SYN FITNESS'),
      related: related([
        ['Q SYN FITNESS', AUG(2)],
        ['Q SYN FITNESS', AUG(2)],
      ]),
    });

    expect(once.candidates[0]?.confidence).toBe('medium');
    expect(often.candidates[0]?.confidence).toBe('high');
    expect(often.seenBefore).toBe(2);
  });

  it('says out loud when a merchant recurs about monthly', () => {
    const reading = inferPurpose({
      row: debit('Q SYN FITNESS'),
      related: related([
        ['Q SYN FITNESS', AUG(1)],
        ['Q SYN FITNESS', new Date(Date.UTC(2026, 8, 1))],
        ['Q SYN FITNESS', new Date(Date.UTC(2026, 9, 1))],
      ]),
    });

    expect(reading.why.join(' ')).toMatch(/at about a month apart/i);
  });

  it('offers sensible alternatives rather than one answer', () => {
    const reading = inferPurpose({ row: debit('FRESH FARM KITCHEN') });

    expect(reading.candidates.length).toBeGreaterThan(1);
    for (const candidate of reading.candidates) {
      expect(SPENDING_CATEGORIES).toContain(candidate.category);
      expect(candidate.why.length).toBeGreaterThan(0);
    }
  });

  it('stays unconfident when two categories fit equally well', () => {
    const reading = inferPurpose({ row: debit('FARM CAFE') });
    expect(reading.candidates[0]?.confidence).toBe('low');
  });

  it('suggests nothing rather than guessing when the wording says nothing', () => {
    const reading = inferPurpose({ row: debit('QX7719 ZZ') });

    expect(reading.nature).toBe('merchant_purchase');
    expect(reading.candidates).toEqual([]);
    expect(reading.why.join(' ')).toMatch(/nothing in the wording says what kind/i);
  });

  it('prefers what a person already chose for the same place over any word', () => {
    const reading = inferPurpose({
      row: debit('Q SYN FITNESS'),
      related: [
        {
          paymentId: 'pay-earlier',
          rawDescription: 'Q SYN FITNESS',
          direction: 'debit',
          occurredAt: AUG(2),
          confirmedCategory: 'Health',
        },
      ],
    });

    expect(reading.candidates[0]).toMatchObject({ category: 'Health', confidence: 'high' });
    expect(reading.candidates[0]?.why).toMatch(/you have filed this place under/i);
    // The word-based reading is still offered underneath, not discarded.
    expect(reading.candidates.map((candidate) => candidate.category)).toContain('Gym & fitness');
  });
});

/* ============================================================ grouping a plan */

describe('grouping an instalment plan', () => {
  const plan: RelatedPayment[] = [
    {
      paymentId: 'p-int',
      rawDescription: 'Q SYN FITNESS - INTEREST 1 - <1/6>',
      direction: 'debit',
      occurredAt: AUG(1),
    },
    {
      paymentId: 'p-pri',
      rawDescription: 'Q SYN FITNESS - PRINCIPAL 1 - <1/6>',
      direction: 'debit',
      occurredAt: AUG(1),
    },
    { paymentId: 'p-buy', rawDescription: 'Q SYN FITNESS', direction: 'debit', occurredAt: AUG(1) },
  ];

  it('finds the other rows of the same plan, and not the plain purchase', () => {
    const reading = inferPurpose({
      row: debit('Q SYN FITNESS - INTEREST 2 - <2/6>'),
      related: plan,
    });

    expect(reading.partOfPlan).toEqual(['p-int', 'p-pri']);
    expect(reading.partOfPlan).not.toContain('p-buy');
  });

  it('counts every sighting of the merchant, however the row is shaped', () => {
    const reading = inferPurpose({ row: debit('Q SYN FITNESS'), related: plan });
    expect(reading.seenBefore).toBe(3);
  });

  it('reads the same merchant through markers, spacing and case', () => {
    const plain = readStatementRow(debit('Q SYN FITNESS'));
    const marked = readStatementRow(debit('q syn fitness  - INTEREST 3/6'));
    expect(marked.merchantKey).toBe(plain.merchantKey);
  });
});

describe('determinism', () => {
  it('gives the same answer twice, so a screen may re-derive rather than store', () => {
    const input = { row: debit('Q SYN FITNESS'), related: related([['Q SYN FITNESS', AUG(2)]]) };
    expect(inferPurpose(input)).toEqual(inferPurpose(input));
  });
});
