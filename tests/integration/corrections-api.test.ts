/**
 * The two correction workflows over HTTP (audit rows 13 and 23, ADR-0052).
 *
 * Both routes require a reason and neither offers a delete, which is the whole point: these
 * are the paths a person takes when an immutable record turns out to be wrong, and the record
 * has to survive the correction.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import { paise } from '../../src/domain/index.js';
import type { AccountId, ExpenseId, PaymentId } from '../../src/domain/index.js';
import {
  approveAllocation,
  distributeAdjustment,
  ingestEvidenceDocument,
  linkEvidence,
  recordExpenseAdjustment,
} from '../../src/services/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore, syntheticDocument } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { addExpense, addPayment, AS_USER, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';

let database: TestDatabase;
let store: MemoryEvidenceStore;
let api: Api;
let cast: Cast;
let accountId: AccountId;

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
  accountId = cast.account['account_hdfc_savings']!;
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: store,
    splitwise: createMockSplitwisePort(),
  });
});

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

async function aPayment(description: string): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId,
    amount: paise(124000n),
    direction: 'debit',
    occurredAt: new Date('2026-07-01T00:00:00.000Z'),
    rawDescription: description,
    channel: 'upi',
  });
}

describe('POST /api/evidence/:evidenceId/supersede', () => {
  async function attachedReceipt(paymentId: PaymentId): Promise<string> {
    const { evidenceId } = await ingestEvidenceDocument(database.db, {
      type: 'receipt_image',
      bytes: syntheticDocument('a-receipt'),
      mediaType: 'image/jpeg',
      capturedAt: new Date('2026-07-01T19:25:00.000Z'),
      store,
      audit: AS_USER,
    });
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_USER });
    return evidenceId;
  }

  it('returns the corrected record and preserves the original', async () => {
    const wrong = await aPayment('WRONG');
    const right = await aPayment('RIGHT');
    const evidenceId = await attachedReceipt(wrong);

    const response = await api.handle(
      post(`/api/evidence/${evidenceId}/supersede`, {
        actor: 'user',
        linkedPaymentId: right,
        reason: 'Attached to the wrong debit.',
      }),
    );
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body['supersededEvidenceId']).toBe(evidenceId);

    const detail = await api.handle(new Request(`${BASE}/api/evidence/${evidenceId}`));
    const original = await json(detail);
    expect(original['supersededByEvidenceId']).toBe(body['evidenceId']);
    expect(original['linkedPaymentId']).toBe(wrong);
  });

  it('requires a reason', async () => {
    const wrong = await aPayment('WRONG');
    const right = await aPayment('RIGHT');
    const evidenceId = await attachedReceipt(wrong);
    const response = await api.handle(
      post(`/api/evidence/${evidenceId}/supersede`, { actor: 'user', linkedPaymentId: right }),
    );
    expect(response.status).toBe(400);
  });

  it('leaves the original attached when the correction is refused', async () => {
    const wrong = await aPayment('WRONG');
    const evidenceId = await attachedReceipt(wrong);
    const response = await api.handle(
      post(`/api/evidence/${evidenceId}/supersede`, {
        actor: 'user',
        linkedPaymentId: wrong,
        reason: 'no change at all',
      }),
    );
    expect(response.status).toBe(409);
    const rows = await database.db.select().from(schema.evidence);
    expect(rows).toHaveLength(1);
  });
});

describe('adjustment reversal over HTTP', () => {
  async function anExpenseWithRefund(): Promise<{ expenseId: ExpenseId; adjustmentId: string }> {
    const expenseId = await addExpense(database.db, {
      description: 'Electronics',
      amount: paise(1000000n),
      occurredAt: new Date('2026-07-05T00:00:00.000Z'),
      relationshipType: 'shared',
      paidByPersonId: cast.userPersonId,
    });
    await approveAllocation(database.db, {
      expenseId,
      decision: {
        method: 'equal',
        beneficiaries: [
          { type: 'person', id: cast.userPersonId },
          { type: 'person', id: cast.person['person_friend_a']! },
        ],
      },
      decidedBy: 'manual',
      audit: AS_USER,
    });
    const adjustment = await recordExpenseAdjustment(database.db, {
      expenseId,
      kind: 'merchant_refund',
      amount: paise(200000n),
      occurredAt: new Date('2026-07-10T00:00:00.000Z'),
      audit: AS_USER,
    });
    return { expenseId, adjustmentId: adjustment.adjustmentId };
  }

  it('lists every adjustment, reversed ones included and marked', async () => {
    const { expenseId, adjustmentId } = await anExpenseWithRefund();
    await api.handle(
      post(`/api/adjustments/${adjustmentId}/reverse`, {
        actor: 'user',
        reason: 'Recorded against the wrong expense.',
      }),
    );

    const response = await api.handle(new Request(`${BASE}/api/expenses/${expenseId}/adjustments`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      adjustments: {
        adjustmentId: string;
        counts: boolean;
        amount: string;
        reversalReason: string;
      }[];
    };
    expect(body.adjustments).toHaveLength(1);
    expect(body.adjustments[0]?.counts).toBe(false);
    expect(body.adjustments[0]?.amount).toBe('200000');
    expect(body.adjustments[0]?.reversalReason).toContain('wrong expense');
  });

  it('reports the net amount it restored and that redistribution is pending', async () => {
    const { expenseId, adjustmentId } = await anExpenseWithRefund();
    // Distributed first: an undistributed refund never reached the shares, so reversing it
    // leaves nothing to redistribute — the interesting case is the one where it did.
    await distributeAdjustment(database.db, { expenseId, audit: AS_USER });

    const response = await api.handle(
      post(`/api/adjustments/${adjustmentId}/reverse`, {
        actor: 'user',
        reason: 'Recorded against the wrong expense.',
      }),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body['netAmountAfter']).toBe('1000000');
    expect(body['pendingRedistribution']).toBe(true);

    const state = await api.handle(
      new Request(`${BASE}/api/expenses/${expenseId}/refund-allocation`),
    );
    const refund = await json(state);
    expect(refund['pendingDistribution']).toBe(true);
  });

  it('requires a reason, and refuses a second reversal', async () => {
    const { adjustmentId } = await anExpenseWithRefund();
    const noReason = await api.handle(
      post(`/api/adjustments/${adjustmentId}/reverse`, { actor: 'user' }),
    );
    expect(noReason.status).toBe(400);

    await api.handle(
      post(`/api/adjustments/${adjustmentId}/reverse`, { actor: 'user', reason: 'wrong' }),
    );
    const again = await api.handle(
      post(`/api/adjustments/${adjustmentId}/reverse`, { actor: 'user', reason: 'again' }),
    );
    expect(again.status).toBe(409);
  });

  it('will not accept a non-person actor', async () => {
    const { adjustmentId } = await anExpenseWithRefund();
    const response = await api.handle(
      post(`/api/adjustments/${adjustmentId}/reverse`, { actor: 'ai', reason: 'because' }),
    );
    expect(response.status).toBe(400);
  });

  it('404s for an adjustment that does not exist', async () => {
    const response = await api.handle(
      post(`/api/adjustments/8ad1a3e2-0f4a-4a3f-9e8a-0d9a1f2b3c4d/reverse`, {
        actor: 'user',
        reason: 'nope',
      }),
    );
    expect(response.status).toBe(404);
  });
});
