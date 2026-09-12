/**
 * `ai.planLedgerQuery` — the tenth operation on this boundary, and the narrowest (ADR-0057).
 *
 * It turns a typed question into a **query plan**: one member of `domain.LEDGER_QUERY_KINDS`
 * with typed parameters. That is its entire contribution. It never sees a figure, never
 * computes one, and never phrases the answer — `services.answerLedgerQuestion` runs the plan
 * against reads that already exist and quotes what they return.
 *
 * Why that division and not the obvious one: a model that phrases the answer is a model
 * stating a number, and every rule in this repository — `domain` owns arithmetic, `web/`
 * recomputes nothing, an LLM never writes authoritative state — exists to keep that sentence
 * from appearing. The cost is fluency. The gain is that nothing on the screen is a figure a
 * model said.
 */

import type { AiInferenceType } from '../domain/index.js';

import { parsePlanLedgerQueryResponse } from './contract.js';
import type { Inference, LedgerQueryPlanProposal, ModelInfo } from './contract.js';
import type { ModelRequest, ModelTransport } from './classify-transaction.js';
import { redactLedgerQuestionForInference } from './redaction.js';

export const PLAN_LEDGER_QUERY: AiInferenceType = 'plan_ledger_query';
export const PLAN_LEDGER_QUERY_PROMPT_VERSION = 'plan_ledger_query/v1';

export type LedgerQuestionInput = Parameters<typeof redactLedgerQuestionForInference>[0];

/**
 * Whether asking is available at all, and why not when it is not.
 *
 * Exposed so a screen can say the question box is unavailable rather than offer one that
 * fails — ADR-0050's rule read backwards, the same argument ADR-0055 made for the repair's
 * `capability` object. It names the missing configuration, never a value
 * (`security-model.md`).
 */
export interface ModelAvailability {
  readonly provider: string;
  readonly model: string;
  readonly configured: boolean;
  readonly unavailableReason?: string;
}

export function describeTransportAvailability(transport: ModelTransport): ModelAvailability {
  const declared = transport.availability;
  return {
    provider: transport.modelInfo.provider,
    model: transport.modelInfo.model,
    // A transport that declares nothing is a real one: the refusing stub in `src/server.ts`
    // is the only thing that declares itself unconfigured, and it does so explicitly.
    configured: declared?.configured ?? true,
    ...(declared?.unavailableReason === undefined
      ? {}
      : { unavailableReason: declared.unavailableReason }),
  };
}

export async function planLedgerQuery(
  transport: ModelTransport,
  input: LedgerQuestionInput,
): Promise<Inference<LedgerQueryPlanProposal>> {
  const raw: unknown = await transport.complete({
    operation: PLAN_LEDGER_QUERY,
    promptVersion: PLAN_LEDGER_QUERY_PROMPT_VERSION,
    input: redactLedgerQuestionForInference(input),
  } satisfies ModelRequest);

  // Gate 1 of `ai-boundary.md`'s validation contract. A plan naming a kind that does not
  // exist, a period that is not a calendar day, or a key nobody asked for is rejected here,
  // before `src/services` is handed something to run.
  const { proposedOutput, confidence } = parsePlanLedgerQueryResponse(raw);

  return {
    inferenceType: PLAN_LEDGER_QUERY,
    proposedOutput,
    confidence,
    modelInfo: modelInfoFor(transport),
  };
}

function modelInfoFor(transport: ModelTransport): ModelInfo {
  return {
    provider: transport.modelInfo.provider,
    model: transport.modelInfo.model,
    promptVersion: PLAN_LEDGER_QUERY_PROMPT_VERSION,
  };
}
