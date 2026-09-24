import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedRecords } from "@/components/attention/connected-records";
import { mockApi } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";

/**
 * The half of a review screen that is usually missing: what has already been decided.
 *
 * These assert the three things that make the list worth having rather than decorative — that
 * it distinguishes a decision somebody made from a record that arrived attached, that it says
 * when the only name a payment has is the bank's own wording, and that an empty list reads as
 * "nothing is connected yet" rather than as a filter hiding something.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const ACCEPTED = {
  evidenceId: "ev-1",
  recordWords: "Bill or receipt",
  capturedAt: "2026-09-02T10:00:00.000Z",
  payment: {
    paymentId: "pay-1",
    name: "Peppermill Cafe",
    nameSource: "counterparty",
    occurredAt: "2026-09-02T00:00:00.000Z",
    amount: "64000",
    direction: "debit",
  },
  origin: "you_accepted",
  decidedAt: "2026-09-03T09:00:00.000Z",
  decidedBy: "user:dev",
  why: ["The amount is the same.", "They happened at about the same time."],
};

function renderLinks(body: Record<string, unknown>) {
  mockApi({ "/api/links": body });
  return renderWithQuery(<ConnectedRecords />);
}

describe("Already connected", () => {
  it("says nothing is connected yet, rather than showing an empty table", async () => {
    renderLinks({ links: [], total: 0, truncated: false });

    expect(await screen.findByText("Nothing has been connected yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/This is the list being empty, not a filter hiding something/i),
    ).toBeInTheDocument();
  });

  it("credits the person who agreed, and shows why the two looked like one thing", async () => {
    renderLinks({ links: [ACCEPTED], total: 1, truncated: false });

    expect(await screen.findByRole("link", { name: "Peppermill Cafe" })).toHaveAttribute(
      "href",
      "/connections/pay-1",
    );
    expect(screen.getByText(/You agreed with a suggested match on/)).toBeInTheDocument();
    expect(screen.getByText("The amount is the same.")).toBeInTheDocument();
    // The stored actor string is audit-trail material, not something a reader should meet.
    expect(screen.queryByText(/user:dev/)).toBeNull();
  });

  it("tells a record that arrived attached apart from one somebody agreed to", async () => {
    renderLinks({
      links: [{ ...ACCEPTED, origin: "attached_when_added", decidedBy: null, why: [] }],
      total: 1,
      truncated: false,
    });

    expect(await screen.findByText("You said which payment this was about")).toBeInTheDocument();
    expect(screen.queryByText(/You agreed with a suggested match/)).toBeNull();
  });

  it("says when the only name a payment has is the bank's own wording", async () => {
    renderLinks({
      links: [
        {
          ...ACCEPTED,
          payment: { ...ACCEPTED.payment, name: "UPI-AMZN9821PYTM", nameSource: "narration" },
        },
      ],
      total: 1,
      truncated: false,
    });

    expect(await screen.findByText(/named from your bank's own wording/i)).toBeInTheDocument();
  });

  it("counts every connected record, not the page it was given", async () => {
    renderLinks({ links: [ACCEPTED], total: 12, truncated: true });

    expect(
      await screen.findByText(/The 1 most recent of 12 connected records/),
    ).toBeInTheDocument();
  });
});
