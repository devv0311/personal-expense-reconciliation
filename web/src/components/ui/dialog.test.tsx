import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { Table, TableBody, TableCaption, TableCell, TableRow } from "@/components/ui/table";

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      <button type="button">Outside</button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        title="A consequential decision"
        description="What it will do"
        footer={<button type="button">Confirm</button>}
      >
        <button type="button">First</button>
        <button type="button">Second</button>
      </Dialog>
    </>
  );
}

describe("the dialog primitive", () => {
  it("is a labelled modal, described by its own description", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open it" }));

    const dialog = screen.getByRole("dialog", { name: "A consequential decision" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("What it will do");
  });

  it("takes focus onto the panel, never onto a button that would act", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open it" }));

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Confirm" }));
  });

  it("keeps Tab inside the dialog", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open it" }));
    const dialog = screen.getByRole("dialog");

    screen.getByRole("button", { name: "Confirm" }).focus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));

    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and restores focus to whatever opened it", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Open it" });
    await user.click(trigger);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open it" }));

    await user.click(document.querySelector('[aria-hidden="true"]')!);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("renders nothing at all while closed", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("the table primitive", () => {
  it("leaves a table that fits alone, with no stray tab stop", () => {
    render(
      <Table>
        <TableCaption>Two small rows</TableCaption>
        <TableBody>
          <TableRow>
            <TableCell>One</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    // jsdom reports every element as zero-width, so nothing scrolls and nothing is focusable.
    const container = screen.getByRole("table").parentElement!;
    expect(container).not.toHaveAttribute("tabindex");
    expect(container).not.toHaveAttribute("role");
  });

  it("makes an overflowing table reachable by keyboard, named by its caption", async () => {
    // jsdom does not lay out, so the measurement is forced the way a narrow viewport would.
    const proto = window.HTMLElement.prototype;
    const scrollWidth = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 300 });

    render(
      <Table>
        <TableCaption>Item breakdown with refunds applied</TableCaption>
        <TableBody>
          <TableRow>
            <TableCell>One</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    await waitFor(() => {
      const region = screen.getByRole("group", { name: "Item breakdown with refunds applied" });
      expect(region).toHaveAttribute("tabindex", "0");
    });

    if (scrollWidth !== undefined) Object.defineProperty(proto, "scrollWidth", scrollWidth);
  });
});
