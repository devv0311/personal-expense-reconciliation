# src/domain

Pure domain logic. No I/O, no framework imports, no AI/network calls, no database access.

**Owns:** entity types matching `docs/domain/domain-model.md`; allocation arithmetic (sum
validation, rounding per `docs/domain/invariants.md` #12); balance/settlement computation;
unexplained-money computation; state-transition validity checks for the lifecycles in
`docs/domain/lifecycle.md`.

**Depends on:** nothing else in `src/`.

**Rule:** everything here must be testable with plain function calls and no mocks — see
`docs/testing/testing-strategy.md`. If a function in this directory needs a mock to test, it
belongs in `src/services` instead.

Not yet implemented — see `docs/roadmap.md` phase 12 (beneficiary allocation) for when this
fills in.
