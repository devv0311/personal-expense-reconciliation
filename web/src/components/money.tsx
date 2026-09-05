import { formatPaise } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * The caller decides the tone, deliberately — a figure's sign alone doesn't say whether it's
 * good or bad news. A negative `NetBalance` just means the debt runs the other way, not that
 * something is wrong; a positive `ledgerUnexplainedTotal` needs attention, but a negative one
 * (over-explained) needs it too (`invariants.md` #20) — sign-based coloring would get that
 * backwards half the time. So callers pass an explicit `debit`/`credit`/`neutral` verdict based
 * on what the number actually means in context, and this component only ever renders it.
 *
 * `size` is opt-in and defaults to inheriting the surrounding text size: most figures sit inside
 * a table cell that already sets it. `figure`/`display` are for the one hero number a screen is
 * built around (a balance headline, the reconciliation total) — see `web/Design.md` "Typography".
 */
export function Money({
  paise,
  tone = "neutral",
  size = "inherit",
  className = "",
}: {
  paise: string;
  tone?: "debit" | "credit" | "neutral";
  size?: "inherit" | "figure" | "display";
  className?: string;
}) {
  const { text } = formatPaise(paise);
  return (
    <span
      className={cn(
        "tabular font-mono",
        tone === "debit" && "text-debit",
        tone === "credit" && "text-credit",
        size === "figure" && "text-figure leading-none font-semibold",
        size === "display" && "text-display leading-none font-semibold",
        className,
      )}
    >
      {text}
    </span>
  );
}
