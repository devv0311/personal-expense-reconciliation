import { describe, expect, it } from "vitest";
import { formatPaise } from "./money";

describe("formatPaise", () => {
  it("formats a whole-rupee amount", () => {
    expect(formatPaise("640000")).toEqual({ text: "₹6,400.00", isNegative: false, isZero: false });
  });

  it("formats paise below one rupee", () => {
    expect(formatPaise("64")).toMatchObject({ text: "₹0.64" });
  });

  it("formats exactly zero", () => {
    expect(formatPaise("0")).toEqual({ text: "₹0.00", isNegative: false, isZero: true });
  });

  it("formats a negative amount with a minus sign and isNegative", () => {
    const result = formatPaise("-64000");
    expect(result.isNegative).toBe(true);
    expect(result.text).toBe("−₹640.00");
  });

  it("groups digits the Indian way (last 3, then pairs)", () => {
    expect(formatPaise("123456700")).toMatchObject({ text: "₹12,34,567.00" });
  });

  it("groups a four-digit rupee amount with a single comma", () => {
    expect(formatPaise("1000000")).toMatchObject({ text: "₹10,000.00" });
  });

  it("does not group a three-digit-or-fewer rupee amount", () => {
    expect(formatPaise("50000")).toMatchObject({ text: "₹500.00" });
  });

  it("stays exact for a value beyond Number.MAX_SAFE_INTEGER", () => {
    // A plain `Number` division here would silently lose precision (invariants.md #12) — this
    // checks the digits formatPaise produces against an independent BigInt computation, rather
    // than a hand-grouped literal, so the assertion can't itself hide a grouping mistake.
    const huge = 9_007_199_254_740_992n + 100n; // beyond 2^53
    const expectedRupees = huge / 100n;
    const expectedCents = huge % 100n;

    const { text } = formatPaise(huge.toString());
    const digitsOnly = text.replace(/[₹,]/g, "");
    expect(digitsOnly).toBe(`${expectedRupees}.${expectedCents.toString().padStart(2, "0")}`);
  });
});
