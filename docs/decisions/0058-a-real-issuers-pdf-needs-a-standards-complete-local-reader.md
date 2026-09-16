# 0058. A real issuer's PDF needs a standards-complete local reader

**Status:** Accepted

**Amends:** [ADR-0051](0051-reading-a-document-is-local-first-and-optical-only-by-opt-in.md)
— that decision's rules are unchanged and still govern; this one replaces the reader that
carries them out, and closes a gap between what it promised and what it could do.

## Context

ADR-0051 built PDF reading on a dependency-free reader (`extractPdfText`). Its reasoning was
explicit and, for its scope, right: `node:zlib` inflates a content stream, the operators that
place text are a small grammar, and _"a PDF parser is a large attack surface"_. The same
paragraph refused a spreadsheet library for XLSX on the same grounds.

The reader was written against generated statements whose text sits in a plain
Flate-compressed content stream and is drawn with `Tj`/`TJ`. That is a real shape, and it is
the shape of every synthetic fixture in `fixtures/statements/`.

**It is not the shape of the statements this ledger exists to read.** A real IDFC FIRST
credit-card PDF carries its text behind embedded font maps, object streams and filter chains —
ordinary, specified constructions that a deliberately partial reader does not implement. The
reader behaves honestly when it meets one: it reports `hasTextLayer: false` with a reason,
exactly as designed. But the answer is wrong about the document. The text is there.

That produced two failures, and the second is the serious one.

**A person could not import their own statement.** The user-facing goal is that an original
statement PDF is selected in the browser and imported, with no conversion step in front of it.
Against the real files, the partial reader returned nothing, so the import refused a readable
document.

**A readable document would have been sent to a provider.** ADR-0051's central rule is that
_"a document that can be read locally never reaches a provider"_ — an ordering it calls a
privacy decision rather than a performance one. But `composite.ts` implements that rule by
asking the local extractor and falling through to vision when it answers `null`. With the
partial reader as the only local attempt, a bank or card PDF it could not decode answered
`null`, and on an installation with `AI_DOCUMENT_VISION=true` the composite would have
uploaded a locally-readable statement to a multimodal model. The rule was stated correctly and
enforced by a reader that could not keep it.

## Decision

### `pdfjs-dist` is a production dependency, for local reading only

`extractPdfTextWithPdfJs` in `src/integrations/statement-formats/pdf-text.ts` reads a PDF with
PDF.js — Mozilla's implementation, Apache-2.0, **zero required runtime dependencies**. It does
declare the optional canvas package quantified below. Statement import uses PDF.js, and so does
the receipt-evidence path's local extractor.

This reverses ADR-0051's no-dependency stance for PDFs specifically, and the reversal is
narrow. The XLSX reader keeps its reasoning intact and gains no dependency: a ZIP of
SpreadsheetML really is a small grammar, and `node:zlib` really does inflate it. A PDF is not
that. The formats a real issuer uses are a standard, and implementing enough of that standard
to read one is not a weekend of parsing — it is a PDF library, either written here or
depended on. Depending on the one that is maintained, widely reviewed and used by every
browser is the better trade.

**The partial reader stays.** It is tried first, because it costs nothing and answers the
ordinary case, and its `%PDF-` header check and stream bounds are still the first thing a
hostile file meets. PDF.js is tried second, when the partial reader found nothing.

### One entry point per document, because two answers is a fork

`parseStatementFile` is the only function that reads a PDF. `parseStatement` — the synchronous
entry point for CSV and XLSX — **refuses a PDF by name**, with an error addressed to whoever
wired the call rather than to a person holding a statement.

It used to read one instead, through the partial reader, while `services.importStatement` read
the same bytes through PDF.js. That is not a fallback, it is a fork: the same document could
answer "no text layer" or "four movements" depending on which function a caller reached for,
and the weaker answer looked exactly like an honest refusal. A financial parser cannot have two
answers about one file. The two entry points remain separate only because PDF.js loads
asynchronously and a caller holding known CSV text should not have to await an import it will
never use.

The partial reader survives in exactly one place: the first step of the receipt path's
local-first cascade, where being cheap and finding nothing costs nothing and the standards-
complete reader gets the document next.

### What "local" is enforced with, rather than assumed

`isEvalSupported: false` stops PDF.js compiling anything the document contains.
`useWorkerFetch: false`, `useSystemFonts: false` and an unset `cMapUrl`/`standardFontDataUrl`
leave it nothing to fetch. The bytes are copied before they are handed over, because PDF.js may
transfer the buffer it is given and evidence is immutable.

None of that is taken on trust: a test spies on `fetch` across a full extraction and asserts it
is never called. A default that changed in a future release would otherwise send a statement's
font requests off the machine silently, which is the failure this ADR exists to prevent.

Four bounds cap the work one document can cause — file size, page count, line count, and a
single line's buffer — and each **refuses the whole document** with a stated reason rather than
returning the part that fit. A statement read halfway is worse than one not read: downstream it
is indistinguishable from a complete import of a shorter month.

Every failure reason is a fixed sentence. A decode error can carry a fragment of the content it
failed on, and that fragment is somebody's statement.

### OCR policy is untouched

A genuine image-only PDF still has no text layer for either local reader. It still reaches a
model only under `AI_DOCUMENT_VISION`, still refuses by name without it, and `receipts.text_source`
still records which reader produced the words. **The second local reader only ever moves
documents out of vision's reach, never into it.**

### Where it runs, and what it costs

**Server-side only.** `pdfjs-dist` is a dependency of the root package; `web/` neither declares
nor references it, and it is absent from the Next.js build output. The browser uploads bytes and
renders what the API returns — `web/`'s no-arithmetic rule (ADR-0048) is untouched, and no PDF
is parsed there.

It is **37 MB on disk** and pulls **`@napi-rs/canvas` as an optional dependency** — roughly
25 MB of prebuilt native binaries. Canvas is for rasterising pages. `getTextContent()` never
rasterises, and the whole PDF test suite passes with `node_modules/@napi-rs` removed, which is
how that claim is checked rather than assumed.

**Deployment policy: leave optional dependencies installed by default, and drop them
deliberately where it is verified.** A repo-wide `omit=optional` would apply to every package in
both `package.json` files, including Next.js's own platform-specific binaries and the native
bindings `vitest`/`rolldown` resolve per platform; the disk saved is not worth a build that
fails on one machine and not another. An install that wants the 25 MB back can pass
`--omit=optional` for the root package once it has verified its own toolchain, and nothing in
this repository depends on that choice.

**Production audit status: clean.** `npm audit --omit=dev` reports zero vulnerabilities. The
findings on the full tree are all dev toolchain — `js-yaml` via eslint, `esbuild` via
drizzle-kit, `@vitest/mocker` via vitest — and none of them is `pdfjs-dist` or reachable at
runtime. Those are a separate decision, deliberately not bundled into this one.

## Consequences

- **The five real statements this was built for are read locally.** Verified in a private local
  review against the originals: every one selected the `idfc_first_credit_card_pdf` layout and
  none contained an unreadable transaction. Nothing about those files — no name, amount,
  reference or card identifier — entered this repository, its fixtures, its tests or its logs,
  and nothing may.
- **ADR-0051's local-first rule is now enforceable rather than merely stated**, and there is a
  test asserting that a PDF only the standards-complete reader can decode never reaches vision.
- **`src/integrations/document-text/local.ts` tries two readers.** It imports them from
  `pdf-text.js` directly rather than the `statement-formats` barrel, so the receipt path does
  not pull the statement parser along behind it.
- **All-or-nothing survives semantic conversion, not just line matching.** A record the layout
  matched and could not convert — an impossible calendar date, a narration that is empty, an
  amount that will not read as money, an unreadable balance — fails the whole file with a
  sanitized per-line error. Only a line that never matched the layout is skipped, because that
  is presentation text rather than a movement this build failed to read. An oversized request
  answers `413 STATEMENT_FILE_TOO_LARGE` whichever of the two size checks noticed it.
- **A password-protected statement now says so**, instead of reading as a corrupt file. It is
  the common case for a card statement and the wrong message sends somebody looking for the
  wrong problem.
- **This does not widen the claim about which banks are supported.** One IDFC FIRST credit-card
  layout is declared and verified. A standards-complete reader makes more documents _readable_;
  it does not make their layouts _declared_, and an undeclared layout is still refused rather
  than guessed at.
