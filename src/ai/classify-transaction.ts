/**
 * `ai.classifyTransaction`, plus `AiService`/`createAiService` — the composition root for
 * every operation on `ai-boundary.md`'s boundary, not only this one.
 *
 * `classifyTransaction` was the first of the nine to exist (phase 8) and this file has stayed
 * where `AiService` is assembled since — phase 11 composes `parseReceipt`/`extractReceiptItems`
 * in here too (`receipt-extraction.ts`) rather than duplicating a second `createAiService`.
 *
 * What every operation does: redact, ask, validate, return a proposal. What none of them can
 * do: reach a database. There is no import of `src/db` anywhere in `src/ai`, so "no code path
 * from `ai/*` to `db` that skips `services.decideInference()`" is a property of the module
 * graph rather than a rule someone has to remember (`ai-boundary.md`).
 *
 * The model itself sits behind {@link ModelTransport}, which this module does not implement —
 * see ADR-0025 for why no provider is wired and what that buys.
 */

import type { AiInferenceType } from '../domain/index.js';

import { parseClassificationResponse } from './contract.js';
import type {
  AllocationSuggestion,
  AnomalyExplanation,
  BeneficiarySuggestion,
  Inference,
  LedgerQueryPlanProposal,
  MerchantNormalization,
  ModelInfo,
  OccasionSuggestion,
  ReceiptDraft,
  ReceiptItemDraft,
  RuleProposal,
  TransactionClassification,
} from './contract.js';
import {
  extractReceiptItems as extractReceiptItemsOperation,
  parseReceipt as parseReceiptOperation,
} from './receipt-extraction.js';
import {
  describeTransportAvailability,
  planLedgerQuery as planLedgerQueryOperation,
} from './ask.js';
import type { LedgerQuestionInput, ModelAvailability } from './ask.js';
import {
  explainAnomaly as explainAnomalyOperation,
  groupIntoOccasion as groupIntoOccasionOperation,
  normalizeMerchant as normalizeMerchantOperation,
  proposeRule as proposeRuleOperation,
  suggestAllocation as suggestAllocationOperation,
  suggestBeneficiaries as suggestBeneficiariesOperation,
} from './suggestions.js';
import type {
  AnomalyInput,
  ExpenseContextInput,
  MerchantNarrationInput,
  OccasionCandidatesInput,
  RuleEvidenceInput,
} from './suggestions.js';
import { redactPaymentForInference } from './redaction.js';
import type {
  ClassifiablePayment,
  ClassificationContext,
  ClassifiableReceiptEvidence,
} from './redaction.js';

/** `ai_inferences.inference_type` for everything this operation produces. */
export const CLASSIFY_TRANSACTION: AiInferenceType = 'classify_transaction';

/**
 * The prompt this operation was written against.
 *
 * Stored on every `AIInference` it produces, so a proposal accepted last month can be traced
 * to the wording that produced it after the prompt has moved on. Bump it whenever the prompt
 * or the expected response shape changes.
 */
export const CLASSIFY_TRANSACTION_PROMPT_VERSION = 'classify_transaction/v1';

/**
 * One call to a model, already redacted.
 *
 * `input` is `unknown` rather than `RedactedPayment` specifically: this shape is shared by
 * every operation on the boundary, and each one redacts into its own type
 * (`RedactedPayment`, `RedactedReceiptEvidence`, …). A transport reads `operation` to know
 * which it received; nothing here asserts a shape a general-purpose transport cannot know.
 */
export interface ModelRequest {
  readonly operation: AiInferenceType;
  readonly promptVersion: string;
  readonly input: unknown;
}

/**
 * The seam between this boundary and an actual model.
 *
 * `complete` returns `unknown` on purpose: whatever comes back is untrusted until
 * `parseClassificationResponse` has had it. A transport that returned a typed object would be
 * asserting a shape it cannot know.
 */
export interface ModelTransport {
  /** Recorded on the `AIInference` so a proposal names what produced it. */
  readonly modelInfo: { readonly provider: string; readonly model: string };
  /**
   * Whether this transport can actually reach a model, and why not when it cannot
   * (ADR-0057).
   *
   * Optional, and **absent means configured** — every real adapter is. The refusing stub in
   * `src/server.ts` declares `configured: false` explicitly, which is what lets a screen say
   * "no provider is set" instead of offering a box that fails on submit. It names the missing
   * environment variable, never its value (`security-model.md`).
   */
  readonly availability?: {
    readonly configured: boolean;
    readonly unavailableReason?: string;
  };
  complete(request: ModelRequest): Promise<unknown>;
}

/**
 * The typed AI interface `src/services` depends on — all nine operations
 * `ai-boundary.md` specifies.
 *
 * The last six arrived with phase 22 (audit row 46). Each keeps the same line the first three
 * do: a proposal with a confidence, validated before `src/services` sees it, and never
 * authoritative. Two of them are worth naming here because they are the ones most easily let
 * across it — `suggestAllocation` proposes a *method* and never resolved amounts, and
 * `proposeRule` always proposes `effect: 'propose'`, never a rule that writes unattended.
 */
export interface AiService {
  classifyTransaction(
    payment: ClassifiablePayment,
    context: ClassificationContext,
  ): Promise<Inference<TransactionClassification>>;
  parseReceipt(evidence: ClassifiableReceiptEvidence): Promise<Inference<ReceiptDraft>>;
  extractReceiptItems(
    evidence: ClassifiableReceiptEvidence,
  ): Promise<Inference<readonly ReceiptItemDraft[]>>;
  normalizeMerchant(input: MerchantNarrationInput): Promise<Inference<MerchantNormalization>>;
  suggestBeneficiaries(input: ExpenseContextInput): Promise<Inference<BeneficiarySuggestion>>;
  /** A method and its inputs. Never amounts — those are `domain.buildAllocationLines`'s. */
  suggestAllocation(input: ExpenseContextInput): Promise<Inference<AllocationSuggestion>>;
  groupIntoOccasion(input: OccasionCandidatesInput): Promise<Inference<OccasionSuggestion>>;
  /** Prose about one figure, and only prose: nothing here has a field a service could write. */
  explainAnomaly(input: AnomalyInput): Promise<Inference<AnomalyExplanation>>;
  proposeRule(input: RuleEvidenceInput): Promise<Inference<RuleProposal>>;
  /**
   * A question turned into a plan over reads that already exist — never an answer (ADR-0057).
   *
   * The only operation here whose output names a *read* rather than a proposed record, and
   * the only one that can see no figure at all: there is nothing on its payload for a balance
   * or a total to occupy.
   */
  planLedgerQuery(input: LedgerQuestionInput): Promise<Inference<LedgerQueryPlanProposal>>;
  /** Whether a model is configured at all, for a screen that must not offer what cannot run. */
  describeAvailability(): ModelAvailability;
}

/**
 * Builds the AI service over a transport.
 *
 * The transport is a required argument, so there is no "unconfigured" service that could fail
 * halfway through a classification run — a caller either has a model or does not have a
 * service.
 */
export function createAiService(transport: ModelTransport): AiService {
  const modelInfo: ModelInfo = {
    provider: transport.modelInfo.provider,
    model: transport.modelInfo.model,
    promptVersion: CLASSIFY_TRANSACTION_PROMPT_VERSION,
  };

  return {
    async classifyTransaction(payment, context) {
      const raw: unknown = await transport.complete({
        operation: CLASSIFY_TRANSACTION,
        promptVersion: CLASSIFY_TRANSACTION_PROMPT_VERSION,
        input: redactPaymentForInference(payment, context),
      });

      // Gate 1 of ai-boundary.md's validation contract. Anything short of the exact contract
      // throws here, and `src/services` is never handed a proposal to persist.
      const { proposedOutput, confidence } = parseClassificationResponse(raw);

      return { inferenceType: CLASSIFY_TRANSACTION, proposedOutput, confidence, modelInfo };
    },
    parseReceipt: (evidence) => parseReceiptOperation(transport, evidence),
    extractReceiptItems: (evidence) => extractReceiptItemsOperation(transport, evidence),
    normalizeMerchant: (input) => normalizeMerchantOperation(transport, input),
    suggestBeneficiaries: (input) => suggestBeneficiariesOperation(transport, input),
    suggestAllocation: (input) => suggestAllocationOperation(transport, input),
    groupIntoOccasion: (input) => groupIntoOccasionOperation(transport, input),
    explainAnomaly: (input) => explainAnomalyOperation(transport, input),
    proposeRule: (input) => proposeRuleOperation(transport, input),
    planLedgerQuery: (input) => planLedgerQueryOperation(transport, input),
    describeAvailability: () => describeTransportAvailability(transport),
  };
}
