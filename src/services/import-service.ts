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
  sumPaise,
  SUPPORTED_CURRENCY,
} from '../domain/index.js';
import type {
  AccountId,
  AccountType,
  ImportBatchId,
  Paise,
  PaymentChannel,
  PaymentDirection,
  PaymentId,
  PaymentReferenceType,
} from '../domain/index.js';
import {
  findImportBatchByContentHash,
  findPaymentsByExternalReference,
  getAccountById,
  insertImportBatch,
  insertPayment,
  updatePaymentState,
} from '../db/index.js';
import type { Database, Executor, PaymentRow } from '../db/index.js';
import { parseBankStatementCsv } from '../integrations/bank-csv/index.js';
import type { BankStatementCsvError } from '../integrations/bank-csv/index.js';
import {
  listStatementFormats,
  parseStatementFile,
  STATEMENT_PARSER_VERSION,
} from '../integrations/statement-formats/index.js';
import type {
  StatementFormatDescriptor,
  StatementWarning,
} from '../integrations/statement-formats/index.js';

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

/**
 * The kind of account this adapter's statements belong to (ADR-0068).
 *
 * Not read from the file — its five columns would fit a card's export as well as a bank
 * account's. It is what a caller says by choosing this adapter at all: the route is
 * `POST /api/imports/bank-csv`, and every row it writes is recorded as a bank transfer
 * (`BANK_STATEMENT_CHANNEL`). So it writes onto a bank account and refuses any other kind.
 */
const BANK_STATEMENT_ACCOUNT_KIND: AccountType = 'bank';

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
  const bytes = new TextEncoder().encode(input.fileContent);
  // The same ceiling as the multi-format route: one limit, not one per entry point.
  assertStatementWithinLimit(bytes.byteLength);

  const parsed = parseBankStatementCsv(input.fileContent);
  if (!parsed.ok) {
    throw new ImportSourceError(parsed.errors);
  }

  const named: NamedStatementKind = { kind: BANK_STATEMENT_ACCOUNT_KIND, by: 'importer' };
  await assertAccountKindMatches(db, input.accountId, named);
  return writeImportedRows(db, {
    accountId: input.accountId,
    sourceSystem: input.sourceSystem,
    sourceChannel: BANK_STATEMENT_SOURCE_CHANNEL,
    parserVersion: BANK_STATEMENT_PARSER_VERSION,
    channel: BANK_STATEMENT_CHANNEL,
    contentHash: sha256Bytes(bytes),
    fileReference: input.fileReference ?? null,
    rows: parsed.rows,
    statement: named,
    audit: input.audit,
  });
}

/* ================================================================ multi-format import */

/**
 * The largest statement this build will read, in bytes, whatever container it arrived in.
 *
 * **The authoritative limit.** The import screen refuses a larger file before reading it and
 * `POST /api/imports/statement` rejects an obviously oversized body before parsing its JSON,
 * but both of those are conveniences that save work — neither is a guarantee. A caller that is
 * not the browser, or one that sends a wrong or absent `Content-Length`, reaches this check,
 * and this check runs **before the file is parsed or hashed**, so an oversized upload never
 * costs a PDF decode or a SHA-256 pass over 400 MB.
 *
 * 25 MB matches `MAX_EVIDENCE_DOCUMENT_BYTES` deliberately: a person who can store a document
 * as evidence should not discover a different ceiling when importing the same file as a
 * statement. A personal statement is a few hundred kilobytes; nothing legitimate is near this.
 */
export const MAX_STATEMENT_BYTES = 25 * 1024 * 1024;

/** Refuses an oversized statement by name, before anything expensive touches its bytes. */
function assertStatementWithinLimit(byteLength: number): void {
  if (byteLength <= MAX_STATEMENT_BYTES) return;
  throw new ServiceError(
    'STATEMENT_FILE_TOO_LARGE',
    `This statement is ${byteLength} bytes; the limit is ${MAX_STATEMENT_BYTES}. Nothing was ` +
      'read from it. A bank statement is normally well under a megabyte, so a file this size ' +
      'is usually the wrong file rather than a long month.',
    { byteLength: String(byteLength), limit: String(MAX_STATEMENT_BYTES) },
  );
}

/** Every statement format this build reads — for an import screen to name (audit row 02). */
export function listSupportedStatementFormats(): readonly StatementFormatDescriptor[] {
  return listStatementFormats();
}

export interface ImportStatementInput {
  readonly accountId: AccountId;
  /** The originating app/institution, e.g. `hdfc_bank`. Never inferred from the file. */
  readonly sourceSystem: string;
  /** A declared format id, or `'auto'` to detect one from the file's own columns. */
  readonly formatId: string;
  /**
   * The file's bytes.
   *
   * Bytes rather than text because two of the three containers are binary: an `.xlsx` is a
   * ZIP and a `.pdf` is a binary document, and decoding either as UTF-8 first destroys it.
   */
  readonly bytes: Uint8Array;
  readonly filename?: string | null;
  readonly fileReference?: string | null;
  /**
   * The kind of account the person importing says this is a statement of (ADR-0068).
   *
   * **Required whenever the document does not say so itself** — every CSV and XLSX, and a PDF
   * read by a layout that cannot tell — because a card's export and a bank account's can carry
   * the same columns, and the columns are never read as a kind. When the document does name its
   * kind, a stated one must agree with it. Either way, the kind in force must be the chosen
   * account's type. Every one of those refusals happens before anything is written.
   */
  readonly statementKind?: AccountType | null;
  readonly audit: AuditMeta;
}

export type ImportStatementResult = ImportBankStatementCsvResult & {
  /** Which declared format actually read the file — the detected one, when `'auto'`. */
  readonly formatId: string;
  /** Anything the adapter read but wants the caller to know. Never silently swallowed. */
  readonly warnings: readonly StatementWarning[];
  /**
   * The last row's printed running balance, when the format prints one.
   *
   * A **candidate** evidenced closing boundary for ADR-0017's cash waterfall, and nothing
   * more: importing a statement never writes a boundary. A person still confirms one against
   * the document, because a boundary is what makes a `verified` ₹0 delta mean anything
   * (17.5, `services.runReconciliation`).
   */
  readonly closingBalanceCandidate: string | null;
};

/**
 * Imports one statement in any format this build reads — CSV, XLSX or a generated PDF.
 *
 * The audit's row 02 named this gap exactly: *"Bank-specific CSV mapping, UPI exports,
 * XLSX/PDF transaction extraction … are unbuilt."* This is the transaction-extraction half;
 * `recordManualPayment` is the cash/manual half and `ingestForwardedMessage` is the
 * forwarding half.
 *
 * Everything that made `importBankStatementCsv` safe is reused rather than reimplemented:
 * all-or-nothing parsing, the file's content hash as a re-import no-op, per-row deterministic
 * duplicate detection, and a written-but-`ignored` row for a confirmed duplicate so the
 * evidence survives while the money is counted once (`invariants.md` #10).
 *
 * @throws ImportSourceError when the file could not be read. Nothing is written, and every
 *   rejected row is reported at once so one pass fixes the file.
 */
export async function importStatement(
  db: Database,
  input: ImportStatementInput,
): Promise<ImportStatementResult> {
  // Before the parser and before `sha256Bytes`, so an oversized file is refused rather than
  // decoded and digested first.
  assertStatementWithinLimit(input.bytes.byteLength);

  const parsed = await parseStatementFile({
    bytes: input.bytes,
    formatId: input.formatId,
    filename: input.filename ?? null,
  });
  if (!parsed.ok) {
    throw new ImportSourceError(
      parsed.errors.map((error) => ({
        lineNumber: error.lineNumber,
        column: null,
        rawValue: error.rawValue,
        message: error.message,
      })),
    );
  }

  const format = listStatementFormats().find((candidate) => candidate.id === parsed.formatId);
  const named = statementKindInForce(parsed.accountKind, input.statementKind ?? null);
  await assertAccountKindMatches(db, input.accountId, named);
  const written = await writeImportedRows(db, {
    accountId: input.accountId,
    sourceSystem: input.sourceSystem,
    sourceChannel: `statement:${parsed.formatId}`,
    parserVersion: `${STATEMENT_PARSER_VERSION}:${parsed.formatId}`,
    channel: format?.channel ?? 'other',
    contentHash: sha256Bytes(input.bytes),
    fileReference: input.fileReference ?? null,
    rows: parsed.rows,
    statement: named,
    audit: input.audit,
  });

  const lastBalance = [...parsed.rows]
    .reverse()
    .find((row) => row.runningBalance !== null)?.runningBalance;

  return {
    ...written,
    formatId: parsed.formatId,
    warnings: parsed.warnings,
    closingBalanceCandidate:
      lastBalance === undefined || lastBalance === null ? null : lastBalance.toString(),
  };
}

/**
 * The kind of account a statement belongs to, and who said so (ADR-0068).
 *
 * `document` when the statement names it itself (a layout recognised it by name, ADR-0066/0067);
 * `importer` when the person importing it said so, because the document does not. Recorded on
 * every payment's audit event, so "why is this movement on this account?" has an answer.
 */
interface NamedStatementKind {
  readonly kind: AccountType;
  readonly by: 'document' | 'importer';
}

/**
 * Which kind of account this import is checked against, or a refusal.
 *
 * The document's own word settles it when it has one, and a stated kind may only agree with
 * it — overruling a statement that names its account, or silently preferring it over the
 * person, would each decide the question for somebody. When the document says nothing, the
 * person must: a table's columns are never read as a kind, so without their word there is
 * nothing to check the account against, and an unchecked import is how a bank account's
 * movements land on a card.
 */
function statementKindInForce(
  documentKind: AccountType | null,
  statedKind: AccountType | null,
): NamedStatementKind {
  if (documentKind !== null) {
    if (statedKind !== null && statedKind !== documentKind) {
      throw new ServiceError(
        'STATEMENT_KIND_CONFLICT',
        `This document says it is the statement of ${accountWords(documentKind)}, and it was ` +
          `named as the statement of ${accountWords(statedKind)}. Nothing was imported. A ` +
          'statement that names its own kind of account goes onto an account of that kind and ' +
          'no other.',
        { statementAccountKind: documentKind, statedAccountKind: statedKind },
      );
    }
    return { kind: documentKind, by: 'document' };
  }
  if (statedKind === null) {
    throw new ServiceError(
      'STATEMENT_KIND_REQUIRED',
      'This file does not say what kind of account it is a statement of — a CSV or a ' +
        'spreadsheet looks the same whether it came from a bank account or a card, and its ' +
        'columns are not taken as an answer. Nothing was imported. Say which kind of account ' +
        'it is from, and import it into an account of that kind.',
      { field: 'statementKind' },
    );
  }
  return { kind: statedKind, by: 'importer' };
}

/**
 * Refuses a statement whose kind of account the chosen account is not.
 *
 * Both ways round and for every kind: a bank statement never lands on a card (ADR-0066), a card
 * statement never lands on a bank account (ADR-0067), and a table goes only onto the kind of
 * account the person said it came from (ADR-0068). The kind is the document's own when it names
 * one — read by the parser whichever layout read the rows, so naming a layout that cannot tell
 * is not a way round it — and the importer's word otherwise.
 *
 * Checked after the file is read — only a read file knows whether it names its kind — and
 * before `writeImportedRows`, so a refusal writes nothing at all: no batch, no row, no audit
 * event. It also comes before the file's duplicate check, so a statement already on record for
 * the right account is still refused, by name, for the wrong one.
 */
async function assertAccountKindMatches(
  db: Database,
  accountId: AccountId,
  named: NamedStatementKind,
): Promise<void> {
  const account = await getAccountById(db, accountId);
  if (account === null) {
    throw new ServiceError('ENTITY_NOT_FOUND', `No account with id ${accountId}.`, { accountId });
  }
  if (account.type === named.kind) return;
  const whose =
    named.by === 'document'
      ? `This statement belongs to ${accountWords(named.kind)}`
      : `You said this is the statement of ${accountWords(named.kind)}`;
  throw new ServiceError(
    'STATEMENT_ACCOUNT_MISMATCH',
    `${whose}, and the account chosen is ${accountWords(account.type)}. Nothing was imported. ` +
      `Choose ${accountWords(named.kind)} — or add one in Setup — and import it there.`,
    { statementAccountKind: named.kind, accountType: account.type },
  );
}

function accountWords(type: string): string {
  switch (type) {
    case 'bank':
      return 'a bank account';
    case 'card':
      return 'a card';
    case 'upi':
      return 'a UPI account';
    case 'wallet':
      return 'a wallet';
    case 'cash':
      return 'cash';
    default:
      return `an account of type ${type}`;
  }
}

export interface PreviewStatementInput {
  /** A declared format id, or `'auto'` to detect one. */
  readonly formatId: string;
  readonly bytes: Uint8Array;
  readonly filename?: string | null;
}

/** What a statement says, before anybody decides to import it. */
export type StatementPreview =
  | {
      readonly readable: true;
      readonly formatId: string;
      readonly formatLabel: string;
      /** The kind of account the document says it belongs to, when it says. */
      readonly accountKind: AccountType | null;
      /** Whether the read was proved complete against the statement's own printed balances. */
      readonly checksPrintedBalances: boolean;
      readonly movementCount: number;
      readonly debitCount: number;
      readonly creditCount: number;
      readonly totalDebits: Paise;
      readonly totalCredits: Paise;
      /** `YYYY-MM-DD`, the earliest and latest printed dates. */
      readonly firstDate: string | null;
      readonly lastDate: string | null;
      /** The last printed running balance, when the format prints one. */
      readonly closingBalance: Paise | null;
      readonly warnings: readonly string[];
      /** Set when these exact bytes are already on record, so importing again changes nothing. */
      readonly alreadyImported: {
        readonly importBatchId: ImportBatchId;
        readonly importedAt: Date;
      } | null;
    }
  | {
      readonly readable: false;
      readonly formatId: string;
      /** Why nothing could be read: line numbers and reasons, never the file's own text. */
      readonly problems: readonly { readonly lineNumber: number; readonly message: string }[];
    };

/**
 * Reads a statement and says what is on it. **Writes nothing** (ADR-0066).
 *
 * The same reader, the same checks and the same duplicate lookup as `importStatement`, so what
 * a person is shown before choosing an account is exactly what an import would do — minus the
 * write. The totals are sums of the rows the reader returned, computed here rather than in the
 * browser, which performs no financial arithmetic (ADR-0048).
 */
export async function previewStatement(
  db: Database,
  input: PreviewStatementInput,
): Promise<StatementPreview> {
  assertStatementWithinLimit(input.bytes.byteLength);

  const parsed = await parseStatementFile({
    bytes: input.bytes,
    formatId: input.formatId,
    filename: input.filename ?? null,
  });
  if (!parsed.ok) {
    return {
      readable: false,
      formatId: parsed.formatId,
      problems: parsed.errors.map((error) => ({
        lineNumber: error.lineNumber,
        message: error.message,
      })),
    };
  }

  const format = listStatementFormats().find((candidate) => candidate.id === parsed.formatId);
  const debits = parsed.rows.filter((row) => row.direction === 'debit');
  const credits = parsed.rows.filter((row) => row.direction === 'credit');
  const days = parsed.rows.map((row) => row.occurredAt.toISOString().slice(0, 10)).sort();
  const closing = [...parsed.rows].reverse().find((row) => row.runningBalance !== null);
  const previous = await findImportBatchByContentHash(db, sha256Bytes(input.bytes));

  return {
    readable: true,
    formatId: parsed.formatId,
    formatLabel: format?.label ?? parsed.formatId,
    // The document's own kind, so the dialog offers exactly the accounts an import would accept.
    accountKind: parsed.accountKind,
    checksPrintedBalances: format?.checksPrintedBalances ?? false,
    movementCount: parsed.rows.length,
    debitCount: debits.length,
    creditCount: credits.length,
    totalDebits: sumPaise(debits.map((row) => row.amount)),
    totalCredits: sumPaise(credits.map((row) => row.amount)),
    firstDate: days[0] ?? null,
    lastDate: days[days.length - 1] ?? null,
    closingBalance: closing?.runningBalance ?? null,
    warnings: parsed.warnings.map((warning) => warning.message),
    alreadyImported:
      previous === null ? null : { importBatchId: previous.id, importedAt: previous.importedAt },
  };
}

/* ============================================================== the shared write path */

/** The structural shape both parsers produce. Neither can say what a payment was *for*. */
interface ImportableRow {
  readonly lineNumber: number;
  readonly occurredAt: Date;
  readonly rawDescription: string;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly externalReference: string | null;
  readonly referenceType: PaymentReferenceType | null;
}

interface WriteImportedRowsInput {
  readonly accountId: AccountId;
  readonly sourceSystem: string;
  readonly sourceChannel: string;
  readonly parserVersion: string;
  readonly channel: PaymentChannel;
  readonly contentHash: string;
  readonly fileReference: string | null;
  readonly rows: readonly ImportableRow[];
  /** The kind of account these rows were checked against, and who named it. */
  readonly statement: NamedStatementKind;
  readonly audit: AuditMeta;
}

/**
 * Turns parsed rows into `Payment`s, once, for every format.
 *
 * Extracted when the second format arrived rather than copied: the two protections against
 * double-counting (the file's hash, and each row's deterministic reference match) are the
 * part of importing that is actually hard to get right, and a second copy of them is a second
 * place for them to drift.
 */
async function writeImportedRows(
  db: Database,
  input: WriteImportedRowsInput,
): Promise<ImportBankStatementCsvResult> {
  const previous = await findImportBatchByContentHash(db, input.contentHash);
  if (previous !== null) {
    return {
      outcome: 'already_imported',
      importBatchId: previous.id,
      contentHash: input.contentHash,
      previouslyImportedAt: previous.importedAt,
    };
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const importBatchId = await insertImportBatch(exec, {
      sourceChannel: input.sourceChannel,
      fileReference: input.fileReference,
      contentHash: input.contentHash,
      parserVersion: input.parserVersion,
      rowCount: input.rows.length,
    });

    const paymentIds: PaymentId[] = [];
    const duplicates: ImportedDuplicate[] = [];

    for (const row of input.rows) {
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
        channel: input.channel,
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
          // Why this movement is on this account: the kind it was checked against, and whether
          // the statement named it or the person importing it did (ADR-0068).
          statementKind: input.statement.kind,
          statementKindNamedBy: input.statement.by,
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

    return {
      outcome: 'imported',
      importBatchId,
      contentHash: input.contentHash,
      paymentIds,
      duplicates,
    };
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
  row: ImportableRow,
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

/**
 * The file's content hash, over its **bytes**.
 *
 * Bytes rather than decoded text because two of the three containers are binary: hashing a
 * decoded `.xlsx` would hash a lossy reading of it, and two different workbooks could collide
 * on the same string. A byte-identical re-import is a recognised no-op (`invariants.md` #10),
 * and that guarantee is only as good as what the hash is taken over.
 */
function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Re-exported so a caller can narrow an amount without reaching into `domain`. */
export type { Paise };
