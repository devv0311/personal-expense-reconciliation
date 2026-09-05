/**
 * Phase 17 — evidence enrichment and context re-attachment, against a real database.
 *
 * The scenarios ADR-0044 and `docs/roadmap.md` phase 17 name, in order: an exact reference
 * match, a missing reference, an amount/date match, bounded time skew, a same-amount
 * collision, an account mismatch, a direction mismatch, partial evidence, several records
 * enriching one payment, conflicting merchant signals, ambiguity, explicit linking, the
 * write-once guarantee, re-attachment to an already-linked record, repeated imports, repeated
 * matching, and the two things enrichment must never do — move an amount, or approve a
 * cash-flow interpretation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { paise } from '../../src/domain/index.js';
import type { EvidenceId, PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import {
  decideEvidenceMatch,
  getPaymentContext,
  linkEvidence,
  listEvidenceMatches,
  listReviewQueue,
  matchEvidenceContext,
  recordEvidenceNotification,
  recordEvidenceObservation,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const AS_USER = { actor: 'user', source: 'test' } as const;

/** The bank posts a date; the notification fires at the moment of the purchase. */
const PAYMENT_AT = new Date('2026-07-01T00:00:00Z');
const CAPTURED_AT = new Date('2026-07-01T19:04:00Z');

const BLINKIT_SMS =
  'Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26 to BLINKIT. UPI Ref no 2607011234.';

let database: TestDatabase;
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
});

/** The decayed statement line this whole pillar exists to repair. */
function addBlinkitPayment(overrides: Parameters<typeof addPayment>[2] | null = null) {
  return addPayment(
    database.db,
    cast,
    overrides ?? {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'upi',
      externalReference: 'UPI/2607011234/BLINKIT',
      referenceType: 'upi_utr',
    },
  );
}

function recordSms(text = BLINKIT_SMS, capturedAt = CAPTURED_AT) {
  return recordEvidenceNotification(database.db, {
    type: 'upi_notification',
    text,
    capturedAt,
    audit: AS_USER,
  });
}

function enrich(evidenceId: EvidenceId) {
  return matchEvidenceContext(database.db, { evidenceId, audit: AS_USER });
}

/** Every audit event in the ledger — the whole log, because "nothing was written" is the claim. */
function auditLog() {
  return database.db.select().from(schema.auditEvents);
}

/* ================================================================ recording evidence */

describe('recording a notification', () => {
  it('stores the text verbatim and the reading beside it', async () => {
    const result = await recordSms();

    expect(result.outcome).toBe('recorded');
    expect(result.observation).toMatchObject({
      observedAmount: 124_000n,
      observedDirection: 'debit',
      observedReference: '2607011234',
      observedReferenceType: 'upi_utr',
      observedAccountHint: '4821',
      observedMerchantText: 'BLINKIT',
      derivation: 'parsed_from_text',
    });

    const [row] = await database.db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.id, result.evidenceId));
    // SOURCE: the notification is stored exactly as it arrived, punctuation and all.
    expect(row?.rawText).toBe(BLINKIT_SMS);
    expect(row?.type).toBe('upi_notification');
    expect(row?.linkedPaymentId).toBeNull();
  });

  it('is idempotent: the same notification forwarded twice is one record', async () => {
    const first = await recordSms();
    const before = await auditLog();

    const second = await recordSms();

    expect(second.outcome).toBe('already_recorded');
    expect(second.evidenceId).toBe(first.evidenceId);
    const rows = await database.db.select().from(schema.evidence);
    expect(rows).toHaveLength(1);
    expect(await auditLog()).toHaveLength(before.length);
  });

  it('takes the caller’s structured fields over the parse, and says so', async () => {
    const result = await recordEvidenceNotification(database.db, {
      type: 'upi_notification',
      text: BLINKIT_SMS,
      capturedAt: CAPTURED_AT,
      observedOccurredAt: CAPTURED_AT,
      observedMerchantText: 'Blinkit',
      audit: AS_USER,
    });
    expect(result.observation.derivation).toBe('caller_supplied');
    expect(result.observation.observedMerchantText).toBe('Blinkit');
    expect(result.observation.observedOccurredAt).toEqual(CAPTURED_AT);
  });

  it('audits the evidence row and the observation as two records of one act', async () => {
    const result = await recordSms();
    const events = await auditLog();
    const kinds = events.map((event) => `${event.entityType}:${event.action}`);
    expect(kinds).toContain('evidence:create');
    expect(kinds).toContain('evidence_observation:create');
    expect(events.every((event) => event.actor === 'user')).toBe(true);
    expect(result.evidenceId).toBeDefined();
  });
});

describe('correcting a reading', () => {
  it('replaces the interpretation and leaves the source untouched', async () => {
    const { evidenceId } = await recordSms();

    const corrected = await recordEvidenceObservation(database.db, {
      evidenceId,
      observedMerchantText: 'Blinkit India',
      audit: AS_USER,
    });

    expect(corrected.outcome).toBe('updated');
    expect(corrected.observation.observedMerchantText).toBe('Blinkit India');
    const [row] = await database.db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.id, evidenceId));
    expect(row?.rawText).toBe(BLINKIT_SMS);
  });

  it('writes nothing when the correction says what is already recorded', async () => {
    const { evidenceId } = await recordSms();
    await recordEvidenceObservation(database.db, {
      evidenceId,
      observedMerchantText: 'Blinkit India',
      audit: AS_USER,
    });
    const before = await auditLog();

    const again = await recordEvidenceObservation(database.db, {
      evidenceId,
      observedMerchantText: 'Blinkit India',
      audit: AS_USER,
    });

    expect(again.outcome).toBe('unchanged');
    expect(await auditLog()).toHaveLength(before.length);
  });
});

/* ===================================================================== the matching */

describe('matching — an exact reference', () => {
  it('records one deterministic candidate with every signal explained', async () => {
    const paymentId = await addBlinkitPayment();
    const { evidenceId } = await recordSms();

    const result = await enrich(evidenceId);

    expect(result.outcome).toBe('matched');
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.paymentId).toBe(paymentId);
    expect(candidate.strength).toBe('deterministic');
    expect(candidate.confidence).toBe('high');
    expect(candidate.status).toBe('proposed');
    expect(candidate.conflictingSignals).toEqual([]);
    expect(candidate.matchedSignals).toContain('reference');
    expect(candidate.matchedSignals).toContain('amount');
    // Every signal keeps its verdict and both sides of the comparison.
    expect(candidate.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: 'reference', verdict: 'matched' }),
      ]),
    );
  });

  it('does not link it — a deterministic match is still a proposal', async () => {
    const { evidenceId } = await recordSms();
    await addBlinkitPayment();

    await enrich(evidenceId);

    const [row] = await database.db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.id, evidenceId));
    expect(row?.linkedPaymentId).toBeNull();
    expect((await listEvidenceMatches(database.db, evidenceId))[0]?.requiresReview).toBe(true);
  });

  it('matches a reference even when the payment sits outside the date window', async () => {
    // A UTR identifies a transaction whenever the evidence for it turned up.
    const paymentId = await addBlinkitPayment({
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: new Date('2026-05-01T00:00:00Z'),
      rawDescription: 'UPI-BLINKIT9821PAYTM',
      channel: 'upi',
      externalReference: 'UPI/2607011234/BLINKIT',
      referenceType: 'upi_utr',
    });
    const { evidenceId } = await recordSms();

    const result = await enrich(evidenceId);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.paymentId).toBe(paymentId);
    expect(result.candidates[0]?.conflictingSignals).toEqual(['time']);
    expect(result.candidates[0]?.strength).toBe('probable');
    expect(result.candidates[0]?.reviewReasons).toContain('conflicting_signals');
  });
});

describe('matching — no reference to go on', () => {
  const NO_REFERENCE_SMS = 'Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26 to BLINKIT.';

  it('falls back to amount, date and merchant', async () => {
    const paymentId = await addBlinkitPayment({
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
      channel: 'upi',
    });
    const { evidenceId } = await recordSms(NO_REFERENCE_SMS);

    const result = await enrich(evidenceId);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.paymentId).toBe(paymentId);
    expect(result.candidates[0]?.strength).toBe('probable');
    expect(result.candidates[0]?.matchedSignals).toContain('merchant');
  });

  it('offers every equally-supported payment and marks the set ambiguous', async () => {
    // The same-amount collision: two debits for the same figure on the same day.
    const first = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/990011',
      channel: 'upi',
    });
    const second = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/990012',
      channel: 'upi',
    });
    const { evidenceId } = await recordSms('Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26.');

    const result = await enrich(evidenceId);

    expect(result.ambiguous).toBe(true);
    expect(result.candidates.map((candidate) => candidate.paymentId).sort()).toEqual(
      [first, second].sort(),
    );
    for (const candidate of result.candidates) {
      expect(candidate.reviewReasons).toContain('ambiguous_candidates');
      // Probable rather than weak: the SMS's `A/C XX4821` corroborates the account, which is
      // exactly why the amount alone cannot pick between the two payments.
      expect(candidate.strength).toBe('probable');
    }
  });

  it('records no candidate when the movement went the other way', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'credit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'ACH REFUND SAMPLE',
      channel: 'bank_transfer',
    });
    const { evidenceId } = await recordSms(NO_REFERENCE_SMS);

    expect((await enrich(evidenceId)).candidates).toEqual([]);
  });

  it('records no candidate when the movement was on a different account', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_icici_credit_card']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'CARD PURCHASE BLINKIT',
      channel: 'card',
    });
    const { evidenceId } = await recordSms(NO_REFERENCE_SMS);

    // The SMS says A/C XX4821 (HDFC Savings); the payment landed on the card ending 9013.
    expect((await enrich(evidenceId)).candidates).toEqual([]);
  });
});

describe('matching — partial and conflicting evidence', () => {
  it('reports “nothing to match on” for evidence nobody has read', async () => {
    const [row] = await database.db
      .insert(schema.evidence)
      .values({
        type: 'upi_notification',
        rawText: 'Your order has shipped.',
        capturedAt: CAPTURED_AT,
      })
      .returning({ id: schema.evidence.id });

    const result = await matchEvidenceContext(database.db, {
      evidenceId: row!.id as EvidenceId,
      audit: AS_USER,
    });

    expect(result.outcome).toBe('no_observation');
    expect(result.candidates).toEqual([]);
  });

  it('reads a document nobody recorded a reading for, and matches nothing when nothing fits', async () => {
    // The write plan here is one observation and zero candidates. It must still commit — and
    // an audited unit of work that recorded nothing is rolled back by design (`audit.ts`), so
    // this is the shape that catches a plan whose only item silently did not happen.
    const [row] = await database.db
      .insert(schema.evidence)
      .values({
        type: 'bank_line',
        rawText: 'Rs.9,999.00 debited from A/C XX4821 on 01-Jul-26 to NOBODY.',
        capturedAt: CAPTURED_AT,
      })
      .returning({ id: schema.evidence.id });

    const result = await enrich(row!.id as EvidenceId);

    expect(result.outcome).toBe('matched');
    expect(result.candidates).toEqual([]);
    expect(result.observation?.observedAmount).toBe(999_900n);
  });

  it('reads two documents that say the same thing without one shutting the other out', async () => {
    // Two receipts for the same amount describe two purchases. A movement-shaped uniqueness
    // rule over every observation would have lost the second one's reading (ADR-0044).
    const rows = await database.db
      .insert(schema.evidence)
      .values([
        { type: 'bank_line', rawText: 'Rs.1,240.00 debited to BLINKIT.', capturedAt: CAPTURED_AT },
        { type: 'bank_line', rawText: 'Rs.1,240.00 debited to BLINKIT.', capturedAt: CAPTURED_AT },
      ])
      .returning({ id: schema.evidence.id });

    for (const row of rows) {
      const result = await enrich(row.id as EvidenceId);
      expect(result.observation?.observedAmount).toBe(124_000n);
    }
    expect(await database.db.select().from(schema.evidenceObservations)).toHaveLength(2);
  });

  it('keeps a candidate whose merchant disagrees, flagged rather than hidden', async () => {
    const merchantId = (
      await database.db
        .insert(schema.merchants)
        .values({ canonicalName: 'Zomato' })
        .returning({ id: schema.merchants.id })
    )[0]!.id;
    await addBlinkitPayment({
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/2607011234',
      channel: 'upi',
      externalReference: 'UPI/2607011234/ZOMATO',
      referenceType: 'upi_utr',
      counterpartyType: 'merchant',
      counterpartyId: merchantId,
    });
    const { evidenceId } = await recordSms();

    const result = await enrich(evidenceId);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.conflictingSignals).toEqual(['merchant']);
    expect(result.candidates[0]?.strength).toBe('probable');
    expect(result.candidates[0]?.confidence).toBe('low');
  });
});

/* ==================================================================== idempotency */

describe('repeated enrichment', () => {
  it('writes nothing at all on a re-run over an unchanged ledger', async () => {
    const { evidenceId } = await recordSms();
    await addBlinkitPayment();
    const first = await enrich(evidenceId);
    const auditBefore = await auditLog();
    const [rowBefore] = await database.db.select().from(schema.evidenceMatchCandidates);

    const second = await enrich(evidenceId);

    expect(second.outcome).toBe('unchanged');
    expect(second.candidates.map((c) => c.candidateId)).toEqual(
      first.candidates.map((c) => c.candidateId),
    );
    const rows = await database.db.select().from(schema.evidenceMatchCandidates);
    expect(rows).toHaveLength(1);
    // Not even a timestamp moves — `updated_at` is the evidence that nothing happened.
    expect(rows[0]?.updatedAt).toEqual(rowBefore?.updatedAt);
    expect(await auditLog()).toHaveLength(auditBefore.length);
  });

  it('records a new candidate when a later import brings one, without duplicating the old', async () => {
    const { evidenceId } = await recordSms('Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26.');
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/990011',
      channel: 'upi',
    });
    await enrich(evidenceId);

    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/990012',
      channel: 'upi',
    });
    const second = await enrich(evidenceId);

    expect(second.outcome).toBe('matched');
    expect(second.candidates).toHaveLength(2);
    expect(await database.db.select().from(schema.evidenceMatchCandidates)).toHaveLength(2);
  });

  it('supersedes a candidate the matcher no longer offers, rather than deleting it', async () => {
    const paymentId = await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    await enrich(evidenceId);

    // The payment turns out to be a duplicate and is taken out of the live set.
    await database.db
      .update(schema.payments)
      .set({ state: 'ignored', ignoredReason: 'out_of_scope' })
      .where(eq(schema.payments.id, paymentId));

    const result = await enrich(evidenceId);

    expect(result.outcome).toBe('matched');
    const rows = await database.db.select().from(schema.evidenceMatchCandidates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('superseded');
    expect(rows[0]?.decidedBy).toBeNull();
  });
});

/* ================================================================ linking decisions */

describe('accepting a candidate', () => {
  it('is the only thing that attaches the evidence, and audits both', async () => {
    const paymentId = await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    const [candidate] = (await enrich(evidenceId)).candidates;

    const result = await decideEvidenceMatch(database.db, {
      candidateId: candidate!.candidateId,
      decision: 'accept',
      audit: { actor: 'user:dev', source: 'test' },
    });

    expect(result.outcome).toBe('accepted');
    expect(result.evidence.linkedPaymentId).toBe(paymentId);
    expect(result.candidate.status).toBe('accepted');
    expect(result.candidate.decidedBy).toBe('user:dev');

    const events = await auditLog();
    const kinds = events.map((event) => `${event.entityType}:${event.action}`);
    expect(kinds).toContain('evidence:update');
    expect(kinds).toContain('evidence_match_candidate:update');
  });

  it('refuses an actor the audit trail could not attribute', async () => {
    await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    const [candidate] = (await enrich(evidenceId)).candidates;

    await expect(
      decideEvidenceMatch(database.db, {
        candidateId: candidate!.candidateId,
        decision: 'accept',
        audit: { actor: 'system', source: 'test' },
      }),
    ).rejects.toMatchObject({ code: 'DECISION_ACTOR_INVALID' });
  });

  it('supersedes the other offers, because the question has been answered', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/990011',
      channel: 'upi',
    });
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/990012',
      channel: 'upi',
    });
    const { evidenceId } = await recordSms('Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26.');
    const candidates = (await enrich(evidenceId)).candidates;
    expect(candidates).toHaveLength(2);

    await decideEvidenceMatch(database.db, {
      candidateId: candidates[0]!.candidateId,
      decision: 'accept',
      audit: AS_USER,
    });

    const after = await listEvidenceMatches(database.db, evidenceId);
    expect(after.map((candidate) => candidate.status).sort()).toEqual(['accepted', 'superseded']);
  });

  it('re-accepting the same link is a no-op, not a failure', async () => {
    await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    const [candidate] = (await enrich(evidenceId)).candidates;
    await decideEvidenceMatch(database.db, {
      candidateId: candidate!.candidateId,
      decision: 'accept',
      audit: AS_USER,
    });
    const before = await auditLog();

    const again = await decideEvidenceMatch(database.db, {
      candidateId: candidate!.candidateId,
      decision: 'accept',
      audit: AS_USER,
    });

    expect(again.outcome).toBe('unchanged');
    expect(await auditLog()).toHaveLength(before.length);
  });
});

describe('the write-once guarantee (ADR-0034)', () => {
  it('refuses to re-attach evidence that is already linked elsewhere', async () => {
    const other = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(50_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/000001',
      channel: 'upi',
    });
    await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    const [candidate] = (await enrich(evidenceId)).candidates;

    // A human attaches it somewhere else first, through phase 10's own route.
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: other, audit: AS_USER });

    await expect(
      decideEvidenceMatch(database.db, {
        candidateId: candidate!.candidateId,
        decision: 'accept',
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_LINK_IMMUTABLE' });

    const [row] = await database.db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.id, evidenceId));
    expect(row?.linkedPaymentId).toBe(other);
  });

  it('offers no candidates once the evidence has a home', async () => {
    const paymentId = await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_USER });

    const result = await enrich(evidenceId);

    expect(result.outcome).toBe('already_linked');
    expect(await database.db.select().from(schema.evidenceMatchCandidates)).toHaveLength(0);
  });
});

describe('dismissing a candidate', () => {
  it('records the judgement and stops the matcher re-offering it', async () => {
    await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    const [candidate] = (await enrich(evidenceId)).candidates;

    const dismissed = await decideEvidenceMatch(database.db, {
      candidateId: candidate!.candidateId,
      decision: 'dismiss',
      audit: { actor: 'user:dev', source: 'test' },
    });
    expect(dismissed.outcome).toBe('dismissed');
    expect(dismissed.evidence.linkedPaymentId).toBeNull();

    const auditBefore = await auditLog();
    const rerun = await enrich(evidenceId);

    expect(rerun.outcome).toBe('unchanged');
    expect((await listEvidenceMatches(database.db, evidenceId))[0]?.status).toBe('dismissed');
    expect(await auditLog()).toHaveLength(auditBefore.length);
  });

  it('refuses to decide a candidate twice', async () => {
    await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    const [candidate] = (await enrich(evidenceId)).candidates;
    await decideEvidenceMatch(database.db, {
      candidateId: candidate!.candidateId,
      decision: 'dismiss',
      audit: AS_USER,
    });

    await expect(
      decideEvidenceMatch(database.db, {
        candidateId: candidate!.candidateId,
        decision: 'accept',
        audit: AS_USER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

/* =============================================================== the re-attachment */

describe('the re-attached context', () => {
  async function attach(paymentId: PaymentId, text: string, capturedAt = CAPTURED_AT) {
    const { evidenceId } = await recordSms(text, capturedAt);
    const [candidate] = (await enrich(evidenceId)).candidates;
    await decideEvidenceMatch(database.db, {
      candidateId: candidate!.candidateId,
      decision: 'accept',
      audit: AS_USER,
    });
    return evidenceId;
  }

  it('puts the merchant back without touching the narration', async () => {
    const paymentId = await addBlinkitPayment();
    await attach(paymentId, BLINKIT_SMS);

    const { context } = await getPaymentContext(database.db, paymentId);

    expect(context.narration).toBe('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
    expect(context.merchantCandidates[0]?.value).toBe('BLINKIT');
    expect(context.references[0]?.value).toBe('2607011234');

    const [row] = await database.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId));
    expect(row?.rawDescription).toBe('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD');
    expect(row?.amount).toBe(124_000n);
  });

  it('lets several records enrich one movement rather than making two of it', async () => {
    const paymentId = await addBlinkitPayment();
    await attach(paymentId, BLINKIT_SMS);
    // A second source: the bank's own statement-line copy, attached directly.
    const second = await recordEvidenceNotification(database.db, {
      type: 'bank_line',
      text: 'Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26 to BLINKIT INDIA PVT LTD.',
      capturedAt: new Date('2026-07-02T09:00:00Z'),
      linkedPaymentId: paymentId,
      audit: AS_USER,
    });
    expect(second.outcome).toBe('recorded');

    const { context } = await getPaymentContext(database.db, paymentId);

    expect(context.sources).toHaveLength(2);
    expect(context.observedSourceCount).toBe(2);
    expect(await database.db.select().from(schema.payments)).toHaveLength(1);
  });
});

/* ============================================================= what must not happen */

describe('enrichment never moves money', () => {
  it('leaves the payment’s own facts and its cash-flow interpretation exactly as they were', async () => {
    const paymentId = await addBlinkitPayment();
    const [before] = await database.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId));
    const { evidenceId } = await recordSms();
    const [candidate] = (await enrich(evidenceId)).candidates;

    await decideEvidenceMatch(database.db, {
      candidateId: candidate!.candidateId,
      decision: 'accept',
      audit: AS_USER,
    });

    const [after] = await database.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId));
    expect(after).toEqual(before);
    // Specifically: matching a credit's evidence must never approve what that credit *was*.
    expect(after?.cashFlowState).toBe('imported');
    expect(after?.cashFlowCategory).toBeNull();
    expect(after?.cashFlowApprovedBy).toBeNull();
  });

  it('does not approve a credit’s cash-flow category by matching a refund notification', async () => {
    const creditId = await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(45_000n),
      direction: 'credit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'ACH REFUND SAMPLE ELECTRONICS STORE',
      channel: 'bank_transfer',
      externalReference: 'ACH/REF9981',
    });
    const { evidenceId } = await recordSms(
      'INR 450.00 credited to A/C XX4821 on 01-Jul-26 from SAMPLE ELECTRONICS STORE. ' +
        'UPI Ref no ACHREF9981.',
    );
    const [candidate] = (await enrich(evidenceId)).candidates;
    expect(candidate?.paymentId).toBe(creditId);

    await decideEvidenceMatch(database.db, {
      candidateId: candidate!.candidateId,
      decision: 'accept',
      audit: AS_USER,
    });

    const [row] = await database.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, creditId));
    // The evidence now explains the credit to a human. It does not classify it: that is
    // `services.classifyPaymentCashFlow` plus an explicit approval (ADR-0017 (cash balance)).
    expect(row?.cashFlowCategory).toBeNull();
    expect(row?.cashFlowState).toBe('imported');
  });
});

/* ================================================================= the review queue */

describe('the review queue', () => {
  it('surfaces an unattached notification with its reading and its candidates', async () => {
    await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    await enrich(evidenceId);

    const queue = await listReviewQueue(database.db, { kinds: ['unmatched_evidence'] });

    expect(queue.items).toHaveLength(1);
    const item = queue.items[0]!;
    expect(item.kind).toBe('unmatched_evidence');
    expect(item.id).toBe(evidenceId);
    // Its amount is known now — the observation read one off the notification.
    expect(item.amount).toBe(124_000n);
    if (item.kind !== 'unmatched_evidence') throw new Error('unreachable');
    expect(item.observation?.observedReference).toBe('2607011234');
    expect(item.matchCandidates).toHaveLength(1);
    expect(item.matchCandidates[0]?.strength).toBe('deterministic');
    expect(item.reasons).toEqual(['evidence_unmatched']);
  });

  it('says when the candidates are ambiguous or in conflict', async () => {
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/990011',
      channel: 'upi',
    });
    await addPayment(database.db, cast, {
      accountId: cast.account['account_hdfc_savings']!,
      amount: paise(124_000n),
      direction: 'debit',
      occurredAt: PAYMENT_AT,
      rawDescription: 'UPI/P2M/990012',
      channel: 'upi',
    });
    const { evidenceId } = await recordSms('Rs.1,240.00 debited from A/C XX4821 on 01-Jul-26.');
    await enrich(evidenceId);

    const queue = await listReviewQueue(database.db, { kinds: ['unmatched_evidence'] });

    expect(queue.items[0]?.reasons).toContain('evidence_match_ambiguous');
  });

  it('leaves an attached notification out of the queue', async () => {
    const paymentId = await addBlinkitPayment();
    const { evidenceId } = await recordSms();
    await linkEvidence(database.db, { evidenceId, linkedPaymentId: paymentId, audit: AS_USER });

    const queue = await listReviewQueue(database.db, { kinds: ['unmatched_evidence'] });
    expect(queue.items).toEqual([]);
  });
});
