/**
 * What one piece of evidence *observes* about a money movement (Phase 17, ADR-0044).
 *
 * `Evidence` is SOURCE and immutable: a bank SMS, a UPI push notification, a photographed
 * receipt. What it says is free text, and free text cannot be matched against a `Payment`.
 * An `EvidenceObservation` is the DERIVED, structured reading of that text — amount,
 * direction, reference, account tail, merchant, instant — recorded beside the evidence, never
 * written back into it.
 *
 * Everything here is pure and deterministic. There is no model on this path and there must
 * not be one: reading `Rs.450.00 debited ... UPI Ref 402312345678` off a bank's own SMS with
 * a fixed grammar is parsing, not inference (`ai-boundary.md`'s division: arithmetic and
 * deterministic evidence belong to application code). Where the grammar does not match, the
 * field comes back `null` — an honest "this text does not say" — rather than a guess.
 *
 * The one rule worth stating twice: **nothing here rewrites a `Payment`'s narration.** A
 * payment's `raw_description` is what the bank said and stays what the bank said
 * (`invariants.md` #4); an observation is a second, separately-attributed reading that sits
 * alongside it (`evidence-context.ts` is where the two are shown together).
 */

import type {
  EvidenceObservationDerivation,
  PaymentDirection,
  PaymentReferenceType,
} from './enums.js';
import { DomainError } from './errors.js';
import type { Paise } from './money.js';

/* ------------------------------------------------------------------------ the shape */

/** The structured facts one evidence record asserts about a movement. Every field optional. */
export interface EvidenceObservationFields {
  /** Exact minor units, when the text or the caller stated one. */
  readonly observedAmount: Paise | null;
  readonly observedDirection: PaymentDirection | null;
  /** The identifier as observed, before normalization — kept verbatim for display. */
  readonly observedReference: string | null;
  readonly observedReferenceType: PaymentReferenceType | null;
  /** Masked trailing digits only, never a full account number (`security-model.md`). */
  readonly observedAccountHint: string | null;
  readonly observedMerchantText: string | null;
  /** When the movement happened, if stated. Distinct from `Evidence.captured_at`. */
  readonly observedOccurredAt: Date | null;
  readonly derivation: EvidenceObservationDerivation;
}

/** Trailing digits, and only trailing digits — mirrors `accounts_last4_check`. */
const ACCOUNT_HINT_PATTERN = /^[0-9]{1,4}$/;

/**
 * Refuses an observation that observes nothing, or that carries an identifier it must not.
 *
 * Two rules, and both mirror a database `CHECK`:
 *
 *  1. **An observation must observe something.** A row with every field null is a reading
 *     that read nothing; it would enter the matcher, contribute no signal, and sit against
 *     the evidence forever asserting that the document was understood when it was not.
 *  2. **The account hint is a masked tail.** `security-model.md` forbids storing a full
 *     account or card number anywhere, and `accounts.last4` already enforces exactly this
 *     shape on the other side of the comparison. An observation is where an SMS's
 *     `A/C XXXX4821` enters the system, so it is where the rule has to hold.
 */
export function validateEvidenceObservation(fields: EvidenceObservationFields): void {
  const observesSomething =
    fields.observedAmount !== null ||
    fields.observedDirection !== null ||
    fields.observedReference !== null ||
    fields.observedAccountHint !== null ||
    fields.observedMerchantText !== null ||
    fields.observedOccurredAt !== null;

  if (!observesSomething) {
    throw new DomainError(
      'EVIDENCE_OBSERVATION_EMPTY',
      'This observation records no amount, direction, reference, account, merchant or ' +
        'instant — nothing the matcher could compare against a Payment. Evidence that could ' +
        'not be read is evidence with no observation, not an observation full of nulls.',
      { derivation: fields.derivation },
    );
  }

  if (fields.observedAmount !== null && fields.observedAmount <= 0n) {
    throw new DomainError(
      'EVIDENCE_OBSERVATION_INVALID',
      `The observed amount is ${fields.observedAmount} paise. A movement of zero or less is ` +
        'not a movement; direction carries the sign in this system, never the amount.',
      { observedAmount: fields.observedAmount.toString() },
    );
  }

  if (
    fields.observedAccountHint !== null &&
    !ACCOUNT_HINT_PATTERN.test(fields.observedAccountHint)
  ) {
    // Deliberately reports the length rather than the value. The offending input is, by
    // definition, something longer than a masked tail — quite possibly a full account or card
    // number — and this message reaches error responses and logs, which `security-model.md`
    // keeps free of exactly that.
    throw new DomainError(
      'EVIDENCE_OBSERVATION_INVALID',
      `The observed account hint is ${fields.observedAccountHint.length} characters and is ` +
        'not a masked account tail. Only the trailing 1-4 digits may be stored — never a full ' +
        'account or card number (security-model.md), which is the same rule accounts.last4 ' +
        'already carries on the other side of the match. The value is not repeated here.',
      { observedAccountHintLength: String(fields.observedAccountHint.length) },
    );
  }
}

/* -------------------------------------------------------------------- normalization */

/**
 * The comparable form of a reference identifier.
 *
 * A UTR reaches this system through several mouths — `UPI/2607011234/BLINKIT` on a statement
 * line, `UPI Ref no. 2607011234` in an SMS, `2607011234` in a push payload — and comparing
 * them literally would find no match where an obvious one exists. Upper-cased and stripped of
 * everything but letters and digits, the three become one key.
 *
 * `null` for an empty or punctuation-only value: there is no such thing as an empty
 * identifier, and returning `''` would make two references with nothing in them "match".
 */
export function normalizeReference(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length === 0 ? null : normalized;
}

/**
 * Whether two reference identifiers name the same transaction.
 *
 * Containment, not equality, and deliberately: a statement's `UPI/2607011234/BLINKIT` and an
 * SMS's `2607011234` are the same UTR wearing different amounts of the bank's own packaging.
 * Requiring a minimum length keeps that from degenerating — a two-character "reference"
 * contained in a longer one is a coincidence, not a match.
 */
export const MIN_COMPARABLE_REFERENCE_LENGTH = 6;

export function referencesMatch(a: string | null, b: string | null): boolean {
  const left = normalizeReference(a);
  const right = normalizeReference(b);
  if (left === null || right === null) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < MIN_COMPARABLE_REFERENCE_LENGTH) return false;
  return longer.includes(shorter);
}

/* ------------------------------------------------------------------------- identity */

/**
 * The deterministic identity of an incoming **notification**, for idempotent re-ingestion.
 *
 * The same push notification forwarded twice, or the same SMS export imported twice, must
 * resolve to the one evidence record it is rather than to two rows a reviewer has to dismiss
 * separately — the rule `ingestEvidenceDocument` already applies to bytes, applied here to
 * text that has no content address of its own.
 *
 * Built from what identifies the *movement* (reference, amount, direction, instant) plus the
 * evidence type, so the same UTR observed by an SMS and by a receipt stays two observations
 * of one transaction rather than collapsing into one. Where nothing identifying was read, the
 * raw text itself is the key: two notifications that say exactly the same thing at the same
 * captured instant are the same notification twice.
 *
 * **This is deliberately not an identity for observations in general.** A reading derived from
 * an `Evidence` row that already exists — a receipt's extracted total, a human's correction —
 * carries no key at all, because that row's own id is already its identity. Making every
 * observation carry one would mean two receipts that happen to total the same amount collide,
 * and the second one's reading would be lost to a uniqueness rule that was never about it.
 */
export function notificationDedupeKey(input: {
  readonly evidenceType: string;
  readonly capturedAt: Date;
  readonly rawText: string | null;
  readonly fields: EvidenceObservationFields;
}): string {
  const { fields } = input;
  const reference = normalizeReference(fields.observedReference);
  const parts = [
    input.evidenceType,
    reference ?? '-',
    fields.observedAmount === null ? '-' : fields.observedAmount.toString(),
    fields.observedDirection ?? '-',
    fields.observedOccurredAt === null ? '-' : fields.observedOccurredAt.toISOString(),
  ];
  if (reference === null && fields.observedAmount === null) {
    // Nothing identifying was read, so the text is the only identity available.
    parts.push(input.capturedAt.toISOString(), collapseWhitespace(input.rawText ?? ''));
  }
  return parts.join('|');
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

/* -------------------------------------------------------------- notification parsing */

/** What {@link parseNotificationText} could read. Absent fields are `null`, never guessed. */
export interface ParsedNotification {
  readonly observedAmount: Paise | null;
  readonly observedDirection: PaymentDirection | null;
  readonly observedReference: string | null;
  readonly observedReferenceType: PaymentReferenceType | null;
  readonly observedAccountHint: string | null;
  readonly observedMerchantText: string | null;
}

const AMOUNT_PATTERN = /(?:INR|RS\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;

const DEBIT_WORDS = /\b(debited|debit|withdrawn|paid|sent|spent)\b/i;
const CREDIT_WORDS = /\b(credited|credit|received|deposited|refunded|refund)\b/i;

/**
 * Reference labels, most specific first.
 *
 * Order matters: `UPI Ref no` must be tried before a bare `Ref no`, or the more specific
 * label's reference type would be lost to the general one.
 */
const REFERENCE_RULES: readonly {
  readonly pattern: RegExp;
  readonly referenceType: PaymentReferenceType;
}[] = [
  {
    pattern: /\bUPI(?:\s*Ref(?:erence)?)?(?:\s*(?:No|Number))?\.?\s*[:#-]?\s*([A-Z0-9]{6,})/i,
    referenceType: 'upi_utr',
  },
  { pattern: /\bUTR\.?\s*(?:No|Number)?\.?\s*[:#-]?\s*([A-Z0-9]{6,})/i, referenceType: 'upi_utr' },
  { pattern: /\bRRN\.?\s*(?:No|Number)?\.?\s*[:#-]?\s*([A-Z0-9]{6,})/i, referenceType: 'upi_rrn' },
  {
    pattern: /\bOrder\s*(?:ID|No|Number)\.?\s*[:#-]?\s*([A-Z0-9-]{6,})/i,
    referenceType: 'merchant_order_id',
  },
  {
    pattern: /\bRef(?:erence)?\.?\s*(?:No|Number)?\.?\s*[:#-]?\s*([A-Z0-9]{6,})/i,
    referenceType: 'bank_reference',
  },
];

const ACCOUNT_HINT_SOURCE_PATTERN =
  /\b(?:A\/C|AC|ACCT|ACCOUNT|CARD)\.?\s*(?:No\.?)?\s*[:#-]?\s*[X*x]*\s*(\d{1,4})\b/i;

/**
 * The merchant/counterparty a notification names.
 *
 * Anchored on the prepositions a bank actually uses (`to`, `at`, `towards`, `from`), and
 * stopped at the first clause boundary — a reference label, `on <date>`, or terminal
 * punctuation. Deliberately conservative: over-reading here would hand the matcher a
 * merchant signal built out of half a sentence, and a wrong `conflicted` verdict is worse
 * than an honest `absent` one.
 */
const MERCHANT_PATTERN =
  /\b(?:to|at|towards|from)\s+([A-Za-z][A-Za-z0-9&'.\- ]{1,48}?)(?=\s*(?:\bon\b|\bUPI\b|\bUTR\b|\bRRN\b|\bRef\b|\bOrder\b|\bA\/C\b|[.,;:!?\n]|$))/i;

/**
 * Reads what a bank SMS or UPI push notification says, deterministically.
 *
 * Every field is independent: a notification that states an amount and a reference but no
 * merchant yields exactly those two, and the rest stay `null`. That partiality is the normal
 * case, and the matcher is built to work from whatever subset it is given
 * (`evidence-matching.ts`).
 *
 * **Direction is refused when the text says both.** "Refund of Rs.450 credited against your
 * debit" contains both families of words, and picking one would be a coin flip recorded as a
 * fact. Neither is recorded, and the movement's direction stays a thing a human supplies.
 */
export function parseNotificationText(text: string): ParsedNotification {
  const amountMatch = AMOUNT_PATTERN.exec(text);
  const observedAmount =
    amountMatch === null ? null : majorUnitsToPaise(amountMatch[1]!.replace(/,/g, ''));

  const debits = DEBIT_WORDS.test(text);
  const credits = CREDIT_WORDS.test(text);
  const observedDirection: PaymentDirection | null =
    debits === credits ? null : debits ? 'debit' : 'credit';

  let observedReference: string | null = null;
  let observedReferenceType: PaymentReferenceType | null = null;
  for (const rule of REFERENCE_RULES) {
    const match = rule.pattern.exec(text);
    if (match !== null) {
      observedReference = match[1]!;
      observedReferenceType = rule.referenceType;
      break;
    }
  }

  const accountMatch = ACCOUNT_HINT_SOURCE_PATTERN.exec(text);
  const merchantMatch = MERCHANT_PATTERN.exec(text);
  const merchant = merchantMatch === null ? null : merchantMatch[1]!.trim();

  return {
    observedAmount,
    observedDirection,
    observedReference,
    observedReferenceType,
    observedAccountHint: accountMatch === null ? null : accountMatch[1]!,
    observedMerchantText: merchant === null || merchant.length === 0 ? null : merchant,
  };
}

/**
 * An exact major-unit decimal to minor units.
 *
 * String arithmetic, never `Number` — `parseFloat('1240.15') * 100` is `124014.99999999999`,
 * and money that arrives through a float has already lost the exactness this system is for
 * (`invariants.md` #12).
 */
function majorUnitsToPaise(value: string): Paise {
  const [whole, fraction = ''] = value.split('.');
  const paddedFraction = `${fraction}00`.slice(0, 2);
  return BigInt(`${whole}${paddedFraction}`) as Paise;
}
