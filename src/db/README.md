# src/db

Schema and persistence. See `docs/architecture/database-design.md` for the reviewed schema
design this will implement.

**Owns:** Drizzle schema definitions, migrations, and repository-style data access functions
(one per entity/query need, no raw queries scattered through `services`).

**Depends on:** nothing else in `src/` (types come from `src/domain`, imported one-way).

**Rule:** no `UPDATE` against SOURCE-classified columns (`payments`, `evidence`,
`import_batches`) is ever issued from here — see `docs/domain/invariants.md` #4 and
`docs/architecture/database-design.md`'s immutability conventions.

Not yet implemented — no migrations exist yet by design (`docs/roadmap.md`: schema is a
reviewed design doc first, phase 6 is where migrations start).
