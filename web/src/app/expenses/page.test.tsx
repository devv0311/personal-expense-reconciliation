import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import { EXPENSE, PEOPLE } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { ExpensePage } from "@/lib/types";
import ExpensesPage from "./page";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderLedger(
  page: ExpensePage = { expenses: [EXPENSE], total: 1, limit: 50, offset: 0 },
): ApiMock {
  const api = mockApi({
    "/api/occasions": { occasions: [] },
    "/api/people": { people: PEOPLE },
    "/api/expenses": page,
  });
  renderWithQuery(<ExpensesPage />);
  return api;
}

describe("the expense ledger", () => {
  it("searches through the API, over the whole ledger rather than a loaded window", async () => {
    const api = renderLedger();
    const user = userEvent.setup();

    await screen.findAllByText("Blinkit — weekly groceries");
    await user.type(screen.getByLabelText("Search"), "Toit");

    await waitFor(() =>
      expect(api.callsTo("/api/expenses").some((call) => call.url.includes("search=Toit"))).toBe(
        true,
      ),
    );
  });

  it("reports how many match across the whole ledger, not how many were loaded", async () => {
    renderLedger({ expenses: [EXPENSE], total: 217, limit: 50, offset: 0 });

    expect(await screen.findByText(/matching expenses in the whole ledger/)).toBeInTheDocument();
    expect(screen.getByText("217")).toBeInTheDocument();
  });

  it("pages rather than truncating, and resets the page when a filter changes", async () => {
    const api = renderLedger({
      expenses: Array.from({ length: 50 }, (_, index) => ({ ...EXPENSE, id: `exp-${index}` })),
      total: 217,
      limit: 50,
      offset: 0,
    });
    const user = userEvent.setup();

    await screen.findAllByText("Blinkit — weekly groceries");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(api.callsTo("/api/expenses").some((call) => call.url.includes("offset=50"))).toBe(
        true,
      ),
    );

    await user.type(screen.getByLabelText("Search"), "T");
    await waitFor(() =>
      expect(
        api
          .callsTo("/api/expenses")
          .some((call) => call.url.includes("search=T") && !call.url.includes("offset=50")),
      ).toBe(true),
    );
  });

  it("offers the expenses nobody has allocated yet, which is where the workflow stalls", async () => {
    const api = renderLedger();
    const user = userEvent.setup();

    await screen.findAllByText("Blinkit — weekly groceries");
    await user.click(screen.getByRole("checkbox", { name: /Nobody named a beneficiary yet/ }));

    await waitFor(() =>
      expect(
        api.callsTo("/api/expenses").some((call) => call.url.includes("withoutAllocation=true")),
      ).toBe(true),
    );
  });

  it("says an empty result is about the whole ledger, not about a loaded page", async () => {
    renderLedger({ expenses: [], total: 0, limit: 50, offset: 0 });

    expect(
      await screen.findByText(/No expenses match these filters, anywhere in the ledger/),
    ).toBeInTheDocument();
  });
});
