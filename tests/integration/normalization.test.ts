import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { merchantAliasKey } from '../../src/domain/index.js';
import type { AccountId, MerchantId } from '../../src/domain/index.js';
import {
  findMerchantByAliasKey,
  listPaymentsAwaitingNormalization,
  schema,
} from '../../src/db/index.js';
import { importBankStatementCsv } from '../../src/services/index.js';
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
