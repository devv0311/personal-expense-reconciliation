/**
 * Session authentication end to end (audit row 50).
 *
 * The audit's finding was that nothing authenticated a caller: *"CORS and `actor: user` do not
 * authenticate callers."* These tests assert that the door is real — that a protected route
 * refuses without a session, accepts with one, and that the session routes themselves stay
 * reachable so a first run is possible at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAiService } from '../../src/ai/index.js';
import { createApi } from '../../src/api/index.js';
import type { Api } from '../../src/api/index.js';
import { hashPassword, verifyPassword } from '../../src/services/index.js';
import { schema, setUserPasswordHash } from '../../src/db/index.js';
import { scriptedClassificationTransport } from '../support/ai.js';
import { createTestDatabase } from '../support/database.js';
import type { TestDatabase } from '../support/database.js';
import { createMemoryEvidenceStore } from '../support/evidence-store.js';
import { seedCast } from '../support/ledger.js';
import type { Cast } from '../support/ledger.js';
import { createMockSplitwisePort } from '../support/splitwise.js';

const BASE = 'http://localhost';
const PASSWORD = 'a-long-enough-password';

let database: TestDatabase;
let cast: Cast;
/** The API as a networked deployment runs it: authentication enforced. */
let guarded: Api;
/** The API as a purely local run may be configured: the door open. */
let open: Api;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.truncateAll();
  cast = await seedCast(database.db);
  const deps = {
    db: database.db,
    ai: createAiService(scriptedClassificationTransport({ people: cast.person })),
    evidenceStore: createMemoryEvidenceStore(),
    splitwise: createMockSplitwisePort(),
  };
  guarded = createApi({ ...deps, authRequired: true });
  open = createApi(deps);
});

function post(api: Api, path: string, body: unknown, token?: string): Promise<Response> {
  return api.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  );
}

function get(api: Api, path: string, token?: string): Promise<Response> {
  return api.handle(
    new Request(`${BASE}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );
}

async function signInAs(): Promise<string> {
  await setUserPasswordHash(database.db, cast.userId, await hashPassword(PASSWORD));
  const response = await post(guarded, '/api/session', {
    email: 'dev@example.test',
    password: PASSWORD,
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie') ?? '';
  const match = /ledger_session=([^;]+)/.exec(cookie);
  expect(match).not.toBeNull();
  return decodeURIComponent(match![1]!);
}

describe('password hashing', () => {
  it('round-trips a password without storing it', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword('not the password', stored)).toBe(false);
  });

  it('produces a different hash each time, so two identical passwords do not match on sight', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(first).not.toBe(second);
  });
});

describe('the door', () => {
  it('refuses a protected route without a session', async () => {
    const response = await get(guarded, '/api/expenses');
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('refuses a protected write without a session', async () => {
    const response = await post(guarded, '/api/people', {
      actor: 'user',
      displayName: 'Should not exist',
    });
    expect(response.status).toBe(401);
  });

  it('lets the session routes through, so a first run is possible', async () => {
    const status = await get(guarded, '/api/session');
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      session: unknown;
      authenticationConfigured: boolean;
      authenticationRequired: boolean;
    };
    expect(body.session).toBeNull();
    expect(body.authenticationConfigured).toBe(false);
    expect(body.authenticationRequired).toBe(true);
  });

  it('admits a request carrying a valid session', async () => {
    const token = await signInAs();
    const response = await get(guarded, '/api/expenses', token);
    expect(response.status).toBe(200);
  });

  it('admits a request carrying the session cookie', async () => {
    const token = await signInAs();
    const response = await guarded.handle(
      new Request(`${BASE}/api/expenses`, {
        headers: { cookie: `ledger_session=${encodeURIComponent(token)}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('stops admitting a session after it is ended', async () => {
    const token = await signInAs();
    expect((await get(guarded, '/api/expenses', token)).status).toBe(200);

    const out = await post(guarded, '/api/session/end', {}, token);
    expect(out.status).toBe(200);
    expect((await get(guarded, '/api/expenses', token)).status).toBe(401);
  });

  it('refuses a token that was never issued', async () => {
    const response = await get(guarded, '/api/expenses', 'not-a-real-token');
    expect(response.status).toBe(401);
  });

  it('leaves every route open when the process is not enforcing authentication', async () => {
    // A purely local run may deliberately not enforce it; the report says so plainly rather
    // than implying a lock that is not there.
    expect((await get(open, '/api/expenses')).status).toBe(200);
    const status = await get(open, '/api/session');
    const body = (await status.json()) as { authenticationRequired: boolean };
    expect(body.authenticationRequired).toBeFalsy();
  });
});

describe('signing in', () => {
  it('refuses the wrong password with the same message as an unknown account', async () => {
    await setUserPasswordHash(database.db, cast.userId, await hashPassword(PASSWORD));

    const wrongPassword = await post(guarded, '/api/session', {
      email: 'dev@example.test',
      password: 'wrong',
    });
    const unknownAccount = await post(guarded, '/api/session', {
      email: 'nobody@example.test',
      password: PASSWORD,
    });

    expect(wrongPassword.status).toBe(409);
    expect(unknownAccount.status).toBe(409);
    const first = (await wrongPassword.json()) as { error: { message: string } };
    const second = (await unknownAccount.json()) as { error: { message: string } };
    // Identical, deliberately: telling the two apart is an account-enumeration oracle.
    expect(first.error.message).toBe(second.error.message);
  });

  it('never returns the token in the body — only as an HttpOnly cookie', async () => {
    await setUserPasswordHash(database.db, cast.userId, await hashPassword(PASSWORD));
    const response = await post(guarded, '/api/session', {
      email: 'dev@example.test',
      password: PASSWORD,
    });
    const body = (await response.json()) as { session: Record<string, unknown> };
    expect(body.session['token']).toBeUndefined();
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });
});

describe('setting a password', () => {
  it('sets one on a fresh installation with no session', async () => {
    const response = await post(open, '/api/session/password', { password: PASSWORD });
    expect(response.status).toBe(201);

    const status = await get(open, '/api/session');
    const body = (await status.json()) as { authenticationConfigured: boolean };
    expect(body.authenticationConfigured).toBe(true);
  });

  it('requires a session to change one that already exists', async () => {
    await post(open, '/api/session/password', { password: PASSWORD });
    const response = await post(open, '/api/session/password', { password: 'another-password' });
    expect(response.status).toBe(400);
  });

  it('changes it for a signed-in person', async () => {
    const token = await signInAs();
    const response = await post(
      guarded,
      '/api/session/password',
      { password: 'a-different-long-password' },
      token,
    );
    expect(response.status).toBe(200);

    const signedIn = await post(guarded, '/api/session', {
      email: 'dev@example.test',
      password: 'a-different-long-password',
    });
    expect(signedIn.status).toBe(200);
  });

  it('refuses a password short enough to be guessed', async () => {
    const response = await post(open, '/api/session/password', { password: 'short' });
    expect(response.status).toBe(409);
  });

  it('records that a password was set, and never the password or its hash', async () => {
    await post(open, '/api/session/password', { password: PASSWORD });

    const events = await database.db.select().from(schema.auditEvents);
    const passwordEvents = events.filter((event) =>
      JSON.stringify(event.newValue).includes('passwordSet'),
    );
    expect(passwordEvents).toHaveLength(1);
    expect(passwordEvents[0]?.newValue).toEqual({ passwordSet: true });

    // The assertion that matters is textual: the secret appears nowhere in the log at all.
    // `sequence` is a bigint, which `JSON.stringify` refuses — the same replacer the API uses.
    const serialized = JSON.stringify(events, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('scrypt$');
  });
});
