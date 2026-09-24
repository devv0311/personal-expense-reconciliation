import { describe, expect, it } from 'vitest';

import { REVIEW_ITEM_KINDS } from './review.js';
import { attentionQuestion } from './attention.js';

describe('the question a waiting decision actually is', () => {
  it('asks every review kind something a person can answer', () => {
    for (const kind of REVIEW_ITEM_KINDS) {
      const asked = attentionQuestion({ kind, reasons: [] });
      expect(asked.question.endsWith('?')).toBe(true);
      expect(asked.why.length).toBeGreaterThan(20);
      // Not a single schema word on the primary surface.
      expect(asked.question).not.toMatch(
        /classification|normalization|inference|evidence|cash.flow|enum/i,
      );
    }
  });

  it('says why two payments may be one, in the owner’s own terms, and that nothing was discarded', () => {
    const asked = attentionQuestion({
      kind: 'possible_duplicate',
      reasons: ['possible_duplicate'],
    });
    expect(asked.question).toBe('Is this the same payment recorded twice?');
    // The policy, as the owner set it (ADR-0070): one day, one amount, and the same or a similar
    // name — or, where a line names nobody, the same kind of payment.
    expect(asked.why).toContain('the same amount on the same day');
    expect(asked.why).toContain('the same or a similar payee');
    expect(asked.why).toContain('the same kind of payment');
    expect(asked.why).toContain('both are counted');
  });

  it('keeps an unknown kind visible under a real question', () => {
    // A kind this file has not been taught is still a decision somebody has to make. The one
    // failure mode a review queue cannot have is dropping it.
    const asked = attentionQuestion({ kind: 'something_added_later', reasons: ['whatever'] });
    expect(asked.question).toBe('Does this still need your judgement?');
    expect(asked.why).toContain('shown here rather than hidden');
  });

  it('asks about a settlement proposal in terms of what the money was, not its kind', () => {
    const asked = attentionQuestion({
      kind: 'classification_decision',
      reasons: ['settlement_kind'],
      proposedKind: 'settlement',
    });
    expect(asked.question).toBe('Was this money a refund, a transfer or a repayment?');
  });

  it('says a stored suggestion could not be read back, rather than pretending there is one', () => {
    const asked = attentionQuestion({
      kind: 'classification_decision',
      reasons: ['malformed_proposal'],
      proposedKind: null,
    });
    expect(asked.question).toBe('What was this payment for?');
    expect(asked.why).toContain('no longer be read back');
  });

  it('asks which payment when more than one could be the one', () => {
    expect(
      attentionQuestion({
        kind: 'unmatched_evidence',
        reasons: ['evidence_unmatched', 'evidence_match_ambiguous'],
        candidateCount: 3,
      }).question,
    ).toBe('Which payment is this document about?');
  });

  it('asks a yes/no when exactly one payment is proposed', () => {
    expect(
      attentionQuestion({
        kind: 'unmatched_evidence',
        reasons: ['evidence_unmatched'],
        candidateCount: 1,
      }).question,
    ).toBe('Does this document belong to this payment?');
  });

  it('asks an open question when nothing is proposed at all', () => {
    expect(
      attentionQuestion({
        kind: 'unmatched_evidence',
        reasons: ['evidence_unmatched'],
        candidateCount: 0,
      }).question,
    ).toBe('What payment is this document about?');
  });

  it('asks who shared an expense nobody is named on', () => {
    const asked = attentionQuestion({ kind: 'allocation_missing', reasons: [] });
    expect(asked.question).toBe('Who shared this expense?');
  });
});
