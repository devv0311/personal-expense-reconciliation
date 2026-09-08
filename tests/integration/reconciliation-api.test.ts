import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

/** The exact wording an unconnected integration reports (audit finding 8). */
const NOT_CHECKED =
  'Splitwise was not checked: no integration is connected, so no comparison ran. ' +
  'This is not agreement — nothing was read.';

const BASE = 'http://localhost';

let database: TestDatabase;
let store: MemoryEvidenceStore;
let api: Api;
let cast: Cast;
let splitwise: ReturnType<typeof createMockSplitwisePort>;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  store = createMemoryEvidenceStore();
  cast = await seedCast(database.db);
  splitwise = createMockSplitwisePort();
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: store,
    splitwise,
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

function get(path: string): Request {
  return new Request(`${BASE}${path}`);
}

const JULY = {
  periodStart: '2026-07-01T00:00:00.000Z',
  periodEnd: '2026-08-01T00:00:00.000Z',
};

describe('POST /api/reconciliation/runs', () => {
  it('runs a reconciliation for a period with no Splitwise integration connected', async () => {
    const response = await api.handle(post('/api/reconciliation/runs', { actor: 'user', ...JULY }));
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body).toHaveProperty('reconciliationRunId');
    // Not an empty list: an unconnected integration is an unchecked one, and saying so is
    // the difference between "the ledger matches" and "nothing was read" (audit finding 8).
    expect(body).toMatchObject({
      discrepancies: [{ kind: 'splitwise_not_connected', detail: NOT_CHECKED }],
    });
    expect((body['totals'] as Record<string, unknown>)['ledgerUnexplainedTotal']).toBe('0');
  });

  it('400s when periodEnd is before periodStart', async () => {
    const response = await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        periodStart: JULY.periodEnd,
        periodEnd: JULY.periodStart,
      }),
    );
    expect(response.status).toBe(400);
  });

  it('400s a malformed period', async () => {
    const response = await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        periodStart: 'not-a-date',
        periodEnd: JULY.periodEnd,
      }),
    );
    expect(response.status).toBe(400);
  });

  it('400s an actor that is not a person', async () => {
    const response = await api.handle(
      post('/api/reconciliation/runs', { actor: 'system', ...JULY }),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/reconciliation/runs', () => {
  it('lists runs newest first', async () => {
    await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        periodStart: '2026-06-01T00:00:00.000Z',
        periodEnd: '2026-07-01T00:00:00.000Z',
      }),
    );
    await api.handle(post('/api/reconciliation/runs', { actor: 'user', ...JULY }));

    const response = await api.handle(get('/api/reconciliation/runs'));
    const body = await json(response);
    const runs = body['runs'] as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(runs).toHaveLength(2);
    expect(runs[0]!['periodStart']).toBe(JULY.periodStart);
  });

  it('respects ?limit=', async () => {
    await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        periodStart: '2026-06-01T00:00:00.000Z',
        periodEnd: '2026-07-01T00:00:00.000Z',
      }),
    );
    await api.handle(post('/api/reconciliation/runs', { actor: 'user', ...JULY }));

    const response = await api.handle(get('/api/reconciliation/runs?limit=1'));
    const body = await json(response);
    expect((body['runs'] as unknown[]).length).toBe(1);
  });
});

describe('GET /api/reconciliation/runs/:id', () => {
  it('reads one run back in full', async () => {
    const created = await api.handle(post('/api/reconciliation/runs', { actor: 'user', ...JULY }));
    const { reconciliationRunId } = (await json(created)) as { reconciliationRunId: string };

    const response = await api.handle(get(`/api/reconciliation/runs/${reconciliationRunId}`));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['id']).toBe(reconciliationRunId);
    expect(body).toHaveProperty('splitwiseBalancesSnapshot');
  });

  it('404s an unknown run id', async () => {
    const response = await api.handle(
      get('/api/reconciliation/runs/00000000-0000-0000-0000-000000000000'),
    );
    expect(response.status).toBe(404);
  });

  it('400s a malformed run id', async () => {
    const response = await api.handle(get('/api/reconciliation/runs/not-a-uuid'));
    expect(response.status).toBe(400);
  });
});

describe('route table', () => {
  it('exposes the phase-15 routes', () => {
    const paths = api.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('POST /api/reconciliation/runs');
    expect(paths).toContain('GET /api/reconciliation/runs');
    expect(paths).toContain('GET /api/reconciliation/runs/:id');
  });
});
