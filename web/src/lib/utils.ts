import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Plain `twMerge` only knows Tailwind's own theme scale, so it can't tell that `text-display`
 * (a custom `font-size` token, `globals.css`) and `text-debit` (a custom `text-color` token) are
 * unrelated — it saw two `text-*` classes it didn't recognize, assumed they conflicted, and
 * silently dropped one. That's not a cosmetic near-miss in this app: it means a figure can lose
 * its debit/credit tone, which is exactly the color-carries-financial-meaning contract
 * `web/Design.md` documents. Every custom `text-*` token this app defines is registered below so
 * the two scales merge independently, the way Tailwind's own `text-sm` and `text-red-500` do.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "meta", "body", "emphasis", "h1", "figure", "display"] }],
      "text-color": [
        {
          text: [
            "paper",
            "panel",
            "ink",
            "ink-muted",
            "ink-faint",
            "rule",
            "rule-strong",
            "debit",
            "credit",
            "accent",
            "accent-ink",
            "attention",
          ],
        },
      ],
    },
  },
});

/** Merges conditional class lists, then resolves conflicting Tailwind utilities in favor of the
 * last one — every `ui/` primitive uses this so a caller's `className` can override a default. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
