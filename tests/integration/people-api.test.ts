import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';

import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { createAiService } from '../../src/ai/index.js';
import { schema } from '../../src/db/index.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import type { MemoryEvidenceStore } from '../support/evidence-store.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';

let database: TestDatabase;
let store: MemoryEvidenceStore;
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
  store = createMemoryEvidenceStore();
  cast = await seedCast(database.db);
  api = createApi({
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: store,
    splitwise: createMockSplitwisePort(),
  });
});

describe('GET /api/people', () => {
  it('lists everyone not archived, flagging the user', async () => {
    const response = await api.handle(new Request(`${BASE}/api/people`));
    const body = (await response.json()) as { people: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    const dev = body.people.find((person) => person['id'] === cast.userPersonId);
    expect(dev).toMatchObject({ displayName: 'Dev', isUser: true });
    const friend = body.people.find((person) => person['id'] === cast.person['person_friend_a']);
    expect(friend).toMatchObject({ isUser: false });
  });

  it('surfaces splitwiseUserId once linked', async () => {
    await database.db
      .update(schema.people)
      .set({ splitwiseUserId: 'sw-friend-a' })
      .where(eq(schema.people.id, cast.person['person_friend_a']!));

    const response = await api.handle(new Request(`${BASE}/api/people`));
    const body = (await response.json()) as { people: Array<Record<string, unknown>> };
    const friend = body.people.find((person) => person['id'] === cast.person['person_friend_a']);
    expect(friend?.['splitwiseUserId']).toBe('sw-friend-a');
  });

  it('excludes an archived person', async () => {
    await database.db
      .update(schema.people)
      .set({ archivedAt: new Date() })
      .where(eq(schema.people.id, cast.person['person_friend_a']!));

    const response = await api.handle(new Request(`${BASE}/api/people`));
    const body = (await response.json()) as { people: Array<Record<string, unknown>> };
    expect(body.people.some((person) => person['id'] === cast.person['person_friend_a'])).toBe(
      false,
    );
  });
});
