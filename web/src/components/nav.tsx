"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useShortcuts } from "@/components/app-shell/shortcuts";
import { Button } from "@/components/ui/button";
import { useReviewQueue } from "@/lib/queries";

const SECTIONS = [
  { href: "/review", label: "Review" },
  { href: "/reconciliation", label: "Reconciliation" },
  { href: "/expenses", label: "Expenses" },
  { href: "/balances", label: "Balances" },
  { href: "/splitwise", label: "Splitwise" },
  { href: "/proof-packs", label: "Proof packs" },
] as const;

export function Nav() {
  const pathname = usePathname();
  const { openCommandPalette, openShortcutHelp } = useShortcuts();
  const queue = useReviewQueue({ limit: 1 });

  return (
    <header className="border-b border-rule bg-panel">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="flex items-center justify-between gap-4 py-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-emphasis font-semibold tracking-tight text-ink"
          >
            <svg
              aria-hidden="true"
              width="24"
              height="28"
              viewBox="0 0 24 28"
              fill="none"
              className="text-accent"
            >
              <rect
                x="2"
                y="2"
                width="20"
                height="24"
                rx="1"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M7 7v14M5 9h13M5 14h13M5 19h13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            Ledger
          </Link>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={openShortcutHelp}
              className="hidden sm:inline-flex"
            >
              Keyboard shortcuts
            </Button>
            <Button variant="outline" size="sm" onClick={openCommandPalette}>
              Search
              <kbd aria-hidden="true" className="ml-3 font-mono text-micro text-ink-faint">
                ⌘ K
              </kbd>
              <span className="sr-only">Open the command palette</span>
            </Button>
          </div>
        </div>
        <nav
          aria-label="Main"
          className="grid grid-cols-3 gap-x-2 text-meta sm:flex sm:gap-x-7 sm:text-body"
        >
          {SECTIONS.map((section) => {
            const active = pathname === section.href || pathname?.startsWith(`${section.href}/`);
            const pending = section.href === "/review" ? queue.data?.total : undefined;
            return (
              <Link
                key={section.href}
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center justify-center gap-1.5 border-b-2 px-1 transition-colors sm:justify-start ${active ? "border-accent font-medium text-accent" : "border-transparent text-ink-muted hover:border-rule-strong hover:text-ink"}`}
              >
                {section.label}
                {pending !== undefined && pending > 0 && (
                  <span className="font-mono text-micro text-attention">
                    {pending}
                    <span className="sr-only"> items waiting</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
