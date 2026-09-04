import { formatPaise } from "@/lib/money";

/**
 * The caller decides the tone, deliberately — a figure's sign alone doesn't say whether it's
 * good or bad news. A negative `NetBalance` just means the debt runs the other way, not that
 * something is wrong; a positive `ledgerUnexplainedTotal` needs attention, but a negative one
 * (over-explained) needs it too (`invariants.md` #20) — sign-based coloring would get that
 * backwards half the time. So callers pass an explicit `debit`/`credit`/`neutral` verdict based
 * on what the number actually means in context, and this component only ever renders it.
 */
export function Money({
  paise,
  tone = "neutral",
  className = "",
}: {
  paise: string;
  tone?: "debit" | "credit" | "neutral";
  className?: string;
}) {
  const { text } = formatPaise(paise);
  const colorClass = tone === "debit" ? "text-debit" : tone === "credit" ? "text-credit" : "";
  return <span className={`tabular font-mono ${colorClass} ${className}`}>{text}</span>;
}
