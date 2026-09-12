/**
 * The plan vocabulary an ask-only surface is allowed to produce (ADR-0057).
 *
 * The property under test throughout is that a plan is *inert*: a bounded page size, a period
 * that makes sense, a name rather than an id, and nothing a model could put a query into.
 */

import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  assertQueryPlanAnswerable,
  describeQueryInterpretation,
  isNonAnsweringQueryKind,
  LEDGER_QUERY_CAPABILITIES,
  LEDGER_QUERY_KINDS,
  MAX_LEDGER_QUERY_LIMIT,
  queryRequiresPerson,
  queryRequiresPeriod,
  resolveQueryPeriod,
} from './ledger-query.js';
import type { LedgerQueryPlan } from './ledger-query.js';

function plan(overrides: Partial<LedgerQueryPlan> = {}): LedgerQueryPlan {
  return {
    kind: 'own_spend',
    period: {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-09-01T00:00:00.000Z'),
    },
    personName: null,
    category: null,
    searchTerm: null,
    limit: 20,
    clarification: null,
    ...overrides,
  };
}

describe('the query vocabulary', () => {
  it('names an authoritative read for every answering kind', () => {
    const answering = LEDGER_QUERY_KINDS.filter((kind) => !isNonAnsweringQueryKind(kind));
    const covered = LEDGER_QUERY_CAPABILITIES.map((entry) => entry.kind);
    expect([...answering].sort()).toEqual([...covered].sort());
    for (const capability of LEDGER_QUERY_CAPABILITIES) {
      expect(capability.source, capability.kind).toMatch(/^services\./);
    }
  });

  it('offers exactly three ways to decline, and none of them answers', () => {
    const declining = LEDGER_QUERY_KINDS.filter(isNonAnsweringQueryKind);
    expect(declining).toEqual([
      'unsupported_question',
      'ambiguous_question',
      'unsupported_write_request',
    ]);
  });

  it('gives a plan no field a query could be put into', () => {
    // The structural guarantee, asserted structurally: if somebody adds `rawSql`, `table` or
    // any other escape hatch to `LedgerQueryPlan`, this fails rather than a model discovering
    // it. `searchTerm` is the only free text, and it reaches one parameterised filter.
    expect(Object.keys(plan()).sort()).toEqual([
      'category',
      'clarification',
      'kind',
      'limit',
      'period',
      'personName',
      'searchTerm',
    ]);
  });
});

describe('assertQueryPlanAnswerable', () => {
  it('accepts an ordinary plan', () => {
    expect(() => assertQueryPlanAnswerable(plan())).not.toThrow();
  });

  it('refuses a page size outside the bound', () => {
    expect(() => assertQueryPlanAnswerable(plan({ limit: 0 }))).toThrow(DomainError);
    expect(() => assertQueryPlanAnswerable(plan({ limit: MAX_LEDGER_QUERY_LIMIT + 1 }))).toThrow(
      /between 1 and 50/,
    );
  });

  it('refuses a period that ends before it starts', () => {
    expect(() =>
      assertQueryPlanAnswerable(
        plan({
          period: {
            start: new Date('2026-09-01T00:00:00.000Z'),
            end: new Date('2026-08-01T00:00:00.000Z'),
          },
        }),
      ),
    ).toThrow(/ends after it starts/);
  });

  it('refuses a refusal that carries query parameters', () => {
    expect(() =>
      assertQueryPlanAnswerable(
        plan({ kind: 'unsupported_write_request', personName: 'Priya', period: null }),
      ),
    ).toThrow(/carries no query parameters/);
  });

  it('refuses an answering plan that carries a clarification', () => {
    expect(() => assertQueryPlanAnswerable(plan({ clarification: 'which Priya?' }))).toThrow(
      /Only a declining plan/,
    );
  });

  it('accepts a well-formed refusal', () => {
    expect(() =>
      assertQueryPlanAnswerable(
        plan({
          kind: 'unsupported_question',
          period: null,
          clarification: 'this ledger has no read for weather',
        }),
      ),
    ).not.toThrow();
  });
});

describe('resolveQueryPeriod', () => {
  const now = new Date('2026-09-12T10:00:00.000Z');

  it('keeps a period the plan named', () => {
    const resolved = resolveQueryPeriod(plan(), now);
    expect(resolved.assumed).toBe(false);
    expect(resolved.period?.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('assumes the current calendar month when a period-scoped question names none', () => {
    const resolved = resolveQueryPeriod(plan({ period: null }), now);
    expect(resolved.assumed).toBe(true);
    expect(resolved.period?.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(resolved.period?.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('leaves a question that is not period-scoped without one', () => {
    const resolved = resolveQueryPeriod(plan({ kind: 'outstanding_balances', period: null }), now);
    expect(resolved.period).toBeNull();
    expect(resolved.assumed).toBe(false);
  });
});

describe('describeQueryInterpretation', () => {
  it('says out loud that a period was assumed', () => {
    const sentence = describeQueryInterpretation({
      plan: plan({ period: null }),
      period: {
        start: new Date('2026-09-01T00:00:00.000Z'),
        end: new Date('2026-10-01T00:00:00.000Z'),
      },
      periodAssumed: true,
      resolvedPersonLabel: null,
    });
    expect(sentence).toMatch(/assumed — no period was named/);
    expect(sentence).toContain('2026-09-01');
    expect(sentence).toContain('2026-09-30');
  });

  it('names the person it resolved, so a wrong reading is visible', () => {
    const sentence = describeQueryInterpretation({
      plan: plan({ kind: 'pair_balance', personName: 'pri', period: null }),
      period: null,
      periodAssumed: false,
      resolvedPersonLabel: 'Priya Sharma',
    });
    expect(sentence).toContain('with Priya Sharma');
  });
});

describe('the per-kind requirements', () => {
  it('marks the period-scoped kinds', () => {
    expect(queryRequiresPeriod('spend_by_category')).toBe(true);
    expect(queryRequiresPeriod('own_spend')).toBe(true);
    expect(queryRequiresPeriod('outstanding_balances')).toBe(false);
  });

  it('marks the one kind that cannot be answered without a person', () => {
    expect(queryRequiresPerson('pair_balance')).toBe(true);
    expect(queryRequiresPerson('expense_search')).toBe(false);
  });
});
