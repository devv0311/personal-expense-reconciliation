import { describe, expect, it } from 'vitest';

import { deriveReattachedContext, reattachedMerchantHints } from './evidence-context.js';
import type { ContextEvidenceSource, ContextPayment } from './evidence-context.js';
import type { EvidenceObservationFields } from './evidence-observation.js';
import type { Paise } from './money.js';

const PAYMENT: ContextPayment = {
  paymentId: 'payment-1',
  amount: 124000n as Paise,
  direction: 'debit',
  occurredAt: new Date('2026-07-01T00:00:00Z'),
  // The narration this whole pillar exists for: a real statement line, decayed to nothing.
  rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
  externalReference: 'UPI/2607011234/BLINKIT',
  merchantName: null,
};

function source(
  evidenceId: string,
  observation: Partial<EvidenceObservationFields> | null,
  capturedAt = new Date('2026-07-01T19:00:00Z'),
): ContextEvidenceSource {
  return {
    evidenceId,
    evidenceType: 'upi_notification',
    capturedAt,
    observation:
      observation === null
        ? null
        : {
            observedAmount: 124000n as Paise,
            observedDirection: 'debit',
            observedReference: '2607011234',
            observedReferenceType: 'upi_utr',
            observedAccountHint: '4821',
            observedMerchantText: 'Blinkit',
            observedOccurredAt: new Date('2026-07-01T19:00:00Z'),
            derivation: 'parsed_from_text',
            ...observation,
          },
  };
}

describe('deriveReattachedContext', () => {
  it('carries the narration through verbatim and puts the reconstruction beside it', () => {
    const context = deriveReattachedContext(PAYMENT, [source('evidence-1', {})]);
    expect(context.narration).toBe(PAYMENT.rawDescription);
    expect(context.merchantCandidates).toEqual([{ value: 'Blinkit', evidenceIds: ['evidence-1'] }]);
  });

  it('lets several evidence records enrich one movement', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', {}),
      source('evidence-2', { observedMerchantText: 'Blinkit' }, new Date('2026-07-02T08:00:00Z')),
    ]);
    expect(context.sources).toHaveLength(2);
    expect(context.observedSourceCount).toBe(2);
    expect(context.merchantCandidates).toEqual([
      { value: 'Blinkit', evidenceIds: ['evidence-1', 'evidence-2'] },
    ]);
    expect(context.conflicts).toEqual([]);
  });

  it('orders sources oldest capture first, whatever order they arrived in', () => {
    const later = source('evidence-later', {}, new Date('2026-07-03T08:00:00Z'));
    const earlier = source('evidence-earlier', {}, new Date('2026-07-01T08:00:00Z'));
    expect(
      deriveReattachedContext(PAYMENT, [later, earlier]).sources.map((s) => s.evidenceId),
    ).toEqual(['evidence-earlier', 'evidence-later']);
  });

  it('counts an attached record with no reading as a source, not as an observation', () => {
    const context = deriveReattachedContext(PAYMENT, [source('evidence-1', null)]);
    expect(context.sources).toHaveLength(1);
    expect(context.observedSourceCount).toBe(0);
    expect(context.merchantCandidates).toEqual([]);
  });

  it('reports a source that disagrees with the payment about the amount, keeping both', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', { observedAmount: 99900n as Paise }),
    ]);
    const conflict = context.conflicts.find((entry) => entry.field === 'amount');
    expect(conflict?.values).toEqual([
      { value: '99900', evidenceIds: ['evidence-1'] },
      { value: '124000', evidenceIds: ['payment'] },
    ]);
    // Nothing is reconciled: the payment still says what the bank moved.
    expect(context.narration).toBe(PAYMENT.rawDescription);
  });

  it('reports a source that disagrees about direction', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', { observedDirection: 'credit' }),
    ]);
    expect(context.conflicts.map((entry) => entry.field)).toContain('direction');
  });

  it('reports two sources naming different transactions', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', {}),
      source('evidence-2', { observedReference: '2607031122' }),
    ]);
    expect(context.conflicts.map((entry) => entry.field)).toContain('reference');
  });

  it('does not report one UTR written two ways as a disagreement', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', { observedReference: '2607011234' }),
      source('evidence-2', { observedReference: 'UPI/2607011234/BLINKIT' }),
    ]);
    expect(context.conflicts.map((entry) => entry.field)).not.toContain('reference');
  });

  it('does not report one merchant written at two lengths as a disagreement', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', { observedMerchantText: 'Blinkit' }),
      source('evidence-2', { observedMerchantText: 'BLINKIT INDIA PVT LTD' }),
    ]);
    expect(context.conflicts.map((entry) => entry.field)).not.toContain('merchant');
  });

  it('reports two genuinely different counterparties without choosing one', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', { observedMerchantText: 'Blinkit' }),
      source('evidence-2', { observedMerchantText: 'Zomato' }),
    ]);
    const conflict = context.conflicts.find((entry) => entry.field === 'merchant');
    expect(conflict?.values.map((entry) => entry.value).sort()).toEqual(['Blinkit', 'Zomato']);
    expect(context.merchantCandidates).toHaveLength(2);
  });

  it('orders merchant candidates by how many records assert them', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', { observedMerchantText: 'Zomato' }),
      source('evidence-2', { observedMerchantText: 'Blinkit' }),
      source('evidence-3', { observedMerchantText: 'Blinkit' }),
    ]);
    expect(context.merchantCandidates[0]).toEqual({
      value: 'Blinkit',
      evidenceIds: ['evidence-2', 'evidence-3'],
    });
  });

  it('is stable: two derivations over the same input are identical', () => {
    const sources = [source('evidence-1', {}), source('evidence-2', {})];
    expect(deriveReattachedContext(PAYMENT, sources)).toEqual(
      deriveReattachedContext(PAYMENT, [...sources].reverse()),
    );
  });
});

describe('reattachedMerchantHints', () => {
  it('takes the most-corroborated names, bounded', () => {
    const context = deriveReattachedContext(PAYMENT, [
      source('evidence-1', { observedMerchantText: 'Blinkit' }),
      source('evidence-2', { observedMerchantText: 'Zomato' }),
    ]);
    expect(reattachedMerchantHints(context, 1)).toEqual(['Blinkit']);
  });

  it('carries only names — no references, account tails or raw text leave through it', () => {
    const context = deriveReattachedContext(PAYMENT, [source('evidence-1', {})]);
    const hints = reattachedMerchantHints(context);
    expect(hints).toEqual(['Blinkit']);
    expect(JSON.stringify(hints)).not.toContain('2607011234');
    expect(JSON.stringify(hints)).not.toContain('4821');
  });
});
