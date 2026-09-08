import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "@/test-support/api-mock";
import {
  CATEGORY_SPEND,
  MONTHLY_SPEND,
  OUTSTANDING,
  OWN_SPEND,
  OWN_SPEND_WITH_PENDING,
  UNSETTLED,
} from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";
import type { OwnSpendResult } from "@/lib/types";
import AnalyticsPage from "./page";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderAnalytics(own: OwnSpendResult = OWN_SPEND) {
  const api = mockApi({
    "/api/analytics/own-spend": own,
    "/api/analytics/spending": CATEGORY_SPEND,
    "/api/analytics/monthly": MONTHLY_SPEND,
    "/api/analytics/outstanding": OUTSTANDING,
    "/api/analytics/unsettled": UNSETTLED,
  });
  renderWithQuery(<AnalyticsPage />);
  return api;
}

describe("analytics", () => {
  it("leads with the user's own share, not what passed through the account", async () => {
    renderAnalytics();

    const label = await screen.findByText("Your own share");
    // The hero is the sibling of its label, sized `text-display` — the one figure this screen
    // is built around. The same amount appears further down as an expense's net cost, which is
    // why this asserts on the hero rather than on the text anywhere on the page.
    const hero = label.parentElement!;
    expect(hero.querySelector(".text-display")).toHaveTextContent("₹2,400.00");
    // Both other figures are present but supporting: fronting money is not spending it.
    expect(screen.getByText("₹4,000.00")).toBeInTheDocument();
    expect(screen.getByText("₹1,600.00")).toBeInTheDocument();
  });

  it("states what every total leaves out rather than implying precision it lacks", async () => {
    renderAnalytics();

    expect(await screen.findByText(/Never included/)).toBeInTheDocument();
    expect(screen.getByText(/rejected expenses/)).toBeInTheDocument();
  });

  it("warns when a contributing expense has a refund the allocation has not absorbed", async () => {
    renderAnalytics(OWN_SPEND_WITH_PENDING);

    expect(
      await screen.findByText(/1 expense has a refund the allocation does not reflect yet/),
    ).toBeInTheDocument();
  });

  it("keeps owed-to-you and owed-by-you as two totals, never a net", async () => {
    renderAnalytics();

    await waitFor(() => expect(screen.getAllByText("Alex")).not.toHaveLength(0));
    expect(screen.getByText(/is owed to you and/)).toBeInTheDocument();
    expect(screen.getByText(/does not cancel what you owe/)).toBeInTheDocument();
  });

  it("asks the API for the period rather than filtering a full history here", async () => {
    const api = renderAnalytics();

    await waitFor(() => expect(api.callsTo("/api/analytics/spending")).not.toHaveLength(0));
    const url = api.callsTo("/api/analytics/spending")[0]!.url;
    expect(url).toContain("from=");
    expect(url).toContain("to=");
  });

  it("names an uncategorised group rather than leaving the row blank", async () => {
    renderAnalytics();

    expect(await screen.findByText("No category")).toBeInTheDocument();
  });
});
