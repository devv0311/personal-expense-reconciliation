"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Hand-owned modal isolation (ADR-0049/0050). A body portal lets the background become inert
 * without disabling the dialog itself. Focus starts on the panel, never a confirm button;
 * Tab stays inside, and close restores focus and the previous background state. Pending
 * decisions can disable dismissal without changing the explicit button-only approval path.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  dismissible?: boolean;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Focus the panel itself, not its first control: a dialog that lands on the first button
    // is one Enter away from an action the reader has not read yet.
    const background = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== layerRef.current,
    );
    const previous = background.map((element) => ({ element, inert: element.inert }));
    for (const { element } of previous) element.inert = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      for (const { element, inert } of previous) element.inert = inert;
      document.body.style.overflow = overflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (dismissible) onClose();
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
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return createPortal(
    <div
      ref={layerRef}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain p-3 sm:p-8"
    >
      <div
        aria-hidden="true"
        onClick={() => {
          if (dismissible) onClose();
        }}
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
        <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
          <div>
            <h2 id={titleId} className="text-emphasis font-semibold text-ink">
              {title}
            </h2>
            {description !== undefined && (
              <p id={descriptionId} className="mt-1 text-meta text-ink-muted">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Close dialog"
            disabled={!dismissible}
            onClick={onClose}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="m4 4 8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </Button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer !== undefined && (
          <div className="flex flex-wrap justify-end gap-3 border-t border-rule px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
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
