import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveBalances } from "@/components/reconciliation/live-balances";
import { BalanceProviders } from "@/components/setup/balance-providers";
import { mockApi } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const CONFIGURED = {
  providerId: "http-balance-provider",
  label: "Configured balance endpoint",
  configured: true,
  endpointHost: "balances.example.test",
  linkedAccountCount: 1,
  readingsAreNeverBoundaries: true,
};

const UNCONFIGURED = {
  providerId: "unconfigured",
  label: "Not configured",
  configured: false,
  unavailableReason:
    "No balance provider is configured. Set BALANCE_PROVIDER_URL and BALANCE_PROVIDER_TOKEN.",
  linkedAccountCount: 0,
  readingsAreNeverBoundaries: true,
};

function reading(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    accountId: "acc-1",
    accountProviderLinkId: "l-1",
    providerId: "http-balance-provider",
    balance: "500000",
    currency: "INR",
    asOf: "2026-07-31T18:00:00.000Z",
    fetchedAt: "2026-08-01T04:00:00.000Z",
    status: "ok",
    failureReason: null,
    readComplete: true,
    readIncompleteReason: null,
    ...overrides,
  };
}

function comparison(overrides: Record<string, unknown> = {}) {
  return {
    comparedTo: "2026-08-01T00:00:00.000Z",
    provider: CONFIGURED,
    note: "A provider reading is a second opinion, never a period boundary.",
    comparisons: [
      {
        accountId: "acc-1",
        accountName: "HDFC Savings",
        reading: reading(),
        linked: true,
        ledgerFigure: "500000",
        comparison: { verdict: "agrees", difference: "0", usability: "fresh" },
      },
    ],
    ...overrides,
  };
}

describe("the live-balance panel", () => {
  it("says plainly when no provider is configured", async () => {
    mockApi({ "/api/balance-provider/comparison": { ...comparison(), provider: UNCONFIGURED } });
    renderWithQuery(<LiveBalances runId="run-1" />);

    expect(await screen.findByText("No balance provider is configured.")).toBeInTheDocument();
    expect(screen.getByText(/BALANCE_PROVIDER_URL/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read balances now/ })).not.toBeInTheDocument();
  });

  it("puts the reading beside the evidenced closing balance, and says what it is not", async () => {
    mockApi({ "/api/balance-provider/comparison": comparison() });
    renderWithQuery(<LiveBalances runId="run-1" />);

    expect(await screen.findByText(/never a period boundary/)).toBeInTheDocument();
    // Both figures are quoted from the API; neither is derived here.
    expect(screen.getAllByText("₹5,000.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("agrees").length).toBeGreaterThan(0);
  });

  it("renders a missing evidenced boundary as 'not evidenced', never as ₹0", async () => {
    mockApi({
      "/api/balance-provider/comparison": comparison({
        comparisons: [
          {
            accountId: "acc-1",
            accountName: "HDFC Savings",
            reading: reading(),
            linked: true,
            ledgerFigure: null,
            comparison: {
              verdict: "not_comparable",
              difference: null,
              usability: "fresh",
              caveat: "This account has no evidenced closing balance for the period.",
            },
          },
        ],
      }),
    });
    renderWithQuery(<LiveBalances runId="run-1" />);

    expect(await screen.findAllByText("not evidenced")).not.toHaveLength(0);
    expect(screen.queryByText("₹0.00")).not.toBeInTheDocument();
    expect(screen.getAllByText("nothing to compare").length).toBeGreaterThan(0);
  });

  it("renders an unreadable account as unreadable, never as zero", async () => {
    mockApi({
      "/api/balance-provider/comparison": comparison({
        comparisons: [
          {
            accountId: "acc-1",
            accountName: "HDFC Savings",
            reading: reading({ status: "unavailable", balance: null, asOf: null }),
            linked: true,
            ledgerFigure: "500000",
            comparison: {
              verdict: "not_comparable",
              difference: null,
              usability: "unusable",
              caveat: "The provider could not state a balance for this account.",
            },
          },
        ],
      }),
    });
    renderWithQuery(<LiveBalances runId="run-1" />);

    expect(await screen.findAllByText("could not be read")).not.toHaveLength(0);
    expect(screen.getAllByText(/could not state a balance/).length).toBeGreaterThan(0);
  });

  it("shows a stale match as a match against an older reading, not as agreement", async () => {
    mockApi({
      "/api/balance-provider/comparison": comparison({
        comparisons: [
          {
            accountId: "acc-1",
            accountName: "HDFC Savings",
            reading: reading({ asOf: "2026-07-20T18:00:00.000Z" }),
            linked: true,
            ledgerFigure: "500000",
            comparison: {
              verdict: "agrees",
              difference: "0",
              usability: "stale",
              caveat: "Neither a match nor a mismatch here settles anything.",
            },
          },
        ],
      }),
    });
    renderWithQuery(<LiveBalances runId="run-1" />);

    expect(await screen.findAllByText("matches an older reading")).not.toHaveLength(0);
    expect(screen.getAllByText(/settles anything/).length).toBeGreaterThan(0);
  });

  it("shows a difference as a magnitude the API computed", async () => {
    mockApi({
      "/api/balance-provider/comparison": comparison({
        comparisons: [
          {
            accountId: "acc-1",
            accountName: "HDFC Savings",
            reading: reading({ balance: "480000" }),
            linked: true,
            ledgerFigure: "500000",
            comparison: { verdict: "differs", difference: "-20000", usability: "fresh" },
          },
        ],
      }),
    });
    renderWithQuery(<LiveBalances runId="run-1" />);

    expect(await screen.findAllByText(/differs by/)).not.toHaveLength(0);
    expect(screen.getAllByText("₹200.00").length).toBeGreaterThan(0);
  });

  it("states that a refresh changes nothing before the button that performs it", async () => {
    const api = mockApi({
      "/api/balance-provider/comparison": comparison(),
      "/api/balance-provider/refresh": {
        provider: CONFIGURED,
        completeness: { requested: 1, answered: 1, complete: true },
        readings: [reading()],
        fetchedAt: "2026-08-01T05:00:00.000Z",
      },
    });
    renderWithQuery(<LiveBalances runId="run-1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Read balances now/ }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/writes no boundary, moves no balance and changes no verdict/),
    ).toBeInTheDocument();
    expect(api.callsTo("/api/balance-provider/refresh")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Read them" }));
    await waitFor(() => expect(api.callsTo("/api/balance-provider/refresh")).toHaveLength(1));
    expect(await screen.findByText(/Nothing in the ledger changed/)).toBeInTheDocument();
  });

  it("reports an incomplete read as incomplete after a refresh", async () => {
    mockApi({
      "/api/balance-provider/comparison": comparison(),
      "/api/balance-provider/refresh": {
        provider: CONFIGURED,
        completeness: {
          requested: 2,
          answered: 1,
          complete: false,
          incompleteReason: "1 of 2 linked accounts were not answered.",
        },
        readings: [reading()],
        fetchedAt: "2026-08-01T05:00:00.000Z",
      },
    });
    renderWithQuery(<LiveBalances runId="run-1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Read balances now/ }));
    await user.click(screen.getByRole("button", { name: "Read them" }));

    expect(await screen.findByText(/1 of 2 linked accounts were not answered/)).toBeInTheDocument();
  });
});

describe("the balance-provider mapping on Setup", () => {
  const ACCOUNTS = [
    { id: "acc-1", name: "HDFC Savings", type: "bank", institution: "HDFC", last4: "4321" },
    { id: "acc-2", name: "Cash wallet", type: "cash", institution: null, last4: null },
  ];

  it("says nothing can be read when nothing is configured, and offers no link button", async () => {
    mockApi({
      "/api/balance-provider/status": UNCONFIGURED,
      "/api/balance-provider/links": { links: [] },
      "/api/accounts": { accounts: ACCOUNTS },
    });
    renderWithQuery(<BalanceProviders />);

    expect(await screen.findByText("No balance provider is configured here.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Link an account/ })).not.toBeInTheDocument();
  });

  it("says an empty mapping is a statement about the mapping, not about any balance", async () => {
    mockApi({
      "/api/balance-provider/status": { ...CONFIGURED, linkedAccountCount: 0 },
      "/api/balance-provider/links": { links: [] },
      "/api/accounts": { accounts: ACCOUNTS },
    });
    renderWithQuery(<BalanceProviders />);

    expect(await screen.findByText(/not about any account's balance/)).toBeInTheDocument();
  });

  it("maps an account behind a dialog that says a reading is never a boundary", async () => {
    const api = mockApi({
      "/api/balance-provider/status": { ...CONFIGURED, linkedAccountCount: 0 },
      "/api/balance-provider/links": { links: [] },
      "/api/accounts": { accounts: ACCOUNTS },
    });
    renderWithQuery(<BalanceProviders />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Link an account/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/never writes a period boundary/)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/provider's reference/i), "ref-savings");
    await user.click(within(dialog).getByRole("button", { name: "Link it" }));

    await waitFor(() =>
      expect(
        api.callsTo("/api/balance-provider/links").filter((call) => call.method === "POST"),
      ).toHaveLength(1),
    );
    const sent = api.callsTo("/api/balance-provider/links").find((call) => call.method === "POST")!
      .body as Record<string, unknown>;
    expect(sent).toMatchObject({
      actor: "user",
      accountId: "acc-1",
      externalAccountRef: "ref-savings",
    });
    // There is no field that could carry a credential, and none was sent.
    expect(Object.keys(sent)).not.toContain("token");
  });

  it("describes unlinking as keeping past readings rather than deleting them", async () => {
    mockApi({
      "/api/balance-provider/status": CONFIGURED,
      "/api/balance-provider/links": {
        links: [
          {
            id: "l-1",
            accountId: "acc-1",
            providerId: "http-balance-provider",
            externalAccountRef: "ref-savings",
            providerLabel: null,
            linkedAt: "2026-08-01T00:00:00.000Z",
            archivedAt: null,
            accountName: "HDFC Savings",
            accountType: "bank",
            accountLast4: "4321",
          },
        ],
      },
      "/api/accounts": { accounts: ACCOUNTS },
    });
    renderWithQuery(<BalanceProviders />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Unlink" }));
    expect(
      within(screen.getByRole("dialog")).getByText(/deleting them would rewrite it/),
    ).toBeInTheDocument();
  });
});
