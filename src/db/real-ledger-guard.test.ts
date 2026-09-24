/**
 * The refusal that stands between a synthetic tool and the owner's own records.
 *
 * Every path in this file is invented or a temporary directory. Nothing here opens a database,
 * and nothing here names a real merchant, amount, account or file — the guard's whole subject is
 * a directory name, and the only real one it needs is the literal `local-data/pglite-dev`, which
 * `scripts/seed-dev-data.ts` has carried in the open since phase 15.
 */

import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REAL_LEDGER_DIR,
  REAL_PORTS,
  RealLedgerRefusal,
  assertSyntheticLedger,
  assertSyntheticPort,
  isRealLedgerPath,
  resolveSyntheticTarget,
} from './real-ledger-guard.js';

/** A stand-in repository root. The guard never reads it unless a path actually exists. */
const REPO = '/repo';

describe('recognising the real ledger', () => {
  it('matches it however the path is spelled', () => {
    // The four spellings a person or a script actually produces: the literal from the seed
    // script's own default, a bare relative path, an absolute one, and one with a trailing
    // separator. A guard that only caught the first would have caught nothing.
    for (const spelling of [
      './local-data/pglite-dev',
      'local-data/pglite-dev',
      resolve(REPO, 'local-data/pglite-dev'),
      `${resolve(REPO, 'local-data/pglite-dev')}/`,
      resolve(REPO, 'local-data/../local-data/pglite-dev'),
    ]) {
      expect(isRealLedgerPath(spelling, REPO)).toBe(true);
    }
  });

  it('matches something inside it', () => {
    expect(isRealLedgerPath(resolve(REPO, 'local-data/pglite-dev/base'), REPO)).toBe(true);
  });

  it('matches a preserved copy, which is just as real', () => {
    // The restore came from one of these. A synthetic tool seeding into a backup would destroy
    // the recovery point rather than the ledger — the same loss, harder to notice.
    for (const copy of [
      'local-data/pglite-dev.before-gst-fix-20260919-063845',
      'local-data/pglite-dev.superseded-20260917-163713',
      'local-data/pglite-dev.UNOPENABLE-torn-wal-20260919-113143',
    ]) {
      expect(isRealLedgerPath(copy, REPO)).toBe(true);
    }
  });

  it('does not match a scratch directory that merely sits nearby', () => {
    for (const scratch of [
      '/tmp/qa/qa-db',
      resolve(REPO, 'local-data/qa-db'),
      resolve(REPO, 'local-data/pglite-qa'),
      // A sibling whose name *starts* the same but is a different directory, not a `.`-suffixed
      // copy of it. `pglite-dev2` is not `pglite-dev.<label>`.
      resolve(REPO, 'local-data/pglite-dev2'),
    ]) {
      expect(isRealLedgerPath(scratch, REPO)).toBe(false);
    }
  });

  it('sees through a symlink pointing at the real ledger', () => {
    // The one evasion path arithmetic alone cannot catch, so it is resolved on disk when the
    // path exists. A scratch directory that is secretly a link to the ledger is exactly the
    // accident a hurried QA setup produces.
    const root = mkdtempSync(join(tmpdir(), 'ledger-guard-'));
    mkdirSync(join(root, 'local-data', 'pglite-dev'), { recursive: true });
    const link = join(root, 'looks-synthetic');
    symlinkSync(join(root, 'local-data', 'pglite-dev'), link);

    expect(isRealLedgerPath(link, root)).toBe(true);
  });
});

describe('what a synthetic tool is allowed to open', () => {
  it('refuses an unset target, because unset means the real ledger', () => {
    // The actual failure mode. Nobody types the real path; they forget one variable, and the
    // seed script's `?? './local-data/pglite-dev'` supplies it for them.
    for (const missing of [undefined, '', '   ']) {
      expect(() =>
        assertSyntheticLedger({ dataDir: missing, repoRoot: REPO, tool: 'scripts/seed-dev-data' }),
      ).toThrow(RealLedgerRefusal);
    }
  });

  it('names the variable to set rather than only saying no', () => {
    expect(() =>
      assertSyntheticLedger({ dataDir: undefined, repoRoot: REPO, tool: 'scripts/seed-dev-data' }),
    ).toThrow(/PGLITE_DATA_DIR/);
  });

  it('refuses the real ledger and says which path it objected to', () => {
    expect(() =>
      assertSyntheticLedger({
        dataDir: `./${REAL_LEDGER_DIR}`,
        repoRoot: REPO,
        tool: 'scripts/seed-dev-data',
      }),
    ).toThrow(/refuses to run against the real ledger/);
  });

  it('allows a scratch directory', () => {
    expect(() =>
      assertSyntheticLedger({
        dataDir: '/tmp/qa/qa-db',
        repoRoot: REPO,
        tool: 'scripts/seed-dev-data',
      }),
    ).not.toThrow();
  });
});

describe('what a synthetic server is allowed to bind', () => {
  it('refuses every port the real stack uses', () => {
    for (const port of REAL_PORTS) {
      expect(() => assertSyntheticPort(port, 'qa server')).toThrow(RealLedgerRefusal);
    }
  });

  it('allows the ports the QA procedure actually uses', () => {
    for (const port of [3001, 4001, 4002]) {
      expect(() => assertSyntheticPort(port, 'qa server')).not.toThrow();
    }
  });

  it('keeps the two stacks on different ports, which is what tells them apart', () => {
    // Stated as a test because three separate procedures depend on it: the QA setup, the
    // network-log check before any screenshot, and the stop-by-port procedure that replaced
    // the pattern kill.
    expect(REAL_PORTS).not.toContain(3001);
    expect(REAL_PORTS).not.toContain(4001);
  });
});

describe('choosing a database at all', () => {
  const TOOL = 'scripts/seed-dev-data';
  const resolve_ = (env: Record<string, string | undefined>) =>
    resolveSyntheticTarget(env, REPO, TOOL);

  it('refuses DATABASE_URL outright, whatever it points at', () => {
    // The gap this closes. `assertSyntheticLedger` guarded the PGlite path while the Postgres
    // branch beside it read DATABASE_URL and connected unchecked — so the guarded tool had an
    // unguarded door. The value is deliberately not inspected: a connection string cannot be
    // read to tell whether the database behind it matters.
    for (const url of [
      'postgres://localhost:5432/anything',
      'postgresql://user:pw@db.internal:5432/production',
      'postgres://127.0.0.1:5432/scratch_looks_harmless',
    ]) {
      expect(() => resolve_({ DATABASE_URL: url })).toThrow(RealLedgerRefusal);
    }
  });

  it('refuses DATABASE_URL even when a synthetic URL is also set', () => {
    // An ambient DATABASE_URL means the shell is configured for something else. Letting the
    // opt-in override it would make the refusal advisory, which is not a refusal.
    expect(() =>
      resolve_({
        DATABASE_URL: 'postgres://localhost:5432/anything',
        SYNTHETIC_DATABASE_URL: 'postgres://localhost:5432/scratch',
      }),
    ).toThrow(RealLedgerRefusal);
  });

  it('tells the reader how to unset it and how to opt in on purpose', () => {
    expect(() => resolve_({ DATABASE_URL: 'postgres://localhost:5432/x' })).toThrow(
      /unset DATABASE_URL/,
    );
    expect(() => resolve_({ DATABASE_URL: 'postgres://localhost:5432/x' })).toThrow(
      /SYNTHETIC_DATABASE_URL/,
    );
  });

  it('ignores an empty or whitespace DATABASE_URL rather than treating it as a target', () => {
    // An exported-but-blank variable is how a shell profile often leaves it; it names no
    // database, so it is neither a refusal nor a target.
    for (const blank of ['', '   ']) {
      expect(resolve_({ DATABASE_URL: blank, PGLITE_DATA_DIR: '/tmp/qa/qa-db' })).toEqual({
        kind: 'pglite',
        dataDir: '/tmp/qa/qa-db',
      });
    }
  });

  it('accepts Postgres under the name nothing but a person sets', () => {
    expect(resolve_({ SYNTHETIC_DATABASE_URL: 'postgres://localhost:5432/scratch' })).toEqual({
      kind: 'postgres',
      connectionString: 'postgres://localhost:5432/scratch',
    });
  });

  it('never falls back to the ledger when the synthetic URL is blank', () => {
    // The failure mode worth naming: an opt-in that silently degrades to the default is the
    // original bug wearing a new variable name.
    expect(() => resolve_({ SYNTHETIC_DATABASE_URL: '  ' })).toThrow(RealLedgerRefusal);
  });

  it('still guards the PGlite path it always guarded', () => {
    expect(() => resolve_({})).toThrow(RealLedgerRefusal);
    expect(() => resolve_({ PGLITE_DATA_DIR: `./${REAL_LEDGER_DIR}` })).toThrow(RealLedgerRefusal);
    expect(resolve_({ PGLITE_DATA_DIR: '/tmp/qa/qa-db' })).toEqual({
      kind: 'pglite',
      dataDir: '/tmp/qa/qa-db',
    });
  });

  it('returns a description rather than a connection, so nothing can be opened first', () => {
    // Structural, and the reason this is one function rather than two asserts at two call sites:
    // there is no branch in which a database is reached before the refusals have run.
    const target = resolve_({ SYNTHETIC_DATABASE_URL: 'postgres://localhost:5432/scratch' });
    expect(Object.keys(target).sort()).toEqual(['connectionString', 'kind']);
  });
});
