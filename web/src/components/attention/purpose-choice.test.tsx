import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "@/components/attention/question-card";
import { mockApi } from "@/test-support/api-mock";
import { CLASSIFICATION_QUESTION, INTEREST_QUESTION } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { AttentionItem } from "@/lib/types";

/**
 * Saying what a payment was for.
 *
 * The tests are about the three ways this can mislead somebody: sounding certain when it is
 * not, offering a category on a line that is not a purchase, and making a correction harder
 * than an agreement. The fourth — writing anything without being asked — is covered by there
 * being no path from a click to a request that does not pass through the dialog.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderQuestion(item: AttentionItem = CLASSIFICATION_QUESTION) {
  const api = mockApi({ "/decision": { outcome: "accepted" } });
  renderWithQuery(<QuestionCard item={item} openHref={null} />);
  return api;
}

describe("what a payment looks like it was for", () => {
  it("leads with the suggestion and the plain reason, before any way to go looking", () => {
    renderQuestion();

    expect(screen.getByText(/This is probably/)).toBeInTheDocument();
    expect(screen.getByText("Gym & fitness")).toBeInTheDocument();
    expect(screen.getByText(/usually means a gym/i)).toBeInTheDocument();
  });

  it("says how sure it is in words, never as a score", () => {
    const { rerender } = renderWithQuery(
      <QuestionCard
        item={{
          ...CLASSIFICATION_QUESTION,
          suggestion: { ...CLASSIFICATION_QUESTION.suggestion!, confidence: "high" },
        }}
        openHref={null}
      />,
    );
    expect(screen.getByText(/This looks like/)).toBeInTheDocument();

    rerender(
      <QuestionCard
        item={{
          ...CLASSIFICATION_QUESTION,
          suggestion: { ...CLASSIFICATION_QUESTION.suggestion!, confidence: "low" },
        }}
        openHref={null}
      />,
    );
    expect(screen.getByText(/This might be/)).toBeInTheDocument();
    expect(screen.queryByText(/confidence|%|score/i)).toBeNull();
  });

  it("offers the alternatives it has, with their reasons, and the whole list behind a control that says so", async () => {
    const user = userEvent.setup();
    renderQuestion();

    expect(screen.getByRole("button", { name: "Health" })).toBeInTheDocument();
    // The reason is visible text rather than a `title`: a tooltip does not exist on a phone.
    expect(screen.getByText("It could also be health or medicine.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose another category" }));

    const select = screen.getByLabelText("What was it for?");
    expect(within(select).getByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Other" })).toBeInTheDocument();
  });

  it("agreeing sends an agreement, not a rewrite", async () => {
    const user = userEvent.setup();
    const api = renderQuestion();

    await user.click(screen.getByRole("button", { name: /Yes, gym & fitness/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /That's what it was/ }));

    await waitFor(() => expect(api.callsTo("/decision")).toHaveLength(1));
    expect(api.bodyOf("/decision")).toMatchObject({ decision: "accept" });
  });

  it("choosing something else sends the correction through the same decision", async () => {
    const user = userEvent.setup();
    const api = renderQuestion();

    await user.click(screen.getByRole("button", { name: "Health" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /That's what it was/ }));

    await waitFor(() => expect(api.callsTo("/decision")).toHaveLength(1));
    expect(api.bodyOf("/decision")).toMatchObject({
      decision: "modify",
      modifiedOutput: { proposedKind: "expense", category: "Health", paidByPersonHint: null },
    });
  });

  it("states what confirming does, and what it does not, before it happens", async () => {
    const user = userEvent.setup();
    renderQuestion();

    await user.click(screen.getByRole("button", { name: /Yes, gym & fitness/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(/counts it under that from now on/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/creates no debt to anybody/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/will be suggested this category/i)).toBeInTheDocument();
  });

  it("writes nothing from the card itself", async () => {
    const user = userEvent.setup();
    const api = renderQuestion();

    await user.click(screen.getByRole("button", { name: "Health" }));
    expect(api.callsTo("/decision")).toHaveLength(0);
  });
});

describe("a line that is not a purchase", () => {
  it("warns before it offers anything at all", () => {
    renderQuestion(INTEREST_QUESTION);

    expect(screen.getByText(/not a purchase of its own/i)).toBeInTheDocument();
    expect(screen.getByText(/count the same money twice/i)).toBeInTheDocument();
  });

  it("never offers the shop named on the same line", () => {
    renderQuestion(INTEREST_QUESTION);

    expect(screen.getByText("Bills & subscriptions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Yes, gym & fitness/i })).toBeNull();
    expect(screen.getByText(/Interest is what the card charged you/i)).toBeInTheDocument();
  });

  it("says so again in the dialog, rather than only on the card", async () => {
    const user = userEvent.setup();
    renderQuestion(INTEREST_QUESTION);

    await user.click(screen.getByRole("button", { name: /Yes, bills & subscriptions/i }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/interest, a fee or a repayment rather than a purchase/i),
    ).toBeInTheDocument();
  });
});

describe("a payment nothing has proposed anything about", () => {
  it("explains the reading, offering nothing to agree with", () => {
    renderQuestion({
      ...CLASSIFICATION_QUESTION,
      suggestion: { ...CLASSIFICATION_QUESTION.suggestion!, inferenceId: null },
    });

    expect(screen.getByText(/Nothing is suggested for this payment yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Yes, gym & fitness/i })).toBeNull();
  });
});
