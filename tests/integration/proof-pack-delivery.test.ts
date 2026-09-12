/**
 * Sending a reviewed proof pack, end to end over the HTTP surface (audit row 42, ADR-0053).
 *
 * What this file is actually protecting, in order of how badly each would go wrong:
 *
 *  1. **The message is derived server-side.** There is no body field to post, so a browser
 *    cannot send a figure it invented over the user's own WhatsApp account.
 *  2. **A resend of unchanged content sends nothing.** The unique index is the guarantee, and
 *    the test proves the transport was not called a second time rather than only that the
 *    response looked idempotent.
 *  3. **A refusal is recorded, not lost.** A failed send leaves a `failed` row carrying the
 *    provider's reason, and the row is retryable.
 *  4. **Sending records no settlement.** The ledger's balance is identical afterwards.
 *  5. **The attachment allowlist holds over HTTP**, not only in the domain unit tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { asId, paise } from '../../src/domain/index.js';
import type { EvidenceId, PersonId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import { approveAllocation, ingestEvidenceDocument } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { createMockMessageTransport } from '../support/message-transport.js';
import type { MockMessageTransport } from '../support/message-transport.js';
import { createMockSplitwisePort } from '../support/splitwise.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { AS_USER, addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const BASE = 'http://localhost';
const AS_OF = '2026-09-06T09:00:00.000Z';
const REVIEWED = {
  recipientConfirmed: true,
  contentConfirmed: true,
  evidenceConfirmed: true,
};

let database: TestDatabase;
let api: Api;
let cast: Cast;
let transport: MockMessageTransport;
let store: MemoryEvidenceStore;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  transport = createMockMessageTransport();
  store = createMemoryEvidenceStore();
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: store,
    splitwise: createMockSplitwisePort(),
    messageTransport: transport,
  });
});

function friendA(): PersonId {
  return cast.person['person_friend_a']!;
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

function sendBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: 'user',
    channel: 'whatsapp',
    address: '+919876543210',
    asOf: AS_OF,
    review: REVIEWED,
    ...overrides,
  };
}

async function seedSharedDinner(): Promise<string> {
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
  return expenseId;
}

/** A receipt document attached to the expense, so the pack actually cites it. */
async function attachReceipt(expenseId: string): Promise<EvidenceId> {
  const result = await ingestEvidenceDocument(database.db, {
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    mediaType: 'application/pdf',
    type: 'receipt_image',
    capturedAt: new Date('2026-07-01T10:05:00.000Z'),
    linkedExpenseId: asId<'expense'>(expenseId),
    store,
    audit: AS_USER,
  });
  return result.evidenceId;
}

describe('GET /api/messaging/status', () => {
  it('says what this installation can send, before anything is typed', async () => {
    const body = await json(await api.handle(new Request(`${BASE}/api/messaging/status`)));
    expect(body['configured']).toBe(true);
    expect(body['channel']).toBe('whatsapp');
    expect(body['attachableEvidenceTypes']).toEqual(['receipt_image', 'email_receipt']);
    expect(body['maxAttempts']).toBe(5);
  });
});

describe('POST /api/proof-packs/:recipientPersonId/deliveries', () => {
  it('sends the pack the server derived, not a body the caller supplied', async () => {
    await seedSharedDinner();

    const response = await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body['sentNow']).toBe(true);
    const delivery = body['delivery'] as Record<string, unknown>;
    expect(delivery['status']).toBe('sent');
    expect(delivery['providerMessageId']).toBe('wamid-1');
    expect(delivery['attemptCount']).toBe(1);
    expect(delivery['address']).toBe('+919876543210');

    expect(transport.sent).toHaveLength(1);
    // The figure that went out is the ledger's own, arrived at by the proof-pack read.
    expect(transport.sent[0]!.body).toContain('Friend A owes me ₹500.00');
    expect(transport.sent[0]!.body).toBe(delivery['bodyText']);
  });

  it('records no settlement and moves no balance', async () => {
    await seedSharedDinner();
    const before = await json(
      await api.handle(new Request(`${BASE}/api/balances/${cast.userPersonId}/${friendA()}`)),
    );

    await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));

    const after = await json(
      await api.handle(new Request(`${BASE}/api/balances/${cast.userPersonId}/${friendA()}`)),
    );
    expect(after['netBalance']).toBe(before['netBalance']);
    const settlements = await database.db.select().from(schema.settlements);
    expect(settlements).toHaveLength(0);
  });

  it('sends nothing a second time for identical content', async () => {
    await seedSharedDinner();

    const first = await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));
    const second = await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await json(second))['sentNow']).toBe(false);
    // The guarantee is that the transport was not reached, not merely that the response said so.
    expect(transport.sent).toHaveLength(1);

    const rows = await database.db.select().from(schema.proofPackDeliveries);
    expect(rows).toHaveLength(1);
  });

  it('sends again once the ledger has moved, because that is a different message', async () => {
    const expenseId = await seedSharedDinner();
    await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));

    // A second shared expense changes what the pack says, so it is genuinely a new thing to
    // have sent somebody — and a new idempotency key.
    await addExpense(database.db, {
      description: 'Cab home',
      amount: paise(40_000n),
      occurredAt: new Date('2026-07-01T14:00:00.000Z'),
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    const rows = await database.db.select().from(schema.expenses);
    const second = rows.find((row) => row.description === 'Cab home')!;
    await approveAllocation(database.db, {
      expenseId: asId<'expense'>(second.id),
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

    const response = await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));
    expect(response.status).toBe(201);
    expect(transport.sent).toHaveLength(2);
    expect(expenseId).toBeTruthy();
  });

  it('refuses a send whose review is incomplete, before anything is claimed', async () => {
    await seedSharedDinner();

    const response = await api.handle(
      post(
        `/api/proof-packs/${friendA()}/deliveries`,
        sendBody({ review: { ...REVIEWED, evidenceConfirmed: false } }),
      ),
    );

    expect(response.status).toBe(422);
    expect((await json(response))['error']).toMatchObject({
      code: 'PROOF_PACK_REVIEW_INCOMPLETE',
    });
    expect(transport.sent).toHaveLength(0);
    expect(await database.db.select().from(schema.proofPackDeliveries)).toHaveLength(0);
  });

  it('refuses an address that is not E.164 rather than guessing a country code', async () => {
    await seedSharedDinner();
    const response = await api.handle(
      post(`/api/proof-packs/${friendA()}/deliveries`, sendBody({ address: '9876543' })),
    );
    expect(response.status).toBe(422);
    expect((await json(response))['error']).toMatchObject({ code: 'PROOF_PACK_ADDRESS_INVALID' });
    expect(transport.sent).toHaveLength(0);
  });

  it('records a transport refusal as a failed, retryable delivery', async () => {
    await seedSharedDinner();
    transport.failNextSend('That number is not registered on WhatsApp.');

    const response = await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));
    expect(response.status).toBe(500);
    expect((await json(response))['error']).toMatchObject({ code: 'MESSAGE_DELIVERY_FAILED' });

    // The attempt survives as a record. A send that vanished would be indistinguishable from
    // one that quietly succeeded.
    const listed = await json(await api.handle(new Request(`${BASE}/api/deliveries`)));
    const deliveries = listed['deliveries'] as Record<string, unknown>[];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!['status']).toBe('failed');
    expect(deliveries[0]!['lastError']).toContain('not registered on WhatsApp');
    expect(deliveries[0]!['retryable']).toBe(true);
  });

  it('attaches a cited receipt and records what went with the message', async () => {
    const expenseId = await seedSharedDinner();
    const evidenceId = await attachReceipt(expenseId);

    const response = await api.handle(
      post(
        `/api/proof-packs/${friendA()}/deliveries`,
        sendBody({ attachEvidenceIds: [evidenceId] }),
      ),
    );
    expect(response.status).toBe(201);

    expect(transport.sent[0]!.attachments).toHaveLength(1);
    expect(transport.sent[0]!.attachments[0]!.mediaType).toBe('application/pdf');
    // The filename the recipient sees carries no merchant, no label, no context.
    expect(transport.sent[0]!.attachments[0]!.filename).toMatch(/^receipt-[0-9a-f]{8}\.pdf$/);

    const delivery = (await json(response))['delivery'] as Record<string, unknown>;
    expect(delivery['attachments']).toEqual([
      {
        evidenceId,
        filename: transport.sent[0]!.attachments[0]!.filename,
        mediaType: 'application/pdf',
        byteSize: 4,
      },
    ]);
  });

  it('refuses to attach a bank statement line, whatever the caller confirms', async () => {
    const expenseId = await seedSharedDinner();
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(100_000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-01T10:00:00.000Z'),
      rawDescription: 'UPI/PIER',
      channel: 'upi',
    });
    const bankLine = await ingestEvidenceDocument(database.db, {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      mediaType: 'application/pdf',
      type: 'bank_line',
      capturedAt: new Date('2026-07-01T10:05:00.000Z'),
      linkedPaymentId: paymentId,
      store,
      audit: AS_USER,
    });

    const response = await api.handle(
      post(
        `/api/proof-packs/${friendA()}/deliveries`,
        sendBody({ attachEvidenceIds: [bankLine.evidenceId] }),
      ),
    );

    expect(response.status).toBe(422);
    expect((await json(response))['error']).toMatchObject({
      code: 'PROOF_PACK_ATTACHMENT_REFUSED',
    });
    expect(transport.sent).toHaveLength(0);
    expect(expenseId).toBeTruthy();
  });

  it('refuses a send whose pack has changed since it was reviewed', async () => {
    await seedSharedDinner();
    const response = await api.handle(
      post(
        `/api/proof-packs/${friendA()}/deliveries`,
        sendBody({ contentDigestSeen: 'a'.repeat(64) }),
      ),
    );
    expect(response.status).toBe(409);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('POST /api/deliveries/:deliveryId/retry', () => {
  it('sends the recorded message again, not a freshly derived one', async () => {
    await seedSharedDinner();
    transport.failNextSend('Temporary provider outage.');
    await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));

    const [failed] = await database.db.select().from(schema.proofPackDeliveries);
    const response = await api.handle(
      post(`/api/deliveries/${failed!.id}/retry`, { actor: 'user' }),
    );

    expect(response.status).toBe(200);
    const delivery = (await json(response))['delivery'] as Record<string, unknown>;
    expect(delivery['status']).toBe('sent');
    expect(delivery['attemptCount']).toBe(2);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.body).toBe(failed!.bodyText);
  });

  it('refuses to retry something that already went', async () => {
    await seedSharedDinner();
    await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));

    const [sent] = await database.db.select().from(schema.proofPackDeliveries);
    const response = await api.handle(post(`/api/deliveries/${sent!.id}/retry`, { actor: 'user' }));

    expect(response.status).toBe(422);
    expect((await json(response))['error']).toMatchObject({
      code: 'PROOF_PACK_DELIVERY_NOT_RETRYABLE',
    });
    expect(transport.sent).toHaveLength(1);
  });
});

describe('POST /api/deliveries/status', () => {
  it('lets a provider confirm a message this ledger handed over', async () => {
    await seedSharedDinner();
    await api.handle(post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()));

    const response = await api.handle(
      post('/api/deliveries/status', {
        transportId: 'mock-whatsapp',
        providerMessageId: 'wamid-1',
        status: 'delivered',
      }),
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body['status']).toBe('delivered');
    expect(body['deliveredAt']).not.toBeNull();
  });

  it('404s a callback for a message this ledger never sent', async () => {
    const response = await api.handle(
      post('/api/deliveries/status', {
        transportId: 'mock-whatsapp',
        providerMessageId: 'wamid-not-ours',
        status: 'delivered',
      }),
    );
    expect(response.status).toBe(404);
    expect(await database.db.select().from(schema.proofPackDeliveries)).toHaveLength(0);
  });
});

describe('an unconfigured installation', () => {
  it('refuses honestly, and the failure is visible in the record', async () => {
    const { createUnconfiguredMessageTransport } =
      await import('../../src/integrations/message-transport/index.js');
    const refusing = createUnconfiguredMessageTransport();
    const unconfigured = createApi({
      db: database.db,
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      evidenceStore: store,
      splitwise: createMockSplitwisePort(),
      messageTransport: refusing,
    });
    await seedSharedDinner();

    const status = await json(
      await unconfigured.handle(new Request(`${BASE}/api/messaging/status`)),
    );
    expect(status['configured']).toBe(false);
    expect(String(status['unavailableReason'])).toContain('WHATSAPP_ACCESS_TOKEN');

    const response = await unconfigured.handle(
      post(`/api/proof-packs/${friendA()}/deliveries`, sendBody()),
    );
    expect(response.status).toBe(500);

    const [row] = await database.db.select().from(schema.proofPackDeliveries);
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toContain('No message transport is configured');
  });
});

describe('route registration', () => {
  it('registers every delivery route', () => {
    const paths = api.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('GET /api/messaging/status');
    expect(paths).toContain('POST /api/proof-packs/:recipientPersonId/deliveries');
    expect(paths).toContain('GET /api/proof-packs/:recipientPersonId/deliveries');
    expect(paths).toContain('GET /api/deliveries');
    expect(paths).toContain('POST /api/deliveries/:deliveryId/retry');
    expect(paths).toContain('POST /api/deliveries/status');
  });
});
