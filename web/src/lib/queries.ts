"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type {
  AuditFindingFilter,
  EvidenceLibraryFilter,
  ListExpensesFilter,
  ListPaymentsFilter,
  RecordAdjustmentInput,
  ReviewQueueFilter,
  RunReconciliationInput,
} from "./api";
import type { SplitwiseAuditReviewDecision } from "./types";

export const queryKeys = {
  expenses: (filter: ListExpensesFilter) => ["expenses", filter] as const,
  expense: (id: string) => ["expense", id] as const,
  expenseItems: (id: string) => ["expense-items", id] as const,
  refundAllocation: (id: string) => ["refund-allocation", id] as const,
  people: () => ["people"] as const,
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
  splitwiseAuditRun: (id: string) => ["splitwise-audit-run", id] as const,
  splitwiseAuditFindings: (filter: AuditFindingFilter) =>
    ["splitwise-audit-findings", filter] as const,
  splitwiseAuditFinding: (id: string) => ["splitwise-audit-finding", id] as const,
  proofPack: (recipientPersonId: string) => ["proof-pack", recipientPersonId] as const,
  payments: (filter: ListPaymentsFilter) => ["payments", filter] as const,
  payment: (id: string) => ["payment", id] as const,
  counterpartyOptions: () => ["counterparty-options"] as const,
  imports: (limit?: number, offset?: number) => ["imports", limit ?? null, offset ?? null] as const,
  peopleManagement: () => ["people-management"] as const,
  expenseFunding: (id: string) => ["expense-funding", id] as const,
  expenseHistory: (id: string) => ["expense-history", id] as const,
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

/* -------------------------------------------------------------------------- mutations */

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
