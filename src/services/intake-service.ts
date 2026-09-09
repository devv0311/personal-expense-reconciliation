/**
 * Automated notification intake — the forwarding path (audit row 12).
 *
 * The audit's finding was specific: *"No phone capture, notification forwarding adapter or
 * user correction screen."* The correction screen shipped in phase 22. This is the forwarding
 * adapter: one endpoint an ordinary mail rule, an SMS-forwarding app, or a phone automation
 * can POST to, so bank SMS and UPI push notifications reach the ledger without anybody pasting
 * them one at a time.
 *
 * Four rules make an unattended write path safe here, and none of them is negotiable:
 *
 *  - **It writes SOURCE and nothing else.** A forwarded message becomes an immutable
 *    `Evidence` row with the text exactly as it arrived, plus the deterministic structured
 *    reading `domain.parseNotificationText` takes off it. No model, no classification, and no
 *    financial state (`invariants.md` #4, `ai-boundary.md`).
 *  - **Nothing auto-links.** An ingested notification lands unattached and reaches the review
 *    queue's `unmatched_evidence` kind, where a person accepts a candidate. ADR-0034's
 *    write-once linkage and ADR-0037's candidates-only rule are reused, not relaxed — which is
 *    the whole reason an unattended sender can be trusted with this at all.
 *  - **It is idempotent.** A mail rule that re-delivers, or a phone that forwards the same SMS
 *    twice, resolves to the record already stored rather than a second copy of it — the same
 *    dedupe key `recordEvidenceNotification` already applies to a hand-pasted notification.
 *  - **It refuses rather than guessing.** A message with nothing financial in it is reported
 *    as `skipped` with the reason, never stored as a receipt with no content.
 *
 * Transport authentication lives in `src/api` (a dedicated forwarding token, never a session
 * cookie — a mail rule has no browser), because whether a caller is who they say is a
 * transport question and this layer has no business holding an opinion about it.
 */

import { parseNotificationText } from '../domain/index.js';
import type { EvidenceId } from '../domain/index.js';
import type { Database } from '../db/index.js';

import type { AuditMeta } from './audit.js';
import { recordEvidenceNotification } from './evidence-enrichment-service.js';
import type { NotificationEvidenceType } from './evidence-enrichment-service.js';
import { ServiceError } from './errors.js';

/** How many messages one delivery may carry. A mail rule batches; it does not bulk-load. */
export const MAX_FORWARDED_MESSAGES = 200;
/** Bounds one message. A bank SMS is a sentence; anything this long is not one. */
export const MAX_FORWARDED_MESSAGE_LENGTH = 8000;

/** Where a forwarded message came from. Recorded verbatim in the evidence text's header. */
export const FORWARDED_MESSAGE_CHANNELS = ['email', 'sms', 'push', 'webhook'] as const;
export type ForwardedMessageChannel = (typeof FORWARDED_MESSAGE_CHANNELS)[number];

export interface ForwardedMessage {
  readonly channel: ForwardedMessageChannel;
  /** When the forwarder received it. Becomes `evidence.captured_at`. */
  readonly receivedAt: Date;
  /** An email's subject line, or a push notification's title. */
  readonly subject?: string | null;
  /** The message body, exactly as forwarded. */
  readonly body: string;
  /**
   * Who sent it — a sender address or an SMS short-code.
   *
   * Kept because it is genuinely part of what arrived and a reviewer uses it to judge the
   * record ("this came from the bank's own short-code"). It is stored inside the immutable
   * evidence text and, like every other free-text field, is redacted before any AI call and
   * before any proof-pack export (`security-model.md`).
   */
  readonly sender?: string | null;
}

/** What became of one forwarded message. `skipped` is an answer, never a silent drop. */
export interface ForwardedMessageOutcome {
  readonly index: number;
  readonly outcome: 'recorded' | 'already_recorded' | 'skipped';
  readonly evidenceId: EvidenceId | null;
  readonly evidenceType: NotificationEvidenceType | null;
  /** Present on `skipped`, and on nothing else. */
  readonly reason?: string;
}

export interface IngestForwardedMessagesInput {
  readonly messages: readonly ForwardedMessage[];
  readonly audit: AuditMeta;
}

export interface IngestForwardedMessagesResult {
  readonly recorded: number;
  readonly alreadyRecorded: number;
  readonly skipped: number;
  readonly outcomes: readonly ForwardedMessageOutcome[];
}

/**
 * Ingests a batch of forwarded messages as immutable notification evidence.
 *
 * Each message is independent: one unusable message does not fail the batch, because a mail
 * rule delivering a marketing email alongside three real alerts should not cost the three.
 * That is the opposite of `importStatement`'s all-or-nothing rule, and deliberately so — a
 * statement is one document whose rows must all land together or the ledger is quietly short,
 * while a batch of forwarded messages is a bag of independent records.
 *
 * @throws ServiceError `PRECONDITION_FAILED` when the batch itself is malformed — empty, over
 *   the size cap, or carrying a message longer than a notification could be.
 */
export async function ingestForwardedMessages(
  db: Database,
  input: IngestForwardedMessagesInput,
): Promise<IngestForwardedMessagesResult> {
  if (input.messages.length === 0) {
    throw new ServiceError('PRECONDITION_FAILED', 'A forwarding delivery carried no messages.');
  }
  if (input.messages.length > MAX_FORWARDED_MESSAGES) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `A forwarding delivery may carry at most ${MAX_FORWARDED_MESSAGES} messages; this one ` +
        `carried ${input.messages.length}. Nothing was ingested.`,
      { limit: String(MAX_FORWARDED_MESSAGES) },
    );
  }

  const outcomes: ForwardedMessageOutcome[] = [];

  for (const [index, message] of input.messages.entries()) {
    const text = composeNotificationText(message);
    if (text.length > MAX_FORWARDED_MESSAGE_LENGTH) {
      outcomes.push({
        index,
        outcome: 'skipped',
        evidenceId: null,
        evidenceType: null,
        reason:
          `This message is ${text.length} characters, past the ${MAX_FORWARDED_MESSAGE_LENGTH}-` +
          'character bound on a notification. It was not stored: a forwarded newsletter is not ' +
          'evidence of a payment, and storing it would put an unreviewable record in the queue.',
      });
      continue;
    }

    const parsed = parseNotificationText(text);
    // The gate: a notification that states neither an amount nor a reference says nothing
    // about a movement, and `domain.validateEvidenceObservation` would refuse it downstream
    // anyway. Refusing here means the caller is told which message and why.
    if (parsed.observedAmount === null && parsed.observedReference === null) {
      outcomes.push({
        index,
        outcome: 'skipped',
        evidenceId: null,
        evidenceType: null,
        reason:
          'Nothing in this message reads as a payment notification — no amount and no ' +
          'reference. It was not stored as evidence of one.',
      });
      continue;
    }

    const evidenceType = classifyNotificationType(text);
    const result = await recordEvidenceNotification(db, {
      type: evidenceType,
      text,
      capturedAt: message.receivedAt,
      audit: input.audit,
    });

    outcomes.push({
      index,
      outcome: result.outcome,
      evidenceId: result.evidenceId,
      evidenceType,
    });
  }

  return {
    recorded: outcomes.filter((outcome) => outcome.outcome === 'recorded').length,
    alreadyRecorded: outcomes.filter((outcome) => outcome.outcome === 'already_recorded').length,
    skipped: outcomes.filter((outcome) => outcome.outcome === 'skipped').length,
    outcomes,
  };
}

/* ------------------------------------------------------------------------- internals */

/**
 * The immutable text stored for a forwarded message.
 *
 * A short provenance header, then the message exactly as it arrived. The header is part of the
 * evidence rather than metadata beside it because a reviewer reading the raw record needs to
 * know it came from a bank's short-code and not from a person typing — and because
 * `evidence.raw_text` is SOURCE, so anything that would have gone in a column would have had
 * to be a second, mutable place for the same fact.
 */
function composeNotificationText(message: ForwardedMessage): string {
  const header = [
    `[forwarded via ${message.channel}]`,
    message.sender === undefined || message.sender === null || message.sender.trim() === ''
      ? null
      : `from: ${message.sender.trim()}`,
    message.subject === undefined || message.subject === null || message.subject.trim() === ''
      ? null
      : `subject: ${message.subject.trim()}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
  return `${header}\n${message.body.trim()}`;
}

/**
 * `upi_notification` or `bank_line`.
 *
 * The reading is deterministic and deliberately conservative: a UPI reference or the word
 * `UPI` makes it a UPI notification, everything else is a bank line. The forwarding *channel*
 * is deliberately not consulted — a bank's card-transaction SMS is a bank line whether it
 * arrived by SMS or by email, and branching on the transport would label the same message two
 * ways depending on how it reached here. Both are payment-side records the matcher treats
 * identically; the distinction exists so a reviewer sees what kind of record they are looking
 * at, not so anything branches on it.
 */
function classifyNotificationType(text: string): NotificationEvidenceType {
  const parsed = parseNotificationText(text);
  if (parsed.observedReferenceType === 'upi_utr' || parsed.observedReferenceType === 'upi_rrn') {
    return 'upi_notification';
  }
  return /\bupi\b/i.test(text) ? 'upi_notification' : 'bank_line';
}
