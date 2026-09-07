"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A modal dialog, hand-built.
 *
 * `Design.md` says to reach for a headless primitive only when a control needs behavior HTML
 * does not provide, and to say which behavior justified it. Three do, and `<dialog>`'s own
 * `showModal()` is not usable here (jsdom, which every test in this package runs in, does not
 * implement it): **focus containment** while open, **restoring focus** to whatever opened it,
 * and **Escape** closing it. That is the whole of this file — about sixty lines — rather than a
 * headless component library and its transitive tree, which ADR-0043 declined for the same
 * reason it declined shadcn's CLI.
 *
 * Two consequences the callers depend on:
 *
 * - Every consequential action inside a dialog is still a button a person presses. Opening a
 *   dialog with a keyboard shortcut never pre-selects one (ADR-0049).
 * - The backdrop closes on click and the container is `role="dialog" aria-modal="true"`,
 *   labelled by the title this renders — never by a `title` attribute.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Focus the panel itself, not its first control: a dialog that lands on the first button
    // is one Enter away from an action the reader has not read yet.
    panelRef.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(panelRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-ink/25 dark:bg-paper/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className={cn(
          "relative w-full max-w-2xl rounded-sm border border-rule bg-panel",
          className,
        )}
      >
        <div className="border-b border-rule px-5 py-4">
          <h2 id={titleId} className="text-emphasis font-semibold text-ink">
            {title}
          </h2>
          {description !== undefined && (
            <p id={descriptionId} className="mt-1 text-meta text-ink-muted">
              {description}
            </p>
          )}
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer !== undefined && (
          <div className="flex flex-wrap justify-end gap-3 border-t border-rule px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Every focusable descendant, in DOM order.
 *
 * Deliberately not filtered by computed visibility: a dialog renders nothing hidden, and
 * `offsetParent`/`getClientRects` are both inert under jsdom — a visibility filter here would
 * quietly make the trap a no-op in exactly the environment that tests it.
 */
function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
}
