import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { claimsSettlement, validateEvidenceNoteKind } from './evidence.js';

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
