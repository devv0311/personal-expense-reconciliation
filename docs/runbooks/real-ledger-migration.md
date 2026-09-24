# Migrating the real ledger — a procedure for review

> **STATUS: EXECUTED ONCE, 19 September 2026. The ledger is migrated and running at 0021.**
>
> Approved by the owner in words at 23:29 IST and carried out immediately after; the record is
> at the end of this file. It was written beforehand from a rehearsal on scratch databases
> (`tests/integration/migration-rehearsal.test.ts`) and from reading the code that carries it
> out, and it ran as written with no improvisation and no stop condition met.
>
> **Running it again needs its own approval.** Nothing below re-authorises itself, and the
> pending-migration table describes the state as it was on 19 September, not as it is now.
>
> **Do not put any of this in a script that runs on its own**, and do not add it to
> `start-real.sh`. The whole point of the sequence is that a person decides between the steps.

## Why this exists at all

`src/server.ts`'s `main()` is two lines before anything else happens:

```ts
const database = await openDevDatabase();
await database.migrate();
```

So **starting the stack is applying every pending migration**, unattended, with no backup step
and nothing to confirm. `local-data/start-real.sh` refuses to start when the ledger folder is
missing and when `DATABASE_URL` is set; it has no opinion about schema changes. The ordinary
gesture — "restart the website" — is therefore also the gesture that migrates the ledger.

Three migrations are currently pending in the working tree and have only ever run on databases
created from nothing:

| Tag                                         | What it does                                                   |
| ------------------------------------------- | -------------------------------------------------------------- |
| `0019_rule_proposal_dismissals`             | Creates `rule_proposal_dismissals` (ADR-0065).                 |
| `0020_audit_rule_proposal_dismissal`        | Widens `audit_events_entity_type_check` by one value.          |
| `0021_rule_proposal_restore_actor_not_null` | Corrects 0019's restore `CHECK`, which admitted SQL `UNKNOWN`. |

None of the three touches an existing row. 0019 and 0021 touch one new table; 0020 replaces one
`CHECK` on `audit_events` and re-validates the existing rows against a strictly wider predicate.

## What the rehearsal established, and what it did not

**Established, by running it** (`tests/integration/migration-rehearsal.test.ts`, 11 tests):

- A populated ledger built at 0018 from the historical SQL and the historical journal comes
  through 0019 → 0021 with **every pre-existing table present and every row identical**, compared
  by per-table `md5` digest rather than by row count alone.
- The journal table gains exactly three rows, in order, with the three journal timestamps.
- Re-running the migrator is a no-op: no new journal rows, no change to any digest.
- The migrations create no rule, no dismissal and no inference. They are schema only.
- **A failure partway rolls the whole batch back.** Injected a migration that errors after
  creating a table; the database was left exactly at 0018 — not at 0020 with one migration
  outstanding. The installed migrator runs every pending migration inside a single
  `session.transaction`, and in PostgreSQL DDL is transactional, so the batch is all-or-nothing.
  This was proven by running it, not by reading the migrator's source.
- **A cold copy restores.** Closed the handle (awaited), copied the directory, upgraded the
  original, then opened the copy in a third location and found it still at 0018 with the same
  digests.
- **An awaited `close()` removes `postmaster.pid` from the data directory.** A stopped PGlite
  directory that still has one was copied while something held it open. See the stop check below.
- If a row already violates the corrected constraint, 0021 **fails loudly** rather than admitting
  it — the batch rolls back and the database stays where it was.

**Not established:**

- Nothing was run against the real ledger, a copy of it, or a database of its size. Timings here
  are unknown; the rehearsal's databases were small.
- The rehearsal used PGlite in-process, one writer, no HTTP traffic. It says nothing about a
  migration racing a request.
- The atomicity proof is for a migration whose **SQL fails**. It is not a proof about a process
  killed mid-migration: that is the 19 September failure mode, and the answer to it is the cold
  copy in step 4, not the transaction.
- `server.close()` is **not** awaited in the shutdown handler (read from `src/server.ts`, not
  executed): the listening socket is released before `await database.close()` runs, and
  in-flight handlers keep going. A free port therefore does not mean the database is flushed.
  This is the reason the stop check below does not rely on the port.
- The migrator records each migration's sha256 but **never compares it** on a later run. Editing
  an already-applied migration file would not be detected. That is why 0021 is an additive
  correction and why 0019 and 0020 were left exactly as they are.

## Stop conditions

Stop, restore nothing, and ask, if any of these is true:

- The pre-flight in step 2 finds the ledger at a migration level this procedure did not expect.
- The stop check in step 4 does not pass **all three** of its conditions.
- Copy **B** does not open, or its census does not match what step 5 expected.
- The migration step reports any error at all. It rolled back; it did not half-apply. Do not
  re-run it to "get past" the error.
- The post-migration census differs from the pre-migration census in any table that existed
  before, in either the row count or the digest.

## The procedure

### 0. Approval

The owner says, in words, that this may be run. Record when.

### 1. Quiet the stack, website first

Close every browser tab pointing at `http://127.0.0.1:3000`. The website polls; a tab left open
keeps issuing reads, and a read can still start a write path.

Then look, without stopping anything:

```bash
npx tsx scripts/stack-status.ts
```

### 2. Stop the real stack, by the recorded group — never by a pattern

```bash
bash local-data/stop-real.sh
```

`pkill`, `killall` and any `-f` pattern are what caused the 19 September 2026 incident. See
[`docs/testing/process-isolation.md`](../testing/process-isolation.md).

### 3. Verify the shutdown actually finished — three checks, not one

All three, because each covers what the others miss:

1. **The ports are free.** `npx tsx scripts/stack-status.ts` reports nothing on 3000 or 4000.
   This proves the socket closed. It does **not** prove the database closed.
2. **The processes are gone.** No pid from the status report still exists.
3. **`local-data/pglite-dev/postmaster.pid` is absent.** This is the one that speaks about the
   database. An awaited `close()` removes it; a directory that still has one is still open, or
   was killed rather than asked.

```bash
ls local-data/pglite-dev/postmaster.pid 2>/dev/null && echo "STILL OPEN — STOP HERE"
```

If check 3 fails, stop. Do not copy the directory and do not start anything: a copy taken now is
torn, and a torn PGlite has no repair.

### 4. Two cold copies, and open neither of them yet

Two, because **opening a copy writes to it** — PGlite recovers its WAL and takes a
`postmaster.pid`. A single copy that you open to verify is no longer the pristine one.

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"
cp -R local-data/pglite-dev "local-data/pglite-dev.pre-0021-archive-$STAMP"   # A: never opened
cp -R local-data/pglite-dev "local-data/pglite-dev.pre-0021-verify-$STAMP"    # B: opened below
```

Copy **A** is the restore point. Nothing reads it, writes it, or opens it. It is named
`pglite-dev.*`, so `src/db/real-ledger-guard.ts` already refuses to let any synthetic tool near
it. Copy **B** is the one every check below uses.

Do not delete the existing preserved copies to make room.

### 5. Read the current state — from copy B, never from the ledger

This is the first step that opens a database, and it opens the copy. Two questions, and one of
them cannot be answered any earlier, because there is no way to read a PGlite database without
opening it and no way to open it without writing to it.

**Which migrations are already applied.** The running stack may have applied 0019 and 0020
already, if it was last started after those files existed. Read it rather than assume it:

```sql
select created_at from drizzle.__drizzle_migrations order by created_at;
```

Compare against `drizzle/meta/_journal.json`'s `when` values. Expect 19 rows (through 0018).
If there are 21, 0019 and 0020 are in and only 0021 is pending; if there are 22, there is
nothing to do and this procedure ends here.

**Whether 0021 will refuse.** Only if `rule_proposal_dismissals` already exists:

```sql
select count(*) from rule_proposal_dismissals
 where restored_at is not null and restored_by is null;
```

Any count above zero means 0021 will fail and roll back. Stop and ask; the answer is a decision
about a real recorded restoration, not a repair to apply quietly.

**The census.** Row counts and content digests, per table — no values, no amounts, no merchant
names, nothing that could be read back as a record:

```sql
select table_name,
       (xpath('/row/n/text()',
              query_to_xml(format('select count(*) as n from %I.%I', table_schema, table_name),
                           false, true, '')))[1]::text::int as rows
  from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE'
 order by table_name;
```

and, per table, the digest the rehearsal compares on:

```sql
select coalesce(md5(string_agg(t::text, '|' order by t::text)), '-') from "<table>" t;
```

Both statements were executed against a scratch database while this was written, so they run
as spelled — an untested query in a runbook fails at the worst possible moment.

Save both to a file **outside** the repository. A count and an md5 are not a record: the
comparison in step 8 is a comparison of digests, and a digest never has to be decoded to be
useful.

### 6. Migrate — and know which act is doing it

There is no separate "apply migrations" command for the PGlite ledger. `npm run db:migrate`
is drizzle-kit against `DATABASE_URL`, which this ledger does not use, and which
`start-real.sh` refuses to have set. **The migration happens when the API starts**, inside
`main()`, before the socket is open.

So the migration step is simply starting the stack, in full knowledge that this is what it does:

```bash
bash local-data/start-real.sh
```

Watch `local-data/logs/api.log`. The migration runs before `API listening on …` is printed, so
that line appearing at all means it completed. If it failed, the process exits and
`start-real.sh` reports "the records service stopped while starting" with the last lines of the
log — and the ledger is back where it was, because the batch rolled back.

### 7. If it failed

The ledger is unchanged; that is what the rehearsal proved. Do not re-run the start to get past
it, and do not edit a migration file that has already been applied anywhere — the migrator does
not re-check hashes, so an edit would leave two databases disagreeing about what "0019" is.

If the ledger will not open afterwards for any reason, **preserve it rather than repair it**,
under the naming the guard already recognises:

```bash
mv local-data/pglite-dev "local-data/pglite-dev.UNOPENABLE-$(date +%Y%m%d-%H%M%S)"
cp -R "local-data/pglite-dev.pre-0021-archive-$STAMP" local-data/pglite-dev
```

Copy **A** goes in as the new ledger; the failed directory stays as evidence, and copy A itself
stays where it is — restore by copying _from_ it, never by moving it. Then stop and report.

### 8. Verify, then stop

Stop the stack again (steps 2–3, all three checks), copy the ledger once more, and re-run step
5's census against that copy. Compare against the saved one:

- every table that existed before still exists, with the **same row count and the same digest**;
- the only new table is `rule_proposal_dismissals`, empty;
- `drizzle.__drizzle_migrations` has exactly three more rows, matching the journal.

Then start the stack normally and confirm the website loads. Keep copy A until the owner says
otherwise.

## What this procedure deliberately does not do

- **It does not reconstruct the two decisions lost on 19 September 2026.** They are gone, the
  payments behind them returned to the review queue as open questions, and re-creating them
  would be inventing a decision nobody made.
- **It does not repair a torn database.** There is no repair. There is a restore from a cold
  copy, or there is nothing.
- **It does not run itself.** Every step above is a person deciding to take it.

## Execution record — 19 September 2026

Run once, as written. No step was skipped, reordered or improvised, and **no stop condition was
met**. Figures below are aggregates and schema facts only; no record, amount, merchant or
identifier was read into any log or report.

| Step                             | Outcome                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Approval                      | Owner approved in words, 23:29 IST.                                                                                                                                            |
| 1. Quiet the website             | Zero established sockets on 3000/4000 across three samples ~3s apart. No tab was connected.                                                                                    |
| 2. Stop                          | `stop-real.sh` signalled group 82722 via strategy 2 (pid files) — `stack.pgid` was absent, because that stack predated the file.                                               |
| 3. Three checks                  | Ports free; all 8 pids of group 82722 gone; `postmaster.pid` absent. All three passed within 1s.                                                                               |
| 4. Two cold copies               | A and B taken, each 1206 files / 42,954,752 bytes, neither carrying a `postmaster.pid`.                                                                                        |
| 5. Read state from copy B        | **19 applied migrations, an exact match for the journal through 0018.** 41 tables, 558 rows. `rule_proposal_dismissals` absent, so 0021 could not refuse.                      |
| 6. Migrate by starting the stack | API printed `API listening on …` within 1s of the start; no failure marker, no error-shaped line in `api.log`. Launcher reached `Open http://…`, so both health checks passed. |
| 7. If it failed                  | Not reached.                                                                                                                                                                   |
| 8. Verify                        | Stopped again (all three checks passed, this time via the recorded `stack.pgid`), copied, censused. **PASS on every criterion.**                                               |

**The comparison, in full.** All 41 pre-existing tables present after the upgrade with an
identical row count _and_ an identical `md5` digest — 0 tables changed. Total rows 558 before and
558 after. One new table, `rule_proposal_dismissals`, empty. Exactly three journal rows added —
0019, 0020, 0021 — with the first 19 unchanged and the resulting 22 matching
`drizzle/meta/_journal.json` entry for entry.

**The two constraints, read from the post-migration copy's catalog:**
`rule_proposal_dismissals_restored_check` now carries `restored_by IS NOT NULL`, and
`audit_events_entity_type_check` lists 33 entity types including `rule_proposal_dismissal`.

**Preserved, and to be kept until the owner says otherwise:**

- `local-data/pglite-dev.pre-0021-archive-20260919-233104` — copy **A**, the restore point.
  **Never opened**: byte-for-byte as created, zero files modified after the copy completed.
- `local-data/pglite-dev.pre-0021-verify-20260919-233104` — copy **B**, opened once for step 5.
- `local-data/pglite-dev.post-0021-verify-20260919-233325` — the post-migration copy censused in
  step 8.

Every copy that existed before this run — including the unopenable one from 19 September — was
left exactly where it was. Nothing was deleted, moved or repaired.

**The ledger was left migrated, not restored**, and the stack is running.
