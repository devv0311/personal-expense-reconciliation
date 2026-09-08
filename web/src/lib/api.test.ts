import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getBalance, listExpenses, listPeople, runReconciliation } from "./api";

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listExpenses", () => {
  it("requests /api/expenses with no query string when no filter is given", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { expenses: [] }));
    await listExpenses();
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/api\/expenses$/);
  });

  it("builds the query string from state/paidBy/limit", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { expenses: [] }));
    await listExpenses({ state: "approved", paidBy: "person-1", limit: 10 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("state")).toBe("approved");
    expect(parsed.searchParams.get("paidBy")).toBe("person-1");
    expect(parsed.searchParams.get("limit")).toBe("10");
  });

  it("passes search, category and offset through to the API rather than filtering here", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { expenses: [], total: 0 }));
    await listExpenses({ search: "Blinkit", category: "groceries", offset: 50 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("search")).toBe("Blinkit");
    expect(parsed.searchParams.get("category")).toBe("groceries");
    expect(parsed.searchParams.get("offset")).toBe("50");
  });

  it("keeps the ledger-wide total beside the page, not just the rows", async () => {
    const expense = {
      id: "e1",
      description: "Coffee",
      category: null,
      grossAmount: "500",
      netAmount: "500",
      currency: "INR",
      occurredAt: "2026-08-01T00:00:00.000Z",
      relationshipType: "personal",
      paidByPersonId: "p1",
      state: "approved",
    };
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { expenses: [expense], total: 217, limit: 50, offset: 0 }),
    );
    const result = await listExpenses();
    // The total is what makes a result count mean anything: it is how many match across the
    // whole ledger, not how many came back (audit row 32).
    expect(result).toEqual({ expenses: [expense], total: 217, limit: 50, offset: 0 });
  });
});

describe("listPeople / getBalance", () => {
  it("unwraps the people array", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        people: [{ id: "p1", displayName: "Dev", splitwiseUserId: null, isUser: true }],
      }),
    );
    const people = await listPeople();
    expect(people).toHaveLength(1);
    expect(people[0]?.displayName).toBe("Dev");
  });

  it("builds the balances URL from both person ids", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        personAId: "p1",
        personBId: "p2",
        netBalance: "0",
        evidenceStatus: "settled_confirmed",
        contributions: [],
      }),
    );
    await getBalance("p1", "p2");
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/api\/balances\/p1\/p2$/);
  });
});

describe("error handling", () => {
  it("throws ApiError with the server's code and message on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(409, { error: { code: "PRECONDITION_FAILED", message: "not ready" } }),
    );
    await expect(listExpenses()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      status: 409,
      message: "not ready",
    });
  });

  it("throws a NETWORK_ERROR ApiError when fetch itself rejects", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(listExpenses()).rejects.toBeInstanceOf(ApiError);
    await expect(listExpenses()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});

describe("runReconciliation", () => {
  it("posts the period with a fixed 'user' actor", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(201, {
        reconciliationRunId: "r1",
        totals: {
          ledgerTotalOutflow: "0",
          ledgerTransfersTotal: "0",
          ledgerInvestmentsTotal: "0",
          ledgerSettlementsTotal: "0",
          ledgerExplainedTotal: "0",
          ledgerUnexplainedTotal: "0",
        },
        discrepancies: [],
      }),
    );
    await runReconciliation({
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
    });
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      actor: "user",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
    });
  });
});
