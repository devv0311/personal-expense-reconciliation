/**
 * Seeding and shorthand for the scenario suite.
 *
 * Everything here is synthetic, loaded from `fixtures/people-and-groups.json` — the same
 * cast (Dev, Flatmate A–D, Friend A/B, the Flat, the Goa Trip) every fixture uses, so the
 * scenarios read as recognisable stories rather than abstract ids.
 *
 * These helpers write rows directly. They deliberately do **not** go through
 * `src/services`: a scenario's *setup* is "here is what the importer already produced",
 * while the behaviour under test is what the services then do with it. Anything a service
 * owns — approving an allocation, recording a settlement, distributing an adjustment — is
 * called through the service in the test itself, never shortcut here.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';

import { asId, merchantAliasKey, validateEvidenceNoteKind } from '../../src/domain/index.js';
import type {
  AccountId,
  EvidenceNoteKind,
  ExpenseId,
  ExpenseItemId,
  ExpenseOccasionId,
  ExpenseRelationshipType,
  ExpenseState,
  GroupId,
  ImportBatchId,
  MerchantId,
  Paise,
  PaymentChannel,
  PaymentCounterpartyType,
  PaymentDirection,
  PaymentId,
  PaymentState,
  PersonId,
  UserId,
} from '../../src/domain/index.js';
import { schema } from '../../src/db/index.js';
import type { Database } from '../../src/db/index.js';

import { loadMerchants, loadPeopleAndGroups } from './fixtures.js';

/** The seeded synthetic cast, keyed by the ids the fixtures use. */
export interface Cast {
  readonly userId: UserId;
  readonly userPersonId: PersonId;
  readonly person: Readonly<Record<string, PersonId>>;
  readonly group: Readonly<Record<string, GroupId>>;
  readonly account: Readonly<Record<string, AccountId>>;
  readonly importBatchId: ImportBatchId;
}

/** Inserts the whole synthetic cast, including the flat's membership timeline. */
export async function seedCast(db: Database): Promise<Cast> {
  const fixture = loadPeopleAndGroups();

  const person: Record<string, PersonId> = {};
  for (const entry of fixture.people) {
    const [row] = await db
      .insert(schema.people)
      .values({ displayName: entry.display_name, notes: entry.notes ?? null })
      .returning({ id: schema.people.id });
    person[entry.id] = asId<'person'>(row!.id);
  }

  const userPersonId = person['person_dev']!;
  const [userRow] = await db
    .insert(schema.users)
    .values({ email: 'dev@example.test', personId: userPersonId })
    .returning({ id: schema.users.id });
  const userId = asId<'user'>(userRow!.id);
  await db
    .update(schema.people)
    .set({ linkedUserId: userId })
    .where(eq(schema.people.id, userPersonId));

  const group: Record<string, GroupId> = {};
  for (const entry of fixture.groups) {
    const [row] = await db
      .insert(schema.groups)
      .values({ name: entry.name, type: entry.type })
      .returning({ id: schema.groups.id });
    group[entry.id] = asId<'group'>(row!.id);
  }

  for (const membership of fixture.group_memberships) {
    await db.insert(schema.groupMemberships).values({
      groupId: group[membership.group_id]!,
      personId: person[membership.person_id]!,
      joinedAt: new Date(membership.joined_at),
      leftAt: membership.left_at === null ? null : new Date(membership.left_at),
    });
  }

  const account: Record<string, AccountId> = {};
  for (const entry of fixture.accounts) {
    const [row] = await db
      .insert(schema.accounts)
      .values({
        ownerUserId: userId,
        name: entry.name,
        type: entry.type,
        institution: entry.institution ?? null,
        last4: entry.last4 ?? null,
      })
      .returning({ id: schema.accounts.id });
    account[entry.id] = asId<'account'>(row!.id);
  }

  const [batch] = await db
    .insert(schema.importBatches)
    .values({ sourceChannel: 'synthetic', parserVersion: 'scenario-suite' })
    .returning({ id: schema.importBatches.id });

  return {
    userId,
    userPersonId,
    person,
    group,
    account,
    importBatchId: asId<'import_batch'>(batch!.id),
  };
}

export interface PaymentSpec {
  /**
   * Forces the row's primary key.
   *
   * Only needed by a test whose subject is *ordering* between rows: `payments.id` is a random
   * UUID, so a test that depends on which of two equally-matching rows sorts first is
   * otherwise a coin toss rather than a test.
   */
  readonly id?: string;
  readonly accountId: AccountId;
  readonly amount: Paise;
  readonly direction: PaymentDirection;
  readonly occurredAt: Date;
  readonly rawDescription: string;
  readonly channel: PaymentChannel;
  readonly counterpartyType?: PaymentCounterpartyType;
  readonly counterpartyId?: string | null;
  readonly externalReference?: string | null;
  readonly referenceType?: string | null;
  readonly sourceSystem?: string | null;
  readonly state?: PaymentState;
  /** Paired with `state: 'ignored'`, e.g. `duplicate_of:<id>` or `out_of_scope`. */
  readonly ignoredReason?: string | null;
}

/** Inserts a payment as the importer would have. */
export async function addPayment(db: Database, cast: Cast, spec: PaymentSpec): Promise<PaymentId> {
  const [row] = await db
    .insert(schema.payments)
    .values({
      ...(spec.id === undefined ? {} : { id: spec.id }),
      accountId: spec.accountId,
      importBatchId: cast.importBatchId,
      amount: spec.amount,
      direction: spec.direction,
      occurredAt: spec.occurredAt,
      rawDescription: spec.rawDescription,
      channel: spec.channel,
      counterpartyType: spec.counterpartyType ?? 'unknown',
      counterpartyId: spec.counterpartyId ?? null,
      externalReference: spec.externalReference ?? null,
      referenceType: spec.referenceType ?? null,
      sourceSystem: spec.sourceSystem ?? null,
      state: spec.state ?? 'normalized',
      ignoredReason: spec.ignoredReason ?? null,
    })
    .returning({ id: schema.payments.id });
  return asId<'payment'>(row!.id);
}

export interface ExpenseSpec {
  readonly description: string;
  readonly amount: Paise;
  readonly occurredAt: Date;
  readonly relationshipType: ExpenseRelationshipType;
  readonly paidByPersonId: PersonId;
  readonly state?: ExpenseState;
  readonly occasionId?: ExpenseOccasionId | null;
  readonly category?: string | null;
}

/** Inserts an expense, defaulting to `approved` so a scenario can allocate it. */
export async function addExpense(db: Database, spec: ExpenseSpec): Promise<ExpenseId> {
  const [row] = await db
    .insert(schema.expenses)
    .values({
      description: spec.description,
      amount: spec.amount,
      occurredAt: spec.occurredAt,
      relationshipType: spec.relationshipType,
      paidByPersonId: spec.paidByPersonId,
      state: spec.state ?? 'approved',
      occasionId: spec.occasionId ?? null,
      category: spec.category ?? null,
    })
    .returning({ id: schema.expenses.id });
  return asId<'expense'>(row!.id);
}

/** Attributes a portion of a payment to an expense (`PaymentExpenseLink`). */
export async function linkPaymentToExpense(
  db: Database,
  input: { paymentId: PaymentId; expenseId: ExpenseId; amount: Paise },
): Promise<void> {
  await db.insert(schema.paymentExpenseLinks).values({
    paymentId: input.paymentId,
    expenseId: input.expenseId,
    amount: input.amount,
  });
}

export async function addExpenseItem(
  db: Database,
  input: { expenseId: ExpenseId; description: string; amount: Paise; quantity?: string },
): Promise<ExpenseItemId> {
  const [row] = await db
    .insert(schema.expenseItems)
    .values({
      expenseId: input.expenseId,
      description: input.description,
      amount: input.amount,
      quantity: input.quantity ?? '1',
    })
    .returning({ id: schema.expenseItems.id });
  return asId<'expense_item'>(row!.id);
}

export async function addOccasion(
  db: Database,
  input: { name: string; start: Date; end?: Date | null },
): Promise<ExpenseOccasionId> {
  const [row] = await db
    .insert(schema.expenseOccasions)
    .values({ name: input.name, occurredStart: input.start, occurredEnd: input.end ?? null })
    .returning({ id: schema.expenseOccasions.id });
  return asId<'expense_occasion'>(row!.id);
}

/**
 * Records a manual note.
 *
 * `noteKind` is required, exactly as the schema requires it: a note that documents an
 * externally-funded expense and a note that claims a debt was cleared are the same shape
 * otherwise, and the test helper is not allowed to guess either (ADR-0018).
 */
export async function addManualNote(
  db: Database,
  input: {
    text: string;
    capturedAt: Date;
    noteKind: EvidenceNoteKind;
    expenseId?: ExpenseId;
    paymentId?: PaymentId;
  },
): Promise<void> {
  validateEvidenceNoteKind('manual_note', input.noteKind);
  await db.insert(schema.evidence).values({
    type: 'manual_note',
    rawText: input.text,
    capturedAt: input.capturedAt,
    noteKind: input.noteKind,
    linkedExpenseId: input.expenseId ?? null,
    linkedPaymentId: input.paymentId ?? null,
  });
}

/**
 * The **current** (non-superseded) allocation's lines, ordered by beneficiary id.
 *
 * Excluding superseded versions matters: an expense that has been corrected or adjusted has
 * several allocation rows, and reading them all would silently double-count.
 */
export async function currentAllocationAmounts(
  db: Database,
  expenseId: ExpenseId,
): Promise<Array<{ beneficiaryId: string; beneficiaryType: string; amount: bigint }>> {
  const rows = await db
    .select({
      beneficiaryId: schema.allocationLines.beneficiaryId,
      beneficiaryType: schema.allocationLines.beneficiaryType,
      amount: schema.allocationLines.amount,
    })
    .from(schema.allocationLines)
    .innerJoin(schema.allocations, eq(schema.allocationLines.allocationId, schema.allocations.id))
    .where(
      and(eq(schema.allocations.expenseId, expenseId), isNull(schema.allocations.supersededAt)),
    );
  return [...rows].sort((a, b) => (a.beneficiaryId < b.beneficiaryId ? -1 : 1));
}

/** Every group-expansion row for an expense's current allocation, ordered by person. */
export async function currentGroupExpansion(
  db: Database,
  expenseId: ExpenseId,
): Promise<Array<{ personId: string; amount: bigint }>> {
  const rows = await db
    .select({
      personId: schema.allocationLineGroupExpansions.personId,
      amount: schema.allocationLineGroupExpansions.amount,
    })
    .from(schema.allocationLineGroupExpansions)
    .innerJoin(
      schema.allocationLines,
      eq(schema.allocationLineGroupExpansions.allocationLineId, schema.allocationLines.id),
    )
    .innerJoin(schema.allocations, eq(schema.allocationLines.allocationId, schema.allocations.id))
    .where(
      and(eq(schema.allocations.expenseId, expenseId), isNull(schema.allocations.supersededAt)),
    );
  return [...rows].sort((a, b) => (a.personId < b.personId ? -1 : 1));
}

/** Every allocation version for an expense, oldest first — proves history is preserved. */
export async function allocationVersions(
  db: Database,
  expenseId: ExpenseId,
): Promise<Array<{ id: string; method: string; supersededAt: Date | null }>> {
  return db
    .select({
      id: schema.allocations.id,
      method: schema.allocations.method,
      supersededAt: schema.allocations.supersededAt,
    })
    .from(schema.allocations)
    .where(eq(schema.allocations.expenseId, expenseId))
    .orderBy(asc(schema.allocations.decidedAt), asc(schema.allocations.id));
}

/** Standard audit metadata for a scenario acting as the user. */
export const AS_USER = { actor: 'user', source: 'tests/scenarios' } as const;

/**
 * Inserts the synthetic merchant catalog, returning fixture id → database id.
 *
 * Alias patterns are stored as canonical keys, produced by the same `merchantAliasKey` the
 * normalization service matches with — the stored value *is* the key, so seeding and
 * matching cannot drift apart.
 */
export async function seedMerchants(db: Database): Promise<Record<string, MerchantId>> {
  const fixture = loadMerchants();
  const merchant: Record<string, MerchantId> = {};

  for (const entry of fixture.merchants) {
    const [row] = await db
      .insert(schema.merchants)
      .values({
        canonicalName: entry.canonical_name,
        defaultCategory: entry.default_category ?? null,
      })
      .returning({ id: schema.merchants.id });
    const merchantId = asId<'merchant'>(row!.id);
    merchant[entry.id] = merchantId;

    for (const alias of entry.aliases) {
      await db.insert(schema.merchantAliases).values({
        merchantId,
        rawPattern: merchantAliasKey(alias),
      });
    }
  }

  return merchant;
}
