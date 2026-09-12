/**
 * The message-transport port: how a reviewed proof pack actually reaches somebody.
 *
 * The audit's row 42 was blunt about what "one-click WhatsApp proof packs" currently meant:
 * *"Copying prepares text for manual use elsewhere; it does not send a message, package
 * recipient-accessible attachments or record a settlement."* This port is the seam a real
 * transport plugs into, and its shape encodes the three things that must stay true once one
 * is plugged in.
 *
 *  - **Sending is a separate act from generating.** Nothing in this interface can be reached
 *    from `buildProofPackPreview`; the only caller is `services.sendProofPack`, which runs
 *    after an explicit review. Generating a pack still writes nothing and sends nothing
 *    (ADR-0047).
 *  - **A transport reports what happened, and never decides what it means.** `send` resolves
 *    with an outcome — accepted with a provider id, or refused with a reason — rather than
 *    throwing for a provider-side refusal, because "WhatsApp rejected this number" is a fact
 *    about the delivery that has to be recorded, not a crash that loses it. A genuine
 *    programming fault still throws.
 *  - **Credentials never cross it.** They belong to the adapter's closure, built in
 *    `src/server.ts` from the environment. No type here has a field that could carry one, and
 *    `describe()` names the *variables* that are missing, never their values
 *    (`security-model.md`).
 *
 * Sending a pack never records a settlement. A message is a message; money moving is a
 * `Payment` with evidence behind it (`invariants.md` #9, ADR-0047).
 */

import type { EvidenceMediaType, MessageChannel } from '../../domain/index.js';

/** One document to send alongside the message. */
export interface OutgoingAttachment {
  /** A caption the recipient sees. Already redacted by the proof-pack boundary. */
  readonly filename: string;
  readonly mediaType: EvidenceMediaType;
  readonly bytes: Uint8Array;
}

export interface SendMessageInput {
  /** The canonical recipient address for this transport's channel. */
  readonly address: string;
  /** The exact text to send — the same bytes the preview showed and the record stores. */
  readonly body: string;
  readonly attachments: readonly OutgoingAttachment[];
  /**
   * The delivery's idempotency key.
   *
   * Passed through to providers that honour one. A transport that cannot is still safe: the
   * unique index on `proof_pack_deliveries.idempotency_key` means a second send of unchanged
   * content never reaches a transport at all.
   */
  readonly idempotencyKey: string;
}

export interface SendMessageResult {
  /** Whether the provider took responsibility for the message. */
  readonly accepted: boolean;
  /** The provider's own id for it, when accepted. The handle a later status refers to. */
  readonly providerMessageId?: string;
  /** Why it was refused, when it was. Recorded verbatim on the delivery. */
  readonly failureReason?: string;
  /** How many attachments the provider actually took, for a record that can be checked. */
  readonly attachmentsSent: number;
}

/** What a transport is and whether it can do anything, for a screen to say so honestly. */
export interface MessageTransportCapabilities {
  readonly transportId: string;
  readonly channel: MessageChannel;
  readonly label: string;
  readonly configured: boolean;
  /** Names the environment variables that are missing, never their values. */
  readonly unavailableReason?: string;
  /** Whether this transport can carry documents as well as text. */
  readonly supportsAttachments: boolean;
  /** The host the adapter talks to, so "where would this go" is answerable before sending. */
  readonly endpointHost?: string;
  /** The largest attachment the provider accepts, in bytes. */
  readonly maxAttachmentBytes?: number;
}

export interface MessageTransport {
  describe(): MessageTransportCapabilities;
  /**
   * Sends one message.
   *
   * @throws only for a fault in this process. A provider refusal, a timeout or an
   *   unreachable host all resolve with `accepted: false` and a reason, because each of them
   *   is something the delivery record must be able to state.
   */
  send(input: SendMessageInput): Promise<SendMessageResult>;
}
