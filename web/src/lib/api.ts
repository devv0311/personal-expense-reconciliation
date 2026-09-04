/**
 * The one place this app talks to the real API (`docs/decisions/0042-frontend-stack-and-server-
 * bridge.md`) — an HTTP call to `src/server.ts`, never a direct import of anything under `src/`
 * in the parent repo. No financial arithmetic happens here or anywhere else in `web/`: every
 * function below returns exactly what the API sent, typed.
 */

import type {
  ApiErrorBody,
  BalanceResult,
  ExpenseLedgerRow,
  ExpenseState,
  PersonSummary,
  ReconciliationRun,
  RunReconciliationResult,
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
}

export async function runReconciliation(
  input: RunReconciliationInput,
): Promise<RunReconciliationResult> {
  return request<RunReconciliationResult>("/api/reconciliation/runs", {
    method: "POST",
    body: JSON.stringify({ actor: ACTOR, ...input }),
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
