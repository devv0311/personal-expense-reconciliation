"use client";

import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { useAttention } from "@/lib/queries";

/**
 * Everything on file, and every screen that proves a figure.
 *
 * This is the former **More** page, promoted into the primary row and given the job its name
 * now claims. The four tabs answer the questions somebody arrives with; this answers the
 * questions somebody arrives with *once they already know the ledger* — how a figure was
 * proved, what the raw record said, what a rule will do next time.
 *
 * **Nothing moved.** Every route below is exactly where it was, every deep link still works,
 * and `/more` still resolves here for anything that bookmarked it.
 *
 * The one live thing on the page is what needs a decision, at the top, because a person who
 * came looking for the detail behind a figure is exactly the person who should be told a
 * suggestion about it is still unanswered.
 */
const GROUPS = [
  {
    id: "records",
    title: "The records themselves",
    items: [
      {
        href: "/payments",
        label: "Every payment",
        note: "Movements in and out, and the step-by-step pipeline behind them",
      },
      {
        href: "/evidence",
        label: "Documents and messages",
        note: "Bills, receipts, screenshots and notes on file",
      },
      { href: "/expenses", label: "Expenses", note: "What was bought, shared and adjusted" },
    ],
  },
  {
    id: "proving",
    title: "Proving the figures",
    items: [
      {
        href: "/reconciliation",
        label: "Reconciliation",
        note: "Account by account, opening balance to closing",
      },
      {
        href: "/balances",
        label: "Balance detail",
        note: "One pair at a time, with the expenses behind it",
      },
      { href: "/analytics", label: "Analytics", note: "Category, trend, own share, outstanding" },
    ],
  },
  {
    id: "sharing",
    title: "Sharing and syncing",
    items: [
      {
        href: "/splitwise",
        label: "Splitwise",
        note: "Drift, repairs, and changes made on their side",
      },
      {
        href: "/proof-packs",
        label: "Proof packs",
        note: "A recipient-specific summary to review before sending",
      },
    ],
  },
  {
    id: "setup",
    title: "Setting things up",
    items: [
      { href: "/setup", label: "Accounts and people", note: "Who and what the ledger knows about" },
      { href: "/automation", label: "Rules and jobs", note: "What happens without you asking" },
      { href: "/ask", label: "Ask a question", note: "Answered from the ledger's own reads" },
      {
        href: "/review",
        label: "Full review queue",
        note: "The unfiltered queue behind Needs attention",
      },
    ],
  },
] as const;

export function RecordsIndex() {
  const attention = useAttention({ limit: 1 });
  const waiting = attention.data?.total ?? 0;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Records"
        description="Everything on file, and the detailed screens behind the summaries — how a figure was proved, and what the original record said."
        actions={
          <Link href="/add" className={buttonVariants({ size: "sm" })}>
            Add records
          </Link>
        }
      />

      {/*
        Rendered only once the count is known and non-zero. A "0 waiting" line and a skeleton
        both make a claim about the queue before the queue has answered, and this page is not
        the place that claim belongs — Home is.
      */}
      {attention.isSuccess && waiting > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-rule bg-panel p-5">
          <p className="max-w-prose text-body text-ink">
            <strong className="font-medium">
              {waiting === 1 ? "One thing is" : `${waiting} things are`}
            </strong>{" "}
            still waiting on a decision from you.
          </p>
          <Link href="/needs-attention" className={buttonVariants({ size: "sm" })}>
            Go through them
          </Link>
        </div>
      )}

      {GROUPS.map((group) => (
        // The heading id is a slug, not the title: an `id` may not contain spaces, and
        // `aria-labelledby` splits on them — so a titled id resolves to several ids that do not
        // exist and the section ends up with no accessible name at all.
        <section key={group.id} aria-labelledby={`records-${group.id}`}>
          <h2
            id={`records-${group.id}`}
            className="mb-4 text-emphasis font-serif font-medium text-ink"
          >
            {group.title}
          </h2>
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {group.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-4 transition-colors hover:text-ink"
                >
                  <span className="text-body text-ink">{item.label}</span>
                  <span className="text-meta text-ink-muted">{item.note}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function RecordsPage() {
  return <RecordsIndex />;
}
