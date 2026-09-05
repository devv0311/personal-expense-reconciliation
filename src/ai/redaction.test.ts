import { describe, expect, it } from 'vitest';

import { asId, deriveReattachedContext, paise } from '../domain/index.js';

import { isSanitizationError } from './errors.js';
import {
  REDACTED_NUMBER,
  REDACTED_UPI_ID,
  assertPayloadSanitized,
  createLocalRedactionMap,
  findResidualIdentifiers,
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
      'reattachedMerchantHints',
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

/* ================================================== phase 17: the fail-closed boundary */

describe('findResidualIdentifiers', () => {
  it('finds a UPI handle or an email in statement text', () => {
    expect(findResidualIdentifiers('paid swiggy@icici', 'statement_text')).toContain(
      'upi_id_or_email',
    );
    expect(findResidualIdentifiers('contact dev@example.test', 'receipt_text')).toContain(
      'upi_id_or_email',
    );
  });

  it('finds a mobile number and a card number in either kind of text', () => {
    expect(findResidualIdentifiers('call 9876543210', 'receipt_text')).toContain('phone_number');
    expect(findResidualIdentifiers('4111 1111 1111 1111', 'receipt_text')).toContain(
      'card_or_account_number',
    );
  });

  it('refuses a bare digit run in statement text but allows one in receipt text', () => {
    // A statement line's long digit run is almost always an account fragment; a receipt's is a
    // price, a quantity or a date, and refusing those would refuse every receipt.
    expect(findResidualIdentifiers('A/C X4821', 'statement_text')).toContain('long_digit_run');
    expect(findResidualIdentifiers('Total 2700.00', 'receipt_text')).toEqual([]);
  });

  it('checks nothing in a structural field, whose shape is what protects it', () => {
    expect(findResidualIdentifiers('2026-07-01T00:00:00.000Z', 'structural')).toEqual([]);
  });
});

describe('assertPayloadSanitized', () => {
  it('passes a payload the redactors actually produced', () => {
    expect(() =>
      assertPayloadSanitized(redactPaymentForInference(PAYMENT, CONTEXT), 'test'),
    ).not.toThrow();
  });

  it('fails closed on an unredacted account fragment, naming the field and not the value', () => {
    let thrown: unknown;
    try {
      assertPayloadSanitized({ description: 'NEFT TO SELF A/C X4821' }, 'test');
    } catch (error) {
      thrown = error;
    }
    expect(isSanitizationError(thrown)).toBe(true);
    expect(isSanitizationError(thrown) && thrown.details['field']).toBe('description');
    // An error about a leak must not itself be the leak.
    expect(String(thrown)).not.toContain('4821');
  });

  it('walks nested objects and arrays, so a new field cannot slip through unchecked', () => {
    expect(() =>
      assertPayloadSanitized({ counterpartyCandidates: [{ displayName: 'swiggy@icici' }] }, 'test'),
    ).toThrow();
    expect(() =>
      assertPayloadSanitized({ reattachedMerchantHints: ['9876543210'] }, 'test'),
    ).toThrow();
  });

  it('does not trip on the structural fields every payload carries', () => {
    expect(() =>
      assertPayloadSanitized(
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          amountMinorUnits: '124000',
          occurredAt: '2026-07-01T00:00:00.000Z',
          capturedAt: '2026-07-01T00:00:00.000Z',
          currency: 'INR',
        },
        'test',
      ),
    ).not.toThrow();
  });

  it('refuses to send rather than dropping the offending field', () => {
    // The whole point of failing closed: a partially-sanitized payload minus one field would
    // go out, and nobody would ever learn that it had.
    const payload = { description: 'contact 9876543210', channel: 'upi' };
    expect(() => assertPayloadSanitized(payload, 'test')).toThrow();
    expect(payload.description).toBe('contact 9876543210');
  });
});

describe('redactPaymentForInference — re-attached context (phase 17)', () => {
  const CONTEXT_PAYMENT = {
    paymentId: 'payment-1',
    amount: paise(124_000n),
    direction: 'debit' as const,
    occurredAt: new Date('2026-07-01T00:00:00.000Z'),
    rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    externalReference: 'UPI/2607011234/BLINKIT',
    merchantName: null,
  };

  function contextWith(merchantText: string) {
    return deriveReattachedContext(CONTEXT_PAYMENT, [
      {
        evidenceId: 'evidence-1',
        evidenceType: 'upi_notification',
        capturedAt: new Date('2026-07-01T19:00:00.000Z'),
        observation: {
          observedAmount: paise(124_000n),
          observedDirection: 'debit',
          observedReference: '2607011234',
          observedReferenceType: 'upi_utr',
          observedAccountHint: '4821',
          observedMerchantText: merchantText,
          observedOccurredAt: new Date('2026-07-01T19:00:00.000Z'),
          derivation: 'parsed_from_text',
        },
      },
    ]);
  }

  it('sends an empty hint list when nothing is attached', () => {
    expect(redactPaymentForInference(PAYMENT, CONTEXT).reattachedMerchantHints).toEqual([]);
  });

  it('sends the merchant a linked notification named, which the narration lost', () => {
    const redacted = redactPaymentForInference(PAYMENT, {
      ...CONTEXT,
      merchant: null,
      reattachedContext: contextWith('Blinkit'),
    });
    expect(redacted.reattachedMerchantHints).toEqual(['Blinkit']);
  });

  it('sends none of the identifiers the same context also holds', () => {
    const redacted = redactPaymentForInference(PAYMENT, {
      ...CONTEXT,
      reattachedContext: contextWith('Blinkit'),
    });
    const serialized = JSON.stringify(redacted);
    // The reference, the account tail and the payment's own external reference all stay local.
    expect(serialized).not.toContain('2607011234');
    expect(serialized).not.toContain('4821');
    expect(serialized).not.toContain('UPI/2607011234/BLINKIT');
  });

  it('redacts a VPA that arrived as a merchant name', () => {
    const redacted = redactPaymentForInference(PAYMENT, {
      ...CONTEXT,
      reattachedContext: contextWith('swiggy@icici'),
    });
    expect(redacted.reattachedMerchantHints).toEqual([REDACTED_UPI_ID]);
  });
});

describe('createLocalRedactionMap', () => {
  it('keeps the originals locally and reconstructs them exactly', () => {
    const map = createLocalRedactionMap();
    const redacted = redactDescription('UPI-BLINKIT9821PAYTM to swiggy@icici', map);
    expect(redacted).toBe(`UPI-BLINKIT${REDACTED_NUMBER}PAYTM to ${REDACTED_UPI_ID}`);
    expect(map.reidentify(redacted)).toBe('UPI-BLINKIT9821PAYTM to swiggy@icici');
  });

  it('restores several occurrences of one placeholder in order', () => {
    const map = createLocalRedactionMap();
    const redacted = redactDescription('A/C 4821 to A/C 9013', map);
    expect(redacted).toBe(`A/C ${REDACTED_NUMBER} to A/C ${REDACTED_NUMBER}`);
    expect(map.reidentify(redacted)).toBe('A/C 4821 to A/C 9013');
  });

  it('is a separate object, so a serialized payload cannot carry it', () => {
    const map = createLocalRedactionMap();
    const redacted = redactPaymentForInference(PAYMENT, CONTEXT, { redactionMap: map });
    expect(map.entries.size).toBeGreaterThan(0);
    expect(JSON.stringify(redacted)).not.toContain('9821');
    expect(Object.keys(redacted)).not.toContain('entries');
  });

  it('does not change what leaves the machine — the same payload either way', () => {
    expect(
      redactPaymentForInference(PAYMENT, CONTEXT, { redactionMap: createLocalRedactionMap() }),
    ).toEqual(redactPaymentForInference(PAYMENT, CONTEXT));
  });

  it('is scoped per call: a fresh map holds nothing from the last one', () => {
    redactDescription('A/C 4821', createLocalRedactionMap());
    expect(createLocalRedactionMap().entries.size).toBe(0);
  });
});
