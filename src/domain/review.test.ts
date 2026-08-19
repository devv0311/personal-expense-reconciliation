import { describe, expect, it } from 'vitest';

import { paise } from './money.js';
import {
  classificationReviewReasons,
  possibleDuplicateKey,
  prioritiseReviewQueue,
  reviewRank,
} from './review.js';
import type { ReviewQueueEntry } from './review.js';
import { routeClassificationForReview } from './classification.js';

const AT = new Date('2026-07-10T00:00:00.000Z');

function entry(overrides: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return {
    kind: 'classification_decision',
    id: 'inference-1',
    amount: paise(100_000n),
    occurredAt: AT,
    reasons: ['decision_required'],
    ...overrides,
  };
}

describe('reviewRank', () => {
  it('puts a possible duplicate first — the ledger may be counting money twice', () => {
    expect(reviewRank(entry({ kind: 'possible_duplicate', reasons: ['possible_duplicate'] }))).toBe(
      0,
    );
  });

  it('ranks a flagged proposal above a routine one', () => {
    expect(reviewRank(entry({ reasons: ['low_confidence'] }))).toBe(1);
    expect(reviewRank(entry({ reasons: ['decision_required'] }))).toBe(2);
  });

  it('treats any flagged reason as flagged, not just low confidence', () => {
    for (const reason of ['material_amount', 'settlement_kind'] as const) {
      expect(reviewRank(entry({ reasons: [reason] }))).toBe(1);
    }
  });

  it('puts an unexplained payment last — unfinished, not pending', () => {
    expect(
      reviewRank(entry({ kind: 'rejected_classification', reasons: ['payment_unexplained'] })),
    ).toBe(3);
  });
});

describe('prioritiseReviewQueue', () => {
  it('orders by rank first, whatever the amounts say', () => {
    const duplicate = entry({
      kind: 'possible_duplicate',
      id: 'pair',
      amount: paise(100n),
      reasons: ['possible_duplicate'],
    });
    const flagged = entry({
      id: 'flagged',
      amount: paise(5_000_000n),
      reasons: ['low_confidence'],
    });

    expect(prioritiseReviewQueue([flagged, duplicate]).map((item) => item.id)).toEqual([
      'pair',
      'flagged',
    ]);
  });

  it('orders by amount descending inside a rank', () => {
    const small = entry({ id: 'a', amount: paise(10_000n), reasons: ['low_confidence'] });
    const large = entry({ id: 'b', amount: paise(900_000n), reasons: ['low_confidence'] });

    expect(prioritiseReviewQueue([small, large]).map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('orders the oldest first when amounts tie', () => {
    const newer = entry({ id: 'a', occurredAt: new Date('2026-07-20T00:00:00Z') });
    const older = entry({ id: 'b', occurredAt: new Date('2026-07-02T00:00:00Z') });

    expect(prioritiseReviewQueue([newer, older]).map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('breaks a total tie on id, so no two entries ever compare equal', () => {
    const second = entry({ id: 'zzz' });
    const first = entry({ id: 'aaa' });

    expect(prioritiseReviewQueue([second, first]).map((item) => item.id)).toEqual(['aaa', 'zzz']);
  });

  it('returns the same order for the same input, whatever order it arrives in', () => {
    // The queue is read repeatedly by a UI; two reads of an unchanged ledger must agree.
    const items = [
      entry({ id: 'a', amount: paise(500n), reasons: ['low_confidence'] }),
      entry({ id: 'b', amount: paise(500n), reasons: ['low_confidence'] }),
      entry({ id: 'c', kind: 'possible_duplicate', reasons: ['possible_duplicate'] }),
      entry({ id: 'd', kind: 'rejected_classification', reasons: ['payment_unexplained'] }),
      entry({ id: 'e', reasons: ['decision_required'] }),
    ];
    const forward = prioritiseReviewQueue(items).map((item) => item.id);
    const reversed = prioritiseReviewQueue([...items].reverse()).map((item) => item.id);

    expect(forward).toEqual(reversed);
    expect(forward).toEqual(['c', 'a', 'b', 'e', 'd']);
  });

  it('does not mutate its input', () => {
    const items = [entry({ id: 'b' }), entry({ id: 'a' })];

    prioritiseReviewQueue(items);

    expect(items.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('handles an empty queue', () => {
    expect(prioritiseReviewQueue([])).toEqual([]);
  });
});

describe('classificationReviewReasons', () => {
  it('carries every reason phase 8 routing produced', () => {
    const route = routeClassificationForReview({
      confidence: 'unknown',
      amount: paise(5_000_000n),
      proposedKind: 'settlement',
    });

    expect(classificationReviewReasons(route)).toEqual([
      'low_confidence',
      'material_amount',
      'settlement_kind',
    ]);
  });

  it('says "decision_required" when routing flagged nothing', () => {
    // A high-confidence, immaterial proposal is still waiting for a human — omitting it would
    // hide a decision nobody has made (invariants.md #16).
    const route = routeClassificationForReview({
      confidence: 'high',
      amount: paise(124_000n),
      proposedKind: 'expense',
    });

    expect(route.requiresReview).toBe(false);
    expect(classificationReviewReasons(route)).toEqual(['decision_required']);
  });
});

describe('possibleDuplicateKey', () => {
  it('is the same key whichever way round the pair is discovered', () => {
    expect(possibleDuplicateKey('b', 'a')).toBe(possibleDuplicateKey('a', 'b'));
  });

  it('distinguishes different pairs', () => {
    expect(possibleDuplicateKey('a', 'b')).not.toBe(possibleDuplicateKey('a', 'c'));
  });
});
