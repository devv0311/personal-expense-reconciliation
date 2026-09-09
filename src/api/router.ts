/**
 * A path dispatcher, so the API can be exercised by a `Request` — from a test, or from
 * `src/server.ts`, the process that actually runs this dispatcher now (phase 15, ADR-0042) —
 * without a framework in between.
 *
 * The handlers are the real product here; this is the smallest thing that turns a set of them
 * into something you can send a `Request` to. ADR-0032 predicted mounting these directly as
 * Next.js App Router route handlers once a UI phase arrived; ADR-0042 chose instead to give
 * `createApi` a real process of its own (`src/server.ts`, no framework) and have the Next.js
 * app (`web/`) call it over `fetch` like any other client — so this table remains the one place
 * every route is listed, and stays on the path rather than being replaced by one.
 *
 * Matching is exact-segment with `:name` captures, first match wins. No wildcards, no regex
 * routes, no scoring — a route table this small does not need them, and every one of those
 * features is a way for two routes to disagree about who owns a path. The one ordering rule it
 * does have is written down at `API_ROUTES`.
 */

import { resolveSession } from '../services/index.js';
import type {
  AiService,
  Database,
  DocumentTextExtractor,
  EvidenceStore,
  SplitwisePort,
} from '../services/index.js';

import { getAccountsRoute } from './account-routes.js';
import {
  getIntakeStatusRoute,
  hasValidIntakeToken,
  postForwardedMessages,
} from './intake-routes.js';
import {
  getRefundAllocationRoute,
  postDistributeAdjustment,
  postExpenseAdjustment,
} from './adjustment-routes.js';
import { postAllocation } from './allocation-routes.js';
import { getBalanceRoute } from './balance-routes.js';
import {
  getEvidenceMatchesRoute,
  getEvidenceObservationRoute,
  getPaymentContextRoute,
  postEvidenceEnrichment,
  postEvidenceMatchDecision,
  postEvidenceNotification,
  postEvidenceObservation,
} from './evidence-enrichment-routes.js';
import {
  getEvidenceContent,
  getEvidenceMetadata,
  postEvidenceFile,
  postEvidenceLink,
  postEvidenceNote,
} from './evidence-routes.js';
import {
  getExpenseFundingRoute,
  postExpense,
  postExpenseFunding,
  postExpenseItemsCorrection,
} from './expense-authoring-routes.js';
import { getExpenseItemsRoute, postExpenseItems } from './expense-item-routes.js';
import {
  getAuditTrailRoute,
  getEvidenceLibraryRoute,
  getExpenseHistoryRoute,
  getPaymentHistoryRoute,
} from './history-routes.js';
import {
  getCounterpartyOptionsRoute,
  getImportBatchRoute,
  getImportsRoute,
  getPaymentRoute,
  getPaymentsRoute,
  getStatementFormatsRoute,
  postBankCsvImport,
  postStatementImport,
  postCashFlowDecision,
  postClassifyPayments,
  postManualPayment,
  postNormalizePayments,
  postPaymentCounterparty,
} from './payment-routes.js';
import {
  getGroupsRoute,
  getMerchantsRoute,
  getPeopleManagementRoute,
  postAccount,
  postAccountUpdate,
  postGroup,
  postGroupMember,
  postGroupMembershipEnd,
  postGroupUpdate,
  postMerchant,
  postMerchantAlias,
  postMerchantUpdate,
  postPerson,
  postPersonUpdate,
} from './master-data-routes.js';
import { getExpenseRoute, getExpensesRoute } from './expense-ledger-routes.js';
import { jsonResponse, toErrorResponse } from './http.js';
import { getPeopleRoute } from './people-routes.js';
import { getProofPackRoute } from './proof-pack-routes.js';
import {
  getReceiptRoute,
  postReceiptConfirmation,
  postReceiptCorrection,
  postReceiptExtraction,
} from './receipt-routes.js';
import {
  getReconciliationAccountSnapshotsRoute,
  getReconciliationRunRoute,
  getReconciliationRunsRoute,
  postReconciliationRun,
} from './reconciliation-routes.js';
import {
  getReviewQueue,
  postInferenceDecision,
  postPaymentDuplicateDecision,
  postPaymentReclassification,
} from './review-routes.js';
import {
  getSessionRoute,
  postSetPassword,
  postSignIn,
  postSignOut,
  readSessionToken,
} from './session-routes.js';
import { getSettlementsRoute, postSettlement } from './settlement-routes.js';
import {
  getJobRoute,
  getJobsRoute,
  getMonthlySpendRoute,
  getOccasionsRoute,
  getOutstandingRoute,
  getOwnSpendRoute,
  getResyncCandidatesRoute,
  getRulesRoute,
  getSpendingRoute,
  getUnsettledRoute,
  postApplyRules,
  postExpenseOccasion,
  postJob,
  postJobCancel,
  postJobRetry,
  postOccasion,
  postRule,
  postRuleUpdate,
  postSplitwiseResync,
} from './workflow-routes.js';
import {
  getSplitwiseAuditFindingRoute,
  getSplitwiseAuditFindingsRoute,
  getSplitwiseAuditRunRoute,
  getSplitwiseAuditsRoute,
  postSplitwiseAudit,
  postSplitwiseAuditFindingReview,
} from './splitwise-audit-routes.js';
import {
  postConnectSplitwiseIntegration,
  postReadyToSync,
  postSyncExpense,
  postSyncSettlement,
} from './splitwise-routes.js';

/** What the handlers need. Injected, so nothing in `src/api` reaches for a connection. */
export interface ApiDependencies {
  readonly db: Database;
  /** Used by classification and receipt extraction; every other route is a read or a decision. */
  readonly ai: AiService;
  /** Where documents live, which is deliberately not the database (`security-model.md`). */
  readonly evidenceStore: EvidenceStore;
  /**
   * Turns a stored receipt's bytes into text (audit row 14, ADR-0051).
   *
   * Optional, and absent means extraction still works over a record that already carries
   * text while a stored photograph is **refused by name** rather than extracted as an empty
   * receipt. `src/server.ts` always composes one; a test that omits it is exercising the
   * text path deliberately.
   */
  readonly documentText?: DocumentTextExtractor;
  /** A real adapter when one is configured; a rejecting stub otherwise (ADR-0040). */
  readonly splitwise: SplitwisePort;
  /**
   * Whether this process refuses unauthenticated requests (audit row 50).
   *
   * Optional here, and **off** when omitted — deliberately. `src/api` is a route table; it has
   * no idea whether it is behind a loopback socket, a reverse proxy, or nothing at all, so it
   * has no business holding an opinion about when a lock is needed. The process that binds the
   * socket does: `src/server.ts` sets this, and defaults it to **on** for any bind that is not
   * loopback. A test that constructs `createApi` directly is exercising the routes, not the
   * door, and gets the door open.
   */
  readonly authRequired?: boolean;
  /**
   * The shared secret an automated forwarder authenticates with (audit row 12).
   *
   * Optional, and **absent means the forwarding endpoint refuses every request** — not that
   * it stands open. That direction is deliberate: an unconfigured intake route accepting
   * anonymous writes would be a stranger's route into a person's evidence table, while a
   * configured-but-unused one costs nothing. `src/server.ts` reads it from
   * `INTAKE_FORWARDING_TOKEN`.
   */
  readonly intakeForwardingToken?: string;
}

export type RouteParams = Readonly<Record<string, string>>;

export type RouteHandler = (
  deps: ApiDependencies,
  request: Request,
  params: RouteParams,
) => Promise<Response>;

export interface ApiRoute {
  readonly method: 'GET' | 'POST';
  /** e.g. `/api/review/payments/:paymentId/duplicate` */
  readonly path: string;
  readonly handler: RouteHandler;
}

/**
 * Establishing and ending a session (audit row 50).
 *
 * The only routes {@link requiresSession} exempts, for the obvious reason: a sign-in that
 * required a session could never be reached.
 */
export const SESSION_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/session', handler: getSessionRoute },
  { method: 'POST', path: '/api/session', handler: postSignIn },
  { method: 'POST', path: '/api/session/end', handler: postSignOut },
  { method: 'POST', path: '/api/session/password', handler: postSetPassword },
];

export const REVIEW_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/review', handler: getReviewQueue },
  {
    method: 'POST',
    path: '/api/review/inferences/:inferenceId/decision',
    handler: postInferenceDecision,
  },
  {
    method: 'POST',
    path: '/api/review/payments/:paymentId/reclassify',
    handler: postPaymentReclassification,
  },
  {
    method: 'POST',
    path: '/api/review/payments/:paymentId/duplicate',
    handler: postPaymentDuplicateDecision,
  },
];

/**
 * Ingesting a document, placing it, and reading it back (`docs/roadmap.md` phase 10), plus
 * phase 17's notification ingestion, enrichment and match decisions.
 *
 * `/api/evidence/files`, `/api/evidence/notes`, `/api/evidence/notifications` and
 * `/api/evidence/matches/:candidateId/decision` are listed **before** `/api/evidence/:evidenceId`
 * and its children, which would otherwise read the literal segments as ids.
 */
export const EVIDENCE_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/evidence', handler: getEvidenceLibraryRoute },
  { method: 'POST', path: '/api/evidence/files', handler: postEvidenceFile },
  { method: 'POST', path: '/api/evidence/notes', handler: postEvidenceNote },
  { method: 'POST', path: '/api/evidence/notifications', handler: postEvidenceNotification },
  {
    method: 'POST',
    path: '/api/evidence/matches/:candidateId/decision',
    handler: postEvidenceMatchDecision,
  },
  { method: 'POST', path: '/api/evidence/:evidenceId/link', handler: postEvidenceLink },
  { method: 'POST', path: '/api/evidence/:evidenceId/receipt', handler: postReceiptExtraction },
  {
    method: 'POST',
    path: '/api/evidence/:evidenceId/observation',
    handler: postEvidenceObservation,
  },
  {
    method: 'GET',
    path: '/api/evidence/:evidenceId/observation',
    handler: getEvidenceObservationRoute,
  },
  { method: 'POST', path: '/api/evidence/:evidenceId/enrich', handler: postEvidenceEnrichment },
  { method: 'GET', path: '/api/evidence/:evidenceId/matches', handler: getEvidenceMatchesRoute },
  { method: 'GET', path: '/api/evidence/:evidenceId', handler: getEvidenceMetadata },
  { method: 'GET', path: '/api/evidence/:evidenceId/content', handler: getEvidenceContent },
];

/** Confirming, correcting and reading the `Receipt` extraction produced (`docs/roadmap.md` phase 11). */
export const RECEIPT_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/receipts/:receiptId/confirm', handler: postReceiptConfirmation },
  { method: 'POST', path: '/api/receipts/:receiptId/correct', handler: postReceiptCorrection },
  { method: 'GET', path: '/api/receipts/:receiptId', handler: getReceiptRoute },
];

/**
 * Items, allocation and adjustments over one expense — deciding who benefited from it and by
 * how much (`docs/roadmap.md` phase 12).
 */
export const ALLOCATION_ROUTES: readonly ApiRoute[] = [
  // `/items/correct` before `/items`: they differ in length, so no capture swallows either,
  // but keeping the more specific path first matches the table's stated ordering rule.
  {
    method: 'POST',
    path: '/api/expenses/:expenseId/items/correct',
    handler: postExpenseItemsCorrection,
  },
  { method: 'POST', path: '/api/expenses/:expenseId/items', handler: postExpenseItems },
  {
    method: 'GET',
    path: '/api/expenses/:expenseId/payment-links',
    handler: getExpenseFundingRoute,
  },
  { method: 'POST', path: '/api/expenses/:expenseId/payment-links', handler: postExpenseFunding },
  { method: 'GET', path: '/api/expenses/:expenseId/items', handler: getExpenseItemsRoute },
  { method: 'GET', path: '/api/expenses/:expenseId/history', handler: getExpenseHistoryRoute },
  { method: 'POST', path: '/api/expenses/:expenseId/occasion', handler: postExpenseOccasion },
  { method: 'POST', path: '/api/expenses/:expenseId/allocation', handler: postAllocation },
  {
    method: 'POST',
    path: '/api/expenses/:expenseId/adjustments/distribute',
    handler: postDistributeAdjustment,
  },
  {
    method: 'POST',
    path: '/api/expenses/:expenseId/adjustments',
    handler: postExpenseAdjustment,
  },
  {
    method: 'GET',
    path: '/api/expenses/:expenseId/refund-allocation',
    handler: getRefundAllocationRoute,
  },
];

/** A manual settlement over a payment, independent of classification (phase 12). */
export const SETTLEMENT_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/payments/:paymentId/settlements', handler: postSettlement },
  { method: 'GET', path: '/api/settlements', handler: getSettlementsRoute },
];

/**
 * What the evidence attached to a payment says about it — `services.getPaymentContext`
 * (phase 17, ADR-0044). A read: the payment's own narration comes back unchanged beside it.
 */
export const PAYMENT_CONTEXT_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/payments/:paymentId/context', handler: getPaymentContextRoute },
];

/** Statement import and its history (`docs/roadmap.md` phase 6; audit rows 01–02). */
export const IMPORT_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/imports/bank-csv', handler: postBankCsvImport },
  { method: 'POST', path: '/api/imports/statement', handler: postStatementImport },
  { method: 'GET', path: '/api/imports/formats', handler: getStatementFormatsRoute },
  { method: 'GET', path: '/api/imports', handler: getImportsRoute },
  { method: 'GET', path: '/api/imports/:importBatchId', handler: getImportBatchRoute },
];

/**
 * Automated notification intake (audit row 12).
 *
 * `POST /api/intake/messages` is the one route authenticated by a **forwarding token** rather
 * than a session — its callers are a mail rule and a phone shortcut, neither of which has a
 * browser. See {@link TOKEN_AUTHENTICATED_PATHS}. `GET /api/intake/status` is an ordinary
 * session-protected read: a configuration screen asks it whether forwarding is set up.
 */
export const INTAKE_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/intake/messages', handler: postForwardedMessages },
  { method: 'GET', path: '/api/intake/status', handler: getIntakeStatusRoute },
];

/**
 * The payment workspace: every posted movement, what explains it, and the decisions a person
 * makes about one (audit rows 02, 04–07, 36).
 *
 * The three literal third segments — `counterparty-options`, `normalize`, `classify` — are
 * listed before `/api/payments/:paymentId`, which would otherwise read them as ids.
 */
export const PAYMENT_WORKSPACE_ROUTES: readonly ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/payments/counterparty-options',
    handler: getCounterpartyOptionsRoute,
  },
  { method: 'POST', path: '/api/payments/normalize', handler: postNormalizePayments },
  { method: 'POST', path: '/api/payments/classify', handler: postClassifyPayments },
  { method: 'GET', path: '/api/payments', handler: getPaymentsRoute },
  { method: 'POST', path: '/api/payments', handler: postManualPayment },
  {
    method: 'POST',
    path: '/api/payments/:paymentId/counterparty',
    handler: postPaymentCounterparty,
  },
  {
    method: 'POST',
    path: '/api/payments/:paymentId/cash-flow/:step',
    handler: postCashFlowDecision,
  },
  { method: 'GET', path: '/api/payments/:paymentId/history', handler: getPaymentHistoryRoute },
  { method: 'GET', path: '/api/payments/:paymentId', handler: getPaymentRoute },
];

/**
 * The append-only audit log, over any record that has one (audit row 33).
 *
 * A read of `audit_events`, which has no update or delete path anywhere in this repository.
 */
export const AUDIT_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/audit/:entityType/:entityId', handler: getAuditTrailRoute },
];

/**
 * Standing rules (audit row 43).
 *
 * `/api/rules/apply` is listed before `/api/rules/:ruleId`, which would otherwise read
 * "apply" as an id — the one precedence rule this table has.
 */
export const RULE_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/rules', handler: getRulesRoute },
  { method: 'POST', path: '/api/rules', handler: postRule },
  { method: 'POST', path: '/api/rules/apply', handler: postApplyRules },
  { method: 'POST', path: '/api/rules/:ruleId', handler: postRuleUpdate },
];

/** Aggregate reads over the ledger's own figures (audit rows 30 and 44). All reads. */
export const ANALYTICS_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/analytics/spending', handler: getSpendingRoute },
  { method: 'GET', path: '/api/analytics/monthly', handler: getMonthlySpendRoute },
  { method: 'GET', path: '/api/analytics/own-spend', handler: getOwnSpendRoute },
  { method: 'GET', path: '/api/analytics/outstanding', handler: getOutstandingRoute },
  { method: 'GET', path: '/api/analytics/unsettled', handler: getUnsettledRoute },
];

/** Expense occasions — a label over a group of expenses, carrying no money (audit row 47). */
export const OCCASION_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/occasions', handler: getOccasionsRoute },
  { method: 'POST', path: '/api/occasions', handler: postOccasion },
];

/** The background job queue (audit row 51). A job orchestrates; it never approves. */
export const JOB_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/jobs', handler: getJobsRoute },
  { method: 'POST', path: '/api/jobs', handler: postJob },
  { method: 'POST', path: '/api/jobs/:jobId/retry', handler: postJobRetry },
  { method: 'POST', path: '/api/jobs/:jobId/cancel', handler: postJobCancel },
  { method: 'GET', path: '/api/jobs/:jobId', handler: getJobRoute },
];

/**
 * The expense ledger, queryable — `services.listExpenses` (`docs/roadmap.md` phase 13) — and
 * one row of it, which the phase 21 expense detail screen reads.
 */
export const EXPENSE_LEDGER_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/expenses', handler: getExpensesRoute },
  { method: 'POST', path: '/api/expenses', handler: postExpense },
  { method: 'GET', path: '/api/expenses/:expenseId', handler: getExpenseRoute },
];

/** The pairwise `Balance` between any two people — `services.getBalance` (phase 13, ADR-0006). */
export const BALANCE_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/balances/:personAId/:personBId', handler: getBalanceRoute },
];

/**
 * The people roster `web/` renders names from — `services.listPeople` (phase 15) — and the
 * management surface that lets a fresh installation build one (audit row 48).
 *
 * `/api/people/manage` is listed before nothing in particular: it is a literal path under a
 * collection with no `:personId` GET, so no capture can swallow it. `POST /api/people/:personId`
 * is the edit; a second POST verb on the collection would have been ambiguous.
 */
export const PEOPLE_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/people/manage', handler: getPeopleManagementRoute },
  { method: 'GET', path: '/api/people', handler: getPeopleRoute },
  { method: 'POST', path: '/api/people', handler: postPerson },
  { method: 'POST', path: '/api/people/:personId', handler: postPersonUpdate },
];

/** The merchant catalog and its aliases — what makes an unknown narration fixable by hand. */
export const MERCHANT_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/merchants', handler: getMerchantsRoute },
  { method: 'POST', path: '/api/merchants', handler: postMerchant },
  { method: 'POST', path: '/api/merchants/:merchantId/aliases', handler: postMerchantAlias },
  { method: 'POST', path: '/api/merchants/:merchantId', handler: postMerchantUpdate },
];

/** Groups and their membership stints (ADR-0009). A stint ends; it is never deleted. */
export const GROUP_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/groups', handler: getGroupsRoute },
  { method: 'POST', path: '/api/groups', handler: postGroup },
  { method: 'POST', path: '/api/groups/:groupId/members', handler: postGroupMember },
  { method: 'POST', path: '/api/groups/:groupId', handler: postGroupUpdate },
  {
    method: 'POST',
    path: '/api/group-memberships/:membershipId/end',
    handler: postGroupMembershipEnd,
  },
];

/**
 * The account roster the per-account cash waterfall names — `services.listAccounts`
 * (phase 21). Phase 16 shipped the snapshot with no surface for it on purpose.
 */
export const ACCOUNT_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/accounts', handler: getAccountsRoute },
  { method: 'POST', path: '/api/accounts', handler: postAccount },
  { method: 'POST', path: '/api/accounts/:accountId', handler: postAccountUpdate },
];

/**
 * The recipient-specific derived proof pack — `services.buildProofPackPreview` (phase 20,
 * ADR-0047). A read: it derives a preview from approved ledger state and neither sends it nor
 * records anything.
 */
export const PROOF_PACK_ROUTES: readonly ApiRoute[] = [
  { method: 'GET', path: '/api/proof-packs/:recipientPersonId', handler: getProofPackRoute },
];

/**
 * Running a reconciliation and reading its history — `services.runReconciliation`
 * (phase 15, ADR-0041).
 */
export const RECONCILIATION_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/reconciliation/runs', handler: postReconciliationRun },
  { method: 'GET', path: '/api/reconciliation/runs', handler: getReconciliationRunsRoute },
  { method: 'GET', path: '/api/reconciliation/runs/:id', handler: getReconciliationRunRoute },
  {
    method: 'GET',
    path: '/api/reconciliation/runs/:id/account-snapshots',
    handler: getReconciliationAccountSnapshotsRoute,
  },
];

/** Connecting to, and syncing with, Splitwise for the first time (phase 14, ADR-0040). */
export const SPLITWISE_ROUTES: readonly ApiRoute[] = [
  {
    method: 'POST',
    path: '/api/integrations/splitwise/connect',
    handler: postConnectSplitwiseIntegration,
  },
  { method: 'POST', path: '/api/expenses/:expenseId/ready-to-sync', handler: postReadyToSync },
  { method: 'POST', path: '/api/expenses/:expenseId/splitwise-sync', handler: postSyncExpense },
  {
    method: 'POST',
    path: '/api/expenses/:expenseId/splitwise-resync',
    handler: postSplitwiseResync,
  },
  { method: 'GET', path: '/api/splitwise/resync-candidates', handler: getResyncCandidatesRoute },
  {
    method: 'POST',
    path: '/api/settlements/:settlementId/splitwise-sync',
    handler: postSyncSettlement,
  },
];

/**
 * Running the Splitwise drift & ghost-debt audit, reading its findings, and reviewing one
 * (phase 19, ADR-0046). Every route is a read or a recorded decision — none writes to
 * Splitwise, and reviewing a finding does not authorize one to.
 */
export const SPLITWISE_AUDIT_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/splitwise/audits', handler: postSplitwiseAudit },
  { method: 'GET', path: '/api/splitwise/audits', handler: getSplitwiseAuditsRoute },
  { method: 'GET', path: '/api/splitwise/audits/:id', handler: getSplitwiseAuditRunRoute },
  {
    method: 'GET',
    path: '/api/splitwise/audit-findings',
    handler: getSplitwiseAuditFindingsRoute,
  },
  {
    method: 'GET',
    path: '/api/splitwise/audit-findings/:id',
    handler: getSplitwiseAuditFindingRoute,
  },
  {
    method: 'POST',
    path: '/api/splitwise/audit-findings/:id/review',
    handler: postSplitwiseAuditFindingReview,
  },
];

/**
 * Every route, in match order.
 *
 * Order carries one rule: a literal segment is listed before the capture that would swallow
 * it. `/api/evidence/files` and `/api/evidence/notes` come before `/api/evidence/:evidenceId`,
 * which would otherwise read both as ids. That is the whole precedence story — one line of
 * ordering rather than a scoring algorithm — and `handle` below is what makes it hold for
 * every verb rather than only for the ones that happen to be registered first.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  ...SESSION_ROUTES,
  ...REVIEW_ROUTES,
  ...EVIDENCE_ROUTES,
  ...RECEIPT_ROUTES,
  ...ALLOCATION_ROUTES,
  ...SETTLEMENT_ROUTES,
  ...PAYMENT_CONTEXT_ROUTES,
  ...IMPORT_ROUTES,
  ...INTAKE_ROUTES,
  ...PAYMENT_WORKSPACE_ROUTES,
  ...AUDIT_ROUTES,
  ...RULE_ROUTES,
  ...ANALYTICS_ROUTES,
  ...OCCASION_ROUTES,
  ...JOB_ROUTES,
  ...EXPENSE_LEDGER_ROUTES,
  ...BALANCE_ROUTES,
  ...PEOPLE_ROUTES,
  ...ACCOUNT_ROUTES,
  ...MERCHANT_ROUTES,
  ...GROUP_ROUTES,
  ...PROOF_PACK_ROUTES,
  ...SPLITWISE_ROUTES,
  ...SPLITWISE_AUDIT_ROUTES,
  ...RECONCILIATION_ROUTES,
];

/**
 * The paths reachable without a session.
 *
 * A closed set, listed rather than pattern-matched: every other route in the table is
 * protected, and adding one is protected by default. That is the direction a mistake here
 * should fail in — a new route accidentally left public is a leak of somebody's financial
 * history, while a new route accidentally protected is a 401 somebody notices in a minute.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(SESSION_ROUTES.map((route) => route.path));

/**
 * The paths that authenticate with the forwarding token instead of a session.
 *
 * Exactly one, and it is a closed set for the same reason {@link PUBLIC_PATHS} is: a route
 * accidentally added here is a write path reachable with a token that was only ever meant to
 * append evidence. These are **not** public — a request without a valid token is rejected,
 * and an installation with no token configured rejects every request to them.
 */
const TOKEN_AUTHENTICATED_PATHS: ReadonlySet<string> = new Set(['/api/intake/messages']);

export interface Api {
  readonly routes: readonly ApiRoute[];
  handle(request: Request): Promise<Response>;
}

/**
 * Builds the API over its dependencies.
 *
 * Errors are caught here rather than in each handler, so every route maps failures the same
 * way and no handler can accidentally return a stack trace (`security-model.md`).
 */
export function createApi(deps: ApiDependencies): Api {
  return {
    routes: API_ROUTES,
    handle: async (request: Request): Promise<Response> => {
      try {
        const { pathname } = new URL(request.url);
        const segments = splitPath(pathname);

        // The first pattern that matches **owns** the path; the routes sharing that pattern
        // are its methods. Without that, a GET of `/api/evidence/files` would fall past the
        // POST it belongs to and into `/api/evidence/:evidenceId`, which would then complain
        // that "files" is not a UUID — a 400 about an id the caller never sent, for what is
        // plainly a wrong verb on a known path.
        const matches = API_ROUTES.map((route) => ({
          route,
          params: matchPath(splitPath(route.path), segments),
        })).filter(
          (match): match is { route: ApiRoute; params: RouteParams } => match.params !== null,
        );

        const owner = matches[0]?.route.path;
        const match = matches.find(
          (candidate) =>
            candidate.route.path === owner && candidate.route.method === request.method,
        );
        if (match !== undefined) {
          // The door, before the route (audit row 50). Deliberately here rather than in each
          // handler: a check every handler has to remember is a check one of them eventually
          // will not, and what is behind these routes is a person's entire financial history.
          if (TOKEN_AUTHENTICATED_PATHS.has(match.route.path)) {
            // A forwarder has no cookie, so this path is gated by its own shared secret —
            // and, when none is configured, closed rather than open. Checked before the
            // session branch so an unauthenticated forwarder never falls through to it.
            if (!hasValidIntakeToken(request, deps.intakeForwardingToken)) {
              return jsonResponse(401, {
                error: {
                  code: 'NOT_AUTHENTICATED',
                  message:
                    'This endpoint requires the forwarding token. Send it as ' +
                    '"Authorization: Bearer <token>". If no INTAKE_FORWARDING_TOKEN is set on ' +
                    'the server, forwarding is off and every request here is refused.',
                },
              });
            }
            return await match.route.handler(deps, request, match.params);
          }

          if (deps.authRequired === true && !PUBLIC_PATHS.has(match.route.path)) {
            const identity = await resolveSession(deps.db, readSessionToken(request));
            if (identity === null) {
              return jsonResponse(401, {
                error: {
                  code: 'NOT_AUTHENTICATED',
                  message:
                    'This ledger requires a session. Sign in at POST /api/session, or set a ' +
                    'password first at POST /api/session/password.',
                },
              });
            }
          }
          return await match.route.handler(deps, request, match.params);
        }

        // A known path with the wrong verb is a different mistake from an unknown path, and
        // saying so is the difference between a usable API and a guessing game.
        return owner !== undefined
          ? jsonResponse(405, {
              error: {
                code: 'METHOD_NOT_ALLOWED',
                message: `${request.method} is not allowed here.`,
              },
            })
          : jsonResponse(404, {
              error: { code: 'NOT_FOUND', message: `No route for ${pathname}.` },
            });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  };
}

/* ------------------------------------------------------------------------- internals */

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** Returns the captured params, or `null` when this route does not match. */
function matchPath(pattern: string[], actual: string[]): RouteParams | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    const segment = actual[i]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(segment);
      continue;
    }
    if (expected !== segment) return null;
  }
  return params;
}
