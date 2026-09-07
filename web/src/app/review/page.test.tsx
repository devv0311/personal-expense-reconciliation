import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutProvider } from "@/components/app-shell/shortcuts";
import { mockApi, mockApiFailure, mockApiPending, type ApiMock } from "@/test-support/api-mock";
import {
  CLASSIFICATION_ITEM,
  DUPLICATE_ITEM,
  UNMATCHED_EVIDENCE_ITEM,
  reviewQueue,
} from "@/test-support/fixtures";
import { resetNavigation } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { ReviewQueueItem } from "@/lib/types";
import ReviewPage from "./page";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

/** The queue lives inside the shortcut layer, because it registers its own triage keys. */
function renderReview(
  items: readonly ReviewQueueItem[] = [CLASSIFICATION_ITEM, UNMATCHED_EVIDENCE_ITEM],
): ApiMock {
  const api = mockApi({
    "/api/review": reviewQueue(items),
    "/api/evidence/ev-1/matches": {
      evidenceId: "ev-1",
      candidates: UNMATCHED_EVIDENCE_ITEM.matchCandidates,
    },
    "/api/evidence/matches/cand-1/decision": {
      candidate: { ...UNMATCHED_EVIDENCE_ITEM.matchCandidates[0], status: "accepted" },
      evidence: {},
      outcome: "accepted",
    },
    "/api/review/inferences/inf-1/decision": { decided: true },
    "/api/review/payments/pay-later/duplicate": { decision: "confirm" },
  });
  renderWithQuery(
    <ShortcutProvider renderOverlays={() => null}>
      <ReviewPage />
    </ShortcutProvider>,
  );
  return api;
}

describe("the review queue", () => {
  it("shows a count per kind, before any filter, and the queue in the API's own order", async () => {
    renderReview();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Everything 2/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Classification 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unmatched evidence 1/ })).toBeInTheDocument();

    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByText("Classification")).toBeInTheDocument();
  });

  it("filters by kind without changing the counts, which describe the whole ledger", async () => {
    const api = renderReview();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Everything 2/ })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Classification 1/ }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes("kinds=classification_decision"))).toBe(
        true,
      ),
    );
    expect(screen.getByRole("button", { name: /Everything 2/ })).toBeInTheDocument();
  });

  it("prompts for a selection rather than opening something the reader did not choose", async () => {
    renderReview();

    await waitFor(() =>
      expect(screen.getByText(/Choose an item to see everything/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the model's proposal, its confidence and what produced it, but never approves it", async () => {
    const api = renderReview([CLASSIFICATION_ITEM]);
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getAllByText("Classification").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /UPI-ZOMATO4471/ }));

    expect(await screen.findByText("What the model proposed")).toBeInTheDocument();
    expect(screen.getByText("Medium confidence")).toBeInTheDocument();
    expect(screen.getByText("scripted-classifier-v1")).toBeInTheDocument();
    expect(screen.getByText(/A proposal, not state/)).toBeInTheDocument();
    expect(api.callsTo("/decision")).toHaveLength(0);
  });

  it("records an acceptance only after the dialog's own button is pressed", async () => {
    const api = renderReview([CLASSIFICATION_ITEM]);
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getAllByText("Classification").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /UPI-ZOMATO4471/ }));
    await user.click(await screen.findByRole("button", { name: /accept this proposal/i }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/lets this proposal become authoritative state/i),
    ).toBeInTheDocument();
    expect(api.callsTo("/decision")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(api.callsTo("/decision")).toHaveLength(1));
    expect(api.bodyOf("/decision")).toMatchObject({ actor: "user", decision: "accept" });
  });

  it("makes confirming a duplicate require a reason, and says it discards the later payment", async () => {
    const api = renderReview([DUPLICATE_ITEM]);
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getAllByText("Possible duplicate").length).toBeGreaterThan(0),
    );
    await user.click(screen.getAllByRole("button", { name: /UPI-UNKNOWN-MERCHANT-8841/ })[0]!);
    await user.click(await screen.findByRole("button", { name: /confirm duplicate/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/discards the later payment/i)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Confirm duplicate" });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/reason/i), "Same UTR, imported twice");
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    await waitFor(() => expect(api.callsTo("/duplicate")).toHaveLength(1));
    expect(api.bodyOf("/duplicate")).toMatchObject({
      decision: "confirm",
      duplicateOfPaymentId: "pay-earlier",
      reason: "Same UTR, imported twice",
    });
  });

  it("shows an unmatched document's reading and its candidates, and links nothing on its own", async () => {
    const api = renderReview([UNMATCHED_EVIDENCE_ITEM]);
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getAllByText("Unmatched evidence").length).toBeGreaterThan(0),
    );
    await user.click(screen.getByRole("button", { name: /PEPPERMILL CAFE/ }));

    expect(await screen.findByText("What was read off it")).toBeInTheDocument();
    expect(screen.getByText("Parsed from the text, deterministically")).toBeInTheDocument();
    // Both verdicts are visible, including the one that disagrees.
    expect(screen.getAllByText("Agrees").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Disagrees").length).toBeGreaterThan(0);
    expect(api.callsTo("/decision")).toHaveLength(0);
  });

  it("warns that attaching a document is permanent before it does it", async () => {
    const api = renderReview([UNMATCHED_EVIDENCE_ITEM]);
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getAllByText("Unmatched evidence").length).toBeGreaterThan(0),
    );
    await user.click(screen.getByRole("button", { name: /PEPPERMILL CAFE/ }));
    await user.click(await screen.findByRole("button", { name: /attach to this payment/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText(/permanent/i).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/write-once/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /attach permanently/i }));
    await waitFor(() => expect(api.callsTo("/matches/cand-1/decision")).toHaveLength(1));
    expect(api.bodyOf("/matches/cand-1/decision")).toMatchObject({ decision: "accept" });
  });

  it("says the queue is empty rather than implying a filter is hiding something", async () => {
    renderReview([]);

    await waitFor(() =>
      expect(screen.getByText(/Nothing is waiting for a decision/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/the counts above are the whole ledger/)).toBeInTheDocument();
  });

  it("announces a loading state, then a retryable error", async () => {
    mockApiPending();
    const { unmount } = renderWithQuery(
      <ShortcutProvider renderOverlays={() => null}>
        <ReviewPage />
      </ShortcutProvider>,
    );
    expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0);
    unmount();

    mockApiFailure("INTERNAL_ERROR", "queue unavailable");
    renderWithQuery(
      <ShortcutProvider renderOverlays={() => null}>
        <ReviewPage />
      </ShortcutProvider>,
    );
    await waitFor(() => expect(screen.getAllByText(/queue unavailable/).length).toBeGreaterThan(0));
  });
});

describe("keyboard triage in the review queue", () => {
  it("moves the selection with j and k, and never decides anything", async () => {
    const api = renderReview();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(2));

    await user.keyboard("j");
    await waitFor(() =>
      expect(document.querySelector('[aria-current="true"]')?.textContent).toContain(
        "Classification",
      ),
    );

    await user.keyboard("j");
    await waitFor(() =>
      expect(document.querySelector('[aria-current="true"]')?.textContent).toContain(
        "Unmatched evidence",
      ),
    );

    await user.keyboard("k");
    await waitFor(() =>
      expect(document.querySelector('[aria-current="true"]')?.textContent).toContain(
        "Classification",
      ),
    );

    // The whole point: navigating a queue is not deciding anything in it.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("clears the selection on Escape", async () => {
    renderReview();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(2));
    await user.keyboard("j");
    await waitFor(() => expect(document.querySelector('[aria-current="true"]')).not.toBeNull());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector('[aria-current="true"]')).toBeNull());
  });

  it("ignores a triage key typed into a field", async () => {
    renderReview([CLASSIFICATION_ITEM]);
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(1));
    await user.click(screen.getByRole("button", { name: /UPI-ZOMATO4471/ }));
    await user.click(await screen.findByRole("button", { name: /^reject$/i }));

    const reason = screen.getByLabelText(/reason/i);
    await user.type(reason, "jk");
    expect(reason).toHaveValue("jk");
  });
});
