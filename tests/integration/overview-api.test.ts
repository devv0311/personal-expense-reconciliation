/**
 * `GET /api/overview` — the one read the front page makes.
 *
 * What is worth testing here is not that it returns numbers. It is that it returns the *same*
 * numbers the specialist reads return, and that it refuses to state one it cannot stand behind.
 * A summary screen is where a confident, wrong figure does the most damage: it is the number
 * somebody glances at and stops thinking about.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import { paise } from '../../src/domain/index.js';
import type { Api } from '../../src/api/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

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

interface OverviewBody {
  spending: { period: { start: string; end: string }; total: { known: boolean; amount: string } };
  unexplained: {
    total: { known: boolean; amount: string; unknownReason?: string };
    movementCount: number;
    scanned: number;
    complete: boolean;
  };
  attention: { total: number; reviewQueueTotal: number; counts: Record<string, number> };
  people: { toCollect: { amount: string }; toPay: { amount: string }; counterparties: unknown[] };
  recent: { paymentId: string; status: string; direction: string }[];
  empty: boolean;
}

async function overview(query = ''): Promise<OverviewBody> {
  const response = await api.handle(new Request(`${BASE}/api/overview${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as OverviewBody;
}

describe('GET /api/overview', () => {
  it('says the ledger is empty rather than reporting zeroes about nothing', async () => {
    const body = await overview();
    expect(body.empty).toBe(true);
    expect(body.recent).toHaveLength(0);
    expect(body.unexplained.movementCount).toBe(0);
  });

  it('chooses a period when the caller does not, and names the one it used', async () => {
    const body = await overview();
    // The screen has to be able to say which period the figure covers rather than implying
    // the total is all-time.
    expect(Date.parse(body.spending.period.start)).toBeLessThan(
      Date.parse(body.spending.period.end),
    );
    expect(body.spending.total.known).toBe(true);
  });

  it('honours an explicit period, and refuses a backwards one', async () => {
    const body = await overview('?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z');
    expect(body.spending.period.start).toBe('2026-07-01T00:00:00.000Z');

    const backwards = await api.handle(
      new Request(`${BASE}/api/overview?from=2026-08-01T00:00:00.000Z&to=2026-07-01T00:00:00.000Z`),
    );
    expect(backwards.status).toBe(400);
  });

  it('counts money the ledger cannot yet account for, and how many movements carry it', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-SAMPLE MERCHANT',
      channel: 'upi',
    });
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(45000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-03T10:00:00.000Z'),
      rawDescription: 'UPI-ANOTHER MERCHANT',
      channel: 'upi',
    });

    const body = await overview();
    expect(body.empty).toBe(false);
    expect(body.unexplained.total.known).toBe(true);
    expect(body.unexplained.total.amount).toBe('169000');
    expect(body.unexplained.movementCount).toBe(2);
    expect(body.unexplained.complete).toBe(true);
  });

  it('never reports a confirmed duplicate as money gone missing', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-SAMPLE MERCHANT',
      channel: 'upi',
      state: 'ignored',
      ignoredReason: 'duplicate_of:some-other-payment',
    });

    const body = await overview();
    // The money was counted once already. Reporting it again would invent a hole.
    expect(body.unexplained.total.amount).toBe('0');
    expect(body.unexplained.movementCount).toBe(0);
  });

  it('reports a floor rather than a total when the ledger is larger than one pass', async () => {
    for (let index = 0; index < 3; index += 1) {
      await addPayment(database.db, cast, {
        accountId: cast.account['account_hdfc_savings']!,
        amount: paise(10000n),
        direction: 'debit',
        occurredAt: new Date('2026-07-02T10:00:00.000Z'),
        rawDescription: `UPI-MERCHANT-${index}`,
        channel: 'upi',
      });
    }

    const { getOverview } = await import('../../src/services/index.js');
    const result = await getOverview(database.db, {
      userPersonId: cast.userPersonId,
      period: { start: new Date('2026-07-01'), end: new Date('2026-08-01') },
      unexplainedScanLimit: 2,
    });

    expect(result.unexplained.complete).toBe(false);
    expect(result.unexplained.total.known).toBe(false);
    expect(result.unexplained.total.unknownReason).toContain('at least');
    expect(result.unexplained.scanned).toBe(2);
  });

  it('marks a movement nothing accounts for as needing context, in plain words', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-SAMPLE MERCHANT',
      channel: 'upi',
    });

    const body = await overview();
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0]?.status).toBe('needs_context');
    expect(body.recent[0]?.direction).toBe('debit');
  });

  it('agrees with the specialist reads rather than computing its own answer', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T10:00:00.000Z'),
      rawDescription: 'UPI-SAMPLE MERCHANT',
      channel: 'upi',
    });

    const period = '?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z';
    const summary = await overview(period);
    const spending = (await (
      await api.handle(new Request(`${BASE}/api/analytics/spending${period}`))
    ).json()) as { netTotal: string };
    const outstanding = (await (
      await api.handle(new Request(`${BASE}/api/analytics/outstanding`))
    ).json()) as { totalOwedToUser: string; totalOwedByUser: string };
    const queue = (await (await api.handle(new Request(`${BASE}/api/review?limit=1`))).json()) as {
      total: number;
    };
    const attention = (await (
      await api.handle(new Request(`${BASE}/api/attention?limit=1`))
    ).json()) as { total: number };

    expect(summary.spending.total.amount).toBe(spending.netTotal);
    expect(summary.people.toCollect.amount).toBe(outstanding.totalOwedToUser);
    expect(summary.people.toPay.amount).toBe(outstanding.totalOwedByUser);
    // The front page counts what **Needs attention** shows, and still reports the review
    // queue's own subset beside it, so neither screen can quote a number the other denies.
    expect(summary.attention.total).toBe(attention.total);
    expect(summary.attention.reviewQueueTotal).toBe(queue.total);
  });
});
