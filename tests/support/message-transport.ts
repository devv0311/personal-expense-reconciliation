/**
 * An in-memory {@link MessageTransport}, deterministic and synchronous under its `Promise`s.
 *
 * The same shape as `tests/support/splitwise.ts`: the real WhatsApp adapter has its own unit
 * tests (`src/integrations/message-transport/whatsapp-cloud.test.ts`), and everything above
 * the port is exercised without a network call. Provider ids are assigned in call order
 * (`wamid-1`, `wamid-2`, …) so a test can assert which message a record refers to rather than
 * pattern-matching a random value.
 */

import type {
  MessageTransport,
  MessageTransportCapabilities,
  SendMessageInput,
  SendMessageResult,
} from '../../src/integrations/message-transport/index.js';

export interface MockMessageTransport extends MessageTransport {
  /** Every send this transport received, in order. */
  readonly sent: readonly SendMessageInput[];
  /** Makes exactly the next send resolve as a refusal, then returns to accepting. */
  readonly failNextSend: (reason: string) => void;
}

export function createMockMessageTransport(
  overrides: Partial<MessageTransportCapabilities> = {},
): MockMessageTransport {
  const sent: SendMessageInput[] = [];
  let nextFailure: string | null = null;
  let counter = 0;

  return {
    sent,
    failNextSend(reason: string) {
      nextFailure = reason;
    },
    describe(): MessageTransportCapabilities {
      return {
        transportId: 'mock-whatsapp',
        channel: 'whatsapp',
        label: 'Mock WhatsApp',
        configured: true,
        supportsAttachments: true,
        endpointHost: 'mock.invalid',
        maxAttachmentBytes: 1_000_000,
        ...overrides,
      };
    },
    send(input: SendMessageInput): Promise<SendMessageResult> {
      sent.push(input);
      if (nextFailure !== null) {
        const reason = nextFailure;
        nextFailure = null;
        return Promise.resolve({ accepted: false, failureReason: reason, attachmentsSent: 0 });
      }
      counter += 1;
      return Promise.resolve({
        accepted: true,
        providerMessageId: `wamid-${counter}`,
        attachmentsSent: input.attachments.length,
      });
    },
  };
}
