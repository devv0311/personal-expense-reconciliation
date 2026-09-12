/**
 * The rules that govern sending a proof pack: who it may be addressed to, what may be
 * attached to it, when a second attempt is the same delivery rather than a new one, and which
 * status transitions are real.
 *
 * `domain/proof-pack.ts` builds the message. This file decides what may happen to it next,
 * and it is deliberately separate for one reason: **generating a pack and sending it are two
 * acts, and only the second one can hurt.** ADR-0047 made the first free — a pure read that
 * persists nothing. Everything here exists because the second is not.
 *
 * Three rules are enforced as shapes rather than asked for:
 *
 *  - **A resend is the same delivery until the content changes.** `deliveryIdempotencyKey`
 *    folds recipient, channel, address and the exact message bytes into one value with a
 *    unique index behind it. Pressing send twice on an unchanged pack cannot produce two
 *    messages; changing one rupee of the pack produces a genuinely different key, because it
 *    is genuinely a different thing to have sent somebody.
 *  - **An attachment is a document leaving the machine**, so the permitted set is an
 *    allowlist of evidence types whose whole content is the shared purchase itself. Everything
 *    else — a bank line, a UPI notification, a screenshot of unknown provenance, a private
 *    note — is refused by type rather than reviewed case by case (`security-model.md`; the
 *    sixth pillar).
 *  - **A failure is a state, not an exception.** A transport that could not be reached leaves
 *    a record saying so, retryable by an explicit act, because a send that vanished without
 *    a trace is indistinguishable from one that quietly succeeded.
 */

import { DomainError } from './errors.js';
import type { EvidenceType, MessageChannel, ProofPackDeliveryStatus } from './enums.js';

/**
 * How many times one delivery may be attempted before it stops offering a retry.
 *
 * A cap rather than unlimited retries because each attempt is an outward act: a loop that
 * kept trying could put the same message in front of somebody five times over a flaky
 * network, and the recipient has no way to tell a retry from a nag.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * The evidence types that may be attached to an outgoing pack.
 *
 * A receipt is the document the shared purchase *is*: the recipient is being asked to accept
 * a share of what it records, so showing it to them is the substance of the claim rather than
 * a leak. Everything outside this set carries facts about the user's own accounts —
 * `bank_line` is a statement row, `upi_notification` carries a handle and often a balance,
 * `screenshot` could be either and its provenance is unknowable from the type, `manual_note`
 * is the user's own reasoning. None of those is the recipient's business, and none of them is
 * made safe by a person ticking a box.
 */
export const ATTACHABLE_EVIDENCE_TYPES: readonly EvidenceType[] = [
  'receipt_image',
  'email_receipt',
];

export function isAttachableEvidenceType(type: EvidenceType): boolean {
  return ATTACHABLE_EVIDENCE_TYPES.includes(type);
}

/** One document a delivery would carry, as the caller proposes it. */
export interface ProposedAttachment {
  readonly evidenceId: string;
  readonly evidenceType: EvidenceType;
  /** Whether the evidence row actually has a stored document behind it. */
  readonly hasStoredDocument: boolean;
  /** Whether this evidence is cited by the pack the delivery is for. */
  readonly citedByPack: boolean;
}

/**
 * Checks every proposed attachment, refusing the whole delivery if any one fails.
 *
 * All-or-nothing on purpose: a partial send whose missing attachment is mentioned nowhere
 * would look to the recipient like the complete claim, and to the sender like a success.
 *
 * @throws DomainError `PROOF_PACK_ATTACHMENT_REFUSED`
 */
export function assertAttachmentsPermitted(attachments: readonly ProposedAttachment[]): void {
  for (const attachment of attachments) {
    if (!attachment.citedByPack) {
      throw new DomainError(
        'PROOF_PACK_ATTACHMENT_REFUSED',
        `Evidence ${attachment.evidenceId} is not cited by this proof pack. A pack may only ` +
          'carry documents it actually refers to — attaching anything else would send a ' +
          'document the message never explains.',
      );
    }
    if (!isAttachableEvidenceType(attachment.evidenceType)) {
      throw new DomainError(
        'PROOF_PACK_ATTACHMENT_REFUSED',
        `Evidence ${attachment.evidenceId} is a ${attachment.evidenceType}, which is never ` +
          `attachable. Only ${ATTACHABLE_EVIDENCE_TYPES.join(' and ')} may leave this ` +
          'machine: every other kind carries facts about your own accounts rather than about ' +
          'the shared purchase.',
      );
    }
    if (!attachment.hasStoredDocument) {
      throw new DomainError(
        'PROOF_PACK_ATTACHMENT_REFUSED',
        `Evidence ${attachment.evidenceId} has no stored document, so there is nothing to ` +
          'attach. A delivery that silently dropped it would claim to have shown proof it ' +
          'never sent.',
      );
    }
  }
}

/**
 * A recipient address, validated for its channel.
 *
 * WhatsApp addresses are E.164 without the leading `+` on the wire, but a person types the
 * `+`. Both are accepted and one canonical form is stored, so the same recipient typed two
 * ways is one idempotency key rather than two.
 *
 * @throws DomainError `PROOF_PACK_ADDRESS_INVALID`
 */
export function canonicalizeAddress(channel: MessageChannel, address: string): string {
  const trimmed = address.trim();
  switch (channel) {
    case 'whatsapp': {
      const digits = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
      if (!/^\d{8,15}$/.test(digits)) {
        throw new DomainError(
          'PROOF_PACK_ADDRESS_INVALID',
          'A WhatsApp address is an international phone number in E.164 form — country code ' +
            `and subscriber number, 8 to 15 digits, e.g. +919876543210. "${trimmed}" is not ` +
            'one, and guessing a country code would be guessing who receives this.',
        );
      }
      return `+${digits}`;
    }
  }
}

/** The three things a person confirms before a pack may be addressed at all (ADR-0049). */
export interface DeliveryReview {
  readonly recipientConfirmed: boolean;
  readonly contentConfirmed: boolean;
  readonly evidenceConfirmed: boolean;
}

/**
 * Refuses a delivery whose content was never reviewed.
 *
 * The same three checks the preview screen already gates copying behind, enforced here as
 * well rather than only there — a check that lives only in a browser is a check an API call
 * skips.
 *
 * @throws DomainError `PROOF_PACK_REVIEW_INCOMPLETE`
 */
export function assertReviewed(review: DeliveryReview): void {
  const missing: string[] = [];
  if (!review.recipientConfirmed) missing.push('who it is addressed to');
  if (!review.contentConfirmed) missing.push('what it says');
  if (!review.evidenceConfirmed) missing.push('which evidence it cites');
  if (missing.length > 0) {
    throw new DomainError(
      'PROOF_PACK_REVIEW_INCOMPLETE',
      `This pack has not been reviewed: ${missing.join(', ')}. Sending it is the moment it ` +
        'stops being private, so each part is confirmed before rather than after.',
    );
  }
}

export interface DeliveryIdentity {
  readonly recipientPersonId: string;
  readonly channel: MessageChannel;
  /** The canonical address, from {@link canonicalizeAddress}. */
  readonly address: string;
  /** A digest of the exact bytes that would be sent, computed by the caller. */
  readonly contentDigest: string;
  /** A digest over the attachment set, so adding a document is a different delivery. */
  readonly attachmentDigest: string;
}

/**
 * The value a unique index makes idempotent.
 *
 * Deliberately built from what was *sent* rather than from when: two presses of the same
 * button on the same unchanged pack are one delivery however far apart they are, and an edit
 * anywhere in the message is a new one however fast it follows.
 */
export function deliveryIdempotencyKey(identity: DeliveryIdentity): string {
  return [
    'v1',
    identity.channel,
    identity.recipientPersonId,
    identity.address,
    identity.contentDigest,
    identity.attachmentDigest,
  ].join(':');
}

/** What a transport reported back about one attempt. */
export interface DeliveryAttemptOutcome {
  readonly accepted: boolean;
  readonly providerMessageId?: string | undefined;
  readonly failureReason?: string | undefined;
}

export interface DeliveryStateChange {
  readonly status: ProofPackDeliveryStatus;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly providerMessageId: string | null;
  readonly sentAt: Date | null;
}

/**
 * The state a delivery moves to after one attempt.
 *
 * `providerMessageId` survives a later failure on purpose: if the transport accepted a
 * message and then a status callback said it failed, the id is how the two are connected, and
 * dropping it would leave a failure nobody can trace to what was actually handed over.
 */
export function applyAttemptOutcome(
  current: { readonly attemptCount: number; readonly providerMessageId: string | null },
  outcome: DeliveryAttemptOutcome,
  at: Date,
): DeliveryStateChange {
  const attemptCount = current.attemptCount + 1;
  if (outcome.accepted) {
    return {
      status: 'sent',
      attemptCount,
      lastError: null,
      providerMessageId: outcome.providerMessageId ?? current.providerMessageId,
      sentAt: at,
    };
  }
  return {
    status: 'failed',
    attemptCount,
    lastError: outcome.failureReason ?? 'The transport refused without saying why.',
    providerMessageId: current.providerMessageId,
    sentAt: null,
  };
}

/**
 * Whether a failed delivery may be attempted again.
 *
 * Only `failed` is retryable. A `sent` or `delivered` record is not: re-sending it would put
 * the same message in front of somebody a second time, and the cure for "I am not sure it
 * arrived" is a delivery status, not another copy.
 */
export function canRetryDelivery(delivery: {
  readonly status: ProofPackDeliveryStatus;
  readonly attemptCount: number;
}): boolean {
  return delivery.status === 'failed' && delivery.attemptCount < MAX_DELIVERY_ATTEMPTS;
}

/**
 * Refuses a retry that is not one.
 *
 * @throws DomainError `PROOF_PACK_DELIVERY_NOT_RETRYABLE`
 */
export function assertRetryable(delivery: {
  readonly status: ProofPackDeliveryStatus;
  readonly attemptCount: number;
}): void {
  if (delivery.status !== 'failed') {
    throw new DomainError(
      'PROOF_PACK_DELIVERY_NOT_RETRYABLE',
      `This delivery is "${delivery.status}", not failed. Sending it again would put the same ` +
        'message in front of the recipient a second time.',
    );
  }
  if (delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    throw new DomainError(
      'PROOF_PACK_DELIVERY_NOT_RETRYABLE',
      `This delivery has been attempted ${delivery.attemptCount} times, which is the limit. ` +
        'Something about the address or the transport is wrong in a way another attempt will ' +
        'not fix.',
    );
  }
}

/**
 * The statuses a provider's own callback may move a delivery to, and from where.
 *
 * A provider may confirm delivery of something it accepted, or report that the accepted
 * message ultimately failed. It may never resurrect a delivery this ledger never sent, and it
 * may never walk `delivered` backwards — an external system is not permitted to rewrite the
 * record of what already happened here.
 *
 * @throws DomainError `INVALID_STATE_TRANSITION`
 */
export function assertProviderStatusTransition(
  from: ProofPackDeliveryStatus,
  to: 'delivered' | 'failed',
): void {
  if (from === 'sent') return;
  throw new DomainError(
    'INVALID_STATE_TRANSITION',
    `A provider callback cannot move a delivery from "${from}" to "${to}". Only a message ` +
      'this ledger handed over can be confirmed or reported failed against.',
  );
}
