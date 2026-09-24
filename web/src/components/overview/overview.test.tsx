import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Overview } from "@/components/overview/overview";
import { mockApi } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";

/**
 * The front page's whole job is to be trusted at a glance, so the tests are about what it
 * refuses to say: a zero it cannot stand behind, a total it only partly read, or a next step
 * that is not the most urgent one.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function overviewBody(overrides: Record<string, unknown> = {}) {
  return {
    spending: {
      period: { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
      total: { known: true, amount: "400000" },
      categories: [{ category: "food", netTotal: "400000", expenseCount: 2 }],
      caveats: { excludes: ["transfers between own accounts"] },
    },
    unexplained: {
      total: { known: true, amount: "169000" },
      movementCount: 2,
      scanned: 10,
      complete: true,
      movements: [
        {
          paymentId: "pay-2",
          occurredAt: "2026-09-03T10:00:00.000Z",
          description: "UPI-ANOTHER MERCHANT",
          amount: "45000",
          direction: "debit",
          status: "needs_context",
        },
      ],
    },
    attention: { total: 0, reviewQueueTotal: 0, counts: {} },
    // Nothing is waiting to be read, so the front page leads with figures rather than with the
    // analysis prompt. A fixture that omitted this would exercise a state the API never sends.
    readiness: { recordsAwaitingAnalysis: 0, documentsAwaitingAnalysis: 0 },
    people: {
      toCollect: { known: true, amount: "60000" },
      toPay: { known: true, amount: "0" },
      counterparties: [
        {
          personId: "p1",
          displayName: "Priya",
          netBalance: "60000",
          contributingExpenseCount: 1,
        },
      ],
      settled: [],
    },
    recent: [
      {
        paymentId: "pay-1",
        occurredAt: "2026-09-02T10:00:00.000Z",
        description: "UPI-SAMPLE MERCHANT",
        amount: "124000",
        direction: "debit",
        status: "needs_context",
      },
    ],
    empty: false,
    ...overrides,
  };
}

describe("the overview", () => {
  it("still reports the four figures a person came to find, below the decision", async () => {
    mockApi({ "/api/overview": overviewBody() });
    renderWithQuery(<Overview />);

    await waitFor(() => expect(screen.getByText("Spent this period")).toBeInTheDocument());
    expect(screen.getByText("Not yet accounted for")).toBeInTheDocument();
    expect(screen.getByText("To collect")).toBeInTheDocument();
    expect(screen.getByText("To pay")).toBeInTheDocument();
  });

  it("puts the one decision above every figure, not beneath them", async () => {
    // The order is the design: four numbers of equal weight ask the reader to work out which
    // one matters, which is the job this page exists to do for them.
    mockApi({ "/api/overview": overviewBody({ attention: { total: 3, counts: {} } }) });
    const { container } = renderWithQuery(<Overview />);

    await waitFor(() =>
      expect(screen.getByText("3 things need your decision")).toBeInTheDocument(),
    );
    const decision = screen.getByText("3 things need your decision");
    const figure = screen.getByText("Spent this period");
    // `DOCUMENT_POSITION_FOLLOWING` — the figure comes after the decision in document order.
    expect(decision.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(container.querySelectorAll(".text-figure").length).toBe(1);
  });

  it("says 'Needs review' rather than a figure the ledger cannot stand behind", async () => {
    // Rule 2 of web/CLAUDE.md on the screen where breaking it would do the most damage: a
    // dashboard reading ₹0 unexplained is indistinguishable from one that stopped looking.
    mockApi({
      "/api/overview": overviewBody({
        unexplained: {
          total: {
            known: false,
            amount: "169000",
            unknownReason: "There are more movements on record than this summary reads in one pass",
          },
          movementCount: 2,
          scanned: 2,
          complete: false,
        },
      }),
    });
    renderWithQuery(<Overview />);

    await waitFor(() => expect(screen.getByText("Needs review")).toBeInTheDocument());
    expect(screen.getByText(/more movements on record/)).toBeInTheDocument();
    expect(screen.queryByText("₹1,690.00")).not.toBeInTheDocument();
  });

  it("puts decisions ahead of unexplained money when both are outstanding", async () => {
    mockApi({ "/api/overview": overviewBody({ attention: { total: 3, counts: {} } }) });
    renderWithQuery(<Overview />);

    await waitFor(() =>
      expect(screen.getByText("3 things need your decision")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Start with the first one" })).toHaveAttribute(
      "href",
      "/needs-attention",
    );
  });

  it("asks for supporting records when nothing needs a decision but money is unplaced", async () => {
    mockApi({ "/api/overview": overviewBody() });
    renderWithQuery(<Overview />);

    await waitFor(() =>
      expect(screen.getByText("Some payments have no story yet")).toBeInTheDocument(),
    );
  });

  it("invites a first record instead of showing four zeroes about nothing", async () => {
    mockApi({
      "/api/overview": overviewBody({
        empty: true,
        recent: [],
        people: {
          toCollect: { known: true, amount: "0" },
          toPay: { known: true, amount: "0" },
          counterparties: [],
        },
      }),
    });
    renderWithQuery(<Overview />);

    await waitFor(() =>
      expect(screen.getByText("Nothing has been added yet.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Add your first records" })).toHaveAttribute(
      "href",
      "/add",
    );
    expect(screen.queryByText("Spent this period")).not.toBeInTheDocument();
  });

  it("names who owes whom in the direction a person reads it", async () => {
    mockApi({ "/api/overview": overviewBody() });
    renderWithQuery(<Overview />);

    await waitFor(() => expect(screen.getByText("Priya")).toBeInTheDocument());
    expect(screen.getByText("owes you")).toBeInTheDocument();
  });

  it("flags a payment nothing accounts for, in words rather than a state name", async () => {
    mockApi({ "/api/overview": overviewBody() });
    renderWithQuery(<Overview />);

    await waitFor(() => expect(screen.getByText("needs context")).toBeInTheDocument());
    // No enum, no id, no parser name on the primary surface.
    expect(screen.queryByText(/cash_flow|normalized|import_batch/)).not.toBeInTheDocument();
  });

  it("offers to read records nobody has read yet, and does not read them on its own", async () => {
    // This is the behaviour that changed on 2026-09-19 and the reason the test is here. The
    // panel used to fire a ledger-wide `POST /api/analysis` from an effect the moment this
    // component mounted — a write against every record on file, caused by somebody opening a
    // page. Rendering must now be inert; the run happens on a press, behind a dialog.
    mockApi({
      "/api/overview": overviewBody({
        readiness: { recordsAwaitingAnalysis: 2, documentsAwaitingAnalysis: 0 },
      }),
      "/api/analysis": () => {
        throw new Error("analysis must not run without a person pressing the button");
      },
    });
    renderWithQuery(<Overview />);

    await waitFor(() =>
      expect(screen.getByText("2 records have not been read yet")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Read them now" })).toBeInTheDocument();
    // The hard assertion: merely viewing the front page issued no write of any kind.
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      0,
    );
  });

  it("states the consequence before reading them, and keeps what it found afterwards", async () => {
    // Two properties together: the run is behind a `DecisionDialog` that says what it will do,
    // and its result survives its own success. A run reads the waiting records, so the count
    // that put the panel there falls to zero the moment it succeeds — a panel bound to that
    // count would destroy its own result, including the stage that could not run.
    let waiting = 2;
    mockApi({
      "/api/overview": () =>
        overviewBody({
          readiness: { recordsAwaitingAnalysis: waiting, documentsAwaitingAnalysis: 0 },
        }),
      "/api/analysis": () => {
        waiting = 0;
        return {
          recordsChecked: 2,
          connectionsFound: 0,
          suggestionsReady: 0,
          questionsForYou: 1,
          notUnderstood: 2,
          complete: false,
          stages: [
            {
              name: "read_records",
              status: "done",
              summary: "Read 2 new records, and recognised 0 of them by name.",
              recordsTouched: 2,
            },
            {
              name: "work_out_purpose",
              status: "skipped",
              summary: "Nothing in these records said what they were for.",
              unfinishedReason: "Nothing was guessed about any of them.",
              recordsTouched: 0,
            },
            {
              name: "connect_records",
              status: "done",
              summary: "Every bill on file is already connected to a payment.",
              recordsTouched: 0,
            },
          ],
        };
      },
      "/api/review": { items: [], counts: {}, total: 0, truncated: false },
      "/api/attention": { items: [], counts: {}, reviewQueueTotal: 0, total: 0, truncated: false },
      "/api/payments": { payments: [], total: 0 },
      "/api/expenses": { expenses: [], total: 0 },
      "/api/spending": overviewBody(),
      "/api/connections": {},
      "/api/people": { people: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(<Overview />);

    await user.click(await screen.findByRole("button", { name: "Read them now" }));

    // The dialog names what the press does before it does it, and what it will not do.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("all 2 records");
    expect(dialog).toHaveTextContent(/nobody owes anything until you say so/i);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      0,
    );

    await user.click(within(dialog).getByRole("button", { name: "Read them" }));

    await waitFor(() =>
      expect(screen.getByText("I found one thing to confirm")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Review suggestions" })).toHaveAttribute(
      "href",
      "/needs-attention",
    );

    // The run's own account of itself survives the refetch that follows it — including the
    // stage that could not finish, which is why the screen must not read as "all done".
    expect(screen.getByText("Not everything could be worked out:")).toBeInTheDocument();
    expect(screen.getByText("Nothing was guessed about any of them.")).toBeInTheDocument();
  });

  it("shows the API's failure rather than an empty dashboard", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "INTERNAL", message: "Ledger unavailable" } }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    ) as unknown as typeof global.fetch;
    renderWithQuery(<Overview />);

    await waitFor(() => expect(screen.getByText(/Ledger unavailable/)).toBeInTheDocument());
  });
});
