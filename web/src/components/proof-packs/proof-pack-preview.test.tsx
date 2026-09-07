import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofPackPreview } from "@/components/proof-packs/proof-pack-preview";
import ProofPacksPage from "@/app/proof-packs/page";
import { mockApi, mockApiFailure } from "@/test-support/api-mock";
import { PEOPLE, PROOF_PACK } from "@/test-support/fixtures";
import { resetNavigation, setSearchParams } from "@/test-support/next-navigation";
import { renderWithQuery } from "@/test-support/render-with-query";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  resetNavigation();
  vi.restoreAllMocks();
});

describe("the proof-pack preview", () => {
  it("quotes the pack's own figures — the balance, each share, each settlement", () => {
    render(<ProofPackPreview preview={PROOF_PACK} />);

    expect(screen.getByText("₹900.00", { selector: "span.text-figure" })).toBeInTheDocument();
    expect(screen.getByText("Alex owes you")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: /expenses this pack quotes/i });
    const row = within(table).getByText("Blinkit — weekly groceries").closest("tr")!;
    const cells = within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells[1]).toBe("₹2,150.00"); // gross
    expect(cells[3]).toBe("₹1,500.00"); // net
    expect(cells[4]).toBe("₹900.00"); // the recipient's share
    // The settlement is quoted too: 160000 paise is ₹1,600.00, formatted the Indian way.
    expect(
      within(screen.getByRole("region", { name: /already settled/i })).getByText("₹1,600.00"),
    ).toBeInTheDocument();
  });

  it("puts every warning before the message, not after it", () => {
    render(<ProofPackPreview preview={PROOF_PACK} />);

    const warnings = screen.getByRole("region", { name: /before you send this/i });
    expect(within(warnings).getByText("Unresolved Splitwise findings")).toBeInTheDocument();
    expect(
      warnings.compareDocumentPosition(screen.getByTestId("proof-pack-text")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows exactly what would be sent, verbatim", () => {
    render(<ProofPackPreview preview={PROOF_PACK} />);

    expect(screen.getByTestId("proof-pack-text")).toHaveTextContent("Alex owes me ₹900.00.");
    expect(
      screen.getByText(/an unredacted pack is refused rather than returned/i),
    ).toBeInTheDocument();
  });

  it("names the intended recipient and says nobody else is in the pack", () => {
    render(<ProofPackPreview preview={PROOF_PACK} />);

    expect(screen.getByText("Nobody else is named")).toBeInTheDocument();
    expect(screen.getByText(/Only you and Alex appear in this pack/)).toBeInTheDocument();
  });

  it("keeps copying disabled until the recipient, content and evidence are each confirmed", async () => {
    render(<ProofPackPreview preview={PROOF_PACK} />);
    const user = userEvent.setup();

    const copy = screen.getByRole("button", { name: /copy the message/i });
    expect(copy).toBeDisabled();

    await user.click(screen.getByLabelText(/The recipient is Alex/));
    expect(copy).toBeDisabled();
    await user.click(screen.getByLabelText(/I have read the message above/));
    expect(copy).toBeDisabled();
    await user.click(screen.getByLabelText(/I have checked which evidence it cites/));
    expect(copy).toBeEnabled();

    await user.click(copy);
    // `userEvent.setup()` installs a real clipboard stub, so this reads back what the page
    // actually put on it rather than trusting a spy.
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(PROOF_PACK.generatedText),
    );
    expect(
      await screen.findByText(/Nothing was sent and nothing was recorded/),
    ).toBeInTheDocument();
  });

  it("makes it clear that copying is where the pack stops being private", () => {
    render(<ProofPackPreview preview={PROOF_PACK} />);

    expect(screen.getByText(/Nothing is sent from this app/)).toBeInTheDocument();
    expect(screen.getByText(/which is the moment it stops being private/)).toBeInTheDocument();
  });

  it("says when a pack cites no supporting evidence at all", () => {
    render(<ProofPackPreview preview={{ ...PROOF_PACK, evidenceReferences: [] }} />);

    expect(screen.getByText("This pack cites no supporting evidence.")).toBeInTheDocument();
  });

  it("flags a pending refund and conflicting evidence on the line they belong to", () => {
    render(
      <ProofPackPreview
        preview={{
          ...PROOF_PACK,
          pack: {
            ...PROOF_PACK.pack,
            expenseLines: [
              {
                ...PROOF_PACK.pack.expenseLines[0]!,
                pendingDistribution: true,
                conflictingEvidence: true,
              },
            ],
          },
        }}
      />,
    );

    // Once in the desktop table and once in the stacked list below `sm` — the same warning,
    // rendered by both layouts, exactly one of which is ever in the accessibility tree.
    expect(screen.getAllByText(/has not reached the allocation yet/)).toHaveLength(2);
    expect(screen.getAllByText(/Two evidence records about this payment disagree/)).toHaveLength(2);
  });

  it("starts unreviewed again when the recipient changes", async () => {
    const { rerender } = render(<ProofPackPreview preview={PROOF_PACK} />);
    const user = userEvent.setup();

    await user.click(screen.getByLabelText(/The recipient is Alex/));
    expect(screen.getByLabelText(/The recipient is Alex/)).toBeChecked();

    rerender(
      <ProofPackPreview
        preview={{
          ...PROOF_PACK,
          intendedRecipient: { id: "p-sam", displayName: "Sam" },
        }}
      />,
    );
    expect(screen.getByLabelText(/The recipient is Sam/)).not.toBeChecked();
  });
});

describe("the proof-packs screen", () => {
  it("waits for a recipient rather than deriving a pack nobody asked for", async () => {
    const api = mockApi({ "/api/people": { people: PEOPLE } });
    renderWithQuery(<ProofPacksPage />);

    await waitFor(() => expect(screen.getByLabelText("Recipient")).toBeInTheDocument());
    expect(screen.getByText(/no third party is ever passed to the assembler/i)).toBeInTheDocument();
    expect(api.callsTo("/api/proof-packs/")).toHaveLength(0);
  });

  it("never offers the user as a recipient of their own pack", async () => {
    mockApi({ "/api/people": { people: PEOPLE } });
    renderWithQuery(<ProofPacksPage />);

    await waitFor(() => expect(screen.getByLabelText("Recipient")).toBeInTheDocument());
    const options = within(screen.getByLabelText("Recipient")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Choose a person", "Alex"]);
  });

  it("opens straight on the recipient a ?recipient= link names", async () => {
    setSearchParams({ recipient: "p-alex" });
    const api = mockApi({
      "/api/proof-packs/p-alex": PROOF_PACK,
      "/api/people": { people: PEOPLE },
    });
    renderWithQuery(<ProofPacksPage />);

    await waitFor(() => expect(api.callsTo("/api/proof-packs/p-alex")).toHaveLength(1));
    expect(await screen.findByText("Alex owes you")).toBeInTheDocument();
  });

  it("shows a retryable error instead of a half-rendered pack", async () => {
    setSearchParams({ recipient: "p-alex" });
    mockApiFailure("PAYLOAD_NOT_SANITIZED", "This pack still carries an identifier.");
    renderWithQuery(<ProofPacksPage />);

    await waitFor(() =>
      expect(screen.getAllByText(/still carries an identifier/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("button", { name: /copy the message/i })).not.toBeInTheDocument();
  });
});
