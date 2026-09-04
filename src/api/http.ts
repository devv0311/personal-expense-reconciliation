/**
 * The three things `src/api` is allowed to do: validate a request, serialize a response, and
 * turn an error from a lower layer into a status code.
 *
 * No business logic lives here and none may. Every rule this file appears to encode is really
 * a translation: which HTTP status corresponds to a failure another layer already decided, and
 * how a `bigint` becomes JSON. If something here starts needing to know what a payment *means*,
 * it belongs in `src/services` (`system-architecture.md`, Layering).
 */

import { isDomainError } from '../domain/index.js';
import { isAiContractError } from '../ai/index.js';
import { isServiceError } from '../services/index.js';

/** A request this layer refused before any service saw it. */
export class ApiRequestError extends Error {
  public readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.field = field;
  }
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly field?: string;
  };
}

/**
 * `JSON.stringify` cannot represent a `bigint`, and must not be allowed to represent money as
 * a `number`.
 *
 * Every monetary value crosses this boundary as an exact decimal **string** of minor units —
 * the same discipline `fixtures/` uses in the other direction, and for the same reason
 * (`invariants.md` #12). A `Date` serializes to ISO-8601 on its own.
 */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, replacer), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Maps a failure to a status code.
 *
 * The mapping is the whole point of this function: `src/services` and `src/domain` raise typed
 * errors with stable codes precisely so a transport layer can translate rather than
 * string-match (`services/errors.ts`).
 *
 * An unrecognised error becomes a bare 500 with no detail, per `security-model.md`'s logging
 * rule — an unexpected failure must not return internals to the caller.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiRequestError) {
    return jsonResponse(400, {
      error: {
        code: 'INVALID_REQUEST',
        message: error.message,
        ...(error.field === undefined ? {} : { field: error.field }),
      },
    } satisfies ApiErrorBody);
  }

  if (isAiContractError(error)) {
    // A proposal that is not a proposal. The caller sent it (a `modify`), so it is theirs.
    return jsonResponse(422, {
      error: { code: error.code, message: error.message },
    } satisfies ApiErrorBody);
  }

  if (isDomainError(error)) {
    const status =
      error.code === 'DECISION_ACTOR_INVALID'
        ? 403
        : error.code === 'INVALID_STATE_TRANSITION'
          ? 409
          : 422;
    return jsonResponse(status, {
      error: { code: error.code, message: error.message },
    } satisfies ApiErrorBody);
  }

  if (isServiceError(error)) {
    const status =
      error.code === 'ENTITY_NOT_FOUND'
        ? 404
        : error.code === 'PRECONDITION_FAILED'
          ? 409
          : error.code === 'AI_PROPOSAL_INVALID'
            ? 422
            : error.code === 'IMPORT_SOURCE_INVALID'
              ? 400
              : error.code === 'EVIDENCE_DOCUMENT_TOO_LARGE'
                ? 413
                : error.code === 'EVIDENCE_STORE_UNAVAILABLE'
                  ? 503
                  : error.code === 'SPLITWISE_SYNC_FAILED'
                    ? 502
                    : 500;
    return jsonResponse(status, {
      error: { code: error.code, message: error.message },
    } satisfies ApiErrorBody);
  }

  return jsonResponse(500, {
    error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' },
  } satisfies ApiErrorBody);
}

/* ------------------------------------------------------------------------ validation */

/** Reads a JSON object body, refusing anything that is not one. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiRequestError('The request body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiRequestError('The request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiRequestError(`"${field}" is required and must be a non-empty string.`, field);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ApiRequestError(`"${field}", when present, must be a string.`, field);
  }
  return value;
}

export function requireOneOf<T extends string>(
  body: Record<string, unknown>,
  field: string,
  permitted: readonly T[],
): T {
  const value = requireString(body, field);
  if (!(permitted as readonly string[]).includes(value)) {
    throw new ApiRequestError(`"${field}" must be one of ${permitted.join(', ')}.`, field);
  }
  return value as T;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks that an id is a UUID before it becomes a branded id.
 *
 * This is the boundary `domain/ids.ts` names: "persistence and API boundaries are where UUID
 * shape is checked; `domain` receives already-validated data". Without it a malformed path
 * segment reaches the database as a failed cast rather than as a 400.
 */
export function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiRequestError(`"${field}" must be a UUID.`, field);
  }
  return value;
}

/** A positive integer query parameter, e.g. `?limit=20`. */
export function optionalPositiveInteger(
  params: URLSearchParams,
  field: string,
): number | undefined {
  const raw = params.get(field);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new ApiRequestError(`"${field}" must be a non-negative integer.`, field);
  }
  return Number.parseInt(raw, 10);
}

/** A `bigint` query parameter carrying minor units, e.g. `?materialityThreshold=500000`. */
export function optionalMinorUnits(params: URLSearchParams, field: string): bigint | undefined {
  const raw = params.get(field);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new ApiRequestError(
      `"${field}" must be a non-negative integer count of minor units.`,
      field,
    );
  }
  return BigInt(raw);
}

/**
 * A JSON body field carrying minor units, distinguishing "absent" from "explicitly null" —
 * `services.correctReceipt`'s way of telling "leave this field alone" from "clear it".
 * `undefined` means the key was not sent at all; `null` means it was sent as `null`.
 */
export function optionalMinorUnitsField(
  body: Record<string, unknown>,
  field: string,
): bigint | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ApiRequestError(
      `"${field}" must be a non-negative integer count of minor units as a decimal string, or ` +
        'null.',
      field,
    );
  }
  return BigInt(value);
}

/** A required JSON body field carrying minor units — no "absent" or "null" reading. */
export function requireMinorUnitsField(body: Record<string, unknown>, field: string): bigint {
  const value = optionalMinorUnitsField(body, field);
  if (value === undefined || value === null) {
    throw new ApiRequestError(
      `"${field}" is required and must be a non-negative integer count of minor units as a ` +
        'decimal string.',
      field,
    );
  }
  return value;
}

/** An ISO-8601 timestamp, refused rather than coerced. */
export function requireTimestamp(body: Record<string, unknown>, field: string): Date {
  const raw = requireString(body, field);
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new ApiRequestError(`"${field}" must be an ISO-8601 timestamp.`, field);
  }
  return value;
}

/** An optional ISO-8601 timestamp — `undefined` when the field is absent or null. */
export function optionalTimestamp(body: Record<string, unknown>, field: string): Date | undefined {
  const raw = optionalString(body, field);
  if (raw === undefined) return undefined;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new ApiRequestError(`"${field}", when present, must be an ISO-8601 timestamp.`, field);
  }
  return value;
}

/** The path segment `params` should have carried, refused as a 400 rather than a cast failure. */
export function requireParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new ApiRequestError(`"${name}" is missing from the path.`, name);
  return value;
}
