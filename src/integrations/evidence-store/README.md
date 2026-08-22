# src/integrations/evidence-store

Where evidence documents live, which is deliberately not the database.

`Evidence.storage_ref` points outside the primary database — filesystem in development,
S3-compatible object storage in production (`docs/security/security-model.md`,
`docs/architecture/system-architecture.md`). That separation is the point: a database
backup does not automatically contain a person's receipts, and access to the documents can
be governed independently of access to the ledger.

**Owns:** storing bytes and giving them back. `put`, `get`, `has` — and no `delete`, because
evidence is never deleted while it is referenced (`docs/domain/domain-model.md`), so the port
does not offer a verb an adapter could be talked into.

**Refs are content addresses.** `sha256/<digest>.<ext>`, derived from the bytes. A ref
therefore cannot come to point at different bytes, which makes `Evidence`'s immutability
(`invariants.md` #4) a property of the layout instead of a rule to remember; re-storing the
same photograph is deterministic rather than a second copy; and nothing about the user — no
merchant, no original filename — is encoded in a path. The ref is a **logical key**: the
sharded directories the filesystem adapter writes underneath are its own business, and an
object store can use the ref verbatim as a key.

**Depends on:** `src/domain` for the accepted media types and the extension mapping. Nothing
else.

**Must never:** decide what a document _means_. It does not know that a JPEG is a receipt, it
never parses one — extraction into a `Receipt` is `docs/roadmap.md` phase 11, through
`src/ai` — and it holds no opinion about which payment or expense a document belongs to. It
stores bytes at an address and hands them back.

**Adding object storage** means adding a sibling file implementing `EvidenceStore`, not
editing this one. Nothing above this layer changes: services take the port, and `.env.example`
already names `EVIDENCE_STORAGE_PATH` for the filesystem case.
