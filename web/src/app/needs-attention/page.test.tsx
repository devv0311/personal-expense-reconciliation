import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import NeedsAttentionPage from "@/app/needs-attention/page";
import { mockApi, mockApiFailure, mockApiPending } from "@/test-support/api-mock";
import {
  CLASSIFICATION_QUESTION,
  DOCUMENT_QUESTION,
  UNKNOWN_QUESTION,
  attentionResult,
} from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

/**
 * This screen's job is to be answerable by somebody who has never read the schema, one question
 * at a time.
 *
 * So the tests are about the wording, the refusals and the queue: a question rather than a kind,
 * only the facts needed to decide, an unread total that says so rather than showing ₹0, a kind
 * this UI has never seen still reachable, no way to approve anything without opening a dialog,
 * and a *Decide later* that writes nothing at all.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderPage(body: unknown = attentionResult()) {
  mockApi({ "/api/attention": body });
  return renderWithQuery(<NeedsAttentionPage />);
}

/** Every POST the page has issued so far. The number that matters on a read-only surface. */
function writes(): unknown[] {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
}

describe("questions, not kinds", () => {
  it("leads with the question and the plain reason it is being asked", async () => {
    renderPage();

    await screen.findByRole("heading", { name: "What was this payment for?" });
    expect(screen.getByText(/nothing becomes true until you agree with it/)).toBeInTheDocument();
    // The stored kind never reaches the surface.
    expect(screen.queryByText(/classification_decision/)).not.toBeInTheDocument();
    expect(screen.queryByText("Unmatched evidence")).not.toBeInTheDocument();
  });

  it("shows only the facts needed to decide, beside the decision", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "What was this payment for?" });

    expect(screen.getByRole("heading", { name: "Supporting records" })).toBeInTheDocument();
    expect(screen.getByText("What the record says")).toBeInTheDocument();
    // Not the model, not the prompt version, not the stored proposal.
    expect(screen.queryByText(/prompt version/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/High confidence|Low confidence/)).not.toBeInTheDocument();
  });

  it("never prints a reason code or a confidence score on the primary surface", async () => {
    // Found by looking at the rendered screen: the focused view listed the API's raw
    // `reasons`, so a category question opened with "Why this came up: low_confidence" —
    // a stored enum and a confidence score, both of which the language rules keep off a
    // primary screen. How sure the reading is reaches the reader as "This is probably".
    renderPage(attentionResult([CLASSIFICATION_QUESTION]));
    await screen.findByRole("heading", { name: "What was this payment for?" });

    expect(screen.queryByText("low_confidence")).not.toBeInTheDocument();
    expect(screen.queryByText(/Low confidence/)).not.toBeInTheDocument();
    expect(screen.queryByText("Why this came up")).not.toBeInTheDocument();
    expect(screen.getByText(/This is probably/)).toBeInTheDocument();
  });

  it("keeps a plain reason for a question that has no suggestion to explain itself", async () => {
    renderPage(
      attentionResult([
        { ...DOCUMENT_QUESTION, reasons: ["ambiguous_evidence_match", "low_confidence"] },
      ]),
    );
    await screen.findByRole("heading", { name: "What payment is this document about?" });

    expect(screen.getByText("Why this came up")).toBeInTheDocument();
    expect(screen.getByText("More than one payment could match")).toBeInTheDocument();
    // The score is filtered even here — it is a measurement, not a reason.
    expect(screen.queryByText(/[Ll]ow confidence/)).not.toBeInTheDocument();
  });

  it("says an unread document has no known amount rather than showing ₹0", async () => {
    renderPage(attentionResult([DOCUMENT_QUESTION]));
    await screen.findByRole("heading", { name: "What payment is this document about?" });

    expect(screen.getByText("Amount not known")).toBeInTheDocument();
    expect(screen.getAllByText("Not known yet").length).toBeGreaterThan(0);
    expect(screen.queryByText("₹0.00")).not.toBeInTheDocument();
  });
});

describe("one question at a time", () => {
  it("puts a single question on screen and counts the rest", async () => {
    // The defect this closes: thirty-five questions rendered as thirty-five cards is a screen
    // you scroll, not a screen you answer — no question is more urgent than the one below it.
    renderPage(attentionResult([CLASSIFICATION_QUESTION, DOCUMENT_QUESTION, UNKNOWN_QUESTION]));

    await screen.findByRole("heading", { name: "What was this payment for?" });
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    // The others are listed, but only the one on screen can be answered from here.
    expect(screen.getByRole("heading", { name: "Still to come" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Yes, /i })).toHaveLength(1);
  });

  it("answers what a payment was for before the checks that need a comparison", async () => {
    // The API's own priority order puts a long run of near-identical duplicate rows first. A
    // purpose question can be answered in a tap; a document or a comparison cannot.
    renderPage(attentionResult([DOCUMENT_QUESTION, CLASSIFICATION_QUESTION]));

    await screen.findByRole("heading", { name: "What was this payment for?" });
    expect(
      screen.queryByRole("heading", { name: "What payment is this document about?" }),
    ).not.toBeInTheDocument();
  });

  it("brings the next question forward when one is set aside, and writes nothing doing it", async () => {
    renderPage(attentionResult([CLASSIFICATION_QUESTION, DOCUMENT_QUESTION]));
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "What was this payment for?" });

    await user.click(screen.getByRole("button", { name: "Decide later" }));

    await screen.findByRole("heading", { name: "What payment is this document about?" });
    expect(screen.getByText(/1 set aside for now/)).toBeInTheDocument();
    // The whole promise of the button: no decision, no deferral, no note reaches the ledger.
    expect(writes()).toHaveLength(0);
  });

  it("says a set-aside question was not recorded, and offers it back", async () => {
    renderPage(attentionResult([CLASSIFICATION_QUESTION]));
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "What was this payment for?" });

    await user.click(screen.getByRole("button", { name: "Decide later" }));

    await screen.findByText("That is everything except the ones you set aside.");
    expect(screen.getByText(/Nothing was recorded about it/)).toBeInTheDocument();
    expect(writes()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Bring it back" }));
    expect(
      await screen.findByRole("heading", { name: "What was this payment for?" }),
    ).toBeInTheDocument();
  });

  it("moves focus to the new question so a keyboard does not lose its place", async () => {
    renderPage(attentionResult([CLASSIFICATION_QUESTION, DOCUMENT_QUESTION]));
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "What was this payment for?" });

    await user.click(screen.getByRole("button", { name: "Decide later" }));

    const heading = await screen.findByRole("heading", {
      name: "What payment is this document about?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  // The three tests below close the same gap from three directions. Focus followed a question
  // replacing a question, but not the queue running out or filling back up: the control the
  // reader had just pressed was removed with the question, and the cursor fell to <body> — the
  // content swapped silently under a keyboard, which is what focus-following exists to prevent.

  it("keeps a keyboard's place when the last question is set aside", async () => {
    renderPage(attentionResult([CLASSIFICATION_QUESTION]));
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "What was this payment for?" });

    await user.click(screen.getByRole("button", { name: "Decide later" }));

    // The exact element, not "an element containing this text": <body> contains every line on
    // the page, so a text match on the active element passes when focus has been lost.
    const lead = await screen.findByText("That is everything except the ones you set aside.");
    await waitFor(() => expect(document.activeElement).toBe(lead));
  });

  it("keeps a keyboard's place when the last question is answered", async () => {
    let answered = false;
    mockApi({
      "/api/attention": () => attentionResult(answered ? [] : [CLASSIFICATION_QUESTION]),
      "/decision": () => {
        answered = true;
        return { outcome: "accepted" };
      },
    });
    renderWithQuery(<NeedsAttentionPage />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "What was this payment for?" });

    await user.click(screen.getByRole("button", { name: /^Yes, /i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /That's what it was/ }));

    const lead = await screen.findByText("Nothing is waiting on you.");
    await waitFor(() => expect(document.activeElement).toBe(lead));
  });

  it("returns a keyboard to the question when the set-aside ones are brought back", async () => {
    renderPage(attentionResult([CLASSIFICATION_QUESTION]));
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "What was this payment for?" });
    await user.click(screen.getByRole("button", { name: "Decide later" }));
    await screen.findByText("That is everything except the ones you set aside.");

    await user.click(screen.getByRole("button", { name: "Bring it back" }));

    const heading = await screen.findByRole("heading", { name: "What was this payment for?" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("does not move focus when the page is opened on an empty queue", async () => {
    // Arriving must never pull the cursor off the skip link — the rule the question heading
    // already follows, and the one a fix for the three cases above could most easily break.
    renderPage(attentionResult([]));
    await screen.findByText("Nothing is waiting on you.");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("nothing is decided from this screen", () => {
  it("reveals the existing inspector rather than offering an approve button", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "What was this payment for?" });

    expect(screen.queryByRole("button", { name: "Accept this proposal" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Other ways to answer this" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Accept this proposal" })).toBeInTheDocument(),
    );
  });

  it("writes nothing when the screen is merely opened and read", async () => {
    renderPage(attentionResult([CLASSIFICATION_QUESTION, DOCUMENT_QUESTION, UNKNOWN_QUESTION]));
    await screen.findByRole("heading", { name: "What was this payment for?" });
    expect(writes()).toHaveLength(0);
  });

  it("links a question to the event it is about", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "What was this payment for?" });
    expect(screen.getByRole("link", { name: "See everything about this" })).toHaveAttribute(
      "href",
      "/connections/pay-1",
    );
  });
});

describe("a kind this screen has never seen", () => {
  it("stays visible under the generic question the API wrote", async () => {
    renderPage(attentionResult([UNKNOWN_QUESTION]));

    await screen.findByRole("heading", { name: "Does this still need your judgement?" });
    expect(screen.getByText(/cannot describe in plain words yet/)).toBeInTheDocument();
  });

  it("offers the full queue rather than a dead end when its inspector is opened", async () => {
    renderPage(attentionResult([UNKNOWN_QUESTION]));
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Does this still need your judgement?" });

    await user.click(screen.getByRole("button", { name: "Other ways to answer this" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open the full review queue" })).toBeInTheDocument(),
    );
  });
});

describe("loading, empty and error", () => {
  it("announces loading without drawing a count", () => {
    mockApiPending();
    renderWithQuery(<NeedsAttentionPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking what is waiting");
  });

  it("says the list is empty rather than letting it read as a filter", async () => {
    renderPage(attentionResult([]));
    await screen.findByText("Nothing is waiting on you.");
    expect(screen.getByText(/not a filter hiding something/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add records" })).toHaveAttribute("href", "/add");
  });

  it("reports a failure instead of an empty queue", async () => {
    mockApiFailure("INTERNAL", "Something went wrong.", 500);
    renderWithQuery(<NeedsAttentionPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("Nothing is waiting on you.")).not.toBeInTheDocument();
  });

  it("keeps the unfiltered queue reachable", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "What was this payment for?" });
    expect(screen.getByRole("link", { name: "The full review queue" })).toHaveAttribute(
      "href",
      "/review",
    );
  });
});

describe("the choice set is usable without hovering or expanding", () => {
  it("shows the recommendation, the alternatives and their reasons on the card", async () => {
    renderPage(attentionResult([CLASSIFICATION_QUESTION]));
    await screen.findByRole("heading", { name: "What was this payment for?" });

    expect(screen.getByRole("button", { name: /Yes, gym & fitness/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Health" })).toBeInTheDocument();
    // The reason an alternative is offered is visible text, not a tooltip a phone never shows.
    expect(screen.getByText("It could also be health or medicine.")).toBeInTheDocument();
  });

  it("opens the whole list from a control that says what it does", async () => {
    renderPage(attentionResult([CLASSIFICATION_QUESTION]));
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "What was this payment for?" });

    const control = screen.getByRole("button", { name: "Choose another category" });
    expect(control).toHaveAttribute("aria-expanded", "false");
    await user.click(control);

    const select = await screen.findByLabelText("What was it for?");
    expect(within(select).getByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Other" })).toBeInTheDocument();
  });

  it("does not offer a one-tap answer for a question with no suggestion", async () => {
    renderPage(attentionResult([DOCUMENT_QUESTION]));
    await screen.findByRole("heading", { name: "What payment is this document about?" });

    expect(screen.queryByRole("button", { name: /^Yes, /i })).not.toBeInTheDocument();
    expect(screen.getByText(/needs a look at the records themselves/)).toBeInTheDocument();
  });
});
