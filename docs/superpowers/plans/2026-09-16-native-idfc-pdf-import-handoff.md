# Native IDFC PDF Import — Claude Handoff

## Checkpoint

- Active branch: `wip/idfc-pdf-import`
- Initial implementation commit: `211cdfc`
- Status at handoff: implementation is saved but not yet verified by the full test, typecheck,
  build, security, or browser-QA suites.

## User outcome

A person must be able to select an original IDFC FIRST credit-card statement PDF in the website
and import it directly. They must not need to convert the statement to CSV or alter the file
before uploading it.

## What the checkpoint implements

- Local PDF text extraction with `pdfjs-dist`; statement contents are not sent to an external
  service.
- IDFC FIRST credit-card statement detection and parsing, including multiline transaction
  descriptions and `DR`/`CR` direction markers.
- An asynchronous statement-file parsing path used by the import service.
- Browser upload of the original bytes to `POST /api/imports/statement`.
- Website file selection for CSV, XLSX, and PDF, with a 25 MB client-side size limit.
- A component-test update for the new browser request shape.

The implementation touches `package.json`, `package-lock.json`, the statement-format integration,
the import service, and the website's import page, component, API client, query hook, and tests.

## Non-negotiable privacy and domain constraints

1. Do not copy, commit, snapshot, log, or turn the user's real statements or extracted financial
   data into fixtures. Use synthetic data for committed tests.
2. Keep readable PDF processing local. OCR remains explicit opt-in under ADR-0051; do not add a
   silent cloud/OCR fallback.
3. Imported evidence stays immutable. Parsing or classification must not rewrite source facts.
4. The frontend performs no financial arithmetic. It only uploads and renders API results.
5. Preserve the existing CSV/XLSX behavior and API compatibility.
6. Do not claim broad bank-PDF support from verification of one IDFC layout.

## Work still required

1. Inspect the checkpoint diff before changing it, especially PDF.js loading, cleanup, page/text
   limits, error handling, and multiline record joining.
2. Run the root checks:

   ```sh
   npm run typecheck
   npm run lint
   npm run format:check
   npm test
   npm run build
   ```

3. Run the website checks:

   ```sh
   npm --prefix web run typecheck
   npm --prefix web run lint
   npm --prefix web run format:check
   npm --prefix web test
   npm --prefix web run build
   ```

4. Add synthetic PDF coverage for format detection, multiline descriptions, debits, credits,
   references, ignored headers/footers, malformed input, and incomplete records. Add API-level
   coverage proving original PDF bytes reach the parser.
5. Verify the five real statements locally and privately against their visible statement totals.
   Never commit the files, their extracted text, account/card identifiers, names, or transactions.
6. Exercise the import through the rendered website and inspect console/network errors, loading,
   success, duplicate, partial-warning, invalid-file, oversize-file, and mobile states.
7. Review dependency and bundle impact, including the current audit findings. Fix or document only
   after identifying which dependency paths are actually responsible.
8. Update claims in documentation only after the behavior and scope are demonstrated.

## Audit gates for Codex supervision

Before this work is accepted, provide Codex with the final diff and command outputs for review.
Codex should audit:

- Parser correctness and transaction-boundary edge cases.
- Privacy, resource limits, malformed-PDF handling, and dependency risk.
- API compatibility, idempotency, and duplicate-import behavior.
- Website accessibility, feedback states, and fidelity to `web/Design.md`.
- Regression coverage for existing CSV/XLSX imports.
- Whether the completion claim matches the evidence produced.

Stop and ask before changing the financial domain model, evidence immutability rules, OCR policy,
or external-service boundary; those changes exceed this import task.
