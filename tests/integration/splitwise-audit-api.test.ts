/**
 * The Splitwise auditing HTTP surface (`docs/roadmap.md` phase 19, ADR-0046).
 *
 * Six routes, all of them a read or a recorded decision. The one thing this file exists to
 * prove beyond ordinary request/response behaviour is the thing the surface must never do:
 * nothing reachable over HTTP here writes to Splitwise, and reviewing a finding does not
 * authorize one to.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';

import { paise } from '../../src/domain/index.js';
import type { BeneficiaryRef, PersonId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import {
  approveAllocation,
  connectSplitwiseIntegration,
  syncExpenseToSplitwise,
  transitionExpense,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { addExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';
const AS_USER = { actor: 'user', source: 'tests/integration/splitwise-audit-api' } as const;
const OCCURRED_AT = new Date('2026-07-10T19:20:00.000Z');

let database: TestDatabase;
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
  cast = await seedCast(database.db);
  splitwise = createMockSplitwisePort();
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
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

function friendA(): PersonId {
  return cast.person['person_friend_a']!;
}

/** A ₹900 dinner synced to Splitwise, which then reports nothing at all for the pair. */
async function seedMissingExternalExpense(): Promise<void> {
  await connectSplitwiseIntegration(database.db, { externalAccountRef: 'sandbox-account-1' });
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId: 'sw-dev' })
    .where(eq(schema.people.id, cast.userPersonId));
  await database.db
    .update(schema.people)
    .set({ splitwiseUserId: 'sw-friend-a' })
    .where(eq(schema.people.id, friendA()));

  const expenseId = await addExpense(database.db, {
    description: 'Group dinner',
    amount: paise(90_000n),
    occurredAt: OCCURRED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
    state: 'approved',
  });
  const beneficiaries: BeneficiaryRef[] = [
    { type: 'person', id: cast.userPersonId },
    { type: 'person', id: friendA() },
  ];
  await approveAllocation(database.db, {
    expenseId,
    decision: { method: 'equal', beneficiaries },
    decidedBy: 'manual',
    audit: AS_USER,
  });
  await transitionExpense(database.db, { expenseId, to: 'ready_to_sync', audit: AS_USER });
  await syncExpenseToSplitwise(database.db, { expenseId, splitwise, audit: AS_USER });

  splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(0n) }]);
  splitwise.setLedgerEntries('sw-friend-a', []);
}

async function runAudit(): Promise<Record<string, unknown>> {
  const response = await api.handle(post('/api/splitwise/audits', { actor: 'user' }));
  expect(response.status).toBe(201);
  return json(response);
}

async function firstFindingId(): Promise<string> {
  const body = await runAudit();
  const findings = body['findings'] as Array<Record<string, unknown>>;
  return findings[0]!['id'] as string;
}

describe('POST /api/splitwise/audits', () => {
  it('runs an audit with no Splitwise integration connected, and says it read nothing', async () => {
    const body = await runAudit();

    expect(body).toMatchObject({ externalReadStatus: 'skipped', findings: [] });
    expect(body).toHaveProperty('splitwiseAuditRunId');
  });

  it('returns the findings it produced, with money as exact decimal strings', async () => {
    await seedMissingExternalExpense();

    const body = await runAudit();
    const findings = body['findings'] as Array<Record<string, unknown>>;

    expect(body['externalReadStatus']).toBe('complete');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'missing_external_expense',
      amount: '45000',
      balanceImpact: '45000',
      reviewStatus: 'open',
    });
  });

  it('is safe to call twice: the second run re-observes rather than duplicates', async () => {
    await seedMissingExternalExpense();

    await runAudit();
    const second = await runAudit();

    expect(second).toMatchObject({ findingsCreated: 0, findingsReobserved: 1 });
    expect((second['findings'] as unknown[]).length).toBe(1);
  });

  it('400s an actor that is not a person', async () => {
    const response = await api.handle(post('/api/splitwise/audits', { actor: 'system' }));

    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('400s a missing actor', async () => {
    const response = await api.handle(post('/api/splitwise/audits', {}));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/splitwise/audits', () => {
  it('lists runs newest first', async () => {
    const first = await runAudit();
    const second = await runAudit();

    const body = await json(await api.handle(get('/api/splitwise/audits')));
    const runs = body['runs'] as Array<Record<string, unknown>>;

    expect(runs.map((run) => run['id'])).toEqual([
      second['splitwiseAuditRunId'],
      first['splitwiseAuditRunId'],
    ]);
  });

  it('honours ?limit=', async () => {
    await runAudit();
    await runAudit();

    const body = await json(await api.handle(get('/api/splitwise/audits?limit=1')));
    expect((body['runs'] as unknown[]).length).toBe(1);
  });

  it('400s a non-numeric limit', async () => {
    const response = await api.handle(get('/api/splitwise/audits?limit=lots'));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/splitwise/audits/:id', () => {
  it('returns one run with the findings it produced', async () => {
    await seedMissingExternalExpense();
    const run = await runAudit();

    const body = await json(
      await api.handle(get(`/api/splitwise/audits/${run['splitwiseAuditRunId'] as string}`)),
    );

    expect((body['run'] as Record<string, unknown>)['externalReadStatus']).toBe('complete');
    expect((body['findings'] as unknown[]).length).toBe(1);
  });

  it('404s an unknown run', async () => {
    const response = await api.handle(
      get('/api/splitwise/audits/00000000-0000-0000-0000-000000000000'),
    );
    expect(response.status).toBe(404);
  });

  it('400s a malformed id', async () => {
    const response = await api.handle(get('/api/splitwise/audits/not-a-uuid'));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/splitwise/audit-findings', () => {
  it('filters by review status, kind, class and person', async () => {
    await seedMissingExternalExpense();
    await runAudit();

    const open = await json(
      await api.handle(get('/api/splitwise/audit-findings?reviewStatus=open')),
    );
    expect((open['findings'] as unknown[]).length).toBe(1);

    const byKind = await json(
      await api.handle(get('/api/splitwise/audit-findings?kind=missing_external_expense')),
    );
    expect((byKind['findings'] as unknown[]).length).toBe(1);

    const byClass = await json(
      await api.handle(get('/api/splitwise/audit-findings?findingClass=limitation')),
    );
    expect(byClass['findings']).toEqual([]);

    const byPerson = await json(
      await api.handle(get(`/api/splitwise/audit-findings?personId=${friendA()}`)),
    );
    expect((byPerson['findings'] as unknown[]).length).toBe(1);
  });

  it('excludes superseded history unless it is asked for', async () => {
    await seedMissingExternalExpense();
    await runAudit();
    // The expense reappears on Splitwise, so the finding stops reproducing and becomes history.
    splitwise.setFriendBalances([{ splitwiseUserId: 'sw-friend-a', netBalance: paise(-45_000n) }]);
    splitwise.setLedgerEntries('sw-friend-a', [
      {
        splitwiseEntryId: 'sw-expense-1',
        kind: 'expense',
        description: 'Group dinner',
        totalAmount: paise(90_000n),
        currency: 'INR',
        deleted: false,
        occurredAt: OCCURRED_AT,
        pairNetBalance: paise(-45_000n),
      },
    ]);
    await runAudit();

    const current = await json(await api.handle(get('/api/splitwise/audit-findings')));
    expect(current['findings']).toEqual([]);

    const withHistory = await json(
      await api.handle(get('/api/splitwise/audit-findings?includeSuperseded=true')),
    );
    expect((withHistory['findings'] as unknown[]).length).toBe(1);
  });

  it('400s an unknown filter value', async () => {
    expect((await api.handle(get('/api/splitwise/audit-findings?kind=made_up'))).status).toBe(400);
    expect(
      (await api.handle(get('/api/splitwise/audit-findings?includeSuperseded=maybe'))).status,
    ).toBe(400);
    expect((await api.handle(get('/api/splitwise/audit-findings?personId=nope'))).status).toBe(400);
  });
});

describe('GET /api/splitwise/audit-findings/:id', () => {
  it('returns the finding with both compared snapshots and its history', async () => {
    await seedMissingExternalExpense();
    const findingId = await firstFindingId();

    const body = await json(await api.handle(get(`/api/splitwise/audit-findings/${findingId}`)));
    const finding = body['finding'] as Record<string, unknown>;

    expect(finding['localSnapshot']).toMatchObject({ friendShareNow: '45000' });
    expect(finding['externalSnapshot']).toMatchObject({ present: false });
    expect(finding['evidence']).toEqual(expect.any(Array));
    expect((body['history'] as unknown[]).length).toBe(1);
  });

  it('404s an unknown finding', async () => {
    const response = await api.handle(
      get('/api/splitwise/audit-findings/00000000-0000-0000-0000-000000000000'),
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/splitwise/audit-findings/:id/review', () => {
  it('records a decision and returns it', async () => {
    await seedMissingExternalExpense();
    const findingId = await firstFindingId();

    const response = await api.handle(
      post(`/api/splitwise/audit-findings/${findingId}/review`, {
        actor: 'user',
        decision: 'resolved',
        reason: 'Re-created on Splitwise by hand.',
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ findingId, reviewStatus: 'resolved', reviewedBy: 'user' });

    const detail = await json(await api.handle(get(`/api/splitwise/audit-findings/${findingId}`)));
    expect((detail['finding'] as Record<string, unknown>)['reviewReason']).toBe(
      'Re-created on Splitwise by hand.',
    );
    expect((detail['history'] as unknown[]).length).toBe(2);
  });

  it('409s a resolution with no reason', async () => {
    await seedMissingExternalExpense();
    const findingId = await firstFindingId();

    const response = await api.handle(
      post(`/api/splitwise/audit-findings/${findingId}/review`, {
        actor: 'user',
        decision: 'resolved',
      }),
    );
    expect(response.status).toBe(409);
  });

  it('400s an unknown decision, and an actor that is not a person', async () => {
    await seedMissingExternalExpense();
    const findingId = await firstFindingId();

    expect(
      (
        await api.handle(
          post(`/api/splitwise/audit-findings/${findingId}/review`, {
            actor: 'user',
            decision: 're-sync',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api.handle(
          post(`/api/splitwise/audit-findings/${findingId}/review`, {
            actor: 'rule:auto',
            decision: 'dismissed',
            reason: 'automated',
          }),
        )
      ).status,
    ).toBe(400);
  });

  it('404s an unknown finding', async () => {
    const response = await api.handle(
      post('/api/splitwise/audit-findings/00000000-0000-0000-0000-000000000000/review', {
        actor: 'user',
        decision: 'acknowledged',
      }),
    );
    expect(response.status).toBe(404);
  });

  it('triggers no Splitwise write, and offers no route that could', async () => {
    await seedMissingExternalExpense();
    const createdBefore = splitwise.createdExpenses.length;
    const paymentsBefore = splitwise.recordedPayments.length;
    const findingId = await firstFindingId();

    await api.handle(
      post(`/api/splitwise/audit-findings/${findingId}/review`, {
        actor: 'user',
        decision: 'resolved',
        reason: 'Accepted — a corrective re-sync is a separate, approved operation.',
      }),
    );

    expect(splitwise.createdExpenses).toHaveLength(createdBefore);
    expect(splitwise.recordedPayments).toHaveLength(paymentsBefore);
    // No audit route offers an update or delete against Splitwise at all.
    const auditRoutes = api.routes.filter((route) => route.path.startsWith('/api/splitwise/audit'));
    expect(auditRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /api/splitwise/audits',
      'GET /api/splitwise/audits',
      'GET /api/splitwise/audits/:id',
      'GET /api/splitwise/audit-findings',
      'GET /api/splitwise/audit-findings/:id',
      'POST /api/splitwise/audit-findings/:id/review',
    ]);
  });

  it('405s the wrong verb on a known path', async () => {
    const response = await api.handle(get('/api/splitwise/audit-findings/x/review'));
    expect(response.status).toBe(405);
  });
});
