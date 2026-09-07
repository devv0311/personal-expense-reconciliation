import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { mockApi } from "@/test-support/api-mock";
import { EXPENSE, PEOPLE } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";
import ExpensesPage from "./page";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function setup() {
  const other = {
    ...EXPENSE,
    id: "exp-2",
    description: "Electricity bill",
    state: "approved",
    netAmount: "900719925474099312",
    grossAmount: "900719925474099312",
  };
  const api = mockApi({
    "/api/people": { people: PEOPLE },
    "/api/expenses": (url: string) => {
      const state = new URL(url, "http://localhost").searchParams.get("state");
      return { expenses: [EXPENSE, other].filter((expense) => !state || expense.state === state) };
    },
  });
  renderWithQuery(<ExpensesPage />);
  return api;
}

describe("expense discovery", () => {
  it("searches descriptions without recomputing, reordering or fetching the money", async () => {
    const api = setup();
    const user = userEvent.setup();
    await screen.findByText(/2 expenses in the ledger/);
    const callsBefore = api.callsTo("/api/expenses").length;
    await user.type(screen.getByRole("searchbox"), "  BLINKIT ");
    expect(screen.getByRole("status")).toHaveTextContent("1 expense matching your filters");
    expect(screen.queryByText("Electricity bill")).not.toBeInTheDocument();
    expect(screen.getAllByText("₹1,500.00")).toHaveLength(2);
    expect(screen.getAllByText("₹2,150.00")).toHaveLength(2);
    expect(api.callsTo("/api/expenses")).toHaveLength(callsBefore);
    await user.clear(screen.getByRole("searchbox"));
    expect(screen.getAllByText("₹9,00,71,99,25,47,40,993.12")).toHaveLength(2);
  });

  it("explains an empty filtered result and clears search, state and payer together", async () => {
    const api = setup();
    const user = userEvent.setup();
    await screen.findByLabelText("Paid by");
    await user.selectOptions(screen.getByLabelText("State"), "approved");
    await user.selectOptions(screen.getByLabelText("Paid by"), "p-dev");
    await user.type(screen.getByRole("searchbox"), "not recorded");
    expect(await screen.findByText(/No expenses match these filters/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByLabelText("State")).toHaveValue("");
    expect(screen.getByLabelText("Paid by")).toHaveValue("");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("2 expenses in the ledger"),
    );
    expect(api.calls.some((call) => call.url.includes("paidBy=p-dev"))).toBe(true);
  });
});
