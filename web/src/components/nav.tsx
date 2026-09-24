"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useShortcuts } from "@/components/app-shell/shortcuts";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAttention, useSession, useSignOut } from "@/lib/queries";
import type { SessionState } from "@/lib/types";

/**
 * Four places, and one thing you can always do.
 *
 * The row this replaced had five sections plus More, and before that eight workflow tabs plus
 * four utilities named after the machinery behind them. Each was a real capability; the row
 * asked the reader to already know what "reconciliation" produces and how it differs from
 * "balances" before it would tell them anything.
 *
 * These four are what somebody arrives wanting:
 *
 *  - **Home** — what needs you next, then where things stand.
 *  - **Spending** — where the money went.
 *  - **People** — who owes whom.
 *  - **Records** — everything on file, and every specialist screen behind it.
 *
 * **Add records is an action, not a place.** It is the one thing a person does here rather than
 * reads, so it is a button in the bar on every screen instead of a fifth tab competing with
 * four questions.
 *
 * **Nothing was removed.** Every specialist screen keeps its route, its deep links and its
 * place; Records lists them, and `/more` still resolves for anything that bookmarked it.
 *
 * The count on **Home** is the product's only live figure outside a screen, because what needs
 * a decision is the reason to come back. It is the count Home itself shows — a badge that
 * disagreed with the screen it points at would be worse than no badge — and it is a count, not
 * money, so it is never toned `debit`.
 */
const SECTIONS = [
  { href: "/", label: "Home", exact: true, badge: true },
  { href: "/spending", label: "Spending", exact: false, badge: false },
  { href: "/people", label: "People", exact: false, badge: false },
  { href: "/records", label: "Records", exact: false, badge: false },
] as const;

export function Nav() {
  const pathname = usePathname();
  const { openCommandPalette } = useShortcuts();
  // `limit: 1` — this only ever reads the total, and asking for a hundred items to render one
  // number would make every screen in the product pay for a badge.
  const queue = useAttention({ limit: 1 });
  const session = useSession();
  const signOut = useSignOut();
  const waiting = queue.data?.total ?? 0;

  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" className="text-emphasis font-serif font-medium tracking-tight text-ink">
            Ledger
          </Link>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={openCommandPalette}
              className="flex h-10 items-center gap-2 rounded-sm border border-rule px-3 text-meta text-ink-muted transition-colors hover:border-rule-strong hover:text-ink"
            >
              Search
              <span aria-hidden="true" className="font-mono text-micro text-ink-faint">
                ⌘K
              </span>
              <span className="sr-only">Open the command palette</span>
            </button>
            <SessionBadge
              state={session.data}
              signingOut={signOut.isPending}
              onSignOut={() => signOut.mutate()}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
          <nav aria-label="Main" className="flex flex-wrap gap-x-7 gap-y-2 text-body">
            {SECTIONS.map((section) => {
              const active = isActive(pathname, section.href, section.exact);
              const pending = section.badge ? waiting : 0;
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
                      <span className="sr-only"> waiting on you</span>
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          {/*
            The persistent action. `size="sm"` rather than the 48px default: it sits in a bar
            beside four navigation links all day, and a full-height primary button there would
            read as the most important thing on every screen — including the ones whose whole
            job is to hand the reader a different decision.
          */}
          <Link
            href="/add"
            aria-current={isActive(pathname, "/add", false) ? "page" : undefined}
            className={buttonVariants({ size: "sm" })}
          >
            Add records
          </Link>
        </div>
      </div>
    </header>
  );
}

/** `/` would otherwise match every route, so the front door is the one exact match. */
function isActive(pathname: string | null, href: string, exact: boolean): boolean {
  if (pathname === null) return false;
  return exact ? pathname === href : pathname.startsWith(href);
}

/**
 * Who this browser is, and the way out.
 *
 * When the API is not enforcing authentication it says so rather than showing nothing: an
 * unlocked ledger that looks locked is the more dangerous of the two mistakes.
 */
function SessionBadge({
  state,
  signingOut,
  onSignOut,
}: {
  state: SessionState | undefined;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  if (state === undefined) return null;
  if (!state.authenticationRequired) {
    return (
      <span className="text-micro text-ink-faint" title="AUTH_REQUIRED is off on this API">
        Not password-protected
      </span>
    );
  }
  if (state.session === null) return null;
  return (
    <span className="flex items-center gap-2 text-micro text-ink-faint">
      {state.session.email}
      <Button variant="link" size="sm" disabled={signingOut} onClick={onSignOut}>
        {signingOut ? "Signing out…" : "Sign out"}
      </Button>
    </span>
  );
}
