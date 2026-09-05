import type { ExpenseState } from "@/lib/types";

/**
 * `review_required` gets its own `attention` amber, distinct from the `accent` indigo the other
 * in-flight states share: it's the one state that means "waiting on you," not "moving through
 * the pipeline normally" — the same distinction `web/Design.md` draws for a Splitwise
 * discrepancy (`discrepancy-list.tsx`).
 */
const TONE: Record<ExpenseState, string> = {
  proposed: "text-ink-muted",
  classified: "text-ink-muted",
  review_required: "text-attention",
  approved: "text-accent",
  allocated: "text-accent",
  ready_to_sync: "text-accent",
  synced: "text-credit",
  reconciled: "text-credit",
  rejected: "text-debit",
};

export function sentenceCaseState(state: ExpenseState): string {
  const [first, ...rest] = state.split("_");
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} ${rest.join(" ")}`.trim();
}

export function ExpenseStateTag({ state }: { state: ExpenseState }) {
  return <span className={`text-meta ${TONE[state]}`}>{sentenceCaseState(state)}</span>;
}
