/**
 * Asking the ledger a question, in words (audit row 45, ADR-0057):
 *
 * ```
 * GET  /api/ask/capabilities   what can be asked, and whether asking works at all
 * POST /api/ask                one question, one answer built from authoritative reads
 * ```
 *
 * `POST` because a question is a request body, **not** because anything changes. Nothing on
 * this surface writes a row, sends anything outward, or touches an external system: the
 * service it calls imports no writer, so that is a property of the module graph rather than a
 * promise in a comment.
 *
 * There is deliberately no route that acts on an answer. Where an answer implies something
 * ought to be done, it carries a link to the screen that owns the act — behind that screen's
 * own dialog, with its own recorded reason.
 */

import {
  answerLedgerQuestion,
  describeAskCapabilities,
  requireUserPersonId,
} from '../services/index.js';

import { jsonResponse, readJsonObject, requireString } from './http.js';
import type { ApiDependencies } from './router.js';

/**
 * `GET /api/ask/capabilities`.
 *
 * Read before the question box renders. An unconfigured provider comes back as
 * `model.configured: false` with the reason, so the screen can say asking is unavailable
 * rather than offer a box that fails on submit — ADR-0050's rule read backwards.
 */
export async function getAskCapabilitiesRoute(deps: ApiDependencies): Promise<Response> {
  return jsonResponse(200, await describeAskCapabilities(deps.db, deps.ai));
}

/**
 * `POST /api/ask` — body: `{ question }`.
 *
 * No `actor`, and that absence is the point: every other POST in this table records a person's
 * decision, and this one records nothing. There is nothing to attribute because nothing
 * changed.
 */
export async function postAsk(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const question = requireString(body, 'question');
  const userPersonId = await requireUserPersonId(deps.db);

  const result = await answerLedgerQuestion(deps.db, {
    question,
    userPersonId,
    ai: deps.ai,
  });
  return jsonResponse(200, result);
}
