/**
 * The re-attached context of one payment (Phase 17, ADR-0044).
 *
 * Once evidence has been attached to a payment, the question stops being "which payment is
 * this?" and becomes "what do we now know about that payment that its own narration never
 * said?". This module answers it, from the payment's immutable facts plus the observations of
 * every evidence record linked to it.
 *
 * Three properties hold by construction, and each of them is a rule from `CLAUDE.md`:
 *
 *  - **The narration is carried through verbatim.** `narration` is `Payment.raw_description`,
 *    unchanged, and the reconstructed merchant sits beside it in its own field. There is no
 *    code path here that produces a *replacement* narration, so nothing downstream can mistake
 *    one for the other (`invariants.md` #4).
 *  - **Several evidence records enrich one movement.** The context is a fold over a list, not
 *    a single winner; two notifications describing the same payment produce one context with
 *    two sources, never two cash movements.
 *  - **Disagreement is surfaced, not resolved.** Where two sources state different amounts, or
 *    a source contradicts the payment itself, the context says so and names both values. It
 *    never picks. Picking is a financial decision and this is a pure read.
 *
 * Nothing here is arithmetic over money: amounts are compared for equality and reported, never
 * summed, netted or adjusted. The re-attached context cannot move a number.
 */

import type { EvidenceType, PaymentDirection } from './enums.js';
import type { EvidenceObservationFields } from './evidence-observation.js';
import { referencesMatch } from './evidence-observation.js';
import type { Paise } from './money.js';

/* --------------------------------------------------------------------------- inputs */

/** One evidence record contributing to a payment's context. */
export interface ContextEvidenceSource {
  readonly evidenceId: string;
  readonly evidenceType: EvidenceType;
  readonly capturedAt: Date;
  /** `null` when the record has been attached but never read into structured form. */
  readonly observation: EvidenceObservationFields | null;
}

/** The payment being described. Every field is SOURCE and is only ever read here. */
export interface ContextPayment {
  readonly paymentId: string;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  readonly rawDescription: string;
  readonly externalReference: string | null;
  readonly merchantName: string | null;
}

/* -------------------------------------------------------------------------- outputs */

/** One reconstructed value, and every evidence record that asserted it. */
export interface ContextValue<T> {
  readonly value: T;
  readonly evidenceIds: readonly string[];
}

/** A field on which the sources, or a source and the payment, do not agree. */
export interface ContextConflict {
  readonly field: 'amount' | 'direction' | 'reference' | 'merchant';
  /** Every distinct value asserted, with who asserted it. `payment` names the ledger's own. */
  readonly values: readonly ContextValue<string>[];
  readonly detail: string;
}

export interface ReattachedContext {
  readonly paymentId: string;
  /** `Payment.raw_description`, exactly as the bank wrote it. Never replaced. */
  readonly narration: string;
  /**
   * Merchant/counterparty names the evidence supplies, most-corroborated first.
   *
   * This is the answer to UPI narration decay: `UPI-BLINKIT9821PAYTM` on the statement,
   * `Blinkit` from the push notification that arrived beside it.
   */
  readonly merchantCandidates: readonly ContextValue<string>[];
  /** Reference identifiers the evidence supplies, including ones the statement omitted. */
  readonly references: readonly ContextValue<string>[];
  /** Instants stated by the evidence, which a date-only statement line does not carry. */
  readonly observedInstants: readonly ContextValue<string>[];
  /** Where the sources, or a source and the payment, disagree. Reported, never resolved. */
  readonly conflicts: readonly ContextConflict[];
  /** Every contributing record, oldest capture first. */
  readonly sources: readonly ContextEvidenceSource[];
  /** How many of the sources have been read into structured form. */
  readonly observedSourceCount: number;
}

/* --------------------------------------------------------------------------- derive */

/**
 * Folds a payment and its linked evidence into one re-attached context.
 *
 * Ordering is total everywhere it could vary — sources by capture time then id, values by how
 * many records assert them then by the value itself — so two reads of an unchanged ledger
 * produce an identical context. A surface that polls this must not see it churn.
 */
export function deriveReattachedContext(
  payment: ContextPayment,
  sources: readonly ContextEvidenceSource[],
): ReattachedContext {
  const ordered = [...sources].sort((a, b) => {
    const byCapture = a.capturedAt.getTime() - b.capturedAt.getTime();
    if (byCapture !== 0) return byCapture;
    return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0;
  });

  const observed = ordered.filter(
    (source): source is ContextEvidenceSource & { observation: EvidenceObservationFields } =>
      source.observation !== null,
  );

  const merchantCandidates = collect(observed, (observation) => observation.observedMerchantText);
  const references = collect(observed, (observation) => observation.observedReference);
  const observedInstants = collect(observed, (observation) =>
    observation.observedOccurredAt === null ? null : observation.observedOccurredAt.toISOString(),
  );

  const conflicts: ContextConflict[] = [];

  const amounts = collect(observed, (observation) =>
    observation.observedAmount === null ? null : observation.observedAmount.toString(),
  );
  const paymentAmount = payment.amount.toString();
  if (amounts.some((entry) => entry.value !== paymentAmount)) {
    conflicts.push({
      field: 'amount',
      values: [...amounts, { value: paymentAmount, evidenceIds: ['payment'] }],
      detail:
        'A source states an amount the payment does not. Both are kept: the payment is what ' +
        'the bank moved, and neither figure is rewritten to agree with the other.',
    });
  }

  const directions = collect(observed, (observation) => observation.observedDirection);
  if (directions.some((entry) => entry.value !== payment.direction)) {
    conflicts.push({
      field: 'direction',
      values: [...directions, { value: payment.direction, evidenceIds: ['payment'] }],
      detail:
        'A source describes money moving the other way. That usually means the record belongs ' +
        'to the opposite leg of a transfer, which is a different payment (ADR-0023).',
    });
  }

  if (referencesDisagree(references)) {
    conflicts.push({
      field: 'reference',
      values: references,
      detail:
        'Two sources attached to this payment name different transactions. One of the links ' +
        'is probably wrong, and a recorded link is corrected by superseding evidence rather ' +
        'than by moving it (ADR-0034).',
    });
  }

  if (merchantsDisagree(merchantCandidates)) {
    conflicts.push({
      field: 'merchant',
      values: merchantCandidates,
      detail:
        'The sources name different counterparties. Every candidate is shown rather than the ' +
        'most frequent one being adopted silently.',
    });
  }

  return {
    paymentId: payment.paymentId,
    narration: payment.rawDescription,
    merchantCandidates,
    references,
    observedInstants,
    conflicts,
    sources: ordered,
    observedSourceCount: observed.length,
  };
}

/**
 * The merchant hints the classifier may be told about, most-corroborated first.
 *
 * Kept as its own function rather than as a field on the context because it is the one part
 * of the context that leaves this machine: `redactPaymentForInference` sanitizes it before a
 * model ever sees it (`security-model.md`, and the fail-closed check in `src/ai/redaction.ts`).
 * A named, bounded list is far easier to reason about at that boundary than "whatever the
 * context happened to contain".
 */
export function reattachedMerchantHints(context: ReattachedContext, limit = 5): readonly string[] {
  return context.merchantCandidates.slice(0, Math.max(0, limit)).map((entry) => entry.value);
}

/* ------------------------------------------------------------------------ internals */

function collect(
  sources: readonly (ContextEvidenceSource & { observation: EvidenceObservationFields })[],
  read: (observation: EvidenceObservationFields) => string | null,
): readonly ContextValue<string>[] {
  const byValue = new Map<string, string[]>();
  for (const source of sources) {
    const value = read(source.observation);
    if (value === null || value.trim().length === 0) continue;
    const existing = byValue.get(value);
    if (existing === undefined) byValue.set(value, [source.evidenceId]);
    else existing.push(source.evidenceId);
  }
  return [...byValue.entries()]
    .map(([value, evidenceIds]) => ({ value, evidenceIds: [...evidenceIds].sort() }))
    .sort((a, b) => {
      const byCount = b.evidenceIds.length - a.evidenceIds.length;
      if (byCount !== 0) return byCount;
      return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    });
}

/**
 * Whether two sources really name different transactions.
 *
 * Compared through `referencesMatch`, so `UPI/2607011234/BLINKIT` and `2607011234` are not
 * reported as a disagreement — they are one UTR with different amounts of the bank's own
 * packaging around it, and calling that a conflict would fill the review surface with noise
 * that says nothing.
 */
function referencesDisagree(values: readonly ContextValue<string>[]): boolean {
  return values.some((entry, index) =>
    values.slice(index + 1).some((other) => !referencesMatch(entry.value, other.value)),
  );
}

/**
 * Whether two sources really name different counterparties.
 *
 * `Blinkit` and `BLINKIT INDIA PVT LTD` are one merchant written at two lengths, so
 * containment — the same test the merchant signal uses — is what decides, not string
 * equality. Anything that survives it is a genuine disagreement worth a person's attention.
 */
function merchantsDisagree(values: readonly ContextValue<string>[]): boolean {
  const keys = values.map((entry) => entry.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return keys.some((key, index) =>
    keys.slice(index + 1).some((other) => !(key.includes(other) || other.includes(key))),
  );
}
