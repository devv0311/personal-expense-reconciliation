import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllocationEditor } from "@/components/expenses/allocation-editor";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { FundingLinks } from "@/components/expenses/funding-links";
import { ItemEditor } from "@/components/expenses/item-editor";
import { SplitwiseSyncPanel } from "@/components/expenses/splitwise-sync";
import { SettlementForm } from "@/components/settlements/settlement-form";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import { EXPENSE, GROUP, PEOPLE, UNEXPLAINED_PAYMENT, paymentPage } from "@/test-support/fixtures";
import { resetNavigation } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { ExpenseItemRecord, ExpenseLedgerRow } from "@/lib/types";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

const ITEMS: readonly ExpenseItemRecord[] = [
  {
    id: "item-1",
    expenseId: EXPENSE.id,
    description: "Paneer tikka",
    amount: "60000",
    quantity: "1",
    receiptItemId: null,
  },
  {
    id: "item-2",
    expenseId: EXPENSE.id,
    description: "Two beers",
    amount: "120000",
    quantity: "2",
    receiptItemId: null,
  },
];

describe("recording an expense", () => {
  function renderForm(): ApiMock {
    const api = mockApi({
      "/api/payments": paymentPage([UNEXPLAINED_PAYMENT]),
      "/api/people": { people: PEOPLE },
      "/api/expenses": {
        expenseId: "exp-new",
        state: "approved",
        fundedByPaymentIds: [UNEXPLAINED_PAYMENT.id],
        externallyFunded: false,
      },
    });
    renderWithQuery(<ExpenseForm />);
    return api;
  }

  it("attributes the chosen movement when a payment in this ledger funded it", async () => {
    const api = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record an expense" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What it was"), "Dinner at Toit");
    await user.type(within(dialog).getByLabelText("Amount"), "2400");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /Dev/ })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText("Who paid"), "p-dev");
    await user.selectOptions(within(dialog).getByLabelText("Movement"), UNEXPLAINED_PAYMENT.id);
    await user.click(within(dialog).getByRole("button", { name: "Record it" }));

    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "POST")).not.toHaveLength(0),
    );
    const body = api.calls.find((call) => call.method === "POST")?.body as Record<string, unknown>;
    expect(body["amount"]).toBe("240000");
    expect(body["funding"]).toEqual([{ paymentId: UNEXPLAINED_PAYMENT.id, amount: "240000" }]);
  });

  it("creates no payment at all when somebody else paid, and requires evidence instead", async () => {
    const api = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record an expense" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What it was"), "Electrician");
    await user.type(within(dialog).getByLabelText("Amount"), "1500");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /Alex/ })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText("Who paid"), "p-alex");
    await user.click(within(dialog).getByRole("radio", { name: /Somebody else paid/ }));

    // Without an evidence id there is no trail back to what happened, so it cannot be recorded.
    expect(within(dialog).getByRole("button", { name: "Record it" })).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Evidence id"), "ev-1");
    await user.click(within(dialog).getByRole("button", { name: "Record it" }));

    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "POST")).not.toHaveLength(0),
    );
    const body = api.calls.find((call) => call.method === "POST")?.body as Record<string, unknown>;
    expect(body["funding"]).toBeUndefined();
    expect(body["evidenceId"]).toBe("ev-1");
    expect(body["paidByPersonId"]).toBe("p-alex");
    // Recording alone approves nothing: the default is a proposal.
    expect(body["state"]).toBeUndefined();
  });

  it("can be counted at once, but only when the person says so and the dialog states it", async () => {
    // The defect: an expense somebody else paid for can only be recorded here, and every one
    // came out `proposed` — which no screen could then approve, so it could never be counted or
    // shared. The API has always accepted `state: "approved"`; nothing in the browser sent it.
    const api = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record an expense" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What it was"), "Flat internet");
    await user.type(within(dialog).getByLabelText("Amount"), "1200");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /Alex/ })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText("Who paid"), "p-alex");
    await user.click(within(dialog).getByRole("radio", { name: /Somebody else paid/ }));
    await user.type(within(dialog).getByLabelText("Evidence id"), "ev-1");

    const countIt = within(dialog).getByRole("checkbox", { name: /Count it as spending now/ });
    expect(countIt).not.toBeChecked();
    expect(within(dialog).getByText(/only a proposal/)).toBeInTheDocument();

    await user.click(countIt);
    expect(within(dialog).getByText(/its amount can never be edited/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Record it and count it" }));

    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "POST")).not.toHaveLength(0),
    );
    const body = api.calls.find((call) => call.method === "POST")?.body as Record<string, unknown>;
    expect(body["state"]).toBe("approved");
    expect(body["amount"]).toBe("120000");
  });
});

describe("recording an expense the ledger would refuse", () => {
  function renderForm(): ApiMock {
    const api = mockApi({
      "/api/payments": paymentPage([UNEXPLAINED_PAYMENT]),
      "/api/people": { people: PEOPLE },
      "/api/expenses": {
        expenseId: "exp-new",
        state: "approved",
        fundedByPaymentIds: [],
        externallyFunded: true,
      },
    });
    renderWithQuery(<ExpenseForm />);
    return api;
  }

  it("says an expense you paid cannot be counted at once with no movement behind it", async () => {
    // The ledger refuses it (the Expense invariants): it would count as spending no statement
    // shows. Said before the button, and the button stays off.
    const api = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record an expense" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What it was"), "Electrician");
    await user.type(within(dialog).getByLabelText("Amount"), "1500");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /Dev/ })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText("Who paid"), "p-dev");
    await user.click(within(dialog).getByRole("radio", { name: /Somebody else paid/ }));
    await user.type(within(dialog).getByLabelText("Evidence id"), "ev-1");
    await user.click(within(dialog).getByRole("checkbox", { name: /Count it as spending now/ }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/cannot be counted/i);
    expect(within(dialog).getByRole("button", { name: /Record it and count it/ })).toBeDisabled();

    // Unticked, it is a proposal again and may be recorded.
    await user.click(within(dialog).getByRole("checkbox", { name: /Count it as spending now/ }));
    expect(within(dialog).getByRole("button", { name: "Record it" })).toBeEnabled();
    expect(api.callsTo("/api/expenses").filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("says a movement from your own account cannot have been paid by somebody else", async () => {
    renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record an expense" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What it was"), "Dinner");
    await user.type(within(dialog).getByLabelText("Amount"), "2400");
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: /Alex/ })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText("Who paid"), "p-alex");
    await user.selectOptions(within(dialog).getByLabelText("Movement"), UNEXPLAINED_PAYMENT.id);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/left your own account/i);
    expect(within(dialog).getByRole("button", { name: "Record it" })).toBeDisabled();
  });
});

describe("naming who benefited", () => {
  function renderEditor(hasCurrent = false): ApiMock {
    const api = mockApi({
      [`/api/expenses/${EXPENSE.id}/allocation`]: { allocationId: "alloc-1" },
      [`/api/expenses/${EXPENSE.id}/items`]: { items: ITEMS },
      "/api/people": { people: PEOPLE },
      "/api/groups": { groups: [GROUP] },
    });
    renderWithQuery(<AllocationEditor expense={EXPENSE} hasCurrentAllocation={hasCurrent} />);
    return api;
  }

  it("sends beneficiaries and a method for an equal split, and no amounts", async () => {
    const api = renderEditor();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Name who benefited" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("checkbox", { name: /Alex/ })).toBeInTheDocument(),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: /Dev/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Alex/ }));
    await user.click(within(dialog).getByRole("button", { name: "Approve it" }));

    await waitFor(() => expect(api.callsTo("/allocation")).not.toHaveLength(0));
    const body = api.callsTo("/allocation")[0]!.body as Record<string, unknown>;
    expect(body["method"]).toBe("equal");
    expect(body["beneficiaries"]).toEqual([
      { type: "person", id: "p-dev" },
      { type: "person", id: "p-alex" },
    ]);
    expect(body["lines"]).toBeUndefined();
  });

  it("passes exact shares through as typed paise, and says the check is an entry check", async () => {
    const api = renderEditor();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Name who benefited" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Method"), "exact");
    await waitFor(() =>
      expect(within(dialog).getByRole("checkbox", { name: /Alex/ })).toBeInTheDocument(),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: /Alex/ }));
    await user.type(within(dialog).getAllByLabelText("Share")[0]!, "1800");

    expect(within(dialog).getByText(/entry check/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Approve it" }));

    await waitFor(() => expect(api.callsTo("/allocation")).not.toHaveLength(0));
    const body = api.callsTo("/allocation")[0]!.body as Record<string, unknown>;
    expect(body["lines"]).toEqual([
      { beneficiary: { type: "person", id: "p-alex" }, amount: "180000" },
    ]);
  });

  it("says a replacement supersedes rather than edits", async () => {
    renderEditor(true);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Change the split" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/supersedes the current one/)).toBeInTheDocument();
  });

  it("sends unit claims per item for a quantity-based split, and divides nothing here", async () => {
    const api = renderEditor();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Name who benefited" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Method"), "quantity_based");
    await waitFor(() =>
      expect(within(dialog).getByRole("checkbox", { name: /Alex/ })).toBeInTheDocument(),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: /Alex/ }));
    await waitFor(() => expect(screen.getByText("Two beers")).toBeInTheDocument());

    // [0] is Alex as a beneficiary; [1] is Alex's claim on the first item.
    const claimOnFirstItem = within(dialog).getAllByRole("checkbox", { name: /Alex/ })[1]!;
    await user.click(claimOnFirstItem);
    await user.click(within(dialog).getByRole("button", { name: "Approve it" }));

    await waitFor(() => expect(api.callsTo("/allocation")).not.toHaveLength(0));
    const body = api.callsTo("/allocation")[0]!.body as Record<string, unknown>;
    expect(body["method"]).toBe("quantity_based");
    expect(body["lines"]).toEqual([
      { beneficiary: { type: "person", id: "p-alex" }, expenseItemId: "item-1", units: "1" },
    ]);
  });
});

describe("the item breakdown", () => {
  it("will not record a set that does not sum to the immutable gross", async () => {
    mockApi({ [`/api/expenses/${EXPENSE.id}/items`]: { items: [] } });
    renderWithQuery(<ItemEditor expense={EXPENSE} items={[]} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record the items" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Item 1"), "Paneer tikka");
    await user.type(within(dialog).getByLabelText("Amount"), "600");

    expect(within(dialog).getByRole("button", { name: "Record them" })).toBeDisabled();
    expect(within(dialog).getByText(/refuses a breakdown that does not sum/)).toBeInTheDocument();
  });

  it("requires a reason to correct one, because a correction without one is an edit", async () => {
    mockApi({
      [`/api/expenses/${EXPENSE.id}/items/correct`]: { items: ITEMS, supersededItemIds: [] },
    });
    renderWithQuery(<ItemEditor expense={EXPENSE} items={ITEMS} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Correct the breakdown" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/old ones are kept, not deleted/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Replace them" })).toBeDisabled();
  });
});

describe("funding links", () => {
  it("says an unfunded expense is the externally-paid shape, not a missing link", async () => {
    mockApi({
      [`/api/expenses/${EXPENSE.id}/payment-links`]: { links: [] },
      "/api/payments": paymentPage([UNEXPLAINED_PAYMENT]),
    });
    renderWithQuery(<FundingLinks expense={EXPENSE} />);

    expect(await screen.findByText(/no payment is invented on your behalf/i)).toBeInTheDocument();
  });
});

describe("recording a settlement", () => {
  it("states that it discharges rather than creates, and sends the amount explicitly", async () => {
    const api = mockApi({
      [`/api/payments/${UNEXPLAINED_PAYMENT.id}/settlements`]: { settlementId: "set-1" },
      "/api/people": { people: PEOPLE },
    });
    renderWithQuery(<SettlementForm payment={UNEXPLAINED_PAYMENT} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record a settlement" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/creates no obligation/)).toBeInTheDocument();

    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: "Alex" })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText("Between you and"), "p-alex");
    await user.click(within(dialog).getByRole("button", { name: "Record it" }));

    await waitFor(() => expect(api.callsTo("/settlements")).not.toHaveLength(0));
    expect(api.callsTo("/settlements")[0]!.body).toMatchObject({
      counterpartyPersonId: "p-alex",
      amount: UNEXPLAINED_PAYMENT.amount,
    });
  });
});

describe("sharing an expense to Splitwise", () => {
  function renderPanel(state: ExpenseLedgerRow["state"]): ApiMock {
    const api = mockApi({
      [`/api/expenses/${EXPENSE.id}/ready-to-sync`]: { state: "ready_to_sync" },
      [`/api/expenses/${EXPENSE.id}/splitwise-sync`]: { splitwiseExpenseId: "swe-1" },
    });
    renderWithQuery(<SplitwiseSyncPanel expense={{ ...EXPENSE, state }} />);
    return api;
  }

  it("keeps marking an expense ready and pushing it as two separate acts", async () => {
    const api = renderPanel("allocated");
    const user = userEvent.setup();

    expect(screen.queryByRole("button", { name: "Sync to Splitwise" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark ready to sync" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/sends nothing anywhere/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Mark it ready" }));

    await waitFor(() => expect(api.callsTo("/ready-to-sync")).not.toHaveLength(0));
    expect(api.callsTo("/splitwise-sync")).toHaveLength(0);
  });

  it("says who will see it before the push that writes into Splitwise", async () => {
    renderPanel("ready_to_sync");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Sync to Splitwise" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Everyone in that group will see it/)).toBeInTheDocument();
  });

  it("offers nothing to push while the expense has no approved allocation", () => {
    renderPanel("approved");

    expect(screen.queryByRole("button", { name: "Mark ready to sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync to Splitwise" })).not.toBeInTheDocument();
  });
});
