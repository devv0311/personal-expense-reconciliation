/**
 * The ask boundary: what a model may return, and what leaves this machine to get it
 * (ADR-0057).
 *
 * Two properties carry the weight. A reply that is not exactly a query plan is refused before
 * `src/services` sees it — including a reply that tries to *answer*, which is the failure this
 * operation's whole shape exists to make impossible. And the payload that goes out carries the
 * question, the menu and the roster's names, with identifiers masked and no figure at all.
 */

import { describe, expect, it } from 'vitest';

import { planLedgerQuery, describeTransportAvailability } from './ask.js';
import type { ModelRequest, ModelTransport } from './classify-transaction.js';
import { AiContractError } from './errors.js';
import { parsePlanLedgerQueryResponse } from './contract.js';
import { redactLedgerQuestionForInference } from './redaction.js';
import { SanitizationError } from './errors.js';

const CAPABILITIES = [
  {
    kind: 'own_spend',
    answers: 'the user’s own share of a period’s spending',
    example: 'What did I actually spend in August?',
    needsPeriod: true,
    needsPerson: false,
  },
];

function transportReturning(response: unknown): ModelTransport & { last: () => ModelRequest } {
  let last: ModelRequest | null = null;
  return {
    modelInfo: { provider: 'test', model: 'planner' },
    last: () => {
      if (last === null) throw new Error('nothing was asked');
      return last;
    },
    complete: (request) => {
      last = request;
      return Promise.resolve(response);
    },
  };
}

const VALID_PLAN = {
  confidence: 'high',
  proposedOutput: {
    kind: 'own_spend',
    period: { start: '2026-08-01', end: '2026-09-01' },
    personName: null,
    category: null,
    searchTerm: null,
    limit: 20,
    clarification: null,
  },
};

describe('parsePlanLedgerQueryResponse', () => {
  it('accepts the contract and parses the period into exact UTC days', () => {
    const { proposedOutput, confidence } = parsePlanLedgerQueryResponse(VALID_PLAN);
    expect(confidence).toBe('high');
    expect(proposedOutput.kind).toBe('own_spend');
    expect(proposedOutput.period?.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(proposedOutput.period?.end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('refuses a kind no read implements', () => {
    expect(() =>
      parsePlanLedgerQueryResponse({
        ...VALID_PLAN,
        proposedOutput: { ...VALID_PLAN.proposedOutput, kind: 'drop_all_tables' },
      }),
    ).toThrow(AiContractError);
  });

  it('refuses an extra key — including one that tries to answer', () => {
    expect(() =>
      parsePlanLedgerQueryResponse({
        ...VALID_PLAN,
        proposedOutput: { ...VALID_PLAN.proposedOutput, answer: 'You spent ₹4,200.' },
      }),
    ).toThrow(/answer/);
  });

  it('refuses a raw query smuggled in beside the plan', () => {
    expect(() =>
      parsePlanLedgerQueryResponse({
        ...VALID_PLAN,
        proposedOutput: { ...VALID_PLAN.proposedOutput, sql: 'select * from payments' },
      }),
    ).toThrow(AiContractError);
  });

  it('refuses a page size outside the bound, at the contract rather than later', () => {
    expect(() =>
      parsePlanLedgerQueryResponse({
        ...VALID_PLAN,
        proposedOutput: { ...VALID_PLAN.proposedOutput, limit: 5000 },
      }),
    ).toThrow(/between 1 and 50/);
  });

  it('refuses a period that is prose rather than a calendar day', () => {
    expect(() =>
      parsePlanLedgerQueryResponse({
        ...VALID_PLAN,
        proposedOutput: {
          ...VALID_PLAN.proposedOutput,
          period: { start: 'last Tuesday', end: 'today' },
        },
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('refuses a missing confidence', () => {
    expect(() =>
      parsePlanLedgerQueryResponse({ proposedOutput: VALID_PLAN.proposedOutput }),
    ).toThrow(AiContractError);
  });
});

describe('redactLedgerQuestionForInference', () => {
  const base = {
    today: new Date('2026-09-12T10:00:00.000Z'),
    capabilities: CAPABILITIES,
    knownPeople: ['Priya', 'Arjun'],
    knownCategories: ['food', 'transport'],
  };

  it('sends the question, the menu and the names — and no figure', () => {
    const payload = redactLedgerQuestionForInference({
      ...base,
      question: 'What did I spend on food last month?',
    });
    expect(payload.question).toBe('What did I spend on food last month?');
    expect(payload.today).toBe('2026-09-12');
    expect(payload.knownPeople).toEqual(['Priya', 'Arjun']);
    // Nothing on this payload can carry an amount, which is why a model on this path cannot
    // quote one back.
    expect(JSON.stringify(payload)).not.toMatch(/amount|balance|netTotal/i);
  });

  it('keeps a calendar year, which identifies nobody', () => {
    const payload = redactLedgerQuestionForInference({
      ...base,
      question: 'What did I spend in 2026?',
    });
    expect(payload.question).toBe('What did I spend in 2026?');
  });

  it('masks an account number somebody pasted into a question', () => {
    const payload = redactLedgerQuestionForInference({
      ...base,
      question: 'What went out of account 123456789012 last month?',
    });
    expect(payload.question).not.toContain('123456789012');
    expect(payload.question).toContain('[redacted-number]');
  });

  it('masks a UPI handle', () => {
    const payload = redactLedgerQuestionForInference({
      ...base,
      question: 'Did priya@okaxis pay me back?',
    });
    expect(payload.question).not.toContain('priya@okaxis');
  });

  it('fails closed when an identifier reaches the payload another way', () => {
    expect(() =>
      redactLedgerQuestionForInference({
        ...base,
        question: 'anything',
        // A name somebody entered as their account number: masked nowhere, and refused here
        // rather than sent (ADR-0044).
        knownPeople: ['card: 4821 1234 5678 9012'],
      }),
    ).toThrow(SanitizationError);
  });
});

describe('planLedgerQuery', () => {
  it('returns an envelope naming the operation and the prompt that produced it', async () => {
    const transport = transportReturning(VALID_PLAN);
    const inference = await planLedgerQuery(transport, {
      question: 'What did I actually spend in August?',
      today: new Date('2026-09-12T10:00:00.000Z'),
      capabilities: CAPABILITIES,
      knownPeople: [],
      knownCategories: [],
    });

    expect(inference.inferenceType).toBe('plan_ledger_query');
    expect(inference.modelInfo.promptVersion).toBe('plan_ledger_query/v1');
    expect(inference.proposedOutput.kind).toBe('own_spend');
    expect(transport.last().operation).toBe('plan_ledger_query');
  });

  it('rejects a model that answers instead of planning', async () => {
    const transport = transportReturning({
      confidence: 'high',
      proposedOutput: { answer: 'You spent ₹4,200 in August.' },
    });
    await expect(
      planLedgerQuery(transport, {
        question: 'What did I spend?',
        today: new Date('2026-09-12T10:00:00.000Z'),
        capabilities: CAPABILITIES,
        knownPeople: [],
        knownCategories: [],
      }),
    ).rejects.toThrow(AiContractError);
  });
});

describe('describeTransportAvailability', () => {
  it('treats a transport that declares nothing as configured', () => {
    expect(describeTransportAvailability(transportReturning(VALID_PLAN)).configured).toBe(true);
  });

  it('reports an explicitly unconfigured transport, with its reason', () => {
    const availability = describeTransportAvailability({
      modelInfo: { provider: 'none', model: 'unconfigured' },
      availability: { configured: false, unavailableReason: 'ANTHROPIC_API_KEY is not set' },
      complete: () => Promise.reject(new Error('unconfigured')),
    });
    expect(availability.configured).toBe(false);
    expect(availability.unavailableReason).toContain('ANTHROPIC_API_KEY');
  });
});
