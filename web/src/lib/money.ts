/**
 * Formatting money for display — the one thing this app is allowed to do to a money value.
 *
 * Every amount arrives as an exact decimal string of paise (the API never sends a float or a
 * JS `number` for money, `invariants.md` #12). Formatting stays in `BigInt` arithmetic the
 * whole way through rather than routing through `Number` — a value near 2^53 would lose
 * precision through a plain division, which is exactly the failure mode invariant #12 exists
 * to prevent. Nothing here adds, subtracts, or otherwise recomputes a figure the backend
 * already produced.
 */

const RUPEE_SIGN = "₹";
const MINUS_SIGN = "−";

/** Groups an unsigned digit string the Indian way: last 3, then pairs — "1234567" → "12,34,567". */
function groupIndianDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const pairs = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${pairs},${last3}`;
}

export interface FormattedMoney {
  readonly text: string;
  readonly isNegative: boolean;
  readonly isZero: boolean;
}

/** Formats an exact paise string (e.g. `"-64000"`) as `{ text: "-₹640.00", isNegative: true }`. */
export function formatPaise(paise: string): FormattedMoney {
  const value = BigInt(paise);
  const isNegative = value < 0n;
  const absolute = isNegative ? -value : value;
  const rupees = absolute / 100n;
  const cents = absolute % 100n;
  const text = `${isNegative ? MINUS_SIGN : ""}${RUPEE_SIGN}${groupIndianDigits(
    rupees.toString(),
  )}.${cents.toString().padStart(2, "0")}`;
  return { text, isNegative, isZero: value === 0n };
}

/**
 * Parses a rupee amount a person typed into the exact paise string the API expects.
 *
 * This is the only direction-of-travel this file has besides formatting, and it is deliberately
 * not arithmetic over ledger state: it converts *what someone typed in a form* into the wire
 * representation, in pure string handling with no `Number` anywhere. `"1,234.5"` becomes
 * `"123450"`, exactly, at any magnitude.
 *
 * Rejections are returned, never thrown and never rounded away: three decimal places is a
 * typo, not a value to silently truncate to two.
 */
export type ParsedRupees =
  { readonly ok: true; readonly paise: string } | { readonly ok: false; readonly message: string };

export function parseRupeeInput(
  raw: string,
  options: { allowNegative?: boolean } = {},
): ParsedRupees {
  const cleaned = raw.replace(/[\s,₹]/g, "");
  if (cleaned.length === 0) return { ok: false, message: "Enter an amount." };

  const negative = cleaned.startsWith("-");
  if (negative && options.allowNegative !== true) {
    return { ok: false, message: "This amount cannot be negative." };
  }
  const unsigned = negative ? cleaned.slice(1) : cleaned;

  if (!/^\d*(\.\d*)?$/.test(unsigned) || unsigned === "." || unsigned.length === 0) {
    return { ok: false, message: "Use digits and at most one decimal point." };
  }

  const [whole = "", fraction = ""] = unsigned.split(".");
  if (fraction.length > 2) {
    return { ok: false, message: "Rupees have at most two decimal places." };
  }
  const paise = `${whole === "" ? "0" : whole}${fraction.padEnd(2, "0")}`;
  // `BigInt` normalizes leading zeroes, so "0050" and "50" produce the same string.
  const value = BigInt(paise);
  return { ok: true, paise: (negative ? -value : value).toString() };
}

/** `"123450"` → `"1234.50"` — the editable form of a stored amount, for a pre-filled field. */
export function toRupeeInput(paise: string): string {
  const value = BigInt(paise);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

/** Sums exact paise strings. Used only to echo what a form's fields add up to, never a ledger figure. */
export function sumPaise(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

/** Compares two exact paise strings: -1, 0 or 1. No `Number` conversion at any magnitude. */
export function comparePaise(a: string, b: string): -1 | 0 | 1 {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `true` when the exact paise string is zero — never `parseInt(value) === 0`. */
export function isZeroPaise(value: string): boolean {
  return BigInt(value) === 0n;
}
