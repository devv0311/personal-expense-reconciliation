/**
 * A concrete {@link MessageTransport} over Meta's WhatsApp Cloud API.
 *
 * Chosen because the fifth pillar names WhatsApp by name, and because the Cloud API is plain
 * HTTPS JSON: no SDK, no dependency, the same shape as the Anthropic and Splitwise adapters
 * beside it.
 *
 * The send is two calls when there are attachments and one when there are not. Documents must
 * be uploaded to `/{phoneNumberId}/media` first, which returns an id that a message then
 * references. That ordering matters here: **attachments are uploaded before the text is
 * sent**, so a failed upload means nothing was sent at all, rather than a bare message the
 * recipient cannot check and a sender who believes proof went with it.
 *
 * Every failure resolves rather than throws (see the port): a 401 from a stale token, a
 * timeout, a number that is not on WhatsApp — each is a fact the delivery record has to
 * state, and an exception would lose the distinction between them.
 *
 * The access token is held in this closure and appears in exactly one place: the
 * `Authorization` header. It is never returned by `describe()`, never put in an error
 * message, and never logged (`security-model.md`).
 */

import type {
  MessageTransport,
  MessageTransportCapabilities,
  OutgoingAttachment,
  SendMessageInput,
  SendMessageResult,
} from './port.js';

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/** The Cloud API's own document limit. Refused here rather than by a 400 halfway through. */
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface WhatsAppCloudTransportOptions {
  /** A WhatsApp Cloud API access token. Never logged, never stored, never described. */
  readonly accessToken: string;
  /** The sending phone number's id, from the Meta app dashboard. */
  readonly phoneNumberId: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createWhatsAppCloudTransport(
  options: WhatsAppCloudTransportOptions,
): MessageTransport {
  const baseUrl = options.baseUrl ?? GRAPH_API_BASE;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function call(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { authorization: `Bearer ${options.accessToken}`, ...init.headers },
      });
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        throw new WhatsAppRefusal(`WhatsApp returned ${response.status}. ${summarize(text)}`);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new WhatsAppRefusal('WhatsApp returned a body that is not JSON.');
      }
    } catch (error) {
      if (error instanceof WhatsAppRefusal) throw error;
      throw new WhatsAppRefusal(
        controller.signal.aborted
          ? `WhatsApp did not respond within ${timeoutMs}ms.`
          : `WhatsApp could not be reached: ${error instanceof Error ? error.message : 'unknown network failure'}.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function uploadMedia(attachment: OutgoingAttachment): Promise<string> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', attachment.mediaType);
    form.set(
      'file',
      new Blob([attachment.bytes], { type: attachment.mediaType }),
      attachment.filename,
    );
    const body = await call(`/${options.phoneNumberId}/media`, { method: 'POST', body: form });
    const id = readString(body, 'id');
    if (id === null) {
      throw new WhatsAppRefusal(
        `WhatsApp accepted "${attachment.filename}" but returned no media id for it, so the ` +
          'message cannot reference it. Nothing was sent.',
      );
    }
    return id;
  }

  return {
    describe(): MessageTransportCapabilities {
      return {
        transportId: 'whatsapp-cloud',
        channel: 'whatsapp',
        label: 'WhatsApp Cloud API',
        configured: true,
        supportsAttachments: true,
        endpointHost: new URL(baseUrl).host,
        maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      };
    },

    async send(input: SendMessageInput): Promise<SendMessageResult> {
      const oversized = input.attachments.find(
        (attachment) => attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES,
      );
      if (oversized !== undefined) {
        return {
          accepted: false,
          failureReason:
            `"${oversized.filename}" is ${oversized.bytes.byteLength} bytes, over WhatsApp's ` +
            `${MAX_ATTACHMENT_BYTES}-byte limit. Nothing was sent.`,
          attachmentsSent: 0,
        };
      }

      // The recipient address goes on the wire without its `+`, which is what the Cloud API
      // expects. `domain.canonicalizeAddress` stores it *with* one, so the canonical record
      // and the provider's format stay distinct rather than one being bent to the other.
      const to = input.address.startsWith('+') ? input.address.slice(1) : input.address;

      try {
        // Attachments first: a failure here must mean nothing was sent, rather than a bare
        // message arriving without the proof it refers to.
        const mediaIds: { readonly id: string; readonly attachment: OutgoingAttachment }[] = [];
        for (const attachment of input.attachments) {
          mediaIds.push({ id: await uploadMedia(attachment), attachment });
        }

        const textResponse = await call(`/${options.phoneNumberId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            // Link previews off: a pack's text is figures and labels, and a preview card
            // would fetch whatever a merchant name happened to resolve to.
            text: { preview_url: false, body: input.body },
          }),
        });

        for (const media of mediaIds) {
          await call(`/${options.phoneNumberId}/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to,
              type: 'document',
              document: { id: media.id, filename: media.attachment.filename },
            }),
          });
        }

        const providerMessageId = readMessageId(textResponse);
        if (providerMessageId === null) {
          return {
            accepted: false,
            failureReason:
              'WhatsApp accepted the message but returned no id for it, so its delivery could ' +
              'never be confirmed. Recorded as failed rather than as an untraceable send.',
            attachmentsSent: mediaIds.length,
          };
        }
        return { accepted: true, providerMessageId, attachmentsSent: mediaIds.length };
      } catch (error) {
        if (error instanceof WhatsAppRefusal) {
          return { accepted: false, failureReason: error.message, attachmentsSent: 0 };
        }
        throw error;
      }
    },
  };
}

/* ------------------------------------------------------------------------- internals */

/** An outcome, not a crash — caught at the edge of `send` and turned into a refusal. */
class WhatsAppRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppRefusal';
  }
}

/**
 * Trims a provider error body before it is recorded.
 *
 * Bounded because the reason is stored and shown: an unbounded provider body in a delivery
 * record is an unbounded string from outside this system on a screen inside it.
 */
function summarize(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The Cloud API returns `{ messages: [{ id }] }`. */
function readMessageId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return readString(messages[0], 'id');
}
