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
  BalanceResult,
  CashFlowCategory,
  CashFlowDecisionResult,
  CashFlowState,
  ClassifyPaymentsResult,
  CounterpartyOptions,
  DecideEvidenceMatchResult,
  EvidenceMatchesResult,
  EvidenceObservationView,
  EvidenceRecord,
  ExpenseAdjustmentKind,
  ExpenseItemRecord,
  ExpenseLedgerRow,
  ExpenseState,
  GroupDetail,
  ImportHistoryResult,
  ImportStatementResult,
  MatchEvidenceContextResult,
  MerchantDetail,
  NormalizePaymentsResult,
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
  ProofPackPreview,
  ReceiptView,
  ReconciliationRun,
  RefundAllocationState,
  ReviewItemKind,
  ReviewQueueResult,
  RunReconciliationResult,
  RunSplitwiseAuditResult,
  SplitwiseAuditFinding,
  SplitwiseAuditFindingDetail,
  SplitwiseAuditReviewDecision,
  SplitwiseAuditReviewStatus,
  SplitwiseAuditRun,
  SplitwiseAuditRunDetail,
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
  readonly limit?: number;
}

export async function listExpenses(
  filter: ListExpensesFilter = {},
): Promise<readonly ExpenseLedgerRow[]> {
  const params = new URLSearchParams();
  if (filter.state !== undefined) params.set("state", filter.state);
  if (filter.paidBy !== undefined) params.set("paidBy", filter.paidBy);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const query = params.toString();
  const { expenses } = await request<{ expenses: ExpenseLedgerRow[] }>(
    `/api/expenses${query.length > 0 ? `?${query}` : ""}`,
  );
  return expenses;
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
      ...(input.itemAttributions === undefined || input.itemAttributions.length === 0
        ? {}
        : { itemAttributions: input.itemAttributions }),
    }),
  });
}

/** Folds every recorded-but-undistributed adjustment into a new `Allocation` version. */
export async function distributeAdjustment(input: {
  readonly expenseId: string;
  readonly reason?: string;
}): Promise<unknown> {
  return request(`/api/expenses/${input.expenseId}/adjustments/distribute`, {
    method: "POST",
    body: JSON.stringify({
      actor: ACTOR,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
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
