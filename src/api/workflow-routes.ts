/**
 * The four capabilities the audit found modelled-but-unreachable, over HTTP: standing rules,
 * analytics, expense occasions, and the background job queue — plus Splitwise stale re-sync.
 *
 * ```
 * GET  /api/rules                        every rule, in evaluation order
 * POST /api/rules                        write one
 * POST /api/rules/apply                  run them (dryRun previews)
 * POST /api/rules/:ruleId                edit / deactivate / archive one
 *
 * GET  /api/analytics/spending           by category, for a period
 * GET  /api/analytics/monthly            the trend
 * GET  /api/analytics/own-spend          what the user's own share came to
 * GET  /api/analytics/outstanding        every open balance at once
 * GET  /api/analytics/unsettled          paid on behalf, still owed
 *
 * GET  /api/occasions                    occasions, with how many expenses each groups
 * POST /api/occasions                    create one
 * POST /api/expenses/:expenseId/occasion attach / detach
 *
 * GET  /api/jobs                         the queue
 * POST /api/jobs                         queue one
 * GET  /api/jobs/:jobId                  one job
 * POST /api/jobs/:jobId/retry            re-queue a failed one
 * POST /api/jobs/:jobId/cancel           stop one nobody wants any more
 *
 * GET  /api/splitwise/resync-candidates  rows the two ledgers disagree about
 * POST /api/expenses/:expenseId/splitwise-resync  correct this expense's entry in place
 * POST /api/settlements/:settlementId/splitwise-resync  correct this settlement's entry
 * ```
 */

import {
  CASH_FLOW_CATEGORIES,
  JOB_KINDS,
  JOB_STATUSES,
  PAYMENT_CHANNELS,
  PAYMENT_COUNTERPARTY_TYPES,
  PAYMENT_DIRECTIONS,
  RULE_EFFECTS,
  RULE_TEXT_OPERATORS,
  asId,
} from '../domain/index.js';
import type { Paise, RuleAssertion, RuleMatchPattern } from '../domain/index.js';
import { getPrimaryUserPerson } from '../db/index.js';
import {
  applyRules,
  assignExpenseToOccasion,
  cancelJob,
  createOccasion,
  createRule,
  enqueueJob,
  getCategorySpend,
  getJob,
  getMonthlySpend,
  getOutstandingBalances,
  getOwnSpend,
  getUnsettledPaidOnBehalf,
  listJobs,
  listOccasions,
  describeSplitwiseRepairCapability,
  listResyncCandidates,
  listSettlementResyncCandidates,
  listRules,
  resyncExpenseToSplitwise,
  resyncSettlementToSplitwise,
  retryJob,
  updateRule,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalBoolean,
  optionalMinorUnitsField,
  optionalOneOf,
  optionalOneOfParam,
  optionalPositiveInteger,
  optionalString,
  optionalTimestamp,
  optionalTimestampParam,
  readJsonObject,
  requireOneOf,
  requireParam,
  requirePersonActor,
  requireString,
  requireTimestamp,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/* =============================================================================== rules */

export async function getRulesRoute(deps: ApiDependencies): Promise<Response> {
  const rules = await listRules(deps.db);
  return jsonResponse(200, { rules });
}

/**
 * `POST /api/rules` — write a standing rule.
 *
 * Body: `{ actor, name, match: {...}, assertion: {...}, effect? }`. `effect` defaults to
 * `propose`: a rule that writes unattended is opt-in, per rule, because `rule:<id>` as an
 * author is only defensible when a person chose it knowing what it does.
 */
export async function postRule(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'write a rule');
  const effect = optionalOneOf(body, 'effect', RULE_EFFECTS);

  const result = await createRule(deps.db, {
    name: requireString(body, 'name'),
    match: parseMatchPattern(body),
    assertion: parseAssertion(body),
    ...(effect === undefined ? {} : { effect }),
    audit: { actor, source: 'api POST /api/rules' },
  });
  return jsonResponse(201, result);
}

export async function postRuleUpdate(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const ruleId = asId<'rule'>(requireUuid(requireParam(params, 'ruleId'), 'ruleId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'edit a rule');
  const effect = optionalOneOf(body, 'effect', RULE_EFFECTS);
  const active = optionalBoolean(body, 'active');
  const archived = optionalBoolean(body, 'archived');
  const name = optionalString(body, 'name');

  await updateRule(deps.db, {
    ruleId,
    ...(name === undefined ? {} : { name }),
    ...('match' in body ? { match: parseMatchPattern(body) } : {}),
    ...('assertion' in body ? { assertion: parseAssertion(body) } : {}),
    ...(effect === undefined ? {} : { effect }),
    ...(active === undefined ? {} : { active }),
    ...(archived === undefined ? {} : { archived }),
    audit: { actor, source: 'api POST /api/rules/:ruleId' },
  });
  return jsonResponse(200, { ruleId });
}

/**
 * `POST /api/rules/apply` — run every active rule over the uninterpreted payments.
 *
 * Body: `{ actor, importBatchId?, dryRun?, limit? }`. `dryRun: true` writes nothing and
 * reports what would happen, which is how a person checks a rule before letting it loose.
 * A payment matching two rules comes back as a **conflict** and is left alone.
 */
export async function postApplyRules(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'run the rules');
  const importBatchId = optionalString(body, 'importBatchId');
  const dryRun = optionalBoolean(body, 'dryRun');
  const limit = body['limit'];

  const result = await applyRules(deps.db, {
    ...(importBatchId === undefined
      ? {}
      : { importBatchId: requireUuid(importBatchId, 'importBatchId') }),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(typeof limit === 'number' ? { limit } : {}),
    audit: { actor, source: 'api POST /api/rules/apply' },
  });
  return jsonResponse(200, result);
}

/* =========================================================================== analytics */

/** Every analytics read takes the same period, and refuses one that runs backwards. */
function requirePeriod(request: Request): { start: Date; end: Date } {
  const params = new URL(request.url).searchParams;
  const start = optionalTimestampParam(params, 'from');
  const end = optionalTimestampParam(params, 'to');
  if (start === undefined || end === undefined) {
    throw new ApiRequestError('"from" and "to" are required ISO-8601 timestamps.', 'from');
  }
  if (end <= start) {
    throw new ApiRequestError('"to" must be after "from".', 'to');
  }
  return { start, end };
}

export async function getSpendingRoute(deps: ApiDependencies, request: Request): Promise<Response> {
  return jsonResponse(200, await getCategorySpend(deps.db, requirePeriod(request)));
}

export async function getMonthlySpendRoute(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  return jsonResponse(200, await getMonthlySpend(deps.db, requirePeriod(request)));
}

export async function getOwnSpendRoute(deps: ApiDependencies, request: Request): Promise<Response> {
  const userPerson = await requireUserPerson(deps);
  return jsonResponse(200, await getOwnSpend(deps.db, userPerson.personId, requirePeriod(request)));
}

export async function getOutstandingRoute(deps: ApiDependencies): Promise<Response> {
  const userPerson = await requireUserPerson(deps);
  return jsonResponse(200, await getOutstandingBalances(deps.db, userPerson.personId));
}

export async function getUnsettledRoute(deps: ApiDependencies): Promise<Response> {
  const userPerson = await requireUserPerson(deps);
  return jsonResponse(200, await getUnsettledPaidOnBehalf(deps.db, userPerson.personId));
}

/* =========================================================================== occasions */

export async function getOccasionsRoute(deps: ApiDependencies): Promise<Response> {
  const occasions = await listOccasions(deps.db);
  return jsonResponse(200, { occasions });
}

export async function postOccasion(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'create an occasion');
  const occurredEnd = optionalTimestamp(body, 'occurredEnd');
  const participants = body['defaultParticipants'];

  const result = await createOccasion(deps.db, {
    name: requireString(body, 'name'),
    occurredStart: requireTimestamp(body, 'occurredStart'),
    ...(occurredEnd === undefined ? {} : { occurredEnd }),
    ...(Array.isArray(participants)
      ? {
          defaultParticipants: participants.map((entry, index) =>
            asId<'person'>(requireUuid(String(entry), `defaultParticipants[${index}]`)),
          ),
        }
      : {}),
    audit: { actor, source: 'api POST /api/occasions' },
  });
  return jsonResponse(201, result);
}

/**
 * `POST /api/expenses/:expenseId/occasion` — file an expense under an occasion, or unfile it.
 *
 * Body: `{ actor, occasionId }`, with `occasionId: null` to detach. A label, carrying no money:
 * grouping three expenses changes no amount, no allocation and no balance.
 */
export async function postExpenseOccasion(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'file an expense under an occasion');
  if (!('occasionId' in body)) {
    throw new ApiRequestError(
      '"occasionId" is required — an occasion id to file it under, or null to unfile it.',
      'occasionId',
    );
  }
  const raw = optionalString(body, 'occasionId');

  await assignExpenseToOccasion(deps.db, {
    expenseId,
    occasionId: raw === undefined ? null : asId<'expense_occasion'>(requireUuid(raw, 'occasionId')),
    audit: { actor, source: 'api POST /api/expenses/:expenseId/occasion' },
  });
  return jsonResponse(200, { expenseId, occasionId: raw ?? null });
}

/* ================================================================================ jobs */

export async function getJobsRoute(deps: ApiDependencies, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const status = optionalOneOfParam(params, 'status', JOB_STATUSES);
  const kind = optionalOneOfParam(params, 'kind', JOB_KINDS);
  const limit = optionalPositiveInteger(params, 'limit');
  const offset = optionalPositiveInteger(params, 'offset');

  const result = await listJobs(deps.db, {
    ...(status === undefined ? {} : { status }),
    ...(kind === undefined ? {} : { kind }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
  return jsonResponse(200, result);
}

export async function postJob(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'queue a job');
  const payload = body['payload'];
  const scheduledFor = optionalTimestamp(body, 'scheduledFor');

  const result = await enqueueJob(deps.db, {
    kind: requireOneOf(body, 'kind', JOB_KINDS),
    ...(typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { payload: payload as Record<string, unknown> }
      : {}),
    ...(scheduledFor === undefined ? {} : { scheduledFor }),
    actor,
  });
  return jsonResponse(201, result);
}

export async function getJobRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const jobId = requireUuid(requireParam(params, 'jobId'), 'jobId');
  return jsonResponse(200, await getJob(deps.db, jobId));
}

export async function postJobRetry(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const jobId = requireUuid(requireParam(params, 'jobId'), 'jobId');
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'retry a job');
  const job = await retryJob(deps.db, {
    jobId,
    audit: { actor, source: 'api POST /api/jobs/:jobId/retry' },
  });
  return jsonResponse(200, job);
}

export async function postJobCancel(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const jobId = requireUuid(requireParam(params, 'jobId'), 'jobId');
  const body = await readJsonObject(request);
  requirePersonActor(body, 'cancel a job');
  const job = await cancelJob(deps.db, jobId, requireString(body, 'reason'));
  return jsonResponse(200, job);
}

/* ==================================================================== Splitwise re-sync */

/**
 * `GET /api/splitwise/resync-candidates` — everything a person could choose to repair.
 *
 * `capability` travels with the list rather than being assumed: the injected adapter may not
 * be able to correct an entry in place at all, and a screen that offered the repair anyway
 * would be promising something the port cannot do (ADR-0050, ADR-0055).
 */
export async function getResyncCandidatesRoute(deps: ApiDependencies): Promise<Response> {
  const [candidates, settlements] = await Promise.all([
    listResyncCandidates(deps.db),
    listSettlementResyncCandidates(deps.db),
  ]);
  return jsonResponse(200, {
    candidates,
    settlements,
    capability: describeSplitwiseRepairCapability(deps.splitwise),
  });
}

/**
 * `POST /api/expenses/:expenseId/splitwise-resync` — correct this expense's entry in Splitwise.
 *
 * Body: `{ actor, reason }`. `reason` is required: this changes a figure in somebody else's
 * ledger, and they are entitled to an account of why.
 */
export async function postSplitwiseResync(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'correct a Splitwise row');
  const reason = requireString(body, 'reason');

  const result = await resyncExpenseToSplitwise(deps.db, {
    expenseId,
    splitwise: deps.splitwise,
    reason,
    audit: { actor, source: 'api POST /api/expenses/:expenseId/splitwise-resync', reason },
  });
  return jsonResponse(200, result);
}

/**
 * `POST /api/settlements/:settlementId/splitwise-resync` — correct a drifted settlement.
 *
 * Body: `{ actor, reason }`, on the same terms as the expense repair above.
 */
export async function postSplitwiseSettlementResync(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const settlementId = asId<'settlement'>(
    requireUuid(requireParam(params, 'settlementId'), 'settlementId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'correct a Splitwise settlement');
  const reason = requireString(body, 'reason');

  const result = await resyncSettlementToSplitwise(deps.db, {
    settlementId,
    splitwise: deps.splitwise,
    reason,
    audit: { actor, source: 'api POST /api/settlements/:settlementId/splitwise-resync', reason },
  });
  return jsonResponse(200, result);
}

/* ------------------------------------------------------------------------- validation */

async function requireUserPerson(
  deps: ApiDependencies,
): Promise<NonNullable<Awaited<ReturnType<typeof getPrimaryUserPerson>>>> {
  const userPerson = await getPrimaryUserPerson(deps.db);
  if (userPerson === null) {
    throw new ApiRequestError(
      'This ledger has no user yet, so there is nobody whose spending or balances to report.',
    );
  }
  return userPerson;
}

function parseMatchPattern(body: Record<string, unknown>): RuleMatchPattern {
  const raw = body['match'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiRequestError('"match" is required and must be an object.', 'match');
  }
  const match = raw as Record<string, unknown>;
  const description = optionalString(match, 'description');
  const descriptionOperator = optionalOneOf(match, 'descriptionOperator', RULE_TEXT_OPERATORS);
  const direction = optionalOneOf(match, 'direction', PAYMENT_DIRECTIONS);
  const channel = optionalOneOf(match, 'channel', PAYMENT_CHANNELS);
  const accountId = optionalString(match, 'accountId');
  const amount = optionalMinorUnitsField(match, 'amount');

  return {
    ...(description === undefined ? {} : { description }),
    ...(descriptionOperator === undefined ? {} : { descriptionOperator }),
    ...(direction === undefined ? {} : { direction }),
    ...(channel === undefined ? {} : { channel }),
    ...(accountId === undefined
      ? {}
      : { accountId: asId<'account'>(requireUuid(accountId, 'match.accountId')) }),
    ...(amount === undefined || amount === null ? {} : { amount: amount as Paise }),
  };
}

function parseAssertion(body: Record<string, unknown>): RuleAssertion {
  const raw = body['assertion'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiRequestError('"assertion" is required and must be an object.', 'assertion');
  }
  const assertion = raw as Record<string, unknown>;
  const action = requireOneOf(assertion, 'action', [
    'set_counterparty_type',
    'set_cash_flow_category',
    'set_expense_category',
  ] as const);

  if (action === 'set_counterparty_type') {
    return {
      action,
      counterpartyType: requireOneOf(assertion, 'counterpartyType', PAYMENT_COUNTERPARTY_TYPES),
    };
  }
  if (action === 'set_cash_flow_category') {
    return {
      action,
      cashFlowCategory: requireOneOf(assertion, 'cashFlowCategory', CASH_FLOW_CATEGORIES),
    };
  }
  return { action, category: requireString(assertion, 'category') };
}
