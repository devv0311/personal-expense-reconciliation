import { describe, expect, it } from 'vitest';

import { asId, paise } from '../domain/index.js';

import {
  REDACTED_NUMBER,
  REDACTED_UPI_ID,
  redactDescription,
  redactReceiptEvidenceForInference,
  redactReceiptText,
} from './redaction.js';
import { redactPaymentForInference } from './redaction.js';
import type {
  ClassifiablePayment,
  ClassifiableReceiptEvidence,
  ClassificationContext,
} from './redaction.js';

const PAYMENT: ClassifiablePayment = {
  amount: paise(124_000n),
  currency: 'INR',
  direction: 'debit',
  occurredAt: new Date('2026-07-01T00:00:00.000Z'),
  rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
  channel: 'upi',
  externalReference: 'UPI/2607011234/BLINKIT',
};

const CONTEXT: ClassificationContext = {
  merchant: {
    id: asId<'merchant'>('merchant-1'),
    canonicalName: 'Blinkit',
    defaultCategory: 'groceries',
  },
  knownPeople: [{ id: asId<'person'>('person-1'), displayName: 'Friend A' }],
};

describe('redactDescription', () => {
  it('masks an account fragment', () => {
    expect(redactDescription('NEFT TRANSFER TO SELF A/C X4821')).toBe(
      `NEFT TRANSFER TO SELF A/C X${REDACTED_NUMBER}`,
    );
  });

  it('masks a merchant-embedded number without losing the merchant', () => {
    expect(redactDescription('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD')).toBe(
      `UPI-BLINKIT${REDACTED_NUMBER}PAYTM-BLINKIT INDIA PVT LTD`,
    );
  });

  it('masks a UPI handle, and the hyphen-joined tokens leading into it', () => {
    // Greedy on purpose. A VPA's local part may itself contain hyphens, so stopping at the
    // first one would leave a fragment of the handle in the text. Losing "FRIENDA" costs a
    // little classification signal; leaking part of a UPI ID costs something that does not
    // grow back (security-model.md).
    expect(redactDescription('UPI-FRIENDA-friend.a@okhdfcbank')).toBe(REDACTED_UPI_ID);
    expect(redactDescription('PAID TO friend.a@okhdfcbank REF 12')).toBe(
      `PAID TO ${REDACTED_UPI_ID} REF 12`,
    );
  });

  it('masks a handle whose local part is a phone number, digits and all', () => {
    // The UPI pattern runs first precisely so this does not become
    // "[redacted-number]@okaxis" — a masked number next to an intact bank handle.
    expect(redactDescription('9876543210@okaxis')).toBe(REDACTED_UPI_ID);
  });

  it('leaves short digit runs alone — they identify nobody', () => {
    expect(redactDescription('BBPS BILLPAY JUL 26')).toBe('BBPS BILLPAY JUL 26');
  });

  it('masks every occurrence, not just the first', () => {
    expect(redactDescription('CARD 4111 1111 1111 1111 PURCHASE')).toBe(
      `CARD ${REDACTED_NUMBER} ${REDACTED_NUMBER} ${REDACTED_NUMBER} ${REDACTED_NUMBER} PURCHASE`,
    );
  });

  it('trims, so a padded description does not travel with its padding', () => {
    expect(redactDescription('  ELECTRICITY BOARD BBPS BILLPAY  ')).toBe(
      'ELECTRICITY BOARD BBPS BILLPAY',
    );
  });
});

describe('redactPaymentForInference', () => {
  it('never sends the external reference, in any field', () => {
    // ADR-0010's amendment to the security model: a UTR/RRN is an identifier of the same
    // sensitivity class as an account number.
    const redacted = redactPaymentForInference(PAYMENT, CONTEXT);

    expect(JSON.stringify(redacted)).not.toContain('UPI/2607011234/BLINKIT');
    expect(Object.keys(redacted)).not.toContain('externalReference');
  });

  it('sends the resolved merchant rather than relying on the raw statement line', () => {
    const redacted = redactPaymentForInference(PAYMENT, CONTEXT);

    expect(redacted.merchantName).toBe('Blinkit');
    expect(redacted.merchantCategory).toBe('groceries');
    expect(redacted.description).not.toContain('9821');
  });

  it('carries the amount as an exact string, never a float', () => {
    const redacted = redactPaymentForInference(PAYMENT, CONTEXT);

    expect(redacted.amountMinorUnits).toBe('124000');
    expect(typeof redacted.amountMinorUnits).toBe('string');
  });

  it('carries the counterparty candidates a proposal may name', () => {
    const redacted = redactPaymentForInference(PAYMENT, CONTEXT);

    expect(redacted.counterpartyCandidates).toEqual([{ id: 'person-1', displayName: 'Friend A' }]);
  });

  it('sends nulls, not absent keys, when nothing was resolved', () => {
    const redacted = redactPaymentForInference(PAYMENT, { merchant: null, knownPeople: [] });

    expect(redacted.merchantName).toBeNull();
    expect(redacted.merchantCategory).toBeNull();
    expect(redacted.counterpartyCandidates).toEqual([]);
  });

  it('sends only the fields the contract defines', () => {
    // The payload is a closed shape: there is no field for an account id or a payment id to
    // occupy, so omitting them is not a step a future caller can forget.
    expect(Object.keys(redactPaymentForInference(PAYMENT, CONTEXT)).sort()).toEqual([
      'amountMinorUnits',
      'channel',
      'counterpartyCandidates',
      'currency',
      'description',
      'direction',
      'merchantCategory',
      'merchantName',
      'occurredAt',
    ]);
  });
});

describe('redactReceiptText — narrower than redactDescription on purpose', () => {
  it('leaves prices, quantities and dates alone — they are the signal, not an identifier', () => {
    const receipt =
      'Sample Restaurant\n2 x Chicken Biryani  Rs 620.00\nSubtotal 2500.00\nTax 200.00\n' +
      'Total 2700.00\nDate: 16/07/2026';
    expect(redactReceiptText(receipt)).toBe(receipt);
  });

  it('masks a labelled card/account/loyalty/contact number', () => {
    // The separator between the keyword and the digits (":", "#", a space) is consumed by the
    // match along with the digits themselves — only the keyword survives, unadorned.
    expect(redactReceiptText('Card: 4111 1111 1111 1111')).toBe(`Card${REDACTED_NUMBER}`);
    expect(redactReceiptText('A/C 400123456789')).toBe(`A/C${REDACTED_NUMBER}`);
    expect(redactReceiptText('Member #98765432')).toBe(`Member${REDACTED_NUMBER}`);
    expect(redactReceiptText('Phone: 9876543210')).toBe(`Phone${REDACTED_NUMBER}`);
  });

  it('masks a UPI handle printed on a receipt footer', () => {
    expect(redactReceiptText('Scan to pay: samplerestaurant@okhdfcbank')).toBe(
      `Scan to pay: ${REDACTED_UPI_ID}`,
    );
  });

  it('trims, exactly as redactDescription does', () => {
    expect(redactReceiptText('  Total 2700.00  ')).toBe('Total 2700.00');
  });
});

describe('redactReceiptEvidenceForInference', () => {
  const EVIDENCE: ClassifiableReceiptEvidence = {
    evidenceType: 'receipt_image',
    mediaType: 'image/jpeg',
    rawText: null,
    capturedAt: new Date('2026-07-16T20:05:00.000Z'),
  };

  it('carries the evidence type, media type and captured date through untouched', () => {
    const redacted = redactReceiptEvidenceForInference(EVIDENCE);
    expect(redacted.evidenceType).toBe('receipt_image');
    expect(redacted.mediaType).toBe('image/jpeg');
    expect(redacted.capturedAt).toBe('2026-07-16T20:05:00.000Z');
  });

  it('sends null rawText as null, not as an absent key', () => {
    expect(redactReceiptEvidenceForInference(EVIDENCE).rawText).toBeNull();
  });

  it('redacts rawText when the caller has some', () => {
    const withText = { ...EVIDENCE, rawText: 'Card: 4111 1111 1111 1111  Total 2700.00' };
    expect(redactReceiptEvidenceForInference(withText).rawText).toBe(
      `Card${REDACTED_NUMBER}  Total 2700.00`,
    );
  });

  it('sends only the fields the contract defines', () => {
    expect(Object.keys(redactReceiptEvidenceForInference(EVIDENCE)).sort()).toEqual([
      'capturedAt',
      'evidenceType',
      'mediaType',
      'rawText',
    ]);
  });
});
