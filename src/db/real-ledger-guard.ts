/**
 * A refusal, so a synthetic tool can never open the real ledger.
 *
 * On 19 September 2026 a teardown of a synthetic QA stack ran `pkill -f "tsx src/server.ts"`.
 * Both stacks run that identical command, so it matched the real API too. PGlite died mid-write,
 * its WAL checkpoint was left torn, and the directory has not opened since — PGlite ships no
 * `pg_resetwal`, so there is no second chance. Two recorded decisions went with it.
 *
 * Two separate things went wrong and this file addresses the quieter one.
 *
 * The loud one was the kill: the fix for that is procedural and lives in
 * `docs/testing/process-isolation.md` and in `local-data/stop-real.sh` — stop a stack by the pid
 * that holds its port, or by its own process group, never by a pattern that both stacks match.
 *
 * The quiet one is that **every synthetic tool in this repository defaults to the real ledger.**
 * `scripts/seed-dev-data.ts` reads `process.env.PGLITE_DATA_DIR ?? './local-data/pglite-dev'`,
 * so forgetting one environment variable points a seeding script at the user's own records, and
 * `createPgliteDatabase` then calls `mkdirSync(…, { recursive: true })` and `migrate()` against
 * them. The "a `User` already exists, so do nothing" check that stands in front of it is a
 * *second* line, not a first: it runs after the database is open and the migrations have gone in.
 *
 * So the rule here is the inverse of a default. **A synthetic tool must name a target that is
 * demonstrably not the real ledger, or it does not run at all.** Nothing in this file writes,
 * reads, opens or repairs a database; it compares two paths and throws.
 *
 * It is deliberately not wired into `src/db/client.ts`. The real server is *supposed* to open the
 * real ledger, and a guard that both the real launcher and the synthetic tools had to negotiate
 * would be a guard with an override — which is the kind that gets passed by reflex.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Where the real ledger lives, relative to the repository root.
 *
 * Duplicated from `local-data/real-ledger.env` rather than read from it, on purpose: that file is
 * private local configuration that is absent on a fresh clone and in CI, and a guard that cannot
 * load its own definition of "the thing to refuse" would have to fail open. This is a path, not a
 * secret — `scripts/seed-dev-data.ts` has carried the same literal since phase 15.
 */
export const REAL_LEDGER_DIR = 'local-data/pglite-dev';

/**
 * The ports the real stack listens on (`local-data/start-real.sh`).
 *
 * A synthetic stack that binds one of these is not merely confusing: the two are told apart by
 * port everywhere else — in the QA procedure, in the browser's network log, and in the stop
 * procedure that replaced the pattern kill. A QA server on 4000 would make all three lie.
 */
export const REAL_PORTS: readonly number[] = [3000, 4000];

/** What a refusal says it was protecting, so the message names the caller's own situation. */
export interface SyntheticTarget {
  /** The resolved PGlite data directory a tool is about to open, or `undefined` if it defaulted. */
  readonly dataDir: string | undefined;
  /** The repository root the relative `REAL_LEDGER_DIR` is resolved against. */
  readonly repoRoot: string;
  /** The tool being guarded, named the way its operator invoked it. */
  readonly tool: string;
}

/**
 * Thrown instead of opening the real ledger. A distinct class so a caller (and a test) can tell
 * this refusal apart from a database that merely failed to open.
 */
export class RealLedgerRefusal extends Error {
  override readonly name = 'RealLedgerRefusal';
}

/**
 * Canonicalises a path far enough that the obvious evasions compare equal.
 *
 * `./local-data/pglite-dev`, `local-data/pglite-dev/`, an absolute spelling of the same place and
 * a route through `..` all resolve to one string. `realpathSync` additionally collapses a symlink
 * — the one evasion pure path arithmetic cannot see — and is allowed to fail, because a synthetic
 * target legitimately may not exist yet; in that case the lexical form is the best available
 * answer and is still enough to catch every accident this guard was written for.
 */
function canonical(candidate: string, base: string): string {
  // Resolved against `base` rather than `process.cwd()`, and that is the load-bearing part. A
  // relative `PGLITE_DATA_DIR` is resolved by PGlite against the working directory of whatever
  // process opened it, so a guard that used its *own* cwd would agree with reality only by
  // coincidence — and would disagree the moment a tool ran from a subdirectory. Callers pass the
  // repository root, which is where every entry point in this repo is invoked from. An absolute
  // candidate ignores the base, which `resolve` already does.
  const absolute = resolve(base, candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * True when `dataDir` is the real ledger, something inside it, or one of its preserved copies.
 *
 * The copies matter as much as the original. `local-data/pglite-dev.before-gst-fix-…` is a
 * complete duplicate of the user's records, and the one that the September restore came from;
 * a synthetic tool that seeded into a backup would quietly destroy the recovery point rather
 * than the ledger, which is worse for being harder to notice.
 */
export function isRealLedgerPath(dataDir: string, repoRoot: string): boolean {
  const real = canonical(REAL_LEDGER_DIR, repoRoot);
  const target = canonical(dataDir, repoRoot);
  if (target === real) return true;

  // Inside the ledger directory: `relative` gives a path that neither escapes upward nor is
  // absolute exactly when the target is a descendant.
  const inside = relative(real, target);
  if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) return true;

  // A sibling copy of it — `pglite-dev.superseded-…`, `pglite-dev.UNOPENABLE-…`, and every
  // backup the recovery procedure leaves behind.
  return target.startsWith(`${real}.`);
}

/**
 * Refuses unless a synthetic tool has named a target that is not the real ledger, and returns
 * that target so the caller cannot accidentally proceed with the unchecked one.
 *
 * Returning the validated string rather than narrowing in place is deliberate: `createPgliteDatabase`
 * accepts `string | undefined` and treats `undefined` as *in-memory*, so a caller that guarded and
 * then passed its original variable through would compile, pass the guard, and silently seed a
 * database that vanishes — a different bug wearing this one's clothes.
 *
 * An absent `dataDir` is refused rather than defaulted, because the default *is* the real ledger.
 * That is the whole point: the failure this guards against is not somebody typing the real path,
 * it is somebody typing nothing.
 */
export function assertSyntheticLedger(target: SyntheticTarget): string {
  const { dataDir, repoRoot, tool } = target;

  if (dataDir === undefined || dataDir.trim() === '') {
    throw new RealLedgerRefusal(
      `${tool} refuses to run without PGLITE_DATA_DIR.\n\n` +
        `Unset, it would fall back to ${REAL_LEDGER_DIR} — the real ledger — and open, migrate ` +
        `and possibly seed it. Name a scratch directory instead:\n\n` +
        `    PGLITE_DATA_DIR=<scratch>/qa-db EVIDENCE_STORAGE_PATH=<scratch>/qa-evidence \\\n` +
        `      npx tsx ${tool}\n\n` +
        `See docs/testing/process-isolation.md.`,
    );
  }

  if (isRealLedgerPath(dataDir, repoRoot)) {
    throw new RealLedgerRefusal(
      `${tool} refuses to run against the real ledger.\n\n` +
        `PGLITE_DATA_DIR points at ${dataDir}, which is ${REAL_LEDGER_DIR} or a preserved copy ` +
        `of it. Those hold the owner's own financial records; synthetic tools never touch them, ` +
        `not even to read.\n\n` +
        `Point it at a scratch directory instead. See docs/testing/process-isolation.md.`,
    );
  }

  return dataDir;
}

/**
 * Refuses a synthetic server that would bind a port the real stack uses.
 *
 * Separate from the ledger check because they fail independently and for different reasons: a
 * QA server on a scratch database but on port 4000 still steals every request the real website
 * makes, and the browser's network log — the thing the QA procedure checks before screenshotting
 * anything — would show the expected origin while serving the wrong data.
 */
export function assertSyntheticPort(port: number, tool: string): void {
  if (REAL_PORTS.includes(port)) {
    throw new RealLedgerRefusal(
      `${tool} refuses to listen on port ${port}.\n\n` +
        `The real stack uses ${REAL_PORTS.join(' and ')}. The two stacks are told apart by port ` +
        `in the QA procedure, in the browser's network log and in the stop procedure; a ` +
        `synthetic server here would make all three of them wrong.\n\n` +
        `See docs/testing/process-isolation.md.`,
    );
  }
}

/* ------------------------------------------------------------------ choosing a whole target */

/**
 * Where a synthetic tool has been told to put its data, once the refusals have passed.
 *
 * A description, not a connection: this is returned *before* anything is opened, so a caller
 * physically cannot reach a database without having gone through the refusals first.
 */
export type SyntheticDatabaseTarget =
  | { readonly kind: 'pglite'; readonly dataDir: string }
  | { readonly kind: 'postgres'; readonly connectionString: string };

/** Just the variables that choose a database. Passed in so the decision is testable. */
export interface SyntheticDatabaseEnv {
  readonly DATABASE_URL?: string | undefined;
  readonly SYNTHETIC_DATABASE_URL?: string | undefined;
  readonly PGLITE_DATA_DIR?: string | undefined;
}

/**
 * The one decision a synthetic tool makes about where to write, and the only way to make it.
 *
 * **`DATABASE_URL` is refused outright**, which closes the gap this function was added for.
 * `assertSyntheticLedger` guarded the on-disk PGlite path while the Postgres branch beside it
 * took `DATABASE_URL` and connected, so a shell already configured to point at something real —
 * which is exactly what `DATABASE_URL` conventionally means, and what `psql`, `drizzle-kit`,
 * every ORM and half of CI read — could have a "synthetic" seed written straight into it. The
 * variable is ambient, inherited and frequently set by something other than the person running
 * the command; that is what makes it unsafe here, not any particular value it might hold.
 *
 * `local-data/start-real.sh` already refuses to start when `DATABASE_URL` is set, for the mirror
 * image of the same reason. The two refusals now agree.
 *
 * **Postgres is still reachable, under a name nothing else sets.** `SYNTHETIC_DATABASE_URL` has
 * to be typed on purpose: no tool, framework or deployment convention populates it, so it cannot
 * arrive by inheritance the way `DATABASE_URL` does. That is the whole of its safety — a URL
 * cannot be inspected to tell whether the database behind it is precious, so the guarantee has to
 * come from the deliberateness of setting the variable, and the name is what makes that
 * deliberate. It is checked first for emptiness, and never silently falls back to the ledger.
 */
export function resolveSyntheticTarget(
  env: SyntheticDatabaseEnv,
  repoRoot: string,
  tool: string,
): SyntheticDatabaseTarget {
  const ambient = env.DATABASE_URL;
  if (ambient !== undefined && ambient.trim() !== '') {
    throw new RealLedgerRefusal(
      `${tool} refuses to run with DATABASE_URL set.\n\n` +
        `DATABASE_URL is an ambient, inherited variable: a shell, a tool or a CI job may have ` +
        `pointed it at a database that matters, and a synthetic seed written into one is not ` +
        `something this script can undo. Its value is not inspected, because a connection ` +
        `string cannot be read to tell whether what is behind it is precious.\n\n` +
        `Unset it:\n\n` +
        `    unset DATABASE_URL\n\n` +
        `To seed a Postgres database on purpose, name it under a variable nothing else sets:\n\n` +
        `    SYNTHETIC_DATABASE_URL=postgres://…/a_scratch_database npx tsx ${tool}\n\n` +
        `See docs/testing/process-isolation.md.`,
    );
  }

  const chosen = env.SYNTHETIC_DATABASE_URL;
  if (chosen !== undefined && chosen.trim() !== '') {
    return { kind: 'postgres', connectionString: chosen };
  }

  return {
    kind: 'pglite',
    dataDir: assertSyntheticLedger({ dataDir: env.PGLITE_DATA_DIR, repoRoot, tool }),
  };
}
