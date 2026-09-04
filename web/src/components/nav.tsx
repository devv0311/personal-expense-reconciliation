"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { href: "/reconciliation", label: "Reconciliation" },
  { href: "/balances", label: "Balances" },
  { href: "/expenses", label: "Expenses" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-5 sm:flex-row sm:items-baseline sm:justify-between">
        <Link href="/" className="text-[15px] font-medium tracking-tight text-ink">
          Ledger
        </Link>
        <nav aria-label="Main" className="flex gap-6 text-[14px]">
          {SECTIONS.map((section) => {
            const active = pathname?.startsWith(section.href) ?? false;
            return (
              <Link
                key={section.href}
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={`border-b-2 pb-1 transition-colors ${
                  active
                    ? "border-accent text-ink"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {section.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
