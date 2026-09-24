import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MorePage from "@/app/more/page";
import RecordsPage from "@/app/records/page";
import { mockApi, mockApiFailure, mockApiPending } from "@/test-support/api-mock";
import { attentionResult } from "@/test-support/fixtures";
import { renderWithQuery } from "@/test-support/render-with-query";

/**
 * **Records** is the former **More**, promoted into the primary row.
 *
 * The promise it has to keep is the one the whole information-architecture pass rests on:
 * nothing was removed. So these tests are mostly an inventory — every specialist route is still
 * one click from here, and the address it used to live at still resolves.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Every specialist screen phases 15–22 and the unnumbered capabilities built. */
const EVERY_SPECIALIST_ROUTE = [
  "/payments",
  "/evidence",
  "/expenses",
  "/reconciliation",
  "/balances",
  "/analytics",
  "/splitwise",
  "/proof-packs",
  "/setup",
  "/automation",
  "/ask",
  "/review",
];

describe("records keeps every specialist screen reachable", () => {
  it("links to all of them, so the four tabs removed nothing", async () => {
    mockApi({ "/api/attention": attentionResult([]) });
    renderWithQuery(<RecordsPage />);

    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    for (const route of EVERY_SPECIALIST_ROUTE) {
      expect(hrefs).toContain(route);
    }
  });

  it("still renders at the address it used to live at", async () => {
    mockApi({ "/api/attention": attentionResult([]) });
    renderWithQuery(<MorePage />);

    // A bookmark and a deep link from an older note are exactly the readers this product
    // promised not to break.
    await screen.findByRole("heading", { name: "Records", level: 1 });
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/reconciliation");
  });

  it("keeps Add records reachable from here too", async () => {
    mockApi({ "/api/attention": attentionResult([]) });
    renderWithQuery(<RecordsPage />);
    expect(screen.getByRole("link", { name: "Add records" })).toHaveAttribute("href", "/add");
  });
});

describe("the one live thing on the page", () => {
  it("says what is still waiting, and points at the queue", async () => {
    mockApi({ "/api/attention": attentionResult() });
    renderWithQuery(<RecordsPage />);

    await waitFor(() => expect(screen.getByText(/2 things are/)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Go through them" })).toHaveAttribute(
      "href",
      "/needs-attention",
    );
  });

  it("claims nothing about the queue before the queue has answered", () => {
    mockApiPending();
    renderWithQuery(<RecordsPage />);

    // No "0 waiting", no skeleton making a claim. The routes below are static and render now.
    expect(screen.queryByText(/waiting on a decision/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Reconciliation/ })).toBeInTheDocument();
  });

  it("stays usable when the queue read fails, because the routes do not depend on it", async () => {
    mockApiFailure("INTERNAL", "Ledger unavailable", 500);
    renderWithQuery(<RecordsPage />);

    await waitFor(() =>
      expect(screen.queryByText(/waiting on a decision/)).not.toBeInTheDocument(),
    );
    const sections = screen.getAllByRole("heading", { level: 2 });
    expect(within(document.body).getByRole("link", { name: /^Every payment/ })).toHaveAttribute(
      "href",
      "/payments",
    );
    expect(sections.length).toBeGreaterThanOrEqual(4);
  });

  it("writes nothing when the page is opened", async () => {
    mockApi({ "/api/attention": attentionResult() });
    renderWithQuery(<RecordsPage />);

    await waitFor(() => expect(screen.getByText(/2 things are/)).toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      0,
    );
  });
});
