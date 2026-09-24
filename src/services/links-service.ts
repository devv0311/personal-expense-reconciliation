/**
 * What the ledger has already connected, said in plain words.
 *
 * ```
 * services.listConfirmedLinks ─▶ db.listEvidenceLibrary({ linkage: 'linked' })  the attachments
 *                             ─▶ db.listEvidenceMatchCandidatesForEvidenceIds   how each was decided
 *                             ─▶ db.getPaymentById / getMerchantById / listPeople  what it is attached to
 *                             ─▶ domain.documentWords / matchSignalWords        the wording
 * ```
 *
 * **The other half of "what needs me".** `listAttentionQuestions` answers what is still open;
 * nothing answered what is already settled, so the product could show a person a list of
 * decisions and never once show them the decisions they had made. A review surface that only
 * ever counts down is one a person cannot check their own work on.
 *
 * Three properties matter here:
 *
 *  - **It computes nothing.** Every field is a stored one, or a word this module maps a stored
 *    one onto. There is no arithmetic in this file and no judgement about whether a link was
 *    right — a link is somebody's recorded decision and this read quotes it.
 *  - **How it was decided travels with it.** A document attached at intake and one a person
 *    accepted from an offer are both links and are not the same act. `decidedAt`/`decidedBy`
 *    come from the accepted candidate when there was one, and `how` names which of the two it
 *    is rather than leaving a blank byline to be read as "the system did it".
 *  - **Absence is stated.** A link whose payment has since been reduced to a stub, or which
 *    points at an expense rather than a payment, comes back with `payment: null` and a
 *    sentence. It is never a row with an empty amount column.
 */

import { asId, documentWords, matchSignalWords } from '../domain/index.js';
import type { EvidenceId, Paise, PaymentDirection, PaymentId } from '../domain/index.js';
import {
  countEvidenceLibrary,
  getMerchantById,
  getPaymentById,
  listEvidenceLibrary,
  getPersonById,
  listEvidenceMatchCandidatesForEvidenceIds,
} from '../db/index.js';
import type { Executor } from '../db/index.js';

/* ---------------------------------------------------------------------------- shapes */

/** The movement a record is attached to, named the best way anybody has established. */
export interface LinkedPayment {
  readonly paymentId: PaymentId;
  /** The counterparty's name when one is resolved; otherwise the bank's own narration. */
  readonly name: string;
  /** Where {@link name} came from, so a screen can say "this is what your bank wrote". */
  readonly nameSource: 'counterparty' | 'narration';
  readonly occurredAt: Date;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
}

/** How a record came to be attached to what it is attached to. */
export type LinkOrigin = 'you_accepted' | 'attached_when_added';

export interface ConfirmedLink {
  readonly evidenceId: EvidenceId;
  /** "Bill or receipt", "Screenshot", "Payment message", "Note you wrote". */
  readonly recordWords: string;
  readonly capturedAt: Date;
  /** The movement it explains, or `null` with {@link noPaymentBecause} saying why not. */
  readonly payment: LinkedPayment | null;
  readonly noPaymentBecause?: string;
  readonly origin: LinkOrigin;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  /** Why the two were taken to be the same event, one plain sentence per signal. */
  readonly why: readonly string[];
}

export interface ConfirmedLinksResult {
  readonly links: readonly ConfirmedLink[];
  /** Every attached record in the ledger, not just the page returned. */
  readonly total: number;
  readonly truncated: boolean;
}

export interface ConfirmedLinksOptions {
  /** How many to return, newest capture first. */
  readonly limit?: number;
}

/* ------------------------------------------------------------------------------ read */

/**
 * Every record already attached to a movement, newest first.
 *
 * The candidate rows are fetched for the whole page in one query rather than per row: a link
 * without its accepted candidate would lose the only record of *who decided it and when*,
 * which is the field that makes this list auditable rather than decorative.
 */
export async function listConfirmedLinks(
  db: Executor,
  options: ConfirmedLinksOptions = {},
): Promise<ConfirmedLinksResult> {
  const limit = options.limit ?? 20;
  const [rows, total] = await Promise.all([
    listEvidenceLibrary(db, { linkage: 'linked', limit }),
    countEvidenceLibrary(db, { linkage: 'linked' }),
  ]);
  if (rows.length === 0) return { links: [], total, truncated: false };

  const candidates = await listEvidenceMatchCandidatesForEvidenceIds(
    db,
    rows.map((row) => row.id),
  );
  const accepted = new Map(
    candidates.filter((candidate) => candidate.status === 'accepted').map((c) => [c.evidenceId, c]),
  );

  const links: ConfirmedLink[] = [];
  for (const row of rows) {
    const candidate = accepted.get(row.id) ?? null;
    links.push({
      evidenceId: row.id,
      recordWords: documentWords(row.type),
      capturedAt: row.capturedAt,
      ...(await attachedTo(db, row.linkedPaymentId)),
      origin: candidate === null ? 'attached_when_added' : 'you_accepted',
      decidedAt: candidate?.decidedAt ?? null,
      decidedBy: candidate?.decidedBy ?? null,
      why:
        candidate === null
          ? []
          : candidate.matchedSignals.map((signal) => matchSignalWords(signal, 'agreed')),
    });
  }

  return { links, total, truncated: total > links.length };
}

/**
 * The movement side of one link.
 *
 * A record attached to an expense rather than a payment is a real state — a receipt filed
 * against a purchase whose money movement never landed on a statement — so it comes back
 * named rather than as a row with three empty columns.
 */
async function attachedTo(
  db: Executor,
  paymentId: PaymentId | null,
): Promise<{ payment: LinkedPayment | null; noPaymentBecause?: string }> {
  if (paymentId === null) {
    return {
      payment: null,
      noPaymentBecause: 'This record is filed against an expense rather than a single payment.',
    };
  }
  const payment = await getPaymentById(db, paymentId);
  if (payment === null) {
    return {
      payment: null,
      noPaymentBecause: 'The payment this was attached to is no longer on record.',
    };
  }
  return {
    payment: {
      paymentId: payment.id,
      ...(await paymentName(db, payment)),
      occurredAt: payment.occurredAt,
      amount: payment.amount,
      direction: payment.direction,
    },
  };
}

/**
 * The best name this movement has, and which of the two it is.
 *
 * Same ranking `getPaymentConnection` applies and for the same reason: a raw narration
 * presented as a chosen name reads as though somebody had established it, and on a ledger of
 * imported statements most of them are the bank's words. The connection view has two more
 * sources (an attached record, the expense it funded); this list deliberately stops at the two
 * a single row can stand behind without loading the whole event.
 */
async function paymentName(
  db: Executor,
  payment: { counterpartyType: string; counterpartyId: string | null; rawDescription: string },
): Promise<{ name: string; nameSource: 'counterparty' | 'narration' }> {
  if (payment.counterpartyId !== null) {
    if (payment.counterpartyType === 'merchant') {
      const merchant = await getMerchantById(db, asId<'merchant'>(payment.counterpartyId));
      if (merchant !== null) return { name: merchant.canonicalName, nameSource: 'counterparty' };
    }
    if (payment.counterpartyType === 'person') {
      const person = await getPersonById(db, asId<'person'>(payment.counterpartyId));
      if (person !== null) return { name: person.displayName, nameSource: 'counterparty' };
    }
  }
  return { name: payment.rawDescription, nameSource: 'narration' };
}
