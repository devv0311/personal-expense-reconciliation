/**
 * Onboarding and master-data management — creating and correcting the rows every financial
 * record points at (people, accounts, merchants and their aliases, groups and memberships).
 *
 * The audit's row 48 named the gap this closes: *"A new empty installation cannot be populated
 * entirely through the website. This also blocks real allocation participants, owned-account
 * reconciliation, aliases and Splitwise person mapping."* Nothing here computes money. What it
 * does do is decide **who and what exist**, which is financially consequential in its own way —
 * an account nobody created cannot be reconciled, and a person nobody created cannot owe
 * anything — so every write goes through `runAudited` like any other decision (`invariants.md`
 * #21).
 *
 * Two rules this layer will not bend:
 *
 *  - **Removal is archival, never deletion.** A person who left, an account that closed and a
 *    merchant nobody buys from any more are all still referenced by history. `archived_at` is
 *    the only "delete" (`database-design.md`, Soft delete).
 *  - **A membership stint is append-only.** Ending one sets `left_at`; re-joining is a new
 *    row. A past `AllocationLineGroupExpansion` was snapshotted as of the expense date and must
 *    never move because somebody edited a date afterwards (ADR-0009).
 */

import { ACCOUNT_TYPES, merchantAliasKey } from '../domain/index.js';
import type {
  AccountId,
  AccountType,
  GroupId,
  GroupMembershipId,
  MerchantId,
  PersonId,
} from '../domain/index.js';
import {
  findMerchantByCanonicalName,
  findPersonByDisplayName,
  findPersonBySplitwiseUserId,
  getAccountById,
  getGroupById,
  getGroupMembershipById,
  getMerchantById,
  getPersonById,
  getPrimaryUserPerson,
  insertAccount,
  insertGroup,
  insertGroupMembership,
  insertMerchant,
  insertMerchantAlias,
  insertPerson,
  listAllPeople,
  listGroupMemberships,
  listGroups,
  listMerchantAliases,
  listMerchants,
  setGroupMembershipLeftAt,
  updateAccount,
  updateGroup,
  updateMerchant,
  updatePerson,
} from '../db/index.js';
import type { Database, Executor } from '../db/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

/* ============================================================================== people */

export interface PersonDetail {
  readonly id: PersonId;
  readonly displayName: string;
  readonly splitwiseUserId: string | null;
  readonly notes: string | null;
  readonly archivedAt: Date | null;
  readonly isUser: boolean;
}

/** Everyone, archived included, each flagged with whether they are the ledger's own user. */
export async function listPeopleForManagement(db: Executor): Promise<readonly PersonDetail[]> {
  const [rows, userPerson] = await Promise.all([listAllPeople(db), getPrimaryUserPerson(db)]);
  return rows.map((row) => ({ ...row, isUser: row.id === userPerson?.personId }));
}

export interface CreatePersonInput {
  readonly displayName: string;
  readonly splitwiseUserId?: string | null;
  readonly notes?: string | null;
  readonly audit: AuditMeta;
}

export async function createPerson(db: Database, input: CreatePersonInput): Promise<PersonDetail> {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new ServiceError('PRECONDITION_FAILED', 'A person needs a name.');
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const existing = await findPersonByDisplayName(exec, displayName);
    if (existing !== null) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `Somebody called "${displayName}" is already on the roster. Two people with the same ` +
          'name would make every allocation ambiguous — rename one of them, or edit the ' +
          'existing person instead of adding a second.',
        { personId: existing },
      );
    }
    await assertSplitwiseIdFree(exec, input.splitwiseUserId ?? null, null);

    const personId = await insertPerson(exec, {
      displayName,
      splitwiseUserId: emptyToNull(input.splitwiseUserId),
      notes: emptyToNull(input.notes),
    });
    await record({
      entityType: 'person',
      entityId: personId,
      action: 'create',
      newValue: { displayName, splitwiseUserId: emptyToNull(input.splitwiseUserId) },
    });
    const created = await getPersonById(exec, personId);
    if (created === null) throw new ServiceError('ENTITY_NOT_FOUND', 'The person vanished.');
    return { ...created, notes: emptyToNull(input.notes) ?? null, isUser: false };
  });
}

export interface UpdatePersonInput {
  readonly personId: PersonId;
  readonly displayName?: string;
  /** `null` unmaps this person from Splitwise; omitted leaves the mapping alone. */
  readonly splitwiseUserId?: string | null;
  readonly notes?: string | null;
  readonly archived?: boolean;
  readonly audit: AuditMeta;
}

export async function updatePersonDetails(
  db: Database,
  input: UpdatePersonInput,
): Promise<PersonDetail> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const before = await getPersonById(exec, input.personId);
    if (before === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such person.', { personId: input.personId });
    }

    if (input.displayName !== undefined && input.displayName.trim() !== before.displayName) {
      const clash = await findPersonByDisplayName(exec, input.displayName.trim());
      if (clash !== null && clash !== input.personId) {
        throw new ServiceError(
          'PRECONDITION_FAILED',
          `Somebody called "${input.displayName.trim()}" is already on the roster.`,
        );
      }
    }
    if (input.splitwiseUserId !== undefined) {
      await assertSplitwiseIdFree(exec, emptyToNull(input.splitwiseUserId), input.personId);
    }

    const userPerson = await getPrimaryUserPerson(exec);
    if (input.archived === true && userPerson?.personId === input.personId) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        "The ledger's own user cannot be archived — every balance is expressed from their " +
          'side, and a ledger with no user has nobody to owe or be owed.',
      );
    }

    const patch = {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
      ...(input.splitwiseUserId === undefined
        ? {}
        : { splitwiseUserId: emptyToNull(input.splitwiseUserId) }),
      ...(input.notes === undefined ? {} : { notes: emptyToNull(input.notes) }),
      ...(input.archived === undefined ? {} : { archivedAt: input.archived ? new Date() : null }),
    };
    await updatePerson(exec, input.personId, patch);
    await record({
      entityType: 'person',
      entityId: input.personId,
      action: 'update',
      oldValue: {
        displayName: before.displayName,
        splitwiseUserId: before.splitwiseUserId,
        archivedAt: before.archivedAt,
      },
      newValue: patch,
    });

    const after = await getPersonById(exec, input.personId);
    if (after === null) throw new ServiceError('ENTITY_NOT_FOUND', 'The person vanished.');
    const people = await listAllPeople(exec);
    const notes = people.find((person) => person.id === input.personId)?.notes ?? null;
    return { ...after, notes, isUser: userPerson?.personId === input.personId };
  });
}

async function assertSplitwiseIdFree(
  exec: Executor,
  splitwiseUserId: string | null,
  selfPersonId: PersonId | null,
): Promise<void> {
  if (splitwiseUserId === null) return;
  const holder = await findPersonBySplitwiseUserId(exec, splitwiseUserId);
  if (holder !== null && holder !== selfPersonId) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      `Splitwise user ${splitwiseUserId} is already mapped to another person. The mapping is ` +
        'one-to-one — pointing two people at one Splitwise account would make every drift ' +
        'comparison attribute the same external balance twice (ADR-0046).',
      { personId: holder },
    );
  }
}

/* ============================================================================ accounts */

export interface CreateAccountInput {
  readonly name: string;
  readonly type: AccountType;
  readonly institution?: string | null;
  /** At most four digits. A full account or card number is never stored (`security-model.md`). */
  readonly last4?: string | null;
  readonly currency?: string;
  readonly audit: AuditMeta;
}

export async function createAccount(
  db: Database,
  input: CreateAccountInput,
): Promise<{ readonly accountId: AccountId }> {
  if (!(ACCOUNT_TYPES as readonly string[]).includes(input.type)) {
    throw new ServiceError('PRECONDITION_FAILED', `Unknown account type "${input.type}".`);
  }
  const last4 = emptyToNull(input.last4);
  if (last4 !== null && !/^[0-9]{1,4}$/.test(last4)) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'Only the last four digits of an account or card may be stored, and only digits ' +
        '(`security-model.md`). Nothing longer is accepted here or at the database.',
      { field: 'last4' },
    );
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const userPerson = await getPrimaryUserPerson(exec);
    if (userPerson === null) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        'No ledger user exists yet, so there is nobody to own this account.',
      );
    }
    const accountId = await insertAccount(exec, {
      ownerUserId: userPerson.userId,
      name: input.name.trim(),
      type: input.type,
      institution: emptyToNull(input.institution),
      last4,
      ...(input.currency === undefined ? {} : { currency: input.currency }),
    });
    await record({
      entityType: 'account',
      entityId: accountId,
      action: 'create',
      newValue: { name: input.name.trim(), type: input.type, last4 },
    });
    return { accountId };
  });
}

export interface UpdateAccountInput {
  readonly accountId: AccountId;
  readonly name?: string;
  readonly institution?: string | null;
  readonly last4?: string | null;
  readonly isActive?: boolean;
  readonly archived?: boolean;
  readonly audit: AuditMeta;
}

export async function updateAccountDetails(db: Database, input: UpdateAccountInput): Promise<void> {
  const last4 = input.last4 === undefined ? undefined : emptyToNull(input.last4);
  if (last4 !== undefined && last4 !== null && !/^[0-9]{1,4}$/.test(last4)) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'Only the last four digits of an account or card may be stored.',
      { field: 'last4' },
    );
  }

  await runAudited(db, input.audit, async ({ exec, record }) => {
    const before = await getAccountById(exec, input.accountId);
    if (before === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such account.', {
        accountId: input.accountId,
      });
    }
    const patch = {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.institution === undefined ? {} : { institution: emptyToNull(input.institution) }),
      ...(last4 === undefined ? {} : { last4 }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      ...(input.archived === undefined
        ? {}
        : { archivedAt: input.archived ? new Date() : null, isActive: !input.archived }),
    };
    await updateAccount(exec, input.accountId, patch);
    await record({
      entityType: 'account',
      entityId: input.accountId,
      action: 'update',
      oldValue: {
        name: before.name,
        institution: before.institution,
        last4: before.last4,
        isActive: before.isActive,
        archivedAt: before.archivedAt,
      },
      newValue: patch,
    });
  });
}

/* =========================================================================== merchants */

export interface MerchantDetail {
  readonly id: MerchantId;
  readonly canonicalName: string;
  readonly defaultCategory: string | null;
  readonly archivedAt: Date | null;
  readonly aliases: readonly { readonly id: string; readonly rawPattern: string }[];
}

/**
 * The merchant catalog with each merchant's aliases attached.
 *
 * The aliases are the point: `domain.resolveMerchant` matches an imported narration against
 * `merchant_aliases.raw_pattern` **exactly** (ADR-0022 kept phase 7 deterministic-only), so
 * "unknown merchant" is nearly always a missing alias rather than a broken matcher. Showing
 * them is what makes that fixable by hand.
 */
export async function listMerchantsWithAliases(db: Executor): Promise<readonly MerchantDetail[]> {
  const [rows, aliases] = await Promise.all([listMerchants(db), listMerchantAliases(db)]);
  return rows.map((row) => ({
    ...row,
    aliases: aliases
      .filter((alias) => alias.merchantId === row.id)
      .map((alias) => ({ id: alias.id, rawPattern: alias.rawPattern })),
  }));
}

export interface CreateMerchantInput {
  readonly canonicalName: string;
  readonly defaultCategory?: string | null;
  /** Raw narrations that resolve to this merchant. Normalized to alias keys before storage. */
  readonly aliases?: readonly string[];
  readonly audit: AuditMeta;
}

export async function createMerchant(
  db: Database,
  input: CreateMerchantInput,
): Promise<{ readonly merchantId: MerchantId }> {
  const canonicalName = input.canonicalName.trim();
  if (canonicalName.length === 0) {
    throw new ServiceError('PRECONDITION_FAILED', 'A merchant needs a canonical name.');
  }

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const existing = await findMerchantByCanonicalName(exec, canonicalName);
    if (existing !== null) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `"${canonicalName}" is already in the catalog. Add the new narration as an alias of it ` +
          'rather than creating a second merchant with the same name.',
        { merchantId: existing },
      );
    }
    const merchantId = await insertMerchant(exec, {
      canonicalName,
      defaultCategory: emptyToNull(input.defaultCategory),
    });
    await record({
      entityType: 'merchant',
      entityId: merchantId,
      action: 'create',
      newValue: { canonicalName, defaultCategory: emptyToNull(input.defaultCategory) },
    });
    for (const raw of input.aliases ?? []) {
      await addAliasWithin(exec, merchantId, raw, record);
    }
    return { merchantId };
  });
}

export interface UpdateMerchantInput {
  readonly merchantId: MerchantId;
  readonly canonicalName?: string;
  readonly defaultCategory?: string | null;
  readonly archived?: boolean;
  readonly audit: AuditMeta;
}

export async function updateMerchantDetails(
  db: Database,
  input: UpdateMerchantInput,
): Promise<void> {
  await runAudited(db, input.audit, async ({ exec, record }) => {
    const before = await getMerchantById(exec, input.merchantId);
    if (before === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such merchant.', {
        merchantId: input.merchantId,
      });
    }
    const patch = {
      ...(input.canonicalName === undefined ? {} : { canonicalName: input.canonicalName.trim() }),
      ...(input.defaultCategory === undefined
        ? {}
        : { defaultCategory: emptyToNull(input.defaultCategory) }),
      ...(input.archived === undefined ? {} : { archivedAt: input.archived ? new Date() : null }),
    };
    await updateMerchant(exec, input.merchantId, patch);
    await record({
      entityType: 'merchant',
      entityId: input.merchantId,
      action: 'update',
      oldValue: { canonicalName: before.canonicalName, defaultCategory: before.defaultCategory },
      newValue: patch,
    });
  });
}

export interface AddMerchantAliasInput {
  readonly merchantId: MerchantId;
  /** The raw narration as it appears on a statement; normalized here, not by the caller. */
  readonly rawPattern: string;
  readonly audit: AuditMeta;
}

export async function addMerchantAlias(
  db: Database,
  input: AddMerchantAliasInput,
): Promise<{ readonly aliasId: string; readonly aliasKey: string }> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const merchant = await getMerchantById(exec, input.merchantId);
    if (merchant === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such merchant.', {
        merchantId: input.merchantId,
      });
    }
    return addAliasWithin(exec, input.merchantId, input.rawPattern, record);
  });
}

async function addAliasWithin(
  exec: Executor,
  merchantId: MerchantId,
  rawPattern: string,
  record: (event: {
    entityType: 'merchant';
    entityId: string;
    action: 'create' | 'update';
    newValue: unknown;
  }) => Promise<void>,
): Promise<{ readonly aliasId: string; readonly aliasKey: string }> {
  // Stored in the same normalized form `domain.merchantAliasKey` produces on both
  // sides — otherwise an alias typed with different spacing or case would never match
  // anything, and the failure would be silent (`normalization.ts`).
  const aliasKey = merchantAliasKey(rawPattern);
  if (aliasKey.length === 0) {
    throw new ServiceError('PRECONDITION_FAILED', 'An alias needs some text to match on.');
  }
  const existing = await listMerchantAliases(exec);
  const clash = existing.find((alias) => alias.rawPattern === aliasKey);
  if (clash !== undefined) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      clash.merchantId === merchantId
        ? 'That alias is already on this merchant.'
        : 'That alias already resolves to a different merchant. One alias means one merchant — ' +
            'otherwise a narration would have two answers and normalization would have to guess.',
      { merchantId: clash.merchantId },
    );
  }
  const aliasId = await insertMerchantAlias(exec, { merchantId, rawPattern: aliasKey });
  await record({
    entityType: 'merchant',
    entityId: merchantId,
    action: 'update',
    newValue: { addedAlias: aliasKey },
  });
  return { aliasId, aliasKey };
}

/* ============================================================================== groups */

export interface GroupMembershipDetail {
  readonly id: GroupMembershipId;
  readonly personId: PersonId;
  readonly displayName: string;
  readonly joinedAt: Date;
  readonly leftAt: Date | null;
}

export interface GroupDetail {
  readonly id: GroupId;
  readonly name: string;
  readonly type: string | null;
  readonly archivedAt: Date | null;
  readonly memberships: readonly GroupMembershipDetail[];
}

export async function listGroupsWithMemberships(db: Executor): Promise<readonly GroupDetail[]> {
  const [rows, memberships, people] = await Promise.all([
    listGroups(db),
    listGroupMemberships(db),
    listAllPeople(db),
  ]);
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  return rows.map((row) => ({
    ...row,
    memberships: memberships
      .filter((membership) => membership.groupId === row.id)
      .map((membership) => ({
        id: membership.id,
        personId: membership.personId,
        displayName: names.get(membership.personId) ?? 'Unknown person',
        joinedAt: membership.joinedAt,
        leftAt: membership.leftAt,
      }))
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()),
  }));
}

export interface CreateGroupInput {
  readonly name: string;
  readonly type?: string | null;
  /** Founding members, all joining at `joinedAt`. */
  readonly members?: readonly PersonId[];
  readonly joinedAt?: Date;
  readonly audit: AuditMeta;
}

export async function createGroup(
  db: Database,
  input: CreateGroupInput,
): Promise<{ readonly groupId: GroupId }> {
  const name = input.name.trim();
  if (name.length === 0) throw new ServiceError('PRECONDITION_FAILED', 'A group needs a name.');

  return runAudited(db, input.audit, async ({ exec, record }) => {
    const groupId = await insertGroup(exec, { name, type: emptyToNull(input.type) });
    await record({
      entityType: 'group',
      entityId: groupId,
      action: 'create',
      newValue: { name, type: emptyToNull(input.type) },
    });
    const joinedAt = input.joinedAt ?? new Date();
    for (const personId of input.members ?? []) {
      const person = await getPersonById(exec, personId);
      if (person === null) {
        throw new ServiceError('ENTITY_NOT_FOUND', 'No such person.', { personId });
      }
      const membershipId = await insertGroupMembership(exec, { groupId, personId, joinedAt });
      await record({
        entityType: 'group_membership',
        entityId: membershipId,
        action: 'create',
        newValue: { groupId, personId, joinedAt },
      });
    }
    return { groupId };
  });
}

export interface UpdateGroupInput {
  readonly groupId: GroupId;
  readonly name?: string;
  readonly type?: string | null;
  readonly archived?: boolean;
  readonly audit: AuditMeta;
}

export async function updateGroupDetails(db: Database, input: UpdateGroupInput): Promise<void> {
  await runAudited(db, input.audit, async ({ exec, record }) => {
    const before = await getGroupById(exec, input.groupId);
    if (before === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such group.', { groupId: input.groupId });
    }
    const patch = {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.type === undefined ? {} : { type: emptyToNull(input.type) }),
      ...(input.archived === undefined ? {} : { archivedAt: input.archived ? new Date() : null }),
    };
    await updateGroup(exec, input.groupId, patch);
    await record({
      entityType: 'group',
      entityId: input.groupId,
      action: 'update',
      oldValue: { name: before.name, type: before.type, archivedAt: before.archivedAt },
      newValue: patch,
    });
  });
}

export interface AddGroupMemberInput {
  readonly groupId: GroupId;
  readonly personId: PersonId;
  readonly joinedAt: Date;
  readonly audit: AuditMeta;
}

/**
 * Starts a membership stint.
 *
 * Overlapping stints for the same person are refused: `domain.expandGroupAllocationLine`
 * counts members active on the expense date, and two overlapping rows for one person would
 * count them twice and halve everyone else's share (ADR-0009).
 */
export async function addGroupMember(
  db: Database,
  input: AddGroupMemberInput,
): Promise<{ readonly membershipId: GroupMembershipId }> {
  return runAudited(db, input.audit, async ({ exec, record }) => {
    const group = await getGroupById(exec, input.groupId);
    if (group === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such group.', { groupId: input.groupId });
    }
    const person = await getPersonById(exec, input.personId);
    if (person === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such person.', { personId: input.personId });
    }

    const existing = await listGroupMemberships(exec, input.groupId);
    const overlapping = existing.find(
      (membership) =>
        membership.personId === input.personId &&
        (membership.leftAt === null || membership.leftAt > input.joinedAt),
    );
    if (overlapping !== undefined) {
      throw new ServiceError(
        'PRECONDITION_FAILED',
        `${person.displayName} is already a member from ` +
          `${overlapping.joinedAt.toISOString()}${
            overlapping.leftAt === null ? ' onwards' : ` to ${overlapping.leftAt.toISOString()}`
          }. End that stint before starting a new one — two overlapping stints would count ` +
          "one person twice in every group expense's expansion (ADR-0009).",
        { membershipId: overlapping.id },
      );
    }

    const membershipId = await insertGroupMembership(exec, {
      groupId: input.groupId,
      personId: input.personId,
      joinedAt: input.joinedAt,
    });
    await record({
      entityType: 'group_membership',
      entityId: membershipId,
      action: 'create',
      newValue: { groupId: input.groupId, personId: input.personId, joinedAt: input.joinedAt },
    });
    return { membershipId };
  });
}

export interface EndGroupMembershipInput {
  readonly membershipId: GroupMembershipId;
  /** `null` reopens an ended stint — a correction, recorded as one. */
  readonly leftAt: Date | null;
  readonly audit: AuditMeta;
}

export async function endGroupMembership(
  db: Database,
  input: EndGroupMembershipInput,
): Promise<void> {
  await runAudited(db, input.audit, async ({ exec, record }) => {
    const before = await getGroupMembershipById(exec, input.membershipId);
    if (before === null) {
      throw new ServiceError('ENTITY_NOT_FOUND', 'No such membership.', {
        membershipId: input.membershipId,
      });
    }
    if (input.leftAt !== null && input.leftAt < before.joinedAt) {
      throw new ServiceError('PRECONDITION_FAILED', 'A membership cannot end before it started.', {
        field: 'leftAt',
      });
    }
    await setGroupMembershipLeftAt(exec, input.membershipId, input.leftAt);
    await record({
      entityType: 'group_membership',
      entityId: input.membershipId,
      action: 'update',
      oldValue: { leftAt: before.leftAt },
      newValue: { leftAt: input.leftAt },
    });
  });
}

/* --------------------------------------------------------------------------- internals */

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
