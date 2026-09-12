/**
 * A concrete {@link ModelTransport} over Anthropic's Messages API — the first real provider
 * this repository has had (ADR-0025 deferred one until a phase needed it; the audit's rows 05,
 * 09 and 14 are that phase).
 *
 * What this file is allowed to do is narrow, and the narrowness is the point:
 *
 *  - It receives an **already-redacted** payload. `src/ai` redacts and then calls
 *    `assertPayloadSanitized` before a transport is handed anything, so nothing here has to be
 *    trusted to protect the boundary — and nothing here is given the chance to widen it. This
 *    module has no import of `src/db`, and no access to an evidence store, an account number,
 *    or a person's real name.
 *  - It returns `unknown`. Whatever the model says goes straight back to
 *    `parseClassificationResponse`, which treats it as untrusted input exactly like a request
 *    body. A transport that returned a typed object would be asserting a shape it cannot know.
 *  - It proposes. Nothing it returns is authoritative, and every proposal still needs a
 *    person's decision before it becomes state (`ai-boundary.md`).
 *
 * No SDK dependency: the Messages API is one JSON `POST`, and adding a package to this
 * repository's dependency surface to make it would be a worse trade than forty lines of
 * `fetch`. `docs/architecture/ai-boundary.md` records the same reasoning for the boundary
 * itself.
 */

import type { AiInferenceType } from '../../domain/index.js';
import type { ModelRequest, ModelTransport } from '../../ai/index.js';

/** The default model. Overridable per deployment; recorded on every proposal it produces. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Bounded so a runaway response cannot stall an import; a proposal is a small object. */
const MAX_OUTPUT_TOKENS = 2048;

export interface AnthropicTransportOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** Overridable so a test can point at a local stub without a network call. */
  readonly baseUrl?: string;
  readonly maxOutputTokens?: number;
  /** Injected for testing; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Raised when the provider itself fails — distinct from a response that breaches the contract. */
export class ModelTransportError extends Error {
  public readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ModelTransportError';
    this.status = status;
  }
}

/**
 * The system prompt, per operation.
 *
 * Each one states the same two rules the architecture states: return **only** the JSON object,
 * and propose rather than decide. The response shapes are the contract in `src/ai/contract.ts`;
 * a model that returns anything else is rejected there, so these prompts describe the shape
 * rather than being the thing that enforces it.
 */
const SYSTEM_PROMPTS: Readonly<Record<AiInferenceType, string>> = {
  classify_transaction: [
    'You classify one already-redacted bank or UPI transaction for a personal expense ledger.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    'For a purchase or a shared cost:',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"proposedKind":"expense",',
    '     "relationshipType":"personal|shared|paid_on_behalf|gift|household_shared_flat",',
    '     "category":<string or null>,',
    '     "paidByPersonHint":{"type":"person","id":<id from counterpartyCandidates>} or null}}',
    '',
    'For a repayment between people (settling an existing debt, not a new cost):',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"proposedKind":"settlement",',
    '     "counterpartyPersonHint":{"type":"person","id":<id from counterpartyCandidates>}}}',
    '',
    'Rules:',
    '- Include no key other than those listed. An extra key is a contract breach and the whole',
    '  answer is discarded.',
    '- A settlement discharges an existing debt. A payment for something newly bought is an',
    '  expense, never a settlement.',
    '- Only ever name an id that appears in counterpartyCandidates. Never invent one.',
    '- Use "unknown" confidence when the description does not support a conclusion. An honest',
    '  "unknown" routes the payment to a person for review, which is the correct outcome —',
    '  a confident guess is worse than no guess.',
  ].join('\n'),
  parse_receipt: [
    'You read the totals off one already-redacted receipt for a personal expense ledger.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"merchantHint":<string or null>,',
    '     "subtotalMinorUnits":<integer minor units as a decimal string, or null>,',
    '     "taxMinorUnits":<same, or null>,',
    '     "totalMinorUnits":<same, or null>,',
    '     "currency":"INR"}}',
    '',
    'Rules:',
    '- Include no key other than those listed. An extra key is a contract breach.',
    '- Every amount is an exact count of paise as a string: ₹12.34 is "1234". Never a float,',
    '  never a rupee figure.',
    '- Use null for anything the document does not state. Do not compute a missing subtotal or',
    '  tax from the others — the ledger does its own arithmetic, and a derived figure recorded',
    '  as an observed one is a false reading of the document.',
  ].join('\n'),
  extract_receipt_items: [
    'You list the line items on one already-redacted receipt for a personal expense ledger.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":[{"description":<string>,',
    '     "quantity":<positive decimal string, e.g. "1" or "2.5">,',
    '     "unitPriceMinorUnits":<integer minor units as a decimal string, or null>,',
    '     "lineTotalMinorUnits":<integer minor units as a decimal string>,',
    '     "suggestedCategory":<string or null>}]}',
    '',
    'Rules:',
    '- Include no key other than those listed on an item. An extra key is a contract breach.',
    '- Every amount is an exact count of paise as a string: ₹12.34 is "1234".',
    '- `lineTotalMinorUnits` is the line total as printed — not a unit price.',
    '- Return only items the document actually lists. Never add a "tax" or "total" line as an',
    '  item.',
    '- Return an empty array when the document lists none.',
  ].join('\n'),
  normalize_merchant: [
    'You name the merchant behind one already-redacted statement narration.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"canonicalName":<string>,',
    '     "aliasHint":<the narration fragment that identifies this merchant, or null>,',
    '     "suggestedCategory":<string or null>}}',
    '',
    'Rules:',
    '- Include no key other than those listed.',
    '- Reuse a name from knownMerchants exactly when the narration is the same shop. Coining a',
    '  second spelling of a shop already in the catalogue splits its history in two.',
    '- `aliasHint` is a fragment of the narration you were shown, never a name you invented.',
    '- Use "unknown" confidence when the narration does not identify a merchant. An unresolved',
    '  merchant is a fine outcome; a wrong one is silently mis-filed spending.',
  ].join('\n'),
  suggest_beneficiaries: [
    'You say WHO benefited from one already-redacted expense. You never say how much.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"people":[{"type":"person","id":<id from candidatePeople>}],',
    '     "rationale":<one sentence, or null>}}',
    '',
    'Rules:',
    '- Include no key other than those listed. There is no amount field, deliberately: what',
    '  each person owes is arithmetic the ledger performs, never a judgement you make.',
    '- Only ever name an id from candidatePeople. Never invent one.',
    '- Include the payer when they also benefited, which is the usual case for a shared meal.',
    '- Use "unknown" confidence when the evidence does not say who was there.',
  ].join('\n'),
  suggest_allocation: [
    'You say HOW one already-redacted expense should be divided — a method, never amounts.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    'Everyone shared it evenly:',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"method":"equal",',
    '     "beneficiaries":[{"type":"person","id":<id from candidatePeople>}]}}',
    '',
    'They agreed uneven shares:',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"method":"percentage",',
    '     "lines":[{"beneficiary":{"type":"person","id":<id>},"percentage":"33.33"}]}}',
    '',
    'Rules:',
    '- Include no key other than those listed. "equal" and "percentage" are the only methods',
    "  you may propose: every other method IS a set of amounts, and amounts are the ledger's.",
    '- Percentages are exact decimal strings with at most two places, and must sum to 100.',
    '- Only ever name an id from candidatePeople.',
    '- Prefer "equal" unless the evidence actually states uneven shares. An invented split is',
    '  a real debt between real people.',
  ].join('\n'),
  group_into_occasion: [
    'You say which of these already-redacted expenses were one occasion — one evening, one',
    'trip, one outing.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"name":<short name for the occasion>,',
    '     "expenseIds":[<two or more ids from the candidates>],',
    '     "rationale":<one sentence, or null>}}',
    '',
    'Rules:',
    '- Include no key other than those listed.',
    '- Only ever name an id you were shown. An id from anywhere else is rejected outright.',
    '- Group at least two expenses. One expense on its own is just an expense.',
    '- Group only what plainly belongs together — adjacent in time and coherent as one outing.',
    "  A loose grouping makes a person's history harder to read, not easier.",
  ].join('\n'),
  explain_anomaly: [
    'You suggest what one figure the ledger cannot account for might be. You are guessing, and',
    'the answer is read as a guess.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"summary":<one sentence>,',
    '     "possibleCauses":[<most likely first>],',
    '     "suggestedChecks":[<what a person could look at to settle it>]}}',
    '',
    'Rules:',
    '- Include no key other than those listed.',
    '- Never state a cause as fact. Every entry is a hypothesis for a person to check.',
    '- Do not repeat anything in knownExplanations — the ledger already accounts for those.',
    '- Say so plainly, with "unknown" confidence, when the information does not support a',
    '  guess. An unexplained amount is a first-class outcome in this system, not a failure.',
  ].join('\n'),
  propose_rule: [
    'You notice that several decisions a person already made follow one pattern, and propose a',
    'standing rule that would restate it.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"name":<short name for the rule>,',
    '     "descriptionOperator":"contains|equals|startsWith",',
    '     "description":<the narration fragment to match on>,',
    '     "action":"set_counterparty_type|set_cash_flow_category|set_expense_category",',
    '     "value":<the value that action should set>,',
    '     "rationale":<one sentence, or null>}}',
    '',
    'Rules:',
    '- Include no key other than those listed.',
    '- The match must be a fragment that appears in the narrations you were shown, specific',
    '  enough that it would not also match unrelated payments. A rule fires unattended on every',
    '  future payment it matches; too broad a pattern silently mis-files them.',
    '- Propose a rule only where the decisions genuinely agree. Two out of three is a',
    '  coincidence, and "unknown" confidence is the right answer to one.',
  ].join('\n'),

  plan_ledger_query: [
    'You turn one typed question about a personal expense ledger into a QUERY PLAN.',
    '',
    'You never answer the question. You do not see any figure, and you must not invent one:',
    'the application runs the plan against its own reads and composes the answer itself.',
    '',
    'Respond with a single JSON object and nothing else — no prose, no markdown fence.',
    'The object has exactly two keys: "confidence" and "proposedOutput".',
    '',
    '  {"confidence":"high|medium|low|unknown",',
    '   "proposedOutput":{"kind":<one of the kinds listed in the input\'s "capabilities">,',
    '     "period":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"} or null,',
    '     "personName":<the person as the question named them, or null>,',
    '     "category":<a category the question named, or null>,',
    '     "searchTerm":<words to match against expense descriptions, or null>,',
    '     "limit":<1-50>,',
    '     "clarification":<one sentence, only for a declining kind; otherwise null>}}',
    '',
    'Rules:',
    '- Include no key other than those listed, and use only a "kind" the input listed.',
    '- "period" is inclusive of "start" and EXCLUSIVE of "end". "August 2026" is',
    '  {"start":"2026-08-01","end":"2026-09-01"}. Resolve relative periods against the',
    '  input\'s "today". Leave it null if the question named none.',
    '- "personName" is the name as written. Never invent an id: the application resolves names',
    '  against its own roster, and picking the wrong person would answer about the wrong debt.',
    '- If the question asks to change, record, delete, approve or settle anything, the kind is',
    '  "unsupported_write_request". This surface only reads; say so in "clarification".',
    '- If no listed kind answers it, use "unsupported_question". If it is answerable but',
    '  underdetermined — an ambiguous name, an unclear period — use "ambiguous_question" and',
    '  put the question you would ask back in "clarification".',
    '- A declining kind carries null for period, personName, searchTerm and category.',
    '- Guessing costs more here than admitting uncertainty: a confident plan for the wrong',
    '  question produces a real, correct figure that answers something nobody asked.',
  ].join('\n'),
};

/**
 * Builds a transport over the Anthropic Messages API.
 *
 * @throws ModelTransportError when the provider is unreachable, refuses the request, or
 *   returns something that is not JSON. Each is a fact about the environment or the call, not
 *   about the payment — `services.classifyPayments` lets those abort a run, while a response
 *   that *is* JSON but breaches the contract is recorded as one payment's rejected proposal.
 */
export function createAnthropicTransport(options: AnthropicTransportOptions): ModelTransport {
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const baseUrl = options.baseUrl ?? ANTHROPIC_API_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    modelInfo: { provider: 'anthropic', model },

    async complete(request: ModelRequest): Promise<unknown> {
      const system = SYSTEM_PROMPTS[request.operation];
      if (system === undefined || system.length === 0) {
        throw new ModelTransportError(
          `No prompt is defined for "${request.operation}". This transport implements the ` +
            'three operations the ledger calls (classify_transaction, parse_receipt, ' +
            'extract_receipt_items); the rest of the boundary is specified but unbuilt ' +
            '(docs/architecture/ai-boundary.md).',
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await doFetch(baseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            max_tokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
            system,
            messages: [
              {
                role: 'user',
                // The redacted payload verbatim. `promptVersion` travels with it so a stored
                // proposal can be traced to the wording that produced it.
                content: JSON.stringify({
                  promptVersion: request.promptVersion,
                  input: request.input,
                }),
              },
            ],
          }),
        });
      } catch (error) {
        const reason = controller.signal.aborted
          ? `no response within ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'unknown network failure';
        throw new ModelTransportError(`The model provider could not be reached: ${reason}.`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // The provider's own error body may echo the request; it is already redacted, but this
        // still reports only the status and a short excerpt rather than the whole thing.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new ModelTransportError(
          `The model provider returned ${response.status}. ${detail}`,
          response.status,
        );
      }

      const body = await response.json().catch(() => null);
      const text = firstTextBlock(body);
      if (text === null) {
        throw new ModelTransportError(
          'The model provider returned no text content. Nothing was proposed.',
        );
      }

      try {
        // Whatever this parses to is untrusted and goes straight to the contract validator.
        return JSON.parse(stripCodeFence(text)) as unknown;
      } catch {
        throw new ModelTransportError(
          'The model did not return JSON. Its answer is discarded rather than guessed at; ' +
            'the payment stays unclassified and a person can classify it by hand.',
        );
      }
    },
  };
}

/* ------------------------------------------------------------------------- internals */

/** The first `text` block of a Messages API response, or `null`. */
function firstTextBlock(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}

/**
 * Removes a ```json fence when a model wraps its object in one.
 *
 * Tolerated rather than rejected because it is a formatting habit, not a different answer —
 * and the object inside still faces the same strict validator. Anything else about the
 * response that is wrong is still rejected there.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*/i, '');
  const closing = withoutOpen.lastIndexOf('```');
  return (closing === -1 ? withoutOpen : withoutOpen.slice(0, closing)).trim();
}
