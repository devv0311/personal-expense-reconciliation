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

import { createAiService } from '../src/ai/index.js';
import type { ModelTransport } from '../src/ai/index.js';
import { createPgliteDatabase, createPostgresDatabase, schema } from '../src/db/index.js';
import { asId, paise } from '../src/domain/index.js';
import type { SplitwiseFriendBalance, SplitwisePort } from '../src/integrations/splitwise/index.js';
import {
  approveAllocation,
  classifyPayment,
  connectSplitwiseIntegration,
  discoverSplitwiseRemoteChanges,
  matchEvidenceContext,
  recordEvidenceNotification,
  recordExpenseAdjustment,
  recordExpenseItems,
  recordSettlement,
  runSplitwiseAudit,
  requireUserPersonId,
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

  /* ------------------------------------------------- phase 21: one scenario per pillar */

  // A statement page, so the reconciliation form has real evidence to cite for a boundary
  // balance. Everything about it is synthetic (`fixtures/README.md`).
  const [statement] = await db
    .insert(schema.evidence)
    .values({
      type: 'bank_line',
      rawText: 'HDFC Savings — statement for August 2026. Opening 50,000.00, closing 30,960.00.',
      capturedAt: new Date('2026-09-01T00:00:00.000Z'),
    })
    .returning({ id: schema.evidence.id });

  // Pillar 2 — an itemised purchase with a partial, item-attributed refund that has been
  // recorded but NOT distributed. That is the state ADR-0018 cares most about: a pending
  // adjustment is visible, and the obligations below it are not presented as current.
  const groceriesExpenseId = await linkedExpense({
    description: 'Blinkit — weekly groceries',
    amount: 2_150_00n,
    occurredAt: '2026-08-11T19:20:00.000Z',
    relationshipType: 'shared',
    rawDescription: 'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
  });
  const { items } = await recordExpenseItems(db, {
    expenseId: asId<'expense'>(groceriesExpenseId),
    items: [
      { description: 'Cold-pressed olive oil (returned)', amount: paise(650_00n) },
      { description: 'Coffee beans, 1kg', amount: paise(900_00n) },
      { description: 'Household staples', amount: paise(520_00n) },
      { description: 'Delivery and handling', amount: paise(80_00n) },
    ],
    audit: AS_SEED,
  });
  await approveAllocation(db, {
    expenseId: asId<'expense'>(groceriesExpenseId),
    decision: {
      method: 'item_based',
      lines: [
        { beneficiary: { type: 'person', id: devPersonId }, expenseItemId: items[0]!.id },
        { beneficiary: { type: 'person', id: alexId }, expenseItemId: items[1]!.id },
        { beneficiary: { type: 'person', id: devPersonId }, expenseItemId: items[2]!.id },
        { beneficiary: { type: 'person', id: devPersonId }, expenseItemId: items[3]!.id },
      ],
    },
    decidedBy: 'manual',
    audit: AS_SEED,
  });
  const refundPaymentId = await payment({
    amount: 650_00n,
    direction: 'credit',
    occurredAt: '2026-08-14T09:05:00.000Z',
    rawDescription: 'UPI-BLINKIT9821PAYTM-REFUND',
    channel: 'upi',
    counterpartyType: 'merchant',
  });
  await recordExpenseAdjustment(db, {
    expenseId: asId<'expense'>(groceriesExpenseId),
    kind: 'merchant_refund',
    amount: paise(650_00n),
    occurredAt: new Date('2026-08-14T09:05:00.000Z'),
    adjustmentPaymentId: asId<'payment'>(refundPaymentId),
    itemAttributions: [{ expenseItemId: items[0]!.id, amount: paise(650_00n) }],
    audit: AS_SEED,
  });

  // Pillar 1 — a UPI push notification nobody has attached yet, and the candidates the matcher
  // records for it. Nothing is linked: accepting a candidate stays an explicit human act.
  const notification = await recordEvidenceNotification(db, {
    type: 'upi_notification',
    text: 'Rs.640.00 debited from A/c XX4821 on 08-Aug-26 to PEPPERMILL CAFE. UPI Ref 884120993741.',
    capturedAt: new Date('2026-08-08T11:31:00.000Z'),
    audit: AS_SEED,
  });
  await matchEvidenceContext(db, { evidenceId: notification.evidenceId, audit: AS_SEED });

  // Pillar 1 again, from the other side — a bank SMS attached to the dinner payment, so one
  // payment's re-attached context has something to show.
  const dinnerNotification = await recordEvidenceNotification(db, {
    type: 'bank_line',
    text: 'Rs.3200.00 debited from A/c XX4821 on 05-Aug-26 to PEPPERMILL RESTAURANT. Ref 771204885512.',
    capturedAt: new Date('2026-08-05T20:16:00.000Z'),
    audit: AS_SEED,
  });
  await matchEvidenceContext(db, { evidenceId: dinnerNotification.evidenceId, audit: AS_SEED });

  // A pending classification, so the review queue has a decision waiting. The model is a
  // scripted transport defined in this file — no provider is wired anywhere (ADR-0025).
  const unclassifiedPaymentId = await payment({
    amount: 1_240_00n,
    direction: 'debit',
    occurredAt: '2026-08-19T13:10:00.000Z',
    rawDescription: 'UPI-ZOMATO4471-SAMPLE RESTAURANT PVT LTD',
    channel: 'upi',
    counterpartyType: 'merchant',
  });
  await classifyPayment(db, {
    paymentId: asId<'payment'>(unclassifiedPaymentId),
    ai: createAiService(seedTransport()),
    audit: AS_SEED,
  });

  // Pillar 4 — one audit against a scripted Splitwise that disagrees with this ledger, so the
  // findings screen has a real disagreement, a real balance impact, and an honest read status.
  // No network call is made and no real account is involved.
  await runSplitwiseAudit(db, {
    userPersonId: await requireUserPersonId(db),
    splitwise: seedSplitwisePort([
      { splitwiseUserId: 'sw-alex-seed', netBalance: paise(-2_000_00n) },
    ]),
    audit: AS_SEED,
  });

  // The other direction of travel (ADR-0056) — one discovery run against a scripted Splitwise
  // that holds an entry this ledger has no link for and a friend nobody is mapped to, so the
  // change-review screen has a real adoption and a real mapping to decide about. Still no
  // network call, still no write to Splitwise: discovery only reads.
  await discoverSplitwiseRemoteChanges(db, {
    userPersonId: await requireUserPersonId(db),
    splitwise: seedDiscoveryPort(),
    audit: AS_SEED,
  });

  console.log('Seeded a synthetic scenario covering all six pillars:');
  console.log('  3 people, 1 account, 5 expenses, 1 settlement, 1 connected integration');
  console.log('  1 itemised expense with a recorded, undistributed item refund');
  console.log('  2 evidence notifications with recorded (unaccepted) match candidates');
  console.log('  1 pending classification decision, 1 Splitwise audit with findings');
  console.log('  1 Splitwise change-discovery run with an adoption and a mapping to decide');
  console.log(`  1 statement page to cite as boundary evidence: ${statement!.id}`);
  await database.close();
}

/**
 * The scripted model this seed classifies against.
 *
 * The same shape `tests/support/ai.ts` uses and for the same reason: no provider is wired
 * (ADR-0025), and a seeded review queue needs a proposal to have a decision about. It answers
 * one redacted description and declines everything else, so it can never quietly classify
 * something this script did not intend.
 */
function seedTransport(): ModelTransport {
  return {
    modelInfo: { provider: 'synthetic', model: 'seed-classifier-v1' },
    complete: () =>
      Promise.resolve({
        confidence: 'medium',
        proposedOutput: {
          proposedKind: 'expense',
          relationshipType: 'shared',
          category: 'dining',
        },
      }),
  };
}

/**
 * A scripted `SplitwisePort` that reports balances and supports no finer read.
 *
 * `fetchLedgerEntries` is deliberately absent: the port's per-entry read is optional
 * (ADR-0046), so leaving it off is how an adapter without that capability is represented — and
 * it makes the audit report an honestly `unsupported` external read rather than a clean one.
 */
function seedSplitwisePort(balances: readonly SplitwiseFriendBalance[]): SplitwisePort {
  return {
    createExpense: () => Promise.reject(new Error('The seed script never writes to Splitwise.')),
    recordPayment: () => Promise.reject(new Error('The seed script never writes to Splitwise.')),
    fetchBalances: () => Promise.resolve(balances),
  };
}

/**
 * A scripted `SplitwisePort` for change discovery (ADR-0056), with the finer read implemented.
 *
 * Unlike {@link seedSplitwisePort} this one *can* list a pair's entries, because discovery has
 * nothing to compare without them. It still writes nothing: `createExpense`/`recordPayment`
 * refuse exactly as above, and discovery never calls them.
 *
 * What it reports is chosen so the review screen has both shapes to show — an entry this
 * ledger has no link for (an adoption a person decides about) and a friend nobody is mapped to
 * (a mapping). Neither proposes a figure.
 */
function seedDiscoveryPort(): SplitwisePort {
  return {
    createExpense: () => Promise.reject(new Error('The seed script never writes to Splitwise.')),
    recordPayment: () => Promise.reject(new Error('The seed script never writes to Splitwise.')),
    fetchBalances: () =>
      Promise.resolve([
        { splitwiseUserId: 'sw-alex-seed', netBalance: paise(-2_000_00n) },
        // A Splitwise friend this ledger has never mapped to a Person.
        { splitwiseUserId: 'sw-unmapped-seed', netBalance: paise(45_000n) },
      ]),
    fetchLedgerEntries: () =>
      Promise.resolve({
        complete: true,
        entries: [
          {
            splitwiseEntryId: 'sw-seed-entry-unlinked',
            kind: 'expense',
            description: 'Cab back from the airport',
            totalAmount: paise(64_000n),
            currency: 'INR',
            deleted: false,
            occurredAt: new Date('2026-08-24T22:10:00.000Z'),
            pairNetBalance: paise(-32_000n),
          },
        ],
      }),
  };
}

main().catch((error: unknown) => {
  console.error('Seeding failed:', error);
  process.exitCode = 1;
});
