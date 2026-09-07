import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunReconciliationForm } from "@/components/run-reconciliation-form";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import { ACCOUNT, RUN, SNAPSHOT_INCOMPLETE } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderForm(): ApiMock {
  const api = mockApi({
    "/api/reconciliation/runs": {
      reconciliationRunId: "run-1",
      totals: RUN.totals,
      discrepancies: [],
      accountSnapshots: SNAPSHOT_INCOMPLETE.snapshots,
      splitwiseAuditRunId: null,
    },
    "/api/accounts": { accounts: [ACCOUNT] },
  });
  renderWithQuery(<RunReconciliationForm />);
  return api;
}

const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";

describe("running a reconciliation", () => {
  it("sends no accountBoundaries at all when nothing has been confirmed", async () => {
    const api = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /run reconciliation/i }));
    await waitFor(() => expect(api.callsTo("/api/reconciliation/runs")).toHaveLength(1));

    const body = api.bodyOf("/api/reconciliation/runs");
    expect(body).not.toHaveProperty("accountBoundaries");
    expect(body).toMatchObject({ actor: "user" });
  });

  it("keeps the boundary fields behind a disclosure, named by the account", async () => {
    renderForm();
    const user = userEvent.setup();

    const toggle = screen.getByRole("button", { name: /add statement balances/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await waitFor(() => expect(screen.getByText(/HDFC Savings/)).toBeInTheDocument());
    expect(screen.getByLabelText(/Opening balance/)).toBeInTheDocument();
    expect(screen.getByText(/unknown, never zero/i)).toBeInTheDocument();
  });

  it("refuses to submit a balance with no statement evidence behind it", async () => {
    const api = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /add statement balances/i }));
    await waitFor(() => expect(screen.getByLabelText(/Opening balance/)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/Opening balance/), "50000.00");

    expect(
      screen.getByText(/needs the id of the statement evidence it came from/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run reconciliation/i })).toBeDisabled();
    expect(api.callsTo("/api/reconciliation/runs")).toHaveLength(0);
  });

  it("sends signed, exact paise once a balance cites its evidence", async () => {
    const api = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /add statement balances/i }));
    await waitFor(() => expect(screen.getByLabelText(/Opening balance/)).toBeInTheDocument());

    // An overdraft is a real balance, so a negative opening balance is accepted.
    await user.type(screen.getByLabelText(/Opening balance/), "-2500.00");
    await user.type(screen.getByLabelText(/Opening statement evidence id/), EVIDENCE_ID);
    await user.click(screen.getByRole("button", { name: /run reconciliation/i }));

    await waitFor(() => expect(api.callsTo("/api/reconciliation/runs")).toHaveLength(1));
    expect(api.bodyOf("/api/reconciliation/runs")["accountBoundaries"]).toEqual([
      {
        accountId: "a-hdfc",
        openingBalance: "-250000",
        openingBalanceEvidenceId: EVIDENCE_ID,
      },
    ]);
  });

  it("reports what the run recorded, including its unexplained total", async () => {
    renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /run reconciliation/i }));
    await waitFor(() =>
      expect(screen.getByText(/Recorded 1 account snapshot\./)).toBeInTheDocument(),
    );
    expect(screen.getByText("₹2,530.00")).toBeInTheDocument();
  });
});
