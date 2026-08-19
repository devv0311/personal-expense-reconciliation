/**
 * Redaction — the last thing that happens before data leaves this system's boundary.
 *
 * `docs/security/security-model.md`, "Data sent to external AI services", requires that full
 * account numbers, card numbers, UPI IDs **and `payments.external_reference` values** are
 * redacted or omitted, that only the minimum fields for the specific inference are sent, and
 * that this is "a named function in `src/ai` (not inlined ad hoc at each call site), so it's
 * implemented once and testable once". This is that function.
 *
 * The rule it follows: an identifier is anything that could name a real account, card, UPI
 * handle or bank reference. Amounts, dates and merchant names are not identifiers and are sent
 * as they are — classification is impossible without them.
 */

import type {
  MerchantId,
  Paise,
  PaymentChannel,
  PaymentDirection,
  PersonId,
} from '../domain/index.js';

/** A payment as `src/services` hands it to an operation — before redaction. */
export interface ClassifiablePayment {
  readonly amount: Paise;
  readonly currency: string;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  readonly rawDescription: string;
  readonly channel: PaymentChannel;
  /**
   * Present so the redaction step can be shown to drop it, not so it can be sent.
   * A UTR/RRN is an identifier of the same sensitivity class as an account number (ADR-0010).
   */
  readonly externalReference: string | null;
}

/** The already-resolved references a proposal may refer to, rather than raw statement text. */
export interface ClassificationContext {
  readonly merchant: {
    readonly id: MerchantId;
    readonly canonicalName: string;
    readonly defaultCategory: string | null;
  } | null;
  /**
   * The people a `counterpartyPersonHint` may name.
   *
   * Sent because a proposal has to be able to *name* someone, and an opaque internal id plus a
   * synthetic display name is the least the operation can work with. Nothing here is a UPI
   * handle, a phone number or an account — those never leave.
   */
  readonly knownPeople: readonly { readonly id: PersonId; readonly displayName: string }[];
}

/** Exactly what is sent to the provider. No account, no reference, no raw identifiers. */
export interface RedactedPayment {
  /** A bigint has no JSON representation; minor units travel as an exact decimal string. */
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly direction: PaymentDirection;
  readonly occurredAt: string;
  readonly description: string;
  readonly channel: PaymentChannel;
  readonly merchantName: string | null;
  readonly merchantCategory: string | null;
  readonly counterpartyCandidates: readonly { readonly id: string; readonly displayName: string }[];
}

export const REDACTED_NUMBER = '[redacted-number]';
export const REDACTED_UPI_ID = '[redacted-upi-id]';

/**
 * A UPI handle: `something@bank`. Matched before the digit rule, since a handle's local part
 * is frequently a phone number and masking that first would leave `[redacted-number]@okaxis`.
 *
 * The local part deliberately includes `-`, so the match runs back through hyphen-joined
 * tokens: a VPA may contain a hyphen, and stopping at the first one would leave a fragment of
 * the handle behind. Over-redacting a neighbouring token is the cheaper mistake.
 */
const UPI_ID_PATTERN = /[A-Za-z0-9._-]+@[A-Za-z][A-Za-z0-9.-]*/g;

/**
 * Four or more consecutive digits.
 *
 * Four is the shortest run that can be an account fragment — `last4` on `accounts` is exactly
 * that, and `A/C X4821` is the fixture's own example. Shorter runs (a `2607` date fragment
 * inside a reference, a quantity) carry no identifying power on their own.
 */
const LONG_DIGIT_RUN_PATTERN = /\d{4,}/g;

/**
 * Strips identifiers out of a raw statement description.
 *
 * Deliberately lossy and deliberately blunt: the description is free text from a bank, so
 * there is no schema to reason about, and over-redacting a merchant's numeric suffix costs a
 * little classification signal while under-redacting sends an account number to a third party.
 */
export function redactDescription(rawDescription: string): string {
  return rawDescription
    .replace(UPI_ID_PATTERN, REDACTED_UPI_ID)
    .replace(LONG_DIGIT_RUN_PATTERN, REDACTED_NUMBER)
    .trim();
}

/**
 * Builds the payload for an inference over one payment.
 *
 * `external_reference`, `account_id` and the payment's own id are absent by construction —
 * there is no field on {@link RedactedPayment} for them to occupy, so omitting them is not a
 * step someone can forget.
 */
export function redactPaymentForInference(
  payment: ClassifiablePayment,
  context: ClassificationContext,
): RedactedPayment {
  return {
    amountMinorUnits: payment.amount.toString(),
    currency: payment.currency,
    direction: payment.direction,
    occurredAt: payment.occurredAt.toISOString(),
    description: redactDescription(payment.rawDescription),
    channel: payment.channel,
    merchantName: context.merchant?.canonicalName ?? null,
    merchantCategory: context.merchant?.defaultCategory ?? null,
    counterpartyCandidates: context.knownPeople.map((person) => ({
      id: person.id,
      displayName: person.displayName,
    })),
  };
}
