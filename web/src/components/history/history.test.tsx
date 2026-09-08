import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpenseHistory } from "@/components/history/expense-history";
import { PaymentHistory } from "@/components/history/payment-history";
import { ReviewItemInspector } from "@/components/review/inspectors";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import { PEOPLE, REJECTED_ITEM, EXPENSE_HISTORY } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("an expense's history", () => {
  function renderHistory(): ApiMock {
    const api = mockApi({
      "/api/expenses/exp-1/history": EXPENSE_HISTORY,
      "/api/people": { people: PEOPLE },
    });
    renderWithQuery(<ExpenseHistory expenseId="exp-1" />);
    return api;
  }

  it("keeps every superseded split readable, marking which one is current", async () => {
    renderHistory();

    expect(await screen.findByText("current")).toBeInTheDocument();
    expect(screen.getByText(/superseded/)).toBeInTheDocument();
    // The superseded version's own figures, as approved then — not what they would be today.
    expect(screen.getAllByText("₹1,075.00")).toHaveLength(2);
    expect(screen.getAllByText("₹750.00")).toHaveLength(2);
  });

  it("shows each event's actor and reason, and what it changed", async () => {
    renderHistory();

    expect(await screen.findByText(/A refund came back on two items/)).toBeInTheDocument();
    expect(screen.getByText("Was")).toBeInTheDocument();
    expect(screen.getByText("Became")).toBeInTheDocument();
  });
});

describe("a payment's history", () => {
  it("says an empty trail is an answer rather than a gap", async () => {
    mockApi({ "/api/payments/pay-1/history": { events: [] } });
    renderWithQuery(<PaymentHistory paymentId="pay-1" />);

    expect(await screen.findByText(/That is an answer, not a gap/)).toBeInTheDocument();
  });
});

describe("a declined classification", () => {
  it("offers a re-run and a manual path instead of leaving the payment stranded", async () => {
    const api = mockApi({
      "/api/review/payments/pay-1/reclassify": { outcome: "proposed" },
    });
    renderWithQuery(<ReviewItemInspector item={REJECTED_ITEM} />);
    const user = userEvent.setup();

    expect(screen.getByRole("link", { name: "Classify it yourself" })).toHaveAttribute(
      "href",
      "/payments/pay-1",
    );

    await user.click(screen.getByRole("button", { name: "Ask the model again" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/approves nothing/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Ask again" }));

    await waitFor(() => expect(api.callsTo("/reclassify")).not.toHaveLength(0));
  });
});
