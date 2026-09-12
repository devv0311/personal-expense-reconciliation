/**
 * Sending a reviewed proof pack, and keeping a record of having sent it (audit row 42).
 *
 * The audit's wording was exact: *"Copying prepares text for manual use elsewhere; it does
 * not send a message, package recipient-accessible attachments or record a settlement."* This
 * service is the send. The last clause of that sentence still holds — **nothing here records
 * a settlement**, because a message is not money moving (`invariants.md` #9, ADR-0047).
 *
 * The order of operations is the design, and it is deliberately not the obvious one:
 *
 *  1. **Rebuild the pack server-side.** The text that goes out is derived here, now, from the
 *     canonical ledger — never a body the caller posted. A browser that could supply the
 *     message body could send any figure it liked over the user's own WhatsApp account,
 *     which is precisely the "the frontend performs no financial arithmetic" rule (ADR-0048)
 *     applied at its most consequential point.
 *  2. **Check the review, then the attachments, then the address.** All three refuse before
 *     anything is claimed or sent.
 *  3. **Claim the idempotency key inside a transaction, and audit the claim.** The row exists
 *     in `pending` *before* the transport is called. If the process dies mid-send, what
 *     survives is a delivery that says it was attempted — not silence.
 *  4. **Call the transport outside that transaction**, then record the outcome in a second
 *     audited unit of work. A long provider call must not hold a database transaction open,
 *     and a provider refusal must leave a visible `failed` row rather than roll back into
 *     nothing.
 *
 * A resend of unchanged content never reaches step 4 at all: step 3 collides with the unique
 * index and returns the existing record.
 */

import { createHash } from 'node:crypto';

import {
  applyAttemptOutcome,
  assertAttachmentsPermitted,
  assertProviderStatusTransition,
  assertRetryable,
  assertReviewed,
  canonicalizeAddress,
  canRetryDelivery,
  deliveryIdempotencyKey,
  isAttachableEvidenceType,
  MAX_DELIVERY_ATTEMPTS,
} from '../domain/index.js';
import type {
  DeliveryReview,
  EvidenceId,
  MessageChannel,
  PersonId,
  ProofPackDeliveryId,
  ProposedAttachment,
} from '../domain/index.js';
import {
  getDeliveryByProviderMessageId,
  getEvidenceById,
  getPersonById,
  getProofPackDelivery,
  insertDeliveryIfNew,
  listProofPackDeliveries,
  updateDeliveryProgress,
} from '../db/index.js';
import type { Database, DeliveryAttachmentRecord, ProofPackDeliveryRow } from '../db/index.js';
import type { EvidenceStore } from '../integrations/evidence-store/index.js';
import type {
  MessageTransport,
  MessageTransportCapabilities,
  OutgoingAttachment,
} from '../integrations/message-transport/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';
import { buildProofPackPreview } from './proof-pack-service.js';
import { readEvidenceDocument } from './evidence-service.js';

/** What a screen needs to say whether sending is available here, before anything is typed. */
export interface MessagingStatus extends MessageTransportCapabilities {
  /** The evidence types that may ever be attached, so the UI states the rule rather than guesses. */
  readonly attachableEvidenceTypes: readonly string[];
  readonly maxAttempts: number;
}

export function getMessagingStatus(transport: MessageTransport): MessagingStatus {
  return {
    ...transport.describe(),
    attachableEvidenceTypes: ['receipt_image', 'email_receipt'],
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
  };
}

export interface SendProofPackInput {
  readonly userPersonId: PersonId;
  readonly recipientPersonId: PersonId;
  readonly channel: MessageChannel;
  /** The recipient's address as typed. Canonicalized before anything else happens. */
  readonly address: string;
  /** The three confirmations. Enforced here as well as in the browser. */
  readonly review: DeliveryReview;
  /** Evidence the pack cites, to attach. Each is checked against the allowlist. */
  readonly attachEvidenceIds?: readonly EvidenceId[];
  /**
   * The as-of label the reviewer saw.
   *
   * Required, and load-bearing: it pins the pack to the one that was reviewed. The figures
   * are always current (ADR-0047 — `asOf` is a label, not a filter), so this does not freeze
   * the ledger; it makes a stale review visible through `contentDigestSeen`.
   */
  readonly asOf: Date;
  /**
   * The digest of the text the reviewer actually read, when the caller has one.
   *
   * A ledger that moved between review and send produces a different digest here, and the
   * send is refused rather than quietly delivering a message nobody approved.
   */
  readonly contentDigestSeen?: string;
  readonly transport: MessageTransport;
  readonly store: EvidenceStore;
  readonly audit: AuditMeta;
}

export interface ProofPackDeliveryResult {
  readonly delivery: ProofPackDeliveryRow;
  /**
   * `false` when an identical delivery already existed — the same recipient, address,
   * message and attachments — and nothing was sent a second time.
   */
  readonly sentNow: boolean;
}

/**
 * Sends one reviewed proof pack.
 *
 * @throws ServiceError `ENTITY_NOT_FOUND` for an unknown recipient or evidence row.
 * @throws DomainError `PROOF_PACK_REVIEW_INCOMPLETE` / `PROOF_PACK_ADDRESS_INVALID` /
 *   `PROOF_PACK_ATTACHMENT_REFUSED` before anything is claimed or sent.
 * @throws ServiceError `PRECONDITION_FAILED` when the pack changed since it was reviewed.
 * @throws ServiceError `MESSAGE_DELIVERY_FAILED` when the transport refused — **after** a
 *   `failed` delivery row has been written, so the attempt is visible and retryable.
 */
export async function sendProofPack(
  db: Database,
  input: SendProofPackInput,
): Promise<ProofPackDeliveryResult> {
  assertReviewed(input.review);
  const address = canonicalizeAddress(input.channel, input.address);

  const capabilities = input.transport.describe();

  // The message is derived here, from the ledger, at send time. Never posted by the caller.
  const preview = await buildProofPackPreview(db, {
    userPersonId: input.userPersonId,
    recipientPersonId: input.recipientPersonId,
    asOf: input.asOf,
  });
  const contentDigest = preview.contentDigest;

  if (input.contentDigestSeen !== undefined && input.contentDigestSeen !== contentDigest) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'The pack changed between being reviewed and being sent — a figure it quotes has moved ' +
        'since you read it. Nothing was sent. Re-read the current message and confirm again.',
      { recipientPersonId: input.recipientPersonId },
    );
  }

  const citedEvidenceIds = new Set(
    preview.evidenceReferences.map((reference) => reference.evidenceId),
  );
  const requested = input.attachEvidenceIds ?? [];
  if (requested.length > 0 && !capabilities.supportsAttachments) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `${capabilities.label} cannot carry documents, so these attachments would be silently ` +
        'dropped. Nothing was sent.',
      { transportId: capabilities.transportId },
    );
  }

  const proposed: ProposedAttachment[] = [];
  for (const evidenceId of requested) {
    const row = await getEvidenceById(db, evidenceId);
    if (row === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', `No evidence with id ${evidenceId}.`, {
        evidenceId,
      });
    }
    proposed.push({
      evidenceId,
      evidenceType: row.type,
      hasStoredDocument: row.storageRef !== null,
      citedByPack: citedEvidenceIds.has(evidenceId),
    });
  }
  assertAttachmentsPermitted(proposed);

  // Bytes are read before the key is claimed: an unreadable document must not leave behind a
  // pending delivery for a message that could never have carried it.
  const outgoing: OutgoingAttachment[] = [];
  const records: DeliveryAttachmentRecord[] = [];
  for (const attachment of proposed) {
    const document = await readEvidenceDocument(db, {
      evidenceId: attachment.evidenceId as EvidenceId,
      store: input.store,
    });
    const filename = attachmentFilename(attachment.evidenceId, document.mediaType);
    outgoing.push({ filename, mediaType: document.mediaType, bytes: document.bytes });
    records.push({
      evidenceId: attachment.evidenceId,
      filename,
      mediaType: document.mediaType,
      byteSize: document.bytes.byteLength,
    });
  }

  const idempotencyKey = deliveryIdempotencyKey({
    recipientPersonId: input.recipientPersonId,
    channel: input.channel,
    address,
    contentDigest,
    attachmentDigest: digestOf(
      records
        .map((record) => record.evidenceId)
        .sort()
        .join('|'),
    ),
  });

  const recipient = await getPersonById(db, input.recipientPersonId);
  if (recipient === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No person with id ${input.recipientPersonId}.`, {
      recipientPersonId: input.recipientPersonId,
    });
  }

  // Step 3: claim the key. The row exists before the transport is touched.
  const claim = await runAudited(db, input.audit, async ({ exec, record }) => {
    const result = await insertDeliveryIfNew(exec, {
      recipientPersonId: input.recipientPersonId,
      channel: input.channel,
      address,
      bodyText: preview.generatedText,
      contentDigest,
      attachments: records,
      idempotencyKey,
      packAsOf: input.asOf,
      transportId: capabilities.transportId,
    });
    await record({
      entityType: 'proof_pack_delivery',
      entityId: result.row.id,
      action: result.created ? 'create' : 'update',
      newValue: {
        recipientPersonId: input.recipientPersonId,
        channel: input.channel,
        // The address is deliberately recorded in the audit trail: "who did I send this to"
        // is the question the record exists to answer, and a masked one could not answer it.
        address,
        contentDigest,
        attachments: records.map((attachment) => attachment.evidenceId),
        alreadyExisted: !result.created,
      },
      reason: result.created
        ? null
        : 'An identical pack had already been sent to this address; nothing was sent again.',
    });
    return result;
  });

  if (!claim.created) {
    return { delivery: claim.row, sentNow: false };
  }

  return attemptDelivery(db, {
    delivery: claim.row,
    body: preview.generatedText,
    attachments: outgoing,
    transport: input.transport,
    audit: input.audit,
  });
}

export interface RetryProofPackDeliveryInput {
  readonly deliveryId: ProofPackDeliveryId;
  readonly transport: MessageTransport;
  readonly store: EvidenceStore;
  readonly audit: AuditMeta;
}

/**
 * Attempts a failed delivery again, sending exactly what was recorded the first time.
 *
 * The body is read from the record rather than re-derived, which is the opposite of the
 * first send and correct for the same reason: a retry is another attempt at *this* message.
 * Re-deriving it could send a different one under a record that says otherwise.
 *
 * @throws DomainError `PROOF_PACK_DELIVERY_NOT_RETRYABLE` for anything not `failed`, or out
 *   of attempts.
 */
export async function retryProofPackDelivery(
  db: Database,
  input: RetryProofPackDeliveryInput,
): Promise<ProofPackDeliveryResult> {
  const delivery = await requireDelivery(db, input.deliveryId);
  assertRetryable(delivery);

  const attachments: OutgoingAttachment[] = [];
  for (const record of delivery.attachments) {
    const document = await readEvidenceDocument(db, {
      evidenceId: record.evidenceId as EvidenceId,
      store: input.store,
    });
    attachments.push({
      filename: record.filename,
      mediaType: document.mediaType,
      bytes: document.bytes,
    });
  }

  return attemptDelivery(db, {
    delivery,
    body: delivery.bodyText,
    attachments,
    transport: input.transport,
    audit: input.audit,
  });
}

export interface ApplyDeliveryStatusInput {
  readonly transportId: string;
  readonly providerMessageId: string;
  readonly status: 'delivered' | 'failed';
  readonly detail?: string;
  readonly audit: AuditMeta;
}

/**
 * Applies a provider's own delivery status to the record it refers to.
 *
 * The one place an external system moves a row in this table, and it is bounded hard: it may
 * only advance a message this ledger actually handed over (`assertProviderStatusTransition`),
 * it may never create a delivery, and it may never touch what was sent. A callback for an
 * unknown id is `ENTITY_NOT_FOUND` rather than a new row — an external system that could
 * mint delivery records could assert that anything had been shared with anyone.
 */
export async function applyProviderDeliveryStatus(
  db: Database,
  input: ApplyDeliveryStatusInput,
): Promise<ProofPackDeliveryRow> {
  const existing = await getDeliveryByProviderMessageId(
    db,
    input.transportId,
    input.providerMessageId,
  );
  if (existing === null) {
    throw new ServiceError(
      'ENTITY_NOT_FOUND',
      `No delivery was sent through ${input.transportId} with provider id ` +
        `${input.providerMessageId}. A status callback cannot create one.`,
      { transportId: input.transportId },
    );
  }
  assertProviderStatusTransition(existing.status, input.status);

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const now = new Date();
    await updateDeliveryProgress(exec, existing.id, {
      status: input.status,
      attemptCount: existing.attemptCount,
      lastError:
        input.status === 'failed'
          ? (input.detail ?? 'The provider reported the message failed after accepting it.')
          : null,
      providerMessageId: existing.providerMessageId,
      sentAt: existing.sentAt,
      deliveredAt: input.status === 'delivered' ? now : null,
    });
    await record({
      entityType: 'proof_pack_delivery',
      entityId: existing.id,
      action: 'update',
      oldValue: { status: existing.status },
      newValue: { status: input.status, detail: input.detail ?? null },
      reason: `${input.transportId} reported this message ${input.status}.`,
    });
    const updated = await getProofPackDelivery(exec, existing.id);
    if (updated === null) throw new Error('The delivery vanished mid-transaction.');
    return updated;
  });
}

export interface ProofPackDeliveryView extends ProofPackDeliveryRow {
  readonly recipientDisplayName: string;
  readonly retryable: boolean;
}

/** Every delivery, newest first — the auditable sharing record, as a read. */
export async function listProofPackDeliveryHistory(
  db: Database,
  filter: { readonly recipientPersonId?: PersonId; readonly limit?: number } = {},
): Promise<readonly ProofPackDeliveryView[]> {
  const rows = await listProofPackDeliveries(db, filter);
  const views: ProofPackDeliveryView[] = [];
  for (const row of rows) {
    const person = await getPersonById(db, row.recipientPersonId);
    views.push({
      ...row,
      recipientDisplayName: person?.displayName ?? 'Unknown recipient',
      retryable: canRetryDelivery(row),
    });
  }
  return views;
}

/* ------------------------------------------------------------------------- internals */

interface AttemptInput {
  readonly delivery: ProofPackDeliveryRow;
  readonly body: string;
  readonly attachments: readonly OutgoingAttachment[];
  readonly transport: MessageTransport;
  readonly audit: AuditMeta;
}

/**
 * One attempt: call the transport, then record what it said.
 *
 * The transport call is outside any transaction, and its outcome — success or refusal — is
 * always written. A refusal then raises `MESSAGE_DELIVERY_FAILED` *after* the record exists,
 * so the caller gets an error and the ledger keeps the evidence that an attempt was made.
 */
async function attemptDelivery(
  db: Database,
  input: AttemptInput,
): Promise<ProofPackDeliveryResult> {
  const outcome = await input.transport.send({
    address: input.delivery.address,
    body: input.body,
    attachments: input.attachments,
    idempotencyKey: input.delivery.idempotencyKey,
  });

  const change = applyAttemptOutcome(
    {
      attemptCount: input.delivery.attemptCount,
      providerMessageId: input.delivery.providerMessageId,
    },
    {
      accepted: outcome.accepted,
      providerMessageId: outcome.providerMessageId,
      failureReason: outcome.failureReason,
    },
    new Date(),
  );

  const updated = await runAudited(db, input.audit, async ({ exec, record }) => {
    await updateDeliveryProgress(exec, input.delivery.id, {
      status: change.status,
      attemptCount: change.attemptCount,
      lastError: change.lastError,
      providerMessageId: change.providerMessageId,
      sentAt: change.sentAt,
      deliveredAt: null,
    });
    await record({
      entityType: 'proof_pack_delivery',
      entityId: input.delivery.id,
      action: 'update',
      oldValue: { status: input.delivery.status, attemptCount: input.delivery.attemptCount },
      newValue: {
        status: change.status,
        attemptCount: change.attemptCount,
        providerMessageId: change.providerMessageId,
        attachmentsSent: outcome.attachmentsSent,
        lastError: change.lastError,
      },
      reason: outcome.accepted
        ? `${input.transport.describe().label} accepted the message.`
        : `${input.transport.describe().label} refused it.`,
    });
    const row = await getProofPackDelivery(exec, input.delivery.id);
    if (row === null) throw new Error('The delivery vanished mid-transaction.');
    return row;
  });

  if (!outcome.accepted) {
    throw new ServiceError(
      'MESSAGE_DELIVERY_FAILED',
      change.lastError ?? 'The transport refused without saying why.',
      { deliveryId: updated.id, attemptCount: String(updated.attemptCount) },
    );
  }
  return { delivery: updated, sentNow: true };
}

async function requireDelivery(
  db: Database,
  deliveryId: ProofPackDeliveryId,
): Promise<ProofPackDeliveryRow> {
  const row = await getProofPackDelivery(db, deliveryId);
  if (row === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No delivery with id ${deliveryId}.`, {
      deliveryId,
    });
  }
  return row;
}

/**
 * A filename the recipient sees.
 *
 * Deliberately opaque apart from the word "receipt": a merchant name or the user's own label
 * in a filename is financial context travelling in a field nobody reviewed. The evidence id
 * is already in the pack's own citation list, so the two can still be matched up.
 */
function attachmentFilename(evidenceId: string, mediaType: string): string {
  const extension = mediaType === 'application/pdf' ? 'pdf' : (mediaType.split('/')[1] ?? 'bin');
  return `receipt-${evidenceId.slice(0, 8)}.${extension}`;
}

/** A digest over the attachment set, so adding a document is a different delivery. */
function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Re-exported so a route can name the rule without reaching into `src/domain` twice. */
export { isAttachableEvidenceType };
