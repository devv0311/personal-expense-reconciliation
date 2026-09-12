import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofPackPreview } from "@/components/proof-packs/proof-pack-preview";
import { mockApi } from "@/test-support/api-mock";
import { PROOF_PACK } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const CONFIGURED = {
  transportId: "whatsapp-cloud",
  channel: "whatsapp",
  label: "WhatsApp Cloud API",
  configured: true,
  supportsAttachments: true,
  endpointHost: "graph.facebook.com",
  maxAttachmentBytes: 104857600,
  attachableEvidenceTypes: ["receipt_image", "email_receipt"],
  maxAttempts: 5,
};

const UNCONFIGURED = {
  transportId: "unconfigured",
  channel: "whatsapp",
  label: "Not configured",
  configured: false,
  unavailableReason:
    "No message transport is configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.",
  supportsAttachments: false,
  attachableEvidenceTypes: ["receipt_image", "email_receipt"],
  maxAttempts: 5,
};

const SENT_DELIVERY = {
  id: "d-1",
  recipientPersonId: "p-alex",
  recipientDisplayName: "Alex",
  channel: "whatsapp",
  address: "+919876543210",
  bodyText: PROOF_PACK.generatedText,
  contentDigest: PROOF_PACK.contentDigest,
  attachments: [],
  packAsOf: PROOF_PACK.asOf,
  status: "sent" as const,
  attemptCount: 1,
  lastError: null,
  providerMessageId: "wamid-1",
  transportId: "whatsapp-cloud",
  sentAt: "2026-09-12T10:00:00.000Z",
  deliveredAt: null,
  createdAt: "2026-09-12T10:00:00.000Z",
  retryable: false,
};

/** A receipt the pack cites, so the attachment list has something legitimate in it. */
const PACK_WITH_RECEIPT = {
  ...PROOF_PACK,
  evidenceReferences: [
    ...PROOF_PACK.evidenceReferences,
    {
      evidenceId: "ev-receipt",
      type: "receipt_image",
      capturedAt: "2026-08-08T11:35:00.000Z",
      label: "Blinkit receipt",
    },
  ],
};

function routes(overrides: Record<string, unknown> = {}) {
  return mockApi({
    "/api/messaging/status": CONFIGURED,
    "/api/proof-packs/p-alex/deliveries": (_url: string, init: RequestInit | undefined) =>
      init?.method === "POST" ? { delivery: SENT_DELIVERY, sentNow: true } : { deliveries: [] },
    ...overrides,
  });
}

async function reviewAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText(/The recipient is Alex/));
  await user.click(screen.getByLabelText(/I have read the message above/));
  await user.click(screen.getByLabelText(/I have checked which evidence it cites/));
}

describe("sending a proof pack", () => {
  it("says plainly when no transport is configured, instead of offering a button that fails", async () => {
    mockApi({
      "/api/messaging/status": UNCONFIGURED,
      "/api/proof-packs/p-alex/deliveries": { deliveries: [] },
    });
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);

    expect(
      await screen.findByText("Sending is not configured on this installation."),
    ).toBeInTheDocument();
    expect(screen.getByText(/WHATSAPP_ACCESS_TOKEN/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Their WhatsApp number/)).not.toBeInTheDocument();
  });

  it("keeps sending behind the same three review checks that gate copying", async () => {
    routes();
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);
    const user = userEvent.setup();

    const address = await screen.findByLabelText(/Their WhatsApp number/);
    await user.type(address, "+919876543210");

    const send = screen.getByRole("button", { name: /Send through WhatsApp Cloud API/ });
    expect(send).toBeDisabled();
    expect(screen.getByText(/Confirm all three review checks above first/)).toBeInTheDocument();

    await reviewAll(user);
    expect(send).toBeEnabled();
  });

  it("keeps sending behind an address, too", async () => {
    routes();
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);
    const user = userEvent.setup();
    await screen.findByLabelText(/Their WhatsApp number/);
    await reviewAll(user);

    expect(screen.getByRole("button", { name: /Send through/ })).toBeDisabled();
  });

  it("states the consequence before the button that sends, and never on a keystroke", async () => {
    const api = routes();
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/Their WhatsApp number/), "+919876543210");
    await reviewAll(user);
    await user.click(screen.getByRole("button", { name: /Send through/ }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/It leaves this machine and cannot be recalled/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/records no settlement/)).toBeInTheDocument();
    expect(within(dialog).getByText("+919876543210")).toBeInTheDocument();
    // Opening the dialog sends nothing.
    expect(
      api.callsTo("/api/proof-packs/p-alex/deliveries").filter((c) => c.method === "POST"),
    ).toHaveLength(0);
  });

  it("posts the recipient, address, review and the server's own digest — never a message body", async () => {
    const api = routes();
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/Their WhatsApp number/), "+919876543210");
    await reviewAll(user);
    await user.click(screen.getByRole("button", { name: /Send through/ }));
    await user.click(screen.getByRole("button", { name: "Send it" }));

    await waitFor(() =>
      expect(
        api.callsTo("/api/proof-packs/p-alex/deliveries").filter((call) => call.method === "POST"),
      ).toHaveLength(1),
    );
    const sent = api
      .callsTo("/api/proof-packs/p-alex/deliveries")
      .find((call) => call.method === "POST")!.body as Record<string, unknown>;

    expect(sent).toMatchObject({
      actor: "user",
      channel: "whatsapp",
      address: "+919876543210",
      asOf: PROOF_PACK.asOf,
      contentDigestSeen: PROOF_PACK.contentDigest,
      review: { recipientConfirmed: true, contentConfirmed: true, evidenceConfirmed: true },
    });
    // The message itself is the API's to derive. A body here would be a figure this app chose.
    expect(sent["bodyText"]).toBeUndefined();
    expect(sent["generatedText"]).toBeUndefined();
  });

  it("offers only the attachable evidence the pack cites, and says why the rest is not offered", async () => {
    routes();
    renderWithQuery(<ProofPackPreview preview={PACK_WITH_RECEIPT} />);

    expect(await screen.findByLabelText("Blinkit receipt")).toBeInTheDocument();
    // The UPI notification in the fixture is cited but never attachable.
    expect(screen.queryByLabelText("Notification")).not.toBeInTheDocument();
    expect(screen.getByText(/never attachable/)).toBeInTheDocument();
  });

  it("names the attachments in the consequence, so nobody sends a document by accident", async () => {
    routes();
    renderWithQuery(<ProofPackPreview preview={PACK_WITH_RECEIPT} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/Their WhatsApp number/), "+919876543210");
    await reviewAll(user);
    await user.click(screen.getByLabelText("Blinkit receipt"));
    await user.click(screen.getByRole("button", { name: /Send through/ }));

    expect(
      within(screen.getByRole("dialog")).getByText(/with 1 receipt attached/),
    ).toBeInTheDocument();
  });

  it("reports an already-sent pack as sent nothing, not as a second send", async () => {
    routes({
      "/api/proof-packs/p-alex/deliveries": (_url: string, init: RequestInit | undefined) =>
        init?.method === "POST" ? { delivery: SENT_DELIVERY, sentNow: false } : { deliveries: [] },
    });
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/Their WhatsApp number/), "+919876543210");
    await reviewAll(user);
    await user.click(screen.getByRole("button", { name: /Send through/ }));
    await user.click(screen.getByRole("button", { name: "Send it" }));

    expect(
      await screen.findByText(/An identical pack had already gone to that number/),
    ).toBeInTheDocument();
  });

  it("shows a failed delivery with its reason and a way to try again", async () => {
    routes({
      "/api/proof-packs/p-alex/deliveries": {
        deliveries: [
          {
            ...SENT_DELIVERY,
            status: "failed",
            attemptCount: 1,
            sentAt: null,
            lastError: "That number is not registered on WhatsApp.",
            retryable: true,
          },
        ],
      },
    });
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);

    expect(await screen.findAllByText("Failed")).not.toHaveLength(0);
    expect(screen.getAllByText("That number is not registered on WhatsApp.")).not.toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Try again" })).not.toHaveLength(0);
  });

  it("says an empty sharing record is a statement about this ledger, not about what was sent elsewhere", async () => {
    routes();
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);

    expect(
      await screen.findByText(/not about what you may have sent by other means/),
    ).toBeInTheDocument();
  });

  it("keeps copying and sending as visibly different acts", async () => {
    routes();
    renderWithQuery(<ProofPackPreview preview={PROOF_PACK} />);

    expect(await screen.findByRole("button", { name: /Send through/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy the message/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Copying puts the text on your clipboard; sending puts it in front/),
    ).toBeInTheDocument();
  });
});
