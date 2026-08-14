import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId } from '../../src/domain/index.js';
import type { AccountId } from '../../src/domain/index.js';
import { listAuditEvents, schema } from '../../src/db/index.js';
import { importBankStatementCsv } from '../../src/services/index.js';
import type { ImportSourceError } from '../../src/services/index.js';
import { captureError, createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

/**
 * Phase 6, end to end: a synthetic CSV becomes an `ImportBatch` plus immutable `Payment`
 * rows, with references extracted and duplicates handled — against a real PostgreSQL engine.
 *
 * These assert the resulting ledger state, not that functions were called.
 */

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

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

function importFixture(content: string = FIXTURE) {
  return importBankStatementCsv(database.db, {
    accountId,
    sourceSystem: 'synthetic_bank_csv',
    fileContent: content,
    fileReference: 'fixtures/bank-statement.csv',
    audit: AS_USER,
  });
}

async function bankStatementBatches() {
  return database.db
    .select({ id: schema.importBatches.id })
    .from(schema.importBatches)
    .where(eq(schema.importBatches.sourceChannel, 'bank_statement_csv'));
}

async function storedPayments() {
  return database.db
    .select({
      id: schema.payments.id,
      amount: schema.payments.amount,
      currency: schema.payments.currency,
      direction: schema.payments.direction,
      occurredAt: schema.payments.occurredAt,
      rawDescription: schema.payments.rawDescription,
      channel: schema.payments.channel,
      counterpartyType: schema.payments.counterpartyType,
      externalReference: schema.payments.externalReference,
      referenceType: schema.payments.referenceType,
      sourceSystem: schema.payments.sourceSystem,
      state: schema.payments.state,
      ignoredReason: schema.payments.ignoredReason,
      importBatchId: schema.payments.importBatchId,
    })
    .from(schema.payments)
    .orderBy(asc(schema.payments.occurredAt), asc(schema.payments.rawDescription));
}

describe('the import batch', () => {
  it('records one batch for the import attempt', async () => {
    const result = await importFixture();

    const batches = await database.db
      .select({
        id: schema.importBatches.id,
        sourceChannel: schema.importBatches.sourceChannel,
        fileReference: schema.importBatches.fileReference,
        contentHash: schema.importBatches.contentHash,
        parserVersion: schema.importBatches.parserVersion,
        rowCount: schema.importBatches.rowCount,
      })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.sourceChannel, 'bank_statement_csv'));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      sourceChannel: 'bank_statement_csv',
      fileReference: 'fixtures/bank-statement.csv',
      rowCount: 8,
    });
    expect(result.outcome).toBe('imported');
    expect(batches[0]?.contentHash).toHaveLength(64);
  });

  it('attaches every payment to that batch', async () => {
    const result = await importFixture();
    if (result.outcome !== 'imported') throw new Error('expected an import');

    const rows = await storedPayments();

    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.importBatchId))).toEqual(new Set([result.importBatchId]));
  });
});

describe('payments carry the source values, unaltered', () => {
  it('persists amounts as exact bigint paise', async () => {
    await importFixture();
    const rows = await storedPayments();

    expect(rows.map((row) => row.amount).sort((a, b) => (a < b ? -1 : 1))).toEqual([
      45000n,
      100000n,
      124000n,
      124000n,
      210000n,
      284000n,
      1500000n,
      1500000n,
    ]);
    expect(rows.every((row) => typeof row.amount === 'bigint')).toBe(true);
  });

  it('preserves the raw description exactly, noise included', async () => {
    await importFixture();
    const rows = await storedPayments();

    expect(rows.map((row) => row.rawDescription)).toContain(
      'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    );
    expect(rows.map((row) => row.rawDescription)).toContain('NEFT TRANSFER TO SELF A/C X4821');
  });

  it('preserves direction on both debit and credit rows', async () => {
    await importFixture();
    const rows = await storedPayments();

    expect(rows.filter((row) => row.direction === 'credit')).toHaveLength(2);
    expect(rows.filter((row) => row.direction === 'debit')).toHaveLength(6);
  });

  it('stores the date at UTC midnight, independent of the host timezone', async () => {
    await importFixture();
    const rows = await storedPayments();

    expect(rows[0]?.occurredAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('stores every reference field from day one (ADR-0010)', async () => {
    await importFixture();
    const rows = await storedPayments();
    const blinkit = rows.find((row) => row.externalReference === 'UPI/2607011234/BLINKIT');

    expect(blinkit).toMatchObject({
      referenceType: 'upi_utr',
      sourceSystem: 'synthetic_bank_csv',
    });
    expect(rows.every((row) => row.sourceSystem === 'synthetic_bank_csv')).toBe(true);
    expect(rows.every((row) => row.externalReference !== null)).toBe(true);
  });

  it('records the currency the domain supports', async () => {
    await importFixture();

    expect((await storedPayments()).every((row) => row.currency === 'INR')).toBe(true);
  });
});

describe('the importer classifies nothing', () => {
  it('leaves every counterparty unknown, including the obvious self-transfer', async () => {
    await importFixture();
    const rows = await storedPayments();

    // "NEFT TRANSFER TO SELF" is plainly an internal transfer to a human reader. Deciding
    // that is Phase 8's job; import must leave it undecided.
    expect(rows.every((row) => row.counterpartyType === 'unknown')).toBe(true);
    const selfTransfer = rows.find((row) => row.rawDescription.includes('TRANSFER TO SELF'));
    expect(selfTransfer?.counterpartyType).toBe('unknown');
  });

  it('leaves every non-duplicate payment at imported, awaiting normalization', async () => {
    await importFixture();
    const rows = await storedPayments();

    expect(rows.filter((row) => row.state === 'imported')).toHaveLength(8);
  });

  it('creates no expenses, settlements or allocations', async () => {
    await importFixture();

    expect(await database.db.select({ id: schema.expenses.id }).from(schema.expenses)).toEqual([]);
    expect(
      await database.db.select({ id: schema.settlements.id }).from(schema.settlements),
    ).toEqual([]);
    expect(
      await database.db.select({ id: schema.allocations.id }).from(schema.allocations),
    ).toEqual([]);
  });
});

describe('the two legs of one transfer both survive (ADR-0019)', () => {
  it('keeps both NEFT rows, which share a reference but oppose in direction', async () => {
    await importFixture();
    const rows = await storedPayments();
    const neft = rows.filter((row) => row.externalReference === 'NEFT/N072026001');

    expect(neft).toHaveLength(2);
    expect(neft.map((row) => row.direction).sort()).toEqual(['credit', 'debit']);
    expect(neft.every((row) => row.state === 'imported')).toBe(true);
    expect(neft.every((row) => row.ignoredReason === null)).toBe(true);
  });

  it('reports no duplicates for the fixture at all', async () => {
    const result = await importFixture();
    if (result.outcome !== 'imported') throw new Error('expected an import');

    expect(result.duplicates).toEqual([]);
  });
});

describe('re-importing does not double-count', () => {
  it('recognises a byte-identical file and writes nothing new', async () => {
    const first = await importFixture();
    const second = await importFixture();

    expect(second.outcome).toBe('already_imported');
    if (second.outcome !== 'already_imported' || first.outcome !== 'imported') {
      throw new Error('unexpected outcomes');
    }
    expect(second.importBatchId).toBe(first.importBatchId);

    expect(await storedPayments()).toHaveLength(8);
    expect(await bankStatementBatches()).toHaveLength(1);
  });

  it('marks a re-stated row ignored when an overlapping statement repeats it', async () => {
    await importFixture();

    // A different file — one extra row — that restates two transactions already imported.
    const overlapping = [
      'date,description,amount_inr,type,reference',
      '2026-07-10,ELECTRICITY BOARD BBPS BILLPAY,2100.00,DEBIT,BBPS/EB220711',
      '2026-07-12,UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD,1240.00,DEBIT,UPI/2607121234/BLINKIT',
      '2026-07-14,UPI-NEWCHARGE-SAMPLE,500.00,DEBIT,UPI/2607141111/NEW',
    ].join('\n');

    const result = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: overlapping,
      audit: AS_USER,
    });
    if (result.outcome !== 'imported') throw new Error('expected an import');

    expect(result.duplicates).toHaveLength(2);
    expect(result.duplicates.map((duplicate) => duplicate.externalReference).sort()).toEqual([
      'BBPS/EB220711',
      'UPI/2607121234/BLINKIT',
    ]);

    const rows = await storedPayments();
    const ignored = rows.filter((row) => row.state === 'ignored');
    expect(ignored).toHaveLength(2);
    for (const row of ignored) {
      expect(row.ignoredReason).toMatch(/^duplicate_of:[0-9a-f-]{36}$/);
    }
    // The genuinely new row is untouched.
    expect(rows.filter((row) => row.externalReference === 'UPI/2607141111/NEW')).toHaveLength(1);
    expect(rows.find((row) => row.externalReference === 'UPI/2607141111/NEW')?.state).toBe(
      'imported',
    );
  });

  it('keeps the duplicate row as evidence rather than discarding it (#10)', async () => {
    await importFixture();
    const overlapping = [
      'date,description,amount_inr,type,reference',
      '2026-07-12,UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD,1240.00,DEBIT,UPI/2607121234/BLINKIT',
    ].join('\n');
    await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: overlapping,
      audit: AS_USER,
    });

    const blinkit = (await storedPayments()).filter(
      (row) => row.externalReference === 'UPI/2607121234/BLINKIT',
    );

    // Two rows exist — never silently merged, never silently kept as two indistinguishable
    // ones: one counts, one carries the reason it does not.
    expect(blinkit).toHaveLength(2);
    expect(blinkit.filter((row) => row.state === 'imported')).toHaveLength(1);
    expect(blinkit.filter((row) => row.state === 'ignored')).toHaveLength(1);
  });

  it('detects a row restated twice within a single file', async () => {
    const selfRepeating = [
      'date,description,amount_inr,type,reference',
      '2026-07-20,UPI-SAMPLE,300.00,DEBIT,UPI/2607201234/SAMPLE',
      '2026-07-20,UPI-SAMPLE,300.00,DEBIT,UPI/2607201234/SAMPLE',
    ].join('\n');

    const result = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: selfRepeating,
      audit: AS_USER,
    });
    if (result.outcome !== 'imported') throw new Error('expected an import');

    expect(result.duplicates).toHaveLength(1);
    expect((await storedPayments()).filter((row) => row.state === 'ignored')).toHaveLength(1);
  });
});

describe('malformed source is refused, atomically and explicitly', () => {
  it('imports nothing at all when any row is bad', async () => {
    const broken = [
      'date,description,amount_inr,type,reference',
      '2026-07-01,GOOD ROW,10.00,DEBIT,UPI/1/A',
      '2026-07-02,BAD ROW,abc,DEBIT,UPI/2/B',
    ].join('\n');

    const error = await captureError(() =>
      importBankStatementCsv(database.db, {
        accountId,
        sourceSystem: 'synthetic_bank_csv',
        fileContent: broken,
        audit: AS_USER,
      }),
    );

    expect(error.message).toMatch(/line 3/);
    // The good row is not imported either — a half-imported statement is worse than none.
    expect(await storedPayments()).toEqual([]);
    expect(await bankStatementBatches()).toEqual([]);
  });

  it('reports every rejected row, with its line number', async () => {
    let raised: ImportSourceError | undefined;
    try {
      await importBankStatementCsv(database.db, {
        accountId,
        sourceSystem: 'synthetic_bank_csv',
        fileContent: [
          'date,description,amount_inr,type,reference',
          '2026-07-01,A,abc,DEBIT,UPI/1/A',
          '2026-07-02,B,10.00,SIDEWAYS,UPI/2/B',
        ].join('\n'),
        audit: AS_USER,
      });
    } catch (error) {
      raised = error as ImportSourceError;
    }

    expect(raised?.code).toBe('IMPORT_SOURCE_INVALID');
    expect(raised?.rowErrors.map((rowError) => rowError.lineNumber)).toEqual([2, 3]);
    expect(raised?.rowErrors.map((rowError) => rowError.column)).toEqual(['amount_inr', 'type']);
  });
});

describe('database constraints still hold against imported data', () => {
  it('rejects a payment whose account does not exist', async () => {
    const error = await captureError(() =>
      importBankStatementCsv(database.db, {
        accountId: asId<'account'>('00000000-0000-0000-0000-000000000000'),
        sourceSystem: 'synthetic_bank_csv',
        fileContent: FIXTURE,
        audit: AS_USER,
      }),
    );

    expect(error.message).toMatch(/foreign key|violates/i);
    expect(await storedPayments()).toEqual([]);
  });

  it('leaves imported source values untouched when the same row arrives again', async () => {
    await importFixture();
    const before = (await storedPayments()).find(
      (row) => row.externalReference === 'UPI/2607121234/BLINKIT',
    );

    await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'a_different_source',
      fileContent: [
        'date,description,amount_inr,type,reference',
        // The same transaction, restated by another export with a mangled description.
        '2026-07-12,BLINKIT (RESTATED BY ANOTHER EXPORT),1240.00,DEBIT,UPI/2607121234/BLINKIT',
      ].join('\n'),
      audit: AS_USER,
    });

    const after = (await storedPayments()).find((row) => row.id === before?.id);

    // The first row is SOURCE evidence. The second capture is stored separately and ignored;
    // nothing about the first is rewritten to "clean it up" (invariants.md #4).
    expect(before).toBeDefined();
    expect(after).toEqual(before);
  });
});

describe('the import is auditable', () => {
  it('records a create event per payment, naming its source line', async () => {
    const result = await importFixture();
    if (result.outcome !== 'imported') throw new Error('expected an import');

    const first = result.paymentIds[0]!;
    const events = await listAuditEvents(database.db, 'payment', first);

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('create');
    expect(events[0]?.newValue).toMatchObject({
      sourceLine: 2,
      amount: '124000',
      direction: 'debit',
      externalReference: 'UPI/2607011234/BLINKIT',
      referenceType: 'upi_utr',
    });
  });

  it('records why a duplicate was ignored, never dropping it silently', async () => {
    await importFixture();
    const result = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-12,UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD,1240.00,DEBIT,UPI/2607121234/BLINKIT',
      ].join('\n'),
      audit: AS_USER,
    });
    if (result.outcome !== 'imported') throw new Error('expected an import');

    const events = await listAuditEvents(database.db, 'payment', result.paymentIds[0]!);

    expect(events.map((event) => event.action)).toEqual(['create', 'update']);
    expect(events[1]?.newValue).toMatchObject({ state: 'ignored' });
    expect(events[1]?.reason).toMatch(/^duplicate_of:/);
  });

  it('writes no audit events when the import is a recognised repeat', async () => {
    await importFixture();
    const before = await database.db.select({ id: schema.auditEvents.id }).from(schema.auditEvents);

    await importFixture();
    const after = await database.db.select({ id: schema.auditEvents.id }).from(schema.auditEvents);

    expect(after).toHaveLength(before.length);
  });
});

describe('imported payments are visible to reconciliation as unexplained outflow', () => {
  it('counts the debits, excludes the credits and excludes ignored duplicates', async () => {
    const { runReconciliation } = await import('../../src/services/index.js');
    await importFixture();

    const { totals } = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-08-01T00:00:00Z'),
      audit: AS_USER,
    });

    // Debits: 1240 + 15000 + 2840 + 1000 + 2100 + 1240 = 23420 rupees.
    expect(totals.ledgerTotalOutflow).toBe(2342000n);
    // Nothing is classified yet, so all of it is unexplained — which is the correct and
    // useful answer at this stage, not a defect.
    expect(totals.ledgerExplainedTotal).toBe(0n);
    expect(totals.ledgerTransfersTotal).toBe(0n);
    expect(totals.ledgerUnexplainedTotal).toBe(2342000n);
  });

  it('drops an ignored duplicate out of the outflow total', async () => {
    await importFixture();
    const { runReconciliation } = await import('../../src/services/index.js');
    const before = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-08-01T00:00:00Z'),
      audit: AS_USER,
    });

    await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-12,UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD,1240.00,DEBIT,UPI/2607121234/BLINKIT',
      ].join('\n'),
      audit: AS_USER,
    });

    const after = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-08-01T00:00:00Z'),
      audit: AS_USER,
    });

    // Re-stating a transaction the ledger already had must not move the total.
    expect(after.totals.ledgerTotalOutflow).toBe(before.totals.ledgerTotalOutflow);
  });
});
