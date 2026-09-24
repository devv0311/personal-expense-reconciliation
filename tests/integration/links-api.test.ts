/**
 * `GET /api/links` — the settled half of "what needs me".
 *
 * `/api/attention` reports what is still open. Until this existed nothing reported what had
 * been closed, so the review surface could show somebody a list of decisions and never once
 * show them a decision they had made — which is also the only way a person catches a wrong one.
 *
 * What is worth testing is therefore not that it lists rows. It is that the row says **how** the
 * link happened and **who** decided it, that a link with no payment behind it says so in words
 * instead of rendering as an empty amount, and that a person's own acceptance is never reported
 * as something the system did.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import { paise } from '../../src/domain/index.js';
import type { EvidenceId, PaymentId } from '../../src/domain/index.js';
import type { Api } from '../../src/api/index.js';
import {
  decideEvidenceMatch,
  linkEvidence,
  listEvidenceMatches,
  matchEvidenceContext,
  recordEvidenceNotification,
} from '../../src/services/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';
const AS_USER = { actor: 'user:dev', source: 'test' } as const;
const PAYMENT_AT = new Date('2026-07-01T00:00:00Z');
const CAPTURED_AT = new Date('2026-07-01T19:04:00Z');
const SMS = 'Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26 to BLINKIT. UPI Ref no 2607011234.';

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

interface LinksBody {
  links: {
    evidenceId: string;
    recordWords: string;
    payment: { paymentId: string; name: string; nameSource: string; amount: string } | null;
    noPaymentBecause?: string;
    origin: string;
    decidedBy: string | null;
    why: string[];
  }[];
  total: number;
  truncated: boolean;
}

async function links(query = ''): Promise<LinksBody> {
  const response = await api.handle(new Request(`${BASE}/api/links${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as LinksBody;
}

function addBlinkitPayment(): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(124000n),
    direction: 'debit',
    occurredAt: PAYMENT_AT,
    rawDescription: 'UPI-BLINKIT-2607011234',
    channel: 'upi',
    externalReference: 'UPI/2607011234/BLINKIT',
    referenceType: 'upi_utr',
  });
}

/** Records the SMS, offers it against the payment, and accepts the offer as a person would. */
async function acceptTheOfferedMatch(): Promise<{ evidenceId: EvidenceId; paymentId: PaymentId }> {
  const paymentId = await addBlinkitPayment();
  const recorded = await recordEvidenceNotification(database.db, {
    type: 'upi_notification',
    text: SMS,
    capturedAt: CAPTURED_AT,
    audit: AS_USER,
  });
  await matchEvidenceContext(database.db, { evidenceId: recorded.evidenceId, audit: AS_USER });
  const [candidate] = await listEvidenceMatches(database.db, recorded.evidenceId);
  await decideEvidenceMatch(database.db, {
    candidateId: candidate!.candidateId,
    decision: 'accept',
    audit: AS_USER,
  });
  return { evidenceId: recorded.evidenceId, paymentId };
}

describe('GET /api/links', () => {
  it('reports nothing connected rather than an error, on a ledger with no documents', async () => {
    const body = await links();
    expect(body.links).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.truncated).toBe(false);
  });

  it('names the person who accepted an offer, and why the two looked like one event', async () => {
    const { evidenceId, paymentId } = await acceptTheOfferedMatch();

    const body = await links();
    expect(body.total).toBe(1);
    const [link] = body.links;
    expect(link!.evidenceId).toBe(evidenceId);
    expect(link!.recordWords).toBe('Payment message');
    expect(link!.origin).toBe('you_accepted');
    expect(link!.decidedBy).toBe('user:dev');
    expect(link!.payment?.paymentId).toBe(paymentId);
    expect(link!.payment?.amount).toBe('124000');
    // The plain sentences, not the signal names the matcher stored.
    expect(link!.why.length).toBeGreaterThan(0);
    for (const reason of link!.why) expect(reason).toMatch(/[a-z] [a-z]/);
  });

  it('tells a link somebody made by hand apart from an offer they accepted', async () => {
    const paymentId = await addBlinkitPayment();
    const recorded = await recordEvidenceNotification(database.db, {
      type: 'upi_notification',
      text: SMS,
      capturedAt: CAPTURED_AT,
      audit: AS_USER,
    });
    await linkEvidence(database.db, {
      evidenceId: recorded.evidenceId,
      linkedPaymentId: paymentId,
      audit: AS_USER,
    });

    const [link] = (await links()).links;
    // No candidate was ever offered, so there is no acceptance to report — and reporting one
    // would credit a person with a decision they were never asked to make.
    expect(link!.origin).toBe('attached_when_added');
    expect(link!.decidedBy).toBeNull();
    expect(link!.why).toEqual([]);
  });

  it('says in words when the bank narration is the only name the movement has', async () => {
    await acceptTheOfferedMatch();
    const [link] = (await links()).links;
    expect(link!.payment?.nameSource).toBe('narration');
    expect(link!.payment?.name).toBe('UPI-BLINKIT-2607011234');
  });

  it('counts every connected record, not just the page it returned', async () => {
    await acceptTheOfferedMatch();
    const second = await recordEvidenceNotification(database.db, {
      type: 'upi_notification',
      text: 'Rs.400.00 debited from A/C XX4821 on 02-Jul-26 to CAFE. UPI Ref no 2607029999.',
      capturedAt: new Date('2026-07-02T10:00:00Z'),
      audit: AS_USER,
    });
    const other = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(40000n),
      direction: 'debit',
      occurredAt: new Date('2026-07-02T00:00:00Z'),
      rawDescription: 'UPI-CAFE-2607029999',
      channel: 'upi',
    });
    await linkEvidence(database.db, {
      evidenceId: second.evidenceId,
      linkedPaymentId: other,
      audit: AS_USER,
    });

    const body = await links('?limit=1');
    expect(body.links).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(true);
  });
});
