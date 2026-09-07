import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { confidenceLabel, matchVerdictLabel, sentenceCase } from "@/lib/labels";
import type { ConfidenceLevel, EvidenceMatchVerdict } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The small semantic annotations shared across the review, evidence, audit and pack screens.
 *
 * Every one of them is colored text with an optional marker glyph, never a filled pill —
 * `Design.md`'s "No `Badge`" rule, applied consistently to the six new surfaces rather than
 * re-litigated on each. The color choices are the same three the design system already draws:
 * `debit` is "this is wrong", `attention` is "this is a finding", `accent` is "this is moving
 * normally", `credit` is "this is settled/confirmed".
 */

/**
 * A model's stated confidence.
 *
 * Never green, at any level. Confidence changes how much friction a proposal gets, never
 * whether it needs approval (`invariants.md` #16) — so rendering `high` as good news would be
 * the UI quietly making the argument the domain refuses to make.
 */
export function Confidence({ level }: { level: ConfidenceLevel }) {
  return (
    <span
      className={cn(
        "text-meta",
        level === "high" && "text-ink",
        level === "medium" && "text-ink-muted",
        (level === "low" || level === "unknown") && "text-attention",
      )}
    >
      {confidenceLabel(level)}
    </span>
  );
}

/** One evidence↔payment signal's verdict, with the marker glyphs phase 15 already established. */
export function SignalVerdict({ verdict }: { verdict: EvidenceMatchVerdict }) {
  const marker = verdict === "matched" ? "✓" : verdict === "conflicted" ? "✕" : "○";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-meta",
        verdict === "matched" && "text-credit",
        verdict === "conflicted" && "text-debit",
        verdict === "absent" && "text-ink-faint",
      )}
    >
      <span aria-hidden="true" className="font-mono">
        {marker}
      </span>
      {matchVerdictLabel(verdict)}
    </span>
  );
}

/**
 * Why something is waiting, or why a figure is not final.
 *
 * `attention`, never `debit`: these are findings to read, not failures. `role="alert"` is
 * deliberately absent for the same reason `DiscrepancyList` omits it (`Design.md`, `Alert`).
 */
export function NoteList({
  items,
  emptyLabel,
}: {
  items: readonly { readonly title: string; readonly detail?: ReactNode }[];
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return emptyLabel === undefined ? null : <p className="text-body text-credit">{emptyLabel}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`}>
          <Alert variant="attention">
            <p className="font-medium text-attention">{item.title}</p>
            {item.detail !== undefined && <p className="mt-1 text-ink-muted">{item.detail}</p>}
          </Alert>
        </li>
      ))}
    </ul>
  );
}

/** A row of quiet, comma-free reason chips — the "why is this here" line under a queue item. */
export function ReasonRow({
  reasons,
  label,
}: {
  reasons: readonly string[];
  label: (reason: string) => string;
}) {
  if (reasons.length === 0) return null;
  return (
    <p className="text-meta text-ink-muted">
      {reasons.map((reason, index) => (
        <span key={reason}>
          {index > 0 && (
            <span aria-hidden="true" className="text-ink-faint">
              {" "}
              ·{" "}
            </span>
          )}
          {label(reason)}
        </span>
      ))}
    </p>
  );
}

/** A state word, sentence-cased, in the tone the caller decided. Never a pill. */
export function StateWord({
  value,
  tone = "muted",
}: {
  value: string;
  tone?: "muted" | "accent" | "attention" | "credit" | "debit";
}) {
  return (
    <span
      className={cn(
        "text-meta",
        tone === "muted" && "text-ink-muted",
        tone === "accent" && "text-accent",
        tone === "attention" && "text-attention",
        tone === "credit" && "text-credit",
        tone === "debit" && "text-debit",
      )}
    >
      {sentenceCase(value)}
    </span>
  );
}
