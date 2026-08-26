/**
 * Receipt extraction rules (`domain-model.md`, `Receipt`/`ReceiptItem`; ADR-0036, ADR-0037).
 *
 * Everything here is pure. `Receipt` is DERIVED, not APPROVED-classified — nothing in this
 * file decides whether a proposal may become state (that gate does not exist for receipts,
 * ADR-0036); what lives here is the eligibility check before extraction runs, the two
 * discrepancies `scenario-analysis.md` §20 and the `ReceiptItem` invariant both say to surface
 * rather than reconcile, and the deterministic candidate-match rule ADR-0037 stops short of
 * turning into a link.
 */

import type { ConfidenceLevel, EvidenceType } from './enums.js';
import { DomainError } from './errors.js';
import type { Paise } from './money.js';

/* -------------------------------------------------------------------------- eligibility */

/**
 * Evidence types a receipt can plausibly be extracted from.
 *
 * `bank_line`/`upi_notification` are payment-side evidence, not a merchant's own document.
 * `manual_note` is typed text with no document at all (and, per this phase's scope decision,
 * manual receipt entry is deferred to phase 12 regardless). What is left is exactly what a
 * phone camera, a forwarded order email, or a screenshot of one actually produces.
 */
export const RECEIPT_EXTRACTABLE_EVIDENCE_TYPES = [
  'receipt_image',
  'email_receipt',
  'screenshot',
] as const;
export type ReceiptExtractableEvidenceType = (typeof RECEIPT_EXTRACTABLE_EVIDENCE_TYPES)[number];

export function isReceiptExtractableEvidenceType(
  type: EvidenceType,
): type is ReceiptExtractableEvidenceType {
  return (RECEIPT_EXTRACTABLE_EVIDENCE_TYPES as readonly string[]).includes(type);
}

/* --------------------------------------------------------------------------- confidence */

/** Lowest first, so the more cautious of two independent confidences can be picked out. */
const CONFIDENCE_RANK: Readonly<Record<ConfidenceLevel, number>> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * The more cautious of two confidences.
 *
 * `Receipt.extraction_confidence` is one column fed by two independent operations
 * (`parseReceipt` for the totals, `extractReceiptItems` for the line items — `ReceiptItem` has
 * no confidence column of its own). Recording the higher of the two would let a confident
 * total mask item extraction the model was actually unsure about; the lower one is the honest
 * summary of "how much of this row should a reviewer trust".
 */
export function lowerConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/* ---------------------------------------------------------------------------- the draft */

/** What `ai.parseReceipt` proposes, after gate 1 — mirrors `ai.ReceiptDraft`. */
export interface ReceiptDraftFields {
  readonly subtotal: Paise | null;
  readonly tax: Paise | null;
  readonly total: Paise | null;
}

/**
 * Refuses an extraction that says nothing.
 *
 * A model can decline to guess (`ai-boundary.md`'s `unknown` confidence exists for exactly
 * this), but a `Receipt` row with `subtotal`/`tax`/`total` all null carries no figure any
 * discrepancy check could ever compare against — it would sit in the ledger as a row that
 * exists but explains nothing, forever. Rejecting it here means `services.extractReceipt`
 * never has to write one.
 */
export function assertReceiptDraftInformative(draft: ReceiptDraftFields): void {
  if (draft.subtotal === null && draft.tax === null && draft.total === null) {
    throw new DomainError(
      'RECEIPT_DRAFT_INVALID',
      'The extraction proposes no subtotal, tax, or total — nothing for this Receipt to ' +
        'record. A model that could not read any figure off the document should be asked ' +
        'again with a clearer image, not recorded as an empty row.',
    );
  }
}

/* ------------------------------------------------------------------------- discrepancies */

/** One resolved `ReceiptItem` line, as far as the subtotal check needs it. */
export interface ReceiptItemLine {
  readonly lineTotal: Paise;
}

/** Sums `ReceiptItem.line_total` across a receipt — exact, no rounding involved. */
export function receiptItemsSubtotal(items: readonly ReceiptItemLine[]): Paise {
  let total = 0n;
  for (const item of items) {
    total += item.lineTotal;
  }
  return total as Paise;
}

/**
 * How far the items' sum sits from the receipt's own `subtotal`, when there is one to compare.
 *
 * `null` means there is nothing to compare — `subtotal` was not extracted, not that the items
 * agree with it. `0n` means they agree exactly. Positive means the items sum to more than the
 * stated subtotal (a line the extraction over-read, or a subtotal it under-read); negative the
 * other way. Never thrown, never clamped — surfaced, per `ReceiptItem`'s own invariant
 * ("discrepancies are surfaced, not hidden").
 */
export function receiptItemsSubtotalDiscrepancy(
  subtotal: Paise | null,
  items: readonly ReceiptItemLine[],
): Paise | null {
  if (subtotal === null) return null;
  return (receiptItemsSubtotal(items) - subtotal) as Paise;
}

/**
 * How far a receipt's `total` sits from the amount actually charged, when the evidence is
 * linked to a payment.
 *
 * `null` means there is nothing to compare — no linked payment, or no extracted total —
 * exactly `scenario-analysis.md` §20's shape ("a `Receipt` with no reachable `Payment` link is
 * valid"). Never reconciled by overwriting either figure: `Receipt.total` and `Payment.amount`
 * "must remain independently stored, never one derived by overwriting the other" (§20).
 */
export function receiptPaymentDiscrepancy(
  receiptTotal: Paise | null,
  linkedPaymentAmount: Paise | null,
): Paise | null {
  if (receiptTotal === null || linkedPaymentAmount === null) return null;
  return (receiptTotal - linkedPaymentAmount) as Paise;
}

/* ------------------------------------------------------------------------ candidate match */

/** The default window a receipt's capture date may sit from a candidate payment's date. */
export const DEFAULT_RECEIPT_MATCH_WINDOW_DAYS = 3;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** One payment `findCandidatePaymentMatches` can compare a receipt against. */
export interface CandidatePayment {
  readonly paymentId: string;
  readonly amount: Paise;
  readonly occurredAt: Date;
}

/**
 * Deterministic candidate payments for one receipt — never a decision, per ADR-0037.
 *
 * Exact amount match only: `Payment.amount = Receipt.total`. A receipt is evidence of what was
 * charged, not an estimate, so a near-miss is not a candidate — it is either the wrong document
 * or a discrepancy `receiptPaymentDiscrepancy` will surface once a human links it anyway.
 *
 * The date window defaults to a few days rather than same-day, because a forwarded email
 * receipt or a photographed paper one is routinely captured after the purchase, not at the
 * instant of it — and `Evidence.captured_at`, not the receipt's own (unextracted) purchase
 * date, is the only capture-time fact this system has.
 *
 * Returns candidates ordered by how close each one's date sits to the receipt's capture —
 * closest first — so a caller showing "the likely match" can just take the first entry; ties
 * break on `paymentId` for a stable order.
 */
export function findCandidatePaymentMatches(
  receipt: { readonly total: Paise | null; readonly capturedAt: Date },
  candidates: readonly CandidatePayment[],
  options: { readonly windowDays?: number } = {},
): readonly CandidatePayment[] {
  if (receipt.total === null) return [];
  const windowMs = (options.windowDays ?? DEFAULT_RECEIPT_MATCH_WINDOW_DAYS) * MILLISECONDS_PER_DAY;

  return candidates
    .filter((candidate) => candidate.amount === receipt.total)
    .map((candidate) => ({
      candidate,
      distanceMs: Math.abs(candidate.occurredAt.getTime() - receipt.capturedAt.getTime()),
    }))
    .filter((entry) => entry.distanceMs <= windowMs)
    .sort((a, b) => {
      if (a.distanceMs !== b.distanceMs) return a.distanceMs - b.distanceMs;
      return a.candidate.paymentId < b.candidate.paymentId ? -1 : 1;
    })
    .map((entry) => entry.candidate);
}
