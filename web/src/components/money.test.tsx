import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Money } from "./money";

describe("Money", () => {
  it("renders the formatted amount", () => {
    render(<Money paise="640000" />);
    expect(screen.getByText("₹6,400.00")).toBeInTheDocument();
  });

  it("applies no color class by default (neutral)", () => {
    render(<Money paise="640000" />);
    const el = screen.getByText("₹6,400.00");
    expect(el).not.toHaveClass("text-debit");
    expect(el).not.toHaveClass("text-credit");
  });

  it("colors debit red when tone=debit", () => {
    render(<Money paise="640000" tone="debit" />);
    expect(screen.getByText("₹6,400.00")).toHaveClass("text-debit");
  });

  it("colors credit green when tone=credit", () => {
    render(<Money paise="0" tone="credit" />);
    expect(screen.getByText("₹0.00")).toHaveClass("text-credit");
  });

  it("never colors by sign alone — a negative value with tone=credit still renders green", () => {
    // This is the exact bug this component's design deliberately avoids: colour is the
    // caller's domain judgement, never derived from the raw sign.
    render(<Money paise="-64000" tone="credit" />);
    const el = screen.getByText("−₹640.00");
    expect(el).toHaveClass("text-credit");
    expect(el).not.toHaveClass("text-debit");
  });
});
