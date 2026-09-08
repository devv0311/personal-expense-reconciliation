import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountWaterfalls } from "@/components/reconciliation/account-waterfall";
import { mockApi, mockApiFailure, mockApiPending } from "@/test-support/api-mock";
import {
  ACCOUNT,
  SNAPSHOT_INCOMPLETE,
  SNAPSHOT_UNRECONCILED,
  SNAPSHOT_VERIFIED,
} from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderWaterfall(snapshots: unknown) {
  mockApi({
    "/api/reconciliation/runs/run-1/account-snapshots": snapshots,
    "/api/accounts": { accounts: [ACCOUNT] },
  });
  return renderWithQuery(<AccountWaterfalls reconciliationRunId="run-1" />);
}

describe("the account cash waterfall", () => {
  it("renders every term of the identity from the snapshot, and none of its own", async () => {
    renderWaterfall(SNAPSHOT_UNRECONCILED);

    await waitFor(() => expect(screen.getByText("HDFC Savings")).toBeInTheDocument());
    const rows = screen.getByRole("table", { name: /cash waterfall/i });

    // opening 50,000 + credits 2,250 − debits 26,430 = expected 25,820, actual 25,820.
    expect(within(rows).getByText("₹50,000.00")).toBeInTheDocument();
    expect(within(rows).getByText("₹2,250.00")).toBeInTheDocument();
    expect(within(rows).getByText("₹26,430.00")).toBeInTheDocument();
    expect(within(rows).getAllByText("₹25,820.00")).toHaveLength(2);
  });

  it("never shows a verified zero when a statement balance is missing", async () => {
    renderWaterfall(SNAPSHOT_INCOMPLETE);

    await waitFor(() => expect(screen.getByText("Incomplete")).toBeInTheDocument());

    // The delta is unknown, and says so — it is not rendered as ₹0.00 anywhere on the screen.
    expect(screen.getByText(/Unknown — a statement balance is missing/i)).toBeInTheDocument();
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    expect(screen.getAllByText("Not evidenced")).toHaveLength(2);
    expect(screen.getByText("Cannot be computed")).toBeInTheDocument();

    // The period verdict says the period is not verified, and why.
    expect(screen.getByText(/This period is not verified/i)).toBeInTheDocument();
  });

  it("shows a zero delta as bad news while anything on the account is unexplained", async () => {
    renderWaterfall(SNAPSHOT_UNRECONCILED);

    await waitFor(() => expect(screen.getByText("Unreconciled")).toBeInTheDocument());

    const delta = screen.getByText("₹0.00", { selector: "span.text-figure" });
    expect(delta).toHaveClass("text-debit");
    expect(delta).not.toHaveClass("text-credit");
    expect(screen.getByText(/1 of 1 accounts do not close/i)).toBeInTheDocument();
  });

  it("calls an account verified only when the backend does, and shows the zero in credit", async () => {
    renderWaterfall(SNAPSHOT_VERIFIED);

    await waitFor(() => expect(screen.getByText("Verified")).toBeInTheDocument());
    const delta = screen.getByText("₹0.00", { selector: "span.text-figure" });
    expect(delta).toHaveClass("text-credit");
    expect(screen.getByText(/Every one of the 1 accounts closes/i)).toBeInTheDocument();
  });

  it("keeps the transfer and explained figures labelled as subsets, not extra terms", async () => {
    renderWaterfall(SNAPSHOT_UNRECONCILED);

    await waitFor(() => expect(screen.getByText("Explained debits")).toBeInTheDocument());
    expect(screen.getAllByText(/A subset of debits, not a new term/i)).toHaveLength(1);
    expect(screen.getAllByText(/A subset of credits, not a new term/i)).toHaveLength(1);
  });

  it("links each evidenced boundary to the statement it came from", async () => {
    renderWaterfall(SNAPSHOT_UNRECONCILED);

    await waitFor(() => expect(screen.getByRole("link", { name: "opening" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "opening" })).toHaveAttribute(
      "href",
      "/evidence/ev-statement",
    );
    expect(screen.getByRole("link", { name: "closing" })).toHaveAttribute(
      "href",
      "/evidence/ev-statement",
    );
  });

  it("names the account rather than showing its id, and says when it is closed", async () => {
    mockApi({
      "/api/reconciliation/runs/run-1/account-snapshots": SNAPSHOT_VERIFIED,
      "/api/accounts": { accounts: [{ ...ACCOUNT, archivedAt: "2026-09-01T00:00:00.000Z" }] },
    });
    renderWithQuery(<AccountWaterfalls reconciliationRunId="run-1" />);

    await waitFor(() => expect(screen.getByText("HDFC Savings")).toBeInTheDocument());
    expect(screen.getByText(/Bank · HDFC Bank · ends 4821 · closed/)).toBeInTheDocument();
    expect(screen.queryByText("a-hdfc")).not.toBeInTheDocument();
  });

  it("shows every cash discrepancy the run recorded", async () => {
    renderWaterfall(SNAPSHOT_UNRECONCILED);

    await waitFor(() =>
      expect(screen.getByText("Debits this account cannot explain")).toBeInTheDocument(),
    );
  });

  it("says a run with no snapshots checked nothing, rather than implying it closed", async () => {
    renderWaterfall({ reconciliationRunId: "run-1", snapshots: [] });

    await waitFor(() =>
      expect(screen.getByText(/there were no accounts to check/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
  });

  it("announces a loading state while the snapshots are in flight", () => {
    mockApiPending();
    renderWithQuery(<AccountWaterfalls reconciliationRunId="run-1" />);

    expect(screen.getByText(/loading account balances/i)).toBeInTheDocument();
  });

  it("shows a retryable error rather than an empty waterfall when the read fails", async () => {
    mockApiFailure("INTERNAL_ERROR", "snapshot read failed");
    renderWithQuery(<AccountWaterfalls reconciliationRunId="run-1" />);

    await waitFor(() => expect(screen.getByText(/snapshot read failed/)).toBeInTheDocument());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("drilling through a waterfall term", () => {
  function renderWithPeriod() {
    mockApi({
      "/api/reconciliation/runs/run-1/account-snapshots": SNAPSHOT_UNRECONCILED,
      "/api/accounts": { accounts: [ACCOUNT] },
    });
    return renderWithQuery(
      <AccountWaterfalls
        reconciliationRunId="run-1"
        periodStart="2026-08-01T00:00:00.000Z"
        periodEnd="2026-09-01T00:00:00.000Z"
      />,
    );
  }

  it("links each term to its own account, period and direction — not to a general list", async () => {
    renderWithPeriod();

    await waitFor(() => expect(screen.getByText("HDFC Savings")).toBeInTheDocument());
    const credits = screen.getByRole("link", { name: /open the movements behind credits/i });
    expect(credits).toHaveAttribute(
      "href",
      `/payments?accountId=${ACCOUNT.id}&direction=credit&from=2026-08-01&to=2026-09-01`,
    );
    const debits = screen.getByRole("link", { name: /open the movements behind debits/i });
    expect(debits.getAttribute("href")).toContain("direction=debit");
  });

  it("narrows the unexplained figures to the movements nothing accounts for", async () => {
    const { container } = renderWithPeriod();

    await waitFor(() => expect(screen.getByText("HDFC Savings")).toBeInTheDocument());
    const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toContain(
      `/payments?accountId=${ACCOUNT.id}&direction=debit&from=2026-08-01&to=2026-09-01&onlyUnexplained=true`,
    );
  });

  it("renders the figures without links when no period was passed, rather than a wrong one", async () => {
    renderWaterfall(SNAPSHOT_UNRECONCILED);

    await waitFor(() => expect(screen.getByText("HDFC Savings")).toBeInTheDocument());
    expect(
      screen.queryByRole("link", { name: /open the movements behind credits/i }),
    ).not.toBeInTheDocument();
  });
});
