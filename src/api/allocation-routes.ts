/**
 * The allocation surface: approve who benefited from an expense, and by how much.
 *
 * ```
 * POST /api/expenses/:expenseId/allocation
 * ```
 *
 * One route, because `services.approveAllocation` already covers all six methods and
 * supersession — there is no separate "create" vs. "correct" verb, since approving a second
 * time over an already-allocated expense **is** the correction path (the service supersedes
 * the previous version).
 */

import { ALLOCATION_METHODS, asId } from '../domain/index.js';
import type {
  AllocationMethod,
  BeneficiaryRef,
  GroupId,
  Paise,
  PersonId,
} from '../domain/index.js';
import { approveAllocation } from '../services/index.js';
import type { AllocationDecision, GroupShareOverride } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalMinorUnitsField,
  optionalString,
  optionalTimestamp,
  readJsonObject,
  requireMinorUnitsField,
  requireOneOf,
  requireParam,
  requireString,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/**
 * `POST /api/expenses/:expenseId/allocation` — approve an allocation, superseding any current
 * one.
 *
 * Body: `{ actor, reason?, decidedBy?, decidedAt?, method, ... }`, where the remaining fields
 * depend on `method`:
 *
 * - `equal` — `beneficiaries: [{ type, id }]`
 * - `exact` / `custom` — `lines: [{ beneficiary: { type, id }, amount }]`
 * - `percentage` — `lines: [{ beneficiary: { type, id }, percentage }]`
 * - `item_based` — `lines: [{ beneficiary: { type, id }, expenseItemId, amount? }]`
 * - `quantity_based` — the same, plus `units?` per line: the item's cost is then split across
 *   its unit-stated lines by the Largest Remainder Method (audit row 21)
 *
 * `decidedBy` defaults to `"manual"` — the only origin a human-driven HTTP request can honestly
 * claim; `"rule:<rule_id>"` is for a future rule-engine caller (`invariants.md` #17).
 */
export async function postAllocation(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const expenseId = asId<'expense'>(requireUuid(requireParam(params, 'expenseId'), 'expenseId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const decidedBy = optionalString(body, 'decidedBy') ?? 'manual';
  const decidedAt = optionalTimestamp(body, 'decidedAt');
  const decision = parseDecision(body);
  const groupShareOverrides = parseGroupShareOverrides(body);

  const result = await approveAllocation(deps.db, {
    expenseId,
    decision,
    decidedBy,
    ...(groupShareOverrides === undefined ? {} : { groupShareOverrides }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    audit: {
      actor,
      source: 'api POST /api/expenses/:expenseId/allocation',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(201, result);
}

/* ------------------------------------------------------------------------- validation */

function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot approve an allocation over HTTP. A request here is a person's act, ` +
        'so the actor is "user" or "user:<id>".',
      'actor',
    );
  }
  return actor;
}

function requireBeneficiary(raw: unknown, field: string): BeneficiaryRef {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiRequestError(`"${field}" must be an object.`, field);
  }
  const value = raw as Record<string, unknown>;
  const type = requireOneOf(value, 'type', ['person', 'group']);
  const id = requireUuid(requireString(value, 'id'), `${field}.id`);
  return type === 'person'
    ? { type: 'person', id: asId<'person'>(id) }
    : { type: 'group', id: asId<'group'>(id) };
}

function parseDecision(body: Record<string, unknown>): AllocationDecision {
  const method: AllocationMethod = requireOneOf(body, 'method', ALLOCATION_METHODS);
  switch (method) {
    case 'equal':
      return { method: 'equal', beneficiaries: parseBeneficiaries(body) };
    case 'exact':
    case 'custom': {
      const lines = parseLines(body).map((raw, index) => ({
        beneficiary: requireBeneficiary(raw['beneficiary'], `lines[${index}].beneficiary`),
        amount: requireMinorUnitsField(raw, 'amount') as Paise,
      }));
      return { method, lines };
    }
    case 'percentage': {
      const lines = parseLines(body).map((raw, index) => ({
        beneficiary: requireBeneficiary(raw['beneficiary'], `lines[${index}].beneficiary`),
        percentage: requireString(raw, 'percentage'),
      }));
      return { method: 'percentage', lines };
    }
    case 'item_based':
    case 'quantity_based': {
      const lines = parseLines(body).map((raw, index) => {
        const expenseItemId = asId<'expense_item'>(
          requireUuid(requireString(raw, 'expenseItemId'), `lines[${index}].expenseItemId`),
        );
        const amount = optionalLineAmount(raw, `lines[${index}].amount`);
        const units = optionalUnits(raw, `lines[${index}].units`);
        return {
          beneficiary: requireBeneficiary(raw['beneficiary'], `lines[${index}].beneficiary`),
          expenseItemId,
          ...(amount === undefined ? {} : { amount }),
          ...(units === undefined ? {} : { units }),
        };
      });
      return { method, lines };
    }
  }
}

function parseBeneficiaries(body: Record<string, unknown>): readonly BeneficiaryRef[] {
  const raw = body['beneficiaries'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiRequestError(
      '"beneficiaries" is required and must be a non-empty array for method "equal".',
      'beneficiaries',
    );
  }
  return raw.map((entry, index) => requireBeneficiary(entry, `beneficiaries[${index}]`));
}

function parseLines(body: Record<string, unknown>): readonly Record<string, unknown>[] {
  const raw = body['lines'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiRequestError(
      `"lines" is required and must be a non-empty array for method "${String(body['method'])}".`,
      'lines',
    );
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiRequestError(`"lines[${index}]" must be an object.`, `lines[${index}]`);
    }
    return entry as Record<string, unknown>;
  });
}

/** `amount` on an item-based/quantity-based line: absent lets the domain compute it. */
function optionalLineAmount(raw: Record<string, unknown>, field: string): Paise | undefined {
  const value = optionalMinorUnitsField(raw, 'amount');
  if (value === null) {
    throw new ApiRequestError(
      `"${field}" cannot be null; omit it to let the amount be computed.`,
      field,
    );
  }
  return value === undefined ? undefined : (value as Paise);
}

/**
 * `units` on a quantity-based line: how many of a shared item this beneficiary took.
 *
 * A count, so the same exact-decimal-string discipline as money — a unit claim decides real
 * paise, and a float would be the one place this system rounded by accident.
 */
function optionalUnits(raw: Record<string, unknown>, field: string): bigint | undefined {
  const value = optionalMinorUnitsField(raw, 'units');
  if (value === null) {
    throw new ApiRequestError(`"${field}" cannot be null; omit it instead.`, field);
  }
  return value ?? undefined;
}

/** A non-negative integer weight — a count, not money, but the same exact-string discipline. */
function requireWeight(raw: Record<string, unknown>, field: string): bigint {
  const value = optionalMinorUnitsField(raw, 'weight');
  if (value === undefined || value === null) {
    throw new ApiRequestError(
      `"${field}" is required and must be a non-negative integer as a decimal string.`,
      field,
    );
  }
  return value;
}

function parseGroupShareOverrides(
  body: Record<string, unknown>,
): readonly GroupShareOverride[] | undefined {
  const raw = body['groupShareOverrides'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ApiRequestError(
      '"groupShareOverrides", when present, must be an array.',
      'groupShareOverrides',
    );
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApiRequestError(
        `"groupShareOverrides[${index}]" must be an object.`,
        `groupShareOverrides[${index}]`,
      );
    }
    const value = entry as Record<string, unknown>;
    const groupId = asId<'group'>(
      requireUuid(requireString(value, 'groupId'), `groupShareOverrides[${index}].groupId`),
    ) as GroupId;
    const weightsRaw = value['weights'];
    if (!Array.isArray(weightsRaw) || weightsRaw.length === 0) {
      throw new ApiRequestError(
        `"groupShareOverrides[${index}].weights" is required and must be a non-empty array.`,
        `groupShareOverrides[${index}].weights`,
      );
    }
    const weights = weightsRaw.map((weightEntry, weightIndex) => {
      if (typeof weightEntry !== 'object' || weightEntry === null || Array.isArray(weightEntry)) {
        throw new ApiRequestError(
          `"groupShareOverrides[${index}].weights[${weightIndex}]" must be an object.`,
          `groupShareOverrides[${index}].weights[${weightIndex}]`,
        );
      }
      const weightValue = weightEntry as Record<string, unknown>;
      const personId = asId<'person'>(
        requireUuid(
          requireString(weightValue, 'personId'),
          `groupShareOverrides[${index}].weights[${weightIndex}].personId`,
        ),
      ) as PersonId;
      const weight = requireWeight(
        weightValue,
        `groupShareOverrides[${index}].weights[${weightIndex}].weight`,
      );
      return { personId, weight };
    });
    return { groupId, weights };
  });
}
