/**
 * The read surface phase 21's UI needed and phase 16 deliberately did not ship
 * (`docs/roadmap.md` phase 21, ADR-0048):
 *
 * ```
 * GET  /api/accounts                                   the roster a waterfall names
 * GET  /api/expenses/:expenseId                        one ledger row, for a detail screen
 * POST /api/reconciliation/runs   + accountBoundaries  evidenced statement balances
 * GET  /api/reconciliation/runs/:id/account-snapshots  ADR-0017's per-account cash identity
 * ```
 *
 * Every test here is about one rule: the transport added no arithmetic and no new permission.
 * A run given no boundaries still reports `incomplete`; a balance sent without its evidence is
 * refused rather than stored; the figures a snapshot route returns are byte-for-byte the ones
 * `services.runReconciliation` already computed and stored.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { schema } from '../../src/db/index.js';
import { asId, paise } from '../../src/domain/index.js';
import type { AccountId, EvidenceId } from '../../src/domain/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { addExpense, addPayment, linkPaymentToExpense, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';

const PERIOD = {
  periodStart: '2026-07-01T00:00:00.000Z',
  periodEnd: '2026-08-01T00:00:00.000Z',
};

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

function get(path: string): Request {
  return new Request(`${BASE}${path}`);
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** A statement page, so a boundary balance can cite immutable evidence (17.5). */
async function statementEvidence(): Promise<EvidenceId> {
  const [row] = await database.db
    .insert(schema.evidence)
    .values({
      type: 'bank_line',
      rawText: 'Synthetic statement page',
      capturedAt: new Date(PERIOD.periodEnd),
    })
    .returning({ id: schema.evidence.id });
  return asId<'evidence'>(row!.id);
}

const savings = (): AccountId => cast.account['account_hdfc_savings']!;

describe('GET /api/accounts', () => {
  it('returns every account by name, with a redacted tail and never a full number', async () => {
    const response = await api.handle(get('/api/accounts'));
    const body = await json(response);

    expect(response.status).toBe(200);
    const accounts = body['accounts'] as Array<Record<string, unknown>>;
    expect(accounts.map((account) => account['name'])).toEqual([
      'Cash',
      'HDFC Savings',
      'HDFC UPI',
      'ICICI Credit Card',
    ]);

    const hdfc = accounts.find((account) => account['name'] === 'HDFC Savings');
    expect(hdfc).toMatchObject({
      type: 'bank',
      institution: 'HDFC Bank',
      last4: '4821',
      currency: 'INR',
      isActive: true,
      archivedAt: null,
    });
    // Nothing in the payload is longer than a four-digit tail.
    for (const account of accounts) {
      const last4 = account['last4'];
      expect(last4 === null || /^[0-9]{1,4}$/.test(last4 as string)).toBe(true);
    }
  });

  it('refuses a verb it does not implement rather than 404ing a known path', async () => {
    const response = await api.handle(post('/api/accounts', {}));
    expect(response.status).toBe(405);
  });
});

describe('GET /api/expenses/:expenseId', () => {
  it('returns exactly the row the ledger listing returns for the same expense', async () => {
    const expenseId = await addExpense(database.db, {
      description: 'Dinner at Peppermill',
      amount: paise(3_200_00n),
      occurredAt: new Date('2026-07-05T20:15:00Z'),
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    await database.db.insert(schema.expenseAdjustments).values({
      originalExpenseId: expenseId,
      kind: 'merchant_refund',
      amount: paise(200_00n),
      occurredAt: new Date('2026-07-08T10:00:00Z'),
    });

    const detail = await json(await api.handle(get(`/api/expenses/${expenseId}`)));
    const listing = await json(await api.handle(get('/api/expenses')));
    const row = (listing['expenses'] as Array<Record<string, unknown>>).find(
      (expense) => expense['id'] === expenseId,
    );

    expect(detail).toEqual(row);
    // The net figure is the domain's, quoted once — a detail screen cannot disagree with the
    // list row that linked to it.
    expect(detail['grossAmount']).toBe('320000');
    expect(detail['netAmount']).toBe('300000');
  });

  it('404s an expense that does not exist', async () => {
    const response = await api.handle(get('/api/expenses/00000000-0000-4000-8000-000000000000'));
    expect(response.status).toBe(404);
    expect((await json(response))['error']).toMatchObject({ code: 'ENTITY_NOT_FOUND' });
  });

  it('400s an id that is not a UUID rather than treating it as a filter', async () => {
    const response = await api.handle(get('/api/expenses/not-a-uuid'));
    expect(response.status).toBe(400);
  });
});

describe('POST /api/reconciliation/runs with accountBoundaries', () => {
  it('reports every account incomplete when no boundary evidence is sent', async () => {
    const response = await api.handle(
      post('/api/reconciliation/runs', { actor: 'user', ...PERIOD }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    const snapshots = body['accountSnapshots'] as Array<Record<string, unknown>>;
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot['verificationStatus']).toBe('incomplete');
      expect(snapshot['expectedEndingBalance']).toBeNull();
      expect(snapshot['cashBalanceDelta']).toBeNull();
    }
  });

  it('computes the second identity for an account whose boundaries are evidenced', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: savings(),
      amount: paise(1_000_00n),
      direction: 'debit',
      occurredAt: new Date('2026-07-10T12:00:00Z'),
      rawDescription: 'UPI-GROCERIES',
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    const expenseId = await addExpense(database.db, {
      description: 'Groceries',
      amount: paise(1_000_00n),
      occurredAt: new Date('2026-07-10T12:00:00Z'),
      relationshipType: 'personal',
      paidByPersonId: cast.userPersonId,
      state: 'approved',
    });
    await linkPaymentToExpense(database.db, { paymentId, expenseId, amount: paise(1_000_00n) });

    const evidenceId = await statementEvidence();
    const response = await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        ...PERIOD,
        accountBoundaries: [
          {
            accountId: savings(),
            openingBalance: '5000000',
            openingBalanceEvidenceId: evidenceId,
            closingBalance: '4900000',
            closingBalanceEvidenceId: evidenceId,
          },
        ],
      }),
    );
    const body = await json(response);
    expect(response.status).toBe(201);

    const snapshots = body['accountSnapshots'] as Array<Record<string, unknown>>;
    const savingsSnapshot = snapshots.find((snapshot) => snapshot['accountId'] === savings())!;
    expect(savingsSnapshot['totalDebits']).toBe('100000');
    expect(savingsSnapshot['expectedEndingBalance']).toBe('4900000');
    expect(savingsSnapshot['cashBalanceDelta']).toBe('0');

    // Every other account still has no boundary evidence, and says so rather than closing at
    // a cosmetic zero.
    for (const snapshot of snapshots.filter((entry) => entry['accountId'] !== savings())) {
      expect(snapshot['verificationStatus']).toBe('incomplete');
    }
  });

  it('accepts a negative (overdrawn) statement balance rather than clamping it', async () => {
    const evidenceId = await statementEvidence();
    const response = await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        ...PERIOD,
        accountBoundaries: [
          {
            accountId: savings(),
            openingBalance: '-250000',
            openingBalanceEvidenceId: evidenceId,
            closingBalance: '-250000',
            closingBalanceEvidenceId: evidenceId,
          },
        ],
      }),
    );
    const body = await json(response);
    expect(response.status).toBe(201);

    const snapshots = body['accountSnapshots'] as Array<Record<string, unknown>>;
    const savingsSnapshot = snapshots.find((snapshot) => snapshot['accountId'] === savings())!;
    expect(savingsSnapshot['openingBalance']).toBe('-250000');
    expect(savingsSnapshot['expectedEndingBalance']).toBe('-250000');
  });

  it('refuses a balance that does not cite its statement evidence', async () => {
    const response = await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        ...PERIOD,
        accountBoundaries: [{ accountId: savings(), closingBalance: '4900000' }],
      }),
    );
    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({
      field: 'accountBoundaries[0].closingBalance',
    });
  });

  it('refuses an empty array, which is a claim rather than an absence', async () => {
    const response = await api.handle(
      post('/api/reconciliation/runs', { actor: 'user', ...PERIOD, accountBoundaries: [] }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses two boundary entries for the same account', async () => {
    const evidenceId = await statementEvidence();
    const response = await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        ...PERIOD,
        accountBoundaries: [
          {
            accountId: savings(),
            openingBalance: '100',
            openingBalanceEvidenceId: evidenceId,
          },
          {
            accountId: savings(),
            openingBalance: '200',
            openingBalanceEvidenceId: evidenceId,
          },
        ],
      }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a balance sent as a JSON number, which cannot carry paise exactly', async () => {
    const evidenceId = await statementEvidence();
    const response = await api.handle(
      post('/api/reconciliation/runs', {
        actor: 'user',
        ...PERIOD,
        accountBoundaries: [
          { accountId: savings(), openingBalance: 4900000, openingBalanceEvidenceId: evidenceId },
        ],
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/reconciliation/runs/:id/account-snapshots', () => {
  it('returns the stored snapshots, identical to what the run reported', async () => {
    const evidenceId = await statementEvidence();
    const run = await json(
      await api.handle(
        post('/api/reconciliation/runs', {
          actor: 'user',
          ...PERIOD,
          accountBoundaries: [
            {
              accountId: savings(),
              openingBalance: '5000000',
              openingBalanceEvidenceId: evidenceId,
              closingBalance: '5000000',
              closingBalanceEvidenceId: evidenceId,
            },
          ],
        }),
      ),
    );
    const runId = run['reconciliationRunId'] as string;

    const response = await api.handle(get(`/api/reconciliation/runs/${runId}/account-snapshots`));
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body['reconciliationRunId']).toBe(runId);

    const stored = body['snapshots'] as Array<Record<string, unknown>>;
    const reported = run['accountSnapshots'] as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(reported.length);

    for (const snapshot of reported) {
      const match = stored.find((entry) => entry['accountId'] === snapshot['accountId'])!;
      // The identity, term by term — a read cannot restate a figure the run computed.
      for (const field of [
        'totalDebits',
        'totalCredits',
        'internalTransferDebits',
        'internalTransferCredits',
        'explainedDebits',
        'unexplainedDebits',
        'explainedCredits',
        'unexplainedCredits',
        'openingBalance',
        'closingBalance',
        'expectedEndingBalance',
        'cashBalanceDelta',
        'verificationStatus',
      ]) {
        expect(match[field]).toEqual(snapshot[field]);
      }
      expect(match['reconciliationRunId']).toBe(runId);
    }
  });

  it('404s a run that does not exist rather than returning an empty list', async () => {
    const response = await api.handle(
      get('/api/reconciliation/runs/00000000-0000-4000-8000-000000000000/account-snapshots'),
    );
    expect(response.status).toBe(404);
  });
});
