"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type { ListExpensesFilter, RunReconciliationInput } from "./api";

export const queryKeys = {
  expenses: (filter: ListExpensesFilter) => ["expenses", filter] as const,
  people: () => ["people"] as const,
  balance: (a: string, b: string) => ["balance", a, b] as const,
  reconciliationRuns: (limit?: number) => ["reconciliation-runs", limit ?? null] as const,
  reconciliationRun: (id: string) => ["reconciliation-run", id] as const,
};

export function useExpenses(filter: ListExpensesFilter) {
  return useQuery({
    queryKey: queryKeys.expenses(filter),
    queryFn: () => api.listExpenses(filter),
  });
}

export function usePeople() {
  return useQuery({ queryKey: queryKeys.people(), queryFn: api.listPeople });
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

export function useRunReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RunReconciliationInput) => api.runReconciliation(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reconciliation-runs"] });
    },
  });
}
