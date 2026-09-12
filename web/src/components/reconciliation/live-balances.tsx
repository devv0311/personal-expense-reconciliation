"use client";

import { useState } from "react";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ResponsiveTable } from "@/components/responsive-table";
import { ErrorBlock, FieldSkeleton, LoadingStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { useBalanceComparison, useRefreshBalances } from "@/lib/queries";
import type { AccountBalanceComparison } from "@/lib/types";

/**
 * A live balance beside the closing balance this run evidenced (audit row 37, ADR-0054).
 *
 * Placed **after** the waterfall, deliberately, and it is not part of it. The waterfall's
 * verdict comes from evidence somebody confirmed; this is a second opinion from an API, with
 * its own timestamp and its own staleness. The two are next to each other so they can be
 * compared, and separated so one cannot be mistaken for the other.
 *
 * Every figure here — the reading, the ledger's closing balance, the difference between them —
 * is the API's. This component chooses no number and subtracts nothing (ADR-0048).
 */
export function LiveBalances({ runId }: { runId: string }) {
  const comparison = useBalanceComparison(runId);
  const refresh = useRefreshBalances();
  const [refreshing, setRefreshing] = useState(false);

  return (
    <Section
      title="What the bank says right now"
      headingId="live-balances"
      description="An optional second opinion, from a configured provider. It is never one of the boundaries above: a boundary is a statement you evidenced, and nothing here can make a delta verified."
      actions={
        comparison.data?.provider.configured === true ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              refresh.reset();
              setRefreshing(true);
            }}
          >
            Read balances now
          </Button>
        ) : undefined
      }
    >
      {comparison.isPending && (
        <LoadingStatus label="Loading live balances…">
          <FieldSkeleton />
        </LoadingStatus>
      )}
      {comparison.isError && (
        <ErrorBlock error={comparison.error} onRetry={() => void comparison.refetch()} />
      )}

      {comparison.isSuccess && !comparison.data.provider.configured && (
        <div className="rounded-sm border border-rule bg-panel p-4">
          <p className="text-body text-ink">No balance provider is configured.</p>
          <p className="mt-2 text-meta text-ink-muted">
            {comparison.data.provider.unavailableReason}
          </p>
        </div>
      )}

      {comparison.isSuccess && comparison.data.provider.configured && (
        <>
          <p className="mb-4 text-meta text-ink-muted">
            Compared against {formatDateTime(comparison.data.comparedTo)}. {comparison.data.note}
          </p>
          <ResponsiveTable
            caption="Live balances beside this run's evidenced closings"
            minWidth="640px"
            rows={comparison.data.comparisons}
            rowKey={(entry) => entry.accountId}
            rowNote={(entry) =>
              entry.comparison?.caveat === undefined ? null : (
                <span className="mt-0.5 block text-micro text-attention">
                  {entry.comparison.caveat}
                </span>
              )
            }
            columns={[
              { key: "account", header: "Account", render: (entry) => entry.accountName },
              {
                key: "reading",
                header: "Provider says",
                align: "right",
                render: (entry) => <ProviderFigure entry={entry} />,
              },
              {
                key: "ledger",
                header: "This run evidenced",
                align: "right",
                render: (entry) =>
                  entry.ledgerFigure === null ? (
                    <span className="text-meta text-ink-muted">not evidenced</span>
                  ) : (
                    <Money paise={entry.ledgerFigure} />
                  ),
              },
              {
                key: "verdict",
                header: "",
                render: (entry) => <Verdict entry={entry} />,
              },
            ]}
          />
        </>
      )}

      {refresh.isSuccess && (
        <p role="status" className="mt-3 text-meta text-ink-muted">
          Read at {formatDateTime(refresh.data.fetchedAt)}.{" "}
          {refresh.data.completeness.complete
            ? `All ${refresh.data.completeness.requested} linked accounts answered.`
            : `${refresh.data.completeness.incompleteReason ?? "The read was incomplete."}`}{" "}
          Nothing in the ledger changed.
        </p>
      )}

      <DecisionDialog
        open={refreshing}
        onClose={() => setRefreshing(false)}
        title="Read live balances"
        confirmLabel="Read them"
        pending={refresh.isPending}
        error={refresh.error}
        consequence={
          <>
            This asks the configured provider about every linked account and records what it says —
            including the accounts it cannot answer for. It writes no boundary, moves no balance and
            changes no verdict above; the figures are put beside each other for you to read.
          </>
        }
        onConfirm={(reason) => {
          refresh.mutate(reason === undefined ? {} : { reason }, {
            onSuccess: () => setRefreshing(false),
          });
        }}
      />
    </Section>
  );
}

function ProviderFigure({ entry }: { entry: AccountBalanceComparison }) {
  if (!entry.linked) {
    return <span className="text-meta text-ink-muted">not linked</span>;
  }
  if (entry.reading === null) {
    return <span className="text-meta text-ink-muted">never read</span>;
  }
  if (entry.reading.status !== "ok" || entry.reading.balance === null) {
    // Never a ₹0: the provider said nothing, which is not the same as saying zero.
    return <span className="text-meta text-attention">could not be read</span>;
  }
  return (
    <>
      <Money paise={entry.reading.balance} />
      {entry.reading.asOf !== null && (
        <span className="mt-0.5 block text-micro text-ink-faint">
          as of {formatDateTime(entry.reading.asOf)}
        </span>
      )}
    </>
  );
}

function Verdict({ entry }: { entry: AccountBalanceComparison }) {
  if (entry.comparison === null) {
    return <span className="text-meta text-ink-muted">nothing to compare</span>;
  }
  switch (entry.comparison.verdict) {
    case "agrees":
      return (
        <span className={entry.comparison.usability === "stale" ? "text-ink-muted" : "text-credit"}>
          {entry.comparison.usability === "stale" ? "matches an older reading" : "agrees"}
        </span>
      );
    case "differs":
      return (
        <span className="text-debit">
          differs by <Money paise={absoluteMinorUnits(entry.comparison.difference)} />
        </span>
      );
    case "not_comparable":
      return <span className="text-meta text-ink-muted">nothing to compare</span>;
  }
}

/**
 * The magnitude of a difference the API already computed, for display beside the word
 * "differs" which carries the direction in prose.
 *
 * String handling, not arithmetic: dropping a leading `-` from a minor-unit string the server
 * derived is the same class of operation as `parseRupeeInput` in the other direction
 * (ADR-0048's two carve-outs). Nothing here subtracts, divides or totals anything.
 */
function absoluteMinorUnits(value: string | null): string {
  if (value === null) return "0";
  return value.startsWith("-") ? value.slice(1) : value;
}
