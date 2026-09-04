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
