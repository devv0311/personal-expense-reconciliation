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

import type { ModelRequest, ModelTransport, RedactedPayment } from '../../src/ai/index.js';
import type { PersonId } from '../../src/domain/index.js';

import { loadClassificationProposals } from './fixtures.js';

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
