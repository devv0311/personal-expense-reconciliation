/**
 * The phase 17 HTTP surface: recording a notification, enriching it, deciding a candidate,
 * and reading a payment's re-attached context.
 *
 * The transport-level half of ADR-0044's guarantees. In particular: no route here links
 * evidence except `POST /api/evidence/matches/:candidateId/decision` with `accept`, and that
 * one is refused with the same write-once error as `POST /api/evidence/:evidenceId/link` when
 * the evidence already has a home.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import type { PaymentId } from '../../src/domain/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const BASE = 'http://localhost';
const CAPTURED_AT = '2026-07-01T19:04:00.000Z';
const SMS = 'Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26 to BLINKIT. UPI Ref no 2607011234.';

let database: TestDatabase;
let api: Api;
let cast: Cast;
let paymentId: PaymentId;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
  paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(124_000n),
    direction: 'debit',
    occurredAt: new Date('2026-07-01T00:00:00Z'),
    rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    channel: 'upi',
    externalReference: 'UPI/2607011234/BLINKIT',
    referenceType: 'upi_utr',
  });
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function recordNotification(overrides: Record<string, unknown> = {}) {
  const response = await api.handle(
    post('/api/evidence/notifications', {
      actor: 'user',
      type: 'upi_notification',
      text: SMS,
      capturedAt: CAPTURED_AT,
      ...overrides,
    }),
  );
  return { response, body: await json(response) };
}

async function enrich(evidenceId: string) {
  const response = await api.handle(post(`/api/evidence/${evidenceId}/enrich`, { actor: 'user' }));
  return { response, body: await json(response) };
}

describe('POST /api/evidence/notifications', () => {
  it('records a notification and returns its reading', async () => {
    const { response, body } = await recordNotification();

    expect(response.status).toBe(201);
    expect(body['outcome']).toBe('recorded');
    expect(body['observation']).toMatchObject({
      // Money crosses the boundary as an exact decimal string of minor units, never a number.
      observedAmount: '124000',
      observedReference: '2607011234',
      observedAccountHint: '4821',
    });
  });

  it('answers 200 for a retry, so a client learns it was not a second notification', async () => {
    await recordNotification();
    const { response, body } = await recordNotification();
    expect(response.status).toBe(200);
    expect(body['outcome']).toBe('already_recorded');
  });

  it('refuses an actor the audit trail could not trace to a person', async () => {
    const { response, body } = await recordNotification({ actor: 'system' });
    expect(response.status).toBe(400);
    expect((body['error'] as Record<string, unknown>)['code']).toBe('INVALID_REQUEST');
  });

  it('refuses an evidence type that is not a notification', async () => {
    const { response } = await recordNotification({ type: 'receipt_image' });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/evidence/:evidenceId/enrich', () => {
  it('returns candidates with their signal provenance, and links nothing', async () => {
    const { body: recorded } = await recordNotification();
    const { response, body } = await enrich(recorded['evidenceId'] as string);

    expect(response.status).toBe(200);
    expect(body['outcome']).toBe('matched');
    const candidates = body['candidates'] as Record<string, unknown>[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      paymentId,
      strength: 'deterministic',
      confidence: 'high',
      status: 'proposed',
      requiresReview: true,
    });

    const metadata = await json(
      await api.handle(new Request(`${BASE}/api/evidence/${recorded['evidenceId'] as string}`)),
    );
    expect(metadata['linkedPaymentId']).toBeNull();
  });

  it('is idempotent over HTTP as well', async () => {
    const { body: recorded } = await recordNotification();
    await enrich(recorded['evidenceId'] as string);
    const { body } = await enrich(recorded['evidenceId'] as string);
    expect(body['outcome']).toBe('unchanged');
  });

  it('404s for an evidence id that does not exist', async () => {
    const { response } = await enrich('00000000-0000-4000-8000-000000000000');
    expect(response.status).toBe(404);
  });

  it('400s for a path segment that is not a UUID', async () => {
    const { response } = await enrich('not-a-uuid');
    expect(response.status).toBe(400);
  });
});

describe('GET /api/evidence/:evidenceId/matches', () => {
  it('reads back what enrichment recorded', async () => {
    const { body: recorded } = await recordNotification();
    await enrich(recorded['evidenceId'] as string);

    const response = await api.handle(
      new Request(`${BASE}/api/evidence/${recorded['evidenceId'] as string}/matches`),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect((body['candidates'] as unknown[]).length).toBe(1);
  });
});

describe('POST /api/evidence/matches/:candidateId/decision', () => {
  async function candidateId(): Promise<{ evidenceId: string; candidateId: string }> {
    const { body: recorded } = await recordNotification();
    const evidenceId = recorded['evidenceId'] as string;
    const { body } = await enrich(evidenceId);
    const candidates = body['candidates'] as Record<string, unknown>[];
    return { evidenceId, candidateId: candidates[0]!['candidateId'] as string };
  }

  it('accepts a candidate and attaches the evidence', async () => {
    const ids = await candidateId();

    const response = await api.handle(
      post(`/api/evidence/matches/${ids.candidateId}/decision`, {
        actor: 'user:dev',
        decision: 'accept',
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['outcome']).toBe('accepted');
    expect((body['evidence'] as Record<string, unknown>)['linkedPaymentId']).toBe(paymentId);
  });

  it('dismisses a candidate without attaching anything', async () => {
    const ids = await candidateId();

    const body = await json(
      await api.handle(
        post(`/api/evidence/matches/${ids.candidateId}/decision`, {
          actor: 'user',
          decision: 'dismiss',
        }),
      ),
    );

    expect(body['outcome']).toBe('dismissed');
    expect((body['evidence'] as Record<string, unknown>)['linkedPaymentId']).toBeNull();
  });

  it('403s an actor that is neither a person nor a rule', async () => {
    const ids = await candidateId();
    const response = await api.handle(
      post(`/api/evidence/matches/${ids.candidateId}/decision`, {
        actor: 'ai',
        decision: 'accept',
      }),
    );
    expect(response.status).toBe(403);
    expect(((await json(response))['error'] as Record<string, unknown>)['code']).toBe(
      'DECISION_ACTOR_INVALID',
    );
  });

  it('422s an accept that would re-point a link that already exists', async () => {
    const ids = await candidateId();
    const other = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(50_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      rawDescription: 'UPI/P2M/000001',
      channel: 'upi',
    });
    await api.handle(
      post(`/api/evidence/${ids.evidenceId}/link`, { actor: 'user', linkedPaymentId: other }),
    );

    const response = await api.handle(
      post(`/api/evidence/matches/${ids.candidateId}/decision`, {
        actor: 'user',
        decision: 'accept',
      }),
    );

    expect(response.status).toBe(422);
    expect(((await json(response))['error'] as Record<string, unknown>)['code']).toBe(
      'EVIDENCE_LINK_IMMUTABLE',
    );
  });

  it('409s a second decision on the same candidate', async () => {
    const ids = await candidateId();
    await api.handle(
      post(`/api/evidence/matches/${ids.candidateId}/decision`, {
        actor: 'user',
        decision: 'dismiss',
      }),
    );
    const response = await api.handle(
      post(`/api/evidence/matches/${ids.candidateId}/decision`, {
        actor: 'user',
        decision: 'accept',
      }),
    );
    expect(response.status).toBe(409);
  });
});

describe('POST /api/evidence/:evidenceId/observation', () => {
  it('corrects a reading the grammar got wrong', async () => {
    const { body: recorded } = await recordNotification();

    const body = await json(
      await api.handle(
        post(`/api/evidence/${recorded['evidenceId'] as string}/observation`, {
          actor: 'user',
          observedMerchantText: 'Blinkit India Pvt Ltd',
        }),
      ),
    );

    expect(body['outcome']).toBe('updated');
    expect((body['observation'] as Record<string, unknown>)['observedMerchantText']).toBe(
      'Blinkit India Pvt Ltd',
    );
  });

  it('refuses an account hint that is more than a masked tail', async () => {
    const { body: recorded } = await recordNotification();
    const response = await api.handle(
      post(`/api/evidence/${recorded['evidenceId'] as string}/observation`, {
        actor: 'user',
        observedAccountHint: '4111111111114821',
      }),
    );
    expect(response.status).toBe(422);
    expect(((await json(response))['error'] as Record<string, unknown>)['code']).toBe(
      'EVIDENCE_OBSERVATION_INVALID',
    );
  });
});

describe('GET /api/payments/:paymentId/context', () => {
  it('returns the narration verbatim beside the reconstruction', async () => {
    const { body: recorded } = await recordNotification();
    const { body: enriched } = await enrich(recorded['evidenceId'] as string);
    const candidates = enriched['candidates'] as Record<string, unknown>[];
    await api.handle(
      post(`/api/evidence/matches/${candidates[0]!['candidateId'] as string}/decision`, {
        actor: 'user',
        decision: 'accept',
      }),
    );

    const response = await api.handle(new Request(`${BASE}/api/payments/${paymentId}/context`));
    const body = await json(response);
    const context = body['context'] as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(context['narration']).toBe('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
    expect(context['merchantCandidates']).toEqual([
      { value: 'BLINKIT', evidenceIds: [recorded['evidenceId']] },
    ]);
    expect(context['conflicts']).toEqual([]);
  });

  it('returns an empty context for a payment nothing is attached to', async () => {
    const body = await json(
      await api.handle(new Request(`${BASE}/api/payments/${paymentId}/context`)),
    );
    const context = body['context'] as Record<string, unknown>;
    expect(context['sources']).toEqual([]);
    expect(context['narration']).toBe('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
  });

  it('404s for a payment that does not exist', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/payments/00000000-0000-4000-8000-000000000000/context`),
    );
    expect(response.status).toBe(404);
  });
});
