import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewQueue } from "@/components/review/review-queue";
import { ShortcutProvider } from "@/components/app-shell/shortcuts";
import ExpensesPage from "@/app/expenses/page";
import { ExpenseDetail } from "@/components/expenses/expense-detail";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import { mockApi } from "@/test-support/api-mock";
import { EXPENSE, PEOPLE, REFUND_STATE_PENDING, reviewQueue } from "@/test-support/fixtures";
import { resetNavigation } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

// Read from disk rather than imported: the assertions below are about the stylesheet's own
// text (a media query, a token's hex value), which a bundled import would have thrown away.
// Vitest runs with `web/` as the working directory.
const globalsCss = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * The rules `Design.md` says a regression in is a shipped bug, asserted rather than trusted.
 *
 * These are cheap and they catch exactly the two mistakes that pass a screenshot review: a
 * custom token that `tailwind-merge` silently drops, and motion that a person who asked for
 * less of it still gets.
 */
describe("the design system's load-bearing rules", () => {
  it("keeps a custom size token and a custom color token from cancelling each other out", () => {
    // The documented `tailwind-merge` pitfall: both are `text-*`, and both must survive.
    expect(cn("text-display", "text-debit")).toBe("text-display text-debit");
    expect(cn("text-figure", "text-credit")).toBe("text-figure text-credit");
    // Two sizes still conflict, as they should — the last one wins.
    expect(cn("text-body", "text-display")).toBe("text-display");
  });

  it("renders a hero figure with both its size and its tone intact", () => {
    render(<Money paise="0" tone="debit" size="display" />);
    const figure = screen.getByText("₹0.00");
    expect(figure).toHaveClass("text-display");
    expect(figure).toHaveClass("text-debit");
  });

  it("collapses every animation and transition under prefers-reduced-motion", () => {
    expect(globalsCss).toContain("@media (prefers-reduced-motion: reduce)");
    const block = globalsCss.slice(globalsCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation-duration: 0.001ms !important");
    expect(block).toContain("transition-duration: 0.001ms !important");
  });

  it("meets the AA contrast bar for the faintest text token, in both themes", () => {
    // Recomputed here rather than trusted: `ink-faint` is the token nearest the threshold, and
    // it is what a "of ₹2,150.00" annotation and every hint line is set in.
    const contrast = (a: string, b: string): number => {
      const luminance = (hex: string): number => {
        const channel = (value: number): number => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
          number,
          number,
          number,
        ];
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b2);
      };
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };

    const token = (name: string, occurrence: number): string => {
      const matches = [...globalsCss.matchAll(new RegExp(`--${name}: (#[0-9a-f]{6});`, "g"))];
      return matches[occurrence]![1]!;
    };

    // Light: on the page background and on a raised panel.
    expect(contrast(token("ink-faint", 0), token("paper", 0))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ink-faint", 0), token("panel", 0))).toBeGreaterThanOrEqual(4.5);
    // Dark: the second definition of each token, under `prefers-color-scheme: dark`.
    expect(contrast(token("ink-faint", 1), token("paper", 1))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ink-faint", 1), token("panel", 1))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("responsive behaviour", () => {
  it("gives a dense ledger table a separate stacked list below the sm breakpoint", async () => {
    mockApi({ "/api/expenses": { expenses: [EXPENSE] }, "/api/people": { people: PEOPLE } });
    const { container } = renderWithQuery(<ExpensesPage />);

    // Two renderings of one row: the desktop table and the mobile stacked list.
    await waitFor(() => expect(screen.getAllByText("Blinkit — weekly groceries")).toHaveLength(2));

    // Genuinely separate markup fed by the same data, not a CSS trick on the table itself.
    const table = container.querySelector("table")!;
    expect(table.className).toContain("hidden");
    expect(table.className).toContain("sm:table");
    const stacked = container.querySelector("ul.sm\\:hidden")!;
    expect(stacked).not.toBeNull();
    expect(stacked.textContent).toContain("Blinkit — weekly groceries");
  });

  it("gives every dense phase-21 table the same stacked list, with no figure left in a table only", async () => {
    mockApi({
      "/api/expenses/exp-1/refund-allocation": REFUND_STATE_PENDING,
      "/api/expenses/exp-1": EXPENSE,
      "/api/people": { people: PEOPLE },
    });
    const { container } = renderWithQuery(<ExpenseDetail expenseId="exp-1" />);

    await waitFor(() => expect(screen.getByText("Items")).toBeInTheDocument());

    // Every `sm:table` in this screen has a matching `sm:hidden` list, so nothing is reachable
    // only by horizontally scrolling a table on a phone — where a clipped ₹650.00 reads as ₹65.
    const desktopTables = container.querySelectorAll("table.sm\\:table");
    const stackedLists = container.querySelectorAll("ul.sm\\:hidden");
    expect(desktopTables.length).toBeGreaterThanOrEqual(3);
    expect(stackedLists.length).toBe(desktopTables.length);

    // And the figures really are in both: the fully refunded item's net cost, twice.
    expect(screen.getAllByText("₹650.00").length).toBeGreaterThan(2);
  });

  it("stacks the review queue's list and inspector into one column below lg", async () => {
    mockApi({ "/api/review": reviewQueue() });
    const { container } = renderWithQuery(
      <ShortcutProvider renderOverlays={() => null}>
        <ReviewQueue kind={null} />
      </ShortcutProvider>,
    );

    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(2));
    const grid = container.querySelector("div.grid")!;
    expect(grid.className).toContain("lg:grid-cols-");
    expect(grid.className).not.toContain("sm:grid-cols-");
  });
});
