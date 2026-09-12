# 0057. A question is a plan over reads the ledger already answers

**Status:** Accepted

## Context

`ai-boundary.md` has named "natural-language interaction" among the things AI owns since the
first revision, and nothing has ever implemented it. It is the last item on
[ADR-0050](0050-closing-the-audit-gaps-a-workflow-is-not-shipped-until-it-is-reachable.md)'s
list, and the capability audit's row 45 was precise about what exists in its place:

> `Cmd+K` is navigation search. It is not natural-language expense entry, question answering or
> anomaly explanation.

The roadmap already wrote down the three constraints that make this hard, and they are the
right three:

> an NL question against the ledger is a read that must recompute nothing (ADR-0048's rule,
> applied to a new surface), an NL _instruction_ has to land as a proposal a person confirms
> (`ai-boundary.md`), and the query itself crosses the sanitization boundary (pillar 6).

The obvious implementation fails all three at once. Hand a model the question, let it write SQL
or call tools freely, let it phrase the answer: now a model has arbitrary read access to
somebody's entire financial history, it states figures it computed itself, and "₹4,200" on the
screen has no provenance at all. Every rule this repository has — `domain` owns arithmetic, the
frontend recomputes nothing, an LLM never writes authoritative state — exists to prevent exactly
that sentence appearing anywhere, and a chat box is not an exemption from it.

## Decision

### The model plans; the ledger answers

A question produces a **query plan**: one member of a closed set of query kinds, with typed
parameters. That is the model's entire contribution. It never sees a figure, never computes one,
and never phrases the answer.

The answer is assembled server-side by calling the **existing authoritative service reads** —
`getCategorySpend`, `getMonthlySpend`, `getOwnSpend`, `getOutstandingBalances`,
`getUnsettledPaidOnBehalf`, `getBalance`, `listExpensePage`, `listExpenseAdjustments`,
`listSettlementRegisterEntries`, `listReconciliationRunHistory`/`getReconciliationRun`,
`listPaymentsWorkspace`, `listAuditFindings` — and quoting what they return. Every figure in an
answer is a figure some screen in this product already shows, produced by the same function that
produces it there.

This is ADR-0047's rule for proof packs (_"a pack that recomputes a share is a bug"_) applied to
a second derived surface, and ADR-0048's rule for `web/` applied to a surface that is not the
browser. If an answer needs a number no read produces, the read gets added to `src/services` —
never the arithmetic to the answerer, and never to the model.

The prose around the figures is composed deterministically from the plan and the result. There
is no field on the response a model wrote. That costs fluency, and it buys the one property this
surface has to have: **nothing on the screen is a number a model said.**

### There is no free-text query, anywhere

`QueryPlan` has no field that could carry SQL, a table name, a column name, a filter expression
or a path. The parameters are a period, an optional person, an optional category, an optional
free-text _search term_ that reaches `listExpensePage`'s existing parameterised `search` filter
and nothing else, and a bounded `limit`. The executor is a `switch` over the closed kind set;
adding a query means writing a branch, reviewing it, and testing it.

A model that invents a kind, a parameter, or an extra key is rejected by
`parseAskQueryPlanResponse` before `src/services` is handed anything — gate 1 of
`ai-boundary.md`'s validation contract, the same hand-written strict parser every other
operation passes through. A plan that parses but cannot be answered — a period that ends before
it starts, a person id that names nobody, a limit out of range — is refused by gate 2 in the
service.

### It is ask-only, structurally

`services.answerLedgerQuestion` imports no writer. It never opens `runAudited`, has no
`AuditMeta` parameter, and there is no branch in it that could reach a mutation — so "this
cannot write" is a property of the module graph rather than a rule somebody has to keep
remembering, the same way `src/ai` cannot reach `src/db`.

`POST /api/ask` is a POST because a question is a request body, not because it changes anything.
It writes no row, sends nothing outward, and touches no external system.

An **instruction** — "mark this settled", "delete that expense", "split it three ways" — is
therefore not something to route; it is something to refuse, and the plan's own vocabulary says
so. `unsupported_write_request` is one of the three non-answering plan kinds, and the answer
names the screen where a person can do the thing themselves. Turning an instruction into a
staged proposal is a different capability with a different ADR; nothing here half-implements it.

### Three honest non-answers

A plan may decline, in three distinguishable ways, and each produces an answer that states no
figure:

- `unsupported_question` — the ledger has no read that answers this. The response lists what can
  be asked, so a dead end is also a menu.
- `ambiguous_question` — the question is answerable but underdetermined: it names a person who
  matches nobody or several people, or a period that could be read two ways. The response asks
  the clarifying question and offers the candidates it found.
- `unsupported_write_request` — as above.

Resolving a name to a `Person` happens in `src/services` against the roster, not in the model: a
plan carries the **name as asked**, and the service matches it. A model guessing a person id
would be a model deciding whose balance to show.

### Confidence describes the reading, and waives nothing

A plan carries a confidence like every other inference. Nothing here is approved, so confidence
cannot lower a bar there is no bar for — what it does instead is change what the answer says
about itself. Every answer states the interpretation it ran (_"read as: your own share of
spending, 1–31 August 2026"_); a `low` or `unknown` confidence states it more prominently and
offers the clarification path beside it.

This does not soften `invariants.md` #16. The rule is that a model's confidence never authorizes
a consequential act, and this surface performs no consequential act at all. **No answer
authorizes anything**: where an answer implies something ought to be done, it links to the
screen where a person does it, behind that screen's own dialog and its own recorded reason.

### The question crosses the boundary, so the question is sanitized

A typed question is free text a person wrote, and people paste account numbers into free text.
`ai.redactAskQuestion` masks identifiers the same way `redactDescription` does, and
`assertPayloadSanitized` runs over the outgoing payload under the `statement_text` profile — so
a question that still carries an identifier is **refused rather than sent** (ADR-0044's
fail-closed rule, unchanged).

What goes out is the redacted question plus a description of the _capabilities_ — the query
kinds, the roster's display names, the category list. No amounts, no balances, no evidence text,
no ids beyond the person ids the roster already exposes to the browser.

**Nothing is persisted.** No table, no migration, no row: an answer is derived on demand from
approved state, exactly as a proof pack is (ADR-0047). That keeps raw questions off disk, and it
means there is no second store of financial statements to keep consistent with the first. Model
provenance — provider, model, prompt version, confidence — is returned _with_ the answer, so a
person can see what read their question without the question being filed anywhere.

### Unavailable is a state the screen can read

`ModelTransport` gains an optional `availability`, and `AiService` a `describeAvailability()`.
`GET /api/ask/capabilities` reports whether a model is configured, what can be asked, and why
asking is unavailable when it is — naming the missing environment variable, never its value.

A screen that offers a question box over an unconfigured provider is ADR-0050's rule read
backwards, which ADR-0055 already made the same argument about for the repair. Every figure the
question box would have reported is reachable from the screens that own it, configured or not,
and the unavailable state says so.

## Consequences

- "What did I spend on food last month?" is answerable, and the number it answers with is the
  same number `/analytics` shows, because it is literally the same call.
- A question the ledger cannot answer says so and lists what it can, rather than producing a
  confident sentence about nothing.
- The model is a parser. Swapping it, losing it, or having it hallucinate changes which read
  runs — never what a read returns. The worst failure available on this path is answering a
  different question than the one asked, stated in the interpretation line where a person can
  see it.
- `ai-boundary.md`'s nine operations become ten, and `AI_INFERENCE_TYPES` gains
  `plan_ledger_query` so the type is nameable — though this operation writes no `AIInference`
  row, because it produces no proposal anybody accepts.
- Still not built, deliberately: natural-language **entry**. Landing an instruction as a staged,
  confirmable proposal is the harder half, it needs the editor for stored proposals the roadmap
  already lists as missing, and pretending a refusal is a placeholder for it would be the same
  mistake the audit found eleven times.
