/**
 * The review API, exercised the way a UI would: real `Request`s in, real `Response`s out,
 * against a real database with the real services underneath.
 *
 * Nothing here is mocked except the model (ADR-0025). That is the point — a route that
 * serializes correctly but calls the wrong service is a route that passes a unit test and
 * loses money.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import type { AccountId, PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import {
  classifyPayments,
  importBankStatementCsv,
  normalizePayments,
} from '../../src/services/index.js';
import type { ProposedClassification } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import type { TestDatabase } from '../support/database.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { AS_USER, addPayment, seedCast, seedMerchants } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');
const AS_SYSTEM = { actor: 'system', source: 'services.classifyPayments' } as const;
const BASE = 'http://localhost';

let database: TestDatabase;
let cast: Cast;
let accountId: AccountId;
let api: Api;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  accountId = cast.account['account_hdfc_savings']!;
  await seedMerchants(database.db);
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
});

async function classifiedFixture(): Promise<readonly ProposedClassification[]> {
  await importBankStatementCsv(database.db, {
    accountId,
    sourceSystem: 'synthetic_bank_csv',
    fileContent: FIXTURE,
    fileReference: 'fixtures/bank-statement.csv',
    audit: AS_USER,
  });
  await normalizePayments(database.db, { audit: AS_USER });
  const { outcomes } = await classifyPayments(database.db, {
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    audit: AS_SYSTEM,
  });
  return outcomes.filter(
    (outcome): outcome is ProposedClassification => outcome.outcome === 'proposed',
  );
}

function get(path: string): Promise<Response> {
  return api.handle(new Request(`${BASE}${path}`));
}

function post(path: string, body: unknown): Promise<Response> {
  return api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function addLookalikePair(): Promise<{ earlier: PaymentId; later: PaymentId }> {
  const earlier = await addPayment(database.db, cast, {
    accountId,
    amount: paise(45_000n),
    direction: 'debit',
    occurredAt: new Date('2026-07-14T00:00:00Z'),
    rawDescription: 'UPI-COFFEE-SHOP',
    channel: 'upi',
    state: 'normalized',
  });
  const later = await addPayment(database.db, cast, {
    accountId,
    amount: paise(45_000n),
    direction: 'debit',
    occurredAt: new Date('2026-07-14T00:00:30Z'),
    rawDescription: 'UPI-COFFEE-SHOP',
    channel: 'upi',
    state: 'normalized',
  });
  return { earlier, later };
}

describe('GET /api/review', () => {
  it('returns the queue as JSON, with money as exact strings', async () => {
    await classifiedFixture();

    const response = await get('/api/review');
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(body['total']).toBe(5);
    const items = body['items'] as Array<Record<string, unknown>>;
    // A bigint has no JSON representation, and money must never cross as a float.
    expect(items[0]?.['amount']).toBe('284000');
    expect(typeof items[0]?.['occurredAt']).toBe('string');
  });

  it('serializes each item with the reasons a surface needs to explain it', async () => {
    await classifiedFixture();

    const body = await json(await get('/api/review'));

    const items = body['items'] as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      kind: 'classification_decision',
      reasons: ['low_confidence'],
      confidence: 'medium',
    });
    expect(items[0]?.['proposal']).toMatchObject({ proposedKind: 'expense' });
    expect(body['counts']).toEqual({
      classification_decision: 5,
      possible_duplicate: 0,
      rejected_classification: 0,
      unmatched_evidence: 0,
    });
  });

  it('passes the query parameters through to the service', async () => {
    await classifiedFixture();
    await addLookalikePair();

    const limited = await json(await get('/api/review?limit=1'));
    expect((limited['items'] as unknown[]).length).toBe(1);
    expect(limited['truncated']).toBe(true);

    const duplicatesOnly = await json(await get('/api/review?kinds=possible_duplicate'));
    expect((duplicatesOnly['counts'] as Record<string, number>)['classification_decision']).toBe(0);

    const material = await json(await get('/api/review?materialityThreshold=100000'));
    const classifications = (material['items'] as Array<Record<string, unknown>>).filter(
      (item) => item['kind'] === 'classification_decision',
    );
    expect(classifications).toHaveLength(5);
    expect(
      classifications.every((item) => (item['reasons'] as string[]).includes('material_amount')),
    ).toBe(true);
  });

  it('refuses a malformed query parameter rather than guessing', async () => {
    const response = await get('/api/review?limit=all');
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body['error']).toMatchObject({ code: 'INVALID_REQUEST', field: 'limit' });
  });

  it('refuses an unknown item kind', async () => {
    const response = await get('/api/review?kinds=receipts');

    expect(response.status).toBe(400);
  });

  it('returns the same body twice', async () => {
    await classifiedFixture();

    const first = await (await get('/api/review')).text();
    const second = await (await get('/api/review')).text();

    // Deterministic ordering all the way out to the wire — safe for a UI to poll.
    expect(second).toBe(first);
  });
});

describe('POST /api/review/inferences/:id/decision', () => {
  it('accepts a proposal through the one authoritative path', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    const response = await post(`/api/review/inferences/${target.inferenceId}/decision`, {
      decision: 'accept',
      actor: 'user',
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'accepted',
      resultingRecordType: 'expense',
      expenseState: 'approved',
      paymentState: 'linked',
      unexplainedRemainder: '0',
    });
    const [expense] = await database.db
      .select({ state: schema.expenses.state })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, target.expenseId!));
    expect(expense?.state).toBe('approved');
  });

  it('modifies a proposal, validating the correction through the same gate', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    const response = await post(`/api/review/inferences/${target.inferenceId}/decision`, {
      decision: 'modify',
      actor: 'user',
      reason: 'this one was for the flat',
      modifiedOutput: {
        proposedKind: 'expense',
        relationshipType: 'household_shared_flat',
        category: 'groceries',
      },
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ status: 'modified' });
    const [expense] = await database.db
      .select({ relationshipType: schema.expenses.relationshipType })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, target.expenseId!));
    expect(expense?.relationshipType).toBe('household_shared_flat');
  });

  it('rejects a corrected proposal that is not a proposal', async () => {
    const proposals = await classifiedFixture();
    const target = proposals[0]!;

    const response = await post(`/api/review/inferences/${target.inferenceId}/decision`, {
      decision: 'modify',
      actor: 'user',
      modifiedOutput: { proposedKind: 'refund' },
    });
    const body = await json(response);

    // src/ai's validator decided this, not the route: the route passes modifiedOutput through
    // untouched (ai-boundary.md).
    expect(response.status).toBe(422);
    expect(body['error']).toMatchObject({ code: 'FIELD_INVALID' });
  });

  it('resolves a settlement proposal that never had an expense', async () => {
    const proposals = await classifiedFixture();
    const settlement = proposals.find((proposal) => proposal.proposedKind === 'settlement')!;

    const response = await post(`/api/review/inferences/${settlement.inferenceId}/decision`, {
      decision: 'accept',
      actor: 'user',
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'accepted',
      resultingRecordType: 'settlement',
      counterpartyPersonId: cast.person['person_friend_a'],
    });
    expect(await database.db.select().from(schema.settlements)).toHaveLength(1);
  });

  it('refuses a decision nobody is accountable for', async () => {
    const proposals = await classifiedFixture();

    const response = await post(`/api/review/inferences/${proposals[0]!.inferenceId}/decision`, {
      decision: 'accept',
      actor: 'ai',
    });

    // 403, not 400: the request is well-formed, and the *model* is not allowed to decide
    // (invariants.md #17).
    expect(response.status).toBe(403);
    expect((await json(response))['error']).toMatchObject({ code: 'DECISION_ACTOR_INVALID' });
  });

  it('refuses a second decision on the same proposal', async () => {
    const proposals = await classifiedFixture();
    const target = proposals[0]!;
    await post(`/api/review/inferences/${target.inferenceId}/decision`, {
      decision: 'accept',
      actor: 'user',
    });

    const response = await post(`/api/review/inferences/${target.inferenceId}/decision`, {
      decision: 'reject',
      actor: 'user',
    });

    expect(response.status).toBe(409);
    expect((await json(response))['error']).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('404s an inference that does not exist', async () => {
    const response = await post(
      '/api/review/inferences/00000000-0000-4000-8000-000000000000/decision',
      { decision: 'accept', actor: 'user' },
    );

    expect(response.status).toBe(404);
  });

  it('400s an id that is not a UUID, before any service sees it', async () => {
    const response = await post('/api/review/inferences/not-a-uuid/decision', {
      decision: 'accept',
      actor: 'user',
    });

    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({ field: 'inferenceId' });
  });

  it('400s a missing actor, an unknown decision, and a body that is not JSON', async () => {
    const proposals = await classifiedFixture();
    const path = `/api/review/inferences/${proposals[0]!.inferenceId}/decision`;

    expect((await post(path, { decision: 'accept' })).status).toBe(400);
    expect((await post(path, { decision: 'maybe', actor: 'user' })).status).toBe(400);
    const notJson = await api.handle(
      new Request(`${BASE}${path}`, { method: 'POST', body: 'nope' }),
    );
    expect(notJson.status).toBe(400);
  });
});

describe('POST /api/review/payments/:id/reclassify', () => {
  it('supersedes the old proposal and returns the new one', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;

    const response = await post(`/api/review/payments/${target.paymentId}/reclassify`, {
      actor: 'user',
      reason: 'the category looks wrong',
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['supersededInferenceId']).toBe(target.inferenceId);
    expect(body['outcome']).toMatchObject({ outcome: 'proposed' });
  });

  it('409s a payment already explained by an accepted decision', async () => {
    const proposals = await classifiedFixture();
    const target = proposals.find((proposal) => proposal.expenseId !== null)!;
    await post(`/api/review/inferences/${target.inferenceId}/decision`, {
      decision: 'accept',
      actor: 'user',
    });

    const response = await post(`/api/review/payments/${target.paymentId}/reclassify`, {
      actor: 'user',
    });

    expect(response.status).toBe(409);
    expect((await json(response))['error']).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('403s an unattributable actor', async () => {
    const proposals = await classifiedFixture();

    const response = await post(`/api/review/payments/${proposals[0]!.paymentId}/reclassify`, {
      actor: 'system',
    });

    expect(response.status).toBe(403);
  });
});

describe('POST /api/review/payments/:id/duplicate', () => {
  it('confirms a duplicate, discarding the copy and naming what it duplicates', async () => {
    const { earlier, later } = await addLookalikePair();

    const response = await post(`/api/review/payments/${later}/duplicate`, {
      decision: 'confirm',
      actor: 'user',
      duplicateOfPaymentId: earlier,
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ decision: 'confirm', canonicalPaymentId: earlier });
    const [row] = await database.db
      .select({ state: schema.payments.state, ignoredReason: schema.payments.ignoredReason })
      .from(schema.payments)
      .where(eq(schema.payments.id, later));
    expect(row).toMatchObject({ state: 'ignored', ignoredReason: `duplicate_of:${earlier}` });
  });

  it('dismisses a pair without touching either payment', async () => {
    const { earlier, later } = await addLookalikePair();

    const response = await post(`/api/review/payments/${later}/duplicate`, {
      decision: 'dismiss',
      actor: 'user',
      duplicateOfPaymentId: earlier,
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ decision: 'dismiss' });
    const rows = await database.db.select({ state: schema.payments.state }).from(schema.payments);
    expect(rows.every((row) => row.state === 'normalized')).toBe(true);
    expect((await json(await get('/api/review')))['total']).toBe(0);
  });

  it('409s a pair that is not a candidate — a confirmation is not a licence', async () => {
    await classifiedFixture();
    const [blinkit] = await database.db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(eq(schema.payments.rawDescription, 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD'));
    const [electricity] = await database.db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(eq(schema.payments.rawDescription, 'ELECTRICITY BOARD BBPS BILLPAY'));

    const response = await post(`/api/review/payments/${electricity!.id}/duplicate`, {
      decision: 'confirm',
      actor: 'user',
      duplicateOfPaymentId: blinkit!.id,
    });

    expect(response.status).toBe(409);
  });

  it('400s a missing or malformed counterpart id', async () => {
    const { later } = await addLookalikePair();

    expect(
      (
        await post(`/api/review/payments/${later}/duplicate`, {
          decision: 'confirm',
          actor: 'user',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`/api/review/payments/${later}/duplicate`, {
          decision: 'confirm',
          actor: 'user',
          duplicateOfPaymentId: 'nope',
        })
      ).status,
    ).toBe(400);
  });
});

describe('the surface itself', () => {
  it('404s an unknown path and 405s a known one with the wrong verb', async () => {
    expect((await get('/api/nope')).status).toBe(404);

    const wrongVerb = await api.handle(new Request(`${BASE}/api/review`, { method: 'POST' }));
    expect(wrongVerb.status).toBe(405);
    expect((await json(wrongVerb))['error']).toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
  });

  it('never returns an internal error’s detail', async () => {
    // A handler that throws something unexpected must not leak it (security-model.md).
    const broken = createApi({
      db: null as unknown as TestDatabase['db'],
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      evidenceStore: createMemoryEvidenceStore(),
      splitwise: createMockSplitwisePort(),
    });

    const response = await broken.handle(new Request(`${BASE}/api/review`));
    const body = await json(response);

    expect(response.status).toBe(500);
    expect(body['error']).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.',
    });
  });

  it('exposes its route table, so a Next.js mount is mechanical', () => {
    expect(api.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /api/session',
      'POST /api/session',
      'POST /api/session/end',
      'POST /api/session/password',
      'GET /api/review',
      'POST /api/review/inferences/:inferenceId/decision',
      'POST /api/review/payments/:paymentId/reclassify',
      'POST /api/review/payments/:paymentId/duplicate',
      'GET /api/evidence',
      'POST /api/evidence/files',
      'POST /api/evidence/notes',
      'POST /api/evidence/notifications',
      'POST /api/evidence/matches/:candidateId/decision',
      'POST /api/evidence/:evidenceId/link',
      'POST /api/evidence/:evidenceId/receipt',
      'POST /api/evidence/:evidenceId/observation',
      'GET /api/evidence/:evidenceId/observation',
      'POST /api/evidence/:evidenceId/enrich',
      'GET /api/evidence/:evidenceId/matches',
      'GET /api/evidence/:evidenceId',
      'GET /api/evidence/:evidenceId/content',
      'POST /api/receipts/:receiptId/confirm',
      'POST /api/receipts/:receiptId/correct',
      'GET /api/receipts/:receiptId',
      'POST /api/expenses/:expenseId/items/correct',
      'POST /api/expenses/:expenseId/items',
      'GET /api/expenses/:expenseId/payment-links',
      'POST /api/expenses/:expenseId/payment-links',
      'GET /api/expenses/:expenseId/items',
      'GET /api/expenses/:expenseId/history',
      'POST /api/expenses/:expenseId/occasion',
      'POST /api/expenses/:expenseId/allocation',
      'POST /api/expenses/:expenseId/adjustments/distribute',
      'POST /api/expenses/:expenseId/adjustments',
      'GET /api/expenses/:expenseId/refund-allocation',
      'POST /api/payments/:paymentId/settlements',
      'GET /api/settlements',
      'GET /api/payments/:paymentId/context',
      'POST /api/imports/bank-csv',
      'GET /api/imports',
      'GET /api/imports/:importBatchId',
      'GET /api/payments/counterparty-options',
      'POST /api/payments/normalize',
      'POST /api/payments/classify',
      'GET /api/payments',
      'POST /api/payments',
      'POST /api/payments/:paymentId/counterparty',
      'POST /api/payments/:paymentId/cash-flow/:step',
      'GET /api/payments/:paymentId/history',
      'GET /api/payments/:paymentId',
      'GET /api/audit/:entityType/:entityId',
      'GET /api/rules',
      'POST /api/rules',
      'POST /api/rules/apply',
      'POST /api/rules/:ruleId',
      'GET /api/analytics/spending',
      'GET /api/analytics/monthly',
      'GET /api/analytics/own-spend',
      'GET /api/analytics/outstanding',
      'GET /api/analytics/unsettled',
      'GET /api/occasions',
      'POST /api/occasions',
      'GET /api/jobs',
      'POST /api/jobs',
      'POST /api/jobs/:jobId/retry',
      'POST /api/jobs/:jobId/cancel',
      'GET /api/jobs/:jobId',
      'GET /api/expenses',
      'POST /api/expenses',
      'GET /api/expenses/:expenseId',
      'GET /api/balances/:personAId/:personBId',
      'GET /api/people/manage',
      'GET /api/people',
      'POST /api/people',
      'POST /api/people/:personId',
      'GET /api/accounts',
      'POST /api/accounts',
      'POST /api/accounts/:accountId',
      'GET /api/merchants',
      'POST /api/merchants',
      'POST /api/merchants/:merchantId/aliases',
      'POST /api/merchants/:merchantId',
      'GET /api/groups',
      'POST /api/groups',
      'POST /api/groups/:groupId/members',
      'POST /api/groups/:groupId',
      'POST /api/group-memberships/:membershipId/end',
      'GET /api/proof-packs/:recipientPersonId',
      'POST /api/integrations/splitwise/connect',
      'POST /api/expenses/:expenseId/ready-to-sync',
      'POST /api/expenses/:expenseId/splitwise-sync',
      'POST /api/expenses/:expenseId/splitwise-resync',
      'GET /api/splitwise/resync-candidates',
      'POST /api/settlements/:settlementId/splitwise-sync',
      'POST /api/splitwise/audits',
      'GET /api/splitwise/audits',
      'GET /api/splitwise/audits/:id',
      'GET /api/splitwise/audit-findings',
      'GET /api/splitwise/audit-findings/:id',
      'POST /api/splitwise/audit-findings/:id/review',
      'POST /api/reconciliation/runs',
      'GET /api/reconciliation/runs',
      'GET /api/reconciliation/runs/:id',
      'GET /api/reconciliation/runs/:id/account-snapshots',
    ]);
  });
});
