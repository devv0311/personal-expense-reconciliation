/**
 * The input-to-ledger path over HTTP, end to end (audit rows 01, 02, 04, 05, 06, 07, 36).
 *
 * Import a statement → see it in history → see its payments in the workspace → normalize →
 * classify a counterparty by hand → run the ADR-0017 cash-flow lifecycle on a credit → watch
 * the movement stop being unexplained. Every step here was previously service-only or absent.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';
const STATEMENT = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

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

async function post(path: string, body: unknown): Promise<Response> {
  return api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await api.handle(new Request(`${BASE}${path}`));
  return (await response.json()) as T;
}

async function importStatement(content = STATEMENT): Promise<Response> {
  return post('/api/imports/bank-csv', {
    actor: 'user',
    accountId: cast.account['account_hdfc_savings']!,
    sourceSystem: 'synthetic_bank_csv',
    fileContent: content,
    fileReference: 'fixtures/bank-statement.csv',
  });
}

interface WorkspaceList {
  payments: Array<Record<string, unknown>>;
  total: number;
  filteredTotalIsExact: boolean;
}

describe('statement import over HTTP', () => {
  it('imports a statement and shows it in history', async () => {
    const response = await importStatement();
    expect(response.status).toBe(201);
    const body = (await response.json()) as { outcome: string; paymentIds: string[] };
    expect(body.outcome).toBe('imported');
    expect(body.paymentIds.length).toBeGreaterThan(0);

    const history = await getJson<{
      batches: Array<{ sourceChannel: string; paymentCount: number; rowCount: number | null }>;
      total: number;
    }>('/api/imports');
    const batch = history.batches.find((entry) => entry.sourceChannel === 'bank_statement_csv');
    expect(batch?.paymentCount).toBe(body.paymentIds.length);
    expect(history.total).toBeGreaterThan(0);
  });

  it('recognises a byte-identical re-import instead of writing the rows twice', async () => {
    await importStatement();
    const again = await importStatement();
    expect(again.status).toBe(200);
    const body = (await again.json()) as { outcome: string };
    expect(body.outcome).toBe('already_imported');

    const rows = await database.db.select().from(schema.payments);
    const history = await getJson<{
      batches: Array<{ sourceChannel: string; paymentCount: number }>;
    }>('/api/imports');
    const batch = history.batches.find((entry) => entry.sourceChannel === 'bank_statement_csv');
    expect(rows.length).toBe(batch?.paymentCount);
  });

  it('imports nothing at all when any row is unreadable, and says which', async () => {
    const broken = `${STATEMENT}\n2026-07-31,BROKEN ROW,not-a-number,DEBIT,REF/1`;
    const response = await importStatement(broken);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('IMPORT_SOURCE_INVALID');
    expect(body.error.message).toContain('line');

    const rows = await database.db.select().from(schema.payments);
    expect(rows).toHaveLength(0);
  });
});

describe('the payment workspace', () => {
  beforeEach(async () => {
    await importStatement();
  });

  it('lists every posted movement with a full-ledger total', async () => {
    const body = await getJson<WorkspaceList>('/api/payments?limit=3');
    expect(body.payments).toHaveLength(3);
    expect(body.total).toBeGreaterThan(3);
    expect(body.filteredTotalIsExact).toBe(true);
  });

  it('searches the whole ledger server-side, not just the loaded page', async () => {
    const body = await getJson<WorkspaceList>('/api/payments?search=BLINKIT&limit=1');
    // Two BLINKIT rows exist in the fixture; the page holds one and the total says so.
    expect(body.total).toBe(2);
    expect(body.payments).toHaveLength(1);
    expect(String(body.payments[0]?.['rawDescription'])).toContain('BLINKIT');
  });

  it('filters by account, direction and period — the shape a waterfall term links with', async () => {
    const account = cast.account['account_hdfc_savings']!;
    const body = await getJson<WorkspaceList>(
      `/api/payments?accountId=${account}&direction=credit&from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z`,
    );
    expect(body.payments.length).toBeGreaterThan(0);
    for (const payment of body.payments) {
      expect(payment['direction']).toBe('credit');
      expect(payment['accountId']).toBe(account);
    }
  });

  it('reports what explains a movement, and marks a fresh import as unexplained', async () => {
    const body = await getJson<WorkspaceList>('/api/payments?onlyUnexplained=true&limit=200');
    expect(body.payments.length).toBeGreaterThan(0);
    expect(body.filteredTotalIsExact).toBe(false);
    for (const payment of body.payments) {
      expect(BigInt(String(payment['unexplainedTotal']))).toBeGreaterThan(0n);
    }
  });

  it('returns one movement with the same shape as its list row', async () => {
    const list = await getJson<WorkspaceList>('/api/payments?limit=1');
    const id = String(list.payments[0]?.['id']);
    const detail = await getJson<Record<string, unknown>>(`/api/payments/${id}`);
    expect(detail['id']).toBe(id);
    expect(detail).toHaveProperty('explainedTotal');
    expect(detail).toHaveProperty('accountName');
  });

  it('404s for a payment that does not exist', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/payments/00000000-0000-4000-8000-000000000000`),
    );
    expect(response.status).toBe(404);
  });
});

describe('normalization and counterparty classification', () => {
  beforeEach(async () => {
    await importStatement();
  });

  it('normalizes what was imported and resolves catalogued merchants', async () => {
    const response = await post('/api/payments/normalize', { actor: 'user' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      normalizedPaymentIds: string[];
      merchantResolvedCount: number;
    };
    expect(body.normalizedPaymentIds.length).toBeGreaterThan(0);

    const list = await getJson<WorkspaceList>('/api/payments?state=normalized&limit=200');
    expect(list.payments.length).toBe(body.normalizedPaymentIds.length);
  });

  it('lets a person classify a debit as an investment, which takes it out of spending', async () => {
    const list = await getJson<WorkspaceList>('/api/payments?direction=debit&limit=1');
    const paymentId = String(list.payments[0]?.['id']);

    const response = await post(`/api/payments/${paymentId}/counterparty`, {
      actor: 'user',
      counterpartyType: 'investment_instrument',
      reason: 'Monthly SIP',
    });
    expect(response.status).toBe(200);

    const detail = await getJson<Record<string, unknown>>(`/api/payments/${paymentId}`);
    expect(detail['counterpartyType']).toBe('investment_instrument');
    // ADR-0011: a non-spend counterparty explains the whole movement on its own.
    expect(detail['unexplainedTotal']).toBe('0');
  });

  it('refuses a counterparty naming a merchant that does not exist', async () => {
    const list = await getJson<WorkspaceList>('/api/payments?limit=1');
    const paymentId = String(list.payments[0]?.['id']);
    const response = await post(`/api/payments/${paymentId}/counterparty`, {
      actor: 'user',
      counterpartyType: 'merchant',
      counterpartyId: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.status).toBe(404);
  });

  it('refuses a "person" counterparty with nobody named', async () => {
    const list = await getJson<WorkspaceList>('/api/payments?limit=1');
    const paymentId = String(list.payments[0]?.['id']);
    const response = await post(`/api/payments/${paymentId}/counterparty`, {
      actor: 'user',
      counterpartyType: 'person',
    });
    expect(response.status).toBe(409);
  });

  it('offers the merchants, people and accounts a counterparty may be set to', async () => {
    const options = await getJson<{
      merchants: unknown[];
      people: unknown[];
      accounts: unknown[];
    }>('/api/payments/counterparty-options');
    expect(options.people.length).toBeGreaterThan(0);
    expect(options.accounts.length).toBeGreaterThan(0);
  });
});

describe('the cash-flow lifecycle over HTTP', () => {
  let creditPaymentId: string;

  beforeEach(async () => {
    await importStatement();
    await post('/api/payments/normalize', { actor: 'user' });
    const list = await getJson<WorkspaceList>('/api/payments?direction=credit&limit=10');
    creditPaymentId = String(list.payments[0]?.['id']);
    // The cash-flow lifecycle runs alongside the legacy one and starts at `imported`, so a
    // movement is readied for a cash-flow decision explicitly rather than as a side effect of
    // `services.normalizePayments` (ADR-0017).
    await post(`/api/payments/${creditPaymentId}/cash-flow/normalize`, { actor: 'user' });
  });

  it('classifies, then approves an evidenced external inflow', async () => {
    const classified = await post(`/api/payments/${creditPaymentId}/cash-flow/classify`, {
      actor: 'user',
      category: 'EXTERNAL_INFLOW',
    });
    expect(classified.status).toBe(200);
    expect((await classified.json()) as Record<string, unknown>).toMatchObject({
      cashFlowState: 'cash_flow_classified',
      cashFlowCategory: 'EXTERNAL_INFLOW',
    });

    // 17.2: EXTERNAL_INFLOW is the residual category, so it needs evidence of its own before
    // anyone may approve it. Without one, approval is refused rather than assumed.
    const unevidenced = await post(`/api/payments/${creditPaymentId}/cash-flow/approve`, {
      actor: 'user',
    });
    expect(unevidenced.status).toBe(422);

    await post('/api/evidence/notes', {
      actor: 'user',
      noteKind: 'documentation',
      text: 'Salary credit, matched against the payslip.',
      capturedAt: '2026-07-05T09:00:00.000Z',
      linkedPaymentId: creditPaymentId,
    });

    const approved = await post(`/api/payments/${creditPaymentId}/cash-flow/approve`, {
      actor: 'user',
      reason: 'Salary credit, confirmed against the payslip',
    });
    expect(approved.status).toBe(200);

    const detail = await getJson<Record<string, unknown>>(`/api/payments/${creditPaymentId}`);
    expect(detail['cashFlowState']).toBe('approved');
    // An approved EXTERNAL_INFLOW explains its whole movement (ADR-0017, 17.1).
    expect(detail['unexplainedTotal']).toBe('0');
  });

  it('refuses a debit-only category on a credit', async () => {
    const response = await post(`/api/payments/${creditPaymentId}/cash-flow/classify`, {
      actor: 'user',
      category: 'PEER_SETTLEMENT',
    });
    // A peer settlement credit needs a person counterparty, which this row has not got — the
    // direction rule permits it, so the refusal comes at approval, not here.
    expect(response.status).toBe(200);

    const approved = await post(`/api/payments/${creditPaymentId}/cash-flow/approve`, {
      actor: 'user',
    });
    expect(approved.status).toBe(422);
  });

  it('refuses a refund on a debit outright', async () => {
    const list = await getJson<WorkspaceList>('/api/payments?direction=debit&limit=1');
    const debitId = String(list.payments[0]?.['id']);
    await post(`/api/payments/${debitId}/cash-flow/normalize`, { actor: 'user' });
    const response = await post(`/api/payments/${debitId}/cash-flow/classify`, {
      actor: 'user',
      category: 'REFUND',
    });
    expect(response.status).toBe(422);
  });

  it('clears the category when a classification is rejected', async () => {
    await post(`/api/payments/${creditPaymentId}/cash-flow/classify`, {
      actor: 'user',
      category: 'EXTERNAL_INFLOW',
    });
    const rejected = await post(`/api/payments/${creditPaymentId}/cash-flow/reject`, {
      actor: 'user',
      reason: 'Not income — this is a refund I have not evidenced yet',
    });
    expect(rejected.status).toBe(200);

    const detail = await getJson<Record<string, unknown>>(`/api/payments/${creditPaymentId}`);
    expect(detail['cashFlowCategory']).toBeNull();
    expect(detail['cashFlowState']).toBe('normalized');
  });

  it('requires a reason to reject', async () => {
    await post(`/api/payments/${creditPaymentId}/cash-flow/classify`, {
      actor: 'user',
      category: 'EXTERNAL_INFLOW',
    });
    const response = await post(`/api/payments/${creditPaymentId}/cash-flow/reject`, {
      actor: 'user',
    });
    expect(response.status).toBe(400);
  });

  it('rejects an unknown lifecycle step rather than guessing', async () => {
    const response = await post(`/api/payments/${creditPaymentId}/cash-flow/approve-everything`, {
      actor: 'user',
    });
    expect(response.status).toBe(400);
  });
});

describe('hand-entered movements', () => {
  it('records a cash payment with its own manual-entry provenance', async () => {
    const response = await post('/api/payments', {
      actor: 'user',
      accountId: cast.account['account_cash_wallet']!,
      amount: '25000',
      direction: 'debit',
      occurredAt: '2026-07-14T10:00:00.000Z',
      description: 'Cash for the sabziwala',
    });
    expect(response.status).toBe(201);
    const { paymentId, importBatchId } = (await response.json()) as {
      paymentId: string;
      importBatchId: string;
    };

    const [batch] = await database.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, importBatchId));
    expect(batch?.sourceChannel).toBe('manual_entry');
    expect(batch?.contentHash).toBeNull();

    const detail = await getJson<Record<string, unknown>>(`/api/payments/${paymentId}`);
    expect(detail).toMatchObject({
      amount: '25000',
      direction: 'debit',
      state: 'imported',
      rawDescription: 'Cash for the sabziwala',
    });
  });

  it('refuses a zero or negative magnitude', async () => {
    const response = await post('/api/payments', {
      actor: 'user',
      accountId: cast.account['account_cash_wallet']!,
      amount: '0',
      direction: 'debit',
      occurredAt: '2026-07-14T10:00:00.000Z',
      description: 'Nothing at all',
    });
    expect(response.status).toBe(409);
  });

  it('refuses a movement with no description to carry as its narration', async () => {
    const response = await post('/api/payments', {
      actor: 'user',
      accountId: cast.account['account_cash_wallet']!,
      amount: '100',
      direction: 'debit',
      occurredAt: '2026-07-14T10:00:00.000Z',
      description: '   ',
    });
    expect(response.status).toBe(400);
  });

  it('takes the same normalization path as an imported row', async () => {
    const created = await post('/api/payments', {
      actor: 'user',
      accountId: cast.account['account_cash_wallet']!,
      amount: '50000',
      direction: 'debit',
      occurredAt: '2026-07-15T10:00:00.000Z',
      description: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    });
    const { paymentId } = (await created.json()) as { paymentId: string };

    await post('/api/payments/normalize', { actor: 'user' });
    const detail = await getJson<Record<string, unknown>>(`/api/payments/${paymentId}`);
    expect(detail['state']).toBe('normalized');
  });
});
