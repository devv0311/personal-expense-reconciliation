/**
 * Statement import, the payment workspace, and the two interpretation lifecycles that run over
 * a payment — the legacy `imported → normalized → linked` one, and ADR-0017's cash-flow one.
 *
 * ```
 * POST /api/imports/bank-csv                      import one statement
 * GET  /api/imports                               import history
 * GET  /api/imports/:importBatchId                one batch
 * GET  /api/payments                              the workspace, filtered and paged
 * GET  /api/payments/counterparty-options         who a counterparty may be set to
 * POST /api/payments                              record a hand-entered movement
 * POST /api/payments/normalize                    run normalization
 * POST /api/payments/classify                     run classification (needs a model)
 * GET  /api/payments/:paymentId                   one movement, with what explains it
 * POST /api/payments/:paymentId/counterparty      say what the other side was
 * POST /api/payments/:paymentId/cash-flow/…       normalize | classify | approve | reject
 * ```
 *
 * Ordering: the literal `/api/payments/counterparty-options`, `/api/payments/normalize` and
 * `/api/payments/classify` are registered before `/api/payments/:paymentId`, which would
 * otherwise read them as ids — the one precedence rule `router.ts` documents.
 *
 * Nothing here approves anything on a payment's behalf. `classify` records proposals;
 * `cash-flow/approve` runs `domain.validateCashFlowApproval` over evidence counted from the
 * ledger's own rows, and refuses when the evidence is not there (17.1, 17.2).
 */

import {
  CASH_FLOW_CATEGORIES,
  CASH_FLOW_STATES,
  PAYMENT_CHANNELS,
  PAYMENT_COUNTERPARTY_TYPES,
  PAYMENT_DIRECTIONS,
  PAYMENT_REFERENCE_TYPES,
  PAYMENT_STATES,
  asId,
} from '../domain/index.js';
import type { Paise } from '../domain/index.js';
import { getPrimaryUserPerson } from '../db/index.js';
import {
  approvePaymentCashFlow,
  classifyPaymentCashFlow,
  classifyPayments,
  getImportBatch,
  getPaymentWorkspaceItem,
  importBankStatementCsv,
  importStatement,
  listImportHistory,
  listSupportedStatementFormats,
  listPaymentCounterpartyOptions,
  listPaymentsWorkspace,
  markPaymentCashFlowNormalized,
  normalizePayments,
  recordManualPayment,
  rejectPaymentCashFlow,
  setPaymentCounterparty,
} from '../services/index.js';

import {
  ApiRequestError,
  jsonResponse,
  optionalOneOf,
  optionalOneOfParam,
  optionalPositiveInteger,
  optionalString,
  optionalTimestampParam,
  optionalUuidParam,
  readJsonObject,
  requireMinorUnitsField,
  requireOneOf,
  requireParam,
  requirePersonActor,
  requireString,
  requireTimestamp,
  requireUuid,
  requireUuidField,
} from './http.js';
import type { ApiDependencies, RouteParams } from './router.js';

/* ============================================================================= imports */

/**
 * `POST /api/imports/bank-csv` — import one bank-statement CSV.
 *
 * Body: `{ actor, accountId, sourceSystem, fileContent, fileReference? }`. The file arrives as
 * text in JSON rather than as multipart: a statement CSV is small, and keeping one body parser
 * is worth more than saving the base64 a browser would otherwise not need anyway.
 *
 * All-or-nothing. A file with any unreadable row imports **nothing** and reports every bad
 * row, because a partially imported statement leaves the ledger quietly missing movements —
 * which is the exact condition cash reconciliation exists to detect.
 */
export async function postBankCsvImport(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'import a statement');
  const fileContent = requireString(body, 'fileContent');
  const fileReference = optionalString(body, 'fileReference');

  const result = await importBankStatementCsv(deps.db, {
    accountId: asId<'account'>(requireUuidField(body, 'accountId')),
    sourceSystem: requireString(body, 'sourceSystem'),
    fileContent,
    ...(fileReference === undefined ? {} : { fileReference }),
    audit: { actor, source: 'api POST /api/imports/bank-csv' },
  });

  // `already_imported` is a recognised no-op, not a failure: the file's content hash matched a
  // batch already on record, so nothing was written twice (`invariants.md` #10).
  return jsonResponse(result.outcome === 'already_imported' ? 200 : 201, result);
}

/**
 * `GET /api/imports/formats` — every statement format this build actually reads.
 *
 * A read, and the honest answer to "what can I upload?". The audit's row 02 found the ledger
 * accepting exactly one synthetic five-column CSV; the list this returns is what replaced it,
 * and it is generated from the format declarations rather than written out again here, so a
 * screen naming a format this build cannot read is not a state the two can reach.
 */
export function getStatementFormatsRoute(): Promise<Response> {
  return Promise.resolve(jsonResponse(200, { formats: listSupportedStatementFormats() }));
}

/**
 * `POST /api/imports/statement` — import one statement in any supported format.
 *
 * Body: `{ actor, accountId, sourceSystem, formatId, contentBase64 | fileContent, filename?,
 * fileReference? }`.
 *
 * `contentBase64` rather than only text, because two of the three containers are binary: an
 * `.xlsx` is a ZIP and a `.pdf` is a binary document, and either one decoded as UTF-8 first is
 * destroyed. A plain-text CSV may still be sent as `fileContent`, which is what the existing
 * import screen does.
 *
 * `formatId` may be `"auto"`. Detection refuses rather than picking a winner it is unsure of —
 * guessing a format is guessing which column held the money — and the refusal names every
 * format this build reads.
 *
 * All-or-nothing, exactly as `POST /api/imports/bank-csv` is: a file with any unreadable row
 * imports nothing and reports every bad row.
 */
export async function postStatementImport(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'import a statement');
  const formatId = requireString(body, 'formatId');
  const filename = optionalString(body, 'filename');
  const fileReference = optionalString(body, 'fileReference');

  const base64 = optionalString(body, 'contentBase64');
  const text = optionalString(body, 'fileContent');
  if ((base64 === undefined) === (text === undefined)) {
    throw new ApiRequestError(
      'Send the statement as exactly one of "contentBase64" (any format, including XLSX and ' +
        'PDF) or "fileContent" (text formats only).',
      'contentBase64',
    );
  }

  let bytes: Uint8Array;
  if (base64 !== undefined) {
    bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    // `Buffer.from(_, 'base64')` never throws — it stops at the first byte it cannot read.
    // So the check that matters is that something decoded at all: a body of punctuation
    // silently becomes an empty buffer, and importing "no rows" from it would look like a
    // statement with no transactions rather than a request that never arrived intact.
    if (bytes.byteLength === 0) {
      throw new ApiRequestError(
        '"contentBase64" decoded to no bytes. Send the file as base64, or send a text ' +
          'statement as "fileContent".',
        'contentBase64',
      );
    }
  } else {
    bytes = new TextEncoder().encode(text ?? '');
  }

  const result = await importStatement(deps.db, {
    accountId: asId<'account'>(requireUuidField(body, 'accountId')),
    sourceSystem: requireString(body, 'sourceSystem'),
    formatId,
    bytes,
    ...(filename === undefined ? {} : { filename }),
    ...(fileReference === undefined ? {} : { fileReference }),
    audit: { actor, source: 'api POST /api/imports/statement' },
  });

  return jsonResponse(result.outcome === 'already_imported' ? 200 : 201, result);
}

export async function getImportsRoute(deps: ApiDependencies, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = optionalPositiveInteger(params, 'limit');
  const offset = optionalPositiveInteger(params, 'offset');
  const result = await listImportHistory(deps.db, {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
  return jsonResponse(200, result);
}

export async function getImportBatchRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const importBatchId = asId<'import_batch'>(
    requireUuid(requireParam(params, 'importBatchId'), 'importBatchId'),
  );
  const batch = await getImportBatch(deps.db, importBatchId);
  return jsonResponse(200, batch);
}

/* =========================================================================== workspace */

/**
 * `GET /api/payments` — every posted movement, filtered.
 *
 * The query parameters exist so a waterfall term can link to exactly its own contributing
 * records: `accountId` + `from`/`to` + `direction` is one term, and `onlyUnexplained=true` is
 * the "payments with no explanation" list Review never was.
 */
export async function getPaymentsRoute(deps: ApiDependencies, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const accountId = optionalUuidParam(params, 'accountId');
  const importBatchId = optionalUuidParam(params, 'importBatchId');
  const direction = optionalOneOfParam(params, 'direction', PAYMENT_DIRECTIONS);
  const state = optionalOneOfParam(params, 'state', PAYMENT_STATES);
  const cashFlowState = optionalOneOfParam(params, 'cashFlowState', CASH_FLOW_STATES);
  const cashFlowCategory = optionalOneOfParam(params, 'cashFlowCategory', CASH_FLOW_CATEGORIES);
  const counterpartyType = optionalOneOfParam(
    params,
    'counterpartyType',
    PAYMENT_COUNTERPARTY_TYPES,
  );
  const search = params.get('search');
  const occurredFrom = optionalTimestampParam(params, 'from');
  const occurredTo = optionalTimestampParam(params, 'to');
  const limit = optionalPositiveInteger(params, 'limit');
  const offset = optionalPositiveInteger(params, 'offset');
  // Deliberately no amount threshold: a movement is not less unexplained for being small,
  // and a floor here would quietly hide the long tail that makes an account fail to close.
  const onlyUnexplained = params.get('onlyUnexplained') === 'true';

  const result = await listPaymentsWorkspace(deps.db, {
    ...(accountId === undefined ? {} : { accountId: asId<'account'>(accountId) }),
    ...(importBatchId === undefined ? {} : { importBatchId: asId<'import_batch'>(importBatchId) }),
    ...(direction === undefined ? {} : { direction }),
    ...(state === undefined ? {} : { state }),
    ...(cashFlowState === undefined ? {} : { cashFlowState }),
    ...(cashFlowCategory === undefined ? {} : { cashFlowCategory }),
    ...(counterpartyType === undefined ? {} : { counterpartyType }),
    ...(search === null || search.length === 0 ? {} : { search }),
    ...(occurredFrom === undefined ? {} : { occurredFrom }),
    ...(occurredTo === undefined ? {} : { occurredTo }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    onlyUnexplained,
  });
  return jsonResponse(200, result);
}

export async function getPaymentRoute(
  deps: ApiDependencies,
  _request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(requireUuid(requireParam(params, 'paymentId'), 'paymentId'));
  const payment = await getPaymentWorkspaceItem(deps.db, paymentId);
  return jsonResponse(200, payment);
}

export async function getCounterpartyOptionsRoute(deps: ApiDependencies): Promise<Response> {
  const options = await listPaymentCounterpartyOptions(deps.db);
  return jsonResponse(200, options);
}

/**
 * `POST /api/payments` — record a movement nobody exported.
 *
 * Body: `{ actor, accountId, amount, direction, occurredAt, description, channel?,
 * externalReference?, referenceType? }`. `amount` is a magnitude in minor units; which way the
 * money went is `direction`, never a sign.
 */
export async function postManualPayment(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'record a movement');
  const channel = optionalOneOf(body, 'channel', PAYMENT_CHANNELS);
  const referenceType = optionalOneOf(body, 'referenceType', PAYMENT_REFERENCE_TYPES);
  const externalReference = optionalString(body, 'externalReference');

  const result = await recordManualPayment(deps.db, {
    accountId: asId<'account'>(requireUuidField(body, 'accountId')),
    amount: requireMinorUnitsField(body, 'amount') as Paise,
    direction: requireOneOf(body, 'direction', PAYMENT_DIRECTIONS),
    occurredAt: requireTimestamp(body, 'occurredAt'),
    description: requireString(body, 'description'),
    ...(channel === undefined ? {} : { channel }),
    ...(externalReference === undefined ? {} : { externalReference }),
    ...(referenceType === undefined ? {} : { referenceType }),
    audit: { actor, source: 'api POST /api/payments' },
  });
  return jsonResponse(201, result);
}

/**
 * `POST /api/payments/:paymentId/counterparty` — say what the other side of a movement was.
 *
 * Body: `{ actor, counterpartyType, counterpartyId?, reason? }`. This is the control audit
 * row 06 found missing: the only way, before this, to mark a SIP debit as an investment or a
 * card payment as a transfer to an owned account was to edit the database by hand.
 */
export async function postPaymentCounterparty(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(requireUuid(requireParam(params, 'paymentId'), 'paymentId'));
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'classify a counterparty');
  const reason = optionalString(body, 'reason');
  const counterpartyId = optionalString(body, 'counterpartyId');

  const result = await setPaymentCounterparty(deps.db, {
    paymentId,
    counterpartyType: requireOneOf(body, 'counterpartyType', PAYMENT_COUNTERPARTY_TYPES),
    ...(counterpartyId === undefined ? {} : { counterpartyId }),
    audit: {
      actor,
      source: 'api POST /api/payments/:paymentId/counterparty',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return jsonResponse(200, result);
}

/* ============================================================== pipeline orchestration */

/**
 * `POST /api/payments/normalize` — refine channels and resolve merchants for what is imported.
 *
 * Deterministic and idempotent-by-state: it acts on payments at `imported` only, and an exact
 * alias miss leaves the counterparty `unknown` rather than guessing (ADR-0022).
 */
export async function postNormalizePayments(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'run normalization');
  const importBatchId = optionalString(body, 'importBatchId');

  const result = await normalizePayments(deps.db, {
    ...(importBatchId === undefined
      ? {}
      : { importBatchId: asId<'import_batch'>(requireUuid(importBatchId, 'importBatchId')) }),
    audit: { actor, source: 'api POST /api/payments/normalize' },
  });
  return jsonResponse(200, result);
}

/**
 * `POST /api/payments/classify` — ask the model what each normalized payment was.
 *
 * Every answer is a **proposal** that lands in the review queue; nothing here approves
 * anything (`ai-boundary.md`). A payment whose answer breaches the contract is reported as a
 * `rejected` outcome and the run continues — that is a fact about one payment, not the run.
 *
 * With no provider configured the transport rejects, and this surfaces as a 502 naming the
 * missing configuration rather than as a silent empty result.
 */
export async function postClassifyPayments(
  deps: ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'run classification');
  const importBatchId = optionalString(body, 'importBatchId');

  try {
    const result = await classifyPayments(deps.db, {
      ...(importBatchId === undefined
        ? {}
        : { importBatchId: asId<'import_batch'>(requireUuid(importBatchId, 'importBatchId')) }),
      ai: deps.ai,
      audit: { actor, source: 'api POST /api/payments/classify' },
    });
    return jsonResponse(200, result);
  } catch (error) {
    // The provider being unreachable is a fact about the environment, not about the request.
    // Saying so plainly is the difference between "configure a model" and a bare 500.
    if (error instanceof Error && /provider is configured|not configured/i.test(error.message)) {
      return jsonResponse(502, {
        error: {
          code: 'AI_PROVIDER_UNAVAILABLE',
          message:
            'Classification needs a configured model provider. Set ANTHROPIC_API_KEY (see ' +
            'docs/architecture/ai-boundary.md) and restart the API. Until then, every ' +
            'payment can still be classified by hand from the payment workspace.',
        },
      });
    }
    throw error;
  }
}

/* =========================================================== the cash-flow lifecycle */

/**
 * `POST /api/payments/:paymentId/cash-flow/:step` — the ADR-0017 lifecycle, one step per call.
 *
 * `normalize` readies a movement for a cash-flow decision, `classify` proposes a category,
 * `approve` records the human decision (subject to the ADR's evidence gates), and `reject`
 * clears the proposal and sends it back. Four separate steps rather than one PATCH, because
 * each is a different decision with a different consequence — and lumping them together is
 * how "approved" quietly becomes a side effect of "classified".
 */
export async function postCashFlowDecision(
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
): Promise<Response> {
  const paymentId = asId<'payment'>(requireUuid(requireParam(params, 'paymentId'), 'paymentId'));
  const step = requireParam(params, 'step');
  const body = await readJsonObject(request);
  const actor = requirePersonActor(body, 'decide a cash-flow role');
  const reason = optionalString(body, 'reason');
  const audit = {
    actor,
    source: `api POST /api/payments/:paymentId/cash-flow/${step}`,
    ...(reason === undefined ? {} : { reason }),
  };

  if (step === 'normalize') {
    const result = await markPaymentCashFlowNormalized(deps.db, { paymentId, audit });
    return jsonResponse(200, result);
  }

  if (step === 'classify') {
    const result = await classifyPaymentCashFlow(deps.db, {
      paymentId,
      category: requireOneOf(body, 'category', CASH_FLOW_CATEGORIES),
      audit,
    });
    return jsonResponse(200, result);
  }

  if (step === 'approve') {
    const userPerson = await getPrimaryUserPerson(deps.db);
    if (userPerson === null) {
      throw new ApiRequestError(
        'No ledger user exists yet, so there is nobody whose accounts count as "own" for the ' +
          'internal-transfer gate.',
      );
    }
    const counterLegPaymentId = optionalString(body, 'counterLegPaymentId');
    const result = await approvePaymentCashFlow(deps.db, {
      paymentId,
      ownerUserId: userPerson.userId,
      ...(counterLegPaymentId === undefined
        ? {}
        : {
            counterLegPaymentId: asId<'payment'>(
              requireUuid(counterLegPaymentId, 'counterLegPaymentId'),
            ),
          }),
      decidedBy: actor,
      audit,
    });
    return jsonResponse(200, result);
  }

  if (step === 'reject') {
    const result = await rejectPaymentCashFlow(deps.db, {
      paymentId,
      // Required, unlike the others: declining a classification without saying why leaves the
      // next reader with a cleared category and no idea what was wrong with it.
      reason: requireString(body, 'reason'),
      audit,
    });
    return jsonResponse(200, result);
  }

  throw new ApiRequestError(
    `"${step}" is not a cash-flow step. Use normalize, classify, approve or reject.`,
    'step',
  );
}
