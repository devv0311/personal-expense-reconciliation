import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditFindingDetail } from "@/components/splitwise/finding-detail";
import { mockApi, mockApiFailure, mockApiPending, type ApiMock } from "@/test-support/api-mock";
import {
  AUDIT_RUN_COMPLETE,
  AUDIT_RUN_FAILED_READ,
  FINDING,
  FINDING_DETAIL,
  PEOPLE,
  UNATTRIBUTED_FINDING,
} from "@/test-support/fixtures";
import { resetNavigation } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { SplitwiseAuditRun } from "@/lib/types";
import SplitwisePage from "@/app/splitwise/page";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

function renderAuditPage(
  runs: unknown[],
  findings: unknown[] = [FINDING, UNATTRIBUTED_FINDING],
): ApiMock {
  const api = mockApi({
    "/api/splitwise/audit-findings": { findings },
    "/api/splitwise/audits": { runs },
  });
  renderWithQuery(<SplitwisePage />);
  return api;
}

describe("the Splitwise audit screen", () => {
  it("calls a failed read an incomplete check rather than agreement", async () => {
    renderAuditPage([AUDIT_RUN_FAILED_READ]);

    await waitFor(() =>
      expect(
        screen.getByText(/Splitwise read: failed — this was an incomplete check, not agreement/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/No finding is retired by a read that could not be made/),
    ).toBeInTheDocument();
  });

  it("says absence means something only when the read was complete", async () => {
    renderAuditPage([AUDIT_RUN_COMPLETE]);

    await waitFor(() =>
      expect(screen.getByText(/Absence of a finding means something here/)).toBeInTheDocument(),
    );
  });

  it("keeps a disagreement, a limitation and an incomplete check visibly different", async () => {
    renderAuditPage(
      [AUDIT_RUN_COMPLETE],
      [FINDING, { ...FINDING, id: "f3", findingClass: "limitation" }],
    );

    await waitFor(() => expect(screen.getByText("Disagreement")).toBeInTheDocument());
    expect(screen.getByText("Observability limit")).toBeInTheDocument();
  });

  it("says an empty findings list is not the two ledgers agreeing", async () => {
    renderAuditPage([AUDIT_RUN_FAILED_READ], []);

    await waitFor(() =>
      expect(
        screen.getByText(/That is not the same as the two ledgers agreeing/),
      ).toBeInTheDocument(),
    );
  });

  it("says out loud that nothing on the screen writes to Splitwise", async () => {
    renderAuditPage([AUDIT_RUN_COMPLETE]);

    await waitFor(() =>
      expect(screen.getByText(/Nothing here writes to Splitwise/)).toBeInTheDocument(),
    );
  });

  it("announces a loading state, then a retryable error", async () => {
    mockApiPending();
    const { unmount } = renderWithQuery(<SplitwisePage />);
    expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0);
    unmount();

    mockApiFailure("INTERNAL_ERROR", "audit history unavailable");
    renderWithQuery(<SplitwisePage />);
    await waitFor(() =>
      expect(screen.getAllByText(/audit history unavailable/).length).toBeGreaterThan(0),
    );
  });
});

function renderFinding(detail: unknown = FINDING_DETAIL): ApiMock {
  const api = mockApi({
    "/api/splitwise/audit-findings/find-1/review": {
      findingId: "find-1",
      reviewStatus: "resolved",
    },
    "/api/splitwise/audit-findings/find-1": detail,
    "/api/people": { people: PEOPLE },
  });
  renderWithQuery(<AuditFindingDetail findingId="find-1" />);
  return api;
}

describe("one audit finding", () => {
  it("shows both compared snapshots and the evidence, so the comparison stays checkable", async () => {
    renderFinding();

    await waitFor(() => expect(screen.getByText("This ledger")).toBeInTheDocument());
    expect(screen.getByText("Splitwise")).toBeInTheDocument();
    expect(screen.getByText("Evidence the audit used")).toBeInTheDocument();
    expect(screen.getByText(/"readStatus": "unsupported"/)).toBeInTheDocument();
  });

  it("states the part of the gap the finding actually accounts for", async () => {
    renderFinding();

    await waitFor(() => expect(screen.getByText("Accounts for")).toBeInTheDocument());
    expect(screen.getByText(/Attribution is earned, never assumed/)).toBeInTheDocument();
    expect(screen.getByText(/−₹1,600.00/)).toBeInTheDocument();
  });

  it("never pins an unattributed mismatch on a record", async () => {
    renderFinding({ finding: UNATTRIBUTED_FINDING, history: FINDING_DETAIL.history });

    await waitFor(() =>
      expect(
        screen.getByText(/stays unattributed rather than being pinned on whichever record/i),
      ).toBeInTheDocument(),
    );
  });

  it("names the people rather than showing their ids", async () => {
    renderFinding();

    await waitFor(() => expect(screen.getByText("Dev (you) and Alex")).toBeInTheDocument());
    expect(screen.queryByText("p-alex")).not.toBeInTheDocument();
  });

  it("requires a reason to resolve, and says the decision reaches Splitwise not at all", async () => {
    const api = renderFinding();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mark resolved" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Mark resolved" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/Nothing about this call reaches Splitwise/),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Mark resolved" });
    expect(confirm).toBeDisabled();
    expect(api.callsTo("/review")).toHaveLength(0);

    await user.type(within(dialog).getByLabelText(/reason/i), "Recorded by hand in Splitwise");
    await user.click(confirm);

    await waitFor(() => expect(api.callsTo("/review")).toHaveLength(1));
    expect(api.bodyOf("/review")).toMatchObject({
      decision: "resolved",
      reason: "Recorded by hand in Splitwise",
      actor: "user",
    });
  });

  it("lets an acknowledgement through without a reason, since it concludes nothing", async () => {
    const api = renderFinding();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Acknowledge" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge" }));

    await waitFor(() => expect(api.callsTo("/review")).toHaveLength(1));
    expect(api.bodyOf("/review")).toMatchObject({ decision: "acknowledged" });
    expect(api.bodyOf("/review")).not.toHaveProperty("reason");
  });

  it("shows the append-only history with its actor and time", async () => {
    renderFinding();

    await waitFor(() => expect(screen.getByText("History")).toBeInTheDocument());
    expect(screen.getByText(/Reviewing supersedes rather than rewrites/)).toBeInTheDocument();
    expect(screen.getByText(/system · 1 Sept 2026/)).toBeInTheDocument();
  });

  it("says when a later audit superseded the finding, without hiding it", async () => {
    renderFinding({
      finding: {
        ...FINDING,
        supersededAt: "2026-09-05T09:00:00.000Z",
        supersedeReason: "no_longer_observed",
      },
      history: FINDING_DETAIL.history,
    });

    await waitFor(() =>
      expect(screen.getByText("A later audit superseded this finding")).toBeInTheDocument(),
    );
    expect(screen.getByText(/kept as history rather than deleted/)).toBeInTheDocument();
  });
});

describe("connecting Splitwise, and correcting what it holds", () => {
  const CANDIDATE = {
    splitwiseExpenseId: "swe-1",
    expenseId: "exp-1",
    externalId: "sw-99",
    syncStatus: "stale",
    syncedAt: "2026-08-10T10:00:00.000Z",
    syncedSnapshot: { amount: "180000" },
    currentNetAmount: "144000",
    description: "Dinner at Toit",
    plannedRepair: "corrected",
  };

  const FULL_CAPABILITY = {
    canCorrect: true,
    canWithdraw: true,
    canCorrectSettlement: true,
  };

  function renderPage(
    runs: readonly SplitwiseAuditRun[],
    resyncCandidates: Record<string, unknown> = {
      candidates: [CANDIDATE],
      settlements: [],
      capability: FULL_CAPABILITY,
    },
  ): ApiMock {
    const api = mockApi({
      "/api/splitwise/audit-findings": { findings: [] },
      "/api/splitwise/resync-candidates": resyncCandidates,
      "/api/splitwise/audits": { runs },
      "/api/expenses/exp-1/splitwise-resync": {
        splitwiseExpenseId: "swe-1",
        syncStatus: "synced",
        repair: "corrected",
        previousExternalId: "sw-99",
        previousSnapshot: { amount: "180000" },
        pushedNetAmount: "144000",
      },
      "/api/settlements/set-1/splitwise-resync": {
        splitwiseTransactionId: "swp-1",
        syncStatus: "synced",
        previousSnapshot: { amount: "50000" },
        pushedAmount: "50000",
      },
    });
    renderWithQuery(<SplitwisePage />);
    return api;
  }

  it("says an unread Splitwise is not an agreeing one, and offers to connect it", async () => {
    renderPage([{ ...AUDIT_RUN_COMPLETE, externalReadStatus: "skipped" }]);

    expect(await screen.findByText("Splitwise has not been read")).toBeInTheDocument();
    // Awaited, not synchronous: before the run loads, the banner correctly says no audit has
    // run at all, and only once it does can it say the read was skipped.
    expect(await screen.findByText(/not the same as finding agreement/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Splitwise" })).toBeInTheDocument();
  });

  it("requires a reason before pushing our figure into somebody else's ledger", async () => {
    const api = renderPage([AUDIT_RUN_COMPLETE]);
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Push ours" })).not.toHaveLength(0),
    );
    await user.click(screen.getAllByRole("button", { name: "Push ours" })[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/the only action in this product that does/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Push it" })).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(/Why this row is being corrected/),
      "Refunded ₹360",
    );
    await user.click(within(dialog).getByRole("button", { name: "Push it" }));

    await waitFor(() => expect(api.callsTo("/splitwise-resync")).not.toHaveLength(0));
    expect(api.callsTo("/splitwise-resync")[0]!.body).toMatchObject({ reason: "Refunded ₹360" });
  });

  it("says the correction edits their entry rather than adding a second one", async () => {
    renderPage([AUDIT_RUN_COMPLETE]);
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Push ours" })).not.toHaveLength(0),
    );
    await user.click(screen.getAllByRole("button", { name: "Push ours" })[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/same entry, same id/)).toBeInTheDocument();
  });

  it("names a withdrawal as a deletion, and labels its button accordingly", async () => {
    renderPage([AUDIT_RUN_COMPLETE], {
      candidates: [{ ...CANDIDATE, currentNetAmount: "0", plannedRepair: "withdrawn" }],
      settlements: [],
      capability: FULL_CAPABILITY,
    });
    const user = userEvent.setup();

    // The row says so before anything is clicked: a person scanning the list can see which of
    // these pushes removes an entry from somebody else's ledger.
    // `findAllByText`: `ResponsiveTable` renders the wide and stacked layouts as separate
    // markup, one hidden by CSS that jsdom does not apply.
    expect(await screen.findAllByText("Removes their entry")).not.toHaveLength(0);
    await user.click(screen.getAllByRole("button", { name: "Push ours" })[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/the entry is deleted/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove it" })).toBeInTheDocument();
  });

  it("says so when the connected adapter cannot correct an entry in place", async () => {
    renderPage([AUDIT_RUN_COMPLETE], {
      candidates: [CANDIDATE],
      settlements: [],
      capability: { ...FULL_CAPABILITY, canCorrect: false },
    });

    expect(
      await screen.findByText("This connection cannot correct an entry in place."),
    ).toBeInTheDocument();
    // And says what it will *not* do instead, because the previous version of this repair did
    // exactly that.
    expect(screen.getByText(/would leave the other person holding two records/)).toBeInTheDocument();
  });

  it("corrects a drifted settlement through the settlement route", async () => {
    const api = renderPage([AUDIT_RUN_COMPLETE], {
      candidates: [],
      settlements: [
        {
          splitwiseSettlementId: "sws-1",
          settlementId: "set-1",
          externalId: "swp-1",
          syncStatus: "drifted",
          syncedAt: "2026-08-10T10:00:00.000Z",
          syncedSnapshot: { amount: "50000" },
          currentAmount: "50000",
          counterpartyPersonId: "per-1",
          counterpartyName: "Friend A",
        },
      ],
      capability: FULL_CAPABILITY,
    });
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Push ours" })).not.toHaveLength(0),
    );
    await user.click(screen.getAllByRole("button", { name: "Push ours" })[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/records no second settlement/)).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText(/Why this settlement is being corrected/),
      "Splitwise shows ₹400 for a ₹500 transfer",
    );
    await user.click(within(dialog).getByRole("button", { name: "Push it" }));

    await waitFor(() =>
      expect(api.callsTo("/settlements/set-1/splitwise-resync")).not.toHaveLength(0),
    );
    expect(api.callsTo("/settlements/set-1/splitwise-resync")[0]!.body).toMatchObject({
      reason: "Splitwise shows ₹400 for a ₹500 transfer",
    });
  });
});
