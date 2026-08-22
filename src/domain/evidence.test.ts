import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import {
  assertEvidenceLinkOnce,
  claimsSettlement,
  evidenceMediaTypeForExtension,
  extensionForEvidenceMediaType,
  parseEvidenceMediaType,
  validateEvidenceNoteKind,
  validateEvidencePayload,
} from './evidence.js';
import type { EvidencePayloadFields } from './evidence.js';

/**
 * ADR-0018. `Evidence{type: manual_note, linked_expense_id}` used to carry two opposite
 * meanings — documenting an externally-funded expense (ADR-0006) and claiming a debt was
 * cleared (ADR-0014) — with nothing distinguishing them. `note_kind` is that distinction,
 * and these are the rules that keep it meaningful.
 */

describe('validateEvidenceNoteKind — a manual note must say which kind it is', () => {
  it.each(['documentation', 'settlement_claim'] as const)(
    'accepts a manual note kinded %s',
    (noteKind) => {
      expect(() => validateEvidenceNoteKind('manual_note', noteKind)).not.toThrow();
    },
  );

  it('rejects a manual note with no kind, rather than defaulting one', () => {
    let raised: DomainError | undefined;
    try {
      validateEvidenceNoteKind('manual_note', null);
    } catch (error) {
      raised = error as DomainError;
    }

    expect(raised?.code).toBe('EVIDENCE_NOTE_KIND_INVALID');
    expect(raised?.message).toMatch(/documentation|settlement_claim/);
  });

  it('explains why a default would be unsafe', () => {
    // Defaulting to `documentation` would silently drop a settlement claim; defaulting to
    // `settlement_claim` would mark every documented expense settled. Neither is acceptable,
    // so the caller has to say.
    expect(() => validateEvidenceNoteKind('manual_note', null)).toThrow(/cannot be inferred/i);
  });
});

describe('validateEvidenceNoteKind — nothing but a manual note may carry one', () => {
  it.each([
    'bank_line',
    'upi_notification',
    'receipt_image',
    'screenshot',
    'email_receipt',
  ] as const)('accepts %s with no note kind', (type) => {
    expect(() => validateEvidenceNoteKind(type, null)).not.toThrow();
  });

  it.each(['bank_line', 'receipt_image'] as const)(
    'rejects %s that claims to be a settlement claim',
    (type) => {
      expect(() => validateEvidenceNoteKind(type, 'settlement_claim')).toThrow(DomainError);
    },
  );

  it('rejects a receipt image pretending to be documentation-kinded', () => {
    expect(() => validateEvidenceNoteKind('receipt_image', 'documentation')).toThrow(
      /only a manual note/i,
    );
  });
});

describe('claimsSettlement — the predicate Balance reads', () => {
  it('is true only for a settlement-claim manual note', () => {
    expect(claimsSettlement({ type: 'manual_note', noteKind: 'settlement_claim' })).toBe(true);
  });

  it('is false for an ordinary documenting note — the ADR-0018 regression', () => {
    // This is the exact row ADR-0006 produces for every externally-funded expense.
    expect(claimsSettlement({ type: 'manual_note', noteKind: 'documentation' })).toBe(false);
  });

  it('is false for every non-note evidence type', () => {
    expect(claimsSettlement({ type: 'receipt_image', noteKind: null })).toBe(false);
    expect(claimsSettlement({ type: 'bank_line', noteKind: null })).toBe(false);
  });

  it('is false when the kind is missing, rather than guessing', () => {
    expect(claimsSettlement({ type: 'manual_note', noteKind: null })).toBe(false);
  });
});

/* ---------------------------------------------------------------------- media types */

describe('parseEvidenceMediaType — an allowlist, not a guess', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'] as const)(
    'accepts %s',
    (mediaType) => {
      expect(parseEvidenceMediaType(mediaType)).toBe(mediaType);
    },
  );

  it('tolerates the two shapes a real Content-Type header arrives in', () => {
    expect(parseEvidenceMediaType('IMAGE/JPEG')).toBe('image/jpeg');
    expect(parseEvidenceMediaType('image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(parseEvidenceMediaType('  image/png  ')).toBe('image/png');
  });

  it.each(['application/octet-stream', 'text/html', 'image/svg+xml', ''])(
    'refuses %s rather than storing bytes nothing can open',
    (mediaType) => {
      let raised: DomainError | undefined;
      try {
        parseEvidenceMediaType(mediaType);
      } catch (error) {
        raised = error as DomainError;
      }
      expect(raised?.code).toBe('EVIDENCE_MEDIA_TYPE_UNSUPPORTED');
    },
  );

  it('maps every accepted type to an extension and back', () => {
    for (const mediaType of ['image/jpeg', 'application/pdf'] as const) {
      const extension = extensionForEvidenceMediaType(mediaType);
      expect(evidenceMediaTypeForExtension(extension)).toBe(mediaType);
    }
  });

  it('does not invent a media type for an extension it does not store', () => {
    expect(evidenceMediaTypeForExtension('exe')).toBeNull();
  });
});

/* ------------------------------------------------------------------------- ingestion */

const storedReceipt: EvidencePayloadFields = {
  type: 'receipt_image',
  noteKind: null,
  storageRef: 'sha256/ab/cd/abcd.jpg',
  mediaType: 'image/jpeg',
  byteSize: 20_481,
  rawText: null,
};

const typedNote: EvidencePayloadFields = {
  type: 'manual_note',
  noteKind: 'documentation',
  storageRef: null,
  mediaType: null,
  byteSize: null,
  rawText: 'Flatmate A paid the electrician, split three ways',
};

describe('validateEvidencePayload — a row must carry the evidence it claims to', () => {
  it('accepts a stored document and a typed note', () => {
    expect(() => validateEvidencePayload(storedReceipt)).not.toThrow();
    expect(() => validateEvidencePayload(typedNote)).not.toThrow();
  });

  it('accepts a bank line that is text with no file', () => {
    expect(() =>
      validateEvidencePayload({
        type: 'bank_line',
        noteKind: null,
        storageRef: null,
        mediaType: null,
        byteSize: null,
        rawText: 'UPI-BLINKIT9821PAYTM',
      }),
    ).not.toThrow();
  });

  it('refuses a note that carries a file — that is a receipt_image or a screenshot', () => {
    expect(() =>
      validateEvidencePayload({ ...typedNote, storageRef: 'sha256/ab/cd/abcd.jpg' }),
    ).toThrow(/manual note/i);
  });

  it.each([
    ['a document with no media type', { mediaType: null }],
    ['a media type with no document', { storageRef: null, byteSize: null }],
    ['a document with no byte size', { byteSize: null }],
  ])('refuses %s', (_label, override) => {
    let raised: DomainError | undefined;
    try {
      validateEvidencePayload({ ...storedReceipt, ...override });
    } catch (error) {
      raised = error as DomainError;
    }
    expect(raised?.code).toBe('EVIDENCE_PAYLOAD_INVALID');
  });

  it.each([0, -1, 1.5])('refuses a byte size of %s', (byteSize) => {
    expect(() => validateEvidencePayload({ ...storedReceipt, byteSize })).toThrow(DomainError);
  });

  it('refuses a row with neither a document nor text', () => {
    expect(() =>
      validateEvidencePayload({
        type: 'screenshot',
        noteKind: null,
        storageRef: null,
        mediaType: null,
        byteSize: null,
        rawText: '   ',
      }),
    ).toThrow(/supports no claim|no content|empty/i);
  });

  it('still enforces the note-kind rule (ADR-0018)', () => {
    let raised: DomainError | undefined;
    try {
      validateEvidencePayload({ ...typedNote, noteKind: null });
    } catch (error) {
      raised = error as DomainError;
    }
    expect(raised?.code).toBe('EVIDENCE_NOTE_KIND_INVALID');
  });
});

/* --------------------------------------------------------------------------- linkage */

describe('assertEvidenceLinkOnce — fill in later, never rewrite', () => {
  const unlinked = { linkedPaymentId: null, linkedExpenseId: null };
  const linked = { linkedPaymentId: 'payment-1', linkedExpenseId: null };

  it('allows an unlinked receipt to be attached once', () => {
    expect(() => assertEvidenceLinkOnce(unlinked, linked)).not.toThrow();
  });

  it('allows the other side to be filled in without disturbing the first', () => {
    expect(() =>
      assertEvidenceLinkOnce(linked, { ...linked, linkedExpenseId: 'expense-1' }),
    ).not.toThrow();
  });

  it('allows an idempotent re-link to the same target', () => {
    expect(() => assertEvidenceLinkOnce(linked, { ...linked })).not.toThrow();
  });

  it('refuses to re-point a link at a different payment', () => {
    let raised: DomainError | undefined;
    try {
      assertEvidenceLinkOnce(linked, { ...linked, linkedPaymentId: 'payment-2' });
    } catch (error) {
      raised = error as DomainError;
    }
    expect(raised?.code).toBe('EVIDENCE_LINK_IMMUTABLE');
    expect(raised?.message).toMatch(/superseding/i);
  });

  it('refuses to clear a link, which would orphan anything extracted from it', () => {
    expect(() => assertEvidenceLinkOnce(linked, { ...linked, linkedPaymentId: null })).toThrow(
      /orphan/i,
    );
  });
});
