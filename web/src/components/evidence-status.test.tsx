import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceStatus } from "./evidence-status";

describe("EvidenceStatus", () => {
  it("renders sentence-case labels, never all-caps", () => {
    render(<EvidenceStatus status="open_unconfirmed" />);
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("renders the believed-settled label", () => {
    render(<EvidenceStatus status="believed_settled_unconfirmed_by_ledger" />);
    expect(screen.getByText("Believed settled")).toBeInTheDocument();
  });

  it("renders the confirmed label in credit green", () => {
    render(<EvidenceStatus status="settled_confirmed" />);
    expect(screen.getByText("Confirmed")).toHaveClass("text-credit");
  });
});
