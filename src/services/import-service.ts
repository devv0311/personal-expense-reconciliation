/**
 * Transaction import — the first step of the pipeline (`data-flow.md`, step 1).
 *
 * ```
 * api ─▶ services.importBankStatementCsv ─▶ integrations/bank-csv.parse
 *                                        ─▶ db.insertImportBatch / db.insertPayment
 * ```
 *
 * This layer's whole job is to get source evidence into the ledger **unaltered** and to say
 * where each row came from. It does not decide what any payment was for: no counterparty
 * resolution, no merchant matching, no expense/settlement/transfer/investment classification.
 * Those belong to `data-flow.md` steps 2–3 and have no code path from here.
 *
 * The one interpretation it does perform is deduplication, because `invariants.md` #10 makes
 * it a correctness requirement rather than an optimisation — and even then it only ever acts
 * on the deterministic case, never on a guess.
 */

import { createHash } from 'node:crypto';

import {
  assertPaymentTransition,
  duplicateOfReason,
  isDeterministicDuplicate,
  parseDuplicateOfReason,
  SUPPORTED_CURRENCY,
} from '../domain/index.js';
import type { AccountId, ImportBatchId, Paise, PaymentId } from '../domain/index.js';
import {
  findImportBatchByContentHash,
  findPaymentsByExternalReference,
  insertImportBatch,
  insertPayment,
  updatePaymentState,
} from '../db/index.js';
import type { Database, Executor, PaymentRow } from '../db/index.js';
import { parseBankStatementCsv } from '../integrations/bank-csv/index.js';
import type { BankStatementCsvError, BankStatementCsvRow } from '../integrations/bank-csv/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

/**
 * The transport a bank-statement CSV represents.
 *
 * Fixed for this adapter and deliberately not inferred per row. A UPI payment captured by a
 * bank's own statement export is a bank-channel capture of that payment — exactly the shape
 * `fixtures/duplicate-transaction.json` records for its bank-CSV row, against the same
 * transaction captured `upi` by a UPI export. Refining `channel` from the description is
 * normalization's job (`lifecycle.md`, NORMALIZED), not ingestion's.
 */
const BANK_STATEMENT_CHANNEL = 'bank_transfer';

/** Names the import event in `import_batches.source_channel`. */
const BANK_STATEMENT_SOURCE_CHANNEL = 'bank_statement_csv';

/** Bumped when a change to the parser would alter how the same file is read. */
export const BANK_STATEMENT_PARSER_VERSION = 'bank-csv@1';

/** Raised when the source file cannot be read; carries every bad row, not just the first. */
export class ImportSourceError extends ServiceError {
  public readonly rowErrors: readonly BankStatementCsvError[];

  constructor(rowErrors: readonly BankStatementCsvError[]) {
    super(
      'IMPORT_SOURCE_INVALID',
      `The statement could not be read: ${rowErrors.length} row(s) were rejected. ` +
        'Nothing was imported — a partially imported statement leaves the ledger quietly ' +
        'missing rows, so the whole file is refused and reported instead. ' +
        rowErrors.map((error) => `line ${error.lineNumber}: ${error.message}`).join(' | '),
      { rejectedRows: String(rowErrors.length) },
    );
    this.name = 'ImportSourceError';
    this.rowErrors = rowErrors;
  }
}

export interface ImportBankStatementCsvInput {
  /** The account this statement belongs to. Every row lands on it. */
  readonly accountId: AccountId;
  /**
   * The originating app/institution, e.g. `hdfc_bank_csv` (ADR-0010).
   *
   * Supplied by the caller rather than hardcoded: this adapter reads a CSV *shape*, and
   * nothing about it should assume a particular bank.
   */
  readonly sourceSystem: string;
  readonly fileContent: string;
  /** Where the file itself is stored, if anywhere. */
  readonly fileReference?: string | null;
  readonly audit: AuditMeta;
}

/** One row the importer confirmed as an already-known transaction. */
export interface ImportedDuplicate {
  readonly paymentId: PaymentId;
  readonly duplicateOfPaymentId: PaymentId;
  readonly externalReference: string;
}

export type ImportBankStatementCsvResult =
  | {
      readonly outcome: 'imported';
      readonly importBatchId: ImportBatchId;
      readonly contentHash: string;
      /** Every payment written, in file order — including the ignored duplicates. */
      readonly paymentIds: readonly PaymentId[];
      /** Rows written but immediately marked `ignored` (`invariants.md` #10). */
      readonly duplicates: readonly ImportedDuplicate[];
    }
  | {
      readonly outcome: 'already_imported';
      readonly importBatchId: ImportBatchId;
      readonly contentHash: string;
      readonly previouslyImportedAt: Date;
    };

/**
 * Imports one bank-statement CSV.
 *
 * Two independent protections against double-counting, because they catch different things:
 *
 *  - **The whole file.** `import_batches.content_hash` makes a byte-identical re-import a
 *    recognised no-op rather than a second set of rows.
 *  - **Individual rows.** An overlapping (not identical) statement re-states some transactions
 *    and not others, so each row is also checked deterministically against what is already
 *    stored. A confirmed duplicate is still written — the ledger did receive that evidence
 *    twice, and `invariants.md` #10 forbids silently merging it — but is immediately marked
 *    `ignored` with `duplicate_of:<id>`, which is what keeps it out of every spend total.
 */
export async function importBankStatementCsv(
  db: Database,
  input: ImportBankStatementCsvInput,
): Promise<ImportBankStatementCsvResult> {
  const parsed = parseBankStatementCsv(input.fileContent);
  if (!parsed.ok) {
    throw new ImportSourceError(parsed.errors);
  }

  const contentHash = sha256(input.fileContent);

  const previous = await findImportBatchByContentHash(db, contentHash);
  if (previous !== null) {
    return {
      outcome: 'already_imported',
      importBatchId: previous.id,
      contentHash,
      previouslyImportedAt: previous.importedAt,
    };
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const importBatchId = await insertImportBatch(exec, {
      sourceChannel: BANK_STATEMENT_SOURCE_CHANNEL,
      fileReference: input.fileReference ?? null,
      contentHash,
      parserVersion: BANK_STATEMENT_PARSER_VERSION,
      rowCount: parsed.rows.length,
    });

    const paymentIds: PaymentId[] = [];
    const duplicates: ImportedDuplicate[] = [];

    for (const row of parsed.rows) {
      // Checked *before* inserting, so a file that restates a row twice within itself is
      // caught by the same rule that catches it across imports.
      const existing = await findDeterministicDuplicate(exec, row);

      const paymentId = await insertPayment(exec, {
        accountId: input.accountId,
        importBatchId,
        amount: row.amount,
        currency: SUPPORTED_CURRENCY,
        direction: row.direction,
        occurredAt: row.occurredAt,
        rawDescription: row.rawDescription,
        channel: BANK_STATEMENT_CHANNEL,
        externalReference: row.externalReference,
        referenceType: row.referenceType,
        sourceSystem: input.sourceSystem,
      });
      paymentIds.push(paymentId);

      await record({
        entityType: 'payment',
        entityId: paymentId,
        action: 'create',
        newValue: {
          importBatchId,
          sourceLine: row.lineNumber,
          amount: row.amount.toString(),
          direction: row.direction,
          occurredAt: row.occurredAt.toISOString(),
          rawDescription: row.rawDescription,
          externalReference: row.externalReference,
          referenceType: row.referenceType,
          sourceSystem: input.sourceSystem,
        },
      });

      if (existing !== null) {
        // Never silently dropped from the import: the row is kept as the evidence it is, and
        // the reason it does not count is recorded against it (`lifecycle.md`, IGNORED).
        assertPaymentTransition('imported', 'ignored');
        const reason = duplicateOfReason(existing);
        await updatePaymentState(exec, paymentId, 'ignored', reason);
        await record({
          entityType: 'payment',
          entityId: paymentId,
          action: 'update',
          oldValue: { state: 'imported' },
          newValue: { state: 'ignored', ignoredReason: reason },
          reason,
        });
        duplicates.push({
          paymentId,
          duplicateOfPaymentId: existing,
          // Non-null by construction: a deterministic match requires a reference on both sides.
          externalReference: row.externalReference ?? '',
        });
      }
    }

    return { outcome: 'imported', importBatchId, contentHash, paymentIds, duplicates };
  });
}

/* ------------------------------------------------------------------------- internals */

/**
 * Finds the already-stored payment this row deterministically duplicates.
 *
 * Only the deterministic path acts automatically. A row that merely *looks* like another —
 * same amount and time, no matching reference — is left alone for a human to confirm, per
 * `invariants.md` #10; surfacing those is review-queue work, not import work.
 *
 * The answer is the **canonical** payment — the head of the `duplicate_of` chain — not merely
 * the first row that matched. A third statement restating the same transaction matches the
 * original *and* the copy already ignored against it, and both sort under one `occurred_at`
 * (this format carries a date, not a timestamp), so "first match" was decided by whichever
 * random UUID sorted lower. Resolving to the chain head makes the result independent of that
 * order, which is why the ordering itself is not what got fixed.
 */
async function findDeterministicDuplicate(
  exec: Executor,
  row: BankStatementCsvRow,
): Promise<PaymentId | null> {
  if (row.externalReference === null) return null;

  const candidates = await findPaymentsByExternalReference(exec, row.externalReference);
  const match = candidates.find((candidate) =>
    isDeterministicDuplicate(
      {
        amount: row.amount,
        occurredAt: row.occurredAt,
        externalReference: row.externalReference,
        direction: row.direction,
      },
      {
        amount: candidate.amount,
        occurredAt: candidate.occurredAt,
        externalReference: candidate.externalReference,
        direction: candidate.direction,
      },
      // This format carries a date, not a timestamp, so two captures of one transaction are
      // the same calendar day rather than seconds apart. The window is widened accordingly;
      // amount + reference + direction still carry the identification.
      { windowSeconds: 24 * 60 * 60 },
    ),
  );

  return match === undefined ? null : resolveCanonical(match, candidates);
}

/**
 * Walks a matched payment back to the head of its `duplicate_of` chain.
 *
 * Every copy of one transaction carries the same `external_reference` — a deterministic match
 * requires it — so the whole chain is already inside `candidates` and no further query is
 * needed.
 *
 * Stops at the first payment that is not an ignored duplicate. That includes a payment ignored
 * for some *other* reason (`out_of_scope`): it is still the first copy this ledger saw, and
 * naming it keeps the new row ignored. Skipping ignored candidates instead would leave a
 * restatement at `imported`, where `domain.computeUnexplained` counts it — turning a discarded
 * transaction back into fresh spend, the double-count `invariants.md` #10 exists to prevent.
 */
function resolveCanonical(match: PaymentRow, candidates: readonly PaymentRow[]): PaymentId {
  const byId = new Map(candidates.map((candidate) => [String(candidate.id), candidate]));

  // Guards against a cycle in stored data: a chain that loops would otherwise hang the import.
  const seen = new Set<string>([String(match.id)]);

  let current = match;
  while (current.state === 'ignored') {
    const parentId = parseDuplicateOfReason(current.ignoredReason);
    if (parentId === null || seen.has(parentId)) break;
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    seen.add(parentId);
    current = parent;
  }
  return current.id;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Re-exported so a caller can narrow an amount without reaching into `domain`. */
export type { Paise };
