/**
 * Every act that counts a payment takes its locks in one global order (ADR-0071).
 *
 * The count guard serialises competing decisions with locks. Two transactions that each hold
 * one lock and then ask for the other's cannot both proceed: PostgreSQL aborts one with
 * `40P01 deadlock_detected`. That is not the guard doing its job — the intended refusal is
 * `PRECONDITION_FAILED` with a plain-language reason — so every test here asserts the *kind*
 * of failure as well as the business outcome, and none of them retries.
 *
 * **Why the interleavings are forced, not raced.** A `Promise.allSettled` of two approvals
 * usually lets one finish before the other begins, which proves nothing about lock order. Here
 * a gate sits after the first lock each transaction acquires. The first transaction is paused
 * there holding what it holds; the second is started; the gate opens only once the second has
 * either reached the same point (the locks are *not* mutually exclusive — the unsafe shape) or
 * is seen waiting on a lock in `pg_stat_activity` (the locks *are* exclusive and it is queued).
 * Opening it then lets both continue to ask for everything else they need. Under the unsafe
 * design that is a deadlock; under the safe one the second simply waits its turn.
 *
 * PGlite has one connection and serialises everything, so these only run against a real
 * server (`TEST_DATABASE_URL`) and skip otherwise; the in-process suite in
 * `duplicate-count-guard.test.ts` covers the business rules on both.
 *
 * Every payment is synthetic.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { paise } from '../../src/domain/index.js';
import type { AccountId, PaymentId } from '../../src/domain/index.js';
import { listPendingClassificationInferences, schema } from '../../src/db/index.js';
import {
  classifyPayments,
  confirmPossibleDuplicate,
  createExpense,
  decideInference,
  recordSettlement,
} from '../../src/services/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase, query } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { AS_USER, addImportBatch, addPayment, seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { sql } from 'drizzle-orm';

/* ------------------------------------------------------------------------------ the gate */

const gate = vi.hoisted(() => {
  const state = {
    enabled: false,
    arrived: 0,
    seen: new WeakSet<object>(),
    held: [] as Array<() => void>,
  };
  return state;
});

vi.mock('../../src/db/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  type LockFn = (exec: object, ...rest: never[]) => Promise<unknown>;
  const gated =
    (lock: LockFn): LockFn =>
    async (exec, ...rest) => {
      const result = await lock(exec, ...rest);
      if (gate.enabled && !gate.seen.has(exec)) {
        gate.seen.add(exec);
        gate.arrived += 1;
        await new Promise<void>((resolve) => gate.held.push(resolve));
      }
      return result;
    };
  const lockers = actual as Record<string, LockFn | undefined>;
  const wrapped: Record<string, LockFn> = {};
  // Whichever function takes a transaction's first lock on a payment, old design or new.
  for (const name of ['lockPaymentsForDecision', 'lockPaymentClasses']) {
    const original = lockers[name];
    if (original !== undefined) wrapped[name] = gated(original);
  }
  return { ...actual, ...wrapped };
});

function closeGate(): void {
  gate.enabled = false;
  const waiting = gate.held.splice(0);
  for (const resolve of waiting) resolve();
}

function armGate(): void {
  gate.enabled = true;
  gate.arrived = 0;
  gate.seen = new WeakSet();
  gate.held = [];
}

const AS_REVIEWER = { actor: 'user', source: 'tests/duplicate-lock-order' } as const;
const AS_SYSTEM = { actor: 'system', source: 'services.classifyPayments' } as const;

let database: TestDatabase;
let cast: Cast;
let accountId: AccountId;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  closeGate();
  await database?.close();
});

beforeEach(async () => {
  closeGate();
  await database.truncateAll();
  cast = await seedCast(database.db);
  accountId = cast.account['account_hdfc_savings']!;
});

/* ----------------------------------------------------------------------------- helpers */

/** Postgres error codes found anywhere in an error's cause chain. */
function sqlStates(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) codes.push(code);
    current = current.cause;
  }
  return codes;
}

const DEADLOCK = '40P01';

/** Fails a test with the database's own words if a transaction was aborted by the engine. */
function expectNoEngineAbort(results: readonly PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status === 'rejected') {
      expect(sqlStates(result.reason)).toEqual([]);
      expect((result.reason as { code?: unknown }).code).not.toBe(DEADLOCK);
    }
  }
}

async function waitingBackends(): Promise<number> {
  const rows = await query<{ n: string }>(
    database.db,
    sql`select count(*)::text as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Starts `first`, waits until it is paused holding its first lock, starts `second`, waits
 * (bounded) until `second` has either joined it at the gate or is queued behind a lock, then
 * opens the gate. Returns both outcomes, never rejecting.
 */
async function interleave(
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> {
  armGate();
  const one = first();
  await until(() => gate.arrived >= 1, 'the first transaction never reached the gate');
  const two = second();
  await until(
    async () => gate.arrived >= 2 || (await waitingBackends()) >= 1,
    'the second transaction neither reached the gate nor queued behind a lock',
  );
  closeGate();
  const settled = await Promise.race([
    Promise.allSettled([one, two]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('the transactions did not finish in 20s')), 20_000),
    ),
  ]);
  return settled;
}

async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function copies(count: number, amount = paise(300_000n)): Promise<PaymentId[]> {
  const ids: PaymentId[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(
      await addPayment(database.db, cast, {
        accountId,
        amount,
        direction: 'debit',
        occurredAt: new Date('2026-08-03T00:00:00Z'),
        rawDescription: 'UPI-QA CAFE DINNER',
        channel: 'upi',
        state: 'normalized',
        importBatchId: await addImportBatch(database.db),
      }),
    );
  }
  return ids;
}

async function propose(): Promise<Map<string, string>> {
  await classifyPayments(database.db, {
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    deterministicOnly: true,
    audit: AS_SYSTEM,
  });
  const pending = await listPendingClassificationInferences(database.db);
  return new Map(pending.map((row) => [row.paymentId as string, row.inferenceId as string]));
}

function approve(inferenceId: string) {
  return decideInference(database.db, {
    inferenceId: inferenceId as never,
    decision: 'accept',
    audit: AS_REVIEWER,
  });
}

async function count(table: 'expenses' | 'payment_expense_links' | 'settlements' | 'audit_events') {
  const rows = await query<{ n: string }>(
    database.db,
    sql`select count(*)::text as n from ${sql.raw(table)}`,
  );
  return Number(rows[0]?.n);
}

async function approvedCount(): Promise<number> {
  const rows = await database.db
    .select({ id: schema.expenses.id })
    .from(schema.expenses)
    .where(eq(schema.expenses.state, 'approved'));
  return rows.length;
}

async function auditEventsFor(entityId: string): Promise<number> {
  const rows = await database.db
    .select({ id: schema.auditEvents.id })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityId, entityId));
  return rows.length;
}

/**
 * How many acts took effect and how many were refused **by the ledger** — a typed refusal with
 * one of `codes`, never an engine abort (those are caught by {@link expectNoEngineAbort}).
 */
function outcomes(
  results: readonly PromiseSettledResult<unknown>[],
  codes: readonly string[] = ['PRECONDITION_FAILED'],
) {
  return {
    won: results.filter((result) => result.status === 'fulfilled').length,
    refused: results.filter(
      (result) =>
        result.status === 'rejected' &&
        codes.includes((result.reason as { code?: string }).code ?? ''),
    ).length,
  };
}

/* ------------------------------------------------------------------------------- tests */

describe('competing counting acts never deadlock, and the loser is refused for the right reason', () => {
  it('opposite-side approvals of one pair: one counts, the other is refused as an unresolved duplicate', async (ctx) => {
    if (database.driver !== 'postgres') return ctx.skip();
    const [one, two] = await copies(2);
    const proposals = await propose();

    const results = await interleave(
      () => approve(proposals.get(one!)!),
      () => approve(proposals.get(two!)!),
    );

    expectNoEngineAbort(results);
    expect(outcomes(results)).toEqual({ won: 1, refused: 1 });
    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({
      code: 'PRECONDITION_FAILED',
      details: { reason: 'unresolved_possible_duplicate' },
    });

    // The business outcome, and no half-written loser.
    expect(await approvedCount()).toBe(1);
    expect(await count('payment_expense_links')).toBe(1);
    const loserPayment = results[0].status === 'rejected' ? one! : two!;
    expect(await auditEventsFor(loserPayment)).toBe(0);
    const [row] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.id, loserPayment));
    expect(row?.state).toBe('normalized');
  });

  it('three same-amount copies: two simultaneous approvals still count exactly one', async (ctx) => {
    if (database.driver !== 'postgres') return ctx.skip();
    const [a, , c] = await copies(3);
    const proposals = await propose();

    const results = await interleave(
      () => approve(proposals.get(a!)!),
      () => approve(proposals.get(c!)!),
    );

    expectNoEngineAbort(results);
    expect(outcomes(results)).toEqual({ won: 1, refused: 1 });
    expect(await approvedCount()).toBe(1);
  });

  it('confirm versus approve of the same copy: exactly one of them takes effect', async (ctx) => {
    if (database.driver !== 'postgres') return ctx.skip();
    const [one, two] = await copies(2);
    const proposals = await propose();
    // The copy approved is the one with the greater id and the pair is confirmed from the
    // other side, so the two transactions would take their row locks in opposite directions
    // under any design that locks a payment and then discovers its twin.
    const [low, high] = [one!, two!].sort();

    const results = await interleave(
      () => approve(proposals.get(high!)!),
      () =>
        confirmPossibleDuplicate(database.db, {
          paymentId: high!,
          duplicateOfPaymentId: low!,
          audit: AS_REVIEWER,
        }),
    );

    expectNoEngineAbort(results);
    expect(outcomes(results, ['PRECONDITION_FAILED', 'INVALID_STATE_TRANSITION'])).toEqual({
      won: 1,
      refused: 1,
    });
    // Either the approval stands and the confirm refused to discard a counted payment, or the
    // confirmation stands and the approval refused a discarded one — never both, never neither.
    const [row] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.id, high!));
    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    if (row?.state === 'ignored') {
      expect(await approvedCount()).toBe(0);
      expect(loser.reason).toMatchObject({
        code: 'PRECONDITION_FAILED',
        details: { reason: 'discarded_duplicate' },
      });
    } else {
      expect(row?.state).toBe('linked');
      expect(await approvedCount()).toBe(1);
      expect(loser.reason).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    }
  });

  it('confirm versus approve of the other copy: both stand, because the survivor is what counts', async (ctx) => {
    if (database.driver !== 'postgres') return ctx.skip();
    const [one, two] = await copies(2);
    const proposals = await propose();
    const [low, high] = [one!, two!].sort();

    // Approve the higher id; discard the lower. Opposite lock directions, compatible outcomes.
    const results = await interleave(
      () => approve(proposals.get(high!)!),
      () =>
        confirmPossibleDuplicate(database.db, {
          paymentId: low!,
          duplicateOfPaymentId: high!,
          audit: AS_REVIEWER,
        }),
    );

    expectNoEngineAbort(results);
    expect(outcomes(results)).toEqual({ won: 2, refused: 0 });
    expect(await approvedCount()).toBe(1);
    const [row] = await database.db
      .select({ state: schema.payments.state })
      .from(schema.payments)
      .where(eq(schema.payments.id, low!));
    expect(row?.state).toBe('ignored');
  });

  it('a settlement against one copy and an approval of the other: one counts', async (ctx) => {
    if (database.driver !== 'postgres') return ctx.skip();
    const [one, two] = await copies(2);
    const proposals = await propose();

    const results = await interleave(
      () =>
        recordSettlement(database.db, {
          paymentId: one!,
          counterpartyPersonId: cast.person['person_flatmate_a']!,
          amount: paise(300_000n),
          audit: AS_USER,
        }),
      () => approve(proposals.get(two!)!),
    );

    expectNoEngineAbort(results);
    expect(outcomes(results)).toEqual({ won: 1, refused: 1 });
    expect((await approvedCount()) + (await count('settlements'))).toBe(1);
  });

  it('funding two payments in opposite orders: one expense wins both, the other leaves nothing behind', async (ctx) => {
    if (database.driver !== 'postgres') return ctx.skip();
    const [rent] = await copies(1, paise(500_000n));
    const [power] = await copies(1, paise(120_000n));
    const fund = (order: readonly PaymentId[], description: string) =>
      createExpense(database.db, {
        description,
        amount: paise(620_000n),
        occurredAt: new Date('2026-08-03T00:00:00Z'),
        relationshipType: 'household_shared_flat',
        paidByPersonId: cast.userPersonId,
        funding: order.map((paymentId) => ({
          paymentId,
          amount: paymentId === rent ? paise(500_000n) : paise(120_000n),
        })),
        audit: AS_USER,
      });

    const results = await interleave(
      () => fund([rent!, power!], 'Flat bills A'),
      () => fund([power!, rent!], 'Flat bills B'),
    );

    expectNoEngineAbort(results);
    // The loser finds both payments already fully explained: the ledger's own budget refusal.
    expect(outcomes(results, ['PAYMENT_BUDGET_EXCEEDED'])).toEqual({ won: 1, refused: 1 });

    // One expense with both links; the loser's expense, links and audit events rolled back.
    expect(await count('expenses')).toBe(1);
    expect(await count('payment_expense_links')).toBe(2);
    const expenseAudit = await database.db
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, 'expense'));
    expect(expenseAudit).toHaveLength(1);
  });

  it('a payment arriving while a decision is in flight is never blocked, and never counts', async (ctx) => {
    if (database.driver !== 'postgres') return ctx.skip();
    const [one, two] = await copies(2);
    const proposals = await propose();

    armGate();
    const decision = approve(proposals.get(one!)!);
    await until(() => gate.arrived >= 1, 'the decision never reached the gate');

    // An import lands a third copy while the decision holds its locks: it must not wait.
    const [late] = await copies(1);
    expect(late).toBeDefined();
    closeGate();
    await decision;

    expect(await approvedCount()).toBe(1);
    // Both the earlier uncounted copy and the late one are twins of a counted payment, so the
    // question is asked about each and neither can be counted until it is answered.
    const lateProposal = await propose();
    for (const id of [two!, late!]) {
      await expect(approve(lateProposal.get(id)!)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        details: { reason: 'unresolved_possible_duplicate' },
      });
    }
    expect(await approvedCount()).toBe(1);
  });
});
