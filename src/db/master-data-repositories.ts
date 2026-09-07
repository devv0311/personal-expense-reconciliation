/**
 * Master data — the rows every financial record points at: people, accounts, merchants (and
 * their aliases), groups and their memberships, and expense occasions.
 *
 * Split out of `repositories.ts` rather than appended to it: none of these carry an amount,
 * and keeping the money tables' data access in one file and the roster's in another is what
 * stops "add a person" from being reviewed alongside "insert an allocation line".
 *
 * The same rules hold as everywhere in `src/db`: reads and writes only, no arithmetic, and no
 * `UPDATE` of a SOURCE column. Archiving is a soft delete (`archived_at`) because financial
 * history references these rows forever — a person who left the flat in 2024 still owns their
 * share of a 2024 expense (`database-design.md`, "Soft delete").
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { AccountType } from '../domain/enums.js';
import type {
  AccountId,
  ExpenseOccasionId,
  GroupId,
  GroupMembershipId,
  MerchantId,
  PersonId,
  SessionId,
  UserId,
} from '../domain/ids.js';

import type { Executor } from './repositories.js';
import {
  accounts,
  expenseOccasions,
  expenses,
  groupMemberships,
  groups,
  merchantAliases,
  merchants,
  people,
  sessions,
  users,
} from './schema.js';

/* ============================================================================== people */

export interface PersonDraft {
  readonly displayName: string;
  readonly splitwiseUserId?: string | null;
  readonly notes?: string | null;
}

export async function insertPerson(exec: Executor, draft: PersonDraft): Promise<PersonId> {
  const [row] = await exec
    .insert(people)
    .values({
      displayName: draft.displayName,
      splitwiseUserId: draft.splitwiseUserId ?? null,
      notes: draft.notes ?? null,
    })
    .returning({ id: people.id });
  if (row === undefined) throw new Error('Insert into people returned no row.');
  return row.id as PersonId;
}

/**
 * The fields a person may change about a `Person`.
 *
 * `undefined` leaves a column alone; an explicit `null` clears it. That distinction matters
 * for `splitwiseUserId`: unmapping somebody from Splitwise and never having mapped them are
 * different facts, and the audit event should be able to show which one happened.
 */
export interface PersonPatch {
  readonly displayName?: string;
  readonly splitwiseUserId?: string | null;
  readonly notes?: string | null;
  readonly archivedAt?: Date | null;
}

export async function updatePerson(
  exec: Executor,
  personId: PersonId,
  patch: PersonPatch,
): Promise<void> {
  const values: Record<string, unknown> = {};
  if (patch.displayName !== undefined) values['displayName'] = patch.displayName;
  if (patch.splitwiseUserId !== undefined) values['splitwiseUserId'] = patch.splitwiseUserId;
  if (patch.notes !== undefined) values['notes'] = patch.notes;
  if (patch.archivedAt !== undefined) values['archivedAt'] = patch.archivedAt;
  if (Object.keys(values).length === 0) return;
  await exec.update(people).set(values).where(eq(people.id, personId));
}

/** A person by exact display name, so "add Priya" twice does not produce two Priyas. */
export async function findPersonByDisplayName(
  exec: Executor,
  displayName: string,
): Promise<PersonId | null> {
  const [row] = await exec
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.displayName, displayName), isNull(people.archivedAt)));
  return row === undefined ? null : (row.id as PersonId);
}

/** Whoever already claims this Splitwise user id — the mapping is one-to-one, by hand. */
export async function findPersonBySplitwiseUserId(
  exec: Executor,
  splitwiseUserId: string,
): Promise<PersonId | null> {
  const [row] = await exec
    .select({ id: people.id })
    .from(people)
    .where(eq(people.splitwiseUserId, splitwiseUserId));
  return row === undefined ? null : (row.id as PersonId);
}

/** Everyone, including archived people — the roster a management screen edits. */
export async function listAllPeople(exec: Executor): Promise<
  Array<{
    id: PersonId;
    displayName: string;
    splitwiseUserId: string | null;
    notes: string | null;
    archivedAt: Date | null;
  }>
> {
  const rows = await exec
    .select({
      id: people.id,
      displayName: people.displayName,
      splitwiseUserId: people.splitwiseUserId,
      notes: people.notes,
      archivedAt: people.archivedAt,
    })
    .from(people)
    .orderBy(asc(people.createdAt), asc(people.id));
  return rows.map((row) => ({ ...row, id: row.id as PersonId }));
}

/* ============================================================================ accounts */

export interface AccountDraft {
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly type: AccountType;
  readonly institution?: string | null;
  /** At most four digits — `accounts_last4_check` refuses anything longer at the database. */
  readonly last4?: string | null;
  readonly currency?: string;
}

export async function insertAccount(exec: Executor, draft: AccountDraft): Promise<AccountId> {
  const [row] = await exec
    .insert(accounts)
    .values({
      ownerUserId: draft.ownerUserId,
      name: draft.name,
      type: draft.type,
      institution: draft.institution ?? null,
      last4: draft.last4 ?? null,
      currency: draft.currency ?? 'INR',
    })
    .returning({ id: accounts.id });
  if (row === undefined) throw new Error('Insert into accounts returned no row.');
  return row.id as AccountId;
}

export interface AccountPatch {
  readonly name?: string;
  readonly institution?: string | null;
  readonly last4?: string | null;
  readonly isActive?: boolean;
  readonly archivedAt?: Date | null;
}

/**
 * Updates the descriptive columns of an account.
 *
 * `type` and `currency` are deliberately absent: every payment already posted to this account
 * was reconciled under them, and changing either would silently restate history rather than
 * correct it (`invariants.md` #4's spirit, applied to the account the movement landed on).
 */
export async function updateAccount(
  exec: Executor,
  accountId: AccountId,
  patch: AccountPatch,
): Promise<void> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values['name'] = patch.name;
  if (patch.institution !== undefined) values['institution'] = patch.institution;
  if (patch.last4 !== undefined) values['last4'] = patch.last4;
  if (patch.isActive !== undefined) values['isActive'] = patch.isActive;
  if (patch.archivedAt !== undefined) values['archivedAt'] = patch.archivedAt;
  if (Object.keys(values).length === 0) return;
  await exec.update(accounts).set(values).where(eq(accounts.id, accountId));
}

export async function getAccountById(
  exec: Executor,
  accountId: AccountId,
): Promise<{
  id: AccountId;
  ownerUserId: UserId;
  name: string;
  type: string;
  institution: string | null;
  last4: string | null;
  currency: string;
  isActive: boolean;
  archivedAt: Date | null;
} | null> {
  const [row] = await exec
    .select({
      id: accounts.id,
      ownerUserId: accounts.ownerUserId,
      name: accounts.name,
      type: accounts.type,
      institution: accounts.institution,
      last4: accounts.last4,
      currency: accounts.currency,
      isActive: accounts.isActive,
      archivedAt: accounts.archivedAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row === undefined
    ? null
    : { ...row, id: row.id as AccountId, ownerUserId: row.ownerUserId as UserId };
}

/* =========================================================================== merchants */

export interface MerchantRow {
  readonly id: MerchantId;
  readonly canonicalName: string;
  readonly defaultCategory: string | null;
  readonly archivedAt: Date | null;
}

export async function insertMerchant(
  exec: Executor,
  draft: { readonly canonicalName: string; readonly defaultCategory?: string | null },
): Promise<MerchantId> {
  const [row] = await exec
    .insert(merchants)
    .values({
      canonicalName: draft.canonicalName,
      defaultCategory: draft.defaultCategory ?? null,
    })
    .returning({ id: merchants.id });
  if (row === undefined) throw new Error('Insert into merchants returned no row.');
  return row.id as MerchantId;
}

export async function updateMerchant(
  exec: Executor,
  merchantId: MerchantId,
  patch: {
    readonly canonicalName?: string;
    readonly defaultCategory?: string | null;
    readonly archivedAt?: Date | null;
  },
): Promise<void> {
  const values: Record<string, unknown> = {};
  if (patch.canonicalName !== undefined) values['canonicalName'] = patch.canonicalName;
  if (patch.defaultCategory !== undefined) values['defaultCategory'] = patch.defaultCategory;
  if (patch.archivedAt !== undefined) values['archivedAt'] = patch.archivedAt;
  if (Object.keys(values).length === 0) return;
  await exec.update(merchants).set(values).where(eq(merchants.id, merchantId));
}

export async function listMerchants(exec: Executor): Promise<MerchantRow[]> {
  const rows = await exec
    .select({
      id: merchants.id,
      canonicalName: merchants.canonicalName,
      defaultCategory: merchants.defaultCategory,
      archivedAt: merchants.archivedAt,
    })
    .from(merchants)
    .orderBy(asc(merchants.canonicalName), asc(merchants.id));
  return rows.map((row) => ({ ...row, id: row.id as MerchantId }));
}

export async function findMerchantByCanonicalName(
  exec: Executor,
  canonicalName: string,
): Promise<MerchantId | null> {
  const [row] = await exec
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.canonicalName, canonicalName));
  return row === undefined ? null : (row.id as MerchantId);
}

export interface MerchantAliasRow {
  readonly id: string;
  readonly merchantId: MerchantId;
  readonly rawPattern: string;
  readonly createdAt: Date;
}

export async function listMerchantAliases(
  exec: Executor,
  merchantId?: MerchantId,
): Promise<MerchantAliasRow[]> {
  const query = exec
    .select({
      id: merchantAliases.id,
      merchantId: merchantAliases.merchantId,
      rawPattern: merchantAliases.rawPattern,
      createdAt: merchantAliases.createdAt,
    })
    .from(merchantAliases);
  const rows =
    merchantId === undefined
      ? await query.orderBy(asc(merchantAliases.rawPattern))
      : await query
          .where(eq(merchantAliases.merchantId, merchantId))
          .orderBy(asc(merchantAliases.rawPattern));
  return rows.map((row) => ({ ...row, merchantId: row.merchantId as MerchantId }));
}

export async function insertMerchantAlias(
  exec: Executor,
  draft: { readonly merchantId: MerchantId; readonly rawPattern: string },
): Promise<string> {
  const [row] = await exec
    .insert(merchantAliases)
    .values({ merchantId: draft.merchantId, rawPattern: draft.rawPattern })
    .returning({ id: merchantAliases.id });
  if (row === undefined) throw new Error('Insert into merchant_aliases returned no row.');
  return row.id;
}

export async function deleteMerchantAlias(exec: Executor, aliasId: string): Promise<void> {
  await exec.delete(merchantAliases).where(eq(merchantAliases.id, aliasId));
}

/* ============================================================================== groups */

export interface GroupRow {
  readonly id: GroupId;
  readonly name: string;
  readonly type: string | null;
  readonly archivedAt: Date | null;
}

export async function insertGroup(
  exec: Executor,
  draft: { readonly name: string; readonly type?: string | null },
): Promise<GroupId> {
  const [row] = await exec
    .insert(groups)
    .values({ name: draft.name, type: draft.type ?? null })
    .returning({ id: groups.id });
  if (row === undefined) throw new Error('Insert into groups returned no row.');
  return row.id as GroupId;
}

export async function updateGroup(
  exec: Executor,
  groupId: GroupId,
  patch: {
    readonly name?: string;
    readonly type?: string | null;
    readonly archivedAt?: Date | null;
  },
): Promise<void> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values['name'] = patch.name;
  if (patch.type !== undefined) values['type'] = patch.type;
  if (patch.archivedAt !== undefined) values['archivedAt'] = patch.archivedAt;
  if (Object.keys(values).length === 0) return;
  await exec.update(groups).set(values).where(eq(groups.id, groupId));
}

export async function listGroups(exec: Executor): Promise<GroupRow[]> {
  const rows = await exec
    .select({
      id: groups.id,
      name: groups.name,
      type: groups.type,
      archivedAt: groups.archivedAt,
    })
    .from(groups)
    .orderBy(asc(groups.name), asc(groups.id));
  return rows.map((row) => ({ ...row, id: row.id as GroupId }));
}

export async function getGroupById(exec: Executor, groupId: GroupId): Promise<GroupRow | null> {
  const [row] = await exec
    .select({
      id: groups.id,
      name: groups.name,
      type: groups.type,
      archivedAt: groups.archivedAt,
    })
    .from(groups)
    .where(eq(groups.id, groupId));
  return row === undefined ? null : { ...row, id: row.id as GroupId };
}

export async function insertGroupMembership(
  exec: Executor,
  draft: {
    readonly groupId: GroupId;
    readonly personId: PersonId;
    readonly joinedAt: Date;
    readonly leftAt?: Date | null;
  },
): Promise<GroupMembershipId> {
  const [row] = await exec
    .insert(groupMemberships)
    .values({
      groupId: draft.groupId,
      personId: draft.personId,
      joinedAt: draft.joinedAt,
      leftAt: draft.leftAt ?? null,
    })
    .returning({ id: groupMemberships.id });
  if (row === undefined) throw new Error('Insert into group_memberships returned no row.');
  return row.id as GroupMembershipId;
}

/**
 * Closes one membership stint.
 *
 * The only mutation membership allows, and deliberately so: joining again is a **new** row
 * (`group_memberships` has no unique constraint precisely to permit that), and a past
 * expansion snapshot must never change because somebody edited a date afterwards (ADR-0009).
 */
export async function setGroupMembershipLeftAt(
  exec: Executor,
  membershipId: GroupMembershipId,
  leftAt: Date | null,
): Promise<void> {
  await exec.update(groupMemberships).set({ leftAt }).where(eq(groupMemberships.id, membershipId));
}

export async function getGroupMembershipById(
  exec: Executor,
  membershipId: GroupMembershipId,
): Promise<{
  id: GroupMembershipId;
  groupId: GroupId;
  personId: PersonId;
  joinedAt: Date;
  leftAt: Date | null;
} | null> {
  const [row] = await exec
    .select({
      id: groupMemberships.id,
      groupId: groupMemberships.groupId,
      personId: groupMemberships.personId,
      joinedAt: groupMemberships.joinedAt,
      leftAt: groupMemberships.leftAt,
    })
    .from(groupMemberships)
    .where(eq(groupMemberships.id, membershipId));
  return row === undefined
    ? null
    : {
        id: row.id as GroupMembershipId,
        groupId: row.groupId as GroupId,
        personId: row.personId as PersonId,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      };
}

/* =========================================================================== occasions */

export interface ExpenseOccasionRow {
  readonly id: ExpenseOccasionId;
  readonly name: string;
  readonly occurredStart: Date;
  readonly occurredEnd: Date | null;
  readonly defaultParticipants: readonly string[];
  readonly createdAt: Date;
}

export async function insertExpenseOccasion(
  exec: Executor,
  draft: {
    readonly name: string;
    readonly occurredStart: Date;
    readonly occurredEnd?: Date | null;
    readonly defaultParticipants?: readonly PersonId[];
  },
): Promise<ExpenseOccasionId> {
  const [row] = await exec
    .insert(expenseOccasions)
    .values({
      name: draft.name,
      occurredStart: draft.occurredStart,
      occurredEnd: draft.occurredEnd ?? null,
      defaultParticipants: [...(draft.defaultParticipants ?? [])],
    })
    .returning({ id: expenseOccasions.id });
  if (row === undefined) throw new Error('Insert into expense_occasions returned no row.');
  return row.id as ExpenseOccasionId;
}

export async function listExpenseOccasions(exec: Executor): Promise<ExpenseOccasionRow[]> {
  const rows = await exec
    .select({
      id: expenseOccasions.id,
      name: expenseOccasions.name,
      occurredStart: expenseOccasions.occurredStart,
      occurredEnd: expenseOccasions.occurredEnd,
      defaultParticipants: expenseOccasions.defaultParticipants,
      createdAt: expenseOccasions.createdAt,
    })
    .from(expenseOccasions)
    .orderBy(desc(expenseOccasions.occurredStart), asc(expenseOccasions.id));
  return rows.map((row) => ({
    ...row,
    id: row.id as ExpenseOccasionId,
    defaultParticipants: Array.isArray(row.defaultParticipants)
      ? (row.defaultParticipants as string[])
      : [],
  }));
}

export async function getExpenseOccasionById(
  exec: Executor,
  occasionId: ExpenseOccasionId,
): Promise<ExpenseOccasionRow | null> {
  const [row] = await exec
    .select({
      id: expenseOccasions.id,
      name: expenseOccasions.name,
      occurredStart: expenseOccasions.occurredStart,
      occurredEnd: expenseOccasions.occurredEnd,
      defaultParticipants: expenseOccasions.defaultParticipants,
      createdAt: expenseOccasions.createdAt,
    })
    .from(expenseOccasions)
    .where(eq(expenseOccasions.id, occasionId));
  return row === undefined
    ? null
    : {
        ...row,
        id: row.id as ExpenseOccasionId,
        defaultParticipants: Array.isArray(row.defaultParticipants)
          ? (row.defaultParticipants as string[])
          : [],
      };
}

/** Attaches an expense to an occasion, or detaches it with `null` (`scenario-analysis.md` §10). */
export async function setExpenseOccasion(
  exec: Executor,
  expenseId: string,
  occasionId: ExpenseOccasionId | null,
): Promise<void> {
  await exec.update(expenses).set({ occasionId }).where(eq(expenses.id, expenseId));
}

/** How many expenses each occasion currently groups — a count, never a sum of money. */
export async function countExpensesPerOccasion(
  exec: Executor,
): Promise<Map<ExpenseOccasionId, number>> {
  const rows = await exec
    .select({ occasionId: expenses.occasionId, count: sql<number>`count(*)::int` })
    .from(expenses)
    .where(sql`${expenses.occasionId} is not null`)
    .groupBy(expenses.occasionId);
  const counts = new Map<ExpenseOccasionId, number>();
  for (const row of rows) {
    if (row.occasionId === null) continue;
    counts.set(row.occasionId as ExpenseOccasionId, Number(row.count));
  }
  return counts;
}

/* =========================================================================== sessions */

export interface UserAccountRow {
  readonly id: UserId;
  readonly email: string;
  readonly personId: PersonId;
  readonly displayName: string;
  readonly passwordHash: string | null;
}

/** One account by email, for sign-in. Email is stored lowercased by the service. */
export async function getUserByEmail(
  exec: Executor,
  email: string,
): Promise<UserAccountRow | null> {
  const [row] = await exec
    .select({
      id: users.id,
      email: users.email,
      personId: users.personId,
      displayName: people.displayName,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .innerJoin(people, eq(people.id, users.personId))
    .where(eq(users.email, email));
  return row === undefined
    ? null
    : { ...row, id: row.id as UserId, personId: row.personId as PersonId };
}

/** One account by id — the ledger user's own row, for a first-run check. */
export async function getUserById(exec: Executor, userId: UserId): Promise<UserAccountRow | null> {
  const [row] = await exec
    .select({
      id: users.id,
      email: users.email,
      personId: users.personId,
      displayName: people.displayName,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .innerJoin(people, eq(people.id, users.personId))
    .where(eq(users.id, userId));
  return row === undefined
    ? null
    : { ...row, id: row.id as UserId, personId: row.personId as PersonId };
}

export async function setUserPasswordHash(
  exec: Executor,
  userId: UserId,
  passwordHash: string,
): Promise<void> {
  await exec.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function createSession(
  exec: Executor,
  draft: {
    readonly userId: UserId;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  },
): Promise<SessionId> {
  const [row] = await exec
    .insert(sessions)
    .values({
      userId: draft.userId,
      tokenHash: draft.tokenHash,
      expiresAt: draft.expiresAt,
    })
    .returning({ id: sessions.id });
  if (row === undefined) throw new Error('Insert into sessions returned no row.');
  return row.id as SessionId;
}

/**
 * A live session by token hash, or `null`.
 *
 * Expiry and revocation are part of the query, not a check the caller might forget: a session
 * that has lapsed simply does not exist as far as any read is concerned.
 */
export async function findValidSession(
  exec: Executor,
  tokenHash: string,
  now: Date,
): Promise<{
  sessionId: SessionId;
  userId: UserId;
  personId: PersonId;
  email: string;
  displayName: string;
} | null> {
  const [row] = await exec
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      personId: users.personId,
      email: users.email,
      displayName: people.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(people, eq(people.id, users.personId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > ${now}`,
      ),
    );
  return row === undefined
    ? null
    : {
        sessionId: row.sessionId as SessionId,
        userId: row.userId as UserId,
        personId: row.personId as PersonId,
        email: row.email,
        displayName: row.displayName,
      };
}

export async function touchSession(exec: Executor, sessionId: SessionId, at: Date): Promise<void> {
  await exec.update(sessions).set({ lastSeenAt: at }).where(eq(sessions.id, sessionId));
}

export async function revokeSession(exec: Executor, tokenHash: string, at: Date): Promise<void> {
  await exec.update(sessions).set({ revokedAt: at }).where(eq(sessions.tokenHash, tokenHash));
}
