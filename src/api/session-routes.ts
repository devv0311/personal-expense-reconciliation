/**
 * Sign in, sign out, and who is signed in (audit row 50).
 *
 * ```
 * GET  /api/session          who this request authenticates as, or `null`
 * POST /api/session          sign in
 * POST /api/session/end      sign out
 * POST /api/session/password set the ledger user's password (first run, or a change)
 * ```
 *
 * The token travels as `Authorization: Bearer <token>` **and** as an `HttpOnly` cookie. The
 * cookie is what a browser uses — a token in `localStorage` is readable by any script that
 * ends up on the page, and this is a person's whole financial history. The header exists so a
 * script or a test can authenticate without a cookie jar.
 *
 * `requireSession` in `router.ts` is what actually protects the other routes. This file only
 * establishes and ends a session.
 */

import { getPrimaryUserPerson } from '../db/index.js';
import {
  isAuthenticationConfigured,
  resolveSession,
  setPassword,
  signIn,
  signOut,
} from '../services/index.js';

import { ApiRequestError, jsonResponse, readJsonObject, requireString } from './http.js';
import type { ApiDependencies } from './router.js';

/** The cookie a browser holds the session in. `HttpOnly`, so no script can read it. */
export const SESSION_COOKIE = 'ledger_session';

/** Reads the bearer token from the header or the cookie, in that order. */
export function readSessionToken(request: Request): string {
  const header = request.headers.get('authorization');
  if (header !== null && /^bearer /i.test(header)) {
    return header.slice(7).trim();
  }
  const cookies = request.headers.get('cookie');
  if (cookies === null) return '';
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function sessionCookie(token: string, expiresAt: Date): string {
  // `SameSite=Lax` rather than `Strict`: `web/` runs on its own origin and navigates here, and
  // `Strict` would drop the cookie on that first navigation. `Secure` is omitted because a
  // local deployment is plain HTTP on localhost, where `Secure` would make the cookie unusable;
  // a networked deployment terminates TLS in front of this process and should add it there.
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ].join('; ');
}

/**
 * `GET /api/session` — who this request authenticates as.
 *
 * Also reports `authenticationConfigured`, so a first-run screen can offer "set a password"
 * rather than a sign-in form nobody can satisfy. Never 401s: "nobody is signed in" is the
 * answer to this question, not a failure to answer it.
 */
export async function getSessionRoute(deps: ApiDependencies, request: Request): Promise<Response> {
  const [identity, configured] = await Promise.all([
    resolveSession(deps.db, readSessionToken(request)),
    isAuthenticationConfigured(deps.db),
  ]);
  return jsonResponse(200, {
    session: identity,
    authenticationConfigured: configured,
    // Whether this process is *enforcing* authentication. A local run may deliberately not be
    // (`AUTH_REQUIRED=false`), and a surface should say so rather than implying a lock that
    // is not there.
    authenticationRequired: deps.authRequired,
  });
}

/** `POST /api/session` — sign in. Body: `{ email, password }`. */
export async function postSignIn(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const result = await signIn(deps.db, {
    email: requireString(body, 'email'),
    password: requireString(body, 'password'),
  });

  const { token, ...identity } = result;
  return new Response(JSON.stringify({ session: identity, expiresAt: result.expiresAt }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': sessionCookie(token, result.expiresAt),
    },
  });
}

/** `POST /api/session/end` — sign out, and clear the cookie. */
export async function postSignOut(deps: ApiDependencies, request: Request): Promise<Response> {
  await signOut(deps.db, readSessionToken(request));
  return new Response(JSON.stringify({ signedOut: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

/**
 * `POST /api/session/password` — set the ledger user's password.
 *
 * Body: `{ password, currentPassword? }`. On a fresh installation with no password set, this
 * is the first-run step and needs no current password — there is nobody to authenticate as
 * yet, and requiring one would make the ledger permanently unreachable. Once a password
 * exists, changing it requires signing in first: the session is the proof.
 */
export async function postSetPassword(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const password = requireString(body, 'password');

  const configured = await isAuthenticationConfigured(deps.db);
  if (configured) {
    const identity = await resolveSession(deps.db, readSessionToken(request));
    if (identity === null) {
      throw new ApiRequestError(
        'Changing the password requires being signed in. Sign in first, or reset it against ' +
          'the database with scripts/set-password.ts if it has been lost.',
      );
    }
    await setPassword(deps.db, {
      userId: identity.userId,
      password,
      audit: { actor: identity.actor, source: 'api POST /api/session/password' },
    });
    return jsonResponse(200, { passwordSet: true });
  }

  const userPerson = await getPrimaryUserPerson(deps.db);
  if (userPerson === null) {
    throw new ApiRequestError(
      'This ledger has no user yet, so there is no account to set a password on. Seed one ' +
        'first (scripts/seed-dev-data.ts, or the onboarding flow).',
    );
  }
  await setPassword(deps.db, {
    userId: userPerson.userId,
    password,
    audit: { actor: 'user', source: 'api POST /api/session/password (first run)' },
  });
  return jsonResponse(201, { passwordSet: true });
}
