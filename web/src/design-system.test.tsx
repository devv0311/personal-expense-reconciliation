import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewQueue } from "@/components/review/review-queue";
import { ShortcutProvider } from "@/components/app-shell/shortcuts";
import ExpensesPage from "@/app/expenses/page";
import { ExpenseDetail } from "@/components/expenses/expense-detail";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCaption, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import NeedsAttentionPage from "@/app/needs-attention/page";
import { Overview } from "@/components/overview/overview";
import { PaymentRows } from "@/components/payments/payment-rows";
import { ResponsiveTable } from "@/components/responsive-table";
import { mockApi } from "@/test-support/api-mock";
import {
  CLASSIFICATION_QUESTION,
  EXPENSE,
  OVERVIEW,
  PEOPLE,
  REFUND_STATE_PENDING,
  UNEXPLAINED_PAYMENT,
  attentionResult,
  reviewQueue,
} from "@/test-support/fixtures";
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

/** WCAG 2.x relative-luminance contrast, recomputed rather than trusted. */
function contrast(a: string, b: string): number {
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
}

/** The nth definition of a token in the stylesheet: 0 is light, 1 is the dark-scheme override. */
function token(name: string, occurrence: number): string {
  const matches = [...globalsCss.matchAll(new RegExp(`--${name}: (#[0-9a-f]{6});`, "g"))];
  return matches[occurrence]![1]!;
}

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

  it("keeps the serif to headings and leaves every figure in tabular mono", () => {
    // The third face added in the 2026-09-19 pass. It is confined to text a person reads as a
    // sentence; a proportional-numeral serif on a column of money would undo the one thing the
    // mono face is load-bearing for.
    render(<Money paise="123456" tone="credit" size="figure" />);
    const figure = screen.getByText("₹1,234.56");
    expect(figure).toHaveClass("font-mono");
    expect(figure).toHaveClass("tabular");
    expect(figure.className).not.toContain("font-serif");

    const { container } = render(<PageHeader title="A screen" description="What it answers." />);
    expect(container.querySelector("h1")).toHaveClass("font-serif");
  });

  it("gives the primary control a 48px target and the secondary one 40px", () => {
    // The brief's "clear 48px controls". `sm` stays smaller deliberately: it is the inline
    // secondary action, and a row of full-height buttons would shout over the primary one.
    render(
      <>
        <Button>Decide</Button>
        <Button size="sm">Show more</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Decide" })).toHaveClass("h-12");
    expect(screen.getByRole("button", { name: "Show more" })).toHaveClass("h-10");
  });

  it("keeps body text at a readable 16px and the scale in one place", () => {
    // Body was 14px — a dense-table size. This product is read one decision at a time.
    expect(globalsCss).toContain("--text-body: 1rem;");
    // A bracketed size in a component is the scale being bypassed rather than extended.
    for (const token of ["micro", "meta", "body", "emphasis", "h1", "figure", "display"]) {
      expect(globalsCss).toMatch(new RegExp(`--text-${token}: `));
    }
  });

  it("holds the whole palette to AA, not only the faintest token", () => {
    // Every text token, on the page and on a raised panel, in both themes. Recomputed from the
    // stylesheet rather than trusted, because the 2026-09-19 pass replaced all of them at once
    // and a single value regressing is invisible to every other test in this file.
    const readable = [
      "ink",
      "ink-muted",
      "ink-faint",
      "debit",
      "credit",
      "accent",
      "attention",
    ] as const;
    for (const theme of [0, 1]) {
      for (const name of readable) {
        for (const surface of ["paper", "panel"] as const) {
          // Named in the message so a failure says which pair in which theme, not just "4.1".
          expect(
            `${theme === 0 ? "light" : "dark"} ${name} on ${surface}: ${contrast(token(name, theme), token(surface, theme)).toFixed(2)}`,
          ).toBe(
            `${theme === 0 ? "light" : "dark"} ${name} on ${surface}: ${Math.max(4.5, contrast(token(name, theme), token(surface, theme))).toFixed(2)}`,
          );
        }
      }
      // A filled primary button's label, on the fill.
      expect(contrast(token("accent-ink", theme), token("accent", theme))).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("meets the AA contrast bar for the faintest text token, in both themes", () => {
    // `ink-faint` is the token nearest the threshold, and it is what a "of ₹2,150.00"
    // annotation and every hint line is set in — so it keeps its own named test.
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

  it("puts the decision above its supporting records on a phone, and beside them on a desktop", async () => {
    // The two-column split on the focused question is `lg`, not `sm`, on purpose: at tablet
    // width the category buttons would sit in a channel too narrow to read their own reasons,
    // which is the thing the layout exists to keep visible. Below it, the decision comes first
    // in document order — so on a phone the choice is not behind six rows of detail.
    mockApi({ "/api/attention": attentionResult([CLASSIFICATION_QUESTION]) });
    const { container } = renderWithQuery(<NeedsAttentionPage />);

    await screen.findByRole("heading", { name: "What was this payment for?" });
    const split = [...container.querySelectorAll("div.grid")].find((node) =>
      node.className.includes("lg:grid-cols-"),
    )!;
    expect(split).not.toBeUndefined();
    expect(split.className).not.toContain("sm:grid-cols-");

    const choice = screen.getByRole("button", { name: /Yes, gym & fitness/i });
    const supporting = screen.getByRole("heading", { name: "Supporting records" });
    expect(choice.compareDocumentPosition(supporting) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("lets the front page's two summaries share a row only once there is room", async () => {
    mockApi({ "/api/overview": OVERVIEW });
    const { container } = renderWithQuery(<Overview />);

    await waitFor(() => expect(screen.getByText("Spent this period")).toBeInTheDocument());
    const pair = [...container.querySelectorAll("div.grid")].find((node) =>
      node.className.includes("lg:grid-cols-2"),
    )!;
    expect(pair).not.toBeUndefined();
    // `min-w-0` on each track: a grid item's default `min-width: auto` sizes the column to its
    // longest unbreakable string, so one long merchant narration would widen the whole page
    // past the phone it is on and the truncation inside the row could never take effect.
    for (const track of pair.children) {
      expect(track.className).toContain("min-w-0");
    }
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

describe("one long narration never widens a phone-width page", () => {
  /**
   * A bank prints a UPI line as one unbroken token — nothing in
   * `UPI/DR/000000000113/SYNTHCAFE/...` is a space to break at — and a real statement is full of
   * them. In a flex row a link's default `min-width: auto` is that whole token, so the figure
   * beside it was pushed past the edge of the phone and the page panned sideways, which
   * `Design.md` forbids. Found at 375px on `/payments`, `/expenses`, `/review` and — through
   * `ResponsiveTable` — `/ask`, in September 2026. The text now wraps anywhere and the figure
   * never shrinks, the same `min-w-0` / `shrink-0` pairing the front page already used.
   */
  const LONG =
    "UPI/DR/000000000113/SYNTHETICCAFEANDBAKERY/ABCD/synthcafe@okaxis/PAYMENTFROMPHONENOTE";

  it("wraps a payment's narration in the phone list and keeps its amount whole", () => {
    const { container } = renderWithQuery(
      <PaymentRows payments={[{ ...UNEXPLAINED_PAYMENT, rawDescription: LONG }]} />,
    );
    const stacked = container.querySelector<HTMLElement>("ul.sm\\:hidden")!;
    const link = within(stacked).getByRole("link", { name: LONG });
    expect(link.className).toContain("min-w-0");
    expect(link.className).toContain("wrap-anywhere");
    expect(link.nextElementSibling!.className).toContain("shrink-0");
  });

  it("wraps an expense's description in the phone list and keeps its amount whole", async () => {
    mockApi({
      "/api/expenses": { expenses: [{ ...EXPENSE, description: LONG }] },
      "/api/people": { people: PEOPLE },
    });
    const { container } = renderWithQuery(<ExpensesPage />);

    await waitFor(() => expect(screen.getAllByText(LONG)).toHaveLength(2));
    const stacked = container.querySelector<HTMLElement>("ul.sm\\:hidden")!;
    const link = within(stacked).getByRole("link", { name: LONG });
    expect(link.className).toContain("min-w-0");
    expect(link.className).toContain("wrap-anywhere");
    expect(link.nextElementSibling!.className).toContain("shrink-0");
  });

  it("keeps the review queue's list inside its column on a phone", async () => {
    mockApi({ "/api/review": reviewQueue() });
    renderWithQuery(
      <ShortcutProvider renderOverlays={() => null}>
        <ReviewQueue kind={null} />
      </ShortcutProvider>,
    );

    const list = await screen.findByRole("list", { name: "Items waiting for a decision" });
    // The one-column grid below lg sizes its track to the list's longest unbreakable string
    // unless the list may shrink.
    expect(list.className).toContain("min-w-0");
    const row = within(list).getAllByRole("button")[0]!;
    const [headline, title] = [...row.children] as HTMLElement[];
    expect(headline!.firstElementChild!.className).toContain("min-w-0");
    expect(headline!.lastElementChild!.className).toContain("shrink-0");
    expect(title!.className).toContain("wrap-anywhere");
  });

  it("wraps a stacked table's title and values rather than widening the page", () => {
    const { container } = render(
      <ResponsiveTable
        caption="Synthetic rows"
        columns={[
          { key: "title", header: "Title", render: (row: { text: string }) => row.text },
          { key: "value", header: "Value", render: (row: { text: string }) => row.text },
        ]}
        rows={[{ text: LONG }]}
        rowKey={(row) => row.text}
      />,
    );
    const stacked = container.querySelector<HTMLElement>("ul.sm\\:hidden")!;
    expect(stacked.querySelector("li > div")!.className).toContain("wrap-anywhere");
    expect(stacked.querySelector("dt")!.className).toContain("shrink-0");
    const value = stacked.querySelector("dd")!;
    expect(value.className).toContain("min-w-0");
    expect(value.className).toContain("wrap-anywhere");
  });
});

describe("two accessibility rules a browser sweep found, kept as unit tests", () => {
  it("positions the table scroll container, so an sr-only caption cannot escape it", () => {
    render(
      <Table className="min-w-[520px]">
        <TableCaption>A wide table</TableCaption>
        <TableBody>
          <TableRow>
            <TableCell>A cell</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const container = screen.getByRole("table").parentElement!;
    // `overflow` alone does not make an element the containing block for an absolutely
    // positioned descendant, so without `relative` an `sr-only` caption inside a table wider
    // than the viewport resolves against the viewport, lands outside it, and makes the whole
    // page pan sideways. Found on /setup at 360px; fixed once, here.
    expect(container.className).toContain("relative");
    expect(container.className).toContain("overflow-x-auto");
  });

  it("underlines a text link at rest rather than distinguishing it by colour alone", () => {
    render(
      <p>
        Some surrounding prose{" "}
        {/* An external href on purpose: the rule under test is about how a link *looks*, and
            `next/link` would drag routing into a styling assertion. */}
        <a href="https://example.invalid" className="text-accent underline underline-offset-2">
          and a link inside it
        </a>
        .
      </p>,
    );

    const link = screen.getByRole("link");
    // WCAG 1.4.1, and axe's `link-in-text-block`: a link sitting in a block of text cannot be
    // told apart by colour alone. `hover:underline` is not enough — it is not there at rest.
    expect(link.className).toContain("underline");
    expect(link.className).not.toContain("hover:underline");
  });
});
