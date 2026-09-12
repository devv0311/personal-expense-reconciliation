/**
 * The one place this app talks to the real API (`docs/decisions/0042-frontend-stack-and-server-
 * bridge.md`) — an HTTP call to `src/server.ts`, never a direct import of anything under `src/`
 * in the parent repo. No financial arithmetic happens here or anywhere else in `web/`: every
 * function below returns exactly what the API sent, typed.
 */

import type {
  AccountBoundaryDraft,
  AccountSnapshotsResult,
  AccountSummary,
  AccountType,
  ApiErrorBody,
  AuditTrailEvent,
  ApplyRulesResult,
  BalanceResult,
  BeneficiaryRef,
  CashFlowCategory,
  CashFlowDecisionResult,
  CashFlowState,
  CategorySpendResult,
  ClassifyPaymentsResult,
  CounterpartyOptions,
  CreateExpenseResult,
  DecideEvidenceMatchResult,
  EvidenceLibraryResult,
  EvidenceMatchesResult,
  EvidenceNoteKind,
  EvidenceObservationView,
  EvidenceRecord,
  EvidenceType,
  ExpenseAdjustmentKind,
  ExpenseFundingLink,
  ExpenseHistoryResult,
  ExpenseItemRecord,
  ExpenseLedgerRow,
  ExpensePage,
  ExpenseRelationshipType,
  ExpenseState,
  GroupDetail,
  JobKind,
  JobListResult,
  JobStatus,
  ImportHistoryResult,
  ImportStatementResult,
  MatchEvidenceContextResult,
  MerchantDetail,
  MonthlySpendResult,
  NormalizePaymentsResult,
  NotificationEvidenceType,
  OccasionSummary,
  OutstandingResult,
  OwnSpendResult,
  PaymentChannel,
  PaymentContextResult,
  PaymentCounterpartyType,
  PaymentDirection,
  PaymentListResult,
  PaymentReferenceType,
  PaymentState,
  PaymentWorkspaceItem,
  PersonDetail,
  PersonSummary,
  AccountBalanceReading,
  AccountProviderLink,
  BalanceComparisonResult,
  BalanceProviderStatus,
  MessagingStatus,
  RefreshBalancesResult,
  ProofPackDelivery,
  ProofPackPreview,
  ReceiptView,
  SendProofPackResult,
  ReconciliationRun,
  RefundAllocationState,
  ResyncCandidate,
  ResyncResult,
  RuleAssertion,
  RuleEffect,
  RuleMatchPattern,
  RuleView,
  ReviewItemKind,
  ReviewQueueResult,
  RunReconciliationResult,
  SessionIdentity,
  SessionState,
  SettlementRegisterResult,
  RunSplitwiseAuditResult,
  SplitwiseAuditFinding,
  SplitwiseAuditFindingDetail,
  SplitwiseAuditReviewDecision,
  SplitwiseAuditReviewStatus,
  SplitwiseAuditRun,
  SplitwiseAuditRunDetail,
  UnsettledResult,
} from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/** Every request in this app is made as the ledger's one human — never a service actor. */
const ACTOR = "user";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field: string | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error.code;
    this.field = body.error.field;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      // The session is an `HttpOnly` cookie on the API's origin, which a browser only sends
      // cross-origin when asked to. Keeping the token out of `localStorage` is the point: a
      // person's whole financial history should not be readable by any script on the page.
      credentials: "include",
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, {
      error: {
        code: "NETWORK_ERROR",
        message: "Couldn't reach the API. Check that src/server.ts is running (see web/README.md).",
      },
    });
  }

  if (!response.ok) {
    const body = (await response.json().catch(
      () =>
        ({
          error: { code: "UNKNOWN_ERROR", message: `Request failed with ${response.status}.` },
        }) satisfies ApiErrorBody,
    )) as ApiErrorBody;
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/* ------------------------------------------------------------------------------ expenses */

export interface ListExpensesFilter {
  readonly state?: ExpenseState;
  readonly paidBy?: string;
  readonly beneficiary?: string;
  readonly search?: string;
  readonly category?: string;
  readonly from?: string;
  readonly to?: string;
  readonly withoutAllocation?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A page of the ledger, with how many rows match across the whole of it.
 *
 * The `total` is the point: audit row 32 recorded what its absence cost — a page that loaded
 * the newest rows, searched only those in the browser, and showed a count that meant nothing.
 * Search, category and period are all applied by the API, over every expense.
 */
export async function listExpenses(filter: ListExpensesFilter = {}): Promise<ExpensePage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === "" || value === false) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return request<ExpensePage>(`/api/expenses${query.length > 0 ? `?${query}` : ""}`);
}

/* --------------------------------------------------------------------------------- people */

export async function listPeople(): Promise<readonly PersonSummary[]> {
  const { people } = await request<{ people: PersonSummary[] }>("/api/people");
  return people;
}

/* -------------------------------------------------------------------------------- balances */

export async function getBalance(personAId: string, personBId: string): Promise<BalanceResult> {
  return request<BalanceResult>(`/api/balances/${personAId}/${personBId}`);
}

/* --------------------------------------------------------------------------- reconciliation */

export interface RunReconciliationInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  /**
   * Evidenced statement boundaries, per account (ADR-0017 (cash balance), 17.5).
   *
   * Omit an account — or all of them — and its snapshot comes back `incomplete`. Nothing here
   * substitutes a zero for a balance nobody has confirmed.
   */
  readonly accountBoundaries?: readonly AccountBoundaryDraft[];
}

export async function runReconciliation(
  input: RunReconciliationInput,
): Promise<RunReconciliationResult> {
  return request<RunReconciliationResult>("/api/reconciliation/runs", {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      // Omitted entirely when nothing has been confirmed: the API refuses an empty array,
      // deliberately, because `[]` reads like a claim about accounts it does not name.
      ...(input.accountBoundaries === undefined || input.accountBoundaries.length === 0
        ? {}
        : { accountBoundaries: input.accountBoundaries }),
    }),
  });
}

export async function listReconciliationRuns(
  limit?: number,
): Promise<readonly ReconciliationRun[]> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  const { runs } = await request<{ runs: ReconciliationRun[] }>(`/api/reconciliation/runs${query}`);
  return runs;
}

export async function getReconciliationRun(id: string): Promise<ReconciliationRun> {
  return request<ReconciliationRun>(`/api/reconciliation/runs/${id}`);
}

export async function getReconciliationAccountSnapshots(
  reconciliationRunId: string,
): Promise<AccountSnapshotsResult> {
  return request<AccountSnapshotsResult>(
    `/api/reconciliation/runs/${reconciliationRunId}/account-snapshots`,
  );
}

/* -------------------------------------------------------------------------- accounts */

export async function listAccounts(): Promise<readonly AccountSummary[]> {
  const { accounts } = await request<{ accounts: AccountSummary[] }>("/api/accounts");
  return accounts;
}

/* ---------------------------------------------------------------------------- review */

export interface ReviewQueueFilter {
  readonly kinds?: readonly ReviewItemKind[];
  readonly limit?: number;
}

export async function getReviewQueue(filter: ReviewQueueFilter = {}): Promise<ReviewQueueResult> {
  const params = new URLSearchParams();
  if (filter.kinds !== undefined && filter.kinds.length > 0) {
    params.set("kinds", filter.kinds.join(","));
  }
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const query = params.toString();
  return request<ReviewQueueResult>(`/api/review${query.length > 0 ? `?${query}` : ""}`);
}

/**
 * Records a person's decision on one AI proposal.
 *
 * `accept` and `reject` only. `modify` exists on the API and is deliberately not reachable
 * from this UI: editing a stored proposal means re-authoring a model's structured output, and
 * shipping a half-built editor for it would be a way to approve something nobody read
 * (`docs/roadmap.md` phase 21 scope, ADR-0049).
 */
export async function decideInference(input: {
  readonly inferenceId: string;
  readonly decision: "accept" | "reject";
  readonly reason?: string;
}): Promise<unknown> {
  return request(`/api/review/inferences/${input.inferenceId}/decision`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      decision: input.decision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

export async function decidePaymentDuplicate(input: {
  readonly paymentId: string;
  readonly duplicateOfPaymentId: string;
  readonly decision: "confirm" | "dismiss";
  readonly reason?: string;
}): Promise<unknown> {
  return request(`/api/review/payments/${input.paymentId}/duplicate`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      decision: input.decision,
      duplicateOfPaymentId: input.duplicateOfPaymentId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/* -------------------------------------------------------------------------- evidence */

export async function getEvidence(evidenceId: string): Promise<EvidenceRecord> {
  return request<EvidenceRecord>(`/api/evidence/${evidenceId}`);
}

export async function getEvidenceMatches(evidenceId: string): Promise<EvidenceMatchesResult> {
  return request<EvidenceMatchesResult>(`/api/evidence/${evidenceId}/matches`);
}

/** The recorded reading of a document, or `null` when nothing has read it. A read, not a re-run. */
export async function getEvidenceObservation(
  evidenceId: string,
): Promise<EvidenceObservationView | null> {
  const { observation } = await request<{ observation: EvidenceObservationView | null }>(
    `/api/evidence/${evidenceId}/observation`,
  );
  return observation;
}

/** Finds the payments one evidence record could be about. Records candidates; never links. */
export async function enrichEvidence(evidenceId: string): Promise<MatchEvidenceContextResult> {
  return request<MatchEvidenceContextResult>(`/api/evidence/${evidenceId}/enrich`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR }),
  });
}

/** The only path from a candidate to `evidence.linked_payment_id` — an explicit human act. */
export async function decideEvidenceMatch(input: {
  readonly candidateId: string;
  readonly decision: "accept" | "dismiss";
  readonly reason?: string;
}): Promise<DecideEvidenceMatchResult> {
  return request<DecideEvidenceMatchResult>(`/api/evidence/matches/${input.candidateId}/decision`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      decision: input.decision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

export async function getReceipt(receiptId: string): Promise<ReceiptView> {
  return request<ReceiptView>(`/api/receipts/${receiptId}`);
}

export async function getPaymentContext(paymentId: string): Promise<PaymentContextResult> {
  return request<PaymentContextResult>(`/api/payments/${paymentId}/context`);
}

/* ------------------------------------------------------------- expenses: one, and its parts */

export async function getExpense(expenseId: string): Promise<ExpenseLedgerRow> {
  return request<ExpenseLedgerRow>(`/api/expenses/${expenseId}`);
}

export async function getExpenseItems(expenseId: string): Promise<readonly ExpenseItemRecord[]> {
  const { items } = await request<{ items: ExpenseItemRecord[] }>(
    `/api/expenses/${expenseId}/items`,
  );
  return items;
}

export async function getRefundAllocation(expenseId: string): Promise<RefundAllocationState> {
  return request<RefundAllocationState>(`/api/expenses/${expenseId}/refund-allocation`);
}

export interface RecordAdjustmentInput {
  readonly expenseId: string;
  readonly kind: ExpenseAdjustmentKind;
  readonly amount: string;
  readonly occurredAt: string;
  readonly reason?: string;
  /**
   * The credit this refund actually arrived on.
   *
   * Optional because a reimbursement may be recorded before its money shows up. But without
   * it the expense drops while the incoming cash stays unexplained on the account — the exact
   * shape that makes a statement fail to close later (audit row 27).
   */
  readonly adjustmentPaymentId?: string;
  /**
   * The complete `{ expenseItemId, amount }` set for an item-attributed refund, or omitted
   * for ADR-0008's whole-expense one. A partial set is refused by the service, not padded.
   */
  readonly itemAttributions?: readonly {
    readonly expenseItemId: string;
    readonly amount: string;
  }[];
}

export async function recordAdjustment(input: RecordAdjustmentInput): Promise<unknown> {
  return request(`/api/expenses/${input.expenseId}/adjustments`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      kind: input.kind,
      amount: input.amount,
      occurredAt: input.occurredAt,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.adjustmentPaymentId === undefined
        ? {}
        : { adjustmentPaymentId: input.adjustmentPaymentId }),
      ...(input.itemAttributions === undefined || input.itemAttributions.length === 0
        ? {}
        : { itemAttributions: input.itemAttributions }),
    }),
  });
}

/**
 * Folds every recorded-but-undistributed adjustment into a new `Allocation` version.
 *
 * `customWeights` is a non-proportional distribution of the **unattributed** whole-expense
 * reduction, positionally aligned with the current allocation's lines. Omit it for the
 * proportional-to-existing-share default. Where an item-attributed refund lands is decided by
 * its attribution, never by these weights — the API refuses them outright in that case rather
 * than ignoring them (ADR-0018).
 */
export async function distributeAdjustment(input: {
  readonly expenseId: string;
  readonly reason?: string;
  readonly customWeights?: readonly string[];
}): Promise<unknown> {
  return request(`/api/expenses/${input.expenseId}/adjustments/distribute`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.customWeights === undefined ? {} : { customWeights: input.customWeights }),
    }),
  });
}

/* ------------------------------------------------------------------- the Splitwise audit */

export async function listSplitwiseAuditRuns(
  limit?: number,
): Promise<readonly SplitwiseAuditRun[]> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  const { runs } = await request<{ runs: SplitwiseAuditRun[] }>(`/api/splitwise/audits${query}`);
  return runs;
}

export async function getSplitwiseAuditRun(id: string): Promise<SplitwiseAuditRunDetail> {
  return request<SplitwiseAuditRunDetail>(`/api/splitwise/audits/${id}`);
}

export interface AuditFindingFilter {
  readonly reviewStatus?: SplitwiseAuditReviewStatus;
  readonly findingClass?: string;
  readonly personId?: string;
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

export async function listSplitwiseAuditFindings(
  filter: AuditFindingFilter = {},
): Promise<readonly SplitwiseAuditFinding[]> {
  const params = new URLSearchParams();
  if (filter.reviewStatus !== undefined) params.set("reviewStatus", filter.reviewStatus);
  if (filter.findingClass !== undefined) params.set("findingClass", filter.findingClass);
  if (filter.personId !== undefined) params.set("personId", filter.personId);
  if (filter.includeSuperseded !== undefined) {
    params.set("includeSuperseded", String(filter.includeSuperseded));
  }
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const query = params.toString();
  const { findings } = await request<{ findings: SplitwiseAuditFinding[] }>(
    `/api/splitwise/audit-findings${query.length > 0 ? `?${query}` : ""}`,
  );
  return findings;
}

export async function getSplitwiseAuditFinding(id: string): Promise<SplitwiseAuditFindingDetail> {
  return request<SplitwiseAuditFindingDetail>(`/api/splitwise/audit-findings/${id}`);
}

/** Runs a fresh comparison. Reads Splitwise; never writes to it. */
export async function runSplitwiseAudit(): Promise<RunSplitwiseAuditResult> {
  return request<RunSplitwiseAuditResult>("/api/splitwise/audits", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR }),
  });
}

/**
 * Records what a person concluded about one finding.
 *
 * Authorizes no write to Splitwise — re-syncing a `stale` row is separate, explicitly approved
 * work that is deliberately not reachable from this surface (ADR-0046).
 */
export async function reviewSplitwiseAuditFinding(input: {
  readonly findingId: string;
  readonly decision: SplitwiseAuditReviewDecision;
  readonly reason?: string;
}): Promise<unknown> {
  return request(`/api/splitwise/audit-findings/${input.findingId}/review`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      decision: input.decision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/* ------------------------------------------------------------------------ proof packs */

/** A read. Generating a pack sends nothing, records no settlement, and writes no row. */
export async function getProofPack(
  recipientPersonId: string,
  asOf?: string,
): Promise<ProofPackPreview> {
  const query = asOf === undefined ? "" : `?asOf=${encodeURIComponent(asOf)}`;
  return request<ProofPackPreview>(`/api/proof-packs/${recipientPersonId}${query}`);
}

/**
 * Whether a reviewed pack can be sent from this installation, and by what (ADR-0053).
 *
 * A read of configuration, not of the ledger. The screen calls it before offering to send so
 * that "no transport is configured here" is stated up front rather than discovered by failing.
 */
export async function getMessagingStatus(): Promise<MessagingStatus> {
  return request<MessagingStatus>("/api/messaging/status");
}

export interface SendProofPackInput {
  readonly recipientPersonId: string;
  readonly channel: string;
  readonly address: string;
  readonly asOf: string;
  readonly review: {
    readonly recipientConfirmed: boolean;
    readonly contentConfirmed: boolean;
    readonly evidenceConfirmed: boolean;
  };
  readonly attachEvidenceIds?: readonly string[];
  /**
   * The digest of the text that was actually reviewed.
   *
   * Sent so the server can refuse a pack that moved between being read and being sent. It is
   * computed over the exact string the API returned — not a figure this app derived.
   */
  readonly contentDigestSeen?: string;
  readonly reason?: string;
}

/**
 * Sends one reviewed proof pack.
 *
 * Note what is **not** in the body: the message. It is derived server-side from the ledger at
 * the moment of sending, so nothing in this app can put a figure in front of another person
 * (ADR-0048).
 */
export async function sendProofPack(input: SendProofPackInput): Promise<SendProofPackResult> {
  const { recipientPersonId, ...body } = input;
  return request<SendProofPackResult>(`/api/proof-packs/${recipientPersonId}/deliveries`, {
    method: "POST",
    body: JSON.stringify({ actor: "user", ...body }),
  });
}

export async function listProofPackDeliveries(
  recipientPersonId?: string,
): Promise<readonly ProofPackDelivery[]> {
  const path =
    recipientPersonId === undefined
      ? "/api/deliveries"
      : `/api/proof-packs/${recipientPersonId}/deliveries`;
  const result = await request<{ readonly deliveries: readonly ProofPackDelivery[] }>(path);
  return result.deliveries;
}

export async function retryProofPackDelivery(input: {
  readonly deliveryId: string;
  readonly reason?: string;
}): Promise<SendProofPackResult> {
  return request<SendProofPackResult>(`/api/deliveries/${input.deliveryId}/retry`, {
    method: "POST",
    body: JSON.stringify({
      actor: "user",
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/* ------------------------------------------------------------- live balance providers */

/** Configuration, not ledger state: whether a live balance can be read here at all. */
export async function getBalanceProviderStatus(): Promise<BalanceProviderStatus> {
  return request<BalanceProviderStatus>("/api/balance-provider/status");
}

export async function listBalanceProviderLinks(): Promise<readonly AccountProviderLink[]> {
  const result = await request<{ readonly links: readonly AccountProviderLink[] }>(
    "/api/balance-provider/links",
  );
  return result.links;
}

export async function linkAccountToBalanceProvider(input: {
  readonly accountId: string;
  readonly externalAccountRef: string;
  readonly providerLabel?: string;
  readonly reason?: string;
}): Promise<AccountProviderLink> {
  return request<AccountProviderLink>("/api/balance-provider/links", {
    method: "POST",
    body: JSON.stringify({ actor: "user", ...input }),
  });
}

export async function unlinkAccountFromBalanceProvider(input: {
  readonly linkId: string;
  readonly reason?: string;
}): Promise<void> {
  await request<{ unlinked: boolean }>(`/api/balance-provider/links/${input.linkId}/unlink`, {
    method: "POST",
    body: JSON.stringify({
      actor: "user",
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/** Reads every linked account now, and records what came back — including the silences. */
export async function refreshBalances(
  input: { readonly reason?: string } = {},
): Promise<RefreshBalancesResult> {
  return request<RefreshBalancesResult>("/api/balance-provider/refresh", {
    method: "POST",
    body: JSON.stringify({ actor: "user", ...input }),
  });
}

/** Each account's latest reading beside the closing balance a run evidenced. */
export async function getBalanceComparison(runId: string): Promise<BalanceComparisonResult> {
  return request<BalanceComparisonResult>(
    `/api/balance-provider/comparison?runId=${encodeURIComponent(runId)}`,
  );
}

export async function listAccountBalanceReadings(
  accountId: string,
): Promise<readonly AccountBalanceReading[]> {
  const result = await request<{ readonly readings: readonly AccountBalanceReading[] }>(
    `/api/accounts/${accountId}/balance-readings`,
  );
  return result.readings;
}

/* --------------------------------------------------------------- the payment workspace */

export interface ListPaymentsFilter {
  readonly accountId?: string;
  readonly importBatchId?: string;
  readonly direction?: PaymentDirection;
  readonly state?: PaymentState;
  readonly cashFlowState?: CashFlowState;
  readonly cashFlowCategory?: CashFlowCategory;
  readonly counterpartyType?: PaymentCounterpartyType;
  readonly search?: string;
  readonly from?: string;
  readonly to?: string;
  /** The "payments with no explanation" list the review queue never was (audit row 36). */
  readonly onlyUnexplained?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export async function listPayments(filter: ListPaymentsFilter = {}): Promise<PaymentListResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === "" || value === false) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return request<PaymentListResult>(`/api/payments${query.length > 0 ? `?${query}` : ""}`);
}

export async function getPayment(paymentId: string): Promise<PaymentWorkspaceItem> {
  return request<PaymentWorkspaceItem>(`/api/payments/${paymentId}`);
}

export async function getCounterpartyOptions(): Promise<CounterpartyOptions> {
  return request<CounterpartyOptions>("/api/payments/counterparty-options");
}

/**
 * Records a movement nobody exported — cash handed over, a transfer no statement shows yet.
 *
 * `amount` is a magnitude in paise; which way the money went is `direction`, never a sign.
 */
export async function recordManualPayment(input: {
  readonly accountId: string;
  readonly amount: string;
  readonly direction: PaymentDirection;
  readonly occurredAt: string;
  readonly description: string;
  readonly channel?: PaymentChannel;
  readonly externalReference?: string;
  readonly referenceType?: PaymentReferenceType;
}): Promise<{ readonly paymentId: string; readonly importBatchId: string }> {
  return request("/api/payments", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

export async function setPaymentCounterparty(input: {
  readonly paymentId: string;
  readonly counterpartyType: PaymentCounterpartyType;
  readonly counterpartyId?: string;
  readonly reason?: string;
}): Promise<unknown> {
  const { paymentId, ...rest } = input;
  return request(`/api/payments/${paymentId}/counterparty`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(rest) }),
  });
}

/** Deterministic, idempotent-by-state: acts on `imported` payments only, and guesses nothing. */
export async function normalizePayments(importBatchId?: string): Promise<NormalizePaymentsResult> {
  return request<NormalizePaymentsResult>("/api/payments/normalize", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact({ importBatchId }) }),
  });
}

/** Asks the model what each normalized payment was. Every answer is a proposal, never state. */
export async function classifyPayments(importBatchId?: string): Promise<ClassifyPaymentsResult> {
  return request<ClassifyPaymentsResult>("/api/payments/classify", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact({ importBatchId }) }),
  });
}

/**
 * One step of ADR-0017's cash-flow lifecycle per call.
 *
 * Four steps rather than one PATCH, because each is a different decision with a different
 * consequence — and lumping them together is how "approved" becomes a side effect of
 * "classified". `reject` requires a reason; the API refuses without one.
 */
export async function decidePaymentCashFlow(input: {
  readonly paymentId: string;
  readonly step: "normalize" | "classify" | "approve" | "reject";
  readonly category?: CashFlowCategory;
  readonly counterLegPaymentId?: string;
  readonly reason?: string;
}): Promise<CashFlowDecisionResult> {
  const { paymentId, step, ...rest } = input;
  return request<CashFlowDecisionResult>(`/api/payments/${paymentId}/cash-flow/${step}`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(rest) }),
  });
}

/* ----------------------------------------------------------------- statement imports */

/**
 * All-or-nothing: a file with any unreadable row imports nothing and names every bad row,
 * because a partially imported statement leaves the ledger quietly missing movements.
 */
export async function importBankCsv(input: {
  readonly accountId: string;
  readonly sourceSystem: string;
  readonly fileContent: string;
  readonly fileReference?: string;
}): Promise<ImportStatementResult> {
  return request<ImportStatementResult>("/api/imports/bank-csv", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

export async function listImports(options: {
  readonly limit?: number;
  readonly offset?: number;
}): Promise<ImportHistoryResult> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  return request<ImportHistoryResult>(`/api/imports${query.length > 0 ? `?${query}` : ""}`);
}

/* ---------------------------------------------------------------------- master data */

export async function listPeopleForManagement(): Promise<readonly PersonDetail[]> {
  const { people } = await request<{ people: PersonDetail[] }>("/api/people/manage");
  return people;
}

export async function createPerson(input: {
  readonly displayName: string;
  readonly splitwiseUserId?: string;
  readonly notes?: string;
}): Promise<{ readonly person: PersonDetail }> {
  return request("/api/people", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

/**
 * `null` and absent mean different things here, deliberately: a present `null` clears the
 * field (unmapping someone from Splitwise), an absent one leaves it alone. `compact` would
 * erase that distinction, so this one builds its body explicitly.
 */
export async function updatePerson(input: {
  readonly personId: string;
  readonly displayName?: string;
  readonly splitwiseUserId?: string | null;
  readonly notes?: string | null;
  readonly archived?: boolean;
}): Promise<{ readonly person: PersonDetail }> {
  const { personId, ...rest } = input;
  return request(`/api/people/${personId}`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    }),
  });
}

export async function createAccount(input: {
  readonly name: string;
  readonly type: AccountType;
  readonly institution?: string;
  readonly last4?: string;
  readonly currency?: string;
}): Promise<{ readonly accountId: string }> {
  return request("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

export async function updateAccount(input: {
  readonly accountId: string;
  readonly name?: string;
  readonly institution?: string | null;
  readonly isActive?: boolean;
}): Promise<unknown> {
  const { accountId, ...rest } = input;
  return request(`/api/accounts/${accountId}`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    }),
  });
}

export async function listMerchants(): Promise<readonly MerchantDetail[]> {
  const { merchants } = await request<{ merchants: MerchantDetail[] }>("/api/merchants");
  return merchants;
}

export async function createMerchant(input: {
  readonly canonicalName: string;
  readonly defaultCategory?: string;
  readonly aliases?: readonly string[];
}): Promise<{ readonly merchantId: string }> {
  return request("/api/merchants", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

/** Teaches normalization one more narration. Matching is exact, so this is the whole fix. */
export async function addMerchantAlias(input: {
  readonly merchantId: string;
  readonly rawPattern: string;
}): Promise<unknown> {
  return request(`/api/merchants/${input.merchantId}/aliases`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, rawPattern: input.rawPattern }),
  });
}

export async function updateMerchant(input: {
  readonly merchantId: string;
  readonly canonicalName?: string;
  readonly defaultCategory?: string | null;
  readonly archived?: boolean;
}): Promise<unknown> {
  const { merchantId, ...rest } = input;
  return request(`/api/merchants/${merchantId}`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    }),
  });
}

export async function listGroups(): Promise<readonly GroupDetail[]> {
  const { groups } = await request<{ groups: GroupDetail[] }>("/api/groups");
  return groups;
}

export async function createGroup(input: {
  readonly name: string;
  readonly type?: string;
  readonly members?: readonly string[];
  readonly joinedAt?: string;
}): Promise<{ readonly groupId: string }> {
  return request("/api/groups", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

export async function updateGroup(input: {
  readonly groupId: string;
  readonly name?: string;
  readonly archived?: boolean;
}): Promise<unknown> {
  const { groupId, ...rest } = input;
  return request(`/api/groups/${groupId}`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    }),
  });
}

/**
 * Starts a membership stint, dated.
 *
 * The date is the point: `domain.expandGroupAllocationLine` counts who was a member **as of an
 * expense's date** (ADR-0009), so joining a group does not retroactively put someone into last
 * month's dinner.
 */
export async function addGroupMember(input: {
  readonly groupId: string;
  readonly personId: string;
  readonly joinedAt: string;
}): Promise<{ readonly membershipId: string }> {
  const { groupId, ...rest } = input;
  return request(`/api/groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...rest }),
  });
}

export async function endGroupMembership(input: {
  readonly membershipId: string;
  readonly leftAt: string | null;
}): Promise<unknown> {
  return request(`/api/group-memberships/${input.membershipId}/end`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, leftAt: input.leftAt }),
  });
}

/** Drops `undefined` and empty strings from a request body — an omitted field, not a blank one. */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== ""),
  );
}

/* --------------------------------------------------------------- authoring an expense */

/**
 * Records an expense a person entered.
 *
 * Omitting `funding` is how "somebody else paid" is expressed: this ledger then has no payment
 * for the expense and must never fabricate one (ADR-0006), so `evidenceId` carries the trail
 * back to what happened instead.
 */
export async function createExpense(input: {
  readonly description: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly relationshipType: ExpenseRelationshipType;
  readonly paidByPersonId: string;
  readonly category?: string;
  readonly evidenceId?: string;
  readonly funding?: readonly { readonly paymentId: string; readonly amount: string }[];
  readonly state?: "proposed" | "approved";
  readonly reason?: string;
}): Promise<CreateExpenseResult> {
  const { funding, ...rest } = input;
  return request<CreateExpenseResult>("/api/expenses", {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...compact(rest),
      ...(funding === undefined || funding.length === 0 ? {} : { funding }),
    }),
  });
}

export async function getExpenseFunding(expenseId: string): Promise<readonly ExpenseFundingLink[]> {
  const { links } = await request<{ links: ExpenseFundingLink[] }>(
    `/api/expenses/${expenseId}/payment-links`,
  );
  return links;
}

/** One payment across several expenses, or several payments onto one — both are repeated calls. */
export async function linkPaymentToExpense(input: {
  readonly expenseId: string;
  readonly paymentId: string;
  readonly amount: string;
  readonly reason?: string;
}): Promise<{ readonly linkId: string }> {
  const { expenseId, ...rest } = input;
  return request(`/api/expenses/${expenseId}/payment-links`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(rest) }),
  });
}

export interface ExpenseItemDraft {
  readonly description: string;
  readonly amount: string;
  readonly quantity?: string;
}

/** The complete breakdown, which must sum to the expense's gross amount. */
export async function recordExpenseItems(input: {
  readonly expenseId: string;
  readonly items: readonly ExpenseItemDraft[];
  readonly reason?: string;
}): Promise<{ readonly items: readonly ExpenseItemRecord[] }> {
  return request(`/api/expenses/${input.expenseId}/items`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      items: input.items,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/**
 * Replaces a wrong breakdown. The gross total cannot move — a correction that changes what the
 * purchase cost is an adjustment, not this — and the reason is required, because a correction
 * with no account of it is an edit.
 */
export async function correctExpenseItems(input: {
  readonly expenseId: string;
  readonly items: readonly ExpenseItemDraft[];
  readonly reason: string;
}): Promise<{
  readonly items: readonly ExpenseItemRecord[];
  readonly supersededItemIds: readonly string[];
}> {
  return request(`/api/expenses/${input.expenseId}/items/correct`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, items: input.items, reason: input.reason }),
  });
}

/* ---------------------------------------------------------------------- allocation */

/**
 * The six methods, each with the shape the API validates for it.
 *
 * `web/` names beneficiaries and states inputs; every amount that results from a division —
 * an equal split, a percentage, a group expansion, a shared item's units — is the domain's,
 * computed by the Largest Remainder Method it owns (ADR-0048, `invariants.md` #12).
 */
export type AllocationDecisionInput =
  | { readonly method: "equal"; readonly beneficiaries: readonly BeneficiaryRef[] }
  | {
      readonly method: "exact" | "custom";
      readonly lines: readonly { readonly beneficiary: BeneficiaryRef; readonly amount: string }[];
    }
  | {
      readonly method: "percentage";
      readonly lines: readonly {
        readonly beneficiary: BeneficiaryRef;
        readonly percentage: string;
      }[];
    }
  | {
      readonly method: "item_based" | "quantity_based";
      readonly lines: readonly {
        readonly beneficiary: BeneficiaryRef;
        readonly expenseItemId: string;
        readonly amount?: string;
        readonly units?: string;
      }[];
    };

export async function approveAllocation(input: {
  readonly expenseId: string;
  readonly decision: AllocationDecisionInput;
  readonly reason?: string;
  readonly groupShareOverrides?: readonly {
    readonly groupId: string;
    readonly weights: readonly { readonly personId: string; readonly weight: string }[];
  }[];
}): Promise<unknown> {
  return request(`/api/expenses/${input.expenseId}/allocation`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...input.decision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.groupShareOverrides === undefined
        ? {}
        : { groupShareOverrides: input.groupShareOverrides }),
    }),
  });
}

/* --------------------------------------------------------------------- settlements */

/** Discharges a debt; never creates one. A settlement has no allocation, ever. */
export async function recordSettlement(input: {
  readonly paymentId: string;
  readonly counterpartyPersonId: string;
  readonly amount: string;
  readonly reason?: string;
}): Promise<{ readonly settlementId: string }> {
  const { paymentId, ...rest } = input;
  return request(`/api/payments/${paymentId}/settlements`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(rest) }),
  });
}

export async function listSettlements(
  options: {
    readonly counterpartyPersonId?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<SettlementRegisterResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return request<SettlementRegisterResult>(
    `/api/settlements${query.length > 0 ? `?${query}` : ""}`,
  );
}

/* ------------------------------------------------------------------------- history */

export async function getExpenseHistory(expenseId: string): Promise<ExpenseHistoryResult> {
  return request<ExpenseHistoryResult>(`/api/expenses/${expenseId}/history`);
}

/* --------------------------------------------------------------------- evidence library */

export interface EvidenceLibraryFilter {
  readonly type?: EvidenceType;
  readonly noteKind?: EvidenceNoteKind;
  /** `linked` — attached to something; `unlinked` — attached to nothing yet. */
  readonly linkage?: "linked" | "unlinked";
  readonly linkedPaymentId?: string;
  readonly linkedExpenseId?: string;
  readonly search?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export async function listEvidence(
  filter: EvidenceLibraryFilter = {},
): Promise<EvidenceLibraryResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return request<EvidenceLibraryResult>(`/api/evidence${query.length > 0 ? `?${query}` : ""}`);
}

/** A note is evidence of a belief, never a payment and never an authoritative settlement. */
export async function recordEvidenceNote(input: {
  readonly text: string;
  readonly noteKind: EvidenceNoteKind;
  readonly capturedAt: string;
  readonly linkedPaymentId?: string;
  readonly linkedExpenseId?: string;
  readonly reason?: string;
}): Promise<{ readonly evidenceId: string }> {
  return request("/api/evidence/notes", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

/** The immutable source text of a bank SMS or UPI push, plus whatever was read off it. */
export async function recordEvidenceNotification(input: {
  readonly type: NotificationEvidenceType;
  readonly text: string;
  readonly capturedAt: string;
  readonly linkedPaymentId?: string;
  readonly reason?: string;
}): Promise<{ readonly outcome: string; readonly evidenceId: string }> {
  return request("/api/evidence/notifications", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

/**
 * Uploads a document.
 *
 * Multipart rather than JSON, and the only request in this package that is: the file is bytes,
 * and base64-ing it through a JSON body to keep one parser would double its size for nothing.
 */
export async function uploadEvidenceFile(input: {
  readonly file: File;
  readonly type: EvidenceType;
  readonly capturedAt: string;
  readonly linkedPaymentId?: string;
  readonly linkedExpenseId?: string;
  readonly reason?: string;
}): Promise<{ readonly evidenceId: string }> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("type", input.type);
  form.set("capturedAt", input.capturedAt);
  form.set("actor", ACTOR);
  if (input.linkedPaymentId !== undefined) form.set("linkedPaymentId", input.linkedPaymentId);
  if (input.linkedExpenseId !== undefined) form.set("linkedExpenseId", input.linkedExpenseId);
  if (input.reason !== undefined) form.set("reason", input.reason);
  // `request` sets a JSON content type; a multipart body must let the browser set its own
  // boundary, so this one call goes direct.
  return requestMultipart(`/api/evidence/files`, form);
}

/**
 * Records or corrects the structured reading of a document.
 *
 * It replaces the reading, never the document: the `Evidence` row is source and stays exactly
 * as it arrived (`invariants.md` #2). A field sent as `null` is cleared; an absent field is
 * left alone.
 */
export async function recordEvidenceObservation(input: {
  readonly evidenceId: string;
  readonly observedAmount?: string | null;
  readonly observedDirection?: PaymentDirection | null;
  readonly observedReference?: string | null;
  readonly observedReferenceType?: PaymentReferenceType | null;
  readonly observedMerchantText?: string | null;
  readonly observedOccurredAt?: string | null;
  readonly reason?: string;
}): Promise<unknown> {
  const { evidenceId, ...rest } = input;
  return request(`/api/evidence/${evidenceId}/observation`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    }),
  });
}

/** Attaches a document to what it is evidence of. Write-once: a wrong link cannot be repointed. */
export async function linkEvidence(input: {
  readonly evidenceId: string;
  readonly linkedPaymentId?: string;
  readonly linkedExpenseId?: string;
  readonly reason?: string;
}): Promise<EvidenceRecord> {
  const { evidenceId, ...rest } = input;
  return request<EvidenceRecord>(`/api/evidence/${evidenceId}/link`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(rest) }),
  });
}

/* ------------------------------------------------------------------------- receipts */

export async function confirmReceipt(input: {
  readonly receiptId: string;
  readonly reason?: string;
}): Promise<ReceiptView> {
  return request<ReceiptView>(`/api/receipts/${input.receiptId}/confirm`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/**
 * Overwrites what extraction read.
 *
 * Each money field is `null` to clear it, an exact paise string to set it, or absent to leave
 * it as extraction left it — three distinct meanings, so this body is built explicitly rather
 * than through `compact`.
 */
export async function correctReceipt(input: {
  readonly receiptId: string;
  readonly subtotal?: string | null;
  readonly tax?: string | null;
  readonly total?: string | null;
  readonly items?: readonly {
    readonly description: string;
    readonly quantity?: string;
    readonly unitPrice?: string;
    readonly lineTotal: string;
  }[];
  readonly reason?: string;
}): Promise<ReceiptView> {
  const { receiptId, ...rest } = input;
  return request<ReceiptView>(`/api/receipts/${receiptId}/correct`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    }),
  });
}

async function requestMultipart<T>(path: string, form: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      body: form,
      credentials: "include",
    });
  } catch {
    throw new ApiError(0, {
      error: {
        code: "NETWORK_ERROR",
        message: "Couldn't reach the API. Check that src/server.ts is running (see web/README.md).",
      },
    });
  }
  if (!response.ok) {
    const body = (await response.json().catch(
      () =>
        ({
          error: { code: "UNKNOWN_ERROR", message: `Request failed with ${response.status}.` },
        }) satisfies ApiErrorBody,
    )) as ApiErrorBody;
    throw new ApiError(response.status, body);
  }
  return (await response.json()) as T;
}

/* ---------------------------------------------------------------------------- session */

/** Never 401s: "nobody is signed in" is the answer to this question. */
export async function getSession(): Promise<SessionState> {
  return request<SessionState>("/api/session");
}

export async function signIn(input: {
  readonly email: string;
  readonly password: string;
}): Promise<{ readonly session: SessionIdentity }> {
  return request("/api/session", { method: "POST", body: JSON.stringify(input) });
}

export async function signOut(): Promise<unknown> {
  return request("/api/session/end", { method: "POST", body: JSON.stringify({}) });
}

/**
 * Sets the ledger user's password.
 *
 * On a fresh installation this is the first-run step and needs no current password — there is
 * nobody to authenticate as yet. Once one exists, changing it requires being signed in, and the
 * session is the proof.
 */
export async function setPassword(input: { readonly password: string }): Promise<unknown> {
  return request("/api/session/password", { method: "POST", body: JSON.stringify(input) });
}

/* --------------------------------------------------------------------- Splitwise sync */

/**
 * Connects the integration record Splitwise work reads its configuration from.
 *
 * No actor: an `ExternalIntegration` is configuration, not an approved financial decision, and
 * carries no audit event of its own.
 */
export async function connectSplitwise(input: {
  readonly externalAccountRef?: string;
}): Promise<unknown> {
  return request("/api/integrations/splitwise/connect", {
    method: "POST",
    body: JSON.stringify(compact(input)),
  });
}

/** `allocated → ready_to_sync`. A lifecycle step, not a push. */
export async function markExpenseReadyToSync(input: {
  readonly expenseId: string;
  readonly reason?: string;
}): Promise<unknown> {
  return request(`/api/expenses/${input.expenseId}/ready-to-sync`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/** Pushes this ledger's split into Splitwise, once. */
export async function syncExpenseToSplitwise(input: {
  readonly expenseId: string;
  readonly reason?: string;
}): Promise<unknown> {
  return request(`/api/expenses/${input.expenseId}/splitwise-sync`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

export async function listResyncCandidates(): Promise<readonly ResyncCandidate[]> {
  const { candidates } = await request<{ candidates: ResyncCandidate[] }>(
    "/api/splitwise/resync-candidates",
  );
  return candidates;
}

/**
 * Corrects a stale row in Splitwise with this ledger's current figure.
 *
 * The reason is required by the API, not by this form: it changes a figure in somebody else's
 * ledger, and they are entitled to an account of why.
 */
export async function resyncExpenseToSplitwise(input: {
  readonly expenseId: string;
  readonly reason: string;
}): Promise<ResyncResult> {
  return request<ResyncResult>(`/api/expenses/${input.expenseId}/splitwise-resync`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, reason: input.reason }),
  });
}

/* -------------------------------------------------------------------------- analytics */

/** Every analytics read takes the same period, and the API refuses one that runs backwards. */
export interface AnalyticsRange {
  readonly from: string;
  readonly to: string;
}

function periodQuery(range: AnalyticsRange): string {
  return `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

export async function getCategorySpend(range: AnalyticsRange): Promise<CategorySpendResult> {
  return request<CategorySpendResult>(`/api/analytics/spending${periodQuery(range)}`);
}

export async function getMonthlySpend(range: AnalyticsRange): Promise<MonthlySpendResult> {
  return request<MonthlySpendResult>(`/api/analytics/monthly${periodQuery(range)}`);
}

export async function getOwnSpend(range: AnalyticsRange): Promise<OwnSpendResult> {
  return request<OwnSpendResult>(`/api/analytics/own-spend${periodQuery(range)}`);
}

export async function getOutstanding(): Promise<OutstandingResult> {
  return request<OutstandingResult>("/api/analytics/outstanding");
}

export async function getUnsettled(): Promise<UnsettledResult> {
  return request<UnsettledResult>("/api/analytics/unsettled");
}

/* ------------------------------------------------------------------------------ rules */

export async function listRules(): Promise<readonly RuleView[]> {
  const { rules } = await request<{ rules: RuleView[] }>("/api/rules");
  return rules;
}

/**
 * Writes a standing rule.
 *
 * `effect` is the whole of what makes a rule safe: `propose` records a suggestion for a person,
 * `apply` writes the fact unattended and is attributed to the rule, never to a person
 * (`invariants.md` #17). No rule touches an allocation or an amount.
 */
export async function createRule(input: {
  readonly name: string;
  readonly match: RuleMatchPattern;
  readonly assertion: RuleAssertion;
  readonly effect?: RuleEffect;
  readonly reason?: string;
}): Promise<{ readonly ruleId: string }> {
  return request("/api/rules", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...input }),
  });
}

export async function updateRule(input: {
  readonly ruleId: string;
  readonly active?: boolean;
  readonly archived?: boolean;
  readonly effect?: RuleEffect;
  readonly reason?: string;
}): Promise<unknown> {
  const { ruleId, ...rest } = input;
  return request(`/api/rules/${ruleId}`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    }),
  });
}

/** `dryRun` previews without writing — the only honest way to see what a rule set would do. */
export async function applyRules(input: {
  readonly dryRun?: boolean;
  readonly importBatchId?: string;
  readonly limit?: number;
}): Promise<ApplyRulesResult> {
  return request<ApplyRulesResult>("/api/rules/apply", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

/* -------------------------------------------------------------------------- occasions */

export async function listOccasions(): Promise<readonly OccasionSummary[]> {
  const { occasions } = await request<{ occasions: OccasionSummary[] }>("/api/occasions");
  return occasions;
}

export async function createOccasion(input: {
  readonly name: string;
  readonly occurredStart: string;
  readonly occurredEnd?: string;
}): Promise<{ readonly occasionId: string }> {
  return request("/api/occasions", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...compact(input) }),
  });
}

/** A label that carries no money: filing an expense under an occasion moves no figure. */
export async function assignExpenseToOccasion(input: {
  readonly expenseId: string;
  readonly occasionId: string | null;
}): Promise<unknown> {
  return request(`/api/expenses/${input.expenseId}/occasion`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, occasionId: input.occasionId }),
  });
}

/* ------------------------------------------------------------------------------- jobs */

export async function listJobs(
  filter: {
    readonly status?: JobStatus;
    readonly kind?: JobKind;
    readonly limit?: number;
  } = {},
): Promise<JobListResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return request<JobListResult>(`/api/jobs${query.length > 0 ? `?${query}` : ""}`);
}

export async function retryJob(jobId: string): Promise<unknown> {
  return request(`/api/jobs/${jobId}/retry`, {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR }),
  });
}

export async function cancelJob(input: {
  readonly jobId: string;
  readonly reason?: string;
}): Promise<unknown> {
  return request(`/api/jobs/${input.jobId}/cancel`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/**
 * Asks the model again about a payment whose proposal was declined.
 *
 * A re-run, not an edit. The declined decision stays on the record — a second proposal does
 * not erase the first, and nothing about the re-run approves anything: what comes back is
 * another proposal for the queue (ADR-0030).
 */
export async function reclassifyPayment(input: {
  readonly paymentId: string;
  readonly reason?: string;
}): Promise<unknown> {
  return request(`/api/review/payments/${input.paymentId}/reclassify`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

/** Every decision recorded against one movement, oldest first. */
export async function getPaymentHistory(
  paymentId: string,
): Promise<{ readonly events: readonly AuditTrailEvent[] }> {
  return request(`/api/payments/${paymentId}/history`);
}
