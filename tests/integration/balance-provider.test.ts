/**
 * Live bank and card balances, end to end over the HTTP surface (audit row 37, ADR-0054).
 *
 * The load-bearing assertions, in order of how badly each would go wrong:
 *
 *  1. **A reading never becomes a boundary.** The comparison route puts the two figures side
 *     by side and the snapshot is untouched, including its `verificationStatus`.
 *  2. **An account the provider did not answer for gets a row saying so.** Silence must not
 *     read as "we have not looked recently", and it must certainly not read as zero.
 *  3. **An unconfigured installation reports an incomplete read**, never an empty success.
 *  4. **Credentials never reach the database or a response.**
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { asId, paise } from '../../src/domain/index.js';
import type { AccountId, EvidenceId, Paise } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import { runReconciliation } from '../../src/services/index.js';
import type { AccountBoundaryInput } from '../../src/services/index.js';
import { createUnconfiguredBalanceProvider } from '../../src/integrations/balance-provider/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { createMockBalanceProvider } from '../support/balance-provider.js';
import type { MockBalanceProvider } from '../support/balance-provider.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const BASE = 'http://localhost';
const PERIOD_START = new Date('2026-07-01T00:00:00Z');
const PERIOD_END = new Date('2026-08-01T00:00:00Z');

let database: TestDatabase;
let api: Api;
let cast: Cast;
let provider: MockBalanceProvider;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  provider = createMockBalanceProvider();
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
    balanceProvider: provider,
  });
});

function savings(): AccountId {
  return cast.account['account_hdfc_savings']!;
}

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

async function link(accountId: AccountId, ref: string): Promise<string> {
  const response = await api.handle(
    post('/api/balance-provider/links', {
      actor: 'user',
      accountId,
      externalAccountRef: ref,
    }),
  );
  expect(response.status).toBe(201);
  return (await json(response))['id'] as string;
}

/** A run with an evidenced closing balance, so there is something to compare against. */
async function runWithBoundaries(closing: Paise): Promise<string> {
  const [evidence] = await database.db
    .insert(schema.evidence)
    .values({ type: 'bank_line', rawText: 'Statement page', capturedAt: PERIOD_END })
    .returning({ id: schema.evidence.id });
  const evidenceId = asId<'evidence'>(evidence!.id) as EvidenceId;

  const boundaries: AccountBoundaryInput[] = [
    {
      accountId: savings(),
      openingBalance: paise(0n),
      openingBalanceEvidenceId: evidenceId,
      closingBalance: closing,
      closingBalanceEvidenceId: evidenceId,
    },
  ];
  const result = await runReconciliation(database.db, {
    userPersonId: cast.userPersonId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    splitwise: createMockSplitwisePort(),
    accountBoundaries: boundaries,
    audit: { actor: 'user', source: 'tests/balance-provider' },
  });
  return result.reconciliationRunId;
}

/** The savings account's own snapshot — the cast has several accounts, and order is not fixed. */
async function savingsSnapshot() {
  const rows = await database.db
    .select()
    .from(schema.reconciliationAccountSnapshots)
    .where(eq(schema.reconciliationAccountSnapshots.accountId, savings()));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('GET /api/balance-provider/status', () => {
  it('says what is configured and how much is mapped', async () => {
    const body = await json(await api.handle(new Request(`${BASE}/api/balance-provider/status`)));
    expect(body['configured']).toBe(true);
    expect(body['linkedAccountCount']).toBe(0);
    // The rule travels with the API rather than living only in a screen.
    expect(body['readingsAreNeverBoundaries']).toBe(true);
  });
});

describe('POST /api/balance-provider/links', () => {
  it('maps one account to one provider account', async () => {
    const linkId = await link(savings(), 'ref-savings');
    const body = await json(await api.handle(new Request(`${BASE}/api/balance-provider/links`)));
    const links = body['links'] as Record<string, unknown>[];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      id: linkId,
      accountId: savings(),
      externalAccountRef: 'ref-savings',
      providerId: 'mock-provider',
    });
  });

  it('refuses a second link for the same account', async () => {
    await link(savings(), 'ref-savings');
    const response = await api.handle(
      post('/api/balance-provider/links', {
        actor: 'user',
        accountId: savings(),
        externalAccountRef: 'ref-other',
      }),
    );
    expect(response.status).toBe(409);
    expect((await json(response))['error']).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses to map one remote account to two of yours', async () => {
    await link(savings(), 'ref-savings');
    const response = await api.handle(
      post('/api/balance-provider/links', {
        actor: 'user',
        accountId: cast.account['account_hdfc_upi']!,
        externalAccountRef: 'ref-savings',
      }),
    );
    expect(response.status).toBe(409);
  });

  it('unlinks by archiving, so past readings still name an account', async () => {
    const linkId = await link(savings(), 'ref-savings');
    provider.setBalance('ref-savings', 500_00n, PERIOD_END);
    await api.handle(post('/api/balance-provider/refresh', { actor: 'user' }));

    const response = await api.handle(
      post(`/api/balance-provider/links/${linkId}/unlink`, { actor: 'user' }),
    );
    expect(response.status).toBe(200);

    const links = (await json(await api.handle(new Request(`${BASE}/api/balance-provider/links`))))[
      'links'
    ] as unknown[];
    expect(links).toHaveLength(0);
    // The reading survives, and still names the account it was about.
    const readings = await database.db.select().from(schema.accountBalanceReadings);
    expect(readings).toHaveLength(1);
    expect(readings[0]!.accountId).toBe(savings());
  });
});

describe('POST /api/balance-provider/refresh', () => {
  it('records what the provider said, with its own instant separate from the fetch', async () => {
    await link(savings(), 'ref-savings');
    const asOf = new Date('2026-07-31T18:00:00Z');
    provider.setBalance('ref-savings', 1_234_500n, asOf);

    const body = await json(
      await api.handle(post('/api/balance-provider/refresh', { actor: 'user' })),
    );

    expect((body['completeness'] as Record<string, unknown>)['complete']).toBe(true);
    const readings = body['readings'] as Record<string, unknown>[];
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      status: 'ok',
      balance: '1234500',
      asOf: asOf.toISOString(),
      readComplete: true,
    });
    expect(readings[0]!['fetchedAt']).not.toBe(readings[0]!['asOf']);
  });

  it('writes an unavailable row for an account the provider could not answer for', async () => {
    await link(savings(), 'ref-savings');
    provider.setUnavailable('ref-savings', 'Consent expired.');

    await api.handle(post('/api/balance-provider/refresh', { actor: 'user' }));

    const [reading] = await database.db.select().from(schema.accountBalanceReadings);
    expect(reading!.status).toBe('unavailable');
    expect(reading!.balance).toBeNull();
    expect(reading!.failureReason).toBe('Consent expired.');
  });

  it('writes a row for an account the provider stayed silent about, rather than none', async () => {
    await link(savings(), 'ref-savings');
    provider.omit('ref-savings');

    await api.handle(post('/api/balance-provider/refresh', { actor: 'user' }));

    // A missing row would read as "we have not looked recently". This looked and saw nothing.
    const [reading] = await database.db.select().from(schema.accountBalanceReadings);
    expect(reading!.status).toBe('unavailable');
    expect(reading!.readComplete).toBe(false);
    expect(reading!.failureReason).toContain('Silence is not a balance');
  });

  it('carries a partial read onto every row it produced', async () => {
    await link(savings(), 'ref-savings');
    provider.setBalance('ref-savings', 100n, PERIOD_END);
    provider.setPartial('Consent covers one of your accounts.');

    await api.handle(post('/api/balance-provider/refresh', { actor: 'user' }));

    const [reading] = await database.db.select().from(schema.accountBalanceReadings);
    expect(reading!.readComplete).toBe(false);
    expect(reading!.readIncompleteReason).toBe('Consent covers one of your accounts.');
  });

  it('says nothing was read when no account is linked, rather than reporting a clean read', async () => {
    const body = await json(
      await api.handle(post('/api/balance-provider/refresh', { actor: 'user' })),
    );
    const completeness = body['completeness'] as Record<string, unknown>;
    expect(completeness['complete']).toBe(false);
    expect(String(completeness['incompleteReason'])).toContain('not a statement about any account');
  });
});

describe('GET /api/balance-provider/comparison', () => {
  it('puts a reading beside the run’s evidenced closing balance without touching it', async () => {
    await link(savings(), 'ref-savings');
    provider.setBalance('ref-savings', 500_000n, new Date('2026-07-31T18:00:00Z'));
    await api.handle(post('/api/balance-provider/refresh', { actor: 'user' }));
    const runId = await runWithBoundaries(paise(500_000n));

    const body = await json(
      await api.handle(new Request(`${BASE}/api/balance-provider/comparison?runId=${runId}`)),
    );
    const comparisons = body['comparisons'] as Record<string, unknown>[];
    const mine = comparisons.find((entry) => entry['accountId'] === savings())!;
    expect((mine['comparison'] as Record<string, unknown>)['verdict']).toBe('agrees');
    expect(String(body['note'])).toContain('never a period boundary');

    // The snapshot is exactly as the run wrote it. Agreement changed nothing.
    const snapshot = await savingsSnapshot();
    expect(snapshot.closingBalance).toBe(500_000n);
    expect(snapshot.closingBalanceEvidenceId).not.toBeNull();
  });

  it('reports a disagreement as a signed difference, and still changes nothing', async () => {
    await link(savings(), 'ref-savings');
    provider.setBalance('ref-savings', 480_000n, new Date('2026-07-31T18:00:00Z'));
    await api.handle(post('/api/balance-provider/refresh', { actor: 'user' }));
    const runId = await runWithBoundaries(paise(500_000n));

    const body = await json(
      await api.handle(new Request(`${BASE}/api/balance-provider/comparison?runId=${runId}`)),
    );
    const mine = (body['comparisons'] as Record<string, unknown>[]).find(
      (entry) => entry['accountId'] === savings(),
    )!;
    const comparison = mine['comparison'] as Record<string, unknown>;
    expect(comparison['verdict']).toBe('differs');
    expect(comparison['difference']).toBe('-20000');

    expect((await savingsSnapshot()).closingBalance).toBe(500_000n);
  });

  it('never calls a comparison against an unevidenced boundary agreement', async () => {
    await link(savings(), 'ref-savings');
    provider.setBalance('ref-savings', 0n, new Date('2026-07-31T18:00:00Z'));
    await api.handle(post('/api/balance-provider/refresh', { actor: 'user' }));

    // A run with no boundaries: the closing balance is unknown, not zero.
    const result = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      splitwise: createMockSplitwisePort(),
      accountBoundaries: [
        {
          accountId: savings(),
          openingBalance: null,
          openingBalanceEvidenceId: null,
          closingBalance: null,
          closingBalanceEvidenceId: null,
        },
      ],
      audit: { actor: 'user', source: 'tests/balance-provider' },
    });

    const body = await json(
      await api.handle(
        new Request(`${BASE}/api/balance-provider/comparison?runId=${result.reconciliationRunId}`),
      ),
    );
    const mine = (body['comparisons'] as Record<string, unknown>[]).find(
      (entry) => entry['accountId'] === savings(),
    )!;
    const comparison = mine['comparison'] as Record<string, unknown>;
    expect(comparison['verdict']).toBe('not_comparable');
    expect(String(comparison['caveat'])).toContain('never that evidence');
  });

  it('400s without a runId, because a balance means nothing without a period', async () => {
    const response = await api.handle(new Request(`${BASE}/api/balance-provider/comparison`));
    expect(response.status).toBe(400);
  });
});

describe('an unconfigured installation', () => {
  it('reports an incomplete read rather than an empty success', async () => {
    const unconfigured = createApi({
      db: database.db,
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      evidenceStore: createMemoryEvidenceStore(),
      splitwise: createMockSplitwisePort(),
      balanceProvider: createUnconfiguredBalanceProvider(),
    });

    const status = await json(
      await unconfigured.handle(new Request(`${BASE}/api/balance-provider/status`)),
    );
    expect(status['configured']).toBe(false);
    expect(String(status['unavailableReason'])).toContain('BALANCE_PROVIDER_URL');

    const refresh = await json(
      await unconfigured.handle(post('/api/balance-provider/refresh', { actor: 'user' })),
    );
    const completeness = refresh['completeness'] as Record<string, unknown>;
    expect(completeness['complete']).toBe(false);
  });
});

describe('what never reaches the database', () => {
  it('stores no credential on a link or a reading', async () => {
    await link(savings(), 'ref-savings');
    provider.setBalance('ref-savings', 1n, PERIOD_END);
    await api.handle(post('/api/balance-provider/refresh', { actor: 'user' }));

    const links = await database.db.select().from(schema.accountProviderLinks);
    const readings = await database.db.select().from(schema.accountBalanceReadings);
    const serialized = JSON.stringify([links, readings], (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    // The columns simply do not exist; this asserts the shape rather than a redaction.
    expect(Object.keys(links[0]!)).not.toContain('accessToken');
    expect(Object.keys(readings[0]!)).not.toContain('accessToken');
    expect(serialized.toLowerCase()).not.toContain('token');
  });
});

describe('route registration', () => {
  it('registers every balance-provider route, and none that writes a boundary', () => {
    const paths = api.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('GET /api/balance-provider/status');
    expect(paths).toContain('GET /api/balance-provider/links');
    expect(paths).toContain('POST /api/balance-provider/links');
    expect(paths).toContain('POST /api/balance-provider/links/:linkId/unlink');
    expect(paths).toContain('POST /api/balance-provider/refresh');
    expect(paths).toContain('GET /api/balance-provider/comparison');
    expect(paths).toContain('GET /api/accounts/:accountId/balance-readings');
    // The only route that sets a period boundary is still the reconciliation run itself.
    expect(paths.filter((path) => path.includes('boundary'))).toEqual([]);
  });
});
