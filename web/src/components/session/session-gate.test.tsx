import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionGate } from "@/components/session/session-gate";
import { mockApi, mockApiFailure, type ApiMock } from "@/test-support/api-mock";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderGate(session: Record<string, unknown>): ApiMock {
  const api = mockApi({
    "/api/session/password": { passwordSet: true },
    "/api/session": (_url: string, init: RequestInit | undefined) =>
      init?.method === "POST"
        ? { session: { userId: "u-1", personId: "p-dev", email: "dev@example.com" } }
        : session,
  });
  renderWithQuery(
    <SessionGate>
      <h1>The ledger</h1>
    </SessionGate>,
  );
  return api;
}

describe("the session gate", () => {
  it("renders the ledger untouched when the API is not enforcing authentication", async () => {
    renderGate({
      session: null,
      authenticationConfigured: false,
      authenticationRequired: false,
    });

    expect(await screen.findByText("The ledger")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("offers to set a password rather than a sign-in form nobody could satisfy", async () => {
    const api = renderGate({
      session: null,
      authenticationConfigured: false,
      authenticationRequired: true,
    });
    const user = userEvent.setup();

    expect(await screen.findByText("No password has been set yet")).toBeInTheDocument();
    expect(screen.queryByText("The ledger")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.type(screen.getByLabelText("Again"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Set it" }));

    await waitFor(() => expect(api.callsTo("/api/session/password")).not.toHaveLength(0));
  });

  it("will not set a password the two fields disagree about", async () => {
    renderGate({
      session: null,
      authenticationConfigured: false,
      authenticationRequired: true,
    });
    const user = userEvent.setup();

    await screen.findByText("No password has been set yet");
    await user.type(screen.getByLabelText("Password"), "one thing");
    await user.type(screen.getByLabelText("Again"), "another");

    expect(screen.getByText("These do not match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set it" })).toBeDisabled();
  });

  it("asks for a sign-in once a password exists, and hides the ledger until then", async () => {
    const api = renderGate({
      session: null,
      authenticationConfigured: true,
      authenticationRequired: true,
    });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("The ledger")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "dev@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "POST")).not.toHaveLength(0),
    );
  });

  it("shows the ledger to a signed-in session", async () => {
    renderGate({
      session: {
        userId: "u-1",
        personId: "p-dev",
        email: "dev@example.com",
        actor: "user",
        expiresAt: "2026-09-30T00:00:00.000Z",
      },
      authenticationConfigured: true,
      authenticationRequired: true,
    });

    expect(await screen.findByText("The ledger")).toBeInTheDocument();
  });

  it("treats an unreachable API as a failure to report, not as being signed out", async () => {
    mockApiFailure("NETWORK_ERROR", "Couldn't reach the API.");
    renderWithQuery(
      <SessionGate>
        <h1>The ledger</h1>
      </SessionGate>,
    );

    expect(await screen.findByText(/Couldn't reach the API/)).toBeInTheDocument();
    // The app still renders: locking a person out because a status read failed would be worse.
    expect(screen.getByText("The ledger")).toBeInTheDocument();
  });
});
