/**
 * Asking the ledger a question (audit row 45, ADR-0057).
 *
 * The sentence under test: **the model plans, and the ledger answers.** So the assertions are
 * not about phrasing — they are about provenance. Every figure an answer states must be the
 * one the matching service read returns, a question the ledger cannot answer must produce a
 * refusal rather than a confident sentence, an instruction must be refused outright, and
 * asking must leave the database byte-for-byte as it was.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paise } from '../../src/domain/index.js';
import type { BeneficiaryRef, ExpenseId, PersonId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import {
  answerLedgerQuestion,
  approveAllocation,
  describeAskCapabilities,
  getBalance,
  getCategorySpend,
  getOwnSpend,
} from '../../src/services/index.js';
import { ServiceError } from '../../src/services/errors.js';
import { AiContractError } from '../../src/ai/errors.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { scriptedQueryPlanTransport } from '../support/ai.js';
import { addExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';
const AS_USER = { actor: 'user', source: 'tests/integration/ask-api' } as const;
const OCCURRED_AT = new Date('2026-08-10T19:20:00.000Z');
const NOW = new Date('2026-09-12T10:00:00.000Z');
const AUGUST = { start: '2026-08-01', end: '2026-09-01' };

let database: TestDatabase;
let api: Api;
let cast: Cast;
let transport: ReturnType<typeof scriptedQueryPlanTransport>;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  transport = scriptedQueryPlanTransport();
  api = createApi({
    db: database.db,
    ai: createAiService(transport),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
});

function friendId(): PersonId {
  return cast.person['person_friend_a']!;
}

function plan(overrides: Record<string, unknown> = {}, confidence = 'high') {
  return {
    confidence,
    proposedOutput: {
      kind: 'own_spend',
      period: AUGUST,
      personName: null,
      category: null,
      searchTerm: null,
      limit: 20,
      clarification: null,
      ...overrides,
    },
  };
}

/** A ₹900 August dinner split two ways, and a ₹400 personal lunch. */
async function seedAugustSpending(): Promise<ExpenseId> {
  const beneficiaries: BeneficiaryRef[] = [
    { type: 'person', id: cast.userPersonId },
    { type: 'person', id: friendId() },
  ];
  const dinner = await addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(90_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
    category: 'food',
  });
  await approveAllocation(database.db, {
    expenseId: dinner,
    decision: { method: 'equal', beneficiaries },
    decidedBy: 'manual',
    audit: AS_USER,
  });

  const lunch = await addExpense(database.db, {
    description: 'Solo lunch',
    amount: paise(40_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'personal',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
    category: 'food',
  });
  await approveAllocation(database.db, {
    expenseId: lunch,
    decision: { method: 'equal', beneficiaries: [{ type: 'person', id: cast.userPersonId }] },
    decidedBy: 'manual',
    audit: AS_USER,
  });
  return dinner;
}

async function ask(question: string) {
  return answerLedgerQuestion(database.db, {
    question,
    userPersonId: cast.userPersonId,
    ai: createAiService(transport),
    now: NOW,
  });
}

describe('answering from the ledger’s own reads', () => {
  it('quotes getCategorySpend rather than recomputing a total', async () => {
    await seedAugustSpending();
    transport.script('What did I spend on food in August?', plan({ kind: 'spend_by_category' }));

    const result = await ask('What did I spend on food in August?');
    const expected = await getCategorySpend(database.db, {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(result.answer.source).toBe('services.getCategorySpend');
    expect(result.answer.figures[0]?.amount).toBe(expected.netTotal.toString());
    // The caveats the read carries are passed through, not summarised away.
    expect(result.answer.caveats).toEqual([...expected.caveats.excludes]);
  });

  it('quotes getOwnSpend, which is a different question from what passed through', async () => {
    await seedAugustSpending();
    transport.script('What did I actually spend in August?', plan());

    const result = await ask('What did I actually spend in August?');
    const expected = await getOwnSpend(database.db, cast.userPersonId, {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(result.answer.figures.map((figure) => figure.amount)).toEqual([
      expected.ownShare.toString(),
      expected.paidByUser.toString(),
      expected.frontedForOthers.toString(),
    ]);
  });

  it('quotes getBalance for a pair, resolving the name here rather than in the model', async () => {
    await seedAugustSpending();
    transport.script(
      'How much does Friend A owe me?',
      plan({ kind: 'pair_balance', period: null, personName: 'Friend A' }),
    );

    const result = await ask('How much does Friend A owe me?');
    const expected = await getBalance(
      database.db,
      cast.userPersonId,
      cast.userPersonId,
      friendId(),
    );

    expect(result.answer.source).toBe('services.getBalance');
    expect(result.answer.figures[0]?.amount).toBe(expected.netBalance.toString());
    expect(result.answer.interpretation).toContain('with Friend A');
  });

  it('states the period it assumed when the question named none', async () => {
    await seedAugustSpending();
    transport.script('What did I spend?', plan({ period: null }));

    const result = await ask('What did I spend?');
    expect(result.answer.interpretation).toMatch(/assumed — no period was named/);
    expect(result.answer.period?.start).toBe('2026-09-01T00:00:00.000Z');
  });

  it('carries links to the screens that own the figures, and never an action', async () => {
    await seedAugustSpending();
    transport.script('Who owes me?', plan({ kind: 'outstanding_balances', period: null }));

    const result = await ask('Who owes me?');
    expect(result.answer.links).toEqual([{ label: 'Balances', href: '/balances' }]);
  });

  it('returns the model’s provenance with the answer', async () => {
    await seedAugustSpending();
    transport.script('What did I actually spend in August?', plan({}, 'medium'));

    const result = await ask('What did I actually spend in August?');
    expect(result.confidence).toBe('medium');
    expect(result.modelInfo).toMatchObject({
      provider: 'scripted',
      model: 'query-planner',
      promptVersion: 'plan_ledger_query/v1',
    });
  });
});

describe('the three honest non-answers', () => {
  it('refuses an instruction outright, stating no figure', async () => {
    transport.script(
      'Mark Friend A as settled.',
      plan({
        kind: 'unsupported_write_request',
        period: null,
        clarification: 'This surface only reads.',
      }),
    );

    const result = await ask('Mark Friend A as settled.');
    expect(result.answer.answered).toBe(false);
    expect(result.answer.figures).toEqual([]);
    expect(result.answer.headline).toMatch(/only reads/);
  });

  it('lists what can be asked when the ledger has no read for a question', async () => {
    transport.script(
      'What will I spend next year?',
      plan({ kind: 'unsupported_question', period: null, clarification: 'no forecast exists' }),
    );

    const result = await ask('What will I spend next year?');
    expect(result.answer.answered).toBe(false);
    expect(result.answer.uncertainties).toContain('What can be asked:');
    expect(result.answer.uncertainties.some((line) => line.startsWith('•'))).toBe(true);
  });

  it('asks which person, rather than picking one', async () => {
    await seedAugustSpending();
    transport.script(
      'What does Nobody owe me?',
      plan({ kind: 'pair_balance', period: null, personName: 'Nobody' }),
    );

    const result = await ask('What does Nobody owe me?');
    expect(result.answer.answered).toBe(false);
    expect(result.answer.kind).toBe('ambiguous_question');
    expect(result.answer.headline).toMatch(/Nobody in this ledger is called/);
    expect(result.answer.figures).toEqual([]);
  });
});

describe('the boundary around the question', () => {
  it('masks an identifier before the question leaves the machine', async () => {
    transport.script(
      'What went out of account [redacted-number] in August?',
      plan({ kind: 'spend_by_category' }),
    );

    await ask('What went out of account 123456789012 in August?');
    expect(transport.asked[0]).toBe('What went out of account [redacted-number] in August?');
    expect(JSON.stringify(transport.lastPayload())).not.toContain('123456789012');
  });

  it('sends no figure to the model', async () => {
    await seedAugustSpending();
    transport.script('What did I actually spend in August?', plan());

    await ask('What did I actually spend in August?');
    const payload = JSON.stringify(transport.lastPayload());
    expect(payload).not.toContain('90000');
    expect(payload).not.toContain('40000');
  });

  it('refuses a plan that is not a plan', async () => {
    transport.script('What did I spend?', {
      confidence: 'high',
      proposedOutput: { answer: 'You spent ₹4,200.' },
    });
    await expect(ask('What did I spend?')).rejects.toThrow(AiContractError);
  });

  it('refuses a plan that parses but cannot be answered', async () => {
    transport.script(
      'What did I spend?',
      plan({ period: { start: '2026-09-01', end: '2026-08-01' } }),
    );
    await expect(ask('What did I spend?')).rejects.toThrow(/ends after it starts/);
  });

  it('says asking is unavailable when no model is configured', async () => {
    const unconfigured = scriptedQueryPlanTransport({
      configured: false,
      unavailableReason: 'ANTHROPIC_API_KEY is not set',
    });
    await expect(
      answerLedgerQuestion(database.db, {
        question: 'What did I spend?',
        userPersonId: cast.userPersonId,
        ai: createAiService(unconfigured),
        now: NOW,
      }),
    ).rejects.toThrow(ServiceError);
    // And it never asked, which is the point of reading availability first.
    expect(unconfigured.asked).toEqual([]);
  });

  it('reports a provider that fails mid-call as unavailable, not as a broken ledger', async () => {
    // A transport error carries its own class. Before this was discriminated explicitly it
    // slipped past as an anonymous 500 — "something is wrong with your ledger" rather than
    // "the provider could not be reached".
    const failing = scriptedQueryPlanTransport();
    await expect(
      answerLedgerQuestion(database.db, {
        question: 'A question nobody scripted',
        userPersonId: cast.userPersonId,
        ai: createAiService(failing),
        now: NOW,
      }),
    ).rejects.toThrow(ServiceError);
    await expect(
      answerLedgerQuestion(database.db, {
        question: 'A question nobody scripted',
        userPersonId: cast.userPersonId,
        ai: createAiService(failing),
        now: NOW,
      }),
    ).rejects.toThrow(/could not be planned/);
  });

  it('refuses an empty or oversized question', async () => {
    await expect(ask('   ')).rejects.toThrow(/Ask something/);
    await expect(ask('a'.repeat(501))).rejects.toThrow(/at most 500 characters/);
  });
});

describe('asking writes nothing', () => {
  it('leaves every table exactly as it was', async () => {
    await seedAugustSpending();
    transport.script('What did I actually spend in August?', plan());

    const before = await snapshotCounts();
    await ask('What did I actually spend in August?');
    expect(await snapshotCounts()).toEqual(before);
  });

  async function snapshotCounts(): Promise<Record<string, number>> {
    const [expenses, allocations, events, inferences, payments] = await Promise.all([
      database.db.select().from(schema.expenses),
      database.db.select().from(schema.allocations),
      database.db.select().from(schema.auditEvents),
      database.db.select().from(schema.aiInferences),
      database.db.select().from(schema.payments),
    ]);
    return {
      expenses: expenses.length,
      allocations: allocations.length,
      // An answer writes no audit event because nothing happened to attribute, and no
      // `ai_inferences` row because the plan is not a proposal anybody accepts (ADR-0057).
      auditEvents: events.length,
      aiInferences: inferences.length,
      payments: payments.length,
    };
  }
});

describe('the HTTP surface', () => {
  it('answers a question, and takes no actor because nothing happened', async () => {
    await seedAugustSpending();
    transport.script('What did I actually spend in August?', plan());

    const response = await api.handle(
      new Request(`${BASE}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'What did I actually spend in August?' }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { answer: { source: string; answered: boolean } };
    expect(body.answer).toMatchObject({ source: 'services.getOwnSpend', answered: true });
  });

  it('reports what can be asked, and that asking writes nothing', async () => {
    const response = await api.handle(new Request(`${BASE}/api/ask/capabilities`));
    const body = (await response.json()) as {
      writes: boolean;
      model: { configured: boolean };
      queries: Array<{ kind: string; source: string }>;
    };
    expect(body.writes).toBe(false);
    expect(body.model.configured).toBe(true);
    expect(body.queries.length).toBeGreaterThan(0);
    for (const query of body.queries) expect(query.source).toMatch(/^services\./);
  });

  it('reports an unconfigured model as unavailable rather than offering a box that fails', async () => {
    const unconfiguredApi = createApi({
      db: database.db,
      ai: createAiService(
        scriptedQueryPlanTransport({
          configured: false,
          unavailableReason: 'ANTHROPIC_API_KEY is not set',
        }),
      ),
      evidenceStore: createMemoryEvidenceStore(),
      splitwise: createMockSplitwisePort(),
    });

    const capabilities = await unconfiguredApi.handle(new Request(`${BASE}/api/ask/capabilities`));
    const body = (await capabilities.json()) as {
      model: { configured: boolean; unavailableReason: string };
    };
    expect(body.model.configured).toBe(false);
    expect(body.model.unavailableReason).toContain('ANTHROPIC_API_KEY');

    const asked = await unconfiguredApi.handle(
      new Request(`${BASE}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'What did I spend?' }),
      }),
    );
    expect(asked.status).toBe(503);
  });

  it('has exactly two ask routes, neither of which writes', () => {
    expect(
      api.routes
        .filter((route) => route.path.startsWith('/api/ask'))
        .map((route) => `${route.method} ${route.path}`),
    ).toEqual(['GET /api/ask/capabilities', 'POST /api/ask']);
  });
});

describe('capabilities', () => {
  it('names people and categories without exposing a figure', async () => {
    await seedAugustSpending();
    const capabilities = await describeAskCapabilities(database.db, createAiService(transport));
    expect(capabilities.knownCategories).toEqual(['food']);
    expect(capabilities.knownPeople).toContain('Friend A');
    expect(JSON.stringify(capabilities)).not.toContain('90000');
  });
});
