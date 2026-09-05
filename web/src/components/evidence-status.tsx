import type { ObligationEvidenceStatus } from "@/lib/types";

/**
 * The three-value read-only annotation ADR-0014 defines. Sentence case, a small marker glyph
 * instead of a colored pill — this is a nuance about evidence, not a status to alarm over.
 */
const STATUS: Record<
  ObligationEvidenceStatus,
  { label: string; marker: string; className: string }
> = {
  open_unconfirmed: { label: "Open", marker: "○", className: "text-ink-muted" },
  believed_settled_unconfirmed_by_ledger: {
    label: "Believed settled",
    marker: "~",
    className: "text-accent",
  },
  settled_confirmed: { label: "Confirmed", marker: "✓", className: "text-credit" },
};

export function EvidenceStatus({ status }: { status: ObligationEvidenceStatus }) {
  const { label, marker, className } = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-meta ${className}`}>
      <span aria-hidden="true" className="font-mono">
        {marker}
      </span>
      {label}
    </span>
  );
}
