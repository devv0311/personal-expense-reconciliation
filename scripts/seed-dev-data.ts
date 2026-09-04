/**
 * Seeds a believable, entirely synthetic scenario into a development database, so `web/` has
 * something real to show without connecting any real account (`docs/roadmap.md` phase 15).
 *
 * Everything financially consequential here goes through the real `src/services` functions
 * (`approveAllocation`, `recordSettlement`, `connectSplitwiseIntegration`) — this script is a
 * caller of the ledger, exactly like a human clicking through the UI would be, never a second
 * implementation of allocation or balance arithmetic. Only SOURCE-level rows (`payments`,
 * `import_batches`, the cast of `people`/`accounts`) are inserted directly, mirroring how
 * `tests/support/ledger.ts` sets up a scenario's *starting* state.
 *
 * Idempotent: does nothing if a `User` already exists, so re-running (or running against a
 * database that already has real data) is always safe.
 *
 * Run with `npx tsx scripts/seed-dev-data.ts`. Uses `DATABASE_URL`/`PGLITE_DATA_DIR` exactly the
 * way `src/server.ts` does, so run this against the same environment (or none — both default to
 * the same on-disk `./local-data/pglite-dev`) and the two processes see the same database.
 */

import { eq } from 'drizzle-orm';

import { createPgliteDatabase, createPostgresDatabase, schema } from '../src/db/index.js';
import { asId, paise } from '../src/domain/index.js';
import {
  approveAllocation,
  connectSplitwiseIntegration,
  recordSettlement,
} from '../src/services/index.js';

const AS_SEED = { actor: 'system', source: 'scripts/seed-dev-data' } as const;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  const database =
    connectionString !== undefined && connectionString !== ''
      ? await createPostgresDatabase(connectionString)
      : await createPgliteDatabase(process.env.PGLITE_DATA_DIR ?? './local-data/pglite-dev');
  await database.migrate();
  const db = database.db;

  const [existingUser] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (existingUser !== undefined) {
    console.log('A User already exists — nothing to seed. Delete the data first to re-seed.');
    await database.close();
    return;
  }

  console.log('Seeding a synthetic development scenario...');

  const [devPerson] = await db
    .insert(schema.people)
    .values({ displayName: 'Dev', splitwiseUserId: 'sw-dev-seed' })
    .returning({ id: schema.people.id });
  const [alex] = await db
    .insert(schema.people)
    .values({ displayName: 'Alex', splitwiseUserId: 'sw-alex-seed' })
    .returning({ id: schema.people.id });
  const [sam] = await db
    .insert(schema.people)
    .values({ displayName: 'Sam' })
    .returning({ id: schema.people.id });

  const devPersonId = asId<'person'>(devPerson!.id);
  const alexId = asId<'person'>(alex!.id);
  const samId = asId<'person'>(sam!.id);

  const [user] = await db
    .insert(schema.users)
    .values({ email: 'dev@example.test', personId: devPersonId })
    .returning({ id: schema.users.id });

  const [account] = await db
    .insert(schema.accounts)
    .values({ ownerUserId: user!.id, name: 'HDFC Savings', type: 'bank', last4: '4821' })
    .returning({ id: schema.accounts.id });

  const [importBatch] = await db
    .insert(schema.importBatches)
    .values({ sourceChannel: 'dev_seed', rowCount: 5 })
    .returning({ id: schema.importBatches.id });

  async function payment(spec: {
    amount: bigint;
    direction: 'debit' | 'credit';
    occurredAt: string;
    rawDescription: string;
    channel: string;
    counterpartyType?: string;
    state?: string;
  }): Promise<string> {
    const [row] = await db
      .insert(schema.payments)
      .values({
        accountId: account!.id,
        importBatchId: importBatch!.id,
        amount: paise(spec.amount),
        direction: spec.direction,
        occurredAt: new Date(spec.occurredAt),
        rawDescription: spec.rawDescription,
        channel: spec.channel,
        counterpartyType: spec.counterpartyType ?? 'unknown',
        state: spec.state ?? 'normalized',
      })
      .returning({ id: schema.payments.id });
    return row!.id;
  }

  /**
   * A self-funded expense with a real `Payment` behind it, fully linked
   * (`PaymentExpenseLink`, `payments.state = 'linked'`) — the shape `services.decideInference`
   * produces for a real classification, not a bare `Expense` row a real pipeline never leaves
   * behind. Skipping the backing payment would make `ledger_total_outflow` and
   * `ledger_explained_total` disagree by construction, which invariant #20 correctly reports as
   * a negative `ledger_unexplained_total` — a real integrity signal, not something this seed
   * data should be triggering by omission.
   */
  async function linkedExpense(spec: {
    description: string;
    amount: bigint;
    occurredAt: string;
    relationshipType: string;
    rawDescription: string;
  }): Promise<string> {
    const paymentId = await payment({
      amount: spec.amount,
      direction: 'debit',
      occurredAt: spec.occurredAt,
      rawDescription: spec.rawDescription,
      channel: 'upi',
      counterpartyType: 'merchant',
    });
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        description: spec.description,
        amount: paise(spec.amount),
        occurredAt: new Date(spec.occurredAt),
        relationshipType: spec.relationshipType,
        paidByPersonId: devPersonId,
        state: 'approved',
      })
      .returning({ id: schema.expenses.id });
    await db.insert(schema.paymentExpenseLinks).values({
      paymentId,
      expenseId: expense!.id,
      amount: paise(spec.amount),
    });
    await db
      .update(schema.payments)
      .set({ state: 'linked' })
      .where(eq(schema.payments.id, paymentId));
    return expense!.id;
  }

  // A shared dinner — the ledger's main "here's a real, allocated expense" example.
  const dinnerExpenseId = await linkedExpense({
    description: 'Dinner at Peppermill',
    amount: 3_200_00n,
    occurredAt: '2026-08-05T20:15:00.000Z',
    relationshipType: 'shared',
    rawDescription: 'UPI-PEPPERMILL-RESTAURANT',
  });
  await approveAllocation(db, {
    expenseId: asId<'expense'>(dinnerExpenseId),
    decision: {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: devPersonId },
        { type: 'person', id: alexId },
      ],
    },
    decidedBy: 'manual',
    audit: AS_SEED,
  });

  // A transfer to the user's own account — excluded from spend, shows the transfers bucket.
  await payment({
    amount: 15_000_00n,
    direction: 'debit',
    occurredAt: '2026-08-03T09:00:00.000Z',
    rawDescription: 'NEFT-OWN-FD-ACCOUNT',
    channel: 'bank_transfer',
    counterpartyType: 'internal_account',
  });

  // A personal purchase, linked but not yet allocated — shows the ledger's "still needs
  // attention" state (allocation is trivial for a personal expense, but nothing has done it yet).
  await linkedExpense({
    description: 'Amazon — desk lamp',
    amount: 1_800_00n,
    occurredAt: '2026-08-07T14:00:00.000Z',
    relationshipType: 'personal',
    rawDescription: 'UPI-AMAZON-PAY-INDIA',
  });

  // A payment nothing has explained yet — the reconciliation dashboard's headline number.
  await payment({
    amount: 640_00n,
    direction: 'debit',
    occurredAt: '2026-08-08T11:30:00.000Z',
    rawDescription: 'UPI-UNKNOWN-MERCHANT-8841',
    channel: 'upi',
  });

  // A flatmate's obligation to the user, with no Splitwise involvement at all — shows a second
  // balance pair.
  const samExpenseId = await linkedExpense({
    description: 'Electricity bill',
    amount: 2_400_00n,
    occurredAt: '2026-08-02T10:00:00.000Z',
    relationshipType: 'household_shared_flat',
    rawDescription: 'UPI-BESCOM-ELECTRICITY',
  });
  await approveAllocation(db, {
    expenseId: asId<'expense'>(samExpenseId),
    decision: {
      method: 'equal',
      beneficiaries: [
        { type: 'person', id: devPersonId },
        { type: 'person', id: samId },
      ],
    },
    decidedBy: 'manual',
    audit: AS_SEED,
  });

  // Alex paying part of it back — a real, recorded Settlement.
  const settlementPaymentId = await payment({
    amount: 1_600_00n,
    direction: 'credit',
    occurredAt: '2026-08-06T18:00:00.000Z',
    rawDescription: 'UPI-ALEX-TRANSFER',
    channel: 'upi',
    counterpartyType: 'person',
  });
  await recordSettlement(db, {
    paymentId: asId<'payment'>(settlementPaymentId),
    counterpartyPersonId: alexId,
    amount: paise(1_600_00n),
    audit: AS_SEED,
  });

  // A connected Splitwise integration (no real account — CLAUDE.md forbids one in development).
  // Reconciliation will still run in full against the ledger-internal totals; the balance-drift
  // comparison surfaces as a `splitwise_fetch_failed` discrepancy, since src/server.ts's
  // Splitwise port is deliberately unconfigured (ADR-0041, ADR-0042) — a real, honest state to
  // verify in the UI, not a gap in the seed data.
  await connectSplitwiseIntegration(db, { externalAccountRef: 'dev-seed-sandbox' });

  console.log('Seeded: 3 people, 1 account, 3 expenses (1 allocated+shared, 1 unallocated');
  console.log('personal, 1 allocated+household), 1 settlement, 1 connected integration.');
  await database.close();
}

main().catch((error: unknown) => {
  console.error('Seeding failed:', error);
  process.exitCode = 1;
});
