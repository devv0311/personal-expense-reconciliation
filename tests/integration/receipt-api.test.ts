import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { ingestEvidenceDocument } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore, syntheticDocument } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { scriptedReceiptExtractionTransport } from '../support/ai.js';

const BASE = 'http://localhost';
const BLINKIT_CAPTURED_AT = new Date('2026-07-01T19:25:00.000Z');

let database: TestDatabase;
let store: MemoryEvidenceStore;
let api: Api;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  store = createMemoryEvidenceStore();
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedReceiptExtractionTransport()),
    evidenceStore: store,
    splitwise: createMockSplitwisePort(),
  });
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function ingestEvidence(
  overrides: Partial<Parameters<typeof ingestEvidenceDocument>[1]> = {},
): Promise<string> {
  const result = await ingestEvidenceDocument(database.db, {
    type: 'receipt_image',
    bytes: syntheticDocument('blinkit-order'),
    mediaType: 'image/jpeg',
    capturedAt: BLINKIT_CAPTURED_AT,
    store,
    audit: { actor: 'user', source: 'test setup' },
    ...overrides,
  });
  return result.evidenceId;
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/evidence/:evidenceId/receipt', () => {
  it('extracts a Receipt and returns it', async () => {
    const evidenceId = await ingestEvidence();

    const response = await api.handle(
      post(`/api/evidence/${evidenceId}/receipt`, { actor: 'user' }),
    );
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['receipt']).toMatchObject({ evidenceId, total: '124000', confirmedByUser: false });
    expect(body['items']).toHaveLength(5);
  });

  it('reports a rejected extraction as a 422, naming the code', async () => {
    const evidenceId = await ingestEvidence({ capturedAt: new Date('2026-07-20T12:00:00.000Z') });

    const response = await api.handle(
      post(`/api/evidence/${evidenceId}/receipt`, { actor: 'user' }),
    );
    const body = await json(response);

    expect(response.status).toBe(422);
    expect(body['error']).toMatchObject({ code: 'RECEIPT_DRAFT_INVALID' });
  });

  it('404s an evidence id that does not exist', async () => {
    const response = await api.handle(
      post('/api/evidence/00000000-0000-4000-8000-000000000000/receipt', { actor: 'user' }),
    );
    expect(response.status).toBe(404);
  });

  it('409s a document that is not receipt-eligible', async () => {
    const evidenceId = await ingestEvidence({ type: 'bank_line' });

    const response = await api.handle(
      post(`/api/evidence/${evidenceId}/receipt`, { actor: 'user' }),
    );
    expect(response.status).toBe(409);
  });

  it('refuses an actor that is not a person', async () => {
    const evidenceId = await ingestEvidence();

    const response = await api.handle(
      post(`/api/evidence/${evidenceId}/receipt`, { actor: 'system' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/receipts/:receiptId/confirm', () => {
  async function extractOne(): Promise<string> {
    const evidenceId = await ingestEvidence();
    const body = await json(
      await api.handle(post(`/api/evidence/${evidenceId}/receipt`, { actor: 'user' })),
    );
    return (body['receipt'] as Record<string, unknown>)['id'] as string;
  }

  it('confirms it and returns confirmed_by_user true', async () => {
    const receiptId = await extractOne();

    const response = await api.handle(
      post(`/api/receipts/${receiptId}/confirm`, { actor: 'user' }),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['receipt']).toMatchObject({ confirmedByUser: true });
  });
});

describe('POST /api/receipts/:receiptId/correct', () => {
  async function extractOne(): Promise<string> {
    const evidenceId = await ingestEvidence();
    const body = await json(
      await api.handle(post(`/api/evidence/${evidenceId}/receipt`, { actor: 'user' })),
    );
    return (body['receipt'] as Record<string, unknown>)['id'] as string;
  }

  it('overwrites a money field as an exact minor-units string', async () => {
    const receiptId = await extractOne();

    const response = await api.handle(
      post(`/api/receipts/${receiptId}/correct`, { actor: 'user', total: '125000' }),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['receipt']).toMatchObject({ total: '125000', confirmedByUser: true });
  });

  it('clears a money field with an explicit null, distinct from omitting it', async () => {
    const receiptId = await extractOne();

    const response = await api.handle(
      post(`/api/receipts/${receiptId}/correct`, { actor: 'user', tax: null }),
    );
    const body = await json(response);

    expect((body['receipt'] as Record<string, unknown>)['tax']).toBeNull();
    // total was not mentioned, and stays what extraction produced.
    expect((body['receipt'] as Record<string, unknown>)['total']).toBe('124000');
  });

  it('replaces the item set', async () => {
    const receiptId = await extractOne();

    const response = await api.handle(
      post(`/api/receipts/${receiptId}/correct`, {
        actor: 'user',
        items: [
          {
            description: 'One corrected item',
            quantity: '1',
            unitPrice: null,
            lineTotal: '124000',
            suggestedCategory: null,
          },
        ],
      }),
    );
    const body = await json(response);

    expect(body['items']).toEqual([
      expect.objectContaining({ description: 'One corrected item', lineTotal: '124000' }),
    ]);
  });

  it('refuses a malformed money field rather than guessing', async () => {
    const receiptId = await extractOne();

    const response = await api.handle(
      post(`/api/receipts/${receiptId}/correct`, { actor: 'user', total: '124000.00' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/receipts/:receiptId', () => {
  it('reads the Receipt, its items, and the surfaced discrepancies', async () => {
    const evidenceId = await ingestEvidence();
    const extracted = await json(
      await api.handle(post(`/api/evidence/${evidenceId}/receipt`, { actor: 'user' })),
    );
    const receiptId = (extracted['receipt'] as Record<string, unknown>)['id'] as string;

    const response = await api.handle(new Request(`${BASE}/api/receipts/${receiptId}`));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body['receipt']).toMatchObject({ id: receiptId });
    expect(body['items']).toHaveLength(5);
  });

  it('404s a receipt id that does not exist', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/receipts/00000000-0000-4000-8000-000000000000`),
    );
    expect(response.status).toBe(404);
  });
});
