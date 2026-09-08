import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceIntake } from "@/components/evidence/evidence-intake";
import { ObservationEditor } from "@/components/evidence/observation-editor";
import { ReceiptReview } from "@/components/evidence/receipt-review";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import { RECEIPT_VIEW } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("bringing evidence in by hand", () => {
  function renderIntake(): ApiMock {
    const api = mockApi({
      "/api/evidence/notes": { evidenceId: "ev-new" },
      "/api/evidence/notifications": { outcome: "recorded", evidenceId: "ev-new" },
    });
    renderWithQuery(<EvidenceIntake />);
    return api;
  }

  it("says a settlement claim moves no money, because it is evidence of a belief", async () => {
    const api = renderIntake();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Write a note" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Kind"), "settlement_claim");

    expect(within(dialog).getByText(/no payment is created/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/no balance moves/i)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("What happened"), "Alex says he paid me.");
    await user.click(within(dialog).getByRole("button", { name: "Store it" }));

    await waitFor(() => expect(api.callsTo("/api/evidence/notes")).not.toHaveLength(0));
    expect(api.callsTo("/api/evidence/notes")[0]!.body).toMatchObject({
      noteKind: "settlement_claim",
      text: "Alex says he paid me.",
    });
  });

  it("stores a pasted notification verbatim and links it to nothing", async () => {
    const api = renderIntake();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Paste a notification" }));
    const dialog = await screen.findByRole("dialog");
    const text = "Rs.640.00 debited from A/c XX4821 on 08-Aug-26 to PEPPERMILL CAFE.";
    await user.type(
      within(dialog).getByLabelText(/The message, exactly as it arrived/),
      text.replace(/[{[]/g, ""),
    );
    await user.click(within(dialog).getByRole("button", { name: "Store it" }));

    await waitFor(() => expect(api.callsTo("/api/evidence/notifications")).not.toHaveLength(0));
    const body = api.callsTo("/api/evidence/notifications")[0]!.body as Record<string, unknown>;
    expect(body["type"]).toBe("upi_notification");
    expect(body["linkedPaymentId"]).toBeUndefined();
  });
});

describe("correcting what was read off a document", () => {
  it("records an emptied field as not stated rather than as zero", async () => {
    const api = mockApi({ "/api/evidence/ev-1/observation": { outcome: "recorded" } });
    renderWithQuery(<ObservationEditor evidenceId="ev-1" observation={null} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Record what it says" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/different fact from zero/)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Amount"), "640");
    await user.click(within(dialog).getByRole("button", { name: "Record it" }));

    await waitFor(() => expect(api.callsTo("/observation")).not.toHaveLength(0));
    const body = api.callsTo("/observation")[0]!.body as Record<string, unknown>;
    expect(body["observedAmount"]).toBe("64000");
    expect(body["observedReference"]).toBeNull();
  });
});

describe("the extracted receipt", () => {
  function renderReview(): ApiMock {
    const api = mockApi({
      "/api/receipts/rec-1/confirm": {
        ...RECEIPT_VIEW,
        receipt: { ...RECEIPT_VIEW.receipt, confirmedByUser: true },
      },
      "/api/receipts/rec-1/correct": RECEIPT_VIEW,
      "/api/receipts/rec-1": RECEIPT_VIEW,
    });
    renderWithQuery(<ReceiptReview receiptId="rec-1" />);
    return api;
  }

  it("renders the items, the totals and the discrepancy the service computed", async () => {
    renderReview();

    expect(await screen.findByText("Paneer tikka")).toBeInTheDocument();
    expect(screen.getByText("₹1,890.00")).toBeInTheDocument();
    expect(screen.getByText(/The items and the printed subtotal disagree/)).toBeInTheDocument();
  });

  it("confirms an extraction without touching any expense", async () => {
    const api = renderReview();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Confirm it" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/changes no expense and no allocation/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Confirm it" }));

    await waitFor(() => expect(api.callsTo("/confirm")).not.toHaveLength(0));
  });

  it("will not correct one without saying what the extraction got wrong", async () => {
    renderReview();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Correct it" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Save the correction" })).toBeDisabled();
  });
});
