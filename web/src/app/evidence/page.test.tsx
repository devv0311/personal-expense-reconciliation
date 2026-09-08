import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, type ApiMock } from "@/test-support/api-mock";
import { evidenceLibrary } from "@/test-support/fixtures";
import { resetNavigation, setSearchParams } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";
import EvidencePage from "./page";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

function renderLibrary(): ApiMock {
  const api = mockApi({ "/api/evidence": evidenceLibrary() });
  renderWithQuery(<EvidencePage />);
  return api;
}

describe("the evidence library", () => {
  it("lists every stored document, saying what has been read off each", async () => {
    renderLibrary();

    expect(await screen.findAllByText(/Rs.640.00 debited/)).not.toHaveLength(0);
    expect(screen.getAllByText("Observation recorded")).not.toHaveLength(0);
    expect(screen.getAllByText("Receipt extracted")).not.toHaveLength(0);
  });

  it("marks a document attached to nothing rather than leaving the column blank", async () => {
    renderLibrary();

    expect(await screen.findAllByText("Nothing yet")).not.toHaveLength(0);
  });

  it("asks the API for unlinked evidence when a link arrives asking for it", async () => {
    setSearchParams({ linkage: "unlinked" });
    const api = renderLibrary();

    await waitFor(() =>
      expect(
        api.callsTo("/api/evidence").some((call) => call.url.includes("linkage=unlinked")),
      ).toBe(true),
    );
  });

  it("says an empty unlinked list is a fact about what is stored, not about what is missing", async () => {
    setSearchParams({ linkage: "unlinked" });
    mockApi({ "/api/evidence": evidenceLibrary([]) });
    renderWithQuery(<EvidencePage />);

    expect(
      await screen.findByText(/statement about what is stored, not about what is missing/),
    ).toBeInTheDocument();
  });

  it("filters by kind through the API rather than in the browser", async () => {
    const api = renderLibrary();
    const user = userEvent.setup();

    await screen.findAllByText(/Rs.640.00 debited/);
    await user.selectOptions(screen.getByLabelText("Kind"), "receipt_image");

    await waitFor(() =>
      expect(
        api.callsTo("/api/evidence").some((call) => call.url.includes("type=receipt_image")),
      ).toBe(true),
    );
  });
});
