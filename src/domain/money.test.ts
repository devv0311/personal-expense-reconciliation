import { describe, expect, it } from 'vitest';

import {
  MINOR_UNITS_PER_MAJOR,
  ZERO,
  addPaise,
  assertNonNegative,
  assertSingleCurrency,
  comparePaise,
  formatMajorUnits,
  isNegative,
  isZero,
  maxPaise,
  negatePaise,
  paise,
  parseMajorUnitsToPaise,
  subtractPaise,
  sumPaise,
} from './money.js';
import { DomainError } from './errors.js';

describe('money: paise representation', () => {
  it('treats one rupee as one hundred minor units', () => {
    expect(MINOR_UNITS_PER_MAJOR).toBe(100n);
  });

  it('wraps a bigint as paise without altering its value', () => {
    expect(paise(90000n)).toBe(90000n);
  });

  it('rejects a non-integer JavaScript number as a source of money', () => {
    // @ts-expect-error — the type system forbids this; the runtime guard is the second line
    // of defence for values crossing an untyped boundary (JSON, SQL driver, HTTP body).
    expect(() => paise(900.5)).toThrow(DomainError);
  });

  it('rejects a JavaScript number even when it happens to be integral', () => {
    // @ts-expect-error — see above.
    expect(() => paise(900)).toThrow(/bigint/i);
  });

  it('exposes zero as a reusable constant', () => {
    expect(ZERO).toBe(0n);
  });
});

describe('money: arithmetic', () => {
  it('adds two amounts exactly', () => {
    expect(addPaise(paise(33333n), paise(33333n))).toBe(66666n);
  });

  it('subtracts two amounts exactly', () => {
    expect(subtractPaise(paise(90000n), paise(15000n))).toBe(75000n);
  });

  it('allows subtraction to produce a negative amount (balances are signed)', () => {
    expect(subtractPaise(paise(100n), paise(400n))).toBe(-300n);
  });

  it('sums an empty list to zero', () => {
    expect(sumPaise([])).toBe(0n);
  });

  it('sums a list exactly', () => {
    expect(sumPaise([paise(33334n), paise(33333n), paise(33333n)])).toBe(100000n);
  });

  it('sums amounts far beyond IEEE-754 integer precision without loss', () => {
    // 2^53 + 1 paise. A float-backed implementation returns 9007199254740992.
    const beyondDoublePrecision = paise(9007199254740993n);
    expect(addPaise(beyondDoublePrecision, paise(1n))).toBe(9007199254740994n);
  });

  it('negates an amount', () => {
    expect(negatePaise(paise(500n))).toBe(-500n);
  });

  it('compares amounts as a total order', () => {
    expect(comparePaise(paise(1n), paise(2n))).toBe(-1);
    expect(comparePaise(paise(2n), paise(2n))).toBe(0);
    expect(comparePaise(paise(3n), paise(2n))).toBe(1);
  });

  it('reports sign and zero', () => {
    expect(isNegative(paise(-1n))).toBe(true);
    expect(isNegative(ZERO)).toBe(false);
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(paise(1n))).toBe(false);
  });

  it('returns the larger of two amounts', () => {
    expect(maxPaise(paise(300n), paise(700n))).toBe(700n);
  });
});

describe('money: non-negativity guard', () => {
  it('accepts zero, because a zero-amount allocation line is a valid shape', () => {
    expect(() => assertNonNegative(ZERO, 'allocationLine.amount')).not.toThrow();
  });

  it('rejects a negative amount and names the field', () => {
    expect(() => assertNonNegative(paise(-1n), 'allocationLine.amount')).toThrow(
      /allocationLine\.amount/,
    );
  });
});

describe('money: exact major-unit parsing', () => {
  it.each([
    ['900', 90000n],
    ['900.0', 90000n],
    ['900.00', 90000n],
    ['0', 0n],
    ['0.05', 5n],
    ['0.5', 50n],
    ['1240.55', 124055n],
    ['-450.25', -45025n],
    ['12345678901234.99', 1234567890123499n],
  ])('parses %s rupees exactly', (text, expected) => {
    expect(parseMajorUnitsToPaise(text)).toBe(expected);
  });

  it('parses a value that a float round-trip would corrupt', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; 8.29 * 100 === 828.9999999999999.
    expect(parseMajorUnitsToPaise('8.29')).toBe(829n);
  });

  it.each(['900.005', '900.123', '', 'abc', '9,00', '1e3', '900.', '.5', '+900', ' 900 '])(
    'rejects %s as a major-unit amount',
    (text) => {
      expect(() => parseMajorUnitsToPaise(text)).toThrow(DomainError);
    },
  );
});

describe('money: formatting', () => {
  it.each([
    [90000n, '900.00'],
    [5n, '0.05'],
    [50n, '0.50'],
    [0n, '0.00'],
    [-45025n, '-450.25'],
    [124055n, '1240.55'],
  ])('formats %s paise as %s', (amount, expected) => {
    expect(formatMajorUnits(paise(amount))).toBe(expected);
  });

  it('round-trips through parse and format', () => {
    expect(formatMajorUnits(parseMajorUnitsToPaise('1240.55'))).toBe('1240.55');
  });
});

describe('money: currency scope (V1 is INR-only, invariants.md #12)', () => {
  it('accepts a computation whose inputs share one currency', () => {
    expect(assertSingleCurrency(['INR', 'INR', 'INR'], 'allocation')).toBe('INR');
  });

  it('accepts an empty input set', () => {
    expect(assertSingleCurrency([], 'allocation')).toBe('INR');
  });

  it('rejects mixed currencies rather than silently coercing them', () => {
    expect(() => assertSingleCurrency(['INR', 'USD'], 'allocation')).toThrow(DomainError);
  });

  it('rejects a currency V1 cannot do arithmetic in, even used alone', () => {
    expect(() => assertSingleCurrency(['USD'], 'allocation')).toThrow(/USD/);
  });
});
