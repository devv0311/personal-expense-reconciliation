/**
 * Money.
 *
 * Every monetary value in this system is an integer count of **minor units** (paise for
 * INR, 100 to the rupee) carried as a `bigint`. Never a float, never a JavaScript
 * `number`, never a `numeric`/`decimal` — see `docs/domain/invariants.md` #12 and
 * `docs/decisions/0012-deterministic-money-rounding.md`.
 *
 * `Paise` is **signed**. Non-negativity is a per-field rule (`AllocationLine.amount >= 0`,
 * `Expense.amount > 0`), not a property of the representation: `NetBalance(X, Y)` is
 * legitimately negative when Y owes X, so a type that forbade negatives could not express
 * the bidirectional balance ADR-0006 requires.
 */

import { DomainError } from './errors.js';

declare const PAISE_BRAND: unique symbol;

/**
 * An exact, signed integer count of currency minor units.
 *
 * Branded so a raw `bigint` from elsewhere (a row count, an index) cannot be passed where
 * money is expected. Arithmetic goes through the helpers below, which re-apply the brand.
 */
export type Paise = bigint & { readonly [PAISE_BRAND]: true };

/** Minor units per major unit. V1 is INR-only, so this is a constant, not a lookup. */
export const MINOR_UNITS_PER_MAJOR = 100n;

/** Number of decimal places implied by {@link MINOR_UNITS_PER_MAJOR}. */
export const MINOR_UNIT_EXPONENT = 2;

/**
 * The only currency `src/domain` can do arithmetic in for V1.
 *
 * `payments`/`expenses`/`accounts` all carry a `currency` column so a later multi-currency
 * phase is a lookup addition rather than a migration, but `domain` deliberately does not
 * branch on it yet — mixing currencies inside one computation is rejected, never coerced
 * (`invariants.md` #12, "Currency scope for V1").
 */
export const SUPPORTED_CURRENCY = 'INR';

/** A currency code as stored on `payments`/`expenses`/`accounts`. */
export type CurrencyCode = string;

/** Zero paise. */
export const ZERO = 0n as Paise;

/** Wraps a `bigint` count of minor units as {@link Paise}. */
export function paise(value: bigint): Paise {
  if (typeof value !== 'bigint') {
    throw new DomainError(
      'MONEY_NOT_BIGINT',
      `Monetary values must be a bigint count of minor units, received ${typeof value}. ` +
        'A JavaScript number cannot represent money exactly (invariants.md #12).',
      { received: typeof value },
    );
  }
  return value as Paise;
}

/** Adds two amounts exactly. */
export function addPaise(a: Paise, b: Paise): Paise {
  return (a + b) as Paise;
}

/** Subtracts `b` from `a` exactly. The result may be negative. */
export function subtractPaise(a: Paise, b: Paise): Paise {
  return (a - b) as Paise;
}

/** Negates an amount. */
export function negatePaise(a: Paise): Paise {
  const raw: bigint = a;
  return -raw as Paise;
}

/** Sums a list exactly. An empty list sums to {@link ZERO}. */
export function sumPaise(values: readonly Paise[]): Paise {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total as Paise;
}

/** Total ordering over amounts: -1, 0, or 1. */
export function comparePaise(a: Paise, b: Paise): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** True when the amount is strictly less than zero. */
export function isNegative(value: Paise): boolean {
  return value < 0n;
}

/** True when the amount is exactly zero. */
export function isZero(value: Paise): boolean {
  return value === 0n;
}

/** The larger of two amounts. */
export function maxPaise(a: Paise, b: Paise): Paise {
  return a >= b ? a : b;
}

/**
 * Asserts `value >= 0`, naming the field in the error.
 *
 * Zero passes: a zero-amount `AllocationLine` is the defined, expected shape for an
 * original beneficiary of a fully refunded expense (`invariants.md` #12a, ADR-0013).
 */
export function assertNonNegative(value: Paise, field: string): Paise {
  if (value < 0n) {
    throw new DomainError('MONEY_NEGATIVE', `${field} must be >= 0, received ${value} paise.`, {
      field,
      value: value.toString(),
    });
  }
  return value;
}

/** Asserts `value > 0`, naming the field in the error. */
export function assertPositive(value: Paise, field: string): Paise {
  if (value <= 0n) {
    throw new DomainError('MONEY_NEGATIVE', `${field} must be > 0, received ${value} paise.`, {
      field,
      value: value.toString(),
    });
  }
  return value;
}

/**
 * An exact major-unit decimal: optional sign, digits, optionally a `.` and one or two
 * more digits. Deliberately strict — no thousands separators, no exponent, no surrounding
 * whitespace, no bare leading `.`, no trailing `.`, no explicit `+`. Anything looser would
 * make "did the import really say ₹9.00 or ₹900?" a judgement call.
 */
const MAJOR_UNIT_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses an exact decimal string of major units into {@link Paise}.
 *
 * String in, integer out — the value never passes through a float, so `'8.29'` yields
 * exactly `829n` where `8.29 * 100` yields `828.9999999999999`. This is the only supported
 * way to bring a human-written or externally-supplied rupee figure into the domain.
 */
export function parseMajorUnitsToPaise(text: string): Paise {
  const match = typeof text === 'string' ? MAJOR_UNIT_PATTERN.exec(text) : null;
  if (match === null) {
    throw new DomainError(
      'MONEY_MALFORMED_MAJOR_UNITS',
      `"${String(text)}" is not an exact major-unit amount. Expected digits with at most ` +
        `${MINOR_UNIT_EXPONENT} decimal places, e.g. "1240.55".`,
      { received: String(text) },
    );
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  const minorUnits = fraction.padEnd(MINOR_UNIT_EXPONENT, '0');
  const magnitude = BigInt(whole) * MINOR_UNITS_PER_MAJOR + BigInt(minorUnits);
  return (sign === '-' ? -magnitude : magnitude) as Paise;
}

/**
 * Renders {@link Paise} as an exact major-unit decimal string, always with
 * {@link MINOR_UNIT_EXPONENT} decimal places. For display and for fixture round-tripping —
 * never as an input to further arithmetic.
 */
export function formatMajorUnits(value: Paise): string {
  const raw: bigint = value;
  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;
  const whole = magnitude / MINOR_UNITS_PER_MAJOR;
  const fraction = magnitude % MINOR_UNITS_PER_MAJOR;
  const fractionText = fraction.toString().padStart(MINOR_UNIT_EXPONENT, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fractionText}`;
}

/**
 * Asserts every currency entering one computation is the same, supported currency, and
 * returns it.
 *
 * An empty input set is treated as {@link SUPPORTED_CURRENCY}: a computation with no
 * monetary inputs (an allocation over zero lines, a balance between two people who have
 * never transacted) has nothing to disagree about.
 */
export function assertSingleCurrency(
  currencies: readonly CurrencyCode[],
  context: string,
): CurrencyCode {
  const distinct = [...new Set(currencies)];
  if (distinct.length > 1) {
    throw new DomainError(
      'CURRENCY_UNSUPPORTED',
      `${context} mixes currencies (${distinct.join(', ')}). V1 does no currency conversion; ` +
        'mixed-currency computations are rejected, never silently coerced (invariants.md #12).',
      { context, currencies: distinct.join(',') },
    );
  }
  const [only] = distinct;
  if (only !== undefined && only !== SUPPORTED_CURRENCY) {
    throw new DomainError(
      'CURRENCY_UNSUPPORTED',
      `${context} uses currency ${only}; V1 supports arithmetic in ${SUPPORTED_CURRENCY} only ` +
        '(invariants.md #12, "Currency scope for V1").',
      { context, currency: only },
    );
  }
  return SUPPORTED_CURRENCY;
}
