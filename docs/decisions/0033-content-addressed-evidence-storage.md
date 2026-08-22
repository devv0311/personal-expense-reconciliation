# 0033. Evidence documents are content-addressed, behind a port with one adapter

**Status:** Accepted

## Context

`Evidence.storage_ref` points outside the primary database — "filesystem in development,
S3-compatible object storage in production" (`security-model.md`,
`system-architecture.md`). Every phase so far could describe that; phase 10 is the first that
has to **make** it, because it is the first phase that writes an `Evidence` row outside the
test harness.

Two questions had to be answered together, because the first constrains the second:

1. **What does a `storage_ref` say?** It is a value in the ledger, read back later by a review
   surface and by phase 11's extraction, and turned into a location by whichever adapter is
   configured.
2. **How much of production is built now?** The roadmap forbids jumping ahead, and
   `security-model.md` forbids real credentials during development. Building an S3 client for a
   phase with no S3 to talk to would be infrastructure without a caller.

## Decision

**A ref is a content address: `sha256/<64 lowercase hex>.<ext>`, derived from the bytes.**

This is chosen over an opaque UUID key or a date-partitioned path carrying the original
filename, for three properties the ledger would otherwise have to enforce by policy:

- **A ref can never come to point at different bytes.** `Evidence` is immutable
  (`invariants.md` #4) and superseding evidence is a new row. Under a content address, that
  immutability is a property of the layout rather than a rule someone must remember; under a
  UUID key, nothing structural stops a later write from replacing what a row already points at.
- **Storing the same document twice is deterministic and free.** The same photograph shared
  twice from a phone resolves to the same ref, which is what lets
  `services.ingestEvidenceDocument` be idempotent without a second dedup mechanism.
- **Nothing about the user is in the path.** A merchant name or an original filename in a
  storage key leaks financial context into a system whose access is deliberately governed
  separately from the database's (`security-model.md`). It would also put untrusted text on a
  filesystem path.

**The ref is a logical key, not a path.** The `sha256/` prefix names the addressing scheme.
How an adapter lays that out underneath is the adapter's business: the filesystem adapter shards
two levels deep from the digest's own prefix (`sha256/ab/cd/<digest>.jpg`) because one directory
holding every receipt a person ever photographs is slow to list and unpleasant to back up; an
object store can use the ref verbatim as a key. The database never holds a filesystem path.

**The port is `put` / `get` / `has`, and deliberately no `delete`.** Evidence is never deleted
while referenced (`domain-model.md`), so the port does not offer the verb — an adapter that
cannot express deletion cannot be talked into it.

**One adapter ships: the filesystem one**, rooted at `EVIDENCE_STORAGE_PATH` (already named in
`.env.example`, already gitignored). It writes to a temporary file and renames into place, which
is atomic on a POSIX filesystem, so a crash mid-write leaves a stray temp file rather than a
truncated document that a digest claims is complete. An existing object is never rewritten: under
a content address it already holds exactly those bytes, and the one case where that would not
hold — a SHA-256 collision — is not a case to resolve by overwriting.

**Object storage is a sibling file implementing the same port**, added when a phase needs it.
Nothing above the adapter changes: services take the port, and the API is handed one.

**Every ref is parsed against an anchored pattern before it becomes a location.** A traversal,
an absolute path, an extension naming a format this system does not store, or a plausible key
from some other system all fail at `parseEvidenceStorageRef` rather than at whichever adapter
happens to be configured. A value read out of the database must not be able to walk out of the
storage root.

**`media_type` and `byte_size` are columns on `evidence`**, paired to `storage_ref` by check
constraints. They are facts about the document rather than about the store: a reader has to know
how to render a document before fetching it, and a ledger that cannot describe its own evidence
without calling out to storage has put the description in the wrong place. Encoding the type in
the ref's extension alone would make it implicit and unqueryable.

## Consequences

One additive migration (`0006_evidence_ingestion.sql`), one new directory
(`src/integrations/evidence-store/`), and a `EvidenceStore` handle threaded through the services
and the API the way `AiService` already is (ADR-0025).

Ingestion hashes every uploaded document. For a phone photograph this is single-digit
milliseconds, against a network upload and a database round trip; it is not a cost worth
designing around.

Refs are opaque to a human reading the database. That is the intended trade: they are addresses,
not descriptions, and `evidence.type`/`media_type`/`captured_at` are what a person reads.

An orphaned object — bytes stored, then the row's insert fails — is possible, because the store
is written before the row. That direction is deliberate: a content-addressed object nobody
references is inert and re-storing it is a no-op, whereas a row pointing at a document that was
never written is a lie the ledger tells. No cleanup job is built for it; if one is ever wanted it
is a sweep over refs with no row, which is exactly the query a content address makes easy.

**Migration note.** `0006` is additive and safe on an empty database. Applied to one already
holding `evidence` rows, `evidence_content_present_check` would reject any row with neither a
document nor text, and the pairing checks would reject a `storage_ref` with no `media_type`.
No such database exists yet, and backfilling a media type on somebody's behalf would be guessing
at what a stored file is — the same thing ADR-0018 refused for `note_kind`.

## Alternatives considered

1. **An opaque UUID key** (`evidence/<uuid>.jpg`). Simplest adapter and it matches the row id,
   but identical re-uploads become distinct objects, ingestion needs a separate dedup mechanism,
   and nothing structural prevents a ref being re-pointed at different bytes.
2. **A date-partitioned path keeping the original filename** (`2026/07/12/<uuid>-bill.jpg`).
   Browsable on disk, which is genuinely nice in development, but it puts untrusted text on a
   path and leaks merchant/context into the storage layer.
3. **Storing documents in the database** as `bytea`. Rejected by `security-model.md` before this
   phase: a database backup would then contain every receipt, and access to documents could no
   longer be governed separately from access to the ledger.
4. **Building the S3 adapter now, alongside the filesystem one.** Rejected: no phase uses it, no
   credentials may exist during development, and the port is what makes adding it later a new
   file rather than a change to anything that ingests evidence.
5. **Encoding `media_type` in the ref only, with no new columns.** No migration, but the type
   becomes implicit, unqueryable, and re-derived by a lookup on every read.
