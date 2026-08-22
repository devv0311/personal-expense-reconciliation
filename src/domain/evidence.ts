/**
 * Evidence semantics (ADR-0018).
 *
 * `Evidence` is otherwise inert — a pointer to a document plus what it was attached to. One
 * rule needs to live here, because getting it wrong is a financial error rather than a
 * cosmetic one:
 *
 * ADR-0006 documents an **externally-funded expense** with a manual note linked to that
 * expense — the only evidence such an expense will ever have. ADR-0014 reads a manual note
 * linked to a contributing expense as a claim that **the debt was cleared**. Identical row
 * shape, opposite meanings. Left undistinguished, the second reading fires on every instance
 * of the first, and an obligation reports itself settled the moment it is recorded.
 *
 * `note_kind` is the distinction. These functions are what make it load-bearing rather than
 * decorative.
 */

import type { EvidenceMediaType, EvidenceNoteKind, EvidenceType } from './enums.js';
import { EVIDENCE_MEDIA_TYPES, EVIDENCE_NOTE_KINDS } from './enums.js';
import { DomainError } from './errors.js';

/**
 * The note kind that asserts a debt was cleared.
 *
 * Exported as a constant because `src/db` has to restate this rule in SQL — a query filter
 * and a partial index — and a hardcoded literal there could drift from the domain silently.
 */
export const SETTLEMENT_CLAIM_NOTE_KIND: EvidenceNoteKind = 'settlement_claim';

/** The two fields the note-kind rule relates. */
export interface EvidenceKindFields {
  readonly type: EvidenceType;
  readonly noteKind: EvidenceNoteKind | null;
}

/**
 * A manual note must declare its kind; nothing else may declare one.
 *
 * Deliberately no default. Defaulting to `documentation` would silently discard a settlement
 * claim; defaulting to `settlement_claim` would mark every documented expense settled. The
 * caller knows which it is, so the caller says so.
 *
 * Mirrors the `evidence_note_kind_only_on_notes_check` constraint, so the same rule fails at
 * the domain boundary and at the database.
 */
export function validateEvidenceNoteKind(
  type: EvidenceType,
  noteKind: EvidenceNoteKind | null,
): void {
  if (type === 'manual_note') {
    if (noteKind === null) {
      throw new DomainError(
        'EVIDENCE_NOTE_KIND_INVALID',
        `A manual note must declare its note_kind (${EVIDENCE_NOTE_KINDS.join(' | ')}). It ` +
          'cannot be inferred: the same shape documents an externally-funded expense ' +
          '(ADR-0006) and claims a debt was cleared (ADR-0014), and guessing wrong either ' +
          'hides a settlement claim or reports an open obligation as settled (ADR-0018).',
        { type },
      );
    }
    return;
  }

  if (noteKind !== null) {
    throw new DomainError(
      'EVIDENCE_NOTE_KIND_INVALID',
      `Evidence of type "${type}" carries note_kind "${noteKind}", but only a manual note has ` +
        'a kind — a bank line or a receipt image asserts nothing about settlement (ADR-0018).',
      { type, noteKind },
    );
  }
}

/**
 * Whether this evidence asserts that a debt was cleared.
 *
 * The single predicate `Balance` reads. False for an ordinary documenting note, false for
 * every non-note evidence type, and false for a note whose kind is somehow absent — the
 * "believed settled" annotation is never produced by guessing.
 */
export function claimsSettlement(evidence: EvidenceKindFields): boolean {
  return evidence.type === 'manual_note' && evidence.noteKind === SETTLEMENT_CLAIM_NOTE_KIND;
}

/* ---------------------------------------------------------------------- media types */

/**
 * The file extension each accepted media type is stored under.
 *
 * A fixed, two-way mapping rather than "whatever the uploaded filename ended in". The
 * extension a caller supplies describes what they *called* the file; this describes what the
 * bytes were declared to be, which is the thing anything downstream has to trust.
 */
export const EVIDENCE_MEDIA_TYPE_EXTENSIONS: Readonly<Record<EvidenceMediaType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

const EXTENSION_MEDIA_TYPES: ReadonlyMap<string, EvidenceMediaType> = new Map(
  Object.entries(EVIDENCE_MEDIA_TYPE_EXTENSIONS).map(([mediaType, extension]) => [
    extension,
    mediaType as EvidenceMediaType,
  ]),
);

/**
 * Reads a declared content type, or refuses it.
 *
 * Tolerates the two shapes a real upload arrives in — parameters (`image/jpeg; charset=…`)
 * and mixed case — because both are legal in a `Content-Type` header and neither changes what
 * the bytes are. Everything else is refused rather than guessed: an unrecognised type means
 * the document cannot be rendered back to the user or read by extraction, and storing it
 * anyway produces evidence that nothing can ever open.
 */
export function parseEvidenceMediaType(value: string): EvidenceMediaType {
  const normalized = value.split(';')[0]!.trim().toLowerCase();
  const match = EVIDENCE_MEDIA_TYPES.find((mediaType) => mediaType === normalized);
  if (match === undefined) {
    throw new DomainError(
      'EVIDENCE_MEDIA_TYPE_UNSUPPORTED',
      `"${value}" is not a document format this system stores. Accepted: ` +
        `${EVIDENCE_MEDIA_TYPES.join(', ')}. The list is an allowlist because the declared ` +
        'type decides how the document is rendered back to a human later, and because ' +
        'receipt extraction can only read formats it knows.',
      { mediaType: value },
    );
  }
  return match;
}

/** The extension a stored document of this type is written under. */
export function extensionForEvidenceMediaType(mediaType: EvidenceMediaType): string {
  return EVIDENCE_MEDIA_TYPE_EXTENSIONS[mediaType];
}

/** The media type an extension denotes, or `null` if this system does not store it. */
export function evidenceMediaTypeForExtension(extension: string): EvidenceMediaType | null {
  return EXTENSION_MEDIA_TYPES.get(extension.toLowerCase()) ?? null;
}

/* ------------------------------------------------------------------------- ingestion */

/** What an `Evidence` row carries, apart from what it is linked to. */
export interface EvidencePayloadFields {
  readonly type: EvidenceType;
  readonly noteKind: EvidenceNoteKind | null;
  /** Where the document lives, outside the database (`security-model.md`). */
  readonly storageRef: string | null;
  readonly mediaType: EvidenceMediaType | null;
  readonly byteSize: number | null;
  readonly rawText: string | null;
}

/**
 * Everything an `Evidence` row must satisfy to be worth storing.
 *
 * Three rules, each mirroring a check constraint so the same mistake fails at the domain
 * boundary and at the database:
 *
 *  1. **A note is typed text; it never has a file.** The two are different evidence types, so
 *     a `manual_note` carrying a `storage_ref` is a row that disagrees with its own type.
 *  2. **`media_type` and `byte_size` are facts about a stored document**, so they are present
 *     exactly when one is. A `storage_ref` with no media type is a document nothing can open;
 *     a media type with no `storage_ref` describes a file that was never stored.
 *  3. **Evidence must contain evidence.** A row with neither a document nor text asserts
 *     nothing at all, and would sit in the review queue forever as a receipt with no content.
 *
 * The note-kind rule (ADR-0018) is checked first, because a note that cannot say what it
 * asserts is the more serious error of the two.
 */
export function validateEvidencePayload(fields: EvidencePayloadFields): void {
  validateEvidenceNoteKind(fields.type, fields.noteKind);

  if (fields.type === 'manual_note' && fields.storageRef !== null) {
    throw new DomainError(
      'EVIDENCE_PAYLOAD_INVALID',
      'A manual note is typed text and has no file, but this one carries a storage_ref. A ' +
        'photograph of a receipt is `receipt_image`, and a screenshot is `screenshot` — ' +
        'storing either as a note would hide it from every reader that looks for a document.',
      { type: fields.type },
    );
  }

  const hasStoredDocument = fields.storageRef !== null;
  if (hasStoredDocument !== (fields.mediaType !== null)) {
    throw new DomainError(
      'EVIDENCE_PAYLOAD_INVALID',
      hasStoredDocument
        ? 'This evidence has a storage_ref but no media_type. Nothing downstream could open ' +
            'the document: the stored bytes would be unrenderable and unreadable by extraction.'
        : 'This evidence declares a media_type but has no storage_ref, describing the format ' +
            'of a file that was never stored.',
      { type: fields.type },
    );
  }

  if (hasStoredDocument !== (fields.byteSize !== null)) {
    throw new DomainError(
      'EVIDENCE_PAYLOAD_INVALID',
      'byte_size records the size of a stored document, so it is present exactly when ' +
        'storage_ref is. Anything else describes a file this row cannot account for.',
      { type: fields.type },
    );
  }

  if (fields.byteSize !== null && (!Number.isInteger(fields.byteSize) || fields.byteSize <= 0)) {
    throw new DomainError(
      'EVIDENCE_PAYLOAD_INVALID',
      `byte_size is ${fields.byteSize}. A stored document has at least one byte; an empty ` +
        'file is a failed upload, not evidence.',
      { byteSize: String(fields.byteSize) },
    );
  }

  if (!hasStoredDocument && (fields.rawText === null || fields.rawText.trim().length === 0)) {
    throw new DomainError(
      'EVIDENCE_PAYLOAD_INVALID',
      'This evidence has neither a stored document nor any text, so it supports no claim ' +
        'about anything. Evidence is support for a claim (domain-model.md); a row with no ' +
        'content is an empty gesture that would sit in the review queue forever.',
      { type: fields.type },
    );
  }
}

/* --------------------------------------------------------------------------- linkage */

/** What an `Evidence` row is attached to. Either side may be absent. */
export interface EvidenceLinkFields {
  readonly linkedPaymentId: string | null;
  readonly linkedExpenseId: string | null;
}

/**
 * Linkage may be filled in later, but never rewritten.
 *
 * `drizzle/security/immutable-table-grants.sql` grants `UPDATE (linked_payment_id,
 * linked_expense_id)` on an otherwise unwritable table, calling linkage *"DERIVED metadata
 * layered on immutable SOURCE columns"*. That is what makes a receipt that arrives before its
 * payment possible at all: it lands unlinked, and a human attaches it once the other half
 * exists.
 *
 * The grant permits the write because the link is derived — not because a recorded link may
 * be changed. Once set, it is an assertion a human made, and a `Receipt` extracted from this
 * evidence reaches its payment and expense through exactly these two columns
 * (`database-design.md`). Re-pointing one silently moves every downstream interpretation onto
 * a different transaction; clearing one orphans them. Both are corrections to what a human
 * decided, and a correction to a decision is a new decision — record superseding evidence
 * instead (`invariants.md` #4).
 *
 * Each side is independent: attaching a receipt to its expense later does not disturb the
 * payment it was already attached to.
 */
export function assertEvidenceLinkOnce(
  current: EvidenceLinkFields,
  proposed: EvidenceLinkFields,
): void {
  assertLinkSideOnce('linkedPaymentId', current.linkedPaymentId, proposed.linkedPaymentId);
  assertLinkSideOnce('linkedExpenseId', current.linkedExpenseId, proposed.linkedExpenseId);
}

function assertLinkSideOnce(field: string, current: string | null, proposed: string | null): void {
  if (current === null || current === proposed) return;
  throw new DomainError(
    'EVIDENCE_LINK_IMMUTABLE',
    proposed === null
      ? `Evidence.${field} is already ${current} and cannot be cleared. Anything extracted ` +
          'from this evidence reaches its payment and expense through this column, so ' +
          'unlinking orphans them.'
      : `Evidence.${field} is already ${current} and cannot be re-pointed at ${proposed}. ` +
          'The link is a decision a human made; moving it silently relocates every ' +
          'interpretation of this document onto a different transaction. Record superseding ' +
          'evidence instead (invariants.md #4).',
    { field, currentValue: current ?? '', proposedValue: proposed ?? '' },
  );
}
