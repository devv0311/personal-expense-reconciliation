import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExpenseStateTag, sentenceCaseState } from "./expense-state-tag";

describe("sentenceCaseState", () => {
  it("converts a single-word state", () => {
    expect(sentenceCaseState("approved")).toBe("Approved");
  });

  it("converts a multi-word state to sentence case, not title case", () => {
    expect(sentenceCaseState("ready_to_sync")).toBe("Ready to sync");
    expect(sentenceCaseState("review_required")).toBe("Review required");
  });
});

describe("ExpenseStateTag", () => {
  it("renders rejected in debit red", () => {
    render(<ExpenseStateTag state="rejected" />);
    expect(screen.getByText("Rejected")).toHaveClass("text-debit");
  });

  it("renders synced in credit green", () => {
    render(<ExpenseStateTag state="synced" />);
    expect(screen.getByText("Synced")).toHaveClass("text-credit");
  });

  it("renders approved in the accent tone", () => {
    render(<ExpenseStateTag state="approved" />);
    expect(screen.getByText("Approved")).toHaveClass("text-accent");
  });
});
