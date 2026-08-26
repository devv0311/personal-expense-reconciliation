/**
 * The evidence surface: two ways in, one way to place a document, two ways to read it back.
 *
 * ```
 * POST /api/evidence/files                 upload a document (multipart/form-data)
 * POST /api/evidence/notes                 record a typed note (JSON)
 * POST /api/evidence/:evidenceId/link      attach it to a payment and/or an expense
 * GET  /api/evidence/:evidenceId           what the ledger knows about it
 * GET  /api/evidence/:evidenceId/content   the document itself
 * ```
 *
 * The upload is `multipart/form-data` read through `Request.formData()` — a web standard, so
 * this stays a plain `Request → Response` handler and no framework is installed to parse a
 * form (ADR-0032). Everything else is JSON.
 *
 * **`actor` arrives in the request body**, as it does on the review routes, because there is
 * no session yet. Here it is checked against the person forms: a request over HTTP is somebody
 * uploading a receipt, and an ingestion attributed to `system` or `ai` is one the audit trail
 * could never trace to anyone. A background ingester — a mail fetcher, an import job — calls
 * `services.ingestEvidenceDocument` directly and says so honestly. When auth lands, the actor
 * comes from the session and this field goes away (ADR-0032).
 */

import { asId } from '../domain/index.js';
import { EVIDENCE_TYPES } from '../domain/index.js';
import type { EvidenceNoteKind, ExpenseId, PaymentId } from '../domain/index.js';
import { EVIDENCE_NOTE_KINDS } from '../domain/index.js';
import {
  MAX_EVIDENCE_DOCUMENT_BYTES,
  getEvidence,
  ingestEvidenceDocument,
  linkEvidence,
  readEvidenceDocument,
  recordManualNote,
} from '../services/index.js';
import type { EvidenceDocumentType } from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalString,
  readJsonObject,
  requireOneOf,
  requireParam,
  requireString,
  requireUuid,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/** Everything except `manual_note`, which has its own route because it has no file. */
const DOCUMENT_TYPES = EVIDENCE_TYPES.filter(
  (type): type is EvidenceDocumentType => type !== 'manual_note',
);

/**
 * Room for the multipart envelope on top of the document itself.
 *
 * The `content-length` check below is a cheap pre-filter that refuses an obviously oversized
 * upload before the body is read into memory; the real limit is the service's, applied to the
 * document's own bytes.
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/* ---------------------------------------------------------------------------- uploads */

/**
 * `POST /api/evidence/files` — store a document.
 *
 * Form fields: `file` (the document), `type`, `capturedAt` (ISO-8601), `actor`, and the
 * optional `linkedPaymentId`, `linkedExpenseId`, `rawText`, `reason`.
 *
 * The media type comes from the uploaded part, not from a field the caller could set
 * independently of the bytes; `domain.parseEvidenceMediaType` is what accepts or refuses it.
 */
export async function postEvidenceFile(deps: ApiDependencies, request: Request): Promise<Response> {
  assertDeclaredSizeWithinLimit(request);

  const form = await readFormData(request);
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    throw new ApiRequestError('"file" is required and must be an uploaded file part.', 'file');
  }

  const fields = formFields(form);
  const type = requireOneOf(fields, 'type', DOCUMENT_TYPES);
  const capturedAt = requireTimestamp(fields, 'capturedAt');
  const actor = requirePersonActor(fields);
  const rawText = optionalString(fields, 'rawText');
  const reason = optionalString(fields, 'reason');

  const result = await ingestEvidenceDocument(deps.db, {
    type,
    bytes: new Uint8Array(await file.arrayBuffer()),
    mediaType: file.type,
    capturedAt,
    ...links(fields),
    ...(rawText === undefined ? {} : { rawText }),
    store: deps.evidenceStore,
    audit: {
      actor,
      source: 'api POST /api/evidence/files',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  // 200 rather than 201 for an already-stored document: nothing was created, and saying so is
  // how a client learns its retry was not a second upload.
  return jsonResponse(result.outcome === 'ingested' ? 201 : 200, result);
}

/**
 * `POST /api/evidence/notes` — record a typed note.
 *
 * Body: `{ actor, text, noteKind, capturedAt, linkedPaymentId?, linkedExpenseId?, reason? }`.
 * `noteKind` is required and never defaulted: the same row documents an externally-funded
 * expense and claims a debt was cleared, and guessing either way is a financial error
 * (ADR-0018).
 */
export async function postEvidenceNote(deps: ApiDependencies, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const noteKind = requireOneOf(body, 'noteKind', EVIDENCE_NOTE_KINDS) satisfies EvidenceNoteKind;
  const text = requireString(body, 'text');
  const capturedAt = requireTimestamp(body, 'capturedAt');
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');

  const evidenceId = await recordManualNote(deps.db, {
    text,
    noteKind,
    capturedAt,
    ...links(body),
    audit: {
      actor,
      source: 'api POST /api/evidence/notes',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(201, { evidenceId });
}

/* ---------------------------------------------------------------------------- linkage */

/**
 * `POST /api/evidence/:evidenceId/link` — attach a document to what it is evidence of.
 *
 * Body: `{ actor, linkedPaymentId?, linkedExpenseId?, reason? }`. An omitted side is left
 * alone; a side already set may only be re-stated. Re-pointing or clearing one is refused by
 * `domain.assertEvidenceLinkOnce` and surfaces as a 422.
 */
export async function postEvidenceLink(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const evidenceId = asId<'evidence'>(
    requireUuid(requireParam(params, 'evidenceId'), 'evidenceId'),
  );
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body);
  const reason = optionalString(body, 'reason');
  const requested = links(body);

  if (requested.linkedPaymentId === undefined && requested.linkedExpenseId === undefined) {
    throw new ApiRequestError(
      'Give at least one of "linkedPaymentId" or "linkedExpenseId". A link request naming ' +
        'neither would be a decision about nothing.',
    );
  }

  const evidence = await linkEvidence(deps.db, {
    evidenceId,
    ...requested,
    audit: {
      actor,
      source: 'api POST /api/evidence/:evidenceId/link',
      ...(reason === undefined ? {} : { reason }),
    },
  });

  return jsonResponse(200, evidence);
}

/* ------------------------------------------------------------------------------ reads */

/** `GET /api/evidence/:evidenceId` — what the ledger knows about a piece of evidence. */
export async function getEvidenceMetadata(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const evidenceId = asId<'evidence'>(
    requireUuid(requireParam(params, 'evidenceId'), 'evidenceId'),
  );
  return jsonResponse(200, await getEvidence(deps.db, evidenceId));
}

/**
 * `GET /api/evidence/:evidenceId/content` — the document itself.
 *
 * The only route that returns something other than JSON. `nosniff` is set because the
 * response body is a file a person uploaded: the media type is one of a small allowlist, and
 * this is what stops a browser from deciding otherwise.
 */
export async function getEvidenceContent(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const evidenceId = asId<'evidence'>(
    requireUuid(requireParam(params, 'evidenceId'), 'evidenceId'),
  );
  const document = await readEvidenceDocument(deps.db, {
    evidenceId,
    store: deps.evidenceStore,
  });

  return new Response(document.bytes, {
    status: 200,
    headers: {
      'content-type': document.mediaType,
      'content-length': String(document.bytes.byteLength),
      'x-content-type-options': 'nosniff',
    },
  });
}

/* ------------------------------------------------------------------------- validation */

/**
 * An actor this ingestion can be attributed to.
 *
 * `user` or `user:<id>`, and nothing else. The audit trail's job is to answer who did this
 * (`invariants.md` #21), and an upload arriving over HTTP that claims to be `system` is an
 * answer nobody can check.
 */
function requirePersonActor(body: Record<string, unknown>): string {
  const actor = requireString(body, 'actor');
  if (actor !== 'user' && !actor.startsWith('user:')) {
    throw new ApiRequestError(
      `"${actor}" cannot ingest evidence over HTTP. A request here is a person's act, so the ` +
        'actor is "user" or "user:<id>". A background ingester calls the service directly and ' +
        'records itself honestly.',
      'actor',
    );
  }
  return actor;
}

/** An ISO-8601 timestamp, refused rather than coerced. */
function requireTimestamp(body: Record<string, unknown>, field: string): Date {
  const raw = requireString(body, field);
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new ApiRequestError(`"${field}" must be an ISO-8601 timestamp.`, field);
  }
  return value;
}

/** The two optional link fields, present only when the caller supplied them. */
function links(body: Record<string, unknown>): {
  linkedPaymentId?: PaymentId;
  linkedExpenseId?: ExpenseId;
} {
  const paymentId = optionalString(body, 'linkedPaymentId');
  const expenseId = optionalString(body, 'linkedExpenseId');
  return {
    ...(paymentId === undefined
      ? {}
      : { linkedPaymentId: asId<'payment'>(requireUuid(paymentId, 'linkedPaymentId')) }),
    ...(expenseId === undefined
      ? {}
      : { linkedExpenseId: asId<'expense'>(requireUuid(expenseId, 'linkedExpenseId')) }),
  };
}

/** Refuses an obviously oversized upload before its body is read into memory. */
function assertDeclaredSizeWithinLimit(request: Request): void {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_EVIDENCE_DOCUMENT_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new ApiRequestError(
      `The upload declares ${declared} bytes; the limit is ${MAX_EVIDENCE_DOCUMENT_BYTES}.`,
      'file',
    );
  }
}

async function readFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new ApiRequestError('The request body must be multipart/form-data.');
  }
}

/** The non-file parts, as the shared validators expect them. */
function formFields(form: FormData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}
