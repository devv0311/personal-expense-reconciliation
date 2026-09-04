import type { ExpenseState } from "@/lib/types";

const TONE: Record<ExpenseState, string> = {
  proposed: "text-ink-muted",
  classified: "text-ink-muted",
  review_required: "text-accent",
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
  return <span className={`text-[13px] ${TONE[state]}`}>{sentenceCaseState(state)}</span>;
}
