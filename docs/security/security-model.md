# Security Model

> **Local PII boundary (2026-09-05 product requirement).** Raw statements, SMS/push messages,
> receipts, account/card numbers, UPI IDs, contact details and re-identification mappings remain
> local. Before any external AI transport, deterministically sanitize/pseudonymize and minimize
> the payload; fail closed if sensitive content remains. Do not leak raw evidence into logs,
> fixtures, Git or model prompts. Keep immutable local evidence for verification. Derived
> WhatsApp proof packs require a recipient-specific preview and redaction step; generation
> does not authorize sending. Phase 17 extends the existing AI redaction boundary, and Phase
> 20 tests export privacy. See `CLAUDE.md` and the current roadmap.

This system processes sensitive personal financial information. This document defines the
rules for handling it, per `CLAUDE.md`'s security section.

> **Revision note (2026-08).** One addition: `payments.external_reference` (ADR-0010) is treated
> as a redaction-worthy identifier before any AI provider call, alongside account/card/UPI
> identifiers — see "Data sent to external AI services" below. No other security rule changed.

## Principles

- Least privilege — the application's database role has only the access each layer actually
  needs (see `docs/architecture/database-design.md` — `UPDATE`/`DELETE` denied on immutable
  and audit tables at the role level, not just by convention).
- Minimal data retention — evidence and derived data are kept as long as they're useful for
  reconciliation/audit, not indefinitely by default; a retention policy is defined before any
  production data is stored (open question — see the foundation report).
- Redaction before anything leaves the system's own boundary — see "Data sent to AI" below.
- Minimal logging — see "Logging" below.

## What must never be committed to Git

Real bank statements, real receipts, real UPI identifiers, account numbers, card numbers, API
keys, access tokens, and production secrets. Enforced by `.gitignore` (`local-data/`,
`*.receipt.*`, `.env`) and by convention: `fixtures/` contains only synthetic data (see
`fixtures/README.md`), and this must be checked in code review for any PR touching `fixtures/`
or adding example data anywhere else in the repo.

## Secrets and credentials

- No secrets in source. `.env` (gitignored) holds local secrets; `.env.example` documents the
  required variable names with empty values (see repository root).
- Production secrets (database URL, AI provider API key, Splitwise OAuth credentials) live in
  the deployment platform's secret manager, not in a config file in the repo.
- `ExternalIntegration` (`database-design.md`) stores connection _metadata_ only; actual
  tokens are stored via a secrets manager or an encrypted-at-rest column accessed outside
  normal query paths — the exact mechanism is an open decision, finalized when Splitwise sync
  is actually implemented (`docs/roadmap.md` phase 14).

## Evidence storage

Evidence files (receipt images, screenshots, statement exports) are stored outside the primary
database, referenced by `Evidence.storage_ref` (`docs/domain/domain-model.md`) — filesystem in
development, S3-compatible object storage in production
(`docs/architecture/system-architecture.md`). This separation means a database backup/export
does not automatically include raw financial documents, and access to evidence storage can be
governed independently of database access.

**Implemented as of phase 10** (ADR-0033), with three properties that matter here:

- **Refs carry no financial context.** A `storage_ref` is `sha256/<digest>.<ext>`, derived from
  the bytes. No merchant name, no original filename, no date is encoded in a storage path, so
  the store's contents leak nothing about the user to anyone who can list it but not read it.
- **A ref never becomes a location unchecked.** `parseEvidenceStorageRef` refuses anything that
  is not that exact shape, so a value read out of the database — or written into it by any other
  means — cannot walk out of the storage root.
- **Only an allowlist of formats is stored** (JPEG, PNG, WebP, HEIC, PDF), because the declared
  type is what decides how a document is later rendered back to a person. The one route that
  serves a document sets `X-Content-Type-Options: nosniff` for the same reason.

The development root is `EVIDENCE_STORAGE_PATH` (`.env.example`), which is gitignored: no real
financial document ever enters the repository.

## Data sent to external AI services

Before any `Payment`/`Evidence`/`Receipt` data is sent to the AI provider
(`docs/architecture/ai-boundary.md`):

- Full account numbers, card numbers, UPI IDs, **and `payments.external_reference` values**
  (added, ADR-0010 — a UTR/RRN/bank reference is an identifier of the same sensitivity class as
  an account number and is redacted or omitted on the same basis) are redacted or omitted.
  Where a merchant or counterparty needs to be identified, the already-normalized
  `Merchant`/`Person` reference is sent where possible, not the raw statement line or reference
  number containing an identifier.
- Only the minimum fields needed for the specific inference are sent (e.g.
  `classifyTransaction` needs amount/description/merchant, not the full account number the
  payment came from, and not its `external_reference`).
- This redaction step is a named function in `src/ai` (not inlined ad hoc at each call site),
  so it's implemented once and testable once.

**Fail-closed as of phase 17** (ADR-0044). `ai.assertPayloadSanitized` runs at the end of every
redaction builder and **throws instead of sending** when an identifier is still present. It is
deliberately independent of the redactors: those are pattern substitutions over free text
written by banks, and a payload is a shape somebody can extend without noticing there was a rule
attached to it — both failures are silent, and both end with an account number at a third party.
It reports the field and the _kind_ of identifier, never the value, because an error about a leak
must not itself be the leak.

Per-field profiles keep it usable: a statement description's bare 4+ digit run is refused, a
receipt's is not (prices, quantities and dates are the signal extraction exists to read), and a
structural field — an id, an ISO timestamp, an exact minor-unit string — is not scanned at all.

Phase 17 also put _evidence_ text on this path for the first time: the merchant a push
notification names is what repairs a decayed UPI narration, and it reaches
`ai.classifyTransaction` as `reattachedMerchantHints`. The reference, the masked account tail and
the raw notification text sitting beside it in the same evidence do not — there is no field on
the outgoing payload for them to occupy, and they stay readable locally through
`services.getPaymentContext`, which is the whole point of keeping them.

`ai.createLocalRedactionMap` is the reversible mapping `CLAUDE.md`'s pillar 6 requires to stay
local. It is a separate object the caller holds, never a field on a payload, so a serialized
request cannot carry it by accident; it is scoped per unit of work rather than per process,
because a long-lived map would accumulate every identifier the system has ever redacted into one
object — a worse thing to hold than the individual values were.

## Logging

- No full financial detail (exact amounts tied to a specific person/merchant, raw evidence
  text) in application logs by default. Structural/operational logs (a job ran, an import had N
  rows, an AI call took Xms) are fine; logs are not the audit trail — `audit_events`
  (`database-design.md`) is, and it's a database table with normal access controls, not a log
  stream.
- Error logs must not include full request/response bodies for endpoints touching financial
  data; log an error reference ID and correlate separately if deeper debugging is needed.

## Authentication

Minimal, single-user session auth for the current phase
(`docs/architecture/system-architecture.md`) — no third-party OAuth surface to secure yet
beyond Splitwise's own (handled as an `ExternalIntegration`, not user login). Finalized when
`src/api` is implemented; the `User`/`Person` split in the domain model means moving to
stronger or multi-user auth later doesn't require a data model change.

## Real accounts and credentials during development

Per `CLAUDE.md`: do not connect real bank accounts, real Splitwise accounts, or use real
financial credentials during development. `src/integrations/splitwise` is built against
Splitwise's sandbox/test mode or a local mock until the system is trusted enough for the
user to deliberately connect it for real — that switch is a conscious, later decision, not a
default.

## Encryption

- Data in transit: TLS for all external calls (database connection, AI provider, Splitwise
  API) — standard for the chosen hosting platform, not something this project reimplements.
- Data at rest: managed Postgres/object storage with encryption at rest, using the hosting
  provider's standard offering (specific provider is an open deployment decision — see the
  foundation report's open questions).
