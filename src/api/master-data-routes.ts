/**
 * Onboarding and master data over HTTP — the roster a fresh installation has to be able to
 * build before any of the financial screens mean anything (audit row 48).
 *
 * ```
 * GET  /api/people/manage                    everyone, archived included
 * POST /api/people                           add a person
 * POST /api/people/:personId                 rename / map to Splitwise / archive
 * POST /api/accounts                         add an owned account
 * POST /api/accounts/:accountId              rename / close
 * GET  /api/merchants                        the catalog, with each merchant's aliases
 * POST /api/merchants                        add a merchant (and optionally its aliases)
 * POST /api/merchants/:merchantId            rename / recategorize / archive
 * POST /api/merchants/:merchantId/aliases    teach normalization one more narration
 * GET  /api/groups                           groups with their membership stints
 * POST /api/groups                           add a group (and optionally founding members)
 * POST /api/groups/:groupId                  rename / archive
 * POST /api/groups/:groupId/members          start a membership stint
 * POST /api/group-memberships/:id/end        end (or reopen) one stint
 * ```
 *
 * `GET /api/people` is untouched: it is the lean roster every screen renders names from, and
 * widening it would make every page carry notes and archive timestamps it never uses.
 */

import { ACCOUNT_TYPES, asId } from '../domain/index.js';
import {
  addGroupMember,
  addMerchantAlias,
  createAccount,
  createGroup,
  createMerchant,
  createPerson,
  endGroupMembership,
  listGroupsWithMemberships,
  listMerchantsWithAliases,
  listPeopleForManagement,
  updateAccountDetails,
  updateGroupDetails,
  updateMerchantDetails,
  updatePersonDetails,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalBoolean,
  optionalString,
  optionalTimestamp,
  readJsonObject,
  requireOneOf,
  requireParam,
  requirePersonActor,
  requireString,
  requireTimestamp,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/* ============================================================================== people */

export async function getPeopleManagementRoute(deps: ApiDependencies): Promise<Response> {
  const people = await listPeopleForManagement(deps.db);
  return jsonResponse(200, { people });
}

export async function postPerson(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'add a person');
  const person = await createPerson(deps.db, {
    displayName: requireString(body, 'displayName'),
    ...optional('splitwiseUserId', optionalString(body, 'splitwiseUserId')),
    ...optional('notes', optionalString(body, 'notes')),
    audit: { actor, source: 'api POST /api/people' },
  });
  return jsonResponse(201, { person });
}

export async function postPersonUpdate(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const personId = asId<'person'>(requireUuid(requireParam(params, 'personId'), 'personId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'edit a person');
  const person = await updatePersonDetails(deps.db, {
    personId,
    ...optional('displayName', optionalString(body, 'displayName')),
    // Present-and-null means "unmap from Splitwise"; absent means "leave it alone".
    ...('splitwiseUserId' in body
      ? { splitwiseUserId: optionalString(body, 'splitwiseUserId') ?? null }
      : {}),
    ...('notes' in body ? { notes: optionalString(body, 'notes') ?? null } : {}),
    ...optional('archived', optionalBoolean(body, 'archived')),
    audit: { actor, source: 'api POST /api/people/:personId' },
  });
  return jsonResponse(200, { person });
}

/* ============================================================================ accounts */

export async function postAccount(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'add an account');
  const result = await createAccount(deps.db, {
    name: requireString(body, 'name'),
    type: requireOneOf(body, 'type', ACCOUNT_TYPES),
    ...optional('institution', optionalString(body, 'institution')),
    ...optional('last4', optionalString(body, 'last4')),
    ...optional('currency', optionalString(body, 'currency')),
    audit: { actor, source: 'api POST /api/accounts' },
  });
  return jsonResponse(201, result);
}

export async function postAccountUpdate(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const accountId = asId<'account'>(requireUuid(requireParam(params, 'accountId'), 'accountId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'edit an account');
  await updateAccountDetails(deps.db, {
    accountId,
    ...optional('name', optionalString(body, 'name')),
    ...('institution' in body
      ? { institution: optionalString(body, 'institution') ?? null }
      : {}),
    ...('last4' in body ? { last4: optionalString(body, 'last4') ?? null } : {}),
    ...optional('isActive', optionalBoolean(body, 'isActive')),
    ...optional('archived', optionalBoolean(body, 'archived')),
    audit: { actor, source: 'api POST /api/accounts/:accountId' },
  });
  return jsonResponse(200, { accountId });
}

/* =========================================================================== merchants */

export async function getMerchantsRoute(deps: ApiDependencies): Promise<Response> {
  const merchants = await listMerchantsWithAliases(deps.db);
  return jsonResponse(200, { merchants });
}

export async function postMerchant(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'add a merchant');
  const aliases = parseAliases(body);
  const result = await createMerchant(deps.db, {
    canonicalName: requireString(body, 'canonicalName'),
    ...optional('defaultCategory', optionalString(body, 'defaultCategory')),
    ...(aliases === undefined ? {} : { aliases }),
    audit: { actor, source: 'api POST /api/merchants' },
  });
  return jsonResponse(201, result);
}

export async function postMerchantUpdate(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const merchantId = asId<'merchant'>(
    requireUuid(requireParam(params, 'merchantId'), 'merchantId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'edit a merchant');
  await updateMerchantDetails(deps.db, {
    merchantId,
    ...optional('canonicalName', optionalString(body, 'canonicalName')),
    ...('defaultCategory' in body
      ? { defaultCategory: optionalString(body, 'defaultCategory') ?? null }
      : {}),
    ...optional('archived', optionalBoolean(body, 'archived')),
    audit: { actor, source: 'api POST /api/merchants/:merchantId' },
  });
  return jsonResponse(200, { merchantId });
}

export async function postMerchantAlias(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const merchantId = asId<'merchant'>(
    requireUuid(requireParam(params, 'merchantId'), 'merchantId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'add a merchant alias');
  const result = await addMerchantAlias(deps.db, {
    merchantId,
    rawPattern: requireString(body, 'rawPattern'),
    audit: { actor, source: 'api POST /api/merchants/:merchantId/aliases' },
  });
  return jsonResponse(201, result);
}

/* ============================================================================== groups */

export async function getGroupsRoute(deps: ApiDependencies): Promise<Response> {
  const groups = await listGroupsWithMemberships(deps.db);
  return jsonResponse(200, { groups });
}

export async function postGroup(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'add a group');
  const members = parseMembers(body);
  const joinedAt = optionalTimestamp(body, 'joinedAt');
  const result = await createGroup(deps.db, {
    name: requireString(body, 'name'),
    ...optional('type', optionalString(body, 'type')),
    ...(members === undefined ? {} : { members }),
    ...(joinedAt === undefined ? {} : { joinedAt }),
    audit: { actor, source: 'api POST /api/groups' },
  });
  return jsonResponse(201, result);
}

export async function postGroupUpdate(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const groupId = asId<'group'>(requireUuid(requireParam(params, 'groupId'), 'groupId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'edit a group');
  await updateGroupDetails(deps.db, {
    groupId,
    ...optional('name', optionalString(body, 'name')),
    ...('type' in body ? { type: optionalString(body, 'type') ?? null } : {}),
    ...optional('archived', optionalBoolean(body, 'archived')),
    audit: { actor, source: 'api POST /api/groups/:groupId' },
  });
  return jsonResponse(200, { groupId });
}

export async function postGroupMember(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const groupId = asId<'group'>(requireUuid(requireParam(params, 'groupId'), 'groupId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'add a group member');
  const result = await addGroupMember(deps.db, {
    groupId,
    personId: asId<'person'>(requireUuid(requireString(body, 'personId'), 'personId')),
    joinedAt: requireTimestamp(body, 'joinedAt'),
    audit: { actor, source: 'api POST /api/groups/:groupId/members' },
  });
  return jsonResponse(201, result);
}

export async function postGroupMembershipEnd(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const membershipId = asId<'group_membership'>(
    requireUuid(requireParam(params, 'membershipId'), 'membershipId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'end a group membership');
  // Present-and-null reopens the stint; absent is a mistake here, not "leave it alone",
  // because there is nothing else this route could mean.
  if (!('leftAt' in body)) {
    throw new ApiRequestError(
      '"leftAt" is required — send a timestamp to end the stint, or null to reopen it.',
      'leftAt',
    );
  }
  const leftAt = optionalTimestamp(body, 'leftAt') ?? null;
  await endGroupMembership(deps.db, {
    membershipId,
    leftAt,
    audit: { actor, source: 'api POST /api/group-memberships/:membershipId/end' },
  });
  return jsonResponse(200, { membershipId, leftAt });
}

/* ------------------------------------------------------------------------- validation */

/** Spreads a key only when the value is present, so `exactOptionalPropertyTypes` holds. */
function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function parseAliases(body: Record<string, unknown>): readonly string[] | undefined {
  if (!('aliases' in body) || body['aliases'] === null) return undefined;
  const raw = body['aliases'];
  if (!Array.isArray(raw)) {
    throw new ApiRequestError('"aliases", when present, must be an array of strings.', 'aliases');
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ApiRequestError(`"aliases[${index}]" must be a non-empty string.`, 'aliases');
    }
    return entry;
  });
}

function parseMembers(
  body: Record<string, unknown>,
): readonly ReturnType<typeof asId<'person'>>[] | undefined {
  if (!('members' in body) || body['members'] === null) return undefined;
  const raw = body['members'];
  if (!Array.isArray(raw)) {
    throw new ApiRequestError('"members", when present, must be an array of person ids.', 'members');
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new ApiRequestError(`"members[${index}]" must be a person id.`, 'members');
    }
    return asId<'person'>(requireUuid(entry, `members[${index}]`));
  });
}
