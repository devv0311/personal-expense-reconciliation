/**
 * `GET /api/proof-packs/:recipientPersonId` — the HTTP surface for a derived proof pack
 * (`docs/roadmap.md` Phase 20, ADR-0047).
 *
 * The pack's content is covered by `tests/scenarios/proof-packs.test.ts`; this file covers the
 * route: its shape, its `asOf` query parameter, its error mapping, and that it is a read.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import type { PersonId } from '../../src/domain/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { AS_USER, addExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { approveAllocation } from '../../src/services/index.js';

const BASE = 'http://localhost';

let database: TestDatabase;
let api: Api;
let cast: Cast;

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
});

function friendA(): PersonId {
  return cast.person['person_friend_a']!;
}

async function seedSharedDinner(): Promise<void> {
  const expenseId = await addExpense(database.db, {
    description: 'Dinner at the pier',
    amount: paise(100_000n),
    occurredAt: new Date('2026-07-01T10:00:00.000Z'),
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
  });
  await approveAllocation(database.db, {
    expenseId,
    decision: {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: cast.userPersonId },
        { type: 'person', id: friendA() },
      ],
    },
    decidedBy: 'manual',
    audit: AS_USER,
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('GET /api/proof-packs/:recipientPersonId', () => {
  it('returns the preview for a pair', async () => {
    await seedSharedDinner();

    const response = await api.handle(new Request(`${BASE}/api/proof-packs/${friendA()}`));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['intendedRecipient']).toEqual({ id: friendA(), displayName: 'Friend A' });
    expect(typeof body['asOf']).toBe('string');
    expect(body['generatedText']).toContain('Expense summary for Friend A');
    expect(body['generatedText']).toContain('Friend A owes me ₹500.00');
    expect(Array.isArray(body['warnings'])).toBe(true);
    expect(Array.isArray(body['evidenceReferences'])).toBe(true);
    const pack = body['pack'] as Record<string, unknown>;
    expect(pack['netBalance']).toBe('-50000');
    expect(pack['netDirection']).toBe('recipient_owes_user');
  });

  it('pins the as-of label from ?asOf and is deterministic over the wire', async () => {
    await seedSharedDinner();
    const asOf = '2026-09-06T09:00:00.000Z';

    const a = await json(
      await api.handle(new Request(`${BASE}/api/proof-packs/${friendA()}?asOf=${asOf}`)),
    );
    const b = await json(
      await api.handle(new Request(`${BASE}/api/proof-packs/${friendA()}?asOf=${asOf}`)),
    );

    expect(a['asOf']).toBe(asOf);
    expect(a['generatedText']).toContain('As of 6 Sep 2026');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('404s an unknown recipient', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/proof-packs/00000000-0000-0000-0000-000000000000`),
    );
    expect(response.status).toBe(404);
  });

  it('400s a malformed recipient id', async () => {
    const response = await api.handle(new Request(`${BASE}/api/proof-packs/not-a-uuid`));
    expect(response.status).toBe(400);
  });

  it('400s a malformed asOf', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/proof-packs/${friendA()}?asOf=not-a-date`),
    );
    expect(response.status).toBe(400);
  });

  it('409s a pack requested for the user themselves', async () => {
    const response = await api.handle(new Request(`${BASE}/api/proof-packs/${cast.userPersonId}`));
    expect(response.status).toBe(409);
  });

  it('is registered as a GET route, and is the only read under /api/proof-packs', () => {
    const paths = api.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('GET /api/proof-packs/:recipientPersonId');
    // Deriving a pack is a read; sending one is a write, and lives on its own POST
    // (ADR-0053). The list is ordered so the literal `/deliveries` segment is matched before
    // the capture that would otherwise swallow it.
    expect(paths.filter((path) => path.includes('/api/proof-packs'))).toEqual([
      'POST /api/proof-packs/:recipientPersonId/deliveries',
      'GET /api/proof-packs/:recipientPersonId/deliveries',
      'GET /api/proof-packs/:recipientPersonId',
    ]);
  });
});
