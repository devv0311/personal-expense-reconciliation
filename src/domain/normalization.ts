/**
 * Deterministic normalization rules (`data-flow.md` step 2, deterministic leg only).
 *
 * Pure: values in, values out. No I/O, no database, no clock. What a payment *is* — an
 * expense, a settlement, a transfer, an investment — is not decided here and has no code
 * path from here; that is classification (`lifecycle.md`, phase 8).
 */

import type { PaymentChannel, PaymentReferenceType } from './enums.js';

/**
 * The channel each reference type proves, where it proves one.
 *
 * Partial on purpose. A `bank_reference` says only "this went through the banking system",
 * which is exactly what the adapter already recorded as `bank_transfer`; and there is no
 * `cheque` member of `PAYMENT_CHANNELS` for `cheque_number` to map to. A type absent from
 * this table refines nothing, which is different from mapping it to `other`.
 */
const CHANNEL_BY_REFERENCE_TYPE: Partial<Record<PaymentReferenceType, PaymentChannel>> = {
  upi_utr: 'upi',
  upi_rrn: 'upi',
  card_reference: 'card',
};

/**
 * Refines a payment's channel from the reference the adapter extracted.
 *
 * `reference_type` is the *only* evidence consulted — deliberately not `raw_description`
 * (ADR-0020). It is a typed field produced by the adapter that owns format knowledge, so
 * matching a description here would duplicate that knowledge in a second layer, and reading
 * meaning out of a description is a heuristic, which `ai-boundary.md` assigns to inference.
 *
 * Falls back to the channel already recorded, never to a default: a source that carries no
 * reference yields no refinement, which is the correct answer rather than a gap.
 */
export function refineChannel(
  referenceType: PaymentReferenceType | null,
  currentChannel: PaymentChannel,
): PaymentChannel {
  if (referenceType === null) return currentChannel;
  return CHANNEL_BY_REFERENCE_TYPE[referenceType] ?? currentChannel;
}
