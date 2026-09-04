import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiscrepancyList } from "./discrepancy-list";

describe("DiscrepancyList", () => {
  it("shows a reassuring message when there are no discrepancies", () => {
    render(<DiscrepancyList discrepancies={[]} />);
    expect(screen.getByText(/no discrepancies/i)).toBeInTheDocument();
  });

  it("renders a known kind with its friendly label", () => {
    render(
      <DiscrepancyList
        discrepancies={[{ kind: "splitwise_fetch_failed", detail: "sandbox unreachable" }]}
      />,
    );
    expect(screen.getByText("Couldn't check Splitwise")).toBeInTheDocument();
    expect(screen.getByText("sandbox unreachable")).toBeInTheDocument();
  });

  it("still renders an unrecognised kind, using its own detail text", () => {
    render(
      <DiscrepancyList
        discrepancies={[{ kind: "some_future_kind", detail: "a new kind of discrepancy" }]}
      />,
    );
    expect(screen.getByText("some_future_kind")).toBeInTheDocument();
    expect(screen.getByText("a new kind of discrepancy")).toBeInTheDocument();
  });

  it("resolves person names when a people list is provided", () => {
    render(
      <DiscrepancyList
        discrepancies={[
          {
            kind: "splitwise_balance_mismatch",
            detail: "mismatch",
            personAId: "p1",
            personBId: "p2",
            externalNetBalance: "3000",
          },
        ]}
        people={[
          { id: "p1", displayName: "Dev", splitwiseUserId: null, isUser: true },
          { id: "p2", displayName: "Alex", splitwiseUserId: "sw-alex", isUser: false },
        ]}
      />,
    );
    expect(screen.getByText(/Between Dev and Alex/)).toBeInTheDocument();
    expect(screen.getByText("₹30.00")).toBeInTheDocument();
  });
});
