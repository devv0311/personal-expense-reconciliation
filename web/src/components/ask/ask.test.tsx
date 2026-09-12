import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskPanel } from "@/components/ask/ask-panel";
import { mockApi } from "@/test-support/api-mock";
import { resetNavigation } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

const CAPABILITIES = {
  model: { provider: "anthropic", model: "claude", configured: true },
  queries: [
    {
      kind: "own_spend",
      answers: "the user’s own share of a period’s spending",
      example: "What did I actually spend in August?",
      needsPeriod: true,
      needsPerson: false,
      source: "services.getOwnSpend",
    },
  ],
  knownPeople: ["Friend A"],
  knownCategories: ["food"],
  writes: false,
};

const ANSWER = {
  question: "What did I actually spend in August?",
  plan: {
    kind: "own_spend",
    period: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" },
    personName: null,
    category: null,
    searchTerm: null,
    limit: 20,
    clarification: null,
  },
  confidence: "high",
  modelInfo: { provider: "anthropic", model: "claude", promptVersion: "plan_ledger_query/v1" },
  answer: {
    kind: "own_spend",
    answered: true,
    interpretation:
      "read as: the user’s own share of a period’s spending, 2026-08-01 to 2026-08-31",
    headline: "Your own share came to ₹ 65000 paise.",
    period: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" },
    scope: "your share of every approved expense in the period",
    source: "services.getOwnSpend",
    figures: [
      { label: "Your own share", amount: "65000", count: null, note: null },
      { label: "What you paid out", amount: "130000", count: null, note: null },
    ],
    records: [],
    caveats: ["rejected expenses (invariants.md #20)"],
    uncertainties: [],
    links: [{ label: "Analytics", href: "/analytics" }],
  },
};

function renderAsk(capabilities: unknown = CAPABILITIES, answer: unknown = ANSWER) {
  const api = mockApi({
    "/api/ask/capabilities": capabilities,
    "/api/ask": answer,
  });
  renderWithQuery(<AskPanel />);
  return api;
}

describe("asking the ledger", () => {
  it("says out loud that it only reads", async () => {
    renderAsk();

    await waitFor(() => expect(screen.getByText(/This surface only reads/)).toBeInTheDocument());
  });

  it("leads with how the question was read, before any figure", async () => {
    renderAsk();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Your question"), "What did I spend?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() =>
      expect(screen.getByText(/read as: the user’s own share/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Your own share came to/)).toBeInTheDocument();
  });

  it("names the read every figure came from, and that the model saw none of them", async () => {
    renderAsk();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Your question"), "What did I spend?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Every figure above comes from services\.getOwnSpend/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/saw none of these numbers/)).toBeInTheDocument();
  });

  it("sends only the question — no actor, because nothing happened", async () => {
    const api = renderAsk();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Your question"), "What did I spend?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(api.callsTo("/api/ask").length).toBeGreaterThan(0));
    const posted = api.calls.find((call) => call.method === "POST");
    expect(posted?.body).toEqual({ question: "What did I spend?" });
  });

  it("shows a refusal without a figure when the question is an instruction", async () => {
    renderAsk(CAPABILITIES, {
      ...ANSWER,
      answer: {
        ...ANSWER.answer,
        answered: false,
        kind: "unsupported_write_request",
        headline: "This surface only reads. It cannot record, approve, settle or delete anything.",
        figures: [],
        source: null,
        uncertainties: ["Every consequential act happens on the screen that owns it."],
      },
    });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Your question"), "Mark Friend A as settled.");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    // The form's own standing note says the same thing, which is the point: the refusal is not
    // news, it is the surface behaving as it always says it does.
    await waitFor(() =>
      expect(
        screen.getAllByText(/It cannot record, approve, settle or delete/).length,
      ).toBeGreaterThan(1),
    );
    expect(screen.getByText("No read was run.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Next step")).toBeInTheDocument();
  });

  it("surfaces what the answer does not know rather than burying it", async () => {
    renderAsk(CAPABILITIES, {
      ...ANSWER,
      answer: {
        ...ANSWER.answer,
        uncertainties: ["3 contributing expenses have a refund no allocation reflects yet."],
      },
    });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Your question"), "What did I spend?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() =>
      expect(screen.getByText("What this answer does not know")).toBeInTheDocument(),
    );
    expect(screen.getByText(/no allocation reflects yet/)).toBeInTheDocument();
  });

  it("offers no box at all when no model is configured", async () => {
    renderAsk({
      ...CAPABILITIES,
      model: {
        provider: "none",
        model: "unconfigured",
        configured: false,
        unavailableReason: "ANTHROPIC_API_KEY is not set",
      },
    });

    await waitFor(() =>
      expect(screen.getByText(/Asking is unavailable on this installation/)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Your question")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    // And it says where every figure a question would have reported still lives.
    expect(screen.getByRole("link", { name: "analytics" })).toHaveAttribute("href", "/analytics");
  });

  it("lists what can be asked, with the read behind each", async () => {
    renderAsk();

    await waitFor(() =>
      expect(screen.getAllByText("services.getOwnSpend").length).toBeGreaterThan(0),
    );
  });
});
