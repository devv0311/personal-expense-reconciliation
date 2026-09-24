import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "@/components/connections/connection";
import { mockApi, mockApiFailure, mockApiPending } from "@/test-support/api-mock";
import { CONNECTION, CLASSIFICATION_QUESTION } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

/**
 * The connection view's job is to make one event read as one event.
 *
 * So the tests are mostly about what it must never show: three records as three purchases, a
 * transfer as spending, a proposal as a connection, an empty share list as "nobody owes
 * anything", or an implementation word on the surface a non-technical person reads.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function connectionBody(overrides: Record<string, unknown> = {}) {
  return { ...CONNECTION, ...overrides };
}

function renderConnection(overrides: Record<string, unknown> = {}) {
  mockApi({
    "/api/connections/": connectionBody(overrides),
    "/api/payments/": { history: [] },
    "/api/audit/": { events: [] },
  });
  return renderWithQuery(<Connection paymentId="pay-1" />);
}

describe("one event, however many records", () => {
  it("shows the payment and its records as one group under one count", async () => {
    renderConnection();

    const records = await screen.findByRole("region", { name: "Records for this" });
    expect(within(records).getByText(/One payment, and 2 records/)).toBeInTheDocument();
    // One 'Payment' row, and the supporting records beneath it — never three equal rows.
    expect(within(records).getByText("Payment")).toBeInTheDocument();
    expect(within(records).getByText("Bill or receipt")).toBeInTheDocument();
    expect(within(records).getByText("Screenshot")).toBeInTheDocument();
  });

  it("quotes one spending figure, whatever the records say", async () => {
    renderConnection();
    await screen.findByText("Counted as spending");
    // The API's `spendingContribution`, not a sum of anything on the screen.
    const figures = screen.getAllByText("₹640.00");
    expect(figures.length).toBeGreaterThan(0);
  });

  it("says a record nothing has read has not been read, rather than showing ₹0", async () => {
    renderConnection();
    await screen.findByRole("region", { name: "Records for this" });
    expect(screen.getByText("Not read yet")).toBeInTheDocument();
  });
});

describe("naming the event", () => {
  it("says a title is the bank's own words when nothing better has been established", async () => {
    renderConnection({
      title: { text: "UPI-BLINKIT9821PAYTM", source: "narration" },
      merchantName: null,
    });
    await screen.findByRole("heading", { name: "UPI-BLINKIT9821PAYTM" });
    expect(screen.getByText(/named by your bank, not by you/)).toBeInTheDocument();
  });

  it("calls a fully accounted event accounted for, rather than showing a bare red zero", async () => {
    renderConnection();
    await screen.findByText("everything here is accounted for");
  });
});

describe("what kind of event it is", () => {
  it("never presents a transfer between your own accounts as spending", async () => {
    renderConnection({
      nature: "transfer",
      title: { text: "CARD BILL PAYMENT", source: "narration" },
      countsAsSpending: false,
      whyNotSpending: "This moved money between your own accounts, so it is not spending.",
      spendingContribution: "0",
      expenses: [],
      merchantName: null,
    });

    await screen.findByText("Not counted as spending");
    expect(screen.getAllByText(/moved money between your own accounts/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Counted as spending")).not.toBeInTheDocument();
    expect(screen.getByText("Moving your own money", { exact: false })).toBeInTheDocument();
  });

  it("says a duplicate is the same money, and points at the record that counts", async () => {
    renderConnection({
      nature: "duplicate",
      countsAsSpending: false,
      fullyAccountedFor: false,
      whyNotSpending: "This is the same money recorded twice.",
      spendingContribution: "0",
      duplicate: { isDuplicate: true, ofPaymentId: "pay-0" },
      unaccountedFor: {
        known: false,
        amount: null,
        unknownReason: "This is the same money as another record.",
      },
      expenses: [],
    });

    // Said twice on purpose — beside the figure it replaces, and as the banner explaining why.
    await waitFor(() =>
      expect(screen.getAllByText(/same money as another record/).length).toBeGreaterThan(0),
    );
    expect(screen.getByRole("link", { name: "See the one that counts" })).toHaveAttribute(
      "href",
      "/connections/pay-0",
    );
  });
});

describe("a proposal is a question", () => {
  it("shows why a match looks related and why it might not, in plain sentences", async () => {
    renderConnection();

    const proposals = await screen.findByRole("region", { name: "Possible matches" });
    expect(within(proposals).getByText("Why this looks related")).toBeInTheDocument();
    expect(within(proposals).getByText("The amount is the same.")).toBeInTheDocument();
    expect(within(proposals).getByText("Why it might not be")).toBeInTheDocument();
    expect(within(proposals).getByText("The name on it is a different one.")).toBeInTheDocument();
    expect(within(proposals).getByText("Waiting on you")).toBeInTheDocument();
    // No score, no strength, no matcher version on the surface.
    expect(within(proposals).queryByText(/probable|confidence|matcher/i)).not.toBeInTheDocument();
  });
});

describe("who paid, and who shared", () => {
  it("names somebody else as the payer rather than assuming it was you", async () => {
    renderConnection();
    await screen.findByText("Paid by Flatmate A");
    expect(screen.getByText("Shared with")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText(/Everybody other than Flatmate A owes them/)).toBeInTheDocument();
  });

  it("does not claim a debt for an expense that cannot create one", async () => {
    // Dividing a `personal` or `gift` expense records who benefited and creates no obligation
    // at all. The API decides that; this screen must never restate it as "everybody owes you",
    // which is what the balances behind the row would then deny.
    renderConnection({
      expenses: [
        {
          ...CONNECTION.expenses[0]!,
          obligationNote:
            "This is recorded as something bought for one person, so naming anybody else " +
            "divides it without creating a debt.",
        },
      ],
    });

    await screen.findByText(/without creating a debt/);
    expect(screen.queryByText(/owes them their share/)).not.toBeInTheDocument();
  });

  it("says nobody has been named yet instead of showing an empty share list", async () => {
    renderConnection({
      expenses: [
        {
          ...CONNECTION.expenses[0]!,
          shares: null,
          sharesUnknownReason:
            "Nobody has been named as having benefited from this yet, so it cannot say who owes whom.",
        },
      ],
    });

    await screen.findByText(/Nobody has been named/);
    expect(screen.queryByText("Shared with")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Say who shared it" })).toBeInTheDocument();
  });
});

describe("what still needs you", () => {
  it("asks the question and keeps the decision behind the existing inspector", async () => {
    renderConnection({ openQuestions: [CLASSIFICATION_QUESTION] });
    const user = userEvent.setup();

    await screen.findByText("What was this payment for?");
    // Nothing on the card decides anything.
    expect(screen.queryByRole("button", { name: /^Accept/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Answer this" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Accept this proposal" })).toBeInTheDocument(),
    );
  });
});

describe("implementation words stay behind Details", () => {
  it("keeps the stored states out of the summary", async () => {
    renderConnection();
    await screen.findByRole("region", { name: "Records for this" });

    // The narration and the states exist — inside the disclosure, which is closed by default.
    const disclosure = screen.getByText(/Details and history/);
    expect(disclosure).toBeInTheDocument();
    expect(screen.queryByText("Normalization")).not.toBeInTheDocument();
    expect(screen.queryByText("Classification")).not.toBeInTheDocument();
    expect(screen.queryByText("Evidence observation")).not.toBeInTheDocument();
    expect(screen.queryByText("batch-1")).not.toBeVisible();
  });

  it("keeps the payment workspace one click away", async () => {
    renderConnection();
    await screen.findByRole("region", { name: "Records for this" });
    expect(screen.getByRole("link", { name: "Open the payment workspace" })).toHaveAttribute(
      "href",
      "/payments/pay-1",
    );
  });
});

/**
 * The decision belongs beside the reasons for it.
 *
 * Before this, reading why two records looked like one thing and *saying whether they are*
 * happened on two different screens — the second one built around a signal-by-signal table and
 * a payment named by eight hexadecimal digits. These assert the plain path exists, that it
 * states the permanence before the confirm rather than after, and that a proposal somebody has
 * already answered offers no buttons.
 */
describe("agreeing with a suggested match", () => {
  it("offers both answers beside the reasons, in plain words", async () => {
    renderConnection();
    await screen.findByRole("region", { name: "Possible matches" });

    expect(screen.getByRole("button", { name: "Yes, they go together" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No, different thing" })).toBeInTheDocument();
  });

  it("says the connection is permanent before the confirm, and names the event", async () => {
    const user = userEvent.setup();
    renderConnection();
    await screen.findByRole("region", { name: "Possible matches" });

    await user.click(screen.getByRole("button", { name: "Yes, they go together" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/permanent/)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot later be moved/)).toBeInTheDocument();
    // What it does NOT do is as important as what it does.
    expect(
      within(dialog).getByText(/does not decide what the payment was for/),
    ).toBeInTheDocument();
  });

  it("sends the decision the person gave, not an approval of anything else", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "/api/connections/": connectionBody(),
      "/api/evidence/matches/": { candidate: { evidenceId: "ev-3" } },
      "/api/payments/": { history: [] },
      "/api/audit/": { events: [] },
    });
    renderWithQuery(<Connection paymentId="pay-1" />);
    await screen.findByRole("region", { name: "Possible matches" });

    await user.click(screen.getByRole("button", { name: "No, different thing" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Not related" }));

    await waitFor(() => expect(api.callsTo("/api/evidence/matches/").length).toBe(1));
    expect(api.bodyOf("/api/evidence/matches/")).toMatchObject({ decision: "dismiss" });
  });

  it("offers no answer for a proposal somebody has already answered", async () => {
    renderConnection({
      proposals: [
        {
          ...CONNECTION.proposals[0],
          status: "accepted",
          decidedAt: "2026-08-09T09:00:00.000Z",
        },
      ],
    });
    await screen.findByRole("region", { name: "Possible matches" });

    expect(screen.queryByRole("button", { name: "Yes, they go together" })).toBeNull();
  });
});

describe("loading, empty and error", () => {
  it("announces loading without drawing a figure", () => {
    mockApiPending();
    renderWithQuery(<Connection paymentId="pay-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Putting this payment's records together");
  });

  it("invites the first supporting record when there are none", async () => {
    renderConnection({ supportingRecords: [], proposals: [] });
    await screen.findByText(/One record so far/);
    expect(
      screen.getByRole("link", { name: /Add a bill, a receipt or a screenshot/ }),
    ).toHaveAttribute("href", "/add");
  });

  it("reports a failure instead of rendering an empty event", async () => {
    mockApiFailure("ENTITY_NOT_FOUND", "No such payment.", 404);
    renderWithQuery(<Connection paymentId="pay-1" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No such payment."));
  });
});
