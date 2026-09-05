/**
 * The local PII boundary, end to end (phase 17, `security-model.md`).
 *
 * Phase 17 is the first phase that puts *evidence* text on the path to a model: the merchant a
 * push notification names is what repairs a decayed UPI narration, and that name reaches
 * `ai.classifyTransaction` through the re-attached context. The identifiers sitting beside it
 * in the same evidence — the UTR, the masked account tail, the raw SMS itself — must not.
 *
 * These tests use synthetic sensitive markers (a VPA, a mobile number, an account fragment,
 * a card number) and assert three things:
 *
 *  1. **Nothing raw crosses the boundary.** The exact payload the transport receives is
 *     captured and searched for every marker.
 *  2. **Local reconstruction still works.** The same identifiers are readable through
 *     `services.getPaymentContext` on this machine, which is the whole point of keeping them.
 *  3. **Redaction fails closed.** A payload that reaches the boundary unredacted raises rather
 *     than being trimmed, and the error names the field, not the value.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createAiService,
  isSanitizationError,
  redactPaymentForInference,
} from '../../src/ai/index.js';
import type { ModelRequest, ModelTransport, RedactedPayment } from '../../src/ai/index.js';
import { isDomainError, paise } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import type { PaymentId } from '../../src/domain/index.js';
import {
  classifyPayment,
  decideEvidenceMatch,
  getPaymentContext,
  matchEvidenceContext,
  recordEvidenceNotification,
  recordEvidenceObservation,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const AS_USER = { actor: 'user', source: 'test' } as const;

/** Synthetic markers. None of these is real; every one is the shape of something that is. */
const MARKERS = {
  vpa: 'blinkit@okaxis',
  mobile: '9876543210',
  accountTail: '4821',
  cardNumber: '4111111111111111',
  utr: '2607011234',
} as const;

const SENSITIVE_SMS =
  `Rs.1,240.00 debited from A/C XX${MARKERS.accountTail} on 01-Jul-26 to BLINKIT. ` +
  `UPI Ref no ${MARKERS.utr}. VPA ${MARKERS.vpa}. Dispute? Call ${MARKERS.mobile}. ` +
  `Card ${MARKERS.cardNumber}.`;

let database: TestDatabase;
let cast: Cast;
let paymentId: PaymentId;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  paymentId = await addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(124_000n),
    direction: 'debit',
    occurredAt: new Date('2026-07-01T00:00:00Z'),
    // A real decayed narration, with an account fragment in it.
    rawDescription: `UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD A/C X${MARKERS.accountTail}`,
    channel: 'upi',
    externalReference: `UPI/${MARKERS.utr}/BLINKIT`,
    referenceType: 'upi_utr',
    state: 'normalized',
  });
});

/** A transport that records exactly what it was asked, and answers a valid proposal. */
function capturingTransport(): ModelTransport & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    modelInfo: { provider: 'test', model: 'capture' },
    complete: (request: ModelRequest) => {
      requests.push(request);
      return Promise.resolve({
        confidence: 'high',
        proposedOutput: {
          proposedKind: 'expense',
          relationshipType: 'personal',
          category: 'groceries',
          paidByPersonHint: null,
        },
      });
    },
  };
}

/** Records the SMS, matches it, and attaches it — the full re-attachment, as a person would. */
async function attachSensitiveNotification(): Promise<void> {
  const { evidenceId } = await recordEvidenceNotification(database.db, {
    type: 'upi_notification',
    text: SENSITIVE_SMS,
    capturedAt: new Date('2026-07-01T19:04:00Z'),
    audit: AS_USER,
  });
  const { candidates } = await matchEvidenceContext(database.db, { evidenceId, audit: AS_USER });
  expect(candidates).toHaveLength(1);
  await decideEvidenceMatch(database.db, {
    candidateId: candidates[0]!.candidateId,
    decision: 'accept',
    audit: AS_USER,
  });
}

describe('what crosses the boundary', () => {
  it('sends the reconstructed merchant and none of the identifiers beside it', async () => {
    await attachSensitiveNotification();
    const transport = capturingTransport();

    await classifyPayment(database.db, {
      paymentId,
      ai: createAiService(transport),
      audit: AS_USER,
    });

    expect(transport.requests).toHaveLength(1);
    const payload = transport.requests[0]!.input as RedactedPayment;
    expect(payload.reattachedMerchantHints).toEqual(['BLINKIT']);

    const serialized = JSON.stringify(payload);
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect(serialized, `${name} leaked into the model payload`).not.toContain(marker);
    }
    // Not the raw notification either, in whole or in part.
    expect(serialized).not.toContain('Dispute?');
    expect(serialized).not.toContain('VPA');
  });

  it('sends no field for an account, a reference or an evidence id to occupy', async () => {
    await attachSensitiveNotification();
    const transport = capturingTransport();

    await classifyPayment(database.db, {
      paymentId,
      ai: createAiService(transport),
      audit: AS_USER,
    });

    expect(Object.keys(transport.requests[0]!.input as RedactedPayment).sort()).toEqual([
      'amountMinorUnits',
      'channel',
      'counterpartyCandidates',
      'currency',
      'description',
      'direction',
      'merchantCategory',
      'merchantName',
      'occurredAt',
      'reattachedMerchantHints',
    ]);
  });

  it('sends nothing extra for a payment with no evidence attached', async () => {
    const transport = capturingTransport();

    await classifyPayment(database.db, {
      paymentId,
      ai: createAiService(transport),
      audit: AS_USER,
    });

    expect((transport.requests[0]!.input as RedactedPayment).reattachedMerchantHints).toEqual([]);
  });
});

describe('what stays local', () => {
  it('keeps every identifier readable on this machine', async () => {
    await attachSensitiveNotification();

    const { context } = await getPaymentContext(database.db, paymentId);

    // Reconstruction is the point of keeping them: the UTR and the account tail are right here.
    expect(context.references[0]?.value).toBe(MARKERS.utr);
    expect(context.sources[0]?.observation?.observedAccountHint).toBe(MARKERS.accountTail);
    expect(context.narration).toContain(MARKERS.accountTail);
  });

  it('keeps the raw notification intact in the ledger, byte for byte', async () => {
    await attachSensitiveNotification();

    const rows = await database.db.select().from(schema.evidence);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.rawText).toBe(SENSITIVE_SMS);
    const { context } = await getPaymentContext(database.db, paymentId);
    expect(context.observedSourceCount).toBe(1);
  });

  it('does not repeat a rejected identifier back in the error that refused it', async () => {
    const { evidenceId } = await recordEvidenceNotification(database.db, {
      type: 'upi_notification',
      text: SENSITIVE_SMS,
      capturedAt: new Date('2026-07-01T19:04:00Z'),
      audit: AS_USER,
    });

    let thrown: unknown;
    try {
      await recordEvidenceObservation(database.db, {
        evidenceId,
        observedAccountHint: MARKERS.cardNumber,
        audit: AS_USER,
      });
    } catch (error) {
      thrown = error;
    }

    // An error that reaches a log or an HTTP response must not carry the card number that
    // caused it (`security-model.md`, Logging).
    expect(isDomainError(thrown) && thrown.code).toBe('EVIDENCE_OBSERVATION_INVALID');
    expect(String(thrown)).not.toContain(MARKERS.cardNumber);
    expect(JSON.stringify(isDomainError(thrown) ? thrown.details : {})).not.toContain(
      MARKERS.cardNumber,
    );
  });
});

describe('failing closed', () => {
  it('refuses to send a payload an unredacted identifier reached', () => {
    let thrown: unknown;
    try {
      redactPaymentForInference(
        {
          amount: paise(124_000n),
          currency: 'INR',
          direction: 'debit',
          occurredAt: new Date('2026-07-01T00:00:00Z'),
          rawDescription: 'BLINKIT',
          channel: 'upi',
          externalReference: null,
        },
        {
          // A merchant catalog entry that somehow holds a VPA. Nothing redacts a canonical
          // merchant name today, which is exactly the kind of gap the guard exists for.
          merchant: {
            id: cast.person['person_dev']! as unknown as never,
            canonicalName: MARKERS.vpa,
            defaultCategory: null,
          },
          knownPeople: [],
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(isSanitizationError(thrown)).toBe(true);
    expect(isSanitizationError(thrown) && thrown.details['field']).toBe('merchantName');
    expect(isSanitizationError(thrown) && thrown.details['kinds']).toContain('upi_id_or_email');
    // The error is not itself the leak.
    expect(String(thrown)).not.toContain(MARKERS.vpa);
  });

  it('refuses rather than dropping the field, so the failure cannot pass unnoticed', async () => {
    await attachSensitiveNotification();
    const transport = capturingTransport();

    // A merchant name carrying a mobile number: the guard stops the call before it is made.
    await expect(
      createAiService(transport).classifyTransaction(
        {
          amount: paise(124_000n),
          currency: 'INR',
          direction: 'debit',
          occurredAt: new Date('2026-07-01T00:00:00Z'),
          rawDescription: 'BLINKIT',
          channel: 'upi',
          externalReference: null,
        },
        {
          merchant: {
            id: cast.person['person_dev']! as unknown as never,
            canonicalName: `Blinkit ${MARKERS.mobile}`,
            defaultCategory: null,
          },
          knownPeople: [],
        },
      ),
    ).rejects.toThrow();
    expect(transport.requests).toHaveLength(0);
  });
});
