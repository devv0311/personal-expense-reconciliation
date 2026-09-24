import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorthALook } from "@/components/anomalies/worth-a-look";
import { InstalmentTimeline } from "@/components/instalments/instalment-timeline";
import { mockApi, mockApiFailure, mockApiPending } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { Anomaly, InstalmentPlan } from "@/lib/types";

/**
 * The two phase-2 surfaces: a timeline of what a statement said, and a quiet list of comparisons.
 *
 * Every fixture here is invented. The tests that carry the weight are the refusals — an expected
 * instalment that shows no figure, a plan with no stated tenure that never says "of six", and an
 * anomaly list with no severity, no count badge and nothing to accept.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const CHARGE = {
  paymentId: "pay-1",
  component: "principal" as const,
  amount: "250000",
  occurredAt: "2026-08-08T00:00:00.000Z",
  narration: "NORTHWIND APPLIANCES - Principal Amount Amortization - <1/3>",
  position: 1,
};

function plan(overrides: Partial<InstalmentPlan> = {}): InstalmentPlan {
  return {
    planKey: "northwindappliances",
    merchantName: "NORTHWIND APPLIANCES",
    tenure: { known: true, of: 3 },
    purchase: { known: false, paymentId: null, amount: null, occurredAt: null },
    positions: [
      {
        number: 1,
        certainty: "observed",
        charges: [CHARGE],
        principal: "250000",
        interest: "18000",
        tax: null,
      },
      { number: 2, certainty: "expected", charges: [], principal: null, interest: null, tax: null },
      { number: 3, certainty: "expected", charges: [], principal: null, interest: null, tax: null },
    ],
    unpositionedCharges: [],
    observed: { principal: "250000", interest: "18000", tax: "0", fee: "0", chargeCount: 2 },
    progress: { seen: 1, of: 3 },
    unknowns: [
      "When the next one is due, and how much it will be.",
      "What was originally bought, and for how much.",
    ],
    ...overrides,
  };
}

describe("the instalment timeline", () => {
  it("tells an observed instalment apart from one the statement merely counted", () => {
    render(<InstalmentTimeline plan={plan()} />);

    expect(screen.getByText("Instalment 1")).toBeInTheDocument();
    // The crux: the statement said three, so a second and third exist. It did not say when or
    // how much, and the screen must not imply otherwise.
    expect(screen.getAllByText("Instalment 2 — not yet on a statement")).toHaveLength(1);
    expect(screen.getAllByText("Nothing on file for this one")).toHaveLength(2);
  });

  it("never renders a zero for an instalment it has not seen", () => {
    render(<InstalmentTimeline plan={plan()} />);

    // ₹0.00 for a future instalment would be a figure the ledger does not hold.
    expect(screen.queryByText("₹0.00")).not.toBeInTheDocument();
  });

  it("never says 'of N' when no statement line stated a tenure", () => {
    render(
      <InstalmentTimeline
        plan={plan({
          tenure: { known: false, of: null },
          progress: { seen: 2, of: null },
          positions: [
            {
              number: 1,
              certainty: "observed",
              charges: [CHARGE],
              principal: "250000",
              interest: null,
              tax: null,
            },
            {
              number: 2,
              certainty: "observed",
              charges: [CHARGE],
              principal: "250000",
              interest: null,
              tax: null,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/does not say how many there are in total/)).toBeInTheDocument();
    expect(screen.queryByText(/of the \d+ the statement says/)).not.toBeInTheDocument();
  });

  it("puts what it does not know on the screen rather than in a footnote", () => {
    render(<InstalmentTimeline plan={plan()} />);

    expect(screen.getByText("What this does not tell you")).toBeInTheDocument();
    expect(screen.getByText(/When the next one is due/)).toBeInTheDocument();
  });

  it("offers no decision, because a plan is a reading and not a proposal", () => {
    render(<InstalmentTimeline plan={plan()} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("separates the components rather than presenting one blended figure", () => {
    render(<InstalmentTimeline plan={plan()} />);

    expect(screen.getByText("Repaid")).toBeInTheDocument();
    expect(screen.getByText("Interest")).toBeInTheDocument();
    expect(screen.getByText("₹2,500.00")).toBeInTheDocument();
    expect(screen.getByText("₹180.00")).toBeInTheDocument();
  });
});

const ANOMALY: Anomaly = {
  id: "repeated_charge:pay-1|pay-2",
  kind: "repeated_charge",
  headline: "The same amount, twice at HARBOUR CAFE",
  detail:
    "Two payments of the same amount to the same place, within 24 hours of each other. That is " +
    "often exactly what happened; it is also what a charge that went through twice looks like.",
  evidence: [
    {
      paymentId: "pay-1",
      occurredAt: "2026-08-11T09:00:00.000Z",
      amount: "40000",
      narration: "HARBOUR CAFE",
    },
    {
      paymentId: "pay-2",
      occurredAt: "2026-08-11T12:00:00.000Z",
      amount: "40000",
      narration: "HARBOUR CAFE",
    },
  ],
};

describe("worth a look", () => {
  it("shows the comparison and links every record it used", async () => {
    mockApi({ "/api/anomalies": { anomalies: [ANOMALY], rowsRead: 40 } });
    renderWithQuery(<WorthALook />);

    await screen.findByText(ANOMALY.headline);
    expect(screen.getByText("The records compared")).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/connections/pay-1",
      "/connections/pay-2",
    ]);
  });

  it("offers nothing to accept, dismiss or approve", async () => {
    mockApi({ "/api/anomalies": { anomalies: [ANOMALY], rowsRead: 40 } });
    renderWithQuery(<WorthALook />);

    await screen.findByText(ANOMALY.headline);
    // Nothing was proposed, so there is no decision — and no button that could look like one.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("adds no severity, urgency or count of its own", async () => {
    mockApi({ "/api/anomalies": { anomalies: [ANOMALY], rowsRead: 40 } });
    const { container } = renderWithQuery(<WorthALook />);

    await screen.findByText(ANOMALY.headline);
    const section = container.textContent ?? "";
    expect(section).not.toMatch(/\b(urgent|critical|high|warning|alert|severity)\b/i);
    // `debit` is the tone for money that is bad news; a comparison is not a figure and not news.
    expect(container.querySelectorAll(".text-debit")).toHaveLength(0);
  });

  it("says nothing stood out, and how much was compared, rather than showing an empty box", async () => {
    mockApi({ "/api/anomalies": { anomalies: [], rowsRead: 40 } });
    renderWithQuery(<WorthALook />);

    await screen.findByText("Nothing stood out.");
    expect(screen.getByText(/All 40 records on file were compared/)).toBeInTheDocument();
    expect(screen.getByText(/not a filter hiding something/)).toBeInTheDocument();
  });

  it("distinguishes an empty ledger from a ledger with nothing to report", async () => {
    mockApi({ "/api/anomalies": { anomalies: [], rowsRead: 0 } });
    renderWithQuery(<WorthALook />);

    await screen.findByText("Nothing stood out.");
    expect(screen.getByText(/no records on file to compare yet/)).toBeInTheDocument();
  });

  it("announces loading without claiming a result", () => {
    mockApiPending();
    renderWithQuery(<WorthALook />);
    expect(screen.getByRole("status")).toHaveTextContent("Comparing your records");
    expect(screen.queryByText("Nothing stood out.")).not.toBeInTheDocument();
  });

  it("reports a failure rather than letting it read as nothing found", async () => {
    mockApiFailure("INTERNAL", "Ledger unavailable", 500);
    renderWithQuery(<WorthALook />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("Nothing stood out.")).not.toBeInTheDocument();
  });

  it("renders a single-record finding with the right heading", async () => {
    mockApi({
      "/api/anomalies": {
        anomalies: [
          {
            id: "unexplained_interest:pay-9",
            kind: "unexplained_interest",
            headline: "Interest charged, with no instalment plan on file that explains it",
            detail: "Nothing on file says what was bought or how many instalments there are.",
            evidence: [
              {
                paymentId: "pay-9",
                occurredAt: "2026-08-12T00:00:00.000Z",
                amount: "90000",
                narration: "SEAGRASS FURNITURE - INTEREST 4",
              },
            ],
          },
        ],
        rowsRead: 12,
      },
    });
    renderWithQuery(<WorthALook />);

    await screen.findByText(/Interest charged/);
    // Singular heading, and exactly one record behind it.
    expect(screen.getByText("The record this is about")).toBeInTheDocument();
    expect(screen.queryByText("The records compared")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("writes nothing when the section is merely rendered", async () => {
    mockApi({ "/api/anomalies": { anomalies: [ANOMALY], rowsRead: 40 } });
    renderWithQuery(<WorthALook />);

    await screen.findByText(ANOMALY.headline);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      0,
    );
  });
});
