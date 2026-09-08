import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import {
  ACCOUNT,
  CLASSIFIED_CREDIT,
  EXPLAINED_PAYMENT,
  UNEXPLAINED_PAYMENT,
  paymentPage,
} from "@/test-support/fixtures";
import { resetNavigation, setSearchParams } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { PaymentListResult } from "@/lib/types";
import PaymentsPage from "./page";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

function renderWorkspace(result: PaymentListResult = paymentPage([UNEXPLAINED_PAYMENT])): ApiMock {
  const api = mockApi({
    "/api/accounts": { accounts: [ACCOUNT] },
    "/api/payments": result,
  });
  renderWithQuery(<PaymentsPage />);
  return api;
}

describe("the payment workspace", () => {
  it("shows every movement with what the ledger cannot account for", async () => {
    renderWorkspace(paymentPage([UNEXPLAINED_PAYMENT, EXPLAINED_PAYMENT]));

    expect(await screen.findAllByText("UPI-BLINKIT-PAYU@AXIS-517290")).not.toHaveLength(0);
    // The unexplained figure is the API's own, rendered as money rather than a status word.
    expect(screen.getAllByText("₹1,840.00").length).toBeGreaterThan(0);
  });

  it("never renders an explained movement as a bare zero", async () => {
    renderWorkspace(paymentPage([EXPLAINED_PAYMENT]));

    await screen.findAllByText("UPI-SWIGGY-8817");
    expect(screen.getAllByText("Explained").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/by 1 expense/).length).toBeGreaterThan(0);
    expect(screen.queryByText("₹0.00")).not.toBeInTheDocument();
  });

  it("says the total is a floor, not a count, when the unexplained filter narrowed the page", async () => {
    renderWorkspace(
      paymentPage([UNEXPLAINED_PAYMENT], { total: 120, filteredTotalIsExact: false }),
    );

    expect(await screen.findByText(/at least/)).toBeInTheDocument();
    expect(screen.getByText(/a floor, not a total/)).toBeInTheDocument();
  });

  it("asks the API for only-unexplained movements rather than filtering them here", async () => {
    const api = renderWorkspace();
    const user = userEvent.setup();

    await screen.findAllByText("UPI-BLINKIT-PAYU@AXIS-517290");
    await user.click(screen.getByRole("checkbox", { name: /only unexplained/i }));

    await waitFor(() =>
      expect(
        api.callsTo("/api/payments").some((call) => call.url.includes("onlyUnexplained=true")),
      ).toBe(true),
    );
  });

  it("applies an account filter from the query string without copying it into state", async () => {
    setSearchParams({ accountId: ACCOUNT.id });
    const api = renderWorkspace();

    await waitFor(() =>
      expect(
        api.callsTo("/api/payments").some((call) => call.url.includes(`accountId=${ACCOUNT.id}`)),
      ).toBe(true),
    );
  });

  it("says so when a link narrowed the list to one import batch", async () => {
    setSearchParams({ importBatchId: "batch-1" });
    renderWorkspace();

    expect(await screen.findByText("Showing one import batch")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Show every movement/ })).toHaveAttribute(
      "href",
      "/payments",
    );
  });

  it("pages through the ledger rather than loading a window and calling it the total", async () => {
    const api = renderWorkspace(
      paymentPage(
        Array.from({ length: 50 }, (_, index) => ({
          ...UNEXPLAINED_PAYMENT,
          id: `pay-${index}`,
        })),
        { total: 130 },
      ),
    );
    const user = userEvent.setup();

    await screen.findAllByText("UPI-BLINKIT-PAYU@AXIS-517290");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(api.callsTo("/api/payments").some((call) => call.url.includes("offset=50"))).toBe(
        true,
      ),
    );
  });

  it("offers the classification run behind a dialog that says it approves nothing", async () => {
    const api = renderWorkspace(paymentPage([CLASSIFIED_CREDIT]));
    const user = userEvent.setup();

    await screen.findAllByText("REFUND BLINKIT ORDER 8842");
    await user.click(screen.getByRole("button", { name: "Run classification" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Nothing is approved/)).toBeInTheDocument();
    // Opening the dialog sends nothing: the mutation is the button inside it.
    expect(api.calls.filter((call) => call.url.includes("/classify"))).toHaveLength(0);
  });
});
