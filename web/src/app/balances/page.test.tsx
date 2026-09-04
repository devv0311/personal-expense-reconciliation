import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test-support/render-with-query";
import BalancesPage from "./page";

const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PEOPLE = [
  { id: "p-dev", displayName: "Dev", splitwiseUserId: null, isUser: true },
  { id: "p-alex", displayName: "Alex", splitwiseUserId: "sw-alex", isUser: false },
];

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("BalancesPage", () => {
  it("shows a loading state, then the person pickers once people load", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { people: PEOPLE }));
    renderWithQuery(<BalancesPage />);

    expect(screen.getByText(/loading people/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Person A")).toBeInTheDocument());
  });

  it("shows an error with retry when the people request fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "boom" } }));
    renderWithQuery(<BalancesPage />);

    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("shows the settled headline once two people with net balance 0 are chosen", async () => {
    global.fetch = vi.fn().mockImplementation((input: string | URL) => {
      const url = input.toString();
      if (url.includes("/api/people"))
        return Promise.resolve(jsonResponse(200, { people: PEOPLE }));
      if (url.includes("/api/balances/")) {
        return Promise.resolve(
          jsonResponse(200, {
            personAId: "p-dev",
            personBId: "p-alex",
            netBalance: "0",
            evidenceStatus: "settled_confirmed",
            contributions: [],
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const user = userEvent.setup();
    renderWithQuery(<BalancesPage />);

    await waitFor(() => expect(screen.getByLabelText("Person A")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Person A"), "Dev (you)");
    await user.selectOptions(screen.getByLabelText("Person B"), "Alex");

    await waitFor(() => expect(screen.getByText("settled")).toBeInTheDocument());
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
  });

  it("shows a prompt instead of calling the API when both selects name the same person", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { people: PEOPLE }));
    const user = userEvent.setup();
    renderWithQuery(<BalancesPage />);

    await waitFor(() => expect(screen.getByLabelText("Person A")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Person A"), "Dev (you)");
    await user.selectOptions(screen.getByLabelText("Person B"), "Dev (you)");

    expect(screen.getByText(/choose two different people/i)).toBeInTheDocument();
    const balanceCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => (url as string).includes("/api/balances/"));
    expect(balanceCalls).toHaveLength(0);
  });
});
