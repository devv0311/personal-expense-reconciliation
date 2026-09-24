# Process isolation — keeping synthetic work away from the real ledger

This document exists because of an incident, and it is written so the incident cannot repeat by
the same route. Read it before starting, stopping, seeding or QA-ing anything locally.

## What happened

On **19 September 2026**, a teardown of the synthetic QA stack ran:

```
pkill -f "tsx src/server.ts"
```

Both stacks — the synthetic one and the one serving the owner's real records — run that exact
command. Nothing in the command line distinguishes them, so the pattern matched both. PGlite
received SIGTERM mid-write, its WAL checkpoint was left torn, and the data directory has not
opened since:

```
PANIC:  could not locate a valid checkpoint record at 0/…
```

PGlite ships no `pg_resetwal`, so a torn checkpoint is terminal — there is no repair, only a
restore. The ledger was restored from a backup taken earlier that morning.

**Two decisions recorded between that backup and the crash were lost and are not recoverable.**
They had reached the write-ahead log but not the heap; the WAL that held them is the WAL that
cannot be replayed. Because this product is decision-based, the underlying payments were
unharmed and simply returned to the review queue as open questions — no figure became wrong, and
no record was corrupted. The unopenable directory is preserved rather than deleted, but it is
preserved as evidence, not as a recovery route. **Do not attempt further recovery from it.**

## The two stacks, and the only thing that tells them apart

|              | Real                       | Synthetic (QA)                    |
| ------------ | -------------------------- | --------------------------------- |
| Database     | `local-data/pglite-dev`    | a scratch directory               |
| API port     | **4000**                   | 4001 (or any non-real port)       |
| Website port | **3000**                   | 3001                              |
| Started by   | `local-data/start-real.sh` | the QA recipe below               |
| Command line | `tsx src/server.ts`        | `tsx src/server.ts` — _identical_ |

The command line is identical. **The port is the difference**, and so is the process group. Every
procedure below keys off one of those two and never off a name.

## Never do this

- `pkill` / `killall` / any `-f` pattern, for anything, ever. A pattern that matches one stack
  matches the other; that is the whole incident.
- `pkill -P <pid>` as a stop. It reaches direct children only, and the process that holds the
  port and the database is a **grandchild** of the pid the launcher records:

  ```
  bash start-real.sh
  └── npm exec tsx src/server.ts        <- what api.pid contains
      └── node …/tsx
          └── node                      <- holds :4000 and the ledger
  ```

  That gap is why the old stop script fell back to a pattern in the first place.

- Running any synthetic tool without naming its database. The default was the real ledger.

## Stopping something, safely

**First, look.** This reads sockets and prints; it stops nothing:

```bash
npx tsx scripts/stack-status.ts
```

It reports, per port, the pid that holds it, that pid's process group, and the one command that
stops exactly that and nothing else.

**The real stack:**

```bash
bash local-data/stop-real.sh
```

It now tries three things in order, none of them a pattern: the process group `start-real.sh`
recorded in `local-data/logs/stack.pgid`; the group derived from the pid files, for a stack
started before this change; and finally the exact pid listening on each real port. It refuses to
signal its own process group, and it reports rather than guessing if a port is still held.

**A synthetic stack** — by the exact pid, from the port it is on:

```bash
kill "$(lsof -nP -iTCP:4001 -sTCP:LISTEN -t)"
```

`start-real.sh` now puts the real stack in its **own session**, so its process group contains that
stack and nothing else. `scripts/process-isolation.test.ts` demonstrates on this operating system
that a group-scoped signal reaches every process in the group and leaves an identical process in
another group untouched — the claim the whole procedure rests on.

## Running synthetic QA

Never against `local-data/pglite-dev`, and never on ports 3000 or 4000.

```bash
SCRATCH=/tmp/qa   # any directory outside local-data/

PGLITE_DATA_DIR=$SCRATCH/qa-db EVIDENCE_STORAGE_PATH=$SCRATCH/qa-evidence \
  npx tsx scripts/seed-dev-data.ts

PGLITE_DATA_DIR=$SCRATCH/qa-db EVIDENCE_STORAGE_PATH=$SCRATCH/qa-evidence \
  PORT=4001 HOST=127.0.0.1 AUTH_REQUIRED=false CORS_ORIGIN=http://127.0.0.1:3001 \
  npx tsx src/server.ts

cd web && NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4001 npx next dev -H 127.0.0.1 -p 3001
```

A shell variable beats `web/.env.local`, but **verify it** in the browser's network log before
rendering or screenshotting anything: every request must go to `:4001`, none to `:4000`.

## The refusal that makes forgetting safe

`src/db/real-ledger-guard.ts` refuses, before any database is opened:

- **`DATABASE_URL` being set at all**, whatever it points at. It is an ambient, inherited variable
  — a shell profile, a tool or a CI job may have aimed it at a database that matters — and a
  connection string cannot be inspected to tell whether what is behind it is precious, so the
  value is never examined. `local-data/start-real.sh` refuses to start for the mirror image of the
  same reason; the two refusals now agree.
- an **unset** `PGLITE_DATA_DIR`, because the old default was the real ledger — the realistic
  failure is not typing the real path, it is typing nothing;
- the real ledger directory, however the path is spelled (relative, absolute, trailing slash, via
  `..`, or through a symlink);
- anything **inside** it;
- any **preserved copy** — `pglite-dev.before-…`, `pglite-dev.superseded-…`,
  `pglite-dev.UNOPENABLE-…`. A backup holds the same records, and seeding into one would destroy
  the recovery point instead of the ledger: the same loss, harder to notice.
- a synthetic server binding port 3000 or 4000 (`assertSyntheticPort`).

**To seed a Postgres database on purpose**, name it under `SYNTHETIC_DATABASE_URL`. Nothing but a
person sets that variable — no framework, deployment or CI convention populates it — so it cannot
arrive by inheritance the way `DATABASE_URL` does, and that deliberateness is the whole of its
safety. It never silently falls back to the ledger: a blank one is refused, not defaulted. The
test harness already worked this way, reading only `TEST_DATABASE_URL`.

`resolveSyntheticTarget` makes the whole choice in one place and returns a _description_ of the
target rather than an open connection, so there is no branch in which a database is reached first
and checked afterwards. That is not hypothetical: until 19 September 2026 the PGlite path was
guarded while the Postgres branch beside it read `DATABASE_URL` and connected unchecked, so the
guarded tool had an unguarded door.

### Exactly what is and is not guarded

| Reads `DATABASE_URL`        | Guarded? | Why                                                           |
| --------------------------- | -------- | ------------------------------------------------------------- |
| `scripts/seed-dev-data.ts`  | **yes**  | The one script that writes a synthetic scenario               |
| `scripts/set-password.ts`   | no       | An intentional operator tool **for** the real ledger          |
| `src/server.ts`             | no       | The real server; `start-real.sh` refuses a set `DATABASE_URL` |
| `src/db/client.ts`          | no       | The factory both real and synthetic callers go through        |
| `tests/support/database.ts` | n/a      | Reads `TEST_DATABASE_URL` only; no fallback                   |

The guard is deliberately **not** wired into `src/db/client.ts`: the real server is supposed to
open the real ledger, and a guard both the real launcher and the synthetic tools had to negotiate
would be a guard with an override — the kind that gets waved through by reflex.

Any new tool that opens a database for synthetic purposes calls `resolveSyntheticTarget` first.

## What this does not protect

- **A deliberate operator.** Every guard here refuses an accident. Someone who exports a scratch
  path and then copies real files into it has defeated all of it, by choice.
- **The real server itself.** It opens the real ledger because that is its job. Its safety comes
  from the launcher's preflight (it refuses to start if the ledger is missing, rather than
  creating an empty one) and from how it is stopped.
- **`scripts/set-password.ts`.** It reads `DATABASE_URL` and defaults to the real ledger, on
  purpose: it exists to set the owner's own password, so pointing it at the real database is the
  job rather than the accident. It writes no financial record.
- **A deliberately-set `SYNTHETIC_DATABASE_URL`.** Its safety is that nothing sets it by
  inheritance, not that its value is checked — because a connection string cannot be read to tell
  what is behind it.
- **An already-torn database.** Nothing here repairs one. The only recovery is a cold copy taken
  while the database was stopped — a `cp` of a _running_ PGlite directory is torn and useless, and
  a copy taken after a crash inherits the crash.

## Tests

| File                                | Covers                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `src/db/real-ledger-guard.test.ts`  | Every spelling of the real path, copies, symlinks, ports, `DATABASE_URL` |
| `scripts/seed-refusal.test.ts`      | The seed script refuses **before** opening anything, run as a subprocess |
| `scripts/stack-status.test.ts`      | Port-based classification; the report never emits a pattern              |
| `scripts/process-isolation.test.ts` | Group signalling reaches one stack only; launchers are clean             |

All four are synthetic: invented pids, temporary directories, `sleep` processes, and the _text_
of the launcher scripts. None opens a database, binds a real port, or reads a record.

Two more open databases, but only ones they created themselves under the OS temp directory,
guarded by `isRealLedgerPath` before anything is opened, and with every path constructed rather
than read from the environment:

| File                                                            | Covers                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `tests/integration/rule-proposal-dismissal-constraints.test.ts` | What the `rule_proposal_dismissals` constraints accept and refuse, in SQL |
| `tests/integration/migration-rehearsal.test.ts`                 | A populated ledger at 0018 carried through 0019–0021, and a cold restore  |

## Before migrating the real ledger

`src/server.ts` runs `database.migrate()` inside `main()`, so **starting the stack applies every
pending migration**. There is no separate apply step, and nothing confirms it.
[`docs/runbooks/real-ledger-migration.md`](../runbooks/real-ledger-migration.md) is the reviewed
procedure for doing that deliberately — a verified shutdown first, then two cold copies, then a
census before and after that compares digests rather than records. It is written to be approved,
and **nothing in it has been run**.
