import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddRecords } from "@/components/add/add-records";
import { mockApi } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";

/**
 * **Add records** is the first thing somebody does, so what it is tested on is whether it can
 * be used by a person who does not know this system's words. Three properties carry that:
 *
 *  - It asks what you are holding before it shows you a form, and pre-answers nothing.
 *  - Choosing a kind explains what adding it does *and what it does not do* — in particular
 *    that a statement is not spending until something says what it was for.
 *  - Nothing is written from the page itself. Every form is still a button that opens a dialog
 *    stating its consequence (ADR-0049), so no test here can click through to a write.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderAdd() {
  mockApi({
    "/api/overview": {
      spending: {
        period: { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
        total: { known: true, amount: "0" },
        categories: [],
        caveats: { excludes: [] },
      },
      unexplained: {
        total: { known: true, amount: "0" },
        movementCount: 0,
        scanned: 0,
        complete: true,
        movements: [],
      },
      attention: { total: 0, reviewQueueTotal: 0, counts: {} },
      readiness: { recordsAwaitingAnalysis: 0, documentsAwaitingAnalysis: 0 },
      people: {
        toCollect: { known: true, amount: "0" },
        toPay: { known: true, amount: "0" },
        counterparties: [],
        settled: [],
      },
      recent: [],
      empty: false,
    },
    "/api/accounts": { accounts: [{ id: "acc-1", name: "HDFC Savings", last4: "4821" }] },
  });
  return renderWithQuery(<AddRecords />);
}

describe("Add records", () => {
  it("asks what you have before it shows a form, and chooses nothing for you", async () => {
    renderAdd();

    expect(screen.getByRole("heading", { name: "What have you got?" })).toBeInTheDocument();
    for (const title of [
      "A bank or card statement",
      "A bill or receipt",
      "A payment screenshot or message",
      "A payment nobody will send you a statement for",
    ]) {
      expect(screen.getByRole("button", { name: new RegExp(title) })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
    // No form is mounted until something is chosen.
    expect(screen.queryByRole("button", { name: "Choose a statement file" })).toBeNull();
  });

  it("explains what a statement does, and that it is not spending yet", async () => {
    const user = userEvent.setup();
    renderAdd();

    await user.click(screen.getByRole("button", { name: /A bank or card statement/ }));

    expect(screen.getByRole("button", { name: "Choose a statement file" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing on it counts as spending yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/If any line cannot be read, nothing at all is added/i),
    ).toBeInTheDocument();
  });

  it("offers both ways to give it a payment screenshot", async () => {
    const user = userEvent.setup();
    renderAdd();

    await user.click(screen.getByRole("button", { name: /A payment screenshot or message/ }));

    expect(screen.getByRole("button", { name: "Upload a screenshot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste the message" })).toBeInTheDocument();
  });

  it("says plainly that a note about a repayment moves no money", async () => {
    const user = userEvent.setup();
    renderAdd();

    await user.click(screen.getByRole("button", { name: /Something you want to write down/ }));

    expect(screen.getByText(/It moves no money and clears no balance/i)).toBeInTheDocument();
  });

  it("shows only one form at a time", async () => {
    const user = userEvent.setup();
    renderAdd();

    await user.click(screen.getByRole("button", { name: /A bank or card statement/ }));
    await user.click(screen.getByRole("button", { name: /A bill or receipt/ }));

    expect(screen.getByRole("button", { name: "Choose a bill or receipt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose a statement file" })).toBeNull();
  });

  it("tells you what happens next in the order it happens", () => {
    renderAdd();
    const steps = screen.getByRole("heading", { name: "What happens after you add something" });
    expect(steps).toBeInTheDocument();
    expect(screen.getByText("The records are read")).toBeInTheDocument();
    expect(screen.getByText("Records about the same thing are put together")).toBeInTheDocument();
    expect(screen.getByText("You answer what is left")).toBeInTheDocument();
  });
});
