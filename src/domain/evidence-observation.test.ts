import { describe, expect, it } from 'vitest';

import {
  notificationDedupeKey,
  normalizeReference,
  parseNotificationText,
  referencesMatch,
  validateEvidenceObservation,
} from './evidence-observation.js';
import type { EvidenceObservationFields } from './evidence-observation.js';
import { isDomainError } from './errors.js';
import type { Paise } from './money.js';

const DEBIT_SMS =
  'Rs.450.00 debited from A/C XX4821 on 05-Jul-26 to SWIGGY. UPI Ref no 402312345678.';

const CREDIT_SMS =
  'INR 450.00 credited to A/C XX4821 on 08-Jul-26 from SAMPLE ELECTRONICS STORE. ' +
  'UPI Ref no 260705112233.';

function fields(overrides: Partial<EvidenceObservationFields> = {}): EvidenceObservationFields {
  return {
    observedAmount: 45000n as Paise,
    observedDirection: 'debit',
    observedReference: '402312345678',
    observedReferenceType: 'upi_utr',
    observedAccountHint: '4821',
    observedMerchantText: 'SWIGGY',
    observedOccurredAt: null,
    derivation: 'parsed_from_text',
    ...overrides,
  };
}

describe('parseNotificationText', () => {
  it('reads amount, direction, reference, account tail and merchant off a debit SMS', () => {
    expect(parseNotificationText(DEBIT_SMS)).toEqual({
      observedAmount: 45000n,
      observedDirection: 'debit',
      observedReference: '402312345678',
      observedReferenceType: 'upi_utr',
      observedAccountHint: '4821',
      observedMerchantText: 'SWIGGY',
    });
  });

  it('reads a credit the same way, without inferring the direction from the merchant', () => {
    const parsed = parseNotificationText(CREDIT_SMS);
    expect(parsed.observedDirection).toBe('credit');
    expect(parsed.observedAmount).toBe(45000n);
    expect(parsed.observedMerchantText).toBe('SAMPLE ELECTRONICS STORE');
  });

  it('converts major units exactly, never through a float', () => {
    // 1240.15 * 100 is 124014.99999999999 in IEEE 754. String arithmetic is why this is exact.
    expect(parseNotificationText('Rs 1,240.15 debited').observedAmount).toBe(124015n);
    expect(parseNotificationText('INR 2100 debited').observedAmount).toBe(210000n);
    expect(parseNotificationText('₹ 99.5 debited').observedAmount).toBe(9950n);
  });

  it('refuses to pick a direction when the text says both', () => {
    const parsed = parseNotificationText('Refund of Rs.450.00 credited against your debit card');
    expect(parsed.observedDirection).toBeNull();
  });

  it('returns nulls for what a notification does not say, rather than guessing', () => {
    expect(parseNotificationText('Your order has shipped.')).toEqual({
      observedAmount: null,
      observedDirection: null,
      observedReference: null,
      observedReferenceType: null,
      observedAccountHint: null,
      observedMerchantText: null,
    });
  });

  it('labels the reference type from the label the bank used', () => {
    expect(parseNotificationText('UTR 260701123499 debited').observedReferenceType).toBe('upi_utr');
    expect(parseNotificationText('RRN: 500123456789 debited').observedReferenceType).toBe(
      'upi_rrn',
    );
    expect(parseNotificationText('Order ID BLK-99213 debited').observedReferenceType).toBe(
      'merchant_order_id',
    );
  });

  it('reads a masked card tail as the account hint', () => {
    expect(parseNotificationText('Rs.2700 spent on Card XX9013').observedAccountHint).toBe('9013');
  });
});

describe('normalizeReference', () => {
  it('strips the bank’s packaging so one UTR has one key', () => {
    expect(normalizeReference('UPI/2607011234/BLINKIT')).toBe('UPI2607011234BLINKIT');
    expect(normalizeReference('upi-2607011234')).toBe('UPI2607011234');
  });

  it('treats a punctuation-only reference as no reference at all', () => {
    expect(normalizeReference('///')).toBeNull();
    expect(normalizeReference('')).toBeNull();
    expect(normalizeReference(null)).toBeNull();
  });
});

describe('referencesMatch', () => {
  it('matches a bare UTR against the same UTR wrapped in a statement reference', () => {
    expect(referencesMatch('2607011234', 'UPI/2607011234/BLINKIT')).toBe(true);
  });

  it('does not match two different transactions', () => {
    expect(referencesMatch('2607011234', 'UPI/2607031122/ZOMATO')).toBe(false);
  });

  it('never matches when either side is absent — silence is not agreement', () => {
    expect(referencesMatch(null, 'UPI/2607011234/BLINKIT')).toBe(false);
    expect(referencesMatch('2607011234', null)).toBe(false);
  });

  it('refuses to match on a fragment too short to identify anything', () => {
    expect(referencesMatch('1234', 'UPI/2607011234/BLINKIT')).toBe(false);
  });
});

describe('validateEvidenceObservation', () => {
  it('accepts a partial reading — most notifications are partial', () => {
    expect(() =>
      validateEvidenceObservation(
        fields({
          observedReference: null,
          observedReferenceType: null,
          observedAccountHint: null,
          observedMerchantText: null,
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a reading that read nothing', () => {
    let thrown: unknown;
    try {
      validateEvidenceObservation({
        observedAmount: null,
        observedDirection: null,
        observedReference: null,
        observedReferenceType: null,
        observedAccountHint: null,
        observedMerchantText: null,
        observedOccurredAt: null,
        derivation: 'parsed_from_text',
      });
    } catch (error) {
      thrown = error;
    }
    expect(isDomainError(thrown) && thrown.code).toBe('EVIDENCE_OBSERVATION_EMPTY');
  });

  it('refuses anything longer than a masked account tail', () => {
    let thrown: unknown;
    try {
      validateEvidenceObservation(fields({ observedAccountHint: '4111111111114821' }));
    } catch (error) {
      thrown = error;
    }
    expect(isDomainError(thrown) && thrown.code).toBe('EVIDENCE_OBSERVATION_INVALID');
  });

  it('refuses a non-positive amount — direction carries the sign, never the amount', () => {
    let thrown: unknown;
    try {
      validateEvidenceObservation(fields({ observedAmount: 0n as Paise }));
    } catch (error) {
      thrown = error;
    }
    expect(isDomainError(thrown) && thrown.code).toBe('EVIDENCE_OBSERVATION_INVALID');
  });
});

describe('notificationDedupeKey', () => {
  const base = {
    evidenceType: 'upi_notification',
    capturedAt: new Date('2026-07-05T20:12:00Z'),
    rawText: DEBIT_SMS,
  };

  it('is identical for the same notification forwarded twice', () => {
    expect(notificationDedupeKey({ ...base, fields: fields() })).toBe(
      notificationDedupeKey({ ...base, fields: fields() }),
    );
  });

  it('sees through the bank’s packaging on the reference', () => {
    expect(
      notificationDedupeKey({
        ...base,
        fields: fields({ observedReference: 'UPI/402312345678' }),
      }),
    ).not.toBe(notificationDedupeKey({ ...base, fields: fields() }));
    // …but the normalized form is what is compared, so punctuation alone does not fork it.
    expect(
      notificationDedupeKey({
        ...base,
        fields: fields({ observedReference: '4023-1234-5678' }),
      }),
    ).toBe(notificationDedupeKey({ ...base, fields: fields() }));
  });

  it('separates the same movement observed by two different kinds of evidence', () => {
    expect(
      notificationDedupeKey({ ...base, evidenceType: 'bank_line', fields: fields() }),
    ).not.toBe(notificationDedupeKey({ ...base, fields: fields() }));
  });

  it('falls back to the text when nothing identifying was read', () => {
    const unidentified = fields({
      observedAmount: null,
      observedReference: null,
      observedReferenceType: null,
    });
    const key = notificationDedupeKey({ ...base, fields: unidentified });
    expect(key).toContain('RS.450.00 DEBITED');
    expect(
      notificationDedupeKey({ ...base, rawText: 'something else', fields: unidentified }),
    ).not.toBe(key);
  });
});
