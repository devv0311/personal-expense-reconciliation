import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asId, merchantAliasKey } from '../../src/domain/index.js';
import type { AccountId, MerchantId, PaymentId } from '../../src/domain/index.js';
import {
  findMerchantByAliasKey,
  listAuditEvents,
  listPaymentsAwaitingNormalization,
  schema,
} from '../../src/db/index.js';
import { importBankStatementCsv, normalizePayments } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, seedCast, seedMerchants } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

let database: TestDatabase;
let cast: Cast;
let accountId: AccountId;
let merchant: Record<string, MerchantId>;

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
  merchant = await seedMerchants(database.db);
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

/**
 * One payment's id, by its external reference.
 *
 * Keyed on the reference rather than the description because two statement rows share the
 * Blinkit description — they are distinct transactions, and only the reference tells them
 * apart. `NEFT/N072026001` is shared by the two legs of one transfer, so callers wanting a
 * specific leg must not use it; the tests below use it only where either leg would do.
 */
async function paymentIdByReference(externalReference: string): Promise<PaymentId> {
  const [row] = await database.db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eq(schema.payments.externalReference, externalReference))
    .orderBy(asc(schema.payments.direction));
  return asId<'payment'>(row!.id);
}

describe('listPaymentsAwaitingNormalization', () => {
  it('returns every imported payment, with the fields normalization reads', async () => {
    await importFixture();

    const awaiting = await listPaymentsAwaitingNormalization(database.db);

    expect(awaiting).toHaveLength(8);
    expect(awaiting.every((row) => row.state === 'imported')).toBe(true);
    // The three columns normalization needs, which PaymentRow did not previously carry.
    expect(awaiting.every((row) => row.channel === 'bank_transfer')).toBe(true);
    expect(awaiting.every((row) => typeof row.rawDescription === 'string')).toBe(true);
    expect(awaiting.filter((row) => row.referenceType === 'upi_utr')).toHaveLength(4);
  });

  it('excludes a duplicate ignored at import', async () => {
    await importFixture();
    const overlapping = [
      'date,description,amount_inr,type,reference',
      '2026-07-10,ELECTRICITY BOARD BBPS BILLPAY,2100.00,DEBIT,BBPS/EB220711',
    ].join('\n');
    await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: overlapping,
      audit: AS_USER,
    });

    const awaiting = await listPaymentsAwaitingNormalization(database.db);

    // 9 rows exist; the 9th is `ignored` and must never be offered for normalization.
    expect(await database.db.select({ id: schema.payments.id }).from(schema.payments)).toHaveLength(
      9,
    );
    expect(awaiting).toHaveLength(8);
    expect(awaiting.every((row) => row.state === 'imported')).toBe(true);
  });

  it('scopes to one import batch when asked', async () => {
    const first = await importFixture();
    if (first.outcome !== 'imported') throw new Error('expected an import');
    const second = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-20,UPI-NEWMERCHANT-SAMPLE,300.00,DEBIT,UPI/2607201234/NEW',
      ].join('\n'),
      audit: AS_USER,
    });
    if (second.outcome !== 'imported') throw new Error('expected an import');

    expect(await listPaymentsAwaitingNormalization(database.db, second.importBatchId)).toHaveLength(
      1,
    );
    expect(await listPaymentsAwaitingNormalization(database.db, first.importBatchId)).toHaveLength(
      8,
    );
  });
});

describe('findMerchantByAliasKey', () => {
  it('finds a merchant by the canonical key of its alias', async () => {
    const found = await findMerchantByAliasKey(
      database.db,
      merchantAliasKey('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD'),
    );

    expect(found).toBe(merchant['merchant_blinkit']);
  });

  it('finds the same merchant from a differently-cased, differently-spaced description', async () => {
    const found = await findMerchantByAliasKey(
      database.db,
      merchantAliasKey('  upi-blinkit9821paytm-blinkit   india pvt ltd '),
    );

    expect(found).toBe(merchant['merchant_blinkit']);
  });

  it('returns null for a description no alias covers', async () => {
    expect(
      await findMerchantByAliasKey(
        database.db,
        merchantAliasKey('NEFT TRANSFER TO SELF A/C X4821'),
      ),
    ).toBeNull();
  });

  it('does not match on a prefix', async () => {
    // Exact equality only. A prefix match would let "UPI-BLINKIT" claim every Blinkit-like
    // description, which is a guess, not a deterministic resolution.
    expect(await findMerchantByAliasKey(database.db, merchantAliasKey('UPI-BLINKIT'))).toBeNull();
  });
});

describe('normalizePayments — channel, state, and audit', () => {
  it('moves every imported payment to normalized', async () => {
    await importFixture();

    const result = await normalizePayments(database.db, { audit: AS_USER });

    expect(result.normalizedPaymentIds).toHaveLength(8);
    const rows = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .orderBy(asc(schema.payments.occurredAt));
    expect(rows.every((row) => row.state === 'normalized')).toBe(true);
  });

  it('refines only the channels a reference proves, leaving the rest as imported', async () => {
    await importFixture();

    const result = await normalizePayments(database.db, { audit: AS_USER });

    const rows = await database.db
      .select({ channel: schema.payments.channel, referenceType: schema.payments.referenceType })
      .from(schema.payments);
    expect(rows.filter((row) => row.channel === 'upi')).toHaveLength(4);
    expect(rows.filter((row) => row.channel === 'bank_transfer')).toHaveLength(4);
    expect(rows.every((row) => (row.referenceType === 'upi_utr') === (row.channel === 'upi'))).toBe(
      true,
    );
    expect(result.channelRefinedCount).toBe(4);
  });

  it('never touches a SOURCE column', async () => {
    await importFixture();
    const before = await database.db
      .select({
        id: schema.payments.id,
        amount: schema.payments.amount,
        occurredAt: schema.payments.occurredAt,
        rawDescription: schema.payments.rawDescription,
        accountId: schema.payments.accountId,
      })
      .from(schema.payments)
      .orderBy(asc(schema.payments.id));

    await normalizePayments(database.db, { audit: AS_USER });

    const after = await database.db
      .select({
        id: schema.payments.id,
        amount: schema.payments.amount,
        occurredAt: schema.payments.occurredAt,
        rawDescription: schema.payments.rawDescription,
        accountId: schema.payments.accountId,
      })
      .from(schema.payments)
      .orderBy(asc(schema.payments.id));

    expect(after).toEqual(before);
  });

  it('records one update event per payment, carrying old and new values', async () => {
    const imported = await importFixture();
    if (imported.outcome !== 'imported') throw new Error('expected an import');

    await normalizePayments(database.db, { audit: AS_USER });

    // listAuditEvents is per-entity: (exec, entityType, entityId). Each payment should
    // now carry exactly two events — the importer's `create`, then this `update`.
    for (const paymentId of imported.paymentIds) {
      const events = await listAuditEvents(database.db, 'payment', paymentId);
      expect(events.map((event) => event.action)).toEqual(['create', 'update']);
    }

    // The Blinkit row is one whose channel actually changed, so both sides are visible.
    const blinkit = await paymentIdByReference('UPI/2607011234/BLINKIT');
    const [, update] = await listAuditEvents(database.db, 'payment', blinkit);
    expect(update?.oldValue).toMatchObject({ state: 'imported', channel: 'bank_transfer' });
    expect(update?.newValue).toMatchObject({ state: 'normalized', channel: 'upi' });

    // A row whose channel is not refined still records the state change, with channel equal
    // on both sides — the event says what happened, not only what differed.
    const utility = await paymentIdByReference('BBPS/EB220711');
    const [, utilityUpdate] = await listAuditEvents(database.db, 'payment', utility);
    expect(utilityUpdate?.oldValue).toMatchObject({ state: 'imported', channel: 'bank_transfer' });
    expect(utilityUpdate?.newValue).toMatchObject({
      state: 'normalized',
      channel: 'bank_transfer',
    });
  });

  it('is a no-op on a second run, rewriting nothing', async () => {
    await importFixture();
    await normalizePayments(database.db, { audit: AS_USER });
    const afterFirst = await database.db
      .select({ id: schema.payments.id, channel: schema.payments.channel })
      .from(schema.payments)
      .orderBy(asc(schema.payments.id));
    const blinkit = await paymentIdByReference('UPI/2607011234/BLINKIT');
    const eventsAfterFirst = (await listAuditEvents(database.db, 'payment', blinkit)).length;

    const second = await normalizePayments(database.db, { audit: AS_USER });

    // No eligible payments: returns empty rather than throwing AUDIT_EVENT_MISSING,
    // and writes no second audit event.
    expect(second.normalizedPaymentIds).toEqual([]);
    expect(second.channelRefinedCount).toBe(0);
    expect(await listAuditEvents(database.db, 'payment', blinkit)).toHaveLength(eventsAfterFirst);
    expect(
      await database.db
        .select({ id: schema.payments.id, channel: schema.payments.channel })
        .from(schema.payments)
        .orderBy(asc(schema.payments.id)),
    ).toEqual(afterFirst);
  });

  it('leaves a duplicate ignored at import untouched', async () => {
    await importFixture();
    const overlapping = [
      'date,description,amount_inr,type,reference',
      '2026-07-10,ELECTRICITY BOARD BBPS BILLPAY,2100.00,DEBIT,BBPS/EB220711',
    ].join('\n');
    const repeat = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: overlapping,
      audit: AS_USER,
    });
    if (repeat.outcome !== 'imported') throw new Error('expected an import');
    const ignoredId = repeat.duplicates[0]!.paymentId;

    await normalizePayments(database.db, { audit: AS_USER });

    const [ignored] = await database.db
      .select({ state: schema.payments.state, ignoredReason: schema.payments.ignoredReason })
      .from(schema.payments)
      .where(eq(schema.payments.id, ignoredId));
    expect(ignored?.state).toBe('ignored');
    expect(ignored?.ignoredReason).toMatch(/^duplicate_of:/);
  });

  it('normalizes only the batch it was scoped to', async () => {
    const first = await importFixture();
    if (first.outcome !== 'imported') throw new Error('expected an import');
    const second = await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: [
        'date,description,amount_inr,type,reference',
        '2026-07-20,UPI-NEWMERCHANT-SAMPLE,300.00,DEBIT,UPI/2607201234/NEW',
      ].join('\n'),
      audit: AS_USER,
    });
    if (second.outcome !== 'imported') throw new Error('expected an import');

    const result = await normalizePayments(database.db, {
      importBatchId: second.importBatchId,
      audit: AS_USER,
    });

    expect(result.normalizedPaymentIds).toHaveLength(1);
    expect(await listPaymentsAwaitingNormalization(database.db, first.importBatchId)).toHaveLength(
      8,
    );
  });
});

describe('normalizePayments — merchant resolution', () => {
  it('resolves every catalogued merchant and leaves the rest unknown', async () => {
    await importFixture();

    const result = await normalizePayments(database.db, { audit: AS_USER });

    const rows = await database.db
      .select({
        rawDescription: schema.payments.rawDescription,
        counterpartyType: schema.payments.counterpartyType,
        counterpartyId: schema.payments.counterpartyId,
      })
      .from(schema.payments);
    const byDescription = new Map(rows.map((row) => [row.rawDescription, row]));

    expect(byDescription.get('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD')).toMatchObject({
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_blinkit'],
    });
    expect(byDescription.get('ELECTRICITY BOARD BBPS BILLPAY')).toMatchObject({
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_electricity_board'],
    });
    // A credit resolves on the same terms as a debit. Whether it is a refund is
    // classification, not normalization.
    expect(byDescription.get('ACH REFUND SAMPLE ELECTRONICS STORE')).toMatchObject({
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_sample_electronics'],
    });

    expect(result.merchantResolvedCount).toBe(5);
  });

  it('leaves the obvious self-transfer unknown — recognising it is classification', async () => {
    await importFixture();

    await normalizePayments(database.db, { audit: AS_USER });

    const transfers = await database.db
      .select({ counterpartyType: schema.payments.counterpartyType })
      .from(schema.payments)
      .where(eq(schema.payments.externalReference, 'NEFT/N072026001'));
    expect(transfers).toHaveLength(2);
    expect(transfers.every((row) => row.counterpartyType === 'unknown')).toBe(true);
  });

  it('leaves a person-to-person payment unknown — a person is not a merchant', async () => {
    await importFixture();

    await normalizePayments(database.db, { audit: AS_USER });

    const [p2p] = await database.db
      .select({
        counterpartyType: schema.payments.counterpartyType,
        counterpartyId: schema.payments.counterpartyId,
        state: schema.payments.state,
      })
      .from(schema.payments)
      .where(eq(schema.payments.rawDescription, 'UPI-FRIENDA-TRANSFER'));
    expect(p2p).toMatchObject({ counterpartyType: 'unknown', counterpartyId: null });
    // Still normalized: the bar is "resolution attempted", not "resolved".
    expect(p2p?.state).toBe('normalized');
  });

  it('writes no counterparty when the catalog is empty', async () => {
    await database.truncateAll();
    cast = await seedCast(database.db);
    accountId = cast.account['account_hdfc_savings']!;
    await importFixture();

    const result = await normalizePayments(database.db, { audit: AS_USER });

    expect(result.merchantResolvedCount).toBe(0);
    expect(result.normalizedPaymentIds).toHaveLength(8);
    const rows = await database.db
      .select({ counterpartyType: schema.payments.counterpartyType })
      .from(schema.payments);
    expect(rows.every((row) => row.counterpartyType === 'unknown')).toBe(true);
  });

  it('records the resolved merchant in the audit event', async () => {
    await importFixture();

    await normalizePayments(database.db, { audit: AS_USER });

    const blinkit = await paymentIdByReference('UPI/2607011234/BLINKIT');
    const [, resolvedUpdate] = await listAuditEvents(database.db, 'payment', blinkit);
    expect(resolvedUpdate?.oldValue).toMatchObject({ counterpartyType: 'unknown' });
    expect(resolvedUpdate?.newValue).toMatchObject({
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_blinkit'],
    });

    // The self-transfer's event records that resolution was attempted and found nothing —
    // an unresolved counterparty is an outcome, not a missing event.
    const transfer = await paymentIdByReference('NEFT/N072026001');
    const [, transferUpdate] = await listAuditEvents(database.db, 'payment', transfer);
    expect(transferUpdate?.newValue).toMatchObject({
      state: 'normalized',
      counterpartyType: 'unknown',
      counterpartyId: null,
    });
  });
});
