/**
 * Single-user session authentication (audit row 50).
 *
 * The audit's wording is the requirement: *"Treat this as a real prerequisite before making
 * personal financial data available over a network; CORS and `actor: user` do not authenticate
 * callers."* This closes that. It is deliberately the smallest thing that actually
 * authenticates — one local person, a password, a session cookie — because
 * `security-model.md` scopes this system to one person's own machine and a multi-tenant
 * identity system would be a larger surface protecting the same single ledger.
 *
 * What it does not do, on purpose:
 *
 *  - **No password recovery flow.** There is no second channel to recover through; this is a
 *    local ledger, and a forgotten password is recovered by resetting it against the database
 *    with `scripts/set-password.ts`.
 *  - **No roles.** Everyone who can sign in is the ledger's one person. `actor` on a write
 *    still says *who*, and is now checked against the session rather than merely claimed.
 *
 * Passwords are hashed with scrypt from `node:crypto` — memory-hard, in the standard library,
 * no dependency. The stored form carries its own parameters and salt, so raising the cost
 * later does not invalidate existing hashes.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import {
  createSession as dbCreateSession,
  findValidSession,
  getPrimaryUserPerson,
  getUserByEmail,
  getUserById,
  revokeSession,
  setUserPasswordHash,
  touchSession,
} from '../db/index.js';
import type { Database, Executor } from '../db/index.js';
import type { PersonId, UserId } from '../domain/index.js';

import { runAudited, type AuditMeta } from './audit.js';
import { ServiceError } from './errors.js';

/**
 * `promisify(scrypt)` cannot see the options overload, so it is retyped here rather than
 * dropped: the options are what make this memory-hard, and calling the three-argument form
 * would silently use Node's defaults.
 */
const scryptAsync = promisify(scrypt) as unknown as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** scrypt parameters. `N` is the cost; raising it later is safe — hashes carry their own. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

/** How long a session lasts without being renewed. Long enough to be usable, short enough to lapse. */
export const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export interface SessionIdentity {
  readonly userId: UserId;
  readonly personId: PersonId;
  readonly email: string;
  readonly displayName: string;
  /** The actor string every audited write made in this session is attributed to. */
  readonly actor: string;
}

export interface SignInResult extends SessionIdentity {
  /**
   * The bearer token, returned **once** and never stored in this form.
   *
   * Only its SHA-256 hash reaches the database, for the same reason the password is hashed:
   * this database holds a person's entire financial life, and a stolen dump must not also be
   * a set of working credentials.
   */
  readonly token: string;
  readonly expiresAt: Date;
}

/* ------------------------------------------------------------------------- passwords */

/** `scrypt$<N>$<r>$<p>$<salt-hex>$<key-hex>` — self-describing, so the cost can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/** Constant-time comparison, so a wrong password cannot be narrowed down by timing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex!, 'hex');
  const expected = Buffer.from(keyHex!, 'hex');
  const derived = await scryptAsync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** The stored form of a session token. A token is a secret; its hash is a lookup key. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/* --------------------------------------------------------------------------- sign in */

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly audit?: AuditMeta;
}

/**
 * Signs a person in, or refuses.
 *
 * One failure message for both "no such account" and "wrong password", deliberately: telling
 * the two apart is an account-enumeration oracle, and there is nothing a legitimate user
 * learns from the distinction that they did not already know.
 */
export async function signIn(db: Database, input: SignInInput): Promise<SignInResult> {
  const user = await getUserByEmail(db, input.email.trim().toLowerCase());
  const refuse = (): never => {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      'That email and password do not match an account.',
    );
  };

  if (user === null || user.passwordHash === null) {
    // Still hash something, so a missing account and a wrong password take the same time.
    await hashPassword(input.password);
    return refuse();
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) return refuse();

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await dbCreateSession(db, {
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return {
    token,
    expiresAt,
    userId: user.id,
    personId: user.personId,
    email: user.email,
    displayName: user.displayName,
    actor: 'user',
  };
}

/**
 * Resolves a bearer token to the person it authenticates, or `null`.
 *
 * Expiry is enforced on read rather than by a sweeper: an expired row is dead the moment it is
 * looked at, whether or not anything has got round to deleting it.
 */
export async function resolveSession(db: Executor, token: string): Promise<SessionIdentity | null> {
  if (token.length === 0) return null;
  const session = await findValidSession(db, hashToken(token), new Date());
  if (session === null) return null;
  await touchSession(db, session.sessionId, new Date());
  return {
    userId: session.userId,
    personId: session.personId,
    email: session.email,
    displayName: session.displayName,
    actor: 'user',
  };
}

export async function signOut(db: Executor, token: string): Promise<void> {
  if (token.length === 0) return;
  await revokeSession(db, hashToken(token), new Date());
}

/* ------------------------------------------------------------------- setting a password */

export interface SetPasswordInput {
  readonly userId: UserId;
  readonly password: string;
  readonly audit: AuditMeta;
}

/**
 * Sets (or changes) the ledger user's password.
 *
 * Audited like every other consequential write, but the event records only that a password was
 * set — never the password, never the hash. An audit log that carried either would defeat the
 * point of hashing it (`security-model.md`).
 */
export async function setPassword(db: Database, input: SetPasswordInput): Promise<void> {
  if (input.password.length < 12) {
    throw new ServiceError(
      'PRECONDITION_FAILED',
      "A password for a ledger holding a person's entire financial history should be at " +
        'least 12 characters. This is the only barrier between it and anyone who reaches ' +
        'the port it listens on.',
      { field: 'password' },
    );
  }
  const passwordHash = await hashPassword(input.password);
  await runAudited(db, input.audit, async ({ exec, record }) => {
    await setUserPasswordHash(exec, input.userId, passwordHash);
    await record({
      entityType: 'person',
      entityId: input.userId,
      action: 'update',
      newValue: { passwordSet: true },
    });
  });
}

/**
 * Whether any account can be signed into yet — what a first-run screen needs to know.
 *
 * False on a fresh installation, and false again if somebody clears the hash. A surface uses
 * it to offer "set a password" instead of "sign in"; it never grants access on its own.
 */
export async function isAuthenticationConfigured(db: Executor): Promise<boolean> {
  const userPerson = await getPrimaryUserPerson(db);
  if (userPerson === null) return false;
  const user = await getUserById(db, userPerson.userId);
  return user !== null && user.passwordHash !== null;
}
