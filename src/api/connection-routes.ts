/**
 * One financial event, and everything still waiting on a person.
 *
 * ```
 * GET /api/connections/:paymentId   one real-world event, with every record connected to it
 * GET /api/attention                what needs a human, as the questions those decisions are
 * ```
 *
 * Both are reads. Neither decides anything, and neither offers a way to decide anything: every
 * action either surface leads to is an existing `POST` behind its own dialog and its own
 * service validation (`/api/review/...`, `/api/evidence/matches/:candidateId/decision`).
 *
 * The connection read needs the user's own `Person` so that a share can be labelled "You"
 * rather than by name — the same reason the analytics reads need one. A ledger with no user
 * yet is a 400 with a sentence, matching `GET /api/analytics/outstanding`.
 */

import { asId } from '../domain/index.js';
import { REVIEW_ITEM_KINDS } from '../domain/index.js';
import type { ReviewItemKind } from '../domain/index.js';
import { getPrimaryUserPerson } from '../db/index.js';
import { getPaymentConnection, listAttentionQuestions } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  requireParam,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `GET /api/connections/:paymentId` — one event, composed server-side.
 *
 * Composed here rather than in the browser on purpose: a screen that fetched the movement, its
 * evidence, its expenses and its allocation separately and joined them would be doing exactly
 * the financial joining `web/CLAUDE.md` rule 1 forbids — and four reads taken milliseconds
 * apart can disagree with each other in a way one read cannot.
 */
export async function getConnectionRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(requireUuid(requireParam(params, 'paymentId'), 'paymentId'));
  const userPerson = await getPrimaryUserPerson(deps.db);

  return jsonResponse(
    200,
    await getPaymentConnection(deps.db, {
      paymentId,
      userPersonId: userPerson?.personId ?? null,
    }),
  );
}

/**
 * `GET /api/attention` — the review queue, re-expressed as questions, plus the ones the queue
 * does not carry.
 *
 * `/api/review` is unchanged and still the unfiltered machine-readable queue. This one adds the
 * wording and the facts needed to answer each item, and includes approved expenses nobody has
 * been named on — a real outstanding decision the queue has never held. `kinds` narrows to
 * review kinds only, and passing it excludes the ledger-derived questions, because they have no
 * review kind to be narrowed by.
 */
export async function getAttentionRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = optionalPositiveInteger(params, 'limit');
  const kinds = parseKinds(params.get('kinds'));

  return jsonResponse(
    200,
    await listAttentionQuestions(deps.db, {
      ...(limit === undefined ? {} : { limit }),
      ...(kinds === undefined ? {} : { kinds }),
    }),
  );
}

function parseKinds(raw: string | null): readonly ReviewItemKind[] | undefined {
  if (raw === null) return undefined;
  const requested = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requested.length === 0) return undefined;

  const unknown = requested.filter(
    (value) => !(REVIEW_ITEM_KINDS as readonly string[]).includes(value),
  );
  if (unknown.length > 0) {
    throw new ApiRequestError(
      `"kinds" must name only ${REVIEW_ITEM_KINDS.join(', ')}; got ${unknown.join(', ')}.`,
      'kinds',
    );
  }
  return requested as readonly ReviewItemKind[];
}
