/**
 * Data access for `proof_pack_deliveries` — the record of what was shared with whom
 * (audit row 42).
 *
 * {@link insertDeliveryIfNew} is the load-bearing one. It is an `INSERT ... ON CONFLICT DO
 * NOTHING RETURNING`, so two concurrent sends of the same unchanged pack race into the unique
 * index and exactly one of them wins; the loser reads back the winner's row and reports it
 * rather than sending a second message. A `SELECT` followed by an `INSERT` would leave a
 * window in which both callers believed they were the first.
 *
 * Nothing here updates the columns that describe what left — recipient, address, body,
 * digest, attachments. Only a delivery's own progress moves.
 */

import { and, desc, eq } from 'drizzle-orm';

import type { MessageChannel, ProofPackDeliveryStatus } from '../domain/enums.js';
import type { PersonId, ProofPackDeliveryId } from '../domain/ids.js';

import type { Executor } from './repositories.js';
import { proofPackDeliveries } from './schema.js';

/** One attachment as it is recorded on the delivery. Bytes stay in the evidence store. */
export interface DeliveryAttachmentRecord {
  readonly evidenceId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

export interface ProofPackDeliveryRow {
  readonly id: ProofPackDeliveryId;
  readonly recipientPersonId: PersonId;
  readonly channel: MessageChannel;
  readonly address: string;
  readonly bodyText: string;
  readonly contentDigest: string;
  readonly attachments: readonly DeliveryAttachmentRecord[];
  readonly idempotencyKey: string;
  readonly packAsOf: Date;
  readonly status: ProofPackDeliveryStatus;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly providerMessageId: string | null;
  readonly transportId: string;
  readonly sentAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRow(row: typeof proofPackDeliveries.$inferSelect): ProofPackDeliveryRow {
  return {
    id: row.id as ProofPackDeliveryId,
    recipientPersonId: row.recipientPersonId as PersonId,
    channel: row.channel as MessageChannel,
    address: row.address,
    bodyText: row.bodyText,
    contentDigest: row.contentDigest,
    attachments: (row.attachments ?? []) as readonly DeliveryAttachmentRecord[],
    idempotencyKey: row.idempotencyKey,
    packAsOf: row.packAsOf,
    status: row.status as ProofPackDeliveryStatus,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    providerMessageId: row.providerMessageId,
    transportId: row.transportId,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ProofPackDeliveryDraft {
  readonly recipientPersonId: PersonId;
  readonly channel: MessageChannel;
  readonly address: string;
  readonly bodyText: string;
  readonly contentDigest: string;
  readonly attachments: readonly DeliveryAttachmentRecord[];
  readonly idempotencyKey: string;
  readonly packAsOf: Date;
  readonly transportId: string;
}

/**
 * Claims the idempotency key, or reports that somebody already has it.
 *
 * `created: false` means an identical delivery exists — same recipient, same address, same
 * message, same attachments. The caller returns that record and sends nothing.
 */
export async function insertDeliveryIfNew(
  exec: Executor,
  draft: ProofPackDeliveryDraft,
): Promise<{ readonly row: ProofPackDeliveryRow; readonly created: boolean }> {
  const [inserted] = await exec
    .insert(proofPackDeliveries)
    .values({
      recipientPersonId: draft.recipientPersonId,
      channel: draft.channel,
      address: draft.address,
      bodyText: draft.bodyText,
      contentDigest: draft.contentDigest,
      attachments: draft.attachments,
      idempotencyKey: draft.idempotencyKey,
      packAsOf: draft.packAsOf,
      transportId: draft.transportId,
    })
    .onConflictDoNothing({ target: proofPackDeliveries.idempotencyKey })
    .returning();

  if (inserted !== undefined) return { row: toRow(inserted), created: true };

  const existing = await getDeliveryByIdempotencyKey(exec, draft.idempotencyKey);
  if (existing === null) {
    throw new Error(
      'The delivery insert conflicted but the conflicting row could not be read back.',
    );
  }
  return { row: existing, created: false };
}

export async function getDeliveryByIdempotencyKey(
  exec: Executor,
  idempotencyKey: string,
): Promise<ProofPackDeliveryRow | null> {
  const [row] = await exec
    .select()
    .from(proofPackDeliveries)
    .where(eq(proofPackDeliveries.idempotencyKey, idempotencyKey))
    .limit(1);
  return row === undefined ? null : toRow(row);
}

export async function getProofPackDelivery(
  exec: Executor,
  deliveryId: ProofPackDeliveryId,
): Promise<ProofPackDeliveryRow | null> {
  const [row] = await exec
    .select()
    .from(proofPackDeliveries)
    .where(eq(proofPackDeliveries.id, deliveryId))
    .limit(1);
  return row === undefined ? null : toRow(row);
}

/** Every delivery, newest first — optionally narrowed to one recipient. */
export async function listProofPackDeliveries(
  exec: Executor,
  filter: { readonly recipientPersonId?: PersonId; readonly limit?: number } = {},
): Promise<readonly ProofPackDeliveryRow[]> {
  const query = exec.select().from(proofPackDeliveries);
  const rows =
    filter.recipientPersonId === undefined
      ? await query.orderBy(desc(proofPackDeliveries.createdAt)).limit(filter.limit ?? 50)
      : await query
          .where(eq(proofPackDeliveries.recipientPersonId, filter.recipientPersonId))
          .orderBy(desc(proofPackDeliveries.createdAt))
          .limit(filter.limit ?? 50);
  return rows.map(toRow);
}

/** Moves a delivery's own progress. Never touches what was sent. */
export async function updateDeliveryProgress(
  exec: Executor,
  deliveryId: ProofPackDeliveryId,
  change: {
    readonly status: ProofPackDeliveryStatus;
    readonly attemptCount: number;
    readonly lastError: string | null;
    readonly providerMessageId: string | null;
    readonly sentAt: Date | null;
    readonly deliveredAt?: Date | null;
  },
): Promise<void> {
  await exec
    .update(proofPackDeliveries)
    .set({
      status: change.status,
      attemptCount: change.attemptCount,
      lastError: change.lastError,
      providerMessageId: change.providerMessageId,
      sentAt: change.sentAt,
      ...(change.deliveredAt === undefined ? {} : { deliveredAt: change.deliveredAt }),
      updatedAt: new Date(),
    })
    .where(eq(proofPackDeliveries.id, deliveryId));
}

/**
 * Finds the delivery a provider status callback refers to.
 *
 * Matched on the provider's own id *and* the transport that produced it: two transports can
 * legitimately mint the same id, and applying one provider's status to another's message
 * would be the external world rewriting a record it has no claim on.
 */
export async function getDeliveryByProviderMessageId(
  exec: Executor,
  transportId: string,
  providerMessageId: string,
): Promise<ProofPackDeliveryRow | null> {
  const [row] = await exec
    .select()
    .from(proofPackDeliveries)
    .where(
      and(
        eq(proofPackDeliveries.transportId, transportId),
        eq(proofPackDeliveries.providerMessageId, providerMessageId),
      ),
    )
    .limit(1);
  return row === undefined ? null : toRow(row);
}
