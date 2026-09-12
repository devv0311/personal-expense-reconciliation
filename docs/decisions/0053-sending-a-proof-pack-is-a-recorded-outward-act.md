# 0053. Sending a proof pack is a recorded outward act, and never a settlement

**Status:** Accepted

## Context

The fifth pillar is called "One-Click WhatsApp Proof Packs". Phase 20 built the pack
(ADR-0047) and Phase 21 built the review and the copy button. The 7 September audit's row 42
was precise about what was left:

> Copying prepares text for manual use elsewhere; it does not send a message, package
> recipient-accessible attachments or record a settlement.

ADR-0050 listed a message transport among the four things that stayed genuinely unbuilt, and
said each would need its own decision record. This is that record.

Sending is unlike every other write in this product. Every other one changes what this ledger
believes. This one changes what _somebody else_ knows, and it cannot be undone: an allocation
can be superseded, an adjustment reversed, an expense corrected — a message that has arrived
has arrived. Two temptations follow from that and both are refused here. The first is to treat
the send as the natural continuation of the copy button, one more click on the same path. The
second is to treat a delivered pack as evidence the debt was acknowledged, or worse, settled.

## Decision

### The message is derived at send time, by the server, from the ledger

`POST /api/proof-packs/:recipientPersonId/deliveries` has no field for the message. It takes a
recipient, a channel, an address, the three review confirmations, an optional list of evidence
to attach, and the as-of label the reviewer saw. `services.sendProofPack` then calls
`buildProofPackPreview` itself and sends what comes back.

This is ADR-0048's rule at the point where it matters most. Everywhere else, a frontend that
computed a figure would render a wrong number on a screen; here, a frontend that could supply
the body could put any figure it liked in front of another person, over the user's own WhatsApp
account, with the user's name on it.

A stale review is caught rather than sent: the preview now returns `contentDigest` — a
server-derived SHA-256 of the exact text — and the browser echoes it back as
`contentDigestSeen`. A ledger that moved between reading and sending produces a different
digest, and the send is refused with the current message offered for re-reading.

### Sending is a third act, after generating and after copying

Generating a pack is a pure read and still writes nothing. Copying is unchanged and still sends
nothing. Sending is a separate button, in a separate section, behind the **same three review
confirmations** — who it is for, what it says, which evidence it cites — which are now enforced
in `src/domain` as well as in the browser, because a check that lives only in a screen is a
check an API call skips.

The consequence is stated in the caller's own words before the button, as ADR-0049 requires:
_it leaves this machine and cannot be recalled_, and _it records no settlement_.

### Nothing about a delivery is a financial fact

`proof_pack_deliveries` records that a message was put in front of somebody. It writes no
`Settlement`, no `Payment`, no `Allocation`, and touches no balance. If the recipient pays,
that is a payment with its own evidence, classified like any other (`invariants.md` #9).

The table does store the exact text that was sent, which is the one place this decision adds
persistence to a design ADR-0047 deliberately kept persistence-free. The justification is
narrow: "what exactly did I send them" cannot be re-derived, because re-deriving it produces
_today's_ pack rather than the one that went. It is a record of a message, not a second copy of
the balance. Everything describing what left — recipient, address, body, digest, attachments —
is write-once at the role level; only the delivery's own progress moves.

### A resend of unchanged content is the same delivery

`domain.deliveryIdempotencyKey` folds recipient, channel, canonical address, the message digest
and the attachment set into one value, under a unique index. Pressing send twice on an
unchanged pack collides there and returns the existing record; the transport is never reached,
and the route answers `200` rather than `201` so the two outcomes are distinguishable.

Changing one rupee of the pack produces a different key, because it is genuinely a different
thing to have sent somebody.

### A failure is recorded, never lost

The delivery row is written in `pending` _before_ the transport is called, so a process that
dies mid-send leaves a record saying an attempt was made rather than silence. The transport
call happens outside that transaction, and its outcome — accepted with a provider id, or
refused with a reason — is written in a second audited unit of work. A refusal then raises
`MESSAGE_DELIVERY_FAILED` **after** the `failed` row exists.

Retry is explicit, capped at five attempts, and only available on a `failed` delivery. A `sent`
or `delivered` one is not retryable: the cure for "I am not sure it arrived" is a delivery
status, not a second copy in somebody's chat. A retry sends the text **as recorded**, not
freshly derived — a retry is another attempt at _that_ message.

`sent` and `delivered` are separate states. `sent` means the transport took responsibility;
`delivered` means the provider later said it reached the recipient. `POST
/api/deliveries/status` is the only path an external system can move a row, and it is bounded
hard: it may only advance a message this ledger handed over, it may never create a delivery,
and an unknown provider id is a 404.

### Attachments are an allowlist by evidence type, not a per-case judgement

Only `receipt_image` and `email_receipt` may be attached, and only when the pack actually cites
them. A receipt is the document the shared purchase _is_ — the recipient is being asked to
accept a share of what it records. Everything else carries facts about the user's own accounts:
`bank_line` is a statement row, `upi_notification` carries a handle and often a balance,
`screenshot`'s provenance is unknowable from its type, `manual_note` is the user's own
reasoning. None of that becomes safe because somebody ticked a box, so the refusal is by type.

The check is all-or-nothing: a partial send whose missing attachment is mentioned nowhere would
look complete to the recipient and successful to the sender. The filename the recipient sees is
`receipt-<8 hex>.pdf` — no merchant, no label, no context travelling in a field nobody reviewed.

### An unconfigured installation says so before anything is typed

`WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` wire the real WhatsApp Cloud API adapter.
Absent either, the composition root installs a transport that **refuses by name**, and
`GET /api/messaging/status` is what the screen reads to replace the send form with the reason
and the variable names. The same shape as the unconfigured Splitwise port and model transport:
a transport that resolved "accepted" and did nothing would write a record saying a person had
been shown their balance when nobody had, which is worse than any failure it replaces.

## Consequences

- **`MESSAGE_CHANNELS` has one member and that is deliberate.** A channel is an adapter, an
  address format, an attachment rule and a status vocabulary that somebody had to write. Adding
  one should have a file attached to it.
- **The Cloud API's two-step upload shapes the send order.** Attachments are uploaded before
  the text is sent, so a failed upload means nothing was sent at all — rather than a bare
  message the recipient cannot check and a sender who believes proof went with it.
- **No dependency was added.** The adapter is a handful of HTTPS JSON calls behind the port,
  the same trade the Anthropic and Splitwise adapters made.
- **Implementation is verified without credentials.** The adapter's own behaviour is tested
  against a scripted `fetch`, and the service and route behaviour against an in-memory
  transport. What is _not_ verified here is a real WhatsApp account accepting a real message;
  that needs a live Meta app and is stated as such rather than implied by a green suite.
