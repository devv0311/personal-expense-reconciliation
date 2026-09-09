import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, paise } from '../../src/domain/index.js';
import type { EvidenceId, PaymentId } from '../../src/domain/index.js';
import {
  getReceiptByEvidenceId,
  listAiInferencesByResultingRecord,
  listAuditEvents,
  schema,
} from '../../src/db/index.js';
import { createAiService } from '../../src/ai/index.js';
import {
  confirmReceipt,
  correctReceipt,
  extractReceipt,
  ingestEvidenceDocument,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore, syntheticDocument } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { scriptedReceiptExtractionTransport } from '../support/ai.js';
import { createStubDocumentTextExtractor } from '../support/document-text.js';

const AS_USER = { actor: 'user', source: 'tests/integration/receipt' } as const;

const RESTAURANT_CAPTURED_AT = new Date('2026-07-16T20:05:00.000Z');
const BLINKIT_CAPTURED_AT = new Date('2026-07-01T19:25:00.000Z');
const EMPTY_CAPTURED_AT = new Date('2026-07-20T12:00:00.000Z');

let database: TestDatabase;
let store: MemoryEvidenceStore;
let cast: Cast;
let ai: ReturnType<typeof createAiService>;

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
  ai = createAiService(scriptedReceiptExtractionTransport());
});

/**
 * The document reader every extraction here is given.
 *
 * Passed explicitly rather than defaulted, because the audit's row 14 was exactly that
 * extraction had no way to read a stored document: a caller with no reader now gets a refusal
 * naming that, not a receipt conjured from an evidence row with no text in it.
 */
function reader() {
  return { evidenceStore: store, documentText: createStubDocumentTextExtractor() };
}

async function ingest(capturedAt: Date, type: 'receipt_image' | 'bank_line' = 'receipt_image') {
  const result = await ingestEvidenceDocument(database.db, {
    type,
    bytes: syntheticDocument(capturedAt.toISOString()),
    mediaType: 'image/jpeg',
    capturedAt,
    store,
    audit: AS_USER,
  });
  return result.evidenceId;
}

describe('extracting a receipt', () => {
  it('writes a Receipt and its items, unconfirmed', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);

    const outcome = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });

    expect(outcome.outcome).toBe('extracted');
    if (outcome.outcome !== 'extracted') throw new Error('unreachable');
    expect(outcome.view.receipt).toMatchObject({
      evidenceId,
      subtotal: 119_000n,
      total: 124_000n,
      confirmedByUser: false,
    });
    expect(outcome.view.items).toHaveLength(5);
    expect(outcome.view.items.map((item) => item.description)).toContain('Amul Milk 1L (x2)');
  });

  it('audits the creation, naming the actor', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);

    const outcome = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (outcome.outcome !== 'extracted') throw new Error('unreachable');

    const events = await listAuditEvents(database.db, 'receipt', outcome.view.receipt.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'create', actor: 'user' });
  });

  it('records both AIInferences, pending, attached to the receipt', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);

    const outcome = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (outcome.outcome !== 'extracted') throw new Error('unreachable');

    const inferences = await listAiInferencesByResultingRecord(
      database.db,
      'receipt',
      outcome.view.receipt.id,
    );
    expect(inferences.map((i) => i.inferenceType).sort()).toEqual([
      'extract_receipt_items',
      'parse_receipt',
    ]);
    expect(inferences.every((i) => i.status === 'pending')).toBe(true);
  });

  it('leaves the merchant null when the hint matches no known alias', async () => {
    // The catalog's aliases are the full raw statement description a bank line carries
    // (phase 7), not a receipt header's plain merchant name — so "Blinkit" resolves to
    // nothing today, which is exactly this phase's scope decision to defer ai.normalizeMerchant().
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);

    const outcome = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });

    expect(outcome.outcome).toBe('extracted');
    if (outcome.outcome !== 'extracted') throw new Error('unreachable');
    expect(outcome.view.receipt.merchantId).toBeNull();
  });

  it('resolves the merchant when the hint happens to match a catalogued alias', async () => {
    const [merchant] = await database.db
      .insert(schema.merchants)
      .values({ canonicalName: 'Blinkit', defaultCategory: 'groceries' })
      .returning({ id: schema.merchants.id });
    await database.db.insert(schema.merchantAliases).values({
      merchantId: merchant!.id,
      // merchantAliasKey canonicalizes to uppercase/trimmed — matching the literal hint here
      // proves the resolution path, independent of what phase 7's own catalog happens to hold.
      rawPattern: 'BLINKIT',
    });
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);

    const outcome = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });

    expect(outcome.outcome).toBe('extracted');
    if (outcome.outcome !== 'extracted') throw new Error('unreachable');
    expect(outcome.view.receipt.merchantId).toBe(merchant!.id);
  });
});

describe('what extraction refuses', () => {
  it('refuses evidence that does not exist', async () => {
    const absent = asId<'evidence'>('00000000-0000-4000-8000-000000000000');

    await expect(
      extractReceipt(database.db, { evidenceId: absent, ai, ...reader(), audit: AS_USER }),
    ).rejects.toMatchObject({
      code: 'ENTITY_NOT_FOUND',
    });
  });

  it('refuses evidence that is not receipt-eligible', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT, 'bank_line');

    await expect(
      extractReceipt(database.db, { evidenceId, ai, ...reader(), audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a second extraction over the same evidence', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);
    await extractReceipt(database.db, { evidenceId, ai, ...reader(), audit: AS_USER });

    await expect(
      extractReceipt(database.db, { evidenceId, ai, ...reader(), audit: AS_USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a draft naming no figure at all, writing nothing', async () => {
    const evidenceId = await ingest(EMPTY_CAPTURED_AT);

    const outcome = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });

    expect(outcome).toMatchObject({ outcome: 'rejected', code: 'RECEIPT_DRAFT_INVALID' });
    // Extraction can be retried: nothing was written for this evidence.
    expect(await getReceiptByEvidenceId(database.db, evidenceId)).toBeNull();
  });
});

describe('confirmReceipt', () => {
  it('flips confirmed_by_user and accepts both inferences', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);
    const extracted = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (extracted.outcome !== 'extracted') throw new Error('unreachable');

    const view = await confirmReceipt(database.db, {
      receiptId: extracted.view.receipt.id,
      audit: AS_USER,
    });

    expect(view.receipt.confirmedByUser).toBe(true);
    const inferences = await listAiInferencesByResultingRecord(
      database.db,
      'receipt',
      view.receipt.id,
    );
    expect(inferences.every((i) => i.status === 'accepted')).toBe(true);
    expect(inferences.every((i) => i.decidedBy === 'user')).toBe(true);
  });

  it('is a no-op the second time, writing no further audit event', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);
    const extracted = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (extracted.outcome !== 'extracted') throw new Error('unreachable');
    const receiptId = extracted.view.receipt.id;

    await confirmReceipt(database.db, { receiptId, audit: AS_USER });
    await confirmReceipt(database.db, { receiptId, audit: AS_USER });

    const events = await listAuditEvents(database.db, 'receipt', receiptId);
    // One create, one confirm — the second confirm added nothing.
    expect(events).toHaveLength(2);
  });
});

describe('correctReceipt', () => {
  it('overwrites the given fields, replaces items, and confirms', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);
    const extracted = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (extracted.outcome !== 'extracted') throw new Error('unreachable');

    const view = await correctReceipt(database.db, {
      receiptId: extracted.view.receipt.id,
      correction: {
        total: paise(125_000n),
        items: [
          {
            description: 'Amul Milk 1L (x2), corrected',
            quantity: '2',
            unitPrice: paise(4_000n),
            lineTotal: paise(8_000n),
            suggestedCategory: 'groceries',
          },
        ],
      },
      audit: AS_USER,
    });

    expect(view.receipt.total).toBe(125_000n);
    expect(view.receipt.confirmedByUser).toBe(true);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.description).toBe('Amul Milk 1L (x2), corrected');
  });

  it('marks pending inferences modified', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);
    const extracted = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (extracted.outcome !== 'extracted') throw new Error('unreachable');
    const receiptId = extracted.view.receipt.id;

    await correctReceipt(database.db, {
      receiptId,
      correction: { total: paise(125_000n) },
      audit: AS_USER,
    });

    const inferences = await listAiInferencesByResultingRecord(database.db, 'receipt', receiptId);
    expect(inferences.every((i) => i.status === 'modified')).toBe(true);
  });

  it('leaves a field out of the correction untouched, not cleared to null', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);
    const extracted = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (extracted.outcome !== 'extracted') throw new Error('unreachable');
    const originalSubtotal = extracted.view.receipt.subtotal;

    const view = await correctReceipt(database.db, {
      receiptId: extracted.view.receipt.id,
      correction: { total: paise(125_000n) },
      audit: AS_USER,
    });

    expect(view.receipt.total).toBe(125_000n);
    expect(view.receipt.subtotal).toBe(originalSubtotal);
  });

  it('leaves an already-decided inference alone when corrected after confirming', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);
    const extracted = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (extracted.outcome !== 'extracted') throw new Error('unreachable');
    const receiptId = extracted.view.receipt.id;

    await confirmReceipt(database.db, { receiptId, audit: AS_USER });
    // A correction after confirmation must not try to re-decide an already-terminal inference.
    await expect(
      correctReceipt(database.db, {
        receiptId,
        correction: { total: paise(125_000n) },
        audit: AS_USER,
      }),
    ).resolves.not.toThrow();

    const inferences = await listAiInferencesByResultingRecord(database.db, 'receipt', receiptId);
    expect(inferences.every((i) => i.status === 'accepted')).toBe(true);
  });
});

describe('discrepancies (scenario-analysis.md §20, ReceiptItem invariant)', () => {
  it('surfaces the items-vs-subtotal gap without touching either figure', async () => {
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);
    const extracted = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });
    if (extracted.outcome !== 'extracted') throw new Error('unreachable');

    const view = await correctReceipt(database.db, {
      receiptId: extracted.view.receipt.id,
      correction: {
        subtotal: paise(100_000n),
        items: [
          {
            description: 'One item',
            quantity: '1',
            unitPrice: null,
            lineTotal: paise(110_000n),
            suggestedCategory: null,
          },
        ],
      },
      audit: AS_USER,
    });

    expect(view.itemsSubtotalDiscrepancy).toBe(10_000n);
    expect(view.receipt.subtotal).toBe(100_000n);
  });

  it('surfaces the receipt-vs-payment gap once linked, per the tip-at-the-table scenario', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(285_000n),
      direction: 'debit',
      occurredAt: RESTAURANT_CAPTURED_AT,
      rawDescription: 'UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD',
      channel: 'upi',
    });
    const evidenceId = await ingestLinked(paymentId);

    const outcome = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });

    expect(outcome.outcome).toBe('extracted');
    if (outcome.outcome !== 'extracted') throw new Error('unreachable');
    // fixtures/receipt-amount-mismatch.json: receipt total 2700, payment 2850 — the tip.
    expect(outcome.view.paymentDiscrepancy).toBe(-15_000n);
  });

  it('surfaces a deterministic candidate match when the evidence is not yet linked', async () => {
    const paymentId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: BLINKIT_CAPTURED_AT,
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'upi',
    });
    const evidenceId = await ingest(BLINKIT_CAPTURED_AT);

    const outcome = await extractReceipt(database.db, {
      evidenceId,
      ai,
      ...reader(),
      audit: AS_USER,
    });

    expect(outcome.outcome).toBe('extracted');
    if (outcome.outcome !== 'extracted') throw new Error('unreachable');
    expect(outcome.view.candidateMatches.map((m) => m.paymentId)).toEqual([paymentId]);
    // Nothing linked itself (ADR-0037) — the evidence still has no home.
    expect(outcome.view.paymentDiscrepancy).toBeNull();
  });
});

async function ingestLinked(paymentId: PaymentId): Promise<EvidenceId> {
  const result = await ingestEvidenceDocument(database.db, {
    type: 'receipt_image',
    bytes: syntheticDocument(RESTAURANT_CAPTURED_AT.toISOString()),
    mediaType: 'image/jpeg',
    capturedAt: RESTAURANT_CAPTURED_AT,
    linkedPaymentId: paymentId,
    store,
    audit: AS_USER,
  });
  return result.evidenceId;
}
