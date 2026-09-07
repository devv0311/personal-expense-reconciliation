/**
 * Onboarding and master data end to end (audit row 48).
 *
 * The point of these tests is that a fresh installation can be *populated* through the API —
 * people, accounts, merchants with the aliases normalization actually matches on, groups with
 * real membership stints — and that the guards that keep master data honest hold: no duplicate
 * person, no two people sharing one Splitwise account, no full card number, no overlapping
 * membership stints, and archival instead of deletion.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { schema } from '../../src/db/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';

let database: TestDatabase;
let api: Api;
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
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  });
});

async function post(path: string, body: unknown): Promise<Response> {
  return api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await api.handle(new Request(`${BASE}${path}`));
  return (await response.json()) as T;
}

describe('people management', () => {
  it('adds a person and lists them, archived people included', async () => {
    const created = await post('/api/people', { actor: 'user', displayName: 'Neighbour Raj' });
    expect(created.status).toBe(201);
    const { person } = (await created.json()) as { person: { id: string; displayName: string } };
    expect(person.displayName).toBe('Neighbour Raj');

    const body = await getJson<{ people: Array<Record<string, unknown>> }>('/api/people/manage');
    expect(body.people.some((entry) => entry['id'] === person.id)).toBe(true);
    expect(body.people.find((entry) => entry['id'] === cast.userPersonId)?.['isUser']).toBe(true);
  });

  it('refuses a second person with the same name', async () => {
    await post('/api/people', { actor: 'user', displayName: 'Neighbour Raj' });
    const again = await post('/api/people', { actor: 'user', displayName: 'Neighbour Raj' });
    expect(again.status).toBe(409);
  });

  it('maps a person to Splitwise and refuses to map a second person to the same account', async () => {
    const mapped = await post(`/api/people/${cast.person['person_friend_a']!}`, {
      actor: 'user',
      splitwiseUserId: 'sw-901',
    });
    expect(mapped.status).toBe(200);

    const clash = await post(`/api/people/${cast.person['person_friend_b']!}`, {
      actor: 'user',
      splitwiseUserId: 'sw-901',
    });
    expect(clash.status).toBe(409);

    const unmapped = await post(`/api/people/${cast.person['person_friend_a']!}`, {
      actor: 'user',
      splitwiseUserId: null,
    });
    expect(unmapped.status).toBe(200);
    const body = await getJson<{ people: Array<Record<string, unknown>> }>('/api/people/manage');
    expect(
      body.people.find((entry) => entry['id'] === cast.person['person_friend_a'])?.[
        'splitwiseUserId'
      ],
    ).toBeNull();
  });

  it('archives rather than deletes, and refuses to archive the ledger user', async () => {
    const archived = await post(`/api/people/${cast.person['person_friend_b']!}`, {
      actor: 'user',
      archived: true,
    });
    expect(archived.status).toBe(200);
    const rows = await database.db
      .select()
      .from(schema.people)
      .where(eq(schema.people.id, cast.person['person_friend_b']!));
    expect(rows[0]?.archivedAt).not.toBeNull();

    const refused = await post(`/api/people/${cast.userPersonId}`, {
      actor: 'user',
      archived: true,
    });
    expect(refused.status).toBe(409);
  });

  it('writes an audit event for every change', async () => {
    const created = await post('/api/people', { actor: 'user', displayName: 'Auditable Person' });
    const { person } = (await created.json()) as { person: { id: string } };
    const events = await database.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, person.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityType: 'person', action: 'create', actor: 'user' });
  });
});

describe('account management', () => {
  it('creates an account owned by the ledger user', async () => {
    const response = await post('/api/accounts', {
      actor: 'user',
      name: 'Salary account',
      type: 'bank',
      institution: 'Test Bank',
      last4: '4321',
    });
    expect(response.status).toBe(201);
    const { accountId } = (await response.json()) as { accountId: string };

    const accounts = await getJson<{ accounts: Array<Record<string, unknown>> }>('/api/accounts');
    expect(accounts.accounts.find((entry) => entry['id'] === accountId)).toMatchObject({
      name: 'Salary account',
      last4: '4321',
    });
  });

  it('refuses anything longer than a four-digit tail', async () => {
    const response = await post('/api/accounts', {
      actor: 'user',
      name: 'Card',
      type: 'card',
      last4: '4111111111111111',
    });
    expect(response.status).toBe(409);
  });

  it('closes an account without removing it from the roster', async () => {
    const created = await post('/api/accounts', {
      actor: 'user',
      name: 'Old wallet',
      type: 'wallet',
    });
    const { accountId } = (await created.json()) as { accountId: string };

    const closed = await post(`/api/accounts/${accountId}`, { actor: 'user', archived: true });
    expect(closed.status).toBe(200);

    const accounts = await getJson<{ accounts: Array<Record<string, unknown>> }>('/api/accounts');
    const row = accounts.accounts.find((entry) => entry['id'] === accountId);
    expect(row?.['archivedAt']).not.toBeNull();
    expect(row?.['isActive']).toBe(false);
  });
});

describe('merchant catalog', () => {
  it('creates a merchant with aliases normalized to the key normalization matches on', async () => {
    const response = await post('/api/merchants', {
      actor: 'user',
      canonicalName: 'Third Wave Coffee',
      defaultCategory: 'food',
      aliases: ['  third   wave coffee roasters '],
    });
    expect(response.status).toBe(201);

    const body = await getJson<{
      merchants: Array<{ id: string; canonicalName: string; aliases: { rawPattern: string }[] }>;
    }>('/api/merchants');
    const merchant = body.merchants.find((entry) => entry.canonicalName === 'Third Wave Coffee');
    expect(merchant?.aliases.map((alias) => alias.rawPattern)).toEqual([
      'THIRD WAVE COFFEE ROASTERS',
    ]);
  });

  it('refuses one alias resolving to two merchants', async () => {
    const first = await post('/api/merchants', {
      actor: 'user',
      canonicalName: 'Merchant One',
      aliases: ['SHARED NARRATION'],
    });
    const { merchantId } = (await first.json()) as { merchantId: string };
    expect(merchantId).toBeTruthy();

    const second = await post('/api/merchants', { actor: 'user', canonicalName: 'Merchant Two' });
    const { merchantId: otherId } = (await second.json()) as { merchantId: string };
    const clash = await post(`/api/merchants/${otherId}/aliases`, {
      actor: 'user',
      rawPattern: 'shared narration',
    });
    expect(clash.status).toBe(409);
  });
});

describe('groups and membership stints', () => {
  it('creates a group with founding members and lists their stints', async () => {
    const response = await post('/api/groups', {
      actor: 'user',
      name: 'Book club',
      type: 'social',
      members: [cast.userPersonId, cast.person['person_friend_a']!],
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(response.status).toBe(201);
    const { groupId } = (await response.json()) as { groupId: string };

    const body = await getJson<{
      groups: Array<{ id: string; name: string; memberships: { personId: string }[] }>;
    }>('/api/groups');
    const group = body.groups.find((entry) => entry.id === groupId);
    expect(group?.memberships.map((membership) => membership.personId).sort()).toEqual(
      [cast.userPersonId, cast.person['person_friend_a']!].sort(),
    );
  });

  it('refuses an overlapping stint and accepts a re-join after the first ends', async () => {
    const created = await post('/api/groups', { actor: 'user', name: 'Trip' });
    const { groupId } = (await created.json()) as { groupId: string };

    const joined = await post(`/api/groups/${groupId}/members`, {
      actor: 'user',
      personId: cast.person['person_friend_a']!,
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(joined.status).toBe(201);
    const { membershipId } = (await joined.json()) as { membershipId: string };

    const overlapping = await post(`/api/groups/${groupId}/members`, {
      actor: 'user',
      personId: cast.person['person_friend_a']!,
      joinedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(overlapping.status).toBe(409);

    const ended = await post(`/api/group-memberships/${membershipId}/end`, {
      actor: 'user',
      leftAt: '2026-01-31T00:00:00.000Z',
    });
    expect(ended.status).toBe(200);

    const rejoined = await post(`/api/groups/${groupId}/members`, {
      actor: 'user',
      personId: cast.person['person_friend_a']!,
      joinedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(rejoined.status).toBe(201);

    const body = await getJson<{
      groups: Array<{ id: string; memberships: { joinedAt: string; leftAt: string | null }[] }>;
    }>('/api/groups');
    const stints = body.groups.find((entry) => entry.id === groupId)?.memberships ?? [];
    expect(stints).toHaveLength(2);
    expect(stints[0]?.leftAt).not.toBeNull();
    expect(stints[1]?.leftAt).toBeNull();
  });

  it('refuses a membership that ends before it starts', async () => {
    const created = await post('/api/groups', { actor: 'user', name: 'Backwards' });
    const { groupId } = (await created.json()) as { groupId: string };
    const joined = await post(`/api/groups/${groupId}/members`, {
      actor: 'user',
      personId: cast.person['person_friend_a']!,
      joinedAt: '2026-05-01T00:00:00.000Z',
    });
    const { membershipId } = (await joined.json()) as { membershipId: string };

    const response = await post(`/api/group-memberships/${membershipId}/end`, {
      actor: 'user',
      leftAt: '2026-04-01T00:00:00.000Z',
    });
    expect(response.status).toBe(409);
  });
});

describe('actor discipline', () => {
  it('refuses a write claiming to be the model', async () => {
    const response = await post('/api/people', { actor: 'ai', displayName: 'Model-created' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
  });
});
