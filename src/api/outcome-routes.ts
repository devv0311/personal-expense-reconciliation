/**
 * The four reads and one action the outcome-first screens make.
 *
 * ```
 * POST /api/analysis                          read the records, work out what they were, connect them
 * GET  /api/spending                          what you spent — category, trend, own share, what came back
 * GET  /api/links                             what has already been connected, and how
 * GET  /api/people/:personId/balance          why this person's balance is what it is
 * GET  /api/instalments                       what belongs to one instalment plan, and what is unknown
 * GET  /api/anomalies                         what is worth a second look, with the rows compared
 * GET  /api/rule-proposals                    patterns your confirmations suggest, none of them active
 * POST /api/rule-proposals                    approve one, which is the only way a pattern starts matching
 * POST /api/rule-proposals/dismiss            decline one, with a reason, so it stops being offered
 * POST /api/rule-proposals/restore            offer a declined one again
 * POST /api/expenses/:expenseId/allocation/preview   what a split would do, before it does it
 * ```
 *
 * `POST /api/analysis` is what a screen calls to bring records nobody has read yet up to date.
 * It is the only write here, and it writes nothing authoritative: it
 * normalizes rows, records proposals, and records match candidates. Every one of those is a
 * service that already refuses to approve anything without a person, which is why this route
 * takes an `actor` and records an audit trail but never asks for a confirmation of its own.
 *
 * The allocation preview is a `POST` because it carries a decision in a body, and a read
 * because it writes nothing at all — the same shape `POST /api/ask` already has.
 */

import { asId } from '../domain/index.js';
import { getPrimaryUserPerson } from '../db/index.js';
import {
  getPersonBalanceSummary,
  getSpendingSummary,
  listConfirmedLinks,
  prepareRecords,
  previewAllocation,
  approveRuleProposal,
  dismissRuleProposal,
  listRuleProposals,
  restoreRuleProposal,
  readInstalmentsAndAnomalies,
} from '../services/index.js';

import { parseAllocationDecision, parseGroupShareOverrides } from './allocation-routes.js';
import {
  ApiRequestError,
  jsonResponse,
  optionalPositiveInteger,
  optionalTimestampParam,
  optionalString,
  readJsonObject,
  requireString,
  requireParam,
  requirePersonActor,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/* -------------------------------------------------------------------------- analysis */

/**
 * `POST /api/analysis` — body: `{ actor, reason?, importBatchId? }`.
 *
 * One action where there used to be two buttons named after the pipeline. It reads what has
 * arrived, works out what it can about each payment, and proposes which records describe the
 * same thing. **It approves nothing**, and a stage that could not run comes back named, with
 * the reason, rather than quietly omitted.
 */
export async function postAnalysis(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'analyze records');
  const reason = optionalReason(body);
  const importBatchId = optionalUuidField(body, 'importBatchId');

  // `prepareRecords`, not `analyzeRecords`: nobody presses a button for this any more, so two
  // callers asking at once is the ordinary case rather than the odd one. A run in progress is
  // the run they both get.
  const result = await prepareRecords(deps.db, {
    ai: deps.ai,
    audit: { actor, source: 'api:POST /api/analysis', ...(reason === undefined ? {} : { reason }) },
    ...(importBatchId === undefined ? {} : { importBatchId: asId<'import_batch'>(importBatchId) }),
  });
  return jsonResponse(200, result);
}

/* -------------------------------------------------------------------------- spending */

/**
 * `GET /api/spending` — what you spent, composed once so every figure agrees.
 *
 * `from`/`to` are optional for the same reason `/api/overview`'s are: a summary screen has to
 * open with some period, and choosing one is a calendar decision rather than a financial one.
 * The period used comes back in the response so the screen names it.
 */
export async function getSpendingSummaryRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const start = optionalTimestampParam(params, 'from');
  const end = optionalTimestampParam(params, 'to');
  if (start !== undefined && end !== undefined && end <= start) {
    throw new ApiRequestError('"to" must be after "from".', 'to');
  }
  const months = optionalPositiveInteger(params, 'months');

  const userPerson = await getPrimaryUserPerson(deps.db);
  if (userPerson === null) {
    throw new ApiRequestError(
      'This ledger has no user yet, so there is nobody whose spending to report.',
    );
  }

  return jsonResponse(
    200,
    await getSpendingSummary(deps.db, {
      userPersonId: userPerson.personId,
      period: start === undefined || end === undefined ? currentMonth() : { start, end },
      ...(months === undefined ? {} : { months }),
    }),
  );
}

/** The calendar month now falls in, at the UTC boundaries every period in this system uses. */
function currentMonth(): { start: Date; end: Date } {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/* ----------------------------------------------------------------------------- links */

/**
 * `GET /api/links` — the records already attached to a movement, and how each was decided.
 *
 * The settled half of what `/api/attention` reports as open. A review surface that could only
 * ever show a person what they had *not* decided gave them no way to check the decisions they
 * had made, and no way to notice a wrong one. Pure read: it quotes stored links and the stored
 * decision behind each, and judges none of them.
 */
export async function getConfirmedLinksRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = optionalPositiveInteger(params, 'limit');
  return jsonResponse(
    200,
    await listConfirmedLinks(deps.db, { ...(limit === undefined ? {} : { limit }) }),
  );
}

/* ---------------------------------------------------------------------------- person */

/** `GET /api/people/:personId/balance` — the balance, and every event that makes it up. */
export async function getPersonBalanceRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const personId = asId<'person'>(requireUuid(requireParam(params, 'personId'), 'personId'));
  const userPerson = await getPrimaryUserPerson(deps.db);
  if (userPerson === null) {
    throw new ApiRequestError(
      'This ledger has no user yet, so there is nobody whose balance to report.',
    );
  }

  return jsonResponse(
    200,
    await getPersonBalanceSummary(deps.db, {
      userPersonId: userPerson.personId,
      personId,
    }),
  );
}

/* ------------------------------------------------------------------ allocation preview */

/**
 * `POST /api/expenses/:expenseId/allocation/preview` — body: the same `decision` the approval
 * takes.
 *
 * Writes nothing, and takes no `actor` for that reason: nothing happened to attribute. It
 * exists so a screen can show what a split would do without dividing an amount itself, which
 * `web/CLAUDE.md` rule 1 forbids and which would be free to disagree with the approval it is
 * previewing.
 */
export async function postAllocationPreview(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const overrides = parseGroupShareOverrides(body);
  const userPerson = await getPrimaryUserPerson(deps.db);

  return jsonResponse(
    200,
    await previewAllocation(deps.db, {
      expenseId,
      // The approval route's own parser, so a preview can never accept a shape the approval
      // would refuse — which would make it a preview of something that cannot happen.
      decision: parseAllocationDecision(body),
      ...(overrides === undefined ? {} : { groupShareOverrides: overrides }),
      userPersonId: userPerson?.personId ?? null,
    }),
  );
}

/* ------------------------------------------------------------------------- validation */

function optionalReason(body: Record<string, unknown>): string | undefined {
  const raw = body['reason'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new ApiRequestError('"reason" must be a string.', 'reason');
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalUuidField(body: Record<string, unknown>, field: string): string | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new ApiRequestError(`"${field}" must be a string.`, field);
  return requireUuid(raw, field);
}

/**
 * Instalment plans, read out of the rows a statement printed
 * ([ADR-0062](../../docs/decisions/0062-an-instalment-plan-is-a-timeline-of-what-the-statement-said.md)).
 *
 * A pure read: it opens nothing, writes nothing and records nothing. Every figure is the
 * domain's, and `tenure.known === false` means no statement line stated one — a caller may never
 * substitute a count of its own.
 */
export async function getInstalmentsRoute(deps: ApiDependencies): Promise<Response> {
  const { plans, rowsRead } = await readInstalmentsAndAnomalies(deps.db);
  return jsonResponse(200, { plans, rowsRead });
}

/**
 * What is worth a second look
 * ([ADR-0063](../../docs/decisions/0063-an-anomaly-is-a-comparison-with-its-evidence-attached.md)).
 *
 * `rowsRead` travels with the findings so a screen can say what was compared. An empty list over
 * a non-zero `rowsRead` is a real answer — nothing stood out — and a screen must say that rather
 * than rendering an empty container.
 */
export async function getAnomaliesRoute(deps: ApiDependencies): Promise<Response> {
  const { anomalies, rowsRead } = await readInstalmentsAndAnomalies(deps.db);
  return jsonResponse(200, { anomalies, rowsRead });
}

/**
 * Patterns a person could approve, read from what they have already confirmed
 * ([ADR-0064](../../docs/decisions/0064-a-pattern-is-a-proposal-a-person-approves-before-it-ever-matches.md)).
 *
 * A pure read. Nothing in this response matches anything yet, and listing it changes nothing.
 */
export async function getRuleProposalsRoute(deps: ApiDependencies): Promise<Response> {
  return jsonResponse(200, await listRuleProposals(deps.db));
}

/**
 * Approves one pattern, which is the only way one ever becomes a rule.
 *
 * The proposal is re-derived server-side and matched by id: the wording that gets stored is the
 * wording that was on screen, and a caller cannot widen it between reading and confirming. The
 * rule is created `effect: 'propose'` — it will suggest a category and name itself while doing
 * so, and a person still confirms every payment it touches.
 */
export async function postRuleProposalRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const proposalId = requireString(body, 'proposalId');
  const name = optionalString(body, 'name');
  const reason = optionalString(body, 'reason');
  const actor = requirePersonActor(body, 'approve a pattern');

  const { ruleId } = await approveRuleProposal(deps.db, {
    proposalId,
    ...(name === undefined ? {} : { name }),
    audit: {
      actor,
      source: 'api POST /api/rule-proposals',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(201, { ruleId });
}

/**
 * Declines a pattern, so it stops being offered (ADR-0065).
 *
 * A write, and a small one: it records a decision about an *offer* and touches no payment, no
 * expense and no prior decision. The reason is required — a dismissal that nobody can account
 * for later silently removes something from a screen.
 */
export async function postRuleProposalDismissRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const proposalId = requireString(body, 'proposalId');
  const reason = requireString(body, 'reason');
  const actor = requirePersonActor(body, 'decline a pattern');

  const { proposalKey } = await dismissRuleProposal(deps.db, {
    proposalId,
    reason,
    audit: { actor, source: 'api POST /api/rule-proposals/dismiss' },
  });
  return jsonResponse(201, { proposalKey });
}

/** Offers a declined pattern again. The dismissal is closed, never deleted (ADR-0065). */
export async function postRuleProposalRestoreRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const proposalKey = requireString(body, 'proposalKey');
  const actor = requirePersonActor(body, 'bring back a pattern');

  const result = await restoreRuleProposal(deps.db, {
    proposalKey,
    audit: { actor, source: 'api POST /api/rule-proposals/restore' },
  });
  return jsonResponse(200, result);
}
