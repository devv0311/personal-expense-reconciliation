"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type {
  AnalyticsRange,
  AuditFindingFilter,
  EvidenceLibraryFilter,
  ListExpensesFilter,
  ListPaymentsFilter,
  RecordAdjustmentInput,
  ReviewQueueFilter,
  RunReconciliationInput,
} from "./api";
import type { JobKind, JobStatus, SplitwiseAuditReviewDecision } from "./types";

export const queryKeys = {
  expenses: (filter: ListExpensesFilter) => ["expenses", filter] as const,
  expense: (id: string) => ["expense", id] as const,
  expenseItems: (id: string) => ["expense-items", id] as const,
  refundAllocation: (id: string) => ["refund-allocation", id] as const,
  people: () => ["people"] as const,
  session: () => ["session"] as const,
  accounts: () => ["accounts"] as const,
  balance: (a: string, b: string) => ["balance", a, b] as const,
  reconciliationRuns: (limit?: number) => ["reconciliation-runs", limit ?? null] as const,
  reconciliationRun: (id: string) => ["reconciliation-run", id] as const,
  accountSnapshots: (id: string) => ["account-snapshots", id] as const,
  reviewQueue: (filter: ReviewQueueFilter) => ["review-queue", filter] as const,
  evidence: (id: string) => ["evidence", id] as const,
  evidenceLibrary: (filter: EvidenceLibraryFilter) => ["evidence-library", filter] as const,
  evidenceMatches: (id: string) => ["evidence-matches", id] as const,
  evidenceObservation: (id: string) => ["evidence-observation", id] as const,
  receipt: (id: string) => ["receipt", id] as const,
  paymentContext: (id: string) => ["payment-context", id] as const,
  splitwiseAuditRuns: (limit?: number) => ["splitwise-audit-runs", limit ?? null] as const,
  resyncCandidates: () => ["resync-candidates"] as const,
  categorySpend: (range: AnalyticsRange) => ["analytics", "spending", range] as const,
  monthlySpend: (range: AnalyticsRange) => ["analytics", "monthly", range] as const,
  ownSpend: (range: AnalyticsRange) => ["analytics", "own-spend", range] as const,
  outstanding: () => ["analytics", "outstanding"] as const,
  unsettled: () => ["analytics", "unsettled"] as const,
  rules: () => ["rules"] as const,
  occasions: () => ["occasions"] as const,
  jobs: (filter: { status?: JobStatus; kind?: JobKind }) => ["jobs", filter] as const,
  splitwiseAuditRun: (id: string) => ["splitwise-audit-run", id] as const,
  splitwiseAuditFindings: (filter: AuditFindingFilter) =>
    ["splitwise-audit-findings", filter] as const,
  splitwiseAuditFinding: (id: string) => ["splitwise-audit-finding", id] as const,
  proofPack: (recipientPersonId: string) => ["proof-pack", recipientPersonId] as const,
  messagingStatus: () => ["messaging-status"] as const,
  balanceProviderStatus: () => ["balance-provider-status"] as const,
  balanceProviderLinks: () => ["balance-provider-links"] as const,
  balanceComparison: (runId: string) => ["balance-comparison", runId] as const,
  deliveries: (recipientPersonId?: string) => ["deliveries", recipientPersonId ?? null] as const,
  payments: (filter: ListPaymentsFilter) => ["payments", filter] as const,
  payment: (id: string) => ["payment", id] as const,
  counterpartyOptions: () => ["counterparty-options"] as const,
  imports: (limit?: number, offset?: number) => ["imports", limit ?? null, offset ?? null] as const,
  peopleManagement: () => ["people-management"] as const,
  expenseFunding: (id: string) => ["expense-funding", id] as const,
  expenseHistory: (id: string) => ["expense-history", id] as const,
  paymentHistory: (id: string) => ["payment-history", id] as const,
  settlements: (counterpartyPersonId?: string) =>
    ["settlements", counterpartyPersonId ?? null] as const,
  merchants: () => ["merchants"] as const,
  groups: () => ["groups"] as const,
};

/* ------------------------------------------------------------------------------ reads */

export function useExpenses(filter: ListExpensesFilter) {
  return useQuery({
    queryKey: queryKeys.expenses(filter),
    queryFn: () => api.listExpenses(filter),
  });
}

export function useExpense(id: string) {
  return useQuery({ queryKey: queryKeys.expense(id), queryFn: () => api.getExpense(id) });
}

export function useExpenseItems(id: string) {
  return useQuery({
    queryKey: queryKeys.expenseItems(id),
    queryFn: () => api.getExpenseItems(id),
  });
}

export function useRefundAllocation(id: string) {
  return useQuery({
    queryKey: queryKeys.refundAllocation(id),
    queryFn: () => api.getRefundAllocation(id),
  });
}

export function usePeople() {
  return useQuery({ queryKey: queryKeys.people(), queryFn: api.listPeople });
}

export function useAccounts() {
  return useQuery({ queryKey: queryKeys.accounts(), queryFn: api.listAccounts });
}

export function useBalance(personAId: string | null, personBId: string | null) {
  return useQuery({
    queryKey: queryKeys.balance(personAId ?? "", personBId ?? ""),
    queryFn: () => api.getBalance(personAId as string, personBId as string),
    enabled: personAId !== null && personBId !== null && personAId !== personBId,
  });
}

export function useReconciliationRuns(limit?: number) {
  return useQuery({
    queryKey: queryKeys.reconciliationRuns(limit),
    queryFn: () => api.listReconciliationRuns(limit),
  });
}

export function useReconciliationRun(id: string) {
  return useQuery({
    queryKey: queryKeys.reconciliationRun(id),
    queryFn: () => api.getReconciliationRun(id),
  });
}

export function useAccountSnapshots(id: string) {
  return useQuery({
    queryKey: queryKeys.accountSnapshots(id),
    queryFn: () => api.getReconciliationAccountSnapshots(id),
  });
}

export function useReviewQueue(filter: ReviewQueueFilter) {
  return useQuery({
    queryKey: queryKeys.reviewQueue(filter),
    queryFn: () => api.getReviewQueue(filter),
  });
}

export function useEvidence(id: string) {
  return useQuery({ queryKey: queryKeys.evidence(id), queryFn: () => api.getEvidence(id) });
}

export function useEvidenceMatches(id: string) {
  return useQuery({
    queryKey: queryKeys.evidenceMatches(id),
    queryFn: () => api.getEvidenceMatches(id),
  });
}

export function useEvidenceObservation(id: string) {
  return useQuery({
    queryKey: queryKeys.evidenceObservation(id),
    queryFn: () => api.getEvidenceObservation(id),
  });
}

export function useReceipt(receiptId: string | null) {
  return useQuery({
    queryKey: queryKeys.receipt(receiptId ?? ""),
    queryFn: () => api.getReceipt(receiptId as string),
    enabled: receiptId !== null,
  });
}

export function usePaymentContext(paymentId: string) {
  return useQuery({
    queryKey: queryKeys.paymentContext(paymentId),
    queryFn: () => api.getPaymentContext(paymentId),
  });
}

export function useSplitwiseAuditRuns(limit?: number) {
  return useQuery({
    queryKey: queryKeys.splitwiseAuditRuns(limit),
    queryFn: () => api.listSplitwiseAuditRuns(limit),
  });
}

export function useSplitwiseAuditRun(id: string) {
  return useQuery({
    queryKey: queryKeys.splitwiseAuditRun(id),
    queryFn: () => api.getSplitwiseAuditRun(id),
  });
}

export function useSplitwiseAuditFindings(filter: AuditFindingFilter) {
  return useQuery({
    queryKey: queryKeys.splitwiseAuditFindings(filter),
    queryFn: () => api.listSplitwiseAuditFindings(filter),
  });
}

export function useSplitwiseAuditFinding(id: string) {
  return useQuery({
    queryKey: queryKeys.splitwiseAuditFinding(id),
    queryFn: () => api.getSplitwiseAuditFinding(id),
  });
}

/**
 * The recipient-specific proof pack.
 *
 * `staleTime: 0` deliberately, unlike every other read: a pack is what you are about to show
 * another person, so it is re-derived when the preview is opened rather than served from a
 * cache that predates the last refund or settlement.
 */
export function useProofPack(recipientPersonId: string | null) {
  return useQuery({
    queryKey: queryKeys.proofPack(recipientPersonId ?? ""),
    queryFn: () => api.getProofPack(recipientPersonId as string),
    enabled: recipientPersonId !== null,
    staleTime: 0,
  });
}

/**
 * Whether a reviewed pack can be sent from here, and by what (ADR-0053).
 *
 * Configuration rather than ledger state, so it is cached for the session: an installation
 * does not grow a WhatsApp token between two renders of the same screen.
 */
export function useMessagingStatus() {
  return useQuery({
    queryKey: queryKeys.messagingStatus(),
    queryFn: api.getMessagingStatus,
    staleTime: 5 * 60 * 1000,
  });
}

/** Whether a live balance can be read here at all, and how many accounts are mapped. */
export function useBalanceProviderStatus() {
  return useQuery({
    queryKey: queryKeys.balanceProviderStatus(),
    queryFn: api.getBalanceProviderStatus,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBalanceProviderLinks() {
  return useQuery({
    queryKey: queryKeys.balanceProviderLinks(),
    queryFn: api.listBalanceProviderLinks,
  });
}

/**
 * Each account's latest reading beside a run's evidenced closing balance.
 *
 * `staleTime: 0`, like the proof pack: the point of a live balance is that it is current, and
 * a cached comparison is the one thing this screen must not show.
 */
export function useBalanceComparison(runId: string | null) {
  return useQuery({
    queryKey: queryKeys.balanceComparison(runId ?? ""),
    queryFn: () => api.getBalanceComparison(runId as string),
    enabled: runId !== null,
    staleTime: 0,
  });
}

/** The record of what has been shared, and with whom. */
export function useProofPackDeliveries(recipientPersonId?: string) {
  return useQuery({
    queryKey: queryKeys.deliveries(recipientPersonId),
    queryFn: () => api.listProofPackDeliveries(recipientPersonId),
  });
}

/* -------------------------------------------------------------------------- mutations */

/**
 * Sends one reviewed pack.
 *
 * Invalidates the delivery lists and nothing else — deliberately. Sending a pack changes no
 * balance, no expense and no settlement, so a screen that refreshed the ledger afterwards
 * would suggest it had (ADR-0047).
 */
export function useSendProofPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.sendProofPack,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["deliveries"] });
    },
  });
}

export function useLinkAccountToBalanceProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.linkAccountToBalanceProvider,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["balance-provider-links"] });
      void queryClient.invalidateQueries({ queryKey: ["balance-provider-status"] });
    },
  });
}

export function useUnlinkAccountFromBalanceProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.unlinkAccountFromBalanceProvider,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["balance-provider-links"] });
      void queryClient.invalidateQueries({ queryKey: ["balance-provider-status"] });
    },
  });
}

/**
 * Reads every linked account now.
 *
 * Invalidates the comparison and nothing about the ledger: a refresh records what a provider
 * said and changes no balance, no snapshot and no delta (ADR-0054).
 */
export function useRefreshBalances() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.refreshBalances,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["balance-comparison"] });
      void queryClient.invalidateQueries({ queryKey: ["balance-provider-links"] });
    },
  });
}

export function useRetryProofPackDelivery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.retryProofPackDelivery,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["deliveries"] });
    },
  });
}

export function useRunReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RunReconciliationInput) => api.runReconciliation(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reconciliation-runs"] });
      void queryClient.invalidateQueries({ queryKey: ["splitwise-audit-runs"] });
      void queryClient.invalidateQueries({ queryKey: ["splitwise-audit-findings"] });
    },
  });
}

export function useDecideInference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.decideInference,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

/** Asks the model again. What comes back is a proposal, so the queue is what changes. */
export function useReclassifyPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.reclassifyPayment,
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.payment(input.paymentId) });
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

export function useDecidePaymentDuplicate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.decidePaymentDuplicate,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
  });
}

export function useEnrichEvidence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (evidenceId: string) => api.enrichEvidence(evidenceId),
    onSuccess: (_result, evidenceId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceMatches(evidenceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceObservation(evidenceId) });
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
  });
}

export function useDecideEvidenceMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.decideEvidenceMatch,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.evidenceMatches(result.candidate.evidenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.evidence(result.candidate.evidenceId),
      });
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["payment-context"] });
    },
  });
}

export function useRecordAdjustment(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<RecordAdjustmentInput, "expenseId">) =>
      api.recordAdjustment({ expenseId, ...input }),
    onSuccess: () => invalidateExpense(queryClient, expenseId),
  });
}

export function useDistributeAdjustment(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      input: { readonly reason?: string; readonly customWeights?: readonly string[] } = {},
    ) => api.distributeAdjustment({ expenseId, ...input }),
    onSuccess: () => invalidateExpense(queryClient, expenseId),
  });
}

export function useRunSplitwiseAudit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.runSplitwiseAudit,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["splitwise-audit-runs"] });
      void queryClient.invalidateQueries({ queryKey: ["splitwise-audit-findings"] });
    },
  });
}

export function useReviewAuditFinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly findingId: string;
      readonly decision: SplitwiseAuditReviewDecision;
      readonly reason?: string;
    }) => api.reviewSplitwiseAuditFinding(input),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ["splitwise-audit-findings"] });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.splitwiseAuditFinding(input.findingId),
      });
      // A pack quotes open findings as warnings, so reviewing one changes what it would say.
      void queryClient.invalidateQueries({ queryKey: ["proof-pack"] });
    },
  });
}

/**
 * Everything an expense-level write can change.
 *
 * A refund moves the net amount, the allocation, the pairwise balance it contributes to, and
 * what a proof pack for that pair would say — so all four are invalidated together rather than
 * left to go quietly stale on a screen a person is still reading.
 */
function invalidateExpense(
  queryClient: ReturnType<typeof useQueryClient>,
  expenseId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.expense(expenseId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.expenseItems(expenseId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.refundAllocation(expenseId) });
  void queryClient.invalidateQueries({ queryKey: ["expenses"] });
  void queryClient.invalidateQueries({ queryKey: ["balance"] });
  void queryClient.invalidateQueries({ queryKey: ["proof-pack"] });
}

/* ------------------------------------------------- the payment workspace and its writes */

export function usePayments(filter: ListPaymentsFilter) {
  return useQuery({
    queryKey: queryKeys.payments(filter),
    queryFn: () => api.listPayments(filter),
  });
}

export function usePayment(id: string) {
  return useQuery({ queryKey: queryKeys.payment(id), queryFn: () => api.getPayment(id) });
}

export function useCounterpartyOptions() {
  return useQuery({
    queryKey: queryKeys.counterpartyOptions(),
    queryFn: api.getCounterpartyOptions,
  });
}

export function useImports(options: { limit?: number; offset?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.imports(options.limit, options.offset),
    queryFn: () => api.listImports(options),
  });
}

export function useImportBankCsv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.importBankCsv,
    // A statement lands as payments, so the workspace, the counts and the history all move.
    onSuccess: () => invalidatePayments(queryClient),
  });
}

export function useRecordManualPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.recordManualPayment,
    onSuccess: () => invalidatePayments(queryClient),
  });
}

export function useNormalizePayments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (importBatchId?: string) => api.normalizePayments(importBatchId),
    onSuccess: () => invalidatePayments(queryClient),
  });
}

export function useClassifyPayments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (importBatchId?: string) => api.classifyPayments(importBatchId),
    onSuccess: () => {
      invalidatePayments(queryClient);
      // Every proposal it recorded is a queue item somebody now has to decide.
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

export function useSetPaymentCounterparty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.setPaymentCounterparty,
    onSuccess: (_result, input) => {
      invalidatePayments(queryClient);
      void queryClient.invalidateQueries({ queryKey: queryKeys.payment(input.paymentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.paymentContext(input.paymentId) });
    },
  });
}

export function useDecidePaymentCashFlow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.decidePaymentCashFlow,
    onSuccess: (_result, input) => {
      invalidatePayments(queryClient);
      void queryClient.invalidateQueries({ queryKey: queryKeys.payment(input.paymentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.paymentContext(input.paymentId) });
      // A cash-flow category is an input to every account's cash identity (ADR-0017), so a
      // stored reconciliation run's figures are what this changes next.
      void queryClient.invalidateQueries({ queryKey: ["reconciliation-runs"] });
    },
  });
}

/* ----------------------------------------------------------- master data and its writes */

export function usePeopleManagement() {
  return useQuery({
    queryKey: queryKeys.peopleManagement(),
    queryFn: api.listPeopleForManagement,
  });
}

export function useMerchants() {
  return useQuery({ queryKey: queryKeys.merchants(), queryFn: api.listMerchants });
}

export function useGroups() {
  return useQuery({ queryKey: queryKeys.groups(), queryFn: api.listGroups });
}

export function useCreatePerson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createPerson,
    onSuccess: () => invalidatePeople(queryClient),
  });
}

export function useUpdatePerson() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.updatePerson,
    onSuccess: () => invalidatePeople(queryClient),
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createAccount,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.accounts() }),
  });
}

export function useUpdateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.updateAccount,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.accounts() }),
  });
}

export function useCreateMerchant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createMerchant,
    onSuccess: () => invalidateMerchants(queryClient),
  });
}

export function useUpdateMerchant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.updateMerchant,
    onSuccess: () => invalidateMerchants(queryClient),
  });
}

export function useAddMerchantAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.addMerchantAlias,
    onSuccess: () => invalidateMerchants(queryClient),
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createGroup,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.groups() }),
  });
}

export function useUpdateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.updateGroup,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.groups() }),
  });
}

export function useAddGroupMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.addGroupMember,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.groups() }),
  });
}

export function useEndGroupMembership() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.endGroupMembership,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.groups() }),
  });
}

/** Everything a write against a payment can move: the list, its totals, and the import history. */
function invalidatePayments(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["payments"] });
  void queryClient.invalidateQueries({ queryKey: ["payment"] });
  void queryClient.invalidateQueries({ queryKey: ["imports"] });
}

/** A person's name is rendered from `people` on half the screens in the product. */
function invalidatePeople(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.peopleManagement() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.people() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.counterpartyOptions() });
}

/** An alias changes what the next normalization run resolves, so the workspace goes stale too. */
function invalidateMerchants(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.merchants() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.counterpartyOptions() });
}

/* --------------------------------------------------- authoring: expenses, shares, repayments */

export function useExpenseFunding(expenseId: string) {
  return useQuery({
    queryKey: queryKeys.expenseFunding(expenseId),
    queryFn: () => api.getExpenseFunding(expenseId),
  });
}

export function useExpenseHistory(expenseId: string) {
  return useQuery({
    queryKey: queryKeys.expenseHistory(expenseId),
    queryFn: () => api.getExpenseHistory(expenseId),
  });
}

export function usePaymentHistory(paymentId: string) {
  return useQuery({
    queryKey: queryKeys.paymentHistory(paymentId),
    queryFn: () => api.getPaymentHistory(paymentId),
  });
}

export function useSettlements(counterpartyPersonId?: string) {
  return useQuery({
    queryKey: queryKeys.settlements(counterpartyPersonId),
    queryFn: () =>
      api.listSettlements(counterpartyPersonId === undefined ? {} : { counterpartyPersonId }),
  });
}

export function useCreateExpense() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createExpense,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
      // Funding an expense from a payment is what explains that payment's money.
      invalidatePayments(queryClient);
    },
  });
}

export function useLinkPaymentToExpense(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly paymentId: string;
      readonly amount: string;
      readonly reason?: string;
    }) => api.linkPaymentToExpense({ expenseId, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.expenseFunding(expenseId) });
      invalidateExpense(queryClient, expenseId);
      invalidatePayments(queryClient);
    },
  });
}

export function useRecordExpenseItems(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly items: readonly api.ExpenseItemDraft[];
      readonly reason?: string;
    }) => api.recordExpenseItems({ expenseId, ...input }),
    onSuccess: () => invalidateExpense(queryClient, expenseId),
  });
}

export function useCorrectExpenseItems(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly items: readonly api.ExpenseItemDraft[];
      readonly reason: string;
    }) => api.correctExpenseItems({ expenseId, ...input }),
    onSuccess: () => invalidateExpense(queryClient, expenseId),
  });
}

/**
 * Approving an allocation moves who owes what, so it invalidates the same set a refund does —
 * plus the version history, which has just gained a row.
 */
export function useApproveAllocation(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly decision: api.AllocationDecisionInput;
      readonly reason?: string;
      readonly groupShareOverrides?: readonly {
        readonly groupId: string;
        readonly weights: readonly { readonly personId: string; readonly weight: string }[];
      }[];
    }) => api.approveAllocation({ expenseId, ...input }),
    onSuccess: () => {
      invalidateExpense(queryClient, expenseId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.expenseHistory(expenseId) });
    },
  });
}

export function useRecordSettlement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.recordSettlement,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settlements"] });
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
      void queryClient.invalidateQueries({ queryKey: ["proof-pack"] });
      invalidatePayments(queryClient);
    },
  });
}

/* ---------------------------------------------------- the evidence library and its writes */

export function useEvidenceLibrary(filter: EvidenceLibraryFilter) {
  return useQuery({
    queryKey: queryKeys.evidenceLibrary(filter),
    queryFn: () => api.listEvidence(filter),
  });
}

export function useRecordEvidenceNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.recordEvidenceNote,
    onSuccess: () => invalidateEvidence(queryClient),
  });
}

export function useRecordEvidenceNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.recordEvidenceNotification,
    onSuccess: () => invalidateEvidence(queryClient),
  });
}

export function useUploadEvidenceFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.uploadEvidenceFile,
    onSuccess: () => invalidateEvidence(queryClient),
  });
}

export function useRecordEvidenceObservation(evidenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Parameters<typeof api.recordEvidenceObservation>[0], "evidenceId">) =>
      api.recordEvidenceObservation({ evidenceId, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceObservation(evidenceId) });
      // A corrected reading changes which payments the matcher would offer next.
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceMatches(evidenceId) });
      invalidateEvidence(queryClient);
    },
  });
}

export function useLinkEvidence(evidenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly linkedPaymentId?: string;
      readonly linkedExpenseId?: string;
      readonly reason?: string;
    }) => api.linkEvidence({ evidenceId, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidence(evidenceId) });
      invalidateEvidence(queryClient);
      invalidatePayments(queryClient);
    },
  });
}

export function useConfirmReceipt(receiptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly reason?: string } = {}) =>
      api.confirmReceipt({ receiptId, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.receipt(receiptId) });
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
  });
}

export function useCorrectReceipt(receiptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Parameters<typeof api.correctReceipt>[0], "receiptId">) =>
      api.correctReceipt({ receiptId, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.receipt(receiptId) });
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
  });
}

/** A new or changed document changes the library and the queue that surfaces loose documents. */
function invalidateEvidence(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["evidence-library"] });
  void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
}

/* ---------------------------------------------------------------------------- session */

export function useSession() {
  return useQuery({ queryKey: queryKeys.session(), queryFn: api.getSession });
}

export function useSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.signIn,
    // Everything read while signed out was read as nobody; none of it is this person's view.
    onSuccess: () => void queryClient.invalidateQueries(),
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.signOut,
    onSuccess: () => {
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    },
  });
}

export function useSetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.setPassword,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.session() }),
  });
}

/* --------------------------------------------------------------------- Splitwise sync */

export function useResyncCandidates() {
  return useQuery({
    queryKey: queryKeys.resyncCandidates(),
    queryFn: api.listResyncCandidates,
  });
}

export function useConnectSplitwise() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.connectSplitwise,
    // What an audit can read changes the moment an integration exists.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["splitwise-audit-runs"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.resyncCandidates() });
    },
  });
}

export function useSyncExpenseToSplitwise(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly reason?: string } = {}) =>
      api.syncExpenseToSplitwise({ expenseId, ...input }),
    onSuccess: () => invalidateSplitwise(queryClient, expenseId),
  });
}

export function useMarkExpenseReadyToSync(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly reason?: string } = {}) =>
      api.markExpenseReadyToSync({ expenseId, ...input }),
    onSuccess: () => invalidateSplitwise(queryClient, expenseId),
  });
}

export function useResyncExpense() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.resyncExpenseToSplitwise,
    onSuccess: (_result, input) => invalidateSplitwise(queryClient, input.expenseId),
  });
}

/** A push changes the expense's state, what still needs one, and what an audit would find. */
function invalidateSplitwise(
  queryClient: ReturnType<typeof useQueryClient>,
  expenseId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.expense(expenseId) });
  void queryClient.invalidateQueries({ queryKey: ["expenses"] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.resyncCandidates() });
  void queryClient.invalidateQueries({ queryKey: ["splitwise-audit-findings"] });
}

/* -------------------------------------------------------------------------- analytics */

export function useCategorySpend(range: AnalyticsRange) {
  return useQuery({
    queryKey: queryKeys.categorySpend(range),
    queryFn: () => api.getCategorySpend(range),
  });
}

export function useMonthlySpend(range: AnalyticsRange) {
  return useQuery({
    queryKey: queryKeys.monthlySpend(range),
    queryFn: () => api.getMonthlySpend(range),
  });
}

export function useOwnSpend(range: AnalyticsRange) {
  return useQuery({
    queryKey: queryKeys.ownSpend(range),
    queryFn: () => api.getOwnSpend(range),
  });
}

export function useOutstanding() {
  return useQuery({ queryKey: queryKeys.outstanding(), queryFn: api.getOutstanding });
}

export function useUnsettled() {
  return useQuery({ queryKey: queryKeys.unsettled(), queryFn: api.getUnsettled });
}

/* ------------------------------------------------------------------------------ rules */

export function useRules() {
  return useQuery({ queryKey: queryKeys.rules(), queryFn: api.listRules });
}

export function useCreateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createRule,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.rules() }),
  });
}

export function useUpdateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.updateRule,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.rules() }),
  });
}

/**
 * Running the rules.
 *
 * A dry run writes nothing, so it invalidates nothing: a preview that quietly refreshed the
 * workspace would look like it had done something.
 */
export function useApplyRules() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.applyRules,
    onSuccess: (_result, input) => {
      if (input.dryRun === true) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.rules() });
      invalidatePayments(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
  });
}

/* -------------------------------------------------------------------------- occasions */

export function useOccasions() {
  return useQuery({ queryKey: queryKeys.occasions(), queryFn: api.listOccasions });
}

export function useCreateOccasion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createOccasion,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.occasions() }),
  });
}

/** Filing an expense under an occasion is a label. No figure moves, so no figure is refetched. */
export function useAssignOccasion(expenseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (occasionId: string | null) =>
      api.assignExpenseToOccasion({ expenseId, occasionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.occasions() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.expense(expenseId) });
    },
  });
}

/* ------------------------------------------------------------------------------- jobs */

export function useJobs(filter: { status?: JobStatus; kind?: JobKind } = {}) {
  return useQuery({ queryKey: queryKeys.jobs(filter), queryFn: () => api.listJobs(filter) });
}

export function useRetryJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.retryJob(jobId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.cancelJob,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
}
