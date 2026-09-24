/**
 * Instalment timelines and anomalies, end to end over a real database.
 *
 * The domain tests fix the rules; this fixes the wiring — that one read feeds both, that the
 * plans really do silence the anomaly list, and that neither writes anything.
 *
 * Every row is invented for this test. The merchant names are made up, the amounts are round
 * numbers no real statement would carry, and the wording follows the *shapes* an Indian
 * credit-card statement uses without reproducing any real one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paise } from '../../src/domain/index.js';
import type { PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import {
  getInstalmentPlanForPayment,
  readInstalmentsAndAnomalies,
} from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';

let database: TestDatabase;
let cast: Cast;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
});

/** A statement row, exactly as the importer would have written it. */
async function statementRow(
  rawDescription: string,
  options: { amount?: bigint; direction?: 'debit' | 'credit'; day?: number } = {},
): Promise<PaymentId> {
  return addPayment(database.db, cast, {
    accountId: cast.account['account_hdfc_savings']!,
    amount: paise(options.amount ?? 250_000n),
    direction: options.direction ?? 'debit',
    occurredAt: new Date(Date.UTC(2026, 7, options.day ?? 8)),
    rawDescription,
    channel: 'card',
    state: 'imported',
  });
}

/** A whole plan, the shape a statement carries it in. */
async function seedPlan(): Promise<{ principal: PaymentId; interest: PaymentId }> {
  const principal = await statementRow(
    'NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>',
    { amount: 250_000n, day: 8 },
  );
  const interest = await statementRow('NORTHWIND APPLIANCES - INTEREST 1 - <1/3>', {
    amount: 18_000n,
    day: 8,
  });
  await statementRow('CGST', { amount: 1_600n, day: 9 });
  return { principal, interest };
}

describe('reading an instalment plan off the ledger', () => {
  it('groups the rows a statement scattered, and reports the tenure it printed', async () => {
    await seedPlan();

    const { plans } = await readInstalmentsAndAnomalies(database.db);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.tenure).toEqual({ known: true, of: 3 });
    expect(plans[0]?.observed.principal).toBe(250_000n);
    expect(plans[0]?.observed.interest).toBe(18_000n);
    expect(plans[0]?.observed.tax).toBe(1_600n);
  });

  it('marks what it has not seen as expected, with no amount attached', async () => {
    await seedPlan();

    const { plans } = await readInstalmentsAndAnomalies(database.db);
    const entries = plans[0]?.positions ?? [];

    expect(entries.map((entry) => entry.certainty)).toEqual(['observed', 'expected', 'expected']);
    for (const entry of entries.slice(1)) {
      expect(entry.principal).toBeNull();
      expect(entry.charges).toEqual([]);
    }
  });

  it('says in words what it does not know, including that there is no due date', async () => {
    await seedPlan();

    const { plans } = await readInstalmentsAndAnomalies(database.db);

    expect(plans[0]?.unknowns.join(' ')).toMatch(/When the next one is due/);
    expect(plans[0]?.purchase.known).toBe(false);
  });

  it('finds the plan a given payment belongs to, and returns null for one outside it', async () => {
    const { principal } = await seedPlan();
    const cafe = await statementRow('HARBOUR CAFE', { amount: 40_000n, day: 11 });

    expect((await getInstalmentPlanForPayment(database.db, principal))?.tenure.of).toBe(3);
    expect(await getInstalmentPlanForPayment(database.db, cafe)).toBeNull();
  });

  it('refuses to call a merchant that merely repeats an instalment plan', async () => {
    // Four identical monthly debits. A reader grouping on recurrence would invent a tenure here
    // and tell somebody they owe instalments nobody agreed to.
    for (const day of [1, 8, 15, 22]) {
      await statementRow('CITYFIELD GYM', { amount: 120_000n, day });
    }

    const { plans } = await readInstalmentsAndAnomalies(database.db);
    expect(plans).toEqual([]);
  });
});

describe('anomalies over the same read', () => {
  it('stays silent about a well-formed plan and its tax', async () => {
    await seedPlan();

    const { anomalies } = await readInstalmentsAndAnomalies(database.db);
    expect(anomalies).toEqual([]);
  });

  it('never reports a CGST/SGST pair as a repeated charge', async () => {
    await seedPlan();
    await statementRow('SGST', { amount: 1_600n, day: 9 });
    await statementRow('CGST', { amount: 1_600n, day: 9 });

    const { anomalies } = await readInstalmentsAndAnomalies(database.db);
    expect(anomalies.filter((anomaly) => anomaly.kind === 'repeated_charge')).toEqual([]);
  });

  it('reports interest that no plan on file explains, with the row attached', async () => {
    await statementRow('SEAGRASS FURNITURE - INTEREST 4', { amount: 90_000n, day: 12 });

    const { anomalies } = await readInstalmentsAndAnomalies(database.db);
    const found = anomalies.find((anomaly) => anomaly.kind === 'unexplained_interest');

    expect(found).toBeDefined();
    expect(found?.evidence).toHaveLength(1);
    expect(found?.evidence[0]?.paymentId).toBeTruthy();
  });

  it('goes quiet about that same interest once its plan is imported', async () => {
    // The property the single read exists for: adding the principal row silences the finding,
    // because both readings come from one snapshot of one table.
    await statementRow('SEAGRASS FURNITURE - INTEREST 1 - <1/2>', { amount: 90_000n, day: 12 });
    const before = await readInstalmentsAndAnomalies(database.db);
    expect(before.anomalies.some((anomaly) => anomaly.kind === 'unexplained_interest')).toBe(true);

    await statementRow('SEAGRASS FURNITURE - Principal Amount Amortization - <1/2>', {
      amount: 400_000n,
      day: 12,
    });

    const after = await readInstalmentsAndAnomalies(database.db);
    expect(after.anomalies.some((anomaly) => anomaly.kind === 'unexplained_interest')).toBe(false);
    expect(after.plans).toHaveLength(1);
  });

  it('reports two identical charges close together as an observation', async () => {
    await statementRow('HARBOUR CAFE', { amount: 40_000n, day: 11 });
    await statementRow('HARBOUR CAFE', { amount: 40_000n, day: 11 });

    const { anomalies } = await readInstalmentsAndAnomalies(database.db);
    const repeat = anomalies.find((anomaly) => anomaly.kind === 'repeated_charge');

    expect(repeat?.evidence).toHaveLength(2);
    expect(repeat?.detail).toMatch(/often exactly what happened/);
  });

  it('never accuses anybody, whatever it finds', async () => {
    await statementRow('SEAGRASS FURNITURE - INTEREST 4', { amount: 90_000n, day: 12 });
    await statementRow('HARBOUR CAFE', { amount: 40_000n, day: 11 });
    await statementRow('HARBOUR CAFE', { amount: 40_000n, day: 11 });

    const { anomalies } = await readInstalmentsAndAnomalies(database.db);
    expect(anomalies.length).toBeGreaterThan(0);
    for (const anomaly of anomalies) {
      expect(`${anomaly.headline} ${anomaly.detail}`).not.toMatch(
        /\b(fraud|suspicious|unauthoriz|overcharg|dispute this)\b/i,
      );
    }
  });
});

describe('both readings are reads', () => {
  it('changes no row, no state and no count', async () => {
    await seedPlan();
    await statementRow('HARBOUR CAFE', { amount: 40_000n, day: 11 });

    const before = await database.db.select().from(schema.payments);
    const beforeAudit = await database.db.select().from(schema.auditEvents);

    await readInstalmentsAndAnomalies(database.db);
    await readInstalmentsAndAnomalies(database.db);

    const after = await database.db.select().from(schema.payments);
    const afterAudit = await database.db.select().from(schema.auditEvents);

    expect(after).toHaveLength(before.length);
    // No proposal, no link, no audit entry: there is no decision here to record, because the
    // reader is never asked to make one (ADR-0063).
    expect(afterAudit).toHaveLength(beforeAudit.length);
    expect(after.map((row) => row.state).sort()).toEqual(before.map((row) => row.state).sort());
    expect(after.map((row) => row.rawDescription).sort()).toEqual(
      before.map((row) => row.rawDescription).sort(),
    );
  });

  it('gives the same answer twice over an unchanged ledger', async () => {
    await seedPlan();

    const once = await readInstalmentsAndAnomalies(database.db);
    const twice = await readInstalmentsAndAnomalies(database.db);

    expect(twice.plans.map((plan) => plan.planKey)).toEqual(once.plans.map((plan) => plan.planKey));
    expect(twice.anomalies.map((anomaly) => anomaly.id)).toEqual(
      once.anomalies.map((anomaly) => anomaly.id),
    );
    expect(twice.rowsRead).toBe(once.rowsRead);
  });
});
