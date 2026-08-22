import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import type { ExpenseId, PaymentId } from '../../src/domain/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore, syntheticDocument } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const BASE = 'http://localhost';
const CAPTURED_AT = '2026-07-12T20:14:00.000Z';

let database: TestDatabase;
let store: MemoryEvidenceStore;
let api: Api;
let cast: Cast;
let paymentId: PaymentId;
let expenseId: ExpenseId;

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
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: store,
  });
  paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(284_000n),
    direction: 'debit',
    occurredAt: new Date(CAPTURED_AT),
    rawDescription: 'UPI-SAMPLE RESTAURANT',
    channel: 'upi',
  });
  expenseId = await addExpense(database.db, {
    description: 'Dinner',
    amount: paise(284_000n),
    occurredAt: new Date(CAPTURED_AT),
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
  });
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function upload(
  fields: Record<string, string> = {},
  file: { bytes?: Uint8Array; mediaType?: string; name?: string } = {},
): Request {
  const form = new FormData();
  form.set(
    'file',
    new Blob([file.bytes ?? syntheticDocument('restaurant-bill')], {
      type: file.mediaType ?? 'image/jpeg',
    }),
    file.name ?? 'bill.jpg',
  );
  form.set('type', 'receipt_image');
  form.set('capturedAt', CAPTURED_AT);
  form.set('actor', 'user');
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request(`${BASE}/api/evidence/files`, { method: 'POST', body: form });
}

async function ingestOne(fields: Record<string, string> = {}): Promise<string> {
  const response = await api.handle(upload(fields));
  const body = await json(response);
  return body['evidenceId'] as string;
}

describe('POST /api/evidence/files', () => {
  it('stores an uploaded document and reports where it went', async () => {
    const response = await api.handle(upload());
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ outcome: 'ingested', mediaType: 'image/jpeg' });
    expect(body['storageRef']).toMatch(/^sha256\/[0-9a-f]{64}\.jpg$/);
    expect(store.size()).toBe(1);
  });

  it('answers a repeated upload with 200 and the row that already holds it', async () => {
    const first = await json(await api.handle(upload()));
    const response = await api.handle(upload());
    const body = await json(response);

    // 201 would tell a retrying client it had just created a second document.
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ outcome: 'already_ingested', evidenceId: first['evidenceId'] });
  });

  it('attaches the document when the caller already knows where it belongs', async () => {
    const evidenceId = await ingestOne({ linkedPaymentId: paymentId, linkedExpenseId: expenseId });

    const body = await json(await api.handle(new Request(`${BASE}/api/evidence/${evidenceId}`)));
    expect(body).toMatchObject({ linkedPaymentId: paymentId, linkedExpenseId: expenseId });
  });

  it('refuses a format this system does not store', async () => {
    const response = await api.handle(
      upload({}, { mediaType: 'application/octet-stream', name: 'thing.bin' }),
    );

    expect(response.status).toBe(422);
    expect((await json(response))['error']).toMatchObject({
      code: 'EVIDENCE_MEDIA_TYPE_UNSUPPORTED',
    });
    expect(store.size()).toBe(0);
  });

  it('refuses an upload with no file part', async () => {
    const form = new FormData();
    form.set('type', 'receipt_image');
    form.set('capturedAt', CAPTURED_AT);
    form.set('actor', 'user');

    const response = await api.handle(
      new Request(`${BASE}/api/evidence/files`, { method: 'POST', body: form }),
    );

    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({ field: 'file' });
  });

  it('refuses an ingestion nobody can be held to', async () => {
    // No session yet, so the actor is asserted by the caller — but an upload over HTTP is a
    // person's act, and `system` is an answer nobody can check (ADR-0032).
    const response = await api.handle(upload({ actor: 'system' }));

    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({ field: 'actor' });
  });

  it('refuses a manual_note on the file route, which has no file to store', async () => {
    const response = await api.handle(upload({ type: 'manual_note' }));

    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({ field: 'type' });
  });

  it('refuses a capture time it cannot read', async () => {
    const response = await api.handle(upload({ capturedAt: 'last tuesday' }));

    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({ field: 'capturedAt' });
  });
});

describe('POST /api/evidence/notes', () => {
  function note(body: Record<string, unknown> = {}): Request {
    return new Request(`${BASE}/api/evidence/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'user',
        text: 'Flatmate A paid the electrician, split three ways',
        noteKind: 'documentation',
        capturedAt: CAPTURED_AT,
        linkedExpenseId: expenseId,
        ...body,
      }),
    });
  }

  it('records a typed note', async () => {
    const response = await api.handle(note());
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['evidenceId']).toEqual(expect.any(String));
    expect(store.size()).toBe(0);
  });

  it('requires the note to say which kind it is (ADR-0018)', async () => {
    const response = await api.handle(note({ noteKind: undefined }));

    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({ field: 'noteKind' });
  });

  it('refuses a kind it does not recognise rather than defaulting one', async () => {
    const response = await api.handle(note({ noteKind: 'probably_settled' }));

    expect(response.status).toBe(400);
  });

  it('reports an expense that does not exist as not found', async () => {
    const response = await api.handle(
      note({ linkedExpenseId: '00000000-0000-4000-8000-000000000000' }),
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /api/evidence/:evidenceId/link', () => {
  function link(evidenceId: string, body: Record<string, unknown>): Request {
    return new Request(`${BASE}/api/evidence/${evidenceId}/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'user', ...body }),
    });
  }

  it('attaches a document that arrived with no home', async () => {
    const evidenceId = await ingestOne();

    const response = await api.handle(link(evidenceId, { linkedPaymentId: paymentId }));

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ linkedPaymentId: paymentId });
  });

  it('refuses to re-point a link that is already recorded', async () => {
    const evidenceId = await ingestOne();
    await api.handle(link(evidenceId, { linkedPaymentId: paymentId }));

    const other = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(12_000n),
      direction: 'debit',
      occurredAt: new Date(CAPTURED_AT),
      rawDescription: 'UPI-SOMEWHERE ELSE',
      channel: 'upi',
    });
    const response = await api.handle(link(evidenceId, { linkedPaymentId: other }));

    expect(response.status).toBe(422);
    expect((await json(response))['error']).toMatchObject({ code: 'EVIDENCE_LINK_IMMUTABLE' });
  });

  it('refuses a link request that names neither side', async () => {
    const evidenceId = await ingestOne();

    const response = await api.handle(link(evidenceId, {}));

    expect(response.status).toBe(400);
  });

  it('refuses an id that is not a UUID before anything reaches the database', async () => {
    const response = await api.handle(link('not-an-id', { linkedPaymentId: paymentId }));

    expect(response.status).toBe(400);
    expect((await json(response))['error']).toMatchObject({ field: 'evidenceId' });
  });
});

describe('reading a document back', () => {
  it('returns the metadata the ledger holds', async () => {
    const evidenceId = await ingestOne();

    const response = await api.handle(new Request(`${BASE}/api/evidence/${evidenceId}`));

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      id: evidenceId,
      type: 'receipt_image',
      mediaType: 'image/jpeg',
    });
  });

  it('returns the document itself, typed and unsniffable', async () => {
    const evidenceId = await ingestOne();

    const response = await api.handle(new Request(`${BASE}/api/evidence/${evidenceId}/content`));
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...bytes]).toEqual([...syntheticDocument('restaurant-bill')]);
  });

  it('reports a document the store no longer holds', async () => {
    const evidenceId = await ingestOne();
    store.clear();

    const response = await api.handle(new Request(`${BASE}/api/evidence/${evidenceId}/content`));

    expect(response.status).toBe(404);
  });

  it('reports an unknown id as not found', async () => {
    const response = await api.handle(
      new Request(`${BASE}/api/evidence/00000000-0000-4000-8000-000000000000`),
    );

    expect(response.status).toBe(404);
  });

  it('has no content to return for a note', async () => {
    const created = await json(
      await api.handle(
        new Request(`${BASE}/api/evidence/notes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actor: 'user',
            text: 'no document, just words',
            noteKind: 'documentation',
            capturedAt: CAPTURED_AT,
          }),
        }),
      ),
    );

    const response = await api.handle(
      new Request(`${BASE}/api/evidence/${created['evidenceId'] as string}/content`),
    );

    expect(response.status).toBe(404);
  });
});

describe('routing', () => {
  it('does not let the id route capture the literal paths', async () => {
    // `/api/evidence/files` and `/api/evidence/:evidenceId` are the same shape; the table is
    // ordered so the literal wins, and a GET of it is a 405 rather than a 400 about a UUID.
    const response = await api.handle(new Request(`${BASE}/api/evidence/files`));

    expect(response.status).toBe(405);
  });

  it('still serves the review surface from the same table', async () => {
    const response = await api.handle(new Request(`${BASE}/api/review`));

    expect(response.status).toBe(200);
  });
});
