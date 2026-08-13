# src/api

Thin HTTP/API layer (Next.js route handlers / server actions, per
`docs/architecture/system-architecture.md`).

**Owns:** request validation, calling the appropriate `src/services` function, response
serialization. Nothing else.

**Depends on:** `src/services`.

**Rule:** no business logic, no direct database access, no direct AI calls. If a route handler
needs an `if` statement more complex than routing/validation, that logic belongs in
`src/services` instead.

Not yet implemented — no UI or API surface exists yet by design
(`docs/roadmap.md`: "Do not build the full application yet").
