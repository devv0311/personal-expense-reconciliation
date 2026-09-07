import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceInspector } from "@/components/evidence/evidence-inspector";
import { PaymentContext } from "@/components/evidence/payment-context";
import { mockApi, mockApiFailure, type ApiMock } from "@/test-support/api-mock";
import { EVIDENCE, MATCH_CANDIDATE, UNMATCHED_EVIDENCE_ITEM } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderInspector(overrides: Record<string, unknown> = {}): ApiMock {
  const api = mockApi({
    "/api/evidence/ev-1/observation": {
      evidenceId: "ev-1",
      observation: UNMATCHED_EVIDENCE_ITEM.observation,
    },
    "/api/evidence/ev-1/matches": { evidenceId: "ev-1", candidates: [MATCH_CANDIDATE] },
    "/api/evidence/ev-1/enrich": {
      evidenceId: "ev-1",
      observation: UNMATCHED_EVIDENCE_ITEM.observation,
      candidates: [MATCH_CANDIDATE],
      ambiguous: false,
      outcome: "matched",
    },
    "/api/evidence/ev-1": EVIDENCE,
    ...overrides,
  });
  renderWithQuery(<EvidenceInspector evidenceId="ev-1" />);
  return api;
}

describe("the evidence inspector", () => {
  it("shows the source verbatim, and says it stays local", async () => {
    renderInspector();

    await waitFor(() => expect(screen.getByText("The source, verbatim")).toBeInTheDocument());
    expect(screen.getByText(/Rs\.640\.00 debited from A\/c XX4821/)).toBeInTheDocument();
    expect(screen.getByText(/it is not what a proof pack exports/)).toBeInTheDocument();
  });

  it("shows the recorded reading without having to re-run the matcher", async () => {
    const api = renderInspector();

    await waitFor(() =>
      expect(screen.getByText("Parsed from the text, deterministically")).toBeInTheDocument(),
    );
    // A read, not a POST: opening the screen enriched nothing.
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("says a document nothing has read has no reading, rather than showing blanks", async () => {
    renderInspector({
      "/api/evidence/ev-1/observation": { evidenceId: "ev-1", observation: null },
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Nothing has read this document into structured form/),
      ).toBeInTheDocument(),
    );
  });

  it("says the document is attached to nothing until a candidate is accepted", async () => {
    renderInspector();

    await waitFor(() => expect(screen.getByText(/Attached to nothing yet/)).toBeInTheDocument());
    expect(screen.getByText(/the only way to attach it/)).toBeInTheDocument();
  });

  it("says linkage is write-once once the document is attached", async () => {
    renderInspector({ "/api/evidence/ev-1": { ...EVIDENCE, linkedPaymentId: "pay-1" } });

    await waitFor(() => expect(screen.getByText(/Attached\./)).toBeInTheDocument());
    expect(screen.getByText(/cannot be re-pointed at something else/)).toBeInTheDocument();
  });

  it("finds candidates on request, and that request records rather than links", async () => {
    const api = renderInspector();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /find candidates/i })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /find candidates/i }));

    await waitFor(() => expect(api.callsTo("/enrich")).toHaveLength(1));
    expect(api.callsTo("/decision")).toHaveLength(0);
  });

  it("says nothing is offered rather than implying nothing matched", async () => {
    renderInspector({ "/api/evidence/ev-1/matches": { evidenceId: "ev-1", candidates: [] } });

    await waitFor(() =>
      expect(screen.getByText(/That is a real answer, not a failure/)).toBeInTheDocument(),
    );
  });

  it("warns when more than one payment is eligible, and refuses to choose", async () => {
    renderInspector({
      "/api/evidence/ev-1/matches": {
        evidenceId: "ev-1",
        candidates: [
          MATCH_CANDIDATE,
          { ...MATCH_CANDIDATE, candidateId: "cand-2", paymentId: "pay-2" },
        ],
      },
    });

    await waitFor(() =>
      expect(
        screen.getByText(/The evidence does not distinguish them, so this system will not either/),
      ).toBeInTheDocument(),
    );
  });

  it("keeps decided candidates as history rather than hiding them", async () => {
    renderInspector({
      "/api/evidence/ev-1/matches": {
        evidenceId: "ev-1",
        candidates: [
          {
            ...MATCH_CANDIDATE,
            status: "dismissed",
            decidedBy: "user",
            decidedAt: "2026-09-01T10:00:00.000Z",
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText("Already decided")).toBeInTheDocument());
    expect(screen.getByText(/Dismissed · user/)).toBeInTheDocument();
  });

  it("shows a retryable error rather than a blank inspector", async () => {
    mockApiFailure("ENTITY_NOT_FOUND", "No evidence with id ev-1.", 404);
    renderWithQuery(<EvidenceInspector evidenceId="ev-1" />);

    await waitFor(() => expect(screen.getByText(/No evidence with id ev-1/)).toBeInTheDocument());
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

const CONTEXT = {
  context: {
    paymentId: "pay-1",
    narration: "UPI-BLINKIT9821PAYTM",
    merchantCandidates: [{ value: "Blinkit", evidenceIds: ["ev-1", "ev-2"] }],
    references: [{ value: "884120993741", evidenceIds: ["ev-1"] }],
    observedInstants: [],
    conflicts: [
      {
        field: "merchant" as const,
        values: [
          { value: "Blinkit", evidenceIds: ["ev-1"] },
          { value: "Peppermill", evidenceIds: ["ev-2"] },
        ],
        detail: "Two sources name different merchants.",
      },
    ],
    sources: [
      {
        evidenceId: "ev-1",
        evidenceType: "upi_notification",
        capturedAt: "2026-08-08T11:31:00.000Z",
        observation: UNMATCHED_EVIDENCE_ITEM.observation,
      },
      {
        evidenceId: "ev-2",
        evidenceType: "receipt_image",
        capturedAt: "2026-08-08T11:40:00.000Z",
        observation: null,
      },
    ],
    observedSourceCount: 1,
  },
};

describe("the re-attached payment context", () => {
  it("shows the bank's narration verbatim, and says it is never replaced", async () => {
    mockApi({ "/api/payments/pay-1/context": CONTEXT });
    renderWithQuery(<PaymentContext paymentId="pay-1" />);

    await waitFor(() => expect(screen.getByText("UPI-BLINKIT9821PAYTM")).toBeInTheDocument());
    expect(screen.getByText(/Never replaced by an interpretation of it/)).toBeInTheDocument();
  });

  it("names a disagreement and shows both values rather than resolving it", async () => {
    mockApi({ "/api/payments/pay-1/context": CONTEXT });
    renderWithQuery(<PaymentContext paymentId="pay-1" />);

    await waitFor(() => expect(screen.getByText("Merchant: sources disagree")).toBeInTheDocument());
    // Both asserted values are shown side by side; neither is picked.
    expect(
      screen.getByText((_, element) => element?.textContent === "Blinkit  ·  Peppermill"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/this system does not pick a winner between two records/),
    ).toBeInTheDocument();
  });

  it("says how many of the attached records have actually been read", async () => {
    mockApi({ "/api/payments/pay-1/context": CONTEXT });
    renderWithQuery(<PaymentContext paymentId="pay-1" />);

    await waitFor(() => expect(screen.getByText("Sources read")).toBeInTheDocument());
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText(/Attached, but never read into structured form/)).toBeInTheDocument();
  });

  it("counts the corroboration behind each reconstructed value", async () => {
    mockApi({ "/api/payments/pay-1/context": CONTEXT });
    renderWithQuery(<PaymentContext paymentId="pay-1" />);

    await waitFor(() => expect(screen.getByText("2 sources")).toBeInTheDocument());
    expect(screen.getByText("1 source")).toBeInTheDocument();
  });

  it("says the narration is all there is when nothing is attached", async () => {
    mockApi({
      "/api/payments/pay-1/context": {
        context: { ...CONTEXT.context, sources: [], conflicts: [], observedSourceCount: 0 },
      },
    });
    renderWithQuery(<PaymentContext paymentId="pay-1" />);

    await waitFor(() =>
      expect(screen.getByText(/Its narration is all the ledger has/)).toBeInTheDocument(),
    );
  });
});

describe("evidence match candidates", () => {
  it("shows every signal's verdict with both sides of the comparison", async () => {
    renderInspector();

    await waitFor(() =>
      expect(
        screen.getByRole("table", { name: /signal-by-signal comparison/i }),
      ).toBeInTheDocument(),
    );
    const table = screen.getByRole("table", { name: /signal-by-signal comparison/i });
    const merchantRow = within(table).getByText("Merchant").closest("tr")!;
    const cells = within(merchantRow)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells[2]).toBe("PEPPERMILL CAFE");
    expect(cells[3]).toBe("BLINKIT");
    expect(within(merchantRow).getByText("Disagrees")).toBeInTheDocument();
  });

  it("keeps every reason the candidate is waiting visible", async () => {
    renderInspector();

    await waitFor(() =>
      expect(screen.getByText(/Linking evidence is an explicit decision/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/At least one signal disagreed/)).toBeInTheDocument();
  });
});
