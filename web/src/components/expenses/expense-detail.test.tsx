import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpenseDetail } from "@/components/expenses/expense-detail";
import { mockApi, mockApiFailure, mockApiPending, type ApiMock } from "@/test-support/api-mock";
import {
  CREDIT_PAYMENT,
  EXPENSE,
  PEOPLE,
  REFUND_STATE_PENDING,
  REFUND_STATE_REVIEW_REQUIRED,
  REFUND_STATE_SETTLED,
} from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderDetail(refundState: unknown = REFUND_STATE_PENDING): ApiMock {
  const api = mockApi({
    "/api/expenses/exp-1/refund-allocation": refundState,
    "/api/expenses/exp-1/payment-links": { links: [] },
    "/api/expenses/exp-1/items": { items: [] },
    "/api/expenses/exp-1/adjustments/distribute": { allocationId: "alloc-2" },
    "/api/expenses/exp-1/adjustments": { adjustmentId: "adj-2" },
    "/api/expenses/exp-1": EXPENSE,
    "/api/people": { people: PEOPLE },
    // The refund form offers unexplained credits as the arrival of the money coming back.
    "/api/payments": { payments: [], total: 0, filteredTotalIsExact: true, limit: 50, offset: 0 },
    "/api/occasions": { occasions: [] },
  });
  renderWithQuery(<ExpenseDetail expenseId="exp-1" />);
  return api;
}

describe("the expense detail screen", () => {
  it("leads with the net cost and keeps the immutable gross beside it", async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText("Net cost")).toBeInTheDocument());
    const hero = screen.getByText("₹1,500.00", { selector: "span.text-figure" });
    expect(hero).toBeInTheDocument();
    expect(screen.getByText(/the gross never changes/)).toBeInTheDocument();
    expect(screen.getAllByText("₹2,150.00").length).toBeGreaterThan(0);
  });

  it("says the obligations are out of date while a refund has not been distributed", async () => {
    renderDetail();

    await waitFor(() =>
      expect(screen.getByText("The obligations below are out of date")).toBeInTheDocument(),
    );
    expect(screen.getByText(/not current or verified/i)).toBeInTheDocument();
  });

  it("drops that warning once every recorded adjustment has reached the allocation", async () => {
    renderDetail(REFUND_STATE_SETTLED);

    await waitFor(() => expect(screen.getByText("Net cost")).toBeInTheDocument());
    expect(screen.queryByText("The obligations below are out of date")).not.toBeInTheDocument();
    expect(screen.getByText(/there is nothing to distribute/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve this distribution/i }),
    ).not.toBeInTheDocument();
  });

  it("quotes each item's paid, refunded and net cost exactly as the API sent them", async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText("Items")).toBeInTheDocument());
    const table = screen.getByRole("table", { name: /item breakdown with refunds applied/i });
    const oilRow = within(table).getByText("Cold-pressed olive oil (returned)").closest("tr")!;
    // Item, quantity, paid, refunded, net — the fully refunded item nets to zero, and the
    // gross it was bought at is still shown beside it.
    const cells = within(oilRow)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells).toEqual([
      "Cold-pressed olive oil (returned)",
      "1.000",
      "₹650.00",
      "₹650.00",
      "₹0.00",
    ]);
  });

  it("shows the projected lines a distribution would write, including a zero-amount line", async () => {
    renderDetail();

    await waitFor(() =>
      expect(screen.getByText("What a distribution would write")).toBeInTheDocument(),
    );
    const projected = screen.getByRole("table", {
      name: /allocation lines a distribution would write/i,
    });
    expect(within(projected).getByText("₹0.00")).toBeInTheDocument();
    expect(
      screen.getByText(/stays as a zero-amount line rather than disappearing/i),
    ).toBeInTheDocument();
  });

  it("refuses to offer a distribution the ledger says needs a decision first", async () => {
    renderDetail(REFUND_STATE_REVIEW_REQUIRED);

    await waitFor(() =>
      expect(screen.getByText("This refund cannot be allocated yet")).toBeInTheDocument(),
    );
    expect(screen.getByText("REFUND_ITEM_OWNERSHIP_REQUIRED")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve this distribution/i }),
    ).not.toBeInTheDocument();
  });

  it("requires an explicit confirmation before distributing, and says what it will do", async () => {
    const api = renderDetail();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText("Net cost")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /approve this distribution/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText(/superseding the current one/i)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Already-recorded settlements are untouched/i),
    ).toBeInTheDocument();
    // Nothing has been sent yet: opening the dialog is not the decision.
    expect(api.callsTo("/adjustments/distribute")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.callsTo("/adjustments/distribute")).toHaveLength(1));
    expect(api.bodyOf("/adjustments/distribute")).toMatchObject({ actor: "user" });
  });

  it("names a group beneficiary as a group rather than resolving it in the browser", async () => {
    renderDetail({
      ...REFUND_STATE_PENDING,
      currentAllocation: {
        ...REFUND_STATE_PENDING.currentAllocation,
        lines: [
          {
            beneficiaryType: "group",
            beneficiaryId: "g-flat",
            expenseItemId: null,
            amount: "215000",
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText("Who benefited")).toBeInTheDocument());
    expect(
      screen.getAllByText(/A group · expanded into people before it can be settled/).length,
    ).toBeGreaterThan(0);
  });

  it("announces a loading state, then an error the reader can retry", async () => {
    mockApiPending();
    const { unmount } = renderWithQuery(<ExpenseDetail expenseId="exp-1" />);
    expect(screen.getByText(/loading this expense/i)).toBeInTheDocument();
    unmount();

    mockApiFailure("ENTITY_NOT_FOUND", "No expense with id exp-1.", 404);
    renderWithQuery(<ExpenseDetail expenseId="exp-1" />);
    await waitFor(() => expect(screen.getByText(/No expense with id exp-1/)).toBeInTheDocument());
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

/** The splitter's desktop field. Its stacked-list twin carries an `-m` suffixed id. */
function itemField(label: string): HTMLElement {
  return within(
    screen.getByRole("table", { name: /refund attributed to each item/i }),
  ).getByLabelText(label);
}

describe("recording an item-attributed refund", () => {
  it("keeps the submit disabled until the attributions add up to the refund exactly", async () => {
    const api = renderDetail();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByLabelText("Amount (₹)")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Amount (₹)"), "900.00");

    const submit = screen.getByRole("button", { name: /record this refund/i });
    expect(submit).toBeDisabled();

    // Short of the refund total: still refused, and it says why.
    await user.type(itemField("Coffee beans, 1kg"), "500.00");
    expect(submit).toBeDisabled();
    expect(screen.getAllByText(/have to add up exactly/i).length).toBeGreaterThan(0);

    await user.clear(itemField("Coffee beans, 1kg"));
    await user.type(itemField("Coffee beans, 1kg"), "900.00");
    await waitFor(() => expect(submit).toBeEnabled());
    expect(api.callsTo("/adjustments")).toHaveLength(0);
  });

  it("sends the attributions as exact paise strings, after an explicit confirmation", async () => {
    const api = renderDetail();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByLabelText("Amount (₹)")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Amount (₹)"), "1,234.5");
    await user.type(itemField("Coffee beans, 1kg"), "1234.50");
    await user.click(screen.getByRole("button", { name: /record this refund/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/is not touched — it never is/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Record" }));

    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/adjustments")),
      ).toHaveLength(1),
    );
    const body = api.calls.find((c) => c.method === "POST" && c.url.endsWith("/adjustments"))!
      .body as Record<string, unknown>;
    expect(body["amount"]).toBe("123450");
    expect(body["itemAttributions"]).toEqual([{ expenseItemId: "item-coffee", amount: "123450" }]);
    expect(body["kind"]).toBe("merchant_refund");
  });

  it("rejects an amount with three decimal places rather than rounding it", async () => {
    renderDetail();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByLabelText("Amount (₹)")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Amount (₹)"), "10.005");

    expect(screen.getByText("Rupees have at most two decimal places.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record this refund/i })).toBeDisabled();
  });

  it("sends no itemAttributions at all for a deliberate whole-expense refund", async () => {
    const api = renderDetail();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByLabelText("Amount (₹)")).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Say which items this refund gave money back for/));
    await user.type(screen.getByLabelText("Amount (₹)"), "100.00");
    await user.click(screen.getByRole("button", { name: /record this refund/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Record" }));

    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/adjustments")),
      ).toHaveLength(1),
    );
    const body = api.calls.find((c) => c.method === "POST" && c.url.endsWith("/adjustments"))!
      .body as Record<string, unknown>;
    expect(body).not.toHaveProperty("itemAttributions");
  });
});

describe("connecting a refund to the money that came back", () => {
  it("offers only unexplained credits, and sends the one chosen with the refund", async () => {
    const api = mockApi({
      "/api/expenses/exp-1/refund-allocation": REFUND_STATE_PENDING,
      "/api/expenses/exp-1/payment-links": { links: [] },
      "/api/expenses/exp-1/items": { items: [] },
      "/api/expenses/exp-1/adjustments": { adjustmentId: "adj-3" },
      "/api/expenses/exp-1": EXPENSE,
      "/api/people": { people: PEOPLE },
      "/api/payments": {
        payments: [CREDIT_PAYMENT],
        total: 1,
        filteredTotalIsExact: true,
        limit: 50,
        offset: 0,
      },
    });
    renderWithQuery(<ExpenseDetail expenseId="exp-1" />);
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByLabelText("The credit it arrived on")).toBeInTheDocument(),
    );
    // The picker asks the API for credits with money nothing accounts for — not every payment.
    // (The funding panel on the same screen asks for unexplained movements in both directions,
    // so this looks for the credit-only request among them rather than at a fixed position.)
    const request = api
      .callsTo("/api/payments")
      .find((call) => call.url.includes("direction=credit"));
    expect(request).toBeDefined();
    expect(request!.url).toContain("onlyUnexplained=true");

    await user.click(screen.getByLabelText(/Say which items this refund gave money back for/));
    await user.type(screen.getByLabelText("Amount (₹)"), "400");
    await user.selectOptions(screen.getByLabelText("The credit it arrived on"), CREDIT_PAYMENT.id);
    await user.click(screen.getByRole("button", { name: "Record this refund" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Record" }));

    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/adjustments")),
      ).toHaveLength(1),
    );
    const body = api.calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/adjustments"),
    )!.body as Record<string, unknown>;
    expect(body["amount"]).toBe("40000");
    expect(body["adjustmentPaymentId"]).toBe(CREDIT_PAYMENT.id);
  });
});
