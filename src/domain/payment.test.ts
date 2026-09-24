import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  assertPaymentCanFundExpense,
  isDeterministicDuplicate,
  isPossibleDuplicate,
  validatePaymentExplanationBudget,
} from './payment.js';
import type { DuplicateCandidate } from './payment.js';
import { paise } from './money.js';

describe('validatePaymentExplanationBudget — links and settlements share one budget', () => {
  it('accepts a payment fully explained by one expense link', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(124000n),
      linkAmounts: [paise(124000n)],
      settlementAmounts: [],
    });

    expect(result).toEqual({ explained: 124000n, unexplained: 0n });
  });

  it('accepts one payment split across two expenses (scenario §1)', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(124000n),
      linkAmounts: [paise(8000n), paise(116000n)],
      settlementAmounts: [],
    });

    expect(result.unexplained).toBe(0n);
  });

  it('surfaces a shortfall as unexplained rather than assuming rounding', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(124000n),
      linkAmounts: [paise(100000n)],
      settlementAmounts: [],
    });

    expect(result).toEqual({ explained: 100000n, unexplained: 24000n });
  });

  it('counts a settlement against the same budget as expense links (ADR-0007)', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(100000n),
      linkAmounts: [paise(40000n)],
      settlementAmounts: [paise(60000n)],
    });

    expect(result).toEqual({ explained: 100000n, unexplained: 0n });
  });

  it('rejects links plus settlements exceeding the payment', () => {
    let raised: DomainError | undefined;
    try {
      validatePaymentExplanationBudget({
        paymentAmount: paise(100000n),
        linkAmounts: [paise(60000n)],
        settlementAmounts: [paise(60000n)],
      });
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('PAYMENT_BUDGET_EXCEEDED');
  });

  it('reports an unexplained payment with no links at all', () => {
    const result = validatePaymentExplanationBudget({
      paymentAmount: paise(500000n),
      linkAmounts: [],
      settlementAmounts: [],
    });

    expect(result.unexplained).toBe(500000n);
  });
});

describe('assertPaymentCanFundExpense — invariant #7', () => {
  it('rejects linking an internal transfer to an expense (scenario §14)', () => {
    let raised: DomainError | undefined;
    try {
      assertPaymentCanFundExpense('internal_account');
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('NON_SPEND_PAYMENT_LINKED');
  });

  it('rejects linking an investment purchase to an expense (scenario §32)', () => {
    expect(() => assertPaymentCanFundExpense('investment_instrument')).toThrow(DomainError);
  });

  it.each(['merchant', 'person', 'unknown'] as const)('allows a %s payment', (counterpartyType) => {
    expect(() => assertPaymentCanFundExpense(counterpartyType)).not.toThrow();
  });
});

describe('duplicate detection — invariant #10, ADR-0010', () => {
  const bankCapture: DuplicateCandidate = {
    amount: paise(124000n),
    occurredAt: new Date('2026-07-12T19:00:00Z'),
    externalReference: 'UPI/2607121234/BLINKIT',
    direction: 'debit',
    accountId: 'account_hdfc_savings',
  };
  const upiCapture: DuplicateCandidate = {
    amount: paise(124000n),
    occurredAt: new Date('2026-07-12T19:00:03Z'),
    externalReference: 'UPI/2607121234/BLINKIT',
    direction: 'debit',
    accountId: 'account_hdfc_upi',
  };

  it('matches the same charge captured by a bank CSV and a UPI export (§13)', () => {
    expect(isDeterministicDuplicate(bankCapture, upiCapture)).toBe(true);
  });

  it('does not require the two captures to share an account', () => {
    // This is the amendment that made the deterministic path reachable at all: a bank-CSV
    // capture and a UPI-export capture of one real transaction land on different Account
    // rows by construction (ADR-0010's amendment).
    expect(bankCapture.accountId).not.toBe(upiCapture.accountId);
    expect(isDeterministicDuplicate(bankCapture, upiCapture)).toBe(true);
  });

  it('does not match two legs of one transfer, which share a reference (bank-statement.csv)', () => {
    // fixtures/bank-statement.csv rows 2 and 3: a NEFT transfer between the user's own
    // accounts appears twice under the SAME reference, same amount, same date — once leaving
    // and once arriving. Both are real. Matching them would delete half a transfer.
    const outgoing: DuplicateCandidate = {
      amount: paise(1500000n),
      occurredAt: new Date('2026-07-02T00:00:00Z'),
      externalReference: 'NEFT/N072026001',
      direction: 'debit',
    };
    const incoming: DuplicateCandidate = { ...outgoing, direction: 'credit' };

    expect(isDeterministicDuplicate(outgoing, incoming)).toBe(false);
  });

  it('does not even flag opposite directions as a possible duplicate', () => {
    const outgoing: DuplicateCandidate = {
      amount: paise(1500000n),
      occurredAt: new Date('2026-07-02T00:00:00Z'),
      externalReference: 'NEFT/N072026001',
      direction: 'debit',
    };

    expect(isPossibleDuplicate(outgoing, { ...outgoing, direction: 'credit' })).toBe(false);
  });

  it('still matches two captures of the same charge in the same direction', () => {
    expect(isDeterministicDuplicate(bankCapture, upiCapture)).toBe(true);
  });

  it('is symmetric', () => {
    expect(isDeterministicDuplicate(upiCapture, bankCapture)).toBe(true);
  });

  it('does not match when the amounts differ', () => {
    expect(isDeterministicDuplicate(bankCapture, { ...upiCapture, amount: paise(124001n) })).toBe(
      false,
    );
  });

  it('does not match when the references differ', () => {
    expect(
      isDeterministicDuplicate(bankCapture, { ...upiCapture, externalReference: 'UPI/OTHER' }),
    ).toBe(false);
  });

  it('does not match when either reference is absent', () => {
    expect(isDeterministicDuplicate(bankCapture, { ...upiCapture, externalReference: null })).toBe(
      false,
    );
    expect(
      isDeterministicDuplicate(
        { ...bankCapture, externalReference: null },
        { ...upiCapture, externalReference: null },
      ),
    ).toBe(false);
  });

  it('does not match when the timestamps are outside the clock-skew window', () => {
    expect(
      isDeterministicDuplicate(bankCapture, {
        ...upiCapture,
        occurredAt: new Date('2026-07-13T19:00:00Z'),
      }),
    ).toBe(false);
  });

  it('matches within the window in either time order', () => {
    const earlier = { ...bankCapture, occurredAt: new Date('2026-07-12T18:59:30Z') };

    expect(isDeterministicDuplicate(earlier, upiCapture)).toBe(true);
  });

  it('flags a same-amount, same-time pair with no reference as a possible duplicate', () => {
    const a: DuplicateCandidate = { ...bankCapture, externalReference: null };
    const b: DuplicateCandidate = { ...upiCapture, externalReference: null };

    expect(isDeterministicDuplicate(a, b)).toBe(false);
    expect(isPossibleDuplicate(a, b)).toBe(true);
  });

  it('asks about a pair one reference proves while both are still counted', () => {
    // The importer settles such a pair the moment the second copy arrives (ADR-0019), so the
    // queue never sees one the importer wrote. A hand-entered payment is not written by the
    // importer: typed with the number of a payment already imported, both stay counted, and a
    // rule that assumed "the importer acted on it" left that double count with nobody asked.
    expect(isDeterministicDuplicate(bankCapture, upiCapture)).toBe(true);
    expect(isPossibleDuplicate(bankCapture, upiCapture)).toBe(true);
    expect(isPossibleDuplicate(upiCapture, bankCapture)).toBe(true);
  });

  it('flags mismatched references at the same amount and time as only possible', () => {
    const other = { ...upiCapture, externalReference: 'UPI/DIFFERENT' };

    expect(isDeterministicDuplicate(bankCapture, other)).toBe(false);
    expect(isPossibleDuplicate(bankCapture, other)).toBe(true);
  });

  it('does not flag different amounts as a possible duplicate', () => {
    expect(isPossibleDuplicate(bankCapture, { ...upiCapture, amount: paise(50000n) })).toBe(false);
  });

  it('does not flag payments days apart as a possible duplicate', () => {
    expect(
      isPossibleDuplicate(bankCapture, {
        ...upiCapture,
        occurredAt: new Date('2026-07-20T19:00:00Z'),
      }),
    ).toBe(false);
  });

  it('lets the caller widen the matching window explicitly', () => {
    const nextDay = { ...upiCapture, occurredAt: new Date('2026-07-13T19:00:00Z') };

    expect(isDeterministicDuplicate(bankCapture, nextDay, { windowSeconds: 86_400 })).toBe(true);
  });
});

describe('a tax component is not a duplicate purchase', () => {
  /**
   * The defect this closes, seen on a real ledger.
   *
   * One charge on an Indian card statement is routinely printed as several lines — the charge,
   * then `CGST`, then `SGST`. The two halves of the tax are equal by construction, on the same
   * date, to the paisa, and carry no reference. That is precisely what the possible-duplicate
   * rule reads as "the same payment recorded twice", and it is a textbook non-duplicate:
   * answering the question would discard half of a real tax charge.
   */
  const SAME_DAY = new Date('2026-09-09T00:00:00Z');

  /** A ₹28.08 line on one day. `batch: null` is a row that does not say which import it came from. */
  function taxRow(
    description: string,
    batch: string | null = 'card-statement',
  ): DuplicateCandidate {
    return {
      amount: paise(2808n),
      occurredAt: SAME_DAY,
      externalReference: null,
      direction: 'debit',
      rawDescription: description,
      ...(batch === null ? {} : { importBatchId: batch }),
    };
  }

  it('does not pair CGST with SGST on the same date for the same amount', () => {
    expect(isPossibleDuplicate(taxRow('CGST'), taxRow('SGST'))).toBe(false);
  });

  it.each([
    ['CGST', 'SGST'],
    ['SGST', 'CGST'],
    ['IGST', 'IGST'],
    ['GST', 'GST'],
    ['cgst', 'Sgst'],
    ['  CGST  ', 'SGST'],
    ['GST @18%', 'GST @18%'],
  ])('does not pair %s with %s on one statement', (left, right) => {
    // One statement prints a tax line for every charge it taxes, so two equal tax lines of one
    // statement are two charges' taxes — even word for word.
    expect(isPossibleDuplicate(taxRow(left), taxRow(right))).toBe(false);
  });

  describe('across two imports, a tax line is compared with the same tax', () => {
    /**
     * The gap this closes. A card statement downloaded a second time is new bytes, so it is not
     * caught as the same file, and its lines carry no reference, so none is caught as the same
     * row: every line arrives again. Each purchase line is then asked about — but a tax line was
     * never compared with anything, so the tax was counted twice and nobody was asked.
     */
    const again = (description: string): DuplicateCandidate =>
      taxRow(description, 'card-statement-downloaded-again');

    it.each([
      ['CGST', 'CGST'],
      ['SGST', 'SGST'],
      ['IGST', 'IGST'],
      ['GST @18%', 'GST @18%'],
      ['C GST', 'CGST'],
      ['cgst', 'CGST'],
    ])('asks about %s printed again as %s by a second import', (left, right) => {
      expect(isPossibleDuplicate(taxRow(left), again(right))).toBe(true);
      expect(isPossibleDuplicate(again(right), taxRow(left))).toBe(true);
    });

    it.each([
      ['CGST', 'SGST'],
      ['SGST', 'CGST'],
      ['IGST', 'CGST'],
      ['GST', 'CGST'],
      ['UGST', 'SGST'],
    ])('never pairs %s with %s, even from two imports', (left, right) => {
      // The two halves of one tax are equal by construction; being equal is not being the same.
      expect(isPossibleDuplicate(taxRow(left), again(right))).toBe(false);
      expect(isPossibleDuplicate(again(right), taxRow(left))).toBe(false);
    });

    it('compares a tax line only with a tax line', () => {
      // A line nobody can place is never a difference between two purchases — but a tax line is
      // not a purchase, and neither a bare transaction number nor a shop is the same kind of line.
      expect(isPossibleDuplicate(taxRow('CGST'), again('UPI/412345678901'))).toBe(false);
      expect(isPossibleDuplicate(again('UPI/412345678901'), taxRow('CGST'))).toBe(false);
      expect(isPossibleDuplicate(taxRow('CGST'), again('GREENLEAF SUPERMARKET'))).toBe(false);
      expect(isPossibleDuplicate(again('GREENLEAF SUPERMARKET'), taxRow('CGST'))).toBe(false);
    });

    it('still needs the same day, the same amount and the same direction', () => {
      const copy = again('CGST');
      expect(isPossibleDuplicate(taxRow('CGST'), { ...copy, amount: paise(2809n) })).toBe(false);
      expect(
        isPossibleDuplicate(taxRow('CGST'), {
          ...copy,
          occurredAt: new Date('2026-09-10T00:00:00Z'),
        }),
      ).toBe(false);
      expect(isPossibleDuplicate(taxRow('CGST'), { ...copy, direction: 'credit' })).toBe(false);
    });

    it('asks as for two imports when a row does not say which import it came from', () => {
      // Missing information can only add a question, never remove one.
      expect(isPossibleDuplicate(taxRow('CGST', null), taxRow('CGST', null))).toBe(true);
      expect(isPossibleDuplicate(taxRow('CGST', null), taxRow('CGST'))).toBe(true);
      expect(isPossibleDuplicate(taxRow('CGST', null), taxRow('SGST', null))).toBe(false);
    });
  });

  it('does not pair a tax component with a purchase that happens to match it', () => {
    const purchase: DuplicateCandidate = {
      ...taxRow('GREENLEAF SUPERMARKET'),
    };
    expect(isPossibleDuplicate(taxRow('CGST'), purchase)).toBe(false);
    expect(isPossibleDuplicate(purchase, taxRow('CGST'))).toBe(false);
  });

  it('still pairs two ordinary purchases that look alike', () => {
    // The rule's real job is untouched: this is the case a person does need to be asked about.
    const first = taxRow('CITYLINE PHARMACY');
    const second = taxRow('CITYLINE PHARMACY');
    expect(isPossibleDuplicate(first, second)).toBe(true);
  });

  it('does not suppress a purchase that merely states the tax it included', () => {
    // "the whole line is tax" is the test, not "the line mentions tax". A restaurant bill
    // printing its GST is still a purchase, and two of them are still worth asking about.
    const bill = taxRow('PEPPERMILL CAFE GST INCL');
    expect(isPossibleDuplicate(bill, { ...bill })).toBe(true);
  });

  it('still catches a genuinely re-imported tax line by its bank reference', () => {
    // Deliberate: a shared reference is proof of one real-world line arriving twice, and
    // suppressing that for tax rows would let a re-imported statement double-count its tax.
    const reimported: DuplicateCandidate = {
      ...taxRow('CGST'),
      externalReference: 'CARD/990004',
    };
    expect(isDeterministicDuplicate(reimported, { ...reimported })).toBe(true);
  });
});

describe('two lines of one statement are two movements', () => {
  /**
   * The defect this closes, reproduced on a synthetic bank statement.
   *
   * Invariant #10 guards against the ledger receiving one movement **twice** — an overlapping
   * statement, a second channel, a re-downloaded copy — and each of those arrives as its own
   * import batch. The rule never asked where a row came from, so every same-amount pair within
   * a day of *one* statement became a question, and because a statement prints a date, the
   * 24-hour window also paired consecutive days. On a synthetic 295-row statement with no
   * duplicates at all, all 100 questions it raised paired two lines of that one statement.
   */
  const DAY = new Date('2026-01-02T00:00:00Z');
  const NEXT_DAY = new Date('2026-01-03T00:00:00Z');

  /** What every line here shares: one ₹20 debit on one day, printing no reference. */
  const TWENTY: DuplicateCandidate = {
    amount: paise(2_000n),
    occurredAt: DAY,
    externalReference: null,
    direction: 'debit',
  };

  function line(overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
    return {
      ...TWENTY,
      rawDescription: 'UPI/SYNTH TEA STALL',
      importBatchId: 'statement-a',
      ...overrides,
    };
  }

  it('does not pair two lines of one statement whose words differ', () => {
    const other = line({ rawDescription: 'UPI/SYNTH AUTO RIDE' });
    expect(isPossibleDuplicate(line(), other)).toBe(false);
    expect(isPossibleDuplicate(other, line())).toBe(false);
  });

  it('does not pair two lines of one statement whose references differ', () => {
    const first = line({ externalReference: 'UPI-000000000001' });
    const second = line({ externalReference: 'UPI-000000000002' });
    expect(isPossibleDuplicate(first, second)).toBe(false);
    // One line printing a reference and the other none is a difference the statement printed too.
    expect(isPossibleDuplicate(first, line())).toBe(false);
  });

  it('does not pair lines of one statement printed on consecutive dates', () => {
    expect(isPossibleDuplicate(line(), line({ occurredAt: NEXT_DAY }))).toBe(false);
  });

  it('still asks about a line one statement prints twice, word for word', () => {
    // Nothing on the page tells these apart and no reference settles it, so it stays a person's
    // question — the same within-file restatement ADR-0019 already treats as real.
    expect(isPossibleDuplicate(line(), line())).toBe(true);
  });

  it('asks about the same resemblance arriving in two statements on the same day', () => {
    const elsewhere = line({
      importBatchId: 'statement-b',
      rawDescription: 'Paid to SYNTH TEA STALL',
      externalReference: '000000000001',
    });
    expect(isPossibleDuplicate(line(), elsewhere)).toBe(true);
    // A day later it is another day's movement (ADR-0070), however alike the two lines read.
    expect(isPossibleDuplicate(line(), { ...elsewhere, occurredAt: NEXT_DAY })).toBe(false);
  });

  it('never lets a missing batch remove a question the words would ask', () => {
    const unplaced: DuplicateCandidate = { ...TWENTY, rawDescription: 'UPI/SYNTH TEA STALL' };
    expect(isPossibleDuplicate(line(), unplaced)).toBe(true);
    expect(isPossibleDuplicate(unplaced, line())).toBe(true);
    // Different words are a difference whether or not anyone knows which statement printed them.
    const elsewhere: DuplicateCandidate = { ...TWENTY, rawDescription: 'UPI/SYNTH AUTO RIDE' };
    expect(isPossibleDuplicate(elsewhere, unplaced)).toBe(false);
    expect(isPossibleDuplicate(line(), elsewhere)).toBe(false);
  });

  it('asks as before when either side does not say what it printed', () => {
    // Missing words must never read as different words: an unknown can only add a question.
    const unread: DuplicateCandidate = { ...TWENTY, importBatchId: 'statement-a' };
    expect(isPossibleDuplicate(line(), unread)).toBe(true);
    expect(isPossibleDuplicate(unread, line())).toBe(true);
  });
});

describe('one movement recorded twice: the same day, the same amount, the same name', () => {
  /**
   * The owner's duplicate policy (ADR-0070), which settles what ADR-0069 left open.
   *
   * Two movements are one transaction for duplicate purposes when they fall on the same calendar
   * day, move the same amount the same way, and name the same payee — or, where a line names
   * nobody, are the same kind of line — **whichever accounts they came from**. Everything short of
   * that is two movements, and asking about it anyway was the noise: an unrelated card line and
   * bank line of one amount on the same or the next day. Every name here is invented.
   */
  const JAN_8 = new Date('2026-01-08T00:00:00Z');

  function bank(description: string, overrides: Partial<DuplicateCandidate> = {}) {
    return {
      amount: paise(25_300n),
      occurredAt: JAN_8,
      externalReference: null,
      direction: 'debit',
      accountId: 'bank-account',
      importBatchId: 'bank-statement',
      rawDescription: description,
      ...overrides,
    } satisfies DuplicateCandidate;
  }

  function card(description: string, overrides: Partial<DuplicateCandidate> = {}) {
    return bank(description, {
      accountId: 'card-account',
      importBatchId: 'card-statement',
      ...overrides,
    });
  }

  function paired(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
    const forward = isPossibleDuplicate(a, b);
    // The rule is a relation between two lines, not an ordering of them.
    expect(isPossibleDuplicate(b, a)).toBe(forward);
    return forward;
  }

  it('asks about a card line and a bank line that name the same shop on the same day', () => {
    expect(paired(bank('POS SYNTH SHOE STORE'), card('SYNTH SHOE STORE BANGALORE'))).toBe(true);
  });

  it('does not ask about a card line and a bank line that name different shops', () => {
    expect(paired(bank('UPI/SYNTH TEA STALL/000000000101'), card('SYNTH BOOK DEPOT MUMBAI'))).toBe(
      false,
    );
    expect(paired(bank('IMPS/P2A/000000000104/SYNTH LANDLORD'), card('SYNTH FUEL STATION'))).toBe(
      false,
    );
  });

  it('asks about two lines at any time of one calendar day', () => {
    const evening = new Date('2026-01-08T18:30:00Z');
    expect(
      paired(
        bank('UPI/SYNTH GROCER/000000000105'),
        card('Paid to SYNTH GROCER', { occurredAt: evening }),
      ),
    ).toBe(true);
  });

  it('does not ask about lines on two calendar days, even seconds apart', () => {
    const lateNight = new Date('2026-01-08T23:59:45Z');
    const justAfter = new Date('2026-01-09T00:00:15Z');
    expect(
      paired(
        bank('UPI/SYNTH GROCER/000000000105', { occurredAt: lateNight }),
        card('Paid to SYNTH GROCER', { occurredAt: justAfter }),
      ),
    ).toBe(false);
    // And a statement's next printed date is the next day, however alike the lines read.
    expect(
      paired(
        bank('POS SYNTH SHOE STORE'),
        card('SYNTH SHOE STORE', { occurredAt: new Date('2026-01-09T00:00:00Z') }),
      ),
    ).toBe(false);
  });

  it.each([
    [
      'a card-rail UPI line and a bank UPI line',
      'UPICC/300000000201/SYNTH PHARMACY',
      'UPI/SYNTH PHARMACY/000000000103',
    ],
    [
      'an app’s “Paid to” and the bank’s narration',
      'Paid to SYNTH GROCER',
      'UPI/SYNTH GROCER/000000000105',
    ],
    ['a card descriptor ending in its city', 'SYNTH SHOE STORE BANGALORE', 'POS SYNTH SHOE STORE'],
    ['a name printed with and without its spaces', 'BIG BASKET', 'BIGBASKET'],
    ['punctuation and letter case', 'Synth-Grocer', 'SYNTH GROCER'],
    [
      'a handle and a legal suffix on one side only',
      'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      'Paid to BLINKIT INDIA PVT LTD',
    ],
  ])('reads one name through %s', (_how, left, right) => {
    expect(paired(bank(left), card(right))).toBe(true);
  });

  it.each([
    ['share only their first word', 'UPI/SYNTH TEA STALL/000000000112', 'SYNTH AUTO STAND PUNE'],
    ['share only a first word, again', 'SAMPLE CAFE', 'SAMPLE BOOKS'],
    ['share a first and a last word', 'SRI SAI TRADERS', 'SRI BALAJI TRADERS'],
    ['differ by one letter', 'SYNTH CAFE', 'SYNTH CAKE'],
  ])('does not treat two names that %s as one', (_how, left, right) => {
    expect(paired(bank(left), card(right))).toBe(false);
  });

  it('tells an instalment’s principal from its interest, however alike the rest reads', () => {
    expect(
      paired(
        card('SYNTH GADGET HUB - PRINCIPAL 2/6'),
        card('SYNTH GADGET HUB - INTEREST 2/6', { importBatchId: 'card-statement-2' }),
      ),
    ).toBe(false);
  });

  it('asks about two lines that name nobody when they are the same kind of line', () => {
    expect(
      paired(
        card('EMI INTEREST 3/6'),
        card('EMI INTEREST 3/6', { importBatchId: 'card-statement-2' }),
      ),
    ).toBe(true);
  });

  it('treats two references of one kind that differ as two movements', () => {
    // Same pharmacy, same amount, same day — but two UPI transaction numbers, and a UTR names
    // exactly one transaction.
    expect(
      paired(
        bank('UPI/SYNTH PHARMACY/000000000103', {
          externalReference: 'UPI-000000000103',
          referenceType: 'upi_utr',
        }),
        card('UPICC/300000000201/SYNTH PHARMACY', {
          externalReference: '300000000201',
          referenceType: 'upi_utr',
        }),
      ),
    ).toBe(false);
    // The same on one account's two statements: the second juice of the day is a second juice.
    expect(
      paired(
        bank('UPI/SYNTH JUICE BAR/000000000109', {
          externalReference: 'UPI-000000000109',
          referenceType: 'upi_utr',
        }),
        bank('UPI/SYNTH JUICE BAR/000000000110', {
          externalReference: 'UPI-000000000110',
          referenceType: 'upi_utr',
          importBatchId: 'bank-statement-2',
        }),
      ),
    ).toBe(false);
  });

  it('lets the names decide when a reference is missing, or is of another kind', () => {
    const bankLine = bank('UPI/SYNTH SHOE STORE/000000000121', {
      externalReference: 'UPI-000000000121',
      referenceType: 'upi_utr',
    });
    expect(paired(bankLine, card('SYNTH SHOE STORE BANGALORE'))).toBe(true);
    expect(
      paired(
        bankLine,
        card('SYNTH SHOE STORE BANGALORE', {
          externalReference: 'CARD/000000000221',
          referenceType: 'card_reference',
        }),
      ),
    ).toBe(true);
    expect(paired(bankLine, card('SYNTH BOOK DEPOT MUMBAI'))).toBe(false);
  });

  it('asks about one identifier in two packagings, whatever the two names say', () => {
    // A bank may print a payee's legal name where the app prints the brand. The transaction
    // number is the stronger witness, and a shared one is never silently kept as two.
    expect(
      paired(
        bank('UPI/SYNTH TECHNOLOGIES/000000000105', {
          externalReference: 'UPI-000000000105',
          referenceType: 'upi_utr',
        }),
        card('Paid to SYNTH GROCER', {
          accountId: 'upi-account',
          externalReference: '000000000105',
          referenceType: 'upi_utr',
        }),
      ),
    ).toBe(true);
  });

  it('never lets an unread or nameless line remove a question', () => {
    const unread: DuplicateCandidate = {
      amount: paise(25_300n),
      occurredAt: JAN_8,
      externalReference: null,
      direction: 'debit',
      importBatchId: 'bank-statement',
    };
    expect(paired(unread, card('SYNTH SHOE STORE BANGALORE'))).toBe(true);
    // A bare transaction number names nobody and says nothing about what kind of line it is.
    expect(paired(bank('UPI/412345678901'), card('SYNTH SHOE STORE BANGALORE'))).toBe(true);
  });

  it('still never asks across directions or amounts', () => {
    expect(
      paired(bank('POS SYNTH SHOE STORE'), card('SYNTH SHOE STORE', { direction: 'credit' })),
    ).toBe(false);
    expect(
      paired(bank('POS SYNTH SHOE STORE'), card('SYNTH SHOE STORE', { amount: paise(25_400n) })),
    ).toBe(false);
  });

  describe('a name that is sufficiently similar', () => {
    /**
     * The owner's word is "the same or sufficiently similar name". Two shapes of one name failed
     * the every-word rule while being plainly one payee: a bank narration carries a note after
     * its payee (`UPI / payee / number / note`) while a card descriptor carries a city, so each
     * side has a word the other lacks; and an issuer cuts a long descriptor short.
     */
    it('reads the payee a bank narration names, not the note after it', () => {
      expect(
        paired(
          bank('UPI/SYNTH CAFE/000000000113/Payment from Phone'),
          card('SYNTH CAFE BANGALORE'),
        ),
      ).toBe(true);
      // A payee of one word is still a name.
      expect(
        paired(
          bank('UPI/SAMPLEEATS/000000000117/Payment from Phone'),
          card('SAMPLEEATS BANGALORE'),
        ),
      ).toBe(true);
    });

    it('reads the payee past a rail, a branch code, a number and a handle', () => {
      expect(
        paired(
          bank('UPI/DR/000000000118/SYNTH BAKERY/ABCD/synthbakery@okaxis/Birthday cake'),
          card('SYNTH BAKERY MUMBAI'),
        ),
      ).toBe(true);
      expect(
        paired(
          bank('NEFT/ABCD0001234/SYNTH LANDLORD/RENT FOR SEPTEMBER'),
          card('SYNTH LANDLORD HOUSE', { accountId: 'hand-entry', importBatchId: 'hand-entry' }),
        ),
      ).toBe(true);
      // A card's own UPI rail names its payee the same way.
      expect(
        paired(card('UPICC/300000000301/SYNTH FLORIST'), bank('SYNTH FLORIST AND GIFTS')),
      ).toBe(true);
    });

    it('counts a word the issuer cut short as the word it begins', () => {
      expect(
        paired(bank('UPI/SYNTH SUPERMARKET/000000000116'), card('SYNTH SUPERMARKE MUMBAI')),
      ).toBe(true);
      expect(paired(bank('SYNTH SUPERMARKET'), card('SYNTH SUPERM'))).toBe(true);
    });

    it.each([
      [
        'a note’s words are not a name',
        'UPI/SYNTH CAFE/000000000113/Payment from Phone',
        'SYNTH PHONE STORE MUMBAI',
      ],
      ['three letters are never a word cut short', 'SYNTH TEA', 'SYNTH TEAK HOUSE'],
      ['nor is a short word inside a longer one', 'SRI SAI TRADERS', 'SRI SAIRAM TRADERS'],
      ['a cut keeps the start of a word, not its end', 'SYNTH MART', 'SYNTH SUPERMART PUNE'],
      [
        'a payee sharing only a first word',
        'UPI/SYNTH TEA STALL/000000000112/Payment from Phone',
        'SYNTH AUTO STAND PUNE',
      ],
      [
        'a payee that is not all there',
        'UPI/SYNTH CAFE HOUSE/000000000119/Payment from Phone',
        'SYNTH CAFE BANGALORE',
      ],
      [
        'two descriptors each with a word the other lacks, and no payee to read',
        'SYNTH CAFE BANGALORE',
        'SYNTH CAFE LUNCH',
      ],
    ])('does not read one name where %s', (_why, left, right) => {
      expect(paired(bank(left), card(right))).toBe(false);
    });
  });
});

describe('the duplicate rule over many synthetic pairs', () => {
  /**
   * Properties that hold for every pair, checked over a seeded sample rather than a list of
   * cases someone thought of: the rule is a relation (never an ordering), it never looks past
   * the day, the amount or the direction, a same-kind reference that differs never adds a
   * question, and a line printed again by another import with no reference is always asked.
   */
  const WORDS = [
    'UPI/SYNTH CAFE/000000000201/Payment from Phone',
    'SYNTH CAFE BANGALORE',
    'UPICC/300000000202/SYNTH CAFE',
    'POS SYNTH SHOE STORE',
    'SYNTH SHOE STORE PUNE',
    'Paid to SYNTH GROCER',
    'UPI/SYNTH GROCER/000000000203',
    'SYNTH SUPERMARKE MUMBAI',
    'SYNTH SUPERMARKET',
    'EMI INTEREST 3/6',
    'SYNTH GADGET HUB - PRINCIPAL 2/6',
    'SYNTH GADGET HUB - INTEREST 2/6',
    'CGST',
    'SGST',
    'UPI/412345678901',
    'SRI SAI TRADERS',
    'SRI BALAJI TRADERS',
    'PAYMENT RECEIVED - THANK YOU',
  ];
  const DAYS = ['2026-01-08T00:00:00Z', '2026-01-08T18:30:00Z', '2026-01-09T00:00:00Z'];
  const REFERENCES: ReadonlyArray<readonly [string | null, string | null]> = [
    [null, null],
    ['UPI-000000000301', 'upi_utr'],
    ['UPI-000000000302', 'upi_utr'],
    ['CARD/000000000303', 'card_reference'],
    ['000000000301', 'upi_utr'],
  ];

  /** mulberry32, so the sample is the same sample every run. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  function sample(count: number): DuplicateCandidate[] {
    const next = seeded(20260922);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    return Array.from({ length: count }, () => {
      const [reference, kind] = pick(REFERENCES);
      return {
        amount: paise(pick([2_808n, 25_300n])),
        occurredAt: new Date(pick(DAYS)),
        externalReference: reference,
        referenceType: kind,
        direction: pick(['debit', 'credit'] as const),
        rawDescription: pick(WORDS),
        importBatchId: pick(['bank-statement', 'card-statement', 'upi-app']),
        accountId: pick(['bank', 'card', 'upi']),
      };
    });
  }

  const ROWS = sample(160);
  const PAIRS = ROWS.flatMap((a, i) => ROWS.slice(i + 1).map((b) => [a, b] as const));

  it('is a relation: the order two lines are compared in never changes the answer', () => {
    const asymmetric = PAIRS.filter(
      ([a, b]) => isPossibleDuplicate(a, b) !== isPossibleDuplicate(b, a),
    );
    expect(asymmetric).toEqual([]);
  });

  it('never asks across two days, two amounts or two directions', () => {
    const day = (row: DuplicateCandidate): string => row.occurredAt.toISOString().slice(0, 10);
    const crossing = PAIRS.filter(
      ([a, b]) =>
        isPossibleDuplicate(a, b) &&
        (day(a) !== day(b) || a.amount !== b.amount || a.direction !== b.direction),
    );
    expect(crossing).toEqual([]);
    // The sample is not trivially empty of questions.
    expect(PAIRS.filter(([a, b]) => isPossibleDuplicate(a, b)).length).toBeGreaterThan(20);
  });

  it('never asks about two different numbers of one kind', () => {
    const told = PAIRS.filter(
      ([a, b]) =>
        a.externalReference !== null &&
        b.externalReference !== null &&
        a.referenceType === b.referenceType &&
        !a.externalReference.endsWith(b.externalReference) &&
        !b.externalReference.endsWith(a.externalReference) &&
        isPossibleDuplicate(a, b),
    );
    expect(told).toEqual([]);
  });

  it('always asks about a line another import prints again, with no number to settle it', () => {
    const unasked = ROWS.filter((row) => {
      const printedAgain: DuplicateCandidate = {
        ...row,
        externalReference: null,
        referenceType: null,
        importBatchId: `${row.importBatchId ?? 'unknown'}-again`,
      };
      return !isPossibleDuplicate(
        { ...row, externalReference: null, referenceType: null },
        printedAgain,
      );
    });
    expect(unasked).toEqual([]);
  });
});
