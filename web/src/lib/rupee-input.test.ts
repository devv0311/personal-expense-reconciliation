import { describe, expect, it } from "vitest";
import { comparePaise, isZeroPaise, parseRupeeInput, sumPaise, toRupeeInput } from "./money";

/**
 * The one place `web/` turns something a person typed into the exact wire representation.
 *
 * Every case here is about exactness: no `Number` is involved at any magnitude, three decimal
 * places is a typo rather than something to round away, and a negative amount is refused unless
 * the caller is a statement balance (the only field in this system that is legitimately signed).
 */
describe("parseRupeeInput", () => {
  it("converts rupees to exact paise", () => {
    expect(parseRupeeInput("1234.50")).toEqual({ ok: true, paise: "123450" });
    expect(parseRupeeInput("0.01")).toEqual({ ok: true, paise: "1" });
    expect(parseRupeeInput("7")).toEqual({ ok: true, paise: "700" });
    expect(parseRupeeInput("7.5")).toEqual({ ok: true, paise: "750" });
    expect(parseRupeeInput(".5")).toEqual({ ok: true, paise: "50" });
  });

  it("accepts the separators a person actually types", () => {
    expect(parseRupeeInput("₹ 1,23,456.78")).toEqual({ ok: true, paise: "12345678" });
  });

  it("stays exact past the range a double can represent", () => {
    // 2^53 paise and one more: a float would round this; string handling does not.
    expect(parseRupeeInput("90071992547409.93")).toEqual({ ok: true, paise: "9007199254740993" });
  });

  it("refuses a third decimal place rather than rounding it", () => {
    const result = parseRupeeInput("10.005");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ message: "Rupees have at most two decimal places." });
  });

  it("refuses anything that is not a plain amount", () => {
    for (const input of ["", "  ", "abc", "1.2.3", "1e5", "."]) {
      expect(parseRupeeInput(input).ok).toBe(false);
    }
  });

  it("refuses a negative amount unless the caller opted in", () => {
    expect(parseRupeeInput("-100").ok).toBe(false);
    expect(parseRupeeInput("-100", { allowNegative: true })).toEqual({ ok: true, paise: "-10000" });
  });

  it("round-trips through the editable form", () => {
    expect(toRupeeInput("123450")).toBe("1234.50");
    expect(toRupeeInput("-250000")).toBe("-2500.00");
    expect(toRupeeInput("5")).toBe("0.05");
  });
});

describe("exact paise helpers", () => {
  it("sums without a Number anywhere in the path", () => {
    expect(sumPaise(["9007199254740993", "1"])).toBe("9007199254740994");
    expect(sumPaise([])).toBe("0");
  });

  it("compares exactly", () => {
    expect(comparePaise("100", "200")).toBe(-1);
    expect(comparePaise("200", "100")).toBe(1);
    expect(comparePaise("0", "0")).toBe(0);
    expect(comparePaise("9007199254740993", "9007199254740992")).toBe(1);
  });

  it("tests for zero without parsing to a Number", () => {
    expect(isZeroPaise("0")).toBe(true);
    expect(isZeroPaise("-0")).toBe(true);
    expect(isZeroPaise("1")).toBe(false);
  });
});
