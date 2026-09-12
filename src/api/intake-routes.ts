/**
 * The forwarding endpoint: bank SMS and UPI push notifications arriving from an automation
 * rather than from a person pasting them (audit row 12).
 *
 * ```
 * POST /api/intake/messages   ingest a batch of forwarded messages
 * GET  /api/intake/status     is forwarding configured, and what does it accept
 * ```
 *
 * **This is the one route in the table that is not behind the session**, and the reason is
 * structural rather than a concession: the callers are a mail rule, an SMS-forwarding app and
 * a phone shortcut, none of which has a browser or a cookie. It is instead behind a dedicated
 * shared secret — `INTAKE_FORWARDING_TOKEN` — compared in constant time, and when that
 * variable is unset the endpoint **refuses every request** rather than standing open. An
 * unconfigured forwarding endpoint that accepted anonymous writes would be a stranger's route
 * into a person's evidence table.
 *
 * The token buys exactly one capability: appending immutable notification evidence. It cannot
 * classify, link, allocate, settle, or read anything back — `ingestForwardedMessages` has no
 * path to any of those, and this route hands it nothing else.
 */

import { ingestForwardedMessages, MAX_FORWARDED_MESSAGES } from '../services/index.js';
import type { ForwardedMessage, ForwardedMessageChannel } from '../services/index.js';
import { FORWARDED_MESSAGE_CHANNELS } from '../services/index.js';

import { ApiRequestError, jsonResponse, readJsonObject } from './http.js';
import type { ApiDependencies } from './router.js';

/** The header a forwarder authenticates with. Bearer, so an ordinary HTTP client can send it. */
export const INTAKE_TOKEN_HEADER = 'authorization';

/**
 * Whether this request carries the configured forwarding token.
 *
 * Returns `false` when no token is configured at all, which is what closes the endpoint on an
 * installation that never set one up. Compared in constant time: a token checked with `===`
 * leaks its prefix through timing, and this one guards a write path.
 */
export function hasValidIntakeToken(
  request: Request,
  configuredToken: string | undefined,
): boolean {
  if (configuredToken === undefined || configuredToken.trim().length === 0) return false;
  const header = request.headers.get(INTAKE_TOKEN_HEADER);
  if (header === null) return false;
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  return constantTimeEquals(presented.trim(), configuredToken.trim());
}

function constantTimeEquals(a: string, b: string): boolean {
  // Length is compared first and separately — it is not a secret, and padding to a common
  // length would compare two things neither of which is the token.
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * `GET /api/intake/status` — whether forwarding is configured, and what it accepts.
 *
 * Behind the session like every other read, and deliberately says **nothing about the token
 * itself** — only whether one is set. A configuration screen needs to distinguish "forwarding
 * is off" from "forwarding is on and nothing has arrived", and neither answer requires
 * echoing a secret back to a browser.
 */
export function getIntakeStatusRoute(deps: ApiDependencies): Promise<Response> {
  const configured = (deps.intakeForwardingToken ?? '').trim().length > 0;
  return Promise.resolve(
    jsonResponse(200, {
      configured,
      endpoint: 'POST /api/intake/messages',
      authentication: configured
        ? 'Authorization: Bearer <INTAKE_FORWARDING_TOKEN>'
        : 'Not configured. Set INTAKE_FORWARDING_TOKEN and restart; until then this endpoint ' +
          'refuses every request rather than standing open.',
      acceptedChannels: FORWARDED_MESSAGE_CHANNELS,
      maxMessagesPerDelivery: MAX_FORWARDED_MESSAGES,
      writes:
        'Immutable notification evidence plus its deterministic structured reading. Nothing ' +
        'is linked to a payment automatically; an ingested notification reaches the review ' +
        "queue's unmatched-evidence list for a person to decide (ADR-0034, ADR-0037).",
    }),
  );
}

/**
 * `POST /api/intake/messages` — ingest forwarded bank/UPI notifications.
 *
 * Body: `{ messages: [{ channel, receivedAt, body, subject?, sender? }] }`.
 *
 * No `actor` field, unlike every other write in the table: the caller is an automation, not a
 * person, and asking it to claim `"user"` would put a person's name on a record nobody read.
 * The audit actor is `forwarder` — a real, distinguishable provenance, which is the point of
 * recording an actor at all.
 */
export async function postForwardedMessages(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const raw = body['messages'];
  if (!Array.isArray(raw)) {
    throw new ApiRequestError('"messages" must be an array of forwarded messages.', 'messages');
  }

  const messages: ForwardedMessage[] = raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiRequestError(`messages[${index}] must be an object.`, 'messages');
    }
    const message = entry as Record<string, unknown>;

    const channel = message['channel'];
    if (
      typeof channel !== 'string' ||
      !(FORWARDED_MESSAGE_CHANNELS as readonly string[]).includes(channel)
    ) {
      throw new ApiRequestError(
        `messages[${index}].channel must be one of ${FORWARDED_MESSAGE_CHANNELS.join(', ')}.`,
        'messages',
      );
    }

    const text = message['body'];
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ApiRequestError(`messages[${index}].body must be a non-empty string.`, 'messages');
    }

    const receivedAtRaw = message['receivedAt'];
    if (typeof receivedAtRaw !== 'string') {
      throw new ApiRequestError(
        `messages[${index}].receivedAt must be an ISO-8601 timestamp.`,
        'messages',
      );
    }
    const receivedAt = new Date(receivedAtRaw);
    if (Number.isNaN(receivedAt.getTime())) {
      throw new ApiRequestError(
        `messages[${index}].receivedAt is not a readable timestamp.`,
        'messages',
      );
    }

    const subject = message['subject'];
    const sender = message['sender'];
    return {
      channel: channel as ForwardedMessageChannel,
      receivedAt,
      body: text,
      ...(typeof subject === 'string' ? { subject } : {}),
      ...(typeof sender === 'string' ? { sender } : {}),
    };
  });

  const result = await ingestForwardedMessages(deps.db, {
    messages,
    audit: { actor: 'forwarder', source: 'api POST /api/intake/messages' },
  });
  return jsonResponse(202, result);
}
