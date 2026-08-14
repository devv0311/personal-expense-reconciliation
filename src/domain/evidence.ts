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

import type { EvidenceNoteKind, EvidenceType } from './enums.js';
import { EVIDENCE_NOTE_KINDS } from './enums.js';
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
