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
  EvidenceMediaType,
  MerchantId,
  Paise,
  PaymentChannel,
  PaymentDirection,
  PersonId,
  ReceiptExtractableEvidenceType,
} from '../domain/index.js';
import type { ReattachedContext } from '../domain/index.js';
import { reattachedMerchantHints } from '../domain/index.js';

import { SanitizationError } from './errors.js';

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
  /**
   * What the evidence attached to this payment says its counterparty was (Phase 17).
   *
   * This is context re-attachment reaching the classifier: a statement line that decayed to
   * `UPI-BLINKIT9821PAYTM` is very hard to classify, and the push notification linked beside
   * it says `Blinkit`. Only the merchant *names* travel — never the references, account tails
   * or raw notification text the same context also holds, all of which stay local
   * (`security-model.md`, and the fail-closed check below).
   */
  readonly reattachedContext?: ReattachedContext | null;
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
  /**
   * Merchant names reconstructed from linked evidence, most-corroborated first (Phase 17).
   *
   * Always present, empty when nothing is attached — a field that appears only sometimes is a
   * field a transport, a fixture and a test all disagree about.
   */
  readonly reattachedMerchantHints: readonly string[];
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
export function redactDescription(rawDescription: string, map?: LocalRedactionMap): string {
  return rawDescription
    .replace(UPI_ID_PATTERN, (match) => remember(map, 'upi_id', match, REDACTED_UPI_ID))
    .replace(LONG_DIGIT_RUN_PATTERN, (match) => remember(map, 'number', match, REDACTED_NUMBER))
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
  options: { readonly redactionMap?: LocalRedactionMap } = {},
): RedactedPayment {
  const map = options.redactionMap;
  const redacted: RedactedPayment = {
    amountMinorUnits: payment.amount.toString(),
    currency: payment.currency,
    direction: payment.direction,
    occurredAt: payment.occurredAt.toISOString(),
    description: redactDescription(payment.rawDescription, map),
    channel: payment.channel,
    merchantName: context.merchant?.canonicalName ?? null,
    merchantCategory: context.merchant?.defaultCategory ?? null,
    counterpartyCandidates: context.knownPeople.map((person) => ({
      id: person.id,
      displayName: person.displayName,
    })),
    // The evidence's own words about who was paid, put through the same redaction as a
    // statement description: a notification's merchant field routinely carries a VPA
    // (`paytm@okaxis`) that is an identifier, not a name.
    reattachedMerchantHints:
      context.reattachedContext === undefined || context.reattachedContext === null
        ? []
        : reattachedMerchantHints(context.reattachedContext).map((hint) =>
            redactDescription(hint, map),
          ),
  };

  assertPayloadSanitized(redacted, 'classifyTransaction');
  return redacted;
}

/* ------------------------------------------------------------------ receipt extraction */

/** A receipt-eligible `Evidence` row as `src/services` hands it to `parseReceipt`/`extractReceiptItems`. */
export interface ClassifiableReceiptEvidence {
  readonly evidenceType: ReceiptExtractableEvidenceType;
  readonly mediaType: EvidenceMediaType;
  /** OCR'd or pasted text, when the caller already has it — a photo alone may carry none. */
  readonly rawText: string | null;
  readonly capturedAt: Date;
}

/** Exactly what is sent to the provider for receipt extraction. No evidence id, no storage ref. */
export interface RedactedReceiptEvidence {
  readonly evidenceType: ReceiptExtractableEvidenceType;
  readonly mediaType: EvidenceMediaType;
  readonly capturedAt: string;
  readonly rawText: string | null;
}

/**
 * A keyword immediately followed by a run of digits (allowing spaces/hyphens inside the run) —
 * a card, account, membership, loyalty, or contact number printed on a receipt footer.
 *
 * Deliberately narrower than {@link redactDescription}'s blanket "4+ digit run" rule. A
 * payment's raw description is short bank-statement text where a long digit run is almost
 * always an account fragment; a receipt's raw text is free-form and legitimately full of
 * digits that are not identifiers at all — prices, quantities, item counts, a printed date.
 * Redacting every one of those would strip the very figures extraction exists to read.
 */
const RECEIPT_IDENTIFIER_PATTERN =
  /\b(card|a\/c|acct|account|member(?:ship)?|loyalty|phone|mobile|contact|tel)\s*[:#]?\s*\d[\d\s-]{3,}\d/gi;

/**
 * Strips identifiers out of a receipt's raw text.
 *
 * Two passes: a UPI handle (a merchant's own QR-code payment address can appear on a printed
 * receipt exactly as it does on a bank statement), then a labelled digit run. Prices, item
 * counts, dates and quantities are left untouched — they are the signal this operation exists
 * to extract, not an identifier.
 */
export function redactReceiptText(rawText: string, map?: LocalRedactionMap): string {
  return rawText
    .replace(UPI_ID_PATTERN, (match) => remember(map, 'upi_id', match, REDACTED_UPI_ID))
    .replace(RECEIPT_IDENTIFIER_PATTERN, (match, keyword: string) => {
      const digits = match.slice(keyword.length);
      return `${keyword}${remember(map, 'number', digits, REDACTED_NUMBER)}`;
    })
    .trim();
}

/** Builds the payload for a receipt-extraction inference over one evidence row. */
export function redactReceiptEvidenceForInference(
  evidence: ClassifiableReceiptEvidence,
  options: { readonly redactionMap?: LocalRedactionMap } = {},
): RedactedReceiptEvidence {
  const redacted: RedactedReceiptEvidence = {
    evidenceType: evidence.evidenceType,
    mediaType: evidence.mediaType,
    capturedAt: evidence.capturedAt.toISOString(),
    rawText:
      evidence.rawText === null ? null : redactReceiptText(evidence.rawText, options.redactionMap),
  };

  assertPayloadSanitized(redacted, 'parseReceipt');
  return redacted;
}

/* ============================================================ the fail-closed boundary */

/**
 * What kind of text a field carries, which decides how suspicious a digit run is.
 *
 * The distinction is the whole reason this is a profile and not one rule. A payment's raw
 * description is short bank text where a long digit run is almost always an account fragment.
 * A receipt's raw text is legitimately full of digits that identify nothing — prices,
 * quantities, item counts, a printed date — and refusing those would refuse every receipt.
 * A structural field (an id, an ISO timestamp, an exact minor-unit string) carries no free
 * text at all: its shape is what protects it, and scanning it would only produce false alarms.
 */
export type SanitizationProfile = 'statement_text' | 'receipt_text' | 'structural';

/** The kinds of identifier the guard refuses to let out. Reported by name, never by value. */
export type ResidualIdentifierKind =
  | 'upi_id_or_email'
  | 'phone_number'
  | 'card_or_account_number'
  | 'labelled_identifier'
  | 'long_digit_run';

/**
 * Fields whose profile is not the default.
 *
 * Keyed by the leaf property name rather than by a full path, because the payloads are flat
 * enough that a leaf name is unambiguous and a path table would have to be re-checked every
 * time a field moved. Anything not listed is treated as statement text — the strict reading —
 * so a field added to a payload without a thought is refused rather than waved through.
 */
const FIELD_PROFILES: Readonly<Record<string, SanitizationProfile>> = {
  id: 'structural',
  amountMinorUnits: 'structural',
  occurredAt: 'structural',
  capturedAt: 'structural',
  currency: 'structural',
  direction: 'structural',
  channel: 'structural',
  evidenceType: 'structural',
  mediaType: 'structural',
  rawText: 'receipt_text',
};

const EMAIL_OR_UPI_PATTERN = /[A-Za-z0-9._-]+@[A-Za-z][A-Za-z0-9.-]*/;
/** An Indian mobile number, with or without the country code. */
const PHONE_PATTERN = /(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/;
/** A card or full account number: 13-19 digits, however the printer spaced them. */
const CARD_PATTERN = /\b(?:\d[\s-]?){13,19}\b/;
const LABELLED_IDENTIFIER_PATTERN =
  /\b(?:card|a\/c|acct|account|member(?:ship)?|loyalty|phone|mobile|contact|tel)\s*[:#]?\s*\d[\d\s-]{3,}\d/i;
const BARE_LONG_DIGIT_RUN_PATTERN = /\d{4,}/;

/**
 * Every identifier still present in a string, by kind.
 *
 * Returns kinds, never the matched text: this feeds an error message, and an error about a
 * leak that quotes the leak is not an improvement (`security-model.md`, Logging).
 */
export function findResidualIdentifiers(
  value: string,
  profile: SanitizationProfile,
): readonly ResidualIdentifierKind[] {
  if (profile === 'structural') return [];

  const found: ResidualIdentifierKind[] = [];
  if (EMAIL_OR_UPI_PATTERN.test(value)) found.push('upi_id_or_email');
  if (PHONE_PATTERN.test(value)) found.push('phone_number');
  if (CARD_PATTERN.test(value)) found.push('card_or_account_number');
  if (LABELLED_IDENTIFIER_PATTERN.test(value)) found.push('labelled_identifier');
  if (profile === 'statement_text' && BARE_LONG_DIGIT_RUN_PATTERN.test(value)) {
    found.push('long_digit_run');
  }
  return found;
}

/**
 * The last thing that happens before a payload leaves this machine — and the thing that stops
 * it if redaction did not work.
 *
 * `security-model.md` requires that identifiers are redacted before any external AI call and
 * that redaction is "a named function in `src/ai` … implemented once and testable once". The
 * redaction functions above are that. **This is the proof that they ran.** They are pattern
 * substitutions over free text written by banks, and free text is exactly the medium where a
 * rule that covers today's formats meets tomorrow's; a payload is also a shape somebody can
 * extend without noticing there was a rule attached to it. Both failures are silent, and both
 * end with an account number at a third party.
 *
 * So the guard is independent of the redactors, walks whatever it is given, and **fails
 * closed**: it throws rather than trimming, masking, or dropping the offending field. Sending
 * a partially-sanitized payload minus one field would be a worse outcome than not sending one
 * at all, because nobody would ever find out it happened.
 *
 * @throws SanitizationError naming the field path and the kind of identifier found.
 */
export function assertPayloadSanitized(payload: unknown, context: string): void {
  walk(payload, '', context);
}

function walk(value: unknown, path: string, context: string): void {
  if (typeof value === 'string') {
    const leaf =
      path
        .split('.')
        .filter((segment) => !/^\d+$/.test(segment))
        .pop() ?? '';
    const profile = FIELD_PROFILES[leaf] ?? 'statement_text';
    const residual = findResidualIdentifiers(value, profile);
    if (residual.length > 0) {
      throw new SanitizationError(
        `The ${context} payload still contains ${residual.join(', ')} at "${path}". Nothing was ` +
          'sent: redaction is the boundary between this machine and a third party, and a ' +
          'payload that reaches this point unredacted is a rule that did not fire, not a ' +
          'field to quietly drop (security-model.md).',
        { context, field: path, kinds: residual.join(',') },
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}.${index}`, context));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      walk(entry, path === '' ? key : `${path}.${key}`, context);
    }
  }
}

/* ================================================== local re-identification (never sent) */

/**
 * A record of what each placeholder stood for, kept on this machine.
 *
 * `CLAUDE.md`'s pillar 6 requires reversible mappings to stay local. This is that mapping,
 * and its shape is what keeps the requirement honest: it is a **separate object the caller
 * holds**, never a field on a payload, so there is no way to serialize a request and include
 * it by accident. A caller that does not need reconstruction simply does not pass one, and
 * the redaction is then irreversible — which is the right default.
 *
 * Placeholders are deliberately *not* numbered. `[redacted-number]` is what the redacted
 * description has always been, and it is the key `fixtures/ai-classification-proposals.json`
 * and every scripted transport look responses up by; numbering them to make reconstruction
 * easier would change what leaves the machine in order to serve something that never does.
 * Reconstruction instead consumes the recorded originals in order of appearance, which is
 * exact because the substitutions were applied in that same order.
 */
export interface LocalRedactionMap {
  /** Every original, in the order it was redacted, grouped by placeholder. */
  readonly entries: ReadonlyMap<string, readonly string[]>;
  /** Restores the originals into a string that came back carrying placeholders. */
  reidentify(value: string): string;
}

interface MutableRedactionMap extends LocalRedactionMap {
  readonly record: (placeholder: string, original: string) => void;
}

/**
 * A fresh mapping for one unit of work.
 *
 * Scoped per call rather than per process on purpose: a long-lived map would accumulate every
 * identifier the system has ever redacted into one object, which is a worse thing to hold than
 * the individual values were.
 */
export function createLocalRedactionMap(): LocalRedactionMap {
  const entries = new Map<string, string[]>();

  const map: MutableRedactionMap = {
    entries,
    record: (placeholder, original) => {
      const existing = entries.get(placeholder);
      if (existing === undefined) entries.set(placeholder, [original]);
      else existing.push(original);
    },
    reidentify: (value: string) => {
      const consumed = new Map<string, number>();
      let result = value;
      for (const placeholder of entries.keys()) {
        // Rebuilt each pass rather than kept as a module constant: a `g`-flagged RegExp
        // carries `lastIndex` between calls, which is a classic way to skip a match.
        result = result.replace(new RegExp(escapeForRegExp(placeholder), 'g'), () => {
          const index = consumed.get(placeholder) ?? 0;
          consumed.set(placeholder, index + 1);
          return entries.get(placeholder)?.[index] ?? placeholder;
        });
      }
      return result;
    },
  };
  return map;
}

function remember(
  map: LocalRedactionMap | undefined,
  _kind: 'upi_id' | 'number',
  original: string,
  placeholder: string,
): string {
  if (map !== undefined) (map as MutableRedactionMap).record(placeholder, original);
  return placeholder;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
