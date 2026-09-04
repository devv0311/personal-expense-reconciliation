/**
 * The phase-8 vertical slice, end to end: a bank statement in, a ledger out.
 *
 * ```
 * fixtures/bank-statement.csv
 *   ─▶ services.importBankStatementCsv   (phase 6)
 *   ─▶ services.normalizePayments        (phase 7)
 *   ─▶ services.classifyPayments         (phase 8, this slice)
 *   ─▶ services.decideInference × N      (phase 8, this slice)
 * ```
 *
 * Every one of the fixture's eight rows has to reach a stated outcome — that is the phase's
 * definition of done, and this file is where it is checked as one story rather than as
 * separate behaviours. The closing assertion is `services.runReconciliation`: after the
 * pipeline, every rupee that left the account is either a transfer, a settlement, or an
 * approved expense, and `ledger_unexplained_total` is exactly zero.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import type { AccountId, MerchantId, PaymentId } from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import {
  classifyPayments,
  decideInference,
  importBankStatementCsv,
  normalizePayments,
  runReconciliation,
} from '../../src/services/index.js';
import type { ClassificationOutcome } from '../../src/services/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { AS_USER, seedCast, seedMerchants } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const FIXTURE = readFileSync(join(process.cwd(), 'fixtures', 'bank-statement.csv'), 'utf8');

const AS_SYSTEM = { actor: 'system', source: 'services.classifyPayments' } as const;
const AS_REVIEWER = { actor: 'user', source: 'services.decideInference' } as const;

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

/** Import → normalize → classify → accept every proposal the run produced. */
async function runPipeline(): Promise<{
  outcomes: readonly ClassificationOutcome[];
  decided: number;
}> {
  await importBankStatementCsv(database.db, {
    accountId,
    sourceSystem: 'synthetic_bank_csv',
    fileContent: FIXTURE,
    fileReference: 'fixtures/bank-statement.csv',
    audit: AS_USER,
  });
  await normalizePayments(database.db, { audit: AS_USER });

  const { outcomes } = await classifyPayments(database.db, {
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    audit: AS_SYSTEM,
  });

  let decided = 0;
  for (const outcome of outcomes) {
    if (outcome.outcome !== 'proposed') continue;
    // A reviewer working the queue: every proposal, including the ones routed to
    // REVIEW_REQUIRED, is confirmed by hand. Nothing auto-approves (invariants.md #16).
    await decideInference(database.db, {
      inferenceId: outcome.inferenceId,
      decision: 'accept',
      audit: AS_REVIEWER,
    });
    decided += 1;
  }
  return { outcomes, decided };
}

async function paymentsByDescription(): Promise<
  Map<
    string,
    Array<{
      id: PaymentId;
      state: string;
      counterpartyType: string;
      counterpartyId: string | null;
      amount: bigint;
      direction: string;
    }>
  >
> {
  const rows = await database.db
    .select({
      id: schema.payments.id,
      rawDescription: schema.payments.rawDescription,
      state: schema.payments.state,
      counterpartyType: schema.payments.counterpartyType,
      counterpartyId: schema.payments.counterpartyId,
      amount: schema.payments.amount,
      direction: schema.payments.direction,
    })
    .from(schema.payments);
  const grouped = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) {
    grouped.set(row.rawDescription, [...(grouped.get(row.rawDescription) ?? []), row]);
  }
  return grouped as never;
}

describe('the statement, all the way through', () => {
  it('reaches a stated outcome for every row', async () => {
    const { outcomes, decided } = await runPipeline();

    expect(outcomes).toHaveLength(8);
    expect(decided).toBe(5);
    const byOutcome = outcomes.reduce<Record<string, number>>((totals, outcome) => {
      totals[outcome.outcome] = (totals[outcome.outcome] ?? 0) + 1;
      return totals;
    }, {});
    // Four merchant expenses, one settlement, two transfer legs, one credit left alone.
    expect(byOutcome).toEqual({ proposed: 5, internal_transfer: 2, skipped: 1 });
  });

  it('leaves each payment in the state its classification implies', async () => {
    await runPipeline();
    const payments = await paymentsByDescription();

    for (const blinkit of payments.get('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD') ?? []) {
      expect(blinkit).toMatchObject({ state: 'linked', counterpartyType: 'merchant' });
    }
    expect(payments.get('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD')?.[0]).toMatchObject({
      state: 'linked',
      counterpartyType: 'merchant',
    });
    expect(payments.get('ELECTRICITY BOARD BBPS BILLPAY')?.[0]).toMatchObject({
      state: 'linked',
      counterpartyType: 'merchant',
    });

    // The person-to-person transfer: resolved to a person only once the settlement was
    // accepted, because who it went to is a classification question (ADR-0022, ADR-0023).
    expect(payments.get('UPI-FRIENDA-TRANSFER')?.[0]).toMatchObject({
      state: 'linked',
      counterpartyType: 'person',
      counterpartyId: cast.person['person_friend_a'],
    });

    // Both legs of the transfer: excluded from spend by their type alone, terminal at
    // normalized, and never shown to a model.
    for (const description of [
      'NEFT TRANSFER TO SELF A/C X4821',
      'NEFT TRANSFER FROM SELF A/C X9013',
    ]) {
      expect(payments.get(description)?.[0]).toMatchObject({
        state: 'normalized',
        counterpartyType: 'internal_account',
        counterpartyId: null,
      });
    }

    // The refund credit: exactly as normalization left it (ADR-0027).
    expect(payments.get('ACH REFUND SAMPLE ELECTRONICS STORE')?.[0]).toMatchObject({
      state: 'normalized',
      counterpartyType: 'merchant',
      counterpartyId: merchant['merchant_sample_electronics'],
    });
  });

  it('produces four approved expenses and one settlement, and nothing else', async () => {
    await runPipeline();

    const expenses = await database.db
      .select({
        description: schema.expenses.description,
        amount: schema.expenses.amount,
        relationshipType: schema.expenses.relationshipType,
        state: schema.expenses.state,
        paidByPersonId: schema.expenses.paidByPersonId,
      })
      .from(schema.expenses);
    expect(expenses).toHaveLength(4);
    expect(expenses.every((expense) => expense.state === 'approved')).toBe(true);
    expect(expenses.every((expense) => expense.paidByPersonId === cast.userPersonId)).toBe(true);
    expect(expenses.reduce((total, expense) => total + expense.amount, 0n)).toBe(742_000n);
    expect([...expenses].map((expense) => expense.relationshipType).sort()).toEqual([
      'household_shared_flat',
      'personal',
      'personal',
      'shared',
    ]);

    const settlements = await database.db
      .select({
        counterpartyPersonId: schema.settlements.counterpartyPersonId,
        amount: schema.settlements.amount,
      })
      .from(schema.settlements);
    expect(settlements).toEqual([
      { counterpartyPersonId: cast.person['person_friend_a'], amount: 100_000n },
    ]);

    // Allocation is phase 12: an approved expense has no beneficiaries yet, and this phase
    // does not invent any.
    expect(await database.db.select().from(schema.allocations)).toEqual([]);
  });

  it('leaves every inference decided, each pointing at the one record it produced', async () => {
    await runPipeline();

    const inferences = await database.db
      .select({
        status: schema.aiInferences.status,
        decidedBy: schema.aiInferences.decidedBy,
        resultingRecordType: schema.aiInferences.resultingRecordType,
        resultingRecordId: schema.aiInferences.resultingRecordId,
      })
      .from(schema.aiInferences);

    expect(inferences).toHaveLength(5);
    expect(inferences.every((row) => row.status === 'accepted')).toBe(true);
    expect(inferences.every((row) => row.decidedBy === 'user')).toBe(true);
    expect(inferences.every((row) => row.resultingRecordId !== null)).toBe(true);
    expect(inferences.filter((row) => row.resultingRecordType === 'expense')).toHaveLength(4);
    expect(inferences.filter((row) => row.resultingRecordType === 'settlement')).toHaveLength(1);
  });

  it('accounts for every rupee that left the account', async () => {
    await runPipeline();

    const { totals } = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
      splitwise: createMockSplitwisePort(),
      audit: AS_USER,
    });

    // ₹23,420 left the account across six debits. ₹15,000 of it was a transfer between the
    // user's own accounts, ₹1,000 discharged a debt, and ₹7,420 was spending.
    expect(totals).toEqual({
      ledgerTotalOutflow: 2_342_000n,
      ledgerTransfersTotal: 1_500_000n,
      ledgerInvestmentsTotal: 0n,
      ledgerSettlementsTotal: 100_000n,
      ledgerExplainedTotal: 742_000n,
      // Nothing is left over, and nothing had to be assumed to get there (invariants.md #20).
      ledgerUnexplainedTotal: 0n,
    });
  });

  it('shows a statement that has only been classified as still unexplained', async () => {
    // The same pipeline, stopping before review: proposals exist, nothing is approved, and
    // the ledger says so rather than counting a proposal as spending.
    await importBankStatementCsv(database.db, {
      accountId,
      sourceSystem: 'synthetic_bank_csv',
      fileContent: FIXTURE,
      fileReference: 'fixtures/bank-statement.csv',
      audit: AS_USER,
    });
    await normalizePayments(database.db, { audit: AS_USER });
    await classifyPayments(database.db, {
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      audit: AS_SYSTEM,
    });

    const { totals } = await runReconciliation(database.db, {
      userPersonId: cast.userPersonId,
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
      splitwise: createMockSplitwisePort(),
      audit: AS_USER,
    });

    expect(totals).toMatchObject({
      ledgerTotalOutflow: 2_342_000n,
      // The transfer is deterministic, so it is excluded whether or not anyone reviewed it.
      ledgerTransfersTotal: 1_500_000n,
      ledgerSettlementsTotal: 0n,
      ledgerExplainedTotal: 0n,
      ledgerUnexplainedTotal: 842_000n,
    });
  });

  it('is re-runnable end to end without producing a second of anything', async () => {
    await runPipeline();

    await normalizePayments(database.db, { audit: AS_USER });
    const second = await classifyPayments(database.db, {
      ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
      audit: AS_SYSTEM,
    });

    // Every payment is either explained or terminal, so the only rows still offered are the
    // two transfer legs and the credit — each skipped with its reason.
    expect(second.outcomes.every((outcome) => outcome.outcome === 'skipped')).toBe(true);
    expect(await database.db.select().from(schema.aiInferences)).toHaveLength(5);
    expect(await database.db.select().from(schema.expenses)).toHaveLength(4);
    expect(await database.db.select().from(schema.settlements)).toHaveLength(1);
    expect(await database.db.select().from(schema.paymentExpenseLinks)).toHaveLength(4);
  });

  it('keeps the whole trail: source rows untouched, every step audited', async () => {
    await runPipeline();

    const payments = await paymentsByDescription();
    const zomato = payments.get('UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD')?.[0];
    // SOURCE data still says exactly what the bank said.
    expect(zomato).toMatchObject({ amount: 284_000n, direction: 'debit' });

    const events = await database.db
      .select({
        entityType: schema.auditEvents.entityType,
        action: schema.auditEvents.action,
        actor: schema.auditEvents.actor,
      })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, zomato!.id));
    // imported → normalized → linked, each recorded, none inferred from a flag.
    expect(events.map((event) => event.action)).toEqual(['create', 'update', 'update']);

    // No audit event anywhere claims the model as its actor: a proposal is evidence of what a
    // model said, never an act it performed (ai-boundary.md).
    const actors = await database.db
      .select({ actor: schema.auditEvents.actor })
      .from(schema.auditEvents);
    expect(new Set(actors.map((row) => row.actor))).toEqual(new Set(['user', 'system']));
  });
});
