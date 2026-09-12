import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteChangeDetail } from "@/components/splitwise/remote-change-detail";
import { RemoteChanges } from "@/components/splitwise/remote-changes";
import { mockApi } from "@/test-support/api-mock";
import { PEOPLE } from "@/test-support/fixtures";
import { resetNavigation } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

const DRIFT_CHANGE = {
  id: "change-1",
  remoteReadId: "read-1",
  lastObservedReadId: "read-1",
  kind: "remote_expense_amount_changed",
  effect: "record_drift",
  summary: "Their Splitwise entry now reads 120000 paise where this ledger sent 90000.",
  consequence:
    "Accepting records what Splitwise now holds on the sync row and marks it drifted. Your " +
    "expense, its allocation and every balance stay exactly as they are.",
  readStatus: "complete",
  readDetail: null,
  personAId: PEOPLE[0]!.id,
  personBId: PEOPLE[1]!.id,
  expenseId: "expense-1",
  settlementId: null,
  externalReference: "sw-expense-1",
  externalUserReference: null,
  amount: "30000",
  localSnapshot: { syncedAmount: "90000" },
  remoteSnapshot: { totalAmount: "120000" },
  subjects: [],
  firstObservedAt: "2026-09-10T10:00:00.000Z",
  lastObservedAt: "2026-09-12T10:00:00.000Z",
  status: "proposed",
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  appliedEffect: null,
  appliedTargetId: null,
  supersededAt: null,
  supersededByChangeId: null,
};

const PARTIAL_READ = {
  id: "read-2",
  runAt: "2026-09-12T10:00:00.000Z",
  externalReadStatus: "partial",
  externalReadDetail: "Read stopped at the page cap.",
  pairsRead: 3,
  pairsUnchecked: 1,
  changesCreated: 0,
  changesReobserved: 0,
  changesSuperseded: 0,
};

const COMPLETE_READ = { ...PARTIAL_READ, externalReadStatus: "complete", externalReadDetail: null };

function renderList(changes: unknown[], reads: unknown[] = [COMPLETE_READ]) {
  const api = mockApi({
    "/api/splitwise/remote-changes": { changes },
    "/api/splitwise/remote-reads": { reads },
  });
  renderWithQuery(<RemoteChanges />);
  return api;
}

describe("changes made in Splitwise", () => {
  it("shows what accepting does, quoting the API rather than deriving it", async () => {
    renderList([DRIFT_CHANGE]);

    // `ResponsiveTable` renders a table and a stacked card view, so each cell appears twice.
    await waitFor(() =>
      expect(screen.getAllByText("They changed the amount").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("Records what they hold").length).toBeGreaterThan(0);
  });

  it("says an incomplete read reported nothing as deleted", async () => {
    renderList([], [PARTIAL_READ]);

    await waitFor(() =>
      expect(screen.getByText(/The last check read partial\./)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/an entry missing from a page is an entry nobody looked for/),
    ).toBeInTheDocument();
  });

  it("does not call an empty list agreement", async () => {
    renderList([], [COMPLETE_READ]);

    await waitFor(() =>
      expect(
        screen.getByText(/not a claim that the two ledgers agree about everything/),
      ).toBeInTheDocument(),
    );
  });

  it("says nothing has been checked when nothing has", async () => {
    renderList([], []);

    await waitFor(() =>
      expect(screen.getByText(/Nothing has been checked yet/)).toBeInTheDocument(),
    );
  });
});

function renderDetail(
  overrides: Record<string, unknown> = {},
  detail: Record<string, unknown> = {},
) {
  const api = mockApi({
    "/api/splitwise/remote-changes/change-1": {
      change: { ...DRIFT_CHANGE, ...overrides },
      discoveredBy: COMPLETE_READ,
      lastObservedBy: COMPLETE_READ,
      needsTarget: false,
      acceptable: true,
      ...detail,
    },
    "/api/people": { people: PEOPLE },
    "/api/expenses": { expenses: [], total: 0, limit: 50, offset: 0 },
    "/api/settlements": { settlements: [], total: 0, limit: 100, offset: 0 },
  });
  renderWithQuery(<RemoteChangeDetail changeId="change-1" />);
  return api;
}

describe("one change in detail", () => {
  it("states the consequence before the button, in the API's own words", async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText("What accepting does")).toBeInTheDocument());
    expect(screen.getAllByText(/stay exactly as they are/).length).toBeGreaterThan(0);
  });

  it("keeps both snapshots on the screen", async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText("This ledger")).toBeInTheDocument());
    expect(screen.getByText("Splitwise")).toBeInTheDocument();
  });

  it("requires a reason before it will accept", async () => {
    renderDetail();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(screen.getByRole("button", { name: "Accept it" })).toBeDisabled();
  });

  it("sends the reason with the decision", async () => {
    const api = renderDetail();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await user.type(screen.getByLabelText(/Why you are accepting this/), "They edited it.");
    await user.click(screen.getByRole("button", { name: "Accept it" }));

    await waitFor(() => expect(api.callsTo("/decision")).toHaveLength(1));
    expect(api.bodyOf("/decision")).toMatchObject({
      decision: "accept",
      reason: "They edited it.",
      actor: "user",
    });
  });

  it("offers no accept at all when there is nothing to apply", async () => {
    renderDetail(
      {
        kind: "remote_duplicate_candidate",
        effect: "none",
        consequence: "There is nothing to accept.",
      },
      { acceptable: false },
    );

    await waitFor(() => expect(screen.getByText("There is nothing to accept")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("blocks an adoption until the local record is named", async () => {
    renderDetail(
      { kind: "remote_expense_unlinked", effect: "adopt_expense_link", expenseId: null },
      { needsTarget: true },
    );
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await user.type(screen.getByLabelText(/Why you are accepting this/), "It is that lunch.");

    // A reason alone is not enough: which expense this is, is a judgement the screen must not
    // default (ADR-0056).
    expect(screen.getByRole("button", { name: "Accept it" })).toBeDisabled();
    expect(screen.getByText(/Adopting creates no expense/)).toBeInTheDocument();
  });

  it("shows the decision already on record instead of offering it again", async () => {
    renderDetail({
      status: "accepted",
      decidedAt: "2026-09-12T11:00:00.000Z",
      decidedBy: "user",
      decisionReason: "Recorded what their side says.",
      appliedEffect: "record_drift",
    });

    await waitFor(() => expect(screen.getByText("The decision on record")).toBeInTheDocument());
    expect(screen.getByText("Recorded what their side says.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  it("says a superseded change is history rather than a decision to make", async () => {
    renderDetail({ supersededAt: "2026-09-12T12:00:00.000Z" });

    await waitFor(() =>
      expect(screen.getByText(/A later check superseded this change\./)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });
});
