import { describe, expect, it } from 'vitest';

import {
  assertBoundaryIsNotAProviderReading,
  BALANCE_READING_FRESHNESS_MS,
  classifyBalanceReading,
  compareBalanceReading,
  summarizeReadCompleteness,
} from './balance-reading.js';
import { isDomainError } from './errors.js';
import { paise } from './money.js';

const PERIOD_END = new Date('2026-08-31T18:29:59.999Z');

function reading(overrides: Partial<Parameters<typeof classifyBalanceReading>[0]> = {}) {
  return {
    balance: paise(1_234_500n),
    asOf: new Date('2026-08-31T18:00:00.000Z'),
    fetchedAt: new Date('2026-09-01T04:00:00.000Z'),
    status: 'ok' as const,
    ...overrides,
  };
}

describe('classifyBalanceReading', () => {
  it('calls a reading from within the freshness window fresh', () => {
    expect(classifyBalanceReading(reading(), PERIOD_END)).toBe('fresh');
  });

  it('calls a reading from outside it stale, in either direction', () => {
    const before = new Date(PERIOD_END.getTime() - BALANCE_READING_FRESHNESS_MS - 1000);
    const after = new Date(PERIOD_END.getTime() + BALANCE_READING_FRESHNESS_MS + 1000);
    expect(classifyBalanceReading(reading({ asOf: before }), PERIOD_END)).toBe('stale');
    expect(classifyBalanceReading(reading({ asOf: after }), PERIOD_END)).toBe('stale');
  });

  it('calls a reading with no balance unusable — never a zero', () => {
    expect(
      classifyBalanceReading(reading({ balance: null, status: 'unavailable' }), PERIOD_END),
    ).toBe('unusable');
  });

  it('calls a reading with no instant unusable, however recently it was fetched', () => {
    // A figure with no instant attached says "this account held ₹X at some point", which is
    // not a statement about a period end at all.
    expect(classifyBalanceReading(reading({ asOf: null }), PERIOD_END)).toBe('unusable');
  });
});

describe('compareBalanceReading', () => {
  it('reports agreement only when both figures are known and identical', () => {
    const result = compareBalanceReading(reading(), paise(1_234_500n), PERIOD_END);
    expect(result.verdict).toBe('agrees');
    expect(result.difference).toBe(0n);
    expect(result.usability).toBe('fresh');
    expect(result.caveat).toBeUndefined();
  });

  it('reports a signed difference when they disagree', () => {
    const result = compareBalanceReading(reading(), paise(1_200_000n), PERIOD_END);
    expect(result.verdict).toBe('differs');
    expect(result.difference).toBe(34_500n);
  });

  it('never calls an unknown ledger figure agreement', () => {
    // The audit's eighth dead end in another costume: an absence is not agreement.
    const result = compareBalanceReading(reading(), null, PERIOD_END);
    expect(result.verdict).toBe('not_comparable');
    expect(result.difference).toBeNull();
    expect(result.caveat).toContain('no evidenced closing balance');
  });

  it('never calls an unavailable reading agreement either', () => {
    const result = compareBalanceReading(
      reading({ balance: null, status: 'unavailable' }),
      paise(0n),
      PERIOD_END,
    );
    expect(result.verdict).toBe('not_comparable');
    expect(result.caveat).toContain('could not state a balance');
  });

  it('distinguishes a missing balance from a missing instant in the caveat', () => {
    expect(compareBalanceReading(reading({ asOf: null }), paise(1n), PERIOD_END).caveat).toContain(
      'no instant',
    );
  });

  it('attaches a caveat to a stale match rather than treating it as confirmation', () => {
    const old = new Date(PERIOD_END.getTime() - 5 * 24 * 60 * 60 * 1000);
    const result = compareBalanceReading(reading({ asOf: old }), paise(1_234_500n), PERIOD_END);
    expect(result.verdict).toBe('agrees');
    expect(result.usability).toBe('stale');
    expect(result.caveat).toContain('Neither a match nor a mismatch here settles anything');
  });

  it('keeps a negative balance as a real balance', () => {
    const result = compareBalanceReading(
      reading({ balance: paise(-5_000n) }),
      paise(-5_000n),
      PERIOD_END,
    );
    expect(result.verdict).toBe('agrees');
  });
});

describe('assertBoundaryIsNotAProviderReading', () => {
  it('permits an evidenced boundary', () => {
    expect(() => assertBoundaryIsNotAProviderReading({ kind: 'evidence' })).not.toThrow();
  });

  it('refuses a provider reading as a boundary, with no way to override it', () => {
    try {
      assertBoundaryIsNotAProviderReading({ kind: 'provider_reading' });
      expect.unreachable('a reading must never become a boundary');
    } catch (error) {
      expect(isDomainError(error) && error.code).toBe('BALANCE_READING_NOT_EVIDENCE');
      expect((error as Error).message).toContain('verified ₹0 delta');
    }
  });
});

describe('summarizeReadCompleteness', () => {
  it('is complete only when the provider says so and every account was answered', () => {
    expect(summarizeReadCompleteness(['a', 'b'], ['a', 'b'], true)).toEqual({
      requested: 2,
      answered: 2,
      complete: true,
    });
  });

  it('is incomplete when an account went unanswered, whatever the provider claimed', () => {
    const result = summarizeReadCompleteness(['a', 'b'], ['a'], true);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toContain('1 of 2');
    expect(result.incompleteReason).toContain('says nothing about their balances');
  });

  it("carries the provider's own reason when it declared the read partial", () => {
    const result = summarizeReadCompleteness(['a'], ['a'], false, 'Consent covers one account.');
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('Consent covers one account.');
  });

  it('still says something when a provider declares a partial read without a reason', () => {
    const result = summarizeReadCompleteness(['a'], ['a'], false);
    expect(result.incompleteReason).toContain('without saying why');
  });
});
