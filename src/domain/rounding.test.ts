import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { paise, sumPaise } from './money.js';
import { equalWeights, splitByLargestRemainder } from './rounding.js';
import type { SplitWeight } from './rounding.js';

/**
 * The exhaustive rounding matrix required by `docs/testing/testing-strategy.md`
 * ("Exhaustive rounding test matrix"). Cases 1, 2, 3, 10 and 14 exercise
 * `splitByLargestRemainder` directly and live here.
 *
 * The remaining matrix cases are properties of the *callers*, and are tested where those
 * callers live, tagged with the same case numbers so the matrix can be grepped:
 *   - case 4 (percentage split), 5 (percentages not summing to 100),
 *     6 (item-based never invokes the algorithm)  -> `allocation.test.ts`
 *   - case 7 (group expansion, exact), 8 (group expansion, remainder)
 *                                                 -> `group-expansion.test.ts`
 *   - case 9 (adjustment, proportional, exact), 11 (full refund, one beneficiary),
 *     12 (full refund, several beneficiaries)      -> `adjustment.test.ts`
 *   - case 13 (custom distribution driving a line negative, rejected)
 *                                                 -> `adjustment.test.ts`
 */

/** Builds weights with keys chosen so lexicographic order is obvious in assertions. */
function weighted(entries: ReadonlyArray<readonly [string, bigint]>): SplitWeight[] {
  return entries.map(([key, weight]) => ({ key, weight }));
}

function amountsByKey(
  shares: ReadonlyArray<{ key: string; amount: bigint }>,
): Record<string, bigint> {
  return Object.fromEntries(shares.map((share) => [share.key, share.amount]));
}

describe('splitByLargestRemainder — matrix case 1: equal split, exact division', () => {
  it('splits ₹900 three ways with no remainder path taken', () => {
    const shares = splitByLargestRemainder(paise(90000n), equalWeights(['b', 'a', 'c']));

    expect(amountsByKey(shares)).toEqual({ a: 30000n, b: 30000n, c: 30000n });
  });

  it('sums to the total exactly', () => {
    const shares = splitByLargestRemainder(paise(90000n), equalWeights(['a', 'b', 'c']));

    expect(sumPaise(shares.map((share) => share.amount))).toBe(90000n);
  });
});

describe('splitByLargestRemainder — matrix case 2: equal split, remainder of 1', () => {
  const total = paise(100000n); // ₹1,000

  it('gives the odd paisa to the lexicographically first key, not the first-listed line', () => {
    // 'zoe' is listed first but sorts last; 'ana' must win the tie-break.
    const shares = splitByLargestRemainder(total, equalWeights(['zoe', 'mia', 'ana']));

    expect(amountsByKey(shares)).toEqual({ ana: 33334n, mia: 33333n, zoe: 33333n });
  });

  it('sums to exactly the total', () => {
    const shares = splitByLargestRemainder(total, equalWeights(['zoe', 'mia', 'ana']));

    expect(sumPaise(shares.map((share) => share.amount))).toBe(100000n);
  });

  it('does not give the odd paisa to the payer by virtue of being the payer', () => {
    // The payer here sorts last. The tie-break rule is ID order, deliberately not
    // "the payer absorbs the odd paisa" (ADR-0012, "Alternatives considered").
    const shares = splitByLargestRemainder(
      total,
      equalWeights(['payer_z', 'friend_a', 'friend_b']),
    );

    expect(amountsByKey(shares).friend_a).toBe(33334n);
    expect(amountsByKey(shares).payer_z).toBe(33333n);
  });
});

describe('splitByLargestRemainder — matrix case 3: remainder equal to N-1', () => {
  const keys = ['g', 'f', 'e', 'd', 'c', 'b', 'a'];

  it('gives six of seven lines the extra paisa, and the tie-break loser none', () => {
    // 10002 = 7 * 1428 + 6, so remainder === N - 1 === 6.
    const shares = splitByLargestRemainder(paise(10002n), equalWeights(keys));
    const byKey = amountsByKey(shares);

    expect(Object.values(byKey).filter((amount) => amount === 1429n)).toHaveLength(6);
    expect(byKey.g).toBe(1428n); // last lexicographically is the only line without it
    expect(sumPaise(shares.map((share) => share.amount))).toBe(10002n);
  });

  it("handles ₹100 split seven ways (the matrix's worked figure, remainder 4)", () => {
    const shares = splitByLargestRemainder(paise(10000n), equalWeights(keys));
    const byKey = amountsByKey(shares);

    expect(Object.values(byKey).filter((amount) => amount === 1429n)).toHaveLength(4);
    expect(Object.values(byKey).filter((amount) => amount === 1428n)).toHaveLength(3);
    expect(byKey.a).toBe(1429n);
    expect(byKey.g).toBe(1428n);
    expect(sumPaise(shares.map((share) => share.amount))).toBe(10000n);
  });
});

describe('splitByLargestRemainder — matrix case 10: unequal weights with a remainder', () => {
  it('divides ₹333 across ₹500/₹300/₹200 lines proportionally and exactly', () => {
    const shares = splitByLargestRemainder(
      paise(33300n),
      weighted([
        ['a_line', 50000n],
        ['b_line', 30000n],
        ['c_line', 20000n],
      ]),
    );

    expect(amountsByKey(shares)).toEqual({ a_line: 16650n, b_line: 9990n, c_line: 6660n });
    expect(sumPaise(shares.map((share) => share.amount))).toBe(33300n);
  });

  it('ranks by fractional remainder, not by line size', () => {
    // Weights 3:3:1 over a total of 1000 paise.
    //   base   = 428, 428, 142   (sum 998, remainder 2)
    //   frac   =   4,   4,   6   -> the SMALLEST line has the largest fractional remainder
    // So the 1-weight line must receive a paisa while one of the 3-weight lines does not.
    const shares = splitByLargestRemainder(
      paise(1000n),
      weighted([
        ['a_big', 3n],
        ['b_big', 3n],
        ['c_small', 1n],
      ]),
    );

    expect(amountsByKey(shares)).toEqual({ a_big: 429n, b_big: 428n, c_small: 143n });
    expect(sumPaise(shares.map((share) => share.amount))).toBe(1000n);
  });
});

describe('splitByLargestRemainder — matrix case 14: determinism', () => {
  it('produces byte-identical output when re-run with identical inputs', () => {
    const run = (): string =>
      JSON.stringify(
        splitByLargestRemainder(paise(100000n), equalWeights(['zoe', 'mia', 'ana'])),
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );

    expect(run()).toBe(run());
  });

  it('assigns the same amount to the same key regardless of input order', () => {
    const forward = splitByLargestRemainder(paise(10002n), equalWeights(['a', 'b', 'c', 'd']));
    const reversed = splitByLargestRemainder(paise(10002n), equalWeights(['d', 'c', 'b', 'a']));

    expect(amountsByKey(forward)).toEqual(amountsByKey(reversed));
  });

  it('returns shares in input order so callers can zip them back onto their lines', () => {
    const shares = splitByLargestRemainder(paise(10002n), equalWeights(['d', 'c', 'b', 'a']));

    expect(shares.map((share) => share.key)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('is deterministic when two lines share a tie-break key', () => {
    // Two item-based lines can legitimately name the same beneficiary. invariants.md #12
    // specifies the tie-break only down to the ID; input position completes it so the
    // result can never depend on unspecified ordering.
    const shares = splitByLargestRemainder(
      paise(100n),
      weighted([
        ['same', 1n],
        ['same', 1n],
        ['same', 1n],
      ]),
    );

    expect(shares.map((share) => share.amount)).toEqual([34n, 33n, 33n]);
  });
});

describe('splitByLargestRemainder — degenerate and boundary totals', () => {
  it('splits a total of zero into one zero-amount share per line (ADR-0013)', () => {
    const shares = splitByLargestRemainder(paise(0n), equalWeights(['a', 'b', 'c']));

    expect(shares).toHaveLength(3);
    expect(shares.map((share) => share.amount)).toEqual([0n, 0n, 0n]);
  });

  it('never returns an empty result for a zero total', () => {
    expect(splitByLargestRemainder(paise(0n), equalWeights(['only']))).toHaveLength(1);
  });

  it('assigns the whole total to a single line', () => {
    expect(splitByLargestRemainder(paise(45000n), equalWeights(['solo']))).toEqual([
      { key: 'solo', amount: 45000n },
    ]);
  });

  it('gives a zero-weight line zero, without disturbing the others', () => {
    const shares = splitByLargestRemainder(
      paise(1000n),
      weighted([
        ['a', 0n],
        ['b', 1n],
      ]),
    );

    expect(amountsByKey(shares)).toEqual({ a: 0n, b: 1000n });
  });

  it('splits a total of zero across zero weights', () => {
    const shares = splitByLargestRemainder(
      paise(0n),
      weighted([
        ['a', 0n],
        ['b', 0n],
      ]),
    );

    expect(shares.map((share) => share.amount)).toEqual([0n, 0n]);
  });

  it('handles amounts far above IEEE-754 integer precision', () => {
    const total = paise(9007199254740993n); // 2^53 + 1
    const shares = splitByLargestRemainder(total, equalWeights(['a', 'b']));

    expect(amountsByKey(shares)).toEqual({ a: 4503599627370497n, b: 4503599627370496n });
    expect(sumPaise(shares.map((share) => share.amount))).toBe(9007199254740993n);
  });
});

describe('splitByLargestRemainder — the sum invariant holds for every input tried', () => {
  it('always sums to the total across a swept range of totals and line counts', () => {
    for (let lineCount = 1; lineCount <= 9; lineCount += 1) {
      const keys = Array.from({ length: lineCount }, (_unused, index) => `person_${index}`);
      for (let total = 0n; total <= 400n; total += 7n) {
        const shares = splitByLargestRemainder(paise(total), equalWeights(keys));

        expect(sumPaise(shares.map((share) => share.amount))).toBe(total);
        expect(shares).toHaveLength(lineCount);
      }
    }
  });

  it('always sums to the total under unequal weights', () => {
    const weights = weighted([
      ['a', 7n],
      ['b', 11n],
      ['c', 13n],
      ['d', 1n],
    ]);
    for (let total = 0n; total <= 500n; total += 1n) {
      const shares = splitByLargestRemainder(paise(total), weights);

      expect(sumPaise(shares.map((share) => share.amount))).toBe(total);
    }
  });

  it('never produces a negative share from non-negative inputs', () => {
    const shares = splitByLargestRemainder(
      paise(1n),
      weighted([
        ['a', 1000n],
        ['b', 1n],
      ]),
    );

    expect(shares.every((share) => share.amount >= 0n)).toBe(true);
  });
});

describe('splitByLargestRemainder — invalid input is rejected, never coerced', () => {
  it('rejects an empty line set', () => {
    expect(() => splitByLargestRemainder(paise(1000n), [])).toThrow(DomainError);
  });

  it('rejects a negative total', () => {
    expect(() => splitByLargestRemainder(paise(-1n), equalWeights(['a']))).toThrow(
      /negative|>= 0/i,
    );
  });

  it('rejects a negative weight', () => {
    expect(() => splitByLargestRemainder(paise(1000n), weighted([['a', -1n]]))).toThrow(
      DomainError,
    );
  });

  it('rejects a non-zero total spread across weights that sum to zero', () => {
    expect(() =>
      splitByLargestRemainder(
        paise(1000n),
        weighted([
          ['a', 0n],
          ['b', 0n],
        ]),
      ),
    ).toThrow(/weight/i);
  });

  it('rejects a blank tie-break key, which would make ordering ambiguous', () => {
    expect(() => splitByLargestRemainder(paise(1000n), weighted([['', 1n]]))).toThrow(DomainError);
  });
});

describe('equalWeights', () => {
  it('gives every key a weight of one', () => {
    expect(equalWeights(['a', 'b'])).toEqual([
      { key: 'a', weight: 1n },
      { key: 'b', weight: 1n },
    ]);
  });
});
