/**
 * The six operations `ai-boundary.md` specified and no phase had built (audit row 46):
 * `normalizeMerchant`, `suggestBeneficiaries`, `suggestAllocation`, `groupIntoOccasion`,
 * `explainAnomaly` and `proposeRule`.
 *
 * Same shape as every operation before them — redact, ask, validate, return a proposal — and
 * the same thing none of them can do: there is no import of `src/db` in this module, so
 * nothing here can turn a proposal into state.
 *
 * The line each one is drawn on, because they are the operations most tempting to let across:
 *
 *  - `suggestAllocation` proposes a **method**, never amounts. `equal` and `percentage` are the
 *    only proposable methods; `exact`, `custom` and the item-sourced ones *are* sets of amounts,
 *    and amounts are `domain.buildAllocationLines`'s alone (`invariants.md` #12).
 *  - `suggestBeneficiaries` proposes **who**, and carries no money field at all.
 *  - `proposeRule` always proposes `effect: 'propose'`. A model may notice a repeated decision;
 *    it may not decide that the next one should be written unattended.
 *  - `explainAnomaly` returns prose and only prose — there is no field a service could persist.
 *  - `normalizeMerchant` proposes a **catalogue entry**. Resolution stays an exact alias match
 *    (ADR-0022); the model saves typing, not the decision.
 */

import type { AiInferenceType } from '../domain/index.js';

import {
  parseExplainAnomalyResponse,
  parseGroupIntoOccasionResponse,
  parseNormalizeMerchantResponse,
  parseProposeRuleResponse,
  parseSuggestAllocationResponse,
  parseSuggestBeneficiariesResponse,
} from './contract.js';
import type {
  AllocationSuggestion,
  AnomalyExplanation,
  BeneficiarySuggestion,
  Inference,
  MerchantNormalization,
  ModelInfo,
  OccasionSuggestion,
  RuleProposal,
} from './contract.js';
import type { ModelRequest, ModelTransport } from './classify-transaction.js';
import {
  redactAnomalyForInference,
  redactExpenseContextForInference,
  redactMerchantNarrationForInference,
  redactOccasionCandidatesForInference,
  redactRuleEvidenceForInference,
} from './redaction.js';

export const NORMALIZE_MERCHANT: AiInferenceType = 'normalize_merchant';
export const SUGGEST_BENEFICIARIES: AiInferenceType = 'suggest_beneficiaries';
export const SUGGEST_ALLOCATION: AiInferenceType = 'suggest_allocation';
export const GROUP_INTO_OCCASION: AiInferenceType = 'group_into_occasion';
export const EXPLAIN_ANOMALY: AiInferenceType = 'explain_anomaly';
export const PROPOSE_RULE: AiInferenceType = 'propose_rule';

export const NORMALIZE_MERCHANT_PROMPT_VERSION = 'normalize_merchant/v1';
export const SUGGEST_BENEFICIARIES_PROMPT_VERSION = 'suggest_beneficiaries/v1';
export const SUGGEST_ALLOCATION_PROMPT_VERSION = 'suggest_allocation/v1';
export const GROUP_INTO_OCCASION_PROMPT_VERSION = 'group_into_occasion/v1';
export const EXPLAIN_ANOMALY_PROMPT_VERSION = 'explain_anomaly/v1';
export const PROPOSE_RULE_PROMPT_VERSION = 'propose_rule/v1';

type RedactorInput = Parameters<typeof redactExpenseContextForInference>[0];
export type ExpenseContextInput = RedactorInput;
export type MerchantNarrationInput = Parameters<typeof redactMerchantNarrationForInference>[0];
export type OccasionCandidatesInput = Parameters<typeof redactOccasionCandidatesForInference>[0];
export type AnomalyInput = Parameters<typeof redactAnomalyForInference>[0];
export type RuleEvidenceInput = Parameters<typeof redactRuleEvidenceForInference>[0];

function modelInfoFor(transport: ModelTransport, promptVersion: string): ModelInfo {
  return {
    provider: transport.modelInfo.provider,
    model: transport.modelInfo.model,
    promptVersion,
  };
}

export async function normalizeMerchant(
  transport: ModelTransport,
  input: MerchantNarrationInput,
): Promise<Inference<MerchantNormalization>> {
  const raw: unknown = await transport.complete({
    operation: NORMALIZE_MERCHANT,
    promptVersion: NORMALIZE_MERCHANT_PROMPT_VERSION,
    input: redactMerchantNarrationForInference(input),
  } satisfies ModelRequest);
  const { proposedOutput, confidence } = parseNormalizeMerchantResponse(raw);
  return {
    inferenceType: NORMALIZE_MERCHANT,
    proposedOutput,
    confidence,
    modelInfo: modelInfoFor(transport, NORMALIZE_MERCHANT_PROMPT_VERSION),
  };
}

export async function suggestBeneficiaries(
  transport: ModelTransport,
  input: ExpenseContextInput,
): Promise<Inference<BeneficiarySuggestion>> {
  const raw: unknown = await transport.complete({
    operation: SUGGEST_BENEFICIARIES,
    promptVersion: SUGGEST_BENEFICIARIES_PROMPT_VERSION,
    input: redactExpenseContextForInference(input, 'suggestBeneficiaries'),
  } satisfies ModelRequest);
  const { proposedOutput, confidence } = parseSuggestBeneficiariesResponse(raw);
  return {
    inferenceType: SUGGEST_BENEFICIARIES,
    proposedOutput,
    confidence,
    modelInfo: modelInfoFor(transport, SUGGEST_BENEFICIARIES_PROMPT_VERSION),
  };
}

export async function suggestAllocation(
  transport: ModelTransport,
  input: ExpenseContextInput,
): Promise<Inference<AllocationSuggestion>> {
  const raw: unknown = await transport.complete({
    operation: SUGGEST_ALLOCATION,
    promptVersion: SUGGEST_ALLOCATION_PROMPT_VERSION,
    input: redactExpenseContextForInference(input, 'suggestAllocation'),
  } satisfies ModelRequest);
  const { proposedOutput, confidence } = parseSuggestAllocationResponse(raw);
  return {
    inferenceType: SUGGEST_ALLOCATION,
    proposedOutput,
    confidence,
    modelInfo: modelInfoFor(transport, SUGGEST_ALLOCATION_PROMPT_VERSION),
  };
}

export async function groupIntoOccasion(
  transport: ModelTransport,
  input: OccasionCandidatesInput,
): Promise<Inference<OccasionSuggestion>> {
  const raw: unknown = await transport.complete({
    operation: GROUP_INTO_OCCASION,
    promptVersion: GROUP_INTO_OCCASION_PROMPT_VERSION,
    input: redactOccasionCandidatesForInference(input),
  } satisfies ModelRequest);
  const { proposedOutput, confidence } = parseGroupIntoOccasionResponse(raw);

  // A proposal naming an expense that was not offered is rejected here rather than downstream:
  // the candidate set is the whole authority for what this operation may group, and a model
  // recalling an id from somewhere else has said something about a row it was never shown.
  const offered = new Set(input.map((expense) => expense.id));
  const unknown = proposedOutput.expenseIds.filter((id) => !offered.has(id));
  if (unknown.length > 0) {
    const { AiContractError } = await import('./errors.js');
    throw new AiContractError(
      'FIELD_INVALID',
      `The proposal names expense(s) that were not among the candidates: ${unknown.join(', ')}.`,
      { field: 'proposedOutput.expenseIds' },
    );
  }

  return {
    inferenceType: GROUP_INTO_OCCASION,
    proposedOutput,
    confidence,
    modelInfo: modelInfoFor(transport, GROUP_INTO_OCCASION_PROMPT_VERSION),
  };
}

export async function explainAnomaly(
  transport: ModelTransport,
  input: AnomalyInput,
): Promise<Inference<AnomalyExplanation>> {
  const raw: unknown = await transport.complete({
    operation: EXPLAIN_ANOMALY,
    promptVersion: EXPLAIN_ANOMALY_PROMPT_VERSION,
    input: redactAnomalyForInference(input),
  } satisfies ModelRequest);
  const { proposedOutput, confidence } = parseExplainAnomalyResponse(raw);
  return {
    inferenceType: EXPLAIN_ANOMALY,
    proposedOutput,
    confidence,
    modelInfo: modelInfoFor(transport, EXPLAIN_ANOMALY_PROMPT_VERSION),
  };
}

export async function proposeRule(
  transport: ModelTransport,
  input: RuleEvidenceInput,
): Promise<Inference<RuleProposal>> {
  const raw: unknown = await transport.complete({
    operation: PROPOSE_RULE,
    promptVersion: PROPOSE_RULE_PROMPT_VERSION,
    input: redactRuleEvidenceForInference(input),
  } satisfies ModelRequest);
  const { proposedOutput, confidence } = parseProposeRuleResponse(raw);
  return {
    inferenceType: PROPOSE_RULE,
    proposedOutput,
    confidence,
    modelInfo: modelInfoFor(transport, PROPOSE_RULE_PROMPT_VERSION),
  };
}
