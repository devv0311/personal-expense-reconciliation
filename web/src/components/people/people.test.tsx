import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonBalance } from "@/components/people/person-balance";
import { ShareExpense } from "@/components/people/share-expense";
import { mockApi, mockApiFailure, mockApiPending } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { AllocationPreviewResult, PersonBalanceSummary } from "@/lib/types";

/**
 * The two screens that answer "who owes whom, and why".
 *
 * What is worth testing is the direction and the arithmetic: a balance must read the way the
 * ledger says regardless of who paid, and every amount on the share screen must be one the
 * server computed — never one this package divided.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const COLLECT: PersonBalanceSummary = {
  personId: "p1",
  displayName: "Priya",
  amount: "30000",
  direction: "collect",
  evidenceStatus: "open_unconfirmed",
  contributions: [
    {
      expenseId: "exp-1",
      whatItWas: "Dinner",
      occurredAt: "2026-08-02T10:00:00.000Z",
      amount: "30000",
      direction: "collect",
      paidByName: "Dev",
      paidByIsYou: true,
      paymentId: "pay-1",
    },
  ],
  settlements: [],
  pendingRefundExpenseIds: [],
};

describe("one person's balance", () => {
  it("says you should collect when you were the one who paid", async () => {
    mockApi({ "/api/people/": COLLECT });
    renderWithQuery(<PersonBalance personId="p1" />);

    await screen.findByRole("heading", { name: "Priya" });
    expect(screen.getByText("You should collect")).toBeInTheDocument();
    expect(screen.getByText("Priya benefited from things you paid for.")).toBeInTheDocument();
    expect(screen.getByText("they owe you")).toBeInTheDocument();
  });

  it("says you need to pay when somebody else paid", async () => {
    mockApi({
      "/api/people/": {
        ...COLLECT,
        direction: "pay",
        contributions: [
          {
            ...COLLECT.contributions[0]!,
            direction: "pay",
            paidByName: "Priya",
            paidByIsYou: false,
          },
        ],
      },
    });
    renderWithQuery(<PersonBalance personId="p1" />);

    await screen.findByText("You need to pay");
    expect(screen.getByText("Priya paid for things you benefited from.")).toBeInTheDocument();
    expect(screen.getByText("you owe")).toBeInTheDocument();
  });

  it("explains the balance with the events behind it", async () => {
    mockApi({ "/api/people/": COLLECT });
    renderWithQuery(<PersonBalance personId="p1" />);

    await screen.findByRole("link", { name: "Dinner" });
    // The row opens the whole event, not an internal workspace.
    expect(screen.getByRole("link", { name: "Dinner" })).toHaveAttribute(
      "href",
      "/connections/pay-1",
    );
  });

  it("warns that a recorded refund has not reached the shares yet", async () => {
    mockApi({ "/api/people/": { ...COLLECT, pendingRefundExpenseIds: ["exp-1"] } });
    renderWithQuery(<PersonBalance personId="p1" />);

    await screen.findByText(/this figure is about to change/);
  });

  it("says a settled balance is settled, and whether anything proves it", async () => {
    mockApi({
      "/api/people/": {
        ...COLLECT,
        amount: "0",
        direction: "settled",
        evidenceStatus: "believed_settled_unconfirmed_by_ledger",
      },
    });
    renderWithQuery(<PersonBalance personId="p1" />);

    // Said twice: as the label and as the figure it stands in for.
    await waitFor(() => expect(screen.getAllByText("Settled").length).toBe(2));
    // Never `₹0.00` presented as proof that somebody paid somebody.
    expect(screen.queryByText("₹0.00")).not.toBeInTheDocument();
  });

  it("announces loading, and reports a failure rather than an empty balance", async () => {
    mockApiPending();
    const pending = renderWithQuery(<PersonBalance personId="p1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Working out this balance");
    pending.unmount();

    mockApiFailure("ENTITY_NOT_FOUND", "No such person.", 404);
    renderWithQuery(<PersonBalance personId="p1" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No such person."));
  });
});

/* ------------------------------------------------------------------------ the split */

const EXPENSE = {
  id: "exp-1",
  description: "Dinner",
  category: "food",
  grossAmount: "60000",
  netAmount: "60000",
  currency: "INR",
  occurredAt: "2026-08-02T10:00:00.000Z",
  relationshipType: "shared",
  paidByPersonId: "p0",
  state: "approved",
};

const PEOPLE = [
  { id: "p0", displayName: "Dev", splitwiseUserId: null, isUser: true },
  { id: "p1", displayName: "Priya", splitwiseUserId: null, isUser: false },
];

const PREVIEW: AllocationPreviewResult = {
  expenseId: "exp-1",
  grossAmount: "60000",
  netAmount: "60000",
  method: "equal",
  paidBy: { personId: "p0", name: "Dev", isYou: true },
  shares: [
    {
      beneficiaryType: "person",
      beneficiaryId: "p0",
      name: "Dev",
      isYou: true,
      amount: "30000",
      percentage: null,
      members: null,
    },
    {
      beneficiaryType: "person",
      beneficiaryId: "p1",
      name: "Priya",
      isYou: false,
      amount: "30000",
      percentage: null,
      members: null,
    },
  ],
  obligations: [{ personId: "p1", name: "Priya", amount: "30000", direction: "collect" }],
  noObligationsBecause: null,
  replacesExistingAllocation: false,
  refusal: null,
};

function renderShare(preview: AllocationPreviewResult = PREVIEW) {
  const mock = mockApi({
    "/api/expenses/exp-1/allocation/preview": preview,
    "/api/expenses/exp-1": EXPENSE,
    "/api/people": { people: PEOPLE },
  });
  return { mock, ...renderWithQuery(<ShareExpense expenseId="exp-1" />) };
}

describe("saying who shared an expense", () => {
  it("asks who benefited first, and shows the ledger's own shares", async () => {
    renderShare();

    await screen.findByRole("heading", { name: "Who shared this?" });
    expect(screen.getByText("Who benefited")).toBeInTheDocument();
    // The amounts come back from the preview; nothing here divides ₹600.00 by two.
    await waitFor(() => expect(screen.getAllByText("₹300.00").length).toBeGreaterThan(0));
    expect(screen.getByText("You should collect from Priya")).toBeInTheDocument();
  });

  it("asks the server what a split comes to rather than working it out here", async () => {
    const { mock } = renderShare();
    await waitFor(() => expect(mock.callsTo("/allocation/preview").length).toBeGreaterThan(0));
    expect(mock.callsTo("/allocation/preview")[0]?.method).toBe("POST");
  });

  it("keeps the advanced methods behind a disclosure", async () => {
    renderShare();
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Who shared this?" });
    expect(screen.queryByText("Exact amounts")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Divide it a different way" }));
    expect(screen.getByText("Exact amounts")).toBeInTheDocument();
  });

  it("reads a refusal out before anything is pressed, and blocks saving", async () => {
    renderShare({
      ...PREVIEW,
      shares: [],
      obligations: [],
      refusal: { code: "ALLOCATION_SUM_MISMATCH", message: "The shares do not add up." },
    });

    await screen.findByText("This cannot be saved as it stands.");
    expect(screen.getByText("The shares do not add up.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save who shared it" })).toBeDisabled();
  });

  it("says why nobody would owe anything rather than showing an empty list", async () => {
    renderShare({
      ...PREVIEW,
      obligations: [],
      noObligationsBecause: "This is recorded as something bought for one person.",
    });

    await screen.findByText("This is recorded as something bought for one person.");
  });

  it("states the consequence in the payer's direction before saving", async () => {
    renderShare({ ...PREVIEW, paidBy: { personId: "p1", name: "Priya", isYou: false } });
    const user = userEvent.setup();

    await screen.findByText("What this comes to");
    await user.click(screen.getByRole("button", { name: "Save who shared it" }));

    // Not "they will owe you" — the debt runs to whoever fronted the money (ADR-0006).
    expect(screen.getByText(/will owe their share to Priya/)).toBeInTheDocument();
  });

  it("does not promise a debt the split would not create", async () => {
    // A `personal` or `gift` expense divides without anybody owing anything. The dialog whose
    // whole job is to state the consequence must not say otherwise (ADR-0049).
    renderShare({
      ...PREVIEW,
      obligations: [],
      noObligationsBecause:
        "This is recorded as something bought for one person, so naming anybody else divides " +
        "it without creating a debt.",
    });
    const user = userEvent.setup();

    await screen.findByText("What this comes to");
    await user.click(screen.getByRole("button", { name: "Save who shared it" }));

    expect(screen.getByText(/This records who benefited from it/)).toBeInTheDocument();
    expect(screen.queryByText(/will owe/)).not.toBeInTheDocument();
  });

  it("says plainly that the payer is owed, without contradicting itself", async () => {
    renderShare();
    const user = userEvent.setup();

    await screen.findByText("What this comes to");
    await user.click(screen.getByRole("button", { name: "Save who shared it" }));

    // The payer here *is* the reader, so "not automatically to you" would be a sentence
    // arguing with itself.
    expect(
      screen.getByText(/Everybody named other than you will owe you their share/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not automatically to you/)).not.toBeInTheDocument();
  });

  it("warns that saving would replace a split that already exists", async () => {
    renderShare({ ...PREVIEW, replacesExistingAllocation: true });

    await screen.findByText(/This expense is already divided between people/);
  });

  it("keeps every other way of dividing it one click away", async () => {
    renderShare();
    await screen.findByRole("heading", { name: "Who shared this?" });
    expect(screen.getByRole("link", { name: "More ways to divide it" })).toHaveAttribute(
      "href",
      "/expenses/exp-1",
    );
  });
});
