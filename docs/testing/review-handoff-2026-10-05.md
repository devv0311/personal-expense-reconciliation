# Review handoff — readiness and hardening patch (published to `main`; base was `e6f1639`)

**Not security-cleared, not final — but published.** Three demonstrated defects were fixed (round 11) and one more Low header issue found by HawkScan (round 15); every production dependency advisory is closed; a release journey passed on the production build (round 14); a HawkScan run on a synthetic subset is clean after the fix; ADR-0072 is ratified. The privacy gate passed with a **distinct combined verdict** (round 18): `PASS_WITH_OWNER_ATTESTED_EXCLUSIONS_AND_PUBLIC_VOCABULARY_OVERLAP` — the owner's statements, the whole ledger (read from a verified cold copy) and the OCR text were checked with no private match, four files that cannot be read were excluded on the owner's attestation (exact file bytes, not content coverage), and four two-word phrases already in the published source were reported under the owner-approved overlap tier. The patch was published to `main` in the commit that contains this document. The owner approved the three release
decisions on 6 October 2026 (below).

## What changed, grouped

1. **Docs refresh** — `README.md` status, `CLAUDE.md` blocks, superseded labels on the PDF handoff,
   ADR index, `docs/domain/invariants.md` #10, `docs/testing/readiness-verification-2026-10-05.md`.
2. **Defects from the first rendered run** — spending trend window (`spending-service.ts`),
   instalment/anomaly filtering of ignored payments (`instalment-service.ts`), Needs-attention
   ordering and the misleading "correction" wording (`domain/connection.ts`, `needs-attention/page.tsx`).
3. **Shared expense before approval** — preview "as if approved as…" (`allocation-service.ts`,
   `api/outcome-routes.ts`), kind choice + split in `web/.../purpose-choice.tsx`, recovery of a
   partial success (`web/src/lib/queries.ts` `useApproveStatementLine`), server-side check that a
   split names real people (`allocation-service.ts` `assertPeopleExist`).
4. **One movement, not two** — [ADR-0071](../decisions/0071-a-possible-duplicate-stays-asked-while-either-copy-can-still-count.md),
   `src/services/duplicate-guard.ts`, review queue/attention/inspector changes, payer/funding
   checks in `expense-authoring-service.ts`, **class advisory lock** `lockPaymentClasses` in
   `src/db/repositories.ts` (replaced an earlier row-then-twins locking that could deadlock).
5. **Uncertain approval responses** — `isUnansweredRequest`/`UncertainResult` in `web/src/lib`, read-before-resend in `useApproveStatementLine`, wording in `purpose-choice.tsx` (rounds 6–7; round 7 settles a stale 409 and another tab's outcome from the ledger; browser-verified in round 8: five scenarios against the scratch API; one defect found and fixed — the explanation vanished with the card).
6. **Choosing a layout for a file whose columns tie** — `ambiguousFormatIds`
   (`statement-formats/types.ts`, `parse.ts`), `ambiguousLayouts` on the preview
   (`import-service.ts`), dialog in `web/src/components/payments/import-statement.tsx`
   ([ADR-0068](../decisions/0068-a-statement-that-cannot-name-its-account-is-named-by-the-person-importing-it.md) update).

## Entry points worth reading first

`duplicate-guard.ts` → `lockPaymentClasses`; `inference-decision-service.ts` (guard first in the
transaction); `expense-authoring-service.ts` `createExpense` (pre-lock); `allocation-service.ts`
`previewAllocation` / `buildLines`; `purpose-choice.tsx`; `import-statement.tsx`
(`LayoutChoiceGroup`, `ImportSummary`); the new tests below.

## Tests (final results at each checkpoint)

| Checkpoint                                               | Result                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round 2                                                  | root 2,823 / web 494 passed; 149 on scratch Postgres                                                                                                                                                                                                                |
| Round 3, serial real PostgreSQL                          | `tests/integration`: 65 files, 1,287 passed                                                                                                                                                                                                                         |
| Round 3 final                                            | root 129 files, 2,830 passed, **7 skipped**; web 43 files, 497 passed                                                                                                                                                                                               |
| Round 4 final (last root change)                         | root 130 files, **2,848 passed, 7 skipped**; web 43 files, 508 passed; typecheck, lint, format, `db:check`, both builds exit 0                                                                                                                                      |
| Round 6 (web only changed)                               | web 43 files, 513 passed; web typecheck/lint/format/build exit 0; root unchanged since round 4                                                                                                                                                                      |
| Round 7 / 8 / 9 (web only)                               | web 43 files 518 → 44 files 521 → 44 files **523 passed**; web typecheck/lint/format/build exit 0; root unchanged since round 4                                                                                                                                     |
| Round 10 (no code changed)                               | web typecheck, lint, format exit 0; web **44 files, 523 passed**; root (2,848 / 7 skipped) and real PostgreSQL (1,287) carried forward                                                                                                                              |
| Round 11 (security fixes)                                | root typecheck, lint, format, `db:check`, build exit 0; root **131 files, 2,864 passed, 7 skipped** (+16 new); web (523) and real PostgreSQL (1,287) carried forward, unchanged code                                                                                |
| Round 12 (dependency bumps)                              | web typecheck, lint, format, build exit 0; web **44 files, 523 passed**; root typecheck, lint, format, `db:check`, build exit 0; root **131 files, 2,864 passed, 7 skipped**; real PostgreSQL (1,287) carried forward                                               |
| Round 13 (web Vitest 4)                                  | web `vitest` 4.1.11: typecheck, lint, format, build exit 0; web **44 files, 523 passed** (unchanged); web audit prod 0, full 5 (was 8); root (2,864 / 7 skipped) and PostgreSQL (1,287) carried forward                                                             |
| Round 14 (closure run, no code change)                   | carried forward: root 131 files / 2,864 passed / 7 skipped, web 44 / 523, PostgreSQL 1,287; audit prod 0 / 0, full 4 + 5 (dev tooling); privacy checker 19/19 on invented fixtures; production-build journey + guard matrix; DAST not run                           |
| Round 18 (attestation + publish; no product code change) | attestation bound to exact bytes (6 synthetic tests, mutation-checked); gate re-run: 0 identifier matches, combined verdict PASS_WITH_OWNER_ATTESTED_EXCLUSIONS_AND_PUBLIC_VOCABULARY_OVERLAP; published                                                            |
| Round 17 (OCR, approved overlap tier; no code change)    | candidate unchanged except these docs; 3 scans OCR'd offline (none classifiable at acceptable confidence), password-protected PDF unresolved; 0 identifier matches; INCONCLUSIVE, not committed                                                                     |
| Round 16 (privacy coverage, no code change)              | candidate byte-identical to round 15; root typecheck, lint, format exit 0, **131 files / 2,866 passed / 7 skipped**; privacy: statements + all 43 ledger tables checked, 0 identifier / 0 private-phrase matches, 4 unreadable PDFs = INCONCLUSIVE; not committed   |
| **Round 15 (gates)**                                     | Hawk CLI 6.5.0; HawkScan on the synthetic target: 1 Low finding (nosniff header) fixed, rescan + full scan clean (12 operations); root 131 files / **2,866 passed** / 7 skipped; privacy: 0 matches on statement exports, ledger content not covered; not committed |

The 7 skipped are `tests/integration/duplicate-lock-order.test.ts`: they need a real server
(`TEST_DATABASE_URL`) because PGlite has one connection; they ran and passed on PostgreSQL 18.6 in
round 3 and were not re-run after it (nothing later touched locking). Rounds 4–5 added the
layout-choice tests and rendered checks; rounds 5 and 10 changed no code.

New test files: `duplicate-count-guard`, `duplicate-lock-order`, `expense-payer-invariants`,
`imported-shared-expense`, `statement-layout-choice` (all `tests/integration/`), plus additions to
`review`, `journey-api`, `parse.test.ts` and the web `purpose-choice`, `payments`, `authoring`,
`needs-attention`, `review` tests. One earlier root run showed a single failing test whose name was
not captured (round 2, passed on later runs); it is unexplained.

## Evidence (all outside the repo, none real)

`/Users/devv/Documents/Sorted/Code & Projects/PES QA Evidence/2026-10-05-readiness/`

- `logs/`, `screenshots/` — first round; `round2/` — hardening (patch, screenshots, logs);
- `round3/` — concurrency: `logs/01…` before (deadlocks `40P01`, server log), `02…` after,
  `03…` serial Postgres run, `04…` final checks, checkpoint patch;
- `round4/` — layout choice: screenshots 01–05, `logs/10-direct-api-refusals.log`, red/green and
  final logs, `combined-readiness-patch.diff` (superseded), synthetic inputs;
- `round17/` — **latest** (round 18 reuses it: attestation tool, tests, final gate): OCR tool and tests, extractor v3, provenance-by-hash, rerun script, final report, patch;
- `round16/` — final privacy report, cold-copy ledger exporter and PDF extractor with tests, checker with the opt-in overlap tier, aggregate-only logs, patch (identical files to round 15);
- `round15/` — gates report (scanner install, DAST blocker, privacy check coverage), checkpoint, DAST run script, privacy checker v2, logs, refreshed patch;
- `round14/` — release-candidate report, ADR-0072 review sheet, privacy checker + workflow, DAST preparation (OpenAPI subset, generator), repeatable production launch/stop, acceptance logs and screenshots, refreshed **`combined-readiness-patch.diff`**;
- `round13/` — web test tooling Vitest 3 → 4.1.11 (report, manifests/lockfiles before and after, audit before/after, check logs), refreshed **`combined-readiness-patch.diff`**;
- `round12/` — dependency bumps (next 16.3.8, source-map-js 1.2.2, root vitest 4.1.11), audit before/after, browser verification on the updated stack with the guards, refreshed **`combined-readiness-patch.diff`**;
- `round11/` — security readiness report (three fixed defects, advisories, DAST blocker), before/after logs, `dast/` scan config and scratch-target script, fingerprint-check checklist, refreshed **`combined-readiness-patch.diff`**;
- `round10/` — rendered verification of the recovery comparison (four scenarios, request traces,
  ledger snapshots, totals, screenshots, real vs injected structured 503, mutation check), its combined
  patch (superseded), report, owner decision sheet;
- `round9/` — final review report, findings, proposed commit description, combined patch (superseded);
- `round8/` — browser verification of decision recovery (traces, ledger snapshots, totals, screenshot, combined patch);
- `round7/` — web checks; patch superseded by round 8;
- `round6/` — uncertain decision responses (before/after logs, injector, snapshots);
- `round5/` — failure-recovery and XLSX in the browser: screenshots 01–04, ledger snapshots, inputs.
  Backup bundle from the branch consolidation: `PES Git Backups/personal-expense-reconciliation-all-refs-20261005-114235.bundle`.

## Owner decisions — approved 6 October 2026

The owner approved all three recommended decisions. The approval is a decision record, not
permission to commit, push, deploy or touch real data.

1. **ADR-0071 — ratified as built.** A counted payment stays in a possible-duplicate pair as the survivor; the
   uncounted copy cannot be counted until a person confirms or dismisses the pair. Alternatives:
   keep only the queue change (nothing refused) or only the refusal.
2. **Approved-Personal kind correction — deferred from this release.** Not built; the design stays a proposal. Proposal: a successor, audited decision
   (`POST /api/expenses/:id/relationship`, reason required) that supersedes the allocation, only
   personal → debt-creating kinds, refused once synced; see the readiness report for the rules touched.
3. **ADR-0068 update (layout choice) — ratified as built.** The person chooses among only the layouts that fit, nothing preselected.

## Gates still open before anyone calls this final

1. ~~**ADR-0072** (origin/Host guard) — owner review~~ — **ratified by the owner on 6 October 2026, as built** (round 15; review sheet `round14/adr-0072-review.md` kept).
2. ~~**DAST**~~ — **done for the described subset** (round 15): scan → fix (nosniff header) → rescan → full scan, all COMPLETED with no remaining findings; exclusions listed in `round15/dast/README-dast.md`.
3. ~~**Privacy check**~~ — **passed with a distinct verdict** (round 18): `PASS_WITH_OWNER_ATTESTED_EXCLUSIONS_AND_PUBLIC_VOCABULARY_OVERLAP`. Covered by content: 7 statement PDFs, the whole ledger (43 tables, 12,361 strings, verified cold copy) and 3 OCR texts; 0 identifier matches. **Owner-attested exclusions (not coverage): 4 files** (1 password-protected PDF, 3 image-only scans), bound to exact file bytes; their content was not verified by the system. Public-vocabulary overlap: 4 phrases, 54 line-hits, all already in the published source.
4. ~~**Publish**~~ — done on 6 October 2026 under the owner's standing authorisation (explicit staging of the 60 reviewed files, no force push). **Real-data acceptance** is separate and **not** authorised or done.
   Local-only scope: no live provider is connected and no background worker runs.

## Known limits

No live provider anywhere; no background worker (`runNextJob` never starts); only synthetic data
and one synthetic IDFC PDF layout; legacy double-counts are not repaired; `approveExpense`
(bare transition, no route) is not guarded; the lost-response wording is generic; not
browser-verified: PostgreSQL concurrency, themes/axe on new states, XLSX refusal states, a second real browser. A structured 503 is covered by injection in the decision flow and by a real API refusal on another route (`EVIDENCE_STORE_UNAVAILABLE`), not by a real 503 on the approval routes (none exists). Nothing here is approved or security-cleared.
