# 0051. Reading a document is local first, and optical only by opt-in

**Status:** Accepted

## Context

The 7 September audit's row 14 named a gap that a green test suite could not have caught:

> `extractReceipt` passes evidence type, media type, `rawText` and `capturedAt`; it does not
> read document bytes from `EvidenceStore`. Uploading an image alone is not a working
> receipt-extraction pipeline.

It was exactly right. Phase 11 built receipt extraction against an evidence row's `rawText`,
which is populated for a typed note or a forwarded notification and empty for the thing a
receipt actually is: a photograph or a PDF somebody uploaded. The whole pipeline existed and
the common case produced an empty receipt.

Fixing it means taking text off a document's bytes, and that is where it stops being a
plumbing problem. There are two ways to do it and they have opposite privacy properties. A
generated PDF carries its own text layer: reading it is local, deterministic, free, and nothing
leaves the machine. A photograph does not, and the only OCR available to this build is a
multimodal model — which means the document's bytes crossing the local sanitization boundary
that the sixth pillar and `security-model.md` exist to hold.

Row 02's sibling problem sits alongside it. The ledger parsed exactly one synthetic five-column
CSV, so "import your bank statement" meant "reshape your bank statement into our CSV first".

## Decision

### Extraction goes through a port, and the local path is always tried first

`src/integrations/document-text/` defines `DocumentTextExtractor`. The composite adapter tries
the local PDF text-layer reader first and only then considers a model. The ordering is a
privacy decision, not a performance one: **a document that can be read locally never reaches a
provider**, even on an installation that has opted into vision.

### Optical extraction is off unless explicitly configured, and having an API key is not enough

`AI_DOCUMENT_VISION=true` — separately from `ANTHROPIC_API_KEY` — is what permits a multimodal
model to transcribe a photographed receipt. The two are deliberately not one switch: having a
model configured for _classification_ (which sends a redacted, structured payload) is not
consent to send it a picture of a receipt (which sends everything on the paper, including
whatever else was in frame).

An installation that has not opted in **refuses by name**. It does not return an empty result.
An unreadable receipt and an empty receipt are different facts, and a pipeline that conflated
them would silently produce a ₹0 receipt for every photograph anybody uploaded. The refusal
names the configuration that would change it, and says the receipt can still be itemized by
hand.

### The provenance of the words is recorded, because it changes what the claim is

`receipts.text_source` is one of `evidence_raw_text`, `pdf_text_layer` or `model_vision`, and
`receipts.text_model` names the model when one was involved. "The receipt says ₹1,240" and "a
model reading a photograph of the receipt says ₹1,240" are different claims, and the person
confirming an extraction is entitled to know which is in front of them — the same rule every
other proposal in this system already carries (`ai-boundary.md`).

### A statement format is a declaration, not a parser

`src/integrations/statement-formats/` reads eight declared formats over three containers: HDFC,
ICICI, SBI, Axis, a card statement and a UPI app export as column maps; XLSX through a
dependency-free ZIP + SpreadsheetML reader; and a generated PDF through its own text layer.
Adding the next bank is five lines of declaration rather than a new file of parsing.

**No dependency was added for either binary container.** `node:zlib` inflates both. A
spreadsheet library in a financial ledger's dependency surface — to read two files out of a ZIP
— is a worse trade than the reader, and the same reasoning that keeps the Anthropic, Splitwise
and WhatsApp adapters SDK-free.

Two bugs the tests found are worth recording, because both would have been silent:

- The XLSX cell regex was greedy, so `<c r="E3"/>` read as an opening tag and swallowed the
  next cell. On a statement that is the debit column landing under credit.
- A PDF narration carries two things that look alike: `UPI-BLINKIT9821PAYTM` is the merchant
  handle and `UPI/2607011234/BLINKIT` is the reference. First-match-wins picked the handle,
  which would then have failed to deduplicate the same transaction arriving from the bank's own
  CSV — the exact double-count this system exists to prevent.

### Notifications arrive by forwarding, not only by pasting

Row 12's other half. `POST /api/intake/messages` accepts bank SMS and UPI push notifications
from a mail rule or a phone shortcut. It is the **one** route not behind the session, because
its callers have no browser; it is behind a dedicated shared secret instead, compared in
constant time, and an installation with no `INTAKE_FORWARDING_TOKEN` **refuses every request**
rather than standing open. The token buys exactly one capability: appending immutable evidence.
Nothing auto-links, and nothing it appends is approved by its arrival.

## Consequences

- **`EVIDENCE_MEDIA_TYPES` is now load-bearing twice**: it decides what may be stored, and
  which of those a local reader can attempt.
- **A photographed receipt on an un-opted-in installation is a visible dead end with a stated
  cause**, which is the correct shape. The alternatives were a silent empty receipt or an
  unannounced upload of somebody's shopping to a provider.
- **`fixtures/` gained synthetic statements in the real shapes.** They are generated, not
  captured: `CLAUDE.md`'s rule that no real financial data enters this repository is unchanged.
