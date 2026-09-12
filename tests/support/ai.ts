/**
 * The scripted model the integration suite classifies against.
 *
 * No provider is wired in phase 8 (ADR-0025), and asserting that a real model *guesses
 * correctly* is not something CI can do anyway (`testing-strategy.md`, "What is not (and
 * cannot be) deterministically tested"). What the suite does assert is everything around the
 * guess: redaction, validation, routing, persistence and the decision gate. So the transport
 * is scripted from `fixtures/ai-classification-proposals.json` and the rest of the chain —
 * `createAiService`, the real validator, the real service, a real database — is the production
 * one.
 *
 * The transport answers by **redacted** description, which is what it actually receives. That
 * is deliberate: if redaction changes, these lookups miss and the suite says so, rather than
 * the fixture quietly describing a payload that no longer exists.
 */

import type {
  ModelRequest,
  ModelTransport,
  RedactedPayment,
  RedactedReceiptEvidence,
} from '../../src/ai/index.js';
import type { PersonId } from '../../src/domain/index.js';

import { loadClassificationProposals, loadReceiptExtractionProposals } from './fixtures.js';

export interface ScriptedTransportOptions {
  /** Fixture person id → database id, for substituting `{{person_*}}` placeholders. */
  readonly people?: Readonly<Record<string, PersonId>>;
  /** Responses that replace the fixture's, keyed by redacted description. */
  readonly overrides?: Readonly<Record<string, unknown>>;
}

export interface ScriptedTransport extends ModelTransport {
  /** Every redacted description the service asked about, in order. */
  readonly asked: readonly string[];
}

const PLACEHOLDER = /^\{\{(.+)\}\}$/;

/** Replaces `{{person_friend_a}}` with the seeded id, anywhere in a response. */
function substitute(value: unknown, people: Readonly<Record<string, PersonId>>): unknown {
  if (typeof value === 'string') {
    const match = PLACEHOLDER.exec(value);
    if (match === null) return value;
    const id = people[match[1]!];
    if (id === undefined) {
      throw new Error(
        `The proposal fixture references ${value}, which the seeded cast does not contain.`,
      );
    }
    return id;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, people));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, people)]),
    );
  }
  return value;
}

/**
 * A transport that answers from the fixture, and refuses to answer anything else.
 *
 * An unscripted description throws rather than returning a default: a test that forgets to
 * script a payment should fail loudly, not silently classify it as whatever the fallback said.
 */
export function scriptedClassificationTransport(
  options: ScriptedTransportOptions = {},
): ScriptedTransport {
  const fixture = loadClassificationProposals();
  const people = options.people ?? {};
  const scripted = new Map<string, unknown>(
    fixture.responses.map((entry) => [
      entry.redacted_description,
      substitute(entry.response, people),
    ]),
  );
  for (const [description, response] of Object.entries(options.overrides ?? {})) {
    scripted.set(description, response);
  }

  const asked: string[] = [];
  return {
    asked,
    modelInfo: { provider: fixture.model.provider, model: fixture.model.model },
    complete: (request: ModelRequest) => {
      const description = (request.input as RedactedPayment).description;
      asked.push(description);
      if (!scripted.has(description)) {
        return Promise.reject(
          new Error(`No scripted classification response for "${description}".`),
        );
      }
      return Promise.resolve(scripted.get(description));
    },
  };
}

export interface ScriptedReceiptTransport extends ModelTransport {
  /** Every captured_at this transport was asked about, per operation, in order. */
  readonly asked: readonly { readonly operation: string; readonly capturedAt: string }[];
}

/**
 * A transport that answers `parseReceipt`/`extractReceiptItems` from
 * `fixtures/receipt-extraction-proposals.json`, keyed by the evidence's `captured_at` — the one
 * field the redacted payload always carries, since a photographed receipt routinely has no
 * `rawText` for a key to hang off of the way a payment's description does.
 *
 * An unscripted `captured_at` throws rather than returning a default, exactly as the
 * classification transport does: a test that forgot to script an evidence row should fail
 * loudly, not silently extract nothing.
 */
export function scriptedReceiptExtractionTransport(): ScriptedReceiptTransport {
  const fixture = loadReceiptExtractionProposals();
  const byCapturedAt = new Map(fixture.responses.map((entry) => [entry.captured_at, entry]));

  const asked: Array<{ operation: string; capturedAt: string }> = [];
  return {
    asked,
    modelInfo: { provider: fixture.model.provider, model: fixture.model.model },
    complete: (request: ModelRequest) => {
      const capturedAt = (request.input as RedactedReceiptEvidence).capturedAt;
      asked.push({ operation: request.operation, capturedAt });
      const entry = byCapturedAt.get(capturedAt);
      if (entry === undefined) {
        return Promise.reject(
          new Error(`No scripted receipt-extraction response for captured_at "${capturedAt}".`),
        );
      }
      if (request.operation === 'parse_receipt') return Promise.resolve(entry.parse_receipt);
      if (request.operation === 'extract_receipt_items') {
        return Promise.resolve(entry.extract_receipt_items);
      }
      return Promise.reject(new Error(`Unexpected operation "${request.operation}".`));
    },
  };
}

/* ============================================== the ask-only question surface (ADR-0057) */

export interface ScriptedQueryPlanTransport extends ModelTransport {
  /** Every redacted question this transport was asked, in order. */
  readonly asked: readonly string[];
  /** The full redacted payload of the last call, so a test can assert what left the machine. */
  readonly lastPayload: () => unknown;
  /** Scripts the reply to the next question, keyed by the redacted question text. */
  readonly script: (redactedQuestion: string, response: unknown) => void;
}

/**
 * A transport that answers `plan_ledger_query` from a script the test writes.
 *
 * Keyed by the **redacted** question, like the classification transport is keyed by the
 * redacted description, and for the same reason: if the question redactor changes, these
 * lookups miss and the suite says so rather than silently exercising a payload that no longer
 * leaves the machine in that shape.
 */
export function scriptedQueryPlanTransport(
  options: { readonly configured?: boolean; readonly unavailableReason?: string } = {},
): ScriptedQueryPlanTransport {
  const asked: string[] = [];
  const scripted = new Map<string, unknown>();
  let lastPayload: unknown = null;

  return {
    asked,
    lastPayload: () => lastPayload,
    script: (redactedQuestion: string, response: unknown) => {
      scripted.set(redactedQuestion, response);
    },
    modelInfo: { provider: 'scripted', model: 'query-planner' },
    ...(options.configured === false
      ? {
          availability: {
            configured: false,
            ...(options.unavailableReason === undefined
              ? {}
              : { unavailableReason: options.unavailableReason }),
          },
        }
      : {}),
    complete: (request: ModelRequest) => {
      if (request.operation !== 'plan_ledger_query') {
        return Promise.reject(new Error(`Unexpected operation "${request.operation}".`));
      }
      lastPayload = request.input;
      const question = (request.input as { question: string }).question;
      asked.push(question);
      if (!scripted.has(question)) {
        return Promise.reject(new Error(`No scripted query plan for "${question}".`));
      }
      return Promise.resolve(scripted.get(question));
    },
  };
}
