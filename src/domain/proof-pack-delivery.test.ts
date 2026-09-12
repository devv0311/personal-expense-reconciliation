import { describe, expect, it } from 'vitest';

import {
  applyAttemptOutcome,
  assertAttachmentsPermitted,
  assertProviderStatusTransition,
  assertRetryable,
  assertReviewed,
  canonicalizeAddress,
  canRetryDelivery,
  deliveryIdempotencyKey,
  isAttachableEvidenceType,
  MAX_DELIVERY_ATTEMPTS,
} from './proof-pack-delivery.js';
import { isDomainError } from './errors.js';

const REVIEWED = {
  recipientConfirmed: true,
  contentConfirmed: true,
  evidenceConfirmed: true,
} as const;

describe('canonicalizeAddress', () => {
  it('accepts an E.164 number with or without its leading plus, and stores one form', () => {
    expect(canonicalizeAddress('whatsapp', '+919876543210')).toBe('+919876543210');
    expect(canonicalizeAddress('whatsapp', '919876543210')).toBe('+919876543210');
    expect(canonicalizeAddress('whatsapp', '  +91 9876543210 '.replace(/ /g, ''))).toBe(
      '+919876543210',
    );
  });

  it('refuses a local number rather than guessing a country code', () => {
    // Guessing +91 here would be guessing *who receives this* — the one thing a send must
    // never infer.
    expect(() => canonicalizeAddress('whatsapp', '9876543')).toThrowError(
      /international phone number/,
    );
  });

  it('refuses anything that is not digits', () => {
    expect(() => canonicalizeAddress('whatsapp', '+91-98765-43210')).toThrowError();
    expect(() => canonicalizeAddress('whatsapp', 'friend@example.test')).toThrowError();
  });
});

describe('assertReviewed', () => {
  it('passes only when all three confirmations are present', () => {
    expect(() => assertReviewed(REVIEWED)).not.toThrow();
  });

  it('names exactly which parts were not reviewed', () => {
    try {
      assertReviewed({ ...REVIEWED, contentConfirmed: false, evidenceConfirmed: false });
      expect.unreachable('an unreviewed pack must not be sendable');
    } catch (error) {
      expect(isDomainError(error) && error.code).toBe('PROOF_PACK_REVIEW_INCOMPLETE');
      expect((error as Error).message).toContain('what it says');
      expect((error as Error).message).toContain('which evidence it cites');
      expect((error as Error).message).not.toContain('who it is addressed to');
    }
  });
});

describe('attachment rules', () => {
  const receipt = {
    evidenceId: 'e1',
    evidenceType: 'receipt_image',
    hasStoredDocument: true,
    citedByPack: true,
  } as const;

  it('permits a cited, stored receipt', () => {
    expect(isAttachableEvidenceType('receipt_image')).toBe(true);
    expect(isAttachableEvidenceType('email_receipt')).toBe(true);
    expect(() => assertAttachmentsPermitted([receipt])).not.toThrow();
  });

  it('refuses a bank line, a notification, a screenshot and a private note by type', () => {
    for (const type of ['bank_line', 'upi_notification', 'screenshot', 'manual_note'] as const) {
      expect(isAttachableEvidenceType(type)).toBe(false);
      expect(() => assertAttachmentsPermitted([{ ...receipt, evidenceType: type }])).toThrowError(
        /never attachable/,
      );
    }
  });

  it('refuses a document the pack does not cite', () => {
    expect(() => assertAttachmentsPermitted([{ ...receipt, citedByPack: false }])).toThrowError(
      /not cited by this proof pack/,
    );
  });

  it('refuses an evidence row with no stored document rather than dropping it silently', () => {
    expect(() =>
      assertAttachmentsPermitted([{ ...receipt, hasStoredDocument: false }]),
    ).toThrowError(/no stored document/);
  });

  it('refuses the whole set when any one member fails', () => {
    expect(() =>
      assertAttachmentsPermitted([
        receipt,
        { ...receipt, evidenceId: 'e2', evidenceType: 'bank_line' },
      ]),
    ).toThrowError();
  });
});

describe('deliveryIdempotencyKey', () => {
  const base = {
    recipientPersonId: 'p1',
    channel: 'whatsapp',
    address: '+919876543210',
    contentDigest: 'abc',
    attachmentDigest: 'def',
  } as const;

  it('is stable for identical content', () => {
    expect(deliveryIdempotencyKey(base)).toBe(deliveryIdempotencyKey({ ...base }));
  });

  it('changes when the message changes', () => {
    expect(deliveryIdempotencyKey({ ...base, contentDigest: 'abd' })).not.toBe(
      deliveryIdempotencyKey(base),
    );
  });

  it('changes when the attachments change', () => {
    expect(deliveryIdempotencyKey({ ...base, attachmentDigest: 'deg' })).not.toBe(
      deliveryIdempotencyKey(base),
    );
  });

  it('changes when the recipient or address changes', () => {
    expect(deliveryIdempotencyKey({ ...base, recipientPersonId: 'p2' })).not.toBe(
      deliveryIdempotencyKey(base),
    );
    expect(deliveryIdempotencyKey({ ...base, address: '+919876543211' })).not.toBe(
      deliveryIdempotencyKey(base),
    );
  });
});

describe('applyAttemptOutcome', () => {
  const at = new Date('2026-09-12T10:00:00.000Z');

  it('records an acceptance as sent, with the provider id and the instant', () => {
    const change = applyAttemptOutcome(
      { attemptCount: 0, providerMessageId: null },
      { accepted: true, providerMessageId: 'wamid-1' },
      at,
    );
    expect(change).toEqual({
      status: 'sent',
      attemptCount: 1,
      lastError: null,
      providerMessageId: 'wamid-1',
      sentAt: at,
    });
  });

  it('records a refusal as failed, with its reason and no sent instant', () => {
    const change = applyAttemptOutcome(
      { attemptCount: 1, providerMessageId: null },
      { accepted: false, failureReason: 'That number is not on WhatsApp.' },
      at,
    );
    expect(change.status).toBe('failed');
    expect(change.attemptCount).toBe(2);
    expect(change.sentAt).toBeNull();
    expect(change.lastError).toBe('That number is not on WhatsApp.');
  });

  it('never leaves a failure without a reason', () => {
    const change = applyAttemptOutcome(
      { attemptCount: 0, providerMessageId: null },
      { accepted: false },
      at,
    );
    expect(change.lastError).not.toBeNull();
  });

  it('keeps a provider id across a later failure, so the two can still be connected', () => {
    const change = applyAttemptOutcome(
      { attemptCount: 1, providerMessageId: 'wamid-1' },
      { accepted: false, failureReason: 'Undeliverable.' },
      at,
    );
    expect(change.providerMessageId).toBe('wamid-1');
  });
});

describe('retry eligibility', () => {
  it('allows a retry only for a failed delivery under the attempt cap', () => {
    expect(canRetryDelivery({ status: 'failed', attemptCount: 1 })).toBe(true);
    expect(canRetryDelivery({ status: 'failed', attemptCount: MAX_DELIVERY_ATTEMPTS })).toBe(false);
    expect(canRetryDelivery({ status: 'sent', attemptCount: 1 })).toBe(false);
    expect(canRetryDelivery({ status: 'delivered', attemptCount: 1 })).toBe(false);
    expect(canRetryDelivery({ status: 'pending', attemptCount: 0 })).toBe(false);
  });

  it('refuses to re-send something that already went', () => {
    // The cure for "I am not sure it arrived" is a delivery status, not a second copy.
    expect(() => assertRetryable({ status: 'sent', attemptCount: 1 })).toThrowError(
      /in front of the recipient a second time/,
    );
  });

  it('refuses once the attempt cap is reached', () => {
    expect(() =>
      assertRetryable({ status: 'failed', attemptCount: MAX_DELIVERY_ATTEMPTS }),
    ).toThrowError(/which is the limit/);
  });
});

describe('assertProviderStatusTransition', () => {
  it('lets a provider confirm or fail a message this ledger handed over', () => {
    expect(() => assertProviderStatusTransition('sent', 'delivered')).not.toThrow();
    expect(() => assertProviderStatusTransition('sent', 'failed')).not.toThrow();
  });

  it('refuses to let an external system resurrect or rewrite anything else', () => {
    for (const from of ['pending', 'failed', 'delivered'] as const) {
      expect(() => assertProviderStatusTransition(from, 'delivered')).toThrowError(
        /cannot move a delivery/,
      );
    }
  });
});
