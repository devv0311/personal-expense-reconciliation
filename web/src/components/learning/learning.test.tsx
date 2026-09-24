import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatternsToApprove } from "@/components/learning/patterns-to-approve";
import { PurposeChoice } from "@/components/attention/purpose-choice";
import { mockApi, mockApiFailure, mockApiPending } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { AttentionSuggestion, LearnedRuleProposal } from "@/lib/types";

/**
 * The surface where invisible learning becomes something a person can decline.
 *
 * Every fixture is invented. The tests that carry the weight are about what the screen promises:
 * that the wording being approved is on screen before the button, that the dialog says an
 * approved pattern suggests rather than files, and that merely looking writes nothing.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const PROPOSAL: LearnedRuleProposal = {
  id: "learned:HARBOUR CAFE:Dining",
  suggestedName: "HARBOUR CAFE is Dining",
  wording: "HARBOUR CAFE",
  operator: "contains",
  category: "Dining",
  reason: "You have filed 2 payments worded like this as Dining.",
  examples: [
    { paymentId: "pay-1", occurredAt: "2026-08-09T00:00:00.000Z", narration: "HARBOUR CAFE" },
    { paymentId: "pay-2", occurredAt: "2026-08-05T00:00:00.000Z", narration: "HARBOUR CAFE" },
  ],
  reach: { alreadyFiled: 2, wouldAlsoMatch: 0, examplesOfNewMatches: [] },
};

/** The same pattern, but wide enough to catch something nobody meant. */
const WIDE: LearnedRuleProposal = {
  ...PROPOSAL,
  id: "learned:CAFE:Dining",
  wording: "CAFE",
  reach: {
    alreadyFiled: 2,
    wouldAlsoMatch: 7,
    examplesOfNewMatches: [
      {
        paymentId: "pay-9",
        occurredAt: "2026-08-12T00:00:00.000Z",
        narration: "CAFE HARDWARE SUPPLY",
      },
    ],
  },
};

function writes(): unknown[] {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
}

describe("offering a pattern", () => {
  it("shows the wording, the category and the payments it came from", async () => {
    mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    renderWithQuery(<PatternsToApprove />);

    await screen.findByText(/Always file/);
    // The thing being approved has to be legible before the button, not after.
    expect(screen.getAllByText(/HARBOUR CAFE/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(PROPOSAL.reason)).toBeInTheDocument();
    expect(screen.getByText("Because you filed these")).toBeInTheDocument();
  });

  it("writes nothing by being looked at", async () => {
    mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    renderWithQuery(<PatternsToApprove />);

    await screen.findByText(/Always file/);
    expect(writes()).toHaveLength(0);
  });

  it("states what an approved pattern may and may not do, before the button", async () => {
    mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(<PatternsToApprove />);

    await user.click(await screen.findByRole("button", { name: "Use this from now on" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("suggested");
    // The sentence that stops somebody thinking they switched on automatic filing.
    expect(dialog).toHaveTextContent(/does not file anything/i);
    expect(dialog).toHaveTextContent(/still be asked about every payment/i);
    // Reading the dialog is not approving it.
    expect(writes()).toHaveLength(0);
  });

  it("approves only on the button, and sends the proposal id", async () => {
    const api = mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(<PatternsToApprove />);

    await user.click(await screen.findByRole("button", { name: "Use this from now on" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Use this pattern" }));

    // `bodyOf` asserts a single matching call, and this path is read-then-write-then-refetch,
    // so the POST is picked out by method rather than by URL.
    await waitFor(() => expect(writes()).toHaveLength(1));
    const posted = api.callsTo("/api/rule-proposals").find((call) => call.method === "POST");
    expect(posted?.body).toMatchObject({ proposalId: PROPOSAL.id, actor: "user" });
  });

  it("offers a way to decline it, which ADR-0065 made a recorded decision", async () => {
    mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    renderWithQuery(<PatternsToApprove />);

    await screen.findByText(/Always file/);
    expect(screen.getByRole("button", { name: /don.t suggest this/i })).toBeInTheDocument();
  });

  it("distinguishes nothing-confirmed-yet from nothing-worth-a-rule", async () => {
    mockApi({ "/api/rule-proposals": { proposals: [], confirmationsRead: 0, dismissed: [] } });
    const { unmount } = renderWithQuery(<PatternsToApprove />);
    await screen.findByText(/Once you have said what a few payments were for/);
    unmount();

    mockApi({ "/api/rule-proposals": { proposals: [], confirmationsRead: 40, dismissed: [] } });
    renderWithQuery(<PatternsToApprove />);
    await screen.findByText(/Read 40 payments you have already filed/);
  });

  it("announces loading without claiming a result", () => {
    mockApiPending();
    renderWithQuery(<PatternsToApprove />);
    expect(screen.getByRole("status")).toHaveTextContent("Looking at what you have already filed");
  });

  it("reports a failure rather than letting it read as nothing to suggest", async () => {
    mockApiFailure("INTERNAL", "Ledger unavailable", 500);
    renderWithQuery(<PatternsToApprove />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("No patterns to suggest yet.")).not.toBeInTheDocument();
  });
});

const SUGGESTION: AttentionSuggestion = {
  inferenceId: "inf-1",
  category: "Dining",
  confidence: "high",
  why: ['Your rule "HARBOUR CAFE is Dining" matches this wording: "HARBOUR CAFE".'],
  alternatives: [],
  everyCategory: ["Dining", "Groceries", "Other"],
  countsAsPurchase: true,
  appliedRule: {
    ruleId: "rule-1",
    ruleName: "HARBOUR CAFE is Dining",
    wording: "HARBOUR CAFE",
    category: "Dining",
    why: 'Your rule "HARBOUR CAFE is Dining" matches this wording: "HARBOUR CAFE".',
  },
};

describe("a suggestion an approved pattern led", () => {
  it("names the rule and links to where it can be changed", async () => {
    mockApi({});
    renderWithQuery(<PurposeChoice suggestion={SUGGESTION} description="HARBOUR CAFE" />);

    expect(screen.getByText(/This came from your own rule/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change or switch it off" })).toHaveAttribute(
      "href",
      "/automation",
    );
  });

  it("still requires the person to confirm the payment", async () => {
    mockApi({});
    const user = userEvent.setup();
    renderWithQuery(<PurposeChoice suggestion={SUGGESTION} description="HARBOUR CAFE" />);

    // A rule may write the suggestion; it may never decide the money. The confirmation is a
    // dialog, exactly as it is for a reading no rule touched.
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Yes, dining/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("says nothing about a rule when none matched", () => {
    mockApi({});
    renderWithQuery(
      <PurposeChoice
        suggestion={{ ...SUGGESTION, appliedRule: null }}
        description="HARBOUR CAFE"
      />,
    );

    expect(screen.queryByText(/This came from your own rule/)).not.toBeInTheDocument();
  });
});

describe("what a pattern would reach (ADR-0065)", () => {
  it("says plainly when it only matches what was already filed", async () => {
    mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    renderWithQuery(<PatternsToApprove />);

    await screen.findByText(/matches only the 2 payments you already filed/);
  });

  it("leads with what it would newly match, and shows which ones", async () => {
    // The only thing on screen that tells a wide pattern from a well-aimed one.
    mockApi({ "/api/rule-proposals": { proposals: [WIDE], confirmationsRead: 12, dismissed: [] } });
    renderWithQuery(<PatternsToApprove />);

    await screen.findByText(/would also start suggesting/);
    expect(screen.getByText("7 other payments")).toBeInTheDocument();
    expect(screen.getByText("CAFE HARDWARE SUPPLY")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 7/)).toBeInTheDocument();
  });

  it("repeats the reach in the approval dialog", async () => {
    mockApi({ "/api/rule-proposals": { proposals: [WIDE], confirmationsRead: 12, dismissed: [] } });
    const user = userEvent.setup();
    renderWithQuery(<PatternsToApprove />);

    await user.click(await screen.findByRole("button", { name: "Use this from now on" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/7 other payments/);
  });
});

describe("declining a pattern (ADR-0065)", () => {
  it("requires a reason before it can be confirmed", async () => {
    mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(<PatternsToApprove />);

    await user.click(await screen.findByRole("button", { name: /don.t suggest this/i }));
    const dialog = await screen.findByRole("dialog");
    // A decision nobody can account for later is not one.
    expect(within(dialog).getByRole("button", { name: /don.t suggest this/i })).toBeDisabled();
  });

  it("states that nothing about the filed payments changes", async () => {
    mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(<PatternsToApprove />);

    await user.click(await screen.findByRole("button", { name: /don.t suggest this/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/changes nothing about the 2 payments you already filed/i);
  });

  it("sends the reason with the dismissal", async () => {
    const api = mockApi({
      "/api/rule-proposals": { proposals: [PROPOSAL], confirmationsRead: 12, dismissed: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(<PatternsToApprove />);

    await user.click(await screen.findByRole("button", { name: /don.t suggest this/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "Sometimes groceries.");
    await user.click(within(dialog).getByRole("button", { name: /don.t suggest this/i }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    const posted = api
      .callsTo("/api/rule-proposals/dismiss")
      .find((call) => call.method === "POST");
    expect(posted?.body).toMatchObject({
      proposalId: PROPOSAL.id,
      reason: "Sometimes groceries.",
    });
  });

  it("lists what was turned down, with the reason, and offers it back", async () => {
    const api = mockApi({
      "/api/rule-proposals": {
        proposals: [],
        confirmationsRead: 12,
        dismissed: [
          {
            proposalKey: "learned:HARBOUR CAFE:Dining",
            wording: "HARBOUR CAFE",
            category: "Dining",
            dismissedAt: "2026-08-12T00:00:00.000Z",
            dismissedBy: "user",
            reason: "Sometimes groceries.",
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<PatternsToApprove />);

    await screen.findByText("Patterns you turned down");
    expect(screen.getByText(/Sometimes groceries/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Offer it again" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const posted = api
      .callsTo("/api/rule-proposals/restore")
      .find((call) => call.method === "POST");
    expect(posted?.body).toMatchObject({ proposalKey: "learned:HARBOUR CAFE:Dining" });
  });
});
