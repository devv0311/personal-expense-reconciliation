import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { schema } from '../../src/db/index.js';
import type { AccountId } from '../../src/domain/index.js';
import {
  importStatement,
  ingestForwardedMessages,
  listSupportedStatementFormats,
} from '../../src/services/index.js';
import { captureError, createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

/**
 * Multi-format statement import and automated notification intake, end to end against a real
 * engine (audit rows 02 and 12).
 *
 * These assert the ledger state a real bank file produces — the exact paise, the direction,
 * the reference that makes deduplication deterministic — not that a parser was called.
 */

const STATEMENTS = join(process.cwd(), 'fixtures', 'statements');

let database: TestDatabase;
let cast: Cast;
let accountId: AccountId;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  accountId = cast.account['account_hdfc_savings']!;
});

function importFixture(name: string, formatId = 'auto') {
  return importStatement(database.db, {
    accountId,
    sourceSystem: 'synthetic_bank',
    formatId,
    bytes: new Uint8Array(readFileSync(join(STATEMENTS, name))),
    filename: name,
    fileReference: `fixtures/statements/${name}`,
    audit: AS_USER,
  });
}

async function payments() {
  return database.db
    .select()
    .from(schema.payments)
    .orderBy(schema.payments.occurredAt, schema.payments.id);
}

describe('importStatement', () => {
  it('imports an HDFC CSV as immutable payments with exact paise and directions', async () => {
    const result = await importFixture('hdfc-bank-statement.csv');
    expect(result.outcome).toBe('imported');
    if (result.outcome !== 'imported') return;
    expect(result.formatId).toBe('hdfc_bank_csv');
    expect(result.paymentIds).toHaveLength(4);

    const rows = await payments();
    expect(rows).toHaveLength(4);
    const blinkit = rows.find((row) => row.rawDescription.includes('BLINKIT'));
    expect(blinkit?.amount).toBe(124000n);
    expect(blinkit?.direction).toBe('debit');
    expect(blinkit?.externalReference).toBe('UPI/2607011234/BLINKIT');
    expect(blinkit?.referenceType).toBe('upi_utr');
    expect(blinkit?.channel).toBe('bank_transfer');
    expect(blinkit?.state).toBe('imported');

    // The parser does not decide what anything was for: the transfer is still just a debit.
    const transfer = rows.find((row) => row.rawDescription.includes('SELF'));
    expect(transfer?.counterpartyType).toBe('unknown');
    expect(transfer?.cashFlowCategory).toBeNull();
  });

  it('records the format it actually used, and the closing balance the statement printed', async () => {
    const result = await importFixture('hdfc-bank-statement.csv');
    if (result.outcome !== 'imported') throw new Error('expected an import');
    // The last row's printed balance is offered as a candidate boundary — never written as one.
    expect(result.closingBalanceCandidate).toBe('3270950');

    const [batch] = await database.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.importBatchId));
    expect(batch?.sourceChannel).toBe('statement:hdfc_bank_csv');
    expect(batch?.parserVersion).toContain('hdfc_bank_csv');
    expect(batch?.rowCount).toBe(4);
  });

  it('imports a card statement, where a credit is a refund rather than new spend', async () => {
    const result = await importFixture('card-statement.csv');
    if (result.outcome !== 'imported') throw new Error('expected an import');
    expect(result.formatId).toBe('card_statement_csv');
    const rows = await payments();
    expect(rows.map((row) => row.direction).sort()).toEqual(['credit', 'debit']);
    expect(rows.every((row) => row.channel === 'card')).toBe(true);
  });

  it('imports a UPI app export on the upi channel', async () => {
    const result = await importFixture('upi-app-export.csv');
    if (result.outcome !== 'imported') throw new Error('expected an import');
    const rows = await payments();
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.channel === 'upi')).toBe(true);
  });

  it('imports an XLSX workbook', async () => {
    const result = await importFixture('sbi-bank-statement.xlsx');
    if (result.outcome !== 'imported') throw new Error('expected an import');
    expect(result.formatId).toBe('sbi_bank_csv');
    const rows = await payments();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.direction === 'credit' && row.amount === 45000n)).toBeDefined();
  });

  it('imports a generated PDF via its text layer', async () => {
    const result = await importFixture('bank-statement.pdf');
    if (result.outcome !== 'imported') throw new Error('expected an import');
    expect(result.formatId).toBe('pdf_debit_credit_balance');
    const rows = await payments();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.amount === 45000n)?.direction).toBe('credit');
    // A PDF has no columns, so the count is what matched — and the caller is told so.
    expect(result.warnings.some((warning) => warning.message.includes('check the count'))).toBe(
      true,
    );
  });

  it('treats a byte-identical re-import as a recognised no-op, not a second copy', async () => {
    const first = await importFixture('hdfc-bank-statement.csv');
    const second = await importFixture('hdfc-bank-statement.csv');
    expect(second.outcome).toBe('already_imported');
    if (first.outcome !== 'imported' || second.outcome !== 'already_imported') return;
    expect(second.importBatchId).toBe(first.importBatchId);
    expect(await payments()).toHaveLength(4);
  });

  it('ignores a row restated by a second, different statement rather than counting it twice', async () => {
    await importFixture('hdfc-bank-statement.csv');
    // The SBI fixture restates the same UPI/2607011234/BLINKIT debit under a different format.
    const second = await importFixture('sbi-bank-statement.csv');
    if (second.outcome !== 'imported') throw new Error('expected an import');
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0]?.externalReference).toBe('UPI/2607011234/BLINKIT');

    const rows = await payments();
    const blinkitRows = rows.filter((row) => row.externalReference === 'UPI/2607011234/BLINKIT');
    // Both copies are kept — the ledger did receive the evidence twice — and exactly one of
    // them counts (`invariants.md` #10).
    expect(blinkitRows).toHaveLength(2);
    expect(blinkitRows.filter((row) => row.state === 'ignored')).toHaveLength(1);
  });

  it('imports nothing at all when one row is unreadable', async () => {
    const broken =
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n' +
      '01/07/26,GOOD ROW,REF1,01/07/26,100.00,0.00,1.00\n' +
      '99/99/9999,BAD DATE,REF2,01/07/26,200.00,0.00,2.00\n';
    const error = await captureError(() =>
      importStatement(database.db, {
        accountId,
        sourceSystem: 'synthetic_bank',
        formatId: 'hdfc_bank_csv',
        bytes: new TextEncoder().encode(broken),
        audit: AS_USER,
      }),
    );
    expect(error.message).toContain('Could not read a date');
    expect(await payments()).toHaveLength(0);
  });

  it('refuses a file no format matches rather than importing under a guess', async () => {
    const error = await captureError(() =>
      importStatement(database.db, {
        accountId,
        sourceSystem: 'synthetic_bank',
        formatId: 'auto',
        bytes: new TextEncoder().encode('alpha,beta,gamma\n1,2,3\n'),
        audit: AS_USER,
      }),
    );
    expect(error.message).toContain('No supported format matched');
    expect(await payments()).toHaveLength(0);
  });

  it('names every format it reads', () => {
    const ids = listSupportedStatementFormats().map((format) => format.id);
    expect(ids).toEqual(expect.arrayContaining(['hdfc_bank_csv', 'upi_app_export_csv']));
  });
});

describe('ingestForwardedMessages', () => {
  const message = (body: string, receivedAt = '2026-07-01T10:15:00.000Z') => ({
    channel: 'sms' as const,
    receivedAt: new Date(receivedAt),
    sender: 'AD-HDFCBK',
    body,
  });

  it('stores a forwarded bank SMS as immutable evidence with its structured reading', async () => {
    const result = await ingestForwardedMessages(database.db, {
      messages: [
        message('Rs.1240.00 debited from a/c XX4821 on 01-07-26 to BLINKIT. UPI Ref 260701123456.'),
      ],
      audit: { actor: 'forwarder', source: 'test' },
    });

    expect(result.recorded).toBe(1);
    const [outcome] = result.outcomes;
    expect(outcome?.outcome).toBe('recorded');
    expect(outcome?.evidenceType).toBe('upi_notification');

    const [row] = await database.db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.id, outcome!.evidenceId!));
    // SOURCE: the text is stored with its provenance header and is otherwise untouched.
    expect(row?.rawText).toContain('[forwarded via sms]');
    expect(row?.rawText).toContain('Rs.1240.00 debited');
    // Nothing auto-links (ADR-0034, ADR-0037): it reaches the queue for a person to decide.
    expect(row?.linkedPaymentId).toBeNull();
    expect(row?.linkedExpenseId).toBeNull();

    const [observation] = await database.db
      .select()
      .from(schema.evidenceObservations)
      .where(eq(schema.evidenceObservations.evidenceId, outcome!.evidenceId!));
    expect(observation?.observedAmount).toBe(124000n);
    expect(observation?.observedDirection).toBe('debit');
    expect(observation?.derivation).toBe('parsed_from_text');
  });

  it('is idempotent: the same message forwarded twice is one record', async () => {
    const body = 'Rs.450.00 credited to a/c XX4821. UPI Ref 260705998877.';
    await ingestForwardedMessages(database.db, {
      messages: [message(body)],
      audit: { actor: 'forwarder', source: 'test' },
    });
    const second = await ingestForwardedMessages(database.db, {
      messages: [message(body)],
      audit: { actor: 'forwarder', source: 'test' },
    });
    expect(second.alreadyRecorded).toBe(1);
    expect(await database.db.select().from(schema.evidence)).toHaveLength(1);
  });

  it('skips a message with nothing financial in it, and says why', async () => {
    const result = await ingestForwardedMessages(database.db, {
      messages: [message('Your monthly newsletter is here!')],
      audit: { actor: 'forwarder', source: 'test' },
    });
    expect(result.skipped).toBe(1);
    expect(result.outcomes[0]?.reason).toContain('no amount and no');
    expect(await database.db.select().from(schema.evidence)).toHaveLength(0);
  });

  it('keeps one unusable message from costing the usable ones beside it', async () => {
    const result = await ingestForwardedMessages(database.db, {
      messages: [
        message('nothing financial here'),
        message('Rs.99.00 debited from a/c XX4821. UPI Ref 260709111222.'),
      ],
      audit: { actor: 'forwarder', source: 'test' },
    });
    expect(result.skipped).toBe(1);
    expect(result.recorded).toBe(1);
  });

  it('attributes the write to the forwarder, never to a person', async () => {
    const result = await ingestForwardedMessages(database.db, {
      messages: [message('Rs.10.00 debited from a/c XX4821. UPI Ref 260710000111.')],
      audit: { actor: 'forwarder', source: 'api POST /api/intake/messages' },
    });
    const events = await database.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, result.outcomes[0]!.evidenceId!));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.actor === 'forwarder')).toBe(true);
  });
});
