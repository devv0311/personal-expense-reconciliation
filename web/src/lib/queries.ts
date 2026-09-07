"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type {
  AuditFindingFilter,
  ListExpensesFilter,
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
    mutationFn: (input: { readonly reason?: string } = {}) =>
      api.distributeAdjustment({ expenseId, ...input }),
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
