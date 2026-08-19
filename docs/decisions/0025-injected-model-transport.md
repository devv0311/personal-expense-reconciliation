# 0025. The model transport is injected; phase 8 wires no provider

**Status:** Accepted

## Context

`src/ai` had to become real in phase 8 (ADR-0022). "Real" raises an immediate question: does it
call Anthropic's API?

Two constraints say no. `CLAUDE.md`: _"Do not connect real bank accounts, real Splitwise
accounts, or use real financial credentials during development. Build adapters/interfaces now;
wire real connections later, deliberately."_ And `security-model.md` puts the provider API key in
a deployment secret manager, which does not exist yet either.

But "no provider" cannot mean "no code". The boundary's whole value is the validation, the
redaction and the `Inference<T>` envelope, and none of that is testable if the only way to
produce a proposal is a live model.

## Decision

**`src/ai` owns the contract; a `ModelTransport` owns the call.**

```ts
interface ModelTransport {
  readonly modelInfo: { provider: string; model: string };
  complete(request: ModelRequest): Promise<unknown>;
}

createAiService(transport: ModelTransport): AiService;
```

`createAiService` redacts the payment (`redactPaymentForInference`), asks the transport, and
validates whatever comes back (`parseClassificationResponse`). `complete` returns `unknown`,
because a transport that returned a typed object would be asserting a shape it cannot know — the
response is untrusted until the parser has had it.

**No production transport ships in this phase.** The integration suite injects one scripted from
`fixtures/ai-classification-proposals.json`, so the real validator, the real service, the real
routing and the real database all run in the test; only the model is synthetic.

The transport is a **required constructor argument**, so there is no half-configured service that
could fail in the middle of a classification run. A caller either has a model or does not have a
service.

`modelInfo` comes from the transport rather than from configuration alongside it: what produced
a proposal is a fact the transport knows, and duplicating it in a config object is how a stored
`model_name` starts disagreeing with the model that actually answered. `promptVersion` comes from
the operation module, since the prompt belongs to the operation, not to the model.

## Consequences

**Phase 8 ships an AI boundary that has never spoken to a model.** That is the intended state,
and it is the same stance the repository already takes toward Splitwise (`src/integrations/
splitwise/` is a README). What ships is everything that decides whether a model's answer may
become state — which is the part financial correctness depends on.

**Writing the production transport is a small, isolated task.** It implements one method, and
nothing about validation, redaction, routing or persistence changes when it lands. It will need:
the API key from the environment, a prompt that produces the `{ confidence, proposedOutput }`
shape, JSON extraction from the model's response, and a timeout/retry policy. The retry policy is
genuinely undecided and is deliberately not pre-empted here.

**A transport failure is not a contract failure.** `complete` rejecting (network, timeout, rate
limit) surfaces unchanged; only a response that breaches the contract becomes an
`AiContractError`. The caller's decision — retry the payment later vs. record that the model
answered nonsense — depends on telling those apart, so they are not collapsed into one error
type.

**Prompt text is not in the repository yet.** The transport that will need it does not exist, and
a prompt with no caller is a document, not code. `CLASSIFY_TRANSACTION_PROMPT_VERSION`
(`classify_transaction/v1`) is stored on every inference so the version can be tied to its text
once that text exists.

## Alternatives considered

- **Wire an Anthropic client now, behind an environment flag.** Rejected: it contradicts
  `CLAUDE.md`'s "wire real connections later, deliberately", it would put an untested,
  unrunnable code path in CI, and the flag itself becomes a second thing to reason about
  ("was this proposal real or stubbed?") in a system whose whole point is knowing where a number
  came from.
- **Have `src/ai` expose a pure `parseClassificationResponse` only, and let `src/services` own
  the call.** Rejected: it moves redaction and prompt versioning into the orchestration layer,
  which `security-model.md` explicitly forbids ("a named function in `src/ai`, not inlined ad hoc
  at each call site"), and leaves `src/ai` as a validation utility rather than the boundary
  `ai-boundary.md` describes.
- **Ship a stub transport in `src/ai` that returns a fixed proposal.** Rejected for the reason
  ADR-0022 rejected the same shape for `normalizeMerchant`: it manufactures inference records no
  model produced. A scripted transport belongs in the test harness, where nobody can mistake its
  output for evidence.
