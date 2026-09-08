"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useShortcuts } from "@/components/app-shell/shortcuts";
import { useReviewQueue } from "@/lib/queries";

/**
 * One row, one entry per workflow, with evidence and receipts reached from the queue and the
 * ledger rather than given tabs of their own (a document is always about a payment or an
 * expense; a list of loose documents is not a workflow).
 *
 * Phase 21 shipped six, matching `CLAUDE.md`'s six pillars. **Payments** joins them because the
 * pillars all start from a cash movement, and until this row existed there was no screen where
 * an imported statement line could be seen at all — the audit's first finding. **Evidence** is
 * here for the same reason: a document attached to nothing only ever surfaced if the review
 * queue happened to raise it, and a library is not a work queue. **Setup** sits
 * apart, next to search: master data changes what the ledger can say, never what it says, and
 * a roster editor is not a workflow to return to daily.
 *
 * The review count is the product's only live figure outside a screen: it is what makes the
 * queue a place you go back to. It is a count, not money, so it is never toned `debit`.
 */
const SECTIONS = [
  { href: "/review", label: "Review" },
  { href: "/payments", label: "Payments" },
  { href: "/evidence", label: "Evidence" },
  { href: "/reconciliation", label: "Reconciliation" },
  { href: "/expenses", label: "Expenses" },
  { href: "/balances", label: "Balances" },
  { href: "/splitwise", label: "Splitwise" },
  { href: "/proof-packs", label: "Proof packs" },
] as const;

export function Nav() {
  const pathname = usePathname();
  const { openCommandPalette } = useShortcuts();
  const queue = useReviewQueue({ limit: 1 });

  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" className="text-emphasis font-semibold tracking-tight text-ink">
            Ledger
          </Link>
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex items-center gap-2 rounded-sm border border-rule px-2.5 py-1 text-meta text-ink-muted transition-colors hover:border-rule-strong hover:text-ink lg:order-last"
          >
            Search
            <span aria-hidden="true" className="font-mono text-micro text-ink-faint">
              ⌘K
            </span>
            <span className="sr-only">Open the command palette</span>
          </button>
        </div>
        <nav aria-label="Main" className="flex flex-wrap gap-x-6 gap-y-2 text-body">
          {SECTIONS.map((section) => {
            const active = pathname?.startsWith(section.href) ?? false;
            const pending = section.href === "/review" ? (queue.data?.total ?? 0) : 0;
            return (
              <Link
                key={section.href}
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={`border-b-2 pb-1 transition-colors ${
                  active
                    ? "border-accent font-medium text-ink"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {section.label}
                {pending > 0 && (
                  <span className="ml-1.5 font-mono text-micro text-attention">
                    {pending}
                    <span className="sr-only"> items waiting</span>
                  </span>
                )}
              </Link>
            );
          })}
          <Link
            href="/setup"
            aria-current={pathname?.startsWith("/setup") === true ? "page" : undefined}
            className={`border-b-2 pb-1 transition-colors ${
              pathname?.startsWith("/setup") === true
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-faint hover:text-ink"
            }`}
          >
            Setup
          </Link>
        </nav>
      </div>
    </header>
  );
}
