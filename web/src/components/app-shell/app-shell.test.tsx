import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell/app-shell";
import { mockApi } from "@/test-support/api-mock";
import { FINDING, PEOPLE, RUN, reviewQueue } from "@/test-support/fixtures";
import { pushedRoutes, resetNavigation, setPathname } from "@/test-support/next-navigation";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

function renderShell() {
  mockApi({
    "/api/review": reviewQueue(),
    "/api/people": { people: PEOPLE },
    "/api/reconciliation/runs": { runs: [RUN] },
    "/api/splitwise/audit-findings": { findings: [FINDING] },
  });
  // `AppShell` provides its own QueryProvider, so this renders it directly rather than through
  // `renderWithQuery` — the shell under test is the one the real layout mounts.
  return render(
    <AppShell>
      <h1>A screen</h1>
    </AppShell>,
  );
}

describe("the application shell", () => {
  it("puts a skip link first, pointing at the main region", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.tab();
    const skip = document.activeElement as HTMLElement;
    expect(skip).toHaveTextContent("Skip to content");
    expect(skip).toHaveAttribute("href", "#main");
    expect(document.getElementById("main")).not.toBeNull();
  });

  it("offers one entry per workflow, and marks the current one", async () => {
    setPathname("/expenses");
    renderShell();

    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/review",
      "/reconciliation",
      "/expenses",
      "/balances",
      "/splitwise",
      "/proof-packs",
    ]);
    expect(within(nav).getByRole("link", { name: "Expenses" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows how many items are waiting, from the queue's own total", async () => {
    renderShell();

    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());
    expect(screen.getByText("items waiting")).toBeInTheDocument();
  });
});

describe("the command palette", () => {
  it("opens on Cmd+K and on Ctrl+K, and closes on Escape", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog", { name: /command palette/i })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: /command palette/i })).toBeInTheDocument();
  });

  it("is a combobox over a listbox, with the search field keeping focus", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: /search commands/i });
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-activedescendant")).not.toBeNull();
  });

  it("navigates on Enter, and only ever navigates", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(pushedRoutes).toEqual(["/reconciliation"]));
    // Nothing the palette does is a POST.
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      0,
    );
  });

  it("searches people, recent runs and open findings, not just the six screens", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByRole("listbox");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Balance with Alex/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("option", { name: /Proof pack for Alex/ })).toBeInTheDocument();
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(screen.getByText("Open findings")).toBeInTheDocument();
  });

  it("filters as you type, and says so when nothing matches", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: /search commands/i });

    await user.type(input, "balances");
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Proof packs g p/ })).not.toBeInTheDocument(),
    );

    await user.clear(input);
    await user.type(input, "zzzz");
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });
});

describe("global keyboard shortcuts", () => {
  it("navigates with a g-prefixed pair", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.keyboard("gb");
    await waitFor(() => expect(pushedRoutes).toEqual(["/balances"]));
  });

  it("does not navigate when the same keys are typed into a field", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: /search commands/i });
    await user.type(input, "gb");

    expect(pushedRoutes).toEqual([]);
    expect(input).toHaveValue("gb");
  });

  it("lists every shortcut on ?, so none of them is a secret", async () => {
    renderShell();
    const user = userEvent.setup();

    await user.keyboard("?");
    const dialog = await screen.findByRole("dialog", { name: /keyboard shortcuts/i });
    expect(within(dialog).getByText("Open the command palette")).toBeInTheDocument();
    expect(within(dialog).getByText("Go to balances")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Approving, distributing and copying stay explicit button presses/),
    ).toBeInTheDocument();
  });

  it("restores focus to whatever opened a dialog when it closes", async () => {
    renderShell();
    const user = userEvent.setup();

    const trigger = screen.getByRole("button", { name: /open the command palette/i });
    trigger.focus();
    await user.click(trigger);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

it("keeps global navigation and other overlays out of an open dialog", async () => {
  renderShell();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  dialog.focus();
  await user.keyboard("gb?{Meta>}k{/Meta}");
  expect(pushedRoutes).toEqual([]);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog")).toBe(dialog);
  await user.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keyboard shortcuts" }));
});
