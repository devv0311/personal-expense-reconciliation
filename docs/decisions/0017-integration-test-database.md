# 0017. Integration tests run against a real Postgres server in CI, and PGlite locally

**Status:** Accepted

## Context

`docs/testing/testing-strategy.md` requires `src/services` integration tests to run against
"a real Postgres instance (Testcontainers or a CI service container)", explicitly not mocks,
because the behaviour under test — `CHECK` constraints firing, foreign keys holding, partial
unique indexes enforcing one current allocation per expense, `bigint` round-tripping exactly —
is behaviour of PostgreSQL itself. A mock would assert that the test double behaves as
expected, which proves nothing about the schema.

Testcontainers needs Docker. The development machine this phase was implemented on has neither
Docker nor a local PostgreSQL installation, and that is not unusual. The practical outcome of
requiring Docker is that the integration suite gets written, skipped locally, and only ever
runs in CI — or, worse, is quietly marked `describe.skip` and rots. A skipped suite is worse
than no suite, because it reads as coverage it is not providing.

## Decision

Run the same suite against two PostgreSQL implementations, selected by environment:

- **`TEST_DATABASE_URL` set** → connect to that server via `node-postgres`. CI sets it to a
  `postgres:16` service container, so the canonical run is against stock PostgreSQL.
- **`TEST_DATABASE_URL` unset** → run against **PGlite**, PostgreSQL compiled to WebAssembly
  and hosted in-process. Not an emulation or a subset: it is the PostgreSQL engine, and it was
  verified to enforce `CHECK` constraints, foreign keys, partial unique indexes and
  `gen_random_uuid()` before anything was built on it.

`tests/support/database.ts` owns the selection; no test knows which engine it is running
against. CI runs the suite **both** ways, so the fallback path cannot silently break.

Both drivers are configured so `bigint` columns arrive as JavaScript `bigint`. `node-postgres`
already returns `int8` as a string; PGlite returns a `number` by default and is given an
explicit `int8` parser, without which a paise amount above 2^53 would come back subtly wrong
rather than loudly wrong — precisely the failure `invariants.md` #12 exists to prevent. There
is a test asserting a 2^53 + 1 paise round-trip.

## Consequences

One development dependency (`@electric-sql/pglite`). Integration tests run everywhere with no
setup, and run against a stock PostgreSQL server in CI. `TEST_DATABASE_URL` is documented in
`.env.example`.

The residual risk is a behavioural difference between PGlite and a stock server going
unnoticed locally. CI running both configurations bounds it: any divergence fails the build
rather than reaching a developer as a surprise.

## Alternatives considered

- **Testcontainers only.** The strategy document's first suggestion, and the right answer on a
  machine with Docker. Rejected as the _only_ option because it makes the suite unrunnable on
  machines without it, which is how integration suites end up skipped.
- **A CI service container only, with the suite skipped locally.** Rejected for the reason
  above: a suite that does not run where the code is written stops being a feedback loop and
  becomes a merge gate that surprises people.
- **PGlite only, no server run.** Rejected: the schema will eventually be deployed to a real
  PostgreSQL server, and the migration must be proven against one. PGlite is the convenience,
  not the authority.
- **SQLite for tests.** Rejected outright — different type system, no `CHECK`-constraint
  parity, no partial-index parity, no `bigint` guarantees. It would test a different database
  than the one the system runs on, which is the failure mode this ADR exists to avoid.
