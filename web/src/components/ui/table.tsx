"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Every table gets the same horizontal-scroll-on-overflow container for free — pass a
 * `min-w-[...]` in `className` for a dense table the way the callers of this component already
 * did by hand before; narrow tables (e.g. `ReconciliationTotals`) simply never trigger it.
 *
 * **The container becomes focusable exactly when it actually scrolls** (phase 21). A region a
 * mouse can pan but a keyboard cannot reach is a real WCAG failure (axe's
 * `scrollable-region-focusable`), and it started firing the moment the dense new tables met a
 * 360px viewport. Adding `tabIndex={0}` unconditionally would have fixed the audit by putting a
 * useless tab stop in front of every small table on every screen, so this measures instead —
 * and re-measures on resize, because the same table scrolls on a phone and does not on a
 * desktop.
 */
export function Table({ className, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const [label, setLabel] = useState("Scrollable table");

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const measure = () => {
      setScrollable(container.scrollWidth > container.clientWidth + 1);
      // The table's own `sr-only` caption names the region, so two scrollable tables on one
      // screen are told apart by what they contain rather than by both being "a table".
      const caption = container.querySelector("caption")?.textContent?.trim();
      if (caption !== undefined && caption.length > 0) setLabel(caption);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="overflow-x-auto"
      // `group`, not `region`: a landmark would need a unique name against every other
      // landmark on the page, and a scroll container is not a landmark — it is a thing you
      // can put focus in and pan with the arrow keys.
      {...(scrollable ? { tabIndex: 0, role: "group", "aria-label": label } : {})}
    >
      <table className={cn("w-full text-body", className)} {...props} />
    </div>
  );
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("sr-only", className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={className} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={className} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-rule last:border-b-0", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn("py-2 text-left text-meta font-normal text-ink-muted", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("py-2.5", className)} {...props} />;
}
