/**
 * The structured-proposal contract every `src/ai` operation returns, and the strict
 * validation that stands between a model response and it (`ai-boundary.md`).
 *
 * Two things live here, and the separation is the point:
 *
 *  - **The types** — `Inference<T>` is the envelope, never a bare `T`. An operation returns a
 *    proposal, a confidence, and what produced it; it never returns an answer.
 *  - **The parser** — a hand-written, strict validator. A model response is *untrusted input*
 *    and is treated exactly like a request body from the network: unknown keys, missing keys,
 *    wrong types and out-of-range values are all rejected, with the offending field named.
 *
 * Rejection happens here, before `src/services` is given anything to persist, which is what
 * `ai-boundary.md` means by "rejected before it becomes an `AIInference` at all".
 */

import {
  AI_PROPOSED_KINDS,
  CONFIDENCE_LEVELS,
  EXPENSE_RELATIONSHIP_TYPES,
  paise,
  SUPPORTED_CURRENCY,
} from '../domain/index.js';
import type {
  AiInferenceType,
  ConfidenceLevel,
  ExpenseRelationshipType,
  Paise,
  PersonId,
  ProposedKind,
} from '../domain/index.js';

import { AiContractError } from './errors.js';

/* ------------------------------------------------------------------------- envelope */

/** Which model, and which prompt, produced a proposal. Stored on every `AIInference`. */
export interface ModelInfo {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
}

/**
 * The return shape of all nine operations — never a bare `T` (`ai-boundary.md`).
 *
 * `confidence` is part of the envelope rather than the proposal because it describes the
 * proposal, not the payment: two runs of the same operation over the same payment can differ
 * in confidence while proposing the same thing.
 */
export interface Inference<T> {
  readonly inferenceType: AiInferenceType;
  readonly proposedOutput: T;
  readonly confidence: ConfidenceLevel;
  readonly modelInfo: ModelInfo;
}

/** A reference to a `Person`, as a proposal may name one. */
export interface PersonRef {
  readonly type: 'person';
  readonly id: PersonId;
}

/* ----------------------------------------------------------- transaction classification */

/**
 * `ai.classifyTransaction`'s proposal (`ai-boundary.md`, revised by ADR-0007).
 *
 * A discriminated union rather than one shape with optional fields, so "a settlement proposal
 * carrying a `relationshipType`" is not representable and does not have to be checked for
 * downstream. The doc's optional-field notation and this are the same contract; this one
 * cannot be half-filled.
 */
export type TransactionClassification =
  | {
      readonly proposedKind: 'expense';
      readonly relationshipType: ExpenseRelationshipType;
      readonly category: string | null;
      /** Usually the user. A payment-funded expense's payer is the account owner (ADR-0026). */
      readonly paidByPersonHint: PersonRef | null;
    }
  | {
      readonly proposedKind: 'settlement';
      /** The other party to the obligation being discharged. Required — a settlement is with someone. */
      readonly counterpartyPersonHint: PersonRef;
    };

/** Keys the contract defines, by kind. Anything else in the response is a contract breach. */
const EXPENSE_KEYS = ['proposedKind', 'relationshipType', 'category', 'paidByPersonHint'];
const SETTLEMENT_KEYS = ['proposedKind', 'counterpartyPersonHint'];

/**
 * Validates one model response into an envelope-shaped classification proposal.
 *
 * @throws AiContractError for anything that is not exactly the contract.
 */
export function parseClassificationResponse(raw: unknown): {
  readonly proposedOutput: TransactionClassification;
  readonly confidence: ConfidenceLevel;
} {
  const response = requireObject(raw, 'response');
  const confidence = requireEnum(response['confidence'], CONFIDENCE_LEVELS, 'confidence');
  const proposedOutput = parseTransactionClassification(response['proposedOutput']);
  requireNoUnexpectedKeys(response, ['confidence', 'proposedOutput'], 'response');
  return { proposedOutput, confidence };
}

/**
 * Validates a bare proposal — the model's, or a human's correction of it.
 *
 * `services.decideInference`'s `modify` path runs a user-supplied proposal through this same
 * function, so a modified proposal cannot enter by a laxer door than the one the model's came
 * through (`ai-boundary.md`: `modified` "still produces a record", through the same gates).
 */
export function parseTransactionClassification(raw: unknown): TransactionClassification {
  const proposal = requireObject(raw, 'proposedOutput');
  const proposedKind: ProposedKind = requireEnum(
    proposal['proposedKind'],
    AI_PROPOSED_KINDS,
    'proposedOutput.proposedKind',
  );

  if (proposedKind === 'settlement') {
    requireNoUnexpectedKeys(proposal, SETTLEMENT_KEYS, 'proposedOutput');
    return {
      proposedKind,
      counterpartyPersonHint: requirePersonRef(
        proposal['counterpartyPersonHint'],
        'proposedOutput.counterpartyPersonHint',
      ),
    };
  }

  requireNoUnexpectedKeys(proposal, EXPENSE_KEYS, 'proposedOutput');
  return {
    proposedKind,
    relationshipType: requireEnum(
      proposal['relationshipType'],
      EXPENSE_RELATIONSHIP_TYPES,
      'proposedOutput.relationshipType',
    ),
    category: optionalNonEmptyString(proposal['category'], 'proposedOutput.category'),
    paidByPersonHint: optionalPersonRef(
      proposal['paidByPersonHint'],
      'proposedOutput.paidByPersonHint',
    ),
  };
}

/* ---------------------------------------------------------------------- receipt extraction */

/**
 * `ai.parseReceipt`'s proposal (`ai-boundary.md`, ADR-0036).
 *
 * `merchantHint` is free text off the receipt's header, resolved to a catalogued `Merchant`
 * deterministically in `src/services` (phase-7's alias match) — never written here, and never
 * by a second gated AI operation this phase does not build (this phase's scope decisions).
 * `subtotal`/`tax`/`total` are independently nullable: a model may read a total off a receipt
 * with no itemized tax line, or vice versa, and `assertReceiptDraftInformative` is what refuses
 * a draft naming none of them at all.
 */
export interface ReceiptDraft {
  readonly merchantHint: string | null;
  readonly subtotal: Paise | null;
  readonly tax: Paise | null;
  readonly total: Paise | null;
  readonly currency: string;
}

/** Keys the contract defines for a `ReceiptDraft`. Anything else is a contract breach. */
const RECEIPT_DRAFT_KEYS = [
  'merchantHint',
  'subtotalMinorUnits',
  'taxMinorUnits',
  'totalMinorUnits',
  'currency',
];

/**
 * Validates one model response into an envelope-shaped `ReceiptDraft`.
 *
 * @throws AiContractError for anything that is not exactly the contract.
 */
export function parseParseReceiptResponse(raw: unknown): {
  readonly proposedOutput: ReceiptDraft;
  readonly confidence: ConfidenceLevel;
} {
  const response = requireObject(raw, 'response');
  const confidence = requireEnum(response['confidence'], CONFIDENCE_LEVELS, 'confidence');
  const proposedOutput = parseReceiptDraft(response['proposedOutput']);
  requireNoUnexpectedKeys(response, ['confidence', 'proposedOutput'], 'response');
  return { proposedOutput, confidence };
}

/** Validates a bare `ReceiptDraft` — the model's, or a human's correction of it. */
export function parseReceiptDraft(raw: unknown): ReceiptDraft {
  const draft = requireObject(raw, 'proposedOutput');
  requireNoUnexpectedKeys(draft, RECEIPT_DRAFT_KEYS, 'proposedOutput');
  return {
    merchantHint: optionalNonEmptyString(draft['merchantHint'], 'proposedOutput.merchantHint'),
    subtotal: optionalMinorUnits(draft['subtotalMinorUnits'], 'proposedOutput.subtotalMinorUnits'),
    tax: optionalMinorUnits(draft['taxMinorUnits'], 'proposedOutput.taxMinorUnits'),
    total: optionalMinorUnits(draft['totalMinorUnits'], 'proposedOutput.totalMinorUnits'),
    currency: requireCurrency(draft['currency'], 'proposedOutput.currency'),
  };
}

/**
 * One line `ai.extractReceiptItems` proposes (`ai-boundary.md`, ADR-0036).
 *
 * `lineTotal` is required — an item with no total is not a line item, it is a description —
 * while `unitPrice` stays optional: a receipt showing one combined line for "2 x Milk ₹80" may
 * carry a per-unit price nowhere for the model to read.
 */
export interface ReceiptItemDraft {
  readonly description: string;
  /** A decimal string, matching `ReceiptItem.quantity` — a count/measure, not money. */
  readonly quantity: string;
  readonly unitPrice: Paise | null;
  readonly lineTotal: Paise;
  readonly suggestedCategory: string | null;
}

const RECEIPT_ITEM_DRAFT_KEYS = [
  'description',
  'quantity',
  'unitPriceMinorUnits',
  'lineTotalMinorUnits',
  'suggestedCategory',
];

/**
 * Validates one model response into an envelope-shaped array of `ReceiptItemDraft`.
 *
 * An empty array is a valid proposal — a total-only receipt with nothing itemized is a real
 * outcome, not a contract breach — so this gate never requires at least one item.
 */
export function parseExtractReceiptItemsResponse(raw: unknown): {
  readonly proposedOutput: readonly ReceiptItemDraft[];
  readonly confidence: ConfidenceLevel;
} {
  const response = requireObject(raw, 'response');
  const confidence = requireEnum(response['confidence'], CONFIDENCE_LEVELS, 'confidence');
  const proposedOutput = parseReceiptItemDrafts(response['proposedOutput']);
  requireNoUnexpectedKeys(response, ['confidence', 'proposedOutput'], 'response');
  return { proposedOutput, confidence };
}

/** Validates a bare `ReceiptItemDraft[]` — the model's, or a human's correction of it. */
export function parseReceiptItemDrafts(raw: unknown): readonly ReceiptItemDraft[] {
  if (!Array.isArray(raw)) {
    throw new AiContractError(
      raw === undefined || raw === null ? 'FIELD_MISSING' : 'MALFORMED_RESPONSE',
      `Expected "proposedOutput" to be an array of receipt items, received ${describe(raw)}.`,
      { field: 'proposedOutput', received: describe(raw) },
    );
  }
  return raw.map((entry, index) => parseReceiptItemDraft(entry, `proposedOutput[${index}]`));
}

function parseReceiptItemDraft(raw: unknown, field: string): ReceiptItemDraft {
  const item = requireObject(raw, field);
  requireNoUnexpectedKeys(item, RECEIPT_ITEM_DRAFT_KEYS, field);
  return {
    description: requireNonEmptyString(item['description'], `${field}.description`),
    quantity: requireQuantity(item['quantity'], `${field}.quantity`),
    unitPrice: optionalMinorUnits(item['unitPriceMinorUnits'], `${field}.unitPriceMinorUnits`),
    lineTotal: requireMinorUnits(item['lineTotalMinorUnits'], `${field}.lineTotalMinorUnits`),
    suggestedCategory: optionalNonEmptyString(
      item['suggestedCategory'],
      `${field}.suggestedCategory`,
    ),
  };
}

/* ------------------------------------------------------------------------- internals */

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiContractError(
      value === undefined || value === null ? 'FIELD_MISSING' : 'MALFORMED_RESPONSE',
      `Expected "${field}" to be an object, received ${describe(value)}. An AI response is ` +
        'untrusted input and is validated before it can become an AIInference ' +
        '(ai-boundary.md, validation contract).',
      { field, received: describe(value) },
    );
  }
  return value as Record<string, unknown>;
}

function requireEnum<T extends string>(value: unknown, permitted: readonly T[], field: string): T {
  if (value === undefined || value === null) {
    throw new AiContractError('FIELD_MISSING', `"${field}" is required.`, { field });
  }
  if (typeof value !== 'string' || !(permitted as readonly string[]).includes(value)) {
    throw new AiContractError(
      'FIELD_INVALID',
      `"${field}" must be one of ${permitted.join(', ')}, received ${describe(value)}.`,
      { field, received: describe(value) },
    );
  }
  return value as T;
}

function optionalNonEmptyString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AiContractError(
      'FIELD_INVALID',
      `"${field}", when present, must be a non-empty string, received ${describe(value)}.`,
      { field, received: describe(value) },
    );
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    throw new AiContractError('FIELD_MISSING', `"${field}" is required.`, { field });
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AiContractError(
      'FIELD_INVALID',
      `"${field}" must be a non-empty string, received ${describe(value)}.`,
      { field, received: describe(value) },
    );
  }
  return value;
}

/** V1 does arithmetic in one currency only; a proposal naming another is rejected, not coerced. */
function requireCurrency(value: unknown, field: string): string {
  const currency = requireNonEmptyString(value, field);
  if (currency !== SUPPORTED_CURRENCY) {
    throw new AiContractError(
      'FIELD_INVALID',
      `"${field}" must be "${SUPPORTED_CURRENCY}", received "${currency}". V1 supports ` +
        'arithmetic in one currency only (invariants.md #12, "Currency scope for V1").',
      { field, received: currency },
    );
  }
  return currency;
}

/** An exact, non-negative integer count of minor units, as a decimal string — never a float. */
const MINOR_UNITS_STRING_PATTERN = /^\d+$/;

/** A count/measure with up to three decimal places, matching `ReceiptItem.quantity`'s column. */
const QUANTITY_STRING_PATTERN = /^\d+(?:\.\d{1,3})?$/;

function requireMinorUnits(value: unknown, field: string): Paise {
  const text = requireNonEmptyString(value, field);
  if (!MINOR_UNITS_STRING_PATTERN.test(text)) {
    throw new AiContractError(
      'FIELD_INVALID',
      `"${field}" must be a non-negative integer count of minor units as a decimal string ` +
        `(e.g. "12500"), received ${describe(value)}. Money crosses this boundary as an exact ` +
        'string precisely so it never passes through a float (invariants.md #12).',
      { field, received: describe(value) },
    );
  }
  return paise(BigInt(text));
}

function optionalMinorUnits(value: unknown, field: string): Paise | null {
  if (value === undefined || value === null) return null;
  return requireMinorUnits(value, field);
}

function requireQuantity(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field);
  if (!QUANTITY_STRING_PATTERN.test(text) || Number(text) <= 0) {
    throw new AiContractError(
      'FIELD_INVALID',
      `"${field}" must be a positive decimal with at most three places (e.g. "2" or "0.5"), ` +
        `received ${describe(value)}.`,
      { field, received: describe(value) },
    );
  }
  return text;
}

function requirePersonRef(value: unknown, field: string): PersonRef {
  const ref = optionalPersonRef(value, field);
  if (ref === null) {
    throw new AiContractError(
      'FIELD_MISSING',
      `"${field}" is required for this proposedKind. A settlement discharges an obligation ` +
        'between two people, so the counterparty is not optional (ADR-0007).',
      { field },
    );
  }
  return ref;
}

function optionalPersonRef(value: unknown, field: string): PersonRef | null {
  if (value === undefined || value === null) return null;
  const ref = requireObject(value, field);
  if (ref['type'] !== 'person') {
    throw new AiContractError(
      'FIELD_INVALID',
      `"${field}.type" must be "person", received ${describe(ref['type'])}.`,
      { field: `${field}.type`, received: describe(ref['type']) },
    );
  }
  const id = ref['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new AiContractError(
      'FIELD_INVALID',
      `"${field}.id" must be a non-empty person id, received ${describe(id)}.`,
      { field: `${field}.id`, received: describe(id) },
    );
  }
  requireNoUnexpectedKeys(ref, ['type', 'id'], field);
  return { type: 'person', id: id as PersonId };
}

/**
 * Rejects any key the contract does not define.
 *
 * Strict on purpose. A key nobody validated is a key nobody agreed to, and a proposal is only
 * "structured" if its structure is closed — an unrecognised field is far more likely to be a
 * model improvising than a caller extending the contract, and the latter is a code change
 * anyway.
 */
function requireNoUnexpectedKeys(
  value: Record<string, unknown>,
  permitted: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !permitted.includes(key));
  if (unexpected.length === 0) return;
  throw new AiContractError(
    'FIELD_UNEXPECTED',
    `"${field}" carries ${unexpected.map((key) => `"${key}"`).join(', ')}, which the ` +
      `contract does not define here. Permitted: ${permitted.join(', ')}.`,
    { field, unexpected: unexpected.join(',') },
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `"${value}"`;
  return typeof value;
}
