import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { EvidenceId, ExpenseId, PaymentId } from '../../src/domain/index.js';
import { listAuditEvents, listUnmatchedEvidence } from '../../src/db/index.js';
import { createAiService } from '../../src/ai/index.js';
import {
  MAX_EVIDENCE_DOCUMENT_BYTES,
  extractReceipt,
  getEvidence,
  ingestEvidenceDocument,
  linkEvidence,
  listReviewQueue,
  readEvidenceDocument,
  recordManualNote,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore, syntheticDocument } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { addExpense, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { scriptedReceiptExtractionTransport } from '../support/ai.js';
import { createStubDocumentTextExtractor } from '../support/document-text.js';

const AS_USER = { actor: 'user', source: 'services.ingestEvidenceDocument' } as const;
const CAPTURED_AT = new Date('2026-07-12T20:14:00Z');

let database: TestDatabase;
let store: MemoryEvidenceStore;
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
  paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(284_000n),
    direction: 'debit',
    occurredAt: CAPTURED_AT,
    rawDescription: 'UPI-SAMPLE RESTAURANT',
    channel: 'upi',
  });
  expenseId = await addExpense(database.db, {
    description: 'Dinner',
    amount: paise(284_000n),
    occurredAt: CAPTURED_AT,
    relationshipType: 'shared',
    paidByPersonId: cast.userPersonId,
  });
});

function ingest(overrides: Partial<Parameters<typeof ingestEvidenceDocument>[1]> = {}) {
  return ingestEvidenceDocument(database.db, {
    type: 'receipt_image',
    bytes: syntheticDocument('restaurant-bill'),
    mediaType: 'image/jpeg',
    capturedAt: CAPTURED_AT,
    store,
    audit: AS_USER,
    ...overrides,
  });
}

/** The document reader an extraction is given — see `receipt.test.ts` for why it is explicit. */
function reader() {
  return { evidenceStore: store, documentText: createStubDocumentTextExtractor() };
}

describe('ingesting a document', () => {
  it('stores the bytes and records a row that points at them', async () => {
    const result = await ingest();

    expect(result.outcome).toBe('ingested');
    expect(result.storageRef).toMatch(/^sha256\/[0-9a-f]{64}\.jpg$/);
    expect(store.size()).toBe(1);

    const evidence = await getEvidence(database.db, result.evidenceId);
    expect(evidence).toMatchObject({
      type: 'receipt_image',
      storageRef: result.storageRef,
      mediaType: 'image/jpeg',
      byteSize: result.byteSize,
      noteKind: null,
      linkedPaymentId: null,
      linkedExpenseId: null,
    });
    expect(evidence.capturedAt).toEqual(CAPTURED_AT);
  });

  it('audits the ingestion, naming the actor', async () => {
    const { evidenceId } = await ingest();

    const events = await listAuditEvents(database.db, 'evidence', evidenceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'create', actor: 'user' });
  });

  it('attaches the document at ingestion when the caller already knows where it belongs', async () => {
    const result = await ingest({ linkedPaymentId: paymentId, linkedExpenseId: expenseId });

    const evidence = await getEvidence(database.db, result.evidenceId);
    expect(evidence.linkedPaymentId).toBe(paymentId);
    expect(evidence.linkedExpenseId).toBe(expenseId);
  });

  it('reads the document back byte for byte', async () => {
    const { evidenceId } = await ingest();

    const document = await readEvidenceDocument(database.db, { evidenceId, store });
    expect(document.mediaType).toBe('image/jpeg');
    expect([...document.bytes]).toEqual([...syntheticDocument('restaurant-bill')]);
  });
});

describe('the same document arriving twice', () => {
  it('resolves to the row that already holds it', async () => {
    const first = await ingest();
    const second = await ingest();

    expect(second.outcome).toBe('already_ingested');
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(store.size()).toBe(1);

    // One row, and therefore one thing for a human to look at rather than two.
    expect(await listUnmatchedEvidence(database.db)).toHaveLength(1);
  });

  it('writes no second audit event for a re-ingestion', async () => {
    const { evidenceId } = await ingest();
    await ingest();

    expect(await listAuditEvents(database.db, 'evidence', evidenceId)).toHaveLength(1);
  });

  it('records a second row when the same document is attached to something else', async () => {
    const first = await ingest();
    const second = await ingest({ linkedPaymentId: paymentId });

    // The same bytes supporting a different claim is a different piece of evidence; the
    // store still holds one copy of them.
    expect(second.evidenceId).not.toBe(first.evidenceId);
    expect(second.storageRef).toBe(first.storageRef);
    expect(store.size()).toBe(1);
  });
});

describe('what ingestion refuses', () => {
  it('refuses a format it does not store', async () => {
    await expect(ingest({ mediaType: 'application/octet-stream' })).rejects.toMatchObject({
      code: 'EVIDENCE_MEDIA_TYPE_UNSUPPORTED',
    });
    expect(store.size()).toBe(0);
  });

  it('refuses a document past the size limit before storing it', async () => {
    const oversized = new Uint8Array(MAX_EVIDENCE_DOCUMENT_BYTES + 1);

    await expect(ingest({ bytes: oversized })).rejects.toMatchObject({
      code: 'EVIDENCE_DOCUMENT_TOO_LARGE',
    });
    expect(store.size()).toBe(0);
  });

  it('refuses to attach a document to a payment that does not exist', async () => {
    const absent = asId<'payment'>('00000000-0000-4000-8000-000000000000');

    await expect(ingest({ linkedPaymentId: absent })).rejects.toMatchObject({
      code: 'ENTITY_NOT_FOUND',
    });
  });

  it('reports a document the store no longer holds, rather than an empty one', async () => {
    const { evidenceId } = await ingest();
    // A database restored without its object store: the row is honest, the document is gone.
    store.clear();

    await expect(readEvidenceDocument(database.db, { evidenceId, store })).rejects.toMatchObject({
      code: 'ENTITY_NOT_FOUND',
    });
  });
});

describe('recording a manual note', () => {
  it('writes a note with no document and audits it', async () => {
    const evidenceId = await recordManualNote(database.db, {
      text: 'Flatmate A paid the electrician, split three ways',
      noteKind: 'documentation',
      capturedAt: CAPTURED_AT,
      linkedExpenseId: expenseId,
      audit: { actor: 'user', source: 'services.recordManualNote' },
    });

    const evidence = await getEvidence(database.db, evidenceId);
    expect(evidence).toMatchObject({
      type: 'manual_note',
      noteKind: 'documentation',
      storageRef: null,
      mediaType: null,
      byteSize: null,
      linkedExpenseId: expenseId,
    });
    expect(await listAuditEvents(database.db, 'evidence', evidenceId)).toHaveLength(1);
  });

  it('keeps both note kinds available and distinguishable (ADR-0018)', async () => {
    const documenting = await recordManualNote(database.db, {
      text: 'A paid, we split it',
      noteKind: 'documentation',
      capturedAt: CAPTURED_AT,
      linkedExpenseId: expenseId,
      audit: { actor: 'user', source: 'services.recordManualNote' },
    });
    const claim = await recordManualNote(database.db, {
      text: 'Settled in cash',
      noteKind: 'settlement_claim',
      capturedAt: CAPTURED_AT,
      linkedExpenseId: expenseId,
      audit: { actor: 'user', source: 'services.recordManualNote' },
    });

    expect((await getEvidence(database.db, documenting)).noteKind).toBe('documentation');
    expect((await getEvidence(database.db, claim)).noteKind).toBe('settlement_claim');
  });

  it('does not deduplicate identical notes — two are two things a person said', async () => {
    const note = {
      text: 'Paid in cash',
      noteKind: 'documentation' as const,
      capturedAt: CAPTURED_AT,
      audit: { actor: 'user', source: 'services.recordManualNote' },
    };

    const first = await recordManualNote(database.db, { ...note, linkedExpenseId: expenseId });
    const second = await recordManualNote(database.db, { ...note, linkedExpenseId: expenseId });

    expect(second).not.toBe(first);
  });

  it('refuses a note attached to an expense that does not exist', async () => {
    await expect(
      recordManualNote(database.db, {
        text: 'about nothing',
        noteKind: 'documentation',
        capturedAt: CAPTURED_AT,
        linkedExpenseId: asId<'expense'>('00000000-0000-4000-8000-000000000000'),
        audit: { actor: 'user', source: 'services.recordManualNote' },
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
  });
});

describe('linking evidence, once', () => {
  const AS_REVIEWER = { actor: 'user', source: 'services.linkEvidence' } as const;
  let evidenceId: EvidenceId;

  beforeEach(async () => {
    evidenceId = (await ingest()).evidenceId;
  });

  it('attaches a document that arrived with no home', async () => {
    const linked = await linkEvidence(database.db, {
      evidenceId,
      linkedPaymentId: paymentId,
      audit: AS_REVIEWER,
    });

    expect(linked.linkedPaymentId).toBe(paymentId);
    expect(await listUnmatchedEvidence(database.db)).toHaveLength(0);
  });

  it('audits the link with what it was and what it became', async () => {
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_REVIEWER });

    const events = await listAuditEvents(database.db, 'evidence', evidenceId);
    const update = events.find((event) => event.action === 'update');
    expect(update?.oldValue).toMatchObject({ linkedPaymentId: null });
    expect(update?.newValue).toMatchObject({ linkedPaymentId: paymentId });
  });

  it('fills in the other side without disturbing the first', async () => {
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_REVIEWER });
    const linked = await linkEvidence(database.db, {
      evidenceId,
      linkedExpenseId: expenseId,
      audit: AS_REVIEWER,
    });

    expect(linked.linkedPaymentId).toBe(paymentId);
    expect(linked.linkedExpenseId).toBe(expenseId);
  });

  it('refuses to re-point a link at a different payment', async () => {
    const other = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(120_00n),
      direction: 'debit',
      occurredAt: CAPTURED_AT,
      rawDescription: 'UPI-SOMEWHERE ELSE',
      channel: 'upi',
    });
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_REVIEWER });

    await expect(
      linkEvidence(database.db, { evidenceId, linkedPaymentId: other, audit: AS_REVIEWER }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_LINK_IMMUTABLE' });

    expect((await getEvidence(database.db, evidenceId)).linkedPaymentId).toBe(paymentId);
  });

  it('refuses to clear a link', async () => {
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_REVIEWER });

    await expect(
      linkEvidence(database.db, { evidenceId, linkedPaymentId: null, audit: AS_REVIEWER }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_LINK_IMMUTABLE' });
  });

  it('treats a re-link to the same target as the no-op it is', async () => {
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_REVIEWER });
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_REVIEWER });

    // One create, one update. A second update would be an audit trail claiming something
    // happened that did not.
    expect(await listAuditEvents(database.db, 'evidence', evidenceId)).toHaveLength(2);
  });

  it('leaves the document itself untouched when linkage changes', async () => {
    const before = await getEvidence(database.db, evidenceId);
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_REVIEWER });
    const after = await getEvidence(database.db, evidenceId);

    expect(after.storageRef).toBe(before.storageRef);
    expect(after.mediaType).toBe(before.mediaType);
    expect(after.byteSize).toBe(before.byteSize);
    expect(after.capturedAt).toEqual(before.capturedAt);
  });
});

describe('an unmatched document in the review queue', () => {
  it('surfaces a document that arrived with no home', async () => {
    const { evidenceId } = await ingest();

    const queue = await listReviewQueue(database.db);

    expect(queue.counts.unmatched_evidence).toBe(1);
    const item = queue.items.find((entry) => entry.kind === 'unmatched_evidence');
    expect(item).toMatchObject({
      id: evidenceId,
      evidenceType: 'receipt_image',
      mediaType: 'image/jpeg',
      reasons: ['evidence_unmatched'],
    });
  });

  it('carries no amount, because nothing has read the document yet', async () => {
    await ingest();

    const [item] = (await listReviewQueue(database.db)).items;
    expect(item?.amount).toBe(0n);
  });

  it('proposes nothing about where the document belongs', async () => {
    await ingest();

    const [item] = (await listReviewQueue(database.db)).items;
    // Matching needs an amount, and reading one off the document is extraction (phase 11).
    expect(item).not.toHaveProperty('proposal');
    expect(item).not.toHaveProperty('payment');
  });

  it('drops out of the queue once a human attaches it', async () => {
    const { evidenceId } = await ingest();

    await linkEvidence(database.db, {
      evidenceId,
      linkedPaymentId: paymentId,
      audit: { actor: 'user', source: 'services.linkEvidence' },
    });

    const queue = await listReviewQueue(database.db);
    expect(queue.counts.unmatched_evidence).toBe(0);
    expect(queue.total).toBe(0);
  });

  it('never surfaces a manual note', async () => {
    // The person who typed it chose its links in the same act; an unlinked note is a note
    // about nothing in particular, not a document waiting to be placed.
    await recordManualNote(database.db, {
      text: 'Cash lunch, nobody owes anybody',
      noteKind: 'documentation',
      capturedAt: CAPTURED_AT,
      audit: { actor: 'user', source: 'services.recordManualNote' },
    });

    expect((await listReviewQueue(database.db)).counts.unmatched_evidence).toBe(0);
  });

  it('is filtered out when a caller asks for other kinds', async () => {
    await ingest();

    const queue = await listReviewQueue(database.db, { kinds: ['possible_duplicate'] });
    expect(queue.items).toHaveLength(0);
  });
});

describe('an unmatched document once extraction has read a Receipt off it', () => {
  const BLINKIT_CAPTURED_AT = new Date('2026-07-01T19:25:00.000Z');
  const ai = createAiService(scriptedReceiptExtractionTransport());

  it('carries the receipt total as its amount, no longer zero', async () => {
    const { evidenceId } = await ingest({ capturedAt: BLINKIT_CAPTURED_AT });
    await extractReceipt(database.db, { evidenceId, ai, ...reader(), audit: AS_USER });

    const [item] = (await listReviewQueue(database.db)).items;

    expect(item?.amount).toBe(124_000n);
    expect(item).toMatchObject({ receiptTotal: 124_000n });
    expect((item as { receiptId?: string })?.receiptId).toEqual(expect.any(String));
  });

  it('offers a deterministic candidate payment, without linking anything (ADR-0037)', async () => {
    const matchingPaymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: BLINKIT_CAPTURED_AT,
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'upi',
    });
    const { evidenceId } = await ingest({ capturedAt: BLINKIT_CAPTURED_AT });
    await extractReceipt(database.db, { evidenceId, ai, ...reader(), audit: AS_USER });

    const item = (await listReviewQueue(database.db)).items.find(
      (entry) => entry.kind === 'unmatched_evidence',
    );

    expect(item).toMatchObject({
      candidateMatches: [{ paymentId: matchingPaymentId, amount: 124_000n }],
    });
    // Still in the queue: a candidate is an offer, not a decision (services.linkEvidence is).
    expect((await listReviewQueue(database.db)).counts.unmatched_evidence).toBe(1);
  });

  it('carries no candidates when nothing matches the extracted total', async () => {
    const { evidenceId } = await ingest({ capturedAt: BLINKIT_CAPTURED_AT });
    await extractReceipt(database.db, { evidenceId, ai, ...reader(), audit: AS_USER });

    const item = (await listReviewQueue(database.db)).items.find(
      (entry) => entry.kind === 'unmatched_evidence',
    );

    expect(item).toMatchObject({ candidateMatches: [] });
  });
});
