/**
 * The transport when no messaging credentials are configured.
 *
 * It refuses by name, and the refusal is the feature. The alternative — a transport that
 * resolved `accepted: true` and did nothing — would write a delivery record saying a person
 * had been shown their balance when nobody had, which is worse than any failure it replaces.
 * Same reasoning as the unconfigured Splitwise port and model transport in `src/server.ts`.
 *
 * `describe()` is what the proof-pack screen reads to say, before anything is typed, that
 * sending is unavailable here and exactly which variables would make it available. It names
 * the variables and never their values.
 */

import type { MessageTransport, MessageTransportCapabilities, SendMessageResult } from './port.js';

export const MESSAGING_UNCONFIGURED_REASON =
  'No message transport is configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID ' +
  '(see .env.example) and restart to send a reviewed pack from here. Until then a pack can ' +
  'still be previewed, reviewed and copied — which sends nothing, and is not a delivery.';

export function createUnconfiguredMessageTransport(reason?: string): MessageTransport {
  const unavailableReason = reason ?? MESSAGING_UNCONFIGURED_REASON;
  return {
    describe(): MessageTransportCapabilities {
      return {
        transportId: 'unconfigured',
        channel: 'whatsapp',
        label: 'Not configured',
        configured: false,
        unavailableReason,
        supportsAttachments: false,
      };
    },
    send(): Promise<SendMessageResult> {
      // Resolving rather than throwing, exactly like a provider refusal: an installation
      // with no transport that tried to send gets a recorded, visible, honest failure rather
      // than a stack trace, and the record says why.
      return Promise.resolve({
        accepted: false,
        failureReason: unavailableReason,
        attachmentsSent: 0,
      });
    },
  };
}
